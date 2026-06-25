import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, of, tap } from 'rxjs';
import { FastifyRequest } from 'fastify';
import { SupabaseClientFactory } from '../factories/supabase-client.factory';
import { ErrorCode } from '../enums/error-code.enum';
import { RequestUser } from '../interfaces/request-user.interface';

const IDEMPOTENCY_HEADER = 'x-idempotency-key';
const WINDOW_MS = 24 * 60 * 60 * 1000; // 24-hour dedup window (FR-17)
// UUID v4 — the X-Idempotency-Key contract (FR-17).
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Read-through idempotency cache for idempotency-gated endpoints (FR-17, AR-9).
 *
 * Implemented as an Interceptor — NOT a Guard — because only an interceptor can
 * short-circuit the handler and emit a cached 200 response body (NestJS guards
 * may only return a boolean or throw). On a cache hit it returns the stored body
 * via `of(...)` so the route handler (and its RPC) never runs; on a miss it lets
 * the handler run and persists the successful response via `tap`.
 *
 * Scope is (key, tenant_id, scope) where scope = "METHOD:/concrete/path" — per the
 * IETF Idempotency-Key draft and Stripe, the key is bound to the tenant AND the
 * concrete request, so reusing one key on a different resource/endpoint never
 * replays the wrong cached body. Uses createAdmin() (RLS-bypassing) with app-layer
 * tenant scoping, consistent with the codebase.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(private readonly supabaseClientFactory: SupabaseClientFactory) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const req = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: RequestUser }>();

    const raw = req.headers[IDEMPOTENCY_HEADER];
    // No key → proceed normally (the key is optional per FR-17).
    if (!raw || typeof raw !== 'string') {
      return next.handle();
    }

    // Reject a malformed key (422) to keep the dedup store clean.
    if (!UUID_V4_RE.test(raw)) {
      throw new HttpException(
        {
          error_code: ErrorCode.VALIDATION_ERROR,
          message: 'X-Idempotency-Key must be a UUID v4',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const user = req.user;
    // No tenant context → let the handler/service produce the 400; never
    // short-circuit a tenant-less request.
    if (!user?.tenantId) {
      return next.handle();
    }

    const tenantId = user.tenantId;
    // Bind the key to the concrete request (method + path, query stripped) so the
    // same key on a different resource/endpoint cannot replay the wrong body.
    const scope = `${req.method}:${req.url.split('?')[0]}`;
    const admin = this.supabaseClientFactory.createAdmin();

    // Look up a prior response within the 24h window. The pg_cron cleanup is
    // Story 4.2; until then this filter enforces the window.
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const { data, error } = await admin
      .from('idempotency_log')
      .select('response_body')
      .eq('key', raw)
      .eq('tenant_id', tenantId)
      .eq('scope', scope)
      .gt('created_at', since)
      .maybeSingle<{ response_body: unknown }>();

    // A real lookup error must not be silently treated as a miss — log it, then
    // fail open (proceed to the handler) so an idempotency-store outage never
    // blocks a legitimate request.
    if (error) {
      this.logger.error('idempotency_log lookup failed', { error });
    }

    // Cache hit → replay the original body; the handler (and RPC) never runs.
    if (!error && data) {
      return of(data.response_body);
    }

    // Cache miss → run the handler, then persist the successful response.
    // `tap` fires only on a successful emission, so failed requests are never
    // cached (a retry re-executes). A concurrent duplicate (23505) is swallowed.
    return next.handle().pipe(
      tap((body) => {
        // Promise.resolve wraps the PostgREST thenable into a real Promise so a
        // rejection (e.g. a network fault) is caught — dedup is best-effort and
        // the request has already succeeded, so failures are swallowed after logs.
        void Promise.resolve(
          admin.from('idempotency_log').insert({
            key: raw,
            tenant_id: tenantId,
            scope,
            response_body: body,
          }),
        )
          .then(({ error: insertError }) => {
            if (insertError && insertError.code !== '23505') {
              this.logger.error('idempotency_log insert failed', {
                insertError,
              });
            }
          })
          .catch((cause: unknown) => {
            this.logger.error('idempotency_log insert threw', { cause });
          });
      }),
    );
  }
}
