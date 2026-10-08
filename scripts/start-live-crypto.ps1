param(
    [switch]$CheckOnly,
    [switch]$EnableLive,
    [switch]$Continuous,
    [ValidateSet('btc','eth','xrp','sol')][string[]]$Assets = @('btc','eth','xrp','sol'),
    [ValidateRange(0.01,5)][double]$OrderDollars = 1,
    [ValidateRange(0.01,5)][double]$MarketDollars = 5,
    [ValidateRange(256,4096)][int]$MaxNewLogMB = 4096,
    [string]$Wallet = ''
)
$ErrorActionPreference = 'Stop'
if (-not $CheckOnly -and -not $EnableLive) { throw 'Live mode is off. Run paper mode first. To deliberately enable real orders later, pass -EnableLive.' }
if ($OrderDollars -gt $MarketDollars) { throw 'OrderDollars cannot exceed MarketDollars.' }
if (($Assets | Select-Object -Unique).Count -ne $Assets.Count) { throw 'Assets must be unique.' }
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskPython = Join-Path $taskRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) { throw 'Python environment is missing. See README.md.' }
Push-Location $taskRoot
try {
    $taskNode = (Get-Command node -ErrorAction Stop).Source
    if (-not $CheckOnly) {
        Write-Host "REAL ORDERS ENABLED: at most `$$OrderDollars per order and `$$MarketDollars per market."
        $taskSecret = Read-Host 'Wallet private key (hidden)' -AsSecureString
    }
    $taskBaselineBytes = (Get-ChildItem (Join-Path $taskRoot 'runs') -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    if (-not $taskBaselineBytes) { $taskBaselineBytes = 0 }
    $taskPreviousSlug = ''
    $taskAssetQueue = @()
    do {
        if ($taskAssetQueue.Count -eq 0) { $taskAssetQueue = @(Get-Random -InputObject $Assets -Count $Assets.Count) }
        $taskAsset = $taskAssetQueue[0]
        $taskAssetQueue = @($taskAssetQueue | Select-Object -Skip 1)
        & $taskNode --use-env-proxy (Join-Path $PSScriptRoot 'clock-check.js')
        if ($LASTEXITCODE -ne 0) { throw 'Clock check failed.' }
        $taskLines = & $taskPython -m polymarket_bot.live_market $taskAsset $taskPreviousSlug
        if ($LASTEXITCODE -ne 0 -or $taskLines.Count -ne 1) { throw 'Live crypto market preflight failed.' }
        $taskMarket = $taskLines | ConvertFrom-Json
        if ($taskMarket.slug -notmatch '^(btc|eth|xrp|sol)-updown-5m-\d+$' -or [double]$taskMarket.strike -le 0) { throw 'Invalid market response.' }
        $taskPreviousSlug = $taskMarket.slug
        Write-Host "Market: $($taskMarket.slug); official opening reference: $($taskMarket.strike)"
        if ($CheckOnly) { Write-Host 'Read-only check complete. No wallet opened or orders placed.'; return }
        $taskReason = & (Join-Path $PSScriptRoot 'wallet.ps1') -Action auto -Wallet $Wallet -Slug $taskMarket.slug -Strike ([double]$taskMarket.strike) -Seconds 90 -OrderDollars $OrderDollars -MaxSpend $MarketDollars -MaxLoss $MarketDollars -StartAfterKey -PrivateKey $taskSecret
        if (-not $Continuous) { break }
        $taskCurrentBytes = (Get-ChildItem (Join-Path $taskRoot 'runs') -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
        if (($taskCurrentBytes - $taskBaselineBytes) -ge $MaxNewLogMB * 1MB) { Write-Host 'Run-log limit reached; stopped for review.'; break }
        if ($taskReason -notin @('session_finished','take_profit')) { Write-Host "Stopped for review: $taskReason"; break }
    } while ($Continuous)
} finally {
    if ($taskSecret) { $taskSecret.Dispose(); $taskSecret = $null }
    Pop-Location
}

