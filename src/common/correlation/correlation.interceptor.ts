import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { randomUUID } from 'crypto';
import { FastifyReply, FastifyRequest } from 'fastify';
import { RequestUser } from '../interfaces/request-user.interface';
import { CorrelationContext, runWithCorrelation } from './correlation.context';
import {
  CORRELATION_HEADER,
  SESSION_HEADER,
  parseCorrelationHeader,
} from './correlation-headers';

export interface CorrelatedRequest extends FastifyRequest {
  user?: RequestUser;
  correlationId?: string;
  sessionId?: string | null;
}

/**
 * Registered as the FIRST APP_INTERCEPTOR (before LoggingInterceptor):
 * validates the client-supplied correlation/session headers, falls back to a
 * generated id, echoes the validated values back, and runs the request chain
 * inside the AsyncLocalStorage context that every log line merges.
 *
 * Guards run before interceptors, so `request.user` is already attached here;
 * if a guard throws, no interceptor runs and the ids are absent for that
 * response (same as the previous x-request-id behavior).
 */
@Injectable()
export class CorrelationInterceptor implements NestInterceptor {
  private readonly logger = new Logger(CorrelationInterceptor.name);

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest<CorrelatedRequest>();
    const reply = ctx.getResponse<FastifyReply>();

    const store: CorrelationContext = {
      correlationId:
        parseCorrelationHeader(request.headers[CORRELATION_HEADER]) ??
        randomUUID(),
      sessionId: parseCorrelationHeader(request.headers[SESSION_HEADER]),
      userId: request.user?.userId ?? null,
      tenantId: request.user?.tenantId ?? null,
    };

    // Hygiene signal when a session header arrived but was unusable (the
    // correlation header needs no signal — regenerating it is the design).
    // The raw value is NEVER logged (injection defense).
    if (request.headers[SESSION_HEADER] !== undefined && !store.sessionId) {
      this.logger.warn(
        'Rejected an invalid x-session-id header (not a UUID or over-length); request continues without a session id',
      );
    }

    // Stamp the raw request too — the GlobalExceptionFilter reads the ids
    // from here when the ALS store is unavailable at its error site.
    request.correlationId = store.correlationId;
    request.sessionId = store.sessionId;

    void reply.header(CORRELATION_HEADER, store.correlationId);
    if (store.sessionId) {
      void reply.header(SESSION_HEADER, store.sessionId);
    }

    // Wrap the SUBSCRIPTION, not next.handle(): the handler runs when the
    // chain is subscribed (after intercept() returns), so the store must be
    // active at subscription time for it to reach downstream code.
    return new Observable<unknown>((subscriber) =>
      runWithCorrelation(store, () => next.handle().subscribe(subscriber)),
    );
  }
}
