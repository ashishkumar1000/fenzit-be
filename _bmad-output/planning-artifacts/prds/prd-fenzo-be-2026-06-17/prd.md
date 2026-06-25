---
title: Jobzo – Field Service Management Backend (Phase 1 MVP — Core)
status: draft
created: 2026-06-17
updated: 2026-06-18
---

# PRD: Jobzo — Field Service Management Backend (Phase 1 MVP — Core)

## 0. Document Purpose

This PRD defines requirements for the Jobzo backend service (`fenzit-be`, Bun.js with TypeScript), which exposes a REST API consumed by two clients: a React web dashboard (owner/dispatcher) and a React Native mobile app (field technicians). Scope is limited to three domains: owner/tenant onboarding, technician invite and auth, and the full job lifecycle. Invoicing, WhatsApp notifications, and dashboard aggregations are deferred to a subsequent PRD increment. Downstream consumers: architecture design, database schema, epics and stories.

UX detail lives in `Jobzo_Prototype.pptx`; business context in `ServeEasy_Business_Plan.docx`.

---

## 1. Vision

Jobzo is a multi-tenant SaaS backend for small Indian trade service businesses (AC repair, pest control, plumbing, electrical — 1–20 technicians). The backend is the single source of truth for jobs, customers, and technician activity within a tenant account.

This increment delivers one thing: a business owner can create a job, assign it to a technician, and the technician can execute it end-to-end from a mobile app — even without connectivity. Everything else (invoicing, payments, WhatsApp, analytics) follows in a subsequent increment once the job lifecycle is stable and tested with beta customers.

The backend runs on Digital Ocean, backed by Supabase (PostgreSQL + RLS for tenant isolation, Storage for file assets, Realtime for live job updates). Auth is mock OTP → JWT in Phase 1. The API is stateless REST with JWT bearer tokens.

---

## 2. Target User

### 2.1 Jobs To Be Done

**Business Owner (web dashboard)**
- Create and assign jobs without picking up a phone
- Know the live status of every job across all technicians at any moment
- Have a complete record of what each technician did on each job

**Field Technician (React Native mobile app)**
- See today's assigned jobs the moment they log in — no training required
- Report job progress with one tap, including from a basement or weak-signal area
- Capture proof-of-work (photos, customer signature) before leaving the site

### 2.2 Non-Users (this increment)

- Customers — no inbound API surface for customers in this increment
- Accountants — no invoicing or financial data in this increment
- Businesses with > 20 technicians — multi-branch is Phase 3

### 2.3 Key User Journeys

**UJ-1. Owner creates a job and assigns it to a technician.**
- **Persona + context:** Ravi, owner of a 6-tech AC service company in Mumbai, books a new call from a returning customer.
- **Entry state:** Authenticated on the web dashboard, Jobs screen.
- **Path:** Taps "New Job" → selects existing customer (Priya Sharma) → fills service type, address, date/time, assigns technician (Suresh), sets priority → taps "Create Job."
- **Climax:** Job `JB-2026-0043` appears in the Kanban board under Scheduled. Ravi can see it is assigned to Suresh.
- **Resolution:** Ravi returns to the job board and can see all today's jobs by status.
- **Edge case:** If Ravi types a new customer name and phone, the system creates the Customer record silently before creating the Job.

**UJ-2. Technician executes a job and the owner sees it update live.**
- **Persona + context:** Suresh, AC technician, working in Priya's apartment basement (intermittent 2G).
- **Entry state:** Authenticated on the React Native app, today's job list.
- **Path:** Taps the job → taps "On My Way" → drives to site → taps "Arrived" → taps "In Progress" → completes work → uploads 2 photos → captures Priya's digital signature → taps "Mark Complete."
- **Climax:** Job moves to Completed on Ravi's dashboard in real time.
- **Resolution:** Suresh sees his completed count update and moves to his next job.
- **Edge case:** Suresh loses connectivity mid-job. Local state is preserved on-device and synced when connection returns — no step is lost.

---

## 3. Glossary

