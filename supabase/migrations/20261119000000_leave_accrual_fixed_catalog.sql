-- Story 23-13 of spec-payroll (CAP-12): the earned-leave accrual program.
--
-- The free-form 23-2 catalog narrows to a FIXED four-type catalog per
-- company: Earned Leave (monthly accrual, default 1/month, carry-forward
-- on), Sick Leave (monthly, 0.5/month, CF off), Bereavement (annual fixed
-- grant, 0 until the owner sets the number), Comp-Off (no accrual, paid,
-- owner approves). Types can no longer be created or deleted; the owner
-- edits VALUES only. Every pre-existing row either matches a fixed code by
-- its name (case-insensitive word keywords; unpaid-flavoured names never
-- match) or lands as a disabled read-only remnant with code NULL.
--
-- DDL order is deliberate: columns first (no constraints — pre-existing
-- rows are code NULL + enabled true, so the shape checks would abort),
-- then the data reshape, then the constraints that pin the final shape.
--
-- Balances are DERIVED on read (April-March FY) — no scheduler, no
-- year-end routine. leave_balance_credits stores only MANUAL opening
-- credits/corrections (source is check-pinned to 'manual', so a future
-- carry-forward source can never double-count against the derived chain).
--
-- Zero new functions (the epic rule): the reshape is a DO block, reads and
-- writes go through the NestJS service, NO updated_at trigger — the
-- service stamps the column itself. The seed writes no audit rows (a
-- system action, not an owner edit).

alter table public.leave_types
  add column code varchar(20),
  add column accrual_mode text,
  add column accrual_days numeric(5, 2) not null default 0,
  add column carry_forward boolean not null default false,
  add column allow_over_balance boolean not null default false,
  add column enabled boolean not null default true;

-- The reshape. Per company, rows are classified onto the fixed codes in
-- created_at order — the first keyword-matching row takes the code, later
-- matches of the same code become remnants. A name matching two codes'
-- keywords resolves by the pinned priority comp_off > bereavement >
-- sick > earned. Remnants are renamed out of the canonical names' way
-- BEFORE the canonical renames (unique (tenant_id, name) would otherwise
-- abort the reshape), then disabled in one update, then the four rows are
-- ensured. Every remnant is RAISE NOTICE-d — the migration output is the
-- operator's record of what did not join the program.
do $$
declare
  v_tenant uuid;
  v_rec record;
  v_taken text[];
  v_code text;
  v_match_ids uuid[];
  v_match_codes text[];
  v_remnants uuid[];
  v_remnant_names text[] := '{}';
  v_remnant_id uuid;
  v_remnant_name text;
  v_suffix text;
  v_counter int;
  v_base text;
  v_candidate text;
  v_n int;
  v_exists boolean;
