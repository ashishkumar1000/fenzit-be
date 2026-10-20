import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { ErrorCode } from '../enums/error-code.enum';

interface RpcError {
  code?: string;
  hint?: string | null;
}

/**
 * Turns an error raised by one of the membership database functions
 * (invite_member, change_member_role, remove_member, set_user_disabled,
 * setup_tenant_for_owner) into the API's error. The functions raise
 * `PT4xx` (the last digits are the HTTP status) with a `hint` naming the API
 * error code. Returns null for any other database error, which the caller
 * treats as a 500.
 */
export function memberRpcException(error: RpcError): HttpException | null {
  switch (error.code) {
    case 'PT400':
      if (error.hint === ErrorCode.PLATFORM_STAFF_NOT_MEMBER) {
        return new BadRequestException({
          error_code: ErrorCode.PLATFORM_STAFF_NOT_MEMBER,
          message: 'This number belongs to Fenzit staff and cannot join a company',
        });
      }
      return new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'The request is not valid',
      });
    case 'PT403':
      return new ForbiddenException({
        error_code: ErrorCode.FORBIDDEN,
        message: 'You do not have permission to do that',
      });
    case 'PT404':
      return new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'Not found',
      });
    case 'PT409':
      if (error.hint === ErrorCode.LAST_ADMIN) {
        return new ConflictException({
          error_code: ErrorCode.LAST_ADMIN,
          message: 'A company must keep at least one active admin',
        });
      }
      if (error.hint === ErrorCode.ALREADY_IN_TEAM) {
        return new ConflictException({
          error_code: ErrorCode.ALREADY_IN_TEAM,
          message: 'This person is already in your company',
        });
      }
      return new ConflictException({
        error_code: ErrorCode.DUPLICATE_RESOURCE,
        message: 'This person already belongs to a company',
      });
    default:
      return null;
  }
}
