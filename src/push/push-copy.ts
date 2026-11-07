import { ATTENDANCE_NOTIFICATION_EVENT } from '../attendance/notification-events';
import { JOB_ASSIGNED_EVENT } from '../jobs/job-notifications';
import {
  REPORT_FAILED_EVENT,
  REPORT_READY_EVENT,
} from '../reports/engine/report-notifications';

/**
 * Push copy (CAP-2): the OS notification's title/body for one notification
 * row, composed from the row's event_type + self-sufficient payload — the
 * same inputs the app's inbox cards render from, so a push says what the
 * bell would have said. Wordings MIRROR the app's cards (the job card
 * title line, the report card's copy, the attendance/leave composed copy);
 * anything unknown or drifted degrades to the humanized event type (the
 * AD-19 fallback), never to a crash or a broken string.
 *
 * EVERY user-facing string lives in the PUSH_COPY table below — the UX
 * pass revises wording there and ONLY there (orchestrator note,
 * 2026-11-07: do not polish or reword outside it). Channel, lock-screen
 * visibility and the truncation caps follow the final UX spec
 * (artifacts/planning-artifacts/ux-designs/ux-fenzit-2026-11-07-push-notifications/EXPERIENCE.md).
 * The functions under "extractors" assemble payload data into strings but
 * carry no wording of their own beyond the shared fixed words they read
 * from the table.
 *
 * Pure module: no I/O, no Nest — trivially unit-testable when the test
 * window opens (plan §Implementation Notes).
 */

/**
 * Lock-screen privacy (EXPERIENCE.md): PUBLIC = full content on any lock
 * screen; PRIVATE = Android redacts when the user chose "hide sensitive
 * content". SECRET never. Lowercased at the FCM boundary (the SDK's
 * AndroidNotification.visibility takes the lowercase spellings).
 */
export type PushVisibility = 'PUBLIC' | 'PRIVATE';

export interface PushCopy {
  /** OS notification title — always non-empty. */
  title: string;
  /** OS notification body; empty means "title only" (FCM rejects ""). */
  body: string;
  /**
   * Android channel id (EXPERIENCE.md's four-channel table): jobs /
   * attendance / reports for known events; omitted for unknown types so
   * the device default `fenzit_default` applies.
   */
  channel?: string;
  /** Lock-screen visibility; omitted for events not in the UX table. */
  visibility?: PushVisibility;
}

/**
 * Android channels (EXPERIENCE.md) — created natively in the app at
 * MainApplication.onCreate; the sweep only names one per message.
 */
export const PUSH_CHANNEL = {
  jobs: 'fenzit_jobs',
  attendance: 'fenzit_attendance',
  reports: 'fenzit_reports',
} as const;

/**
 * Truncation caps (EXPERIENCE.md): names 24 chars in titles / 30 in
 * bodies; reasons 40; customer/office/holiday/report labels 30; "…"
 * marks the cut. Load-bearing facts (dates, job numbers, decisions)
 * always lead the body and are never truncated.
 */
const TITLE_NAME_CAP = 24;
const BODY_NAME_CAP = 30;
const REPORT_LABEL_CAP = 30;
const REASON_CAP = 40;

const truncate = (value: string, cap: number): string =>
  value.length > cap ? `${value.slice(0, cap)}…` : value;

/* ------------------------------------------------------------------ *
 * Extractors — payload shape guards and formatters, wording-free
 * (their fixed words come from the table's `words`).
 * ------------------------------------------------------------------ */

const isText = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;

const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0;

const isIsoDate = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Humanize an unknown event type: `leave_applied` → "Leave applied". */
function humanizeEventType(eventType: string): string {
  const text = eventType.replace(/[._]/g, ' ').trim();
  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The product's canonical zone — jobs live on IST (the BE day windows). */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** "30 Sep 2026" — the leave card's date label. */
function formatLeaveDate(yyyyMmDd: string): string {
  if (!isIsoDate(yyyyMmDd)) return yyyyMmDd;
  const [y, m, d] = yyyyMmDd.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Single-day spans collapse; same-month spans compress ("14–18 Sep 2026"). */
function formatLeaveRange(start: string, end: string): string {
  const [sy, sm, sd] = start.split('-');
  const [ey, em, ed] = end.split('-');
  if (sy === ey && sm === em) {
    return `${Number(sd)}–${Number(ed)} ${MONTHS[Number(sm) - 1]} ${sy}`;
  }
  return `${formatLeaveDate(start)} – ${formatLeaveDate(end)}`;
}

/** "Wed, 30 Sep, 2026" — the holiday card's long label (en-IN shape). */
function formatHolidayDate(yyyyMmDd: string): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday}, ${d} ${MONTHS[m - 1]}, ${y}`;
}

/** "12 Nov, 10:30 AM" — the scheduled slot in IST, no ICU dependence. */
function formatScheduledTime(iso: unknown): string | null {
  if (typeof iso !== 'string') return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const shifted = new Date(at + IST_OFFSET_MS);
  const day = shifted.getUTCDate();
  const month = MONTHS[shifted.getUTCMonth()];
  const hours24 = shifted.getUTCHours();
  const minutes = String(shifted.getUTCMinutes()).padStart(2, '0');
  const meridiem = hours24 < 12 ? 'AM' : 'PM';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${day} ${month}, ${hours12}:${minutes} ${meridiem}`;
}

