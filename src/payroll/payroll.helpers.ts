import {
  BadRequestException,
  InternalServerErrorException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ErrorCode } from '../common/enums/error-code.enum';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';

/**
 * Shared plumbing for the payroll config services (23-3), kept payroll-local
 * so the module does not lean on attendance or members internals (the same
 * separation attendance.module declares for itself).
 */

/** 400 gate — payroll is unusable before the owner has a company. */
export function requireTenant(user: RequestUser): string {
  if (!user.tenantId) {
    throw new BadRequestException({
      error_code: ErrorCode.VALIDATION_ERROR,
      message: 'Company setup required before using payroll',
    });
  }
  return user.tenantId;
}

/** 500 with the pinned error-code body (never leak raw DB errors). */
export function internalError(message: string): InternalServerErrorException {
  return new InternalServerErrorException({
    error_code: ErrorCode.INTERNAL_SERVER_ERROR,
    message,
  });
}

/** 422 with the pinned error-code body — the payroll validation answer. */
export function validationError(message: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    error_code: ErrorCode.VALIDATION_ERROR,
    message,
  });
}

/**
 * One audit entry per real mutation, through the shared write_audit_row rpc.
 * An audit failure is logged, never thrown — it must not undo the save it
 * describes. The three payroll services that audit pass only their label;
 * the behaviour lives here so the rpc contract has one home.
 */
export async function writeAuditRow(
  admin: ReturnType<SupabaseClientFactory['createAdmin']>,
  logger: Logger,
  label: string,
  entry: {
    actorId: string | null;
    tenantId: string;
    action: string;
    targetUser: string | null;
    details: Record<string, unknown>;
  },
): Promise<void> {
  if (!entry.actorId) {
    // write_audit_row's p_actor is a uuid and must be a real user — an
    // actorless entry (e.g. a run row that somehow lost initiated_by) is
    // logged and skipped, never let it disturb the change it describes.
    logger.warn(`No actor for the ${label} audit entry — skipping`, {
      action: entry.action,
    });
    return;
  }
  try {
    const auditCall = (await admin.rpc('write_audit_row', {
      p_actor: entry.actorId,
      p_action: entry.action,
      p_tenant_id: entry.tenantId,
      p_target_user: entry.targetUser,
      p_details: entry.details,
    })) as { error: { code?: string; message?: string } | null };
    if (auditCall.error) {
      logger.error(`Failed to write the ${label} audit entry:`, {
        error: auditCall.error,
      });
    }
  } catch (rejection: unknown) {
    logger.error(`Failed to write the ${label} audit entry:`, {
      error: rejection,
    });
  }
}
