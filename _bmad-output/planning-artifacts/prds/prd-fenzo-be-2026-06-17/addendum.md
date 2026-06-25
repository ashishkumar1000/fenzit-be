# PRD Addendum — Jobzo Backend Phase 1 MVP

Items captured here were contributed during Discovery but belong downstream (architecture, infra setup) or were explicitly deferred. The PRD's `[ASSUMPTION]` tags reference this file where applicable.

---

## A1. PDF Renderer Decision

**Options considered:**

| Option | Pros | Cons |
|---|---|---|
| **Typst** | Deterministic layout; no Chrome dependency; fast; can be called as a subprocess | Newer ecosystem; CSS-like but not CSS; learning curve for template authors |
| **Headless Chrome / Puppeteer** | Full CSS/HTML; most common in Indian SaaS; familiar to any web dev | External process; memory-heavy (~300MB); slower cold start; Docker complexity on DigitalOcean |
| **WeasyPrint** | Good CSS support; Python ecosystem | Requires Python sidecar; mixed results with complex tables |
| **wkhtmltopdf** | Widely deployed | Being deprecated; no active maintenance |

**Recommendation for architecture phase:** Typst if the team is comfortable with it — it eliminates a Chrome dependency and runs as a fast subprocess. Headless Chrome if the team wants faster iteration on invoice layout using standard CSS. Either runs as a sidecar process called from the Bun.js backend.

**Decision to record at architecture phase.** Open question OQ-1 in PRD §11.

---

## A2. WhatsApp BSP Selection

**Options considered:**

| BSP | Monthly Cost | Onboarding | API Quality | India-optimised |
|---|---|---|---|---|
| **Interakt** | ~₹2,499/mo | Fast (1–2 days) | REST, good docs | Yes |
| **Wati** | ~$49/mo (~₹4,100) | Fast (1–2 days) | REST, good docs | Yes |
| **Gupshup** | Variable (per-msg) | Moderate | Lower-level API | Yes |
| **Meta Cloud API (direct)** | Per-conversation (~₹0.58–0.94) | Slower (Business verification) | Best long-term | Yes |

**Recommendation:** Interakt or Wati for Phase 1 (fastest onboarding for beta). Migrate to Meta Cloud API direct after 1,000+ conversations/month to reduce cost. Gupshup suits high-volume; premature for Phase 1.

**Pre-requisite regardless of BSP:** 4 WhatsApp Business message templates must be pre-approved before beta customer onboarding. Template approval: 1–24 hours per template. Submit templates in Week 1.

**Decision to record at infrastructure setup.** Open question OQ-2 in PRD §11.

---

## A3. OTP Provider (Phase 2 Pre-requisite)

**Recommendation:** MSG91 for Phase 2 real OTP.
- De-facto standard for Indian SaaS OTP
- Dedicated OTP API with retry fallback (SMS → voice)
- Supports DLT-registered sender IDs (mandatory in India since TRAI 2021)

**DLT Registration** is a legal pre-requisite for all transactional SMS in India. The process:
1. Register on the DLT portal (Jio Trueconnect, Videocon, etc.)
2. Register Sender ID and message templates
3. Wait for approval: 2–4 weeks

**Action required:** Initiate DLT registration in Week 1 of the build, even though real OTP is Phase 2. Missing this delays Phase 2 by weeks.

---

## A4. Supabase RLS Policy Design Notes

Multi-tenancy is enforced via Supabase Row Level Security, not application-layer filters. Every table with tenant-scoped data follows this pattern:

```sql
-- Example for jobs table
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON jobs
  USING (tenant_id = (auth.jwt() -> 'tenant_id')::uuid);
```

The JWT `tenant_id` claim is set by the Bun.js backend when issuing JWTs (or by Supabase Auth if using Supabase Auth custom claims).

**Important:** The Bun.js backend must never disable RLS or use a service role key for business-data queries. Service role is reserved for background jobs (overdue transition cron, WhatsApp worker) that run outside of user JWT context.

---

## A5. WhatsApp Message Queue Architecture

Messages are queued in a `whatsapp_messages` PostgreSQL table (not in-memory, not Redis in Phase 1) so they survive server restarts. A background worker polls the table for `queued` messages and delivers via BSP API.

Minimal schema for the queue table:
- `id`, `tenant_id`, `job_id`, `invoice_id` (nullable), `customer_phone`, `template_name`, `template_variables` (JSONB), `status` (`queued | sent | delivered | failed`), `bsp_message_id` (nullable), `idempotency_key`, `enqueued_at`, `sent_at`, `delivered_at`

Worker polling interval: every 10 seconds in Phase 1. No external message broker (SQS, Redis Streams) needed at this scale.