function datesOf(payload: Record<string, unknown>): string | null {
  const start = payload['startDate'];
  const end = payload['endDate'];
  if (!isIsoDate(start)) return null;
  if (!isIsoDate(end) || end === start) return formatLeaveDate(start);
  return formatLeaveRange(start, end);
}

function listDatesOf(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const list = payload[key];
  if (!Array.isArray(list)) return null;
  const dates = list.filter(isIsoDate).map(formatLeaveDate);
  return dates.length > 0 ? dates.join(', ') : null;
}

const reasonOf = (payload: Record<string, unknown>): string | null =>
  isText(payload['reason']) ? payload['reason'] : null;

const whoOf = (payload: Record<string, unknown>): string | null =>
  isText(payload['employeeName']) ? payload['employeeName'] : null;

/* ------------------------------------------------------------------ *
 * THE wording table — the single surface the UX pass revises.
 * ------------------------------------------------------------------ */

interface CopyEntry {
  /** A literal, or a composed title when drift picks the fallback. */
  title: string | ((payload: Record<string, unknown>) => string);
  body: (payload: Record<string, unknown>) => string;
  /** Android channel (EXPERIENCE.md — required on every known event). */
  channel: string;
  /** Lock-screen visibility (EXPERIENCE.md — required on known events). */
  visibility: PushVisibility;
}

/**
 * Explicit annotation, not inference: the bodies reference PUSH_COPY
 * itself (the shared `words`/`fallback`), which would otherwise make the
 * whole const self-referential and collapse to `any`.
 */
