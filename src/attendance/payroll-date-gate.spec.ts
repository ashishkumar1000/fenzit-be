import { HttpException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  assertPayrollDateEditable,
  assertPayrollDatesEditable,
  frozenPayrollDates,
  hasFrozenPayrollDate,
} from './payroll-date-gate';

/**
 * The gate freezes a date when the month that OWNS it for run purposes is
 * locked: own-month dates up to the resolved cut-off belong to the own
 * month's run, post-cut-off dates belong to the successor's run. The
 * stand-in tx routes by SQL shape (advisory call vs locks read vs calendar
 * read) so a query change in the gate fails loudly here. Ownership
 * arithmetic — including the December → January rollover — is pinned by the
 * successor-message cases, and the serialization order (shared advisory on
 * the owning month BEFORE its lock read) is pinned by the race cases. The
 * range form (23-7 follow-up — the leave write paths) shares the one
 * resolution body, so its cases pin the multi-month span, the earliest-
 * frozen-date answer, the empty-input resolve and the non-throwing probe.
 */
function tx(
  opts: {
    lockedMonths?: string[];
    calendarRows?: Array<{ effective_from: string | Date; cutoff_day: number }>;
  } = {},
): PoolClient {
  return {
    query: jest.fn((sql: string, params: unknown[]) => {
      if (sql.includes('pg_advisory_xact_lock_shared')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('payroll_month_locks')) {
        // The unified lock read passes the candidate owners as an array.
        const asked = params?.[1];
        const months = Array.isArray(asked)
          ? asked.map(String)
          : [String(asked)];
        const hits = (opts.lockedMonths ?? []).filter((m) =>
          months.includes(m),
        );
        return Promise.resolve({ rows: hits.map((month) => ({ month })) });
      }
      // payroll_calendar
      return Promise.resolve({ rows: opts.calendarRows ?? [] });
    }),
  } as unknown as PoolClient;
}

type Calls = Array<[string, unknown[]]>;

function callsOf(client: PoolClient): Calls {
  return (client.query as jest.Mock).mock.calls as Calls;
}

function advisoryIndex(calls: Calls): number {
  return calls.findIndex((c) => c[0].includes('pg_advisory_xact_lock_shared'));
}

function lockReadIndex(calls: Calls): number {
  return calls.findIndex((c) => c[0].includes('payroll_month_locks'));
}

async function refused(
  promise: Promise<void>,
): Promise<Record<string, unknown>> {
  try {
    await promise;
    throw new Error('expected the gate to refuse the date');
  } catch (e) {
    const http = e as HttpException;
    expect(http.getStatus()).toBe(409);
    return http.getResponse() as Record<string, unknown>;
  }
}

