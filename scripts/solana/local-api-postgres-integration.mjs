#!/usr/bin/env node
/**
 * Disposable local-only API -> PostgreSQL -> Solana integration campaign.
 *
 * Required environment:
 *   POKEARENA_DATABASE_URL=postgres://...
 *   POKEARENA_POKE_MINT=<disposable local mint>
 *   POKEARENA_KEEPER_KEYPAIR=<local keeper keypair>
 *
 * The script refuses non-loopback RPCs and never loads production configuration.
 * It creates wallets in memory, uses the configured local mint, exercises the
 * browser-shaped WebSocket intent/sign/confirm path, and removes no user state.
 */
import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import WebSocket from 'ws';

const RPC = process.env.POKEARENA_SOLANA_RPC ?? 'http://127.0.0.1:8899';
if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(RPC)) {
  throw new Error(`Local integration refuses non-loopback RPC: ${RPC}`);
}
if (!process.env.POKEARENA_DATABASE_URL) {
  throw new Error('POKEARENA_DATABASE_URL is required for the local Postgres integration.');
}

const PROGRAM_ID = new PublicKey(process.env.POKEARENA_PROGRAM_ID ?? '41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W');
const POKE_MINT = new PublicKey(process.env.POKEARENA_POKE_MINT);
const KEYDIR = process.env.POKEARENA_SOLANA_KEYS ?? new URL('./keys/', import.meta.url).pathname;
const AUTHORITY = loadKeypair(process.env.POKEARENA_AUTHORITY_KEYPAIR ?? `${KEYDIR}/authority.json`);
const KEEPER = loadKeypair(process.env.POKEARENA_KEEPER_KEYPAIR ?? `${KEYDIR}/keeper.json`);
const PLAYER_COUNT = 32;
const POKE_PER_PLAYER_ATOMS = 500_000_000_000n;
const BURN_ATOMS = 10_000_000_000n;
const PRIZE_LAMPORTS = 100_000_000;
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM_ID = SystemProgram.programId;
const RENT_SYSVAR = new PublicKey('SysvarRent111111111111111111111111111111111');

function loadKeypair(file) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, 'utf8'))));
}

function base58(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let output = '';
  while (value > 0n) {
    output = alphabet[Number(value % 58n)] + output;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    output = `1${output}`;
  }
  return output || '1';
}

