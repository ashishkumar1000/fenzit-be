import ExcelJS from 'exceljs';
import {
  HOLIDAY_DESCRIPTION_MAX,
  HOLIDAY_NAME_MAX,
} from './dto/holiday.dto';

/**
 * The bulk-holiday sheet (console redesign 2026-11-26): the BE generates the
 * .xlsx template (so the format and the parser can never drift apart) and
 * parses the filled sheet back into rows. Sheet 1 "Holidays" carries the
 * data — PRE-FILLED with the holidays already on the tenant's calendar, so
 * the user adds new rows below them and the upload skips the pre-filled
 * ones; sheet 2 "Reference" lists the tenant's REAL office names so the
 * Offices column can be copied verbatim. One row per holiday.
 */

export const HOLIDAY_TEMPLATE_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const HOLIDAY_TEMPLATE_FILENAME = 'fenzit-holidays-template.xlsx';

/** Rows the parser accepts, before any DB-side resolution. */
export interface HolidayBulkRow {
  /** 1-based sheet row (row 1 = the header) — the number error messages name. */
  row: number;
  date: string;
  name: string;
  description: string | null;
  /** The Offices cell, trimmed — null/blank means every office. */
  officesRaw: string | null;
}

/** One problem row, shaped for the console's error table. */
export interface HolidayBulkRowError {
  row: number;
  date: string | null;
  name: string | null;
  message: string;
}

export class HolidayBulkParseError extends Error {
  constructor(readonly errors: HolidayBulkRowError[]) {
    super(`The sheet has ${errors.length} problem${errors.length === 1 ? '' : 's'}`);
    this.name = 'HolidayBulkParseError';
  }
}

/** Hard ceiling — a year is ~20 rows; 500 is generous headroom. */
const MAX_BULK_ROWS = 500;

const DATA_SHEET = 'Holidays';
const REFERENCE_SHEET = 'Reference';

/** One holiday already on the calendar, pre-filled into the template. */
export interface HolidayTemplateRow {
  date: string;
  name: string;
  description: string | null;
  /** Resolved office names — empty for an every-office holiday. */
  officeNames: string[];
}

/**
 * GET /attendance/holidays/bulk-template — the download. The Date column is
 * text-formatted ('@') so Excel keeps "2026-08-15" as typed instead of
 * converting it behind the user's back; date-typed cells are still accepted
 * by the parser (Excel converts on paste regardless). Existing holidays are
 * pre-filled rows 2..N: untouched rows are skipped on upload, an edited row
 * (name, description, or offices) UPDATES that holiday — the sheet is the
 * edit surface. F1 carries the generated-on stamp: the console reads it and
 * warns when an old sheet may no longer match the calendar.
 */
