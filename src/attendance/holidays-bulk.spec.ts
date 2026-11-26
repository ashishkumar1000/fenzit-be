import ExcelJS from 'exceljs';
import { HttpException } from '@nestjs/common';
import {
  buildHolidayTemplate,
  HolidayBulkParseError,
  parseHolidayWorkbook,
} from './holidays-bulk';
import { HolidaysService } from './holidays.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { StorageService } from '../storage/storage.service';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { ErrorCode } from '../common/enums/error-code.enum';

/**
 * The bulk-holiday sheet: the template and the parser are pure (holidays-bulk.ts),
 * the service path is the all-or-nothing gate — every statement the bulk flow
 * runs is routed by SQL SHAPE here (the holidays.service.spec idiom), and the
 * assertions pin the two contracts the owner feels: one bad row adds NOTHING,
 * and a clean sheet adds everything WITHOUT a notification burst.
 */

const TENANT_ID = '00000000-0000-4000-8000-0000000000c6';
const HOLIDAY_ID = '00000000-0000-4000-8000-0000000000e6';
const TODAY = '2026-11-26';

const OWNER: RequestUser = {
  id: '00000000-0000-4000-8000-0000000000a1',
  role: 'company_admin',
  tenantId: TENANT_ID,
} as unknown as RequestUser;

/** Fabricates a filled "Holidays" sheet the way the console user's Excel would. */
async function sheetBuffer(
  rows: ExcelJS.CellValue[][],
  sheetName = 'Holidays',
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRow(['Date', 'Holiday Name', 'Description (optional)', 'Offices (optional)']);
  for (const row of rows) ws.addRow(row);
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

describe('buildHolidayTemplate', () => {
  it('round-trips: the generated template parses back as an EMPTY sheet', async () => {
    const file = await buildHolidayTemplate(['Head Office', 'Test Branch'], [], '2026-11-26');
    const rows = await parseHolidayWorkbook(file);
    expect(rows).toEqual([]);
  });

  it('lists the tenant office names on the Reference sheet', async () => {
    const file = await buildHolidayTemplate(['Head Office', 'Regional Hub'], [], '2026-11-26');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ref = wb.getWorksheet('Reference');
    expect(ref?.getCell('A3').value).toBe('Head Office');
    expect(ref?.getCell('A4').value).toBe('Regional Hub');
  });

  it('PRE-FILLS the existing holidays so the user adds new ones below them', async () => {
    const file = await buildHolidayTemplate(['Head Office', 'Test Branch'], [
      { date: '2026-01-26', name: 'Republic Day', description: 'National holiday', officeNames: [] },
      { date: '2026-09-05', name: 'Milad-un-Nabi', description: null, officeNames: ['Head Office'] },
    ], '2026-11-26');
    const rows = await parseHolidayWorkbook(file);
    expect(rows).toEqual([
      { row: 2, date: '2026-01-26', name: 'Republic Day', description: 'National holiday', officesRaw: null },
      { row: 3, date: '2026-09-05', name: 'Milad-un-Nabi', description: null, officesRaw: 'Head Office' },
    ]);
  });
});

describe('parseHolidayWorkbook', () => {
  it('reads ISO text dates, day-first text and real date cells', async () => {
    const file = await sheetBuffer([
      ['2026-08-15', 'Independence Day', 'National holiday', null],
      ['5/9/2026', 'Milad-un-Nabi', null, null],
      [new Date(Date.UTC(2026, 9, 2)), 'Gandhi Jayanti', null, null],
    ]);
    const rows = await parseHolidayWorkbook(file);
    expect(rows.map((r) => [r.date, r.name])).toEqual([
      ['2026-08-15', 'Independence Day'],
      ['2026-09-05', 'Milad-un-Nabi'],
      ['2026-10-02', 'Gandhi Jayanti'],
    ]);
  });

  it('skips blank filler rows and keeps the raw offices cell', async () => {
    const file = await sheetBuffer([
      [null, null, null, null],
      ['2026-01-26', 'Republic Day', null, 'Head Office, Test Branch'],
    ]);
    const rows = await parseHolidayWorkbook(file);
    expect(rows).toEqual([
      {
        row: 3,
        date: '2026-01-26',
        name: 'Republic Day',
        description: null,
        officesRaw: 'Head Office, Test Branch',
      },
    ]);
  });

  it('collects EVERY shape problem with its sheet row, not just the first', async () => {
    const file = await sheetBuffer([
      ['15/08/2026', 'Fine', null, null],
      ['not a date', 'Bad Date', null, null],
      ['2026-02-30', 'Impossible Date', null, null],
      ['2026-03-04', null, null, null],
      ['2026-04-03', 'N'.repeat(81), null, null],
      ['2026-05-01', 'Dupe', null, null],
      ['2026-05-01', 'Dupe again', null, null],
    ]);
    await expect(parseHolidayWorkbook(file)).rejects.toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({ row: 3, message: expect.stringContaining('Use the date as 2026-08-15') }),
        // An impossible calendar date (2026-02-30) fails the same round-trip
        // and gets the same teach-the-format message.
        expect.objectContaining({ row: 4, message: expect.stringContaining('Use the date as 2026-08-15') }),
        expect.objectContaining({ row: 5, message: expect.stringContaining('name') }),
        expect.objectContaining({ row: 6, message: expect.stringContaining('80') }),
        expect.objectContaining({ row: 8, message: expect.stringContaining('row 7') }),
      ]),
    });
  });

  it('rejects a buffer that is not an xlsx at all', async () => {
    await expect(
      parseHolidayWorkbook(Buffer.from('this is not excel')),
    ).rejects.toBeInstanceOf(HolidayBulkParseError);
  });

  it('keeps row 1 as data when A1 is not the template header', async () => {
    // Built WITHOUT the header row — sheetBuffer always writes one.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Holidays');
    ws.addRow(['2026-01-26', 'Republic Day', null, null]);
    ws.addRow(['2026-08-15', 'Independence Day', null, null]);
    const file = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    const rows = await parseHolidayWorkbook(file);
    expect(rows.map((r) => [r.row, r.date, r.name])).toEqual([
      [1, '2026-01-26', 'Republic Day'],
      [2, '2026-08-15', 'Independence Day'],
    ]);
  });

  it('a fractional Excel serial floors to its DAY — the time-of-day never shifts the date', async () => {
    // The serial for 2026-08-15 computed from the Excel epoch; the .5 is
    // 18:00. Rounded ms would miss UTC midnight and the local-parts fallback
    // could read the previous day on a non-UTC server.
    const serial = Math.round(
      (Date.UTC(2026, 7, 15) - Date.UTC(1899, 11, 30)) / 86400000,
    );
    const file = await sheetBuffer([[`${serial}.5`, 'Fractional Serial', null, null]]);
    const rows = await parseHolidayWorkbook(file);
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe('2026-08-15');
  });
});

