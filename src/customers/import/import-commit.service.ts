import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseClientFactory } from '../../common/factories/supabase-client.factory';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { RequestUser } from '../../common/interfaces/request-user.interface';
import { CommitImportRowsDto } from './dto/commit-import-rows.dto';
import { ImportValidateService } from './import-validate.service';
import { writeImportRow } from './import-commit.writes';
import {
  claimImportKey,
  completeImportKey,
  hashImportRequest,
  releaseImportKey,
} from './import-commit.replay';
import {
  CommitRowResult,
  CommitSummary,
  DEFAULT_IMPORT_FILE_NAME,
  ImportCommitResponse,
} from './import-commit.types';

/**
 * Staff import commit (SPEC-owner-bulk-customer-import, story 4). Tenant
 * comes from the request user, never the body. Every row is re-checked by
 * the same validation the validate endpoint uses.
 *
 * Order of writes: customer rows (each on its own), then the import batch
 * row, then the company audit entry, then the replay record. There is no
 * cross-table transaction through the Supabase client, so a failure partway
 * is reported, and a retry is safe: phone matching turns rows that already
 * saved into updates, not duplicates.
 */
@Injectable()
export class ImportCommitService {
  private readonly logger = new Logger(ImportCommitService.name);

  constructor(
    private readonly supabaseClientFactory: SupabaseClientFactory,
    private readonly importValidate: ImportValidateService,
  ) {}

  async commit(
    owner: RequestUser,
    dto: CommitImportRowsDto,
    idempotencyKey: string,
  ): Promise<ImportCommitResponse> {
    if (!owner.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before managing customers',
      });
    }
    const tenantId = owner.tenantId;
    const admin = this.supabaseClientFactory.createAdmin();

    // Claim the key before any write. A replay returns the first answer and
    // writes nothing; a concurrent or reused key is refused.
    const requestHash = hashImportRequest(dto);
    const claim = await claimImportKey(
      admin,
      tenantId,
      idempotencyKey,
      requestHash,
    );
    if (claim.kind === 'replay') return claim.response;

    let sheet: Awaited<ReturnType<ImportValidateService['validate']>>;
    try {
      sheet = await this.importValidate.validate(owner, dto);
    } catch (error) {
      // Nothing written yet, so a retry with this key may run again.
      await releaseImportKey(admin, tenantId, idempotencyKey);
      throw error;
    }
    const rows: CommitRowResult[] = [];
    for (const row of sheet.rows) {
      rows.push(
        row.status === 'valid'
          ? await writeImportRow(admin, tenantId, row)
          : {
              rowIndex: row.rowIndex,
              status: 'failed',
              customerId: null,
              reasons: row.reasons,
            },
      );
    }

    const summary = tally(rows);
    const batchId = await this.insertBatch(
      admin,
      owner,
      dto.fileName ?? DEFAULT_IMPORT_FILE_NAME,
      summary,
    );
    await this.writeAudit(admin, owner, batchId, summary);

    const response: ImportCommitResponse = { batchId, rows, summary };
    await completeImportKey(
      admin,
      tenantId,
      idempotencyKey,
      requestHash,
      response,
    );
    return response;
  }

  /** One row per run: who, which company, file name and the three counts. */
  private async insertBatch(
    admin: SupabaseClient,
    owner: RequestUser,
    fileName: string,
    summary: CommitSummary,
  ): Promise<string> {
    // A network fault rejects instead of returning an error: both stop the
    // run with the same stated 500.
    let page: { data: { id: string } | null; error: { code?: string } | null };
    try {
      page = await admin
        .from('import_batches')
        .insert({
          tenant_id: owner.tenantId,
          actor_user_id: owner.userId,
          file_name: fileName,
          row_total: summary.total,
          created_count: summary.created,
          updated_count: summary.updated,
          failed_count: summary.failed,
        })
        .select('id')
        .single<{ id: string }>();
    } catch {
      page = { data: null, error: { code: 'network' } };
    }
    if (page.error || !page.data) {
      this.logger.error(
        `Failed to write import_batches (code=${page.error?.code ?? 'none'})`,
      );
      throw this.recordFailed();
    }
    return page.data.id;
  }

  /** Company-level entry for the owner's audit log. Counts only, no values. */
  private async writeAudit(
    admin: SupabaseClient,
    owner: RequestUser,
    batchId: string,
    summary: CommitSummary,
  ): Promise<void> {
    const imported = summary.created + summary.updated;
    let error: { code?: string } | null;
    try {
      ({ error } = await admin.rpc('write_audit_row', {
        p_actor: owner.userId,
        p_action: `Fenzit staff imported ${imported} customers`,
        p_tenant_id: owner.tenantId,
        p_target_user: null,
        p_details: {
          batch_id: batchId,
          created: summary.created,
          updated: summary.updated,
          failed: summary.failed,
        },
      }));
    } catch {
      error = { code: 'network' };
    }
    if (error) {
      this.logger.error(
        `Failed to write import audit entry (code=${error.code ?? 'none'})`,
      );
      throw this.recordFailed();
    }
  }

  private recordFailed(): InternalServerErrorException {
    return new InternalServerErrorException({
      error_code: ErrorCode.INTERNAL_SERVER_ERROR,
      message:
        'The import ran, but its record could not be saved. Check the customer list before you try again.',
    });
  }
}

function tally(rows: CommitRowResult[]): CommitSummary {
  const count = (status: CommitRowResult['status']) =>
    rows.filter((r) => r.status === status).length;
  return {
    total: rows.length,
    created: count('created'),
    updated: count('updated'),
    failed: count('failed'),
  };
}
