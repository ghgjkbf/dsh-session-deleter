# Launch restart-and-verify.ps1 fully detached from the current dsh session.
#
# `Start-Process` alone is not enough: a child still lives inside this session's
# process tree, so it dies with the host it is meant to restart. Win32_Process
# Create hands the work to the WMI service, which owns the new process directly —
# it therefore outlives the dsh host that spawned this script.
#
# Usage: powershell -File restart-detached.ps1 [-DelaySeconds 20]

param(
  [int]$DelaySeconds = 20
)

$script = Join-Path $PSScriptRoot 'restart-and-verify.ps1'
$log    = Join-Path $PSScriptRoot 'restart-log.txt'

# Truncate any previous run's log so the next read is unambiguous.
if (Test-Path $log) { Remove-Item $log -Force -ErrorAction SilentlyContinue }

# Resolve the host shell by full path: this environment has Windows PowerShell
# (powershell.exe), not pwsh, and the detached process inherits no PATH help.
$shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $shell)) {
  Write-Output "no PowerShell host found at $shell"
  exit 1
}

$commandLine = '"{0}" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "{1}" -DelaySeconds {2}' -f $shell, $script, $DelaySeconds

$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = $commandLine
}

if ($result.ReturnValue -ne 0) {
  Write-Output "failed to launch detached restart: ReturnValue=$($result.ReturnValue)"
  exit 1
}

Write-Output "detached restart launched: PID $($result.ProcessId), delay ${DelaySeconds}s"
Write-Output "log: $log"
