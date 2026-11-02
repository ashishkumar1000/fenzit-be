-- Photo reports and hiding (Google Play user-content policy).
--
-- Plain-English contract: anyone who can open a job can report one of its
-- photos. A report waits in a queue for a Fenzit platform admin. The admin
-- either hides the photo (hidden_at is set; it then leaves job detail and
-- sync) or dismisses the report. A photo is never hidden by a report alone.
--
-- One report per person per photo (UNIQUE). A report is never edited except
-- to be resolved once: status moves from 'open' to 'hidden' or 'dismissed'.
--
-- RLS is on with NO policies, and anon and authenticated have no grants, so
-- only the backend's service role reads or writes attachment_reports.

alter table public.attachments
  add column hidden_at timestamptz null;

comment on column public.attachments.hidden_at is
  'Set by a platform admin when a reported photo is hidden. Hidden photos are left out of job detail and sync.';

create table public.attachment_reports (
  id            uuid primary key default gen_random_uuid(),
  attachment_id uuid not null references public.attachments (id) on delete cascade,
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  reporter_id   uuid not null references public.users (id) on delete restrict,
  reason        text not null,
  note          text null,
  status        text not null default 'open',
  reviewed_by   uuid null references public.users (id) on delete restrict,
  reviewed_at   timestamptz null,
  created_at    timestamptz not null default now(),
  constraint attachment_reports_one_per_reporter
    unique (attachment_id, reporter_id),
  constraint attachment_reports_reason_check check (
    reason in ('inappropriate', 'harassment', 'spam', 'other')
  ),
  constraint attachment_reports_status_check check (
    status in ('open', 'hidden', 'dismissed')
  ),
  constraint attachment_reports_note_length check (
    note is null or char_length(note) between 1 and 500
  ),
  constraint attachment_reports_review_consistent check (
    (status = 'open') = (reviewed_at is null)
    and (reviewed_at is null) = (reviewed_by is null)
  )
);

comment on table public.attachment_reports is
  'Reports of job photos (user content). RLS on, no policies: service role only.';

create index attachment_reports_status_created_idx
  on public.attachment_reports (status, created_at);

alter table public.attachment_reports enable row level security;

revoke all on public.attachment_reports from anon, authenticated;