describe('HolidaysService bulkCreateHolidays', () => {
  function build(opts: {
    offices?: Array<{ office_id: string; name: string }>;
    /** The tenant's existing holidays as the bulk query reads them. */
    existing?: Array<{
      d: string;
      name: string;
      description: string | null;
      scope: string;
      office_ids: string[];
      id: string;
    }>;
    templateRows?: Array<{
      d: string;
      name: string;
      description: string | null;
      scope: string;
      office_names: string[];
    }>;
  } = {}) {
    const txStatements: Array<{ sql: string; params?: unknown[] }> = [];
    const holidayOfficeRows: string[][] = [];
    const notificationRows: unknown[][] = [];

    const tx = {
      query: jest.fn((sql: string, params?: unknown[]) => {
        txStatements.push({ sql, params });
        if (sql.includes('from public.attendance_offices')) {
          return Promise.resolve({ rows: opts.offices ?? [] });
        }
        if (sql.includes('array_agg(o.name')) {
          return Promise.resolve({ rows: opts.templateRows ?? [] });
        }
        if (sql.includes('array_agg(ho.office_id')) {
          return Promise.resolve({ rows: opts.existing ?? [] });
        }
        if (sql.includes('insert into public.holidays')) {
          return Promise.resolve({
            rows: [
              {
                id: HOLIDAY_ID,
                name: params?.[2],
                description: params?.[3],
                scope: params?.[4],
                holidayDate: params?.[1],
              },
            ],
          });
        }
        if (sql.includes('update public.holidays')) {
          return Promise.resolve({
            rows: [
              {
                id: params?.[0],
                name: params?.[2],
                description: params?.[3],
                scope: params?.[4],
                holidayDate: '2026-10-02',
              },
            ],
          });
        }
        if (sql.includes('delete from public.holiday_offices')) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        if (sql.includes('insert into public.holiday_offices')) {
          holidayOfficeRows.push((params?.[2] as string[]) ?? []);
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('insert into public.notifications')) {
          notificationRows.push(params ?? []);
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        return Promise.reject(new Error(`unexpected SQL in the tx: ${sql}`));
      }),
    };
    const pg = {
      withTransaction: jest.fn((work: (c: unknown) => Promise<unknown>) =>
        work(tx),
      ),
    } as unknown as jest.Mocked<PgPoolFactory>;
    const rpc = jest.fn(() => Promise.resolve({ data: TODAY, error: null }));
    const supabase = {
      createAdmin: () => ({ rpc }),
    } as unknown as jest.Mocked<SupabaseClientFactory>;
    const service = new HolidaysService(
      supabase,
      {} as unknown as StorageService,
      pg,
    );
    return { service, txStatements, holidayOfficeRows, notificationRows };
  }

  const OFFICES = [
    { office_id: '00000000-0000-4000-8000-0000000000f1', name: 'Head Office' },
    { office_id: '00000000-0000-4000-8000-0000000000f2', name: 'Test Branch' },
  ];

  it('adds every row of a clean sheet in one transaction — mixed scopes resolve', async () => {
    const file = await sheetBuffer([
      ['2026-08-15', 'Independence Day', null, null],
      ['2026-09-05', 'Milad-un-Nabi', 'Moon-dependent', 'head office'],
      ['2026-10-02', 'Gandhi Jayanti', null, 'Head Office, Test Branch'],
    ]);
    const { service, txStatements, holidayOfficeRows, notificationRows } =
      build({ offices: OFFICES });
    const result = await service.bulkCreateHolidays(OWNER, file);

    expect(result.created).toBe(3);
    expect(result.holidays.map((h) => h.scope)).toEqual(['all', 'offices', 'offices']);
    // Only the office-scoped rows land join rows; the case-insensitive match wins.
    expect(holidayOfficeRows).toEqual([
      ['00000000-0000-4000-8000-0000000000f1'],
      ['00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000f2'],
    ]);
    // Bulk stays SILENT — a year's import must not fire a notification burst.
    expect(notificationRows).toEqual([]);
    // One transaction: every statement ran against the same client.
    expect(txStatements.filter((s) => s.sql.includes('insert into public.holidays'))).toHaveLength(3);
  });

  it('creates NOTHING when one row names an unknown office — the errors name the rows', async () => {
    const file = await sheetBuffer([
      ['2026-08-15', 'Independence Day', null, null],
      ['2026-09-05', 'Milad-un-Nabi', null, 'Bengaluru Office'],
    ]);
    const { service, txStatements } = build({ offices: OFFICES });

    await expect(service.bulkCreateHolidays(OWNER, file)).rejects.toMatchObject({
      status: 422,
      response: {
        error_code: ErrorCode.ATTENDANCE_HOLIDAY_BULK_INVALID,
        errors: [
          expect.objectContaining({
            row: 3,
            message: expect.stringContaining('Bengaluru Office'),
          }),
        ],
      },
    });
    expect(
      txStatements.filter((s) => s.sql.includes('insert into public.holidays')),
    ).toEqual([]);
  });

  it('SKIPS rows that are identical to the calendar — the pre-filled rows untouched', async () => {
    const file = await sheetBuffer([
      ['2026-08-15', 'Independence Day', null, null],
      ['2026-10-02', 'Gandhi Jayanti', null, null],
      ['2026-12-25', 'Christmas', null, null],
    ]);
    const { service, txStatements } = build({
      offices: OFFICES,
      existing: [
        { d: '2026-10-02', name: 'Gandhi Jayanti', description: null, scope: 'all', office_ids: [], id: HOLIDAY_ID },
      ],
    });
    const result = await service.bulkCreateHolidays(OWNER, file);

    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(
      txStatements.filter((s) => s.sql.includes('insert into public.holidays')),
    ).toHaveLength(2);
    expect(txStatements.filter((s) => s.sql.includes('update public.holidays'))).toEqual([]);
  });

  it('OVERRIDES a pre-filled row whose name changed — the sheet is the edit surface', async () => {
    const file = await sheetBuffer([
      ['2026-10-02', 'Mahatma Gandhi Jayanti', 'Father of the nation', null],
    ]);
    const { service, txStatements, holidayOfficeRows } = build({
      offices: OFFICES,
      existing: [
        { d: '2026-10-02', name: 'Gandhi Jayanti', description: null, scope: 'all', office_ids: [], id: HOLIDAY_ID },
      ],
    });
    const result = await service.bulkCreateHolidays(OWNER, file);

    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.updates.map((u) => [u.id, u.name, u.description])).toEqual([
      [HOLIDAY_ID, 'Mahatma Gandhi Jayanti', 'Father of the nation'],
    ]);
    const update = txStatements.find((s) => s.sql.includes('update public.holidays'));
    expect(update?.params?.[2]).toBe('Mahatma Gandhi Jayanti');
    expect(update?.params?.[3]).toBe('Father of the nation');
    // scope 'all' rewrites applicability: the old join rows go (the delete),
    // and an empty insert list writes zero join rows — so no INSERT at all.
    expect(holidayOfficeRows).toEqual([]);
    expect(
      txStatements.filter((s) => s.sql.includes('delete from public.holiday_offices')),
    ).toHaveLength(1);
    // Bulk stays SILENT — an override fires no notification.
    expect(
      txStatements.filter((s) => s.sql.includes('insert into public.notifications')),
    ).toEqual([]);
  });

  it('OVERRIDES offices too — same name but a different office set updates the row', async () => {
    const file = await sheetBuffer([
      ['2026-10-02', 'gandhi jayanti', null, 'Head Office'],
    ]);
    const { service, txStatements, holidayOfficeRows } = build({
      offices: OFFICES,
      existing: [
        { d: '2026-10-02', name: 'Gandhi Jayanti', description: null, scope: 'all', office_ids: [], id: HOLIDAY_ID },
      ],
    });
    const result = await service.bulkCreateHolidays(OWNER, file);

    // The case-only name is NOT a rename, but the offices change still is an override.
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(0);
    const update = txStatements.find((s) => s.sql.includes('update public.holidays'));
    expect(update?.params?.[4]).toBe('offices');
    expect(holidayOfficeRows).toEqual([['00000000-0000-4000-8000-0000000000f1']]);
  });

  it('a sheet that adds one AND overrides another answers both in one transaction', async () => {
    const file = await sheetBuffer([
      ['2026-10-02', 'Gandhi Jayanti', 'Father of the nation', null],
      ['2027-12-31', 'Test New Years Eve', null, null],
    ]);
    const { service, txStatements } = build({
      offices: OFFICES,
      existing: [
        { d: '2026-10-02', name: 'Gandhi Jayanti', description: null, scope: 'all', office_ids: [], id: HOLIDAY_ID },
      ],
    });
    const result = await service.bulkCreateHolidays(OWNER, file);

    expect(result.created).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(txStatements.filter((s) => s.sql.includes('insert into public.holidays'))).toHaveLength(1);
    expect(txStatements.filter((s) => s.sql.includes('update public.holidays'))).toHaveLength(1);
  });

  it('buildBulkTemplate pre-fills the sheet with the tenant holidays, offices resolved', async () => {
    const { service } = build({
      offices: OFFICES,
      templateRows: [
        { d: '2026-01-26', name: 'Republic Day', description: 'National holiday', scope: 'all', office_names: ['Head Office'] },
        { d: '2026-09-05', name: 'Milad-un-Nabi', description: null, scope: 'offices', office_names: ['Head Office', 'Test Branch'] },
      ],
    });
    const file = await service.buildBulkTemplate(OWNER);

    const rows = await parseHolidayWorkbook(file);
    expect(rows).toEqual([
      { row: 2, date: '2026-01-26', name: 'Republic Day', description: 'National holiday', officesRaw: null },
      { row: 3, date: '2026-09-05', name: 'Milad-un-Nabi', description: null, officesRaw: 'Head Office, Test Branch' },
    ]);
  });

  it('surfaces a non-xlsx upload as the plain 422, nothing created', async () => {
    const { service, txStatements } = build();
    await expect(
      service.bulkCreateHolidays(OWNER, Buffer.from('garbage bytes')),
    ).rejects.toMatchObject({
      status: 422,
      response: {
        error_code: ErrorCode.ATTENDANCE_HOLIDAY_BULK_INVALID,
      },
    });
    expect(
      txStatements.filter((s) => s.sql.includes('insert into public.holidays')),
    ).toEqual([]);
  });

  it('the 422 body is an HttpException the console can read row errors from', async () => {
    const file = await sheetBuffer([['nope', 'Broken', null, null]]);
    const { service } = build({ offices: OFFICES });
    const error = await service.bulkCreateHolidays(OWNER, file).catch((e) => e);
    expect(error).toBeInstanceOf(HttpException);
  });
});
