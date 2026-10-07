import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';

import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@pokearena/solana-client';

import { TOKEN_2022_PROGRAM_ID, type SplBalanceConnection } from '../src/play-token-balance';
import {
  canonicalizeDecimal,
  decimalToScaled,
  formatTokenAmount,
  USD_PRICE_SCALE,
} from '../src/play-token-math';
import {
  JupiterTokenPriceOracle,
  type PriceFetcher,
  type TokenUsdPrice,
} from '../src/play-token-oracle';
import {
  createPlayTokenEligibilityService,
  DEFAULT_PLAY_TOKEN_MIN_USD,
  loadPlayTokenConfig,
  PlayTokenEligibilityService,
  type PlayTokenCheckResult,
} from '../src/play-token';
import { ApiServer } from '../src/server';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function jupiterBody(mint: string, usdPrice: string, liquidity = '5000000.25', decimals = 6): string {
  return `{"${mint}":{"createdAt":"2024-06-05T08:55:25.527Z","liquidity":${liquidity},"usdPrice":${usdPrice},"blockId":42,"decimals":${decimals},"priceChange24h":0}}`;
}

function fetcherReturning(body: string, status = 200): PriceFetcher & { calls: string[] } {
  const calls: string[] = [];
  const fetcher: PriceFetcher & { calls: string[] } = async (url) => {
    calls.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    };
  };
  fetcher.calls = calls;
  return fetcher;
}

function mintAccount(decimals: number, owner: PublicKey = TOKEN_PROGRAM_ID) {
  return {
    value: {
      owner,
      data: { parsed: { type: 'mint', info: { decimals } } },
    },
  };
}

function tokenAccount(mint: string, amount: string, decimals: number, pubkey: PublicKey) {
  return {
    pubkey,
    account: {
      data: {
        parsed: {
          type: 'account',
          info: {
            mint,
            tokenAmount: { amount, decimals, uiAmount: null },
          },
        },
      },
    },
  };
}

function fakeConnection(input: {
  decimals?: number;
  owner?: PublicKey;
  accounts?: Array<{ amount: string; pubkey?: PublicKey; decimals?: number }>;
  token2022Accounts?: Array<{ amount: string; pubkey?: PublicKey; decimals?: number }>;
  fail?: 'mint' | 'accounts' | 'token2022';
}): SplBalanceConnection & { programScans: number } {
  const decimals = input.decimals ?? 6;
  const owner = input.owner ?? TOKEN_2022_PROGRAM_ID;
  let programScans = 0;
  const connection: SplBalanceConnection & { programScans: number } = {
    programScans: 0,
    async getParsedAccountInfo() {
      if (input.fail === 'mint') throw new Error('rpc down');
      return mintAccount(decimals, owner);
    },
    async getParsedTokenAccountsByOwner(_wallet, filter) {
      if ('programId' in filter) {
        programScans += 1;
        connection.programScans = programScans;
        if (input.fail === 'token2022') throw new Error('rpc down');
        const rows = input.token2022Accounts
          ?? (owner.equals(TOKEN_2022_PROGRAM_ID) ? input.accounts ?? [] : []);
        return {
          value: rows.map(account => tokenAccount(
            MINT,
            account.amount,
            account.decimals ?? decimals,
            account.pubkey ?? Keypair.generate().publicKey,
          )),
        };
      }
      if (input.fail === 'accounts') throw new Error('rpc down');
      return {
        value: (input.accounts ?? []).map(account => tokenAccount(
          MINT,
          account.amount,
          account.decimals ?? decimals,
          account.pubkey ?? Keypair.generate().publicKey,
        )),
      };
    },
  };
  return connection;
}

