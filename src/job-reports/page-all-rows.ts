/**
 * PostgREST returns at most 1000 rows per request. A report that read one
 * request would silently undercount on a busy company, so every report read
 * walks the rows page by page until a short page says "that was all".
 *
 * `fetchPage` must order by a unique column (the id) so pages never overlap or
 * skip a row.
 */
export const REPORT_PAGE_SIZE = 1000;

export async function pageAllRows<T>(
  fetchPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize: number = REPORT_PAGE_SIZE,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) {
      throw error instanceof Error ? error : new Error('page read failed');
    }
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) return all;
  }
}
