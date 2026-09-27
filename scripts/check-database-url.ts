import { Pool } from 'pg';

/**
 * One-shot connectivity check for DATABASE_URL (15-7 prereq). Prints nothing
 * sensitive — connection outcome, object visibility, and the two existing
 * helpers the pg-backed service calls inside a rolled-back transaction.
 * Run: bun scripts/check-database-url.ts   (bun auto-loads .env)
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

try {
  const info = await pool.query('select current_database() as db, current_user as usr');
  console.log('CONNECTED as', info.rows[0].usr, 'to db', info.rows[0].db);

  const objs = await pool.query(`
    select c.relname, c.relkind
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('attendance_enrolments','attendance_office_assignments',
                        'attendance_onboarding','attendance_access_state')
    order by c.relname`);
  console.log(
    'objects visible:',
    objs.rows.map((r) => `${r.relname}:${r.relkind}`).join(', ') || 'NONE',
  );

  const view = await pool.query('select count(*)::int as n from public.attendance_access_state');
  console.log('access view readable, rows:', view.rows[0].n);

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `select public.attendance_lock_tenant(t.tenant_id, false)
       from (select tenant_id from public.attendance_settings limit 1) t`,
    );
    console.log('AD-5 lock helper callable in txn: ok');
    const today = await client.query(
      `select public.attendance_today(t.tenant_id)::text as today
       from (select tenant_id from public.attendance_settings limit 1) t`,
    );
    console.log('attendance_today resolves (tenant tz):', today.rows[0]?.today ?? 'no tenant row');
  } finally {
    await client.query('rollback');
    client.release();
  }
  console.log('ALL CHECKS PASSED');
} catch (e) {
  console.error('FAILED:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
