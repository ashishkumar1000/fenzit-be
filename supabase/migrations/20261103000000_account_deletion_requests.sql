-- Account deletion requests from the public deletion page (POST /api/v1/account-deletion/requests).
--
-- Plain-English contract: a person asks for their account to be deleted. They prove
-- they own the phone number with a one-time code first. One row per request. A
-- platform admin reviews each open request. Nothing here deletes the account
-- itself; that happens in the admin review step (not built yet).
--
-- At most one OPEN request per user (partial unique index). A user who asks
-- again while a request is open gets the same answer and no second row.
--
-- RLS is on with NO policies, and anon and authenticated have no grants, so only
-- the backend's service role reads or writes this table.

create table public.account_deletion_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users (id) on delete restrict,
  status      text not null default 'open',
  reviewed_by uuid null references public.users (id) on delete restrict,
  reviewed_at timestamptz null,
  created_at  timestamptz not null default now(),
  constraint account_deletion_requests_status_check check (
    status in ('open', 'completed', 'rejected')
  ),
  constraint account_deletion_requests_review_consistent check (
    (status = 'open') = (reviewed_at is null)
    and (reviewed_at is null) = (reviewed_by is null)
  )
);

comment on table public.account_deletion_requests is
  'Account deletion requests from the public deletion page (personal data). RLS on, no policies: service role only.';

create unique index account_deletion_requests_one_open_per_user
  on public.account_deletion_requests (user_id)
  where status = 'open';

create index account_deletion_requests_user_idx
  on public.account_deletion_requests (user_id);

create index account_deletion_requests_status_created_idx
  on public.account_deletion_requests (status, created_at);

alter table public.account_deletion_requests enable row level security;

revoke all on public.account_deletion_requests from anon, authenticated;
