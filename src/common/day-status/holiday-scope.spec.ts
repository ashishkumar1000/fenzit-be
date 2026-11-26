import { holidayAppliesToOffice, observedHolidaysByDate } from './holiday-scope';

/**
 * The pure applicability rule — the same verdicts the SQL fan-out (the
 * notification recipients), the day-status engine and the leave span facts
 * all inherit. The review's verification-gap round pins them here so a
 * drift shows up as a unit failure, not a live behaviour change.
 */

const ALL = { scope: 'all', officeIds: [] };
const BRANCH = { scope: 'offices', officeIds: ['office-a'] };

describe('holidayAppliesToOffice', () => {
  it('an all-scope holiday closes every office — and the office-less', () => {
    expect(holidayAppliesToOffice(ALL, 'office-a')).toBe(true);
    expect(holidayAppliesToOffice(ALL, 'office-b')).toBe(true);
    expect(holidayAppliesToOffice(ALL, null)).toBe(true);
    expect(holidayAppliesToOffice(ALL, undefined)).toBe(true);
  });

  it('an offices-scope holiday closes only the offices it names', () => {
    expect(holidayAppliesToOffice(BRANCH, 'office-a')).toBe(true);
    expect(holidayAppliesToOffice(BRANCH, 'office-b')).toBe(false);
  });

  it('an office-less employee never inherits an offices-scope closure', () => {
    expect(holidayAppliesToOffice(BRANCH, null)).toBe(false);
    expect(holidayAppliesToOffice(BRANCH, undefined)).toBe(false);
  });

  it('no holiday closes nothing', () => {
    expect(holidayAppliesToOffice(null, 'office-a')).toBe(false);
    expect(holidayAppliesToOffice(undefined, 'office-a')).toBe(false);
  });
});

describe('observedHolidaysByDate', () => {
  const holidays = [
    { name: 'Republic Day', scope: 'all', officeIds: [], holidayDate: '2027-01-26' },
    { name: 'Founders Day', scope: 'offices', officeIds: ['office-a'], holidayDate: '2027-03-05' },
  ];

  it('an office-less employee observes only the all-scope holidays', () => {
    const observed = observedHolidaysByDate(holidays, []);
    expect(observed.size).toBe(1);
    expect(observed.get('2027-01-26')?.name).toBe('Republic Day');
    expect(observed.has('2027-03-05')).toBe(false);
  });

  it('the covering assignment decides the offices-scope verdict', () => {
    const covered = observedHolidaysByDate(holidays, [
      { officeId: 'office-a', valid: '[2026-01-01,)' },
    ]);
    expect(covered.get('2027-03-05')?.name).toBe('Founders Day');

    const coveredElsewhere = observedHolidaysByDate(holidays, [
      { officeId: 'office-b', valid: '[2026-01-01,)' },
    ]);
    expect(coveredElsewhere.has('2027-03-05')).toBe(false);
  });

  it('an assignment must cover the holiday DATE to count as covering', () => {
    const lapsed = observedHolidaysByDate(holidays, [
      { officeId: 'office-a', valid: '[2026-01-01,2027-02-01)' },
    ]);
    // Covers Jan 26 but not Mar 5 — the offices holiday drops out.
    expect(lapsed.get('2027-01-26')?.name).toBe('Republic Day');
    expect(lapsed.has('2027-03-05')).toBe(false);
  });

  it('one verdict per DATE — two holidays on a date collapse to the last', () => {
    const observed = observedHolidaysByDate(
      [
        ...holidays,
        { name: 'Extra', scope: 'all', officeIds: [], holidayDate: '2027-01-26' },
      ],
      [],
    );
    expect(observed.get('2027-01-26')?.name).toBe('Extra');
  });
});
