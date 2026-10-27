import { Box, Text, useApp, useInput } from 'ink';
import { Alert, ConfirmInput, Spinner, StatusMessage } from '@inkjs/ui';
import { useCallback, useEffect, useState } from 'react';
import { describe, findByPhone, parsePhone, type Target } from './core';
import { executePurge, preparePurge } from './purge';
import { setDisabled, setStaff, staffCount } from './accounts';
import { applyRestore, formatBackupDate, listBackups, previewRestore } from './restore';
import type { Db } from './db';
import { PurgeApp } from './purge-ui';
import {
  C,
  ErrorLine,
  Frame,
  MenuList,
  OnMenu,
  Panel,
  PhoneInput,
  TargetBadges,
  Wordmark,
  type MenuItem,
} from './ui';
import { ListView, StatsView, TokenView } from './views';
import { WhoisView } from './whois-view';

/**
 * The interactive shell behind bare `bun run super`. Number-addressable
 * launcher menu (1–9/0, q, arrows/jk, g/G), every command a guided flow.
 * Escape always walks back one level and — from a result screen — leaves a
 * one-line receipt ("last: …") on the menu so verdicts survive navigation.
 * Explicit arguments (`super whois <phone>`) stay headless for scripting.
 */

type View =
  | { name: 'menu' }
  | { name: 'whois' }
  | { name: 'list' }
  | { name: 'stats' }
  | { name: 'purge' }
  | { name: 'restore' }
  | { name: 'promote' }
  | { name: 'demote' }
  | { name: 'disable' }
  | { name: 'enable' }
  | { name: 'token' };

const INSPECT = { label: 'INSPECT', color: C.cyan };
const DANGER = { label: 'DANGER', color: C.red };
const ACCOUNT = { label: 'ACCOUNT', color: C.amber };

const MENU_ITEMS: MenuItem[] = [
  { value: 'whois', label: 'Whois', description: 'full report on one person', color: C.green, section: INSPECT },
  { value: 'list', label: 'List', description: 'find people by phone or name', color: C.green, section: INSPECT },
  { value: 'stats', label: 'Stats', description: 'every table that matters', color: C.green, section: INSPECT },
  { value: 'purge', label: 'Purge', description: 'delete a person — owners take the whole company', color: C.red, section: DANGER },
  { value: 'restore', label: 'Restore', description: 'bring a purge backup back', color: C.amber, section: DANGER },
  { value: 'promote', label: 'Promote', description: 'make fenzit staff', color: C.amber, section: ACCOUNT },
  { value: 'demote', label: 'Demote', description: 'revoke fenzit staff', color: C.amber, section: ACCOUNT },
  { value: 'disable', label: 'Disable', description: 'block app login', color: C.amber, section: ACCOUNT },
  { value: 'enable', label: 'Enable', description: 'unblock app login', color: C.amber, section: ACCOUNT },
  { value: 'token', label: 'Token', description: 'mint an app login JWT (debug as this person)', color: C.green, section: ACCOUNT },
  { value: 'quit', label: 'Quit', description: 'leave the tool', color: C.slate, index: 'q' },
];

const MENU_HINT = '1-9,0 pick · q quit · ↑↓/jk move · enter pick · ctrl+c quit';

const FLAG_TITLES = {
  promote: 'PROMOTE — make fenzit staff',
  demote: 'DEMOTE — revoke fenzit staff',
  disable: 'DISABLE — block app login',
  enable: 'ENABLE — unblock app login',
} as const;

function PurgeView({ db, onMenu }: { db: Db; onMenu: OnMenu }) {
  const { exit } = useApp();
  const [phone, setPhone] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Awaited<ReturnType<typeof preparePurge>> | null>(null);
  const [error, setError] = useState('');
  useInput((input, key) => {
    if (key.escape && !phone) onMenu();
    if (key.ctrl && input === 'c' && !prepared) exit();
  });
  const start = useCallback(async (value: string) => {
    setError('');
    setPhone(value);
    try {
      setPrepared(await preparePurge(db, value));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhone(null);
    }
  }, [db]);
  if (!phone) {
    return (
      <Frame title="PURGE" subtitle="see exactly what a delete removes — nothing happens yet" accent={C.red} hint="esc — menu · ctrl+c — quit">
        <Text>Type a number to arm the plan. The confirm screen names every table before anything is touched.</Text>
        {error && <ErrorLine message={error} />}
        <PhoneInput label="Phone" onSubmit={(v) => void start(v)} />
      </Frame>
    );
  }
  if (!prepared) {
    return <Frame title="PURGE" accent={C.red} hint={null}><Spinner label={`Preparing the plan for +91 ${phone}…`} /></Frame>;
  }
  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <PurgeApp
        targetLine={describe(prepared.target)}
        scopeLine={prepared.scope + ':'}
        counts={prepared.counts}
        missingTables={prepared.missingTables}
        total={prepared.total}
        onFinished={onMenu}
        run={(report) => executePurge(db, prepared, report)}
      />
    </Box>
  );
}

