import { Injectable, Logger } from '@nestjs/common';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import type { PdfRenderer } from './pdf-renderer.port';
import type { ReportDocument } from '../registry/report-definition';
import { fontDescriptor, fontsDir } from '../templates/brand-kit/brand-assets';

/**
 * pdfmake 0.3's server entry is a CommonJS singleton (`module.exports = new
 * pdfmake()`): its methods live on the instance, not as named exports, so
 * named ESM imports don't resolve (Bun fails at module load). Require the
 * instance directly and type the surface we use.
 */
interface PdfmakeServer {
  setUrlAccessPolicy(callback: (url: string) => boolean): void;
  setLocalAccessPolicy(callback: (path: string) => boolean): void;
  addFonts(fonts: Record<string, Record<string, string>>): void;
  createPdf(doc: TDocumentDefinitions): { getBuffer(): Promise<Buffer> };
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfmake = require('pdfmake') as PdfmakeServer;

/**
 * pdfmake implementation of the PdfRenderer port (FR-6) — story 12-4.
 *
 * Fonts register once (absolute paths of the brand-kit TTFs); every render
 * call compiles the doc definition and collects the PDF into a Buffer — no
 * temp files. Access is policy-locked: report PDFs never fetch external
 * URLs, and local file reads are allowlisted to the bundled fonts dir (the
 * logo is a data URI), so a doc definition cannot turn the renderer into an
 * SSRF or file-read primitive.
 *
 * Swapping renderers later (Puppeteer / Gotenberg) = rebind PDF_RENDERER;
 * templates and engine never change.
 */
@Injectable()
export class PdfmakeRenderer implements PdfRenderer {
  private readonly logger = new Logger(PdfmakeRenderer.name);
  private static fontsRegistered = false;

  constructor() {
    if (!PdfmakeRenderer.fontsRegistered) {
      // The singleton's policies are process-wide; the reports module is the
      // only pdfmake consumer, so setting them here is the whole surface.
      pdfmake.setUrlAccessPolicy(() => false);
      pdfmake.setLocalAccessPolicy((path) => path.startsWith(fontsDir));
      pdfmake.addFonts(fontDescriptor);
      PdfmakeRenderer.fontsRegistered = true;
      this.logger.log('pdfmake fonts registered (Inter regular/semibold/bold)');
    }
  }

  async render(doc: ReportDocument): Promise<Buffer> {
    // ReportDocument stays structural at the port (renderer-agnostic); the
    // pdfmake shape is enforced here, at the single binding point.
    const created = pdfmake.createPdf(doc as unknown as TDocumentDefinitions);
    return created.getBuffer();
  }
}
