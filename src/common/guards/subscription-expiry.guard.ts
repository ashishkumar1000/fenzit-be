import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyRequest } from 'fastify';
import { ALLOW_EXPIRED_SUBSCRIPTION_KEY } from '../decorators/allow-expired-subscription.decorator';
import { ErrorCode } from '../enums/error-code.enum';
import { Role } from '../enums/role.enum';
import { RequestUser } from '../interfaces/request-user.interface';
import { SupabaseClientFactory } from '../factories/supabase-client.factory';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const SUBSCRIPTION_EXPIRED_MESSAGE =
  'Your company subscription has ended. You cannot make changes until it is renewed.';

/**
 * Refuses an OWNER's writes once the company subscription has ended (CAP-2).
 *
 * Only the company admin (owner) role is blocked. Technicians and viewers keep
 * working in an expired company, and platform admins are never blocked. Reads
 * always pass. The expiry date is read from the database on every request
 * (no cache), so a manual extension takes effect at once. Registered after
 * JwtAuthGuard and PermissionsGuard, so `request.user` is already set.
 */
@Injectable()
export class SubscriptionExpiryGuard implements CanActivate {
  private readonly logger = new Logger(SubscriptionExpiryGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly supabaseFactory: SupabaseClientFactory,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: RequestUser }>();
    const user = request.user;

    // Public routes have no user; reads and exempt routes pass as well.
    if (!user || READ_METHODS.has(request.method)) return true;
    if (
      this.reflector.getAllAndOverride<boolean>(
        ALLOW_EXPIRED_SUBSCRIPTION_KEY,
        [context.getHandler(), context.getClass()],
      )
    ) {
      return true;
    }
    // Only the owner's writes are gated. Staff are never blocked.
    if (
      user.platformAdmin ||
      !user.tenantId ||
      user.role !== Role.COMPANY_ADMIN
    ) {
      return true;
    }

    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .from('tenants')
      .select('validity_until')
      .eq('id', user.tenantId)
      .maybeSingle<{ validity_until: string | null }>();

    if (error) {
      this.logger.error('Failed to read the subscription for a write:', error);
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Could not check your subscription',
      });
    }
    // No company row or no date: nothing to enforce.
    if (!data?.validity_until) return true;

    const validUntil = Date.parse(data.validity_until);
    // A date we cannot read must not let an owner write through (fail closed).
    if (Number.isNaN(validUntil)) {
      this.logger.error(
        `Unreadable validity_until for tenant ${user.tenantId}`,
      );
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Could not check your subscription',
      });
    }

    if (Date.now() >= validUntil) {
      throw new HttpException(
        {
          error_code: ErrorCode.SUBSCRIPTION_EXPIRED,
          message: SUBSCRIPTION_EXPIRED_MESSAGE,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    return true;
  }
}
