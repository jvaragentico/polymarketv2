param(
    [ValidateRange(1, 100)][int]$Markets = 1,
    [switch]$Review,
    [ValidateRange(0, 3600)][int]$ResolutionWaitSeconds = 300,
    [ValidateRange(50, 4096)][int]$MaxNewLogMB = 1024,
    [ValidateSet('btc', 'eth', 'xrp', 'sol')][string[]]$Assets = @('btc', 'eth', 'xrp', 'sol'),
    [int]$Seed = -1
)

& (Join-Path $PSScriptRoot 'start-paper-btc.ps1') @PSBoundParameters

