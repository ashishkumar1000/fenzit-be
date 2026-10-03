import { BadRequestException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ErrorCode } from '../../common/enums/error-code.enum';
import type { ReportFetchContext } from './report-definition';
import { fetchAttendanceReportData } from './attendance.data';

/**
 * Spec for 21-2's attendance fetcher. The pg transaction client is stubbed
 * at the SQL level (routing on the same substrings the grid reader sends)
 * so the REAL readDayStatusGrid runs — the spec exercises the whole
 * read → assemble → aggregate pipeline, not a mock of the grid. The
 * Supabase side (names, enrolments, attempts) is a per-table chain stub.
 *
 * Scope semantics pinned here: per-day office filtering, explicit
 * zero-day employees keep their row, the roster arm drops them, the
 * oversize guard fires before any grid read, and the register renders
 * only for ranges ≤ 31 days.
 */

const TENANT = '00000000-0000-4000-8000-000000000001';
const E1 = '00000000-0000-4000-8000-0000000000e1';
const E2 = '00000000-0000-4000-8000-0000000000e2';
const OFFICE_1 = '00000000-0000-4000-8000-00000000ff01';
const OFFICE_2 = '00000000-0000-4000-8000-00000000ff02';
const RULE = '00000000-0000-4000-8000-00000000ru01';

const NAMES: Record<string, string> = {
  [E1]: 'Asha',
  [E2]: 'Bimal',
};

type PgRow = Record<string, unknown>;

/** Routes the grid reader's statements by substring to fixture rows. */
function pgStub(fixtures: {
  records?: PgRow[];
  assignments?: PgRow[];
  enrolments?: PgRow[];
  mockedAttempts?: PgRow[];
}) {
  const queries: string[] = [];
  return {
    queries,
    client: {
      query: jest.fn(async (text: string, values?: unknown[]) => {
        queries.push(text);
        // Real Postgres returns nothing for `= ANY('{}')` — honour the
        // employee-ids array param so fixtures never leak across a scope.
        // Prophylactic, not load-bearing: the grid reader already
        // materialises rows only for the requested employees. (QA bug
        // bash 2026-10-03.)
        const scopeIds = new Set<string>();
        let scoped = false;
        for (const v of values ?? []) {
          if (Array.isArray(v)) {
            scoped = true;
            for (const id of v) scopeIds.add(String(id));
          }
        }
        const inScope = (rows: PgRow[]): PgRow[] =>
          scoped
            ? rows.filter(
                (r) =>
                  typeof r.employee_id !== 'string' ||
                  scopeIds.has(r.employee_id),
              )
            : rows;
        const rows: PgRow[] = (() => {
          if (text.includes('attendance_today')) return [{ today: '2026-09-29' }];
          if (text.includes('from public.tenants')) return [{ timezone: 'Asia/Kolkata' }];
          if (text.includes('attendance_settings'))
            return [{ enabled: true, setup_completed_at: new Date() }];
          if (text.includes('attendance_enrolments'))
            return fixtures.enrolments ?? [
              { employee_id: E1, valid: '[2026-09-01,)', enabled_at: new Date('2026-09-01T05:00:00Z') },
              { employee_id: E2, valid: '[2026-09-01,)', enabled_at: new Date('2026-09-01T05:00:00Z') },
            ];
          if (text.includes('attendance_office_assignments'))
            return fixtures.assignments ?? [
              { employee_id: E1, office_id: OFFICE_1, valid: '[2026-09-01,)', office_name: 'HQ', office_lat: 12.9, office_lng: 77.5, radius_m: 100 },
              { employee_id: E2, office_id: OFFICE_1, valid: '[2026-09-01,2026-09-26)', office_name: 'HQ', office_lat: 12.9, office_lng: 77.5, radius_m: 100 },
              { employee_id: E2, office_id: OFFICE_2, valid: '[2026-09-26,)', office_name: 'Branch', office_lat: 13.0, office_lng: 77.6, radius_m: 100 },
            ];
          if (text.includes('attendance_weekly_off_overrides')) return [];
          if (text.includes('attendance_weekly_off_defaults'))
            return [{ valid: '[2026-09-01,)', days: [] }];
          if (text.includes('holidays')) return [];
          if (text.includes('attendance_office_rules'))
            return [
              { office_id: OFFICE_1, id: RULE, valid: '[2026-09-01,)', start_time: '09:30:00', end_time: '18:30:00', late_cutoff_minutes: 15, full_day_hours: 8, half_day_hours: 4 },
              { office_id: OFFICE_2, id: RULE, valid: '[2026-09-01,)', start_time: '09:30:00', end_time: '18:30:00', late_cutoff_minutes: 15, full_day_hours: 8, half_day_hours: 4 },
            ];
          if (text.includes('attendance_records')) return fixtures.records ?? [];
          if (text.includes("outcome = 'mocked'")) return fixtures.mockedAttempts ?? [];
          if (text.includes('leave_request_days')) return [];
          if (text.includes('attendance_day_overrides')) return [];
          if (text.includes('attendance_corrections')) return [];
          throw new Error(`pg stub: unhandled statement: ${text.slice(0, 60)}`);
        })();
        const visible = inScope(rows);
        return { rows: visible, rowCount: visible.length };
      }),
    } as unknown as PoolClient,
  };
}

