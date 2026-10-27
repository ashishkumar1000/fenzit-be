import { Box, Text, useInput } from 'ink';
import { Badge, TextInput } from '@inkjs/ui';
import { useState, type ReactNode } from 'react';
import { projectRef, type Target } from './core';

/**
 * The super CLI's design system — one place that decides how the tool looks.
 *
 * Palette (flamboyant on purpose, but the map stays honest):
 *   green  = read-only        cyan   = inspect / identity
 *   amber  = mutating flags   red    = deletion
 *   gold→orange gradient = the brand, only on the wordmark.
 * Nothing here ever makes a destructive screen look calm; the purges keep
 * their warning styling in purge-ui.tsx.
 */

export const C = {
  gold: '#FFE066',
  orange: '#FF922B',
  ember: '#FF6B00',
  amber: '#FBBF24',
  red: '#F87171',
  green: '#4ADE80',
  cyan: '#22D3EE',
  magenta: '#E879F9',
  slate: '#94A3B8',
} as const;

/** Views hand this to escape back to the menu, optionally leaving a receipt line behind. */
export type OnMenu = (note?: string) => void;

export function hexLerp(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

/** Per-character truecolor gradient — ink renders each char with its own hex. */
export function GradientText(props: { text: string; from: string; to: string }) {
  const chars = [...props.text];
  const n = Math.max(1, chars.length - 1);
  return (
    <Text>
      {chars.map((ch, i) => (
        <Text key={i} color={hexLerp(props.from, props.to, i / n)}>{ch}</Text>
      ))}
    </Text>
  );
}

/** ANSI-shadow SUPER, one colour step per letter. */
const GLYPHS = [
  ['███████╗', '██╗   ██╗', '██████╗ ', '███████╗', '██████╗ '],
  ['██╔════╝', '██║   ██║', '██╔══██╗', '██╔════╝', '██╔══██╗'],
  ['███████╗', '██║   ██║', '██████╔╝', '█████╗  ', '██████╔╝'],
  ['╚════██║', '██║   ██║', '██╔═══╝ ', '██╔══╝  ', '██╔══██╗'],
  ['███████║', '╚██████╔╝', '██║     ', '███████╗', '██║  ██║'],
  ['╚══════╝', ' ╚═════╝ ', '╚═╝     ', '╚══════╝', '╚═╝  ╚═╝'],
] as const;

export function Wordmark() {
  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {GLYPHS.map((row, ri) => (
          <Text key={ri}>
            {row.map((cell, li) => (
              <Text key={li} color={hexLerp(C.gold, C.ember, li / (row.length - 1))}>
                {cell}{' '}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
      <Box gap={2} marginTop={1}>
        <Text bold color={C.gold}>⌾ fenzit owner control</Text>
        <Text dimColor>project <Text bold>{projectRef()}</Text></Text>
      </Box>
      <Text dimColor>
        read-only <Text color={C.green}>green</Text> · mutating <Text color={C.amber}>amber</Text> · deletes <Text color={C.red}>red</Text>
      </Text>
      <GradientText text={'─'.repeat(56)} from={C.gold} to={C.ember} />
    </Box>
  );
}

/** Sectioned, always-coloured, number-addressable menu — launcher and backup picker. */
export interface MenuItem {
  value: string;
  label: string;
  description?: string;
  /** Hex — the row keeps its semantic colour even unfocused (the danger map is ambient). */
  color: string;
  section?: { label: string; color: string };
  /** Fixed picker key; defaults to position (1–9, 0 for the tenth). */
  index?: string;
}

export function MenuList(props: {
  items: MenuItem[];
  onPick: (value: string) => void;
  onCtrlC?: () => void;
  hint?: string | null;
}) {
  const [index, setIndex] = useState(0);
  const items = props.items;
  const hasQuit = items.some((i) => i.index === 'q');
  // 1–9 plus 0 for the tenth row; an 11th row is fine when it is the q-quit.
  const numbered = items.length <= 10 || (items.length === 11 && hasQuit);
  const labelWidth = Math.max(...items.map((i) => i.label.length));
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      props.onCtrlC?.();
      return;
    }
    const n = items.length;
    if (key.upArrow || input === 'k') setIndex((i) => (i - 1 + n) % n);
    else if (key.downArrow || input === 'j') setIndex((i) => (i + 1) % n);
    else if (key.home || input === 'g') setIndex(0);
    else if (key.end || input === 'G') setIndex(n - 1);
    else if (key.return) props.onPick(items[index].value);
    else if (numbered && /^[0-9]$/.test(input)) {
      const k = input === '0' ? 9 : Number(input) - 1;
      if (k >= 0 && k < n) props.onPick(items[k].value);
    } else if (input === 'q' && hasQuit) {
      props.onPick(items.find((i) => i.index === 'q')!.value);
    }
  });
  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        const focused = i === index;
        const sec = item.section;
        const showSection = sec !== undefined && (i === 0 || items[i - 1].section?.label !== sec.label);
        const gutter = item.index ?? (numbered ? (i === 9 ? '0' : String(i + 1)) : ' ');
        return (
          <Box key={item.value} flexDirection="column">
            {showSection && sec !== undefined && (
              <Text>
                {'  '}
                <Text bold color={sec.color}>◆ {sec.label}</Text>
                <Text dimColor> ────</Text>
              </Text>
            )}
            <Text>
              <Text color={focused ? item.color : C.slate} bold={focused}>{focused ? '❯' : ' '}</Text>
              <Text> </Text>
              <Text dimColor>{gutter}</Text>
              <Text> </Text>
              <Text color={item.color} bold={focused} dimColor={!focused}>{item.label.padEnd(labelWidth)}</Text>
              {item.description && <Text dimColor>  {item.description}</Text>}
            </Text>
          </Box>
        );
      })}
      {props.hint !== null && props.hint !== undefined && <Text dimColor>  {props.hint}</Text>}
    </Box>
  );
}

