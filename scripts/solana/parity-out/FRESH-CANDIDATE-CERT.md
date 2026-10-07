# Fresh Pinocchio candidate certification

Program ID: `6dHMWQd1M2ZZSmrkQLGZcFpHnvHi8rcH68QqQJ4Kj4r8`

HRN was not opened, upgraded, closed, or otherwise mutated. No mainnet SOL was spent.

## Artifact (clean local SBF, `--arch v0`)

| Field | Value |
| --- | --- |
| Git HEAD | `ff515028e350f1559d7561e831e59ec558a802e5` |
| Working tree | dirty (certification source is in the canonical repo, not committed) |
| ELF path | `target/deploy/arena_escrow_pinocchio.so` |
| ELF size | 131,408 bytes |
| ELF SHA-256 | `03154ec42a2cfc75866a5cf28cd27254d2c7cf63ee03910d415096027ef04837` |
| ProgramData length | 131,453 bytes (`ELF + 45`) |
| Rent RPC | `https://api.mainnet-beta.solana.com` |
| ProgramData rent (Mainnet RPC, 131,453 bytes) | 668,431,480 lamports (0.668431480 SOL) |
| Program account rent (Mainnet RPC, 36 bytes) | 833,120 lamports (0.000833120 SOL) |
| ELF machine / flags | `0x107` / `0x0` |
| Instruction-surface hash | `5c8f3d5854d1e434879875cc3534bbff6341d1e5f42ae754dae31e9086730ee0` |

This ELF supersedes the earlier 123,776-byte candidate (`e1ed97f9…`). Same program ID, new locally built bytes.

Rent values above were queried with `getMinimumBalanceForRentExemption` using
the exact ProgramData length and, separately, the 36-byte program account
length. The former 6,960-lamports/byte estimate is not used for Mainnet.

## Gates

- Rust unit tests: 6/6
- LiteSVM execution: 17/17 (`instruction-surface`, `cards-rail`, `sol-without-mint`, `pinocchio-abi-parity`)
- Corrupt-account fuzz: 640 cases, `unexpectedAccept=0`, `pinocchioMutatedOther=0`
- Explicit stale/wrong-owner rejects: 8/8 (config 273, match 102/101, entry 106, cards 131, classic SPL token owner, config System Program owner)
- CARDS regression: client frozen list (31) vs program dispatch; zero-account invoke of every `IX` discriminator must not return `invalid instruction data`

## Compatibility conclusions

### Entry escrow 138 bytes — REQUIRED CHANGE

Staging stores `burn_key` at 106–137. `close_final_entry` reads that stored key, closes the matching burn replay when status is Burned, and rejects a non-zero key on the Refunded path. The canonical TypeScript client exports `closeFinalEntryIx` with that replay account. A 106-byte account cannot hold the key. Fresh program uses 138 bytes.

### POKE deposit amount and mint checks — REQUIRED CHANGE (amount); staging security port (mint)

Canonical callers always deposit `TOURNAMENT_BURN_FEE_ATOMS` (10,000 POKE = 10,000,000,000 atoms): `packages/api/src/chain-economy.ts`, `packages/solana-client/src/poke-units.ts`. Allowing any positive amount would let a player under-deposit. Exact 10k-atom check is on `deposit_poke_entry` and `burn_poke_entry`.

Passport USD remains a separate off-chain check. On-chain POKE mint validation now matches staging: Token-2022, 6 decimals, initialized, bare 82-byte mint or launch MetadataPointer+TokenMetadata only. Classic SPL and TransferFee-style extensions are rejected. This does not change the 10k-atom economy.

### Missing instructions — REQUIRED CHANGE (ported)

`claim_operator_fees` and `close_final_entry` are on the canonical client surface. They were ported from staging Pinocchio `process.rs` / `cards.rs` (authority-only operator drain to the config authority; Token-2022 close of a zero-balance entry vault; burn replay close using the stored key). API does not currently call them; the client still can.

## Instruction surface (31)

SOL: initialize, create match, deposit wager, seat, refund, charge fee, settle win, settle tie, close settled match, treasury deposit, reserve/set/pay/release prize, claim operator fees.

POKE / Token-2022: set mint, deposit/refund/burn entry, close final entry, buyback and burn.

CARDS / classic SPL: set mint, fund, set winner, pay, release, fund from treasury, init reward vaults, claim operator, close final prize, claim fee vault.

A later fresh program that omits CARDS handlers fails `fresh program dispatches every canonical client discriminator` and the Rust `every_client_instruction_is_dispatched` test.

## Remaining differences vs staging Pinocchio

| Item | Class |
| --- | --- |
| CARDS handlers, discriminators, PDAs, Tokenkeg vs Token-2022 split | EXACT MATCH |
| `claim_operator_fees` / `close_final_entry` semantics | EXACT MATCH |
| Entry 138 + `burn_key`; match 133 + `settlement_key`; config 305 + `cards_mint` | EXACT MATCH |
| Replay kinds 0–10 | EXACT MATCH |
| Exact 10,000 POKE atoms + poke mint extension rules | EXACT MATCH |
| Client `MatchEscrowState` decoder ignores trailing `settlement_key` | INTENTIONAL DIFFERENCE (reads offsets 24–99 only; close uses the caller-supplied key) |
| API does not yet invoke `claimOperatorFees` / `closeFinalEntry` | INTENTIONAL DIFFERENCE (client still exports them; program implements them) |
| Program ID `6dHMWQ…` vs staging ID | INTENTIONAL DIFFERENCE (this candidate) |
| Helper names (`assert_token_program` = Token-2022 here) | INTENTIONAL DIFFERENCE (same checks) |
| Pinocchio 0.8.4 `slice_invoke_signed` vs staging invoke | INTENTIONAL DIFFERENCE (runtime adapter) |

No remaining BLOCKER on instruction existence, layouts, or economic checks.

## Reproducibility note

The certified ELF was built from the canonical repo working tree, not from VPS-only source. HEAD `ff515028` does not contain these files. Rebuilding the same bytes requires this working tree (or a later commit that includes it). No commit was created.
