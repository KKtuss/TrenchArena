# PokeArena public deployment

PokeArena is a **single-process** application for live battles, rooms, sessions,
and rate limits. Durable wallets, holds, settlements, casual rooms, and
tournaments live in PostgreSQL. Horizontal scaling is **not supported**.
Running two API processes will split identity, live matches, and in-memory
limits.

Native Linux execution of systemd and Caddy has **not** been verified. This
document describes the intended production process and reverse-proxy
configuration. Batch 6I (VPS provisioning) and 6J (load testing) are separate
and are not performed here.

```text
Internet
  ↓ :80 / :443 (Caddy only; HTTP → HTTPS)
Caddy
  ├── /ws      → 127.0.0.1:3000   (API WebSocket; path preserved)
  ├── /health  → 127.0.0.1:3000   (API process liveness)
  └── *        → 127.0.0.1:3001   (Next.js)
        ↓
pokearena-api.service   Node, one process, 127.0.0.1:3000
  ├── PostgreSQL (loopback/private; never public)
  ├── Pokémon Showdown in-process
  ├── durable state in PostgreSQL
  └── live battle/session state in process memory
pokearena-web.service   Next.js, 127.0.0.1:3001
```

| Listener | Bind | Public? |
| --- | --- | --- |
| Caddy | `:80`, `:443` | **Yes** — only public-facing process |
| API | `127.0.0.1:3000` | No |
| Next.js | `127.0.0.1:3001` | No |
| PostgreSQL | loopback/private `:5432` | No |

There must be **exactly one** API process. Live battle and session state is
process-local.

Substitute `pokearena.example` with the real public hostname before going
live. This repository does not pick a production domain.

## Host requirements (Linux production)

Verified from the repository, not assumed:

| Requirement | Source |
| --- | --- |
| Node.js **>= 22.18.0** | `engines.node` on workspace packages and the repo root |
| pnpm **12.6.0** | root `packageManager` and `pnpm-lock.yaml` |
| PostgreSQL listening for the API | `POKEARENA_DATABASE_URL` / `DATABASE_URL`; production refuses in-memory economics |
| Working directory | **repository root** for install; package filters for build/start |

There is **no dotenv loader**. The API process environment must already contain
the variables below (systemd `EnvironmentFile` in production).

`pnpm install` at the **workspace root**. Do not `npm install` inside an
individual package. On Linux, pnpm workspace symlinks are required and
expected; `pnpm sync:copies` is a **Windows-only** robocopy helper and is not
part of the Linux path.

`poc/*` packages are not required to start production. Prefer building
`packages/*` and `apps/web` rather than `pnpm -r build` (which also builds
POCs that call `npm --prefix`).

## Linux vs Windows web build

`apps/web` `build` runs Showdown asset verification, then
`apps/web/scripts/build-next.js`:

- **Windows (`win32`):** stage onto local NTFS with `robocopy`, then `next build`
- **Non-Windows:** `node …/next/dist/bin/next build` **in place**. No robocopy.

Linux must not depend on PowerShell, `robocopy`, or `scripts/sync-workspace-copies.ps1`.

## Local development

Development still binds `127.0.0.1` and allows missing Origin plus localhost
browser origins.

```text
pnpm --filter @pokearena/api dev
pnpm --filter @pokearena/web dev
```

`POKEARENA_ALLOW_DEMO_AUTH` is set by the API **dev** script only. The Next.js
app reads `NEXT_PUBLIC_POKEARENA_ALLOW_DEMO_AUTH` from
`apps/web/.env.development`. Demo identify stays off unless those flags are
explicitly true.

## Production environment variables

### API (`packages/api`) — runtime

`NODE_ENV=production` is **required** for the production fail-closed path.
Without it, the API defaults to in-memory economics (development).

Production **must not** select memory economics. `NODE_ENV=production` plus
`POKEARENA_ECONOMICS=postgres` (unit + env file) is the intended combination.
Setting `POKEARENA_ECONOMICS=memory` under `NODE_ENV=production` causes
startup to throw; the process does not listen.

