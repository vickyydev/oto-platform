/**
 * Error envelope (CLAUDE.md §3): every error response is
 * `{ error: { code, message, details? } }`.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const errors = {
  badRequest: (message: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details),
  unauthorized: (message = 'Not signed in') => new AppError(401, 'UNAUTHORIZED', message),
  forbidden: (message = 'Not allowed') => new AppError(403, 'FORBIDDEN', message),
  notFound: (message = 'Not found') => new AppError(404, 'NOT_FOUND', message),
  conflict: (code: string, message: string, details?: unknown) => new AppError(409, code, message, details),
  tooMany: (message: string) => new AppError(429, 'TOO_MANY_REQUESTS', message),
};
