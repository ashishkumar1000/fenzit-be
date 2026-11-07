/** Largest profile photo the backend accepts (2 MB). */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** Presigned upload link lifetime — 15 minutes. */
export const AVATAR_UPLOAD_TTL_SECONDS = 15 * 60;

/** Presigned read link lifetime — 1 hour. The app re-reads the profile for a fresh one. */
export const AVATAR_READ_TTL_SECONDS = 60 * 60;

/** Allowed photo types, and the file extension each one is stored under. */
export const AVATAR_MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
} as const;

export type AvatarMimeType = keyof typeof AVATAR_MIME_TO_EXT;
