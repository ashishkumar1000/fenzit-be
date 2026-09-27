import {
  BadRequestException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';

/**
 * Shared plumbing for the attendance RPC-backed services (15-2/15-3/15-5
 * pattern). Extracted at the 15-5 review: requireTenant, internalError and
 * the HINT vocabulary had grown duplicated near-verbatim across
 * weekly-offs.service and holidays.service. The per-service HINT → status
 * mapping (which hints mean 404 vs 409 vs 422) stays in each service — that
 * mapping IS the route contract.
 */

/** supabase-js admin client shape (RLS bypassed — service role server-side). */
export type Admin = ReturnType<SupabaseClientFactory['createAdmin']>;

const logger = new Logger('AttendanceRpc');

/**
 * SQLSTATE HINTs the attendance RPCs raise (each names its ErrorCode — the
 * service-side mapping reads these verbatim).
 */
export const HINT_TENANT_NOT_FOUND = 'ATTENDANCE_TENANT_NOT_FOUND';
export const HINT_EMPLOYEE_NOT_FOUND = 'ATTENDANCE_EMPLOYEE_NOT_FOUND';
export const HINT_NO_WORKING_DAYS = 'ATTENDANCE_NO_WORKING_DAYS';
export const HINT_HOLIDAY_TAKEN = 'ATTENDANCE_HOLIDAY_TAKEN';
export const HINT_HOLIDAY_NOT_FOUND = 'ATTENDANCE_HOLIDAY_NOT_FOUND';
/** days-CHECK backstop the DTO mirrors normally catch first. */
export const PG_CHECK_VIOLATION = '23514';

/** Shape of an error object surfaced by a failed supabase-js rpc() call. */
export type RpcError = { code?: string; hint?: string; message: string };

/** 400 gate — attendance is unusable before the owner has a company. */
export function requireTenant(user: RequestUser): string {
  if (!user.tenantId) {
    throw new BadRequestException({
      error_code: ErrorCode.VALIDATION_ERROR,
      message: 'Company setup required before using attendance',
    });
  }
  return user.tenantId;
}

/** 500 with the pinned error-code body (never leak raw DB errors). */
export function internalError(
  message: string,
): InternalServerErrorException {
  return new InternalServerErrorException({
    error_code: ErrorCode.INTERNAL_SERVER_ERROR,
    message,
  });
}

/** The 404 every attendance route reaches when attendance_today rejects. */
export function tenantNotFoundError(): NotFoundException {
  return new NotFoundException({
    error_code: ErrorCode.ATTENDANCE_TENANT_NOT_FOUND,
    message: 'Company setup required before using attendance',
  });
}

/**
 * The only source of "today" (AD-7) — server clock in the tenant timezone.
 * An unknown tenant fails loud as 404 (attendance_today's PT404 HINT — the
 * contract every attendance GET relies on); any other RPC failure is a 500.
 * A contract-breaking null also fails loud — a null flowing into the
 * `from <= today` range picks would silently empty them instead.
 */
export async function resolveTenantToday(
  admin: Admin,
  tenantId: string,
): Promise<string> {
  const { data, error } = await admin.rpc('attendance_today', {
    p_tenant_id: tenantId,
  });
  if (error) {
    if (error.hint === HINT_TENANT_NOT_FOUND) {
      throw tenantNotFoundError();
    }
    logger.error('attendance_today RPC failed:', { error });
    throw internalError('Failed to resolve tenant date');
  }
  if (!data) {
    throw internalError('Failed to resolve tenant date');
  }
  return data as string;
}