export async function buildHolidayTemplate(
  officeNames: string[],
  existing: HolidayTemplateRow[],
  generatedOn: string,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Fenzit';
  const sheet = workbook.addWorksheet(DATA_SHEET);
  const reference = workbook.addWorksheet(REFERENCE_SHEET);

  sheet.columns = [
    { width: 14 },
    { width: 34 },
    { width: 42 },
    { width: 38 },
  ];
  const header = sheet.getRow(1);
  header.values = ['Date', 'Holiday Name', 'Description (optional)', 'Offices (optional)'];
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.height = 22;
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2148DD' } };
    cell.alignment = { vertical: 'middle' };
  });
  sheet.getCell('A1').note =
    'One row per holiday. Type the date as 2026-08-15, or let Excel format the cell as a date. Keep both sheet names unchanged.';
  sheet.getCell('D1').note =
    'Leave blank (or write "all") for every office. For specific offices, copy the names from the Reference sheet, comma-separated.';
  // The freshness stamp, parked out of the data columns: quiet to the user,
  // machine-readable to the console's pre-validation.
  const stamp = sheet.getCell('F1');
  stamp.value = `Generated on ${generatedOn}`;
  stamp.font = { color: { argb: 'FF8A8F98' }, size: 9 };
  for (const holiday of existing) {
    sheet.addRow([
      holiday.date,
      holiday.name,
      holiday.description,
      holiday.officeNames.length > 0 ? holiday.officeNames.join(', ') : null,
    ]);
  }
  // AFTER the pre-fill: getCell() materializes rows, and addRow appends past
  // them — formatting first would push the data rows down the sheet.
  const lastFmtRow = Math.max(100, existing.length + 1);
  for (let r = 2; r <= lastFmtRow; r += 1) {
    sheet.getCell(`A${r}`).numFmt = '@';
    // Excel-side guardrails: the ceilings the browser and the backend also
    // check, surfaced as a gentle warning the moment the text goes over —
    // warning (not stop) so a deliberate longer value can still be kept.
    sheet.getCell(`B${r}`).dataValidation = {
      type: 'textLength',
      operator: 'lessThanOrEqual',
      formulae: [String(HOLIDAY_NAME_MAX)],
      showErrorMessage: true,
      errorStyle: 'warning',
      errorTitle: 'Long holiday name',
      error: `Names this long get hard to read on the calendar (limit ${HOLIDAY_NAME_MAX}). Keep it anyway?`,
    };
    sheet.getCell(`C${r}`).dataValidation = {
      type: 'textLength',
      operator: 'lessThanOrEqual',
      formulae: [String(HOLIDAY_DESCRIPTION_MAX)],
      showErrorMessage: true,
      errorStyle: 'warning',
      errorTitle: 'Long description',
      error: `Descriptions this long get cut off on the calendar (limit ${HOLIDAY_DESCRIPTION_MAX}). Keep it anyway?`,
    };
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const firstEmptyRow = existing.length + 2;
  sheet.getCell(`A${firstEmptyRow}`).note =
    'New holidays go below the pre-filled rows. Editing a pre-filled row updates that holiday on upload; leaving it as it is changes nothing.';

  const refTitle = reference.getCell('A1');
  refTitle.value =
    'Your offices — copy the exact name into the Holidays sheet when a holiday closes only some offices:';
  refTitle.font = { bold: true };
  officeNames.forEach((name, index) => {
    reference.getCell(`A${index + 3}`).value = name;
  });
  const rulesRow = officeNames.length + 5;
  reference.getCell(`A${rulesRow}`).value =
    'Rules: Dates as 2026-08-15. Holiday Name required (up to 80 letters). Description optional (up to 280). Leave Offices blank for every office.';
  reference.getCell(`A${rulesRow + 1}`).value =
    'Pre-filled rows are your calendar: leave them as they are and the upload skips them; change a name, description, or offices and that holiday is updated. Add new holidays below. Every row is checked first: if any row is wrong, nothing changes and you get the exact rows back to fix.';

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer as ArrayBuffer);
}

/**
 * Reads the filled sheet into rows, collecting every shape-level problem
 * (date format, missing name, ceilings) so the owner fixes them all in one
 * round. DB-side checks (office names, taken dates) live in the service —
 * they need the tenant's data.
 */
