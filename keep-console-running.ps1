# Keeps the wealth console running.
#
# The weekly email is scheduled inside the server process, so the only thing that
# has to be true on a Sunday is that the server is up. This starts it if it is
# not, and does nothing if it is.
#
#   -Watch   stay resident and re-check every 30 minutes, so a crash or a
#            reboot does not quietly cost a week's email.
#
# Task Scheduler is locked down on this machine, so the watch mode is launched
# from the Startup folder instead. Same effect, no elevation needed.

param([switch]$Watch, [int]$IntervalMinutes = 30)

$root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $root 'server'
$node   = 'C:\Program Files\nodejs\node.exe'
$log    = Join-Path $server 'console.log'

function Test-Listening {
  try {
    return [bool](Get-NetTCPConnection -LocalPort 4800 -State Listen -ErrorAction SilentlyContinue)
  } catch {
    # Get-NetTCPConnection is absent on some editions; netstat is always there.
    return [bool](netstat -ano | Select-String ':4800\s+.*LISTENING')
  }
}

function Start-Console {
  if (-not (Test-Path $node)) { Write-Warning "node.exe not found at $node"; return }

  # Roll the log rather than letting it grow without limit.
  if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) { Move-Item $log "$log.old" -Force }

  Start-Process -FilePath $node `
    -ArgumentList 'server.js' `
    -WorkingDirectory $server `
    -WindowStyle Hidden `
    -RedirectStandardOutput $log `
    -RedirectStandardError "$log.err"

  Write-Output ("{0}  started console" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
}

if ($Watch) {
  while ($true) {
    if (-not (Test-Listening)) { Start-Console }
    Start-Sleep -Seconds ($IntervalMinutes * 60)
  }
} else {
  if (Test-Listening) { Write-Output 'already running'; exit 0 }
  Start-Console
}
