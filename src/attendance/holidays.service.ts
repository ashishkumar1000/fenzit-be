import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { avatarUrlsByUserId } from '../common/members/member-avatars';
import { StorageService } from '../storage/storage.service';
import {
  CreateHolidayDto,
  HolidayDateQueryDto,
  HolidayOverviewQueryDto,
  UpdateHolidayDto,
} from './dto/holiday.dto';
import {
  internalError,
  requireTenant,
  resolveTenantToday,
} from './attendance-rpc.helpers';
import {
  holidayAppliesToOffice,
  type ScopedHoliday,
} from '../common/day-status/holiday-scope';
import {
  readScopedHolidayOn,
  readScopedHolidays,
  readScopedHolidaysBetween,
} from './holiday-scope.read';
import { ATTENDANCE_NOTIFICATION_EVENT } from './notification-events';
import { fanoutHolidayNotification } from './holiday-notify';
import {
  buildHolidayTemplate,
  HolidayBulkParseError,
  parseHolidayWorkbook,
  type HolidayBulkRowError,
} from './holidays-bulk';

/**
 * Holiday writes left the legacy PL/pgSQL RPCs (console redesign 2026-11-26):
 * every read/write is a parameterised statement through the pg pool, the
 * notification fan-out lives in holiday-notify.ts, and applicability is
 * scope + holiday_offices. The (tenant, date) unique stays — a retried add
 * or an edit onto a taken date is a 409 (AD-6: no idempotency interceptor
 * here).
 */

/** holidays row (snake_case, DB shape). */
export interface HolidayRow {
  id: string;
  tenant_id: string;
  holiday_date: string;
  name: string;
  description: string | null;
  scope: string;
  created_at: string;
  updated_at: string;
}

/** Holiday responses travel camelCase; officeIds is [] when scope is 'all'. */
export interface HolidayResponse {
  id: string;
  date: string;
  name: string;
  description: string | null;
  scope: string;
  officeIds: string[];
}

export interface HolidayOfficeCount {
  officeId: string;
  name: string;
  staffCount: number;
  /** True when this holiday closes the office (scope 'all', or named). */
  closed: boolean;
}

/**
 * GET /attendance/holidays/impact — keeps the shipped affectedEmployees
 * contract (the mobile app's add-sheet banner reads it) and ADDS the
 * console's real-data panel.
 */
export interface HolidayImpactResponse {
  date: string;
  affectedEmployees: {
    employeeId: string;
    employeeName: string;
    /** Short-lived link to the employee's photo, or null when none is set. */
    avatarUrl: string | null;
  }[];
  /** The holiday on the date — null when the date has no holiday. */
  holiday: HolidayResponse | null;
  approvedLeaveCount: number;
  trackedCount: number;
  perOffice: HolidayOfficeCount[];
  unassignedCount: number;
}

/** GET /attendance/holidays/overview — one call for both console pages. */
export interface HolidayOverviewResponse {
  year: string;
  holidays: (HolidayResponse & {
    /** Employees THIS holiday closes on ITS OWN date — the same
     * date-anchored population the impact endpoint serves, so the table's
     * "N employees off" and the inspector always agree.
     */
    employeesOff: number;
  })[];
  offices: { officeId: string; name: string; staffCount: number }[];
  unassignedCount: number;
  /**
   * The tenant's weekly-off default rules overlapping the year window
   * (Postgres daterange text, e.g. "[2026-01-01,)") — the raw facts the
   * console's long-break math needs; empty days = no weekly off.
   */
  weeklyOffDefaults: { valid: string; days: number[] }[];
}

/** The shape the tx reads normalise to (readScopedById / scoped reads). */
interface HolidaySource extends ScopedHoliday {
  description: string | null;
  holidayDate: string;
}

/**
 * Write RETURNING: scalars only — the applicability rows don't exist yet at
 * INSERT time (they land a statement later) and both writers already hold
 * the new officeIds in JS, so the response spread overrides it.
 */
const RETURNING = `returning id::text, name, description, scope,
  holiday_date::text as "holidayDate"`;

const writeLogger = new Logger('HolidaysService');