/** Per-table supabase chain stub: every method chains, every await resolves.
 *  Every chained call is RECORDED so the specs can pin the query shapes
 *  (the 21-2 review's verification gap): filters, windows, ordering. */
function supabaseStub(tables: Record<string, PgRow[]>) {
  const seen: Record<string, number> = {};
  const calls: Record<string, unknown[][]> = {};
  return {
    seen,
    calls,
    client: {
      from: jest.fn((table: string) => {
        const qb: Record<string, unknown> = {};
        calls[table] = calls[table] ?? [];
        for (const method of [
          'select', 'eq', 'filter', 'in', 'neq', 'gte', 'lt', 'order', 'range', 'single',
        ]) {
          qb[method] = jest.fn((...args: unknown[]) => {
            calls[table].push([method, ...args]);
            return qb;
          });
        }
        qb.then = (
          resolve: (v: { data: unknown; error: null }) => void,
        ) => {
          seen[table] = (seen[table] ?? 0) + 1;
          // `.single()` unwraps to the first row; list terminals keep the array.
          const rows = tables[table] ?? [];
          resolve({
            data: tables[table] === undefined ? [] : rows,
            error: null,
          });
          // single() is just a marker method — the unwrap happens here by
          // checking whether the caller ended the chain with it.
          return Promise.resolve();
        };
        qb.single = jest.fn(() => ({
          then: (resolve: (v: { data: unknown; error: null }) => void) => {
            seen[table] = (seen[table] ?? 0) + 1;
            const rows = tables[table] ?? [];
            resolve({ data: rows[0] ?? null, error: null });
            return Promise.resolve();
          },
        }));
        return qb;
      }),
    } as unknown as ReportFetchContext['supabase'],
  };
}

function makeCtx(over: {
  params?: Partial<ReportFetchContext['params']>;
  maxRows?: number;
  supabase: ReportFetchContext['supabase'];
  pg: PoolClient;
}): ReportFetchContext {
  return {
    supabase: over.supabase,
    pg: over.pg,
    tenantId: TENANT,
    requestId: 'req-uuid',
    params: {
      start_date: '2026-09-25',
      end_date: '2026-09-27',
      technician_ids: [],
      office_ids: [],
      ...over.params,
    },
    maxJobs: 5000,
    maxRows: over.maxRows ?? 25_000,
  };
}

