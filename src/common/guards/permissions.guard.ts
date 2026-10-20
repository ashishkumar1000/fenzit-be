import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ANY_MEMBER_KEY } from '../decorators/any-member.decorator';
import { CAN_KEY } from '../decorators/can.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ErrorCode } from '../enums/error-code.enum';
import {
  Permission,
  PLATFORM_WIDE_PERMISSIONS,
  permissionsFor,
} from '../permissions/permissions';
import { RequestUser } from '../interfaces/request-user.interface';

/**
 * Deny by default (decision 10). An endpoint is reachable only when it is
 * `@Public`, `@AnyMember`, or `@Can(...)` a permission the caller's role holds.
 * An endpoint declaring none of these is refused, so a forgotten decorator
 * can never open a route.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }
    if (this.reflector.getAllAndOverride<boolean>(ANY_MEMBER_KEY, targets)) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<Permission[]>(
      CAN_KEY,
      targets,
    );
    const request = context.switchToHttp().getRequest<{ user?: RequestUser }>();
    const user = request.user;

    if (!user || !required || required.length === 0) {
      throw this.forbidden('Insufficient permissions');
    }

    const held = permissionsFor(user.role);
    // A company-scoped permission needs a company. Only a platform admin who
    // named none can reach this point without one, so check each permission
    // they hold against that rule, in declaration order, and take the first
    // one that fits. The decorator's order must not decide the outcome.
    const usable = required.find(
      (p) => held.has(p) && (user.tenantId || PLATFORM_WIDE_PERMISSIONS.has(p)),
    );
    if (usable) return true;

    if (required.some((p) => held.has(p))) {
      throw this.forbidden('Name the company with the X-Company-Id header');
    }
    throw this.forbidden('Insufficient permissions');
  }

  private forbidden(message: string): ForbiddenException {
    return new ForbiddenException({
      error_code: ErrorCode.FORBIDDEN,
      message,
    });
  }
}
