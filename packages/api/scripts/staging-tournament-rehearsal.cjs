#!/usr/bin/env node
/**
 * One-shot staging rehearsal for a 16-player GEN 1 CASUAL tournament.
 *
 * CLI only. Refuses to run unless this process is explicitly opted in and the
 * database is the loopback staging database. It does not register an HTTP route,
 * enable the scheduler, or change the API environment file.
 *
 * Synthetic players are rehearsal identities. POKE burn deposits are not part of
 * this rehearsal. The burn-fee window is intentionally left unset: the live API
 * seals that window by calling the POKE lock path, which this rehearsal must not
 * enter. Burn flags are stored through the tournament repository so startTournament
 * can use the real bracket and match-result machine. CARDS still move only through
 * the existing creator-reward funder, prize vault, and payTournamentCardsPodium.
 */
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Keypair, PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = require('@solana/spl-token');

const ROOT = '/opt/pokearena';
const { TournamentService, isThirdPlaceMatch, readTournamentPlaces } = require(`${ROOT}/packages/tournament/dist/src/index.js`);
const { PostgresTournamentRepository } = require(`${ROOT}/packages/api/dist/src/postgres-tournament-repository.js`);
const { ChainEconomyService } = require(`${ROOT}/packages/api/dist/src/chain-economy.js`);
const { CreatorRewardsWorker } = require(`${ROOT}/packages/api/dist/src/creator-rewards.js`);
const {
  Pool,
  PostgresTournamentStore,
  PostgresChainStore,
  PostgresCreatorRewardsStore,
} = require(`${ROOT}/packages/db/dist/src/index.js`);
const { TOURNAMENT_BURN_FEE_ATOMS } = require(`${ROOT}/packages/solana-client/dist/src/index.js`);

const TITLE = 'STAGING REHEARSAL GEN 1 CASUAL';
const PRIZE_RAW = 100;
const FIELD = 16;
const STATE_PATH = '/home/ubuntu/staging-rehearsal.json';
const TEAM = [
  'Venusaur',
  'Charizard',
  'Blastoise',
  'Pikachu',
  'Snorlax',
  'Alakazam',
].join('\n');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function assertCliOnly() {
  if (require.main !== module) {
    throw new Error('The staging rehearsal harness is CLI-only.');
  }
  if (process.env.POKEARENA_STAGING_REHEARSAL !== '1') {
    throw new Error('Set POKEARENA_STAGING_REHEARSAL=1 for this process only.');
  }
  if (process.env.POKEARENA_STAGING !== 'true' || process.env.POKEARENA_ENV === 'production') {
    throw new Error('Refusing to run outside the staging process gate.');
  }
  const databaseUrl = process.env.POKEARENA_DATABASE_URL;
  if (!databaseUrl) throw new Error('POKEARENA_DATABASE_URL is required.');
  const parsed = new URL(databaseUrl);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('Refusing to run against a non-loopback database.');
  }
  if (parsed.pathname !== '/pokearena_staging') {
    throw new Error('Refusing to run against a database other than pokearena_staging.');
  }
  const configuredPrize = process.env.POKEARENA_TOURNAMENT_PRIZE_CARDS_RAW;
  if (configuredPrize !== undefined && configuredPrize !== '' && configuredPrize !== String(PRIZE_RAW)) {
    throw new Error('Refusing to run with a prize amount other than 100 raw CARDS.');
  }
}

async function schedulerEnabled(pool) {
  const result = await pool.query('SELECT enabled FROM tournament_scheduler');
  return result.rows.some(row => row.enabled === true);
}

async function assertSchedulerOff(pool) {
  if (await schedulerEnabled(pool)) {
    throw new Error('Refusing to run while the tournament scheduler is enabled.');
  }
}

function rehearsalTournaments(tournaments) {
  return tournaments.filter(tournament => (
    tournament.title === TITLE && tournament.status !== 'cancelled'
  ));
}

async function openServices() {
  const pool = new Pool({ connectionString: process.env.POKEARENA_DATABASE_URL });
  const repository = new PostgresTournamentRepository(new PostgresTournamentStore(pool));
  const tournaments = new TournamentService({ repository });
  return { pool, repository, tournaments };
}

