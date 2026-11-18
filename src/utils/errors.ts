export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly field?: string;

  constructor(statusCode: number, code: string, message: string, field?: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.field = field;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export const Errors = {
  badRequest: (code: string, message: string, field?: string) =>
    new AppError(400, code, message, field),
  unauthorized: (code = 'unauthorized', message = 'Authentication required') =>
    new AppError(401, code, message),
  forbidden: (code = 'forbidden', message = 'Access denied') =>
    new AppError(403, code, message),
  notFound: (code = 'not_found', message = 'Resource not found') =>
    new AppError(404, code, message),
  conflict: (code = 'conflict', message = 'Resource conflict', field?: string) =>
    new AppError(409, code, message, field),
  tooManyRequests: (code = 'rate_limited', message = 'Too many requests') =>
    new AppError(429, code, message),
  serviceUnavailable: (code = 'service_unavailable', message = 'Service temporarily unavailable') =>
    new AppError(503, code, message),
};
