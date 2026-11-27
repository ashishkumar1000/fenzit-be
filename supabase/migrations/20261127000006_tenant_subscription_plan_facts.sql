-- The overview's subscription banner (2026-11-27 exec-dashboard revamp) reads
-- the company's plan facts straight off the tenant row: the plan chip, the
-- billing line and the auto-renew note. Defaults keep every existing company
-- valid; the platform can update them per tenant later. Plain columns only —
-- no triggers, no functions.
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS plan_name text NOT NULL DEFAULT 'Enterprise',
  ADD COLUMN IF NOT EXISTS billing_cycle text NOT NULL DEFAULT 'Annual',
  ADD COLUMN IF NOT EXISTS auto_renews boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.tenants.plan_name IS
  'Subscription plan display name (the overview banner''s plan chip).';
COMMENT ON COLUMN public.tenants.billing_cycle IS
  'Billing cadence display word (e.g. Annual, Monthly) for the overview banner.';
COMMENT ON COLUMN public.tenants.auto_renews IS
  'Whether the subscription renews on its own (overview banner note).';
