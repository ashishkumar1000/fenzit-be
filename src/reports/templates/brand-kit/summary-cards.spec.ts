import { brand, gray, statusTints, CARD } from './brand-theme';
import { summaryCardRow, SummaryCard } from './summary-cards';

/**
 * Summary metric cards — these tests lock the FE-matching card anatomy (chip,
 * label, value, optional caption) and the accent→tint derivation that keeps
 * the chip fill paired with its status colour.
 */

/** Flattens one card column to its inner stack (chip node first, if any). */
function cardStack(row: ReturnType<typeof summaryCardRow>, index: number) {
  const column = (row as unknown as {
    columns: { table: { body: [Record<string, unknown>[]] } }[];
  }).columns[index];
  return (column.table.body[0][0] as { stack: Record<string, unknown>[] })
    .stack;
}

describe('summary-cards — summaryCardRow', () => {
  it('lays one column per card with a gap and a single-cell body each', () => {
    const cards: SummaryCard[] = [
      { label: 'Total jobs', value: '42' },
      { label: 'Completed', value: '38', accent: brand.done },
      { label: 'Cancelled', value: '2', accent: brand.cancelled },
    ];
    const row = summaryCardRow(cards) as unknown as {
      columns: unknown[];
      columnGap: number;
      margin: number[];
    };

    expect(row.columns).toHaveLength(3);
    expect(row.columnGap).toBe(6);
    expect(row.margin).toEqual([0, 0, 0, 12]);
    for (const column of row.columns as {
      table: { widths: unknown[]; body: unknown[][] };
    }[]) {
      expect(column.table.widths).toEqual(['*']);
      expect(column.table.body).toHaveLength(1);
    }
  });

  it('renders label (dark) then value (accent or dark) without a chip or caption when optional fields are absent', () => {
    const stack = cardStack(summaryCardRow([{ label: 'Total jobs', value: '42' }]), 0);

    expect(stack).toHaveLength(2); // no icon → no chip
    expect(stack[0]).toMatchObject({
      text: 'Total jobs',
      color: brand.text,
      font: expect.any(String),
    });
    expect(stack[1]).toMatchObject({ text: '42', color: brand.text });
  });

  it('prepends a tinted icon chip when the card has an icon, deriving its tint from the accent', () => {
    const stack = cardStack(
      summaryCardRow([
        {
          label: 'Completed',
          value: '38',
          accent: brand.done,
          icon: 'circle-check',
          caption: '95% finish rate',
        },
      ]),
      0,
    );

    expect(stack).toHaveLength(4); // chip, label, value, caption
    const chip = stack[0] as {
      table: { widths: unknown[]; body: [Record<string, unknown>[]] };
      layout: string;
    };
    expect(chip.table.widths).toEqual([16]);
    expect(chip.layout).toBe('noBorders');
    const chipCell = chip.table.body[0][0] as {
      fillColor: string;
      stack: { svg: string }[];
    };
    expect(chipCell.fillColor).toBe(statusTints.completed);
    expect(chipCell.stack[0].svg).toContain(brand.done);

    expect(stack[1]).toMatchObject({ text: 'Completed' });
    expect(stack[2]).toMatchObject({ text: '38', color: brand.done });
    expect(stack[3]).toMatchObject({ text: '95% finish rate', color: brand.textMuted });
  });

  it.each([
    ['done → completed tint', brand.done, statusTints.completed],
    ['scheduled → scheduled tint', brand.scheduled, statusTints.scheduled],
    ['cancelled → cancelled tint', brand.cancelled, statusTints.cancelled],
    ['unknown accent → brand tint', '#123456', brand.primaryTint],
    ['no accent → neutral gray', undefined, gray[100]],
  ])('derives the chip tint: %s', (_name, accent, expectedTint) => {
    const stack = cardStack(
      summaryCardRow([{ label: 'K', value: '1', accent, icon: 'users' }]),
      0,
    );
    const chip = stack[0] as { table: { body: [Record<string, unknown>[]] } };
    expect(
      (chip.table.body[0][0] as { fillColor: string }).fillColor,
    ).toBe(expectedTint);
  });

  it('honours explicit tint and iconColor overrides over the derived ones', () => {
    const stack = cardStack(
      summaryCardRow([
        {
          label: 'Proofs',
          value: '17',
          accent: brand.done,
          icon: 'camera',
          tint: '#FFEEDD',
          iconColor: '#AA0000',
        },
      ]),
      0,
    );
    const chip = stack[0] as { table: { body: [Record<string, unknown>[]] } };
    const chipCell = chip.table.body[0][0] as {
      fillColor: string;
      stack: { svg: string }[];
    };
    expect(chipCell.fillColor).toBe('#FFEEDD');
    expect(chipCell.stack[0].svg).toContain('#AA0000');
  });

  it('cards sit on the white surface with the shared padding', () => {
    const row = summaryCardRow([{ label: 'Total jobs', value: '42' }]) as unknown as {
      columns: { table: { body: [Record<string, unknown>[]] } }[];
    };
    const cell = row.columns[0].table.body[0][0] as { fillColor: string; margin: number[] };
    expect(cell.fillColor).toBe(CARD.background);
    expect(cell.margin).toEqual([
      CARD.padding,
      CARD.padding,
      CARD.padding,
      CARD.padding,
    ]);
  });
});