const PUSH_COPY: {
  words: Record<string, string>;
  fallback: Record<string, string>;
  events: Record<string, CopyEntry>;
} = {
  /** Fixed words shared by several bodies (assembled by the extractors). */
  words: {
    workingDaysOne: '1 working day',
    workingDaysMany: 'working days',
    partsSeparator: ' · ',
    emDashSeparator: ' — ',
    revokedSingularVerb: 'counts',
    revokedPluralVerb: 'count',
    noLongerLeave: 'no longer',
    requestOne: 'leave request',
    requestMany: 'leave requests',
    waitingForApproval: 'waiting for approval.',
    hasnCheckedInOne: "1 hasn't",
    hasntCheckedInMany: "haven't",
    checkedInAtSuffix: 'checked in at',
    attemptThisMonth: 'attempt',
    attemptThisMonthSuffix: 'this month',
    anEmployee: 'An employee',
  },

  /** Fallback surfaces — drifted rows and unknown types (user-facing too). */
  fallback: {
    leaveDriftedTitle: 'Leave updated',
    jobCardTitle: 'Job status updated',
    unknownTitle: 'Notification',
  },

  /** Per-event copy, keyed by the exact notifications.event_type. */
  events: {
    // Reports (the engine's terminal events; payload {reportLabel, errorCode}).
    // PRIVATE: report labels are the recipient's own requests — shade-hidden
    // behind "hide sensitive content" (EXPERIENCE.md lock-screen table).
    [REPORT_READY_EVENT]: {
      title: 'Report ready',
      channel: PUSH_CHANNEL.reports,
      visibility: 'PRIVATE',
      body: (p) => {
        // The definition label already carries "Report" ("Technician Job Report").
        const label = isText(p['reportLabel']) ? p['reportLabel'] : null;
        return label
          ? `${truncate(label, REPORT_LABEL_CAP)} is ready to view.`
          : 'Your report is ready to view.';
      },
    },
    [REPORT_FAILED_EVENT]: {
      title: 'Report failed',
      channel: PUSH_CHANNEL.reports,
      visibility: 'PRIVATE',
      body: (p) => {
        // The report card's failure copy table (reportModel.failedReportCopy).
        const errorCode = p['errorCode'];
        if (errorCode === 'REPORT_GENERATION_FAILED') {
          return 'Report generation failed. Try again.';
        }
        if (errorCode === 'REPORT_TOO_LARGE') {
          return 'Too many jobs in range. Narrow the date range.';
        }
        return isText(errorCode)
          ? `Error (code: ${errorCode})`
          : 'This report failed. Try again.';
      },
    },

    // Attendance (payload fields per the AD-13 registry). Holidays and the
    // three reminders are PUBLIC (facts to act on); the fake-location
    // accusation is PRIVATE (EXPERIENCE.md lock-screen table).
    [ATTENDANCE_NOTIFICATION_EVENT.HOLIDAY_ADDED]: {
      title: 'Holiday added',
      channel: PUSH_CHANNEL.attendance,
      visibility: 'PUBLIC',
      body: (p) =>
        joinEmDash(
          isText(p['holidayName'])
            ? truncate(p['holidayName'], BODY_NAME_CAP)
            : null,
          isIsoDate(p['holidayDate'])
            ? formatHolidayDate(p['holidayDate'].slice(0, 10))
            : null,
        ),
    },
    [ATTENDANCE_NOTIFICATION_EVENT.HOLIDAY_REMOVED]: {
      title: 'Holiday removed',
      channel: PUSH_CHANNEL.attendance,
      visibility: 'PUBLIC',
      body: (p) =>
        joinEmDash(
          isText(p['holidayName'])
            ? truncate(p['holidayName'], BODY_NAME_CAP)
            : null,
          isIsoDate(p['holidayDate'])
            ? formatHolidayDate(p['holidayDate'].slice(0, 10))
            : null,
        ),
    },
    [ATTENDANCE_NOTIFICATION_EVENT.FAKE_LOCATION]: {
      title: 'Fake location alert',
      channel: PUSH_CHANNEL.attendance,
      visibility: 'PRIVATE',
      body: (p) => {
        const w = PUSH_COPY.words;
        // The owner's inbox renders this one generic today; the push still
        // deserves real words (the registry's payloadFields are the contract).
        const who = whoOf(p);
        return joinEmDash(
          who !== null ? truncate(who, BODY_NAME_CAP) : w.anEmployee,
          isCount(p['attemptCount'])
            ? `${w.attemptThisMonth} ${p['attemptCount']} ${w.attemptThisMonthSuffix}`
            : null,
        );
      },
    },
    [ATTENDANCE_NOTIFICATION_EVENT.REMINDER_CHECKIN]: {
      title: 'Check-in reminder',
      channel: PUSH_CHANNEL.attendance,
      visibility: 'PUBLIC',
      body: () => "You haven't checked in yet today.",
    },
    [ATTENDANCE_NOTIFICATION_EVENT.REMINDER_CHECKOUT]: {
      title: 'Check-out reminder',
      channel: PUSH_CHANNEL.attendance,
      visibility: 'PUBLIC',
      body: () => "You haven't checked out yet today.",
    },
    [ATTENDANCE_NOTIFICATION_EVENT.REMINDER_NOT_CHECKED_IN]: {
      title: 'Not checked in',
      channel: PUSH_CHANNEL.attendance,
      visibility: 'PUBLIC',
      body: (p) => {
        const w = PUSH_COPY.words;
        const office = isText(p['officeName'])
          ? truncate(p['officeName'], BODY_NAME_CAP)
          : null;
        // The FE card rule: a count of 0 (or a drifted payload) is nonsense
        // copy — degrade to the honest title-only notification.
        if (
          !isCount(p['notCheckedInCount']) ||
          p['notCheckedInCount'] < 1 ||
          office === null
        ) {
          return '';
        }
        const who =
          p['notCheckedInCount'] === 1
            ? w.hasnCheckedInOne
            : `${p['notCheckedInCount']} ${w.hasntCheckedInMany}`;
        return `${who} ${w.checkedInAtSuffix} ${office}.`;
      },
    },

    // Leave (the D5 copy table mirrored from leaveNotificationModel). A
    // drifted payload degrades to the fallback title with an EMPTY body
    // (the FE's minimal honest card), never to a half-composed sentence.
    // PRIVATE: personal dates and reasons stay off the unlocked shade —
    // the one PUBLIC leave event is the count-only pending reminder.
    ['leave.applied']: {
      title: (p) => appliedTitle(p),
      body: (p) => (whoOf(p) === null ? '' : spanOrEmpty(p)),
      channel: PUSH_CHANNEL.attendance,
      visibility: 'PRIVATE',
    },
    ['leave.employee_cancelled']: {
      title: (p) => {
        const who = whoOf(p);
        return who === null
          ? PUSH_COPY.fallback.leaveDriftedTitle
          : `${truncate(who, TITLE_NAME_CAP)} cancelled leave`;
      },
      body: (p) =>
        whoOf(p) === null
          ? ''
          : (listDatesOf(p, 'cancelledDates') ?? datesOf(p) ?? ''),
      channel: PUSH_CHANNEL.attendance,
      visibility: 'PRIVATE',
    },
    ['leave.checkin_auto_cancel']: {
      title: (p) => {
        const who = whoOf(p);
        return who === null || !isIsoDate(p['leaveDate'])
          ? PUSH_COPY.fallback.leaveDriftedTitle
          : `${truncate(who, TITLE_NAME_CAP)} checked in on leave`;
      },
      body: (p) =>
        whoOf(p) === null || !isIsoDate(p['leaveDate'])
          ? ''
          : `Their leave on ${formatLeaveDate(p['leaveDate'])} was cancelled.`,
      channel: PUSH_CHANNEL.attendance,
      visibility: 'PRIVATE',
    },
    ['leave.applied_on_behalf']: {
      title: 'Leave applied for you',
      body: (p) => spanOrEmpty(p),
      channel: PUSH_CHANNEL.attendance,
      visibility: 'PRIVATE',
    },
    ['leave.approved']: {
      title: 'Leave approved',
      body: (p) => spanOrEmpty(p),
      channel: PUSH_CHANNEL.attendance,
      visibility: 'PRIVATE',
    },
    ['leave.rejected']: {
      title: (p) =>
        datesOf(p) === null
          ? PUSH_COPY.fallback.leaveDriftedTitle
          : 'Leave rejected',
      body: (p) => {
        const dates = datesOf(p);
        if (dates === null) return '';
        const reason = reasonOf(p);
        return reason !== null
          ? `${dates} — "${truncate(reason, REASON_CAP)}"`
          : dates;
      },
      channel: PUSH_CHANNEL.attendance,
      visibility: 'PRIVATE',
    },
    ['leave.owner_revoked']: {
      title: (p) =>
        listDatesOf(p, 'revokedDates') === null
          ? PUSH_COPY.fallback.leaveDriftedTitle
          : 'Leave revoked',
      body: (p) => {
        const w = PUSH_COPY.words;
        const revoked = listDatesOf(p, 'revokedDates');
        if (revoked === null) return '';
        const reason = reasonOf(p);
        const count = Array.isArray(p['revokedDates'])
          ? (p['revokedDates'] as unknown[]).filter(isIsoDate).length
          : 0;
        const verb = count === 1 ? w.revokedSingularVerb : w.revokedPluralVerb;
        return reason !== null
          ? `${revoked} ${w.noLongerLeave} ${verb} as leave — ${truncate(reason, REASON_CAP)}`
          : `${revoked} ${w.noLongerLeave} ${verb} as leave`;
      },
      channel: PUSH_CHANNEL.attendance,
      visibility: 'PRIVATE',
    },
    ['leave.cancelled_by_disable']: {
      title: 'Leave cancelled',
      body: (p) => listDatesOf(p, 'cancelledDates') ?? datesOf(p) ?? '',
      channel: PUSH_CHANNEL.attendance,
      visibility: 'PRIVATE',
    },
    ['leave.pending_reminder']: {
      title: (p) =>
        isCount(p['pendingCount'])
          ? 'Pending leave'
          : PUSH_COPY.fallback.leaveDriftedTitle,
      body: (p) => {
        const w = PUSH_COPY.words;
        const count = p['pendingCount'];
        if (!isCount(count)) return '';
        const noun = count === 1 ? w.requestOne : w.requestMany;
        return `${count} ${noun} ${w.waitingForApproval}`;
      },
      channel: PUSH_CHANNEL.attendance,
      visibility: 'PUBLIC',
    },

    // Job assignment (user decision 2026-11-07): "New job assigned" over
    // "job number · customer · time", each part dropped when the payload
    // lacks it — the title fires on the EVENT TYPE alone (EXPERIENCE.md:
    // a drifted payload must not rename the event), the body degrades
    // per field. PUBLIC: customer names surface only on the technician's
    // own lock screen.
    [JOB_ASSIGNED_EVENT]: {
      title: 'New job assigned',
      body: (p) =>
        joinMiddleDot(
          isText(p['job_number']) ? p['job_number'] : null,
          isText(p['customer_name'])
            ? truncate(p['customer_name'], BODY_NAME_CAP)
            : null,
          formatScheduledTime(p['scheduled_start']),
        ),
      channel: PUSH_CHANNEL.jobs,
      visibility: 'PUBLIC',
    },
  },
};