@Injectable()
export class HolidaysService {
  private readonly logger = new Logger(HolidaysService.name);

  constructor(
    private readonly supabaseClientFactory: SupabaseClientFactory,
    private readonly storageService: StorageService,
    private readonly pg: PgPoolFactory,
  ) {}

  /**
   * GET /attendance/holidays — tenant-scoped, ascending by date; the FE
   * (15-6) groups upcoming/past client-side. attendance_today runs first so
   * a stale/unknown tenant fails loud 404 like every sibling read.
   */
  async listHolidays(user: RequestUser): Promise<HolidayResponse[]> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();
    await resolveTenantToday(admin, tenantId);
    return this.pg.withTransaction(async (tx) => {
      const rows = await readScopedHolidays(tx, tenantId);
      return rows.map(toResponse);
    });
  }

  /**
   * GET /attendance/holidays/overview?year= — the console's year view: every
   * holiday with its offices, plus CURRENT staff per office (enrolments ∧
   * assignments covering TODAY — the schedule's "N staff" headcount) and the
   * enrolled-but-office-less count.
   */
  async getOverview(
    user: RequestUser,
    query: HolidayOverviewQueryDto,
  ): Promise<HolidayOverviewResponse> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();
    const today = await resolveTenantToday(admin, tenantId);
    const year = query.year;
    // The DTO only pins the SHAPE (^\d{4}$) — year 0000 slips past it and the
    // weekly-off window string `-1-12-20` explodes inside Postgres as a 500.
    if (Number(year) < 1) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Year must be 0001 or later.',
      });
    }
    return this.pg.withTransaction(async (tx) => {
      const [holidays, offices, unassignedCount, weeklyOffDefaults, headcounts] = await Promise.all([
        readScopedHolidaysBetween(tx, tenantId, `${year}-01-01`, `${year}-12-31`),
        readOfficeStaffCounts(tx, tenantId, today),
        readUnassignedCount(tx, tenantId, today),
        // The window must cover the web console's client-side long-weekend
        // scan (year edges ± 10 days): Dec 20 → Jan 12, not the narrower
        // Dec 30 → Jan 2 the FE once matched.
        readWeeklyOffDefaults(tx, tenantId, `${Number(year) - 1}-12-20`, `${Number(year) + 1}-01-12`),
        readHolidayHeadcounts(tx, tenantId, `${year}-01-01`, `${year}-12-31`),
      ]);
      return {
        year,
        holidays: holidays.map((holiday) => ({
          ...toResponse(holiday),
          employeesOff: headcounts.get(holiday.id) ?? 0,
        })),
        offices: offices.map(({ officeId, name, staffCount }) => ({
          officeId,
          name,
          staffCount,
        })),
        unassignedCount,
        weeklyOffDefaults,
      };
    });
  }

  /**
   * POST /attendance/holidays — holiday + applicability + (future dates) the
   * office-scoped notification fan-out, all in ONE transaction. A taken date
   * stays a 409 (the (tenant, date) unique).
   */
  async createHoliday(
    user: RequestUser,
    dto: CreateHolidayDto,
  ): Promise<HolidayResponse> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();
    const today = await resolveTenantToday(admin, tenantId);
    const scope = dto.scope ?? 'all';
    const officeIds = dto.officeIds ?? [];

    return this.pg.withTransaction((tx) =>
      this.insertHolidayInTx(
        tx,
        tenantId,
        { date: dto.date, name: dto.name, description: dto.description ?? null, scope, officeIds },
        { notify: true },
        today,
      ),
    );
  }

  /**
   * The one INSERT every holiday write path shares (single add AND bulk):
   * the holiday row, the office applicability rows, and — when `notify` — the
   * future-dated notification fan-out. Same rules, same audit trail, one
   * transaction supplied by the caller.
   */
  private async insertHolidayInTx(
    tx: PoolClient,
    tenantId: string,
    cmd: {
      date: string;
      name: string;
      description: string | null;
      scope: string;
      officeIds: string[];
    },
    opts: { notify: boolean },
    today: string,
  ): Promise<HolidayResponse> {
    const inserted = await tx
      .query<Omit<HolidaySource, 'officeIds'>>(
        `insert into public.holidays (tenant_id, holiday_date, name, description, scope)
         values ($1::uuid, $2::date, $3, $4, $5)
         ${RETURNING}`,
        [tenantId, cmd.date, cmd.name, cmd.description, cmd.scope],
      )
      .catch(throwHolidayWriteError('Failed to add holiday'));
    const row = inserted.rows[0];
    if (cmd.scope === 'offices') {
      await insertHolidayOffices(tx, tenantId, row.id, cmd.officeIds);
    }
    if (opts.notify) {
      await fanoutHolidayNotification(
        tx,
        ATTENDANCE_NOTIFICATION_EVENT.HOLIDAY_ADDED,
        {
          tenantId,
          holidayId: row.id,
          holidayName: row.name,
          holidayDate: row.holidayDate,
          holiday: { scope: cmd.scope, officeIds: cmd.officeIds },
        },
        today,
      );
    }
    return toResponse({
      ...row,
      officeIds: cmd.scope === 'offices' ? cmd.officeIds : [],
    });
  }

  /**
   * GET /attendance/holidays/bulk-template — the .xlsx download, with the
   * tenant's real (non-archived) office names on the Reference sheet so the
   * Offices column can be copied verbatim, and the tenant's existing holidays
   * pre-filled on the Holidays sheet so the user adds the new ones below them.
   */
  async buildBulkTemplate(user: RequestUser): Promise<Buffer> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();
    const today = await resolveTenantToday(admin, tenantId);
    return this.pg.withTransaction(async (tx) => {
      const offices = await readActiveOffices(tx, tenantId);
      const existing = (
        await tx.query<{
          d: string;
          name: string;
          description: string | null;
          scope: string;
          office_names: string[];
        }>(
          `select h.holiday_date::text as d,
                  h.name,
                  h.description,
                  h.scope,
                  coalesce(array_agg(o.name order by o.name) filter (where o.name is not null), '{}') as office_names
           from public.holidays h
           left join public.holiday_offices ho on ho.holiday_id = h.id
           left join public.attendance_offices o on o.id = ho.office_id
                and o.archived_at is null
           where h.tenant_id = $1::uuid
           group by h.id
           order by h.holiday_date`,
          [tenantId],
        )
      ).rows;
      return buildHolidayTemplate(
        offices.map((o) => o.name),
        existing.map((row) => ({
          date: row.d,
          name: row.name,
          description: row.description,
          officeNames: row.scope === 'all' ? [] : row.office_names,
        })),
        today,
      );
    });
  }

  /**
   * POST /attendance/holidays/bulk — the filled sheet, ALL OR NOTHING: every
   * row is parsed and checked first (shape in holidays-bulk.ts, office names
   * here); one bad row and NOTHING happens — the response names the exact
   * rows to fix. The template pre-fills the existing holidays, so a row whose
   * date is already on the calendar is that holiday's EDIT surface: same
   * name/description/offices → skipped (no-op); any of them changed → the
   * holiday is UPDATED in place (the date never changes, so no notification
   * fan-out — bulk stays SILENT). New dates are created in ONE transaction
   * through the same INSERT the single add uses.
   */
  async bulkCreateHolidays(
    user: RequestUser,
    file: Buffer,
  ): Promise<{
    created: number;
    updated: number;
    skipped: number;
    holidays: HolidayResponse[];
    updates: HolidayResponse[];
  }> {
    const tenantId = requireTenant(user);
    const parsedRows = await parseHolidayWorkbook(file).catch((error) => {
      if (error instanceof HolidayBulkParseError) {
        throwBulkInvalid(error.errors);
      }
      throw error;
    });

    const admin = this.supabaseClientFactory.createAdmin();
    const today = await resolveTenantToday(admin, tenantId);

    return this.pg.withTransaction(async (tx) => {
      const offices = await readActiveOffices(tx, tenantId);
      const officeIdByName = new Map(
        offices.map((o) => [o.name.toLowerCase(), o.id] as const),
      );
      const existing = new Map(
        (
          await tx.query<{
            d: string;
            name: string;
            description: string | null;
            scope: string;
            office_ids: string[];
            id: string;
          }>(
            `select h.holiday_date::text as d, h.name, h.description, h.scope, h.id,
                    coalesce(array_agg(ho.office_id::text) filter (where ho.office_id is not null), '{}') as office_ids
             from public.holidays h
             left join public.holiday_offices ho on ho.holiday_id = h.id
             where h.tenant_id = $1::uuid
             group by h.id
             order by h.holiday_date`,
            [tenantId],
          )
        ).rows.map((r) => [r.d, r] as const),
      );

      const errors: HolidayBulkRowError[] = [];
      const creates: {
        row: number;
        date: string;
        name: string;
        description: string | null;
        scope: string;
        officeIds: string[];
      }[] = [];
      const updates: {
        row: number;
        id: string;
        name: string;
        description: string | null;
        scope: string;
        officeIds: string[];
      }[] = [];
      let skipped = 0;

      for (const row of parsedRows) {
        const rowError = (message: string): HolidayBulkRowError => ({
          row: row.row,
          date: row.date,
          name: row.name,
          message,
        });

        // Offices cell: blank/"all" closes everyone; named offices resolve
        // case-insensitively against the tenant's non-archived offices (the
        // error echoes the name AS WRITTEN, not the lowercase lookup key).
        let scope = 'all';
        let officeIds: string[] = [];
        if (row.officesRaw !== null && !/^all( offices)?$/i.test(row.officesRaw)) {
          const wanted = [
            ...new Map(
              row.officesRaw
                .split(/[,;]/)
                .map((part) => part.trim())
                .filter((part) => part !== '')
                .map((part) => [part.toLowerCase(), part] as const),
            ).entries(),
          ];
          const resolved: string[] = [];
          for (const [lookupKey, asWritten] of wanted) {
            const id = officeIdByName.get(lookupKey);
            if (id === undefined) {
              errors.push(
                rowError(
                  `"${asWritten}" is not one of your offices — copy the exact name from the Reference sheet.`,
                ),
              );
            } else {
              resolved.push(id);
            }
          }
          if (resolved.length === 0) {
            if (errors.at(-1)?.row !== row.row) {
              errors.push(rowError('Name at least one office, or leave the cell blank for every office.'));
            }
            continue;
          }
          scope = 'offices';
          officeIds = resolved;
        }

        // A date already on the calendar is that holiday's edit surface:
        // identical → skip; any of name/description/offices changed → update
        // in place (names compare case-insensitively so Excel's autocorrect
        // is not read as an intent to rename).
        const stored = existing.get(row.date);
        if (stored !== undefined) {
          const sameName = stored.name.toLowerCase() === row.name.toLowerCase();
          const sameDescription = (stored.description ?? '') === (row.description ?? '');
          const sameOffices =
            scope === stored.scope &&
            (scope === 'all' ||
              (officeIds.length === stored.office_ids.length &&
                [...officeIds].sort().every((id, i) => id === [...stored.office_ids].sort()[i])));
          if (sameName && sameDescription && sameOffices) {
            skipped += 1;
          } else {
            updates.push({
              row: row.row,
              id: stored.id,
              // A case-only rename is Excel's autocorrect, not an intent to
              // rename (the comment above) — keep the stored casing.
              name: sameName ? stored.name : row.name,
              description: row.description,
              scope,
              officeIds,
            });
          }
          continue;
        }
        creates.push({
          row: row.row,
          date: row.date,
          name: row.name,
          description: row.description,
          scope,
          officeIds,
        });
      }

      if (errors.length > 0) throwBulkInvalid(errors);

      const holidays: HolidayResponse[] = [];
      for (const cmd of creates) {
        holidays.push(
          await this.insertHolidayInTx(
            tx,
            tenantId,
            { date: cmd.date, name: cmd.name, description: cmd.description, scope: cmd.scope, officeIds: cmd.officeIds },
            { notify: false },
            today,
          ),
        );
      }
      // The overrides: same UPDATE the single edit runs (the date never moves,
      // so no notification fan-out) + the applicability rewrite.
      const updatedHolidays: HolidayResponse[] = [];
      for (const cmd of updates) {
        const updated = await tx
          .query<Omit<HolidaySource, 'officeIds'>>(
            `update public.holidays
             set name = $3, description = $4, scope = $5, updated_at = now()
             where id = $1::uuid and tenant_id = $2::uuid
             ${RETURNING}`,
            [cmd.id, tenantId, cmd.name, cmd.description, cmd.scope],
          )
          .catch(throwHolidayWriteError('Failed to update holiday'));
        if (updated.rows.length === 0) {
          throw holidayNotFound();
        }
        await insertHolidayOffices(tx, tenantId, cmd.id, cmd.scope === 'offices' ? cmd.officeIds : []);
        updatedHolidays.push(toResponse({ ...updated.rows[0], officeIds: cmd.officeIds }));
      }
      return {
        created: holidays.length,
        updated: updatedHolidays.length,
        skipped,
        holidays,
        updates: updatedHolidays,
      };
    });
  }

  /**
   * PATCH /attendance/holidays/:id — every field incl. the date (the console
   * redesign reverses the old remove+add scope decision). A date change on a
   * future holiday fires holiday_removed for the old date then
   * holiday_added for the new; a scope/officeIds change on an unmoved future
   * holiday fires holiday_added alone (the audience changed). Name/description
   * edits stay silent, exactly like the legacy RPC.
   */
  async updateHoliday(
    user: RequestUser,
    holidayId: string,
    dto: UpdateHolidayDto,
  ): Promise<HolidayResponse> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();
    const today = await resolveTenantToday(admin, tenantId);

    return this.pg.withTransaction(async (tx) => {
      const existing = await readScopedById(tx, tenantId, holidayId);
      const scope = dto.scope ?? existing.scope;
      const officeIds =
        dto.officeIds ?? (existing.scope === 'offices' ? existing.officeIds : []);
      const date = dto.date ?? existing.holidayDate;

      // An applicability payload that would be silently discarded (officeIds
      // with scope 'all') or silently empty (scope 'offices' without offices)
      // is a client bug — say so instead of storing a surprise.
      if (dto.officeIds !== undefined && scope !== 'offices') {
        throw new BadRequestException({
          error_code: ErrorCode.VALIDATION_ERROR,
          message: 'officeIds only apply when the scope is offices.',
        });
      }
      if (scope === 'offices' && officeIds.length === 0) {
        throw new BadRequestException({
          error_code: ErrorCode.VALIDATION_ERROR,
          message: 'Name at least one office when the scope is offices.',
        });
      }

      const updated = await tx
        .query<Omit<HolidaySource, 'officeIds'>>(
          `update public.holidays
           set name = $3, description = $4, scope = $5, holiday_date = $6::date,
               updated_at = now()
           where id = $1::uuid and tenant_id = $2::uuid
           ${RETURNING}`,
          [
            holidayId,
            tenantId,
            dto.name ?? existing.name,
            dto.description !== undefined ? dto.description : existing.description,
            scope,
            date,
          ],
        )
        .catch(throwHolidayWriteError('Failed to update holiday'));
      if (updated.rows.length === 0) {
        throw holidayNotFound();
      }

      // Applicability rewrite on any scope/officeIds key — 'all' leaves zero
      // join rows behind, 'offices' lands the new set.
      const applicabilityChanged =
        dto.scope !== undefined || dto.officeIds !== undefined;
      if (applicabilityChanged) {
        await insertHolidayOffices(
          tx,
          tenantId,
          holidayId,
          scope === 'offices' ? officeIds : [],
        );
      }

      if (date !== existing.holidayDate && existing.holidayDate > today) {
        await fanoutHolidayNotification(
          tx,
          ATTENDANCE_NOTIFICATION_EVENT.HOLIDAY_REMOVED,
          {
            tenantId,
            holidayId,
            holidayName: existing.name,
            holidayDate: existing.holidayDate,
            holiday: existing,
          },
          today,
        );
      }
      if (date > today && (date !== existing.holidayDate || applicabilityChanged)) {
        await fanoutHolidayNotification(
          tx,
          ATTENDANCE_NOTIFICATION_EVENT.HOLIDAY_ADDED,
          {
            tenantId,
            holidayId,
            holidayName: dto.name ?? existing.name,
            holidayDate: date,
            holiday: { scope, officeIds },
          },
          today,
        );
      }
      return toResponse({
        ...updated.rows[0],
        officeIds: scope === 'offices' ? officeIds : [],
      });
    });
  }

  /**
   * DELETE /attendance/holidays/:id — hard delete (FR-20); join rows go by
   * cascade; removed future holidays notify the offices the holiday covered.
   */
  async removeHoliday(user: RequestUser, holidayId: string): Promise<null> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();
    const today = await resolveTenantToday(admin, tenantId);

    await this.pg.withTransaction(async (tx) => {
      const existing = await readScopedById(tx, tenantId, holidayId);
      const deleted = await tx.query(
        `delete from public.holidays where id = $1::uuid and tenant_id = $2::uuid`,
        [holidayId, tenantId],
      );
      if (deleted.rowCount === 0) {
        throw holidayNotFound();
      }
      await fanoutHolidayNotification(
        tx,
        ATTENDANCE_NOTIFICATION_EVENT.HOLIDAY_REMOVED,
        {
          tenantId,
          holidayId,
          holidayName: existing.name,
          holidayDate: existing.holidayDate,
          holiday: existing,
        },
        today,
      );
    });
    return null;
  }

  /**
   * GET /attendance/holidays/impact?date= — the AD-24 preview, extended with
   * the console's real-data panel. affectedEmployees keeps its shipped shape
   * (the mobile add-sheet banner reads it); holiday is null on a plain date.
   * Per-office counts anchor at the QUERIED date (the inspector shows who is
   * where on that day).
   */
  async getImpact(
    user: RequestUser,
    query: HolidayDateQueryDto,
  ): Promise<HolidayImpactResponse> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();
    await resolveTenantToday(admin, tenantId);

    return this.pg.withTransaction(async (tx) => {
      const holiday = await readScopedHolidayOn(tx, tenantId, query.date);
      const [approvedLeave, trackedCount, offices, unassignedCount] =
        await Promise.all([
          readApprovedLeaveOn(tx, tenantId, query.date),
          readTrackedCount(tx, tenantId, query.date),
          readOfficeStaffCounts(tx, tenantId, query.date),
          readUnassignedCount(tx, tenantId, query.date),
        ]);
      const avatarUrls = await avatarUrlsByUserId(
        this.storageService,
        this.supabaseClientFactory.createAdmin(),
        tenantId,
        approvedLeave.map((row) => row.employeeId),
      );
      return {
        date: query.date,
        affectedEmployees: approvedLeave.map((row) => ({
          employeeId: row.employeeId,
          employeeName: row.employeeName,
          avatarUrl: avatarUrls.get(row.employeeId) ?? null,
        })),
        holiday: holiday ? toResponse(holiday) : null,
        approvedLeaveCount: approvedLeave.length,
        trackedCount,
        perOffice: offices.map((office) => ({
          ...office,
          closed: holidayAppliesToOffice(holiday, office.officeId),
        })),
        unassignedCount,
      };
    });
  }
}

