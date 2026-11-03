import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ErrorCode } from '../common/enums/error-code.enum';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import {
  DeletionQueueStatus,
  DeletionResolveAction,
} from './dto/account-deletion-admin.dto';

export interface AccountDeletionQueueItem {
  id: string;
  userId: string;
  name: string | null;
  countryCode: string;
  phoneNumber: string;
  status: string;
  /** Which surface filed it: the public web page ('web') or the app ('app'). */
  source: string;
  requestedAt: string;
  reviewedAt: string | null;
}

interface QueueRow {
  id: string;
  status: string;
  source: string;
  created_at: string;
  reviewed_at: string | null;
  users: {
    id: string;
    name: string | null;
    country_code: string;
    phone_number: string;
  };
}

const QUEUE_LIMIT = 50;

/** Platform-admin queue for account deletion requests (user.manage). */
@Injectable()
export class AccountDeletionAdminService {
  private readonly logger = new Logger(AccountDeletionAdminService.name);

  constructor(private readonly supabaseClientFactory: SupabaseClientFactory) {}

  async list(
    status: DeletionQueueStatus = 'open',
  ): Promise<AccountDeletionQueueItem[]> {
    const admin = this.supabaseClientFactory.createAdmin();
    const { data, error } = await admin
      .from('account_deletion_requests')
      .select(
        'id, status, source, created_at, reviewed_at, users!inner(id, name, country_code, phone_number)',
      )
      .eq('status', status)
      .order('created_at', { ascending: true })
      .limit(QUEUE_LIMIT)
      .returns<QueueRow[]>();
    if (error) {
      this.logger.error('Failed to load account deletion queue:', { error });
      throw this.internal('Failed to load deletion requests');
    }
    return (data ?? []).map((row) => ({
      id: row.id,
      userId: row.users.id,
      name: row.users.name,
      countryCode: row.users.country_code,
      phoneNumber: row.users.phone_number,
      status: row.status,
      source: row.source,
      requestedAt: row.created_at,
      reviewedAt: row.reviewed_at,
    }));
  }

  /**
   * Marks an open request as completed or rejected. The update only matches an
   * open row, so two admins resolving at once cannot both succeed.
   */
  async resolve(
    user: RequestUser,
    requestId: string,
    action: DeletionResolveAction,
  ): Promise<{ id: string; status: string }> {
    const admin = this.supabaseClientFactory.createAdmin();
    const nextStatus = action === 'complete' ? 'completed' : 'rejected';
    const { data, error } = await admin
      .from('account_deletion_requests')
      .update({
        status: nextStatus,
        reviewed_by: user.userId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', requestId)
      .eq('status', 'open')
      .neq('user_id', user.userId)
      .select('id')
      .maybeSingle<{ id: string }>();
    if (error) {
      this.logger.error('Failed to resolve account deletion request:', {
        error,
      });
      throw this.internal('Failed to resolve deletion request');
    }
    if (!data) {
      const { data: existing, error: lookupError } = await admin
        .from('account_deletion_requests')
        .select('id, user_id')
        .eq('id', requestId)
        .maybeSingle<{ id: string; user_id: string }>();
      if (lookupError) {
        this.logger.error('Failed to look up deletion request:', {
          error: lookupError,
        });
        throw this.internal('Failed to resolve deletion request');
      }
      if (existing?.user_id === user.userId) {
        throw new ForbiddenException({
          error_code: ErrorCode.FORBIDDEN,
          message: 'You cannot resolve a deletion request for your own account',
        });
      }
      if (!existing) {
        throw new NotFoundException({
          error_code: ErrorCode.RESOURCE_NOT_FOUND,
          message: 'Deletion request not found',
        });
      }
      throw new ConflictException({
        error_code: ErrorCode.DELETION_REQUEST_ALREADY_RESOLVED,
        message: 'Deletion request already resolved',
      });
    }
    return { id: requestId, status: nextStatus };
  }

  private internal(message: string) {
    return new InternalServerErrorException({
      error_code: ErrorCode.INTERNAL_SERVER_ERROR,
      message,
    });
  }
}
