# arena-escrow-pinocchio (production)

Production implementation of `arena_escrow`. The Anchor program in
`programs/arena-escrow` remains the parity/oracle reference and is not the
mainnet deployment artifact.

## Compatibility goals

- Same Program ID: `41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W`
- Same Anchor instruction discriminators (`sha256("global:<name>")[0..8]`)
- Same account discriminators, layouts, PDA seeds, and account ordering
- Same security semantics (auth, status, token mint/owner, replay uniqueness)
- Externally observable error semantics (reject same cases; no unauthorized mutation)

## Build

```bash
cargo-build-sbf --manifest-path programs/arena-escrow-pinocchio/Cargo.toml --arch v0
```

Artifact: `target/deploy/arena_escrow_pinocchio.so`

Mainnet deployment:

```bash
./scripts/solana/deploy-pinocchio-mainnet.sh
```

That script is mainnet-only, deploys this artifact, and keeps the upgrade
authority. See `docs/deployment.md`.

## Local parity run

```bash
./scripts/solana/run-pinocchio-parity.sh
```

This is local testing. It loads the Pinocchio `.so` at genesis under the shared
Program ID, bootstraps POKE/config, and runs `@pokearena/solana-client` tests
(including real-tx integration when the validator is up). Anchor parity
campaigns remain available and are not a deployment path.