begin
  -- EVERY company leaves with the full fixed catalog, including companies
  -- that never created a leave type — the loop walks tenants, not rows.
  for v_tenant in select id from public.tenants loop
    v_taken := '{}';
    v_match_ids := '{}';
    v_match_codes := '{}';
    v_remnants := '{}';
    v_remnant_names := '{}';

    -- (i) classify only (no writes yet — the canonical renames must wait
    -- for the remnant renames): first match per code wins; unpaid-
    -- flavoured names never match; a taken code demotes the row to a
    -- remnant.
    for v_rec in select id, name
                   from public.leave_types
                  where tenant_id = v_tenant
                  order by created_at asc, id asc
      loop
      v_code := null;
      if lower(v_rec.name) !~ '(^|[^a-z])(unpaid|lop)([^a-z]|$)' then
        if lower(v_rec.name) ~ '(^|[^a-z])(comp off|comp-off|compoff|compensatory)([^a-z]|$)' then
          v_code := 'comp_off';
        elsif lower(v_rec.name) ~ '(^|[^a-z])(bereavement|compassionate|funeral)([^a-z]|$)' then
          v_code := 'bereavement';
        elsif lower(v_rec.name) ~ '(^|[^a-z])(sick|medical)([^a-z]|$)' then
          v_code := 'sick';
        elsif lower(v_rec.name) ~ '(^|[^a-z])earned([^a-z]|$)' then
          v_code := 'earned';
        end if;
      end if;

      if v_code is not null and not (v_code = any(v_taken)) then
        v_taken := array_append(v_taken, v_code);
        v_match_ids := array_append(v_match_ids, v_rec.id);
        v_match_codes := array_append(v_match_codes, v_code);
      else
        v_remnants := array_append(v_remnants, v_rec.id);
        v_remnant_names := array_append(v_remnant_names, v_rec.name);
      end if;
    end loop;

    -- (ii) rename collision-yielding remnants first: a remnant holding a
    -- canonical name must yield it before the matched row (or the ensured
    -- row) can claim it. `<name> (custom)`, counter ` (custom N)` on
    -- further collision, every rename clipped to the 60-char name check.
    for v_n in 1 .. coalesce(array_length(v_remnants, 1), 0) loop
      v_remnant_id := v_remnants[v_n];
      v_remnant_name := v_remnant_names[v_n];
      if v_remnant_name in ('Earned Leave', 'Sick Leave', 'Bereavement', 'Comp-Off') then
        v_suffix := ' (custom)';
        v_counter := 1;
        loop
          v_base := left(v_remnant_name, 60 - char_length(v_suffix));
          v_candidate := v_base || v_suffix;
          select exists (
            select 1 from public.leave_types
             where tenant_id = v_tenant and name = v_candidate
          ) into v_exists;
          exit when not v_exists;
          v_counter := v_counter + 1;
          v_suffix := ' (custom ' || v_counter::text || ')';
        end loop;
        update public.leave_types
           set name = v_candidate
         where id = v_remnant_id;
        raise notice 'leave catalog: "%" renamed to "%" (tenant %)',
          v_remnant_name, v_candidate, v_tenant;
      end if;
    end loop;

    -- (iii) the matched rows take their canonical name, code, mode and
    -- default accrual value; their own paid markings are kept.
    for v_n in 1 .. coalesce(array_length(v_match_ids, 1), 0) loop
      v_code := v_match_codes[v_n];
      update public.leave_types
         set code = v_code,
             accrual_mode = case v_code
                              when 'earned' then 'monthly'
                              when 'sick' then 'monthly'
                              when 'bereavement' then 'annual'
                              else 'none'
                            end,
             accrual_days = case v_code
                              when 'earned' then 1.00
                              when 'sick' then 0.50
                              else 0
                            end,
             carry_forward = (v_code = 'earned'),
             name = case v_code
                      when 'earned' then 'Earned Leave'
                      when 'sick' then 'Sick Leave'
                      when 'bereavement' then 'Bereavement'
                      else 'Comp-Off'
                    end
       where id = v_match_ids[v_n];
    end loop;

    -- (iv) disable every remnant in one update; code/accrual_mode stay
    -- NULL (the remnant's read-only marker) and the name is kept.
    if coalesce(array_length(v_remnants, 1), 0) > 0 then
      update public.leave_types
         set enabled = false
       where id = any(v_remnants);
      for v_n in 1 .. array_length(v_remnants, 1) loop
        raise notice 'leave catalog: "%" kept as a disabled remnant (tenant %)',
          v_remnant_names[v_n], v_tenant;
      end loop;
    end if;

    -- (v) ensure the four rows: every company leaves this migration with
    -- the full fixed catalog enabled.
    if not ('earned' = any(v_taken)) then
      insert into public.leave_types
        (tenant_id, name, code, accrual_mode, accrual_days, carry_forward, paid, enabled)
      values (v_tenant, 'Earned Leave', 'earned', 'monthly', 1.00, true, true, true);
    end if;
    if not ('sick' = any(v_taken)) then
      insert into public.leave_types
        (tenant_id, name, code, accrual_mode, accrual_days, carry_forward, paid, enabled)
      values (v_tenant, 'Sick Leave', 'sick', 'monthly', 0.50, false, true, true);
    end if;
    if not ('bereavement' = any(v_taken)) then
      insert into public.leave_types
        (tenant_id, name, code, accrual_mode, accrual_days, carry_forward, paid, enabled)
      values (v_tenant, 'Bereavement', 'bereavement', 'annual', 0, false, true, true);
    end if;
    if not ('comp_off' = any(v_taken)) then
      insert into public.leave_types
        (tenant_id, name, code, accrual_mode, accrual_days, carry_forward, paid, enabled)
      values (v_tenant, 'Comp-Off', 'comp_off', 'none', 0, false, true, true);
    end if;
  end loop;
end $$;

-- The final shape, pinned: the four (code, mode) pairs are the only legal
-- combos; remnants (code NULL) can never be enabled, so a legacy row can
-- never silently join the program; CF and the over-balance escape are
-- monthly-only knobs (an annual grant never carries; mode-none is exempt
-- from the balance check entirely); NULL codes never collide (PG unique
-- treats NULLs as distinct).
alter table public.leave_types
  add constraint leave_types_code_mode_check
    check ((code, accrual_mode) in (
             ('earned', 'monthly'),
             ('sick', 'monthly'),
             ('bereavement', 'annual'),
             ('comp_off', 'none')
           ) or (code is null and accrual_mode is null)),
  add constraint leave_types_remnant_disabled_check
    check (code is not null or enabled = false),
  add constraint leave_types_accrual_days_check
    check (accrual_days between 0 and 366),
  add constraint leave_types_none_zero_check
    check (accrual_mode is distinct from 'none' or accrual_days = 0),
  add constraint leave_types_cf_monthly_check
    check (not carry_forward or accrual_mode = 'monthly'),
  add constraint leave_types_oab_monthly_check
    check (not allow_over_balance or accrual_mode = 'monthly'),
  add constraint leave_types_tenant_code_uq unique (tenant_id, code);

comment on column public.leave_types.code is
  'The fixed-catalog code: earned | sick | bereavement | comp_off. NULL = a legacy unmatched row, a disabled read-only remnant that can never be enabled.';
comment on column public.leave_types.accrual_mode is
  'How the type grants leave: monthly (rate per full month of the FY), annual (fixed grant for the whole FY, no pro-rating), none (no accrual — owner approves each use). NULL = remnant.';
comment on column public.leave_types.accrual_days is
  'The value the mode consumes: days per month for monthly, the annual grant for annual; 0 for none. 0 on a monthly type is legal (the owner has not set a rate yet — no credit accrues).';
comment on column public.leave_types.carry_forward is
  'Monthly-only knob: the prior FY''s unused balance (floored at 0) carries into this FY, derived on read — no year-end routine.';
comment on column public.leave_types.allow_over_balance is
  'Monthly-only knob: when true, an apply that exceeds the balance succeeds instead of answering 422.';
comment on column public.leave_types.enabled is
  'false hides the type from the employee catalog, blocks new applies and re-typing onto it, and excludes it from payslip capture. Balances still list disabled mode-bearing types (their consumed days remain visible).';

-- Manual opening credits and offsetting corrections, per person per type
-- per FY (identified by its starting April year). The composite foreign
-- keys make cross-tenant links impossible at the storage layer; the delete
-- behaviour mirrors the payroll tables (a membership or type going away
-- takes its credit history with it / a type cannot go while credits name
-- it).
create table public.leave_balance_credits (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  user_id       uuid not null,
  leave_type_id uuid not null,
  year          int not null,
  days          numeric(6, 2) not null,
  source        text not null,
  created_by    uuid not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint leave_balance_credits_year_check
    check (year between 2000 and 2999),
  -- Corrections are offsetting rows — a 0-day credit is dead data.
  constraint leave_balance_credits_days_check
    check (days <> 0),
  -- Only manual rows exist: the derived carry-forward is computed on read,
  -- never stored, so it can never double-count against itself.
  constraint leave_balance_credits_source_check
    check (source = 'manual'),
  constraint leave_balance_credits_user_tenant_fkey
    foreign key (user_id, tenant_id)
    references public.memberships (user_id, tenant_id)
    on delete cascade,
  constraint leave_balance_credits_type_tenant_fkey
    foreign key (leave_type_id, tenant_id)
    references public.leave_types (id, tenant_id)
    on delete restrict,
  constraint leave_balance_credits_creator_tenant_fkey
    foreign key (created_by, tenant_id)
    references public.memberships (user_id, tenant_id)
    on delete cascade
);

create index leave_balance_credits_tenant_user_type_year_idx
  on public.leave_balance_credits (tenant_id, user_id, leave_type_id, year);

comment on table public.leave_balance_credits is
  'Manual leave-balance credits (23-13): opening balances and offsetting corrections, per person per type per April-March FY. The balance itself is derived on read — credits + accrued + carry-forward - consumed.';
comment on column public.leave_balance_credits.year is
  'The FY the credit belongs to, identified by its starting April year (FY 2026 = 2026-04-01..2027-03-31).';
comment on column public.leave_balance_credits.days is
  'Signed day count: positive grants, negative corrects. Never 0.';
comment on column public.leave_balance_credits.source is
  'How the credit came to be; check-pinned to manual — corrections are offsetting rows, not edits.';

-- Deny-by-default (the 15-7 hygiene every table here follows): RLS on with
-- no policies, every grant cleared, service_role only — the NestJS admin
-- client is the only reader/writer.
alter table public.leave_balance_credits enable row level security;

revoke all on public.leave_balance_credits from public, anon, authenticated;

grant select, insert, update, delete on public.leave_balance_credits to service_role;

-- The payslip snapshot gains the leave-balance section, captured as of the
-- pay-period's last day at run time and frozen with the rest of the row.
alter table public.payroll_payslips
  add column if not exists leave_balances jsonb not null default '[]';

comment on column public.payroll_payslips.leave_balances is
  'The leave-balance snapshot (23-13): per enabled accrual-bearing type, as of the pay-period''s last day — [{ code, name, accrued, availed, carryForward, remaining }]. Empty when no type bears a balance.';
