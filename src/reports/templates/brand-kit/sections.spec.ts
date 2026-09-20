import type { TableLayout } from 'pdfmake/interfaces';
import { brand, TABLE, FONT_FAMILY } from './brand-theme';
import { FONT_SEMIBOLD } from './brand-assets';
import {
  sectionTitle,
  emptyStateRow,
  emptyStateBlock,
  flagList,
  FlagItem,
} from './sections';

/**
 * Section furniture — these tests lock the shapes templates compose: plain vs
 * icon section titles, the two empty-state variants (FR18), and the flag list
 * where each row must carry its own icon, severity colour, and detail text.
 */

describe('sections — sectionTitle', () => {
  it('renders a plain branded heading when no icon is given', () => {
    const node = sectionTitle('Overall');

    expect(node).toMatchObject({
      text: 'Overall',
      font: FONT_SEMIBOLD,
      color: brand.primary,
      margin: [0, 14, 0, 8],
    });
  });

  it('renders the icon + text as a borderless two-column row when an icon is given', () => {
    const node = sectionTitle('Needs attention', 'triangle-alert') as {
      table: { widths: unknown[]; body: Content[][] };
      layout: TableLayout;
    };

    expect(node.table.widths).toEqual([18, 'auto']);
    const [iconCell, textCell] = node.table.body[0];
    // The icon cell IS the svg node (not a text node), recoloured to brand.
    expect((iconCell as { svg: string }).svg).toContain(brand.primary);
    expect(textCell).toMatchObject({
      text: 'Needs attention',
      color: brand.primary,
    });
    // Zero-width rules keep the heading from reading as a boxed table.
    expect(node.layout.hLineWidth(0)).toBe(0);
    expect(node.layout.vLineWidth(0)).toBe(0);
  });
});

describe('sections — empty states (FR18)', () => {
  it.each([
    ['row', emptyStateRow],
    ['block', emptyStateBlock],
  ])('renders the empty-state %s as a single centered muted cell', (_kind, build) => {
    const node = build('No jobs in this period.') as {
      table: { widths: unknown[]; body: Content[][] };
      layout: TableLayout;
    };

    expect(node.table.widths).toEqual(['*']);
    expect(node.table.body).toHaveLength(1);
    const cell = node.table.body[0][0] as Record<string, unknown>;
    expect(cell.text).toBe('No jobs in this period.');
    expect(cell.alignment).toBe('center');
    expect(cell.color).toBe(brand.textMuted);
    expect(cell.fillColor).toBe(TABLE.zebraBackground);
    // Hairline box on every edge — a quiet framed empty state.
    expect(node.layout.hLineWidth(0)).toBe(0.75);
    expect(node.layout.vLineWidth(0)).toBe(0.75);
  });

  it('differentiates the two variants: the block is larger and padded wider', () => {
    const row = emptyStateRow('x') as { table: { body: Content[][] } };
    const block = emptyStateBlock('x') as { table: { body: Content[][] } };

    expect((block.table.body[0][0] as { fontSize: number }).fontSize).toBe(13);
    expect((row.table.body[0][0] as { fontSize: number }).fontSize).toBe(8.5);
    expect((block.table.body[0][0] as { margin: number[] }).margin).toEqual([
      24, 28, 24, 28,
    ]);
  });
});

describe('sections — flagList', () => {
  const FLAGS: FlagItem[] = [
    { title: 'Overdue · J-1042', detail: 'Planned 3 days ago, still pending.' },
    {
      title: 'Cancelled · J-1043',
      detail: 'Customer cancelled on the visit morning.',
      color: brand.textMuted,
      icon: 'circle-x',
    },
  ];

  it('renders every flag as an icon + title + detail row (3 columns)', () => {
    const node = flagList(FLAGS) as {
      table: { widths: unknown[]; body: Content[][] };
      layout: TableLayout;
      margin: number[];
    };

    expect(node.table.widths).toEqual([16, 'auto', '*']);
    expect(node.table.body).toHaveLength(FLAGS.length);
    expect(node.margin).toEqual([0, 0, 0, 12]);
  });

  it('defaults to the alarm icon and cancelled colour, and honours overrides', () => {
    const node = flagList(FLAGS) as { table: { body: Content[][] } };
    const [defaultRow, overrideRow] = node.table.body;

    const [defaultIcon, defaultTitle, detailCell] = defaultRow as [
      { stack: { svg: string }[] },
      { text: string; color: string; font: string },
      { text: string; color: string },
    ];
    expect(defaultIcon.stack[0].svg).toContain(brand.cancelled); // triangle-alert
    expect(defaultTitle.text).toBe('Overdue · J-1042');
    expect(defaultTitle.color).toBe(brand.cancelled);
    expect(defaultTitle.font).toBe(FONT_SEMIBOLD);
    expect(detailCell.color).toBe(brand.textBody);
    expect(detailCell.font).toBe(FONT_FAMILY);

    const [overrideIcon, overrideTitle] = overrideRow as [
      { stack: { svg: string }[] },
      { text: string; color: string },
    ];
    expect(overrideIcon.stack[0].svg).toContain(brand.textMuted); // circle-x
    expect(overrideTitle.text).toBe('Cancelled · J-1043');
    expect(overrideTitle.color).toBe(brand.textMuted);
  });

  it('suppresses the row hairlines for short lists, and rules only between rows for long ones', () => {
    // Layout is derived from the item count at build time — long lists get a
    // hairline between consecutive rows only (never above the first row).
    const short = flagList(FLAGS.slice(0, 2)).layout as TableLayout;
    for (let i = 0; i <= 2; i++) {
      expect(short.hLineWidth(i)).toBe(0);
    }

    const long = flagList(Array.from({ length: 6 }, (_, i) => ({
      title: `Flag ${i + 1}`,
      detail: 'Detail.',
    }))).layout as TableLayout;
    expect(long.hLineWidth(0)).toBe(0);
    expect(long.hLineWidth(1)).toBe(0);
    expect(long.hLineWidth(2)).toBe(0.5);
    expect(long.hLineWidth(5)).toBe(0.5);
    expect(long.hLineWidth(6)).toBe(0); // nothing after the last row
  });
});