| Variable | Required in production? | Notes |
| --- | --- | --- |
| `NODE_ENV` | **Yes** (`production`) | Selects postgres economics, strict Origin mode. |
| `POKEARENA_DATABASE_URL` | **Yes** (or `DATABASE_URL`) | Connection string. No silent in-memory fallback if this is missing in production: startup throws and does not listen. |
| `DATABASE_URL` | Alias | Used only if `POKEARENA_DATABASE_URL` is unset. |
| `PORT` | No | Default `3000`. |
| `POKEARENA_BIND_HOST` | No | Default `127.0.0.1`. Production stays on loopback behind Caddy. Set `0.0.0.0` only to expose the process (not this topology). |
| `POKEARENA_ALLOWED_ORIGINS` | **Yes** in strict mode | Comma-separated browser Origins for `/ws`, e.g. `https://pokearena.example`. Constructor throws if strict and this list is empty. Never treat `Host` as Origin. |
| `POKEARENA_ORIGIN_MODE` | No | `strict` or `development`. Default `strict` when `NODE_ENV=production` or an allowlist is set. |
| `POKEARENA_AUTH_ORIGIN` | No | Wallet-message origin fallback when a socket has no Origin (development). |
| `POKEARENA_ALLOW_DEMO_AUTH` | Must be unset/false | Demo identify and the API demo HTML page stay disabled. |
| `POKEARENA_ECONOMICS` | **Yes** (`postgres`) | `postgres` or `memory`. Default `postgres` when `NODE_ENV=production`. Production **refuses** `memory`. `DATABASE_URL` alone does not switch a non-production process to Postgres. |
| `POKEARENA_MAX_WS_CONNECTIONS` | No | Default `512`. |
| `POKEARENA_MAX_WS_CONNECTIONS_PER_IP` | No | Default `16`. Behind Caddy, `POKEARENA_TRUST_PROXY=true` is required or every client appears as 127.0.0.1. |
| `POKEARENA_MAX_WS_PAYLOAD` | No | Default `32768`. |
| `POKEARENA_TRUST_PROXY` | **Yes** (`true`) behind Caddy | Default false. `true` only when a trusted reverse proxy is the only public path. |
| `POKEARENA_RATE_WINDOW_MS` | No | Default `60000`. |
| `POKEARENA_RATE_AUTH_CHALLENGE` | No | Default `10`. |
| `POKEARENA_RATE_CASUAL_CREATE` | No | Default `20`. |
| `POKEARENA_RATE_TOURNAMENT_CREATE` | No | Default `10`. |
| `POKEARENA_RATE_TEAM_SEARCH` | No | Default `60`. |
| `POKEARENA_RATE_MATCH_CHOICE` | No | Default `120`. |
| `POKEARENA_AUTH_CHALLENGE_TTL_MS` | No | Default `300000`. |
| `POKEARENA_AUTH_CHALLENGE_CLEANUP_MS` | No | Default `15000`. |

The in-memory limiter is only appropriate while a **single API process** owns
all connections.

Production wallets created by PostgreSQL `ensureWallet` start at **0**. There
is no production faucet.

### Web (`apps/web`) — build-time (`NEXT_PUBLIC_*`)

These are inlined when Next.js builds. Changing them later requires a rebuild.
A systemd `EnvironmentFile` loaded at `next start` does **not** rewrite an
existing `apps/web/.next` bundle.

| Variable | Required for public HTTPS? | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_WS_URL` | **Yes** for the Caddy same-origin topology | Set **at build time** to `wss://pokearena.example/ws` (replace the hostname). Also added to CSP `connect-src`. If unset, the client falls back toward `127.0.0.1:3000`, which is wrong for public users. |
| `NEXT_PUBLIC_API_HOST` | No | Fallback host only when `NEXT_PUBLIC_WS_URL` is unset. Default `127.0.0.1:3000`. |
| `NEXT_PUBLIC_POKEARENA_ALLOW_DEMO_AUTH` | Must be unset/false | Do not copy `apps/web/.env.development` into a production build. |

Do not put API keys, wallet private keys, or Google/Stitch credentials in
these files. Local MCP configuration belongs in gitignored `.cursor/`.

### EnvironmentFile locations (production host)

Do not put secrets in the committed systemd units. On the host:

| File | Role | Source in repo |
| --- | --- | --- |
| `/etc/pokearena/api.env` | API runtime (includes `POKEARENA_DATABASE_URL`) | `deploy/env/api.env.example` |
| `/etc/pokearena/web.env` | Next.js **runtime** only (`NODE_ENV`, bind hints) | `deploy/env/web.env.example` |
| *(build environment)* | `NEXT_PUBLIC_WS_URL` for `pnpm --filter @pokearena/web build` | `deploy/env/web.build.env.example` |

Suggested permissions: directory `/etc/pokearena` mode `0750`, files mode
`0640`, owner `root:pokearena`. Replace `pokearena` if the host uses a
different service user.

`deploy/env/*.env` (without `.example`) is gitignored. Never commit a filled
copy.

## Linux production build

From the repository root, with Node >= 22.18.0 and pnpm 12.6.0:

