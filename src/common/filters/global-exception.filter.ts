import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { ErrorCode } from '../enums/error-code.enum';
import { CorrelatedRequest } from '../correlation/correlation.interceptor';
import { getCorrelationContext } from '../correlation/correlation.context';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorCode = ErrorCode.INTERNAL_SERVER_ERROR;
    let message = 'An unexpected error occurred';
    // Extra structured fields a thrown exception may carry alongside
    // error_code/message (e.g. currentStep on an INVALID_WORKFLOW_STEP 422).
    // Forwarded verbatim into the response body; empty for ordinary errors.
    let extra: Record<string, unknown> = {};
    // `retryAfterSeconds`, when present on a thrown exception's body (e.g. the
    // places 429), is lifted out into a Retry-After response header instead of
    // being forwarded as a body field.
    let retryAfterSeconds: number | undefined;

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const response = exception.getResponse();

      if (typeof response === 'object' && response !== null) {
        const r = response as Record<string, unknown>;
        errorCode =
          (r['error_code'] as ErrorCode) ??
          this.httpStatusToErrorCode(statusCode);
        message = (r['message'] as string) ?? exception.message;
        // Forward any additional structured fields verbatim (e.g. currentStep),
        // minus the keys already represented in the canonical envelope. `error` is
        // Nest's default exception label (e.g. 'Unprocessable Entity' from
        // ValidationPipe) — strip it so it never leaks into our envelope.
        extra = { ...r };
        const rawRetryAfter = r['retryAfterSeconds'];
        delete extra['error_code'];
        delete extra['message'];
        delete extra['statusCode'];
        delete extra['error'];
        delete extra['stack'];
        delete extra['retryAfterSeconds'];
        if (
          typeof rawRetryAfter === 'number' &&
          Number.isFinite(rawRetryAfter) &&
          rawRetryAfter > 0
        ) {
          retryAfterSeconds = Math.ceil(rawRetryAfter);
        }
      } else {
        errorCode = this.httpStatusToErrorCode(statusCode);
        message = exception.message;
      }
    } else {
      // For request exceptions the correlation ALS store is still active
      // here (the filter runs inside CorrelationInterceptor's wrapped
      // subscription), so CorrelationLogger.merge appends the ids to this
      // line itself. The suffix below is only the fallback for the rare
      // case where the store is gone but the request was already stamped.
      const request = ctx.getRequest<CorrelatedRequest>();
      let ids = '';
      if (!getCorrelationContext() && request?.correlationId) {
        ids = ` ${JSON.stringify({
          correlation_id: request.correlationId,
          ...(request.sessionId ? { session_id: request.sessionId } : {}),
        })}`;
      }
      this.logger.error(
        `Unhandled exception${ids}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const isProduction = process.env.NODE_ENV === 'production';

    if (retryAfterSeconds !== undefined) {
      void reply.header('Retry-After', String(retryAfterSeconds));
    }

    void reply.status(statusCode).send({
      statusCode,
      error_code: errorCode,
      message,
      ...extra,
      ...(!isProduction && exception instanceof Error
        ? { stack: exception.stack }
        : {}),
    });
  }

  private httpStatusToErrorCode(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.RESOURCE_NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.DUPLICATE_RESOURCE;
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return ErrorCode.VALIDATION_ERROR;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMIT_EXCEEDED;
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.VALIDATION_ERROR;
      default:
        return ErrorCode.INTERNAL_SERVER_ERROR;
    }
  }
}
