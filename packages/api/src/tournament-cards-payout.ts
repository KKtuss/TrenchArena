/**
 * CARDS podium shares and one place transfer.
 * The signed transaction bytes are durable before broadcast.
 * The same bytes can be broadcast again. A different transfer is signed only
 * after the stored signature is confirmed not to have landed and cannot be replayed.
 */

export interface CardsPrizeShares {
  first: bigint;
  second: bigint;
  third: bigint;
}

export function splitCardsPrize(pool: bigint): CardsPrizeShares {
  if (pool < 0n) throw new Error('CARDS prize pool cannot be negative.');
  const first = (pool * 50n) / 100n;
  const second = (pool * 35n) / 100n;
  const third = pool - first - second;
  if (first + second + third !== pool) {
    throw new Error('CARDS prize shares do not sum to the prize pool.');
  }
  return { first, second, third };
}

export type CardsPlaceStatus = 'created' | 'pending' | 'confirmed' | 'failed' | 'expired' | 'cancelled';

export interface CardsPlaceIntent {
  id: string;
  status: CardsPlaceStatus;
  playerId?: string;
  amount: number;
  metadata: Record<string, unknown>;
}

export function metadataStringList(metadata: Record<string, unknown> | undefined, key: string): string[] {
  const value = metadata?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

export function metadataString(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : '';
}

export interface SignedCardsPlace {
  signature: string;
  serializedTx: string;
  lastValidBlockHeight?: number;
}

export type CardsSignatureOutcome = 'confirmed' | 'failed' | 'unknown';
export type CardsReplayResult = 'submitted' | 'expired' | 'failed';

/**
 * Decide what an existing place signature allows.
 * A signature without signed bytes was not proven to have been broadcast.
 * Those bytes are replayed while their blockhash can still land.
 */
export function cardsPlaceRecovery(input: {
  outcome: CardsSignatureOutcome;
  hasSignedTransaction: boolean;
  blockhashExpired: boolean;
  mayStillLand: boolean;
}): 'confirmed' | 'rebroadcast' | 'wait' | 'replace' {
  if (input.outcome === 'confirmed') return 'confirmed';
  if (input.outcome === 'failed') return 'replace';
  if (input.hasSignedTransaction && !input.blockhashExpired) return 'rebroadcast';
  if (input.hasSignedTransaction && input.blockhashExpired) return 'replace';
  if (input.mayStillLand) return 'wait';
  return 'replace';
}

/**
 * Pay one podium place from CARDS already collected to the keeper.
 * `submit` must persist the signed transaction before it broadcasts.
 * Recovery rebroadcasts those same bytes. It does not throw while that
 * transaction may still confirm, so boot can keep running.
 */
export async function settleCardsPlace(input: {
  place: 1 | 2 | 3;
  playerId: string;
  amount: bigint;
  loadOrCreate: () => Promise<CardsPlaceIntent>;
  remember: (intentId: string, patch: Record<string, unknown>) => Promise<void>;
  setStatus: (
    intentId: string,
    status: CardsPlaceStatus,
    signature?: string,
  ) => Promise<void>;
  reload: (intent: CardsPlaceIntent) => Promise<CardsPlaceIntent>;
  reconcile: (signature: string) => Promise<CardsSignatureOutcome>;
  /**
   * True when the stored blockhash can still be included.
   * A missing signed transaction is not replayable.
   */
  blockhashExpired?: (signature: string, serializedTx: string) => Promise<boolean>;
  /**
   * True when a signature with no stored bytes might still confirm.
   * False means it is absent from the ledger and too old to land.
   */
  mayStillLand?: (signature: string) => Promise<boolean>;
  rebroadcast?: (serializedTx: string) => Promise<CardsReplayResult>;
  submit: (persistSigned: (signed: SignedCardsPlace) => Promise<void>) => Promise<{
    status: 'confirmed' | 'failed' | 'pending' | 'expired';
    signature?: string;
    error?: string;
  }>;
}): Promise<void> {
  if (input.amount < 0n) throw new Error(`Prize place ${input.place} cannot be negative.`);
  if (input.amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Prize place ${input.place} exceeds a safe integer CARDS amount.`);
  }
  const amount = Number(input.amount);
  let intent = await input.loadOrCreate();
  if (intent.playerId && intent.playerId !== input.playerId) {
    throw new Error(`Prize place ${input.place} is already assigned to a different player.`);
  }
  if (intent.amount !== amount) {
    throw new Error(`Prize place ${input.place} amount is already recorded.`);
  }
  if (intent.status === 'confirmed') return;

  const storedSignature = metadataString(intent.metadata, 'signature');
  if (storedSignature) {
    const outcome = await input.reconcile(storedSignature);
    if (outcome === 'confirmed') {
      await input.setStatus(intent.id, 'confirmed', storedSignature);
      return;
    }
    const serializedTx = metadataString(intent.metadata, 'serializedTx');
    const blockhashExpired = serializedTx
      ? await input.blockhashExpired?.(storedSignature, serializedTx) ?? false
      : true;
    const mayStillLand = serializedTx
      ? false
      : await input.mayStillLand?.(storedSignature) ?? false;
    const action = cardsPlaceRecovery({
      outcome,
      hasSignedTransaction: serializedTx.length > 0,
      blockhashExpired,
      mayStillLand,
    });
    if (action === 'rebroadcast') {
      const replay = await input.rebroadcast?.(serializedTx) ?? 'submitted';
      const again = await input.reconcile(storedSignature);
      if (again === 'confirmed') {
        await input.setStatus(intent.id, 'confirmed', storedSignature);
        return;
      }
      if (again !== 'failed' && replay !== 'expired') return;
    } else if (action === 'wait') {
      return;
    }
    const previous = [...new Set([
      ...metadataStringList(intent.metadata, 'previousSignatures'),
      storedSignature,
    ])];
    await input.remember(intent.id, {
      previousSignatures: previous,
      signature: '',
      serializedTx: '',
      settlementPhase: outcome === 'failed' || action === 'replace' ? 'failed' : 'expired',
    });
    await input.setStatus(intent.id, 'failed', storedSignature);
    intent = await input.reload(intent);
    intent = {
      ...intent,
      status: 'failed',
      metadata: {
        ...intent.metadata,
        previousSignatures: previous,
        signature: '',
        serializedTx: '',
        settlementPhase: 'failed',
      },
    };
  }

  if (amount === 0) {
    await input.setStatus(intent.id, 'confirmed');
    return;
  }

  if (intent.status === 'failed' || intent.status === 'expired') {
    await input.setStatus(intent.id, 'pending');
    intent = await input.reload(intent);
  }

  const result = await input.submit(async signed => {
    if (!signed.signature || !signed.serializedTx) {
      throw new Error(`Prize place ${input.place} was signed without a replayable transaction.`);
    }
    await input.remember(intent.id, {
      signature: signed.signature,
      serializedTx: signed.serializedTx,
      ...(signed.lastValidBlockHeight === undefined
        ? {}
        : { lastValidBlockHeight: signed.lastValidBlockHeight }),
      settlementPhase: 'signed',
      signedAt: new Date().toISOString(),
    });
    await input.setStatus(intent.id, 'pending', signed.signature);
    intent = {
      ...intent,
      status: 'pending',
      metadata: {
        ...intent.metadata,
        signature: signed.signature,
        serializedTx: signed.serializedTx,
        ...(signed.lastValidBlockHeight === undefined
          ? {}
          : { lastValidBlockHeight: signed.lastValidBlockHeight }),
        settlementPhase: 'signed',
        signedAt: new Date().toISOString(),
      },
    };
  });

  if (result.status === 'confirmed') {
    const signature = result.signature || metadataString(intent.metadata, 'signature');
    if (!signature) throw new Error(`Prize place ${input.place} confirmed without a signature.`);
    await input.setStatus(intent.id, 'confirmed', signature);
    return;
  }
  if (result.status === 'pending' || result.status === 'expired' || result.status === 'failed') return;
  throw new Error(result.error ?? `Prize place ${input.place} payout was not confirmed.`);
}