function serviceWith(input: {
  body?: string;
  status?: number;
  connection?: SplBalanceConnection;
  minLiquidityUsd?: number;
  now?: () => number;
  cacheTtlMs?: number;
  fetcher?: PriceFetcher;
}): { service: PlayTokenEligibilityService; fetcher: PriceFetcher & { calls: string[] } } {
  const fetcher = (input.fetcher as PriceFetcher & { calls: string[] } | undefined)
    ?? fetcherReturning(input.body ?? jupiterBody(MINT, '0.42'), input.status ?? 200);
  const oracle = new JupiterTokenPriceOracle({
    endpoint: 'https://lite-api.jup.ag/price/v3',
    headers: {},
    minLiquidityUsd: input.minLiquidityUsd ?? 1_000,
    cacheTtlMs: input.cacheTtlMs ?? 30_000,
    negativeCacheTtlMs: 15_000,
    upstreamCacheTtlMs: 5_000,
    fetcher,
    now: input.now,
  });
  const config = loadPlayTokenConfig({});
  const service = new PlayTokenEligibilityService(
    oracle,
    input.connection ?? fakeConnection({ accounts: [{ amount: '123450000' }] }),
    config,
  );
  return { service, fetcher };
}

test('decimal helpers keep low SPL prices and do not use scientific notation', () => {
  assert.equal(canonicalizeDecimal('1.23e-7'), '0.000000123');
  assert.equal(canonicalizeDecimal('0.000003781073768022567'), '0.000003781073768022567');
  assert.equal(formatTokenAmount(123450000n, 6), '123.45');
  assert.equal(formatTokenAmount(1n, 6), '0.000001');
  const scaled = decimalToScaled('0.000003781073768022567', USD_PRICE_SCALE);
  assert.equal(scaled, 3781073768022n);
});

test('eligibility uses the full token amount and floors USD instead of rounding up', async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const { service } = serviceWith({
    connection: fakeConnection({ accounts: [{ amount: '123450000' }] }),
  });
  const held = await service.check({ mint: MINT, wallet, minimumUsd: '20' });
  assert.equal(held.status, 'ok');
  assert.equal(held.tokenBalance, '123.45');
  assert.equal(held.priceUsd, '0.42');
  assert.equal(held.usdValue, '51.849');
  assert.equal(held.eligible, true);
  assert.equal(held.priceSource, 'jupiter-price-v3');
  assert.equal(held.cacheHit, false);
  assert.equal(held.decimals, 6);

  const exact = await service.check({ mint: MINT, wallet, minimumUsd: '51.849' });
  assert.equal(exact.eligible, true);
  assert.equal(exact.cacheHit, true);

  const above = await service.check({ mint: MINT, wallet, minimumUsd: '51.849000000000000001' });
  assert.equal(above.eligible, false);
  assert.equal(above.reason, 'below_threshold');
});

test('a one-base-unit balance is not rounded away before the USD check', async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const { service } = serviceWith({
    body: jupiterBody(MINT, '20000000'),
    connection: fakeConnection({ accounts: [{ amount: '1' }] }),
  });
  const held = await service.check({ mint: MINT, wallet, minimumUsd: 20 });
  assert.equal(held.tokenBalance, '0.000001');
  assert.equal(held.usdValue, '20');
  assert.equal(held.eligible, true);
});

test('sub-micro prices still count when the balance is large', async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const { service } = serviceWith({
    body: jupiterBody(MINT, '0.000000000123', '2000'),
    connection: fakeConnection({ decimals: 0, accounts: [{ amount: '1000000000000' }] }),
  });
  const held = await service.check({ mint: MINT, wallet, minimumUsd: '100' });
  assert.equal(held.tokenBalance, '1000000000000');
  assert.equal(held.usdValue, '123');
  assert.equal(held.eligible, true);
  const short = await service.check({ mint: MINT, wallet, minimumUsd: '200' });
  assert.equal(short.eligible, false);
});

test('raw balances outside Number.MAX_SAFE_INTEGER stay exact', async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const raw = 10000000000000000001n;
  const { service } = serviceWith({
    body: jupiterBody(MINT, '1'),
    connection: fakeConnection({ accounts: [{ amount: raw.toString() }] }),
  });
  const held = await service.check({ mint: MINT, wallet, minimumUsd: '20' });
  assert.equal(held.tokenBalance, '10000000000000.000001');
  assert.equal(held.tokenBalanceRaw, raw.toString());
  assert.equal(held.usdValue, '10000000000000.000001');
  assert.equal(held.eligible, true);
});

