# Reports module (Epic 12)

Owner PDF report generation: an owner requests a report for a date range
(optionally scoped to technicians), an in-process worker generates the PDF,
stores it in R2, and the owner polls/downloads it through the status endpoint.

## Layout

```
src/reports/
  reports.module.ts            module wiring (imports only common/ + storage — NFR5)
  reports.controller.ts        POST / · GET / · GET /:id (owner-only)
  reports.service.ts           create/status/list + params validation
  report-response.model.ts     row + response shapes (single source)
  registry/
    report-definition.ts       the definition contract (params, fetcher, builder)
    report-registry.ts         the registry map (FR9/NFR6)
    report-params.util.ts      IST date-range validation (no date library)
    technician-job-activity.definition.ts   first report (wired end to end, 12-5)
    technician-job-activity.data.ts         fetcher: IST bounds, paged queries, attachment counts
    technician-job-activity.metrics.ts      PRD §4 metrics (pure fn over fetched jobs)
    technician-job-activity.flags.ts        "needs attention" flags (pure fn)
    technician-job-activity.template.ts     template composed from brand-kit helpers
  templates/
    brand-kit/                 FR-T1: the one file(s) owning the brand
      brand-theme.ts           theme tokens (colours, grays, status tints, table/card constants)
      brand-assets.ts          logo data URI + Inter TTF paths (loaded once)
      brand-icons.ts           Lucide SVG icons (loaded once, recolored per use)
      page-chrome.ts           barrel — the kit's single import surface
      page-header.ts           pageHeader (identity + accent bar) / pageFooter
      summary-cards.ts         summaryCardRow — accent-topped metric cards
      job-table.ts             jobsTable — tinted header, zebra body, fixed widths
      sections.ts              sectionTitle / flagList / empty states
      assets/                  fenzit-logo.png + fonts/Inter-*.ttf + icons/*.svg (Lucide)
  engine/
    report-worker.ts           in-process poll loop (bootstrap → destroy)
    report-pipeline.service.ts one claimed row: fetch → render → upload → stamp
    report-claims.ts           guarded-UPDATE claim/stamp helpers
    report-notifications.ts    terminal notification insert (logged-and-dropped on failure)
    pdf-renderer.port.ts       PdfRenderer port + PDF_RENDERER token
    pdfmake-renderer.ts        pdfmake binding (12-4): fonts once, Buffer out
  dto/                         create body + list query DTOs
```

## The de-SP concurrency story (no app-facing RPCs)

Epic 12 deliberately adds **zero stored procedures** (user decision,
2026-09-20; migrations 50 → 51 dropped the RPC era). Guarantees come from
plain Postgres instead:

- **In-flight cap (NFR-3, ≤ 3 queued+generating per tenant):** the
  `report_requests_in_flight_guard` BEFORE INSERT trigger (migration 51) —
  advisory xact lock per tenant + count + `PT429` raise. The service inserts
  plainly and maps `error.code === 'PT429'` → 429.
- **Claim / lease / recovery:** single guarded UPDATEs in
  `engine/report-claims.ts` — `where id = ? and status = 'queued'` (fresh
  claim) and `where id = ? and status = 'generating' and locked_until <
  now()` (lease recovery). A single conditional UPDATE is atomic in
  Postgres: exactly one concurrent caller wins. `attempt_count` is bumped
  by each claim (the value comes from the poll read; the guarded UPDATE is
  the serialization point). `REPORT_MAX_ATTEMPTS` (default 3) caps recovery
  re-runs → `failed report_generation_failed`.
