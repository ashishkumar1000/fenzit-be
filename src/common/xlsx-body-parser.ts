type ParserDone = (err: Error | null, body?: unknown) => void;
type Parser = (req: unknown, body: Buffer, done: ParserDone) => void;

/**
 * The minimal shape this needs. Nest bundles its own copy of Fastify, so the
 * full `FastifyInstance` types of the two copies do not match (the
 * allow-bodiless-delete precedent).
 */
interface ParserHost {
  addContentTypeParser(
    contentType: RegExp,
    options: { parseAs: 'buffer'; bodyLimit?: number },
    parser: Parser,
  ): void;
}

/** The MIME Excel sheets travel under; browsers send it verbatim for a File body. */
export const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * POST /attendance/holidays/bulk uploads the FILLED sheet as a raw .xlsx body
 * (no multipart — one file, no form fields, so no @fastify/multipart either).
 * Fastify has no parser for this content type and would 415 before the
 * guards; this hands the raw Buffer to the route as `request.body`.
 */
export function acceptXlsxBody(fastify: ParserHost): void {
  fastify.addContentTypeParser(
    new RegExp(`^${XLSX_MIME.replace('/', '\\/')}(;|$)`),
    // 10MB — the console promises the sheet fits; the parser caps at Fastify's
    // 1MB default otherwise, and a filled 500-row sheet with formatting can
    // legitimately run larger than that.
    { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );
}
