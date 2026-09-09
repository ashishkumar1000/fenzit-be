import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { PaginatedResponse } from '../common/dto/paginated-response.dto';
import { decodeCursor, encodeCursor } from '../common/utils/cursor.util';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import type { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import type { NotificationResponse } from './dto/notification-response.dto';
import type {
  UnreadCountResponse,
  MarkReadResponse,
} from './dto/notification-count-response.dto';
import type { MarkReadDto } from './dto/mark-read.dto';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';

/** Keyset scope for this list — encoded into every minted cursor. */
const NOTIFICATIONS_CURSOR_SCOPE = 'notifications-list' as const;

const DEFAULT_PAGE_SIZE = 20;

interface NotificationRow {
  id: string;
  job_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly supabaseClientFactory: SupabaseClientFactory) {}

  /**
   * Newest-first keyset list for the JWT recipient. Every query is
   * double-scoped (tenant_id + user_id): tenant scoping alone would leak
   * across recipients (owner + technician share tenantId).
   */
  async listNotifications(
    user: RequestUser,
    query: ListNotificationsQueryDto,
  ): Promise<PaginatedResponse<NotificationResponse>> {
    // tenantId is nullable (user hasn't completed company setup) — a null
    // .eq('tenant_id', undefined) would silently drop the filter, so
    // short-circuit to the empty page without querying.
    if (!user.tenantId) {
      return new PaginatedResponse<NotificationResponse>([], null);
    }

    const admin = this.supabaseClientFactory.createAdmin();

    let qb = admin
      .from('notifications')
      .select('id, job_id, event_type, payload, read_at, created_at')
      .eq('tenant_id', user.tenantId)
      .eq('user_id', user.userId);

    if (query.cursor) {
      const c = decodeCursor(query.cursor, NOTIFICATIONS_CURSOR_SCOPE); // throws 400 on malformed/foreign cursor
      // Keyset paging under (created_at DESC, id DESC): rows strictly after the cursor.
      qb = qb.or(
        `created_at.lt.${c.createdAt},and(created_at.eq.${c.createdAt},id.lt.${c.id})`,
      );
    }

    const pageSize = query.limit ?? DEFAULT_PAGE_SIZE;

    const { data, error } = await qb
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(pageSize + 1);

    if (error) {
      this.logger.error('Failed to list notifications:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to list notifications',
      });
    }

    const rows = (data ?? []) as NotificationRow[];
    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor(last.id, last.created_at, NOTIFICATIONS_CURSOR_SCOPE)
        : null;

    return new PaginatedResponse(
      pageRows.map((row) => this.toResponse(row)),
      nextCursor,
    );
  }

  /** Count of the recipient's rows with read_at IS NULL. */
  async getUnreadCount(user: RequestUser): Promise<UnreadCountResponse> {
    if (!user.tenantId) {
      return { unreadCount: 0 };
    }

    const admin = this.supabaseClientFactory.createAdmin();

    const { count, error } = await admin
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', user.tenantId)
      .eq('user_id', user.userId)
      .is('read_at', null);

    if (error) {
      this.logger.error('Failed to count unread notifications:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to count unread notifications',
      });
    }

    return { unreadCount: count ?? 0 };
  }

  /**
   * Mark specific rows read. Idempotent: only own + currently-unread rows are
   * updated, so foreign/missing/already-read ids are silent no-ops — the
   * response reports how many rows were actually marked.
   */
  async markRead(
    user: RequestUser,
    dto: MarkReadDto,
  ): Promise<MarkReadResponse> {
    // The DTO caps ids at 100 and forbids empty, but the empty guard keeps the
    // service safe standalone (never build an empty .in('id', []) query).
    if (!user.tenantId || dto.ids.length === 0) {
      return { markedCount: 0 };
    }

    const admin = this.supabaseClientFactory.createAdmin();

    const { data, error } = await admin
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .in('id', dto.ids)
      .eq('tenant_id', user.tenantId)
      .eq('user_id', user.userId)
      .is('read_at', null)
      .select('id');

    if (error) {
      this.logger.error('Failed to mark notifications read:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to mark notifications read',
      });
    }

    return { markedCount: (data ?? []).length };
  }

  /** Mark every unread row of the recipient read. Idempotent repeat → 0. */
  async markAllRead(user: RequestUser): Promise<MarkReadResponse> {
    if (!user.tenantId) {
      return { markedCount: 0 };
    }

    const admin = this.supabaseClientFactory.createAdmin();

    const { data, error } = await admin
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('tenant_id', user.tenantId)
      .eq('user_id', user.userId)
      .is('read_at', null)
      .select('id');

    if (error) {
      this.logger.error('Failed to mark all notifications read:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to mark all notifications read',
      });
    }

    return { markedCount: (data ?? []).length };
  }

  /** snake_case row → camelCase boundary shape (toResponse convention, as in customers.service). */
  private toResponse(row: NotificationRow): NotificationResponse {
    return {
      id: row.id,
      jobId: row.job_id,
      eventType: row.event_type,
      payload: row.payload,
      readAt: row.read_at,
      createdAt: row.created_at,
    };
  }
}
