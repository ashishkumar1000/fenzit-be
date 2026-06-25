import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { randomUUID } from 'crypto';
import { FastifyReply, FastifyRequest } from 'fastify';
import { RequestUser } from '../interfaces/request-user.interface';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest<
      FastifyRequest & { user?: RequestUser; requestId?: string }
    >();
    const reply = ctx.getResponse<FastifyReply>();

    const requestId = randomUUID();
    request.requestId = requestId;
    void reply.header('x-request-id', requestId);

    const startTime = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          this.log(request, reply.statusCode, startTime, requestId);
        },
        error: (err: { status?: number }) => {
          const statusCode = err?.status ?? 500;
          this.log(request, statusCode, startTime, requestId);
        },
      }),
    );
  }

  private log(
    request: FastifyRequest & { user?: RequestUser; requestId?: string },
    httpStatus: number,
    startTime: number,
    requestId: string,
  ): void {
    const durationMs = Date.now() - startTime;
    this.logger.log(
      JSON.stringify({
        request_id: requestId,
        tenant_id: request.user?.tenantId ?? null,
        route: `${request.method} ${request.url}`,
        http_status: httpStatus,
        duration_ms: durationMs,
      }),
    );
  }
}
