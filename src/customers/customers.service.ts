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
import { hasInvalidCoordinates } from '../common/utils/validate-coordinates';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto';
import { CustomersPageQueryDto } from './dto/customers-page-query.dto';
import { normalizeSkillEmbed } from '../jobs/workflow-template.model';

export interface CustomerResponse {
  id: string;
  name: string;
  /** Display identity CST-001 — minted by trigger, write-once, never authz. */
  customerCode: string;
  countryCode: string;
  phoneNumber: string;
  address: string | null;
  city: string | null;
  formattedAddress: string | null;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  placeId: string | null;
  // CAP-5 — user-entered extra location detail (flat/building/floor/
  // landmark); its own column, never merged into the geocoded text.
  addressDetails: string | null;
  createdVia: 'manual' | 'job_creation';
  createdAt: string;
  tenantId: string;
}

/**
 * The optional structured-address fields accepted on every customer-creation
 * path. Declared once here so the service input and the insert mapping below
 * share one TS shape (the validator layer shares its own — StructuredAddressDto).
 */
export interface StructuredAddressFields {
  address?: string;
  city?: string;
  formattedAddress?: string;
  pincode?: string;
  latitude?: number;
  longitude?: number;
  placeId?: string;
  addressDetails?: string;
}

/**
 * Structural input for findOrCreateByPhone. Declared here (not imported from the
 * jobs module) so customers has no dependency on jobs. NewCustomerDto is
 * structurally assignable to this.
 */
export interface FindOrCreateCustomerInput extends StructuredAddressFields {
  name: string;
  countryCode: string;
  phoneNumber: string;
}

/**
 * Maps the camelCase structured-address fields onto the customers table's
 * snake_case columns, normalizing absent fields to null (the table-wide
 * convention for optional values). Shared by both insert paths so a new
 * structured-address column is added in exactly one place.
 */
function structuredAddressColumns(input: StructuredAddressFields) {
  return {
    address: input.address ?? null,
    city: input.city ?? null,
    formatted_address: input.formattedAddress ?? null,
    pincode: input.pincode ?? null,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    place_id: input.placeId ?? null,
    address_details: input.addressDetails ?? null,
  };
}

/**
 * Normalizer for the clearable free-text fields on PATCH: a trimmed-empty
 * string is the natural client "clear" idiom, so it is stored as null (the
 * table-wide convention) instead of ''. `pincode` is excluded — '' already
 * fails its @Matches at the DTO layer — as are latitude/longitude (numbers)
 * and `name` (non-nullable).
 */
function clearableText(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.trim() === '' ? null : value;
}

export interface CustomerListItem {
  id: string;
  name: string;
  /** Display identity CST-001 — minted by trigger, write-once, never authz. */
  customerCode: string;
  countryCode: string;
  phoneNumber: string;
  address: string | null;
  city: string | null;
  formattedAddress: string | null;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  placeId: string | null;
  addressDetails: string | null;
  jobCount: number;
  lastJobDate: string | null;
}

interface CustomerListRow {
  id: string;
  name: string;
  // Non-null on this table since the 20261117130000 migration: the BEFORE
  // INSERT trigger mints a code for every new row and the backfill covered
  // every existing one.
  customer_code: string;
  country_code: string;
  phone_number: string;
  address: string | null;
  city: string | null;
  formatted_address: string | null;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  place_id: string | null;
  address_details: string | null;
  created_at: string;
}

/** One customers_overview row — a customer plus its job aggregate. The code
 *  is non-null here: the trigger mints one on every insert and the migration
 *  backfilled every existing row. */
interface CustomerOverviewRow extends CustomerListRow {
  job_count: number;
  last_job_date: string | null;
}

/**
 * The whole-company bucket counts the console's tiles show (see
 * getCustomersStats). `new`/`single`/`repeat` sum to `total`.
 */
export interface CustomersStats {
  total: number;
  new: number;
  single: number;
  repeat: number;
}

/** One page of GET /customers/page — the members-page contract. `total` is
 *  the FILTERED row count; `stats` always describes the whole company. */
