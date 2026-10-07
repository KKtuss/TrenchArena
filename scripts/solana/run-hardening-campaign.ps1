# READ-ONLY hardening campaign:
# 1) LiteSVM byte-corruption fuzz against identical Anchor/Pinocchio .so artifacts
# 2) Concurrent soak on live local validator (Pinocchio, then Anchor sample)
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$ProgramId = if ($env:POKEARENA_PROGRAM_ID) { $env:POKEARENA_PROGRAM_ID } else { "41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W" }
$Rpc = if ($env:POKEARENA_SOLANA_RPC) { $env:POKEARENA_SOLANA_RPC } else { "http://127.0.0.1:8899" }
$OutDir = Join-Path $Root "scripts\solana\parity-out\hardening"
$WslRoot = "/mnt/d/CursorProj/PokeArena"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if (-not $env:POKEARENA_HARDENING_SEED) { $env:POKEARENA_HARDENING_SEED = "1347373893" } # 0x504F4B45
if (-not $env:POKEARENA_CORRUPT_CASES) { $env:POKEARENA_CORRUPT_CASES = "80" }
if (-not $env:POKEARENA_SOAK_WALLETS) { $env:POKEARENA_SOAK_WALLETS = "8" }
if (-not $env:POKEARENA_SOAK_LIFECYCLES) { $env:POKEARENA_SOAK_LIFECYCLES = "40" }
if (-not $env:POKEARENA_SOAK_CONCURRENCY) { $env:POKEARENA_SOAK_CONCURRENCY = "6" }

function Invoke-WslBash([string]$Script) {
  $tmp = Join-Path $OutDir "_wsl_step.sh"
  $lf = ($Script -replace "`r`n", "`n" -replace "`r", "`n")
  [System.IO.File]::WriteAllText($tmp, $lf)
  & wsl.exe --cd ~ bash "$WslRoot/scripts/solana/parity-out/hardening/_wsl_step.sh"
  if ($LASTEXITCODE -ne 0) { throw "WSL step failed with exit $LASTEXITCODE" }
}

function Wait-Rpc {
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $r = Invoke-WebRequest -Uri $Rpc -Method Post -ContentType "application/json" `
        -Body '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' -TimeoutSec 2
      if ($r.StatusCode -eq 200) { return }
    } catch {}
    Start-Sleep -Seconds 1
  }
  throw "RPC not ready"
}

function Start-Impl([string]$Impl, [string]$SoWsl, [string]$Ledger) {
  Write-Host "==> Validator $Impl"
  $boot = @"
set -euo pipefail
export PATH="`$HOME/.local/share/solana/install/active_release/bin:`$HOME/.cargo/bin:`$HOME/.avm/bin:`$PATH"
ROOT='$WslRoot'
PROGRAM_ID='$ProgramId'
SO='$SoWsl'
LEDGER='$Ledger'
RPC='$Rpc'
LOG='/tmp/pokearena-hardening-$Impl.log'
while read -r pid; do
  [[ -n "`$pid" ]] || continue
  kill "`$pid" 2>/dev/null || true
done < <(ps -eo pid,args | awk '/solana-test-validator/ && !/awk/ {print `$1}')
sleep 1
rm -rf "`$LEDGER"
nohup solana-test-validator \
  --ledger "`$LEDGER" --reset --bind-address 127.0.0.1 --rpc-port 8899 \
  --bpf-program "`$PROGRAM_ID" "`$SO" >"`$LOG" 2>&1 &
for _ in `$(seq 1 60); do
  solana cluster-version --url "`$RPC" >/dev/null 2>&1 && break
  sleep 1
done
solana cluster-version --url "`$RPC"
export POKEARENA_PROGRAM_ID="`$PROGRAM_ID"
export POKEARENA_PROGRAM_SO="`$SO"
export POKEARENA_SOLANA_RPC="`$RPC"
export POKEARENA_SKIP_INIT=1
unset POKEARENA_FORCE_DEPLOY || true
"`$ROOT/scripts/solana/bootstrap-local.sh"
"@
  Invoke-WslBash $boot
  Wait-Rpc
}