/** View chrome: coloured ▌TITLE header, content, truthful key footer. */
export function Frame(props: {
  title: string;
  subtitle?: string;
  accent: string;
  /** null hides the footer (a child already prints its own). */
  hint?: string | null;
  children: ReactNode;
}) {
  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Box gap={1}>
        <Text bold color={props.accent}>▌{props.title}</Text>
        {props.subtitle && <Text dimColor>{props.subtitle}</Text>}
      </Box>
      {props.children}
      {props.hint !== null && (
        <Text dimColor>{props.hint ?? 'esc — menu · ctrl+c — quit'}</Text>
      )}
    </Box>
  );
}

/** Rounded data panel in the view's accent colour. */
export function Panel(props: { accent: string; children: ReactNode }) {
  return (
    <Box borderStyle="round" borderColor={props.accent} flexDirection="column" paddingX={1}>
      {props.children}
    </Box>
  );
}

/** Small coloured section label with a count — one data group inside a view. */
export function SectionTitle(props: { label: string; count?: number; color: string }) {
  return (
    <Text>
      <Text bold color={props.color}>▸ {props.label}</Text>
      {props.count !== undefined && <Text dimColor> ({props.count})</Text>}
    </Text>
  );
}

/** btop-style glance strip: bold coloured value over a dim label, one tile per data family. */
export function StatTiles(props: { tiles: Array<{ label: string; value: number; color: string }> }) {
  return (
    <Box gap={2} paddingLeft={1}>
      {props.tiles.map((t) => (
        <Box key={t.label} flexDirection="column">
          <Text bold color={t.color}>{t.value.toLocaleString('en-IN')}</Text>
          <Text dimColor>{t.label.toUpperCase()}</Text>
        </Box>
      ))}
    </Box>
  );
}

/**
 * Fixed-width data table: gold header row, per-column body colours, every
 * cell a fixed-width box (layout pads — never trust trailing spaces) so
 * nothing breaks the grid. `colors[i]` tints column i; uncoloured body
 * cells render dim (they're the meta).
 */
