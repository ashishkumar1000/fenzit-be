import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { PaginatedResponse } from '../common/dto/paginated-response.dto';
import {
  encodeCursor,
  decodeCursor,
  CursorScope,
} from '../common/utils/cursor.util';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto';

export interface CustomerResponse {
  id: string;
  name: string;
  countryCode: string;
  phoneNumber: string;
  address: string | null;
  city: string | null;
  createdVia: 'manual' | 'job_creation';
  createdAt: string;
  tenantId: string;
}

/**
 * Structural input for findOrCreateByPhone. Declared here (not imported from the
 * jobs module) so customers has no dependency on jobs. NewCustomerDto is
 * structurally assignable to this.
 */
export interface FindOrCreateCustomerInput {
  name: string;
  countryCode: string;
  phoneNumber: string;
  address?: string;
  city?: string;
}

export interface CustomerListItem {
  id: string;
  name: string;
  countryCode: string;
  phoneNumber: string;
  address: string | null;
  city: string | null;
  jobCount: number;
  lastJobDate: string | null;
}

interface CustomerListRow {
  id: string;
  name: string;
  country_code: string;
  phone_number: string;
  address: string | null;
  city: string | null;
  created_at: string;
}

export interface JobHistoryItem {
  id: string;
  jobNumber: string;
  scheduledStart: string;
  status: string;
  serviceType: string;
}

interface JobHistoryRow {
  id: string;
  job_number: string;
  scheduled_start: string;
  status: string;
  service_type: string;
}

export interface CustomerDetailResponse extends CustomerResponse {
  jobHistory: PaginatedResponse<JobHistoryItem>;
}

interface CustomerRow {
  id: string;
  name: string;
  country_code: string;
  phone_number: string;
  address: string | null;
  city: string | null;
  created_via: 'manual' | 'job_creation';
  created_at: string;
  tenant_id: string;
}

const CUSTOMER_COLUMNS =
  'id, name, country_code, phone_number, address, city, created_via, created_at, tenant_id';