/* ------------------------- table-local helpers --------------------- */

/** "{dates} · {n} working days" — either half alone when the other drifts. */
function spanOrEmpty(payload: Record<string, unknown>): string {
  const parts = [
    datesOf(payload),
    isCount(payload['workingDays'])
      ? payload['workingDays'] === 1
        ? PUSH_COPY.words.workingDaysOne
        : `${payload['workingDays']} ${PUSH_COPY.words.workingDaysMany}`
      : null,
  ].filter((v): v is string => v !== null);
  return parts.join(PUSH_COPY.words.partsSeparator);
}

function appliedTitle(payload: Record<string, unknown>): string {
  const who = whoOf(payload);
  return who === null
    ? PUSH_COPY.fallback.leaveDriftedTitle
    : `${truncate(who, TITLE_NAME_CAP)} applied for leave`;
}

function joinEmDash(...parts: (string | null)[]): string {
  return parts
    .filter((v): v is string => v !== null)
    .join(PUSH_COPY.words.emDashSeparator);
}

function joinMiddleDot(...parts: (string | null)[]): string {
  return parts
    .filter((v): v is string => v !== null)
    .join(PUSH_COPY.words.partsSeparator);
}

/* ------------------------------ public ----------------------------- */

/**
 * The push title/body (plus channel + lock-screen visibility) for one
 * notification row. Table first; families without a table entry degrade
 * per the app's classifier order — channel per the UX channel table,
 * visibility only where the lock-screen table names it.
 */
