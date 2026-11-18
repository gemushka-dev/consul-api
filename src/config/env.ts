import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const isTest = process.env.NODE_ENV === 'test';

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

  // AI & VoiceLab
  AI_API_KEY: z.string().default(''),
  AI_BASE_URL: z.string().url().default('https://api.deepseek.com/v1'),
  AI_MODEL: z.string().default('deepseek-chat'),
  AI_VISION_MODEL: z.string().default('gpt-4o-mini'),
  AI_DAILY_LIMIT: z.coerce.number().int().positive().default(50),
  VOICELAB_API_KEY: z.string().default(''),
  VOICELAB_BASE_URL: z.string().url().default('https://api.voicelab.uz/v1'),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return parsed.data;
}

export const env: Env = parseEnv();
