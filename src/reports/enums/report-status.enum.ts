export enum ReportRequestStatus {
  QUEUED = 'queued',
  GENERATING = 'generating',
  READY = 'ready',
  FAILED = 'failed',
}

/** Terminal statuses — the FE stops polling once every request is here. */
export const TERMINAL_REPORT_STATUSES: readonly ReportRequestStatus[] = [
  ReportRequestStatus.READY,
  ReportRequestStatus.FAILED,
];