test('token accounts for the same mint are summed and deduped', async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const shared = Keypair.generate().publicKey;
  const connection = fakeConnection({
    decimals: 0,
    owner: TOKEN_2022_PROGRAM_ID,
    accounts: [{ amount: '10', pubkey: shared }],
    token2022Accounts: [
      { amount: '10', pubkey: shared },
      { amount: '5', pubkey: Keypair.generate().publicKey },
    ],
  });
  const { service } = serviceWith({
    body: jupiterBody(MINT, '2'),
    connection,
  });
  const held = await service.check({ mint: MINT, wallet, minimumUsd: '20' });
  assert.equal(connection.programScans, 1);
  assert.equal(held.tokenBalanceRaw, '15');
  assert.equal(held.usdValue, '30');
  assert.equal(held.eligible, true);

  const classic = fakeConnection({
    decimals: 0,
    owner: TOKEN_PROGRAM_ID,
    accounts: [{ amount: '1' }, { amount: '2' }],
  });
  const classicService = serviceWith({
    body: jupiterBody(MINT, '1'),
    connection: classic,
  }).service;
  const rejected = await classicService.check({ mint: MINT, wallet, minimumUsd: '2' });
  assert.equal(classic.programScans, 0);
  assert.equal(rejected.eligible, false);
  assert.equal(rejected.status, 'invalid_mint');
  assert.equal(rejected.reason, 'not_mint');
});

test('Token-2022 passport uses the Token-2022 scan and ignores a classic mint filter', async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const connection = fakeConnection({
    owner: TOKEN_2022_PROGRAM_ID,
    accounts: [{ amount: '999000000000' }],
    token2022Accounts: [{ amount: '5000000' }],
  });
  const { service } = serviceWith({
    body: jupiterBody(MINT, '1'),
    connection,
  });
  const held = await service.check({ mint: MINT, wallet, minimumUsd: DEFAULT_PLAY_TOKEN_MIN_USD });
  assert.equal(connection.programScans, 1);
  assert.equal(held.tokenBalanceRaw, '5000000');
  assert.equal(held.decimals, 6);
  assert.equal(held.eligible, true);

  const classicOnly = fakeConnection({
    owner: TOKEN_2022_PROGRAM_ID,
    accounts: [{ amount: '5000000' }],
    token2022Accounts: [],
  });
  const missed = await serviceWith({
    body: jupiterBody(MINT, '1'),
    connection: classicOnly,
  }).service.check({ mint: MINT, wallet, minimumUsd: DEFAULT_PLAY_TOKEN_MIN_USD });
  assert.equal(classicOnly.programScans, 1);
  assert.equal(missed.tokenBalanceRaw, '0');
  assert.equal(missed.eligible, false);
});

test('passport accepts exactly the configured USD minimum and rejects less', async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const { service } = serviceWith({
    body: jupiterBody(MINT, '1'),
    connection: fakeConnection({ accounts: [{ amount: '5000000' }] }),
  });
  const exact = await service.check({ mint: MINT, wallet, minimumUsd: DEFAULT_PLAY_TOKEN_MIN_USD });
  assert.equal(exact.eligible, true);
  assert.equal(exact.usdValue, '5');
  const short = serviceWith({
    body: jupiterBody(MINT, '1'),
    connection: fakeConnection({ accounts: [{ amount: '4999999' }] }),
  });
  const under = await short.service.check({ mint: MINT, wallet, minimumUsd: DEFAULT_PLAY_TOKEN_MIN_USD });
  assert.equal(under.eligible, false);
  const over = serviceWith({
    body: jupiterBody(MINT, '1'),
    connection: fakeConnection({ accounts: [{ amount: '5000001' }] }),
  });
  const above = await over.service.check({ mint: MINT, wallet, minimumUsd: DEFAULT_PLAY_TOKEN_MIN_USD });
  assert.equal(above.eligible, true);
  assert.equal(DEFAULT_PLAY_TOKEN_MIN_USD, '5.00');
});

