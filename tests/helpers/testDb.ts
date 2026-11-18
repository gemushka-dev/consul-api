import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { setDbInstance } from '../../src/config/db.js';
import { redis } from '../../src/config/redis.js';
import * as schema from '../../src/db/schema.js';
import { loadMigrationSql } from '../../src/scripts/migrate.js';

let pgliteClient: PGlite | null = null;

/**
 * Boots a fresh in-memory PostgreSQL (PGlite) database, applies all SQL migrations
 * from drizzle/, and wires it into Drizzle via setDbInstance().
 */
export async function setupTestDb(): Promise<PGlite> {
  if (pgliteClient) {
    await pgliteClient.close();
  }
  pgliteClient = new PGlite();
  const sqlScripts = loadMigrationSql();
  for (const script of sqlScripts) {
    await pgliteClient.exec(script);
  }
  const db = drizzle(pgliteClient, { schema });
  setDbInstance(db, async (q: string) => {
    await pgliteClient!.exec(q);
  });
  redis.clearForTests?.();
  return pgliteClient;
}

export async function teardownTestDb(): Promise<void> {
  if (pgliteClient) {
    await pgliteClient.close();
    pgliteClient = null;
  }
}
