import multer from 'multer';
import { env } from '../../config/env.js';
import { AppError } from '../errors/app-error.js';

/** PDF, images, Word and Excel (FR-DOC-01). */
export const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export const MAX_FILES_PER_UPLOAD = 10;

/** Multipart parser kept in memory; files are streamed to storage by the documents service. */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: MAX_FILES_PER_UPLOAD },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) cb(null, true);
    else cb(AppError.badRequest(`File type not allowed: ${file.mimetype}`));
  },
});
