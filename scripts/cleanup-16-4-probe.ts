import { Pool } from 'pg';

/** One-off cleanup for orphaned probe fixtures (failed probe runs). */
const pool = new Pool({
  connectionString: process.env['DATABASE_URL'],
  ssl: { rejectUnauthorized: false },
  max: 1,
});

const tenants = await pool.query(
  `select id from public.tenants where company_name like $1`,
  ['16-4 summary today probe%'],
);
for (const row of tenants.rows) {
  await pool.query(`delete from public.tenants where id = $1`, [row.id]);
  console.log('deleted tenant', row.id);
}
const users = await pool.query(`select id from public.users where name like $1`, [
  '16-4 probe%',
]);
for (const row of users.rows) {
  await pool.query(`delete from public.users where id = $1`, [row.id]);
  console.log('deleted user', row.id);
}
await pool.end();
console.log('cleanup done');
