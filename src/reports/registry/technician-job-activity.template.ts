import type { Content } from 'pdfmake/interfaces';
import {
  brand,
  FONT_FAMILY,
  PAGE_MARGINS,
} from '../templates/brand-kit/brand-theme';
import {
  pageHeader,
  summaryCardRow,
  jobsTable,
  pageFooter,
  sectionTitle,
  emptyStateRow,
  emptyStateBlock,
  flagList,
} from '../templates/brand-kit/page-chrome';
import type {
  ActivityJobStatus,
  FetchedJob,
  TechnicianJobActivityData,
} from './technician-job-activity.data';
import {
  computeMetrics,
  type ActivityMetrics,
} from './technician-job-activity.metrics';
import { computeFlags, type FlagKind } from './technician-job-activity.flags';
import type { BrandIcon } from '../templates/brand-kit/brand-icons';
import type { ReportDocument } from './report-definition';

/**
 * Technician Job Activity template (FR15) — story 12-5. Composes ONLY
 * structure from the brand-kit helpers; every colour, font and asset flows
 * from the kit (FR-T2). Layout: branded header (with the selection scope),
 * the Overall section first, a "Needs attention" section flagging what the
 * owner should look into, then one section per technician (zero-job
 * technicians included, FR18); a selection with no jobs at all renders the
 * explicit empty page (FR18).
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

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

/** IST calendar date + HH:mm from a stored timestamptz (no date library). */
function istParts(iso: string): { date: string; time: string } {
  const shifted = new Date(
    new Date(iso).getTime() + IST_OFFSET_MS,
  ).toISOString();
  return { date: shifted.slice(0, 10), time: shifted.slice(11, 16) };
}

/** "20 Sep" from a YYYY-MM-DD slice — friendlier than 2026-09-20. */
function shortDate(isoDate: string): string {
  return `${Number(isoDate.slice(8, 10))} ${MONTHS[Number(isoDate.slice(5, 7)) - 1]}`;
}

const STATUS_LABELS: Record<ActivityJobStatus, string> = {
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

function toJobTableRow(job: FetchedJob) {
  const scheduled = istParts(job.scheduledStart);
  const completed = job.completedAt ? istParts(job.completedAt) : null;
  return {
    jobNumber: job.jobNumber,
    planned: `${shortDate(scheduled.date)} ${scheduled.time}`,
    customer: job.customerName,
    skill: job.skillName ?? '—',
    status: STATUS_LABELS[job.status],
    // Multi-day ranges make the finish date as important as the time.
    finish: completed ? `${shortDate(completed.date)} ${completed.time}` : '—',
    proofs: job.photoCount + job.signatureCount,
  };
}

/** The PRD §4 metric set as two rows of summary cards — the FE metric-card
 *  design (tinted icon chip, dark label, large value). Plain-English labels
 *  (user request 2026-09-20); captions only carry real derived info, never
 *  filler text. */
function metricCardRows(m: ActivityMetrics): Content[] {
  const total = m.totalAssigned;
  const share = (part: number) =>
    total > 0 ? `${Math.round((part / total) * 100)}%` : '0%';
  return [
    summaryCardRow([
      {
        label: 'Total jobs',
        value: String(total),
        icon: 'clipboard-list',
        iconColor: brand.primary,
        tint: brand.primaryTint,
      },
      {
        label: 'Completed',
        value: String(m.completed),
        accent: brand.done,
        icon: 'circle-check',
        caption: `${share(m.completed)} finish rate`,
      },
      {
        label: 'Open',
        value: String(m.open),
        accent: brand.scheduled,
        icon: 'clock',
      },
      {
        label: 'Cancelled',
        value: String(m.cancelled),
        accent: brand.cancelled,
        icon: 'circle-x',
        caption: `${share(m.cancelled)} drop rate`,
      },
    ]),
    summaryCardRow([
      {
        label: 'Finished on time %',
        value: m.onTimePercent,
        icon: 'timer',
        caption: m.completed === 0 ? 'No completed jobs yet' : undefined,
      },
      {
        label: 'Urgent jobs done',
        value: String(m.urgentCompleted),
        icon: 'zap',
      },
      { label: 'Customers', value: String(m.distinctCustomers), icon: 'users' },
      {
        label: 'Photos & signatures',
        value: String(m.photosAndSignatures),
        icon: 'camera',
      },
    ]),
  ];
}

/** One Lucide icon + one severity colour per concern kind: urgent and
 *  on-time failures are alarms (red), a missing proof is a warning
 *  (amber), a cancellation is informational (muted). */
const FLAG_ICONS: Record<FlagKind, BrandIcon> = {
  'Not done on time': 'clock',
  'Urgent job not done': 'zap',
  'No proof of work': 'camera-off',
  Cancelled: 'circle-x',
};

const FLAG_COLORS: Record<FlagKind, string> = {
  'Not done on time': brand.cancelled,
  'Urgent job not done': brand.cancelled,
  'No proof of work': brand.scheduled,
  Cancelled: brand.textMuted,
};

/** A section title glued to its first content block — pdfmake has no
 *  keep-with-next, so a small `unbreakable` stack stops a heading from
 *  stranding at a page bottom (wrapper stays small; never wrap a table). */
function kept(title: Content, firstBlock: Content): Content {
  return { unbreakable: true, stack: [title, firstBlock] } satisfies Content;
}

export function buildTechnicianJobActivityDocument(
  data: TechnicianJobActivityData,
): ReportDocument {
  const selectedCount = data.technicians.length;
  const scope =
    selectedCount === 0
      ? 'All technicians'
      : `${selectedCount} technician${selectedCount === 1 ? '' : 's'} selected`;

  const content: Content[] = [
    pageHeader(
      data.tenant,
      'Technician Job Report',
      data.range,
      `${scope} · ${data.jobs.length} job${data.jobs.length === 1 ? '' : 's'} in this period`,
    ),
  ];

  if (data.jobs.length === 0) {
    content.push(emptyStateBlock('No jobs for these dates'));
  } else {
    const overall = metricCardRows(computeMetrics(data.jobs));
    content.push(kept(sectionTitle('Overall'), overall[0]));
    content.push(overall[1]);

    const flags = computeFlags(data, new Date().toISOString());
    if (flags.length > 0) {
      const title = sectionTitle('Needs attention', 'triangle-alert');
      const list = flagList(
        flags.map((f) => ({
          title: `${f.kind} · ${f.jobNumber}`,
          detail: `${f.detail} — ${f.technicianName}`,
          icon: FLAG_ICONS[f.kind],
          color: FLAG_COLORS[f.kind],
        })),
      );
      // A long flag list must be free to break — only small lists glue.
      if (flags.length <= 6) {
        content.push(kept(title, list));
      } else {
        content.push(title, list);
      }
    }

    for (const technician of data.technicians) {
      const technicianJobs = data.jobs.filter(
        (j) => j.technicianId === technician.id,
      );
      const cards = metricCardRows(computeMetrics(technicianJobs));
      content.push(kept(sectionTitle(technician.name, 'user'), cards[0]));
      content.push(cards[1]);
      content.push(
        technicianJobs.length > 0
          ? jobsTable(technicianJobs.map(toJobTableRow))
          : emptyStateRow('No jobs for these dates'),
      );
    }
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
