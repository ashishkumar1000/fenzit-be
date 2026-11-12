export enum JobStatus {
  SCHEDULED = 'scheduled',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  /** Employee-created job waiting for owner approval. Not assigned work (CAP-4). */
  PENDING_APPROVAL = 'pending_approval',
  /** The owner rejected a pending job. Kept in the creator's history (CAP-7). */
  REJECTED = 'rejected',
}
