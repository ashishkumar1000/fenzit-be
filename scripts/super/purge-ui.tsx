import { Box, Text, useApp, useInput } from 'ink';
import { ConfirmInput, ProgressBar, Spinner, StatusMessage } from '@inkjs/ui';
import { useEffect, useRef, useState } from 'react';
import type { PurgeReceipt } from './purge';
import { C, Bar } from './ui';

/**
 * The one interactive screen of the super CLI: the purge confirmation and
 * its honest aftermath. Design contract (Sally's reviews, rounds 1–2):
 *  - the confirm moment must carry the whole truth — who, scope, counts,
 *    the backup promise and what can never come back;
 *  - every exit lands on a verdict line, and via the shell the verdict
 *    stays on the menu as a "last:" receipt;
 *  - a failure says exactly what was and was not done — never "nothing
 *    happened" when logins were already removed;
 *  - Ctrl+C is never silent: at confirm it cancels, mid-run it explains
 *    that the run finishes or rolls back as one unit.
 * Loud styling here is deliberate: red and amber, never the calm green of
 * read-only screens.
 */

export interface PurgeUiProps {
  targetLine: string;
  scopeLine: string;
  counts: Array<{ table: string; n: number }>;
  missingTables: string[];
  total: number;
  /** When provided (interactive shell), esc after a verdict returns to the menu with a receipt note. */
  onFinished?: (note?: string) => void;
  run: (report: {
    phase: (p: 'backup' | 'logins' | 'delete') => void;
    step: (table: string, n: number) => void;
  }) => Promise<PurgeReceipt>;
}

type Phase = 'confirm' | 'running' | 'done' | 'cancelled' | 'failed';
type WorkPhase = 'backup' | 'logins' | 'delete';

const PHASE_LABELS: Record<WorkPhase, string> = {
  backup: 'Writing JSON backup to tmp/…',
  logins: 'Removing login identities…',
  delete: 'Deleting…',
};

const enIN = (n: number): string => n.toLocaleString('en-IN');

