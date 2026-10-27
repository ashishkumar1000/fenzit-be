import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { projectRef } from './core';
import type { Db } from './db';

/**
 * restore — brings a purge backup back to life.
 *
 * Backup files are written by purge in child-first (delete) order, so
 * restoring walks them in REVERSE: parents (users, tenants) before the
 * tables that point at them. Inserts are ON CONFLICT DO NOTHING, so a
 * re-run or a partially-present database never errors — it just fills the
 * gaps. Login identities (auth.users) are NOT restored: the tool cannot
 * mint them, so restored people stay logged out until they OTP again (which
 * mints a fresh identity on the same phone).
 *
 * Safety mirrors purge: preview by default, --apply to write. Everything
 * happens in one transaction — a failed restore leaves nothing behind.
 */

interface BackupSection {
  table: string;
  where: string;
  rows?: Record<string, unknown>[];
}

interface Backup {
  meta?: { project?: string; target?: string; scope?: string };
  sections?: BackupSection[];
}

const BACKUP_DIR = 'tmp';

export interface BackupInfo {
  file: string;
  mtime: Date;
  target: string;
  rows: number;
}

export function listBackups(): BackupInfo[] {
  if (!statSync(BACKUP_DIR, { throwIfNoEntry: false })?.isDirectory()) return [];
  const out: BackupInfo[] = [];
  for (const f of readdirSync(BACKUP_DIR)) {
    if (!f.startsWith('purge-backup-') || !f.endsWith('.json')) continue;
    const full = path.join(BACKUP_DIR, f);
    let mtime: Date;
    try {
      mtime = statSync(full).mtime;
    } catch {
      continue; // vanished between readdir and stat — a parallel restore consumed it
    }
    try {
      const parsed = JSON.parse(readFileSync(full, 'utf8')) as Backup;
      const rows = parsed.sections?.reduce((n, s) => n + (s.rows?.length ?? 0), 0) ?? 0;
      out.push({
        file: f,
        mtime,
        target: parsed.meta?.target ?? '(unknown target)',
        rows,
      });
    } catch {
      out.push({ file: f, mtime, target: '(unreadable backup)', rows: 0 });
    }
  }
  return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

export function formatBackupDate(d: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getDate()).padStart(2, '0')} ${months[d.getMonth()]}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export interface RestorePreview {
  file: string;
  targetLine: string | null;
  scopeLine: string | null;
  fromProject: string | null;
  crossProject: boolean;
  planned: Array<{ table: string; rows: number; missingColumns: string[] }>;
  total: number;
}

export function resolveBackupPath(fileArg: string): string {
  const file = fileArg.includes('/')
    ? fileArg
    : path.join(BACKUP_DIR, fileArg.endsWith('.json') ? fileArg : `${fileArg}.json`);
  // Restores only ever read what purge wrote into tmp/ — anything else is a
  // foreign file and must be moved into tmp/ first.
  if (path.dirname(path.resolve(file)) !== path.resolve(BACKUP_DIR)) {
    throw new Error(`Backups must live in ${BACKUP_DIR}/ — move the file there first: ${file}`);
  }
  return file;
}

/** Columns a backup row may write: present in the live table AND not
 *  database-generated (identity-always / generated-always columns refuse
 *  explicit values — attendance_corrections.seq and leave_events.seq).
 *  json/jsonb columns are flagged so their params are cast and re-encoded:
 *  pg hands jsonb back as a parsed JS value, and a bare JSON scalar (e.g.
 *  the string `09:00`) re-inserted as text is not valid JSON syntax. */
async function insertableColumns(db: Db, table: string): Promise<Map<string, string>> {
  const { rows } = await db.query(
    `select column_name, data_type, is_generated, identity_generation
      from information_schema.columns
      where table_schema = 'public' and table_name = $1`,
    [table],
  );
  const out = new Map<string, string>();
  for (const r of rows as Array<{ column_name: string; data_type: string; is_generated: string; identity_generation: string | null }>) {
    if (r.is_generated === 'ALWAYS') continue;
    if (r.identity_generation === 'ALWAYS') continue;
    out.set(r.column_name, r.data_type);
  }
  return out;
}

const isJsonCol = (dataType: string | undefined): boolean => dataType === 'json' || dataType === 'jsonb';

/** Table names from the backup JSON are interpolated into SQL — only plain
 *  identifiers are ever accepted. Column names are filtered against the live
 *  schema, so they are already constrained. */
function assertPlainTable(table: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
    throw new Error(`Backup names a table that is not a plain identifier: "${table}"`);
  }
}

