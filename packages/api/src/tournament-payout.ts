import type { ChainIntentRow, PostgresChainStore } from '@pokearena/db';

import { splitCardsPrize } from './tournament-cards-payout';

export type PrizePlace = 1 | 2 | 3;
export type PlacePayoutStatus = 'recorded' | 'submitted' | 'confirmed' | 'failed';

export interface PlacePayoutRecord {
  place: PrizePlace;
  playerId: string;
  amount: number;
  status: PlacePayoutStatus;
  signature?: string;
  /** Earlier signatures for this place, including a failed attempt that was reconciled. */
  previousSignatures: string[];
}

export interface PlacePayoutStore {
  load(place: PrizePlace): Promise<PlacePayoutRecord | undefined>;
  /**
   * Persist `record`. A confirmed row must ignore a later failed or different signature.
   */
  save(record: PlacePayoutRecord): Promise<void>;
}

export class PrizePayoutUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrizePayoutUnknownError';
  }
}

const inflight = new Map<string, Promise<PlacePayoutRecord[]>>();

export interface SettlePrizePlacesInput {
  lockKey: string;
  prizePool: number;
  recipients: Record<PrizePlace, string>;
  store: PlacePayoutStore;
  reconcile: (record: PlacePayoutRecord) => Promise<'confirmed' | 'failed' | 'unknown'>;
  /**
   * Sign the place transfer and return its signature before any network send.
   * The signature is stored before `broadcast`.
   */
  arm?: (record: PlacePayoutRecord) => Promise<{ signature: string }>;
  broadcast: (record: PlacePayoutRecord) => Promise<{
    signature?: string;
    outcome: 'confirmed' | 'failed' | 'unknown';
  }>;
}

/**
 * Pay 1st, 2nd, and 3rd exactly once. Same-process callers share one operation.
 * A submitted signature is reconciled before another broadcast. A confirmed
 * signature is never replaced.
 */
export function settlePrizePlaces(input: SettlePrizePlacesInput): Promise<PlacePayoutRecord[]> {
  const existing = inflight.get(input.lockKey);
  if (existing) return existing;
  const job = settlePrizePlacesLocked(input).finally(() => {
    if (inflight.get(input.lockKey) === job) inflight.delete(input.lockKey);
  });
  inflight.set(input.lockKey, job);
  return job;
}

async function settlePrizePlacesLocked(input: SettlePrizePlacesInput): Promise<PlacePayoutRecord[]> {
  const shares = splitCardsPrize(BigInt(input.prizePool));
  const amounts: Record<PrizePlace, number> = {
    1: Number(shares.first),
    2: Number(shares.second),
    3: Number(shares.third),
  };
  if (amounts[1] + amounts[2] + amounts[3] !== input.prizePool) {
    throw new Error('Tournament prize shares do not sum to the prize pool.');
  }
  const paid: PlacePayoutRecord[] = [];
  for (const place of [1, 2, 3] as const) {
    paid.push(await settlePlace(input, place, amounts[place], input.recipients[place]));
  }
  return paid;
}

