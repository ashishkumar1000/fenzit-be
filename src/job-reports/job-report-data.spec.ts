import { resolveReportWindow, isRealDate, istDateOf } from './job-report-data';
import { pageAllRows } from './page-all-rows';

describe('isRealDate', () => {
  it.each(['2026-02-28', '2028-02-29'])('%s is a real day', (d) => {
    expect(isRealDate(d)).toBe(true);
  });
  it.each([
    '2026-02-30',
    '2026-13-01',
    '2026-00-10',
    '2026-1-01',
    'not-a-date',
  ])('%s is refused', (d) => {
    expect(isRealDate(d)).toBe(false);
  });
});

describe('resolveReportWindow', () => {
  const now = new Date('2026-11-12T10:00:00Z'); // 15:30 IST on 12 Nov

  it('defaults to the last 30 IST days including today', () => {
    const w = resolveReportWindow({}, now);
    expect(w.to).toBe('2026-11-12');
    expect(w.from).toBe('2026-10-14');
  });
  it('an IST day runs from IST midnight, not UTC midnight', () => {
    const w = resolveReportWindow(
      { from: '2026-11-12', to: '2026-11-12' },
      now,
    );
    expect(w.start.toISOString()).toBe('2026-11-11T18:30:00.000Z');
    expect(w.end.toISOString()).toBe('2026-11-12T18:30:00.000Z');
  });
  it('a single-day window is valid; from after to is refused', () => {
    expect(() =>
      resolveReportWindow({ from: '2026-11-12', to: '2026-11-12' }, now),
    ).not.toThrow();
    expect(() =>
      resolveReportWindow({ from: '2026-11-13', to: '2026-11-12' }, now),
    ).toThrow('from must be on or before to');
  });
  it('a 366-day window is the largest allowed; 367 is refused', () => {
    expect(() =>
      resolveReportWindow({ from: '2025-11-12', to: '2026-11-12' }, now),
    ).not.toThrow();
    expect(() =>
      resolveReportWindow({ from: '2025-11-11', to: '2026-11-12' }, now),
    ).toThrow('at most 366 days');
  });
  it('a non-existent calendar day is refused with 422', () => {
    expect(() =>
      resolveReportWindow({ from: '2026-02-30', to: '2026-03-01' }, now),
    ).toThrow('real calendar dates');
  });
  it('istDateOf rolls over at IST midnight, not UTC midnight', () => {
    expect(istDateOf(new Date('2026-11-12T18:29:00Z'))).toBe('2026-11-12');
    expect(istDateOf(new Date('2026-11-12T18:31:00Z'))).toBe('2026-11-13');
  });
});

describe('pageAllRows: no silent 1000-row cut', () => {
  const make = (total: number) => (from: number, to: number) => {
    const end = Math.min(to + 1, total);
    const data = Array.from(
      { length: Math.max(0, end - from) },
      (_, i) => from + i,
    );
    return Promise.resolve({ data, error: null });
  };

  it('reads all rows when the total is exactly one page', async () => {
    expect(await pageAllRows(make(1000), 1000)).toHaveLength(1000);
  });
  it('reads past the first page (1001 rows)', async () => {
    const rows = await pageAllRows(make(1001), 1000);
    expect(rows).toHaveLength(1001);
    expect(rows[1000]).toBe(1000);
  });
  it('an empty result returns an empty list', async () => {
    expect(await pageAllRows(make(0), 1000)).toEqual([]);
  });
  it('a read error on the first page is thrown, never returned as an empty total', async () => {
    await expect(
      pageAllRows(
        () => Promise.resolve({ data: null, error: { message: 'boom' } }),
        10,
      ),
    ).rejects.toThrow('page read failed');
  });
  it('a read error after a full page is thrown, never a partial total', async () => {
    const pages = [
      { data: Array.from({ length: 10 }, (_, i) => i), error: null },
      { data: null, error: new Error('db timeout') },
    ];
    let call = 0;
    await expect(
      pageAllRows(() => Promise.resolve(pages[call++]), 10),
    ).rejects.toThrow('db timeout');
    expect(call).toBe(2);
  });
});