- **Tenant** — A single registered business account. All data is scoped to a Tenant. One Tenant has many Users, Jobs, and Customers.
- **Owner** — A User with `role = owner` who accesses the web dashboard. Full read/write over all Tenant data.
- **Technician** — A User with `role = technician` who accesses the mobile app. Can read and advance only their own assigned Jobs.
- **Job** — A single field service appointment. Belongs to one Tenant, one Customer, and one Technician. Has a lifecycle (see Job Status).
- **Job Status** — The ordered lifecycle state of a Job: `scheduled → in_progress → completed`. `scheduled` can also transition to `cancelled`.
- **Workflow Step** — One of six ordered technician actions within the `in_progress` phase: `on_my_way`, `arrived`, `in_progress`, `photos_uploaded`, `signature_captured`, `completed`.
- **Customer** — A business contact record scoped to a Tenant. Auto-created when a new phone number is used on Job creation.
- **Activity Log** — An append-only, timestamped record of events on a Job. Immutable once written.
- **JWT** — Bearer token issued on OTP verification. Contains `user_id`, `tenant_id`, `role`. Required on every protected API call.
- **Mock OTP** — Phase 1 auth shortcut: any 6-digit code is accepted for any phone number. No SMS or WhatsApp delivery. Replaced in Phase 2.
- **Sync Cursor** — A `last_synced_at` ISO 8601 timestamp held by the mobile app to request only delta changes since last sync.

---

## 4. Features

### 4.1 Authentication & Tenant Onboarding

**Description:** All users authenticate via mobile phone number and OTP. No passwords exist anywhere in the system. In Phase 1, OTP delivery is mocked — the server accepts any 6-digit code for any phone number, enabling development and beta testing without SMS infrastructure. On first login, an owner completes company setup (Tenant record). Technicians are invited by phone number and join via OTP login.

A JWT is issued on successful OTP verification and must accompany every subsequent API request as a Bearer token. The JWT encodes `user_id`, `tenant_id`, and `role`. Middleware validates JWT signatures on every protected route and rejects expired or malformed tokens.

[ASSUMPTION: Supabase Auth JWT is used; the Bun.js backend validates using the Supabase JWT secret. Revisit at architecture phase if a custom token issuer is preferred.]

**Functional Requirements:**

#### FR-1: Mock OTP initiation
`POST /api/v1/auth/otp/send`. Accepts a mobile number in E.164 format (`+91XXXXXXXXXX`). Creates a time-limited OTP session (5-minute TTL). Does not deliver any message in Phase 1. Returns `{otp_session_id, expires_at}`.

**Consequences (testable):**
- Returns `200` with `otp_session_id` for a valid E.164 mobile number.
- Returns `422` for a non-E.164 or non-numeric number.
- Returns `429` if the same number requests > 5 OTPs within 10 minutes.
- Session is unusable after the 5-minute TTL; caller must re-initiate.

#### FR-2: OTP verification and JWT issuance
`POST /api/v1/auth/otp/verify`. Accepts `otp_session_id` + `otp_code`. On success, returns a signed JWT and user profile (`user_id`, `tenant_id` if set, `role`, `name`). If `tenant_id` is null (first-ever login), the client proceeds to company onboarding (FR-3).

**Consequences (testable):**
- Mock mode: any 6-digit numeric code succeeds.
- Returns `401` for wrong code or expired session.
- Returns `401` after 5 failed attempts within a session (session locked; new OTP required).
- JWT validity: 7 days. No refresh endpoint in Phase 1.

#### FR-3: Tenant (company) onboarding
`POST /api/v1/auth/company`. Owner-only. Accepts: `company_name` (required), `gstin` (optional), `address`, `state_code` (ISO 3166-2:IN, e.g., `MH`), `service_categories` (array of enum values), `upi_vpa` (optional). Creates the Tenant record and sets the calling User's `tenant_id`. Idempotent — subsequent calls update the company profile.

**Consequences (testable):**
- Returns `201` on create, `200` on update.
- Returns `403` if called by a Technician.
- GSTIN validated against format `\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d][Z][A-Z\d]` when provided; returns `422` on mismatch.
- `state_code` required; returns `422` if missing.

#### FR-4: Technician invitation
`POST /api/v1/auth/invite`. Owner-only. Creates a pending `invited` User record for the provided phone number, scoped to the Owner's Tenant. On first OTP login from that phone, the pending invite is auto-accepted and the Technician is activated under the Owner's Tenant.

