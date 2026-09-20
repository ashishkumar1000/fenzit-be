import { ReportParams } from './registry/report-definition';
import { ReportRequestStatus } from './enums/report-status.enum';

/** A `report_requests` row as PostgREST returns it. */
export interface ReportRequestRow {
  id: string;
  tenant_id: string;
  requested_by: string;
  report_type: string;
  params: ReportParams;
  status: ReportRequestStatus;
  /** Lease claim counter — bumped by each worker claim (crash recovery). */
  attempt_count: number;
  /** Lease deadline; null unless the row is (or was) generating. */
  locked_until: string | null;
  r2_key: string | null;
  file_size_bytes: number | null;
  error_code: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface CreateReportResponse {
  id: string;
  status: ReportRequestStatus;
  createdAt: string;
}

/** Present only when status = ready (FR3). */
export interface ReportFileResponse {
  /** Fresh short-lived presigned R2 URL — minted per request, never stored. */
  url: string;
  sizeBytes: number;
  filename: string;
}

export interface ReportParamsResponse {
  startDate: string;
  endDate: string;
  technicianIds: string[];
}

export interface ReportStatusResponse {
  id: string;
  reportType: string;
  params: ReportParamsResponse;
  status: ReportRequestStatus;
  createdAt: string;
  completedAt: string | null;
  file?: ReportFileResponse;
  /** Present only when status = failed — stable error_code from the engine. */
  error?: { code: string };
}

/** One history-list row (FR4). */
export interface ReportListItemResponse {
  id: string;
  reportType: string;
  range: { startDate: string; endDate: string };
  /** Selected technician count; null = all technicians of the tenant. */
  technicianCount: number | null;
  status: ReportRequestStatus;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** Deterministic artifact filename (also used by the engine upload path). */
export function reportFilename(row: ReportRequestRow): string {
  return `${row.report_type}_${row.params.start_date}_${row.params.end_date}.pdf`;
}

export function toParamsResponse(params: ReportParams): ReportParamsResponse {
  return {
    startDate: params.start_date,
    endDate: params.end_date,
    technicianIds: params.technician_ids ?? [],
  };
}
