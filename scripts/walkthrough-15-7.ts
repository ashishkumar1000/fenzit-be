import jwt from 'jsonwebtoken';

/**
 * Story 15-7 live walkthrough — real HTTP against the running dev server and
 * the real DB (Business tenant; cleaned up by SQL afterwards).
 * Run: bun scripts/walkthrough-15-7.ts   (server on :3000)
 */
const BASE = 'http://localhost:3000/api/v1';
const TENANT = '792b28ed-522f-483e-8c6a-3bb8ce859a27';
const TECH = '5ab74a2f-6bf9-4b13-9a1d-b8e49748da2a';
const OWNER = 'f5864f60-d46b-4d20-a616-cb5dd837117c';
const OFFICE_A = 'c597dde7-6dfa-46c6-b0c9-65b17cad6a9e';
const OFFICE_B = '82b80353-8fad-4559-8ae9-5666f808fe57';

const secret = process.env.SUPABASE_JWT_SECRET!;
const ownerJwt = jwt.sign({ sub: OWNER, tenantId: TENANT, role: 'owner' }, secret);
const techJwt = jwt.sign({ sub: TECH, tenantId: TENANT, role: 'technician' }, secret);

let step = 0;
async function call(label: string, method: string, path: string, token: string, body?: unknown) {
  step += 1;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined
      ? { authorization: `Bearer ${token}` }
      : { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`${step}. ${label} → ${res.status}`);
  if (text) console.log(`   ${text.slice(0, 400)}`);
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

await call('GET /attendance/enrolments (empty roster)', 'GET', '/attendance/enrolments', ownerJwt);
await call('POST /attendance/setup (start wizard)', 'POST', '/attendance/setup', ownerJwt);
await call(
  'PUT /attendance/enrolments/:tech (enable @ Yuka, today)',
  'PUT',
  `/attendance/enrolments/${TECH}`,
  ownerJwt,
  { officeId: OFFICE_A, startDate: '2026-09-28' },
);
await call('POST /attendance/setup/complete (Gate 2: tracked employee @ live office)', 'POST', '/attendance/setup/complete', ownerJwt);
await call('GET /attendance/me/access (Arya — expect active)', 'GET', '/attendance/me/access', techJwt);
await call('POST /attendance/me/onboarding (Arya)', 'POST', '/attendance/me/onboarding', techJwt);
await call('POST /attendance/me/onboarding (replay — idempotent)', 'POST', '/attendance/me/onboarding', techJwt);
await call('GET /users/me (Arya — attendance mirror)', 'GET', '/users/me', techJwt);
await call(
  "PUT /attendance/enrolments/:tech/office (reassign → Yuka1)",
  'PUT',
  `/attendance/enrolments/${TECH}/office`,
  ownerJwt,
  { officeId: OFFICE_B },
);
await call('DELETE /attendance/enrolments/:tech (disable — history kept)', 'DELETE', `/attendance/enrolments/${TECH}`, ownerJwt);
await call('GET /attendance/enrolments (roster — expect history_only @ Yuka1)', 'GET', '/attendance/enrolments', ownerJwt);
await call('GET /attendance/me/access (Arya — expect history_only)', 'GET', '/attendance/me/access', techJwt);