/** Reads the backup and checks every row against the live schema — no writes. */
export async function previewRestore(db: Db, fileArg: string): Promise<RestorePreview> {
  const file = resolveBackupPath(fileArg);
  let backup: Backup;
  try {
    backup = JSON.parse(readFileSync(file, 'utf8')) as Backup;
  } catch {
    throw new Error(`Cannot read backup ${file}`);
  }
  const sections = [...(backup.sections ?? [])].reverse(); // parents first
  if (sections.length === 0) throw new Error(`${file} holds no rows.`);

  const planned: RestorePreview['planned'] = [];
  let total = 0;
  for (const section of sections) {
    assertPlainTable(section.table);
    const cols = await insertableColumns(db, section.table);
    const keys = new Set<string>();
    for (const row of section.rows ?? []) for (const k of Object.keys(row)) keys.add(k);
    const missingColumns = [...keys].filter((k) => !cols.has(k));
    planned.push({ table: section.table, rows: section.rows?.length ?? 0, missingColumns });
    total += section.rows?.length ?? 0;
  }  const meta = backup.meta ?? {};
  return {
    file,
    targetLine: meta.target ?? null,
    scopeLine: meta.scope ?? null,
    fromProject: meta.project ?? null,
    crossProject: meta.project !== projectRef(),
    planned,
    total,
  };
}

export function printPreview(preview: RestorePreview): void {
  console.log(`project ${projectRef()} · restore from ${preview.file}`);
  if (preview.targetLine) {
    console.log(`Backed up from: ${preview.targetLine}${preview.scopeLine ? ` — ${preview.scopeLine}` : ''}`);
  }
  if (preview.crossProject) {
    console.log(preview.fromProject
      ? `Backup is from project ${preview.fromProject}; you are on ${projectRef()}. Stop and check before --apply.`
      : `Backup has no origin project recorded (hand-edited or legacy) — stop and check before --apply.`);
  }
  for (const p of preview.planned) {
    console.log(`  ${p.table}: ${p.rows} row(s)${p.missingColumns.length ? ` (skipped columns: ${p.missingColumns.join(', ')})` : ''}`);
  }
  console.log(`  total: ${preview.total} row(s), parents inserted first, existing rows skipped.`);
}

/** Inserts every backup row, parents first, one transaction, ON CONFLICT DO
 *  NOTHING. On a FULL restore (every row inserted) the backup file is deleted
 *  — consumed, and keeping it invites restoring the same rows twice. When any
 *  row was skipped (a unique conflict against different rows, not merely a
 *  re-restore) the backup is KEPT so the difference stays recoverable. Only
 *  files inside tmp/ that purge wrote are ever removed. */
export async function applyRestore(
  db: Db,
  fileArg: string,
): Promise<{ inserted: number; total: number; backupDeleted: boolean; backupPath: string }> {
  const preview = await previewRestore(db, fileArg);
  const backup = JSON.parse(readFileSync(preview.file, 'utf8')) as Backup;
  const sections = [...(backup.sections ?? [])].reverse();
  const inserted = await db.transaction(async (tx) => {
    let n = 0;
    for (const section of sections) {
      assertPlainTable(section.table);
      const cols = await insertableColumns(tx, section.table);
      for (const row of section.rows ?? []) {
        const keys = Object.keys(row).filter((k) => cols.has(k));
        if (keys.length === 0) continue;
        const placeholders = keys.map((k, i) => (isJsonCol(cols.get(k)) ? `$${i + 1}::jsonb` : `$${i + 1}`));
        const res = await tx.query(
          `INSERT INTO public.${section.table} (${keys.map((k) => `"${k}"`).join(', ')})
           VALUES (${placeholders.join(', ')})
           ON CONFLICT DO NOTHING`,
          keys.map((k) => (isJsonCol(cols.get(k)) ? JSON.stringify(row[k] ?? null) : row[k])),
        );
        n += res.rowCount;
      }
    }
    return n;
  });
  const backupPath = preview.file;
  let backupDeleted = false;
  if (
    inserted === preview.total &&
    backupPath.startsWith(`${BACKUP_DIR}/`) &&
    path.basename(backupPath).startsWith('purge-backup-')
  ) {
    try {
      rmSync(backupPath);
      backupDeleted = true;
    } catch {
      // Data is already restored; a stuck backup file is a warning, not a failure.
    }
  }
  return { inserted, total: preview.total, backupDeleted, backupPath };
}

/** Headless glue: listing, preview, or apply — the interactive shell calls the pieces directly. */
export async function runRestore(db: Db, fileArg?: string, apply = false): Promise<void> {
  if (!fileArg) {
    const backups = listBackups();
    if (backups.length === 0) {
      console.log('No backups in tmp/ yet — purge writes one before every delete.');
      return;
    }
    console.log(`Backups in ${BACKUP_DIR}/ (newest first) — restore one with: super restore <file>`);
    for (const b of backups) {
      console.log(`  ${b.file}  ·  ${formatBackupDate(b.mtime)}  ·  ${b.rows} rows  ·  ${b.target}`);
    }
    return;
  }
  const preview = await previewRestore(db, fileArg);
  printPreview(preview);
  if (!apply) {
    console.log('Dry run — rerun with --apply to insert.');
    return;
  }
  console.log(`Inserting ${preview.total} rows…`);
  const { inserted, total, backupDeleted, backupPath } = await applyRestore(db, fileArg);
  console.log(
    inserted === total
      ? `Restored all ${total} rows.`
      : `Restored ${inserted} of ${total} rows — ${total - inserted} conflicted with rows already here; the backup was kept.`,
  );
  console.log(backupDeleted
    ? `Backup consumed and deleted: ${backupPath}`
    : `Backup kept: ${backupPath}`);
  console.log('Logins and inviter links are not restored — each person\'s next OTP mints a fresh identity on the same number.');
}
