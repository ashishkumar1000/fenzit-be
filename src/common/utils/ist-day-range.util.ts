const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30

export interface DayRange {
  start: Date;
  end: Date;
}

export function getIstDayRange(utcNow: Date = new Date()): DayRange {
  const istNow = new Date(utcNow.getTime() + IST_OFFSET_MS);

  const istMidnight = new Date(
    Date.UTC(
      istNow.getUTCFullYear(),
      istNow.getUTCMonth(),
      istNow.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );

  const start = new Date(istMidnight.getTime() - IST_OFFSET_MS);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  return { start, end };
}
