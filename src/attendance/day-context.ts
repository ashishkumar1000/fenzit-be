import {
  OfficeRuleRow,
  WeeklyOffRow,
  pickRuleForDate,
  pickWeeklyOffDays,
} from './me-summary.model';

/**
 * The AD-22 day context (16-1) — THE single place the per-employee-date
 * facts are computed; check-in/out, and every later attendance epic, read
 * these facts only from here.
 *
 * Shape note (spec-16-1 D1): the spine sketched this as a SQL function,
 * but AD-3's amendment (2026-09-27) makes Epic 16+ NestJS-first and this
 * is a read-path helper — the facts live in TypeScript, and the pure
 * pickers are IMPORTED from me-summary.model.ts so the FR-4 summary and
 * this context can never disagree about which rule or weekly-off set
 * applies (the 15-9 drift-defect class, closed at the type level).
 *
 * Wall-clock math uses Intl with the tenant timezone (AD-7: never a
 * timezone library, never getIstDayRange). The SQL reads live in
 * day-context.read.ts.
 */

export interface DayContext {
  tenantId: string;
  employeeId: string;
  workDate: string;
  timezone: string;
  /** Enrolment covers the date AND setup completed AND module enabled. */
  trackedBase: boolean;
  /** trackedBase minus the FR-2 enable-day grace (see `hasCheckInForGrace`). */
  tracked: boolean;
  /** Diagnostic: the grace is what makes this date untracked. */
  enableDayGraceBlocks: boolean;
  officeId: string | null;
  officeName: string | null;
  officeLat: number | null;
  officeLng: number | null;
  radiusM: number | null;
  /** Null when no rule covers the date (D7) — late/early then stay null. */
  officeRulesId: string | null;
  /** Minutes of the tenant-local day; null when no rule covers. */
  startMinute: number | null;
  endMinute: number | null;
  midpointMinute: number | null;
  lateCutoffMinutes: number | null;
  isWeeklyOff: boolean;
  holidayId: string | null;
  holidayName: string | null;
  isWorkingDay: boolean;
  /**
   * The AD-22 leave seam, live since Epic 17 (spec-17 D3): today's active
   * leave day — pending or approved; null when the date has none.
   */
  leaveState: 'pending' | 'approved' | null;
  /** The leave request's part when leaveState is set; null otherwise. */
  leavePart: 'full_day' | 'first_half' | 'second_half' | null;
}

/** Input rows for the pure computations below. */
export interface DayFacts {
  enrolmentCovers: boolean;
  setupCompleted: boolean;
  enabled: boolean;
  enabledAt: Date | null;
  enrolmentStart: string | null;
  rule: OfficeRuleRow | null;
  weeklyOffDays: number[];
  holidayId: string | null;
  holidayName: string | null;
}

export interface OfficeJoinRow {
  office_id: string;
  office_name: string;
  office_lat: number;
  office_lng: number;
  radius_m: number;
}

/**
 * Minutes of the tenant-local day for an instant ("10:22" → 622). Intl is
 * the platform's tz engine — a timezone LIBRARY is banned by AD-7, Intl is
 * not a library.
 */
export function minuteOfDayInTz(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    throw new Error(`Unparseable local time for ${timezone}`);
  }
  return hour * 60 + minute;
}

/** The tenant-local calendar date of an instant, `YYYY-MM-DD`. */
export function dateInTz(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** `YYYY-MM-DD` → ISO weekday number 1=Mon .. 7=Sun (UTC space — no DST). */
export function isoWeekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

/** pg `time` ("10:00:00" or "10:00") → minutes of day. */
export function timeStringToMinutes(value: string): number {
  const [h, m] = value.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) {
    throw new Error(`Unparseable time value: ${value}`);
  }
  return h * 60 + m;
}

/** Midpoint = start + (end − start)/2, truncated to the minute (AD-22). */
export function computeMidpointMinute(
  startMinute: number,
  endMinute: number,
): number {
  return startMinute + Math.trunc((endMinute - startMinute) / 2);
}

/**
 * Late minutes (D12): late strictly after Start + late cut-off; 0 within
 * the grace; null when no rule covers the date (D7).
 */
export function computeLateMinutes(
  checkinMinute: number,
  startMinute: number,
  lateCutoffMinutes: number,
): number {
  return Math.max(0, checkinMinute - (startMinute + lateCutoffMinutes));
}

/** Early-checkout minutes before Expected end; null when not early. */
export function computeEarlyCheckoutMinutes(
  checkoutMinute: number,
  endMinute: number,
): number | null {
  return checkoutMinute < endMinute ? endMinute - checkoutMinute : null;
}

/**
 * FR-7's half-day expectation (AD-22's expected_start, live since Epic 17
 * — spec-17 D3): on a FIRST-half leave day the working half is the
 * afternoon, so Expected start is the Midpoint; otherwise the rule start.
 */
