import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  GoneException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NotFound } from '@aws-sdk/client-s3';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import { Role } from '../common/enums/role.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { PaginatedResponse } from '../common/dto/paginated-response.dto';
import { decodeCursor, encodeCursor } from '../common/utils/cursor.util';
import { StorageService } from '../storage/storage.service';
import { ReportRegistry } from './registry/report-registry';
import { TECHNICIAN_JOB_ACTIVITY_TYPE } from './registry/technician-job-activity.definition';
import { ReportRequestStatus } from './enums/report-status.enum';
import {
  CreateReportResponse,
  ReportListItemResponse,
  ReportRequestRow,
  ReportStatusResponse,
  reportFilename,
  toParamsResponse,
} from './report-response.model';
import { CreateReportRequestDto } from './dto/create-report-request.dto';
import { ListReportsQueryDto } from './dto/list-reports-query.dto';

/** NFR-3: at most 3 queued+generating requests per tenant. */
export const MAX_IN_FLIGHT_REPORTS = 3;
/** FR1: a report can be scoped to at most 25 technicians. */
export const MAX_TECHNICIANS_PER_REPORT = 25;

const PAGE_SIZE = 20;
const REPORTS_CURSOR_SCOPE = 'reports-list' as const;

/**
 * SQLSTATE raised by the report_requests in-flight guard trigger when a
 * tenant's queued+generating count is already at the cap. The app maps it to
 * 429 REPORT_IN_FLIGHT_LIMIT (PTxxx convention: last 3 digits = HTTP status).
 */