describe('assertPayrollDateEditable — the payroll-lock date gate (23-7)', () => {
  it('lets any date through when no month is locked — calendar, advisory, one owner-scoped lock read', async () => {
    const client = tx();
    await expect(
      assertPayrollDateEditable(client, 'tenant-A', '2026-10-20'),
    ).resolves.toBeUndefined();
    const calls = callsOf(client);
    expect(calls).toHaveLength(3);
    expect(
      calls.find((c) => c[0].includes('payroll_month_locks'))?.[1]?.[1],
    ).toEqual(['2026-10']);
    expect(advisoryIndex(calls)).toBeLessThan(lockReadIndex(calls));
  });

  it('refuses a pre-cut-off date of a locked own month, naming the boundary', async () => {
    const err = await refused(
      assertPayrollDateEditable(
        tx({ lockedMonths: ['2026-10'] }),
        'tenant-A',
        '2026-10-20',
      ),
    );
    expect(err.error_code).toBe('PAYROLL_MONTH_LOCKED');
    expect(String(err.message)).toContain('2026-10 is locked');
    expect(String(err.message)).toContain('day-25');
  });

  it('the cut-off date itself is frozen too', async () => {
    await expect(
      refused(
        assertPayrollDateEditable(
          tx({ lockedMonths: ['2026-10'] }),
          'tenant-A',
          '2026-10-25',
        ),
      ),
    ).resolves.toBeDefined();
  });

  it('a dated calendar revision moves the boundary (cutoff 20 → the 21st is free)', async () => {
    const client = tx({
      lockedMonths: ['2026-10'],
      calendarRows: [{ effective_from: '2026-10-01', cutoff_day: 20 }],
    });
    await expect(
      assertPayrollDateEditable(client, 'tenant-A', '2026-10-21'),
    ).resolves.toBeUndefined();
  });

  it('tolerates a driver handing effective_from back as a Date, not text', async () => {
    const client = tx({
      lockedMonths: ['2026-10'],
      calendarRows: [
        { effective_from: new Date(Date.UTC(2026, 9, 1)), cutoff_day: 20 },
      ],
    });
    // Cutoff 20 → the 25th is post-cut-off, November unlocked → editable.
    await expect(
      assertPayrollDateEditable(client, 'tenant-A', '2026-10-25'),
    ).resolves.toBeUndefined();
  });

  it('a post-cut-off date stays editable while only the own month is locked', async () => {
    await expect(
      assertPayrollDateEditable(
        tx({ lockedMonths: ['2026-10'] }),
        'tenant-A',
        '2026-10-27',
      ),
    ).resolves.toBeUndefined();
  });

  it('a post-cut-off date freezes once the successor month locks — it owns it', async () => {
    const err = await refused(
      assertPayrollDateEditable(
        tx({ lockedMonths: ['2026-11'] }),
        'tenant-A',
        '2026-10-27',
      ),
    );
    expect(err.error_code).toBe('PAYROLL_MONTH_LOCKED');
    expect(String(err.message)).toContain(
      '2026-11 is locked for payroll and owns 2026-10-27',
    );
  });

  it('both months locked: a pre-cut-off date answers with the own month', async () => {
    const err = await refused(
      assertPayrollDateEditable(
        tx({ lockedMonths: ['2026-10', '2026-11'] }),
        'tenant-A',
        '2026-10-05',
      ),
    );
    expect(String(err.message)).toContain('2026-10 is locked');
  });

  it('the December → January rollover keeps ownership arithmetic true', async () => {
    const err = await refused(
      assertPayrollDateEditable(
        tx({ lockedMonths: ['2027-01'] }),
        'tenant-A',
        '2026-12-26',
      ),
    );
    expect(String(err.message)).toContain(
      '2027-01 is locked for payroll and owns 2026-12-26',
    );
  });

  it('the shared advisory names the OWNING month — successor for a post-cut-off date', async () => {
    const client = tx({ lockedMonths: ['2026-10'] });
    await expect(
      assertPayrollDateEditable(client, 'tenant-A', '2026-10-27'),
    ).resolves.toBeUndefined();
    const calls = callsOf(client);
    const advisory = calls[advisoryIndex(calls)];
    expect(String(advisory?.[1]?.[0])).toBe('payroll-run:tenant-A:2026-11');
  });

  it('a January date resolves its owner past the rollover, not a phantom successor', async () => {
    const client = tx({});
    await expect(
      assertPayrollDateEditable(client, 'tenant-A', '2026-01-27'),
    ).resolves.toBeUndefined();
    const calls = callsOf(client);
    // Jan 27 is post-cutoff-25 → owned by February's run.
    expect(
      calls.find((c) => c[0].includes('payroll_month_locks'))?.[1]?.[1],
    ).toEqual(['2026-02']);
  });
});

