/** One IST day of the exec-dashboard attendance trend (2026-11-27). The six
 *  numbers are the SAME buckets the today-pulse tiles show — the partition
 *  rule lives in dashboard.ts and is consumed, never re-implemented. */
export interface AttendanceTrendDay {
  /** YYYY-MM-DD (IST). */
  date: string;
  tracked: number;
  checkedIn: number;
  notCheckedIn: number;
  shortDay: number;
  /** Late is a qualifier of checked-in, exactly as the pulse tile counts it. */
  late: number;
  onLeave: number;
}

export interface AttendanceTrendResponse {
  range: { from: string; to: string };
  /** Every day of `[from, to]` inclusive, oldest first; a day nobody was
   *  tracked on carries honest zeros. */
  days: AttendanceTrendDay[];
}
