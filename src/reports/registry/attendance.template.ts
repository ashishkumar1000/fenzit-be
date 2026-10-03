import type { Content } from 'pdfmake/interfaces';
import {
  brand,
  FONT_FAMILY,
  PAGE_MARGINS,
} from '../templates/brand-kit/brand-theme';
import {
  pageHeader,
  summaryCardRow,
  dataTable,
  pageFooter,
  sectionTitle,
  emptyStateRow,
  emptyStateBlock,
  flagList,
  type DataTableCell,
} from '../templates/brand-kit/page-chrome';
import type { BrandIcon } from '../templates/brand-kit/brand-icons';
import type { ReportDocument } from './report-definition';
import type { AttendanceReportData } from './attendance.data';
import type { AttendanceException, AttendanceSummary } from './attendance.metrics';

/**
 * Attendance Report template (21-3). Composes ONLY structure from the
 * brand-kit helpers — every colour, font and asset flows from the kit.
 * Section order is normative per spec report-content.md: header → overall
 * cards → offices → employee summary (attendance + discipline/hours) →
 * needs attention → weekly trend → day register (≤ 31-day ranges) → leave
 * summary → rejected punches. The data arrives pre-aggregated from
 * attendance.data/attendance.metrics — this file does zero attendance
 * math (12-5 rule).
 */

const MUTED = brand.textMuted;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "20 Sep" from YYYY-MM-DD (the header + register labels). */
function shortDate(isoDate: string): string {
  return `${Number(isoDate.slice(8, 10))} ${MONTHS[Number(isoDate.slice(5, 7)) - 1]}`;
}
const AMBER = brand.scheduled;
const RED = brand.cancelled;
const GREEN = brand.done;

const EXCEPTION_PRESENTATION: Record<
  AttendanceException['kind'],
  { icon: BrandIcon; color: string }
> = {
  fake_location: { icon: 'triangle-alert', color: RED },
  missing_checkout: { icon: 'clock', color: AMBER },
  absent_streak: { icon: 'circle-x', color: RED },
  repeat_late: { icon: 'timer', color: AMBER },
  corrected: { icon: 'clipboard-list', color: MUTED },
};

function hours(minutesTotal: number): string {
  const h = Math.round(minutesTotal / 6) / 10;
  return `${h.toFixed(1)} h`;
}

function rate(summary: AttendanceSummary): DataTableCell {
  return summary.attendanceRate === null
    ? { text: '—', color: MUTED }
    : `${summary.attendanceRate}%`;
}

function fmtHours(summary: AttendanceSummary): string {
  return hours(summary.workedMinutesTotal);
}

/** The Overall section: three rows of four cards, plain-English labels.
 *  Captions carry real derived info only (12-5 rule). */
function metricCardRows(data: AttendanceReportData): Content[] {
  const o = data.overall;
  const mockedAttempts = data.rejections.reduce((n, r) => n + r.mocked, 0);
  const avgHours =
    o.avgHoursPerDay === null ? undefined : `${o.avgHoursPerDay} h/day avg`;
  return [
    summaryCardRow([
      {
        label: 'Employees in scope',
        value: String(data.scope.employeesInScope),
        icon: 'users',
        iconColor: brand.primary,
        tint: brand.primaryTint,
      },
      {
        label: 'Expected working days',
        value: String(o.expectedDays),
        icon: 'clipboard-list',
      },
      {
        label: 'Attendance rate',
        value: o.attendanceRate === null ? '—' : `${o.attendanceRate}%`,
        accent: o.attendanceRate !== null && o.attendanceRate >= 90 ? GREEN : undefined,
        icon: 'circle-check',
        caption: 'Worked days ÷ expected days',
      },
      {
        label: 'Total worked hours',
        value: fmtHours(o),
        icon: 'timer',
        caption: avgHours,
      },
    ]),
    summaryCardRow([
      {
        label: 'Late arrivals',
        value: String(o.lateCount),
        accent: o.lateCount > 0 ? AMBER : undefined,
        icon: 'timer',
        caption: o.lateMinutes > 0 ? `${o.lateMinutes} min late in total` : undefined,
      },
      {
        label: 'Absent days',
        value: String(o.absent),
        accent: o.absent > 0 ? RED : undefined,
        icon: 'circle-x',
      },
      {
        label: 'Leave days',
        value: String(o.leave),
        icon: 'clipboard-list',
      },
      {
        label: 'Missed check-outs',
        value: String(o.checkoutMissing),
        accent: o.checkoutMissing > 0 ? AMBER : undefined,
        icon: 'clock',
        caption: o.checkoutMissing > 0 ? 'Hours under-counted on these days' : undefined,
      },
    ]),
    summaryCardRow([
      { label: 'Half days', value: String(o.halfDays), icon: 'clock' },
      {
        label: 'Extra days worked',
        value: String(o.workedOnHoliday),
        accent: o.workedOnHoliday > 0 ? GREEN : undefined,
        icon: 'zap',
        caption: 'On weekly offs / holidays',
      },
      {
        label: 'Corrections applied',
        value: String(o.corrections),
        icon: 'clipboard-list',
      },
      {
        label: 'Fake-location attempts',
        value: String(mockedAttempts),
        accent: mockedAttempts > 0 ? RED : undefined,
        icon: 'camera-off',
        caption:
          o.fakeLocationDays > 0
            ? `${o.fakeLocationDays} unacknowledged day flag${o.fakeLocationDays === 1 ? '' : 's'}`
            : undefined,
      },
    ]),
  ];
}