async function settlePlace(
  input: SettlePrizePlacesInput,
  place: PrizePlace,
  amount: number,
  playerId: string,
): Promise<PlacePayoutRecord> {
  let record = await input.store.load(place);
  if (!record) {
    record = { place, playerId, amount, status: 'recorded', previousSignatures: [] };
    await input.store.save(record);
    record = (await input.store.load(place)) ?? record;
  }
  if (record.playerId !== playerId || record.amount !== amount) {
    throw new Error(`Prize place ${place} is already assigned to a different payout.`);
  }
  if (record.status === 'confirmed') return record;

  if (record.signature) {
    const outcome = await input.reconcile(record);
    if (outcome === 'unknown') {
      throw new PrizePayoutUnknownError(`Prize place ${place} signature is not confirmed yet.`);
    }
    if (outcome === 'confirmed') {
      const confirmed: PlacePayoutRecord = { ...record, status: 'confirmed' };
      await input.store.save(confirmed);
      return (await input.store.load(place)) ?? confirmed;
    }
    const previous = uniqueSignatures([...(record.previousSignatures ?? []), record.signature]);
    record = {
      place: record.place,
      playerId: record.playerId,
      amount: record.amount,
      status: 'failed',
      previousSignatures: previous,
    };
    await input.store.save(record);
    record = (await input.store.load(place)) ?? record;
    if (record.status === 'confirmed') return record;
  }

  if (amount === 0) {
    const confirmed: PlacePayoutRecord = { ...record, status: 'confirmed' };
    await input.store.save(confirmed);
    return (await input.store.load(place)) ?? confirmed;
  }

  const latest = await input.store.load(place);
  if (latest?.status === 'confirmed') return latest;
  let pending = latest ?? record;
  const signatureAlreadyStored = Boolean(pending.signature);
  if (input.arm && !pending.signature) {
    const armed = await input.arm(pending);
    const submitted: PlacePayoutRecord = {
      ...pending,
      status: 'submitted',
      signature: armed.signature,
      previousSignatures: pending.previousSignatures ?? [],
    };
    await input.store.save(submitted);
    pending = (await input.store.load(place)) ?? submitted;
    if (pending.status === 'confirmed') return pending;
  }
  if (signatureAlreadyStored && pending.signature && pending.status === 'submitted') {
    const outcome = await input.reconcile(pending);
    if (outcome === 'unknown') {
      throw new PrizePayoutUnknownError(`Prize place ${place} signature is not confirmed yet.`);
    }
    if (outcome === 'confirmed') {
      const confirmed: PlacePayoutRecord = { ...pending, status: 'confirmed' };
      await input.store.save(confirmed);
      return (await input.store.load(place)) ?? confirmed;
    }
  }

  const sent = await input.broadcast(pending);
  if (pending.signature && sent.signature && sent.signature !== pending.signature) {
    throw new Error(`Prize place ${place} broadcast replaced a signature that was already stored.`);
  }
  if (sent.signature) {
    const submitted: PlacePayoutRecord = {
      ...pending,
      status: 'submitted',
      signature: sent.signature,
      previousSignatures: pending.previousSignatures ?? [],
    };
    await input.store.save(submitted);
  }
  const stored = (await input.store.load(place)) ?? pending;
  if (stored.status === 'confirmed') return stored;
  if (stored.signature && stored.signature !== sent.signature && stored.status === 'submitted') {
    const outcome = await input.reconcile(stored);
    if (outcome === 'unknown') {
      throw new PrizePayoutUnknownError(`Prize place ${place} signature is not confirmed yet.`);
    }
    if (outcome === 'confirmed') {
      const confirmed: PlacePayoutRecord = { ...stored, status: 'confirmed' };
      await input.store.save(confirmed);
      return (await input.store.load(place)) ?? confirmed;
    }
  }
  const signature = stored.signature ?? sent.signature;
  if (sent.outcome === 'unknown' || (sent.outcome === 'confirmed' && !signature)) {
    throw new PrizePayoutUnknownError(`Prize place ${place} payout outcome is unknown.`);
  }
  if (sent.outcome === 'failed') {
    const failed: PlacePayoutRecord = {
      ...stored,
      status: 'failed',
      ...(signature ? { signature } : {}),
      previousSignatures: signature
        ? uniqueSignatures([...(stored.previousSignatures ?? []), signature])
        : (stored.previousSignatures ?? []),
    };
    await input.store.save(failed);
    throw new Error(`Prize place ${place} payout failed.`);
  }
  const confirmed: PlacePayoutRecord = {
    ...stored,
    status: 'confirmed',
    ...(signature ? { signature } : {}),
  };
  await input.store.save(confirmed);
  return (await input.store.load(place)) ?? confirmed;
}

function uniqueSignatures(values: readonly string[]): string[] {
  return [...new Set(values.filter(value => value.length > 0))];
}

/**
 * In-memory place ledger. A confirmed payout ignores a later failed write
 * and keeps the confirmed signature.
 */
export class MemoryPlacePayoutStore implements PlacePayoutStore {
  private readonly records = new Map<PrizePlace, PlacePayoutRecord>();

  async load(place: PrizePlace): Promise<PlacePayoutRecord | undefined> {
    const record = this.records.get(place);
    return record ? structuredClone(record) : undefined;
  }

