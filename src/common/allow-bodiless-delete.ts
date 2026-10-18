/**
 * The minimal shape this hook needs. Nest bundles its own copy of Fastify, so
 * the full `FastifyInstance` types of the two copies do not match.
 */
interface HookHost {
  addHook(
    name: 'onRequest',
    hook: (
      request: { method: string; headers: Record<string, unknown> },
      reply: unknown,
      done: () => void,
    ) => void,
  ): unknown;
}

/**
 * A DELETE that declares `Content-Type: application/json` but sends no body
 * is routine (HTTP clients often attach the header to every call). Fastify's
 * JSON parser rejects it with 400 "Body cannot be empty" BEFORE any guard
 * runs, so a technician got 400 instead of 403 (R-15).
 *
 * This hook drops the content-type of a body-less DELETE, so no body parser
 * runs and the request reaches the guards untouched. Only DELETE is relaxed:
 * a body-less POST/PUT/PATCH still gets the parser's 400.
 */
export function allowBodilessDelete(fastify: HookHost): void {
  fastify.addHook('onRequest', (request, _reply, done) => {
    const headers = request.headers;
    const hasBody =
      (headers['content-length'] !== undefined &&
        headers['content-length'] !== '0') ||
      headers['transfer-encoding'] !== undefined;
    if (request.method === 'DELETE' && !hasBody) {
      delete headers['content-type'];
    }
    done();
  });
}