**Consequences (testable):**
- Returns `201` with `{invite_id}` on creation.
- Returns `409` if the phone is already an active member of the Tenant.
- A phone can hold a pending invite from only one Tenant at a time.
- First OTP login from the invited phone activates the Technician; subsequent logins work normally.
- Invited Technician payload includes `name` and `skill_type` (enum: `ac_technician | pest_control | plumbing | electrical | general`).

#### FR-5: JWT authentication middleware
All routes except `/auth/otp/send` and `/auth/otp/verify` require a valid JWT. Middleware extracts `tenant_id` and `role` and injects them into the request context for route handlers and Supabase RLS evaluation.

**Consequences (testable):**
- Returns `401` for missing, malformed, or expired JWT on any protected route.
- Returns `403` if the caller's role does not permit the operation.

---

### 4.2 Job Management

**Description:** The core entity. A Job is created by an Owner, assigned to a Technician, and executed through a six-step Workflow. Every status change is appended to the Activity Log. Job status drives the Kanban board on the owner dashboard and the job list on the technician app. Realizes UJ-1, UJ-2.

Job number format: `JB-{YYYY}-{NNNN}` — sequential per Tenant per calendar year, zero-padded to 4 digits (e.g., `JB-2026-0001`). [ASSUMPTION: counter resets each calendar year; starts at `0001` regardless of tenant onboarding date within the year.]

**Functional Requirements:**

#### FR-6: Create job
`POST /api/v1/jobs`. Owner-only. Required fields: `customer_id` (or inline `new_customer` object with `name` + `phone`), `service_location` (string; defaults to customer address if omitted), `service_type` (enum: `ac_service | ac_installation | pest_control | plumbing | electrical | other`), `scheduled_start` (ISO 8601), `technician_id`. Optional: `scheduled_end` (ISO 8601), `description`, `priority` (`normal | urgent`, default `normal`), `require_completion_photo` (boolean, default `false`), `notes_for_technician`. System assigns Job Number, sets status to `scheduled`, and appends a `job_created` Activity Log entry.

**Consequences (testable):**
- Returns `201` with the full job object including assigned Job Number.
- Returns `422` if any required field is missing.
- If `new_customer` phone matches an existing Customer in the Tenant, the system links to the existing Customer (no duplicate created).
- Returns `404` if `technician_id` does not belong to the caller's Tenant.
- Activity Log entry `job_created` appended with `actor = owner_user_id` and timestamp.

#### FR-7: List jobs
`GET /api/v1/jobs`. Query parameters: `date` (ISO 8601 date, defaults to today in IST), `status` (repeatable: `?status=scheduled&status=in_progress`), `technician_id`. Owners receive all Tenant jobs matching filters; Technicians receive only their own assigned jobs regardless of filters.

**Consequences (testable):**
- Default `date=today` returns jobs where `scheduled_start` falls within the current calendar day in IST (UTC+5:30). [ASSUMPTION: all tenants in Phase 1 operate in IST.]
- Technicians cannot filter by other technicians' jobs — `technician_id` param is ignored for Technician role.
- Pagination: cursor-based, default page size 50.
- Returns `200` with empty array (not `404`) when no jobs match.

#### FR-8: Job detail
`GET /api/v1/jobs/:id`. Returns full job with: all fields, Technician profile (name, phone, skill_type), Customer profile (name, phone, address), Activity Log (ordered oldest-first), Attachments list (photo URLs + signature URL), current Workflow Step.

**Consequences (testable):**
- Returns `404` for a job not belonging to the caller's Tenant (RLS enforced).
- Attachment URLs are pre-signed Supabase Storage URLs with 1-hour TTL, refreshed on each call.
- Technician can only retrieve detail for their own assigned jobs; returns `403` otherwise.

#### FR-9: Edit, reassign, or cancel job
`PATCH /api/v1/jobs/:id`. Owner-only. Mutable on a `scheduled` job: `description`, `scheduled_start`, `scheduled_end`, `notes_for_technician`, `technician_id` (reassign), `priority`. To cancel: `{status: "cancelled"}`.

**Consequences (testable):**
- Returns `409` when attempting to cancel a job not in `scheduled` status.
- Returns `409` when attempting to edit fields on an `in_progress`, `completed`, or `cancelled` job.
- Returns `403` if called by a Technician.
- Reassignment appends a `job_reassigned` Activity Log entry recording both previous and new `technician_id`.
- Cancellation appends a `job_cancelled` entry.