/** Employee summary, split into two readable tables (spec report-content.md). */
function employeeTables(data: AttendanceReportData): Content[] {
  const attendanceRows: DataTableCell[][] = data.employees.map((e) => [
    { text: e.name, bold: true },
    e.offices,
    e.enrolledFrom
      ? { text: `from ${shortDate(e.enrolledFrom)}`, color: MUTED }
      : '',
    String(e.summary.daysWorked),
    String(e.summary.fullDays),
    String(e.summary.halfDays),
    String(e.summary.absent),
    String(e.summary.leave),
    String(e.summary.weeklyOffs),
    String(e.summary.holidays),
    String(e.summary.workedOnHoliday),
  ]);
  const disciplineRows: DataTableCell[][] = data.employees.map((e) => [
    { text: e.name, bold: true },
    String(e.summary.lateCount),
    e.summary.lateMinutes > 0 ? `${e.summary.lateMinutes} min` : '—',
    String(e.summary.earlyOuts),
    String(e.summary.checkoutMissing),
    fmtHours(e.summary),
    e.summary.avgHoursPerDay === null ? '—' : `${e.summary.avgHoursPerDay} h`,
    rate(e.summary),
    String(e.summary.corrections),
    e.summary.fakeLocationDays > 0
      ? { text: String(e.summary.fakeLocationDays), color: RED, bold: true }
      : '0',
  ]);
  return [
    dataTable(
      [
        { header: 'Employee', width: 92 },
        { header: 'Office(s)', width: 78 },
        { header: 'Joined', width: 44 },
        { header: 'Days worked', width: 42, align: 'center' },
        { header: 'Full', width: 30, align: 'center' },
        { header: 'Half', width: 30, align: 'center' },
        { header: 'Absent', width: 36, align: 'center' },
        { header: 'Leave', width: 34, align: 'center' },
        { header: 'Off', width: 28, align: 'center' },
        { header: 'Holiday', width: 40, align: 'center' },
        { header: 'Extra', width: 32, align: 'center' },
      ],
      attendanceRows,
    ),
    dataTable(
      [
        { header: 'Employee', width: 92 },
        { header: 'Late days', width: 44, align: 'center' },
        { header: 'Late minutes', width: 56, align: 'center' },
        { header: 'Early outs', width: 42, align: 'center' },
        { header: 'Missed check-outs', width: 62, align: 'center' },
        { header: 'Worked hours', width: 56, align: 'center' },
        { header: 'Avg hrs/day', width: 48, align: 'center' },
        { header: 'Attendance', width: 50, align: 'center' },
        { header: 'Corrections', width: 46, align: 'center' },
        { header: 'Fake GPS', width: 36, align: 'center' },
      ],
      disciplineRows,
    ),
  ];
}

