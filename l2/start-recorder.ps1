# Morning launcher for the order flow recorder -- the desktop shortcut runs this.
#
# The token lives in .orderflow_token beside this script (gitignored) and must
# match ORDERFLOW_TOKEN on the main Railway service, or every push is a 401.
#
# Usage:
#   start-recorder.ps1                 # MRVL NVDA
#   start-recorder.ps1 AMD TSLA        # other names (IBKR allows 3 at once)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
$Host.UI.RawUI.WindowTitle = 'Order flow recorder'

# @() matters: PowerShell unrolls a one-element $args to a bare string, and
# splatting a string spreads its CHARACTERS -- one ticker became P, L, T, R,
# and the recorder spent an afternoon watching AT&T.
$symbols = if ($args.Count) { @($args) } else { @('MRVL', 'NVDA') }

$tokenFile = Join-Path $here '.orderflow_token'
if (-not (Test-Path $tokenFile)) {
    Write-Host "Missing $tokenFile -- the server would reject every push." -ForegroundColor Red
    Read-Host 'Press Enter to close'; exit 1
}
$env:ORDERFLOW_TOKEN = (Get-Content $tokenFile -Raw).Trim()

# The gateway needs a human login each morning, so wait for it rather than fail.
$gateway = "$env:USERPROFILE\OneDrive\Desktop\IB Gateway 10.45.lnk"
$listening = { Get-NetTCPConnection -State Listen -LocalPort 4001 -ErrorAction SilentlyContinue }
if (-not (& $listening)) {
    if (-not (Get-Process ibgateway -ErrorAction SilentlyContinue) -and (Test-Path $gateway)) {
        Write-Host 'Starting IB Gateway...'
        Start-Process $gateway
    }
    Write-Host 'Waiting for IB Gateway on port 4001 -- log in (live, not paper).' -ForegroundColor Yellow
    while (-not (& $listening)) { Start-Sleep -Seconds 3 }
    Start-Sleep -Seconds 5   # the port opens a moment before the API answers
}

# Check the token against the server before recording all day into a 401.
try {
    $health = Invoke-RestMethod 'https://robinhood-pnl-tracker-production.up.railway.app/api/health' -TimeoutSec 15
    if (-not $health.orderflow.tokenConfigured) {
        Write-Host 'WARNING: ORDERFLOW_TOKEN is not set on the Railway service; pushes will fail.' -ForegroundColor Red
    } elseif ($health.orderflow.tokenLength -ne $env:ORDERFLOW_TOKEN.Length) {
        Write-Host 'WARNING: server token length does not match .orderflow_token; pushes will fail.' -ForegroundColor Red
    }
} catch {
    Write-Host "Could not reach the server health check: $($_.Exception.Message)" -ForegroundColor Yellow
}

& "$here\.venv\Scripts\python.exe" recorder.py @symbols
Read-Host "`nRecorder stopped. Press Enter to close"
