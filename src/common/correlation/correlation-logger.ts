import { ConsoleLogger } from '@nestjs/common';
import {
  CorrelationContext,
  getCorrelationContext,
} from './correlation.context';

/**
 * App-wide logger wired via `app.useLogger()` in main.ts. Nest routes every
 * `new Logger(Context)` call through the registered logger, so the
 * correlation context from AsyncLocalStorage is merged into every log line
 * WITHOUT touching call sites. Lines logged outside a request/worker scope
 * (boot, no-context code) pass through unchanged.
 */
export class CorrelationLogger extends ConsoleLogger {
  log(message: unknown, context?: string): void {
    super.log(this.merge(message), context);
  }

  warn(message: unknown, context?: string): void {
    super.warn(this.merge(message), context);
  }

  error(message: unknown, stackOrContext?: unknown, context?: string): void {
    super.error(this.merge(message), stackOrContext, context);
  }

  debug(message: unknown, context?: string): void {
    super.debug(this.merge(message), context);
  }

  verbose(message: unknown, context?: string): void {
    super.verbose(this.merge(message), context);
  }

  fatal(message: unknown, stackOrContext?: unknown, context?: string): void {
    super.fatal(this.merge(message), stackOrContext, context);
  }

  /**
   * A plain object message gets the fields merged in and is re-stringified
   * as one JSON line; a hand-JSONified string message (the LoggingInterceptor
   * access log) gets the same merge via a parse. Anything else gets a compact
   * JSON suffix. No ALS store → message untouched.
   */
  private merge(message: unknown): unknown {
    const store = getCorrelationContext();
    if (!store) {
      return message;
    }
    const fields = correlationLogFields(store);
    // Plain object → merge fields and emit one JSON line (avoids the
    // `[object Object]` degradation of String(object)).
    if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
      return JSON.stringify({ ...(message as object), ...fields });
    }
    if (typeof message === 'string' && message.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(message);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return JSON.stringify({ ...(parsed as object), ...fields });
        }
      } catch {
        // Not JSON after all — fall through to the suffix form.
      }
    }
    return `${String(message)} ${JSON.stringify(fields)}`;
  }
}

/** Context fields for the merged log line; nulls are dropped to keep lines compact. */
export function correlationLogFields(
  store: CorrelationContext,
): Record<string, string> {
  const fields: Record<string, string> = {
    correlation_id: store.correlationId,
  };
  if (store.sessionId) {
    fields.session_id = store.sessionId;
  }
  if (store.userId) {
    fields.user_id = store.userId;
  }
  if (store.tenantId) {
    fields.tenant_id = store.tenantId;
  }
  return fields;
}
