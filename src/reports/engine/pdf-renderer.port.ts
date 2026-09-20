/**
 * PdfRenderer port (FR-6) — owned by the reports module, implemented with
 * pdfmake in story 12-4. Templates (story 12-5) emit a ReportDocument
 * through the brand kit; the port turns it into PDF bytes. Swapping the
 * renderer later (Puppeteer / Gotenberg) touches only the implementation
 * binding, never templates or engine.
 */

import type { ReportDocument } from '../registry/report-definition';

/** Injection token for the renderer binding in reports.module.ts. */
export const PDF_RENDERER = Symbol('PDF_RENDERER');

export interface PdfRenderer {
  /** Renders the document and resolves with the PDF bytes. */
  render(doc: ReportDocument): Promise<Buffer>;
}