/** The default 3-day fixture: Asha works 25 (full), absent 26, half 27. */
function baseFixtures(): Parameters<typeof pgStub>[0] {
  const instant = (date: string, time: string) =>
    new Date(`${date}T${time}:00+05:30`).toISOString();
  return {
    records: [
      { employee_id: E1, work_date: '2026-09-25', checkin_at: instant('2026-09-25', '09:30'), checkout_at: instant('2026-09-25', '18:30') },
      { employee_id: E1, work_date: '2026-09-27', checkin_at: instant('2026-09-27', '09:30'), checkout_at: instant('2026-09-27', '13:30') },
      { employee_id: E2, work_date: '2026-09-25', checkin_at: instant('2026-09-25', '09:30'), checkout_at: instant('2026-09-25', '18:30') },
    ],
  };
}

describe('fetchAttendanceReportData (21-2)', () => {
  it('aggregates the grid through the shared reader: summaries, offices, register, names', async () => {
    const pg = pgStub(baseFixtures());
    const supa = supabaseStub({
      tenants: [{ company_name: 'Acme Services' }],
      users: Object.entries(NAMES).map(([id, name]) => ({ id, name })),
      attendance_enrolments: [{ employee_id: E1 }, { employee_id: E2 }],
      attendance_attempts: [
        { employee_id: E1, outcome: 'mocked' },
        { employee_id: E1, outcome: 'too_far' },
        { employee_id: E2, outcome: 'stale_fix' },
      ],
    });

    const data = await fetchAttendanceReportData(
      makeCtx({ supabase: supa.client, pg: pg.client }),
    );

    expect(data.tenant.companyName).toBe('Acme Services');
    expect(data.overall.daysWorked).toBe(2.5);
    // 6 grid rows: Asha P/A/H + Bimal P/A/A → 3 rule-9 absents across both offices.
    expect(data.overall.absent).toBe(3);

    // Employees: alphabetical, names resolved, mid-range attribution.
    expect(data.employees.map((e) => e.name)).toEqual(['Asha', 'Bimal']);
    const asha = data.employees[0];
    expect(asha.summary.daysWorked).toBe(1.5);
    expect(asha.summary.absent).toBe(1);
    expect(asha.offices).toBe('HQ');
    expect(asha.enrolledFrom).toBeNull(); // tracked from the first day

    // Office table: per-day attribution — Bimal's absents on 26/27 sit at
    // Branch (the covering assignment moved), HQ keeps both employees.
    expect(data.offices.map((o) => o.name)).toEqual(['Branch', 'HQ']);
    const hq = data.offices.find((o) => o.name === 'HQ')!;
    expect(hq.employees).toBe(2);
    expect(hq.summary.daysWorked).toBe(2.5);
    const branch = data.offices.find((o) => o.name === 'Branch')!;
    expect(branch.employees).toBe(1);
    expect(branch.summary.absent).toBe(2);
    expect(branch.summary.daysWorked).toBe(0);

    // Register: 3 days ≤ 31 → rendered, codes from the engine outcomes.
    expect(data.scope.registerDays).toBe(3);
    expect(data.register?.dates).toHaveLength(3);
    expect(data.register?.rows[0]).toEqual({ name: 'Asha', codes: ['P', 'A', 'H'] });

    // Rejections bucketed per employee; 'ok' never appears, unknown outcomes
    // land in "other".
    expect(data.rejections).toHaveLength(2);
    const ashaRej = data.rejections.find((r) => r.employeeName === 'Asha')!;
    expect(ashaRej.mocked).toBe(1);
    expect(ashaRej.tooFar).toBe(1);
    const bimalRej = data.rejections.find((r) => r.employeeName === 'Bimal')!;
    expect(bimalRej.other).toBe(1);
  });

  it('scopes per day by office: only rows attributed to the selected offices survive', async () => {
    const pg = pgStub(baseFixtures());
    const supa = supabaseStub({
      tenants: [{ company_name: 'Acme' }],
      users: Object.entries(NAMES).map(([id, name]) => ({ id, name })),
      attendance_enrolments: [{ employee_id: E1 }, { employee_id: E2 }],
      attendance_attempts: [],
    });

    const data = await fetchAttendanceReportData(
      makeCtx({
        supabase: supa.client,
        pg: pg.client,
        params: { office_ids: [OFFICE_2] },
      }),
    );

    expect(data.scope.allOffices).toBe(false);
    expect(data.scope.employeesInScope).toBe(1);
    expect(data.employees.map((e) => e.name)).toEqual(['Bimal']);
    expect(data.employees[0].summary.absent).toBe(2);
    expect(data.offices.map((o) => o.name)).toEqual(['Branch']);
    expect(data.overall.absent).toBe(2);
  });

  it('explicitly selected employees keep a zero-day row ("—" scope) in office-filtered reports', async () => {
    const pg = pgStub(baseFixtures());
    const supa = supabaseStub({
      tenants: [{ company_name: 'Acme' }],
      users: Object.entries(NAMES).map(([id, name]) => ({ id, name })),
      attendance_enrolments: [{ employee_id: E1 }, { employee_id: E2 }],
      attendance_attempts: [],
    });

    const data = await fetchAttendanceReportData(
      makeCtx({
        supabase: supa.client,
        pg: pg.client,
        params: { technician_ids: [E1, E2], office_ids: [OFFICE_2] },
      }),
    );

    expect(data.employees.map((e) => e.name)).toEqual(['Asha', 'Bimal']);
    const asha = data.employees[0];
    expect(asha.summary.expectedDays).toBe(0);
    expect(asha.summary.attendanceRate).toBeNull();
    expect(asha.offices).toBe('—');
  });

  it('the roster arm resolves enrolled employees via the range-overlap filter', async () => {
    const pg = pgStub(baseFixtures());
    const supa = supabaseStub({
      tenants: [{ company_name: 'Acme' }],
      users: Object.entries(NAMES).map(([id, name]) => ({ id, name })),
      attendance_enrolments: [
        { employee_id: E1 },
        { employee_id: E2 },
      ],
      attendance_attempts: [],
    });

    const data = await fetchAttendanceReportData(
      makeCtx({ supabase: supa.client, pg: pg.client }),
    );

    expect(supa.client.from).toHaveBeenCalledWith('attendance_enrolments');
    expect(data.scope.allEmployees).toBe(true);
    expect(data.employees).toHaveLength(2);
  });

  it('fails report_too_large before any grid read when employee-days exceed maxRows', async () => {
    const pg = pgStub(baseFixtures());
    const supa = supabaseStub({
      tenants: [{ company_name: 'Acme' }],
      users: Object.entries(NAMES).map(([id, name]) => ({ id, name })),
      attendance_enrolments: [{ employee_id: E1 }, { employee_id: E2 }],
      attendance_attempts: [],
    });

    await expect(
      fetchAttendanceReportData(
        makeCtx({ supabase: supa.client, pg: pg.client, maxRows: 5 }), // 2 × 3 = 6 > 5
      ),
    ).rejects.toMatchObject({
      response: { error_code: ErrorCode.REPORT_TOO_LARGE },
    });
    // The guard ran before the grid: the reader never issued its reads.
    expect(pg.queries.some((q) => q.includes('attendance_records'))).toBe(false);
  });

  it('skips the day register for ranges over 31 days (92-column portrait is unreadable)', async () => {
    const pg = pgStub({ ...baseFixtures(), records: [] });
    const supa = supabaseStub({
      tenants: [{ company_name: 'Acme' }],
      users: Object.entries(NAMES).map(([id, name]) => ({ id, name })),
      attendance_enrolments: [{ employee_id: E1 }, { employee_id: E2 }],
      attendance_attempts: [],
    });

    const data = await fetchAttendanceReportData(
      makeCtx({
        supabase: supa.client,
        pg: pg.client,
        params: { start_date: '2026-09-01', end_date: '2026-10-02' }, // 32 days
      }),
    );

    expect(data.scope.registerDays).toBeNull();
    expect(data.register).toBeNull();
    expect(data.weeks.length).toBeGreaterThan(4);
  });

  it('mid-period joiners get the enrolledFrom annotation from their first tracked day', async () => {
    const fixtures = baseFixtures();
    // Asha's only tracked day is the 27th — inside the range.
    fixtures.records = [
      { employee_id: E1, work_date: '2026-09-27', checkin_at: new Date('2026-09-27T09:30:00+05:30').toISOString(), checkout_at: new Date('2026-09-27T18:30:00+05:30').toISOString() },
    ];
    // The ENROLMENT starts on the 27th — before that the grid rows are
    // untracked, so the first TRACKED day is the mid-period join date.
    fixtures.enrolments = [
      { employee_id: E1, valid: '[2026-09-27,)', enabled_at: new Date('2026-09-27T05:00:00Z') },
      { employee_id: E2, valid: '[2026-09-01,)', enabled_at: new Date('2026-09-01T05:00:00Z') },
    ];
    const pg = pgStub(fixtures);
    const supa = supabaseStub({
      tenants: [{ company_name: 'Acme' }],
      users: Object.entries(NAMES).map(([id, name]) => ({ id, name })),
      attendance_enrolments: [{ employee_id: E1 }, { employee_id: E2 }],
      attendance_attempts: [],
    });

    const data = await fetchAttendanceReportData(
      makeCtx({
        supabase: supa.client,
        pg: pg.client,
        params: { start_date: '2026-09-25', end_date: '2026-09-27' },
      }),
    );

    const asha = data.employees.find((e) => e.name === 'Asha')!;
    expect(asha.enrolledFrom).toBe('2026-09-27');
  });
});

