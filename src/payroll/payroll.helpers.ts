import {
  BadRequestException,
  InternalServerErrorException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ErrorCode } from '../common/enums/error-code.enum';
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