/** The day register: one grid, employee × date, single-char codes. */
function registerSection(data: AttendanceReportData): Content[] {
  if (!data.register) return [];
  const dayColumns = data.register.dates.map((date, i) => {
    const day = Number(date.slice(8, 10));
    const month = date.slice(5, 7);
    const prev = i > 0 ? data.register!.dates[i - 1].slice(5, 7) : null;
    return {
      header: `${day}\n${month !== prev ? monthName(month) : ''}`,
      width: Math.min(14, Math.floor((515 - 100) / data.register!.dates.length)),
      noWrap: true,
      align: 'center' as const,
    };
  });
  const rows: DataTableCell[][] = data.register.rows.map((r) => [
    { text: r.name, bold: true, fontSize: 7.5 },
    ...r.codes.map((code) => ({
      text: code,
      fontSize: 7,
      alignment: 'center' as const,
      color: code === 'A' || code === 'M' ? RED : code === 'H' ? AMBER : undefined,
    })),
  ]);
  return [
    dataTable(
      [{ header: 'Employee', width: 100 }, ...dayColumns],
      rows,
    ),
    {
      text:
        'P present · H half day · A absent · L leave · Hl half-day leave · ' +
        'W worked on holiday · O weekly off · ★ holiday · M checkout missing · ' +
        '· not tracked / not yet',
      fontSize: 7.5,
      color: MUTED,
      margin: [0, 0, 0, 12],
    },
  ];
}

const monthName = (mm: string) => MONTHS[Number(mm) - 1];

function kept(title: Content, firstBlock: Content): Content {
  return { unbreakable: true, stack: [title, firstBlock] } satisfies Content;
}

