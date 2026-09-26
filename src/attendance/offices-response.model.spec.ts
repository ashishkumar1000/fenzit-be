import {
  AttendanceOfficeRow,
  AttendanceOfficeRuleRow,
  parseRuleRange,
  pickCurrentRule,
  pickNextRule,
  toOfficeDetailResponse,
  toOfficeRuleResponse,
} from './offices-response.model';

const TODAY = '2026-09-26';

function ruleRow(overrides: Partial<AttendanceOfficeRuleRow> = {}): AttendanceOfficeRuleRow {
  return {
    id: 'rule-uuid',
    office_id: 'office-uuid',
    tenant_id: 'tenant-uuid',
    valid: '[2026-09-26,)',
    start_time: '10:00:00',
    end_time: '18:00:00',
    late_cutoff_minutes: 15,
    full_day_hours: '8.00',
    half_day_hours: '4.00',
    created_at: '2026-09-26T00:00:00Z',
    updated_at: '2026-09-26T00:00:00Z',
    ...overrides,
  };
}

const officeRow: AttendanceOfficeRow = {
  id: 'office-uuid',
  tenant_id: 'tenant-uuid',
  name: 'Andheri West',
  latitude: 19.1364,
  longitude: 72.8296,
  radius_m: 200,
  archived_at: null,
  created_at: '2026-09-26T00:00:00Z',
  updated_at: '2026-09-26T00:00:00Z',
};

describe('offices-response.model (story 15-3)', () => {
  describe('parseRuleRange', () => {
    it('reads an open-ended range — empty upper means no end', () => {
      expect(parseRuleRange('[2026-09-26,)')).toEqual({
        from: '2026-09-26',
        to: null,
      });
    });

    it('reads a clipped (closed-upper) range', () => {
      expect(parseRuleRange('[2026-09-26,2026-09-27)')).toEqual({
        from: '2026-09-26',
        to: '2026-09-27',
      });
    });

    it('strips both bracket styles — PostgREST sends lower-inclusive/upper-exclusive only, but the parser tolerates variants', () => {
      expect(parseRuleRange('(2026-09-26,2026-09-27]')).toEqual({
        from: '2026-09-26',
        to: '2026-09-27',
      });
    });
  });

  describe('toOfficeRuleResponse', () => {
    it('maps the snake_case row to the API shape (HH:mm times, numeric hours, range bounds)', () => {
      expect(toOfficeRuleResponse(ruleRow({ valid: '[2026-09-26,2026-09-27)' }))).toEqual({
        id: 'rule-uuid',
        startTime: '10:00',
        endTime: '18:00',
        lateCutoffMinutes: 15,
        fullDayHours: 8,
        halfDayHours: 4,
        validFrom: '2026-09-26',
        validTo: '2026-09-27',
      });
    });

    it('maps a Postgres numeric (string) and a JS number alike to a number', () => {
      expect(toOfficeRuleResponse(ruleRow({ full_day_hours: 8, half_day_hours: '4.00' })))
        .toEqual(expect.objectContaining({ fullDayHours: 8, halfDayHours: 4 }));
    });
  });

  describe('toOfficeDetailResponse', () => {
    it('returns the office with rules sorted by validFrom ascending', () => {
      const old = ruleRow({ id: 'r2', valid: '[2026-09-20,2026-09-26)' });
      const current = ruleRow({ id: 'r3', valid: '[2026-09-26,)' });
      const oldest = ruleRow({ id: 'r1', valid: '[2026-09-10,2026-09-20)' });

      const detail = toOfficeDetailResponse(officeRow, [current, old, oldest]);

      expect(detail.rules.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
      // The input array is not mutated — a sorted copy is returned.
      expect(detail.rules[0].id).not.toBe(current.id);
      expect(detail.archivedAt).toBeNull();
      expect(detail.radiusM).toBe(200);
    });
  });

  describe('pickCurrentRule', () => {
    it('picks the rule whose range contains today (from inclusive, to exclusive)', () => {
      const clipped = ruleRow({ id: 'current', valid: '[2026-09-20,2026-09-27)' });
      expect(pickCurrentRule([ruleRow({ id: 'old', valid: '[2026-09-10,2026-09-20)' }), clipped], TODAY)?.id)
        .toBe('current');
    });

    it('picks the open-ended rule — an empty upper bound means today is inside', () => {
      const open = ruleRow({ id: 'open', valid: '[2026-09-26,)' });
      expect(pickCurrentRule([open], TODAY)?.id).toBe('open');
    });

    it('treats the upper bound as exclusive — a rule ending today is NOT current', () => {
      expect(pickCurrentRule([ruleRow({ valid: '[2026-09-20,2026-09-26)' })], TODAY)).toBeNull();
    });

    it('a rule starting today IS current (lower bound inclusive)', () => {
      expect(pickCurrentRule([ruleRow({ valid: '[2026-09-26,)' })], TODAY)?.id).toBe('rule-uuid');
    });

    it('returns null with no history', () => {
      expect(pickCurrentRule([], TODAY)).toBeNull();
    });
  });

  describe('pickNextRule', () => {
    it('picks the earliest future rule', () => {
      const tomorrow = ruleRow({ id: 'next', valid: '[2026-09-27,)' });
      const later = ruleRow({ id: 'later', valid: '[2026-10-01,)' });
      expect(pickNextRule([later, ruleRow({ id: 'past', valid: '[2026-09-01,2026-09-26)' }), tomorrow], TODAY)?.id)
        .toBe('next');
    });

    it('a rule starting today is current, not next', () => {
      expect(pickNextRule([ruleRow({ valid: '[2026-09-26,)' })], TODAY)).toBeNull();
    });

    it('returns null with no future rule — no pending edit', () => {
      expect(
        pickNextRule(
          [ruleRow({ valid: '[2026-09-01,2026-09-27)' })],
          TODAY,
        ),
      ).toBeNull();
    });
  });
});