- **Terminal stamp + notification:** two app-level steps in the worker
  (stamp `ready`/`failed` first, then insert the notification). The stamp
  is the commit point; a notification failure is logged and dropped — the
  FE history polling is the designed fallback. There is deliberately **no**
  RPC/trigger for the pair (the PRD's one-transaction clause was superseded
  in the de-SP pass — see story 12-3's deviation note).

## Terminal ordering (FR-4)

Upload to R2 (`{tenantId}/reports/{requestId}.pdf`, deterministic key via
`StorageService.putObject`) **strictly before** the ready stamp, which lands
`status='ready'` + `r2_key` + `file_size_bytes` + `completed_at` in one
guarded UPDATE. A DB failure after a successful upload self-heals: lease
recovery re-runs and re-uploads the same key. A row is never `ready` without
an uploaded file.

## Adding a new report type (extensibility contract, NFR6)

1. One definition file in `registry/` implementing `ReportDefinition`
   (stable `type`, `label`, `validateParams`, `fetchData`, `buildDocument`).
2. One `register(...)` entry in `report-registry.ts`.
3. **Zero** engine, API, or migration changes. The engine resolves the
   registry; unknown types are rejected at create time; a definition with a
   missing fetcher/builder degrades to a clean `failed` row, never a hang.

Data access inside a fetcher goes through the admin Supabase client handed
in via `ReportFetchContext` — the module never imports from `jobs/`,
`customers/`, etc.

## First report: `technician_job_activity` (12-5)

- **Fetcher** (`technician-job-activity.data.ts`): tenant identity
  (`company_name`, `address`), jobs with `scheduled_start` inside the IST day
  bounds (`end_date` inclusive via an exclusive upper bound), embedded
  `customers(name)` / `skills(name)`, chunked technician-name and
  attachment-count reads (photo/signature). Every list query is paginated
  (Supabase's default 1000-row cap); the only truncation point is the
  `REPORT_MAX_JOBS` guard, which fails `report_too_large`.
- **Metrics** (`…metrics.ts`, pure): total jobs, completed, cancelled, open
  (scheduled + in_progress), urgent jobs done, finished-on-time %
  (completed-only denominator, null `scheduled_end` excluded, zero
  completed → "—"), customers served, photos + signatures captured.
- **Flags** (`…flags.ts`, pure): the "Needs attention" section — jobs not
  done on time, urgent jobs still open, completed jobs with no proof of
  work, and cancellations (owner follow-up cues; user request 2026-09-20).
  All report wording is deliberately plain English (user request
  2026-09-20) — simple labels and short full sentences.
- **Template** (`…template.ts`): branded header with a scope line
  ("All technicians · N jobs in this period"), Overall first, then one
  section per technician — zero-job technicians keep their section with an
  empty-state row; a selection with zero jobs renders the "No jobs for
  these dates" page as a success (FR18).

## Template machine (FR-T1/FR-T2)

The brand kit (`templates/brand-kit/`) is the **only** place brand styling
lives: theme tokens in `brand-theme.ts`, assets in `brand-assets.ts`
(logo data URI + Inter TTF paths, loaded once at module load), icons in
`brand-icons.ts` (Lucide SVGs — the same set the FE renders via
lucide-react-native, bundled as standalone .svg files and recolored per
use; they render as vector paths via pdfmake's `svg` node, so they stay
crisp in print), and the chrome helpers split one responsibility per file
(`page-header.ts`, `summary-cards.ts`, `job-table.ts`, `sections.ts`) behind
the `page-chrome.ts` barrel. A template (one per report type) composes only
structure from these helpers — never a hard-coded colour, font, logo, or
icon path.

Report look (UI-polish pass, 2026-09-20): metric cards are light-fill
columns with a coloured top accent bar; table headers are a quiet brand
tint (not solid blue bars); the job table uses fixed column widths (only
Customer flexes) so every technician's table aligns, Date and Planned time
are one column ("20 Sep 16:30"), status cells get a light tint of their
status colour, and the body is zebra-only (no per-row rules). Flag rows are
severity-coloured — urgent/on-time failures red, missing proof amber,
cancellations muted — so "Needs attention" reads by urgency at a glance.
Section titles get generous top margins, and each section title is glued
to its first content block with a small `unbreakable` stack (pdfmake has
no keep-with-next) so no heading strands at a page bottom.

The renderer is pdfmake 0.3 behind the `PdfRenderer` port (`PDF_RENDERER`
token): pdfmake's server entry is a CJS singleton (`module.exports = new
pdfmake()`), so `PdfmakeRenderer` requires it directly and calls the
instance methods — named ESM imports don't resolve (Bun fails at module
load). Fonts register once in `PdfmakeRenderer`'s constructor, every
`render(doc)` compiles the doc definition and resolves a Buffer (no temp
files). Access is policy-locked at the singleton — no external URLs, local
reads allowlisted to the fonts dir — so a doc definition can't become an
SSRF/file-read primitive. pdfmake 0.3 notes: font sources must be **string
paths** (Buffers are typed but crash `Printer.resolveUrls`); images take
data URIs; the footer is a `(currentPage, pageCount) => Content` callback.

## Env vars

| Var | Default | Purpose |
| --- | --- | --- |
| `REPORT_PRESIGN_TTL_SECONDS` | 600 | Presigned URL TTL for the status endpoint |
| `REPORT_POLL_INTERVAL_SECONDS` | 5 | Worker poll tick |
| `REPORT_LEASE_SECONDS` | 300 | Claim lease (crash recovery window) |
| `REPORT_WORKER_CONCURRENCY` | 1 | Renders processed per tick (NFR-1: sequential) |
| `REPORT_MAX_JOBS` | 5000 | Oversize guard for the fetcher (12-5) |
| `REPORT_MAX_ATTEMPTS` | 3 | Recovery re-run cap |

## Status machine

`queued → generating → ready | failed` (terminal: ready, failed). The table
(`report_requests`, migration 48) is the queue; RLS is deny-by-default with
one tenant-isolation policy — the worker mutates through the admin client
only, and clients have no UPDATE/DELETE path.