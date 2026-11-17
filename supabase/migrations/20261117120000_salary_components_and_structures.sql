-- Story 23-3 of spec-payroll (CAP-1, CAP-2): the salary component library and
-- per-employee salary structures.
--
-- salary_components: one catalog per company. Exactly one row is the basic
-- component (the PF base and the Form V basic/DA line); the service enforces
-- the single-basic rule at write time — the table stays plain so the
-- zero-functions boundary holds. Rows are mutable config: renames are legal
-- and reach the next run (payslips snapshot names at run time, story 6+);
-- deactivation is refused while any structure row still references the
-- component (the service lists the employees).
--
-- salary_structures: effective-dated rows per membership — the structure in
-- effect for a run month is the latest row with effective_from <= that
-- month's first day (month-start resolution). A same-date save REPLACES that
-- dated row in place (upsert on the unique below): the dated row is the
-- configuration for every month it governs, and locked months keep the
-- run-time snapshot, so replacing config never rewrites pay history. Lines
-- are validated JSONB — per component, either an amount or a formula AST —
-- because the story mandates two config tables and the run snapshots whole
-- rows; the service validates shape (depth/node caps), cycles (naming the
-- chain), zero-operand division and negative results before anything is
-- stored. Component references are UUIDs, never names, so a rename cannot
-- rewrite pay history.
--
-- Validation split: the API rejects bad input with plain-English messages
-- before it reaches here; the database only guarantees shape, uniqueness and
-- tenancy at the storage layer.
--
-- Zero new functions: every read and write goes through the NestJS service,
-- which stamps updated_at itself (no trigger by design — same boundary as
-- leave_types).

create table public.salary_components (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  name       varchar(60) not null,
  is_basic   boolean not null default false,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint salary_components_name_len_check
    check (char_length(name) between 1 and 60),
  constraint salary_components_tenant_name_uq unique (tenant_id, name)
);

create table public.salary_structures (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  membership_id uuid not null,
  effective_from date not null,
  lines         jsonb not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- One dated revision per month boundary: a same-date save replaces the
  -- row, a different date is a new revision.
  constraint salary_structures_membership_effective_uq
    unique (membership_id, effective_from),
  constraint salary_structures_effective_from_is_date_check
    check (effective_from = effective_from::date),
  constraint salary_structures_lines_is_array_check
    check (jsonb_typeof(lines) = 'array')
);

-- The composite target the structures FK points at, so a structure can only
-- ever belong to a membership of its own company (same idiom as
-- leave_types_id_tenant_id_key).
alter table public.memberships
  add constraint memberships_id_tenant_id_key unique (id, tenant_id);

alter table public.salary_structures
  add constraint salary_structures_membership_tenant_fkey
    foreign key (membership_id, tenant_id)
    references public.memberships (id, tenant_id)
    on delete cascade;

create index salary_structures_tenant_idx
  on public.salary_structures (tenant_id);
create index salary_structures_membership_effective_idx
  on public.salary_structures (membership_id, effective_from);

comment on table public.salary_components is
  'Per-company salary component library (CAP-1): a name, the one is_basic designation (the PF base / Form V basic line) and an active flag. Renames reach the next run; deactivation is refused while any structure references the component.';
comment on column public.salary_components.is_basic is
  'The designated basic component — exactly one per company, enforced by the service. The PF base and the Form V basic/DA line resolve through it.';
comment on column public.salary_components.active is
  'false retires the component from new use. Only ever settable when no structure row references the component (service probe).';
comment on table public.salary_structures is
  'Per-employee effective-dated salary structures (CAP-2): lines is a validated JSONB array of {componentId, amount} or {componentId, formula} entries; the run resolves the latest effective_from <= the month''s first day. A same-date save replaces the row.';
comment on column public.salary_structures.effective_from is
  'Month-start effective dating: first used by the first run month whose first day is on/after this date; a mid-month-dated revision is first used by the NEXT month''s run.';
comment on column public.salary_structures.lines is
  'JSONB array, one entry per component: {"componentId": uuid, "amount": "20000.00"} (exact decimal text) or {"componentId": uuid, "formula": AST}. Formula AST: {kind: component|const|percent-of|binary, ...} — validated at save (cycles, zero-operand division, negatives rejected; depth <= 8, nodes <= 32).';

-- Deny-by-default (house pattern): RLS on with no policies, every grant
-- cleared, service_role only — the NestJS admin client is the only
-- reader/writer.
alter table public.salary_components enable row level security;
alter table public.salary_structures enable row level security;

revoke all on public.salary_components from public, anon, authenticated;
revoke all on public.salary_structures from public, anon, authenticated;

grant select, insert, update, delete on public.salary_components to service_role;
grant select, insert, update, delete on public.salary_structures to service_role;
