export enum JobListScope {
  TODAY = 'today',
  UPCOMING = 'upcoming',
  OVERDUE = 'overdue',
  HISTORY = 'history',
  /** Every status, no day window — the employee Jobs tab's "All" chip
   *  (Epic 22): a pending job lives on no other scope for its creator. */
  ALL = 'all',
}
