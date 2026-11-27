/**
 * 24-5b / CAP-4 + D7 — the pending-leave digest follows the resolved approver
 * branch (migration 20261127000003).
 *
 * One throwaway company with a four-rung tree, and one more company with no
 * admin at all. The injected clock drives the single arm that matters here
 * (the digest fires at 10:00 tenant wall time), and `leave.pending_reminder`
 * rows are read back with their payload counts:
 *
 *   MANAGER ── A (self-filed)
 *           ├─ D (self-filed)
 *           └─ B (filed BY MANAGER, on behalf)
 *   ADMIN2 (their own pending request)
 *   C (no manager, self-filed)
 *
 * Expected digest: MANAGER 2 (A, D), OWNER 2 (B climbs past its author, and
 * C falls back to the admin set), ADMIN2 1 (C only), and nothing for ADMIN2's
 * own filing.
 *
 * Also pinned directly on the helper: an unassigned requester falls back to
 * every active admin, a deactivated manager is climbed past, a hand-written
 * loop answers NULL (unresolved, never a hang), and an ownerless company
 * answers NULL.
 *
 * NOTE on the live DB: the suite temporarily unschedules the
 * `attendance-run-reminders` pg_cron job and restores the EXACT stored
 * schedule + command in afterAll (the existing 19-1 suite's pattern).
 */
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { purgeCompanyChildren } from '../helpers/attendance-company-fixture';
import {
  readSubtreeMemberDirectory,
  readSubtreeMemberIds,
} from '../../src/common/members/hierarchy';

jest.setTimeout(120_000);

const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
const IS_REAL_DB = DATABASE_URL !== '' && !DATABASE_URL.includes('test:test');

const maybeDescribe = IS_REAL_DB ? describe : describe.skip;
const maybeIt = IS_REAL_DB ? it : it.skip;

const TZ = 'Asia/Kolkata';
const OFF = '+05:30';

const TENANT = randomUUID();
const OWNER = randomUUID();
const ADMIN2 = randomUUID();
const MANAGER = randomUUID();
const A = randomUUID();
const B = randomUUID();
const C = randomUUID();
const D = randomUUID();
/** A deactivated member who still has a live report. */
const PARKED_MANAGER = randomUUID();
const R = randomUUID();
/** Two members pointing at each other — only a hand-written row can do this. */
const LOOP_1 = randomUUID();
const LOOP_2 = randomUUID();
/** A corrupt loop that climbs back THROUGH the requester (on-behalf filing). */
const CYC_EMPLOYEE = randomUUID();
const CYC_PARKED = randomUUID();

/** A company with no admin: the fallback set is empty (unresolved). */
const OWNERLESS = randomUUID();
const LONE = randomUUID();

const ist = (date: string, hms: string): string => `${date} ${hms}${OFF}`;

