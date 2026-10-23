/**
 * POST /auth/email/link — real-database e2e (DEV database only).
 *
 * Plain English: any signed-in person, with or without a company, can link one
 * email to their account. Setting the same email again does nothing. An
 * account that already has a different email cannot change it here. A second
 * person asking for a taken address gets 409 a few times, then 429, so the
 * endpoint cannot be used to test many addresses. Rows seeded here are
 * removed in afterAll.
 */
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { JwtService } from '@nestjs/jwt';
import { SupabaseClient } from '@supabase/supabase-js';
import { bootApp } from './helpers/weekly-off-app';
import { purgeCompany, serviceRoleClient } from './helpers/rls-seed';
import { accessToken } from './helpers/auth-test-utils';
import { EMAIL_LINK_MAX_TAKEN_ANSWERS } from '../src/auth/email-link.service';

const TENANT = 'e2e0e222-0000-4000-8000-000000000001';
const id = (n: number) =>
  `e2e0e222-0000-4000-8000-0000000001${n}0`.slice(0, 36);
// A fresh identity per run: the taken-answer pause lives in the app's cache
// for ten minutes, so a fixed id would start the next run already paused.
const proberSeed = crypto.randomUUID().slice(24);
const prober = `e2e0e222-0000-4000-8000-${proberSeed}`;
// The phone is fresh per run too: the user table's unique index is on
// (country_code, phone_number), so a fixed number left behind by a run that
// was interrupted before its cleanup would block every later run here.
const proberPhone = `777${String(parseInt(proberSeed, 16) % 10_000_000).padStart(7, '0')}`;
const U = {
  admin: id(1),
  viewer: id(2),
  // No membership: linking must work before a person has a company.
  stranger: id(3),
  // Holds an email another account will ask for.
  holder: id(4),
  prober,
  // Already has one email; tries to change it.
  attached: id(6),
};
const ALL = Object.values(U);
const em = (k: string) => `e2e-emaillink-${k}@example.test`;
const URL_ = '/api/v1/auth/email/link';