const PT_IN_FLIGHT_LIMIT = 'PT429';

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly supabaseClientFactory: SupabaseClientFactory,
    private readonly storageService: StorageService,
    private readonly registry: ReportRegistry,
    private readonly configService: ConfigService,
  ) {}

  async createReport(
    user: RequestUser,
    dto: CreateReportRequestDto,
  ): Promise<CreateReportResponse> {
    if (!user.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before requesting reports',
      });
    }

    const definition = this.registry.getOrThrow(
      dto.reportType?.trim() || TECHNICIAN_JOB_ACTIVITY_TYPE,
    );
    const params = definition.validateParams({
      startDate: dto.startDate,
      endDate: dto.endDate,
      technicianIds: dto.technicianIds,
    });
    params.technician_ids = await this.resolveTechnicianIds(
      user.tenantId,
      dto.technicianIds,
    );

    // Plain INSERT — the in-flight cap is enforced declaratively by the
    // report_requests guard trigger (PT429), so a plain write cannot race
    // past the cap no matter how many submissions run concurrently.
    const admin = this.supabaseClientFactory.createAdmin();
    const { data, error } = await admin
      .from('report_requests')
      .insert({
        tenant_id: user.tenantId,
        requested_by: user.userId,
        report_type: definition.type,
        params,
      })
      .select('*')
      .single<ReportRequestRow>();

    if (error) {
      if (error.code === PT_IN_FLIGHT_LIMIT) {
        throw new HttpException(
          {
            error_code: ErrorCode.REPORT_IN_FLIGHT_LIMIT,
            message: `Too many reports in progress — wait for one to finish (max ${MAX_IN_FLIGHT_REPORTS})`,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      this.logger.error('Failed to create report request:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to create report request',
      });
    }

    return { id: data.id, status: data.status, createdAt: data.created_at };
  }

  /**
   * Story 12-7: re-queues a FAILED request in place — the same row
   * regenerates and the history keeps one row per intent. A plain guarded
   * UPDATE (no RPC, de-SP rule): only a row still `failed` flips to
   * `queued`, so a concurrent double-tap cannot re-queue twice, and the
   * in-flight cap holds via the widened guard trigger (PT429 → 429, same
   * mapping as create). The error stamp clears and attempt_count resets —
   * a deliberate human retry is a fresh run of the worker's attempt budget.
   */
  async retryReport(
    user: RequestUser,
    requestId: string,
  ): Promise<CreateReportResponse> {
    const row = await this.getOwnRowOrThrow(user, requestId);
    if (row.status !== ReportRequestStatus.FAILED) {
      throw new HttpException(
        {
          error_code: ErrorCode.REPORT_NOT_RETRYABLE,
          message: 'Only a failed report can be retried',
        },
        HttpStatus.CONFLICT,
      );
    }

    const admin = this.supabaseClientFactory.createAdmin();
    const { data, error } = await admin
      .from('report_requests')
      .update({
        status: ReportRequestStatus.QUEUED,
        error_code: null,
        completed_at: null,
        locked_until: null,
        attempt_count: 0,
      })
      .eq('id', requestId)
      .eq('status', ReportRequestStatus.FAILED)
      .select('*');

    if (error) {
      if (error.code === PT_IN_FLIGHT_LIMIT) {
        throw new HttpException(
          {
            error_code: ErrorCode.REPORT_IN_FLIGHT_LIMIT,
            message: `Too many reports in progress — wait for one to finish (max ${MAX_IN_FLIGHT_REPORTS})`,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      this.logger.error('Failed to requeue report request:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to retry report request',
      });
    }

    // The status predicate lost the race — another retry (or an unexpected
    // state change) got there first. Same contract as "not retryable".
    if (!data || data.length === 0) {
      throw new HttpException(
        {
          error_code: ErrorCode.REPORT_NOT_RETRYABLE,
          message: 'Only a failed report can be retried',
        },
        HttpStatus.CONFLICT,
      );
    }

    return { id: row.id, status: data[0].status, createdAt: row.created_at };
  }

  async getReportStatus(
    user: RequestUser,
    requestId: string,
  ): Promise<ReportStatusResponse> {
    const row = await this.getOwnRowOrThrow(user, requestId);

    const response: ReportStatusResponse = {
      id: row.id,
      reportType: row.report_type,
      params: toParamsResponse(row.params),
      status: row.status,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };

    if (row.status === ReportRequestStatus.READY && row.r2_key) {
      response.file = {
        // Fresh presigned URL minted per request, never stored (FR3).
        url: await this.presignOrThrow(row.r2_key),
        sizeBytes: row.file_size_bytes ?? 0,
        filename: reportFilename(row),
      };
    } else if (row.status === ReportRequestStatus.FAILED) {
      response.error = {
        code: row.error_code ?? ErrorCode.REPORT_GENERATION_FAILED,
      };
    }

    return response;
  }

  async listReports(
    user: RequestUser,
    query: ListReportsQueryDto,
  ): Promise<PaginatedResponse<ReportListItemResponse>> {
    if (!user.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before viewing reports',
      });
    }

    const admin = this.supabaseClientFactory.createAdmin();
    let qb = admin
      .from('report_requests')
      .select('*')
      .eq('tenant_id', user.tenantId);

    // Keyset pagination, newest first (created_at desc, id tiebreaker).
    if (query.cursor) {
      const c = decodeCursor(query.cursor, REPORTS_CURSOR_SCOPE);
      qb = qb.or(
        `created_at.lt.${c.createdAt},and(created_at.eq.${c.createdAt},id.lt.${c.id})`,
      );
    }

    const { data, error } = await qb
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(PAGE_SIZE + 1);

    if (error) {
      this.logger.error('Failed to list report requests:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to list report requests',
      });
    }

    const rows = (data ?? []) as unknown as ReportRequestRow[];
    const hasMore = rows.length > PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor(last.id, last.created_at, REPORTS_CURSOR_SCOPE)
        : null;

    return new PaginatedResponse(
      pageRows.map((row) => this.toListItem(row)),
      nextCursor,
    );
  }

  private toListItem(row: ReportRequestRow): ReportListItemResponse {
    return {
      id: row.id,
      reportType: row.report_type,
      range: {
        startDate: row.params.start_date,
        endDate: row.params.end_date,
      },
      technicianCount: row.params.technician_ids?.length
        ? row.params.technician_ids.length
        : null,
      status: row.status,
      errorCode: row.error_code,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }

  /**
   * Fetches the row tenant-scoped (defense-in-depth over the admin client's
   * RLS bypass). Cross-tenant and unknown ids are indistinguishable → 404.
   */
  private async getOwnRowOrThrow(
    user: RequestUser,
    requestId: string,
  ): Promise<ReportRequestRow> {
    if (!user.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before viewing reports',
      });
    }

    const admin = this.supabaseClientFactory.createAdmin();
    const { data: row, error } = await admin
      .from('report_requests')
      .select('*')
      .eq('id', requestId)
      .eq('tenant_id', user.tenantId)
      .single<ReportRequestRow>();

    if (error && error.code !== 'PGRST116') {
      this.logger.error('Failed to fetch report request:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to fetch report request',
      });
    }
    if (!row || row.tenant_id !== user.tenantId) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'Report not found',
      });
    }
    return row;
  }

  private async presignOrThrow(r2Key: string): Promise<string> {
    const ttl =
      this.configService.get<number>('REPORT_PRESIGN_TTL_SECONDS') ?? 600;
    try {
      return await this.storageService.getPresignedReadUrl(r2Key, ttl);
    } catch (err) {
      // File was deleted/missing (persistent loss) → 410 Gone.
      if (err instanceof NotFound) {
        throw new GoneException({
          error_code: ErrorCode.REPORT_PRESIGN_FAILED,
          message: 'Report file is no longer available',
        });
      }
      // 5xx, timeout, or other transient error → 500 REPORT_PRESIGN_FAILED.
      this.logger.error('Failed to presign report PDF:', { r2Key, err });
      throw new InternalServerErrorException({
        error_code: ErrorCode.REPORT_PRESIGN_FAILED,
        message: 'Failed to generate the report download link',
      });
    }
  }

  /**
   * Validates the requested technician ids against the tenant's technicians.
   * Empty/absent → [] (all technicians, stored canonically as an empty array).
   */
  private async resolveTechnicianIds(
    tenantId: string,
    technicianIds: string[] | null | undefined,
  ): Promise<string[]> {
    const requested = [...new Set(technicianIds ?? [])];
    if (requested.length === 0) {
      return [];
    }

    if (requested.length > MAX_TECHNICIANS_PER_REPORT) {
      throw new BadRequestException({
        error_code: ErrorCode.REPORT_TOO_MANY_TECHNICIANS,
        message: `A report can be scoped to at most ${MAX_TECHNICIANS_PER_REPORT} technicians`,
      });
    }

    const admin = this.supabaseClientFactory.createAdmin();
    const { data, error } = await admin
      .from('users')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('role', Role.TECHNICIAN)
      .in('id', requested);

    if (error) {
      this.logger.error('Failed to validate report technicians:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to validate report technicians',
      });
    }

    const found = new Set((data ?? []).map((u) => u.id));
    const invalid = requested.filter((id) => !found.has(id));
    if (invalid.length > 0) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'technicianIds must all be technicians of your company',
      });
    }
    return requested;
  }
}
