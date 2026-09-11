# Keeps the wealth console running.
#
#   -Watch   stay resident and re-check every 5 minutes.
#
# Reachability is no longer this script's job. The console is published at a
# permanent address by Tailscale Funnel:
#
#     https://ryanpc.tailc3f56d.ts.net
#
# Tailscale runs as an automatic Windows service and keeps the Funnel config in
# its own state, so it returns after a reboot without help. That replaced a
# cloudflared quick tunnel, which had to be watched precisely because it could
# not be relied on -- and which was issued a different hostname every time it
# started, so there was never a link worth bookmarking.
#
# What still needs watching is the Node server. If it is down, Funnel faithfully
# proxies to a closed port and the address answers with nothing.
#
# Task Scheduler is locked down on this machine, so watch mode is launched from
# the Startup folder instead. Same effect, no elevation needed.

param([switch]$Watch, [int]$IntervalMinutes = 5)

$root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$server  = Join-Path $root 'server'
$node    = 'C:\Program Files\nodejs\node.exe'
$ts      = 'C:\Program Files\Tailscale\tailscale.exe'
$log     = Join-Path $server 'console.log'
$urlFile = Join-Path $root 'current-url.txt'
$publicUrl = 'https://ryanpc.tailc3f56d.ts.net'

function Test-Listening {
  try {
    return [bool](Get-NetTCPConnection -LocalPort 4800 -State Listen -ErrorAction SilentlyContinue)
  } catch {
    return [bool](netstat -ano | Select-String ':4800\s+.*LISTENING')
  }
}

function Start-Console {
  if (-not (Test-Path $node)) { Write-Warning "node.exe not found at $node"; return }
  if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) { Move-Item $log "$log.old" -Force }
  Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $server `
    -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  Write-Output ("{0}  started console" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
}

# Cheap insurance. The Funnel config is persistent, but if it were ever cleared
# the dashboard would go dark quietly -- the address keeps resolving and simply
# stops answering. Re-applying costs nothing when it is already set.
function Ensure-Funnel {
  if (-not (Test-Path $ts)) { return }
  $status = & $ts funnel status 2>&1 | Out-String
  if ($status -notmatch 'Funnel on') {
    & $ts funnel --bg 4800 2>&1 | Out-Null
    Write-Output ("{0}  re-applied funnel" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
  }
}

function Ensure-Up {
  if (-not (Test-Listening)) { Start-Console; Start-Sleep -Seconds 5 }
  Ensure-Funnel
  Set-Content -Path $urlFile -Value $publicUrl -Encoding ascii
}

if ($Watch) {
  # One watcher only. A second copy -- from a stray logon, a manual run, or a
  # session that never exited -- would duplicate the work and could race to
  # start two servers. Counting the matching processes is blunt but it is true,
  # and it can be checked by eye.
  $me = $PID
  $others = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
              Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -like '*keep-console-running*-Watch*' })
  if ($others.Count -gt 0) {
    Write-Output ("another watcher already running (pid {0}) - exiting" -f $others[0].ProcessId)
    exit 0
  }

  while ($true) {
    try { Ensure-Up } catch { Write-Warning $_.Exception.Message }
    Start-Sleep -Seconds ($IntervalMinutes * 60)
  }
} else {
  Ensure-Up
  Write-Output ("console: " + $(if (Test-Listening) {"up"} else {"DOWN"}) + "   public: $publicUrl")
}
