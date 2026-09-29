# Sync built workspace packages into dependent node_modules copies.
# Required on Windows hosts that cannot create pnpm/npm symlinks.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

function Sync-Package($name, $extraTargets = @()) {
  $source = Join-Path $root "packages\$name"
  $targets = @(
    (Join-Path $root "packages\api\node_modules\@pokearena\$name"),
    (Join-Path $root "packages\tournament\node_modules\@pokearena\$name")
  ) + $extraTargets
  foreach ($target in $targets) {
    $parent = Split-Path $target -Parent
    if (-not (Test-Path $parent)) {
      if ($name -eq "solana-client" -and $target -like "*\api\node_modules\*") {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
      } else {
        continue
      }
    }
    if (-not (Test-Path $target)) {
      New-Item -ItemType Directory -Path $target | Out-Null
    }
    robocopy $source $target /MIR /NFL /NDL /NJH /NJS /XD node_modules .git | Out-Null
    if ($LASTEXITCODE -ge 8) {
      throw "robocopy failed syncing $name to $target (code $LASTEXITCODE)"
    }
    Write-Host "Synced $name -> $target"
  }
}

Sync-Package "battle-engine"
Sync-Package "tournament"
Sync-Package "db"
Sync-Package "solana-client"