export function pushCopyForEvent(
  eventType: string,
  payload: Record<string, unknown>,
): PushCopy {
  const entry = Object.hasOwn(PUSH_COPY.events, eventType)
    ? PUSH_COPY.events[eventType]
    : undefined;
  if (entry) {
    const title =
      typeof entry.title === 'function' ? entry.title(payload) : entry.title;
    return {
      title,
      body: entry.body(payload),
      channel: entry.channel,
      visibility: entry.visibility,
    };
  }
  // Attendance subtypes not in the table keep the composed-card posture:
  // the humanized type, title-only (never payload.title/message prose).
  // They ride the attendance channel; the lock-screen table names no
  // visibility for an unknown subtype, so the device default applies.
  if (eventType.startsWith('attendance.')) {
    return {
      title: humanizeOrFallback(eventType),
      body: '',
      channel: PUSH_CHANNEL.attendance,
    };
  }
  // Job events not in the table: event_type is the workflow step key,
  // payload carries {job_number, step, technician_name}; the card title
  // line is "{technician} · {job_number}" (fallback in the table).
  // Workflow steps are Jobs channel, PUBLIC.
  if (isText(payload['job_number'])) {
    const technician = isText(payload['technician_name'])
      ? truncate(payload['technician_name'], TITLE_NAME_CAP)
      : null;
    const title =
      technician !== null
        ? `${technician} · ${payload['job_number']}`
        : PUSH_COPY.fallback.jobCardTitle;
    const step = isText(payload['step']) ? payload['step'] : eventType;
    return {
      title,
      body: humanizeOrFallback(step, step),
      channel: PUSH_CHANNEL.jobs,
      visibility: 'PUBLIC',
    };
  }
  // Leave drift: the FE's minimal honest card, title-only (attendance
  // channel per "all leave.*"; visibility unspecified → device default).
  if (eventType.startsWith('leave.')) {
    return {
      title: PUSH_COPY.fallback.leaveDriftedTitle,
      body: '',
      channel: PUSH_CHANNEL.attendance,
    };
  }
  // Unknown types: the humanized event type (or payload self-description),
  // title-only unless the payload carries a message. No channel, no
  // visibility — the device default `fenzit_default` applies (EXPERIENCE.md).
  return {
    title: isText(payload['title'])
      ? payload['title']
      : humanizeOrFallback(eventType),
    body: isText(payload['message']) ? payload['message'] : '',
  };
}

/** Humanized event type; the empty guard ends at the table's fallback. */
function humanizeOrFallback(eventType: string, raw?: string): string {
  const humanized = humanizeEventType(eventType);
  return humanized.length > 0
    ? humanized
    : (raw ?? PUSH_COPY.fallback.unknownTitle);
}
