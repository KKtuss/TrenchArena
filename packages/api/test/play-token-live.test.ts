import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Connection, Keypair, PublicKey } from '@solana/web3.js';

import { decimalToScaled, formatScaled, USD_PRICE_SCALE } from '../src/play-token-math';
import { createPlayTokenEligibilityService, type PlayTokenCheckResult } from '../src/play-token';

const LIVE = process.env.PLAY_TOKEN_LIVE_TEST === '1';
const RPC = process.env.PLAY_TOKEN_RPC?.trim() || 'https://api.mainnet-beta.solana.com';

/** Wrapped SOL, USDC, BONK, and PayPal USD. None of these is a PokeArena mint. */
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
/**
 * Token-2022 mint Jupiter was pricing from about $530 of liquidity on 2026-10-01,
 * under the default $1,000 floor. Re-checked at runtime in case that changes.
 */
const THIN_MINT = '6rmCU6X3XtasrTEdqQNnScAwgTJAP9eoaetWN56kzf4b';
/** Public hot wallet used only as a balance fixture. It holds USDC across many token accounts. */
const HOLDER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

function liveService() {
  return createPlayTokenEligibilityService({
    env: {
      PLAY_TOKEN_RPC: RPC,
      PLAY_TOKEN_MIN_LIQUIDITY_USD: '1000',
      PLAY_TOKEN_PRICE_CACHE_TTL_MS: '120000',
    },
  });
}

/** Independent floor(raw * price / 10^decimals) at 18 decimal places. */
function manualUsd(raw: bigint, priceUsd: string, decimals: number): string {
  const [whole = '0', frac = ''] = priceUsd.trim().split('.');
  const priceScaled = BigInt(`${whole}${frac.slice(0, USD_PRICE_SCALE).padEnd(USD_PRICE_SCALE, '0')}`);
  const usd = (raw * priceScaled) / (10n ** BigInt(decimals));
  return formatScaled(usd, USD_PRICE_SCALE);
}

test('mainnet mint prices, balances, and USD eligibility', { skip: !LIVE, timeout: 180_000 }, async () => {
  const service = liveService();
  const emptyWallet = Keypair.generate().publicKey.toBase58();
  const connection = new Connection(RPC, 'confirmed');

  const sol = await check(service, { mint: SOL, wallet: emptyWallet, minimumUsd: '20' });
  const usdc = await check(service, { mint: USDC, wallet: emptyWallet, minimumUsd: '20' });
  const bonkQuote = await check(service, { mint: BONK, wallet: emptyWallet, minimumUsd: '20' });
  const pyusd = await check(service, { mint: PYUSD, wallet: emptyWallet, minimumUsd: '20' });

  for (const quote of [sol, usdc, bonkQuote, pyusd]) {
    assert.equal(quote.status, 'ok', `${quote.mint} ${quote.status} ${quote.reason}`);
    assert.equal(quote.tokenBalance, '0');
    assert.equal(quote.usdValue, '0');
    assert.equal(quote.eligible, false);
    assert.equal(quote.priceSource, 'jupiter-price-v3');
    assert.ok(quote.priceUsd);
    assert.ok(quote.priceTimestamp);
  }
  assert.equal(sol.decimals, 9);
  assert.equal(usdc.decimals, 6);
  assert.equal(bonkQuote.decimals, 5);
  assert.equal(pyusd.decimals, 6);
  assert.equal(sol.priceDecimals, 9);
  assert.equal(usdc.priceDecimals, 6);
  assert.equal(bonkQuote.priceDecimals, 5);

  const solPrice = Number(sol.priceUsd);
  const usdcPrice = Number(usdc.priceUsd);
  const bonkPrice = Number(bonkQuote.priceUsd);
  const pyusdPrice = Number(pyusd.priceUsd);
  assert.ok(solPrice > 5 && solPrice < 100_000, `unexpected SOL price ${sol.priceUsd}`);
  assert.ok(usdcPrice > 0.9 && usdcPrice < 1.1, `unexpected USDC price ${usdc.priceUsd}`);
  assert.ok(pyusdPrice > 0.9 && pyusdPrice < 1.1, `unexpected PYUSD price ${pyusd.priceUsd}`);
  assert.ok(bonkPrice > 0 && bonkPrice < 0.01, `unexpected BONK price ${bonkQuote.priceUsd}`);
  assert.notEqual(sol.priceUsd, usdc.priceUsd);
  assert.notEqual(sol.priceUsd, bonkQuote.priceUsd);

  const cached = await check(service, { mint: USDC, wallet: emptyWallet, minimumUsd: '20' });
  assert.equal(cached.cacheHit, true);
  assert.equal(cached.priceUsd, usdc.priceUsd);
  assert.equal(cached.eligible, false);

  const usdcRaw = await summedRaw(connection, HOLDER, USDC);
  const usdcHeld = await check(service, { mint: USDC, wallet: HOLDER, minimumUsd: '20' });
  assert.equal(usdcHeld.status, 'ok', usdcHeld.reason);
  assert.equal(usdcHeld.cacheHit, true);
  assert.equal(usdcHeld.decimals, 6);
  assert.equal(usdcHeld.tokenBalanceRaw, usdcRaw);
  assert.equal(usdcHeld.priceUsd, usdc.priceUsd);
  assert.equal(usdcHeld.usdValue, manualUsd(BigInt(usdcRaw), usdc.priceUsd!, 6));
  assert.equal(usdcHeld.eligible, true);

  const above = await check(service, {
    mint: USDC,
    wallet: HOLDER,
    minimumUsd: bumpUsd(usdcHeld.usdValue!),
  });
  assert.equal(above.status, 'ok');
  assert.equal(above.tokenBalanceRaw, usdcRaw);
  assert.equal(above.eligible, false);
  assert.equal(above.reason, 'below_threshold');

  const bonkRaw = await summedRaw(connection, HOLDER, BONK);
  const bonkHeld = await check(service, { mint: BONK, wallet: HOLDER, minimumUsd: '20' });
  assert.equal(bonkHeld.status, 'ok', bonkHeld.reason);
  assert.equal(bonkHeld.decimals, 5);
  assert.equal(bonkHeld.tokenBalanceRaw, bonkRaw);
  assert.equal(bonkHeld.priceUsd, bonkQuote.priceUsd);
  assert.equal(bonkHeld.usdValue, manualUsd(BigInt(bonkRaw), bonkHeld.priceUsd!, 5));
  assert.ok(BigInt(bonkRaw) > BigInt(Number.MAX_SAFE_INTEGER));

  const solRaw = await summedRaw(connection, HOLDER, SOL);
  const solHeld = await check(service, { mint: SOL, wallet: HOLDER, minimumUsd: '20' });
  assert.equal(solHeld.status, 'ok', solHeld.reason);
  assert.equal(solHeld.decimals, 9);
  assert.equal(solHeld.tokenBalanceRaw, solRaw);
  assert.equal(solHeld.priceUsd, sol.priceUsd);
  assert.equal(solHeld.usdValue, manualUsd(BigInt(solRaw), solHeld.priceUsd!, 9));
  assert.notEqual(solHeld.tokenBalance, '0');
  assert.equal(solHeld.eligible, false);
  assert.equal(solHeld.reason, 'below_threshold');

  const notAMint = Keypair.generate().publicKey.toBase58();
  const missingAccount = await check(service, { mint: notAMint, wallet: emptyWallet, minimumUsd: '20' });
  assert.equal(missingAccount.status, 'invalid_mint');
  assert.equal(missingAccount.eligible, false);
  assert.equal(missingAccount.priceUsd, null);

  const thin = await check(service, { mint: THIN_MINT, wallet: emptyWallet, minimumUsd: '20' });
  const thinQuote = await jupiterQuote(THIN_MINT);
  const thinLiquidity = thinQuote ? Number(thinQuote.liquidity) : 0;
  if (!thinQuote || thinLiquidity < 1_000) {
    assert.equal(thin.status, 'price_unavailable', `${thin.status} ${thin.reason}`);
    assert.equal(thin.eligible, false);
    assert.equal(thin.priceUsd, null);
    assert.equal(thin.tokenBalance, '0');
    assert.equal(thin.decimals, 6);
  }

  console.log(JSON.stringify({
    sol: summary(sol),
    usdc: summary(usdc),
    bonk: summary(bonkQuote),
    pyusd: summary(pyusd),
    usdcHolder: summary(usdcHeld),
    usdcHolderAboveBalance: summary(above),
    bonkHolder: summary(bonkHeld),
    wrappedSolDust: summary(solHeld),
    thinMint: { ...summary(thin), jupiterLiquidity: thinQuote?.liquidity ?? null },
  }, null, 2));
});

