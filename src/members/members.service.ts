import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import { MembershipRole } from '../common/enums/role.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import {
  CompanyMember,
  listCompanyMembers,
} from '../common/members/company-members';
import { memberRpcException } from '../common/members/member-rpc-error';
import {
  avatarUrlFor,
  presignAvatarUrls,
} from '../common/members/member-avatars';
import { StorageService } from '../storage/storage.service';

/** A person of the company as the members list serves them: no raw storage key. */
export type MemberView = Omit<CompanyMember, 'avatarKey'> & {
  /** Short-lived link to the person's photo, or null when none is set. */
  avatarUrl: string | null;
};

export interface AuditLogEntry {
  id: string;
  createdAt: string;
  actorUserId: string;
  actorIsPlatformAdmin: boolean;
  tenantId: string | null;
  action: string;
  targetUserId: string | null;
  details: Record<string, unknown>;
}

const DEFAULT_AUDIT_LIMIT = 50;

/**
 * People of a company and who changed what. The rules (no self change, a
 * company always keeps an admin, every change audited in the same step) live
 * in the database functions, so a bug here cannot bypass them; this service
 * only checks the caller's permission (the guard) and maps errors.
 */
@Injectable()
export class MembersService {
  private readonly logger = new Logger(MembersService.name);

  constructor(
    private readonly supabaseFactory: SupabaseClientFactory,
    private readonly storageService: StorageService,
  ) {}

  async list(caller: RequestUser): Promise<MemberView[]> {
    try {
      const members = await listCompanyMembers(
        this.supabaseFactory.createAdmin(),
        caller.tenantId as string,
        { includeRemoved: false },
      );
      const avatarUrls = await presignAvatarUrls(
        this.storageService,
        members.map((m) => m.avatarKey),
      );
      return members.map(({ avatarKey, ...member }) => ({
        ...member,
        avatarUrl: avatarUrlFor(avatarUrls, avatarKey),
      }));
    } catch (error) {
      this.logger.error('Failed to list members:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to list members',
      });
    }
  }

  async changeRole(
    caller: RequestUser,
    memberUserId: string,
    newRole: MembershipRole,
  ): Promise<{ userId: string; oldRole: string; newRole: string }> {
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .rpc('change_member_role', {
        p_caller: caller.userId,
        p_tenant_id: caller.tenantId,
        p_member_user_id: memberUserId,
        p_new_role: newRole,
      });
    if (error) {
      throw this.mapError(error, 'Failed to change the role');
    }
    // The database always returns the old and new role on success. A missing row
    // is a broken contract, so fail loudly rather than report a made-up change.
    const row = (data as Array<Record<string, string>> | null)?.[0];
    if (!row?.['old_role'] || !row?.['new_role']) {
      this.logger.error('change_member_role returned no role change');
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to change the role',
      });
    }
    return {
      userId: memberUserId,
      oldRole: row['old_role'],
      newRole: row['new_role'],
    };
  }

  /**
   * Owner sets an employee's two job switches (CAP-1). One database call does
   * the check, the change and its audit row together.
   */
  async setJobSettings(
    caller: RequestUser,
    memberUserId: string,
    settings: { canCreateJobs: boolean; jobApprovalRequired: boolean },
  ): Promise<{
    userId: string;
    canCreateJobs: boolean;
    jobApprovalRequired: boolean;
  }> {
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .rpc('set_member_job_settings', {
        p_caller: caller.userId,
        p_tenant_id: caller.tenantId,
        p_member_user_id: memberUserId,
        p_can_create_jobs: settings.canCreateJobs,
        p_job_approval_required: settings.jobApprovalRequired,
      });
    if (error) {
      throw this.mapError(error, 'Failed to update the job settings');
    }
    const row = (
      data as Array<{
        member_id: string;
        can_create_jobs: boolean;
        job_approval_required: boolean;
      }> | null
    )?.[0];
    if (!row) {
      this.logger.error('set_member_job_settings returned no row');
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to update the job settings',
      });
    }
    return {
      userId: memberUserId,
      canCreateJobs: row.can_create_jobs,
      jobApprovalRequired: row.job_approval_required,
    };
  }

  async remove(caller: RequestUser, memberUserId: string): Promise<void> {
    const { error } = await this.supabaseFactory
      .createAdmin()
      .rpc('remove_member', {
        p_caller: caller.userId,
        p_tenant_id: caller.tenantId,
        p_member_user_id: memberUserId,
      });
    if (error) {
      throw this.mapError(error, 'Failed to remove the member');
    }
  }

  async setDisabled(
    caller: RequestUser,
    userId: string,
    disabled: boolean,
  ): Promise<{ userId: string; disabled: boolean }> {
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .rpc('set_user_disabled', {
        p_caller: caller.userId,
        p_user_id: userId,
        p_disabled: disabled,
      });
    if (error) {
      throw this.mapError(error, 'Failed to update the account');
    }
    return { userId, disabled: data === true };
  }

  /**
   * A company admin reads their own company's rows. A platform admin reads the
   * named company's rows (X-Company-Id), or every row when none is named.
   */
  async auditLog(
    caller: RequestUser,
    limit: number | undefined,
    before: string | undefined,
    beforeId?: string,
  ): Promise<AuditLogEntry[]> {
    if (beforeId && !before) {
      // The id only refines the timestamp cursor; alone it would be ignored.
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'beforeId needs before',
      });
    }
    let query = this.supabaseFactory
      .createAdmin()
      .from('audit_log')
      .select(
        'id, created_at, actor_user_id, actor_is_platform_admin, tenant_id, action, target_user_id, details',
      )
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit ?? DEFAULT_AUDIT_LIMIT);

    if (!caller.platformAdmin) {
      // Never trust the caller to widen this: a company admin always has a company.
      query = query.eq('tenant_id', caller.tenantId as string);
    } else if (caller.tenantId) {
      query = query.eq('tenant_id', caller.tenantId);
    }
    if (before) {
      // With beforeId the cursor is (created_at, id), so rows that share one
      // timestamp are never skipped. Both values are validated by the DTO
      // (ISO date, UUID) and quoted here.
      query = beforeId
        ? query.or(
            `created_at.lt."${before}",and(created_at.eq."${before}",id.lt.${beforeId})`,
          )
        : query.lt('created_at', before);
    }

    const { data, error } = await query;
    if (error) {
      this.logger.error('Failed to read the audit log:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to read the audit log',
      });
    }
    return (data ?? []).map((r) => ({
      id: r.id as string,
      createdAt: r.created_at as string,
      actorUserId: r.actor_user_id as string,
      actorIsPlatformAdmin: r.actor_is_platform_admin as boolean,
      tenantId: (r.tenant_id as string | null) ?? null,
      action: r.action as string,
      targetUserId: (r.target_user_id as string | null) ?? null,
      details: (r.details as Record<string, unknown>) ?? {},
    }));
  }

  private mapError(
    error: { code?: string; hint?: string | null; message?: string },
    fallback: string,
  ): Error {
    const mapped = memberRpcException(error);
    if (mapped) return mapped;
    this.logger.error(`${fallback}:`, { error });
    return new InternalServerErrorException({
      error_code: ErrorCode.INTERNAL_SERVER_ERROR,
      message: fallback,
    });
  }
}
