import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

// Postgres INT max — the attachments.size_bytes column is INT. Bounding here
// keeps a forged/oversized R2 event from overflowing the column into an opaque
// 500 (which the Worker would then retry forever). Mirrors the client confirm
// path's MAX_ATTACHMENT_SIZE_BYTES guard. @Min(1) rejects 0-byte (failed) PUTs.
const PG_INT_MAX = 2147483647;

export class StorageEventDto {
  @IsString()
  @IsNotEmpty()
  key: string;

  @IsInt()
  @Min(1)
  @Max(PG_INT_MAX)
  size: number;

  @IsUUID()
  tenantId: string;

  @IsUUID()
  jobId: string;

  @IsIn(['photo', 'signature'])
  attachmentType: string;
}
