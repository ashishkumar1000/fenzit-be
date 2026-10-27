import { render } from 'ink';
import { makePgDb, type Db } from './super/db';
import {
  describe,
  envOrThrow,
  findByPhone,
  formatListRow,
  listUsers,
  parsePhone,
  projectRef,
  statsLines,
  whoisLines,
  type Target,
} from './super/core';
import { executePurge, preparePurge } from './super/purge';
import { mintAccessToken, setDisabled, setStaff, staffCount } from './super/accounts';
import { PurgeApp } from './super/purge-ui';
import { runRestore } from './super/restore';

/**
 * super — the owner-only CLI for dirty, dangerous jobs the product APIs
 * must never offer.
 *
 * Bare `bun run super` on a terminal opens the interactive menu (ink):
 * every command becomes a guided flow. With explicit arguments the same
 * commands run headless for scripting — dry-run by default, --apply
 * executes, purge always writes a JSON backup first, restore brings one
 * back (logins excepted).
 */

const HELP = `super — owner-only CLI · project {PROJECT}

  Run without arguments on a terminal for the interactive menu.

  whois <phone>            full report on one person (read-only)
  list <fragment>          find people by phone/name fragment (read-only)
  stats                    global row counts (read-only)
  purge <phone> [--apply]  DELETE a person — owner: whole company (people,
                           customers, jobs, attendance, audit); technician:
                           that person only. Interactive confirm on a terminal;
                           always writes a JSON backup to tmp/ first.
  restore [file] [--apply] list backups in tmp/ (or inspect one); --apply
                           re-inserts its rows, parents first, skipping rows
                           that already exist, and deletes the consumed backup.
                           Logins are not restored.
  promote <phone> [--apply]   make fenzit staff (platform_admin)
  demote  <phone> [--apply]   revoke fenzit staff
  disable <phone> [--apply]   block app login (reversible)
  enable  <phone> [--apply]   unblock app login
  token  <phone>           mint an app login JWT for this person (debug as them)`;

async function resolveTarget(db: Db, cmd: string, phoneArg?: string): Promise<Target> {
  if (!phoneArg) throw new Error(`usage: super ${cmd} <phone>  (super help lists commands)`);
  const target = await findByPhone(db, parsePhone(phoneArg));
  if (!target) {
    throw new Error('No person with that number — find it with: super list <fragment>');
  }
  if (target.kind === 'staff' && cmd !== 'demote') {
    throw new Error(`${describe(target)} is staff — staff accounts are never touched by this tool.`);
  }
  return target;
}

async function runPurge(db: Db, phoneArg?: string, apply = false): Promise<void> {
  const prepared = await preparePurge(db, phoneArg);
  if (!apply && process.stdout.isTTY) {
    const { waitUntilExit } = render(
      <PurgeApp
        targetLine={describe(prepared.target)}
        scopeLine={prepared.scope + ':'}
        counts={prepared.counts}
        missingTables={prepared.missingTables}
        total={prepared.total}
        run={(report) => executePurge(db, prepared, report)}
      />,
      { exitOnCtrlC: false },
    );
    await waitUntilExit();
    // The ink screen vanishes on exit — leave the pointer where the backup
    // lives, so the receipt survives the unmount.
    console.log('Backups live in tmp/ — bring one back with: super restore');
    return;
  }
  console.log(`target ${describe(prepared.target)}\nWill delete ${prepared.scope}:`);
  for (const c of prepared.counts) if (c.n > 0) console.log(`  ${c.table}: ${c.n}`);
  if (prepared.missingTables.length > 0) {
    console.log(`  (skipped, absent or different shape here: ${prepared.missingTables.join(', ')})`);
  }
  if (!apply) {
    console.log('Dry run — rerun with --apply to delete.');
    return;
  }
  console.log('--apply: deleting now…');
  const r = await executePurge(db, prepared, { phase: () => undefined, step: () => undefined });
  console.log(`Deleted ${r.deletedRows} rows. Logins removed: ${r.loginsRemoved} (${r.loginsSkipped} ${r.loginsSkipped === 1 ? 'was' : 'were'} already gone).`);
  console.log(`Backup: ${r.backupPath} (${r.backupRows} rows)`);
  console.log(`Bring it back with: super restore ${r.backupPath.split('/').pop()}`);
}

const FLAG_VERBS: Record<'promote' | 'demote' | 'disable' | 'enable', { done: string; will: string }> = {
  promote: { done: 'made fenzit staff', will: 'make fenzit staff' },
  demote: { done: 'revoked fenzit staff', will: 'revoke fenzit staff' },
  disable: { done: 'blocked login', will: 'block login' },
  enable: { done: 'unblocked login', will: 'unblock login' },
};