async function requireRehearsal(tournaments) {
  const matches = rehearsalTournaments(await tournaments.listTournaments());
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one rehearsal tournament, found ${matches.length}.`);
  }
  return matches[0];
}

function writeState(state) {
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function readState() {
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

async function createRehearsal(services) {
  const existing = rehearsalTournaments(await services.tournaments.listTournaments());
  if (existing.length > 0) {
    throw new Error(`Rehearsal tournament already exists: ${existing.map(item => item.id).join(', ')}`);
  }
  const created = await services.tournaments.createTournament({
    title: TITLE,
    format: 'gen9ou',
    ruleset: 'gen1casual',
    maxPlayers: FIELD,
    hostId: 'staging-rehearsal',
    entryFee: 0,
    bracketSeed: 'staging-rehearsal-gen1-casual',
    rail: 'sol_chain',
    entryAtoms: TOURNAMENT_BURN_FEE_ATOMS,
    prizeCardsRaw: PRIZE_RAW,
  });
  const opened = await services.tournaments.openRegistration(created.id);
  if (opened.finalizesAt !== undefined || opened.paymentEndsAt !== undefined) {
    throw new Error('Rehearsal creation unexpectedly opened the live burn-fee window.');
  }
  writeState({
    tournamentId: opened.id,
    phase: 'created',
    prizeCardsRaw: PRIZE_RAW,
    participants: [],
  });
  return opened;
}

function wipeKeypair(keypair) {
  keypair.secretKey.fill(0);
}

async function seedRehearsal(services) {
  let tournament = await requireRehearsal(services.tournaments);
  if (tournament.status !== 'registration') {
    throw new Error(`Cannot seed a tournament in status ${tournament.status}.`);
  }
  const occupied = tournament.players.filter(player => (
    player.status === 'registered' || player.status === 'waitlisted'
  ));
  if (occupied.length > 0) {
    if (occupied.some(player => player.burnFeePaid === true) || tournament.finalizesAt !== undefined) {
      throw new Error('Refusing to seed over a roster that already has burn-fee state.');
    }
    const intents = await services.pool.query(
      'SELECT count(*)::text AS count FROM chain_intents WHERE tournament_id = $1',
      [tournament.id],
    );
    if (Number(intents.rows[0]?.count ?? 0) > 0) {
      throw new Error('Refusing to seed over a tournament that already has chain intents.');
    }
    for (const player of occupied) {
      await services.tournaments.withdrawPlayer(tournament.id, player.id);
    }
    tournament = await services.tournaments.getTournament(tournament.id);
  }
  const participants = [];
  for (let index = 0; index < FIELD; index += 1) {
    const keypair = Keypair.generate();
    const playerId = keypair.publicKey.toBase58();
    wipeKeypair(keypair);
    const registered = await services.tournaments.registerPlayer(tournament.id, {
      playerId,
      displayName: `Rehearsal ${String(index + 1).padStart(2, '0')}`,
      team: TEAM,
    });
    participants.push({
      playerId,
      displayName: registered.displayName,
      registrationOrder: registered.registrationOrder,
    });
  }
  const loaded = await services.tournaments.getTournament(tournament.id);
  if (loaded.finalizesAt !== undefined) {
    throw new Error('Refusing to mark rehearsal players while the live burn window is open.');
  }
  for (const player of loaded.players) {
    if (player.status === 'registered') {
      player.burnFeePaid = true;
      player.teamLocked = true;
    }
  }
  loaded.updatedAt = Date.now();
  await services.repository.saveTournament(loaded);
  const saved = await services.tournaments.getTournament(tournament.id);
  const registered = saved.players.filter(player => player.status === 'registered');
  if (registered.length !== FIELD || registered.some(player => player.burnFeePaid !== true)) {
    throw new Error('Rehearsal roster was not fully marked through the repository.');
  }
  writeState({
    tournamentId: saved.id,
    phase: 'seeded',
    prizeCardsRaw: PRIZE_RAW,
    participants,
  });
  return saved;
}

function orderOf(participants, playerId) {
  const found = participants.find(player => player.playerId === playerId);
  if (!found) throw new Error(`Unknown rehearsal participant ${playerId}.`);
  return found.registrationOrder;
}

function rehearsalEngine(participants) {
  return {
    async createBattle(input) {
      const left = input.players[0].id;
      const right = input.players[1].id;
      const winner = orderOf(participants, left) < orderOf(participants, right) ? left : right;
      const result = { status: 'win', winner, score: [1, 0], turns: 1 };
      const listeners = [];
      return {
        id: randomUUID(),
        subscribe(listener) {
          listeners.push(listener);
          return () => undefined;
        },
        async start() {
          for (const listener of listeners) listener({ type: 'completed', result });
        },
        getResult() {
          return result;
        },
        getState() {
          return { id: this.id, lifecycle: 'ended', format: input.format, players: input.players, result };
        },
        getEvents() {
          return [];
        },
        getView() {
          return undefined;
        },
        async submitChoice() {
          return undefined;
        },
        async forfeit() {
          return undefined;
        },
      };
    },
  };
}

function classify(match, matches) {
  if (isThirdPlaceMatch(match, matches)) return 'third';
  const finalRound = Math.max(...matches
    .filter(candidate => !isThirdPlaceMatch(candidate, matches))
    .map(candidate => candidate.round));
  if (match.round === finalRound && match.bracketPosition === 0) return 'final';
  if (match.round === finalRound - 1) return 'semifinal';
  if (match.round === finalRound - 2) return 'quarterfinal';
  return 'round-of-16';
}

const EXPECTED_MATCHES = {
  'round-of-16': 8,
  quarterfinal: 4,
  semifinal: 2,
  final: 1,
  third: 1,
};

async function playReady(services, tournamentId, participants, kind) {
  const matches = await services.tournaments.getBracket(tournamentId);
  const ready = matches.filter(match => (
    match.status === 'ready'
    && match.player1
    && match.player2
    && classify(match, matches) === kind
  ));
  if (ready.length !== EXPECTED_MATCHES[kind]) {
    throw new Error(`Expected ${EXPECTED_MATCHES[kind]} ready ${kind} matches, found ${ready.length}.`);
  }
  const played = [];
  for (const match of ready) {
    const settled = await services.tournaments.startMatch(match.id);
    if (!settled.winner || (settled.status !== 'completed' && settled.status !== 'forfeited')) {
      throw new Error(`Match ${match.id} did not settle through the tournament service.`);
    }
    played.push({
      id: settled.id,
      kind,
      round: settled.round,
      winner: settled.winner,
      status: settled.status,
      player1: settled.player1 ?? null,
      player2: settled.player2 ?? null,
    });
  }
  return played;
}

async function lockRehearsal(services) {
  const state = readState();
  const tournament = await requireRehearsal(services.tournaments);
  if (tournament.id !== state.tournamentId) {
    throw new Error('State file does not match the rehearsal tournament.');
  }
  if (tournament.finalizesAt !== undefined) {
    throw new Error('Refusing to start while the live burn-fee window is set.');
  }
  const started = await services.tournaments.startTournament(tournament.id);
  const matches = await services.tournaments.getBracket(started.id);
  const third = matches.filter(match => isThirdPlaceMatch(match, matches));
  if (started.status !== 'in-progress' || third.length !== 1) {
    throw new Error('Real bracket did not enter progress with one third-place match.');
  }
  writeState({ ...state, phase: 'locked' });
  return { started, matchCount: matches.length, thirdPlaceMatchId: third[0].id };
}

async function settleOpenMatch(services, match) {
  if (match.status === 'battle-created' || match.status === 'active') {
    await services.repository.interruptMatch(match.id);
  }
  const settled = await services.tournaments.startMatch(match.id);
  if (!settled.winner || (settled.status !== 'completed' && settled.status !== 'forfeited')) {
    throw new Error(`Match ${match.id} did not settle through the tournament service.`);
  }
  return settled;
}

async function podiumSnapshot(services) {
  const state = readState();
  const tournament = await services.tournaments.getTournament(state.tournamentId);
  const matches = await services.tournaments.getBracket(state.tournamentId);
  const intents = await services.pool.query(
    `SELECT kind, status, idempotency_key
     FROM chain_intents
     WHERE tournament_id = $1
     ORDER BY created_at`,
    [state.tournamentId],
  );
  const reserve = await services.pool.query(
    `SELECT status, prize_cards_raw::text, settle_intent_id, winner_id
     FROM prize_reserves
     WHERE tournament_id = $1`,
    [state.tournamentId],
  );
  const constraint = await services.pool.query(
    `SELECT pg_get_constraintdef(oid) AS definition
     FROM pg_constraint
     WHERE conname = 'tournaments_winner_only_when_completed'`,
  );
  const finalMatch = matches.find(match => classify(match, matches) === 'final');
  const third = matches.find(match => classify(match, matches) === 'third');
  const nameOf = (playerId) => tournament.players.find(player => player.id === playerId)?.displayName ?? playerId;
  const named = (match) => match ? {
    id: match.id,
    status: match.status,
    winner: match.winner ?? null,
    winnerName: match.winner ? nameOf(match.winner) : null,
    player1: match.player1 ?? null,
    player1Name: match.player1 ? nameOf(match.player1) : null,
    player2: match.player2 ?? null,
    player2Name: match.player2 ? nameOf(match.player2) : null,
  } : null;
  return {
    tournamentId: tournament.id,
    status: tournament.status,
    winner: tournament.winner ?? null,
    winnerName: tournament.winner ? nameOf(tournament.winner) : null,
    completedAt: tournament.completedAt ?? null,
    final: named(finalMatch),
    third: named(third),
    places: (() => {
      const places = readTournamentPlaces(matches);
      if (!places) return null;
      return {
        firstId: places.firstId,
        firstName: nameOf(places.firstId),
        secondId: places.secondId,
        secondName: nameOf(places.secondId),
        thirdId: places.thirdId ?? null,
        thirdName: places.thirdId ? nameOf(places.thirdId) : null,
      };
    })(),
    intents: intents.rows.map(row => ({
      kind: row.kind,
      status: row.status,
      idempotencyKey: row.idempotency_key,
    })),
    reserve: reserve.rows[0] ?? null,
    winnerConstraint: constraint.rows[0]?.definition ?? null,
  };
}

function assertNoPayout(snapshot) {
  const payout = snapshot.intents.filter(intent => (
    intent.kind === 'prize_pay'
    || String(intent.idempotencyKey).startsWith('prize_pay:')
  ));
  if (payout.length > 0) {
    throw new Error(`Payout intent already exists: ${payout.map(intent => intent.idempotencyKey).join(', ')}`);
  }
  if (snapshot.reserve?.settle_intent_id || snapshot.reserve?.winner_id) {
    throw new Error('Prize reserve already has a settlement or winner.');
  }
}

async function recordFinal(services) {
  const state = readState();
  if (state.tournamentId !== '2fccda85-2748-4c70-902c-35795353f063') {
    throw new Error('Refusing to record a final for a different tournament.');
  }
  services.tournaments = new TournamentService({
    repository: services.repository,
    battleEngine: rehearsalEngine(state.participants),
  });
  const before = await podiumSnapshot(services);
  if (!before.final) throw new Error('Championship final is missing.');
  if (before.final.status !== 'completed' && before.final.status !== 'forfeited') {
    await settleOpenMatch(services, before.final);
  }
  const after = await podiumSnapshot(services);
  if (after.status !== 'in-progress' || after.winner || after.completedAt) {
    throw new Error('Final result changed the tournament champion before third place.');
  }
  if (!after.final?.winner) throw new Error('Final match has no winner.');
  if (after.third?.status === 'completed' || after.third?.winner) {
    throw new Error('Third-place match was changed while recording the final.');
  }
  assertNoPayout(after);
  return after;
}

async function recordThird(services) {
  const state = readState();
  if (state.tournamentId !== '2fccda85-2748-4c70-902c-35795353f063') {
    throw new Error('Refusing to record third place for a different tournament.');
  }
  services.tournaments = new TournamentService({
    repository: services.repository,
    battleEngine: rehearsalEngine(state.participants),
  });
  const before = await podiumSnapshot(services);
  if (before.status !== 'in-progress' || before.winner) {
    throw new Error('Third place can only be recorded while the cup is still in progress.');
  }
  if (!before.final?.winner) throw new Error('Championship final has no recorded winner.');
  if (!before.third) throw new Error('Third-place match is missing.');
  if (before.third.status !== 'completed' && before.third.status !== 'forfeited') {
    await settleOpenMatch(services, before.third);
  }
  const after = await podiumSnapshot(services);
  if (after.status !== 'completed' || !after.winner || !after.completedAt || !after.places?.thirdId) {
    throw new Error('Third-place result did not finalize the podium.');
  }
  if (after.winner !== after.places.firstId || after.final?.winner !== after.places.firstId) {
    throw new Error('Tournament champion does not match the championship final winner.');
  }
  assertNoPayout(after);
  return after;
}

async function playRehearsal(services) {
  const state = readState();
  const engine = rehearsalEngine(state.participants);
  services.tournaments = new TournamentService({
    repository: services.repository,
    battleEngine: engine,
  });
  const rounds = [];
  for (const kind of ['round-of-16', 'quarterfinal', 'semifinal']) {
    const played = await playReady(services, state.tournamentId, state.participants, kind);
    const current = await services.tournaments.getTournament(state.tournamentId);
    if (current.status === 'completed') {
      throw new Error(`Tournament completed during ${kind}.`);
    }
    rounds.push({ kind, played, status: current.status });
  }
  const finalPlayed = await playReady(services, state.tournamentId, state.participants, 'final');
  const afterFinal = await services.tournaments.getTournament(state.tournamentId);
  if (afterFinal.status === 'completed') {
    throw new Error('Tournament completed before the third-place match.');
  }
  const thirdPlayed = await playReady(services, state.tournamentId, state.participants, 'third');
  const completed = await services.tournaments.getTournament(state.tournamentId);
  const places = readTournamentPlaces(await services.tournaments.getBracket(state.tournamentId));
  if (completed.status !== 'completed' || !places?.thirdId) {
    throw new Error('Tournament did not complete from the real podium result.');
  }
  if (new Set([places.firstId, places.secondId, places.thirdId]).size !== 3) {
    throw new Error('Podium places are not three distinct players.');
  }
  writeState({ ...state, phase: 'played', places });
  return { rounds, finalPlayed, afterFinal: afterFinal.status, thirdPlayed, places, status: completed.status };
}

function economyFor(pool) {
  const chainStore = new PostgresChainStore(pool);
  const economy = new ChainEconomyService({ chainStore, env: process.env });
  const worker = new CreatorRewardsWorker({
    env: process.env,
    connection: economy.client.connection,
    store: new PostgresCreatorRewardsStore(pool),
  });
  economy.attachCreatorRewardFunder(worker);
  return economy;
}

async function fundRehearsal(services) {
  const state = readState();
  const tournament = await requireRehearsal(services.tournaments);
  if (tournament.prizeCardsRaw !== PRIZE_RAW) {
    throw new Error('Rehearsal prize is not 100 raw CARDS.');
  }
  process.env.POKEARENA_TOURNAMENT_PRIZE_CARDS_RAW = String(PRIZE_RAW);
  const economy = economyFor(services.pool);
  const funded = await economy.runStagingTournamentFundingSmoke({
    tournamentId: tournament.id,
    prizeCardsRaw: PRIZE_RAW,
    authorization: process.env.POKEARENA_STAGING_SMOKE_TOKEN,
  });
  writeState({ ...state, phase: 'funded', funding: funded });
  return funded;
}

async function tokenRaw(connection, mint, owner) {
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, TOKEN_PROGRAM_ID);
  const info = await connection.getAccountInfo(ata, 'confirmed');
  if (!info) return '0';
  const balance = await connection.getTokenAccountBalance(ata, 'confirmed');
  return balance.value.amount;
}

async function payRehearsal(services) {
  const state = readState();
  const economy = economyFor(services.pool);
  const paid = await economy.payTournamentCardsPodium({
    tournamentId: state.tournamentId,
    firstId: state.places.firstId,
    secondId: state.places.secondId,
    thirdId: state.places.thirdId,
  });
  writeState({ ...state, phase: 'paid', payout: paid });
  return paid;
}

function publicKeyFromKeypairFile(path) {
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(path, 'utf8')));
  const keypair = Keypair.fromSecretKey(secret);
  const owner = keypair.publicKey.toBase58();
  secret.fill(0);
  keypair.secretKey.fill(0);
  return owner;
}

async function accountRaw(connection, address) {
  try {
    const balance = await connection.getTokenAccountBalance(new PublicKey(address), 'confirmed');
    return balance.value.amount;
  } catch {
    return '0';
  }
}

async function balances(services) {
  const state = readState();
  const { ArenaChainClient, loadChainConfig, uuidToBytes } = require(`${ROOT}/packages/solana-client/dist/src/index.js`);
  const { cardsPrizeVaultPda } = require(`${ROOT}/packages/solana-client/dist/src/pdas.js`);
  const config = loadChainConfig(process.env);
  const client = new ArenaChainClient(config);
  const tournamentBytes = uuidToBytes(state.tournamentId);
  const [vault] = cardsPrizeVaultPda(config.programId, tournamentBytes);
  let reserve = { present: false };
  try {
    const current = await client.getCardsPrizeReserveState(tournamentBytes);
    reserve = {
      present: true,
      status: current.status,
      cardsAmount: current.cardsAmount.toString(),
      winnerSet: current.winnerSet === true,
    };
  } catch {
    reserve = { present: false };
  }
  const ledger = await services.pool.query(
    `SELECT tournament_allocated_raw::text AS allocated,
            tournament_committed_raw::text AS committed
     FROM creator_reward_ledger`,
  );
  const places = state.places ?? {};
  const named = [
    ['creator', publicKeyFromKeypairFile(process.env.POKEARENA_CREATOR_REWARDS_KEYPAIR)],
    ['keeper', process.env.POKEARENA_KEEPER],
    ['first', places.firstId],
    ['second', places.secondId],
    ['third', places.thirdId],
  ].filter((entry) => entry[1]);
  const accounts = {};
  for (const [name, owner] of named) {
    const ata = client.getCardsAta(new PublicKey(owner));
    accounts[name] = await accountRaw(client.connection, ata);
  }
  accounts.vault = await accountRaw(client.connection, vault);
  process.stdout.write(`${JSON.stringify({
    tournamentId: state.tournamentId,
    reserve,
    ledger: ledger.rows[0] ?? null,
    accounts,
  }, null, 2)}\n`);
}

async function report(services) {
  const state = readState();
  const tournament = await services.tournaments.getTournament(state.tournamentId);
  const matches = await services.tournaments.getBracket(state.tournamentId);
  const intents = await services.pool.query(
    `SELECT kind, status, amount::text, idempotency_key, metadata
     FROM chain_intents
     WHERE tournament_id = $1
     ORDER BY created_at`,
    [state.tournamentId],
  );
  const scheduler = await services.pool.query('SELECT enabled FROM tournament_scheduler');
  process.stdout.write(`${JSON.stringify({
    tournamentId: tournament.id,
    title: tournament.title,
    ruleset: tournament.ruleset,
    maxPlayers: tournament.maxPlayers,
    status: tournament.status,
    registered: tournament.players.filter(player => player.status === 'registered').length,
    matchCount: matches.length,
    thirdPlace: matches.filter(match => isThirdPlaceMatch(match, matches)).map(match => ({
      id: match.id,
      status: match.status,
      winner: match.winner ?? null,
      player1: match.player1 ?? null,
      player2: match.player2 ?? null,
    })),
    places: readTournamentPlaces(matches) ?? null,
    intents: intents.rows.map(row => ({
      kind: row.kind,
      status: row.status,
      amount: row.amount,
      idempotencyKey: row.idempotency_key,
      metadata: row.metadata,
    })),
    schedulerEnabled: scheduler.rows.some(row => row.enabled === true),
  }, null, 2)}\n`);
}

async function main() {
  assertCliOnly();
  const command = process.argv[2];
  if (!['create', 'seed', 'fund', 'lock', 'play', 'pay', 'balances', 'report', 'record-final', 'record-third'].includes(command)) {
    throw new Error('Usage: staging-tournament-rehearsal.cjs <create|seed|fund|lock|play|pay|balances|report|record-final|record-third>');
  }
  const services = await openServices();
  try {
    await assertSchedulerOff(services.pool);
    let result;
    if (command === 'create') result = await createRehearsal(services);
    if (command === 'seed') result = await seedRehearsal(services);
    if (command === 'fund') result = await fundRehearsal(services);
    if (command === 'lock') result = await lockRehearsal(services);
    if (command === 'play') result = await playRehearsal(services);
    if (command === 'record-final') result = await recordFinal(services);
    if (command === 'record-third') result = await recordThird(services);
    if (command === 'pay') result = await payRehearsal(services);
    if (command === 'balances') {
      await balances(services);
      return;
    }
    if (command === 'report') {
      await report(services);
      return;
    }
    await assertSchedulerOff(services.pool);
    const tournament = command === 'create' || command === 'seed'
      ? result
      : await services.tournaments.getTournament(readState().tournamentId);
    process.stdout.write(`${JSON.stringify({
      command,
      tournamentId: tournament.id,
      status: tournament.status,
      registered: tournament.players.filter(player => player.status === 'registered').length,
      maxPlayers: tournament.maxPlayers,
      ruleset: tournament.ruleset,
      prizeCardsRaw: tournament.prizeCardsRaw ?? null,
      finalizesAt: tournament.finalizesAt ?? null,
      result,
    }, null, 2)}\n`);
  } finally {
    await services.pool.end();
  }
}

if (require.main === module) {
  main().catch(error => fail(error instanceof Error ? error.stack ?? error.message : String(error)));
}
