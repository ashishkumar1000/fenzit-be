import type {
  HolidayRow,
  MeMonthlyResponse,
  MonthlyResponse,
} from './monthly-response.model';

/**
 * Pure spec for 19-3's wire shapes. Written as a tester: the response IS a
 * wire contract — the FE 19-5 summary cards read these keys verbatim, and
 * `summary`'s key set is D6's tile VOCABULARY (the same nine the calendar
 * grades into), so the pin freezes the serialized KEY SETS via typed
 * fixtures before a live page reads an empty cell. A change to the
 * implementation (not the requirement) must not turn these red.
 */

const body: MonthlyResponse = {
  from: '2026-09-01',
  to: '2026-09-29',
  employees: [
    {
      employeeId: 'e1',
      employeeName: 'Asha',
      officeId: 'o1',
      officeName: 'HQ',
      summary: {
        daysWorked: 20,
        halfDays: 2,
        lateCount: 1,
        leave: 1,
        weeklyOffs: 4,
        holidays: 2,
        workedOnHoliday: 0,
        absent: 1,
        checkoutMissing: 3,
      },
    },
  ],
};

const me: MeMonthlyResponse = {
  from: '2026-09-01',
  to: '2026-09-29',
  summary: body.employees[0].summary,
  weeklyOffs: [0, 6],
  upcomingHolidays: [{ holidayDate: '2026-10-02', holidayName: 'Gandhi Jayanti' }],
};

describe('MonthlyResponse — the wire key sets (D6)', () => {
  it('the owner monthly body carries exactly the pinned keys', () => {
    expect(Object.keys(body).sort()).toEqual(['employees', 'from', 'to']);
    expect(Object.keys(body.employees[0]).sort()).toEqual([
      'employeeId',
      'employeeName',
      'officeId',
      'officeName',
      'summary',
    ]);
  });

  it('the summary carries exactly D6’s nine-tile vocabulary — shared by the me route', () => {
    expect(Object.keys(body.employees[0].summary).sort()).toEqual([
      'absent',
      'checkoutMissing',
      'daysWorked',
      'halfDays',
      'holidays',
      'lateCount',
      'leave',
      'weeklyOffs',
      'workedOnHoliday',
    ]);
    expect(Object.keys(me.summary)).toEqual(
      Object.keys(body.employees[0].summary),
    );
  });

  it('the self view adds weeklyOffs + upcomingHolidays — nothing else moves', () => {
    expect(Object.keys(me).sort()).toEqual([
      'from',
      'summary',
      'to',
      'upcomingHolidays',
      'weeklyOffs',
    ]);
    expect(Object.keys(me.upcomingHolidays[0]).sort()).toEqual([
      'holidayDate',
      'holidayName',
    ]);
  });
});
