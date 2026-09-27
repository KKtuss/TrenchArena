import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from 'pg';

import {
  checksumBuffer,
  databaseConfig,
  listMigrationFiles,
  migrate,
  resolveMigrationsDir,
  splitSqlStatements,
} from '../src/migrate';

const REQUIRED_TABLES = [
  'wallets',
  'holds',
  'settlements',
  'casual_rooms',
  'tournaments',
  'tournament_players',
  'tournament_matches',
];

test('migrations are ordered, checksummed, and encode the durability contract', () => {
  const files = listMigrationFiles(resolveMigrationsDir());
  assert.equal(files[0]?.fileName, '001_initial.sql');
  assert.equal(files[1]?.fileName, '002_tournament_holds_without_parent.sql');
  assert.equal(files[2]?.fileName, '003_restore_tournament_parent_fks.sql');
  assert.equal(files[3]?.fileName, '004_interrupted_matches.sql');
  assert.equal(files[0]?.id, '001_initial.sql');
  assert.equal(files[0]?.checksum, checksumBuffer(files[0].sql));
  const sql = files.map(file => file.sql).join('\n');
  for (const table of REQUIRED_TABLES) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.match(sql, /balance BIGINT NOT NULL CHECK \(balance >= 0\)/);
  assert.match(sql, /hold_key TEXT PRIMARY KEY/);
  assert.match(sql, /status TEXT NOT NULL CHECK \(status IN \('reserved', 'released', 'consumed'\)\)/);
  assert.match(sql, /hold_key = 'casual:' \|\| room_id::text \|\| ':creator'/);
  assert.match(sql, /hold_key = 'tournament:' \|\| tournament_id::text \|\| ':' \|\| player_id/);
  assert.match(sql, /settlement_key = 'casual:' \|\| room_id::text/);
  assert.match(sql, /settlement_key = 'tournament:' \|\| tournament_id::text/);
  assert.match(sql, /PRIMARY KEY \(tournament_id, player_id\)/);
  assert.match(sql, /UNIQUE \(tournament_id, round, bracket_position\)/);
  assert.match(sql, /host_id TEXT NOT NULL/);
  assert.match(sql, /entry_fee BIGINT NOT NULL/);
  assert.match(sql, /status = 'tied' AND winner_id IS NULL/);
  assert.match(sql, /status IN \('tied', 'interrupted'\) AND winner_id IS NULL/);
  assert.match(sql, /status <> 'interrupted' OR completed_at IS NOT NULL/);
  assert.equal(sql.includes('CREATE TABLE battle_instances'), false);
  assert.equal(sql.includes('treasury'), false);
  const statements = splitSqlStatements(sql);
  assert.equal(statements.some(statement => statement.includes('CREATE TABLE wallets')), true);
  assert.equal(statements.length > REQUIRED_TABLES.length, true);
  const initialStatements = splitSqlStatements(files[0].sql);
  assert.match(initialStatements[0] ?? '', /CREATE TABLE wallets/);
  assert.equal(/^\s*node\b/i.test(initialStatements[0] ?? ''), false);
  const commented = splitSqlStatements(
    '-- values fit BIGINT; node-pg returns BIGINT as string\nCREATE TABLE t (id TEXT);',
  );
  assert.equal(commented.length, 1);
  assert.match(commented[0] ?? '', /^-- values fit BIGINT; node-pg[\s\S]*CREATE TABLE t/);
});

async function canConnect(): Promise<false | Client> {
  const client = new Client(databaseConfig());
  try {
    await client.connect();
    return client;
  } catch {
    await client.end().catch(() => undefined);
    return false;
  }
}

async function expectReject(
  client: Client,
  work: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  await client.query('SAVEPOINT invariant_check');
  try {
    await work();
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT invariant_check');
    assert.match(String(error), pattern);
    return;
  }
  await client.query('ROLLBACK TO SAVEPOINT invariant_check');
  throw new Error('expected query to be rejected');
}