async function readScopedById(
  tx: PoolClient,
  tenantId: string,
  holidayId: string,
): Promise<HolidaySource> {
  const holiday = await tx.query<HolidaySource>(
    `select h.id::text, h.name, h.scope, h.holiday_date::text as "holidayDate",
            h.description,
            coalesce((select array_agg(ho.office_id::text)
                      from public.holiday_offices ho
                      where ho.holiday_id = h.id), '{}') as "officeIds"
     from public.holidays h
     where h.id = $1::uuid and h.tenant_id = $2::uuid`,
    [holidayId, tenantId],
  );
  const row = holiday.rows[0];
  if (!row) {
    throw holidayNotFound();
  }
  return row;
}

/**
 * Rewrite semantics for applicability: the old set goes, the new set lands
 * ('all' → zero rows). Idempotent, so a retried PATCH lands the same state.
 */
async function insertHolidayOffices(
  tx: PoolClient,
  tenantId: string,
  holidayId: string,
  officeIds: string[],
): Promise<void> {
  await tx.query(`delete from public.holiday_offices where holiday_id = $1::uuid`, [
    holidayId,
  ]);
  if (officeIds.length === 0) return;
  await tx
    .query(
      `insert into public.holiday_offices (holiday_id, office_id, tenant_id, updated_at)
       select $1::uuid, x, $2::uuid, now()
       from unnest($3::uuid[]) x`,
      // Dedupe first — a repeated id would violate the (holiday, office) PK
      // and read as a bogus "already exists" 409.
      [holidayId, tenantId, [...new Set(officeIds)]],
    )
    .catch(throwHolidayWriteError('Failed to save holiday offices'));
}

