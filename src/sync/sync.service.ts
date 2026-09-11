import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { SyncJobDto, SyncResponseDto } from './dto/sync-response.dto';
import {
  parseTemplateSteps,
  stepToResponse,
  currentStepIndexForRead,
  normalizeSkillEmbed,
} from '../jobs/workflow-template.model';
import { JOB_COLUMNS } from '../jobs/jobs.service';

// Composed from the shared JOB_COLUMNS (Story 4.5) so a future job column can
// never silently miss the sync payload — only the sync-specific relation
// embeds (customer + attachments) are added on top of the canonical literal.
const SYNC_JOB_COLUMNS = `${JOB_COLUMNS}, customers!inner(name, address), attachments(id, attachment_type, size_bytes, created_at)`;

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(private readonly supabaseFactory: SupabaseClientFactory) {}

  async sync(
    user: RequestUser,
    lastSyncedAt?: string,
  ): Promise<SyncResponseDto> {
    // Capture serverTime BEFORE the query — conservative: client re-fetches
    // anything that mutated during query execution on the next sync cycle.
    const serverTime = new Date().toISOString();

    const client = this.supabaseFactory.create(user.rawJwt);

    let query = client
      .from('jobs')
      .select(SYNC_JOB_COLUMNS)
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

    // Story 4.5 — skill/template embeds map the same way the job responses do
    // (null on missing/unreadable embeds; reads are soft, never a 500). The
    // to-one skill embed can surface as an object or array per PostgREST.
    const jobs: SyncJobDto[] = (data ?? []).map((row: any) => {
      const skillRaw = normalizeSkillEmbed(row.skills);
      const steps = row.workflow_templates
        ? parseTemplateSteps(row.workflow_templates.steps)
        : null;
      const workflowTemplate =
        steps && row.workflow_templates
          ? {
              version: row.workflow_templates.version,
              steps: steps.map(stepToResponse),
            }
          : null;
      return {
        id: row.id,
        jobNumber: row.job_number,
        tenantId: row.tenant_id,
        customerId: row.customer_id,
        technicianId: row.technician_id,
        serviceLocation: row.service_location,
        scheduledStart: row.scheduled_start,
        scheduledEnd: row.scheduled_end ?? null,
        status: row.status,
        currentStep: row.current_step ?? null,
        priority: row.priority,
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
        skill: skillRaw ? { id: skillRaw.id, name: skillRaw.name } : null,
        workflowTemplate,
        currentStepIndex: steps
          ? currentStepIndexForRead(steps, row.current_step ?? null)
          : null,
      };
    });

    return { jobs, serverTime };
  }
}
