-- Story 23-5 review follow-ups: pf_config gets row identity (the calendar
-- idiom) and the head name gains the DB shape backstop its sibling
-- (salary_components) already carries. DDL only.

alter table public.payroll_pf_config
  add column id uuid primary key default gen_random_uuid();

alter table public.payroll_deduction_heads
  add constraint payroll_deduction_heads_name_shape
    check (char_length(name) between 1 and 60);
