import crypto from 'node:crypto';
import type { Db } from './db';
import { writeAudit, type Target } from './core';

/**
 * Account-level super operations. Each write flips one flag on users and
 * appends an audit row (actor = the target, marked platform-admin, details
 * name the CLI) so the append-only history keeps answering "who changed
 * what" even for out-of-band changes.
 */

async function flipFlag(
  db: Db,
  target: Target,
  column: 'platform_admin' | 'disabled',
  value: boolean,
  action: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(`UPDATE public.users SET ${column} = $2 WHERE id = $1`, [target.id, value]);
    // The audit row records the actor's staff status AFTER the flip — a
    // demote must not attribute staff authority to someone who just lost it.
    const actorIsStaff = column === 'platform_admin' ? value : target.platformAdmin;
    await writeAudit(tx, target.id, action, {
      via: 'super-cli',
      phone: `${target.countryCode}${target.phoneNumber}`,
      [column]: value,
    }, actorIsStaff);
  });
}

export async function setStaff(db: Db, target: Target, staff: boolean): Promise<void> {
  await flipFlag(db, target, 'platform_admin', staff, staff ? 'cli.promote_staff' : 'cli.demote_staff');
}

export async function setDisabled(db: Db, target: Target, disabled: boolean): Promise<void> {
  await flipFlag(db, target, 'disabled', disabled, disabled ? 'cli.disable' : 'cli.enable');
}

/** How many staff accounts exist — used to warn before demoting the last one. */
export async function staffCount(db: Db): Promise<number> {
  const { rows } = await db.query(
    'select count(*)::int as n from public.users where platform_admin',
  );
  return Number(rows[0].n);
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Mints the same access token the backend signs: HS256, payload
 * { sub, typ: 'access' }, no exp (app.module registers JwtModule without
 * expiresIn). Opens the mobile/web app as this person for debugging.
 */
export function mintAccessToken(target: Target): string {
  const secret = process.env['SUPABASE_JWT_SECRET'];
  if (!secret) {
    throw new Error('Missing SUPABASE_JWT_SECRET in env — needed to sign an app token.');
  }
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ sub: target.id, typ: 'access' }));
  const signature = b64url(
    crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${signature}`;
}