```text
export NEXT_PUBLIC_WS_URL=wss://pokearena.example/ws
pnpm install --frozen-lockfile
pnpm --filter "./packages/**" --filter @pokearena/web build
pnpm --filter "./packages/**" --filter @pokearena/web typecheck
```

Workspace packages publish types from `dist/`. Typecheck therefore runs
**after** the package build on a clean checkout. Do not skip typecheck.

Web output is `apps/web/.next`. API output is `packages/*/dist`.

**Build order:** workspace install → packages + web build (with
`NEXT_PUBLIC_WS_URL` set) → packages + web typecheck. Then install env files
and systemd units, then start services.

If the public hostname changes, rebuild the web app. Restarting
`pokearena-web.service` alone does not pick up a new WebSocket URL.

## systemd units

Committed units (placeholders, not secrets):

| Unit | Process | Bind |
| --- | --- | --- |
| `deploy/systemd/pokearena-api.service` | `node dist/src/server.js` | `POKEARENA_BIND_HOST` / `PORT` (127.0.0.1:3000) |
| `deploy/systemd/pokearena-web.service` | `next start -p 3001 -H 127.0.0.1` | **localhost only** |

Placeholders that Batch 6I must replace if the host differs:

| Placeholder | Default in unit files | Meaning |
| --- | --- | --- |
| service user/group | `pokearena` | Unprivileged account; units do not run as root |
| app root | `/opt/pokearena` | Checkout / deploy directory |
| Node binary | `/usr/bin/node` | Node >= 22.18.0; nvm paths must be substituted |
| API env | `/etc/pokearena/api.env` | See above |
| web env | `/etc/pokearena/web.env` | Runtime only |

API unit behavior:

- `Type=simple`, **one** non-template unit (never `pokearena-api@.service`)
- `WorkingDirectory=/opt/pokearena/packages/api`
- `NODE_ENV=production` and `POKEARENA_ECONOMICS=postgres` in the unit; full
  secrets and limits from `EnvironmentFile`
- `Restart=on-failure`, `KillSignal=SIGTERM`, `TimeoutStopSec=30`
- `After=network-online.target postgresql.service` with `Wants=` (not
  `Requires=`) for PostgreSQL so a distro-specific unit name does not mask
  start forever. The API itself already refuses to listen when PostgreSQL,
  migrations, or recovery fail; systemd retries instead of substituting a
  memory store.
- Logs to journald (`SyslogIdentifier=pokearena-api`)

Web unit behavior:

- `WorkingDirectory=/opt/pokearena/apps/web`
- Production Next server with `-p 3001 -H 127.0.0.1` (also the `package.json`
  `start` script)
- `Restart=on-failure`, SIGTERM stop, journald (`pokearena-web`)
- Does not depend on `pokearena-api.service` (no circular dependency)

Install units onto a Linux host (does not create users or install packages):

```text
sudo sh deploy/apply-process-config.sh --install-units --validate-caddy
sudo systemctl enable pokearena-api.service pokearena-web.service
```

### Service startup order

1. Network
2. PostgreSQL (private)
3. `pokearena-api.service` — fails and restarts until DB + migrations +
   recovery succeed, then listens on 127.0.0.1:3000
4. `pokearena-web.service` — requires `apps/web/.next` from the production
   build
5. Caddy (distro unit, configured in Batch 6I) — public :80/:443

`/health` is **process liveness**: HTTP 200 and `{"ok":true}` once the API is
listening. It does not check PostgreSQL. It is not a readiness probe for
migrations or recovery. Those already gate `listen`; systemd `Restart=` covers
crash loops. Do not invent a second health URL.

### journald commands

Do not put secrets in logs or in these examples.

```text
systemctl status pokearena-api.service
systemctl status pokearena-web.service

journalctl -u pokearena-api.service -n 100 --no-pager
journalctl -u pokearena-web.service -n 100 --no-pager

journalctl -u pokearena-api.service -f
journalctl -u pokearena-web.service -f

sudo systemctl restart pokearena-api.service
sudo systemctl restart pokearena-web.service

sudo systemctl stop pokearena-api.service
sudo systemctl stop pokearena-web.service
sudo systemctl start pokearena-api.service
sudo systemctl start pokearena-web.service
```

Caddy (once installed in 6I) uses its own unit, typically `caddy.service`.

## Caddy reverse proxy

Source file: `deploy/Caddyfile`. Site address is the hostname placeholder
`pokearena.example`. Caddy's automatic HTTPS issues certificates for that
name and redirects HTTP to HTTPS when DNS points at the host (6I).

