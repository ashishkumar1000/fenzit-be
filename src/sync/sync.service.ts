import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { SyncJobDto, SyncResponseDto } from './dto/sync-response.dto';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(private readonly supabaseFactory: SupabaseClientFactory) {}

  async sync(user: RequestUser, lastSyncedAt?: string): Promise<SyncResponseDto> {
    // Capture serverTime BEFORE the query — conservative: client re-fetches
    // anything that mutated during query execution on the next sync cycle.
    const serverTime = new Date().toISOString();

    const client = this.supabaseFactory.create(user.rawJwt);

    let query = client
      .from('jobs')
      .select(
        `id, job_number, tenant_id, customer_id, technician_id,
         service_location, service_type, scheduled_start, scheduled_end,
         status, current_step, priority, require_completion_photo,
         description, notes_for_technician, created_at, updated_at,
         customers!inner(name, address),
         attachments(id, attachment_type, size_bytes, created_at)`,
      )
      .eq('tenant_id', user.tenantId)
      .eq('technician_id', user.userId);

    if (lastSyncedAt) {
      query = query.gt('updated_at', lastSyncedAt);
    }

    const { data, error } = await query
      .order('updated_at', { ascending: false })
      .limit(500);

    if (error) {
      this.logger.error('Delta sync query failed', error);
      throw new InternalServerErrorException('Sync query failed');
    }

    const jobs: SyncJobDto[] = (data ?? []).map((row: any) => ({
      id: row.id,
      jobNumber: row.job_number,
      tenantId: row.tenant_id,
      customerId: row.customer_id,
      technicianId: row.technician_id,
      serviceLocation: row.service_location,
      serviceType: row.service_type,
      scheduledStart: row.scheduled_start,
      scheduledEnd: row.scheduled_end ?? null,
      status: row.status,
      currentStep: row.current_step ?? null,
      priority: row.priority,
      requireCompletionPhoto: row.require_completion_photo,
      description: row.description ?? null,
      notesForTechnician: row.notes_for_technician ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      customer: {
        name: row.customers?.name ?? '',
        address: row.customers?.address ?? null,
      },
      attachments: (row.attachments ?? []).map((a: any) => ({
        id: a.id,
        attachmentType: a.attachment_type,
        sizeBytes: a.size_bytes,
        createdAt: a.created_at,
      })),
    }));

    return { jobs, serverTime };
  }
}