describe('assertPayrollDatesEditable — the range form (the leave write paths, 23-7 follow-up)', () => {
  it('resolves an empty input with zero queries — nothing to freeze-check', async () => {
    const client = tx({ lockedMonths: ['2026-10'] });
    await expect(
      assertPayrollDatesEditable(client, 'tenant-A', []),
    ).resolves.toBeUndefined();
    expect(callsOf(client)).toHaveLength(0);
  });

  it('lets a whole unlocked range through with one calendar read and one lock read for its distinct owners', async () => {
    const client = tx({});
    await expect(
      assertPayrollDatesEditable(client, 'tenant-A', [
        '2026-10-20',
        '2026-10-27',
        '2026-11-05',
      ]),
    ).resolves.toBeUndefined();
    const calls = callsOf(client);
    // Owners: Oct 20 → Oct (pre-cutoff); Oct 27 and Nov 5 → Nov (post-cutoff
    // and own-month).
    expect(
      calls.find((c) => c[0].includes('payroll_month_locks'))?.[1]?.[1],
    ).toEqual(['2026-10', '2026-11']);
    expect(calls.filter((c) => c[0].includes('payroll_calendar'))).toHaveLength(
      1,
    );
  });

  it('refuses the WHOLE range when one date is frozen, naming the earliest frozen date', async () => {
    const err = await refused(
      assertPayrollDatesEditable(
        tx({ lockedMonths: ['2026-10'] }),
        'tenant-A',
        ['2026-10-20', '2026-11-05'],
      ),
    );
    expect(err.error_code).toBe('PAYROLL_MONTH_LOCKED');
    expect(String(err.message)).toContain('2026-10 is locked');
    expect(String(err.message)).toContain('2026-10-20');
  });

  it('a range spanning the cut-off answers with the successor-owned copy', async () => {
    const err = await refused(
      assertPayrollDatesEditable(
        tx({ lockedMonths: ['2026-11'] }),
        'tenant-A',
        ['2026-10-24', '2026-10-27'],
      ),
    );
    expect(String(err.message)).toContain(
      '2026-11 is locked for payroll and owns 2026-10-27',
    );
  });

  it('serializes the distinct owner months with shared advisory keys before the lock read', async () => {
    const client = tx({ lockedMonths: [] });
    await expect(
      assertPayrollDatesEditable(client, 'tenant-A', [
        '2026-10-20',
        '2026-10-27',
      ]),
    ).resolves.toBeUndefined();
    const calls = callsOf(client);
    const advisoryKeys = calls
      .filter((c) => c[0].includes('pg_advisory_xact_lock_shared'))
      .map((c) => String(c[1]?.[0]));
    // Oct 20 is owned by Oct, Oct 27 by Nov — BOTH owners serialize (the
    // order is incidental: shared locks never conflict, so pin the set, not
    // the sequence).
    expect([...advisoryKeys].sort()).toEqual([
      'payroll-run:tenant-A:2026-10',
      'payroll-run:tenant-A:2026-11',
    ]);
    expect(advisoryKeys).toHaveLength(2); // one call per distinct owner
    expect(advisoryIndex(calls)).toBeLessThan(lockReadIndex(calls));
  });

  it('the probe answers true/false without throwing — the auto-cancel skip reads it', async () => {
    await expect(
      hasFrozenPayrollDate(tx({ lockedMonths: ['2026-10'] }), 'tenant-A', [
        '2026-10-20',
      ]),
    ).resolves.toBe(true);
    await expect(
      hasFrozenPayrollDate(tx({}), 'tenant-A', ['2026-10-20']),
    ).resolves.toBe(false);
    await expect(
      hasFrozenPayrollDate(tx({ lockedMonths: ['2026-10'] }), 'tenant-A', []),
    ).resolves.toBe(false);
  });

  it('frozenPayrollDates returns the FULL frozen subset — the disable sweep carves its write around it', async () => {
    await expect(
      frozenPayrollDates(
        tx({ lockedMonths: ['2026-10'] }),
        'tenant-A',
        // 10-24 is October-owned (frozen); 10-27 is November-owned (free);
        // 11-05 is November-owned (free).
        ['2026-10-24', '2026-10-27', '2026-11-05'],
      ),
    ).resolves.toEqual(new Set(['2026-10-24']));
    await expect(
      frozenPayrollDates(tx({}), 'tenant-A', ['2026-10-24']),
    ).resolves.toEqual(new Set());
    await expect(
      frozenPayrollDates(
        tx({ lockedMonths: ['2026-10', '2026-11'] }),
        'tenant-A',
        ['2026-10-24', '2026-11-05'],
      ),
    ).resolves.toEqual(new Set(['2026-10-24', '2026-11-05']));
  });
});
