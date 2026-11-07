import type { ImportRowReason } from './import-rows.types';

/** Scope bound to the replay record, same as the idempotency interceptor. */
export const IMPORT_COMMIT_SCOPE = 'POST:/customers/import/commit';

/** Used when the request does not name the file. */
export const DEFAULT_IMPORT_FILE_NAME = 'import.csv';

export type CommitRowStatus = 'created' | 'updated' | 'failed';

export interface CommitRowResult {
  rowIndex: number;
  status: CommitRowStatus;
  customerId: string | null;
  reasons: ImportRowReason[];
}

export interface CommitSummary {
  total: number;
  created: number;
  updated: number;
  failed: number;
}

export interface ImportCommitResponse {
  batchId: string;
  rows: CommitRowResult[];
  summary: CommitSummary;
}
