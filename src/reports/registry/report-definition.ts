/**
 * Report-definition contract (FR9 — pluggable registry).
 *
 * One report type = one definition unit. The engine (state machine, worker,
 * R2, API) and the API layer know nothing about specific reports — registering
 * a new type is one definition file + one registry entry in
 * `report-registry.ts`, with zero engine/API changes (NFR6).
 *
 * `dataFetcher` and `templateBuilder` join this contract in story 12-5, when
 * the generation engine (story 12-3) starts calling them. Params validation is
 * complete here already, because the create endpoint validates on submit.
 */

import type { PoolClient } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The document definition a template builds for the renderer. Deliberately
 * structural for now — story 12-4's pdfmake implementation types it as
 * pdfmake's TDocumentDefinitions without the engine ever caring. Owned here
 * so registry stays the bottom layer (engine imports registry, never the
 * reverse).
 */
export type ReportDocument = Record<string, unknown>;

/**
 * Canonical params as stored in the `report_requests.params` jsonb column —
 * a discriminated-by-shape union since story 23-8 (the payslip type). The
 * range types carry the classic four fields; the payslip type carries the
 * exact triple that pins ONE payslip row (no report_type marker in the
 * stored jsonb — the `report_requests.report_type` column discriminates at
 * rest, and the guards below discriminate in code).
 */
export interface RangeReportParams {
  /** Calendar date (YYYY-MM-DD), inclusive. */
  start_date: string;
  /** Calendar date (YYYY-MM-DD), inclusive. */
  end_date: string;
  /** Selected technicians; empty array = all technicians of the tenant.
   *  For people-scoped reports (attendance) the same array carries the
   *  selected EMPLOYEES — the FE labels the field per report type. */
  technician_ids: string[];
  /** Selected offices; empty array = all offices. Only office-scoped
   *  reports (attendance) read it; definitions that do not scope by office
   *  must reject a non-empty value in validateParams. */
  office_ids: string[];
}

export interface PayslipReportParams {
  /** Wage month (YYYY-MM) — the payslip's salary_period. */
  month: string;
  /** The employee's membership id (the payslip row's membership_id). */
  membershipId: string;
  /** The payslip row id the PDF renders from. */
  payslipId: string;
}

export type ReportParams = RangeReportParams | PayslipReportParams;

export function isRangeParams(
  params: ReportParams,
): params is RangeReportParams {
  return 'start_date' in params;
}

export function isPayslipParams(
  params: ReportParams,
): params is PayslipReportParams {
  return 'payslipId' in params;
}

/** Raw params exactly as they arrive on the create-request body. */
export interface RangeRawParams {
  startDate: string;
  endDate: string;
  technicianIds?: string[] | null;
  officeIds?: string[] | null;
}

export interface PayslipRawParams {
  month: string;
  membershipId: string;
  payslipId: string;
}

export type RawReportParams = RangeRawParams | PayslipRawParams;

/**
 * What the engine hands a definition's fetcher: the admin Supabase client
 * (data access goes directly through the client — NFR5), the owning tenant,
 * and the validated params. Tenant scoping is the fetcher's contract (FR9).
 * `maxJobs` comes from the REPORT_MAX_JOBS env (handed in by the pipeline)
 * so definitions stay DI-free.
 */
export interface ReportFetchContext {
  supabase: SupabaseClient;
  tenantId: string;
  requestId: string;
  params: ReportParams;
  /** Oversize guard for the fetcher (FR2): exceeding fails report_too_large. */
  maxJobs: number;
  /**
   * A transaction-scoped raw-pg client (21-1): the pipeline opens one
   * `withTransaction` around every fetch. Definitions that read the shared
   * day-status grid use it; Supabase-only fetchers ignore it.
   */
  pg: PoolClient;
  /** Per-definition oversize guard in the definition's own row unit
   *  (REPORT_MAX_ATTENDANCE_ROWS for attendance; unused by job reports). */
  maxRows: number;
}

/**
 * What the pipeline hands a definition's pre-ready verification hook (23-8):
 * the same tenant scoping as a fetch, plus the fetched data — so a
 * snapshot-backed definition can re-verify its source row still exists with
 * the same content before its PDF is uploaded and stamped ready. The hook
 * runs OUTSIDE the fetch transaction (use `supabase`, not a pg client).
 */
export interface ReportVerifyContext {
  supabase: SupabaseClient;
  tenantId: string;
  requestId: string;
  params: ReportParams;
  data: unknown;
}

export interface ReportDefinition {
  /** Stable registry key, e.g. 'technician_job_activity'. */
  readonly type: string;
  /** Human-facing label (report title in PDFs and the FE history list). */
  readonly label: string;
  /**
   * Validates the raw params and returns the canonical stored shape. Throws
   * BadRequestException carrying the mapped error_code (VALIDATION_ERROR,
   * REPORT_RANGE_TOO_LARGE, ...).
   */
  validateParams(raw: RawReportParams): ReportParams;
  /**
   * Fetches the tenant-scoped data for one request (story 12-5 implements
   * the first one). Optional until implemented: the engine (story 12-3)
   * treats a missing fetcher/builder as a generation failure, so a
   * half-registered type degrades to a clean `failed` row, never a hang.
   * Throws BadRequestException with the mapped error_code on oversize/
   * validation failures (e.g. report_too_large).
   */
  fetchData?(ctx: ReportFetchContext): Promise<unknown>;
  /** Builds the renderer document from the fetched data (story 12-5). */
  buildDocument?(data: unknown): ReportDocument;
  /**
   * Optional last gate (23-8) — called after the fetch and BEFORE the
   * render, any upload, and the ready stamp. A throw → clean `failed`
   * request, nothing rendered, nothing uploaded. Closes the
   * fetch→verify→render supersession window for snapshot-backed reports:
   * the payslip definition re-verifies its snapshot row still exists with
   * the same slip_number/run_id it fetched, so a payslip destroyed by a
   * re-run can never be delivered as a PDF.
   */
  verifyBeforeReady?(ctx: ReportVerifyContext): Promise<void>;
  /**
   * Cap on explicitly selected people (21-1). Defaults to the service's
   * 25-technician cap; people-scoped reports with bigger rosters (the
   * attendance report's ~100-employee tenants) raise it — the row-unit
   * oversize guard stays the real scale protection.
   */
  readonly maxTechnicianIds?: number;
  /**
   * Definition-owned create-time DB checks that need the admin client
   * (21-1): module gating, membership of the selected offices/people.
   * Runs after validateParams and the service's technician-role check,
   * before the request row is inserted. Throws BadRequestException with a
   * mapped error_code.
   */
  validateAccess?(
    supabase: SupabaseClient,
    tenantId: string,
    params: RangeReportParams,
  ): Promise<void>;
}
