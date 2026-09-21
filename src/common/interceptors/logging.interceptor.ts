import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { FastifyReply, FastifyRequest } from 'fastify';
import { getCorrelationContext } from '../correlation/correlation.context';
import { CorrelatedRequest } from '../correlation/correlation.interceptor';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest<CorrelatedRequest>();
    const reply = ctx.getResponse<FastifyReply>();

    const startTime = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          this.log(request, reply.statusCode, startTime);
        },
        error: (err: { status?: number }) => {
          const statusCode = err?.status ?? 500;
          this.log(request, statusCode, startTime);
        },
      }),
    );
  }

  private log(
    request: CorrelatedRequest,
    httpStatus: number,
    startTime: number,
  ): void {
    const durationMs = Date.now() - startTime;
    // The CorrelationInterceptor already merges the same fields via
    // CorrelationLogger; this structured line is self-contained so the access
    // log stays parseable even if the logger merge ever changes shape.
    const correlation = getCorrelationContext();
    this.logger.log(
      JSON.stringify({
        correlation_id: correlation?.correlationId ?? request.correlationId ?? null,
        session_id: correlation?.sessionId ?? request.sessionId ?? null,
        user_id: request.user?.userId ?? null,
        tenant_id: request.user?.tenantId ?? null,
        route: `${request.method} ${request.url}`,
        http_status: httpStatus,
        duration_ms: durationMs,
      }),
    );
  }
}
