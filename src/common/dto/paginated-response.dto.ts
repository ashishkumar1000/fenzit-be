export class PaginatedResponse<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;

  constructor(data: T[], nextCursor: string | null) {
    this.data = data;
    this.nextCursor = nextCursor;
    this.hasMore = nextCursor !== null;
  }
}