function Load-Env {
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
  if (-not $env:POKEARENA_FEE_VAULT) {
    Push-Location (Join-Path $Root "packages\solana-client")
    $lines = & node -e @"
const {PublicKey}=require('@solana/web3.js');
const pid=new PublicKey('$ProgramId');
console.log(PublicKey.findProgramAddressSync([Buffer.from('fee_vault')], pid)[0].toBase58());
console.log(PublicKey.findProgramAddressSync([Buffer.from('treasury_vault')], pid)[0].toBase58());
console.log(PublicKey.findProgramAddressSync([Buffer.from('operator_vault')], pid)[0].toBase58());
"@
    Pop-Location
    $env:POKEARENA_FEE_VAULT = $lines[0]
    $env:POKEARENA_TREASURY_VAULT = $lines[1]
    $env:POKEARENA_OPERATOR_VAULT = $lines[2]
  }
}

Write-Host "==> Building solana-client (includes hardening tests)"
Push-Location (Join-Path $Root "packages\solana-client")
npm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "build failed" }
Pop-Location

Write-Host ""
Write-Host "==> Category 1: byte-level corruption fuzz (LiteSVM + identical .so via WSL Node)"
$fuzzEnv = @"
export POKEARENA_HARDENING_SEED='$($env:POKEARENA_HARDENING_SEED)'
export POKEARENA_CORRUPT_CASES='$($env:POKEARENA_CORRUPT_CASES)'
bash '$WslRoot/scripts/solana/parity-out/hardening/_run_corrupt_fuzz.sh'
"@
Invoke-WslBash $fuzzEnv

# Also fix the summary script path - use OutDir directly later.

Write-Host ""
Write-Host "==> Category 2: concurrent soak on Pinocchio local validator"
Start-Impl "pinocchio" "$WslRoot/target/deploy/arena_escrow_pinocchio.so" "/tmp/pokearena-hardening-pinocchio-ledger"
Load-Env
& node (Join-Path $Root "scripts\solana\init-config.mjs")
if ($LASTEXITCODE -ne 0) { throw "init-config failed" }
Load-Env
$env:POKEARENA_PARITY_IMPL = "pinocchio"
$env:POKEARENA_CHAIN_ECONOMY = "true"
Push-Location (Join-Path $Root "packages\solana-client")
node --test dist/test/hardening-soak.test.js
$soakPin = $LASTEXITCODE
Pop-Location
if ($soakPin -ne 0) { throw "Pinocchio soak FAILED" }

Write-Host ""
Write-Host "==> Category 2b: Anchor soak sample (same seed, fewer lifecycles for differential)"
$env:POKEARENA_SOAK_LIFECYCLES = "20"
Start-Impl "anchor" "$WslRoot/target/deploy/arena_escrow.so" "/tmp/pokearena-hardening-anchor-ledger"
Load-Env
& node (Join-Path $Root "scripts\solana\init-config.mjs")
Load-Env
$env:POKEARENA_PARITY_IMPL = "anchor"
$env:POKEARENA_CHAIN_ECONOMY = "true"
Push-Location (Join-Path $Root "packages\solana-client")
node --test dist/test/hardening-soak.test.js
$soakAnchor = $LASTEXITCODE
Pop-Location
if ($soakAnchor -ne 0) { throw "Anchor soak FAILED" }

