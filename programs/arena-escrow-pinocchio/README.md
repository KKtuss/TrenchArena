# arena-escrow-pinocchio (experiment)

Parallel Pinocchio implementation of `arena_escrow` for size/deployment-rent
comparison. The Anchor program in `programs/arena-escrow` remains the behavioral
oracle and is not modified by this experiment.

## Compatibility goals

- Same Program ID: `26fttiarz4KzXfcyB5W24WfXpMw8UqZHqKoTF9wWm2Ke`
- Same Anchor instruction discriminators (`sha256("global:<name>")[0..8]`)
- Same account discriminators, layouts, PDA seeds, and account ordering
- Same security semantics (auth, status, token mint/owner, replay uniqueness)
- Externally observable error semantics (reject same cases; no unauthorized mutation)

## Build

```bash
cargo build-sbf --manifest-path programs/arena-escrow-pinocchio/Cargo.toml --arch v0
```

Artifact: `target/deploy/arena_escrow_pinocchio.so`

## Local parity run

```bash
./scripts/solana/run-pinocchio-parity.sh
```

This loads the Pinocchio `.so` at genesis under the shared Program ID, bootstraps
POKE/config, and runs `@pokearena/solana-client` tests (including real-tx
integration when the validator is up).

## Success criteria

Do not replace Anchor unless:

1. Parity tests pass
2. Client ABI and security semantics are preserved
3. Stripped Pinocchio `.so` is materially smaller than the Anchor 419,736-byte artifact

Report final byte size and exact ProgramData rent savings before deciding on migration.