describe('POST /auth/email/link (real dev DB)', () => {
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let db: SupabaseClient;

  const link = async (
    userId: string,
    payload: unknown,
  ): Promise<{
    statusCode: number;
    body: Record<string, unknown>;
    headers: Record<string, unknown>;
  }> => {
    const res = await app.inject({
      method: 'POST',
      url: URL_,
      headers: { authorization: `Bearer ${accessToken(jwt, userId)}` },
      payload: payload as object,
    });
    return {
      statusCode: res.statusCode,
      body: res.json(),
      headers: res.headers,
    };
  };
  const emailOf = async (userId: string): Promise<string | null> => {
    const { data, error } = await db
      .from('users')
      .select('email')
      .eq('id', userId)
      .single();
    // A vanished row or a failed read must fail the test, not read as "no email".
    if (error !== null || data === null)
      throw new Error(`user row missing: ${userId}`);
    return (data.email as string | null) ?? null;
  };

  beforeAll(async () => {
    db = serviceRoleClient();
    await purgeCompany(db, TENANT, ALL);
    const ins = await db.from('users').insert([
      {
        id: U.admin,
        country_code: '+91',
        phone_number: '7770022001',
        email: em('admin'),
        name: 'E2E Link admin',
      },
      {
        id: U.viewer,
        country_code: '+91',
        phone_number: '7770022002',
        email: null,
        name: 'E2E Link viewer',
      },
      {
        id: U.stranger,
        country_code: '+91',
        phone_number: '7770022003',
        email: null,
        name: 'E2E Link stranger',
      },
      {
        id: U.holder,
        country_code: '+91',
        phone_number: '7770022004',
        email: em('holder'),
        name: 'E2E Link holder',
      },
      {
        id: U.prober,
        country_code: '+91',
        phone_number: proberPhone,
        email: null,
        name: 'E2E Link prober',
      },
      {
        id: U.attached,
        country_code: '+91',
        phone_number: '7770022006',
        email: em('attached'),
        name: 'E2E Link attached',
      },
    ]);
    if (ins.error) throw new Error(ins.error.message);
    const t = await db.from('tenants').insert({
      id: TENANT,
      created_by: U.admin,
      company_name: 'E2E Email Link Co',
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
        user_id: U.viewer,
        tenant_id: TENANT,
        role: 'viewer',
        status: 'active',
      },
    ]);
    if (m.error) throw new Error(m.error.message);
    ({ app, jwt } = await bootApp());
  }, 120000);

  afterAll(async () => {
    await app?.close();
    // beforeAll can stop before the client existed (for example the database
    // is down); nothing was seeded yet, so there is nothing to purge.
    if (!db) return;
    await purgeCompany(db, TENANT, ALL);
    const { data } = await db
      .from('users')
      .select('id')
      .like('email', 'e2e-emaillink-new%');
    expect(data ?? []).toEqual([]);
  }, 120000);

  it('links an email to a signed-in viewer and the row carries the lowercase address', async () => {
    const res = await link(U.viewer, {
      email: '  e2E-Emaillink-new-viewer@Example.COM ',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ email: 'e2e-emaillink-new-viewer@example.com' });
    expect(await emailOf(U.viewer)).toBe(
      'e2e-emaillink-new-viewer@example.com',
    );
  });

  it('works for a person with no company membership', async () => {
    const res = await link(U.stranger, {
      email: 'e2e-emaillink-new-stranger@example.test',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      email: 'e2e-emaillink-new-stranger@example.test',
    });
  });

  it('setting the same email again is a no-op that answers 200', async () => {
    // Links on its own first, so the test does not lean on the run order.
    const first = await link(U.viewer, {
      email: 'e2e-emaillink-new-viewer@example.com',
    });
    expect(first.statusCode).toBe(200);

    const res = await link(U.viewer, {
      email: 'e2e-emaillink-new-viewer@example.com',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ email: 'e2e-emaillink-new-viewer@example.com' });
  });

  it('an account that already has a different email cannot change it here', async () => {
    const res = await link(U.attached, {
      email: 'e2e-emaillink-new-attached@example.test',
    });

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error_code: 'DUPLICATE_RESOURCE' });
    expect(await emailOf(U.attached)).toBe(em('attached'));
  });

  it('an account that has an email gets one generic 409 even when the address is also taken', async () => {
    // The admin's own email is set, so the answer is "you already have one"
    // whether or not the asked-for address belongs to someone else — the
    // response never confirms that a third account exists.
    const res = await link(U.admin, { email: em('holder') });

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({
      error_code: 'DUPLICATE_RESOURCE',
      message: 'This account already has an email linked.',
    });
  });

  it(`pauses the prober with 429 after ${EMAIL_LINK_MAX_TAKEN_ANSWERS} taken answers`, async () => {
    for (let i = 0; i < EMAIL_LINK_MAX_TAKEN_ANSWERS; i++) {
      const taken = await link(U.prober, { email: em('holder') });
      expect(taken.statusCode).toBe(409);
      expect(taken.body).toMatchObject({
        error_code: 'DUPLICATE_RESOURCE',
        message: 'That email is already linked to another account.',
      });
    }

    const paused = await link(U.prober, { email: em('holder') });
    expect(paused.statusCode).toBe(429);
    expect(paused.body).toMatchObject({ error_code: 'RATE_LIMIT_EXCEEDED' });
    // The global filter carries the wait as a header, not a body field.
    expect(paused.body).not.toHaveProperty('retryAfterSeconds');
    expect(Number(paused.headers['retry-after'])).toBeGreaterThanOrEqual(1);

    // The pause holds the whole endpoint for this user, not just this address.
    const evenFree = await link(U.prober, {
      email: 'e2e-emaillink-new-prober@example.test',
    });
    expect(evenFree.statusCode).toBe(429);
    expect(await emailOf(U.prober)).toBeNull();
  });

  it('refuses a malformed address with 422 and stores nothing', async () => {
    const res = await link(U.admin, { email: 'not-an-email' });

    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ error_code: 'VALIDATION_ERROR' });
    expect(await emailOf(U.admin)).toBe(em('admin'));
  });

  it('needs a signed-in token at all', async () => {
    const res = await app.inject({
      method: 'POST',
      url: URL_,
      payload: { email: 'e2e-emaillink-new-nobody@example.test' },
    });

    expect(res.statusCode).toBe(401);
  });
});