export interface CustomersPage {
  data: CustomerListItem[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  stats: CustomersStats;
}

export interface JobHistoryItem {
  id: string;
  jobNumber: string;
  scheduledStart: string;
  status: string;
  // Story 4.5 — the job's skill display name (label). Historical: an inactive
  // skill still renders. Null when the embed yields no skill — e.g. job rows
  // created before the skill_id column existed (migration 36) carry a NULL
  // skill_id, so the plain left embed resolves to nothing (soft read posture).
  skillName: string | null;
}

interface JobHistoryRow {
  id: string;
  job_number: string;
  scheduled_start: string;
  status: string;
  skills: { name: string } | { name: string }[] | null;
}

export interface CustomerDetailResponse extends CustomerResponse {
  jobHistory: PaginatedResponse<JobHistoryItem>;
}

interface CustomerRow {
  id: string;
  name: string;
  customer_code: string;
  country_code: string;
  phone_number: string;
  address: string | null;
  city: string | null;
  formatted_address: string | null;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  place_id: string | null;
  address_details: string | null;
  created_via: 'manual' | 'job_creation';
  created_at: string;
  tenant_id: string;
}

const CUSTOMER_COLUMNS =
  'id, name, customer_code, country_code, phone_number, address, city, formatted_address, pincode, latitude, longitude, place_id, address_details, created_via, created_at, tenant_id';

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

