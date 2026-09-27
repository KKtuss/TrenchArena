import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { Client, type ClientConfig } from 'pg';

/** `pg` Client or PoolClient — both expose `query`. */
export type PgQueryClient = Pick<Client, 'query'>;

const MIGRATION_FILE = /^(\d{3})_[a-z0-9_]+\.sql$/;
const MIGRATE_LOCK = 0x504F4B45;

export const SCHEMA_MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
`;

export interface MigrationFile {
  id: string;
  fileName: string;
  filePath: string;
  checksum: string;
  sql: string;
}

export function resolveMigrationsDir(fromDir = __dirname): string {
  const candidates = [
    path.resolve(fromDir, '..', '..', 'migrations'),
    path.resolve(fromDir, '..', 'migrations'),
  ];
  for (const candidate of candidates) {
    try {
      readdirSync(candidate);
      return candidate;
    } catch {
      // Try the next layout (src vs dist).
    }
  }
  throw new Error('Could not find packages/db/migrations.');
}

export function checksumBuffer(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

export function listMigrationFiles(migrationsDir = resolveMigrationsDir()): MigrationFile[] {
  const names = readdirSync(migrationsDir)
    .filter(name => MIGRATION_FILE.test(name))
    .sort();
  if (names.length === 0) throw new Error(`No migration files in ${migrationsDir}.`);
  const seen = new Set<string>();
  return names.map(fileName => {
    const id = fileName.slice(0, 3);
    if (seen.has(id)) throw new Error(`Duplicate migration id ${id}.`);
    seen.add(id);
    const filePath = path.join(migrationsDir, fileName);
    const sql = readFileSync(filePath, 'utf8');
    return { id: fileName, fileName, filePath, checksum: checksumBuffer(sql), sql };
  });
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === "'") {
      if (inString && sql[index + 1] === "'") {
        current += "''";
        index += 1;
        continue;
      }
      inString = !inString;
    }
    if (character === ';' && !inString) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      continue;
    }
    current += character;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements.filter(statement => (
    statement
      .split('\n')
      .map(line => line.trim())
      .some(line => line.length > 0 && !line.startsWith('--'))
  ));
}

export function databaseConfig(): ClientConfig {
  const url = process.env.POKEARENA_DATABASE_URL ?? process.env.DATABASE_URL;
  if (url) return { connectionString: url };
  return {
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'pokearena',
    password: process.env.PGPASSWORD ?? '',
    database: process.env.PGDATABASE ?? 'pokearena',
  };
}

async function execSql(client: PgQueryClient, sql: string): Promise<void> {
  for (const statement of splitSqlStatements(sql)) {
    await client.query(statement);
  }
}

export async function migrate(client: PgQueryClient, migrationsDir = resolveMigrationsDir()): Promise<string[]> {
  const files = listMigrationFiles(migrationsDir);
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATE_LOCK]);
  try {
    await client.query('BEGIN');
    try {
      await client.query(SCHEMA_MIGRATIONS_SQL);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    const applied: string[] = [];
    for (const file of files) {
      await client.query('BEGIN');
      try {
        const existing = await client.query<{ id: string; checksum: string }>(
          'SELECT id, checksum FROM schema_migrations WHERE id = $1',
          [file.id],
        );
        if (existing.rowCount) {
          const row = existing.rows[0];
          if (row.checksum !== file.checksum) {
            throw new Error(
              `Migration ${file.id} was already applied with a different checksum.`,
            );
          }
          await client.query('COMMIT');
          continue;
        }
        await execSql(client, file.sql);
        await client.query(
          'INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)',
          [file.id, file.checksum],
        );
        await client.query('COMMIT');
        applied.push(file.id);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATE_LOCK]);
  }
}

export async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(databaseConfig());
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const applied = await withClient(client => migrate(client));
  if (applied.length === 0) {
    console.log('PokeArena migrations: already up to date.');
    return;
  }
  console.log(`PokeArena migrations applied: ${applied.join(', ')}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
