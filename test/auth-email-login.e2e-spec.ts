/**
 * POST /auth/email/login — real-database e2e (DEV database only).
 * DEV SHORTCUT — remove at go-live gate, together with the endpoint.
 *
 * Plain English: the fixed password signs in an EXISTING person who owns the
 * email. Every refusal (wrong password, unknown email, disabled person) looks
 * identical from outside. Rows seeded here are removed in afterAll.
 */
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { JwtService } from '@nestjs/jwt';
import { SupabaseClient } from '@supabase/supabase-js';
import { bootApp } from './helpers/weekly-off-app';
import { purgeCompany, serviceRoleClient } from './helpers/rls-seed';
import { DEV_SHORTCUT_EMAIL_PASSWORD } from '../src/auth/email-login.constants';

const TENANT = 'e2e0e111-0000-4000-8000-000000000001';
const id = (n: number) =>
  `e2e0e111-0000-4000-8000-0000000001${n}0`.slice(0, 36);
const U = {
  admin: id(1),
  employee: id(2),
  viewer: id(3),
  platform: id(4),
  stranger: id(5),
  disabled: id(6),
  invited: id(7),
  removed: id(8),
  disabledAdmin: id(9),
};
const ALL = Object.values(U);
const em = (k: string) => `e2e-emaillogin-${k}@example.test`;
const URL_ = '/api/v1/auth/email/login';