Write-Host ""
Write-Host "==> Writing final hardening summary"
& node -e @"
const fs=require('fs');
const path=require('path');
const dir=path.join(String.raw`$Root`.replace(/\\/g,'/'),'scripts/solana/parity-out/hardening');
const corrupt=JSON.parse(fs.readFileSync(path.join(dir,'corrupt-fuzz-report.json'),'utf8'));
const soakP=JSON.parse(fs.readFileSync(path.join(dir,'soak-pinocchio-report.json'),'utf8'));
const soakA=JSON.parse(fs.readFileSync(path.join(dir,'soak-anchor-report.json'),'utf8'));
const softMismatches=(corrupt.cases||[]).filter(c=>c.acceptMismatch && !c.unexpectedAccept);
const summary={
  generatedAt:new Date().toISOString(),
  seed: Number(process.env.POKEARENA_HARDENING_SEED||corrupt.seed),
  corruption:{
    verdict: corrupt.summary.unexpectedAccept===0 && corrupt.summary.pinocchioMutatedOther===0 ? 'PASS':'FAIL',
    total: corrupt.summary.total,
    pinocchioAccepted: corrupt.summary.pinocchioAccepted,
    pinocchioRejected: corrupt.summary.pinocchioRejected,
    anchorAccepted: corrupt.summary.anchorAccepted,
    anchorRejected: corrupt.summary.anchorRejected,
    unexpectedAccept: corrupt.summary.unexpectedAccept,
    hardAcceptMismatch: (corrupt.failures||[]).filter(c=>c.unexpectedAccept|| (c.acceptMismatch && ['disc-byte-flip','disc-replace','truncate','bump-corrupt','enum-status-ff','pubkey-zero'].includes(c.mutation))).length,
    softAcceptMismatch: softMismatches.length,
    pinocchioMutatedOther: corrupt.summary.pinocchioMutatedOther,
  },
  soak:{
    pinocchio:{
      verdict: soakP.summary.invariantViolations===0 && soakP.summary.failed===0 ? 'PASS':'FAIL',
      ...soakP.summary,
    },
    anchor:{
      verdict: soakA.summary.invariantViolations===0 && soakA.summary.failed===0 ? 'PASS':'FAIL',
      ...soakA.summary,
    },
  },
};
summary.verdict = summary.corruption.verdict==='PASS' && summary.soak.pinocchio.verdict==='PASS' && summary.soak.anchor.verdict==='PASS' ? 'PASS':'FAIL';
fs.writeFileSync(path.join(dir,'HARDENING-SUMMARY.json'), JSON.stringify(summary,null,2));
const md=[];
md.push('# Hardening campaign summary');
md.push('');
md.push('Seed: ``'+summary.seed+'``');
md.push('');
md.push('## Corruption fuzz: **'+summary.corruption.verdict+'**');
md.push('- Cases: '+summary.corruption.total);
md.push('- Pinocchio accepted/rejected: '+summary.corruption.pinocchioAccepted+' / '+summary.corruption.pinocchioRejected);
md.push('- Anchor accepted/rejected: '+summary.corruption.anchorAccepted+' / '+summary.corruption.anchorRejected);
md.push('- Unexpected accepts: '+summary.corruption.unexpectedAccept);
md.push('- Soft accept/reject mismatches (non-critical mutations): '+summary.corruption.softAcceptMismatch);
md.push('- Non-target mutations: '+summary.corruption.pinocchioMutatedOther);
md.push('');
md.push('## Soak Pinocchio: **'+summary.soak.pinocchio.verdict+'**');
md.push('- Lifecycles: '+summary.soak.pinocchio.lifecycles+' (ok '+summary.soak.pinocchio.completedOk+')');
md.push('- Wallets: '+summary.soak.pinocchio.wallets+' · concurrency: '+summary.soak.pinocchio.concurrency);
md.push('- Transactions: '+summary.soak.pinocchio.txCount);
md.push('- Invariant violations: '+summary.soak.pinocchio.invariantViolations);
md.push('- Timeouts: '+summary.soak.pinocchio.timeouts);
md.push('');
md.push('## Soak Anchor sample: **'+summary.soak.anchor.verdict+'**');
md.push('- Lifecycles: '+summary.soak.anchor.lifecycles+' (ok '+summary.soak.anchor.completedOk+')');
md.push('- Transactions: '+summary.soak.anchor.txCount);
md.push('- Invariant violations: '+summary.soak.anchor.invariantViolations);
md.push('');
md.push('## Overall: **'+summary.verdict+'**');
fs.writeFileSync(path.join(dir,'HARDENING-REPORT.md'), md.join('\n'));
console.log(JSON.stringify(summary,null,2));
if(summary.verdict!=='PASS') process.exit(1);
"@

Write-Host "Hardening campaign complete. Reports in $OutDir"