  /**
   * Defense-in-depth on the service interface: the DTO validators are the
   * first line (422 at the edge), but both creation entry points are callable
   * from any module — so a non-finite or out-of-range latitude/longitude can
   * never reach the DB even if a future caller bypasses the ValidationPipe
   * (mirrors the coordinate guard in PlacesService.resolve).
   */
  private assertValidCoordinates(
    latitude: number | undefined,
    longitude: number | undefined,
  ): void {
    if (hasInvalidCoordinates(latitude, longitude)) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message:
          "That address doesn't have a valid location. Please pick it from the map.",
      });
    }
  }

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

    this.assertValidCoordinates(dto.latitude, dto.longitude);

    const admin = this.supabaseClientFactory.createAdmin();

    const { data, error } = await admin
      .from('customers')
      .insert({
        id: crypto.randomUUID(),
        tenant_id: owner.tenantId,
        name: dto.name,
        country_code: dto.countryCode,
        phone_number: dto.phoneNumber,
        ...structuredAddressColumns(dto),
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
   * Company-admin partial update (SPEC-edit-customer CAP-4), modelled on the
   * offices updateOffice precedent. Only the mutable subset is writable — the
   * update DTO structurally excludes countryCode/phoneNumber, so the stored
   * phone can never change here (and no unique column is mutable, so no 23505
   * mapping is needed on this path).
   */
  async updateCustomer(
    owner: RequestUser,
    customerId: string,
    dto: UpdateCustomerDto,
  ): Promise<CustomerResponse> {
    if (!owner.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before managing customers',
      });
    }

    // Patch-level coordinate guard: validated only when the location pair is
    // being touched, on the values present in the DTO — the same guard create
    // runs on its DTO. Explicit nulls mean "clear the column", so they are
    // normalized to undefined here; only real numbers are range-checked.
    if ('latitude' in dto || 'longitude' in dto) {
      this.assertValidCoordinates(
        dto.latitude ?? undefined,
        dto.longitude ?? undefined,
      );
    }

    // Build the patch only from keys present in the body: "present with null"
    // (or a trimmed-empty string — clearableText) clears the column, "absent"
    // leaves it untouched. `name` is the one non-nullable field, so a null
    // there counts as absent (it can never clear the column) — an
    // otherwise-empty body then 400s below.
    const patch: Record<string, unknown> = {};
    if (dto.name != null) {
      patch.name = dto.name;
    }
    if ('address' in dto) patch.address = clearableText(dto.address);
    if ('city' in dto) patch.city = clearableText(dto.city);
    if ('formattedAddress' in dto) {
      patch.formatted_address = clearableText(dto.formattedAddress);
    }
    if ('pincode' in dto) patch.pincode = dto.pincode ?? null;
    if ('latitude' in dto) patch.latitude = dto.latitude ?? null;
    if ('longitude' in dto) patch.longitude = dto.longitude ?? null;
    if ('placeId' in dto) patch.place_id = clearableText(dto.placeId);
    if ('addressDetails' in dto) {
      // CAP-5: cleared only by an explicit null/empty — a re-pin never clears
      // it (a re-pin PATCH simply omits this key).
      patch.address_details = clearableText(dto.addressDetails);
    }

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Nothing to update',
      });
    }

    const admin = this.supabaseClientFactory.createAdmin();

    // Guarded single-row UPDATE: id + tenant filter (createAdmin() bypasses
    // RLS, so the explicit tenant_id filter is the isolation boundary). An
    // empty result is a 404 — a missing customer and a foreign-tenant one are
    // indistinguishable, never 403.
    const { data, error } = await admin
      .from('customers')
      .update(patch)
      .eq('id', customerId)
      .eq('tenant_id', owner.tenantId)
      .select(CUSTOMER_COLUMNS);

    if (error) {
      this.logger.error('Failed to update customer:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to update customer',
      });
    }

    const rows = (data ?? []) as CustomerRow[];
    // Empty result → 404: a missing customer and a foreign-tenant one are
    // indistinguishable on purpose (the tenant filter is in the UPDATE
    // itself), never 403.
    if (rows.length === 0) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'Customer not found',
      });
    }

    // Writes ONLY the targeted customers row — no job-side writes, no backfill.
    return this.toResponse(rows[0]);
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

    this.assertValidCoordinates(input.latitude, input.longitude);

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
        ...structuredAddressColumns(input),
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
      .select(
        'id, name, customer_code, country_code, phone_number, address, city, formatted_address, pincode, latitude, longitude, place_id, address_details, created_at',
      )
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
        customerCode: row.customer_code,
        countryCode: row.country_code,
        phoneNumber: row.phone_number,
        address: row.address,
        city: row.city,
        formattedAddress: row.formatted_address,
        pincode: row.pincode,
        latitude: row.latitude,
        longitude: row.longitude,
        placeId: row.place_id,
        addressDetails: row.address_details,
        jobCount: stats?.jobCount ?? 0,
        lastJobDate: stats?.lastJobDate ?? null,
      };
    });

    return new PaginatedResponse(items, nextCursor);
  }

  /**
   * The whole-company counters the console's customer stat tiles show. The
   * owner-approved disjoint buckets over job history — new (0 jobs), single
   * (exactly 1), repeat (2+) — so the counts sum to the total. Counted before
   * any filter, so tiles stay stable while the table narrows (the members
   * stats contract).
   */
  private async getCustomersStats(tenantId: string): Promise<CustomersStats> {
    const admin = this.supabaseClientFactory.createAdmin();

    // Only the bucket column crosses the wire — a tenant can hold thousands
    // of customers and this runs on every page load.
    const { data, error } = await admin
      .from('customers_overview')
      .select('job_count')
      .eq('tenant_id', tenantId);

    if (error) {
      this.logger.error('Failed to count customer buckets:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to count customers',
      });
    }

    const stats: CustomersStats = { total: 0, new: 0, single: 0, repeat: 0 };
    for (const row of (data ?? []) as { job_count: number }[]) {
      stats.total += 1;
      if (row.job_count <= 0) stats.new += 1;
      else if (row.job_count === 1) stats.single += 1;
      else stats.repeat += 1;
    }
    return stats;
  }

  /**
   * One page of the console's customer list — the members-page contract over
   * the customers_overview view: DB-side filtering/sorting/paging (a company
   * can hold thousands of customers), a filtered exact total, and whole-
   * company stats that ignore the filters. No database function of its own —
   * the view carries the aggregates.
   */
  async getCustomersPage(
    owner: RequestUser,
    query: CustomersPageQueryDto,
  ): Promise<CustomersPage> {
    if (!owner.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before managing customers',
      });
    }

    const admin = this.supabaseClientFactory.createAdmin();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 10;

    // The tenant/search/bucket filters, applied to a fresh builder — the list
    // query and the past-the-end recount (below) share them. The select
    // expression and its options ride in as parameters because the
    // options-bearing select() overload only exists at the from() level.
    const filtered = (
      columns: string,
      options: { head?: boolean; count?: 'exact' },
    ) => {
      let q = admin
        .from('customers_overview')
        .select(columns, options)
        .eq('tenant_id', owner.tenantId);

      const term = query.search ? this.sanitizeSearchTerm(query.search) : '';
      if (term) {
        // Inside .or() the ilike wildcard is '*' (PostgREST translates to '%').
        q = q.or(`name.ilike.*${term}*,phone_number.ilike.*${term}*`);
      }

      // The disjoint buckets — a customer falls in exactly one, so these are
      // plain predicates over job_count.
      if (query.filter === 'new') q = q.eq('job_count', 0);
      else if (query.filter === 'single') q = q.eq('job_count', 1);
      else if (query.filter === 'repeat') q = q.gte('job_count', 2);

      return q;
    };

    let qb = filtered('*', { count: 'exact' });

    // Every sort carries an id tiebreak, so two rows that share the sort key
    // can never straddle a page boundary.
    switch (query.sort) {
      case 'created_old':
        qb = qb
          .order('created_at', { ascending: true })
          .order('id', { ascending: true });
        break;
      case 'name_az':
        qb = qb
          .order('name', { ascending: true })
          .order('id', { ascending: true });
        break;
      case 'name_za':
        qb = qb
          .order('name', { ascending: false })
          .order('id', { ascending: false });
        break;
      case 'recent_activity':
        // A customer with no jobs sorts last (nullsFirst: false on a
        // descending order puts the nulls at the end).
        qb = qb
          .order('last_job_date', { ascending: false, nullsFirst: false })
          .order('id', { ascending: false });
        break;
      default:
        qb = qb
          .order('created_at', { ascending: false })
          .order('id', { ascending: false });
    }

    const [listResult, stats] = await Promise.all([
      qb.range((page - 1) * pageSize, page * pageSize - 1),
      this.getCustomersStats(owner.tenantId),
    ]);

    const { data, error, count } = listResult;
    if (error) {
      // A page entirely past the end (a hand-edited address — the app's own
      // pager clamps) is an EMPTY page, not a failure: PostgREST answers
      // PGRST103. The filtered total still counts, so the envelope stays
      // honest and the pager shows the real last page.
      if (error.code === 'PGRST103') {
        const { count: recount, error: recountError } = await filtered('id', {
          count: 'exact',
          head: true,
        });
        if (recountError) {
          this.logger.error('Failed to recount customers:', {
            error: recountError,
          });
          throw new InternalServerErrorException({
            error_code: ErrorCode.INTERNAL_SERVER_ERROR,
            message: 'Failed to list customers',
          });
        }
        const recountTotal = recount ?? 0;
        return {
          data: [],
          total: recountTotal,
          page,
          pageSize,
          pages: Math.max(1, Math.ceil(recountTotal / pageSize)),
          stats,
        };
      }
      this.logger.error('Failed to list customers page:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to list customers',
      });
    }

    const total = count ?? 0;
    // The select expression is a parameter, so postgrest-js can't narrow the
    // row type — the double cast just restores the shape we asked for.
    const rows = (data ?? []) as unknown as CustomerOverviewRow[];

    const items: CustomerListItem[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      customerCode: row.customer_code,
      countryCode: row.country_code,
      phoneNumber: row.phone_number,
      address: row.address,
      city: row.city,
      formattedAddress: row.formatted_address,
      pincode: row.pincode,
      latitude: row.latitude,
      longitude: row.longitude,
      placeId: row.place_id,
      addressDetails: row.address_details,
      jobCount: row.job_count,
      lastJobDate: row.last_job_date,
    }));

    return {
      data: items,
      total,
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
      stats,
    };
  }

  /**
   * Total number of customers in the tenant — an exact DB count, independent
   * of the cursor-paginated list above (whose page length caps at the page
   * size). Consumed by the profile endpoint (`customerCount` on
   * `CompanyProfileResponse`) so Home can show the real total without paging
   * through the customer list.
   */
  async countCustomers(tenantId: string): Promise<number> {
    const admin = this.supabaseClientFactory.createAdmin();

    // head: true — metadata-only request, no rows transferred.
    const { count, error } = await admin
      .from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId);

    if (error) {
      this.logger.error('Failed to count customers:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to count customers',
      });
    }

    return count ?? 0;
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
      // Story 4.5 — the skill name replaces the dropped service_type as the
      // history row's human label. Plain embed: a missing skill row degrades
      // to a null skillName, never a dropped row.
      .select('id, job_number, scheduled_start, status, skills(name)')
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

    const items: JobHistoryItem[] = pageRows.map((row) => {
      return {
        id: row.id,
        jobNumber: row.job_number,
        scheduledStart: row.scheduled_start,
        status: row.status,
        skillName: normalizeSkillEmbed(row.skills)?.name ?? null,
      };
    });

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
    customer_code: string;
    country_code: string;
    phone_number: string;
    address: string | null;
    city: string | null;
    formatted_address: string | null;
    pincode: string | null;
    latitude: number | null;
    longitude: number | null;
    place_id: string | null;
    address_details: string | null;
    created_via: 'manual' | 'job_creation';
    created_at: string;
    tenant_id: string;
  }): CustomerResponse {
    return {
      id: row.id,
      name: row.name,
      customerCode: row.customer_code,
      countryCode: row.country_code,
      phoneNumber: row.phone_number,
      address: row.address,
      city: row.city,
      formattedAddress: row.formatted_address,
      pincode: row.pincode,
      latitude: row.latitude,
      longitude: row.longitude,
      placeId: row.place_id,
      addressDetails: row.address_details,
      createdVia: row.created_via,
      createdAt: row.created_at,
      tenantId: row.tenant_id,
    };
  }
}
