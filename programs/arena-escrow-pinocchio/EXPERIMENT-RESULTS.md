# Pinocchio parity experiment results

Date: 2026-10-03  
Anchor reference left unmodified at `programs/arena-escrow`.

## Artifacts

| Build | Path | Bytes | SHA256 |
| --- | --- | --- | --- |
| Anchor (baseline) | `target/deploy/arena_escrow.so` | 419,736 | `bbf82458047bcc15db2f49fc50327acad330fdd78dc6a16efe4edd966a09aac1` |
| Pinocchio | `target/deploy/arena_escrow_pinocchio.so` | 75,016 | `84b834241b0baf6fbf36b63f59bb09449e4b7e1862704345c9922466324a92e5` |

Pinocchio ELF sections (deploy artifact):

```text
.text         69,192
.rodata          761
.data.rel.ro     648
.rel.dyn       3,008
```

## ProgramData rent (6960 lamports / byte for 2-year exemption)

Formula: `(binary_bytes + 45 + 128) * 6960`

| Implementation | ProgramData lamports | SOL |
| --- | ---: | ---: |
| Anchor | 2,922,566,640 | 2.92256664 |
| Pinocchio | 523,315,440 | 0.52331544 |
| **Saved** | **2,399,251,200** | **2.39925120** |

On-chain confirmation from local genesis load (`solana program show`):

```text
Data Length: 75016 bytes
Balance: 0.52331544 SOL
```

Size reduction: **344,720 bytes (82.1% smaller)**.

## Parity validation

Offline ABI fixtures (`pinocchio-abi-parity.test.ts`): pass.

Real-tx integration against local validator loaded with Pinocchio `.so` under Program ID
`41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W`:

- `initialize_config` + treasury seed deposit: pass
- SOL wager fee + win: pass
- treasury 90/10 deposit: pass
- POKE refund cannot redirect: pass
- prize payment bound to stored winner: pass

Full `@pokearena/solana-client` suite: **21/21 pass**.

## Success criteria

1. Parity tests pass: **yes**
2. Existing client ABI + security semantics preserved: **yes** (same Program ID, discriminators, PDAs, account orders; integration tests exercise auth/status/token/prize constraints)
3. Materially smaller than 419,736-byte Anchor artifact: **yes** (75,016 bytes; ~2.40 SOL ProgramData rent savings)

## Recommendation

The experiment meets the hard acceptance criteria. Pinocchio is a viable path to cut deployment rent from ~2.92 SOL to ~0.52 SOL while keeping the current TypeScript client.

Next steps (only if adopting):

1. Keep Anchor as oracle until a longer soak / broader API-level chain tests pass
2. Point deploy scripts at `arena_escrow_pinocchio.so` (or rename after cutover)
3. Only then consider optional size polish; do not optimize further before cutover decisions

If a more conservative rollout is preferred, keep Anchor for now and revisit after additional adversarial testing — but size savings are already large enough to materially improve deployment economics.