Routing:

- `/ws` → `127.0.0.1:3000` without stripping the path (`handle`, not
  `handle_path`). HTTP/1.1, `flush_interval -1`, unlimited read/write
  timeouts. Gzip is not applied on this handle. `Upgrade` / `Connection` are
  forwarded by `reverse_proxy`.
- `/health` → `127.0.0.1:3000` with the path unchanged.
- everything else → `127.0.0.1:3001` (gzip allowed).

Forwarded proto/host headers are set so `POKEARENA_TRUST_PROXY=true` can see
the client. Battle and session timeouts remain in the API; Caddy does not
impose a short proxy idle timeout on `/ws`.

Validate on a machine that has Caddy:

```text
caddy validate --config deploy/Caddyfile --adapter caddyfile
```

This Windows checkout does not run that command as proof of production
readiness. Static inspection of `deploy/Caddyfile` is what this batch did.

## Start without systemd (debug)

PostgreSQL must be up. Then:

```text
export NODE_ENV=production
export POKEARENA_DATABASE_URL=postgres://pokearena:PASSWORD@127.0.0.1:5432/pokearena
export POKEARENA_ALLOWED_ORIGINS=https://pokearena.example
export POKEARENA_TRUST_PROXY=true
export POKEARENA_BIND_HOST=127.0.0.1
export PORT=3000
pnpm --filter @pokearena/api start
```

`ApiServer.create` then:

1. connects to PostgreSQL
2. runs migrations
3. constructs `PostgresEconomicsStore` and `PostgresTournamentStore` on the **same pool**
4. runs boot recovery
5. only then `listen`

If the database is unreachable, migrations fail, or recovery fails, the process
exits and **does not** fall back to in-memory state.

Replace `https://pokearena.example` with the real public site Origin. Leave
`POKEARENA_ALLOW_DEMO_AUTH` unset.

The Next.js production server (after a production web build):

```text
pnpm --filter @pokearena/web start
```

That command binds `127.0.0.1:3001`. Default API port remains **3000**.

Next.js sends CSP, `X-Content-Type-Options`, `Referrer-Policy`,
`X-Frame-Options: DENY`, and related headers. CSP `script-src` and `style-src`
include `'unsafe-inline'` because the App Router bootstrap and Showdown CSS
need it. `'unsafe-eval'` is not used. `connect-src` is `'self'` plus
`NEXT_PUBLIC_WS_URL` when that points at a different host. Caddy, not Next,
should set HSTS so localhost development is not pinned to HTTPS.

## Helper script

`deploy/apply-process-config.sh` may build, copy units, validate Caddy, and
restart services. It does **not** provision a VPS, install packages, configure
DNS/TLS/firewall, create users, or touch PostgreSQL data.

```text
sh deploy/apply-process-config.sh
sh deploy/apply-process-config.sh --validate-caddy
sudo sh deploy/apply-process-config.sh --install-units
sudo sh deploy/apply-process-config.sh --restart
```

`--build` requires `NEXT_PUBLIC_WS_URL` in the environment. It installs,
builds packages and web, then typechecks.

## Verify

Health (monitoring / reverse proxy only; no browser CORS). Semantics:
**process is listening**, not database-ready.

```text
curl -sS http://127.0.0.1:3000/health
# {"ok":true}
```

Through Caddy (after 6I): `https://pokearena.example/health`.

WebSocket through the TLS proxy:

```text
curl -sS -I -H "Origin: https://pokearena.example" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://pokearena.example/ws
```

Expect `101` from an allowed Origin and `403` from any other Origin. A
successful upgrade still requires `auth.challenge` / `auth.verify` before
gameplay.

## Security / exposure

- Only Caddy listens publicly (`:80` / `:443`). TLS terminates at Caddy.
- API `:3000`, Next `:3001`, and PostgreSQL `:5432` stay on loopback/private.
- One API process; no workers, PM2 cluster, or template instances.
- Production cannot use memory economics.
- Secrets live in `/etc/pokearena/api.env`, not in git or unit files.
- systemd services run as `pokearena`, not root (placeholder; 6I creates the
  user).

## What this document does not cover (later batches)

- Installing Caddy, PostgreSQL, Node, or pnpm on a VPS (6I)
- Creating the `pokearena` user, `/opt/pokearena`, DNS, firewall, TLS issuance (6I)
- Load testing (6J)
- Multi-process API scaling / Redis / Docker / Kubernetes / PM2 / nginx
- Real on-chain POKE
- A CDN or global rate-limit fabric
- Native Linux runtime proof of systemd or Caddy — still required before
  production traffic