export async function parseHolidayWorkbook(
  file: Buffer,
): Promise<HolidayBulkRow[]> {
  let workbook: ExcelJS.Workbook;
  try {
    workbook = new ExcelJS.Workbook();
    // exceljs's own .d.ts pins an older global Buffer shape than the repo's
    // @types/node — the cast names exceljs's contract, not a weakening.
    await workbook.xlsx.load(file as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new HolidayBulkParseError([
      {
        row: 0,
        date: null,
        name: null,
        message: 'This file could not be read as an Excel (.xlsx) sheet. Download the template and fill it.',
      },
    ]);
  }

  const sheet =
    workbook.getWorksheet(DATA_SHEET) ?? workbook.worksheets[0] ?? null;
  if (sheet === null) {
    throw new HolidayBulkParseError([
      {
        row: 0,
        date: null,
        name: null,
        message: 'The sheet is empty. Download the template and fill it in.',
      },
    ]);
  }

  const rows: HolidayBulkRow[] = [];
  const errors: HolidayBulkRowError[] = [];
  const seenDates = new Map<string, number>();
  let capReported = false;

  sheet.eachRow((sheetRow, rowNumber) => {
    const dateCell = sheetRow.getCell(1).value;
    const nameCell = sheetRow.getCell(2).value;
    const descriptionCell = sheetRow.getCell(3).value;
    const officesCell = sheetRow.getCell(4).value;

    if (rowNumber === 1) {
      // The template always writes `Date` in A1 — only then is row 1 a
      // header. A sheet that already starts with data (no header) keeps
      // that first holiday instead of silently eating it.
      const firstCell = cellText(dateCell);
      if (firstCell !== null && firstCell.trim().toLowerCase() === 'date') {
        return;
      }
    }

    const name = cellText(nameCell);
    const description = cellText(descriptionCell);
    const officesRaw = cellText(officesCell);
    const whollyEmpty = dateCell === null && name === null && officesRaw === null;
    if (whollyEmpty) return; // a blank filler row is not a problem

    // The error table names the row by its sheet position.
    const problem = (message: string): HolidayBulkRowError => ({
      row: rowNumber,
      date: typeof dateCell === 'object' && dateCell instanceof Date ? dateCellToIso(dateCell) : null,
      name,
      message,
    });

    if (rows.length >= MAX_BULK_ROWS) {
      // One cap error for the sheet, not one per row past the cap — a
      // 10k-row sheet would otherwise return ten thousand messages.
      if (!capReported) {
        errors.push(problem(`The sheet holds more than ${MAX_BULK_ROWS} holidays — upload the rest in a second sheet.`));
        capReported = true;
      }
      return;
    }

    const date = readDateCell(dateCell);
    if (date === null) {
      errors.push(problem('Use the date as 2026-08-15 (or let Excel format the cell as a date).'));
      return;
    }
    if (name === null) {
      errors.push({ row: rowNumber, date, name: null, message: 'Give the holiday a name.' });
      return;
    }
    if (name.length > HOLIDAY_NAME_MAX) {
      errors.push({ row: rowNumber, date, name, message: `The name is over ${HOLIDAY_NAME_MAX} letters — shorten it.` });
      return;
    }
    if (description !== null && description.length > HOLIDAY_DESCRIPTION_MAX) {
      errors.push({ row: rowNumber, date, name, message: `The description is over ${HOLIDAY_DESCRIPTION_MAX} letters — shorten it.` });
      return;
    }
    const earlierRow = seenDates.get(date);
    if (earlierRow !== undefined) {
      errors.push({ row: rowNumber, date, name, message: `This date is already on row ${earlierRow} of this sheet.` });
      return;
    }

    seenDates.set(date, rowNumber);
    rows.push({ row: rowNumber, date, name, description, officesRaw });
  });

  if (errors.length > 0) throw new HolidayBulkParseError(errors);
  return rows;
}

/** Trims a cell into text; null when the cell carries nothing readable. */
function cellText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return dateCellToIso(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) {
      return joinRichText(value.richText);
    }
    if ('text' in value && value.text !== undefined && value.text !== null) {
      // hyperlink cells
      const trimmed = String(value.text).trim();
      return trimmed === '' ? null : trimmed;
    }
    if ('result' in value) {
      // formula cells — read the cached result
      return cellText((value as { result: ExcelJS.CellValue }).result);
    }
  }
  return null;
}

function joinRichText(parts: { text?: string }[]): string | null {
  const joined = parts.map((part) => part.text ?? '').join('').trim();
  return joined === '' ? null : joined;
}

/**
 * A date cell → YYYY-MM-DD, or null when it is not a real date. ExcelJS
 * surfaces date-formatted cells as JS Dates; the serial-based conversion can
 * land on UTC midnight or local midnight depending on the producer, so read
 * whichever parts the value itself declares (a zero-UTC-time reads UTC parts,
 * anything else reads local parts).
 */
function readDateCell(value: ExcelJS.CellValue): string | null {
  if (value instanceof Date) return dateCellToIso(value);
  const text = cellText(value);
  if (text === null) return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso !== null) {
    return normalizeParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }
  // D/M/YYYY — the day-first form India writes by hand. D-M and D/M/Y2 too.
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(text);
  if (dmy !== null) {
    const yearRaw = Number(dmy[3]);
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    return normalizeParts(year, Number(dmy[2]), Number(dmy[1]));
  }
  // A bare Excel date serial (a number in a date column lost its format) —
  // bounded to 1950–2099 (serials 18264–73050). Floor the DAY count first:
  // a fractional serial is time-of-day, and rounding it into the ms value
  // misses UTC midnight → dateCellToIso falls back to LOCAL parts, which a
  // non-UTC server reads as a shifted date.
  const serial = /^\d{4,6}(\.\d+)?$/.test(text) ? Number(text) : null;
  if (serial !== null && serial >= 18264 && serial <= 73050) {
    return dateCellToIso(new Date(Math.floor(serial - 25569) * 86400000));
  }
  return null;
}

function dateCellToIso(value: Date): string | null {
  const utcMidnight =
    value.getUTCHours() === 0 &&
    value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0;
  const year = utcMidnight ? value.getUTCFullYear() : value.getFullYear();
  const month = utcMidnight ? value.getUTCMonth() + 1 : value.getMonth() + 1;
  const day = utcMidnight ? value.getUTCDate() : value.getDate();
  return normalizeParts(year, month, day);
}

/** YYYY-MM-DD only when the parts name a REAL calendar date (no rollover). */
function normalizeParts(year: number, month: number, day: number): string | null {
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}
