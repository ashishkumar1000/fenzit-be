/**
 * confirm_attachment photo auto-advance — real-DB regression probes for the
 * 2026-10-02 technician-flow QA fix (migration
 * 20261002220000_confirm_auto_advance_any_photo).
 *
 * The auto-advance gate lives in the SQL function; the mocked e2e specs only
 * pin the HTTP boundary around it (the rpc mock would just test itself), so
 * these probes call confirm_attachment directly against a REAL database:
 *
 *   Probe 1 — the fixed dead-end (JB-2026-0004): a photo confirmed BEFORE the
 *   job reaches photos_uploaded (so the count is already >= 1 when it does)
 *   must not stop the step advancing on a later confirm AT it. Under the
 *   pre-fix first-photo-only gate the final assertion failed — the job stuck
 *   at in_progress with a dead "Upload a photo to continue" pill.
 *
 *   Probe 2 — over-advance guard: once current_step IS photos_uploaded,
 *   further confirms must not move the job again (the delegated
 *   advance_workflow_step's predecessor compare-and-set).
 *
 * Requires real credentials — gated like 16-1 (SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY not the jest.env.setup.ts stubs; run via
 * `npm run test:e2e:real` or a scoped jest invocation with --env-file=.env).
 * Fixtures are self-contained (throwaway tenant, Date.now-keyed probe phones)
 * and removed in afterAll.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const IS_REAL_DB =
  SUPABASE_URL !== '' &&
  !SUPABASE_URL.includes('test.supabase.co') &&
  SUPABASE_SERVICE_ROLE_KEY !== '' &&
  !SUPABASE_SERVICE_ROLE_KEY.includes('test-service-role-key');

const TENANT = randomUUID();
const OWNER = randomUUID();
const TECH = randomUUID();
const CUSTOMER = randomUUID();
const JOB_DEADEND = randomUUID();
const JOB_GUARD = randomUUID();

/** Unique probe phones (16-1 pattern) — [0] owner, [1] technician. */
const PHONES = [0, 1].map((i) => `7${Date.now()}2${i}`.slice(-10));

let admin: SupabaseClient;

/** A v1-shaped template (any 6-step chain with a photo_confirm step), plus an
 *  active skill id — read from the seeded catalog, not duplicated here. */
let templateId: string;
let templateVersion: number;
let skillId: string;

async function insertJob(jobId: string, jobNumber: string): Promise<void> {
  const { error } = await admin.from('jobs').insert({
    id: jobId,
    tenant_id: TENANT,
    job_number: jobNumber,
    customer_id: CUSTOMER,
    technician_id: TECH,
    skill_id: skillId,
    workflow_template_id: templateId,
    workflow_template_version: templateVersion,
    service_location: 'QA probe — photo auto-advance',
    scheduled_start: new Date().toISOString(),
    status: 'scheduled',
    current_step: null,
  });
  expect(error).toBeNull();
}

/** Stages one pending photo upload and confirms it through the RPC. */
async function confirmPhoto(jobId: string): Promise<void> {
  const uploadId = randomUUID();
  const { error: insertError } = await admin.from('attachment_uploads').insert({
    id: uploadId,
    job_id: jobId,
    tenant_id: TENANT,
    r2_key: `${TENANT}/qa-probe/${uploadId}.jpg`,
    attachment_type: 'photo',
    mime_type: 'image/jpeg',
    status: 'pending',
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  });
  expect(insertError).toBeNull();

  const { error: rpcError } = await admin.rpc('confirm_attachment', {
    p_upload_id: uploadId,
    p_job_id: jobId,
    p_tenant_id: TENANT,
    p_size_bytes: 1024,
    p_actor_id: TECH,
  });
  expect(rpcError).toBeNull();
}

async function currentStep(jobId: string): Promise<string | null> {
  const { data, error } = await admin
    .from('jobs')
    .select('current_step, status')
    .eq('id', jobId)
    .single<{ current_step: string | null; status: string }>();
  expect(error).toBeNull();
  return data.current_step;
}

/** Advances the job through on_my_way → arrived → in_progress via the real
 *  RPC (the same delegated path confirm_attachment uses). */
async function walkToInProgress(jobId: string): Promise<void> {
  const chain: Array<[string, string | null]> = [
    ['on_my_way', null],
    ['arrived', 'on_my_way'],
    ['in_progress', 'arrived'],
  ];
  for (const [step, expected] of chain) {
    const { error } = await admin.rpc('advance_workflow_step', {
      p_job_id: jobId,
      p_tenant_id: TENANT,
      p_actor_id: TECH,
      p_step: step,
      p_new_status: step === 'on_my_way' ? 'in_progress' : null,
      p_expected_current_step: expected,
    });
    expect(error).toBeNull();
  }
}