export function DataTable(props: {
  head: string[];
  widths: number[];
  rows: ReactNode[][];
  colors?: Array<string | undefined>;
  empty?: string;
}) {
  if (props.rows.length === 0) {
    return <Text dimColor>  {props.empty ?? 'nothing here'}</Text>;
  }
  const cellBox = (content: ReactNode, i: number): ReactNode => (
    <Box key={i} width={props.widths[i] ?? 10} flexShrink={0}>{content}</Box>
  );
  const gutter = (i: number): ReactNode => (
    <Box key={`g${i}`} width={1} flexShrink={0}><Text> </Text></Box>
  );
  return (
    <Box flexDirection="column">
      <Box paddingLeft={2}>
        {props.head.map((h, i) => [i > 0 ? gutter(i) : null, cellBox(
          <Text bold color={C.gold}>{h.toUpperCase().slice(0, props.widths[i] ?? 10)}</Text>,
          i,
        )])}
      </Box>
      {props.rows.map((row, r) => (
        <Box key={r} paddingLeft={2}>
          {row.map((v, i) => [
            i > 0 ? gutter(i) : null,
            (() => {
              if (typeof v === 'string') {
                const color = props.colors?.[i];
                return cellBox(
                  <Text color={color} dimColor={!color}>{v.slice(0, props.widths[i] ?? 10)}</Text>,
                  i,
                );
              }
              return cellBox(v, i);
            })(),
          ])}
        </Box>
      ))}
    </Box>
  );
}

/** Horizontal bar that scales against `max` — the stats dashboard and purge counts. */
export function Bar(props: { value: number; max: number; color: string; width?: number }) {
  const w = props.width ?? 18;
  const filled = props.max > 0 ? Math.max(props.value > 0 ? 1 : 0, Math.round((props.value / props.max) * w)) : 0;
  return (
    <Text>
      <Text color={props.color}>{'█'.repeat(Math.min(filled, w))}</Text>
      <Text dimColor>{'░'.repeat(Math.max(0, w - filled))}</Text>
    </Text>
  );
}

/** Inline dim-label/bold-value run — the counts strip under a whois. */
export function CountsRow(props: { counts: Array<{ k: string; v: number | string }> }) {
  return (
    <Text>
      {'  '}
      {props.counts.map((c, i) => (
        <Text key={c.k}>
          {i > 0 && <Text dimColor> · </Text>}
          <Text dimColor>{c.k} </Text>
          <Text bold>{typeof c.v === 'number' ? c.v.toLocaleString('en-IN') : c.v}</Text>
        </Text>
      ))}
    </Text>
  );
}

export function fmtPhone(t: Pick<Target, 'countryCode' | 'phoneNumber'>): string {
  const cc = t.countryCode.replace('+', '');
  return `+${cc} ${t.phoneNumber.slice(0, 5)} ${t.phoneNumber.slice(5)}`;
}

export function kindColor(kind: Target['kind']): string {
  return kind === 'staff' ? C.amber : kind === 'owner' ? C.magenta : kind === 'technician' ? C.cyan : C.slate;
}

export function TargetBadges({ target }: { target: Target }) {
  return (
    <Box gap={1}>
      <Badge color={target.kind === 'staff' ? 'yellow' : target.kind === 'owner' ? 'magenta' : target.kind === 'technician' ? 'cyan' : 'white'}>{target.kind}</Badge>
      {target.membership && <Badge color="cyan">{target.membership.role}</Badge>}
      {target.platformAdmin && <Badge color="yellow">STAFF</Badge>}
      {target.disabled && <Badge color="red">DISABLED</Badge>}
    </Box>
  );
}

export function PhoneInput(props: { label: string; onSubmit: (phone: string) => void }) {
  return (
    <Box>
      <Text>{props.label}: </Text>
      <TextInput
        placeholder="9876543210 · 919876543210"
        onSubmit={(v) => {
          if (v.trim()) props.onSubmit(v.trim());
        }}
      />
    </Box>
  );
}

export function ErrorLine(props: { message: string }) {
  return <Text color={C.red} bold>✗ {props.message}</Text>;
}
