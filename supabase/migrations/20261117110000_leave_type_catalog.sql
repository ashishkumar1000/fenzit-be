-- Story 23-2 of spec-payroll (CAP-12): the leave-type catalog for LOP.
--
-- leave_types: one catalog per company — a name and a paid/unpaid marking.
-- The payroll run (a later story) derives LOP from UNPAID leaves only; NULL
-- typing on a request reads as paid, so an untyped leave never causes an LOP
-- surprise. The catalog starts empty per company on purpose: the four common
-- types are one API call each from the admin, and the create endpoint applies
-- the confirmed keyword default (casual/sick/earned → paid, unpaid/LOP →
-- unpaid, anything else → paid) unless the owner picks the marking.
--
-- leave_requests.leave_type_id links a request to its type. The FK is
-- composite (id, tenant_id) so a request can only ever point at a type of
-- its own company — a cross-tenant link is impossible at the storage layer,
-- not just in the service. Deleting a type that requests still reference is
-- refused (ON DELETE RESTRICT; the API probes first and answers a plain
-- English 409).
--
-- No backfill: every existing request keeps leave_type_id NULL (= paid) and
-- no row of leave_requests changes today. Zero new functions — the reads and
-- writes go through the NestJS service (zero-RPC rule), which also means NO
-- updated_at trigger on leave_types: the service stamps the column itself on
-- every change (by design — same zero-functions boundary).

create table public.leave_types (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  name       varchar(60) not null,
  paid       boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint leave_types_name_len_check
    check (char_length(name) between 1 and 60),
  -- One catalog per company: two types cannot share a name.
  constraint leave_types_tenant_name_uq unique (tenant_id, name),
  -- The composite target for leave_requests' (id, tenant_id) foreign key.
  constraint leave_types_id_tenant_id_key unique (id, tenant_id)
);

create index leave_types_tenant_name_idx
  on public.leave_types (tenant_id, name);

alter table public.leave_requests
  add column leave_type_id uuid,
  add constraint leave_requests_type_tenant_fkey
    foreign key (leave_type_id, tenant_id)
    references public.leave_types (id, tenant_id)
    on delete restrict;

comment on table public.leave_types is
  'Per-company leave-type catalog (CAP-12): a name plus the paid/unpaid marking the payroll run uses to derive LOP from unpaid leaves.';
comment on column public.leave_types.name is
  'Catalog name shown in the admin and on the leave form; unique inside the company, 1-60 characters.';
comment on column public.leave_types.paid is
  'true = paid leave (never LOP); false = unpaid leave (LOP in a payroll run). Rows are mutable config — a run resolves the marking at execution time.';
comment on column public.leave_requests.leave_type_id is
  'The leave type this request carries. NULL reads as paid until typed; the composite foreign key makes a cross-tenant link impossible, and a type with referencing requests cannot be deleted.';

-- Deny-by-default (15-7 hygiene, same as the leave tables): RLS on with no
-- policies, every grant cleared, service_role only — the NestJS admin client
-- is the only reader/writer.
alter table public.leave_types enable row level security;

revoke all on public.leave_types from public, anon, authenticated;

grant select, insert, update, delete on public.leave_types to service_role;
