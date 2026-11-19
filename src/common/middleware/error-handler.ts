import type { ErrorRequestHandler, RequestHandler } from 'express';
import multer from 'multer';
import { AppError } from '../errors/app-error.js';
import { isProduction } from '../../config/env.js';

export const notFoundHandler: RequestHandler = (req) => {
  throw new AppError(404, `Route not found: ${req.method} ${req.originalUrl}`, 'NOT_FOUND');
};

interface MysqlError {
  code?: string;
  errno?: number;
  sqlMessage?: string;
}

function mysqlCause(err: unknown): MysqlError | undefined {
  const e = err as { cause?: MysqlError } & MysqlError;
  if (e?.code?.startsWith('ER_')) return e;
  if (e?.cause?.code?.startsWith('ER_')) return e.cause;
  return undefined;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
    return;
  }

  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : err.message;
    res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    return;
  }

  // Malformed JSON body from express.json()
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Malformed JSON body' } });
    return;
  }

  const sqlErr = mysqlCause(err);
  if (sqlErr?.code === 'ER_DUP_ENTRY') {
    res
      .status(409)
      .json({ error: { code: 'CONFLICT', message: 'A record with these details already exists' } });
    return;
  }
  if (sqlErr?.code === 'ER_NO_REFERENCED_ROW_2' || sqlErr?.code === 'ER_NO_REFERENCED_ROW') {
    res
      .status(422)
      .json({ error: { code: 'UNPROCESSABLE', message: 'A referenced record does not exist' } });
    return;
  }

  req.log.error({ err }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: isProduction ? 'Internal server error' : String((err as Error)?.message ?? err),
    },
  });
};
