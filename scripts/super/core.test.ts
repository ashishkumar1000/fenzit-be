import { describe, expect, test } from 'bun:test';
import { findByPhone, likePattern, parsePhone, whoisLines, whoisReport, type Target } from './core';
import type { Db } from './db';
import { mintAccessToken } from './accounts';
import { countPlan, EXPECTED_EDGES, preparePurge } from './purge';
import crypto from 'node:crypto';

/**
 * The no-database behavior tests for the super CLI's core: the person
 * classification that powers the staff rail, the rail itself (via
 * preparePurge's refusal), the minted-token contract the backend guard
 * expects, LIKE escaping, and the headless whois twin's section parity.
 * Everything runs against a stub Db — no database, no writes.
 */

const STAFF_ID = '11111111-1111-1111-1111-111111111111';
const OWNER_ID = '22222222-2222-2222-2222-222222222222';

interface QueryPlan {
  match: (text: string) => boolean;
  rows: Record<string, unknown>[];
}

function stubDb(plans: QueryPlan[]): Db {
  return {
    driver: 'pg',
    query: async (text: string) => {
      const plan = plans.find((p) => p.match(text));
      return { rows: plan ? plan.rows : [], rowCount: plan ? plan.rows.length : 0 };
    },
    transaction: async <T,>(work: (tx: Db) => Promise<T>) => work(stubDb(plans)),
    close: async () => undefined,
  } as unknown as Db;
}

const userRow = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: OWNER_ID, name: 'QA Owner', country_code: '+91', phone_number: '9717331820',
  email: null, platform_admin: false, disabled: false, created_at: new Date(), ...over,
});
const membershipRow = (over: Record<string, unknown>): Record<string, unknown> => ({
  tenant_id: 't1', role: 'company_admin', status: 'active', employee_code: 'EMP-001',
  created_at: new Date(), company_name: 'QA Co', created_by: OWNER_ID, invited_by_name: null,
  ...over,
});

describe('parsePhone', () => {
  test('accepts the documented shapes', () => {
    expect(parsePhone('9876543210')).toEqual({ countryCode: '+91', phoneNumber: '9876543210' });
    expect(parsePhone('919876543210').phoneNumber).toBe('9876543210');
    expect(parsePhone('+91 98765 43210').phoneNumber).toBe('9876543210');
  });
  test('rejects malformed input', () => {
    for (const bad of ['987654321', '19876543210', 'abcdefghij', '']) {
      expect(() => parsePhone(bad)).toThrow();
    }
  });
});

describe('likePattern', () => {
  test('escapes LIKE wildcards so fragments match literally', () => {
    expect(likePattern('100%')).toBe("%100\\%%");
    expect(likePattern('a_b')).toBe("%a\\_b%");
    expect(likePattern('a\\b')).toBe("%a\\\\b%");
  });
});

describe('findByPhone classification (the staff rail source)', () => {
  const plans = (user: Record<string, unknown>, mems: Record<string, unknown>[]): QueryPlan[] => [
    { match: (t) => t.includes('from public.users') && t.includes('where country_code'), rows: [user] },
    { match: (t) => t.includes('from public.memberships m') && t.includes('limit 1'), rows: mems },
  ];
  test('platform_admin classifies as staff', async () => {
    const t = await findByPhone(stubDb(plans(userRow({ id: STAFF_ID, platform_admin: true }), [])), parsePhone('9717331820'));
    expect(t?.kind).toBe('staff');
  });
  test('company_admin member classifies as owner', async () => {
    const t = await findByPhone(stubDb(plans(userRow({}), [membershipRow({})])), parsePhone('9717331820'));
    expect(t?.kind).toBe('owner');
  });
  test('employee member classifies as technician', async () => {
    const t = await findByPhone(stubDb(plans(userRow({}), [membershipRow({ role: 'employee' })])), parsePhone('9717331820'));
    expect(t?.kind).toBe('technician');
  });
  test('memberless user classifies as standalone', async () => {
    const t = await findByPhone(stubDb(plans(userRow({}), [])), parsePhone('9717331820'));
    expect(t?.kind).toBe('standalone');
  });
});

