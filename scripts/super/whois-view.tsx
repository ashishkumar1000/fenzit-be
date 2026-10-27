import { Box, Text, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';
import { useCallback, useState, type ReactNode } from 'react';
import {
  findByPhone,
  fmtDate,
  fmtDateTime,
  parsePhone,
  whoisReport,
  type WhoisReport,
} from './core';
import type { Db } from './db';
import {
  C,
  CountsRow,
  DataTable,
  ErrorLine,
  Frame,
  GradientText,
  OnMenu,
  Panel,
  PhoneInput,
  SectionTitle,
  StatTiles,
  TargetBadges,
  fmtPhone,
  kindColor,
} from './ui';

/**
 * WHOIS v3 — the full dossier on one person, built from the 2026-10-27
 * schema inventories (two agent sweeps). Structure follows the BMAD spec
 * artifacts/specs/spec-whois-v3-dossier: k9s-style context header, btop-style
 * glance tiles, then a colour-coded table per data group with role-aware
 * ordering (owners see their company first, technicians their work). Empty
 * sections collapse. Status colours follow the schema CHECK domains and are
 * always paired with their word.
 */

const RESULT_HINT = 'n — new search · esc — menu · ctrl+c — quit';

const statusColor = (s: string): string =>
  s === 'active' || s === 'approved' || s === 'ready' || s === 'completed'
    ? C.green
    : s === 'invited' || s === 'pending' || s === 'queued' || s === 'generating' || s === 'in_progress' || s === 'half_day'
      ? C.amber
      : s === 'removed' || s === 'rejected' || s === 'cancelled' || s === 'revoked' || s === 'failed' || s === 'absent'
        ? C.red
        : C.slate;

const stamp = (v: Date | string | null | undefined): string => fmtDateTime(v).slice(5);

const workedHours = (a: { checkin: Date | string | null; checkout: Date | string | null }): ReactNode => {
  if (!a.checkin || !a.checkout) return <Text bold color={C.amber}>OPEN</Text>;
  const h = (new Date(a.checkout).getTime() - new Date(a.checkin).getTime()) / 3_600_000;
  if (!Number.isFinite(h) || h < 0) return <Text color={C.slate}>?</Text>;
  return <Text>{h.toFixed(1)}h</Text>;
};

export function WhoisView({ db, onMenu }: { db: Db; onMenu: OnMenu }) {
  const [phase, setPhase] = useState<'input' | 'loading' | 'result'>('input');
  const [report, setReport] = useState<WhoisReport | null>(null);
  const [error, setError] = useState('');
  useInput((input, key) => {
    if (key.escape) onMenu(report ? `whois — ${report.target.name ?? fmtPhone(report.target)}` : undefined);
    if (input === 'n' && phase === 'result') {
      setReport(null);
      setError('');
      setPhase('input');
    }
  });
  const look = useCallback(async (phone: string) => {
    setError('');
    setPhase('loading');
    try {
      const t = await findByPhone(db, parsePhone(phone));
      if (!t) throw new Error('No person with that number.');
      setReport(await whoisReport(db, t));
      setPhase('result');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('input');
    }
  }, [db]);

  if (phase === 'loading') {
    return <Frame title="WHOIS" accent={C.cyan} hint={null}><Spinner label="Pulling the full dossier…" /></Frame>;
  }

  if (phase === 'result' && report) {
    return <WhoisDossier report={report} onMenu={onMenu} />;
  }

  return (
    <Frame title="WHOIS" subtitle="the full dossier on one person" accent={C.cyan} hint="esc — menu · ctrl+c — quit">
      {error && <ErrorLine message={error} />}
      <PhoneInput label="Phone" onSubmit={(v) => void look(v)} />
    </Frame>
  );
}

export function WhoisDossier({ report, onMenu }: { report: WhoisReport; onMenu: OnMenu }) {
  const r = report;
  const t = r.target;
  const isOwner = t.kind === 'owner' || t.kind === 'staff';

  const memberships = (
    <Section id="memberships" label="MEMBERSHIPS" count={r.memberships.length} color={C.magenta}>
      <DataTable
        head={['company', 'role', 'status', 'code', 'invited by', 'joined']}
        widths={[17, 11, 8, 9, 13, 10]}
        colors={[undefined, undefined, undefined, C.slate, C.slate, C.slate]}
        rows={r.memberships.map((m) => [
          m.company + (m.isFounder ? ' ◆' : ''),
          m.role,
          <Text color={statusColor(m.status)}>{m.status}</Text>,
          m.employeeCode ?? '—',
          m.invitedBy ?? '—',
          fmtDate(m.joined),
        ])}
        empty="no memberships"
      />
    </Section>
  );

  const invites = (
    <Section id="invites" label="INVITES" count={r.invites.sent.length} color={C.magenta}>
      <DataTable
        head={['invited', 'phone', 'company', 'role', 'status']}
        widths={[16, 13, 14, 11, 8]}
        rows={r.invites.sent.map((i) => [
          i.name ?? '(no name)',
          `+91${i.phone}`,
          i.company,
          i.role,
          <Text color={statusColor(i.status)}>{i.status}</Text>,
        ])}
        empty={r.invites.invitedBy ? `invited by ${r.invites.invitedBy}` : 'nobody invited'}
      />
    </Section>
  );

  const jobs = (
    <Section id="jobs" label="JOBS (as technician, newest)" count={r.counts.jobs} color={C.green}>
      <DataTable
        head={['number', 'status', 'step', 'scheduled', 'customer', 'photos']}
        widths={[13, 11, 10, 11, 12, 6]}
        rows={r.jobs.map((j) => [
          j.priority === 'urgent'
            ? <Text bold color={C.red}>{j.jobNumber}!</Text>
            : j.jobNumber,
          <Text color={statusColor(j.status)}>{j.status}</Text>,
          j.currentStep ?? '—',
          stamp(j.scheduledStart),
          j.customer ?? '—',
          j.photos > 0 ? <Text color={C.cyan}>{j.photos}</Text> : '0',
        ])}
        empty="no jobs assigned"
      />
    </Section>
  );

  const offices = (
    <Section id="offices" label="OFFICES" count={r.offices.length} color={C.green}>
      <DataTable
        head={['office', 'address', 'radius', 'valid']}
        widths={[15, 19, 7, 24]}
        rows={r.offices.map((o) => [
          o.name,
          o.address ?? '—',
          o.radius === null ? '—' : `${o.radius}m`,
          o.valid ?? '—',
        ])}
      />
    </Section>
  );

  const attendance = (
    <Section id="attendance" label="ATTENDANCE" count={r.attendance.attemptsCount} color={C.gold}>
      {r.attendance.recent.length > 0 && (
        <DataTable
          head={['work date', 'check in', 'check out', 'hrs', 'distance', 'flags']}
          widths={[11, 11, 11, 5, 8, 6]}
          rows={r.attendance.recent.map((a) => [
            fmtDate(a.workDate),
            stamp(a.checkin),
            stamp(a.checkout),
            workedHours(a),
            a.checkinDistance === null ? '—' : `${a.checkinDistance}m`,
            a.mocked ? <Text bold color={C.red}>MOCK</Text> : '—',
          ])}
        />
      )}
      {r.attendance.attempts.length > 0 && (
        <DataTable
          head={['attempt', 'outcome', 'provider', 'dist', 'mock', 'when']}
          widths={[9, 12, 9, 7, 6, 11]}
          colors={[undefined, undefined, C.slate, C.slate, undefined, C.slate]}
          rows={r.attendance.attempts.map((a) => [
            a.kind,
            <Text color={statusColor(a.outcome === 'ok' ? 'active' : 'failed')}>{a.outcome}</Text>,
            a.provider ?? '—',
            a.distance === null ? '—' : `${a.distance}m`,
            a.mocked ? <Text bold color={C.red}>YES</Text> : 'no',
            <Text dimColor>{stamp(a.createdAt)}</Text>,
          ])}
        />
      )}
      <CountsRow counts={[
        { k: 'attempts', v: r.attendance.attemptsCount },
        { k: 'corrections', v: r.attendance.corrections },
        { k: 'overrides', v: r.attendance.overrides },
        { k: 'overrides authored', v: r.attendance.overridesAuthored },
        { k: 'weekly-off', v: r.attendance.weeklyOff },
        { k: 'enrolments', v: r.attendance.enrolments },
      ]} />
    </Section>
  );

  const authored = (
    <Section id="authored" label="MODERATIONS AUTHORED" count={r.authored.corrections.length} color={C.amber}>
      <DataTable
        head={['work date', 'employee', 'note']}
        widths={[11, 15, 26]}
        rows={r.authored.corrections.map((c) => [
          fmtDate(c.workDate),
          c.employee ?? '—',
          c.note ?? '—',
        ])}
        empty="none authored"
      />
    </Section>
  );

  const leave = (
    <Section id="leave" label="LEAVE" count={r.leave.length} color={C.amber}>
      <DataTable
        head={['start', 'end', 'part', 'state', 'reason']}
        widths={[10, 10, 11, 9, 21]}
        rows={r.leave.map((l) => [
          fmtDate(l.start),
          fmtDate(l.end),
          l.part,
          l.lastState ? <Text color={statusColor(l.lastState)}>{l.lastState}</Text> : '—',
          l.reason ?? '—',
        ])}
        empty="no leave requests"
      />
      {r.leaveDays.length > 0 && (
        <Text>
          {'  '}<Text dimColor>days: </Text>
          {r.leaveDays.map((d, i) => (
            <Text key={`${d.date}:${i}`}>
              {i > 0 && <Text dimColor> · </Text>}
              <Text color={statusColor(d.state)}>{fmtDate(d.date)} {d.state}</Text>
            </Text>
          ))}
        </Text>
      )}
      {r.leaveEvents.length > 0 && (
        <DataTable
          head={['event', 'actor', 'when']}
          widths={[22, 14, 11]}
          colors={[undefined, C.slate, C.slate]}
          rows={r.leaveEvents.map((e) => [
            e.reason ? `${e.cause} (${e.reason})` : e.cause,
            e.actor ?? '—',
            <Text dimColor>{stamp(e.createdAt)}</Text>,
          ])}
        />
      )}
    </Section>
  );

  const skills = (
    <Section id="skills" label="SKILLS" count={r.skills.length} color={C.green}>
      <Text>
        {'  '}
        {r.skills.map((s, i) => (
          <Text key={s}>
            {i > 0 && <Text dimColor> · </Text>}
            <Text color={C.green}>{s}</Text>
          </Text>
        ))}
      </Text>
    </Section>
  );

  const activity = (
    <Section id="activity" label="ACTIVITY (recent)" count={r.activity.length} color={C.cyan}>
      <DataTable
        head={['event', 'job', 'when']}
        widths={[25, 11, 16]}
        rows={r.activity.map((a) => [
          a.event,
          a.jobNumber ?? '—',
          <Text dimColor>{fmtDateTime(a.createdAt)}</Text>,
        ])}
      />
    </Section>
  );

  const audit = (
    <Section id="audit" label="AUDIT (recent)" count={r.counts.auditRows} color={C.slate}>
      <DataTable
        head={['action', 'role', 'when']}
        widths={[23, 8, 16]}
        rows={r.audit.map((a) => [
          a.action,
          <Text color={a.isActor ? C.cyan : C.magenta}>{a.isActor ? 'actor' : 'target'}</Text>,
          <Text dimColor>{fmtDateTime(a.createdAt)}</Text>,
        ])}
      />
    </Section>
  );

  const notifications = (
    <Section id="notifications" label="NOTIFICATIONS (recent)" count={r.counts.notifications} color={C.amber}>
      <DataTable
        head={['event', 'about', 'state', 'when']}
        widths={[25, 18, 7, 11]}
        colors={[undefined, C.slate, undefined, C.slate]}
        rows={r.notifications.map((n) => [
          n.event,
          n.summary ?? '—',
          n.read ? <Text color={C.slate}>read</Text> : <Text bold color={C.amber}>unread</Text>,
          <Text dimColor>{stamp(n.createdAt)}</Text>,
        ])}
      />
    </Section>
  );

  const reports = (
    <Section id="reports" label="REPORTS" count={r.reports.length} color={C.green}>
      <DataTable
        head={['type', 'status', 'when']}
        widths={[25, 9, 16]}
        rows={r.reports.map((rep) => [
          rep.type,
          <Text color={statusColor(rep.status)}>{rep.status}</Text>,
          <Text dimColor>{fmtDateTime(rep.createdAt)}</Text>,
        ])}
      />
    </Section>
  );

  const byKey: Record<string, ReactNode> = {
    memberships, invites, jobs, offices, attendance, authored, leave, skills, activity, audit, notifications, reports,
  };
  const lead = isOwner
    ? ['memberships', 'invites', 'jobs', 'attendance', 'authored']
    : ['jobs', 'attendance', 'leave', 'invites', 'memberships'];
  // Every section renders exactly once: the role's lead order first, then the
  // remainder in canonical order (a naive lead+tail once dropped LEAVE for
  // owners and MODERATIONS AUTHORED for technicians).
  const canonical = ['memberships', 'invites', 'jobs', 'offices', 'attendance', 'authored', 'leave', 'skills', 'activity', 'audit', 'notifications', 'reports'];
  const order = [...lead, ...canonical.filter((k) => !lead.includes(k))];

  return (
    <Frame title="WHOIS" subtitle="full dossier · newest first" accent={C.cyan} hint={RESULT_HINT}>
      <Panel accent={C.cyan}>
        <Box flexDirection="column">
          <Box gap={1}>
            <Text bold color={C.gold}>{t.name ?? '(no name)'}</Text>
            <TargetBadges target={t} />
          </Box>
          <Text>
            <Text color={kindColor(t.kind)}>{fmtPhone(t)}</Text>
            <Text dimColor> · joined {fmtDate(t.createdAt)} · {t.id.slice(0, 8)}… · logins {r.logins === null ? '—' : r.logins}</Text>
            {t.email && <Text dimColor> · {t.email}</Text>}
            {t.membership && (
              <Text dimColor> · {t.membership.companyName} ({t.membership.role}{t.membership.status !== 'active' ? `, ${t.membership.status}` : ''})</Text>
            )}
          </Text>
          <GradientText text={'─'.repeat(56)} from={C.cyan} to={C.magenta} />
        </Box>
        <StatTiles tiles={[
          { label: 'jobs', value: r.counts.jobs, color: C.green },
          { label: 'attempts', value: r.attendance.attemptsCount, color: C.gold },
          { label: 'leave', value: r.leave.length, color: C.amber },
          { label: 'offices', value: r.offices.length, color: C.green },
          { label: 'notifications', value: r.counts.notifications, color: C.cyan },
          { label: 'audit', value: r.counts.auditRows, color: C.slate },
        ]} />
        {r.company && (
          <Text>
            {'  '}<Text color={C.amber}>{`company "${r.company.name}"`}</Text>
            {r.company.isFounder && <Text bold color={C.gold}> ← founded by this person</Text>}
            {' · '}{r.company.members.toLocaleString('en-IN')} people · {r.company.customers.toLocaleString('en-IN')} customers · {r.company.jobs.toLocaleString('en-IN')} jobs · {r.company.attendanceRows.toLocaleString('en-IN')} attendance rows
            {r.company.address && <Text dimColor> · {r.company.address}</Text>}
            {r.company.timezone && <Text dimColor> · {r.company.timezone}</Text>}
            {(r.company.gstin || r.company.upi) && (
              <Text color={C.green}> · {[r.company.gstin ? 'GSTIN ✓' : null, r.company.upi ? 'UPI ✓' : null].filter(Boolean).join(' ')}</Text>
            )}
          </Text>
        )}

        {order.map((key) => byKey[key])}
      </Panel>
    </Frame>
  );
}

function Section(props: { id: string; label: string; count?: number; color: string; children: ReactNode }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <SectionTitle label={props.label} count={props.count} color={props.color} />
      {props.children}
    </Box>
  );
}