export function expectedStartMinute(ctx: {
  leavePart: 'full_day' | 'first_half' | 'second_half' | null;
  startMinute: number | null;
  midpointMinute: number | null;
}): number | null {
  if (ctx.leavePart === 'first_half') return ctx.midpointMinute;
  return ctx.startMinute;
}

/**
 * FR-7's symmetric expectation: on a SECOND-half leave day the working
 * half is the morning, so Expected end is the Midpoint; otherwise the
 * rule end.
 */
export function expectedEndMinute(ctx: {
  leavePart: 'full_day' | 'first_half' | 'second_half' | null;
  endMinute: number | null;
  midpointMinute: number | null;
}): number | null {
  if (ctx.leavePart === 'second_half') return ctx.midpointMinute;
  return ctx.endMinute;
}

/**
 * AD-22's leave cutoff (D8): today's leave counts as started once the
 * Office Start has passed. When no rule covers the date there is no
 * office start to miss — the cutoff counts as NOT passed (the permissive
 * reading, spec-17 D8). `nowMinute` comes from the DB clock.
 */
/** The shared core: has this day's Office Start passed? No rule → NOT
 * passed (the permissive reading, spec-17 D8). */
export function isPastOfficeStart(
  startMinute: number | null,
  nowMinute: number,
): boolean {
  return startMinute !== null && nowMinute >= startMinute;
}

export function leaveCutoffPassed(
  ctx: {
    leaveState: 'pending' | 'approved' | null;
    startMinute: number | null;
  },
  nowMinute: number,
): boolean {
  if (ctx.leaveState === null) return false;
  return isPastOfficeStart(ctx.startMinute, nowMinute);
}

export function isWeeklyOffDay(days: number[], workDate: string): boolean {
  return days.includes(isoWeekdayOf(workDate));
}

/**
 * The FR-2 enable-day grace: on the day tracking began, an employee whose
 * `enabled_at` falls after that day's Start is NOT tracked — unless there
 * is a check-in (D10: the check-in path passes `hasCheckIn: true`, because
 * the call being processed IS the check-in FR-2 carves out).
 */
export function applyEnableDayGrace(
  facts: Pick<
    DayFacts,
    'enrolmentCovers' | 'setupCompleted' | 'enabled' | 'enabledAt'
  >,
  rule: OfficeRuleRow | null,
  workDate: string,
  timezone: string,
  hasCheckIn: boolean,
): { tracked: boolean; graceBlocks: boolean } {
  const base = facts.enrolmentCovers && facts.setupCompleted && facts.enabled;
  if (!base || hasCheckIn || !rule || !facts.enabledAt) {
    return { tracked: base, graceBlocks: false };
  }
  const enabledDay = dateInTz(facts.enabledAt, timezone);
  const enabledMinute = minuteOfDayInTz(facts.enabledAt, timezone);
  const startMinute = timeStringToMinutes(rule.start_time);
  const graceBlocks = enabledDay === workDate && enabledMinute > startMinute;
  return { tracked: base && !graceBlocks, graceBlocks };
}

/** Pure assembly of the context from already-read rows. */
export function assembleDayContext(
  tenantId: string,
  employeeId: string,
  workDate: string,
  timezone: string,
  facts: DayFacts,
  office: OfficeJoinRow | null,
  hasCheckIn: boolean,
  leave: {
    state: 'pending' | 'approved';
    part: 'full_day' | 'first_half' | 'second_half';
  } | null = null,
): DayContext {
  const rule = facts.rule;
  const startMinute = rule ? timeStringToMinutes(rule.start_time) : null;
  const endMinute = rule ? timeStringToMinutes(rule.end_time) : null;
  const isWeeklyOff = isWeeklyOffDay(facts.weeklyOffDays, workDate);
  const isHoliday = facts.holidayId !== null;
  const { tracked, graceBlocks } = applyEnableDayGrace(
    facts,
    rule,
    workDate,
    timezone,
    hasCheckIn,
  );
  return {
    tenantId,
    employeeId,
    workDate,
    timezone,
    trackedBase: facts.enrolmentCovers && facts.setupCompleted && facts.enabled,
    tracked,
    enableDayGraceBlocks: graceBlocks,
    officeId: office?.office_id ?? null,
    officeName: office?.office_name ?? null,
    officeLat: office?.office_lat ?? null,
    officeLng: office?.office_lng ?? null,
    radiusM: office?.radius_m ?? null,
    officeRulesId: rule?.id ?? null,
    startMinute,
    endMinute,
    midpointMinute:
      startMinute !== null && endMinute !== null
        ? computeMidpointMinute(startMinute, endMinute)
        : null,
    lateCutoffMinutes: rule ? rule.late_cutoff_minutes : null,
    isWeeklyOff,
    holidayId: facts.holidayId,
    holidayName: facts.holidayName,
    isWorkingDay: !isWeeklyOff && !isHoliday,
    leaveState: leave?.state ?? null,
    leavePart: leave?.part ?? null,
  };
}

interface EnrolmentRow {
  valid: string;
  enabled_at: Date | string;
}
