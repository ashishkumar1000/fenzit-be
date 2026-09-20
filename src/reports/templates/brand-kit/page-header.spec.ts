import type { Content } from 'pdfmake/interfaces';
import { brand, FONT_FAMILY, CONTENT_WIDTH, PAGE_MARGINS } from './brand-theme';
import { logoDataUri, FONT_SEMIBOLD } from './brand-assets';
import { pageHeader, pageFooter, HeaderTenant } from './page-header';

/**
 * The page header is the tenant identity block and the footer is the page
 * strip on every page — these tests lock the node structure templates embed:
 * the logo image, the plain-English footer labels, and the optional
 * address/subtitle paths (present and absent).
 */

const TENANT: HeaderTenant = { companyName: 'Acme Facilities', address: 'MG Road, Bengaluru' };
const RANGE = { startDate: '2026-09-01', endDate: '2026-09-07' };

describe('page-header — pageHeader', () => {
  it('opens with the logo + tenant identity table (logo left, name right)', () => {
    const node = pageHeader(TENANT, 'Technician job activity', RANGE);

    const identityTable = node.stack[0] as {
      table: { widths: unknown[]; body: [Content[]] };
      layout: string;
    };
    // 30pt logo + 8pt gutter, then the auto-sized identity column.
    expect(identityTable.table.widths).toEqual([38, 'auto']);
    expect(identityTable.layout).toBe('noBorders');

    const [logoCell, identityCell] = identityTable.table.body[0];
    expect((logoCell as { image: string }).image).toBe(logoDataUri);

    const identityStack = (identityCell as { stack: Content[] }).stack;
    expect(identityStack[0]).toMatchObject({
      text: 'Acme Facilities',
      font: FONT_SEMIBOLD,
      color: brand.text,
    });
    expect(identityStack[1]).toMatchObject({
      text: 'MG Road, Bengaluru',
      font: FONT_FAMILY,
      color: brand.textMuted,
    });
  });

  it('omits the address line entirely when the tenant has none', () => {
    const node = pageHeader({ companyName: 'Solo Corp' }, 'Title', RANGE);

    const identityTable = node.stack[0] as {
      table: { body: [Content[]] };
    };
    const identityCell = identityTable.table.body[0][1] as { stack: Content[] };
    expect(identityCell.stack).toHaveLength(1);
  });

  it('renders the title, the IST date range line, and the accent bar', () => {
    const node = pageHeader(TENANT, 'Technician job activity', RANGE);

    expect(node.stack[1]).toMatchObject({
      text: 'Technician job activity',
      fontSize: 18,
      font: FONT_SEMIBOLD,
    });
    expect(node.stack[2]).toMatchObject({
      text: '2026-09-01 → 2026-09-07 (IST)',
      color: brand.textMuted,
    });

    const accentBar = node.stack[node.stack.length - 1] as {
      canvas: { type: string; w: number; h: number; color: string }[];
    };
    expect(accentBar.canvas[0]).toMatchObject({
      type: 'rect',
      w: 44,
      h: 3,
      color: brand.primary,
    });
  });

  it('adds the subtitle line when given, and a spacer when not', () => {
    const withSubtitle = pageHeader(TENANT, 'Title', RANGE, 'All technicians');
    expect(withSubtitle.stack[3]).toMatchObject({ text: 'All technicians' });

    const withoutSubtitle = pageHeader(TENANT, 'Title', RANGE);
    expect(withoutSubtitle.stack[3]).toMatchObject({ text: '' });
  });
});

describe('page-header — pageFooter', () => {
  it('formats the creation timestamp on the IST clock (no seconds, no T)', () => {
    const footer = pageFooter() as (page: number, total: number) => Content;

    const strip = footer(2, 3) as {
      margin: number[];
      stack: { columns: { text: string }[] }[];
    };
    const [left, right] = strip.stack[1].columns;

    expect(left.text).toMatch(/^Created \d{4}-\d{2}-\d{2} \d{2}:\d{2} IST/);
    expect(right.text).toBe('Fenzit · 2 / 3');
    expect(left.text).toContain('Private — contains customer details');
  });

  it('uses the page margins so the footer rule lines up with the content', () => {
    const footer = pageFooter() as (page: number, total: number) => Content;

    const strip = footer(1, 1) as { margin: number[] };
    expect(strip.margin).toEqual([
      PAGE_MARGINS.left,
      0,
      PAGE_MARGINS.right,
      12,
    ]);

    // The hairline above the strip spans exactly the printable content width.
    const rule = strip.stack[0] as {
      canvas: { type: string; x2: number; lineColor: string }[];
    };
    expect(rule.canvas[0]).toMatchObject({
      type: 'line',
      x2: CONTENT_WIDTH,
      lineColor: brand.border,
    });
  });
});