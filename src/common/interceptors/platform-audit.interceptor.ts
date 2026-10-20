import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import type { FastifyRequest } from 'fastify';
import { SupabaseClientFactory } from '../factories/supabase-client.factory';
import type { RequestUser } from '../interfaces/request-user.interface';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Roles spec decisions 13 and 42: every write a platform admin makes is
 * recorded. One place, so no individual endpoint can forget it.
 *
 * Records AFTER the write succeeded (a refused or failed call changed nothing).
 * If the audit insert itself fails the request is not undone — the write
 * already happened — so the failure is logged loudly instead.
 */
@Injectable()
export class PlatformAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(PlatformAuditInterceptor.name);

  constructor(private readonly supabaseFactory: SupabaseClientFactory) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: RequestUser }>();

    return next.handle().pipe(
      tap(() => {
        const user = request.user;
        if (!user?.platformAdmin || !WRITE_METHODS.has(request.method)) return;
        void this.record(user, request).catch((err: unknown) => {
          // Never an unhandled rejection: the write already happened, so log it.
          this.logger.error(
            'Failed to audit a platform-admin write',
            err instanceof Error ? err.stack : String(err),
          );
        });
      }),
    );
  }

  private async record(
    user: RequestUser,
    request: FastifyRequest,
  ): Promise<void> {
    const route = request.routeOptions?.url ?? request.url.split('?')[0];
    // Routes that act on one person name them as :userId; record that person
    // as the target. Anything that is not a UUID is not a target.
    const params = request.params as Record<string, unknown> | undefined;
    const rawTarget = typeof params?.userId === 'string' ? params.userId : null;
    const targetUserId = rawTarget && UUID_PATTERN.test(rawTarget) ? rawTarget : null;

    const { error } = await this.supabaseFactory
      .createAdmin()
      .rpc('write_audit_row', {
        p_actor: user.userId,
        p_action: `platform.write ${request.method} ${route}`.slice(0, 200),
        p_tenant_id: user.tenantId,
        p_target_user: targetUserId,
        p_details: { method: request.method, route },
      });
    if (error) {
      this.logger.error('Failed to audit a platform-admin write', {
        code: error.code,
        route,
      });
    }
  }
}
