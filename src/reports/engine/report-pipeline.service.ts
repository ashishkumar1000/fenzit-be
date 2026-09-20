import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseClientFactory } from '../../common/factories/supabase-client.factory';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { StorageService } from '../../storage/storage.service';
import { ReportRegistry } from '../registry/report-registry';
import {
  ReportDefinition,
  ReportFetchContext,
} from '../registry/report-definition';
import { PDF_RENDERER } from './pdf-renderer.port';
import type { PdfRenderer } from './pdf-renderer.port';
import { ReportRequestRow } from '../report-response.model';
import {
  markReportFailed,
  reportR2Key,
  stampReportReady,
} from './report-claims';

const PDF_CONTENT_TYPE = 'application/pdf';

/**
 * Runs one claimed report request end to end: fetch → render → upload →
 * ready stamp. The engine knows nothing about specific reports (FR-5) — it
 * resolves the definition from the registry and calls its contract members;
 * a definition that has not implemented its fetcher/builder yet (stories
 * 12-4/12-5 land them) fails cleanly with report_generation_failed.
 */
@Injectable()
export class ReportPipelineService {
  private readonly logger = new Logger(ReportPipelineService.name);

  constructor(
    private readonly supabaseClientFactory: SupabaseClientFactory,
    private readonly storageService: StorageService,
    private readonly registry: ReportRegistry,
    private readonly configService: ConfigService,
    @Inject(PDF_RENDERER) private readonly renderer: PdfRenderer,
  ) {}

  async run(row: ReportRequestRow): Promise<void> {
    const admin = this.supabaseClientFactory.createAdmin();
    try {
      const definition = this.definitionOrThrow(row.report_type);
      const data = await this.fetchData(definition, row, admin);
      const doc = this.buildDocument(definition, data);
      const pdf = await this.renderer.render(doc);
      await this.uploadAndStampReady(admin, row, pdf);
    } catch (err) {
      await this.fail(admin, row, err);
    }
  }

  private definitionOrThrow(reportType: string): ReportDefinition {
    const definition = this.registry.get(reportType);
    if (!definition) {
      // Unregistered types are rejected at create time; reaching here means
      // the registry changed after the request was queued — fail the row.
      throw new Error(`Report type '${reportType}' is not registered`);
    }
    return definition;
  }

  private async fetchData(
    definition: ReportDefinition,
    row: ReportRequestRow,
    admin: SupabaseClient,
  ): Promise<unknown> {
    if (!definition.fetchData) {
      throw new Error(
        `Report type '${definition.type}' has no data fetcher yet (story 12-5)`,
      );
    }
    const ctx: ReportFetchContext = {
      supabase: admin,
      tenantId: row.tenant_id,
      requestId: row.id,
      params: row.params,
      maxJobs: this.configService.get<number>('REPORT_MAX_JOBS') ?? 5000,
    };
    return definition.fetchData(ctx);
  }

  private buildDocument(
    definition: ReportDefinition,
    data: unknown,
  ): ReturnType<NonNullable<ReportDefinition['buildDocument']>> {
    if (!definition.buildDocument) {
      throw new Error(
        `Report type '${definition.type}' has no document builder yet (story 12-5)`,
      );
    }
    return definition.buildDocument(data);
  }

  private async uploadAndStampReady(
    admin: SupabaseClient,
    row: ReportRequestRow,
    pdf: Buffer,
  ): Promise<void> {
    // Terminal ordering (FR-4): upload strictly before the ready stamp.
    // The key is deterministic, so lease recovery re-uploads the same
    // object and a failed stamp's R2 orphan self-heals on the next attempt.
    const key = reportR2Key(row.tenant_id, row.id);
    await this.storageService.putObject(key, PDF_CONTENT_TYPE, pdf);
    await stampReportReady(admin, row.id, key, pdf.length);
  }

  private async fail(
    admin: SupabaseClient,
    row: ReportRequestRow,
    err: unknown,
  ): Promise<void> {
    const errorCode = this.mapErrorCode(err);
    this.logger.error('Report generation failed:', {
      tenantId: row.tenant_id,
      requestId: row.id,
      reportType: row.report_type,
      attempt: row.attempt_count,
      errorCode,
      err,
    });
    try {
      await markReportFailed(admin, row.id, errorCode);
    } catch (stampErr) {
      // The stamp itself failed — lease recovery will re-run the row; the
      // next attempt sees the same failure and retries the stamp.
      this.logger.error('Failed to stamp report failed:', {
        tenantId: row.tenant_id,
        requestId: row.id,
        stampErr,
      });
    }
  }

  /**
   * Definitions throw BadRequestException-shaped errors carrying a mapped
   * error_code (e.g. report_too_large in 12-5) — pass that code through;
   * everything else is a generic generation failure.
   */
  private mapErrorCode(err: unknown): string {
    const response = (err as { response?: { error_code?: string } })?.response;
    if (response?.error_code) {
      return response.error_code;
    }
    return ErrorCode.REPORT_GENERATION_FAILED;
  }
}
