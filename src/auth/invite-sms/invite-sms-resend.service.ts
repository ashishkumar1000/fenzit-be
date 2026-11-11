import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../../common/factories/supabase-client.factory';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { MembershipRole } from '../../common/enums/role.enum';
import { RequestUser } from '../../common/interfaces/request-user.interface';
import { permissionsFor } from '../../common/permissions/permissions';
import { InviteSmsService, InviteSmsStatus } from './invite-sms.service';
import {
  INVITE_SMS_CAP_PER_PHONE,
  INVITE_SMS_CAP_WINDOW_MINUTES,
} from './invite-sms-cap.constants';

interface InvitedMembershipRow {
  user_id: string;
  role: string;
  status: string;
  users: {
    name: string | null;
    country_code: string;
    phone_number: string;
  } | null;
}

/**
 * Resend of the invite SMS (spec CAP-2, story 21-2). Decides who may resend
 * and answers the 403, 404, 409 and 429 cases. The send and the cap are the
 * shared InviteSmsService path, so a resend and a first invite count together.
 */
@Injectable()
export class InviteSmsResendService {
  private readonly logger = new Logger(InviteSmsResendService.name);

  constructor(
    private readonly inviteSmsService: InviteSmsService,
    private readonly supabaseClientFactory: SupabaseClientFactory,
  ) {}

  async resend(
    caller: RequestUser,
    membershipUserId: string,
  ): Promise<{ sms_status: InviteSmsStatus }> {
    // Rule 1: only a company admin of this company. The permission matrix
    // grants invite_sms.resend to company_admin alone, and the platform
    // admin's role is PLATFORM_ADMIN, so it is refused here.
    const tenantId = caller.tenantId;
    if (
      !tenantId ||
      caller.platformAdmin ||
      !permissionsFor(caller.role).has('invite_sms.resend')
    ) {
      throw new ForbiddenException({
        error_code: ErrorCode.NOT_COMPANY_ADMIN,
        message: 'Only a company admin can resend the invite text',
      });
    }

    const admin = this.supabaseClientFactory.createAdmin();
    // Rule 2: the lookup is scoped to the caller's company. Another company's
    // membership reads as not found.
    const { data, error } = await admin
      .from('memberships')
      .select(
        'user_id, role, status, users!memberships_user_id_fkey(name, country_code, phone_number)',
      )
      .eq('user_id', membershipUserId)
      .eq('tenant_id', tenantId)
      .maybeSingle<InvitedMembershipRow>();
    if (error) {
      this.logger.error('Failed to read the invite for a resend', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Could not resend the invite text',
      });
    }
    if (!data) {
      throw new NotFoundException({
        error_code: ErrorCode.INVITE_NOT_FOUND,
        message: 'No invite was found for this person in your company',
      });
    }

    // Rule 3: only an invite that is still pending can be resent.
    if (data.status !== 'invited') {
      throw new ConflictException({
        error_code: ErrorCode.INVITE_NOT_PENDING,
        message:
          'This person has already joined, so the invite text is not needed',
      });
    }

    if (!data.users) {
      this.logger.error('Invited membership has no user row');
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Could not resend the invite text',
      });
    }

    // Rules 4 to 7: the cap, the send and the audit all happen in the shared
    // path. A refused cap is a 429 here, with no SMS and no counter row.
    const status = await this.inviteSmsService.sendInviteSms({
      tenantId,
      membershipUserId: data.user_id,
      countryCode: data.users.country_code,
      phoneNumber: data.users.phone_number,
      name: data.users.name ?? '',
      role: data.role as MembershipRole,
    });

    if (status === 'refused_cap') {
      throw new HttpException(
        {
          error_code: ErrorCode.INVITE_SMS_LIMIT_REACHED,
          message: `This phone number has already had ${INVITE_SMS_CAP_PER_PHONE} invite texts in the last ${INVITE_SMS_CAP_WINDOW_MINUTES} minutes, so no text was sent. Try again later.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return { sms_status: status };
  }
}