/** Employees on APPROVED leave that date (the shipped preview contract). */
async function readApprovedLeaveOn(
  tx: PoolClient,
  tenantId: string,
  date: string,
): Promise<{ employeeId: string; employeeName: string }[]> {
  const { rows } = await tx.query<{
    employee_id: string;
    employee_name: string;
  }>(
    `select d.employee_id::text,
            coalesce(nullif(u.name, ''), u.country_code || u.phone_number,
                     'Unknown employee') as employee_name
     from public.leave_request_days d
     join public.users u on u.id = d.employee_id
     join public.memberships m
       on m.user_id = d.employee_id
      and m.tenant_id = $1::uuid
      and m.status <> 'removed'
     where d.tenant_id = $1::uuid and d.leave_date = $2::date
       and d.state = 'approved'
     order by employee_name`,
    [tenantId, date],
  );
  return rows.map((r) => ({
    employeeId: r.employee_id,
    employeeName: r.employee_name,
  }));
}

/** Enrolled ∧ office-assigned employees covering the date. */
async function readTrackedCount(
  tx: PoolClient,
  tenantId: string,
  date: string,
): Promise<number> {
  const { rows } = await tx.query<{ tracked: number }>(
    `select count(distinct e.employee_id)::int as tracked
     from public.attendance_enrolments e
     join public.attendance_office_assignments a
       on a.employee_id = e.employee_id and a.valid @> $2::date
     where e.tenant_id = $1::uuid and e.valid @> $2::date`,
    [tenantId, date],
  );
  return rows[0]?.tracked ?? 0;
}

