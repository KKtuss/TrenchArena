#!/bin/sh
# Apply PokeArena process/proxy config on an already-provisioned host.
#
# This helper does NOT:
#   provision a VPS, install Node/pnpm/Caddy/PostgreSQL, configure DNS,
#   issue certificates, configure a firewall, create users, install Docker,
#   or run destructive database operations (those belong to Batch 6I/6J).
#
# It may:
#   build API/web, copy systemd units, validate the Caddyfile, restart units.
#
# Usage (from anywhere):
#   sh deploy/apply-process-config.sh [--build] [--install-units] [--validate-caddy] [--restart]
#
# Default (no flags): print paths and validate Caddy if `caddy` is on PATH.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
UNIT_SRC="$ROOT/deploy/systemd"
CADDYFILE="$ROOT/deploy/Caddyfile"
UNIT_DEST="${POKEARENA_SYSTEMD_DIR:-/etc/systemd/system}"

DO_BUILD=0
DO_INSTALL=0
DO_VALIDATE=0
DO_RESTART=0
NO_FLAGS=1

for arg in "$@"; do
	case "$arg" in
		--build) DO_BUILD=1; NO_FLAGS=0 ;;
		--install-units) DO_INSTALL=1; NO_FLAGS=0 ;;
		--validate-caddy) DO_VALIDATE=1; NO_FLAGS=0 ;;
		--restart) DO_RESTART=1; NO_FLAGS=0 ;;
		-h|--help)
			sed -n '2,18p' "$0"
			exit 0
			;;
		*)
			echo "unknown argument: $arg" >&2
			exit 2
			;;
	esac
done

if [ "$NO_FLAGS" -eq 1 ]; then
	DO_VALIDATE=1
fi

echo "repository root: $ROOT"
echo "unit source:     $UNIT_SRC"
echo "Caddyfile:       $CADDYFILE"
echo "unit dest:       $UNIT_DEST"
echo "Replace placeholders in the unit files (User, /opt/pokearena, /usr/bin/node)"
echo "and install /etc/pokearena/{api,web}.env from deploy/env/*.env.example"
echo "before enabling services. See docs/deployment.md."
echo

if [ "$DO_BUILD" -eq 1 ]; then
	echo "building packages and web (requires Node >= 22.18.0, pnpm 12.6.0)"
	if [ -z "${NEXT_PUBLIC_WS_URL:-}" ]; then
		echo "NEXT_PUBLIC_WS_URL is unset. Production browsers need" >&2
		echo "wss://<public-host>/ws inlined at build time. Aborting." >&2
		echo "See deploy/env/web.build.env.example." >&2
		exit 1
	fi
	pnpm --dir "$ROOT" install --frozen-lockfile
	# Workspace packages emit types to dist/; typecheck after build.
	pnpm --dir "$ROOT" --filter "./packages/**" --filter @pokearena/web build
	pnpm --dir "$ROOT" --filter "./packages/**" --filter @pokearena/web typecheck
fi

if [ "$DO_VALIDATE" -eq 1 ]; then
	if command -v caddy >/dev/null 2>&1; then
		echo "validating Caddyfile"
		caddy validate --config "$CADDYFILE" --adapter caddyfile
	else
		echo "caddy not on PATH; skipped Caddyfile validation (static inspection only)"
	fi
fi

if [ "$DO_INSTALL" -eq 1 ]; then
	if [ ! -d "$UNIT_DEST" ]; then
		echo "systemd unit directory does not exist: $UNIT_DEST" >&2
		exit 1
	fi
	cp "$UNIT_SRC/pokearena-api.service" "$UNIT_DEST/pokearena-api.service"
	cp "$UNIT_SRC/pokearena-web.service" "$UNIT_DEST/pokearena-web.service"
	echo "copied units to $UNIT_DEST"
	if command -v systemctl >/dev/null 2>&1; then
		systemctl daemon-reload
		echo "systemctl daemon-reload completed"
	else
		echo "systemctl not on PATH; copied files only"
	fi
fi

if [ "$DO_RESTART" -eq 1 ]; then
	if ! command -v systemctl >/dev/null 2>&1; then
		echo "systemctl not on PATH; cannot restart" >&2
		exit 1
	fi
	systemctl restart pokearena-api.service
	systemctl restart pokearena-web.service
	echo "restarted pokearena-api.service and pokearena-web.service"
fi
