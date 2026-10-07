# Staging product reconciliation

This report records the read-only certification run after reconciling the
frozen source to the finished staging product. No deployment, wallet mutation,
SOL transfer, or mainnet program mutation was performed.

## Artifact

- Working-tree base commit: `148203539d4034cbc55724ba726c86467ef29a1c`
- Program ID: `6dHMWQd1M2ZZSmrkQLGZcFpHnvHi8rcH68QqQJ4Kj4r8`
- ELF: `target/deploy/arena_escrow_pinocchio.so`
- ELF size: `131,408` bytes
- ELF SHA-256: `03154ec42a2cfc75866a5cf28cd27254d2c7cf63ee03910d415096027ef04837`
- ProgramData length: `131,453` bytes
- Mainnet ProgramData rent: `668,431,480` lamports
- Mainnet program-account rent (36 bytes): `833,120` lamports
- Instruction count: `31`
- Instruction-surface SHA-256: `5c8f3d5854d1e434879875cc3534bbff6341d1e5f42ae754dae31e9086730ee0`

The Pinocchio Rust logic was not changed; the clean `--arch v0` rebuild
produced the same certified ELF.

## Reconciled behavior

- Chain tournaments require a fixed 32-player field.
- Brackets contain `N - 1` elimination matches and complete on the champion.
- Podium, third-place, 50/35/15 payout, scheduler, persisted `scheduledKey`,
  and migrations 015/016 are removed.
- The client-side display rotation remains; server-side scheduler state does
  not.
- CARDS initialization validates the configured classic-SPL mint, sends
  `initialize_config` and `set_cards_mint` atomically, and verifies the
  resulting 305-byte config.
- The Pinocchio instruction surface, SOL rail, POKE Token-2022 rail, CARDS
  handlers/layouts, creator-reward worker, and migrations 011–014 remain
  unchanged.

## Certification results

- Tournament package: `23/23` passed.
- API package: `220 passed, 1 skipped`.
- Web targeted tournament/API tests: `16/16` passed.
- DB package: `8 passed, 6 skipped because PostgreSQL was unavailable`.
- Deployment/runtime preflight: `10/10` passed.
- LiteSVM/client certification: `18/18` passed.
- CARDS initialization regression: passed.
- Corrupt-account campaign: `640` cases; `unexpectedAccept=0`,
  `acceptMismatch=0`, `pinocchioMutatedOther=0`.
- Explicit malformed/stale/owner/token-program rejects: `8/8`.

The current working tree still needs to be committed and the clean committed
certification rerun before it is considered frozen again.
