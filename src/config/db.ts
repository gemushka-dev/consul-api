import { neon } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import { drizzle as drizzleNeon, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from '../db/schema.js';
import { env } from './env.js';

export type DbInstance = NeonHttpDatabase<typeof schema>;

let _db: DbInstance | null = null;
let _rawExec: ((query: string) => Promise<void>) | null = null;

function createNeonDb(): DbInstance {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured');
  }
  const client = neon(env.DATABASE_URL);
  return drizzleNeon({ client, schema });
}

/**
 * Returns the active Drizzle database instance.
 * Uses @neondatabase/serverless (pooled DATABASE_URL) in normal environments.
 */
export function getDb(): DbInstance {
  if (!_db) {
    _db = createNeonDb();
  }
  return _db;
}

/**
 * Allows test harness to inject an in-memory PGlite Drizzle instance.
 */
export function setDbInstance(
  instance: unknown,
  rawExec?: (query: string) => Promise<void>,
): void {
  _db = instance as DbInstance;
  _rawExec = rawExec ?? null;
}

export function getRawExec(): ((query: string) => Promise<void>) | null {
  return _rawExec;
}

export function createDirectSqlClient() {
  return neon(env.DIRECT_URL);
}

export async function checkDbReady(): Promise<boolean> {
  try {
    const db = getDb();
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}