describe('staff rail', () => {
  test('preparePurge refuses a staff target before touching anything', async () => {
    const db = stubDb([
      { match: (t) => t.includes('from public.users') && t.includes('where country_code'), rows: [userRow({ id: STAFF_ID, platform_admin: true })] },
      { match: (t) => t.includes('from public.memberships m'), rows: [] },
    ]);
    let message = '';
    try {
      await preparePurge(db, '9717331820');
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain('staff — staff accounts are never touched');
  });
});

/**
 * A stub that enforces Postgres' bind rules: every $N passed must be
 * referenced by the SQL (an unused one is 42P18), and every $N referenced
 * must be bound (else 08P01). Plain stubDb never checks this, which is how
 * the departed-founder bind bug shipped.
 */
function bindCheckedDb(plans: QueryPlan[]): Db {
  const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });
  const db: Db = {
    driver: 'pg',
    query: async (text: string, params: unknown[] = []) => {
      const referenced = [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
      for (let i = 1; i <= params.length; i++) {
        if (!referenced.includes(i)) throw pgError('42P18', `could not determine data type of parameter $${i}`);
      }
      const highest = Math.max(0, ...referenced);
      if (highest > params.length) throw pgError('08P01', `bind message supplies ${params.length} parameters, but statement requires ${highest}`);
      const plan = plans.find((p) => p.match(text));
      return { rows: plan ? plan.rows : [], rowCount: plan ? plan.rows.length : 0 };
    },
    transaction: async <T,>(work: (tx: Db) => Promise<T>) => work(db),
    close: async () => undefined,
  };
  return db;
}

/** Owner target (Happy-Hoye shape) with a clean snapshot, so only the
 *  company-branch pre-checks decide the outcome. */
function ownerPlans(overrides: { departedFounder?: Record<string, unknown>[] } = {}): QueryPlan[] {
  const snapshot = EXPECTED_EDGES.map((edge) => {
    const [table_name, cols, ref_table, on_delete] = edge.split('|');
    return { table_name, cols, ref_table, on_delete };
  });
  return [
    { match: (t) => t.includes('pg_constraint'), rows: snapshot },
    { match: (t) => t.includes('from public.users') && t.includes('where country_code'), rows: [userRow({})] },
    { match: (t) => t.includes('from public.memberships m') && t.includes('limit 1'), rows: [membershipRow({})] },
    { match: (t) => t.includes('m.tenant_id <> $2'), rows: [] },
    { match: (t) => t.includes('select user_id from public.memberships'), rows: [{ user_id: OWNER_ID }] },
    { match: (t) => t.includes('platform_admin and id = ANY'), rows: [] },
    { match: (t) => t.includes('t2.created_by = ANY'), rows: [] },
    { match: (t) => t.includes('not exists'), rows: overrides.departedFounder ?? [] },
    { match: (t) => t.includes('to_regclass'), rows: [{ reg: 'x' }] },
    { match: (t) => t.includes('count(*)'), rows: [{ n: 0 }] },
  ];
}

describe('preparePurge owner branch (bind contract)', () => {
  test('a clean company founder prepares a plan without any unbound or unused parameter', async () => {
    const prepared = await preparePurge(bindCheckedDb(ownerPlans()), '9717331820');
    expect(prepared.scope).toContain('COMPANY');
    expect(prepared.plan.length).toBeGreaterThan(0);
  });

  test('a departed founder is refused with the founder message, not a bind error', async () => {
    const db = bindCheckedDb(ownerPlans({ departedFounder: [{ name: 'Ashish', phone_number: '9717331820' }] }));
    await expect(preparePurge(db, '9717331820')).rejects.toThrow("founder (Ashish) no longer has an active membership");
  });
});

