import { getIstDayRange } from './ist-day-range.util';

describe('getIstDayRange', () => {
  it('returns start at IST midnight (UTC 18:30 prev day) and end 24h later', () => {
    // IST noon on 2026-06-19 = 2026-06-19T06:30:00Z
    const utcNoon = new Date('2026-06-19T06:30:00.000Z');
    const { start, end } = getIstDayRange(utcNoon);

    expect(start.toISOString()).toBe('2026-06-18T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-06-19T18:30:00.000Z');
  });

  it('handles IST midnight boundary (just before midnight IST)', () => {
    // 2026-06-18T23:59:59 IST = 2026-06-18T18:29:59Z
    const utcJustBeforeMidnight = new Date('2026-06-18T18:29:59.000Z');
    const { start, end } = getIstDayRange(utcJustBeforeMidnight);

    expect(start.toISOString()).toBe('2026-06-17T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-06-18T18:30:00.000Z');
  });

  it('handles IST midnight boundary (just after midnight IST)', () => {
    // 2026-06-19T00:00:01 IST = 2026-06-18T18:30:01Z
    const utcJustAfterMidnight = new Date('2026-06-18T18:30:01.000Z');
    const { start, end } = getIstDayRange(utcJustAfterMidnight);

    expect(start.toISOString()).toBe('2026-06-18T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-06-19T18:30:00.000Z');
  });

  it('start and end are exactly 24 hours apart', () => {
    const utcNow = new Date('2026-06-19T10:00:00.000Z');
    const { start, end } = getIstDayRange(utcNow);

    const diffMs = end.getTime() - start.getTime();
    expect(diffMs).toBe(24 * 60 * 60 * 1000);
  });
});
