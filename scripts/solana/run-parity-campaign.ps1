# Hybrid Windows/WSL parity campaign:
# - WSL: build (if needed), validator, bootstrap, spl-token mint
# - Host Node: init-config, solana-client tests, report diff, api tests
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$ProgramId = if ($env:POKEARENA_PROGRAM_ID) { $env:POKEARENA_PROGRAM_ID } else { "26fttiarz4KzXfcyB5W24WfXpMw8UqZHqKoTF9wWm2Ke" }
$Rpc = if ($env:POKEARENA_SOLANA_RPC) { $env:POKEARENA_SOLANA_RPC } else { "http://127.0.0.1:8899" }
$OutDir = Join-Path $Root "scripts\solana\parity-out"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$AnchorSo = Join-Path $Root "target\deploy\arena_escrow.so"
$PinocchioSo = Join-Path $Root "target\deploy\arena_escrow_pinocchio.so"
$WslRoot = "/mnt/d/CursorProj/PokeArena"

function Invoke-WslBash([string]$Script) {
  $tmp = Join-Path $OutDir "_wsl_step.sh"
  # Normalize to LF for bash.
  $lf = ($Script -replace "`r`n", "`n" -replace "`r", "`n")
  [System.IO.File]::WriteAllText($tmp, $lf)
  $wslTmp = "$WslRoot/scripts/solana/parity-out/_wsl_step.sh"
  & wsl.exe --cd ~ bash "$wslTmp"
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "WSL step failed with exit $code" }
}

function Wait-Rpc {
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $r = Invoke-WebRequest -Uri $Rpc -Method Post -ContentType "application/json" -Body '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' -TimeoutSec 2
      if ($r.StatusCode -eq 200) { return }
    } catch {}
    Start-Sleep -Seconds 1
  }
  throw "RPC not ready at $Rpc"
}

function Start-Impl([string]$Impl, [string]$SoWsl, [string]$Ledger) {
  Write-Host ""
  Write-Host "============================================================"
  Write-Host "==> Campaign against $Impl"
  Write-Host "============================================================"

  $log = "/tmp/pokearena-parity-$Impl.log"
  $boot = @"
set -euo pipefail
export PATH="`$HOME/.local/share/solana/install/active_release/bin:`$HOME/.cargo/bin:`$HOME/.avm/bin:`$PATH"
ROOT='$WslRoot'
PROGRAM_ID='$ProgramId'
SO='$SoWsl'
LEDGER='$Ledger'
LOG='$log'
RPC='$Rpc'

while read -r pid; do
  [[ -n "`$pid" ]] || continue
  kill "`$pid" 2>/dev/null || true
done < <(ps -eo pid,args | awk '/solana-test-validator/ && !/awk/ {print `$1}')
sleep 1
rm -rf "`$LEDGER"

nohup solana-test-validator \
  --ledger "`$LEDGER" \
  --reset \
  --bind-address 127.0.0.1 \
  --rpc-port 8899 \
  --bpf-program "`$PROGRAM_ID" "`$SO" \
  >"`$LOG" 2>&1 &
echo "validator pid `$!"

for _ in `$(seq 1 60); do
  if solana cluster-version --url "`$RPC" >/dev/null 2>&1; then
    solana cluster-version --url "`$RPC"
    break
  fi
  sleep 1
done
if ! solana cluster-version --url "`$RPC" >/dev/null 2>&1; then
  tail -60 "`$LOG" >&2 || true
  exit 1
fi

export POKEARENA_PROGRAM_ID="`$PROGRAM_ID"
export POKEARENA_PROGRAM_SO="`$SO"
export POKEARENA_SOLANA_RPC="`$RPC"
export POKEARENA_SKIP_INIT=1
unset POKEARENA_FORCE_DEPLOY || true
"`$ROOT/scripts/solana/bootstrap-local.sh"

set -a
source "`$ROOT/scripts/solana/.local.env"
set +a
export POKEARENA_SOLANA_KEYS="`${POKEARENA_SOLANA_KEYS:-`$ROOT/scripts/solana/keys}"

AUTH_PUB="`$(solana-keygen pubkey "`$POKEARENA_SOLANA_KEYS/authority.json")"
echo "Minting POKE to authority ATA `$AUTH_PUB"
spl-token create-account "`$POKEARENA_POKE_MINT" \
  --owner "`$AUTH_PUB" \
  --fee-payer "`$POKEARENA_SOLANA_KEYS/authority.json" \
  --url "`$RPC" >/dev/null 2>&1 || true
spl-token mint "`$POKEARENA_POKE_MINT" 1000 \
  --recipient-owner "`$AUTH_PUB" \
  --mint-authority "`$POKEARENA_SOLANA_KEYS/authority.json" \
  --fee-payer "`$POKEARENA_SOLANA_KEYS/authority.json" \
  --url "`$RPC"
spl-token balance "`$POKEARENA_POKE_MINT" --owner "`$AUTH_PUB" --url "`$RPC" || true
"@
  Invoke-WslBash $boot
  Wait-Rpc
}

