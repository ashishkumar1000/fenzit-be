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

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The document definition a template builds for the renderer. Deliberately
 * structural for now — story 12-4's pdfmake implementation types it as
 * pdfmake's TDocumentDefinitions without the engine ever caring. Owned here
 * so registry stays the bottom layer (engine imports registry, never the
 * reverse).
 */
export type ReportDocument = Record<string, unknown>;

/** Canonical params as stored in the `report_requests.params` jsonb column. */
export interface ReportParams {
  /** Calendar date (YYYY-MM-DD), inclusive. */
  start_date: string;
  /** Calendar date (YYYY-MM-DD), inclusive. */
  end_date: string;
  /** Selected technicians; empty array = all technicians of the tenant. */
  technician_ids: string[];
}

/** Raw params exactly as they arrive on the create-request body. */
export interface RawReportParams {
  startDate: string;
  endDate: string;
  technicianIds?: string[] | null;
}

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
}