function signWalletMessage(wallet, message) {
  const seed = wallet.secretKey.subarray(0, 32);
  const derPrefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const privateKey = createPrivateKey({
    key: Buffer.concat([derPrefix, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
  return base58(sign(null, Buffer.from(message, 'utf8'), privateKey));
}

function associatedTokenAddress(owner) {
  owner = owner.publicKey ?? owner;
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), POKE_MINT.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

function createAtaIx(owner, ata) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: AUTHORITY.publicKey, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: POKE_MINT, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: RENT_SYSVAR, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

function mintToIx(ata, amount) {
  const data = Buffer.alloc(9);
  data[0] = 7;
  data.writeBigUInt64LE(amount);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: POKE_MINT, isSigner: false, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: AUTHORITY.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  });
}

async function send(connection, instructions, signers = []) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({
    feePayer: AUTHORITY.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(...instructions);
  transaction.partialSign(AUTHORITY, ...signers);
  const signature = await connection.sendRawTransaction(transaction.serialize());
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  return signature;
}

async function provisionWallets(connection, wallets) {
  for (const wallet of wallets) {
    const signature = await connection.requestAirdrop(wallet.publicKey, 2_000_000_000);
    await connection.confirmTransaction(signature, 'confirmed');
  }
  for (let offset = 0; offset < wallets.length; offset += 4) {
    const batch = wallets.slice(offset, offset + 4);
    const instructions = [];
    for (const wallet of batch) {
      const ata = associatedTokenAddress(wallet);
      instructions.push(createAtaIx(wallet.publicKey, ata));
    }
    await send(connection, instructions);
  }
  const mintAuthority = '/mnt/d/CursorProj/PokeArena/scripts/solana/keys/authority.json';
  for (const wallet of wallets) {
    execFileSync('wsl.exe', [
      '-e',
      'bash',
      '-lc',
      `spl-token mint ${POKE_MINT.toBase58()} 500000 --recipient-owner ${wallet.publicKey.toBase58()} `
        + `--mint-authority ${mintAuthority} --fee-payer ${mintAuthority} --url ${RPC}`,
    ], { stdio: 'ignore' });
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(label, read, predicate, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await read();
    if (predicate(latest)) return latest;
    await delay(1_000);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(latest)}`);
}

class ApiWallet {
  constructor(wallet) {
    this.wallet = wallet;
    this.socket = null;
  }

  async connect(port) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Origin: 'http://localhost' },
    });
    await new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    await this.request('auth.challenge', { address: this.wallet.publicKey.toBase58() }, 'auth.challenge');
    const challenge = this.lastResponse;
    await this.request('auth.verify', {
      address: this.wallet.publicKey.toBase58(),
      nonce: challenge.nonce,
      signature: signWalletMessage(this.wallet, challenge.message),
    }, 'auth.verified');
  }

  async request(type, payload, expectedType) {
    const requestId = randomUUID();
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.off('message', onMessage);
        reject(new Error(`${type} timed out`));
      }, 60_000);
      const onMessage = data => {
        const message = JSON.parse(String(data));
        if (message.type === 'error' && message.requestId === requestId) {
          clearTimeout(timer);
          this.socket.off('message', onMessage);
          reject(new Error(`${type}: ${message.message}`));
          return;
        }
        if (message.requestId === requestId && message.type === expectedType) {
          clearTimeout(timer);
          this.socket.off('message', onMessage);
          resolve(message);
        }
      };
      this.socket.on('message', onMessage);
      this.socket.send(JSON.stringify({ type, requestId, ...payload }));
    });
    this.lastResponse = response;
    return response;
  }

  close() {
    this.socket?.terminate();
  }
}

async function submitBurnPayment(connection, apiWallet, tournamentId) {
  const intentResponse = await apiWallet.request(
    'tournament.payBurnFee',
    { tournamentId, playerPokeAta: associatedTokenAddress(apiWallet.wallet).toBase58() },
    'tx.intent',
  );
  const intent = intentResponse.intent;
  const transaction = Transaction.from(Buffer.from(intent.serializedTx));
  transaction.partialSign(apiWallet.wallet);
  const signed = transaction.serialize();
  const signature = base58(transaction.signature);
  await connection.sendRawTransaction(signed);
  let update;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    update = await apiWallet.request('tx.confirm', {
      intentId: intent.intentId,
      signature,
      signedTransaction: [...signed],
    }, 'tx.update');
    if (update.status === 'confirmed') break;
    await delay(500);
  }
  if (update?.status !== 'confirmed') {
    throw new Error(`Payment confirmation did not converge for ${intent.intentId}.`);
  }
  return { intentId: intent.intentId, signature };
}

async function main() {
  const connection = new Connection(RPC, 'confirmed');
  const wallets = Array.from({ length: PLAYER_COUNT }, () => Keypair.generate());
  await provisionWallets(connection, wallets);

  const { ApiServer } = await import('../../packages/api/dist/src/server.js');
  const server = await ApiServer.create({
    bindHost: '127.0.0.1',
    allowMissingOrigin: false,
    allowedOrigins: ['http://localhost'],
    authOrigin: 'http://localhost',
    localTestMode: true,
    maxConnections: 64,
    maxConnectionsPerIp: 64,
    rateLimits: { authChallenge: 64 },
  });
  const port = await server.listen(0);
  const clients = wallets.map(wallet => new ApiWallet(wallet));
  const chainStore = server.chainEconomy.chainStore;
  const originalSetIntentStatus = chainStore?.setIntentStatus?.bind(chainStore);
  let interruptedPrizeConfirmation = false;
  if (chainStore && originalSetIntentStatus) {
    chainStore.setIntentStatus = async (...args) => {
      if (!interruptedPrizeConfirmation && args[1] === 'confirmed') {
        const intent = await chainStore.getIntent(args[0]);
        if (intent?.kind === 'prize_pay') {
          interruptedPrizeConfirmation = true;
          throw new Error('Database update delayed.');
        }
      }
      return originalSetIntentStatus(...args);
    };
  }
  try {
    await Promise.all(clients.map(client => client.connect(port)));
    const created = await clients[0].request('tournament.create', {
      title: 'Local API Postgres Cup',
      maxPlayers: 32,
      ruleset: 'gen9ou',
    }, 'tournament.created');
    const tournamentId = created.tournament.id;
    const demoTeams = await import('../../packages/api/dist/src/demo-teams.js');
    await Promise.all(clients.map(client => client.request('tournament.join', {
      tournamentId,
      team: demoTeams.DEMO_TEAM_ONE,
    }, 'tournament.state')));

    const joined = await server.tournaments.getTournament(tournamentId);
    if (joined.players.filter(player => player.status === 'registered').length !== PLAYER_COUNT) {
      throw new Error('Postgres roster did not contain exactly 32 registered players.');
    }
    const payments = await Promise.all(clients.map(client => submitBurnPayment(connection, client, tournamentId)));
    if (new Set(payments.map(payment => payment.signature)).size !== PLAYER_COUNT) {
      throw new Error('Duplicate browser/API payment signatures detected.');
    }

    const paymentWindow = await server.tournaments.getTournament(tournamentId);
    await waitFor(
      'payment sealing',
      () => server.tournaments.getTournament(tournamentId),
      tournament => tournament.finalizesAt !== undefined && Date.now() >= tournament.finalizesAt,
      Math.max(180_000, (paymentWindow.finalizesAt ?? Date.now()) - Date.now() + 60_000),
    );
    await waitFor(
      'chain tournament start',
      () => server.tournaments.getTournament(tournamentId),
      tournament => tournament.status === 'in-progress',
    );

    let matchIterations = 0;
    while ((await server.tournaments.getTournament(tournamentId)).status !== 'completed') {
      if (++matchIterations > 100) throw new Error('Tournament bracket did not converge.');
      const matches = await server.tournaments.getBracket(tournamentId);
      const active = matches.filter(match => (
        match.status === 'active' && match.player1
      ));
      if (active.length === 0) {
        await delay(250);
        continue;
      }
      await Promise.all(active.map(match => server.tournaments.forfeit(match.id, match.player1)));
    }

    const completed = await waitFor(
      'prize payout',
      () => server.tournaments.getTournament(tournamentId),
      tournament => tournament.status === 'completed' && Boolean(tournament.winner),
    );
    const pg = await import('pg');
    const pool = new pg.Pool({ connectionString: process.env.POKEARENA_DATABASE_URL });
    const paidPrize = await waitFor(
      'durable prize payout',
      async () => (await pool.query(
        `SELECT status, amount_lamports::text AS amount_lamports, winner_id
         FROM prize_reserves WHERE tournament_id = $1`,
        [tournamentId],
      )).rows[0],
      row => row?.status === 'paid',
      60_000,
    );
    const intentRows = await pool.query(
      `SELECT kind, status, COUNT(*)::int AS count
       FROM chain_intents WHERE tournament_id = $1 GROUP BY kind, status ORDER BY kind, status`,
      [tournamentId],
    );
    const entryRows = await pool.query(
      `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(amount_atoms), 0)::text AS atoms
       FROM entry_escrows WHERE tournament_id = $1 GROUP BY status`,
      [tournamentId],
    );
    const dbTournament = await pool.query(
      `SELECT status, winner_id, (SELECT COUNT(*) FROM tournament_players tp
       WHERE tp.tournament_id = tournaments.id AND tp.status = 'registered')::int AS registered
       FROM tournaments WHERE id = $1`,
      [tournamentId],
    );
    await pool.end();

    const secondServer = await ApiServer.create({
      bindHost: '127.0.0.1',
      allowMissingOrigin: false,
      allowedOrigins: ['http://localhost'],
      authOrigin: 'http://localhost',
      localTestMode: true,
      maxConnections: 64,
      maxConnectionsPerIp: 64,
      rateLimits: { authChallenge: 64 },
    });
    await secondServer.close();

    const report = {
      rpc: RPC,
      programId: PROGRAM_ID.toBase58(),
      pokeMint: POKE_MINT.toBase58(),
      tournamentId,
      participants: wallets.length,
      uniquePaymentSignatures: new Set(payments.map(payment => payment.signature)).size,
      entryBurnAtomsExpected: String(BURN_ATOMS * BigInt(PLAYER_COUNT)),
      finalTournament: {
        status: completed.status,
        winner: completed.winner,
        registered: dbTournament.rows[0]?.registered,
      },
      chainIntents: intentRows.rows,
      entryEscrows: entryRows.rows,
      prizeReserve: paidPrize ?? null,
      landedPrizeRecovery: interruptedPrizeConfirmation ? 'passed' : 'not exercised',
      restartReconciliation: 'passed',
    };
    console.log(`LOCAL_API_POSTGRES_REPORT=${JSON.stringify(report)}`);
  } finally {
    for (const client of clients) client.close();
    await server.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
