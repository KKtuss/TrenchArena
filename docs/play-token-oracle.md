# Play-token USD holding check

The future Arena gate is denominated in USD: a wallet must hold at least a configured
dollar value of one SPL mint. The mint does not exist yet. Until `PLAY_TOKEN_MINT`
is set, this check stays idle and the rest of the API behaves as before.

The browser may display the result. It cannot supply the price, the balance, the
USD value, or the eligibility bit. Those are computed in `packages/api`.

This path is separate from the local POKE passport quote (`POKEARENA_POKE_PRICE_MICRO_USD`
/ the mock $0.40 quote). That quote is still what chain-economy uses for local
validator passport math. It is not a market price.

## Price provider

**Jupiter Price API v3** (`jupiter-price-v3`).

Jupiter prices a token by its mint address. It walks recent Solana DEX swaps back
to assets whose USD price comes from external oracles (SOL is the main anchor),
and it omits mints it will not stand behind (no trade in the last 7 days, or the
mint fails Jupiter's liquidity / organic-trading checks). The response is keyed by
the mint, so a ticker symbol is never part of the lookup.

| Environment | Request |
| --- | --- |
| No API key (development) | `GET https://lite-api.jup.ag/price/v3?ids=<mint>` |
| `JUPITER_API_KEY` or `PLAY_TOKEN_JUPITER_API_KEY` set | `GET https://api.jup.ag/price/v3?ids=<mint>` with header `x-api-key` |

`PLAY_TOKEN_PRICE_URL` overrides the base URL. The same API key header is still
sent when a key is set.

Fields used:

- `usdPrice` — USD per whole token. Read from the raw JSON number text, then floored to 18 decimal places.
- `liquidity` — total USD liquidity Jupiter reports. Prices below `PLAY_TOKEN_MIN_LIQUIDITY_USD` (default `1000`) are treated as unavailable.
- `blockId` — Solana block Jupiter associated with the quote. Returned as `priceBlockId`.
- `decimals` — hint only, returned as `priceDecimals`.

`createdAt` in the Jupiter payload is the token's creation time, not the quote time.
`priceTimestamp` is when this process observed the response.

Jupiter does not return a confidence interval. Liquidity and `blockId` are the
availability signals. A missing mint key, a non-positive price, a non-200 response,
or a network failure is **price unavailable**. The price is never invented and is
never reported as `$0`.

## Balance

`readSplBalance` in `packages/api/src/play-token-balance.ts` uses a Solana RPC
`Connection` from `@solana/web3.js`.

1. Load the mint account and require it to be owned by the SPL Token program or Token-2022.
2. Read `decimals` from that mint. Jupiter's decimal hint is not used for math.
3. Sum `tokenAmount.amount` (the raw integer string) across the wallet's token accounts for that mint.
4. For a Token-2022 mint, also scan Token-2022 accounts and ignore duplicate pubkeys.

The classic associated-token-account helper on `ArenaChainClient.getPokeBalance` is
not used here. That helper reads one associated account and turns RPC errors into a
zero balance. A failed read in this check is `rpc_error` and is not eligible.

RPC URL, first match wins:

1. `PLAY_TOKEN_RPC`
2. `POKEARENA_SOLANA_RPC`
3. `https://api.mainnet-beta.solana.com`

Set `PLAY_TOKEN_RPC` when the chain-economy RPC is still a local validator. An
existing `ArenaChainClient` connection is reused only when its endpoint is the same URL.

## USD value

```text
usdValue = floor(rawBalance * priceUsd / 10^decimals)
eligible = usdValue >= minimumUsd
```

The division is integer math at 18 decimal places. The raw balance is never
converted through a JavaScript number, and it is not rounded before the multiply.
Extra price digits past 18 places are dropped (floor), so a price cannot be rounded
up into eligibility. A missing price does not become `$0` and cannot pass.

`tokenBalance` and `usdValue` in the JSON result are exact decimal strings.

## Cache

In-memory, per API process, keyed by mint address.

| Outcome | Default TTL | Env |
| --- | --- | --- |
| Usable price | 30s | `PLAY_TOKEN_PRICE_CACHE_TTL_MS` |
| Not listed, thin liquidity, invalid price | 15s | `PLAY_TOKEN_PRICE_NEGATIVE_CACHE_TTL_MS` |
| Upstream HTTP/network failure | 5s | `PLAY_TOKEN_PRICE_UPSTREAM_CACHE_TTL_MS` |

A cache hit reuses the stored quote and sets `cacheHit: true`. After the TTL the
entry is dropped. A failed refresh does not fall back to an older price. Two
players asking about the same mint inside the TTL share one Jupiter request.
The cache is not shared across multiple API processes.

## Failure behavior

| Situation | `status` | `eligible` |
| --- | --- | --- |
| Price and balance both read, value meets the minimum | `ok` | `true` |
| Price and balance both read, value is short | `ok` | `false` (`below_threshold`) |
| Jupiter has no usable price, or liquidity is under the floor | `price_unavailable` | `false` |
| RPC error, or token-account decimals disagree with the mint | `rpc_error` | `false` |
| Mint or wallet is not a public key, or the minimum is not a positive USD amount | `invalid_request` | `false` |
| Public key exists but is not an SPL mint | `invalid_mint` | `false` |
| `PLAY_TOKEN_MINT` unset | `not_configured` | `false` |
| `PLAY_TOKEN_MINT` or `PLAY_TOKEN_MIN_USD` is set but invalid | `invalid_request` | `false` |

## Configuration

```text
PLAY_TOKEN_MINT=<SPL mint address>
PLAY_TOKEN_MIN_USD=20
```

Both can stay unset during development. `PLAY_TOKEN_MIN_USD` defaults to `20`
only once a mint is configured. `0` or a negative minimum is rejected.

Production should also set:

```text
PLAY_TOKEN_RPC=<dedicated mainnet RPC>
JUPITER_API_KEY=<key from the Jupiter portal>
PLAY_TOKEN_MIN_LIQUIDITY_USD=1000
```

Do not set `PLAY_TOKEN_ELIGIBILITY_DEBUG` in production.

## Arbitrary-mint debug route

`GET` or `POST /dev/token-holding`

Enabled only when both are true:

- `NODE_ENV` is not `production`
- `PLAY_TOKEN_ELIGIBILITY_DEBUG=true`

Otherwise the route is `404`. It does not sign a player in, change a session, or
open a match. Fields named `priceUsd`, `tokenBalance`, `usdValue`, and `eligible`
in the request are ignored.

```text
curl -s -X POST http://127.0.0.1:3000/dev/token-holding \
  -H 'content-type: application/json' \
  -d '{"mint":"<ANY_SPL_MINT>","wallet":"<WALLET>","minimumUsd":20}'
```

`400` means the request itself is invalid. `503` means Solana RPC failed.
`200` with `eligible: false` and `status: "price_unavailable"` means the price
could not be used. The game does not call this route.

The server-side function for the future gate is
`PlayTokenEligibilityService.checkConfiguredWallet(wallet)`. It reads
`PLAY_TOKEN_MINT` and `PLAY_TOKEN_MIN_USD` from the environment.

## Run the checks

Unit tests (no network):

```powershell
cd packages/api
npm run build
node --test --test-force-exit dist/test/play-token-eligibility.test.js
```

`npm test` also builds and runs this file with the rest of the API tests.
The mainnet test is skipped unless opted in.

Mainnet spot check against real mints (not a PokeArena token):

```powershell
cd packages/api
$env:PLAY_TOKEN_LIVE_TEST = '1'
$env:PLAY_TOKEN_RPC = 'https://api.mainnet-beta.solana.com'
npm run build
node --test --test-force-exit dist/test/play-token-live.test.js
```

The live test prices wrapped SOL, USDC, BONK, and PYUSD, checks a large holder
and an empty wallet, recomputes USD from the raw balance, and looks for a Solana
mint Jupiter will not price.

## Switch the provider later

Implement `TokenPriceOracle`:

```ts
interface TokenPriceOracle {
  getUsdPrice(mintAddress: string): Promise<TokenUsdPrice>;
}
```

Pass it to the service. The eligibility math, balance reader, cache policy, and
debug route stay as they are.

```ts
createPlayTokenEligibilityService({
  env: process.env,
  oracle: new OtherMintPriceOracle(),
});
```

`TokenUsdPrice.available` must be false when the provider will not name a price.
Do not return `priceUsd: "0"` for that case.

## Launch checklist

1. Create the PokeArena SPL mint. Do not point this config at a stand-in mint.
2. Confirm Jupiter Price API v3 returns a positive `usdPrice` for that mint and
   liquidity at or above `PLAY_TOKEN_MIN_LIQUIDITY_USD`.
3. Set `PLAY_TOKEN_MINT` to that mint and `PLAY_TOKEN_MIN_USD=20`.
4. Set `PLAY_TOKEN_RPC` to the production mainnet RPC.
5. Set `JUPITER_API_KEY` so production uses `api.jup.ag` instead of the public lite host.
6. Leave `PLAY_TOKEN_ELIGIBILITY_DEBUG` unset. Keep `NODE_ENV=production`.
7. Call `checkConfiguredWallet` from the server when the gate is turned on.
   Do not trust a client-reported price, balance, or eligibility flag.

## Limits

- The cache lives in one Node process.
- The public lite host is rate limited. Production should use an API key.
- A whole token cheaper than `10^-18` USD floors to a zero price and fails closed.
- A Token-2022 wallet whose full token-account list cannot be fetched fails closed
  rather than counting a partial balance.
- Jupiter's price is the last qualified swap, not a TWAP and not an execution quote.
- The holding check is not wired into casual or tournament entry yet.
