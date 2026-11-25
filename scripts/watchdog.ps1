# GlobalMarketMonitor health watchdog (Windows PowerShell 5.1, ASCII only)
# Default: resident loop, checks /api/health every 30s and restarts the service if down.
# -Once  : single check for scheduled-task fallback (no resident loop).
# No third-party modules; all paths point to the D: project folder.

param(
  [switch]$Once,
  [int]$IntervalSec = 30,
  [int]$TimeoutSec = 6
)

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'   # suppress Invoke-WebRequest progress bar

$Root    = 'D:\WorkBuddy\projects\GlobalMarketMonitor'
$Node    = 'C:\Users\58451\.workbuddy\binaries\node\versions\22.22.2-6\node.exe'
$Entry   = Join-Path $Root 'server\server.js'
$LogDir  = Join-Path $Root 'data'
$Log     = Join-Path $LogDir 'watchdog.log'
$SvcOut  = Join-Path $LogDir 'service-stdout.log'
$SvcErr  = Join-Path $LogDir 'service-stderr.log'
$Health  = 'http://127.0.0.1:8777/api/health'
$Port    = 8777

if (-not (Test-Path $Node)) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $Node = $cmd.Source } else { $Node = $null }
}

function Write-Log([string]$msg) {
  $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $msg
  Add-Content -Path $Log -Value $line -Encoding UTF8
  try {
    $lines = @(Get-Content -Path $Log -Encoding UTF8)
    if ($lines.Count -gt 3000) {
      $lines | Select-Object -Last 2000 | Set-Content -Path $Log -Encoding UTF8
    }
  } catch {}
}

function Test-Health {
  try {
    $r = Invoke-WebRequest -Uri $Health -Method Get -TimeoutSec $TimeoutSec -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Start-MonitorService {
  if (-not $Node -or -not (Test-Path $Entry)) {
    Write-Log 'ERROR node.exe or server/server.js missing - cannot start'
    return $false
  }
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($listener) {
    Write-Log ('port ' + $Port + ' already has a listener (pid ' + ($listener.OwningProcess | Select-Object -First 1) + ') - skip start')
    return $true
  }
  # NOTE: Start-Process is avoided here. It builds a .NET environment dictionary and
  # throws "An item with the same key has already been added" when both 'https_proxy'
  # and 'HTTPS_PROXY' (case variants) exist on this machine. cmd.exe / WScript.Shell
  # inherits the raw environment block without that restriction.
  try {
    $cmdLine = 'cmd.exe /c cd /d "' + $Root + '" && "' + $Node + '" server\server.js --no-browser' +
      ' > "' + $SvcOut + '" 2> "' + $SvcErr + '"'
    $ws = New-Object -ComObject WScript.Shell
    $rc = $ws.Run($cmdLine, 0, $false)   # 0 = hidden window, false = do not wait
    Write-Log ('started service via hidden cmd (rc=' + $rc + ', logs: service-stdout.log / service-stderr.log)')
    return ($rc -eq 0)
  } catch {
    Write-Log ('ERROR start failed: ' + $_.Exception.Message)
    return $false
  }
}

if ($Once) {
  if (Test-Health) {
    Write-Log 'ONCE check: healthy'
  } else {
    Write-Log 'ONCE check: unhealthy -> starting service'
    Start-MonitorService | Out-Null
  }
  exit 0
}

Write-Log ('watchdog resident started (interval=' + $IntervalSec + 's, node=' + $Node + ')')
$failStreak = 0
while ($true) {
  if (Test-Health) {
    $failStreak = 0
  } else {
    $failStreak++
    Write-Log ('health DOWN (streak ' + $failStreak + ') -> restart attempt')
    Start-MonitorService | Out-Null
  }
  # backoff: 30s -> 60s -> 120s -> ... capped at 300s while unhealthy
  $wait = $IntervalSec
  if ($failStreak -gt 1) { $wait = [Math]::Min(300, $IntervalSec * [Math]::Pow(2, [Math]::Min(4, $failStreak - 1))) }
  Start-Sleep -Seconds $wait
}
