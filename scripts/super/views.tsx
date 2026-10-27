import { Box, Text, useInput } from 'ink';
import { Spinner, StatusMessage } from '@inkjs/ui';
import { useCallback, useEffect, useState } from 'react';
import {
  findByPhone,
  fmtDate,
  listUsers,
  parsePhone,
  statsData,
  type ListRow,
  type StatDatum,
  type Target,
} from './core';
import { mintAccessToken } from './accounts';
import type { Db } from './db';
import {
  Bar,
  C,
  ErrorLine,
  Frame,
  OnMenu,
  Panel,
  PhoneInput,
  TargetBadges,
  fmtPhone,
} from './ui';

/**
 * The read-only screens of the super shell — whois, list, stats, token.
 * House rules (Sally round 2): lookups spin, errors stay inline above a
 * still-mounted input, b/n shortcuts only live on result screens (a name
 * fragment may contain those letters), and leaving a result leaves a
 * one-line receipt on the menu.
 */

const READ_HINT = 'esc — menu · ctrl+c — quit';
const RESULT_HINT = 'n — new search · esc — menu · ctrl+c — quit';

const LIST_COLS = { phone: 12, name: 24, company: 22, role: 20 } as const;

export function ListView({ db, onMenu }: { db: Db; onMenu: OnMenu }) {
  const [phase, setPhase] = useState<'input' | 'loading' | 'result'>('input');
  const [rows, setRows] = useState<ListRow[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  useInput((input, key) => {
    if (key.escape) onMenu(rows ? `list “${query}” — ${rows.length} shown` : undefined);
    if (input === 'n' && phase === 'result') {
      setRows(null);
      setError('');
      setPhase('input');
    }
  });
  const search = useCallback(async (q: string) => {
    setError('');
    setQuery(q);
    setPhase('loading');
    try {
      setRows(await listUsers(db, q));
      setPhase('result');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('input');
    }
  }, [db]);
  if (phase === 'loading') {
    return <Frame title="LIST" accent={C.green}><Spinner label={`Searching “${query}”…`} /></Frame>;
  }
  if (phase === 'result' && rows) {
    return (
      <Frame title={`LIST — “${query}”`} accent={C.green} hint={RESULT_HINT}>
        <Panel accent={C.green}>
          <Text dimColor>
            {'  '}{'PHONE'.padEnd(LIST_COLS.phone)}{'NAME'.padEnd(LIST_COLS.name)}{'COMPANY'.padEnd(LIST_COLS.company)}{'ROLE'.padEnd(LIST_COLS.role)}CREATED
          </Text>
          {rows.map((r, i) => (
            <Text key={i}>
              {'  '}{r.phone_number.padEnd(LIST_COLS.phone)}
              {(r.name ?? '(no name)').padEnd(LIST_COLS.name).slice(0, LIST_COLS.name)}
              {(r.company_name ?? '-').padEnd(LIST_COLS.company).slice(0, LIST_COLS.company)}
              {(r.role ? `${r.role}/${r.status}` : '-').padEnd(LIST_COLS.role).slice(0, LIST_COLS.role)}
              <Text dimColor>{fmtDate(r.created_at)}</Text>
              {r.platform_admin && <Text bold color={C.amber}> STAFF</Text>}
              {r.disabled && <Text bold color={C.red}> DISABLED</Text>}
            </Text>
          ))}
        </Panel>
        <Text dimColor>{rows.length === 0 ? 'No match.' : `${rows.length} shown · newest first`}</Text>
      </Frame>
    );
  }
  return (
    <Frame title="LIST" subtitle="find people by phone or name" accent={C.green} hint={READ_HINT}>
      {error && <ErrorLine message={error} />}
      <PhoneInput label="Fragment" onSubmit={(v) => void search(v)} />
    </Frame>
  );
}

const STAT_SECTIONS: Array<{ label: string; color: string; keys: string[] }> = [
  { label: 'PEOPLE', color: C.cyan, keys: ['users', 'staff'] },
  { label: 'COMPANIES', color: C.magenta, keys: ['companies', 'memberships'] },
  { label: 'WORK', color: C.green, keys: ['customers', 'jobs'] },
  { label: 'MESSAGING', color: C.amber, keys: ['notifications'] },
  { label: 'ATTENDANCE', color: C.gold, keys: ['attendance_rows'] },
  { label: 'SYSTEM', color: C.slate, keys: ['audit_rows'] },
];

export function StatsView({ db, onMenu }: { db: Db; onMenu: OnMenu }) {
  const [data, setData] = useState<StatDatum[] | null>(null);
  const [error, setError] = useState('');
  useInput((input, key) => {
    if (key.escape || input === 'b') onMenu();
  });
  useEffect(() => {
    statsData(db).then(setData).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [db]);
  if (error) {
    return <Frame title="STATS" accent={C.red} hint={READ_HINT}><ErrorLine message={error} /></Frame>;
  }
  if (!data) {
    return <Frame title="STATS" accent={C.green}><Spinner label="Counting every table…" /></Frame>;
  }
  const byKey = new Map(data.map((d) => [d.key, d.value]));
  const max = Math.max(1, ...data.map((d) => d.value));
  const seen = new Set<string>();
  return (
    <Frame title="STATS" subtitle="every table that matters" accent={C.green} hint={READ_HINT}>
      <Panel accent={C.green}>
        {STAT_SECTIONS.map((sec) => (
          <Box key={sec.label} flexDirection="column" marginBottom={0}>
            <Text>
              {'  '}<Text bold color={sec.color}>◆ {sec.label}</Text>
            </Text>
            {sec.keys.map((k) => {
              seen.add(k);
              return (
                <Text key={k}>
                  {'    '}{k.replace(/_/g, ' ').padEnd(16)}<Bar value={byKey.get(k) ?? 0} max={max} color={sec.color} />{' '}
                  <Text bold>{(byKey.get(k) ?? 0).toLocaleString('en-IN')}</Text>
                </Text>
              );
            })}
          </Box>
        ))}
        {data.filter((d) => !seen.has(d.key)).map((d) => (
          <Text key={d.key}>
            {'  '}{d.key.replace(/_/g, ' ').padEnd(16)}<Bar value={d.value} max={max} color={C.slate} />{' '}
            <Text bold>{d.value.toLocaleString('en-IN')}</Text>
          </Text>
        ))}
      </Panel>
    </Frame>
  );
}

export function TokenView({ db, onMenu }: { db: Db; onMenu: OnMenu }) {
  const [phase, setPhase] = useState<'input' | 'loading' | 'result'>('input');
  const [token, setToken] = useState('');
  const [target, setTarget] = useState<Target | null>(null);
  const [error, setError] = useState('');
  useInput((input, key) => {
    if (key.escape) onMenu(target ? `token — minted for ${fmtPhone(target)}` : undefined);
    if (input === 'n' && phase === 'result') {
      setToken('');
      setTarget(null);
      setError('');
      setPhase('input');
    }
  });
  const mint = useCallback(async (phone: string) => {
    setError('');
    setPhase('loading');
    try {
      const t = await findByPhone(db, parsePhone(phone));
      if (!t) throw new Error('No person with that number.');
      setTarget(t);
      setToken(mintAccessToken(t));
      setPhase('result');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('input');
    }
  }, [db]);
  if (phase === 'loading') {
    return <Frame title="TOKEN" accent={C.green}><Spinner label="Minting token…" /></Frame>;
  }
  if (phase === 'result' && target) {
    return (
      <Frame title="TOKEN" subtitle="app login JWT" accent={C.green} hint={RESULT_HINT}>
        <Box gap={1}>
          <Text bold>{target.name ?? '(no name)'}</Text>
          <TargetBadges target={target} />
        </Box>
        <Panel accent={C.green}>
          <Text>{token}</Text>
        </Panel>
        <StatusMessage variant="success">No expiry — paste into the app&apos;s Authorization header to debug as this person.</StatusMessage>
      </Frame>
    );
  }
  return (
    <Frame title="TOKEN" subtitle="mint an app login JWT (debug as this person)" accent={C.green} hint={READ_HINT}>
      {error && <ErrorLine message={error} />}
      <PhoneInput label="Phone" onSubmit={(v) => void mint(v)} />
    </Frame>
  );
}