function Run-HostTests([string]$Impl, [string]$ReportPath) {
  $envFile = Join-Path $Root "scripts\solana\.local.env"
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
    $kv = $_.Split('=', 2)
    if ($kv.Length -eq 2) { Set-Item -Path "Env:$($kv[0])" -Value $kv[1] }
  }
  $env:POKEARENA_CHAIN_ECONOMY = "true"
  $env:POKEARENA_SOLANA_RPC = $Rpc
  $env:POKEARENA_PROGRAM_ID = $ProgramId
  $env:POKEARENA_SOLANA_KEYS = (Join-Path $Root "scripts\solana\keys")
  $env:POKEARENA_PARITY_IMPL = $Impl
  $env:POKEARENA_PARITY_OUT = $ReportPath

  if (-not $env:POKEARENA_FEE_VAULT) {
    $derive = @"
const {PublicKey}=require('@solana/web3.js');
const pid=new PublicKey('$ProgramId');
console.log(PublicKey.findProgramAddressSync([Buffer.from('fee_vault')], pid)[0].toBase58());
console.log(PublicKey.findProgramAddressSync([Buffer.from('treasury_vault')], pid)[0].toBase58());
console.log(PublicKey.findProgramAddressSync([Buffer.from('operator_vault')], pid)[0].toBase58());
"@
    Push-Location (Join-Path $Root "packages\solana-client")
    $lines = & node -e $derive
    Pop-Location
    $env:POKEARENA_FEE_VAULT = $lines[0]
    $env:POKEARENA_TREASURY_VAULT = $lines[1]
    $env:POKEARENA_OPERATOR_VAULT = $lines[2]
  }

  Push-Location (Join-Path $Root "packages\solana-client")
  npm run build | Out-Null
  Pop-Location
  & node (Join-Path $Root "scripts\solana\init-config.mjs")
  if ($LASTEXITCODE -ne 0) { throw "init-config failed" }

  # Re-load env in case init-config printed vaults only
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
    $kv = $_.Split('=', 2)
    if ($kv.Length -eq 2 -and $kv[1]) { Set-Item -Path "Env:$($kv[0])" -Value $kv[1] }
  }
  $env:POKEARENA_CHAIN_ECONOMY = "true"
  $env:POKEARENA_PARITY_IMPL = $Impl
  $env:POKEARENA_PARITY_OUT = $ReportPath
  $env:POKEARENA_SOLANA_KEYS = (Join-Path $Root "scripts\solana\keys")

  Push-Location (Join-Path $Root "packages\solana-client")
  npm test
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw "solana-client tests failed for $Impl" }
  Pop-Location
  Write-Host "==> $Impl report: $ReportPath"
}

# Ensure binaries exist (build in WSL if missing)
if (-not (Test-Path $AnchorSo) -or -not (Test-Path $PinocchioSo)) {
  Invoke-WslBash @"
set -euo pipefail
export PATH="`$HOME/.local/share/solana/install/active_release/bin:`$HOME/.cargo/bin:`$PATH"
cd '$WslRoot'
[[ -f target/deploy/arena_escrow.so ]] || cargo-build-sbf --manifest-path programs/arena-escrow/Cargo.toml --arch v0
[[ -f target/deploy/arena_escrow_pinocchio.so ]] || cargo-build-sbf --manifest-path programs/arena-escrow-pinocchio/Cargo.toml --arch v0
wc -c target/deploy/arena_escrow.so target/deploy/arena_escrow_pinocchio.so
"@
}

Write-Host "Anchor SO:    $((Get-Item $AnchorSo).Length) bytes"
Write-Host "Pinocchio SO: $((Get-Item $PinocchioSo).Length) bytes"

Start-Impl "anchor" "$WslRoot/target/deploy/arena_escrow.so" "/tmp/pokearena-parity-anchor-ledger"
Run-HostTests "anchor" (Join-Path $OutDir "anchor-report.json")

Start-Impl "pinocchio" "$WslRoot/target/deploy/arena_escrow_pinocchio.so" "/tmp/pokearena-parity-pinocchio-ledger"
Run-HostTests "pinocchio" (Join-Path $OutDir "pinocchio-report.json")

Write-Host ""
Write-Host "==> Diffing Anchor vs Pinocchio campaign reports"
& node (Join-Path $Root "scripts\solana\compare-parity-reports.cjs") `
  (Join-Path $OutDir "anchor-report.json") `
  (Join-Path $OutDir "pinocchio-report.json") `
  (Join-Path $OutDir "diff-report.json")
if ($LASTEXITCODE -ne 0) { throw "Differential compare failed" }

Write-Host "==> Running @pokearena/api test suite (mock ledger)"
Push-Location (Join-Path $Root "packages\api")
npm test
$apiCode = $LASTEXITCODE
Pop-Location
if ($apiCode -ne 0) { throw "api tests failed" }

Write-Host ""
Write-Host "Parity campaign complete. Reports: $OutDir"
Get-ChildItem $OutDir | Format-Table Name, Length, LastWriteTime