const PAGE_SIZE = 50;
const JOB_HISTORY_PAGE_SIZE = 20;
// Cursor scopes — a cursor minted for one endpoint is rejected (400) on the
// other, so a jobs-list cursor can never silently filter job history.
const LIST_CUSTOMERS_CURSOR_SCOPE: CursorScope = 'customers-list';
const JOB_HISTORY_CURSOR_SCOPE: CursorScope = 'customer-history';

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(private readonly supabaseClientFactory: SupabaseClientFactory) {}

  async createCustomer(
    owner: RequestUser,
    dto: CreateCustomerDto,
  ): Promise<CustomerResponse> {
    if (!owner.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before managing customers',
      });
    }

    const admin = this.supabaseClientFactory.createAdmin();

    const { data, error } = await admin
      .from('customers')
      .insert({
        id: crypto.randomUUID(),
        tenant_id: owner.tenantId,
        name: dto.name,
        country_code: dto.countryCode,
        phone_number: dto.phoneNumber,
        address: dto.address ?? null,
        city: dto.city ?? null,
      })
      .select(CUSTOMER_COLUMNS)
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException({
          error_code: ErrorCode.DUPLICATE_RESOURCE,
          message:
            'A customer with this phone number already exists for your company',
        });
      }
      if (error.code === '23503') {
        // FK violation — countryCode passed the regex but is not a known dial code
        throw new BadRequestException({
          error_code: ErrorCode.VALIDATION_ERROR,
          message: 'Unknown country code',
        });
      }
      this.logger.error('Failed to create customer:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to create customer',
      });
    }

    return this.toResponse(data);
  }

  /**
   * Find-or-create a customer by (tenant_id, country_code, phone_number) for the
   * job-creation flow (Story 3.1). Returns the existing customer if the phone
   * already exists in the tenant (dedup/link), otherwise inserts a new one with
   * created_via = 'job_creation'. This is the only write path that sets
   * 'job_creation'; createCustomer always uses the DB default 'manual'.
   */
  async findOrCreateByPhone(
    owner: RequestUser,
    input: FindOrCreateCustomerInput,
    attempt = 0,
  ): Promise<CustomerResponse> {
    if (!owner.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before managing customers',
      });
    }

    const admin = this.supabaseClientFactory.createAdmin();

    // 1. Dedup lookup. maybeSingle() returns null data (no PGRST116) when absent.
    const { data: existing, error: lookupError } = await admin
      .from('customers')
      .select(CUSTOMER_COLUMNS)
      .eq('tenant_id', owner.tenantId)
      .eq('country_code', input.countryCode)
      .eq('phone_number', input.phoneNumber)
      .maybeSingle<CustomerRow>();

    if (lookupError) {
      this.logger.error('Failed to look up customer by phone:', {
        error: lookupError,
      });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to resolve customer',
      });
    }

    if (existing) {
      return this.toResponse(existing); // link existing — no duplicate
    }

    // 2. No match → create with created_via = 'job_creation'.
    const { data, error } = await admin
      .from('customers')
      .insert({
        id: crypto.randomUUID(),
        tenant_id: owner.tenantId,
        name: input.name,
        country_code: input.countryCode,
        phone_number: input.phoneNumber,
        address: input.address ?? null,
        city: input.city ?? null,
        created_via: 'job_creation',
      })
      .select(CUSTOMER_COLUMNS)
      .single<CustomerRow>();

    if (error) {
      // Concurrent create lost the race — re-read the winning row, but bound the
      // retry: one re-read is enough for a genuine phone-uniqueness race. If a
      // 23505 still fires after that, the conflict is not the expected one (and
      // the lookup keys aren't matching the winning row) — fail loudly instead
      // of recursing forever.
      if (error.code === '23505') {
        if (attempt >= 1) {
          this.logger.error(
            'findOrCreateByPhone: 23505 persisted after retry',
            {
              error,
            },
          );
          throw new InternalServerErrorException({
            error_code: ErrorCode.INTERNAL_SERVER_ERROR,
            message: 'Failed to resolve customer',
          });
        }
        return this.findOrCreateByPhone(owner, input, attempt + 1);
      }
      if (error.code === '23503') {
        // countryCode passed the regex but is not a known dial code.
        throw new BadRequestException({
          error_code: ErrorCode.VALIDATION_ERROR,
          message: 'Unknown country code',
        });
      }
      this.logger.error('Failed to create customer (job_creation):', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to create customer',
      });
    }

    return this.toResponse(data);
  }

  async listCustomers(
    owner: RequestUser,
    query: ListCustomersQueryDto,
  ): Promise<PaginatedResponse<CustomerListItem>> {
    if (!owner.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before managing customers',
      });
    }

    const admin = this.supabaseClientFactory.createAdmin();

    let qb = admin
      .from('customers')
      .select('id, name, country_code, phone_number, address, city, created_at')
      .eq('tenant_id', owner.tenantId);

    const term = query.q ? this.sanitizeSearchTerm(query.q) : '';
    if (term) {
      // Inside .or() the ilike wildcard is '*' (PostgREST translates to '%').
      qb = qb.or(`name.ilike.*${term}*,phone_number.ilike.*${term}*`);
    }

    if (query.cursor) {
      const c = decodeCursor(query.cursor, LIST_CUSTOMERS_CURSOR_SCOPE); // throws 400 on malformed/foreign cursor
      // Keyset paging under (created_at DESC, id DESC): rows strictly after the cursor.
      qb = qb.or(
        `created_at.lt.${c.createdAt},and(created_at.eq.${c.createdAt},id.lt.${c.id})`,
      );
    }

    const pageSize = query.limit ?? PAGE_SIZE;

    const { data, error } = await qb
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(pageSize + 1);

    if (error) {
      this.logger.error('Failed to list customers:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to list customers',
      });
    }

    const rows = (data ?? []) as CustomerListRow[];
    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor(last.id, last.created_at, LIST_CUSTOMERS_CURSOR_SCOPE)
        : null;

    const jobStats = await this.getJobStats(
      owner.tenantId,
      pageRows.map((row) => row.id),
    );

    const items: CustomerListItem[] = pageRows.map((row) => {
      const stats = jobStats.get(row.id);
      return {
        id: row.id,
        name: row.name,
        countryCode: row.country_code,
        phoneNumber: row.phone_number,
        address: row.address,
        city: row.city,
        jobCount: stats?.jobCount ?? 0,
        lastJobDate: stats?.lastJobDate ?? null,
      };
    });

    return new PaginatedResponse(items, nextCursor);
  }

  /**
   * jobCount / lastJobDate for a page of customers, computed from the jobs
   * table directly (not via JobsService — customers has no dependency on
   * jobs, per the module-boundary note on FindOrCreateCustomerInput above).
   * Counts jobs of any status; lastJobDate is the most recent scheduledStart.
   */
  private async getJobStats(
    tenantId: string,
    customerIds: string[],
  ): Promise<Map<string, { jobCount: number; lastJobDate: string | null }>> {
    const stats = new Map<
      string,
      { jobCount: number; lastJobDate: string | null }
    >();
    if (customerIds.length === 0) return stats;

    const admin = this.supabaseClientFactory.createAdmin();
    const { data, error } = await admin
      .from('jobs')
      .select('customer_id, scheduled_start')
      .eq('tenant_id', tenantId)
      .in('customer_id', customerIds);

    if (error) {
      this.logger.error('Failed to fetch job stats for customers:', {
        error,
      });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to list customers',
      });
    }

    const rows = (data ?? []) as {
      customer_id: string;
      scheduled_start: string;
    }[];
    for (const row of rows) {
      const entry = stats.get(row.customer_id) ?? {
        jobCount: 0,
        lastJobDate: null,
      };
      entry.jobCount += 1;
      if (
        !entry.lastJobDate ||
        new Date(row.scheduled_start) > new Date(entry.lastJobDate)
      ) {
        entry.lastJobDate = row.scheduled_start;
      }
      stats.set(row.customer_id, entry);
    }

    return stats;
  }

  async getCustomerDetail(
    owner: RequestUser,
    customerId: string,
    cursor?: string,
  ): Promise<CustomerDetailResponse> {
    if (!owner.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before managing customers',
      });
    }

    const admin = this.supabaseClientFactory.createAdmin();

    const { data, error } = await admin
      .from('customers')
      .select(CUSTOMER_COLUMNS)
      .eq('id', customerId)
      .eq('tenant_id', owner.tenantId)
      .single<CustomerRow>();

    // A genuine DB failure (any error other than PGRST116) is a 500.
    if (error && error.code !== 'PGRST116') {
      this.logger.error('Failed to fetch customer:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to fetch customer',
      });
    }

    // PGRST116 (no rows) or any empty result → 404. Covers both a missing
    // customer AND one in another tenant (the tenant_id filter returns empty),
    // so cross-tenant access is indistinguishable from not-found — never 403.
    // The explicit tenant_id check is defense-in-depth: createAdmin() bypasses
    // RLS, so if the `.eq('tenant_id')` filter is ever dropped, this still
    // refuses to return another tenant's row.
    if (!data || data.tenant_id !== owner.tenantId) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'Customer not found',
      });
    }

    // NOTE (ordering invariant): the cursor decodes inside getJobHistory, i.e.
    // AFTER the 404 check above — a malformed cursor on a missing/cross-tenant
    // customer yields 404, not 400. That is deliberate: the customer lookup is
    // the primary resource. A test pins this; don't reorder without updating it.
    return {
      ...this.toResponse(data),
      jobHistory: await this.getJobHistory(
        admin,
        owner.tenantId,
        customerId,
        cursor,
      ),
    };
  }

  /**
   * Paginated job history for the customer-detail response (AC#1-4). Keyset on
   * (scheduled_start DESC, id DESC) — the same or-predicate + limit-N+1 pattern as
   * jobs.service.ts#listJobs. Reuses the generic {id, createdAt} cursor.util
   * shape with `createdAt` holding the scheduled_start value (Dev Notes choice),
   * scoped so a cursor minted elsewhere is rejected.
   */
  private async getJobHistory(
    admin: SupabaseClient,
    tenantId: string,
    customerId: string,
    cursor?: string,
  ): Promise<PaginatedResponse<JobHistoryItem>> {
    let qb = admin
      .from('jobs')
      .select('id, job_number, scheduled_start, status, service_type')
      .eq('tenant_id', tenantId)
      .eq('customer_id', customerId);

    if (cursor) {
      const c = decodeCursor(cursor, JOB_HISTORY_CURSOR_SCOPE); // throws 400 on malformed/foreign cursor
      qb = qb.or(
        `scheduled_start.lt.${c.createdAt},and(scheduled_start.eq.${c.createdAt},id.lt.${c.id})`,
      );
    }

    const { data, error } = await qb
      .order('scheduled_start', { ascending: false })
      .order('id', { ascending: false })
      .limit(JOB_HISTORY_PAGE_SIZE + 1);

    if (error) {
      this.logger.error('Failed to fetch customer job history:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to fetch customer job history',
      });
    }

    const rows = (data ?? []) as JobHistoryRow[];
    const hasMore = rows.length > JOB_HISTORY_PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, JOB_HISTORY_PAGE_SIZE) : rows;
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor(last.id, last.scheduled_start, JOB_HISTORY_CURSOR_SCOPE)
        : null;

    const items: JobHistoryItem[] = pageRows.map((row) => ({
      id: row.id,
      jobNumber: row.job_number,
      scheduledStart: row.scheduled_start,
      status: row.status,
      serviceType: row.service_type,
    }));

    return new PaginatedResponse(items, nextCursor);
  }

  /**
   * Neutralizes PostgREST/LIKE-significant characters before a term is
   * interpolated into an unsanitized `.or()` filter string.
   * - escapes LIKE metacharacters `%` and `_` so they match literally
   * - strips PostgREST-structural chars (`, ( )`), the `*` wildcard, and backslash
   *   (`.` and `:` are safe inside an ilike value and are preserved)
   * Returns the cleaned term ('' means "no search filter").
   */
  private sanitizeSearchTerm(q: string): string {
    return (
      q
        // Strip only PostgREST-structural chars (`, ( )`) and the `*` wildcard.
        // `.` and `:` are safe inside an ilike value, so they are preserved.
        .replace(/[,()*\\]/g, '')
        .replace(/[%_]/g, (m) => `\\${m}`)
        .trim()
    );
  }

  private toResponse(row: {
    id: string;
    name: string;
    country_code: string;
    phone_number: string;
    address: string | null;
    city: string | null;
    created_via: 'manual' | 'job_creation';
    created_at: string;
    tenant_id: string;
  }): CustomerResponse {
    return {
      id: row.id,
      name: row.name,
      countryCode: row.country_code,
      phoneNumber: row.phone_number,
      address: row.address,
      city: row.city,
      createdVia: row.created_via,
      createdAt: row.created_at,
      tenantId: row.tenant_id,
    };
  }
}