beforeAll(async () => {
  admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Pick a seeded template whose chain actually carries a photo_confirm step
  // (every v1 seed does) and any active skill for the NOT NULL stamp columns.
  const { data: templates, error: tplError } = await admin
    .from('workflow_templates')
    .select('id, version, steps')
    .limit(50);
  expect(tplError).toBeNull();
  const withPhoto = (templates ?? []).find((t) =>
    ((t.steps as Array<Record<string, unknown>>) ?? []).some(
      (s) => s['advances_on'] === 'photo_confirm',
    ),
  );
  expect(withPhoto).toBeDefined();
  templateId = withPhoto!.id;
  templateVersion = withPhoto!.version;

  const { data: skill, error: skillError } = await admin
    .from('skills')
    .select('id')
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();
  expect(skillError).toBeNull();
  expect(skill).not.toBeNull();
  skillId = skill!.id;

  // Throwaway tenant shell + users (16-1 fixture shape): the owner user goes
  // in FIRST (tenants.owner_id → users.id while users.tenant_id → tenants.id —
  // same chicken-and-egg the attendance probes solve), then the tenant, then
  // the link + the technician. state_code is NOT NULL on tenants.
  const { error: ownerError } = await admin.from('users').insert({
    id: OWNER,
    country_code: '+91',
    phone_number: PHONES[0],
    name: 'QA Owner',
    role: 'owner',
    status: 'active',
  });
  expect(ownerError).toBeNull();

  const { error: tenantError } = await admin
    .from('tenants')
    .insert({ id: TENANT, company_name: 'QA Photo Auto-Advance', owner_id: OWNER, state_code: 'KA' });
  expect(tenantError).toBeNull();

  await admin.from('users').update({ tenant_id: TENANT }).eq('id', OWNER);

  const { error: techError } = await admin.from('users').insert({
    id: TECH,
    country_code: '+91',
    phone_number: PHONES[1],
    name: 'QA Tech',
    role: 'technician',
    status: 'active',
    tenant_id: TENANT,
  });
  expect(techError).toBeNull();

  const { error: customerError } = await admin.from('customers').insert({
    id: CUSTOMER,
    tenant_id: TENANT,
    name: 'QA Customer',
    country_code: '+91',
    phone_number: '9999990001',
  });
  expect(customerError).toBeNull();

  await insertJob(JOB_DEADEND, `QA-${randomUUID().slice(0, 8)}`);
  await insertJob(JOB_GUARD, `QA-${randomUUID().slice(0, 8)}`);
});

afterAll(async () => {
  if (!IS_REAL_DB) return;
  // FK-safe order: logs/notifications → attachments → uploads → jobs →
  // customers → users → tenants.
  await admin.from('activity_logs').delete().in('job_id', [JOB_DEADEND, JOB_GUARD]);
  await admin.from('notifications').delete().eq('tenant_id', TENANT);
  await admin.from('attachments').delete().in('job_id', [JOB_DEADEND, JOB_GUARD]);
  await admin.from('attachment_uploads').delete().in('job_id', [JOB_DEADEND, JOB_GUARD]);
  await admin.from('jobs').delete().in('id', [JOB_DEADEND, JOB_GUARD]);
  await admin.from('customers').delete().eq('id', CUSTOMER);
  await admin.from('users').delete().in('id', [OWNER, TECH]);
  await admin.from('tenants').delete().eq('id', TENANT);
});

describe('confirm_attachment photo auto-advance (real DB)', () => {
  const maybeIt = IS_REAL_DB ? it : it.skip;

  maybeIt(
    'Probe 1 — an early photo does not dead-end the photo step (the 2026-10-02 fix)',
    async () => {
      // The early upload: confirmed while the job is FRESH (current_step
      // null — before the photo step's predecessor). No advance may fire
      // (the CAS compares against in_progress), and the count is now 1.
      await confirmPhoto(JOB_DEADEND);
      expect(await currentStep(JOB_DEADEND)).toBeNull();

      // Walk to the photo step's predecessor.
      await walkToInProgress(JOB_DEADEND);
      expect(await currentStep(JOB_DEADEND)).toBe('in_progress');

      // THE FIX: the second confirm (count 2 under the old first-photo-only
      // gate) must advance the step.
      await confirmPhoto(JOB_DEADEND);
      expect(await currentStep(JOB_DEADEND)).toBe('photos_uploaded');

      // The delegated advance logged the step (identical to a manual one).
      const { data: logs, error } = await admin
        .from('activity_logs')
        .select('event_type')
        .eq('job_id', JOB_DEADEND)
        .eq('event_type', 'step_photos_uploaded');
      expect(error).toBeNull();
      expect(logs).toHaveLength(1);
    },
    30_000,
  );

  maybeIt(
    'Probe 2 — a confirm while AT photos_uploaded does not over-advance',
    async () => {
      await walkToInProgress(JOB_GUARD);
      await confirmPhoto(JOB_GUARD);
      expect(await currentStep(JOB_GUARD)).toBe('photos_uploaded');

      // A later confirm at the step must leave the job where it is — the
      // predecessor CAS (current_step is no longer in_progress).
      await confirmPhoto(JOB_GUARD);
      expect(await currentStep(JOB_GUARD)).toBe('photos_uploaded');
    },
    30_000,
  );
});
