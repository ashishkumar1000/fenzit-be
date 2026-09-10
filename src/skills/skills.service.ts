import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { CreateSkillDto } from './dto/create-skill.dto';

export interface SkillResponse {
  id: string;
  name: string;
  tenantId: string;
  createdAt: string;
}

/**
 * TTL for the minted PostgREST access token. Short-lived by design — one
 * catalog read per request.
 */
export const POSTGREST_TOKEN_TTL_SECONDS = 900;

@Injectable()
export class SkillsService {
  private readonly logger = new Logger(SkillsService.name);

  constructor(
    private readonly supabaseClientFactory: SupabaseClientFactory,
    private readonly jwtService: JwtService,
  ) {}

  async createSkill(
    owner: RequestUser,
    dto: CreateSkillDto,
  ): Promise<SkillResponse> {
    if (!owner.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before managing skills',
      });
    }

    const admin = this.supabaseClientFactory.createAdmin();

    const { data, error } = await admin
      .from('tenant_skills')
      .insert({
        id: crypto.randomUUID(),
        tenant_id: owner.tenantId,
        name: dto.name,
      })
      .select('id, name, tenant_id, created_at')
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException({
          error_code: ErrorCode.DUPLICATE_RESOURCE,
          message: 'A skill with this name already exists for your company',
        });
      }
      this.logger.error('Failed to create skill:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to create skill',
      });
    }

    return {
      id: data.id,
      name: data.name,
      tenantId: data.tenant_id,
      createdAt: data.created_at,
    };
  }

  /**
   * Global skills catalog — seeded by migrations, read-only for the API.
   * PostgREST switches to the DB role named in the JWT's `role` claim, and the
   * app's owner/technician roles are not DB roles — so the read is made with a
   * short-lived role:'authenticated' token carrying the caller's sub (same
   * claim shape as AuthService.mintRealtimeToken; jsonwebtoken throws when a
   * payload `exp` meets an `expiresIn` option, so only the payload `exp` is
   * set). This keeps the `skills_authenticated_read` RLS policy actually
   * exercised — never createAdmin() here.
   */
  async listGlobalSkills(
    user: RequestUser,
  ): Promise<{ id: string; name: string }[]> {
    const exp = Math.floor(Date.now() / 1000) + POSTGREST_TOKEN_TTL_SECONDS;
    const token = await this.jwtService.signAsync({
      sub: user.userId,
      role: 'authenticated',
      exp,
    });
    const client = this.supabaseClientFactory.create(token);

    const { data, error } = await client
      .from('skills')
      .select('id, name')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error) {
      this.logger.error('Failed to list skills:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to list skills',
      });
    }

    return (data ?? []).map((row) => ({ id: row.id, name: row.name }));
  }

  async deleteSkill(
    owner: RequestUser,
    skillId: string,
  ): Promise<{ success: boolean }> {
    if (!owner.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before managing skills',
      });
    }

    const admin = this.supabaseClientFactory.createAdmin();

    const { data: existing, error: fetchError } = await admin
      .from('tenant_skills')
      .select('id')
      .eq('id', skillId)
      .eq('tenant_id', owner.tenantId)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      this.logger.error('Failed to fetch skill for delete:', {
        error: fetchError,
      });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to delete skill',
      });
    }

    if (!existing) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'Skill not found',
      });
    }

    const { error } = await admin
      .from('tenant_skills')
      .delete()
      .eq('id', skillId)
      .eq('tenant_id', owner.tenantId);

    if (error) {
      this.logger.error('Failed to delete skill:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to delete skill',
      });
    }

    return { success: true };
  }
}
