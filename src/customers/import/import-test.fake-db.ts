import { randomUUID } from 'crypto';

/**
 * Test-only (not a spec file, so the production build excludes nothing new:
 * it is never imported by production code). In-memory stand-in for the
 * Supabase admin client as the import uses it. It applies eq / in / gt
 * filters, enforces the constraints the import relies on (the customer phone
 * unique index, the replay key unique index, the created_via check, the
 * import_batches row-count check), and records every call so tests can
 * assert on the writes that really happened.
 */

export interface FakeError {
  code?: string;
  message?: string;
}

type Op = 'select' | 'insert' | 'update' | 'rpc';
type Mode = 'single' | 'maybeSingle' | 'many';
type Row = Record<string, unknown>;
interface Filter {
  kind: 'eq' | 'in' | 'gt' | 'lt';
  column: string;
  value: unknown;
}
export interface FakeCall {
  table: string;
  op: Op;
  rpcName?: string;
  payload?: unknown;
  filters: Filter[];
}
type Result = { data: unknown; error: FakeError | null };
export type FailOutcome = { error: FakeError } | { throws: string };
interface FailureRule {
  table?: string;
  op?: Op;
  rpcName?: string;
  outcome: FailOutcome;
  remaining: number;
}

const CREATED_VIA = ['manual', 'job_creation', 'bulk_import'];
const CUSTOMER_UNIQUE = ['tenant_id', 'country_code', 'phone_number'];
const REPLAY_UNIQUE = ['key', 'tenant_id', 'scope'];

export class FakeDb {
  readonly rows: Record<string, Row[]> = {
    customers: [],
    import_batches: [],
    idempotency_log: [],
  };
  readonly calls: FakeCall[] = [];
  readonly auditRows: Row[] = [];
  private readonly rules: FailureRule[] = [];

  /** Next `times` matching operations fail with an error result, or reject (network fault). */
  failNext(
    match: { table?: string; op?: Op; rpcName?: string },
    outcome: FailOutcome,
    times = 1,
  ): void {
    this.rules.push({ ...match, outcome, remaining: times });
  }

  /** Every call that is not a read. */
  writes(): FakeCall[] {
    return this.calls.filter((c) => c.op !== 'select');
  }

  seed(table: string, row: Row): void {
    this.rows[table].push({ created_at: '2026-01-01T00:00:00.000Z', ...row });
  }

  /** The object handed to the services as the admin client. */
  client(): unknown {
    return {
      from: (table: string) => this.builder(table),
      rpc: (name: string, args: Row) => this.rpcBuilder(name, args),
    };
  }

  private builder(table: string) {
    const call: FakeCall = { table, op: 'select', filters: [] };
    const api = {
      select: () => api,
      insert: (payload: unknown) => {
        call.op = 'insert';
        call.payload = payload;
        return api;
      },
      update: (payload: unknown) => {
        call.op = 'update';
        call.payload = payload;
        return api;
      },
      eq: (column: string, value: unknown) => {
        call.filters.push({ kind: 'eq', column, value });
        return api;
      },
      in: (column: string, value: unknown) => {
        call.filters.push({ kind: 'in', column, value });
        return api;
      },
      gt: (column: string, value: unknown) => {
        call.filters.push({ kind: 'gt', column, value });
        return api;
      },
      lt: (column: string, value: unknown) => {
        call.filters.push({ kind: 'lt', column, value });
        return api;
      },
      single: () => this.execute(call, 'single'),
      maybeSingle: () => this.execute(call, 'maybeSingle'),
      then: (ok: (r: Result) => unknown, fail?: (e: unknown) => unknown) =>
        this.execute(call, 'many').then(ok, fail),
    };
    return api;
  }

  private rpcBuilder(name: string, args: Row) {
    const call: FakeCall = {
      table: '',
      op: 'rpc',
      rpcName: name,
      payload: args,
      filters: [],
    };
    return {
      then: (ok: (r: Result) => unknown, fail?: (e: unknown) => unknown) =>
        this.execute(call, 'many').then(ok, fail),
    };
  }

  private execute(call: FakeCall, mode: Mode): Promise<Result> {
    this.calls.push(call);
    const rule = this.takeRule(call);
    if (rule && 'throws' in rule.outcome) {
      return Promise.reject(new Error(rule.outcome.throws));
    }
    if (rule && 'error' in rule.outcome) {
      return Promise.resolve({ data: null, error: rule.outcome.error });
    }
    return Promise.resolve(this.apply(call, mode));
  }