async function runFlag(
  db: Db,
  cmd: 'promote' | 'demote' | 'disable' | 'enable',
  phoneArg?: string,
  apply = false,
): Promise<void> {
  const target = await resolveTarget(db, cmd, phoneArg);
  const column = cmd === 'promote' || cmd === 'demote' ? 'platform_admin' : 'disabled';
  const flagKey = column === 'platform_admin' ? 'platformAdmin' : 'disabled';
  // promote and disable turn their flag ON; demote and enable turn it OFF.
  const value = cmd === 'promote' || cmd === 'disable';
  if (target[flagKey] === value) {
    console.log(`${describe(target)} already has ${column}=${value} — nothing to do.`);
    return;
  }
  if (cmd === 'demote') {
    const n = await staffCount(db);
    if (n <= 1) {
      console.log('WARNING: this is the last fenzit staff account — demoting it could lock you out of this CLI and staff tools.');
    }
  }
  if (!apply) {
    console.log(`Dry run — will ${FLAG_VERBS[cmd].will}: ${describe(target)}. Rerun with --apply.`);
    return;
  }
  if (column === 'platform_admin') await setStaff(db, target, value);
  else await setDisabled(db, target, value);
  console.log(`Done: ${FLAG_VERBS[cmd].done} — ${describe(target)} (${column}=${value}).`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const positional = args.filter((a, i) => i > 0 && !a.startsWith('--'));
  const phoneArg = positional[0];
  const apply = args.includes('--apply');
  if (positional.length > 1) {
    throw new Error(`usage: super ${cmd ?? '<command>'} takes exactly one <phone-or-fragment> argument`);
  }
  const unknownFlags = args.filter((a) => a.startsWith('--') && a !== '--apply' && !a.includes('help'));
  if (unknownFlags.length > 0) {
    throw new Error(`unknown flag "${unknownFlags[0]}" — did you mean --apply? (a typo'd flag silently stays a dry run)`);
  }
  if (args.includes('--help')) {
    console.log(HELP.replace('{PROJECT}', projectRef()));
    return;
  }
  if (!cmd) {
    if (process.stdout.isTTY) {
      envOrThrow();
      const db = makePgDb(process.env['DATABASE_URL']!);
      try {
        const { SuperApp } = await import('./super/interactive');
        const { waitUntilExit } = render(<SuperApp db={db} />, { exitOnCtrlC: false });
        await waitUntilExit();
      } finally {
        await db.close();
      }
    } else {
      console.log(HELP.replace('{PROJECT}', projectRef()));
    }
    return;
  }
  if (cmd === 'help') {
    console.log(HELP.replace('{PROJECT}', projectRef()));
    return;
  }
  envOrThrow();
  const db = makePgDb(process.env['DATABASE_URL']!);
  try {
    console.log(`project ${projectRef()}`);
    if (cmd === 'purge') await runPurge(db, phoneArg, apply);
    else if (cmd === 'promote' || cmd === 'demote' || cmd === 'disable' || cmd === 'enable') {
      await runFlag(db, cmd, phoneArg, apply);
    } else if (cmd === 'whois' || cmd === 'token') {
      // Read-only commands may look at anyone, staff included — the staff rail
      // only forbids WRITES.
      if (!phoneArg) throw new Error(`usage: super ${cmd} <phone>  (super help lists commands)`);
      const target = await findByPhone(db, parsePhone(phoneArg));
      if (!target) {
        throw new Error('No person with that number — find it with: super list <fragment>');
      }
      if (cmd === 'whois') {
        for (const l of await whoisLines(db, target)) console.log(l);
      } else {
        if (target.disabled) {
          console.log('WARNING: this account is disabled — logins will reject this token\'s session.');
        }
        if (target.platformAdmin) {
          console.log('WARNING: STAFF account — this token carries staff-level access.');
        }
        console.log(`App token for ${describe(target)} (no expiry — the backend's own tokens have none):`);
        console.log(mintAccessToken(target));
      }
    } else if (cmd === 'restore') {
      await runRestore(db, phoneArg, apply);
    } else if (cmd === 'list') {
      if (!phoneArg) {
        console.log('usage: super list <phone or name fragment>');
        return;
      }
      const rows = await listUsers(db, phoneArg);
      for (const r of rows) console.log(formatListRow(r));
      console.log(rows.length === 20 ? '  20 shown (list limit — narrow the search)' : rows.length === 0 ? '  (no match)' : `  ${rows.length} shown`);
    } else if (cmd === 'stats') {
      for (const l of await statsLines(db)) console.log(l);
    } else {
      console.log(`Unknown command "${cmd}"\n${HELP.replace('{PROJECT}', projectRef())}`);
      process.exitCode = 1;
    }
  } finally {
    await db.close();
  }
}

main().catch((e: unknown) => {
  console.error(`ERROR: ${e instanceof Error ? e.message : e}`);
  console.error(`(project ${projectRef()} — nothing else was written unless you saw ✓ lines, "Done:" or "Restored" above. A failed purge may still have left tmp/purge-backup-*.json and removed logins — rerun the same command to finish; it skips what is done.)`);
  process.exit(1);
});
