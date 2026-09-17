# Morning launcher for the order flow recorder -- the desktop shortcut runs this.
#
# The token lives in .orderflow_token beside this script (gitignored) and must
# match ORDERFLOW_TOKEN on the main Railway service, or every push is a 401.
#
# Usage:
#   start-recorder.ps1                 # resume whatever the panel is watching
#   start-recorder.ps1 AMD TSLA        # watch these instead (IBKR allows 3 at once)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
$Host.UI.RawUI.WindowTitle = 'Order flow recorder'

# Assigned in separate statements on purpose. `$symbols = if (...) { @($args) }`
# looks equivalent but is not: the if block's output goes through the pipeline,
# which unrolls a one-element array back to a bare string -- and splatting a
# string spreads its CHARACTERS, so one ticker became P, L, T, R and the
# recorder spent an afternoon watching AT&T.
# Empty means "resume the panel's list": the recorder asks the server what is
# being watched and adopts it, so double-clicking the shortcut after lunch no
# longer replaces the watch list with a hardcoded pair.
$symbols = @()
if ($args.Count) { $symbols = @($args) }

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