  private takeRule(call: FakeCall): FailureRule | undefined {
    const rule = this.rules.find(
      (r) =>
        r.remaining > 0 &&
        (r.table === undefined || r.table === call.table) &&
        (r.op === undefined || r.op === call.op) &&
        (r.rpcName === undefined || r.rpcName === call.rpcName),
    );
    if (rule) rule.remaining -= 1;
    return rule;
  }

  private apply(call: FakeCall, mode: Mode): Result {
    if (call.op === 'rpc') return this.applyRpc(call);
    if (call.op === 'insert') return this.applyInsert(call, mode);
    if (call.op === 'update') return this.applyUpdate(call, mode);
    const rows = this.matching(call);
    return this.shape(rows.map(clone), mode);
  }

  private applyRpc(call: FakeCall): Result {
    if (call.rpcName !== 'write_audit_row') {
      return { data: null, error: { code: '42883', message: 'no such rpc' } };
    }
    this.auditRows.push({ ...(call.payload as Row) });
    return { data: null, error: null };
  }

  private applyInsert(call: FakeCall, mode: Mode): Result {
    const payloads = Array.isArray(call.payload)
      ? (call.payload as Row[])
      : [call.payload as Row];
    const inserted: Row[] = [];
    for (const payload of payloads) {
      const problem = this.constraintProblem(call.table, payload, null);
      if (problem) return { data: null, error: problem };
      const row: Row = {
        created_at: new Date().toISOString(),
        ...payload,
        id: payload.id ?? randomUUID(),
      };
      this.rows[call.table].push(row);
      inserted.push(clone(row));
    }
    return this.shape(inserted, mode);
  }

  private applyUpdate(call: FakeCall, mode: Mode): Result {
    const patch = call.payload as Row;
    const targets = this.matching(call);
    for (const row of targets) {
      const problem = this.constraintProblem(call.table, patch, row);
      if (problem) return { data: null, error: problem };
    }
    for (const row of targets) Object.assign(row, patch);
    return this.shape(targets.map(clone), mode);
  }

  /** Checks the constraints the import relies on. `existing` is set on updates. */
  private constraintProblem(
    table: string,
    payload: Row,
    existing: Row | null,
  ): FakeError | null {
    const merged = { ...(existing ?? {}), ...payload };
    if (table === 'customers') {
      if (
        'created_via' in payload &&
        !CREATED_VIA.includes(String(payload.created_via))
      ) {
        return { code: '23514', message: 'customers_created_via_check' };
      }
      const clash = this.rows.customers.some(
        (r) =>
          r !== existing && CUSTOMER_UNIQUE.every((c) => r[c] === merged[c]),
      );
      if (clash)
        return { code: '23505', message: 'customers_tenant_phone_unique' };
    }
    if (table === 'import_batches') {
      const sum =
        Number(merged.created_count) +
        Number(merged.updated_count) +
        Number(merged.failed_count);
      if (sum !== Number(merged.row_total)) {
        return { code: '23514', message: 'import_batches_row_counts_check' };
      }
    }
    if (table === 'idempotency_log') {
      const clash = this.rows.idempotency_log.some(
        (r) => r !== existing && REPLAY_UNIQUE.every((c) => r[c] === merged[c]),
      );
      if (clash) return { code: '23505', message: 'idempotency_log_unique' };
    }
    return null;
  }

  private matching(call: FakeCall): Row[] {
    return this.rows[call.table].filter((row) =>
      call.filters.every((f) => {
        if (f.kind === 'eq') return row[f.column] === f.value;
        if (f.kind === 'in')
          return (f.value as unknown[]).includes(row[f.column]);
        if (f.kind === 'lt') return String(row[f.column]) < String(f.value);
        return String(row[f.column]) > String(f.value);
      }),
    );
  }

  private shape(rows: Row[], mode: Mode): Result {
    if (mode === 'many') return { data: rows, error: null };
    if (mode === 'maybeSingle') {
      if (rows.length > 1) return { data: null, error: { code: 'PGRST116' } };
      return { data: rows[0] ?? null, error: null };
    }
    if (rows.length !== 1) return { data: null, error: { code: 'PGRST116' } };
    return { data: rows[0], error: null };
  }
}

function clone<T extends Row>(row: T): T {
  return { ...row };
}
