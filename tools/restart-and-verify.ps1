# Restart the dsh web host so it loads the current plugin host code, then verify.
#
# Why a restart is required: the client half of a plugin is rebuilt and served on
# every page load, but the host half is `require`d once at process start. This
# process started 38 minutes before the plugin was linked into the profile, so it
# has been running the first version of lib/index.js ever since — which is why the
# inventory route kept taking ~9 s even after the underlying fix landed.
#
# Run this from a shell that is NOT the dsh session being restarted.
#
# Because the host being replaced is the one this agent turn runs inside, the
# operator launches this detached (see restart-detached.ps1) with a delay, so the
# turn can finish and report before the process goes away.

param(
  [int]$DelaySeconds = 20
)

$ErrorActionPreference = 'Stop'

$DSH    = if ($env:DSH_LAUNCHER) { $env:DSH_LAUNCHER } else { 'dsh.cmd' }
$PLUGIN = if ($env:DSH_PLUGIN_DIR) { $env:DSH_PLUGIN_DIR } else { Split-Path -Parent $PSScriptRoot }
$URL    = if ($env:DSH_URL) { $env:DSH_URL } else { 'http://127.0.0.1:3080' }
$LOG    = Join-Path $PSScriptRoot 'restart-log.txt'

# The GUI gate is an authority-bound signed cookie. Its value is a bearer
# credential, so it is never stored in this file: pass it in explicitly.
#   $env:DSH_COOKIE_NAME / $env:DSH_COOKIE_VALUE
# The step-6 GUI drive below is skipped when they are absent.
$COOKIE_NAME = $env:DSH_COOKIE_NAME
$COOKIE_VALUE = $env:DSH_COOKIE_VALUE
$haveCookie = -not [string]::IsNullOrWhiteSpace($COOKIE_NAME) -and -not [string]::IsNullOrWhiteSpace($COOKIE_VALUE)

# Mirror everything to a log file: the host being replaced is the one this session
# runs in, so a failure here must leave a readable trace behind.
try { Start-Transcript -Path $LOG -Force | Out-Null } catch { }

Write-Output "waiting ${DelaySeconds}s so the requesting turn can finish and report"
Start-Sleep -Seconds $DelaySeconds
Write-Output ''

function Get-DshProcess {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'dsh\\lib\\bin\.js"\s+web|dsh.*bin\.js.*web' }
}

function Test-Responsive {
  try {
    $response = Invoke-WebRequest -Uri "$URL/session-deleter/health" -UseBasicParsing -TimeoutSec 5
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

Write-Output '=== 1. stop the running host ==='
$running = Get-DshProcess
if ($running) {
  foreach ($process in $running) {
    Write-Output "  stopping PID $($process.ProcessId)"
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 3
} else {
  Write-Output '  no running host found'
}

Write-Output ''
Write-Output '=== 2. start it again in the background ==='
# Inherit the harness home when the caller already exported one; otherwise leave
# the launcher to its own default (~/.dsh).
if (-not $env:DSH_HOME) { Write-Output '  DSH_HOME not set; the launcher will use its default' }
$env:DSH_PROFILE = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'web' }
# The launcher rewrites DSH_SESSION_ID and DSH_SHELL for the session it hosts, so
# they are cleared here rather than inherited from this shell.
Remove-Item Env:DSH_SESSION_ID -ErrorAction SilentlyContinue
Remove-Item Env:DSH_SHELL -ErrorAction SilentlyContinue

$child = Start-Process -FilePath $DSH -ArgumentList 'web' -WindowStyle Hidden -PassThru
Write-Output "  launcher PID $($child.Id)"

Write-Output ''
Write-Output '=== 3. wait for the health route ==='
$ready = $false
for ($attempt = 1; $attempt -le 60; $attempt++) {
  Start-Sleep -Seconds 1
  if (Test-Responsive) { $ready = $true; Write-Output "  healthy after ${attempt}s"; break }
}
if (-not $ready) {
  Write-Output '  host did not answer /session-deleter/health within 60s'
  exit 1
}

Write-Output ''
Write-Output '=== 4. time the inventory route (was ~9.2s before the fix) ==='
if (-not $haveCookie) {
  Write-Output '  skipped: set DSH_COOKIE_NAME and DSH_COOKIE_VALUE to time the authenticated route'
} else {
  $header = @{ Cookie = "$COOKIE_NAME=$COOKIE_VALUE" }
  # Warm one request so module caching is not measured, then time the real one.
  Invoke-WebRequest -Uri "$URL/session-deleter/inventory" -Headers $header -UseBasicParsing -TimeoutSec 120 | Out-Null
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $response = Invoke-WebRequest -Uri "$URL/session-deleter/inventory" -Headers $header -UseBasicParsing -TimeoutSec 120
  $sw.Stop()
  $payload = $response.Content | ConvertFrom-Json
  Write-Output ("  status {0}  {1:N0} ms  {2} sessions  {3} titled  {4} bytes" -f `
    $response.StatusCode, $sw.Elapsed.TotalMilliseconds, $payload.sessions.Count, `
    ($payload.sessions | Where-Object { $_.title -ne '' }).Count, $response.RawContentLength)
  if ($sw.Elapsed.TotalMilliseconds -gt 3000) {
    Write-Output '  STILL SLOW: the host may not have picked up the new lib/sessions.js'
    exit 1
  }
}

Write-Output ''
Write-Output '=== 5. re-run the three verification suites ==='
# The host suite resolves its session root the same way the plugin does.
$sessionsDir = if ($env:DSH_SESSIONS_DIR) { $env:DSH_SESSIONS_DIR } elseif ($env:DSH_HOME) { Join-Path $env:DSH_HOME 'sessions' } else { '' }
Push-Location $PLUGIN
if ($sessionsDir) { node tools\verify-host.mjs $sessionsDir 2>&1 | Select-Object -Last 2 }
else { node tools\verify-host.mjs 2>&1 | Select-Object -Last 2 }
node tools\verify-http.mjs 2>&1 | Select-Object -Last 2
node tools\verify-client.mjs 2>&1 | Select-Object -Last 2
Pop-Location

Write-Output ''
Write-Output '=== 6. drive the real GUI ==='
if (-not $haveCookie) {
  Write-Output '  skipped: set DSH_COOKIE_NAME and DSH_COOKIE_VALUE to drive the authenticated GUI'
} else {
  Push-Location $PLUGIN
  node tools\verify-ui.mjs "$env:TEMP\dshsd-shots" 2>&1
  node tools\verify-footer.mjs 2>&1
  Pop-Location
}