describe('mintAccessToken (the backend guard contract)', () => {
  const SECRET = 'test-jwt-secret';
  const savedSecret = process.env['SUPABASE_JWT_SECRET'];
  test('minted token is HS256 {sub, typ: access} with no expiry and verifies', () => {
    process.env['SUPABASE_JWT_SECRET'] = SECRET;
    const target = userRow({ id: OWNER_ID }) as never;
    const token = mintAccessToken(target);
    const [h, p, sig] = token.split('.');
    // Header: HS256 JWT.
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
    // Payload: the guard's exact acceptance rule — sub + typ: 'access', NO exp.
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    expect(payload).toEqual({ sub: OWNER_ID, typ: 'access' });
    expect('exp' in payload).toBe(false);
    // Signature verifies with the same secret the backend guard uses.
    const expected = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest().toString('base64url');
    expect(sig).toBe(expected);
    process.env['SUPABASE_JWT_SECRET'] = savedSecret; // no leak into other tests
  });
});

describe('whoisLines headless twin (section parity with the dossier)', () => {
  // Canned rows for every whoisReport query — one populated section each.
  const plans: QueryPlan[] = [
    { match: (t) => t.includes('as notifications'), rows: [{ jobs: 2, skills: 1, audit_rows: 3, memberships: 1, notifications: 4 }] },
    { match: (t) => t.includes('auth.identities'), rows: [{ n: 0 }] },
    { match: (t) => t.includes('employee_code'), rows: [membershipRow({ invited_by_name: 'Founder' })] },
    { match: (t) => t.includes('attendance_office_assignments'), rows: [{ name: 'HQ', formatted_address: 'Bhopal', radius_m: 100, valid: '[2026-01-01,2036-01-01)' }] },
    { match: (t) => t.includes('current_step'), rows: [{ job_number: 'JB-2026-0001', status: 'in_progress', priority: 'urgent', scheduled_start: new Date(), current_step: 'on_my_way', completed_at: null, service_location: 'Bhopal', photos: 2, customer: 'Kajal', skill: 'Pipe Leak' }] },
    { match: (t) => t.includes('checkin_mocked'), rows: [{ work_date: '2026-10-26', checkin_at: new Date('2026-10-26T04:05:00Z'), checkout_at: new Date('2026-10-26T13:10:00Z'), checkin_distance_m: 3, checkout_distance_m: 4, mocked: false }] },
    { match: (t) => t.includes('overrides_authored'), rows: [{ attempts: 5, corrections: 1, overrides: 1, overrides_authored: 1, weekly_off: 0, enrolments: 1 }] },
    { match: (t) => t.includes('from public.attendance_attempts'), rows: [{ kind: 'check_in', outcome: 'too_far', provider: 'network', distance_m: 240, mocked: false, created_at: new Date() }] },
    { match: (t) => t.includes('last_state'), rows: [{ start_date: '2026-11-02', end_date: '2026-11-03', part: 'full_day', reason: 'Trip', last_state: 'pending' }] },
    { match: (t) => t.includes('leave_request_days'), rows: [{ leave_date: '2026-11-02', state: 'pending' }] },
    { match: (t) => t.includes('from public.leave_events'), rows: [{ cause: 'apply', reason: null, dates: '{2026-11-02}', actor: 'QA Owner', created_at: new Date() }] },
    { match: (t) => t.includes('user_skills us'), rows: [{ name: 'Pipe Leak Repair' }] },
    { match: (t) => t.includes('where m.invited_by'), rows: [{ name: 'Suresh', phone_number: '1212121212', company_name: 'QA Co', role: 'employee', status: 'active' }] },
    { match: (t) => t.includes('c.actor_id'), rows: [{ work_date: '2026-10-19', employee: 'Suresh', note: 'He was present' }] },
    { match: (t) => t.includes('payload'), rows: [{ event_type: 'leave.applied', payload: { employeeName: 'Suresh', startDate: '2026-11-02' }, read_at: null, pushed_at: null, created_at: new Date() }] },
    { match: (t) => t.includes('actor_user_id = $1 or target_user_id'), rows: [{ action: 'member.invite', is_actor: true, created_at: new Date() }] },
    { match: (t) => t.includes('from public.activity_logs'), rows: [{ event_type: 'job_created', job_number: 'JB-2026-0001', created_at: new Date() }] },
    { match: (t) => t.includes('report_requests'), rows: [{ report_type: 'technician_job_activity', status: 'ready', created_at: new Date() }] },
    { match: (t) => t.includes('from public.tenants t'), rows: [{ is_founder: true, address: 'Bhopal', state_code: 'MP', timezone: 'Asia/Kolkata', gstin: null, upi_vpa: null, customers: 1, jobs: 1, members: 3, attendance_rows: 0 }] },
  ];
  const person: Target = {
    id: OWNER_ID, name: 'QA Owner', countryCode: '+91', phoneNumber: '9717331820',
    email: null, platformAdmin: false, disabled: false,
    membership: { tenantId: 't1', role: 'company_admin', status: 'active', companyName: 'QA Co' },
    kind: 'owner', createdAt: new Date(),
  };

  test('prints a block for every populated section', async () => {
    const lines = await whoisLines(stubDb(plans), person);
    const text = lines.join('\n');
    for (const title of [
      'memberships:', 'invites sent:', 'offices:', 'jobs (as technician):', 'attendance:',
      'leave:', 'skills:', 'activity (recent):', 'audit (recent):', 'notifications (recent):', 'reports:',
    ]) {
      expect(text).toContain(title);
    }
  });
  test('carries the deep data (invites, forensics, payloads, founder)', async () => {
    const lines = (await whoisLines(stubDb(plans), person)).join('\n');
    expect(lines).toContain('Suresh');                     // invites + payload + moderation
    expect(lines).toContain('too_far');                    // attempt forensics
    expect(lines).toContain('founder');                    // founder marker
    expect(lines).toContain('He was present');             // authored correction note
    expect(lines).toContain('9.1h');                       // derived worked hours
  });
});