#### FR-10: Technician workflow step advancement
`POST /api/v1/jobs/:id/workflow`. Technician-only. Body: `{step: "<step_name>", idempotency_key: "<uuid>"}`. Steps must be submitted in order: `on_my_way → arrived → in_progress → photos_uploaded → signature_captured → completed`. `on_my_way` transitions Job status to `in_progress`. `completed` transitions Job status to `completed`.

**Consequences (testable):**
- Returns `422` if a step is submitted out of order; response body includes `current_step` so the client can reconcile.
- `photos_uploaded` is skippable when `require_completion_photo = false`; submitting `signature_captured` directly after `in_progress` is valid.
- Re-submitting an already-completed step returns `200` with current state (idempotent via `idempotency_key`).
- Each step appends an Activity Log entry: step name, timestamp, `actor = technician_user_id`.
- Returns `403` if called by an Owner.

#### FR-11: Activity log (auto-recorded)
Append-only log managed entirely by the backend. No create/update/delete endpoint exposed. Events: `job_created`, `job_reassigned`, `job_cancelled`, `step_on_my_way`, `step_arrived`, `step_in_progress`, `step_photos_uploaded`, `step_signature_captured`, `step_completed`, `conflict_resolved`.

**Consequences (testable):**
- Activity Log entries are never modified or deleted.
- Every entry includes: `event_type`, `actor` (`user_id` or `system`), `timestamp`, optional `metadata` (JSON blob).
- Returned as part of FR-8 job detail, ordered oldest-first.

#### FR-12: Job attachment upload
`POST /api/v1/jobs/:id/attachments`. Technician-only. Upload photos (max 5 per job) or one customer signature. Files stored in Supabase Storage under `/{tenant_id}/jobs/{job_id}/`. Returns an attachment record with storage reference. Uploading the first photo auto-advances the `photos_uploaded` workflow step.

**Consequences (testable):**
- Accepts JPEG, PNG, HEIC up to 10 MB per file.
- Returns `413` for files over 10 MB; `422` for unsupported MIME types.
- Returns `409` on attempting to upload a 6th photo.
- Signature: one per job; re-uploading replaces the existing entry.
- Pre-signed read URLs have 1-hour TTL, refreshed on each FR-8 call.

---

### 4.3 Customer Management

**Description:** Customers are contact records scoped to a Tenant. Created manually or auto-created via Job creation (FR-6). Accumulate job history automatically. Required for Job creation; kept lightweight in this increment.

**Functional Requirements:**

#### FR-13: Create customer
`POST /api/v1/customers`. Owner-only. Required: `name`, `phone` (E.164). Optional: `address`, `city`. Auto-creation via FR-6: if `new_customer.phone` matches an existing Customer in the Tenant, the system links the existing Customer rather than creating a duplicate.

**Consequences (testable):**
- Returns `409` if a Customer with the same `phone` already exists in the Tenant.
- Auto-created Customers (via job creation) have `created_via: job_creation` set.
- Returns `201` on manual creation.

#### FR-14: List and search customers
`GET /api/v1/customers`. Owner-only. Supports `q` (partial match on name and phone, case-insensitive). Returns for each Customer: `name`, `phone`, `city`, `job_count`, `last_job_date`. Pagination: cursor-based, page size 50.

**Consequences (testable):**
- Returns `403` if called by a Technician.
- Partial phone search matches any substring of the stored number.
- Returns `200` with empty array for a new Tenant with no customers.

#### FR-15: Customer detail
`GET /api/v1/customers/:id`. Returns full Customer profile with paginated Job history (newest first): job number, `scheduled_start`, `status`, `service_type`.

**Consequences (testable):**
- Returns `404` for a Customer not belonging to the caller's Tenant.
- Job history pagination: cursor-based, page size 20.

---

### 4.4 Technician Mobile Sync (Offline-First)

**Description:** The React Native app must function when a technician has no connectivity. The app queues actions locally and syncs when connection returns. The backend provides a delta sync endpoint and enforces idempotency on all incoming mobile actions. Realizes UJ-2 edge case.

**Functional Requirements:**

#### FR-16: Delta sync endpoint
`POST /api/v1/sync`. Technician-only. Accepts `last_synced_at` (ISO 8601 or null for initial sync). Returns all Job records for the authenticated Technician updated since `last_synced_at`: all fields, current workflow step, attachment metadata, customer name/address. Response includes `server_time` which the client stores as the next `last_synced_at`.

