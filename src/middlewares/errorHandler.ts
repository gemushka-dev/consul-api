import type { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors.js';

export interface ErrorPayload {
  error: {
    code: string;
    field?: string;
    message: string;
  };
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    const payload: ErrorPayload = {
      error: {
        code: err.code,
        ...(err.field ? { field: err.field } : {}),
        message: err.message,
      },
    };
    res.status(err.statusCode).json(payload);
    return;
  }

  if (err instanceof ZodError) {
    const first = err.issues[0];
    const field = first?.path?.join('.') || undefined;
    const code = field ? `invalid_${field.replace(/\./g, '_')}` : 'validation_error';
    res.status(400).json({
      error: {
        code,
        ...(field ? { field } : {}),
        message: first?.message ?? 'Invalid request payload',
      },
    } satisfies ErrorPayload);
    return;
  }

  if (err instanceof MulterError) {
    const code = err.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : 'upload_error';
    res.status(400).json({
      error: {
        code,
        field: err.field,
        message: err.message,
      },
    } satisfies ErrorPayload);
    return;
  }

  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({
      error: {
        code: 'invalid_json',
        message: 'Malformed JSON body',
      },
    } satisfies ErrorPayload);
    return;
  }

  const message =
    err instanceof Error && process.env.NODE_ENV !== 'production'
      ? err.message
      : 'Internal server error';

  if (process.env.NODE_ENV !== 'test') {
    console.error('[errorHandler]', err);
  }

  res.status(500).json({
    error: {
      code: 'internal_error',
      message,
    },
  } satisfies ErrorPayload);
}
