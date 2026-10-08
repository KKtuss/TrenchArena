import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ArenaApiClient,
  choiceFromAvailable,
  formatPoke,
  formatPokeFromAtoms,
  formatPokeAtomsValue,
  formatPokeValue,
  formatRoomAmount,
  formatSolLamports,
  formatSolLamportsValue,
  formatTournamentEntry,
  TOURNAMENT_BURN_FEE_ATOMS,
  TOURNAMENT_FIELD_BURN_FEE_ATOMS,
} from '../lib/api-client';

type FakeMessageEvent = { data: string };

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: FakeMessageEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as { type: string; requestId: string; address?: string };
    const response = message.type === 'auth.challenge'
      ? {
        type: 'auth.challenge',
        address: message.address,
        nonce: 'nonce',
        message: 'PokeArena login',
        expiresAt: Date.now() + 60_000,
      }
      : {
        type: 'auth.verified',
        playerId: message.address,
      };
    queueMicrotask(() => {
      this.onmessage?.({ data: JSON.stringify({ ...response, requestId: message.requestId }) });
    });
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

test('a server-replaced wallet session does not reconnect and re-prompt', async () => {
  const previousWebSocket = globalThis.WebSocket;
  Object.assign(globalThis, { WebSocket: FakeWebSocket });
  FakeWebSocket.instances = [];
  const client = new ArenaApiClient('ws://test/ws');

  try {
    await client.authenticateWallet({
      address: 'wallet-address',
      signMessage: async () => 'signature',
    });

    assert.equal(FakeWebSocket.instances.length, 1);
    const socket = FakeWebSocket.instances[0]!;
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'error',
        code: 'SessionReplacedError',
        message: 'This wallet authenticated from another connection.',
      }),
    });
    socket.onclose?.();

    await new Promise(resolve => setTimeout(resolve, 1_100));
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(client.connectionState, 'closed');
  } finally {
    client.close();
    Object.assign(globalThis, { WebSocket: previousWebSocket });
  }
});

test('formats mocked POKE values', () => {
  assert.equal(formatPoke(1000000), '1,000,000 POKE');
});

test('chain burn fees format raw atoms as whole POKE', () => {
  assert.equal(TOURNAMENT_BURN_FEE_ATOMS, 10_000_000_000);
  assert.equal(TOURNAMENT_FIELD_BURN_FEE_ATOMS, 320_000_000_000);
  assert.equal(formatPokeFromAtoms(TOURNAMENT_BURN_FEE_ATOMS), '10,000 POKE');
  assert.equal(formatPokeFromAtoms(TOURNAMENT_FIELD_BURN_FEE_ATOMS), '320,000 POKE');
  assert.equal(formatPokeFromAtoms(10_000), '0.01 POKE');
  assert.equal(formatPoke(TOURNAMENT_BURN_FEE_ATOMS), '10,000,000,000 POKE');
  assert.notEqual(formatPoke(TOURNAMENT_BURN_FEE_ATOMS), formatPokeFromAtoms(TOURNAMENT_BURN_FEE_ATOMS));
  assert.equal(formatTournamentEntry({
    rail: 'sol_chain',
    burnFeeAtoms: TOURNAMENT_BURN_FEE_ATOMS,
  }), '10,000 POKE');
  assert.equal(formatTournamentEntry({
    rail: 'sol_chain',
    burnFeeAtoms: 10_000,
  }), '0.01 POKE');
  assert.equal(formatTournamentEntry({
    rail: 'legacy_poke',
    entryFee: 50_000,
  }), '50,000 POKE');
});

test('room amounts use the room rail, never lamports as POKE', () => {
  assert.equal(formatRoomAmount(100_000, 'legacy_poke'), '100,000 POKE');
  assert.equal(formatRoomAmount(100_000), '100,000 POKE');
  assert.equal(formatRoomAmount(100_000_000, 'sol_chain'), '0.10 SOL');
  assert.equal(formatRoomAmount(196_000_000, 'sol_chain').includes('POKE'), false);
  assert.equal(formatRoomAmount(50_000_000, 'sol_chain'), '0.05 SOL');
  assert.equal(formatSolLamports(19_031_431), '0.02 SOL');
  assert.equal(formatSolLamports(1_000_000_000), '1.00 SOL');
});

test('compact balance values do not repeat their currency labels', () => {
  assert.equal(formatPokeValue(0), '0');
  assert.equal(formatPokeAtomsValue('1838457824085'), '1,838,457.824085');
  assert.equal(formatPoke(0), '0 POKE');
  assert.equal(formatSolLamportsValue(19_031_431), '0.02');
  assert.equal(formatSolLamports(19_031_431), '0.02 SOL');
});

test('serializes typed choices from available options', () => {
  assert.deepEqual(choiceFromAvailable({ type: 'team-preview' }), { type: 'team-preview' });
  assert.deepEqual(choiceFromAvailable({ type: 'move', slot: 2, terastallize: true }), {
    type: 'move',
    slot: 2,
    terastallize: true,
  });
  assert.deepEqual(choiceFromAvailable({ type: 'switch', slot: 3 }), { type: 'switch', slot: 3 });
  assert.deepEqual(choiceFromAvailable({ type: 'pass' }), { type: 'pass' });
});
