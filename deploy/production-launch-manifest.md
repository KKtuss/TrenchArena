# PokeArena production launch manifest

Recorded from the running staging host and from chain reads. No secrets are included. Secret configuration is provided separately through the server environment / secret store.

## Application

- Canonical Git commit: `bf130a91d0b90f0c64c44e173c0215e341c975c5`
- Git tag: `pokearena-staging-proven-2026-10-07`
- Tag object: `81a515686712a299f6f4283554d91d0d00d8493d`
- Running API Node: `v22.23.3`
- Host pnpm: `12.10.1`
- Clean reproduction build: Node `v22.18.0`, pnpm `12.6.0`

Proven runtime SHA-256:

| File | SHA-256 |
|---|---|
| `packages/api/dist/src/server.js` | `f1b4185f5c7a7d1f372738ca50da2af6a484eb795bf9796bfd2474d8bfed3dd6` |
| `packages/api/dist/src/chain-economy.js` | `98c86a84dcdd8d172d83a09292af095923b40d7fb4ab23654f14ee5d03b5bebd` |
| `packages/api/dist/src/tournament-cards-payout.js` | `a21ae5fedb28272345b9336edd58a28c05cd5413a28bc21a3c1b6bf5488a921e` |
| `packages/api/dist/src/creator-rewards.js` | `ae6890e8f76e8a4452f56c4f73011d9e9eb982d3701f136ba7f6066e7e309985` |
| `packages/api/dist/src/tournament-scheduler.js` | `085461ca0491ff11fe2ed66a85ec17e0fab32edc369ecfb73fe0094cce7e9254` |
| `packages/db/dist/src/tournament-completion.js` | `c8660f3ab3fa42111427432293fb99cd92f0697544cedceaa8725168b2cff93e` |
| `packages/tournament/dist/src/bracket.js` | `c4c5f47622499018c86b9d1cfc4cc61863efdc66e962e22ac398fefb33a6f236` |

A clean build of the tagged sources matched every hash above except `chain-economy.js`, which compiled to `550a9c03e8a0b6154b88a474d1ba1e84b2c5673714994235ce6562ac0f3cab30`. The web production bundle hash is UNKNOWN / NEEDS VERIFICATION. The clean Next.js build compiled successfully.

## On-chain

- Cluster: `mainnet-beta`
- Program: `HRN7567mTaH27Bhngu4Rg7JUQ8bvZp6Ymmf7XRT99rZk`
- ProgramData: `5FkXYdQpgNnB2bZDwKseH527ayArL4hM1jU3kTA1c6xb`
- Upgrade authority: `8C5oWBFxk4J57BXkHrSE1Dg2F7tkvsJrAWPLSSpLKFwC`
- Loader: `BPFLoaderUpgradeab1e11111111111111111111111`
- Deployed ELF SHA-256: `b40496e84cd4748b3530ef8769232dc4af9be992812ad78151693a679e30db90`
- ELF size: 120160 bytes
- ProgramData account size: 120205 bytes
- Last deploy slot: `453995537`
- Last deployed at: `2026-10-06T19:29:43.000Z`
- Deploy signature: `4Vctso86gBzpMxYrN7v1UHJpPX9rx8fGyHVUmKswfx52zy6TXRovnvsRxQysbkTk1gCXXRyybJAXy6Rd2HCjbSPq`
- Archive: `deploy/program-archive/HRN7567mTaH27Bhngu4Rg7JUQ8bvZp6Ymmf7XRT99rZk/arena_escrow.so`

## Config

These addresses were derived from the program and then read from the on-chain config account. They match the public server configuration.

| Role | Address |
|---|---|
| Config | `GmXeZM9hb1aoAFNEnhexWkwWrLCppKFRfpwdqVxtCED5` |
| Config authority | `67sQcfcocfoq91oHZKxPZyiGndQvSgNfu2UmmNuRbFGi` |
| Quote authority | `67sQcfcocfoq91oHZKxPZyiGndQvSgNfu2UmmNuRbFGi` |
| Keeper | `DFo1hqiFQ5crfZrrUVfV82RputSKPevRsZjNDwCfs6Co` |
| Fee vault | `FemDYs5uiiTCdCmM1ftX4UN7NQXWD5ro3Zteb8ppXYv5` |
| Treasury vault | `CgzKZ6n2mLBtQSeh2VVPeEYZdrio5zMw3LzqU8tzza9N` |
| Operator vault | `CBX2c86gumyCU4TfpMjE78suhFG6yvP8CwTDJuHRe1Hf` |
| CARDS mint | `CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp` |
| POKE mint | `4oc27vsDaJeYhbhUybhhoPrjxobDzgPgKpZEMWwWpump` |

On-chain rates: fee 200 bps, treasury 9000 bps, operator 1000 bps, buyback 0, minimum buyback 50000000 lamports.

## Database

Migration level: `016_tournament_scheduler.sql`.

Applied: `001` through `016`, in filename order.

Database rows are runtime state. Git can recreate the schema. It does not recreate the live rows.

Scheduler, read from the live row:

- enabled: `false`
- next_tournament_start_at: `null`
- next_rotation_index: `0`

## Application behavior

Chain cups pay CARDS. The vault is collected once to the keeper, then split 50/35/15. A two-player cup with no third-place match uses `payTournamentCardsPrize`. There is no SOL tournament prize method on this path.

`sol_chain` remains the 1v1 SOL rail and the chain-cup rail name. The 1v1 fee is 2%.

Rotation indexes 0, 1, and 2 are 16-player events. Later indexes are 32-player events.

The scheduler is disabled until explicitly enabled. Enabling sets one start anchor 30 minutes ahead.

Creator rewards split CARDS creator fees 90% to the tournament share and 10% to the operator. The default poll is 60 seconds. The signer is provided separately through the server environment / secret store.

The POKE passport minimum is 5.00 USD.

Place recovery stores the signed transaction before broadcast. The same bytes are rebroadcast while they can still land. A new place transfer is signed only after the stored signature is confirmed not to have landed.

## Recorded differences

`Anchor.toml` in the tagged commit names `26fttiarz4KzXfcyB5W24WfXpMw8UqZHqKoTF9wWm2Ke`. That is not the deployed program. The application client names `HRN7567mTaH27Bhngu4Rg7JUQ8bvZp6Ymmf7XRT99rZk`. The dirty working copy of `Anchor.toml` names `41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W`, which is also not the deployed program. Neither Anchor value was tagged as the program id.

The running `chain-economy.js` and a clean compile of the tagged source differ by one persistence check: the running file keeps `lastValidBlockHeight` only when `Number.isFinite` is true. The tagged source keeps it when the field is not `undefined`. The other recorded runtime files match the clean build.