describe('countPlan updateSet honesty', () => {
  test('update steps appear in neither counts nor missingTables', async () => {
    const db = stubDb([
      { match: (t) => t.includes('to_regclass'), rows: [{ reg: 'sometable' }] },
      { match: (t) => t.includes('count(*)'), rows: [{ n: 7 }] },
    ]);
    const { counts, missingTables } = await countPlan(db, [
      { table: 'users', where: 'id = $1', params: ['u'] },
      { table: 'memberships', where: 'invited_by = $1', params: ['u'], updateSet: 'invited_by = NULL' },
    ]);
    expect(counts).toEqual([{ table: 'users', n: 7 }]);
    expect(missingTables).toEqual([]);
  });
});

describe('whoisReport degrade paths', () => {
  test('a drifted optional section degrades to empty and logins-unknown stays null', async () => {
    const failing = (code: string) => {
      const e = new Error('boom') as Error & { code: string };
      e.code = code;
      return Promise.reject(e);
    };
    const db = stubDb([
      // counts still work
      { match: (t) => t.includes('as notifications'), rows: [{ jobs: 0, skills: 0, audit_rows: 0, memberships: 0, notifications: 0 }] },
      // auth schema unreadable
      { match: (t) => t.includes('auth.identities'), rows: [] },
    ]) as Db;
    // Every optional section query rejects with 42P01 — soft() must swallow it.
    db.query = (async (text: string) => {
      if (text.includes('as notifications')) return { rows: [{ jobs: 0, skills: 0, audit_rows: 0, memberships: 0, notifications: 0 }] };
      if (text.includes('auth.identities')) return { rows: [{ n: null }] };
      const e = new Error('relation missing') as Error & { code: string };
      e.code = '42P01';
      throw e;
    }) as Db['query'];
    const target: Target = {
      id: OWNER_ID, name: 'X', countryCode: '+91', phoneNumber: '9717331820',
      email: null, platformAdmin: false, disabled: false, membership: null,
      kind: 'standalone', createdAt: null,
    };
    const report = await whoisReport(db, target);
    expect(report.offices).toEqual([]);
    expect(report.jobs).toEqual([]);
    expect(report.notifications).toEqual([]);
    expect(report.company).toBeNull();
    expect(report.logins).toBeNull();
    const lines = await whoisLines(db, target);
    expect(lines.join('\n')).not.toContain('logins'); // unknown, never a fake 0
  });
});
