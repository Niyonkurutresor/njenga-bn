export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'ACCOUNT_LOCKED'
  | 'TOO_MANY_REQUESTS'
  | 'INTERNAL';

/** Expected, client-facing error. Anything else is treated as a 500. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: ErrorCode,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message = 'Bad request', details?: unknown) {
    return new AppError(400, message, 'BAD_REQUEST', details);
  }
  static validation(details: unknown, message = 'Validation failed') {
    return new AppError(400, message, 'VALIDATION_FAILED', details);
  }
  static unauthorized(message = 'Authentication required') {
    return new AppError(401, message, 'UNAUTHENTICATED');
  }
  static forbidden(message = 'You do not have permission to perform this action') {
    return new AppError(403, message, 'FORBIDDEN');
  }
  static notFound(entity = 'Resource') {
    return new AppError(404, `${entity} not found`, 'NOT_FOUND');
  }
  static conflict(message: string, details?: unknown) {
    return new AppError(409, message, 'CONFLICT', details);
  }
  /** A business rule was violated (e.g. paying an unapproved request). */
  static rule(message: string, details?: unknown) {
    return new AppError(422, message, 'UNPROCESSABLE', details);
  }
  static locked(message: string) {
    return new AppError(423, message, 'ACCOUNT_LOCKED');
  }
}
