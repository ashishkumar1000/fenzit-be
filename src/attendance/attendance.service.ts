import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { UpdateSetupStepDto } from './dto/update-setup-step.dto';
import {
  AttendanceSettingsRow,
  AttendanceSetupProgressRow,
  SetupStateResponse,
  toSetupStateResponse,
} from './attendance-response.model';

/**
 * SQLSTATEs raised by the attendance RPCs (PTxxx convention: last 3 digits
 * = HTTP status). The HINT on each SQL error names the ErrorCode.
 */
const PT_SETUP_INCOMPLETE = 'PT422';
const PT_SETUP_STATE_CONFLICT = 'PT409';

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private readonly supabaseClientFactory: SupabaseClientFactory,
  ) {}

  /**
   * FR-1 resume state. Rows are created on demand — no settings row means
   * the wizard has never been started, reported as started=false (200, not
   * 404, so the app can render the entry point without an error branch).
   */
  async getSetupState(user: RequestUser): Promise<SetupStateResponse> {
    this.requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();
    const [settings, progress] = await Promise.all([
      this.readSettings(admin, user),
      this.readProgress(admin, user),
    ]);
    return toSetupStateResponse(settings, progress);
  }

  /**
   * Start (or resume) the wizard. attendance_start_setup is a single RPC
   * (AD-3: two row-sets, one write) whose on-conflict-do-nothing inserts
   * make a restart mid-wizard a no-op — progress is never reset, so the
   * owner resumes at their last incomplete step. 201 on first start, 200
   * when the wizard was already under way.
   */
  async startSetup(
    user: RequestUser,
  ): Promise<{ state: SetupStateResponse; created: boolean }> {
    const tenantId = this.requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();

    const existing = await this.readSettings(admin, user);
    if (existing?.setup_completed_at) {
      throw new HttpException(
        {
          error_code: ErrorCode.ATTENDANCE_SETUP_ALREADY_COMPLETED,
          message: 'Attendance setup has already been completed',
        },
        HttpStatus.CONFLICT,
      );
    }

    const { error } = await admin.rpc('attendance_start_setup', {
      p_tenant_id: tenantId,
      p_actor_id: user.userId,
    });
    if (error) {
      this.logger.error('Failed to start attendance setup:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to start attendance setup',
      });
    }

    const [settings, progress] = await Promise.all([
      this.readSettings(admin, user),
      this.readProgress(admin, user),
    ]);
    return { state: toSetupStateResponse(settings, progress), created: !existing };
  }

  /**
   * Persist the wizard's current step (the FR-1 "progress saved after each
   * step" contract). Guards from the settings row first: no row → never
   * started (POST start self-heals); completed → 409, the wizard is over.
   * The guarded UPDATE itself is scoped to the tenant — an empty result
   * means no progress row (the app lost its rows; POST start self-heals).
   */
  async saveStep(user: RequestUser, dto: UpdateSetupStepDto): Promise<void> {
    this.requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();

    const existing = await this.readSettings(admin, user);
    if (!existing) {
      throw new NotFoundException({
        error_code: ErrorCode.ATTENDANCE_SETUP_NOT_STARTED,
        message: 'Attendance setup has not been started',
      });
    }
    if (existing.setup_completed_at) {
      throw new HttpException(
        {
          error_code: ErrorCode.ATTENDANCE_SETUP_ALREADY_COMPLETED,
          message: 'Attendance setup has already been completed',
        },
        HttpStatus.CONFLICT,
      );
    }

    const { data, error } = await admin
      .from('attendance_setup_progress')
      .update({ current_step: dto.currentStep })
      .eq('tenant_id', user.tenantId as string)
      .select('tenant_id');

    if (error) {
      this.logger.error('Failed to save attendance setup step:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to save attendance setup step',
      });
    }
    if (!data || data.length === 0) {
      throw new NotFoundException({
        error_code: ErrorCode.ATTENDANCE_SETUP_NOT_STARTED,
        message: 'Attendance setup has not been started',
      });
    }
  }

  /**
   * Complete the wizard (FR-1 gate): attendance_complete_setup takes the
   * exclusive tenant lock, verifies ≥1 office and ≥1 tracked employee with
   * an assignment, then sets setup_completed_at and enabled=true. 404/409
   * are decided here from the row state; the RPC's PT409 is only the
   * concurrent-completion fallback.
   */
  async completeSetup(user: RequestUser): Promise<SetupStateResponse> {
    const tenantId = this.requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();

    const existing = await this.readSettings(admin, user);
    if (!existing) {
      throw new NotFoundException({
        error_code: ErrorCode.ATTENDANCE_SETUP_NOT_STARTED,
        message: 'Attendance setup has not been started',
      });
    }
    if (existing.setup_completed_at) {
      throw new HttpException(
        {
          error_code: ErrorCode.ATTENDANCE_SETUP_ALREADY_COMPLETED,
          message: 'Attendance setup has already been completed',
        },
        HttpStatus.CONFLICT,
      );
    }

    const { error } = await admin.rpc('attendance_complete_setup', {
      p_tenant_id: tenantId,
      p_actor_id: user.userId,
    });
    if (error) {
      if (error.code === PT_SETUP_INCOMPLETE) {
        throw new HttpException(
          {
            error_code: ErrorCode.ATTENDANCE_SETUP_INCOMPLETE,
            message:
              'Setup needs at least one office and one tracked employee with an office assignment',
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (error.code === PT_SETUP_STATE_CONFLICT) {
        // Another actor completed the setup between our read and the RPC.
        throw new HttpException(
          {
            error_code: ErrorCode.ATTENDANCE_SETUP_ALREADY_COMPLETED,
            message: 'Attendance setup has already been completed',
          },
          HttpStatus.CONFLICT,
        );
      }
      this.logger.error('Failed to complete attendance setup:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to complete attendance setup',
      });
    }

    const [settings, progress] = await Promise.all([
      this.readSettings(admin, user),
      this.readProgress(admin, user),
    ]);
    return toSetupStateResponse(settings, progress);
  }

  private requireTenant(user: RequestUser): string {
    if (!user.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before using attendance',
      });
    }
    return user.tenantId;
  }

  private async readSettings(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    user: RequestUser,
  ): Promise<AttendanceSettingsRow | null> {
    const { data, error } = await admin
      .from('attendance_settings')
      .select('*')
      .eq('tenant_id', user.tenantId as string)
      .maybeSingle<AttendanceSettingsRow>();
    if (error) {
      this.logger.error('Failed to read attendance settings:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to read attendance settings',
      });
    }
    return data;
  }

  private async readProgress(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    user: RequestUser,
  ): Promise<AttendanceSetupProgressRow | null> {
    const { data, error } = await admin
      .from('attendance_setup_progress')
      .select('*')
      .eq('tenant_id', user.tenantId as string)
      .maybeSingle<AttendanceSetupProgressRow>();
    if (error) {
      this.logger.error('Failed to read attendance setup progress:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to read attendance setup progress',
      });
    }
    return data;
  }
}