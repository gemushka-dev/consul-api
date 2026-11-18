import dotenv from 'dotenv';
import { z } from 'zod';

const isTest = process.env.NODE_ENV === 'test';
const isVercel = Boolean(process.env.VERCEL);

if (!isTest) {
  dotenv.config();
}

function clean(val: string | undefined): string | undefined {
  if (val === undefined) return undefined;
  const trimmed = val.trim().replace(/^["']|["']$/g, '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function ensureUrl(val: string | undefined): string | undefined {
  const c = clean(val);
  if (!c) return undefined;
  if (/^https?:\/\//i.test(c) || c.startsWith('memory://')) return c;
  return `https://${c}`;
}

function normalizeVercelEnv(raw: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const databaseUrl =
    clean(raw.DATABASE_URL) ||
    clean(raw.POSTGRES_URL) ||
    clean(raw.POSTGRES_PRISMA_URL) ||
    clean(raw.POSTGRES_URL_NON_POOLING);

  const directUrl =
    clean(raw.DIRECT_URL) ||
    clean(raw.DATABASE_URL_UNPOOLED) ||
    clean(raw.POSTGRES_URL_NON_POOLING) ||
    databaseUrl;

  const upstashUrl =
    ensureUrl(raw.UPSTASH_REDIS_REST_URL) ||
    ensureUrl(raw.KV_REST_API_URL);

  const upstashToken =
    clean(raw.UPSTASH_REDIS_REST_TOKEN) ||
    clean(raw.KV_REST_API_TOKEN);

  const frontendUrl =
    ensureUrl(raw.FRONTEND_URL) ||
    (clean(raw.VERCEL_URL) ? `https://${clean(raw.VERCEL_URL)}` : undefined);

  const aiApiKey = clean(raw.AI_API_KEY) || clean(raw.MOONSHOT_API_KEY);

  return {
    NODE_ENV: clean(raw.NODE_ENV),
    APP_ENV: clean(raw.APP_ENV),
    PORT: clean(raw.PORT),
    FRONTEND_URL: frontendUrl,
    DATABASE_URL: databaseUrl,
    DIRECT_URL: directUrl,
    UPSTASH_REDIS_REST_URL: upstashUrl,
    UPSTASH_REDIS_REST_TOKEN: upstashToken,
    JWT_ACCESS_SECRET: clean(raw.JWT_ACCESS_SECRET),
    JWT_REFRESH_SECRET: clean(raw.JWT_REFRESH_SECRET),
    DEMO_OTP: clean(raw.DEMO_OTP),
    AI_API_KEY: aiApiKey,
    MOONSHOT_API_KEY: clean(raw.MOONSHOT_API_KEY),
    AI_BASE_URL: ensureUrl(raw.AI_BASE_URL),
    AI_MODEL: clean(raw.AI_MODEL),
    AI_VISION_MODEL: clean(raw.AI_VISION_MODEL),
    AI_THINKING: clean(raw.AI_THINKING),
    AI_TIMEOUT_MS: clean(raw.AI_TIMEOUT_MS),
    AI_DAILY_LIMIT: clean(raw.AI_DAILY_LIMIT),
    ELEVENLABS_API_KEY: clean(raw.ELEVENLABS_API_KEY) || clean(raw.XI_API_KEY),
    ELEVENLABS_BASE_URL: ensureUrl(raw.ELEVENLABS_BASE_URL),
    ELEVENLABS_VOICE_ID: clean(raw.ELEVENLABS_VOICE_ID),
    ELEVENLABS_TTS_MODEL: clean(raw.ELEVENLABS_TTS_MODEL),
    ELEVENLABS_STT_MODEL: clean(raw.ELEVENLABS_STT_MODEL),
  };
}

const relaxed = isTest || isVercel;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['demo', 'staging', 'production']).default('demo'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),

  // Vercel Neon (PostgreSQL)
  DATABASE_URL: relaxed
    ? z.string().default(isTest ? 'pglite://memory' : '')
    : z.string().min(1, 'DATABASE_URL is required'),
  DIRECT_URL: relaxed
    ? z.string().default(isTest ? 'pglite://memory' : '')
    : z.string().min(1, 'DIRECT_URL is required'),

  // Vercel Upstash (Redis REST API)
  UPSTASH_REDIS_REST_URL: relaxed
    ? z.string().default(isTest ? 'memory://upstash' : '')
    : z.string().url('UPSTASH_REDIS_REST_URL must be a valid URL'),
  UPSTASH_REDIS_REST_TOKEN: relaxed
    ? z.string().default(isTest ? 'test-redis-token' : '')
    : z.string().min(1, 'UPSTASH_REDIS_REST_TOKEN is required'),

  // Auth & Demo
  JWT_ACCESS_SECRET: isTest
    ? z.string().min(16).default('test-jwt-access-secret-key-min-32-chars')
    : isVercel
      ? z.string().default('')
      : z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
  JWT_REFRESH_SECRET: isTest
    ? z.string().min(16).default('test-jwt-refresh-secret-key-min-32-chars')
    : isVercel
      ? z.string().default('')
      : z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
  DEMO_OTP: z.string().regex(/^\d{6}$/, 'DEMO_OTP must be 6 digits').default('123456'),

  // AI (Kimi K3 / Moonshot OpenAI-compatible) & ElevenLabs (STT/TTS)
  AI_API_KEY: z.string().default(''),
  MOONSHOT_API_KEY: z.string().default(''),
  AI_BASE_URL: z.string().url().default('https://api.moonshot.ai/v1'),
  AI_MODEL: z.string().default('kimi-k3'),
  AI_VISION_MODEL: z.string().default('kimi-k3'),
  AI_THINKING: z.enum(['disabled', 'enabled', 'auto']).default('enabled'),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(20000),
  AI_DAILY_LIMIT: z.coerce.number().int().positive().default(50),
  ELEVENLABS_API_KEY: z.string().default(''),
  ELEVENLABS_BASE_URL: z.string().url().default('https://api.elevenlabs.io/v1'),
  ELEVENLABS_VOICE_ID: z.string().default('EXAVITQu4vr4xnSDxMaL'),
  ELEVENLABS_TTS_MODEL: z.string().default('eleven_flash_v2_5'),
  ELEVENLABS_STT_MODEL: z.string().default('scribe_v1'),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const parsed = envSchema.safeParse(normalizeVercelEnv(process.env));
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return parsed.data;
}

export const env: Env = parseEnv();

export function getMissingRuntimeEnv(): string[] {
  if (env.NODE_ENV === 'test') return [];
  const missing: string[] = [];
  if (!env.DATABASE_URL) missing.push('DATABASE_URL');
  if (!env.UPSTASH_REDIS_REST_URL) missing.push('UPSTASH_REDIS_REST_URL');
  if (!env.UPSTASH_REDIS_REST_TOKEN) missing.push('UPSTASH_REDIS_REST_TOKEN');
  if (env.JWT_ACCESS_SECRET.length < 16) missing.push('JWT_ACCESS_SECRET (min 16 chars)');
  if (env.JWT_REFRESH_SECRET.length < 16) missing.push('JWT_REFRESH_SECRET (min 16 chars)');
  return missing;
}
