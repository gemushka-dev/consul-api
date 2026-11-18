import dotenv from 'dotenv';
import { z } from 'zod';

const isTest = process.env.NODE_ENV === 'test';
if (!isTest) {
  dotenv.config();
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['demo', 'staging', 'production']).default('demo'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),

  // Vercel Neon (PostgreSQL)
  DATABASE_URL: isTest
    ? z.string().default('pglite://memory')
    : z.string().min(1, 'DATABASE_URL is required'),
  DIRECT_URL: isTest
    ? z.string().default('pglite://memory')
    : z.string().min(1, 'DIRECT_URL is required'),

  // Vercel Upstash (Redis REST API)
  UPSTASH_REDIS_REST_URL: isTest
    ? z.string().default('memory://upstash')
    : z.string().url('UPSTASH_REDIS_REST_URL must be a valid URL'),
  UPSTASH_REDIS_REST_TOKEN: isTest
    ? z.string().default('test-redis-token')
    : z.string().min(1, 'UPSTASH_REDIS_REST_TOKEN is required'),

  // Auth & Demo
  JWT_ACCESS_SECRET: isTest
    ? z.string().min(16).default('test-jwt-access-secret-key-min-32-chars')
    : z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
  JWT_REFRESH_SECRET: isTest
    ? z.string().min(16).default('test-jwt-refresh-secret-key-min-32-chars')
    : z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
  DEMO_OTP: z.string().regex(/^\d{6}$/, 'DEMO_OTP must be 6 digits').default('123456'),

  // AI (Kimi K3 / Moonshot OpenAI-compatible) & VoiceLab
  AI_API_KEY: z.string().default(''),
  MOONSHOT_API_KEY: z.string().default(''),
  AI_BASE_URL: z.string().url().default('https://api.moonshot.ai/v1'),
  AI_MODEL: z.string().default('kimi-k3'),
  AI_VISION_MODEL: z.string().default('kimi-k3'),
  AI_THINKING: z.enum(['disabled', 'enabled', 'auto']).default('disabled'),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(8000),
  AI_DAILY_LIMIT: z.coerce.number().int().positive().default(50),
  VOICELAB_API_KEY: z.string().default(''),
  VOICELAB_BASE_URL: z.string().url().default('https://api.voicelab.uz/v1'),
});

export type Env = z.infer<typeof envSchema>;

function normalizeVercelEnv(raw: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const databaseUrl = raw.DATABASE_URL || raw.POSTGRES_URL;
  const directUrl =
    raw.DIRECT_URL ||
    raw.DATABASE_URL_UNPOOLED ||
    raw.POSTGRES_URL_NON_POOLING ||
    databaseUrl;
  const upstashUrl = raw.UPSTASH_REDIS_REST_URL || raw.KV_REST_API_URL;
  const upstashToken = raw.UPSTASH_REDIS_REST_TOKEN || raw.KV_REST_API_TOKEN;
  const frontendUrl =
    raw.FRONTEND_URL ||
    (raw.VERCEL_URL ? `https://${raw.VERCEL_URL}` : undefined);

  return {
    ...raw,
    ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
    ...(directUrl ? { DIRECT_URL: directUrl } : {}),
    ...(upstashUrl ? { UPSTASH_REDIS_REST_URL: upstashUrl } : {}),
    ...(upstashToken ? { UPSTASH_REDIS_REST_TOKEN: upstashToken } : {}),
    ...(frontendUrl ? { FRONTEND_URL: frontendUrl } : {}),
  };
}

function parseEnv(): Env {
  const parsed = envSchema.safeParse(normalizeVercelEnv(process.env));
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  const data = parsed.data;
  if (!data.AI_API_KEY && data.MOONSHOT_API_KEY) {
    data.AI_API_KEY = data.MOONSHOT_API_KEY;
  }
  return data;
}

export const env: Env = parseEnv();