**Consequences (testable):**
- Null `last_synced_at` returns the full job dataset for the Technician (initial sync).
- Response scoped strictly to the authenticated Technician's own jobs.
- Response time < 500ms p95 for up to 50 changed records.
- `server_time` is the server's UTC timestamp at query execution.

#### FR-17: Idempotent action replay
Workflow step calls (FR-10) and attachment uploads (FR-12) accept an optional `idempotency_key` (UUID v4). Re-submitting the same key within 24 hours returns the original response without re-processing.

**Consequences (testable):**
- Keys stored for 24 hours then expired.
- Duplicate within window returns `200` with original response body.
- Post-expiry re-submission processed as a new request.

#### FR-18: Conflict resolution rules
Server-side resolution for offline-replayed actions:
- **Workflow steps**: A step already recorded server-side is a no-op (idempotent). An out-of-order step returns `422` with `current_step` in the body.
- **Attachments**: Last upload wins per slot (photo by index 1–5, signature by type).

**Consequences (testable):**
- Out-of-order step replay returns `422` with `{current_step}` so the client can reconcile.
- Every conflict appends a `conflict_resolved` Activity Log entry — no silent data drops.

---

## 5. Non-Goals (Explicit)

**Deferred to next PRD increment:**
- GST-compliant invoicing — invoice generation, PDF, line items, tax calculation
- WhatsApp notification engine — all three customer-facing templates and payment reminder
- Dashboard summary aggregations — jobs today, pending invoices, revenue MTD
- Automated invoice overdue transitions

**Deferred to Phase 2:**
- Real OTP delivery (SMS via MSG91 or WhatsApp OTP)
- UPI / payment gateway (Razorpay, Cashfree)
- GPS / real-time technician location tracking
- AMC / recurring job scheduling
- Quotes and estimates
- Customer self-service portal
- Push notifications (FCM/APNS)
- Reports and exports

**Deferred to Phase 3:**
- Multi-branch / multi-location
- Regional language support (Hindi, Tamil)
- Global (non-GST) mode with Stripe
- AI-based job scheduling

---

## 6. MVP Scope (This Increment)

### 6.1 In Scope
- Mock OTP authentication with JWT issuance (FR-1, FR-2)
- Tenant setup — company onboarding (FR-3)
- Technician invite and accept flow (FR-4)
- JWT middleware with role-based access control (FR-5)
- Full Job lifecycle: create → assign → 6-step Technician workflow → complete (FR-6–FR-11)
- Job attachment upload — photos and customer signature to Supabase Storage (FR-12)
- Customer create, list/search, detail (FR-13–FR-15)
- Technician mobile delta sync with offline-first idempotency and conflict resolution (FR-16–FR-18)
- Supabase RLS for multi-tenant data isolation across all tables

### 6.2 Out of Scope for This Increment
- Invoicing, PDF generation, payment tracking
- WhatsApp template messages
- Dashboard summary endpoint
- Automated background jobs (overdue cron, etc.)

---

## 7. Cross-Cutting NFRs

### 7.1 Multi-Tenancy and Data Isolation
- All data tables include `tenant_id`.
- Supabase RLS policies enforce every query is scoped to the JWT `tenant_id` claim. The Bun.js backend does not substitute explicit `WHERE tenant_id = ?` for RLS.
- Cross-tenant data leaks are a hard launch blocker.

### 7.2 Authentication and Authorization
- All routes except `/auth/otp/send` and `/auth/otp/verify` require a valid JWT.
- Owner routes return `403` for Technician callers; Technician-only routes return `403` for Owner callers.
- OTP brute-force: 5 failed verify attempts locks the session; 5 send requests per phone per 10 minutes triggers `429`.

### 7.3 Performance
- List endpoints (jobs, customers): p95 < 300ms under 100 concurrent tenants.
- Delta sync (≤ 50 records): p95 < 500ms.

### 7.4 Reliability
- No in-memory application state. All state in Supabase.
- Supabase Realtime for live job status push to the web dashboard; frontend polls on Realtime disconnection.

### 7.5 Security
- All file access via pre-signed Supabase Storage URLs only — no public buckets.
- Customer phone numbers stored in plaintext (required for Phase 2 WhatsApp integration). [ASSUMPTION: no field-level PII encryption at rest in Phase 1.]