test('missing, thin, and failed prices do not grant eligibility', async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const connection = fakeConnection({ accounts: [{ amount: '1000000000' }] });

  const missing = serviceWith({ body: '{}', connection });
  const unavailable = await missing.service.check({ mint: MINT, wallet, minimumUsd: '20' });
  assert.equal(unavailable.status, 'price_unavailable');
  assert.equal(unavailable.reason, 'not_listed');
  assert.equal(unavailable.priceUsd, null);
  assert.equal(unavailable.usdValue, null);
  assert.equal(unavailable.eligible, false);
  assert.equal(unavailable.tokenBalance, '1000');

  const thin = serviceWith({
    body: jupiterBody(MINT, '10', '12.5'),
    connection,
  });
  const rejected = await thin.service.check({ mint: MINT, wallet, minimumUsd: '20' });
  assert.equal(rejected.reason, 'thin_liquidity');
  assert.equal(rejected.priceUsd, null);
  assert.equal(rejected.eligible, false);

  const zero = serviceWith({
    body: jupiterBody(MINT, '0', '5000'),
    connection,
  });
  const invalid = await zero.service.check({ mint: MINT, wallet, minimumUsd: '20' });
  assert.equal(invalid.reason, 'invalid_price');
  assert.equal(invalid.eligible, false);

  const down = serviceWith({ body: '{}', status: 503, connection });
  const upstream = await down.service.check({ mint: MINT, wallet, minimumUsd: '20' });
  assert.equal(upstream.reason, 'upstream_error');
  assert.equal(upstream.priceUsd, null);
  assert.equal(upstream.eligible, false);
});

test('RPC failure is explicit and a zero balance is not eligible', async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const rpc = serviceWith({
    connection: fakeConnection({ fail: 'mint', accounts: [{ amount: '999' }] }),
  });
  const failed = await rpc.service.check({ mint: MINT, wallet, minimumUsd: '20' });
  assert.equal(failed.status, 'rpc_error');
  assert.equal(failed.eligible, false);
  assert.equal(failed.tokenBalance, null);

  const empty = serviceWith({
    connection: fakeConnection({ accounts: [] }),
  });
  const none = await empty.service.check({ mint: MINT, wallet, minimumUsd: '20' });
  assert.equal(none.status, 'ok');
  assert.equal(none.tokenBalance, '0');
  assert.equal(none.usdValue, '0');
  assert.equal(none.priceUsd, '0.42');
  assert.equal(none.eligible, false);
  assert.equal(none.reason, 'below_threshold');
});

test('an address that is not a mint does not receive a price or eligibility', async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey;
  const connection: SplBalanceConnection = {
    async getParsedAccountInfo() {
      return { value: null };
    },
    async getParsedTokenAccountsByOwner() {
      throw new Error('should not list accounts');
    },
  };
  const { service } = serviceWith({ connection });
  const checked = await service.check({
    mint: mint.toBase58(),
    wallet,
    minimumUsd: '20',
  });
  assert.equal(checked.status, 'invalid_mint');
  assert.equal(checked.eligible, false);
  assert.equal(checked.priceUsd, null);
});

test('the price cache is shared by mint and does not keep a stale success after TTL', async () => {
  let now = 1_000_000;
  const fetch = fetcherReturning(jupiterBody(MINT, '0.42'));
  const { service } = serviceWith({
    fetcher: fetch,
    now: () => now,
    cacheTtlMs: 30_000,
    connection: fakeConnection({ accounts: [{ amount: '100000000' }] }),
  });
  const wallet = Keypair.generate().publicKey.toBase58();
  const first = await service.check({ mint: MINT, wallet, minimumUsd: '20' });
  const second = await service.check({ mint: MINT, wallet, minimumUsd: '20' });
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(second.priceUsd, first.priceUsd);
  assert.equal(fetch.calls.length, 1);
  assert.match(fetch.calls[0]!, new RegExp(MINT));
  now += 30_000;
  const third = await service.check({ mint: MINT, wallet, minimumUsd: '20' });
  assert.equal(third.cacheHit, false);
  assert.equal(fetch.calls.length, 2);
});