/** Enrolled employees covering the date with NO covering office assignment. */
async function readUnassignedCount(
  tx: PoolClient,
  tenantId: string,
  date: string,
): Promise<number> {
  const { rows } = await tx.query<{ unassigned: number }>(
    `select count(distinct e.employee_id)::int as unassigned
     from public.attendance_enrolments e
     where e.tenant_id = $1::uuid and e.valid @> $2::date
       and not exists (
         select 1 from public.attendance_office_assignments a
         where a.employee_id = e.employee_id and a.valid @> $2::date
       )`,
    [tenantId, date],
  );
  return rows[0]?.unassigned ?? 0;
}

/**
 * The tenant's weekly-off default rules overlapping [from, to) — the raw
 * facts behind the console's long-break math (a break = a holiday's run of
 * weekly-off days + applicable holidays). Range text stays Postgres
 * daterange format; empty days = no weekly off.
 */
async function readWeeklyOffDefaults(
  tx: PoolClient,
  tenantId: string,
  from: string,
  to: string,
): Promise<{ valid: string; days: number[] }[]> {
  const { rows } = await tx.query<{ valid: string; days: number[] }>(
    `select valid::text, days
     from public.attendance_weekly_off_defaults
     where tenant_id = $1::uuid and valid && daterange($2::date, $3::date)
     order by valid`,
    [tenantId, from, to],
  );
  return rows.map((r) => ({ valid: r.valid, days: [...r.days].sort((a, b) => a - b) }));
}

