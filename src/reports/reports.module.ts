import { Module } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { ReportRegistry } from './registry/report-registry';
import { SupabaseModule } from '../supabase/supabase.module';
import { StorageModule } from '../storage/storage.module';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import { PDF_RENDERER } from './engine/pdf-renderer.port';
import { PdfmakeRenderer } from './engine/pdfmake-renderer';
import { ReportPipelineService } from './engine/report-pipeline.service';
import { ReportWorker } from './engine/report-worker';

/**
 * Report module (Epic 12) — self-contained per NFR5: the only cross-module
 * dependencies are common/ (auth, errors, cursor, idempotency) and storage
 * (R2 presign + the engine's putObject upload path). Data access goes through
 * the Supabase client directly — no imports from jobs/, customers/, etc.
 *
 * The PDF_RENDERER token binds the pdfmake implementation (brand kit + Inter
 * fonts register once at construction); templates (story 12-5) emit
 * ReportDocuments through the brand kit, never touching fonts/colours/logo.
 */
@Module({
  imports: [SupabaseModule, StorageModule],
  controllers: [ReportsController],
  providers: [
    ReportsService,
    ReportRegistry,
    IdempotencyInterceptor,
    ReportPipelineService,
    ReportWorker,
    { provide: PDF_RENDERER, useClass: PdfmakeRenderer },
  ],
  exports: [ReportsService, ReportRegistry],
})
export class ReportsModule {}
