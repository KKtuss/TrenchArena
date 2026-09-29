import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';

import type { Tournament } from '@pokearena/tournament';
import { WebSocket } from 'ws';

import { DEMO_TEAM_ONE, DEMO_TEAM_TWO } from '../src/demo-teams';
import { DEFAULT_DEV_BALANCE_POKE } from '../src/mock-economics';
import { ApiServer } from '../src/server';
import { publicTournamentForViewer } from '../src/tournament-view';
import { encodeBase58 } from '../src/wallet-auth';

const TEAM_A_SECRETS = ['Great Tusk', 'Protosynthesis', 'Headlong Rush', 'Gholdengo'];
const TEAM_B_SECRETS = ['Samurott-Hisui', 'Sharpness', 'Ceaseless Edge', 'Dragapult'];

function createSolanaKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const rawPublic = Buffer.from(spki.subarray(spki.length - 32));
  return { address: encodeBase58(rawPublic), privateKey };
}

function signMessage(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  message: string,
): string {
  return encodeBase58(sign(null, Buffer.from(message, 'utf8'), privateKey as any));
}

class TestClient {
  readonly socket: WebSocket;
  private readonly messages: any[] = [];
  private readonly waiters: Array<{
    predicate: (message: any) => boolean;
    resolve: (message: any) => void;
  }> = [];

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      const waiter = this.waiters.find(item => item.predicate(message));
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      } else {
        this.messages.push(message);
      }
    });
  }

  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify({ requestId: randomUUID(), ...message }));
  }

  async waitFor<T = any>(predicate: (message: any) => boolean, timeoutMs = 8_000): Promise<T> {
    const existing = this.messages.find(predicate);
    if (existing) {
      this.messages.splice(this.messages.indexOf(existing), 1);
      return existing as T;
    }
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiter = this.waiters.find(item => item.resolve === resolve);
        if (waiter) this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error('Timed out waiting for WebSocket message.'));
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: message => {
          clearTimeout(timeout);
          resolve(message);
        },
      });
    });
  }

  close(): Promise<void> {
    this.socket.terminate();
    (this.socket as WebSocket & { _socket?: { destroy: () => void } })._socket?.destroy();
    return Promise.resolve();
  }
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function authenticate(client: TestClient, keypair: ReturnType<typeof createSolanaKeypair>): Promise<void> {
  client.send({ type: 'auth.challenge', address: keypair.address });
  const challenge = await client.waitFor<any>(message => (
    message.type === 'auth.challenge' && message.address === keypair.address
  ));
  client.send({
    type: 'auth.verify',
    address: keypair.address,
    signature: signMessage(keypair.privateKey, challenge.message),
    nonce: challenge.nonce,
  });
  await client.waitFor(message => message.type === 'auth.verified' && message.playerId === keypair.address);
}

function assertHidden(payload: unknown, hidden: string[]): void {
  const text = JSON.stringify(payload);
  for (const secret of hidden) {
    assert.equal(text.includes(secret), false, `payload leaked hidden team detail: ${secret}`);
  }
}

function assertOwnTeam(tournament: any, playerId: string, secrets: string[]): void {
  const self = tournament.players.find((player: any) => player.id === playerId);
  assert.equal(typeof self?.team, 'string');
  for (const secret of secrets) assert.match(self.team, new RegExp(secret));
  for (const player of tournament.players) {
    if (player.id !== playerId) assert.equal(player.team, undefined);
  }
}