function RestoreView({ db, onMenu }: { db: Db; onMenu: OnMenu }) {
  const [backups, setBackups] = useState<ReturnType<typeof listBackups> | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewRestore>> | null>(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState('');
  const toPicker = useCallback(() => {
    setPicked(null);
    setPreview(null);
    setError('');
  }, []);
  useInput((input, key) => {
    if (key.escape && !applying) {
      if (picked) toPicker();
      else onMenu(result ? `restore — ${result}` : undefined);
    }
    if (input === 'b' && picked && !applying) toPicker();
  });
  useEffect(() => {
    setBackups(listBackups());
  }, []);
  const choose = useCallback(async (file: string) => {
    setError('');
    setPicked(file);
    try {
      setPreview(await previewRestore(db, file));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPicked(null);
    }
  }, [db]);
  const apply = useCallback(async () => {
    if (!picked) return;
    setApplying(true);
    try {
      const { inserted, total, backupDeleted, backupPath } = await applyRestore(db, picked);
      setResult(`${inserted.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')} rows back${backupDeleted ? ` — backup consumed (${backupPath})` : ` — backup kept (${backupPath})`}. Logins and inviter links are not restored; the next OTP mints a fresh identity.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }, [db, picked]);
  if (backups === null) {
    return <Frame title="RESTORE" accent={C.amber} hint={null}><Spinner label="Looking for backups…" /></Frame>;
  }
  if (backups.length === 0) {
    return (
      <Frame title="RESTORE" accent={C.amber}>
        <Text>No backups in tmp/ yet — purge writes one before every delete.</Text>
      </Frame>
    );
  }
  if (applying) {
    return <Frame title="RESTORE" accent={C.amber} hint={null}><Spinner label="Inserting rows, parents first…" /></Frame>;
  }
  if (result) {
    return (
      <Frame title="RESTORE" accent={C.green} hint="esc — menu · ctrl+c — quit">
        <StatusMessage variant="success">{result}</StatusMessage>
      </Frame>
    );
  }
  if (picked && preview) {
    return (
      <Frame title={`RESTORE — ${picked.split('/').pop()}`} accent={C.amber} hint="b/esc — back to list · ctrl+c — quit">
        <Panel accent={C.amber}>
          <Text bold>{preview.targetLine ?? '?'}</Text>
          {preview.scopeLine && <Text color={C.amber}>{preview.scopeLine}</Text>}
          {preview.planned.map((x) => (
            <Text key={x.table}>
              {'  '}{x.table.padEnd(34)}{x.rows.toLocaleString('en-IN')} rows
              {x.missingColumns.length > 0 && <Text dimColor> (skipped cols: {x.missingColumns.join(', ')})</Text>}
            </Text>
          ))}
          <Text bold color={C.amber}>
            {'  '}total: {preview.total.toLocaleString('en-IN')} rows — parents inserted first, existing rows skipped
          </Text>
        </Panel>
        {preview.crossProject && (
          <Alert variant="warning">
            {preview.fromProject
              ? `This backup came from a different project (${preview.fromProject}) — check before restoring.`
              : 'This backup has no origin project recorded (hand-edited or legacy?) — check before restoring.'}
          </Alert>
        )}
        {error && <ErrorLine message={error} />}
        <Box>
          <Text bold>Restore these rows? </Text>
          <ConfirmInput defaultChoice="cancel" onConfirm={() => void apply()} onCancel={toPicker} />
        </Box>
      </Frame>
    );
  }
  return (
    <Frame title="RESTORE" subtitle="pick a purge backup" accent={C.amber} hint={null}>
      {error && <ErrorLine message={error} />}
      <MenuList
        items={backups.map((b) => ({
          value: b.file,
          label: `${b.file} · ${b.rows.toLocaleString('en-IN')} rows`,
          description: `${formatBackupDate(b.mtime)} · ${b.target}`,
          color: C.amber,
        }))}
        hint={backups.length <= 10
          ? '1-9 pick · ↑↓/jk move · enter pick · esc — menu · ctrl+c — quit'
          : '↑↓/jk move · enter pick · esc — menu · ctrl+c — quit'}
        onPick={(file) => void choose(file)}
      />
    </Frame>
  );
}

export function FlagView({ db, cmd, onMenu }: { db: Db; cmd: 'promote' | 'demote' | 'disable' | 'enable'; onMenu: OnMenu }) {
  const [phase, setPhase] = useState<'input' | 'loading' | 'confirm' | 'applying' | 'result'>('input');
  const [target, setTarget] = useState<Target | null>(null);
  const [warning, setWarning] = useState('');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const column = cmd === 'promote' || cmd === 'demote' ? 'platform_admin' as const : 'disabled' as const;
  const flagKey = column === 'platform_admin' ? 'platformAdmin' as const : 'disabled' as const;
  // promote and disable turn their flag ON; demote and enable turn it OFF.
  const value = cmd === 'promote' || cmd === 'disable';
  useInput((input, key) => {
    if (key.escape && phase !== 'applying') {
      onMenu(result ? result : undefined);
    }
    if (input === 'n' && phase === 'result') {
      setTarget(null);
      setResult('');
      setWarning('');
      setError('');
      setPhase('input');
    }
  });
  const prepare = useCallback(async (phone: string) => {
    setError('');
    setWarning(''); // a stale warning must never bleed onto another person's confirm
    setPhase('loading');
    try {
      const t = await findByPhone(db, parsePhone(phone));
      if (!t) throw new Error('No person with that number.');
      if (t.kind === 'staff' && cmd !== 'demote') {
        throw new Error(`${describe(t)} is staff — staff accounts are never touched by this tool.`);
      }
      if (t[flagKey] === value) throw new Error(`${describe(t)} already has ${column}=${value} — nothing to do.`);
      if (cmd === 'demote') {
        const n = await staffCount(db);
        if (n <= 1) setWarning('This is the last fenzit staff account — demoting it could lock you out of this CLI and staff tools.');
      }
      setTarget(t);
      setPhase('confirm');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('input');
    }
  }, [db, cmd, column, value]);
  const apply = useCallback(async () => {
    if (!target) return;
    setPhase('applying');
    try {
      if (column === 'platform_admin') await setStaff(db, target, value);
      else await setDisabled(db, target, value);
      setResult(`Done: ${FLAG_TITLES[cmd].split(' — ')[1].toLowerCase()} — ${describe(target)} (${column}=${value}).`);
      setPhase('result');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('input');
      setTarget(null);
    }
  }, [db, target, column, value, cmd]);
  if (phase === 'loading') {
    return <Frame title={FLAG_TITLES[cmd]} accent={C.amber} hint={null}><Spinner label="Looking up…" /></Frame>;
  }
  if (phase === 'applying' && target) {
    return <Frame title={FLAG_TITLES[cmd]} accent={C.amber} hint={null}><Spinner label={`Applying ${cmd} — ${describe(target)}…`} /></Frame>;
  }
  if (phase === 'result' && target) {
    return (
      <Frame title={FLAG_TITLES[cmd]} accent={C.green} hint="n — next person · esc — menu · ctrl+c — quit">
        <StatusMessage variant="success">{result}</StatusMessage>
      </Frame>
    );
  }
  if (phase === 'confirm' && target) {
    return (
      <Frame title={FLAG_TITLES[cmd]} accent={C.amber}>
        <Panel accent={C.amber}>
          <Box gap={1}>
            <Text bold>{describe(target)}</Text>
            <TargetBadges target={target} />
          </Box>
          <Text dimColor>This change is audited; {column === 'platform_admin' ? 'staff can open admin tools.' : 'a disabled person cannot sign in.'}</Text>
        </Panel>
        {warning && <Alert variant="warning">{warning}</Alert>}
        <Box>
          <Text bold>Apply? </Text>
          <ConfirmInput defaultChoice="cancel" onConfirm={() => void apply()} onCancel={() => onMenu()} />
        </Box>
      </Frame>
    );
  }
  return (
    <Frame title={FLAG_TITLES[cmd]} accent={C.amber}>
      {error && <ErrorLine message={error} />}
      <PhoneInput label="Phone" onSubmit={(v) => void prepare(v)} />
    </Frame>
  );
}

export function SuperApp({ db }: { db: Db }) {
  const { exit } = useApp();
  const [view, setView] = useState<View>({ name: 'menu' });
  const [note, setNote] = useState<string | null>(null);
  const back = useCallback<OnMenu>((n) => {
    // The menu receipt must stay one line: no "Done:" stutter, no wrap.
    if (n !== undefined) setNote(n.replace(/^Done: /, '').slice(0, 100));
    setView({ name: 'menu' });
  }, []);
  useInput((input, key) => {
    // PurgeApp owns Ctrl+C once mounted — it must explain, not vanish.
    if (key.ctrl && input === 'c' && view.name !== 'purge') exit();
  });
  return (
    <Box flexDirection="column" gap={1}>
      {view.name === 'menu' ? (
        <Box flexDirection="column" gap={1}>
          <Wordmark />
          {note && <Text dimColor>  last: {note}</Text>}
          <MenuList
            items={MENU_ITEMS}
            hint={MENU_HINT}
            onCtrlC={exit}
            onPick={(value) => {
              if (value === 'quit') exit();
              else setView({ name: value } as View);
            }}
          />
        </Box>
      ) : view.name === 'whois' ? <WhoisView db={db} onMenu={back} />
      : view.name === 'list' ? <ListView db={db} onMenu={back} />
      : view.name === 'stats' ? <StatsView db={db} onMenu={back} />
      : view.name === 'purge' ? <PurgeView db={db} onMenu={back} />
      : view.name === 'restore' ? <RestoreView db={db} onMenu={back} />
      : view.name === 'token' ? <TokenView db={db} onMenu={back} />
      : <FlagView db={db} cmd={view.name as 'promote' | 'demote' | 'disable' | 'enable'} onMenu={back} />}
    </Box>
  );
}
