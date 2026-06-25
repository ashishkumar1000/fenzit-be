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
        delete extra['error_code'];
        delete extra['message'];
        delete extra['statusCode'];
        delete extra['error'];
        delete extra['stack'];
      } else {
        errorCode = this.httpStatusToErrorCode(statusCode);
        message = exception.message;
      }
    } else {
      this.logger.error(
        'Unhandled exception',
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const isProduction = process.env.NODE_ENV === 'production';

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