/**
 * Per-holiday closed headcounts anchored at EACH holiday's own date — the
 * same population the impact endpoint serves for one date, so the table's
 * "N employees off" and the inspector can never disagree (the overview's
 * per-office roster counts stay TODAY-anchored for the coverage cards, so
 * they are the wrong anchor for a row). Scope 'all' closes every enrolled
 * employee covering the date, assigned or not; scope 'offices' closes the
 * enrolled who are ALSO assigned to a named office covering the date.
 * Holidays nobody is enrolled for land as no row at all — the caller reads
 * them as 0.
 */
async function readHolidayHeadcounts(
  tx: PoolClient,
  tenantId: string,
  fromDate: string,
  toDate: string,
): Promise<Map<string, number>> {
  const { rows } = await tx.query<{ holiday_id: string; employees_off: number }>(
    `select h.id::text as holiday_id,
            count(distinct e.employee_id)::int as employees_off
     from public.holidays h
     join public.attendance_enrolments e
       on e.tenant_id = h.tenant_id and e.valid @> h.holiday_date
     where h.tenant_id = $1::uuid
       and h.holiday_date between $2::date and $3::date
       and (h.scope = 'all' or exists (
         select 1 from public.holiday_offices ho
         join public.attendance_office_assignments a
           on a.office_id = ho.office_id
          and a.employee_id = e.employee_id
          and a.valid @> h.holiday_date
         where ho.holiday_id = h.id
       ))
     group by h.id`,
    [tenantId, fromDate, toDate],
  );
  return new Map(rows.map((r) => [r.holiday_id, r.employees_off]));
}

