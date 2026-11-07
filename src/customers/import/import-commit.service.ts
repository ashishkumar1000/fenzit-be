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
 * Order of writes: the import batch row (all N rows counted as failed), then
 * customer rows (each on its own, with the batch counts refreshed every
 * PROGRESS_EVERY rows and at the end), then the company audit entry, then the
 * replay record. There is no cross-table transaction through the Supabase
 * client. A run that dies mid-way therefore leaves a batch row with partial
 * counts and no audit entry, and its claim stays pending until it goes stale.
 * A retry is safe: phone matching turns rows that already saved into updates,
 * not duplicates.
 */
/** How often the batch row is refreshed while rows are being written. */
const PROGRESS_EVERY = 25;
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
    const owned = { requestHash, claimToken: claim.claimToken };

    let sheet: Awaited<ReturnType<ImportValidateService['validate']>>;
    try {
      sheet = await this.importValidate.validate(owner, dto);
    } catch (error) {
      // Nothing written yet, so a retry with this key may run again.
      await releaseImportKey(admin, tenantId, idempotencyKey, claim.claimToken);
      throw error;
    }
    // The batch row goes in BEFORE any customer write, so a run that dies
    // mid-loop is still visible. Until rows are counted, every row is failed.
    const total = sheet.rows.length;
    let batchId: string;
    try {
      batchId = await this.insertBatch(
        admin,
        owner,
        dto.fileName ?? DEFAULT_IMPORT_FILE_NAME,
        total,
      );
    } catch (error) {
      // Nothing written yet, so a retry with this key may run again.
      await releaseImportKey(admin, tenantId, idempotencyKey, claim.claimToken);
      throw error;
    }

    // From the first customer write on, the claim is NOT released on error.
    // The rows are saved, so a retry must wait for the claim to go stale
    // (a stalled run is taken over and re-run, and its saved rows update).
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
      if (rows.length % PROGRESS_EVERY === 0 && rows.length < total) {
        await this.syncBatch(admin, owner, batchId, tally(rows, total), false);
      }
    }

    const summary = tally(rows, total);
    await this.syncBatch(admin, owner, batchId, summary, true);
    await this.writeAudit(admin, owner, batchId, summary);

    const response: ImportCommitResponse = { batchId, rows, summary };
    await completeImportKey(admin, tenantId, idempotencyKey, owned, response);
    return response;
  }

  /**
   * One row per run: who, which company, file name and the counts. Starts with
   * every row counted as failed, so created + updated + failed = total holds
   * from the first moment the row exists.
   */
  private async insertBatch(
    admin: SupabaseClient,
    owner: RequestUser,
    fileName: string,
    total: number,
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
          row_total: total,
          created_count: 0,
          updated_count: 0,
          failed_count: total,
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

  /**
   * Writes the three counts to the batch row. Mid-run (final = false) a failure
   * is logged and the run goes on: the next refresh or the final one corrects
   * the row. The final refresh must land, or the run is reported as failed.
   */
  private async syncBatch(
    admin: SupabaseClient,
    owner: RequestUser,
    batchId: string,
    summary: CommitSummary,
    final: boolean,
  ): Promise<void> {
    let error: { code?: string } | null;
    try {
      ({ error } = await admin
        .from('import_batches')
        .update({
          created_count: summary.created,
          updated_count: summary.updated,
          failed_count: summary.failed,
        })
        .eq('id', batchId)
        .eq('tenant_id', owner.tenantId));
    } catch {
      error = { code: 'network' };
    }
    if (!error) return;
    this.logger.error(
      `Failed to update import_batches (code=${error.code ?? 'none'}, final=${final})`,
    );
    if (final) throw this.recordFailed();
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

/**
 * Counts so far. Rows not yet written still count as failed, so the three
 * counts always sum to the total (the batch row's CHECK needs that). Once every
 * row is in, this is exact.
 */
function tally(rows: CommitRowResult[], total: number): CommitSummary {
  const count = (status: CommitRowResult['status']) =>
    rows.filter((r) => r.status === status).length;
  const created = count('created');
  const updated = count('updated');
  return { total, created, updated, failed: total - created - updated };
}