export function buildAttendanceReportDocument(
  data: AttendanceReportData,
): ReportDocument {
  const scopeBits: string[] = [
    data.scope.allOffices
      ? 'All offices'
      : `${data.scope.selectedOffices} office${data.scope.selectedOffices === 1 ? '' : 's'}`,
    data.scope.allEmployees
      ? 'All employees'
      : `${data.scope.selectedEmployees} employee${data.scope.selectedEmployees === 1 ? '' : 's'}`,
  ];
  const scope = `${scopeBits.join(' · ')} · ${data.scope.employeesInScope} tracked`;

  const content: Content[] = [
    pageHeader(
      data.tenant,
      'Attendance Report',
      { startDate: data.range.startDate, endDate: data.range.endDate },
      scope,
    ),
  ];

  if (data.employees.length === 0) {
    content.push(emptyStateBlock('No attendance data for these dates'));
    return {
      pageSize: 'A4',
      pageMargins: [
        PAGE_MARGINS.left,
        PAGE_MARGINS.top,
        PAGE_MARGINS.right,
        PAGE_MARGINS.bottom,
      ],
      defaultStyle: { font: FONT_FAMILY, fontSize: 9.5, color: brand.textBody },
      footer: pageFooter(),
      content,
    };
  }

  const overallCards = metricCardRows(data);
  content.push(kept(sectionTitle('Overall'), overallCards[0]));
  content.push(overallCards[1], overallCards[2]);

  if (data.offices.length > 0) {
    const officeTable = dataTable(
      [
        { header: 'Office', width: '*' },
        { header: 'Employees', width: 52, align: 'center' },
        { header: 'Days worked', width: 56, align: 'center' },
        { header: 'Absent', width: 40, align: 'center' },
        { header: 'Leave', width: 38, align: 'center' },
        { header: 'Late', width: 36, align: 'center' },
        { header: 'Attendance', width: 54, align: 'center' },
        { header: 'Worked hrs', width: 52, align: 'center' },
      ],
      data.offices.map((o) => [
        { text: o.name, bold: true },
        String(o.employees),
        String(o.summary.daysWorked),
        String(o.summary.absent),
        String(o.summary.leave),
        String(o.summary.lateCount),
        rate(o.summary),
        fmtHours(o.summary),
      ]),
    );
    content.push(kept(sectionTitle('Offices'), officeTable));
  }

  const [attendanceTable, disciplineTable] = employeeTables(data);
  content.push(kept(sectionTitle('Employees — attendance'), attendanceTable));
  content.push(
    kept(sectionTitle('Employees — discipline & hours'), disciplineTable),
  );

  if (data.exceptions.length > 0) {
    const title = sectionTitle('Needs attention', 'triangle-alert');
    const items = data.exceptions.slice(0, 200).map((e) => {
      const presentation = EXCEPTION_PRESENTATION[e.kind];
      return {
        title: `${e.title} · ${e.employeeName}`,
        detail: e.detail,
        icon: presentation.icon,
        color: presentation.color,
      };
    });
    const list = flagList(items);
    if (data.exceptions.length > 200) {
      content.push(
        title,
        list,
        {
          text: `+${data.exceptions.length - 200} more — narrow the filters`,
          fontSize: 8.5,
          color: MUTED,
          margin: [0, 0, 0, 12],
        },
      );
    } else if (data.exceptions.length <= 6) {
      content.push(kept(title, list));
    } else {
      content.push(title, list);
    }
  }

  if (data.weeks.length > 1) {
    const trendTable = dataTable(
      [
        { header: 'Week', width: '*' },
        { header: 'Attendance', width: 60, align: 'center' },
        { header: 'Days worked', width: 60, align: 'center' },
        { header: 'Absent', width: 44, align: 'center' },
        { header: 'Late', width: 40, align: 'center' },
        { header: 'Leave', width: 40, align: 'center' },
      ],
      data.weeks.map((w) => [
        { text: w.label, bold: true },
        rate(w.summary),
        String(w.summary.daysWorked),
        String(w.summary.absent),
        String(w.summary.lateCount),
        String(w.summary.leave),
      ]),
    );
    content.push(kept(sectionTitle('Weekly trend'), trendTable));
  }

  content.push(...registerSection(data));

  const leaveRows = data.employees.filter(
    (e) => e.summary.leave > 0 || e.summary.pendingLeaveDays > 0 || e.summary.halfDayLeaves > 0,
  );
  if (leaveRows.length > 0) {
    const leaveTable = dataTable(
      [
        { header: 'Employee', width: '*' },
        { header: 'Approved (days)', width: 70, align: 'center' },
        { header: 'Pending (days)', width: 70, align: 'center' },
        { header: 'Half-day leaves', width: 70, align: 'center' },
      ],
      leaveRows.map((e) => [
        { text: e.name, bold: true },
        String(e.summary.leave),
        e.summary.pendingLeaveDays > 0
          ? { text: String(e.summary.pendingLeaveDays), color: AMBER }
          : '0',
        String(e.summary.halfDayLeaves),
      ]),
    );
    content.push(kept(sectionTitle('Leave summary'), leaveTable));
  }

  if (data.rejections.length > 0) {
    const rejectionTable = dataTable(
      [
        { header: 'Employee', width: '*' },
        { header: 'Too far', width: 48, align: 'center' },
        { header: 'Low accuracy', width: 56, align: 'center' },
        { header: 'Fake location', width: 56, align: 'center' },
        { header: 'Rate-limited', width: 56, align: 'center' },
        { header: 'Other', width: 40, align: 'center' },
      ],
      data.rejections.map((r) => [
        { text: r.employeeName, bold: true },
        String(r.tooFar),
        String(r.lowAccuracy),
        r.mocked > 0
          ? { text: String(r.mocked), color: RED, bold: true }
          : '0',
        String(r.rateLimited),
        String(r.other),
      ]),
    );
    content.push(
      kept(
        sectionTitle('Rejected punches', 'camera-off'),
        rejectionTable,
      ),
    );
    content.push(rejectionsNote());
  }

  return {
    pageSize: 'A4',
    pageMargins: [
      PAGE_MARGINS.left,
      PAGE_MARGINS.top,
      PAGE_MARGINS.right,
      PAGE_MARGINS.bottom,
    ],
    defaultStyle: {
      font: FONT_FAMILY,
      fontSize: 9.5,
      color: brand.textBody,
    },
    footer: pageFooter(),
    content,
  };
}

/** Caption note under the rejected-punches table. */
function rejectionsNote(): Content {
  return {
    text: 'Attempts shown here never became attendance records.',
    fontSize: 7.5,
    color: MUTED,
    margin: [0, -6, 0, 12],
  };
}
