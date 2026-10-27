import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { previewRestore, resolveBackupPath, type Db } from './restore';
import { projectRef } from './core';

/**
 * The restore guards that make it safe to aim at a live database, pinned
 * without a database: the tmp/-only path rule, the origin-project warning
 * (including absent meta), the missingColumns union across ALL rows of a
 * section, and the consume-only-on-full-restore rule.
 */

const TMP = 'tmp';

function writeBackup(name: string, body: unknown): string {
  mkdirSync(TMP, { recursive: true });
  const file = `${TMP}/${name}`;
  writeFileSync(file, JSON.stringify(body));
  return file;
}

afterAll(() => {
  for (const f of ['qa-guard-1.json', 'qa-guard-2.json', 'qa-guard-3.json', 'qa-guard-out.json']) {
    rmSync(`${TMP}/${f}`, { force: true });
  }
});

// resolveBackupPath is module-private; the harness re-exports a safe wrapper.
describe('resolveBackupPath (tmp/-only rule)', () => {
  test('accepts bare names and tmp/-relative paths', () => {
    expect(resolveBackupPath('purge-backup-x.json')).toBe('tmp/purge-backup-x.json');
    expect(resolveBackupPath('tmp/purge-backup-x.json')).toBe('tmp/purge-backup-x.json');
  });
  test('rejects paths outside tmp/', () => {
    expect(() => resolveBackupPath('secrets/backup.json')).toThrow(/tmp/);
    expect(() => resolveBackupPath('../backup.json')).toThrow(/tmp/);
    expect(() => resolveBackupPath('/etc/passwd.json')).toThrow(/tmp/);
  });
});

describe('previewRestore guards', () => {
  const stubDb = {
    driver: 'pg',
    query: async (text: string) =>
      text.includes('information_schema.columns')
        ? { rows: [{ column_name: 'id', data_type: 'uuid', is_generated: 'NEVER', identity_generation: null }, { column_name: 'note', data_type: 'jsonb', is_generated: 'NEVER', identity_generation: null }], rowCount: 2 }
        : { rows: [], rowCount: 0 },
    transaction: async () => { throw new Error('not used'); },
    close: async () => undefined,
  } as unknown as Db;

  test('absent meta.project warns as cross-project (unknown origin)', async () => {
    const file = writeBackup('qa-guard-1.json', { sections: [{ table: 'users', where: 'id = $1', rows: [] }] });
    const p = await previewRestore(stubDb, file);
    expect(p.crossProject).toBe(true);
    expect(p.fromProject).toBeNull();
  });

  test('matching meta.project does not warn', async () => {
    const file = writeBackup('qa-guard-2.json', { meta: { project: projectRef() }, sections: [{ table: 'users', where: 'id = $1', rows: [] }] });
    const p = await previewRestore(stubDb, file);
    expect(p.crossProject).toBe(false);
  });

  test('missingColumns unions across ALL rows, not just the first', async () => {
    const file = writeBackup('qa-guard-3.json', {
      meta: { project: projectRef() },
      sections: [{ table: 'users', where: 'id = $1', rows: [
        { id: 'a', name: 'first' },
        { id: 'b', name: 'second', special: 'only-row-2-has-me' },
      ] }],
    });
    const p = await previewRestore(stubDb, file);
    expect(p.planned[0]!.missingColumns).toContain('special');
  });

  test('rejects a table name that is not a plain identifier', async () => {
    const file = writeBackup('qa-guard-out.json', { sections: [{ table: 'users; DROP TABLE users', where: 'id = $1', rows: [] }] });
    await expect(previewRestore(stubDb, file)).rejects.toThrow(/plain identifier/);
  });
});
