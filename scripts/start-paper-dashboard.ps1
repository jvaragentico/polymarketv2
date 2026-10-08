param([ValidateRange(1024, 65535)][int]$Port = 8792)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$python = Join-Path $project '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    throw 'Create the paper-only environment first: py -3 -m venv .venv; .\.venv\Scripts\python.exe -m pip install -e .'
}
Push-Location $project
try {
    & $python -m polymarket_bot.dashboard --runs runs --port $Port
} finally {
    Pop-Location
}

