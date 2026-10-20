/**
 * A customer, a job and two skill ids inside a throwaway company, for the
 * suites that need job rows (alerts, activity history). Real DEV database only.
 */
import { SupabaseClient } from '@supabase/supabase-js';
import { randomPhone } from './member-functions-fixture';

export interface JobFixture {
  customerId: string;
  jobId: string;
  skillIds: string[];
}

export async function seedJob(
  service: SupabaseClient,
  tenantId: string,
  technician: string,
  creator: string,
): Promise<JobFixture> {
  const { data: skills } = await service
    .from('skills')
    .select('id')
    .eq('is_active', true)
    .limit(2);
  const skillIds = (skills as { id: string }[]).map((s) => s.id);
  const { data: customer, error: customerError } = await service
    .from('customers')
    .insert({
      tenant_id: tenantId,
      name: 'MFQA customer',
      country_code: '+91',
      phone_number: randomPhone(),
    })
    .select('id')
    .single();
  expect(customerError).toBeNull();
  const customerId = (customer as { id: string }).id;
  const res = await service.rpc('create_job_with_log', {
    p_tenant_id: tenantId,
    p_customer_id: customerId,
    p_technician_id: technician,
    p_service_location: 'MFQA location',
    p_skill_id: skillIds[0],
    p_scheduled_start: new Date().toISOString(),
    p_scheduled_end: null,
    p_description: 'MFQA job',
    p_priority: 'normal',
    p_notes_for_technician: null,
    p_actor_id: creator,
    p_year: new Date().getUTCFullYear(),
  });
  expect(res.error).toBeNull();
  return {
    customerId,
    jobId: (res.data as { id: string }[])[0].id,
    skillIds,
  };
}
