/**
 * Temp end-to-end verification for story 12-5 (deleted after review):
 * runs the real fetcher → template → PdfmakeRenderer against the live DB
 * with the Solar Sytem tenant's 2026-09-20 jobs, writes the PDF to the repo
 * root for a visual check. Run: bun tmp-verify-12-5.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { fetchTechnicianJobActivityData } from './src/reports/registry/technician-job-activity.data';
import { buildTechnicianJobActivityDocument } from './src/reports/registry/technician-job-activity.template';
import { PdfmakeRenderer } from './src/reports/engine/pdfmake-renderer';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const ctx = {
  supabase,
  tenantId: 'd82d0e0d-f88b-4134-a55a-79d0f9a065dc',
  requestId: 'local-verify',
  params: { start_date: '2026-09-20', end_date: '2026-09-20', technician_ids: [] },
  maxJobs: 5000,
};

async function main(): Promise<void> {
const t0 = Date.now();
const data = await fetchTechnicianJobActivityData(ctx);
console.log(
  `fetched jobs=${data.jobs.length} technicians=${data.technicians.length} tenant="${data.tenant.companyName}" in ${Date.now() - t0}ms`,
);
for (const j of data.jobs) {
  console.log(
    `  ${j.jobNumber} ${j.status} ${j.customerName} / ${j.skillName} / ${j.technicianId.slice(0, 8)} att=${j.photoCount}+${j.signatureCount}`,
  );
}

const doc = buildTechnicianJobActivityDocument(data);
const pdf = await new PdfmakeRenderer().render(doc);
const out = '12-5-verify.pdf';
writeFileSync(out, pdf);
console.log(`bytes=${pdf.length} head=${pdf.subarray(0, 5).toString()} out=${out}`);
}

void main();