export function PurgeApp(props: PurgeUiProps) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>('confirm');
  const [workPhase, setWorkPhase] = useState<WorkPhase>('backup');
  const [steps, setSteps] = useState<Array<{ table: string; n: number }>>([]);
  const [receipt, setReceipt] = useState<PurgeReceipt | null>(null);
  const [rawError, setRawError] = useState('');
  const [failedAt, setFailedAt] = useState<WorkPhase>('backup');
  const [waitNote, setWaitNote] = useState(false);
  const phaseRef = useRef<WorkPhase>('backup');
  // runDeletes reports one step per plan entry — existing tables (counts) plus
  // the missing ones — so the progress denominator matches both.
  const expectedTables = props.counts.length + props.missingTables.length;
  const maxCount = Math.max(1, ...props.counts.map((c) => c.n));

  const receiptNote = (): string | undefined => {
    if (phase === 'done' && receipt) {
      return `purge — deleted ${enIN(receipt.deletedRows)} rows · backup ${receipt.backupPath.split('/').pop()}`;
    }
    if (phase === 'cancelled') return 'purge — cancelled, nothing was changed';
    if (phase === 'failed') return 'purge — FAILED, database rolled back';
    return undefined;
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (phase === 'confirm') setPhase('cancelled');
      if (phase === 'running') setWaitNote(true);
      if (phase !== 'confirm' && phase !== 'running' && props.onFinished) props.onFinished(receiptNote());
      return;
    }
    if (props.onFinished && phase !== 'confirm' && phase !== 'running' && key.escape) {
      props.onFinished(receiptNote());
      return;
    }
    if (phase !== 'confirm') return;
    if (input === 'n' || input === 'N' || key.escape) setPhase('cancelled');
  });

  useEffect(() => {
    if (phase !== 'running') return;
    props
      .run({
        phase: (p) => {
          phaseRef.current = p;
          setWorkPhase(p);
        },
        step: (table, n) => setSteps((prev) => [...prev, { table, n }]),
      })
      .then((r) => {
        setReceipt(r);
        setPhase('done');
      })
      .catch((e: unknown) => {
        setRawError(e instanceof Error ? e.message : String(e));
        setFailedAt(phaseRef.current);
        setPhase('failed');
      });
  }, [phase]);

  useEffect(() => {
    if (phase === 'confirm' || phase === 'running' || props.onFinished) return;
    const t = setTimeout(() => exit(), phase === 'done' ? 1200 : 2000);
    return () => clearTimeout(t);
  }, [phase]);

  if (phase === 'confirm') {
    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box borderStyle="round" borderColor={C.red} flexDirection="column" paddingX={1} gap={0}>
          <Text bold color={C.red}>super · purge — this permanently deletes data</Text>
          <Text> </Text>
          <Text bold>{props.targetLine}</Text>
          <Text color={C.amber}>{props.scopeLine}</Text>
          {props.counts.filter((c) => c.n > 0).map((c) => (
            <Text key={c.table}>
              {'  '}{c.table.padEnd(34)}<Bar value={c.n} max={maxCount} color={C.amber} width={14} />{' '}
              <Text bold>{enIN(c.n)}</Text>
            </Text>
          ))}
          {props.missingTables.length > 0 && (
            <Text dimColor>  (not present in this database, skipped: {props.missingTables.join(', ')})</Text>
          )}
          <Text bold color={C.amber}>  total rows: {enIN(props.total)}</Text>
          <Text> </Text>
          <Text backgroundColor={C.amber} color="#0A0A0A" bold>
            {' '}⚠ DESTRUCTIVE — backup goes to tmp/ first · LOGINS NEVER RESTORABLE{' '}
          </Text>
          <Text> </Text>
          <Box>
            <Text bold>Delete? </Text>
            <ConfirmInput defaultChoice="cancel" onConfirm={() => setPhase('running')} onCancel={() => setPhase('cancelled')} />
          </Box>
          <Text dimColor>  esc or n — cancel · nothing has been touched yet</Text>
        </Box>
      </Box>
    );
  }

  if (phase === 'running') {
    const doneTables = steps.length;
    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        {workPhase !== 'delete' ? (
          <Spinner label={PHASE_LABELS[workPhase]} />
        ) : (
          <Box flexDirection="column" gap={1}>
            <Spinner label={`Deleting ${enIN(props.total)} rows across ${expectedTables} tables…`} />
            <Box gap={1}>
              <ProgressBar value={expectedTables > 0 ? (doneTables / expectedTables) * 100 : 0} />
              <Text dimColor>{doneTables}/{expectedTables} tables</Text>
            </Box>
            <Box flexDirection="column" paddingLeft={2}>
              {steps.map((s, i) => (
                <Text key={`${s.table}:${i}`} dimColor>✓ {s.table}: {enIN(s.n)}</Text>
              ))}
            </Box>
          </Box>
        )}
        {waitNote && <Text dimColor>Running — this finishes or rolls back as one unit. Please wait.</Text>}
      </Box>
    );
  }

  if (phase === 'done' && receipt) {
    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box borderStyle="round" borderColor={C.green} flexDirection="column" paddingX={1}>
          <StatusMessage variant="success">
            Deleted {enIN(receipt.deletedRows)} rows. Logins removed: {enIN(receipt.loginsRemoved)} ({enIN(receipt.loginsSkipped)} {receipt.loginsSkipped === 1 ? 'was' : 'were'} already gone).
          </StatusMessage>
          <Text>Backup: {receipt.backupPath} ({enIN(receipt.backupRows)} rows)</Text>
          <Text dimColor>Bring it back with: super restore {receipt.backupPath.split('/').pop()}</Text>
          {props.onFinished && <Text dimColor>esc — menu</Text>}
        </Box>
      </Box>
    );
  }

  if (phase === 'cancelled') {
    return (
      <Box paddingX={1} flexDirection="column" gap={1}>
        <Text color={C.amber}>Cancelled — nothing was changed.</Text>
        {props.onFinished && <Text dimColor>esc — menu</Text>}
      </Box>
    );
  }

  // failed
  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      <Box borderStyle="round" borderColor={C.red} flexDirection="column" paddingX={1}>
        <Text color={C.red} bold>✗ FAILED — the database rolled back, so no rows were deleted.</Text>
        {failedAt !== 'backup' && (
          <Text>Logins were already removed; rerun the same command to finish (it skips what is done).</Text>
        )}
        <Text dimColor>{rawError}</Text>
        {props.onFinished && <Text dimColor>esc — menu</Text>}
      </Box>
    </Box>
  );
}
