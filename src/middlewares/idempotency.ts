import type { NextFunction, Request, Response } from 'express';
import { redis } from '../config/redis.js';

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60; // 24 hours

interface CachedResponse {
  status: number;
  body: unknown;
}

/**
 * Caches successful JSON responses by Idempotency-Key in Upstash Redis
 * under key `idem:${userId}:${key}` for 24 hours.
 */
export function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const rawKey = req.header('Idempotency-Key')?.trim();
  if (!rawKey) {
    next();
    return;
  }

  // Skip idempotency cache for SSE streaming requests
  if (req.headers.accept?.includes('text/event-stream')) {
    next();
    return;
  }

  const userId = req.user?.id ?? 'anon';
  const cacheKey = `idem:${userId}:${rawKey}`;

  void (async () => {
    try {
      const cached = await redis.get<CachedResponse>(cacheKey);
      if (cached && typeof cached === 'object' && 'status' in cached && 'body' in cached) {
        res.setHeader('X-Idempotency-Replayed', 'true');
        res.status(cached.status).json(cached.body);
        return;
      }
    } catch {
      // Fail open if Redis is temporarily unavailable
    }

    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        void redis
          .set(cacheKey, { status: res.statusCode, body } satisfies CachedResponse, {
            ex: IDEMPOTENCY_TTL_SECONDS,
          })
          .catch(() => undefined);
      }
      return originalJson(body);
    }) as Response['json'];

    next();
  })();
}
