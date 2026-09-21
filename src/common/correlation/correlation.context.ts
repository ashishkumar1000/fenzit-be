import { AsyncLocalStorage } from 'async_hooks';

/**
 * Per-request correlation context carried through the async chain via
 * AsyncLocalStorage. `userId`/`tenantId` come from `request.user` attached
 * by JwtAuthGuard — never from a client header. Fields are null when absent
 * (public routes, worker jobs) so log lines stay clean without undefined
 * noise.
 */
export interface CorrelationContext {
  correlationId: string;
  sessionId: string | null;
  userId: string | null;
  tenantId: string | null;
}

const correlationStore = new AsyncLocalStorage<CorrelationContext>();

/** Reads the current context, or null outside a request/worker scope. */
export function getCorrelationContext(): CorrelationContext | null {
  return correlationStore.getStore() ?? null;
}

/**
 * Runs `fn` with `context` active for every async operation it initiates.
 * Prefer run() over enterWith() — enterWith leaks the context past its
 * boundary (Node async_context docs).
 */
export function runWithCorrelation<T>(context: CorrelationContext, fn: () => T): T {
  return correlationStore.run(context, fn);
}
