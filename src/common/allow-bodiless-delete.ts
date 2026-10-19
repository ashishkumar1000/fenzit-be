type ParserDone = (err: Error | null, body?: unknown) => void;
type Parser = (req: { method: string }, body: Buffer, done: ParserDone) => void;

/**
 * The minimal shape this needs. Nest bundles its own copy of Fastify, so the
 * full `FastifyInstance` types of the two copies do not match.
 */
interface ParserHost {
  initialConfig: {
    bodyLimit?: number;
    onProtoPoisoning?: 'error' | 'remove' | 'ignore';
    onConstructorPoisoning?: 'error' | 'remove' | 'ignore';
  };
  getDefaultJsonParser(
    onProtoPoisoning: 'error' | 'remove' | 'ignore',
    onConstructorPoisoning: 'error' | 'remove' | 'ignore',
  ): (req: never, body: never, done: never) => void;
  removeContentTypeParser(contentType: string): void;
  addContentTypeParser(
    contentType: string,
    options: { parseAs: 'buffer'; bodyLimit?: number },
    parser: Parser,
  ): void;
  addHook(name: 'onReady', hook: (done: () => void) => void): unknown;
}

/**
 * A DELETE that declares `Content-Type: application/json` but sends no body
 * is routine (HTTP clients often attach the header to every call, and some
 * send it chunked). Fastify's JSON parser rejects it with 400 "Body cannot be
 * empty" BEFORE any guard runs, so a technician got 400 instead of 403 (R-15).
 *
 * This swaps the JSON parser for one that gives an EMPTY DELETE body as
 * `undefined`, so the request reaches the guards. Everything else delegates
 * to Fastify's own default parser (same prototype-poisoning handling, same
 * errors), so an empty or malformed body on POST/PUT/PATCH, or malformed JSON
 * on DELETE, is still a 400.
 *
 * Nest registers its own JSON parser while `app.init()` runs, so the swap is
 * done in an `onReady` hook (after Nest's parser exists, before listening).
 * Call this BEFORE `app.init()` / `app.listen()`.
 */
export function allowBodilessDelete(fastify: ParserHost): void {
  fastify.addHook('onReady', (done) => {
    const { bodyLimit, onProtoPoisoning, onConstructorPoisoning } =
      fastify.initialConfig;
    const defaultParser = fastify.getDefaultJsonParser(
      onProtoPoisoning ?? 'error',
      onConstructorPoisoning ?? 'error',
    );
    fastify.removeContentTypeParser('application/json');
    fastify.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit },
      (req, body, parserDone) => {
        if (req.method === 'DELETE' && body.length === 0) {
          parserDone(null, undefined);
          return;
        }
        // Same call Nest makes: Fastify's default parser accepts the buffer.
        (defaultParser as Parser)(req, body, parserDone);
      },
    );
    done();
  });
}