describe('query shapes (21-2 review gap) — the Supabase reads are pinned', () => {
  it('the roster arm range-overlaps the enrolment on the report window', async () => {
    const pg = pgStub(baseFixtures());
    const supa = supabaseStub({
      tenants: [{ company_name: 'Acme' }],
      users: Object.entries(NAMES).map(([id, name]) => ({ id, name })),
      attendance_enrolments: [{ employee_id: E1 }, { employee_id: E2 }],
      attendance_attempts: [],
    });

    await fetchAttendanceReportData(
      makeCtx({
        supabase: supa.client,
        pg: pg.client,
        params: { start_date: '2026-09-25', end_date: '2026-09-27' },
      }),
    );

    const enrolCalls = supa.calls['attendance_enrolments'];
    expect(enrolCalls).toContainEqual([
      'filter', 'valid', 'ov', '[2026-09-25,2026-09-27]',
    ]);
    expect(enrolCalls).toContainEqual(['order', 'id']);
  });

  it('the rejection audit excludes ok attempts and bounds the IST window', async () => {
    const pg = pgStub(baseFixtures());
    const supa = supabaseStub({
      tenants: [{ company_name: 'Acme' }],
      users: Object.entries(NAMES).map(([id, name]) => ({ id, name })),
      attendance_enrolments: [{ employee_id: E1 }, { employee_id: E2 }],
      attendance_attempts: [],
    });

    await fetchAttendanceReportData(
      makeCtx({
        supabase: supa.client,
        pg: pg.client,
        params: { start_date: '2026-09-25', end_date: '2026-09-27' },
      }),
    );

    const attemptCalls = supa.calls['attendance_attempts'];
    expect(attemptCalls).toContainEqual(['neq', 'outcome', 'ok']);
    // 2026-09-25T00:00 IST = 2026-09-24T18:30Z; 2026-09-28T00:00 IST exclusive.
    expect(attemptCalls).toContainEqual([
      'gte', 'attempted_at', '2026-09-24T18:30:00.000Z',
    ]);
    expect(attemptCalls).toContainEqual([
      'lt', 'attempted_at', '2026-09-27T18:30:00.000Z',
    ]);
    expect(attemptCalls).toContainEqual(['order', 'id']);
  });

  it('an office-scoped report audits rejections for in-scope employees only (triage)', async () => {
    const pg = pgStub(baseFixtures());
    const supa = supabaseStub({
      tenants: [{ company_name: 'Acme' }],
      users: Object.entries(NAMES).map(([id, name]) => ({ id, name })),
      attendance_enrolments: [{ employee_id: E1 }, { employee_id: E2 }],
      // The stub ignores .in filters, so the fixture models what PostgREST
      // would return for the pinned .in('employee_id', [E2]) probe: only
      // the in-scope employee's attempts come back.
      attendance_attempts: [{ employee_id: E2, outcome: 'mocked' }],
    });

    const data = await fetchAttendanceReportData(
      makeCtx({
        supabase: supa.client,
        pg: pg.client,
        params: { office_ids: [OFFICE_2] }, // only Bimal's 26/27 absents sit here
      }),
    );

    // Asha has no in-scope rows under Branch — her attempts must not surface.
    // The stub ignores .in filters by design, so pin the probe's shape:
    // the audit queries ONLY the in-scope employee (Bimal).
    expect(supa.calls['attendance_attempts']).toContainEqual([
      'in', 'employee_id', [E2],
    ]);
    expect(data.rejections.map((r) => r.employeeName)).toEqual(['Bimal']);
  });
});

