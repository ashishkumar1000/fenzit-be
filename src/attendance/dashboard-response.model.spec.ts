import type {
  DashboardResponse,
} from './dashboard-response.model';

/**
 * Pure spec for 19-2's wire shapes. Written as a tester: the response IS a
 * wire contract — the FE 19-4 tiles read these keys verbatim, so the pin
 * freezes the serialized KEY SETS via typed fixtures (a key rename or
 * removal breaks the compile or turns these red before a live dashboard
 * shows an empty tile). A change to the implementation (not the
 * requirement) must not turn these red.
 */

const body: DashboardResponse = {
  date: '2026-09-29',
  counts: {
    tracked: 3,
    checkedIn: 1,
    notCheckedIn: 2,
    late: 1,
    onLeave: 1,
  },
  offices: [
    {
      id: 'o1',
      name: 'HQ',
      tracked: 3,
      checkedIn: 1,
    },
  ],
  flags: {
    checkoutMissing: [
      {
        employeeId: 'e1',
        employeeName: 'Asha',
        workDate: '2026-09-27',
        officeName: 'HQ',
      },
    ],
    fakeLocationAttempt: [
      {
        employeeId: 'e2',
        employeeName: 'B',
        workDate: '2026-09-29',
        officeName: null,
        attemptCount: 4,
      },
    ],
  },
};

describe('DashboardResponse — the wire key sets (D5)', () => {
  it('the dashboard body carries exactly the pinned keys at every level', () => {
    expect(Object.keys(body).sort()).toEqual(['counts', 'date', 'flags', 'offices']);
    expect(Object.keys(body.offices[0]).sort()).toEqual([
      'checkedIn',
      'id',
      'name',
      'tracked',
    ]);
    expect(Object.keys(body.counts).sort()).toEqual([
      'checkedIn',
      'late',
      'notCheckedIn',
      'onLeave',
      'tracked',
    ]);
    expect(Object.keys(body.flags).sort()).toEqual([
      'checkoutMissing',
      'fakeLocationAttempt',
    ]);
  });

  it('the flag rows carry exactly the pinned keys (no coordinate field!)', () => {
    expect(Object.keys(body.flags.checkoutMissing[0]).sort()).toEqual([
      'employeeId',
      'employeeName',
      'officeName',
      'workDate',
    ]);
    expect(Object.keys(body.flags.fakeLocationAttempt[0]).sort()).toEqual([
      'attemptCount',
      'employeeId',
      'employeeName',
      'officeName',
      'workDate',
    ]);
  });
});
