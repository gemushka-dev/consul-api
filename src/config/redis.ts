import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { env } from './env.js';

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
}

export interface CacheClient {
  get<T = string>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { ex?: number }): Promise<void>;
  del(key: string): Promise<void>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
  ping(): Promise<string>;
  limitOtp(identifier: string): Promise<RateLimitResult>;
  clearForTests?(): void;
}

class MemoryCacheClient implements CacheClient {
  private store = new Map<string, { value: string; expiresAt?: number }>();
  private rateHits = new Map<string, number[]>();

  private isExpired(entry?: { value: string; expiresAt?: number }): boolean {
    return Boolean(entry?.expiresAt && Date.now() >= entry.expiresAt);
  }

  async get<T = string>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry || this.isExpired(entry)) {
      this.store.delete(key);
      return null;
    }
    try {
      return JSON.parse(entry.value) as T;
    } catch {
      return entry.value as unknown as T;
    }
  }

  async set(key: string, value: unknown, opts?: { ex?: number }): Promise<void> {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    const expiresAt = opts?.ex ? Date.now() + opts.ex * 1000 : undefined;
    this.store.set(key, { value: serialized, expiresAt });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async incr(key: string): Promise<number> {
    const existing = this.store.get(key);
    const current = existing && !this.isExpired(existing) ? Number(existing.value) || 0 : 0;
    const next = current + 1;
    this.store.set(key, { value: String(next), expiresAt: existing?.expiresAt });
    return next;
  }

  async expire(key: string, seconds: number): Promise<void> {
    const existing = this.store.get(key);
    if (existing) {
      existing.expiresAt = Date.now() + seconds * 1000;
    }
  }

  async ping(): Promise<string> {
    return 'PONG';
  }

  async limitOtp(identifier: string): Promise<RateLimitResult> {
    const windowMs = 10 * 60 * 1000; // 10 minutes
    const limit = 3;
    const now = Date.now();
    const hits = (this.rateHits.get(identifier) ?? []).filter((ts) => now - ts < windowMs);
    if (hits.length >= limit) {
      this.rateHits.set(identifier, hits);
      return {
        success: false,
        limit,
        remaining: 0,
        reset: (hits[0] ?? now) + windowMs,
      };
    }
    hits.push(now);
    this.rateHits.set(identifier, hits);
    return {
      success: true,
      limit,
      remaining: limit - hits.length,
      reset: now + windowMs,
    };
  }

  clearForTests(): void {
    this.store.clear();
    this.rateHits.clear();
  }
}

class UpstashCacheClient implements CacheClient {
  private readonly client: Redis;
  private readonly otpLimiter: Ratelimit;

  constructor(url: string, token: string) {
    this.client = new Redis({ url, token });
    this.otpLimiter = new Ratelimit({
      redis: this.client,
      limiter: Ratelimit.slidingWindow(3, '10 m'),
      prefix: 'rl:otp',
      analytics: false,
    });
  }

  async get<T = string>(key: string): Promise<T | null> {
    const val = await this.client.get<T>(key);
    return val ?? null;
  }

  async set(key: string, value: unknown, opts?: { ex?: number }): Promise<void> {
    if (opts?.ex) {
      await this.client.set(key, value, { ex: opts.ex });
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.client.expire(key, seconds);
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }

  async limitOtp(identifier: string): Promise<RateLimitResult> {
    const res = await this.otpLimiter.limit(identifier);
    return {
      success: res.success,
      limit: res.limit,
      remaining: res.remaining,
      reset: res.reset,
    };
  }
}

export const redis: CacheClient =
  env.UPSTASH_REDIS_REST_URL === 'memory://upstash'
    ? new MemoryCacheClient()
    : new UpstashCacheClient(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);

export async function checkRedisReady(): Promise<boolean> {
  try {
    const res = await redis.ping();
    return res === 'PONG';
  } catch {
    return false;
  }
}
