import {
  pickCurrentWeeklyOff,
  pickNextWeeklyOff,
  sortWeeklyOffRows,
  toWeeklyOffHistory,
  toWeeklyOffView,
  WeeklyOffRow,
} from './weekly-offs-response.model';

const TODAY = '2026-09-27';

function row(overrides: Partial<WeeklyOffRow> = {}): WeeklyOffRow {
  return {
    id: 'wo-uuid',
    tenant_id: 'tenant-uuid',
    valid: '[2026-09-27,)',
    days: [6, 7],
    created_at: '2026-09-27T00:00:00Z',
    updated_at: '2026-09-27T00:00:00Z',
    ...overrides,
  };
}

describe('weekly-offs-response.model (story 15-5)', () => {
  describe('toWeeklyOffView', () => {
    it('maps the snake_case row to the API shape — days sorted ascending, range bounds split', () => {
      expect(
        toWeeklyOffView(row({ valid: '[2026-09-20,2026-10-05)', days: [7, 6] })),
      ).toEqual({
        days: [6, 7],
        validFrom: '2026-09-20',
        validTo: '2026-10-05',
      });
    });

    it('an open-ended range maps to validTo null', () => {
      expect(toWeeklyOffView(row({ valid: '[2026-09-27,)' })).validTo).toBeNull();
    });

    it('an empty days array (works-all-7 override) maps through unchanged', () => {
      expect(toWeeklyOffView(row({ days: [] })).days).toEqual([]);
    });
  });

  describe('sortWeeklyOffRows', () => {
    it('orders by validFrom ascending without mutating the input', () => {
      const a = row({ id: 'a', valid: '[2026-10-01,)' });
      const b = row({ id: 'b', valid: '[2026-09-01,)' });
      const c = row({ id: 'c', valid: '[2026-09-20,)' });

      expect(sortWeeklyOffRows([a, b, c]).map((r) => r.id)).toEqual(['b', 'c', 'a']);
      // The input array is untouched — a sorted copy is returned.
      expect([a, b, c].map((r) => r.id)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('pickCurrentWeeklyOff', () => {
    it('picks the range containing today — lower inclusive, upper exclusive', () => {
      const clipped = row({ id: 'current', valid: '[2026-09-20,2026-09-28)' });
      expect(
        pickCurrentWeeklyOff(
          [row({ id: 'old', valid: '[2026-09-01,2026-09-20)' }), clipped],
          TODAY,
        )?.id,
      ).toBe('current');
    });

    it('an open-ended range contains today', () => {
      expect(pickCurrentWeeklyOff([row()], TODAY)?.id).toBe('wo-uuid');
    });

    it('a range ending today is NOT current (upper bound exclusive)', () => {
      expect(
        pickCurrentWeeklyOff([row({ valid: '[2026-09-01,2026-09-27)' })], TODAY),
      ).toBeNull();
    });

    it('a range starting today IS current', () => {
      expect(pickCurrentWeeklyOff([row()], TODAY)).not.toBeNull();
    });

    it('returns null with no history — the never-configured default', () => {
      expect(pickCurrentWeeklyOff([], TODAY)).toBeNull();
    });
  });

  describe('pickNextWeeklyOff', () => {
    it('picks the earliest future range', () => {
      expect(
        pickNextWeeklyOff(
          [
            row({ id: 'later', valid: '[2026-10-05,)' }),
            row({ id: 'past', valid: '[2026-09-01,2026-09-27)' }),
            row({ id: 'next', valid: '[2026-09-28,)' }),
          ],
          TODAY,
        )?.id,
      ).toBe('next');
    });

    it('a range starting today is current, not next', () => {
      expect(pickNextWeeklyOff([row()], TODAY)).toBeNull();
    });

    it('returns null with no pending edit', () => {
      expect(
        pickNextWeeklyOff([row({ valid: '[2026-09-01,2026-09-28)' })], TODAY),
      ).toBeNull();
    });
  });

  describe('toWeeklyOffHistory', () => {
    it('returns the full effective-dated history ascending — current and next included', () => {
      const past = row({ id: 'p', valid: '[2026-09-01,2026-09-20)', days: [1] });
      const current = row({ id: 'c', valid: '[2026-09-20,2026-10-05)', days: [7, 6] });
      const future = row({ id: 'f', valid: '[2026-10-05,)', days: [7] });

      const history = toWeeklyOffHistory([future, past, current]);

      expect(history.map((v) => v.validFrom)).toEqual([
        '2026-09-01',
        '2026-09-20',
        '2026-10-05',
      ]);
      expect(history[1].days).toEqual([6, 7]);
    });

    it('an empty history stays empty (the never-configured tenant)', () => {
      expect(toWeeklyOffHistory([])).toEqual([]);
    });
  });
});