async function check(
  service: ReturnType<typeof liveService>,
  input: { mint: string; wallet: string; minimumUsd: string },
): Promise<PlayTokenCheckResult> {
  let last: PlayTokenCheckResult | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await delay(1_000 * attempt);
    last = await service.check(input);
    if (last.status !== 'rpc_error') return last;
  }
  assert.fail(`RPC failed for ${input.mint}: ${last?.reason}`);
}

async function summedRaw(connection: Connection, owner: string, mint: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await delay(1_000 * attempt);
    try {
      const rows = await connection.getParsedTokenAccountsByOwner(
        new PublicKey(owner),
        { mint: new PublicKey(mint) },
        'confirmed',
      );
      let raw = 0n;
      for (const row of rows.value) {
        const amount = row.account.data.parsed.info.tokenAmount.amount as string;
        raw += BigInt(amount);
      }
      return raw.toString();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function jupiterQuote(mint: string): Promise<{ usdPrice?: number; liquidity?: number } | undefined> {
  const response = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`);
  if (!response.ok) return undefined;
  const body = await response.json() as Record<string, { usdPrice?: number; liquidity?: number }>;
  return body[mint];
}

function summary(checked: PlayTokenCheckResult) {
  return {
    mint: checked.mint,
    wallet: checked.wallet,
    tokenBalance: checked.tokenBalance,
    decimals: checked.decimals,
    priceUsd: checked.priceUsd,
    usdValue: checked.usdValue,
    minimumUsd: checked.minimumUsd,
    eligible: checked.eligible,
    priceSource: checked.priceSource,
    priceTimestamp: checked.priceTimestamp,
    priceBlockId: checked.priceBlockId,
    liquidityUsd: checked.liquidityUsd,
    cacheHit: checked.cacheHit,
    status: checked.status,
    reason: checked.reason,
  };
}

function bumpUsd(usd: string): string {
  const scaled = decimalToScaled(usd, USD_PRICE_SCALE)!;
  return formatScaled(scaled + 1n, USD_PRICE_SCALE);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