test('fresh database migrates, is idempotent, and enforces invariants', async t => {
  const client = await canConnect();
  if (!client) {
    t.skip('PostgreSQL is not reachable (set POKEARENA_DATABASE_URL). Live schema tests were not executed.');
    return;
  }

  try {
    await migrate(client);
    const again = await migrate(client);
    assert.deepEqual(again, []);

    const tracked = await client.query('SELECT id FROM schema_migrations ORDER BY id');
    assert.equal(tracked.rows[0]?.id, '001_initial.sql');
    assert.equal(
      tracked.rows.some(row => row.id === '002_tournament_holds_without_parent.sql'),
      true,
    );
    assert.equal(
      tracked.rows.some(row => row.id === '003_restore_tournament_parent_fks.sql'),
      true,
    );
    assert.equal(
      tracked.rows.some(row => row.id === '004_interrupted_matches.sql'),
      true,
    );

    const tables = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
      [REQUIRED_TABLES],
    );
    assert.equal(tables.rowCount, REQUIRED_TABLES.length);

    await client.query('BEGIN');
    await client.query(`INSERT INTO wallets (player_id, balance) VALUES ('wallet-a', 100)`);
    await expectReject(
      client,
      () => client.query(`INSERT INTO wallets (player_id, balance) VALUES ('wallet-a', 0)`),
      /duplicate key|unique/i,
    );
    await expectReject(
      client,
      () => client.query(`INSERT INTO wallets (player_id, balance) VALUES ('wallet-neg', -1)`),
      /check constraint/i,
    );

    const roomId = '11111111-1111-1111-1111-111111111111';
    await client.query(
      `INSERT INTO casual_rooms (
         id, match_id, room_type, battle_size, format, creator_id, collateral, status
       ) VALUES ($1, $2, 'open', '1v1', 'gen9ou', 'wallet-a', 1000, 'open')`,
      [roomId, `casual-${roomId}`],
    );
    await client.query(
      `INSERT INTO holds (
         hold_key, player_id, amount, purpose, status, room_id
       ) VALUES ($1, 'wallet-a', 1000, 'casual_creator', 'reserved', $2)`,
      [`casual:${roomId}:creator`, roomId],
    );
    await expectReject(
      client,
      () => client.query(
        `INSERT INTO holds (
           hold_key, player_id, amount, purpose, status, room_id
         ) VALUES ($1, 'wallet-a', 1000, 'casual_creator', 'reserved', $2)`,
        [`casual:${roomId}:creator`, roomId],
      ),
      /duplicate key|unique/i,
    );
    await expectReject(
      client,
      () => client.query(
        `INSERT INTO holds (
           hold_key, player_id, amount, purpose, status, room_id
         ) VALUES ($1, 'wallet-a', 1000, 'casual_creator', 'released', $2)`,
        [`casual:${roomId}:bogus`, roomId],
      ),
      /check constraint/i,
    );
    await expectReject(
      client,
      () => client.query(
        `UPDATE holds SET status = 'released' WHERE hold_key = $1`,
        [`casual:${roomId}:creator`],
      ),
      /check constraint/i,
    );

    await client.query(
      `INSERT INTO settlements (
         settlement_key, kind, winner_id, amount, protocol_fee, room_id
       ) VALUES ($1, 'casual-win', 'wallet-a', 1960, 40, $2)`,
      [`casual:${roomId}`, roomId],
    );
    await expectReject(
      client,
      () => client.query(
        `INSERT INTO settlements (
           settlement_key, kind, winner_id, amount, protocol_fee, room_id
         ) VALUES ($1, 'casual-win', 'wallet-a', 1960, 40, $2)`,
        [`casual:${roomId}`, roomId],
      ),
      /duplicate key|unique/i,
    );

    const tournamentId = '22222222-2222-2222-2222-222222222222';
    await client.query(`INSERT INTO wallets (player_id, balance) VALUES ('wallet-b', 0)`);
    await client.query(
      `INSERT INTO tournaments (
         id, title, format, max_players, bracket_seed, match_timeout_ms, status, host_id, entry_fee
       ) VALUES ($1, 'Cup', 'gen9ou', 4, 'default', 300000, 'registration', 'wallet-a', 50000)`,
      [tournamentId],
    );
    await client.query(
      `INSERT INTO tournament_players (
         tournament_id, player_id, display_name, team, status, registration_order
       ) VALUES ($1, 'wallet-a', 'A', 'team-a', 'registered', 0)`,
      [tournamentId],
    );
    await expectReject(
      client,
      () => client.query(
        `INSERT INTO tournament_players (
           tournament_id, player_id, display_name, team, status, registration_order
         ) VALUES ($1, 'wallet-a', 'A', 'team-a', 'registered', 1)`,
        [tournamentId],
      ),
      /duplicate key|unique/i,
    );
    await expectReject(
      client,
      () => client.query(
        `INSERT INTO holds (
           hold_key, player_id, amount, purpose, status, tournament_id
         ) VALUES ($1, 'missing-wallet', 50000, 'tournament_entry', 'reserved', $2)`,
        [`tournament:${tournamentId}:missing-wallet`, tournamentId],
      ),
      /foreign key/i,
    );

    const orphanTournamentId = '33333333-3333-3333-3333-333333333333';
    await expectReject(
      client,
      () => client.query(
        `INSERT INTO holds (
           hold_key, player_id, amount, purpose, status, tournament_id
         ) VALUES ($1, 'wallet-a', 50000, 'tournament_entry', 'reserved', $2)`,
        [`tournament:${orphanTournamentId}:wallet-a`, orphanTournamentId],
      ),
      /foreign key/i,
    );
    await client.query(
      `INSERT INTO holds (
         hold_key, player_id, amount, purpose, status, tournament_id
       ) VALUES ($1, 'wallet-a', 50000, 'tournament_entry', 'reserved', $2)`,
      [`tournament:${tournamentId}:wallet-a`, tournamentId],
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
});
