import { Injectable, Logger } from '@nestjs/common';
import type { PdfRenderer } from './pdf-renderer.port';
import type { ReportDocument } from '../registry/report-definition';

/**
 * Placeholder binding until story 12-4 lands the pdfmake implementation.
 * Every render attempt fails fast, which the engine maps to a clean
 * `report_generation_failed` row — a queued report can never hang or
 * half-complete while the renderer is missing.
 */
@Injectable()
export class PdfRendererStub implements PdfRenderer {
  private readonly logger = new Logger(PdfRendererStub.name);

  async render(doc: ReportDocument): Promise<Buffer> {
    this.logger.error('PdfRenderer is not implemented yet (story 12-4)');
    throw new Error('PdfRenderer is not implemented yet (story 12-4)');
  }
}