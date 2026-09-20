import type { ReportDocument } from '../registry/report-definition';
import {
  brand,
  FONT_FAMILY,
  PAGE_MARGINS,
} from '../templates/brand-kit/brand-theme';
import { pageHeader, pageFooter } from '../templates/brand-kit/page-header';
import { summaryCardRow } from '../templates/brand-kit/summary-cards';
import { sectionTitle, emptyStateBlock, flagList } from '../templates/brand-kit/sections';
import { jobsTable, JobTableRow } from '../templates/brand-kit/job-table';
import { PdfmakeRenderer } from './pdfmake-renderer';

/**
 * One cheap end-to-end smoke render through the real pdfmake binding (the
 * story's live verification covered the full two-page report; this locks the
 * same contract in CI): the brand kit's full node vocabulary — header, cards,
 * icons, table, empty state, flags — compiles into PDF bytes starting with
 * the %PDF magic. Fonts are the bundled absolute TTF paths, never Buffers
 * (the known pdfmake 0.3 gotcha).
 */

const ROWS: JobTableRow[] = [
  {
    jobNumber: 'J-1042',
    planned: '20 Sep 16:30',
    customer: 'Priya Sharma',
    skill: 'AC repair',
    status: 'In progress',
    finish: '20 Sep 19:10',
    proofs: 3,
  },
  {
    jobNumber: 'J-1043',
    planned: '21 Sep 10:00',
    customer: 'Ravi Menon',
    skill: 'Plumbing',
    status: 'Cancelled',
    finish: '—',
    proofs: 0,
  },
];

function sampleDocument(): ReportDocument {
  return {
    content: [
      pageHeader(
        { companyName: 'Acme Facilities', address: 'MG Road, Bengaluru' },
        'Technician job activity',
        { startDate: '2026-09-01', endDate: '2026-09-07' },
        'All technicians',
      ),
      summaryCardRow([
        { label: 'Total jobs', value: '42', accent: brand.done, icon: 'clipboard-list', caption: '95% finish rate' },
        { label: 'In progress', value: '3', accent: brand.scheduled, icon: 'timer' },
        { label: 'Cancelled', value: '2', accent: brand.cancelled, icon: 'circle-x' },
      ]),
      sectionTitle('Needs attention', 'triangle-alert'),
      flagList([
        { title: 'Overdue · J-1044', detail: 'Planned 3 days ago, still pending.' },
      ]),
      sectionTitle('Per technician', 'users'),
      jobsTable(ROWS),
      emptyStateBlock('No jobs in this period.'),
    ],
    defaultStyle: { font: FONT_FAMILY },
    pageMargins: [
      PAGE_MARGINS.left,
      PAGE_MARGINS.top,
      PAGE_MARGINS.right,
      PAGE_MARGINS.bottom,
    ],
    footer: pageFooter(),
  };
}

describe('PdfmakeRenderer — real render smoke (pdfmake 0.3 + Inter TTFs)', () => {
  it('compiles a full brand-kit document into a %PDF buffer', async () => {
    const renderer = new PdfmakeRenderer();
    const bytes = await renderer.render(sampleDocument());

    expect(bytes).toBeInstanceOf(Buffer);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  }, 30000);

  it('renders an empty-data document (all-zero tables, no jobs) without crashing', async () => {
    const renderer = new PdfmakeRenderer();
    const bytes = await renderer.render({
      content: [jobsTable([]), emptyStateBlock('No jobs in this period.')],
      defaultStyle: { font: FONT_FAMILY },
    });

    expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  }, 30000);
});