test('production mode rejects demo identify and hides the demo page, while wallet auth still works', async () => {
  const server = new ApiServer();
  const port = await server.listen(0);
  const client = new TestClient(port);
  const keypair = createSolanaKeypair();
  try {
    const index = await httpGet(`http://127.0.0.1:${port}/`);
    const clientJs = await httpGet(`http://127.0.0.1:${port}/client.js`);
    const health = await httpGet(`http://127.0.0.1:${port}/health`);
    assert.equal(index.status, 404);
    assert.equal(clientJs.status, 404);
    assert.equal(index.body.includes('demo-player-1'), false);
    assert.equal(health.status, 200);

    await client.open();
    for (const playerId of ['demo-player-1', 'demo-player-2']) {
      client.send({ type: 'identify', playerId });
      const rejected = await client.waitFor<any>(message => message.type === 'error');
      assert.equal(rejected.code, 'DemoAuthDisabledError');
    }

    await authenticate(client, keypair);
    client.send({ type: 'tournament.create', title: 'Wallet Cup', maxPlayers: 4 });
    const created = await client.waitFor<any>(message => message.type === 'tournament.created');
    assert.equal(created.tournament.hostId, keypair.address);
    assert.equal(created.tournament.status, 'registration');

    client.send({ type: 'tournament.join', tournamentId: created.tournament.id });
    const missingTeam = await client.waitFor<any>(message => message.type === 'error');
    assert.equal(missingTeam.code, 'TeamRequiredError');
    client.send({ type: 'tournament.subscribe', tournamentId: created.tournament.id });
    const stillOpen = await client.waitFor<any>(message => message.type === 'tournament.state');
    assert.equal(stillOpen.tournament.players?.length ?? 0, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test('development demo auth still serves the demo page and accepts demo identify', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0 });
  const port = await server.listen(0);
  const client = new TestClient(port);
  try {
    const index = await httpGet(`http://127.0.0.1:${port}/`);
    assert.equal(index.status, 200);
    assert.match(index.body, /demo-player-1/);
    await client.open();
    client.send({ type: 'identify', playerId: 'demo-player-2' });
    const ready = await client.waitFor<any>(message => message.type === 'ready' && message.playerId === 'demo-player-2');
    assert.equal(ready.playerId, 'demo-player-2');
  } finally {
    await client.close();
    await server.close();
  }
});

test('only the recorded host can start a tournament', async () => {
  const server = new ApiServer();
  const port = await server.listen(0);
  const hostKey = createSolanaKeypair();
  const memberKey = createSolanaKeypair();
  const outsiderKey = createSolanaKeypair();
  const host = new TestClient(port);
  const member = new TestClient(port);
  const outsider = new TestClient(port);
  try {
    await Promise.all([host.open(), member.open(), outsider.open()]);
    await authenticate(host, hostKey);
    await authenticate(member, memberKey);
    await authenticate(outsider, outsiderKey);
    await server.economics.credit(hostKey.address, DEFAULT_DEV_BALANCE_POKE);
    await server.economics.credit(memberKey.address, DEFAULT_DEV_BALANCE_POKE);

    host.send({
      type: 'tournament.create',
      title: 'Host Cup',
      maxPlayers: 4,
      hostId: outsiderKey.address,
    });
    const created = await host.waitFor<any>(message => message.type === 'tournament.created');
    const tournamentId = created.tournament.id;
    assert.equal(created.tournament.hostId, hostKey.address);
    assert.equal(created.tournament.status, 'registration');

    host.send({ type: 'tournament.join', tournamentId, team: DEMO_TEAM_ONE });
    member.send({ type: 'tournament.join', tournamentId, team: DEMO_TEAM_TWO });
    const registered = await host.waitFor<any>(message => (
      message.type === 'tournament.state' && message.tournament.players?.length === 2
    ));
    assert.equal(registered.tournament.status, 'registration');
    assert.equal(registered.tournament.bracket?.length ?? 0, 0);

    member.send({ type: 'tournament.start', tournamentId });
    const memberDenied = await member.waitFor<any>(message => message.type === 'error');
    assert.equal(memberDenied.code, 'TournamentHostRequiredError');

    outsider.send({ type: 'tournament.start', tournamentId });
    const outsiderDenied = await outsider.waitFor<any>(message => message.type === 'error');
    assert.equal(outsiderDenied.code, 'TournamentHostRequiredError');

    outsider.send({ type: 'tournament.subscribe', tournamentId });
    await outsider.waitFor(message => message.type === 'tournament.state' && message.tournament.id === tournamentId);
    outsider.send({ type: 'tournament.start', tournamentId });
    const subscriberDenied = await outsider.waitFor<any>(message => message.type === 'error');
    assert.equal(subscriberDenied.code, 'TournamentHostRequiredError');

    host.send({ type: 'tournament.subscribe', tournamentId });
    const unchanged = await host.waitFor<any>(message => (
      message.type === 'tournament.state'
      && message.tournament.id === tournamentId
      && message.tournament.players?.length === 2
      && message.tournament.status === 'registration'
    ));
    assert.equal(unchanged.tournament.status, 'registration');
    assert.equal(unchanged.tournament.players.filter((player: any) => player.status === 'registered').length, 2);
    assert.equal(unchanged.tournament.bracket?.length ?? 0, 0);

    host.send({ type: 'tournament.start', tournamentId });
    const started = await host.waitFor<any>(message => (
      message.type === 'tournament.state' && message.tournament.status === 'in-progress'
    ));
    assert.equal(started.tournament.status, 'in-progress');
    assert.ok(started.tournament.bracket?.length);
  } finally {
    await Promise.all([host.close(), member.close(), outsider.close()]);
    await server.close();
  }
});

test('tournament.state and tournament.result hide the opposing build', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0 });
  const port = await server.listen(0);
  const outsiderKey = createSolanaKeypair();
  const players: [TestClient, TestClient] = [new TestClient(port), new TestClient(port)];
  const outsider = new TestClient(port);
  try {
    await Promise.all([...players, outsider].map(client => client.open()));
    players[0].send({ type: 'identify', playerId: 'demo-player-1' });
    players[1].send({ type: 'identify', playerId: 'demo-player-2' });
    await authenticate(outsider, outsiderKey);
    await Promise.all(players.map(client => client.waitFor(message => message.type === 'ready' && message.playerId)));

    players[0].send({ type: 'tournament.create', title: 'Private Builds', maxPlayers: 4 });
    const created = await players[0].waitFor<any>(message => message.type === 'tournament.created');
    const tournamentId = created.tournament.id;
    assert.equal(created.tournament.title, 'Private Builds');
    assert.equal(created.tournament.format, 'gen9ou');

    players[0].send({ type: 'tournament.join', tournamentId, team: DEMO_TEAM_ONE });
    players[1].send({ type: 'tournament.join', tournamentId, team: DEMO_TEAM_TWO });
    const stateA = await players[0].waitFor<any>(message => (
      message.type === 'tournament.state' && message.tournament.players?.length === 2
    ));
    const stateB = await players[1].waitFor<any>(message => (
      message.type === 'tournament.state' && message.tournament.players?.length === 2
    ));
    outsider.send({ type: 'tournament.subscribe', tournamentId });
    const stateOutsider = await outsider.waitFor<any>(message => (
      message.type === 'tournament.state' && message.tournament.players?.length === 2
    ));

    assertOwnTeam(stateA.tournament, 'demo-player-1', TEAM_A_SECRETS);
    assertHidden(stateA, TEAM_B_SECRETS);
    assertOwnTeam(stateB.tournament, 'demo-player-2', TEAM_B_SECRETS);
    assertHidden(stateB, TEAM_A_SECRETS);
    assertHidden(stateOutsider, [...TEAM_A_SECRETS, ...TEAM_B_SECRETS]);
    assert.equal(stateOutsider.tournament.players.every((player: any) => player.team === undefined), true);
    assert.equal(stateA.tournament.entryFee, created.tournament.entryFee);
    assert.ok(stateA.tournament.economics);
    assert.equal(stateA.tournament.hostId, 'demo-player-1');

    players[0].send({ type: 'tournament.list' });
    const listed = await players[0].waitFor<any>(message => message.type === 'tournament.list');
    assert.ok(listed.tournaments.some((item: any) => item.id === tournamentId && item.title === 'Private Builds'));
    assertHidden(listed, [...TEAM_A_SECRETS, ...TEAM_B_SECRETS]);

    players[0].send({ type: 'tournament.start', tournamentId });
    const started = await players[0].waitFor<any>(message => (
      message.type === 'tournament.state' && message.tournament.status === 'in-progress'
    ));
    assertHidden(started, TEAM_B_SECRETS);
    const match = started.tournament.bracket.find((candidate: any) => (
      candidate.status === 'active' || candidate.status === 'ready'
    ));
    assert.ok(match);

    players[0].send({ type: 'match.subscribe', matchId: match.id });
    players[1].send({ type: 'match.subscribe', matchId: match.id });
    let [stateOne, stateTwo] = await Promise.all(players.map(client => (
      client.waitFor<any>(message => message.type === 'match.subscribed')
    )));

    for (let turn = 0; turn < 1000; turn += 1) {
      if (stateOne.match.status === 'completed') break;
      const choiceOne = stateOne.state?.request?.choices?.[0];
      if (choiceOne) {
        players[0].send({
          type: 'match.choice',
          matchId: match.id,
          battleInstanceId: stateOne.match.battleInstanceId,
          requestRevision: stateOne.state.request.revision,
          choice: choiceOne.type === 'move'
            ? { type: 'move', slot: choiceOne.slot }
            : choiceOne.type === 'switch'
              ? { type: 'switch', slot: choiceOne.slot }
              : { type: choiceOne.type },
        });
        [stateOne, stateTwo] = await Promise.all(players.map(client => (
          client.waitFor<any>(message => message.type === 'match.update' || message.type === 'error')
        )));
        if (stateOne.type === 'error' || stateTwo.type === 'error') {
          throw new Error(`${stateOne.code ?? stateTwo.code}: ${stateOne.message ?? stateTwo.message}`);
        }
      }
      if (stateOne.match.status === 'completed' || stateTwo.match.status === 'completed') break;
      const choiceTwo = stateTwo.state?.request?.choices?.[0];
      if (choiceTwo) {
        players[1].send({
          type: 'match.choice',
          matchId: match.id,
          battleInstanceId: stateTwo.match.battleInstanceId,
          requestRevision: stateTwo.state.request.revision,
          choice: choiceTwo.type === 'move'
            ? { type: 'move', slot: choiceTwo.slot }
            : choiceTwo.type === 'switch'
              ? { type: 'switch', slot: choiceTwo.slot }
              : { type: choiceTwo.type },
        });
        [stateOne, stateTwo] = await Promise.all(players.map(client => (
          client.waitFor<any>(message => message.type === 'match.update' || message.type === 'error')
        )));
        if (stateOne.type === 'error' || stateTwo.type === 'error') {
          throw new Error(`${stateOne.code ?? stateTwo.code}: ${stateOne.message ?? stateTwo.message}`);
        }
      }
    }

    const resultA = await players[0].waitFor<any>(message => message.type === 'tournament.result', 20_000);
    const resultB = await players[1].waitFor<any>(message => message.type === 'tournament.result', 20_000);
    const resultOutsider = await outsider.waitFor<any>(message => message.type === 'tournament.result', 20_000);
    assert.equal(resultA.tournament.status, 'completed');
    assertOwnTeam(resultA.tournament, 'demo-player-1', TEAM_A_SECRETS);
    assertHidden(resultA, TEAM_B_SECRETS);
    assertOwnTeam(resultB.tournament, 'demo-player-2', TEAM_B_SECRETS);
    assertHidden(resultB, TEAM_A_SECRETS);
    assertHidden(resultOutsider, [...TEAM_A_SECRETS, ...TEAM_B_SECRETS]);
    assert.ok(resultA.payout);
    assert.equal(resultA.tournament.title, 'Private Builds');
  } finally {
    await Promise.all([...players, outsider].map(client => client.close()));
    await server.close();
  }
});