### 7.6 Observability
- Structured JSON logs: `request_id`, `tenant_id`, `route`, `http_status`, `duration_ms` on every request.
- Error responses include machine-readable `error_code` and human-readable `message`.

---

## 8. API Contracts (Surface Summary)

All endpoints prefixed `/api/v1/`. All payloads `application/json`. Authenticated endpoints require `Authorization: Bearer {jwt}`.

### Auth & Onboarding
| Method | Path | Role | FR |
|---|---|---|---|
| POST | `/auth/otp/send` | Public | FR-1 |
| POST | `/auth/otp/verify` | Public | FR-2 |
| POST | `/auth/company` | Owner | FR-3 |
| POST | `/auth/invite` | Owner | FR-4 |
| POST | `/auth/invite/accept` | Technician | FR-4 |

### Jobs
| Method | Path | Role | FR |
|---|---|---|---|
| POST | `/jobs` | Owner | FR-6 |
| GET | `/jobs` | Owner / Tech | FR-7 |
| GET | `/jobs/:id` | Owner / Tech | FR-8 |
| PATCH | `/jobs/:id` | Owner | FR-9 |
| POST | `/jobs/:id/workflow` | Tech | FR-10 |
| POST | `/jobs/:id/attachments` | Tech | FR-12 |

### Customers
| Method | Path | Role | FR |
|---|---|---|---|
| POST | `/customers` | Owner | FR-13 |
| GET | `/customers` | Owner | FR-14 |
| GET | `/customers/:id` | Owner | FR-15 |

### Sync
| Method | Path | Role | FR |
|---|---|---|---|
| POST | `/sync` | Tech | FR-16 |

---

## 9. Success Metrics

**Primary**
- **SM-1**: Owner can create a job and a technician can complete it end-to-end within a single session, with full Activity Log populated. Validates FR-6, FR-10, FR-11.
- **SM-2**: Technician app daily active rate ≥ 70% of invited technicians within 14 days of tenant signup. Validates FR-1–FR-5, FR-7, FR-10.

**Secondary**
- **SM-3**: Offline job completion — technician completes all 6 workflow steps without connectivity and data syncs correctly on reconnect. Validates FR-16–FR-18.
- **SM-4**: API list endpoint p95 < 300ms under load. Validates §7.3.
- **SM-5**: Zero cross-tenant data leaks in pre-launch penetration test. Validates §7.1.

**Counter-metrics (do not optimize at these expenses)**
- **SM-C1**: Do not reduce required job fields to make FR-6 easier — `customer`, `service_location`, `scheduled_start`, `technician` must remain mandatory. Incomplete records break the downstream invoicing increment.
- **SM-C2**: Do not skip FR-16–FR-18 to simplify the initial build — a technician app that fails offline will be abandoned in the field and destroy SM-2.

---

## 10. Open Questions

1. **Supabase Realtime for job board**: Is Supabase Realtime sufficient for < 20 concurrent technicians per tenant, or does the owner web dashboard need a dedicated WebSocket? → Architecture phase decision.
2. **Supabase Auth JWT vs. custom**: Using Supabase Auth JWT simplifies RLS wiring. If the team prefers a custom JWT issuer in Bun.js, RLS policies must be adjusted. → Architecture phase decision.
3. **Invite expiry**: Should technician invites expire (e.g., 7 days)? Currently no expiry defined. → Needs decision before epics.
4. **Technician self-profile update**: Can a Technician update their own name or skill_type after joining? Not defined in this increment.
5. **Job deletion vs. cancellation**: Only cancellation is supported (soft). Hard delete is explicitly not included. Confirm this is sufficient for beta.

---

## 11. Assumptions Index

- **§1** — All Tenants in Phase 1 operate in IST (UTC+5:30).
- **§4.1** — Supabase Auth JWT used; Bun.js backend validates against Supabase JWT secret.
- **§4.2 FR-6** — Job numbers sequential per Tenant per calendar year; counter resets Jan 1.
- **§4.2 FR-7** — IST timezone used for `date=today` filter across all tenants in Phase 1.
- **§4.4 FR-17** — `idempotency_key` is optional but encouraged; not enforced in Phase 1.
- **§7.5** — No field-level PII encryption at rest in Phase 1.