test('PLAY_TOKEN_MINT is optional and a bad value does not grant access', async () => {
  let fetched = false;
  const oracle = {
    async getUsdPrice(): Promise<TokenUsdPrice> {
      fetched = true;
      throw new Error('should not fetch');
    },
  };
  const balances: SplBalanceConnection = {
    async getParsedAccountInfo() {
      throw new Error('should not read rpc');
    },
    async getParsedTokenAccountsByOwner() {
      throw new Error('should not read rpc');
    },
  };
  const wallet = Keypair.generate().publicKey.toBase58();
  const unset = new PlayTokenEligibilityService(oracle, balances, loadPlayTokenConfig({}));
  const missing = await unset.checkConfiguredWallet(wallet);
  assert.equal(missing.status, 'not_configured');
  assert.equal(missing.eligible, false);
  assert.equal(fetched, false);

  const invalid = new PlayTokenEligibilityService(
    oracle,
    balances,
    loadPlayTokenConfig({ PLAY_TOKEN_MINT: 'not-a-mint', PLAY_TOKEN_MIN_USD: '20' }),
  );
  const bad = await invalid.checkConfiguredWallet(wallet);
  assert.equal(bad.status, 'invalid_request');
  assert.equal(bad.eligible, false);
  assert.equal(fetched, false);
});

test('the debug route ignores client price, balance, and eligibility', async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const { service } = serviceWith({
    connection: fakeConnection({ accounts: [{ amount: '0' }] }),
  });
  const server = new ApiServer({
    allowDemoAuth: false,
    originMode: 'development',
    playToken: service,
    playTokenDebug: true,
    nodeEnv: 'development',
  });
  const port = await server.listen(0);
  try {
    const response = await httpJson(port, {
      mint: MINT,
      wallet,
      minimumUsd: 20,
      priceUsd: 999,
      tokenBalance: 1_000_000,
      usdValue: 999_999,
      eligible: true,
    });
    assert.equal(response.status, 200);
    const body = response.body as PlayTokenCheckResult;
    assert.equal(body.eligible, false);
    assert.equal(body.tokenBalance, '0');
    assert.equal(body.priceUsd, '0.42');
    assert.equal(body.usdValue, '0');
    assert.equal(body.reason, 'below_threshold');
  } finally {
    await server.close();
  }
});

test('the debug route is absent unless explicitly enabled, including in production', async () => {
  const { service } = serviceWith({});
  const disabled = new ApiServer({
    allowDemoAuth: true,
    originMode: 'development',
    playToken: service,
    playTokenDebug: false,
    nodeEnv: 'development',
  });
  const production = new ApiServer({
    allowDemoAuth: false,
    originMode: 'development',
    allowedOrigins: ['http://localhost'],
    playToken: service,
    playTokenDebug: true,
    nodeEnv: 'production',
  });
  const disabledPort = await disabled.listen(0);
  const productionPort = await production.listen(0);
  try {
    const off = await httpJson(disabledPort, { mint: MINT, wallet: MINT, minimumUsd: 20 });
    const prod = await httpJson(productionPort, { mint: MINT, wallet: MINT, minimumUsd: 20 });
    assert.equal(off.status, 404);
    assert.equal(prod.status, 404);
  } finally {
    await disabled.close();
    await production.close();
  }
});

function httpJson(port: number, payload: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/dev/token-holding',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode ?? 0,
          body: text.startsWith('{') ? JSON.parse(text) : text,
        });
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });
}