/**
 * Per-office staff counts (enrolled ∧ assigned covering the anchor), every
 * non-archived office present — zero-staff offices render too.
 */
async function readOfficeStaffCounts(
  tx: PoolClient,
  tenantId: string,
  date: string,
): Promise<{ officeId: string; name: string; staffCount: number }[]> {
  const { rows } = await tx.query<{
    office_id: string;
    name: string;
    staff_count: number;
  }>(
    `select o.id::text as office_id, o.name,
            count(distinct e.employee_id)::int as staff_count
     from public.attendance_offices o
     left join public.attendance_office_assignments a
       on a.office_id = o.id and a.valid @> $2::date
     left join public.attendance_enrolments e
       on e.employee_id = a.employee_id and e.valid @> $2::date
     where o.tenant_id = $1::uuid and o.archived_at is null
     group by o.id, o.name
     order by o.name`,
    [tenantId, date],
  );
  return rows.map((r) => ({
    officeId: r.office_id,
    name: r.name,
    staffCount: r.staff_count,
  }));
}

/** The tenant's non-archived offices — the bulk sheet's Offices column and
 *  the template's Reference sheet both resolve against exactly this set. */
async function readActiveOffices(
  tx: PoolClient,
  tenantId: string,
): Promise<{ id: string; name: string }[]> {
  const { rows } = await tx.query<{ office_id: string; name: string }>(
    `select o.id::text as office_id, o.name
     from public.attendance_offices o
     where o.tenant_id = $1::uuid and o.archived_at is null
     order by o.name`,
    [tenantId],
  );
  return rows.map((r) => ({ id: r.office_id, name: r.name }));
}