describe('POST /auth/email/login (real dev DB)', () => {
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let db: SupabaseClient;

  const post = (payload: unknown) =>
    app.inject({ method: 'POST', url: URL_, payload: payload as object });
  const login = (email: string, password = DEV_SHORTCUT_EMAIL_PASSWORD) =>
    post({ email, password });

  beforeAll(async () => {
    db = serviceRoleClient();
    await purgeCompany(db, TENANT, ALL);
    const people: Array<[string, string, string, Record<string, unknown>]> = [
      [U.admin, '7770011001', 'admin', {}],
      [U.employee, '7770011002', 'employee', {}],
      [U.viewer, '7770011003', 'viewer', {}],
      [U.platform, '7770011004', 'platform', { platform_admin: true }],
      [U.stranger, '7770011005', 'stranger', {}],
      [U.disabled, '7770011006', 'disabled', { disabled: true }],
      [U.invited, '7770011007', 'invited', {}],
      [U.removed, '7770011008', 'removed', {}],
      [U.disabledAdmin, '7770011009', 'disabledadmin', { disabled: true }],
    ];
    const ins = await db.from('users').insert(
      people.map(([uid, phone, key, extra]) => ({
        id: uid,
        country_code: '+91',
        phone_number: phone,
        email: em(key),
        name: `E2E ${key}`,
        platform_admin: false,
        disabled: false,
        ...extra,
      })),
    );
    if (ins.error) throw new Error(ins.error.message);
    const t = await db.from('tenants').insert({
      id: TENANT,
      created_by: U.admin,
      company_name: 'E2E Email Login Co',
      state_code: 'KA',
    });
    if (t.error) throw new Error(t.error.message);
    const m = await db.from('memberships').insert([
      {
        user_id: U.admin,
        tenant_id: TENANT,
        role: 'company_admin',
        status: 'active',
      },
      {
        user_id: U.employee,
        tenant_id: TENANT,
        role: 'employee',
        status: 'active',
      },
      {
        user_id: U.viewer,
        tenant_id: TENANT,
        role: 'viewer',
        status: 'active',
      },
      {
        user_id: U.invited,
        tenant_id: TENANT,
        role: 'employee',
        status: 'invited',
      },
      {
        user_id: U.removed,
        tenant_id: TENANT,
        role: 'employee',
        status: 'removed',
      },
      {
        user_id: U.disabledAdmin,
        tenant_id: TENANT,
        role: 'company_admin',
        status: 'active',
      },
    ]);
    if (m.error) throw new Error(m.error.message);
    ({ app, jwt } = await bootApp());
  }, 120000);

  afterAll(async () => {
    await app?.close();
    await purgeCompany(db, TENANT, ALL);
    // Users created by a (buggy) login for an unknown email would show here.
    const { data } = await db
      .from('users')
      .select('id')
      .like('email', 'e2e-emaillogin-%');
    expect(data ?? []).toEqual([]);
  }, 120000);

  it('company admin: 200, same shape as otp/verify, token works on /users/me', async () => {
    const res = await login(em('admin'));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['token', 'user']);
    expect(body.user).toEqual({
      userId: U.admin,
      tenantId: TENANT,
      role: 'company_admin',
      name: 'E2E admin',
      platformAdmin: false,
      formerMember: false,
    });
    const claims = jwt.decode(body.token);
    expect(claims).toMatchObject({ sub: U.admin, typ: 'access' });
    expect(claims).not.toHaveProperty('role');
    expect(claims).not.toHaveProperty('tenantId');
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it.each([
    ['employee', 'employee'],
    ['viewer', 'viewer'],
  ])('%s signs in with their own role', async (key, role) => {
    const res = await login(em(key));
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ role, tenantId: TENANT });
  });

  it('platform admin: role platform_admin, no company, flag true', async () => {
    const res = await login(em('platform'));
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({
      userId: U.platform,
      tenantId: null,
      role: 'platform_admin',
      platformAdmin: true,
    });
  });

  it('a user with no company gets a token and the no-company state', async () => {
    const res = await login(em('stranger'));
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ tenantId: null, role: null });
  });

  it('first sign-in activates an invited membership', async () => {
    const res = await login(em('invited'));
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({
      role: 'employee',
      tenantId: TENANT,
    });
    const { data } = await db
      .from('memberships')
      .select('status')
      .eq('user_id', U.invited)
      .single();
    expect(data?.status).toBe('active');
  });

  it('a removed member can sign in but sees the no-company state', async () => {
    const res = await login(em('removed'));
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ tenantId: null, role: null });
  });

  it.each(['disabled', 'disabledadmin'])(
    'disabled person (%s) is refused with the generic 401',
    async (key) => {
      const res = await login(em(key));
      expect(res.statusCode).toBe(401);
      expect(res.json()).not.toHaveProperty('token');
    },
  );

  it('wrong password, unknown email and disabled give identical 401 bodies', async () => {
    const a = await login(em('admin'), 'wrong-pass');
    const b = await login('e2e-emaillogin-ghost@example.test');
    const c = await login(em('disabled'));
    expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([401, 401, 401]);
    const strip = (r: { json: () => Record<string, unknown> }) => {
      const j = { ...r.json() };
      delete j['timestamp'];
      delete j['request_id'];
      delete j['path'];
      return j;
    };
    expect(strip(b)).toEqual(strip(a));
    expect(strip(c)).toEqual(strip(a));
    expect(JSON.stringify(a.json())).not.toContain(DEV_SHORTCUT_EMAIL_PASSWORD);
  });

  it('unknown email with the right password does NOT create a user', async () => {
    const res = await login('e2e-emaillogin-ghost2@example.test');
    expect(res.statusCode).toBe(401);
    const { data } = await db
      .from('users')
      .select('id')
      .eq('email', 'e2e-emaillogin-ghost2@example.test');
    expect(data).toEqual([]);
  });

  // One email per variant: six wrong guesses on one email would (correctly)
  // trip the lockout and answer 429 instead of 401.
  it.each([
    ['yah00mail', 'stranger'],
    ['YAH00MAIL', 'platform'],
    [' yah00Mail', 'invited'],
    ['yah00Mail\n', 'removed'],
    ['yah00Mail\0', 'admin'],
    ['Yah00Mail', 'viewer'],
  ])('password variant %j is refused', async (pw, key) => {
    const res = await login(em(key), pw);
    expect(res.statusCode).toBe(401);
  });

  it.each([
    ['upper-case email', '  E2E-EmailLogin-ADMIN@Example.TEST  '],
    ['trailing space', `${em('admin')} `],
  ])('email normalisation: %s still matches', async (_n, email) => {
    const res = await login(email);
    expect(res.statusCode).toBe(200);
    expect(res.json().user.userId).toBe(U.admin);
  });

  it.each([
    ['empty body', {}],
    ['missing password', { email: em('admin') }],
    ['missing email', { password: DEV_SHORTCUT_EMAIL_PASSWORD }],
    ['empty email', { email: '', password: DEV_SHORTCUT_EMAIL_PASSWORD }],
    [
      'whitespace email',
      { email: '   ', password: DEV_SHORTCUT_EMAIL_PASSWORD },
    ],
    [
      'malformed email',
      { email: 'not-an-email', password: DEV_SHORTCUT_EMAIL_PASSWORD },
    ],
    [
      'oversized email',
      {
        email: `${'a'.repeat(300)}@x.co`,
        password: DEV_SHORTCUT_EMAIL_PASSWORD,
      },
    ],
    ['oversized password', { email: em('admin'), password: 'p'.repeat(5000) }],
    ['empty password', { email: em('admin'), password: '' }],
    [
      'email as object (NoSQL-ish)',
      { email: { $ne: '' }, password: DEV_SHORTCUT_EMAIL_PASSWORD },
    ],
    [
      'email as array',
      { email: [em('admin')], password: DEV_SHORTCUT_EMAIL_PASSWORD },
    ],
    ['password as number', { email: em('admin'), password: 12345 }],
    [
      'SQL-ish email',
      { email: "x' or '1'='1", password: DEV_SHORTCUT_EMAIL_PASSWORD },
    ],
    [
      'SQL-ish with @',
      {
        email: "a'--@b.co; drop table users",
        password: DEV_SHORTCUT_EMAIL_PASSWORD,
      },
    ],
    [
      'PostgREST filter injection',
      { email: 'a@b.co,id.neq.0', password: DEV_SHORTCUT_EMAIL_PASSWORD },
    ],
  ])('%s -> 422, no token', async (_n, payload) => {
    const res = await post(payload);
    expect(res.statusCode).toBe(422);
    expect(res.json()).not.toHaveProperty('token');
  });

  it('non-JSON / null body is refused, never 200 or 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: URL_,
      headers: { 'content-type': 'application/json' },
      payload: 'null',
    });
    expect([400, 401, 422]).toContain(res.statusCode);
  });

  it('extra fields are ignored and cannot escalate (role / platformAdmin / tenantId)', async () => {
    const res = await post({
      email: em('stranger'),
      password: DEV_SHORTCUT_EMAIL_PASSWORD,
      role: 'platform_admin',
      platformAdmin: true,
      tenantId: TENANT,
      userId: U.admin,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({
      userId: U.stranger,
      tenantId: null,
      role: null,
      platformAdmin: false,
    });
  });

  it('needs no Authorization header (public) and ignores a bogus one', async () => {
    const res = await app.inject({
      method: 'POST',
      url: URL_,
      headers: { authorization: 'Bearer garbage' },
      payload: { email: em('viewer'), password: DEV_SHORTCUT_EMAIL_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
  });

  it('repeated wrong attempts lock the email (429, Retry-After) even for the right password; other emails are unaffected', async () => {
    const victim = em('employee');
    // other tests used em('employee') only with failures < 5 and a success reset
    await login(victim); // success resets any earlier count
    for (let i = 0; i < 5; i++) {
      expect((await login(victim, `wrong${i}`)).statusCode).toBe(401);
    }
    const locked = await login(victim);
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(locked.json()).not.toHaveProperty('token');
    expect((await login(em('viewer'))).statusCode).toBe(200);
  });

  it('lockout also applies to an unknown email (same behaviour, no enumeration)', async () => {
    const ghost = 'e2e-emaillogin-ghost3@example.test';
    for (let i = 0; i < 5; i++) await login(ghost);
    expect((await login(ghost)).statusCode).toBe(429);
  });

  it('a disabled person with a token issued earlier is refused on later requests', async () => {
    // Log in, then disable in the database: the next request must 401.
    const body = (await login(em('viewer'))).json();
    await db.from('users').update({ disabled: true }).eq('id', U.viewer);
    try {
      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me',
        headers: { authorization: `Bearer ${body.token}` },
      });
      expect(me.statusCode).toBe(401);
      expect((await login(em('viewer'))).statusCode).toBe(401);
    } finally {
      await db.from('users').update({ disabled: false }).eq('id', U.viewer);
    }
  });
});