test('viewer serialization never copies another player build into a shared object', () => {
  const tournament = {
    id: 'cup',
    title: 'Cup',
    format: 'gen9ou' as const,
    maxPlayers: 4 as const,
    bracketSeed: 'default',
    matchTimeoutMs: 300_000,
    status: 'registration' as const,
    players: [
      {
        id: 'player-a' as any,
        displayName: 'player-a',
        team: DEMO_TEAM_ONE,
        eligible: true as const,
        status: 'registered' as const,
        registrationOrder: 0,
      },
      {
        id: 'player-b' as any,
        displayName: 'player-b',
        team: DEMO_TEAM_TWO,
        eligible: true as const,
        status: 'registered' as const,
        registrationOrder: 1,
      },
    ],
    matchIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const forA = publicTournamentForViewer(tournament as unknown as Tournament, 'player-a');
  const forB = publicTournamentForViewer(tournament as unknown as Tournament, 'player-b');
  const resultForA = { type: 'tournament.result', tournament: forA, payout: { amount: 1 } };
  const stateForB = { type: 'tournament.state', tournament: forB };
  assertHidden(stateForB, TEAM_A_SECRETS);
  assertHidden(resultForA, TEAM_B_SECRETS);
  assert.match(forA.players[0]?.team ?? '', /Great Tusk/);
  assert.equal(forA.players[1]?.team, undefined);
  assert.match(forB.players[1]?.team ?? '', /Samurott-Hisui/);
  assert.equal(forB.players[0]?.team, undefined);
  assert.equal(tournament.players[0]?.team.includes('Great Tusk'), true);
  assert.equal(tournament.players[1]?.team.includes('Samurott-Hisui'), true);
});

test('match.subscribe cannot bypass ready or locked-team requirements', async () => {
  const server = new ApiServer({ countdownMs: 0 });
  const port = await server.listen(0);
  const creatorKey = createSolanaKeypair();
  const opponentKey = createSolanaKeypair();
  const creator = new TestClient(port);
  const opponent = new TestClient(port);
  try {
    await Promise.all([creator.open(), opponent.open()]);
    await authenticate(creator, creatorKey);
    await authenticate(opponent, opponentKey);
    await server.economics.credit(creatorKey.address, DEFAULT_DEV_BALANCE_POKE);
    await server.economics.credit(opponentKey.address, DEFAULT_DEV_BALANCE_POKE);

    creator.send({
      type: 'casual.create',
      roomType: 'open',
      battleSize: '1v1',
      collateral: 1_000,
    });
    const created = await creator.waitFor<any>(message => message.type === 'casual.created');
    const roomId = created.room.id;
    const matchId = created.room.matchId;
    opponent.send({ type: 'casual.accept', roomId });
    await opponent.waitFor(message => message.type === 'casual.state' && message.room.status === 'full');

    creator.send({ type: 'match.subscribe', matchId });
    const premature = await creator.waitFor<any>(message => (
      message.type === 'match.subscribed' || message.type === 'error'
    ));
    if (premature.type === 'match.subscribed') {
      assert.notEqual(premature.match.status, 'active');
      assert.equal(premature.match.battleInstanceId, undefined);
    }
    creator.send({ type: 'casual.subscribe', roomId });
    const stillFull = await creator.waitFor<any>(message => (
      message.type === 'casual.state' && message.room.id === roomId
    ));
    assert.equal(stillFull.room.status, 'full');
    assert.equal(stillFull.room.teamPreview, undefined);

    creator.send({ type: 'casual.select', roomId, slots: [0, 1, 2], confirm: true });
    const prematureSelect = await creator.waitFor<any>(message => message.type === 'error');
    assert.equal(prematureSelect.code, 'CasualSelectionError');
    creator.send({ type: 'match.subscribe', matchId });
    await creator.waitFor(message => message.type === 'match.subscribed' || message.type === 'error');
    creator.send({ type: 'casual.subscribe', roomId });
    const onlyWaiting = await creator.waitFor<any>(message => (
      message.type === 'casual.state' && message.room.status !== 'battling'
    ));
    assert.notEqual(onlyWaiting.room.status, 'battling');

    opponent.send({ type: 'casual.ready', roomId, ready: true, team: DEMO_TEAM_TWO });
    const customTeam = await opponent.waitFor<any>(message => message.type === 'error');
    assert.equal(customTeam.code, 'CasualCustomTeamRejectedError');

    creator.send({ type: 'casual.ready', roomId, ready: true });
    opponent.send({ type: 'casual.ready', roomId, ready: true });
    await Promise.all([
      creator.waitFor(message => message.type === 'casual.state' && message.room.status === 'drafting'),
      opponent.waitFor(message => message.type === 'casual.state' && message.room.status === 'drafting'),
    ]);

    creator.send({ type: 'casual.select', roomId, slots: [0, 1, 2], confirm: true });
    await creator.waitFor(message => (
      message.type === 'casual.state' && message.room.ready[creatorKey.address] === true
    ));
    creator.send({ type: 'match.subscribe', matchId });
    const stillDrafting = await creator.waitFor<any>(message => (
      message.type === 'match.subscribed' || message.type === 'error'
    ));
    if (stillDrafting.type === 'match.subscribed') {
      assert.notEqual(stillDrafting.match.status, 'active');
    }

    opponent.send({ type: 'casual.select', roomId, slots: [0, 1, 2], confirm: true });
    await opponent.waitFor(message => (
      message.type === 'casual.state'
      && message.room.teamPreview?.every((preview: { confirmed?: boolean }) => preview.confirmed)
    ));
    creator.send({ type: 'match.subscribe', matchId });
    const started = await creator.waitFor<any>(message => message.type === 'match.subscribed');
    assert.equal(started.match.status, 'active');
    assert.ok(started.match.battleInstanceId);
    assert.equal(started.state.request.playerId, creatorKey.address);
  } finally {
    await creator.close();
    await opponent.close();
    await server.close();
  }
});
