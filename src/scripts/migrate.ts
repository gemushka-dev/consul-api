import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDirectSqlClient } from '../config/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(__dirname, '../../drizzle');

export function loadMigrationSql(): string[] {
  const files = fs
    .readdirSync(drizzleDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return files.map((f) => fs.readFileSync(path.join(drizzleDir, f), 'utf-8'));
}

async function main() {
  const client = createDirectSqlClient();
  const sqlFiles = loadMigrationSql();

  for (const script of sqlFiles) {
    const statements = script
      .split(/;\s*(?:\r?\n|$)/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('--'));

    for (const stmt of statements) {
      await client.query(stmt);
    }
  }

  console.log(`[migrate] applied ${sqlFiles.length} SQL migration file(s) via DIRECT_URL`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[migrate] failed:', err);
    process.exit(1);
  });
}
