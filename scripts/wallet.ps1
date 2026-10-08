param(
    [ValidateSet('address', 'balance', 'orders', 'buy', 'cancel', 'auto')][string]$Action = 'address',
    [string]$Wallet = '',
    [string]$ExpectedSigner = '0x8041Cc720aBC7DA28B056439aa2932Dbb879c408',
    [string]$Slug = '',
    [ValidateSet('Up','Down')][string]$Outcome = 'Up',
    [string]$Price = '',
    [string]$Size = '',
    [string]$OrderId = '',
    [double]$Strike = 0,
    [double]$Seconds = 120,
    [double]$OrderDollars = 5,
    [double]$MaxSpend = 10,
    [double]$MaxLoss = 3,
    [switch]$StartAfterKey,
    [Security.SecureString]$PrivateKey
)
$ErrorActionPreference = 'Stop'
$taskNode = (Get-Command node -ErrorAction Stop).Source
$taskScript = Join-Path $PSScriptRoot 'wallet-cli.js'
$taskOptions = @{action=$Action;wallet=$Wallet;expectedSigner=$ExpectedSigner;slug=$Slug;outcome=$Outcome;price=$Price;size=$Size;orderId=$OrderId}
if ($Action -eq 'auto') {
    if ($Strike -le 0 -or $Slug -notmatch '^(btc|eth|xrp|sol)-updown-5m-\d+$' -or $Seconds -lt 5 -or $Seconds -gt 900 -or $MaxLoss -le 0 -or $MaxLoss -gt $MaxSpend -or $OrderDollars -le 0 -or $OrderDollars -gt [Math]::Min(5,$MaxSpend)) { throw 'Provide a current crypto 5m market, official strike and valid caps.' }
    Write-Host "AUTOMATIC REAL ORDERS in $Slug. Strike: $Strike. Duration: $Seconds seconds. Per-order cap: $OrderDollars. Session spend cap: $MaxSpend. Market loss cap: $MaxLoss. No account-value floor."
    Write-Host 'Maker-only. Do not manually trade this market during the session. Resolved bot winners are checked for redemption after the session.'
    if (-not $StartAfterKey -and (Read-Host 'Type START to launch these automatic real-money orders') -cne 'START') { throw 'Automatic session canceled.' }
    $taskOptions.confirmed = $true
    $taskOptions.strike = $Strike
    $taskOptions.seconds = $Seconds
    $taskOptions.orderDollars = $OrderDollars
    $taskOptions.maxSpend = $MaxSpend
    $taskOptions.maxLoss = $MaxLoss
    $taskOptions.autoRedeem = $true
}
if ($Action -eq 'buy') {
    Write-Host "Real BUY: $Size $Outcome shares at `$$Price in $Slug. Maximum cost: $([decimal]$Size * [decimal]$Price)."
    if ((Read-Host 'Type BUY to confirm this real-money order') -cne 'BUY') { throw 'Order canceled.' }
    $taskOptions.confirmed = $true
}
if ($Action -eq 'cancel' -and -not $OrderId) { throw 'Provide -OrderId.' }
$taskSecret = if ($PrivateKey) { $PrivateKey } else { Read-Host 'Wallet private key (hidden)' -AsSecureString }
$taskPointer = [IntPtr]::Zero
$taskProcess = $null
$taskPlainKey = $null
try {
    $taskPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecret)
    $taskPlainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer)
    if ($taskPlainKey -notmatch '^(?:0x)?[0-9a-fA-F]{64}$') {
        throw 'Key format is invalid. Enter exactly 64 hexadecimal characters, optionally prefixed with 0x; do not include quotes or spaces.'
    }
    $taskInfo = New-Object System.Diagnostics.ProcessStartInfo
    $taskInfo.FileName = $taskNode
    $taskInfo.Arguments = '--use-env-proxy "' + $taskScript + '"'
    $taskInfo.WorkingDirectory = Split-Path $PSScriptRoot -Parent
    $taskInfo.UseShellExecute = $false
    $taskInfo.RedirectStandardInput = $true
    $taskInfo.RedirectStandardOutput = $true
    $taskInfo.RedirectStandardError = $true
    $taskInfo.CreateNoWindow = $true
    $taskProcess = New-Object System.Diagnostics.Process
    $taskProcess.StartInfo = $taskInfo
    [void]$taskProcess.Start()
    # Anonymous stdin pipe: no key in argv, environment, disk, or console output.
    $taskProcess.StandardInput.WriteLine($taskPlainKey)
    $taskProcess.StandardInput.WriteLine(($taskOptions | ConvertTo-Json -Compress))
    $taskProcess.StandardInput.Close()
    Write-Host 'Checking wallet and running the selected action. Public results will print when it exits.'
    $taskOutput = $taskProcess.StandardOutput.ReadToEndAsync()
    $taskErrors = $taskProcess.StandardError.ReadToEndAsync()
    $taskProcess.WaitForExit()
    foreach ($taskMessage in @($taskOutput.GetAwaiter().GetResult(), $taskErrors.GetAwaiter().GetResult())) {
        if ($taskMessage) {
            # The CLI redacts caught exceptions. Also suppress an accidental
            # verbatim key in any unexpected child-process output.
            $taskMessage = $taskMessage.Replace($taskPlainKey, '[redacted]')
            Write-Host $taskMessage.TrimEnd()
        }
    }
    if ($taskProcess.ExitCode -ne 0) { throw 'Wallet command failed. Review the stage shown above; check Polymarket orders before retrying.' }
    if ($Action -eq 'auto') {
        $taskMatch = [regex]::Match($taskOutput.GetAwaiter().GetResult(), '(?m)^Automatic session stopped: ([a-z_]+)')
        if (-not $taskMatch.Success) { throw 'Automatic session ended without a final status. Check Polymarket orders before retrying.' }
        Write-Output $taskMatch.Groups[1].Value
    }
} finally {
    $taskPlainKey = $null
    if ($taskPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer) }
    if ($taskProcess) { $taskProcess.Dispose() }
    if (-not $PrivateKey) { $taskSecret.Dispose() }
}