maybeDescribe(
  'leave.pending_reminder — routed to the resolved approver (24-5b)',
  () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    let probeDate = '';
    let storedJob: { schedule: string; command: string } | null = null;

    const seedUsers = async (ids: string[]): Promise<void> => {
      await pool.query(
        `insert into public.users (id, name, country_code, phone_number)
       select u, '24-5b probe person', '+91', ph
         from unnest($1::uuid[], $2::text[]) as t(u, ph)`,
        [
          ids,
          ids.map((_, i) => String(940000000 + (Date.now() % 40_000_000) + i)),
        ],
      );
    };

    const seedTenant = async (tenant: string, name: string): Promise<void> => {
      await pool.query(
        `insert into public.tenants (id, created_by, company_name, state_code, timezone)
       values ($1, $2, $3, 'KA', $4)`,
        [tenant, OWNER, name, TZ],
      );
      await pool.query(
        `insert into public.attendance_settings (tenant_id, enabled, setup_completed_at)
       values ($1, true, now())`,
        [tenant],
      );
    };

    const membership = async (
      tenant: string,
      userId: string,
      role: string,
      managerId: string | null = null,
      status = 'active',
    ): Promise<void> => {
      await pool.query(
        `insert into public.memberships (user_id, tenant_id, role, status, manager_id)
       values ($1, $2, $3, $4, $5)`,
        [userId, tenant, role, status, managerId],
      );
    };

    const pendingLeave = async (
      tenant: string,
      employeeId: string,
      filedBy: string,
    ): Promise<void> => {
      const id = (
        await pool.query<{ id: string }>(
          `insert into public.leave_requests
           (tenant_id, employee_id, request_id, start_date, end_date, part, reason, created_by)
         values ($1, $2, gen_random_uuid(), $3, $3, 'full_day', 'probe leave', $4)
         returning id`,
          [tenant, employeeId, probeDate, filedBy],
        )
      ).rows[0].id;
      await pool.query(
        `insert into public.leave_request_days
         (tenant_id, leave_request_id, employee_id, leave_date, state)
       values ($1, $2, $3, $4, 'pending')`,
        [tenant, id, employeeId, probeDate],
      );
    };

    const tick = (hms: string): Promise<unknown> =>
      pool.query('select public.attendance_run_reminders($1)', [
        ist(probeDate, hms),
      ]);

    const digest = async (): Promise<
      Array<{ userId: string; pendingCount: number }>
    > =>
      (
        await pool.query<{
          user_id: string;
          payload: { pendingCount: number };
        }>(
          `select user_id, payload from public.notifications
          where tenant_id = $1 and event_type = 'leave.pending_reminder'
          order by user_id`,
          [TENANT],
        )
      ).rows.map((row) => ({
        userId: row.user_id,
        pendingCount: row.payload.pendingCount,
      }));

    const approvers = async (
      tenant: string,
      requester: string,
      actor: string,
    ): Promise<string[] | null> => {
      const { rows } = await pool.query<{ ids: string[] | null }>(
        'select public.attendance_leave_approvers($1, $2, $3) as ids',
        [tenant, requester, actor],
      );
      return rows[0]?.ids ?? null;
    };

    beforeAll(async () => {
      if (!IS_REAL_DB) return;
      probeDate = (
        await pool.query<{ today: string }>(
          'select (now() at time zone $1)::date::text as today',
          [TZ],
        )
      ).rows[0].today;

      // The live cron's own clock would race the crafted instants: take it down
      // BEFORE the fixture exists, and restore the exact schedule in afterAll.
      storedJob =
        (
          await pool.query<{ schedule: string; command: string }>(
            `select schedule, command from cron.job
            where jobname = 'attendance-run-reminders' limit 1`,
          )
        ).rows[0] ?? null;
      if (storedJob) {
        await pool.query("select cron.unschedule('attendance-run-reminders')");
      }

      await seedUsers([
        OWNER,
        ADMIN2,
        MANAGER,
        A,
        B,
        C,
        D,
        PARKED_MANAGER,
        R,
        LOOP_1,
        LOOP_2,
        CYC_EMPLOYEE,
        CYC_PARKED,
        LONE,
      ]);
      await seedTenant(TENANT, `24-5b routing ${TENANT.slice(0, 8)}`);
      await seedTenant(OWNERLESS, `24-5b ownerless ${OWNERLESS.slice(0, 8)}`);

      await membership(TENANT, OWNER, 'company_admin');
      await membership(TENANT, ADMIN2, 'company_admin');
      await membership(TENANT, MANAGER, 'employee', OWNER);
      await membership(TENANT, A, 'employee', MANAGER);
      await membership(TENANT, B, 'employee', MANAGER);
      await membership(TENANT, C, 'employee', null);
      await membership(TENANT, D, 'employee', MANAGER);
      await membership(
        TENANT,
        PARKED_MANAGER,
        'employee',
        OWNER,
        'deactivated',
      );
      await membership(TENANT, R, 'employee', PARKED_MANAGER);
      // The composite FK needs both loop rows first; the loop itself is
      // written by hand (only a corrupted tree can hold it).
      await membership(TENANT, LOOP_1, 'employee', null, 'deactivated');
      await membership(TENANT, LOOP_2, 'employee', null, 'deactivated');
      await pool.query(
        `update public.memberships set manager_id = $3
          where tenant_id = $1 and user_id = $2`,
        [TENANT, LOOP_1, LOOP_2],
      );
      await pool.query(
        `update public.memberships set manager_id = $3
          where tenant_id = $1 and user_id = $2`,
        [TENANT, LOOP_2, LOOP_1],
      );
      // A loop that returns to the requester: the requester's manager is a
      // parked (inactive) member whose own manager is the requester again.
      // Only a hand-written row can hold this.
      await membership(TENANT, CYC_EMPLOYEE, 'employee', null);
      await membership(TENANT, CYC_PARKED, 'employee', null, 'deactivated');
      await pool.query(
        `update public.memberships set manager_id = $3
          where tenant_id = $1 and user_id = $2`,
        [TENANT, CYC_EMPLOYEE, CYC_PARKED],
      );
      await pool.query(
        `update public.memberships set manager_id = $3
          where tenant_id = $1 and user_id = $2`,
        [TENANT, CYC_PARKED, CYC_EMPLOYEE],
      );
      // The ownerless company: one employee, nobody who can decide.
      await membership(OWNERLESS, LONE, 'employee', null);

      await pendingLeave(TENANT, A, A);
      await pendingLeave(TENANT, D, D);
      await pendingLeave(TENANT, B, MANAGER);
      await pendingLeave(TENANT, C, C);
      await pendingLeave(TENANT, ADMIN2, ADMIN2);
    });

    afterAll(async () => {
      if (!IS_REAL_DB) return;
      try {
        if (storedJob) {
          await pool.query('select cron.schedule($1, $2, $3)', [
            'attendance-run-reminders',
            storedJob.schedule,
            storedJob.command,
          ]);
          storedJob = null;
        }
        await purgeCompanyChildren(pool, [TENANT, OWNERLESS]);
        await pool.query(
          'delete from public.tenants where id = any($1::uuid[])',
          [[TENANT, OWNERLESS]],
        );
        await pool.query(
          'delete from public.users where id = any($1::uuid[])',
          [
            [
              OWNER,
              ADMIN2,
              MANAGER,
              A,
              B,
              C,
              D,
              PARKED_MANAGER,
              R,
              LOOP_1,
              LOOP_2,
              CYC_EMPLOYEE,
              CYC_PARKED,
              LONE,
            ],
          ],
        );
      } finally {
        await pool.end();
      }
    });

    maybeIt('fires nothing before 10:00 tenant wall time', async () => {
      await tick('09:30:00');
      expect(await digest()).toEqual([]);
    });

    maybeIt(
      'notifies exactly the resolved approvers, each with their own count',
      async () => {
        await tick('10:00:00');

        const rows = await digest();
        expect(rows).toEqual(
          [
            { userId: ADMIN2, pendingCount: 1 }, // C fell back to the admin set
            { userId: MANAGER, pendingCount: 2 }, // A and D
            // B (filed by MANAGER → climbs past the author) AND C (fallback).
            { userId: OWNER, pendingCount: 2 },
          ].sort((x, y) => x.userId.localeCompare(y.userId)),
        );
        // Nobody else: the requester is never their own reminder, and ADMIN2's
        // own pending request resolves to self (D11) — not to the other admin.
        expect(rows.map((row) => row.userId)).not.toContain(A);
        expect(rows.map((row) => row.userId)).not.toContain(B);
        expect(rows.map((row) => row.userId)).not.toContain(C);
      },
    );

    maybeIt(
      'absorbs a second tick — one digest per recipient per day',
      async () => {
        await tick('10:05:00');
        expect(await digest()).toHaveLength(3);
      },
    );

    maybeIt(
      'the walk matches the decision path: single, fallback, actor exclusion, self',
      async () => {
        await expect(approvers(TENANT, A, A)).resolves.toEqual([MANAGER]);
        // B's own manager filed it: the author never decides their own filing.
        await expect(approvers(TENANT, B, MANAGER)).resolves.toEqual([OWNER]);
        await expect(approvers(TENANT, C, C)).resolves.toEqual(
          [OWNER, ADMIN2].sort(),
        );
        // An admin's own filing decides itself.
        await expect(approvers(TENANT, ADMIN2, ADMIN2)).resolves.toEqual([]);
        // A deactivated manager is inactive: the walk climbs to the next
        // eligible member above — the owner — as a SINGLE approver (the
        // fallback set only appears when nobody is assigned).
        await expect(approvers(TENANT, R, R)).resolves.toEqual([OWNER]);
      },
    );

    maybeIt(
      'the team directory is the same branch the access scope walks',
      async () => {
        // Real SQL, real rows: the directory's joins, its status cast and its
        // pruning are never exercised by the unit mocks.
        const tx = pool as unknown as Parameters<
          typeof readSubtreeMemberDirectory
        >[0];
        const directory = await readSubtreeMemberDirectory(tx, TENANT, MANAGER);
        const ids = await readSubtreeMemberIds(tx, TENANT, MANAGER);

        expect(directory.map((row) => row.userId).sort()).toEqual(
          [A, B, D].sort(),
        );
        expect([...ids].sort()).toEqual(
          directory.map((row) => row.userId).sort(),
        );
        expect(
          directory.every(
            (row) =>
              row.status === 'active' &&
              typeof row.employeeCode === 'string' &&
              row.name === '24-5b probe person',
          ),
        ).toBe(true);
        // A deactivated (parked) manager keeps their read: their report is
        // still their branch, and the seed never lists itself.
        const parked = await readSubtreeMemberDirectory(
          tx,
          TENANT,
          PARKED_MANAGER,
        );
        expect(parked.map((row) => row.userId)).toEqual([R]);
      },
    );

    maybeIt(
      'a loop that climbs back to the requester answers unresolved (null)',
      async () => {
        // An on-behalf filing: the actor is not the requester, so without the
        // requester seeded in the visited set the walk would return the
        // requester as their own approver.
        await expect(
          approvers(TENANT, CYC_EMPLOYEE, ADMIN2),
        ).resolves.toBeNull();
      },
    );

    maybeIt(
      'a hand-written loop answers unresolved (null), never a hang',
      async () => {
        await expect(approvers(TENANT, LOOP_1, LOOP_1)).resolves.toBeNull();
      },
    );

    maybeIt(
      'an ownerless company resolves to nobody (null), not to the filer',
      async () => {
        await expect(approvers(OWNERLESS, LONE, LONE)).resolves.toBeNull();
      },
    );
  },
);
