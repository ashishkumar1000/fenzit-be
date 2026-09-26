-- Story 15-3 review hardening (2026-09-26): a rule row's tenant_id must
-- match its office's tenant. The RPCs already derive both from the office;
-- this composite FK closes the non-RPC write paths (defense-in-depth).
--
-- UNIQUE (id, tenant_id) gives the FK its matching target. The original
-- single-column FK (rules.office_id → offices.id, ON DELETE RESTRICT) stays:
-- it still blocks deleting an office that has rules, exactly as the story
-- spec prescribes.

alter table attendance_offices
  add constraint attendance_offices_id_tenant_id_key unique (id, tenant_id);

alter table attendance_office_rules
  add constraint attendance_office_rules_office_tenant_fkey
    foreign key (office_id, tenant_id)
    references attendance_offices (id, tenant_id)
    on delete cascade;