describe('QA deep-probe corners (bug bash 2026-10-03)', () => {
  it('an empty roster renders the honest empty shape end-to-end', async () => {
    // The real grid reader runs with employeeIds = [] — PostgREST would
    // return nothing for `= ANY('{}')`, and the stub now honours that.
    const pg = pgStub(baseFixtures());
    const supa = supabaseStub({
      tenants: [{ company_name: 'Acme' }],
      users: [],
      attendance_enrolments: [],
      attendance_attempts: [],
    });

    const data = await fetchAttendanceReportData(
      makeCtx({ supabase: supa.client, pg: pg.client }),
    );

    expect(data.employees).toEqual([]);
    expect(data.offices).toEqual([]);
    expect(data.exceptions).toEqual([]);
    expect(data.rejections).toEqual([]);
    expect(data.scope.employeesInScope).toBe(0);
    expect(data.overall.expectedDays).toBe(0);
    expect(data.overall.attendanceRate).toBeNull();
    expect(data.register?.rows).toEqual([]);
    expect(data.register?.dates).toHaveLength(3);
  });

  it('the oversize guard admits exactly maxRows employee-days (boundary)', async () => {
    // 125 days × 200 employees = 25,000 == maxRows → the read proceeds.
    const twoHundred = Array.from(
      { length: 200 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const pg = pgStub(baseFixtures());
    const supa = supabaseStub({
      tenants: [{ company_name: 'Acme' }],
      users: [],
      attendance_enrolments: [],
      attendance_attempts: [],
    });

    const data = await fetchAttendanceReportData(
      makeCtx({
        supabase: supa.client,
        pg: pg.client,
        maxRows: 25_000,
        params: {
          start_date: '2026-01-01',
          end_date: '2026-05-05',
          technician_ids: twoHundred,
        },
      }),
    );
    expect(pg.queries.some((q) => q.includes('attendance_records'))).toBe(true);
    expect(data.employees).toHaveLength(200); // explicit zero-day rows

    // One employee-day over the boundary → refused BEFORE any grid read.
    const pg2 = pgStub(baseFixtures());
    const supa2 = supabaseStub({
      tenants: [{ company_name: 'Acme' }],
      users: [],
      attendance_enrolments: [],
      attendance_attempts: [],
    });
    await expect(
      fetchAttendanceReportData(
        makeCtx({
          supabase: supa2.client,
          pg: pg2.client,
          maxRows: 24_999,
          params: {
            start_date: '2026-01-01',
            end_date: '2026-05-05',
            technician_ids: twoHundred,
          },
        }),
      ),
    ).rejects.toMatchObject({
      response: { error_code: ErrorCode.REPORT_TOO_LARGE },
    });
    expect(pg2.queries.some((q) => q.includes('attendance_records'))).toBe(
      false,
    );
  });

  it('weekly trend chunks run MONDAY-start, not from the range’s own weekday', async () => {
    // 1 Sep 2026 is a TUESDAY — the first chunk must close on Sunday 6 Sep
    // (the Indian business week), not run Tue–Mon.
    const pg = pgStub({ ...baseFixtures(), records: [] });
    const supa = supabaseStub({
      tenants: [{ company_name: 'Acme' }],
      users: Object.entries(NAMES).map(([id, name]) => ({ id, name })),
      attendance_enrolments: [{ employee_id: E1 }, { employee_id: E2 }],
      attendance_attempts: [],
    });

    const data = await fetchAttendanceReportData(
      makeCtx({
        supabase: supa.client,
        pg: pg.client,
        params: { start_date: '2026-09-01', end_date: '2026-09-30' },
      }),
    );

    // The label is the user-visible surface: Tue-start range closes its
    // first chunk on Sunday.
    expect(data.weeks[0].label).toBe('1 Sep – 6 Sep');
    expect(data.weeks[1].label).toBe('7 Sep – 13 Sep');
    expect(data.weeks[data.weeks.length - 1].label).toBe('28 Sep – 30 Sep');
  });

  it('an office bucket whose rows are ALL untracked is dropped (no "(no office) · N employees · all zeros" row)', async () => {
    // Assignments exist, but every grid row is pre-enrolment/untracked:
    // the bucket carries no office truth and read like broken data.
    const fixtures = baseFixtures();
    fixtures.enrolments = [
      { employee_id: E1, valid: '[2026-09-27,)', enabled_at: new Date('2026-09-27T05:00:00Z') },
      { employee_id: E2, valid: '[2026-09-27,)', enabled_at: new Date('2026-09-27T05:00:00Z') },
    ];
    fixtures.records = [];
    const pg = pgStub(fixtures);
    const supa = supabaseStub({
      tenants: [{ company_name: 'Acme' }],
      users: Object.entries(NAMES).map(([id, name]) => ({ id, name })),
      attendance_enrolments: [{ employee_id: E1 }, { employee_id: E2 }],
      attendance_attempts: [],
    });

    const data = await fetchAttendanceReportData(
      makeCtx({
        supabase: supa.client,
        pg: pg.client,
        params: { start_date: '2026-09-25', end_date: '2026-09-26' }, // both days untracked
      }),
    );

    // The OFFICES section drops the all-untracked bucket; the employee
    // table honestly keeps the zero rows (the "N tracked" scope count).
    expect(data.offices).toEqual([]);
    expect(data.employees.map((e) => e.name)).toEqual(['Asha', 'Bimal']);
    expect(data.employees.every((e) => e.summary.daysWorked === 0)).toBe(true);
  });

  it('an office filter matching nobody audits NOBODY (fallback to the roster is a defect)', async () => {
    // Both employees only ever sat at HQ; the filter asks for Branch.
    const fixtures = baseFixtures();
    fixtures.assignments = [
      { employee_id: E1, office_id: OFFICE_1, valid: '[2026-09-01,)', office_name: 'HQ', office_lat: 12.9, office_lng: 77.5, radius_m: 100 },
      { employee_id: E2, office_id: OFFICE_1, valid: '[2026-09-01,)', office_name: 'HQ', office_lat: 12.9, office_lng: 77.5, radius_m: 100 },
    ];
    const pg = pgStub(fixtures);
    const supa = supabaseStub({
      tenants: [{ company_name: 'Acme' }],
      users: Object.entries(NAMES).map(([id, name]) => ({ id, name })),
      attendance_enrolments: [{ employee_id: E1 }, { employee_id: E2 }],
      attendance_attempts: [{ employee_id: E1, outcome: 'mocked' }],
    });

    const data = await fetchAttendanceReportData(
      makeCtx({
        supabase: supa.client,
        pg: pg.client,
        params: { office_ids: [OFFICE_2] },
      }),
    );

    // The employee table is empty (the template's early-return empty page)
    // — so the audit MUST NOT quietly cover the whole roster.
    expect(data.employees).toEqual([]);
    expect(supa.calls['attendance_attempts']).toBeUndefined();
    expect(data.rejections).toEqual([]);
  });
});
