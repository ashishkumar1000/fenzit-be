import { ForbiddenException, InternalServerErrorException, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ErrorCode } from '../common/enums/error-code.enum';
import { Role } from '../common/enums/role.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';

const logger = new Logger('EmployeeSubmission');

/** Result for an employee's new job: does the owner need to approve it first? */
export interface EmployeeSubmission {
  pendingApproval: boolean;
}

/**
 * CAP-2 / CAP-3 / CAP-4. For an employee creating a job, reads the caller's own
 * membership switches (set by the owner, story 1) and refuses when they may not
 * create jobs, or when they try to give the job to someone else (non-goal).
 *
 * Returns null for owners: no switch applies to them and their jobs are not
 * pending. Runs before any customer is created, so a refused request leaves no trace.
 */
export async function resolveEmployeeSubmission(
  admin: SupabaseClient,
  caller: RequestUser,
  technicianId: string,
): Promise<EmployeeSubmission | null> {
  if (caller.role !== Role.EMPLOYEE) return null;

  if (technicianId !== caller.userId) {
    throw new ForbiddenException({
      error_code: ErrorCode.FORBIDDEN,
      message: 'Employees can only create jobs for themselves',
    });
  }

  const { data, error } = await admin
    .from('memberships')
    .select('can_create_jobs, job_approval_required')
    .eq('user_id', caller.userId)
    .eq('tenant_id', caller.tenantId as string)
    .eq('status', 'active')
    .maybeSingle<{ can_create_jobs: boolean; job_approval_required: boolean }>();

  if (error) {
    logger.error('Failed to read job switches:', { error });
    throw new InternalServerErrorException({
      error_code: ErrorCode.INTERNAL_SERVER_ERROR,
      message: 'Failed to create job',
    });
  }
  if (!data || !data.can_create_jobs) {
    throw new ForbiddenException({
      error_code: ErrorCode.FORBIDDEN,
      message: 'You are not allowed to create jobs. Ask your owner to turn this on.',
    });
  }
  return { pendingApproval: data.job_approval_required };
}