/** 422 carrying the exact problem rows — nothing was created. */
function throwBulkInvalid(errors: HolidayBulkRowError[]): never {
  throw new HttpException(
    {
      error_code: ErrorCode.ATTENDANCE_HOLIDAY_BULK_INVALID,
      message: `The sheet has ${errors.length} problem${errors.length === 1 ? '' : 's'} — nothing was added yet. Fix the rows below and upload again.`,
      errors,
    },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

function toResponse(row: HolidaySource): HolidayResponse {
  return {
    id: row.id,
    date: row.holidayDate,
    name: row.name,
    description: row.description,
    scope: row.scope,
    officeIds: row.officeIds ?? [],
  };
}

function holidayNotFound(): NotFoundException {
  return new NotFoundException({
    error_code: ErrorCode.ATTENDANCE_HOLIDAY_NOT_FOUND,
    message: 'Holiday not found',
  });
}

/** Maps the write-path SQLSTATEs: taken date → 409, foreign office → 422. */
function throwHolidayWriteError(fallback: string): (error: unknown) => never {
  return (error: unknown) => {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : undefined;
    if (code === '23505') {
      throw new HttpException(
        {
          error_code: ErrorCode.ATTENDANCE_HOLIDAY_TAKEN,
          message: 'A holiday on this date already exists',
        },
        HttpStatus.CONFLICT,
      );
    }
    if (code === '23503') {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Unknown office in officeIds',
      });
    }
    writeLogger.error('Holiday write failed:', { error });
    throw internalError(fallback);
  };
}