  async save(record: PlacePayoutRecord): Promise<void> {
    const existing = this.records.get(record.place);
    if (existing?.status === 'confirmed') {
      if (
        record.status !== 'confirmed'
        || record.playerId !== existing.playerId
        || record.amount !== existing.amount
        || (record.signature && existing.signature && record.signature !== existing.signature)
      ) {
        return;
      }
    }
    if (
      existing?.signature
      && record.signature
      && existing.signature !== record.signature
      && existing.status !== 'failed'
      && record.status !== 'confirmed'
    ) {
      return;
    }
    this.records.set(record.place, structuredClone(record));
  }
}

export function chainPlaceStore(
  chainStore: PostgresChainStore,
  tournamentId: string,
): PlacePayoutStore {
  const scope = (place: PrizePlace) => `${tournamentId}:${place}`;
  const idempotencyKey = (place: PrizePlace) => `prize_pay:${tournamentId}:${place}`;

  return {
    async load(place) {
      const intent = await chainStore.getIntentByScope('prize_pay', scope(place));
      return intent ? recordFromIntent(place, intent) : undefined;
    },
    async save(record) {
      const existing = await chainStore.getIntentByScope('prize_pay', scope(record.place));
      if (existing?.status === 'confirmed') return;
      const intent = existing ?? await chainStore.createIntent({
        kind: 'prize_pay',
        scopeId: scope(record.place),
        playerId: record.playerId,
        asset: 'SOL',
        amount: record.amount,
        idempotencyKey: idempotencyKey(record.place),
        tournamentId,
        metadata: metadataFor(record),
      });
      if (intent.status === 'confirmed') return;
      if (intent.playerId && intent.playerId !== record.playerId) {
        throw new Error(`Prize place ${record.place} is already assigned to a different payout.`);
      }
      if (intent.amount !== record.amount) {
        throw new Error(`Prize place ${record.place} amount is already recorded.`);
      }
      const storedSignature = typeof intent.metadata.signature === 'string' ? intent.metadata.signature : '';
      if (
        storedSignature
        && record.signature
        && storedSignature !== record.signature
        && intent.metadata.settlementPhase !== 'failed'
        && record.status !== 'confirmed'
      ) {
        return;
      }
      await chainStore.mergeIntentMetadata(intent.id, metadataFor(record));
      if (record.status === 'confirmed') {
        await chainStore.setIntentStatus(intent.id, 'confirmed', {
          ...(record.signature ? { signature: record.signature } : {}),
        });
      } else if (record.status === 'submitted' || record.status === 'failed') {
        await chainStore.setIntentStatus(intent.id, 'pending', {
          ...(record.signature ? { signature: record.signature } : {}),
          ...(record.status === 'failed' ? { error: 'Prize place payout failed.' } : {}),
        });
      }
    },
  };
}

function metadataFor(record: PlacePayoutRecord): Record<string, unknown> {
  return {
    place: record.place,
    playerId: record.playerId,
    amount: record.amount,
    settlementPhase: record.status,
    previousSignatures: record.previousSignatures,
    ...(record.signature ? { signature: record.signature } : {}),
  };
}

function recordFromIntent(place: PrizePlace, intent: ChainIntentRow): PlacePayoutRecord {
  const phase = intent.metadata.settlementPhase;
  const status: PlacePayoutStatus = intent.status === 'confirmed'
    ? 'confirmed'
    : phase === 'submitted' || phase === 'failed' || phase === 'recorded'
      ? phase
      : intent.status === 'pending'
        ? 'submitted'
        : 'recorded';
  const signature = typeof intent.metadata.signature === 'string' ? intent.metadata.signature : undefined;
  const previous = Array.isArray(intent.metadata.previousSignatures)
    ? intent.metadata.previousSignatures.filter((value): value is string => typeof value === 'string')
    : [];
  return {
    place,
    playerId: intent.playerId ?? String(intent.metadata.playerId ?? ''),
    amount: intent.amount,
    status,
    ...(signature ? { signature } : {}),
    previousSignatures: previous,
  };
}
