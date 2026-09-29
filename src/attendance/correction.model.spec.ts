import { CORRECTION_MARKER_KEYS, EMPTY_CORRECTION_VALUE, toCorrectionEntry, validateCorrectionValue } from './correction.model';

/**
 * Pure spec for the corrections audit model (18-2). Written as a tester:
 * the stored jsonb could carry anything (an old shape, a foreign write, a
 * hand-edit) — the read must render an honest entry or an empty value,
 * never crash and never trust blindly. A change to the implementation
 * (not the requirement) must not turn these red.
 */

const row = (over: Partial<Parameters<typeof toCorrectionEntry>[0]> = {}) => ({
  id: 'entry-1',
  employee_id: 'emp-1',
  work_date: '2026-09-28',
  created_at: new Date('2026-09-28T10:00:00.000Z'),
  note: 'Fixed check-in',
  old_value: { status: 'absent', checkinAt: null, checkoutAt: null },
  new_value: { status: 'present', checkinAt: null, checkoutAt: null },
  ...over,
});

describe('toCorrectionEntry — the wire shape of one history entry', () => {
  const TZ = 'Asia/Kolkata';

  // The review G2-P9 contract: correctedAt travels as AD-7 tenant-offset
  // ISO (the wall time the actor saw), never the UTC `Z` spelling — the
  // sheet would show the wrong clock time for any UTC≠tenant tenant.
  it('maps every column to the camelCase entry, correctedAt as the tenant-offset instant', () => {
    expect(toCorrectionEntry(row(), 'Owner A', TZ)).toEqual({
      id: 'entry-1',
      employeeId: 'emp-1',
      workDate: '2026-09-28',
      correctedAt: '2026-09-28T15:30:00+05:30',
      actorName: 'Owner A',
      note: 'Fixed check-in',
      oldValue: { status: 'absent', checkinAt: null, checkoutAt: null },
      newValue: { status: 'present', checkinAt: null, checkoutAt: null },
    });
  });

  it('a null actor name stays null (the actor may be gone from the tenant)', () => {
    expect(toCorrectionEntry(row(), null, TZ).actorName).toBeNull();
  });

  it('a string created_at in another offset is re-anchored to the tenant offset', () => {
    expect(
      toCorrectionEntry(row({ created_at: '2026-09-28T10:00:00+05:30' }), null, TZ).correctedAt,
    ).toBe('2026-09-28T10:00:00+05:30');
  });
});

describe('validateCorrectionValue — the untrusted jsonb gate', () => {
  it('a well-formed stored value passes through field-for-field', () => {
    const stored = { status: 'half_day', checkinAt: '2026-09-28T09:30:00+05:30', checkoutAt: null };
    expect(validateCorrectionValue(stored)).toEqual(stored);
  });

  it('a foreign/unknown status string degrades to null, not a crash', () => {
    expect(validateCorrectionValue({ status: 'on_a_break', checkinAt: null, checkoutAt: null }).status).toBeNull();
  });

  it('non-string timestamps degrade to null', () => {
    expect(
      validateCorrectionValue({ status: null, checkinAt: 123, checkoutAt: {} }),
    ).toEqual({ status: null, checkinAt: null, checkoutAt: null });
  });

  it('a stored wrong SHAPE from the other epic (array) becomes the empty value', () => {
    expect(validateCorrectionValue(['old', 'shape'])).toEqual({ ...EMPTY_CORRECTION_VALUE });
  });

  it('null, numbers and missing payloads become the empty value — a removed correction reads honest', () => {
    expect(validateCorrectionValue(null)).toEqual({ ...EMPTY_CORRECTION_VALUE });
    expect(validateCorrectionValue(undefined)).toEqual({ ...EMPTY_CORRECTION_VALUE });
    expect(validateCorrectionValue(42)).toEqual({ ...EMPTY_CORRECTION_VALUE });
  });

  it('extra keys are dropped (the wire never echoes unknown fields)', () => {
    const out = validateCorrectionValue({
      status: 'present', checkinAt: null, checkoutAt: null, actor_id: 'x', tampered: true,
    });
    expect(Object.keys(out).sort()).toEqual(['checkinAt', 'checkoutAt', 'status']);
  });

  it('every 12 status keys survive a write→read round trip by name', () => {
    for (const status of [
      'not_tracked', 'not_checked_in_yet', 'in_progress', 'weekly_off', 'holiday',
      'worked_on_holiday', 'leave', 'half_day_leave', 'present', 'half_day',
      'absent', 'checkout_missing',
    ]) {
      expect(
        validateCorrectionValue({ status, checkinAt: null, checkoutAt: null }).status,
      ).toBe(status);
    }
  });
});

describe('CORRECTION_MARKER_KEYS — the actionable-marker contract', () => {
  it('carries exactly the four marker keys (a fifth is an engine-only concept)', () => {
    expect([...CORRECTION_MARKER_KEYS]).toEqual([
      'corrected', 'leave_pending', 'checkout_missing', 'fake_location_attempt',
    ]);
  });
});

describe('EMPTY_CORRECTION_VALUE — the zero value', () => {
  it('is frozen and fully null (the removal-audit new_value)', () => {
    expect(EMPTY_CORRECTION_VALUE).toEqual({ status: null, checkinAt: null, checkoutAt: null });
    expect(Object.isFrozen(EMPTY_CORRECTION_VALUE));
  });
});
