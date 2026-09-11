# Keeps the wealth console running, and keeps it reachable.
#
# Two separate processes have to be alive for the dashboard to work from a
# phone: the Node server, and the cloudflared tunnel that publishes it. The
# first version of this script watched only the server, which is why the server
# kept surviving reboots while the link kept dying.
#
#   -Watch   stay resident and re-check every 5 minutes.
#
# Task Scheduler is locked down on this machine, so the watch mode is launched
# from the Startup folder instead. Same effect, no elevation needed.
#
# NOTE: a Cloudflare *quick* tunnel is anonymous, and its hostname is issued
# fresh on every start. This script cannot keep the address stable -- nothing
# can. It only keeps a working address existing, and records it in
# current-url.txt so there is somewhere to look it up.

param([switch]$Watch, [int]$IntervalMinutes = 5)

$root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $root 'server'
$node   = 'C:\Program Files\nodejs\node.exe'
$cfd    = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$log    = Join-Path $server 'console.log'
$tlog   = Join-Path $server 'tunnel.log'
$urlFile = Join-Path $root 'current-url.txt'

function Test-Listening {
  try {
    return [bool](Get-NetTCPConnection -LocalPort 4800 -State Listen -ErrorAction SilentlyContinue)
  } catch {
    return [bool](netstat -ano | Select-String ':4800\s+.*LISTENING')
  }
}

function Test-Tunnel {
  return [bool](Get-Process -Name 'cloudflared' -ErrorAction SilentlyContinue)
}

function Roll-Log($path) {
  if ((Test-Path $path) -and ((Get-Item $path).Length -gt 5MB)) { Move-Item $path "$path.old" -Force }
}

function Start-Console {
  if (-not (Test-Path $node)) { Write-Warning "node.exe not found at $node"; return }
  Roll-Log $log
  Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $server `
    -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  Write-Output ("{0}  started console" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
}

function Start-Tunnel {
  if (-not (Test-Path $cfd)) { Write-Warning "cloudflared not found at $cfd"; return }
  # The log is the only place the assigned hostname appears, so it is replaced
  # rather than appended -- otherwise the first match is a stale address.
  Remove-Item $tlog -ErrorAction SilentlyContinue
  Start-Process -FilePath $cfd `
    -ArgumentList 'tunnel','--url','http://127.0.0.1:4800','--no-autoupdate' `
    -WindowStyle Hidden -RedirectStandardOutput "$tlog.out" -RedirectStandardError $tlog

  # cloudflared prints the hostname a few seconds in. Poll rather than guess.
  $url = $null
  foreach ($i in 1..20) {
    Start-Sleep -Seconds 2
    if (Test-Path $tlog) {
      $m = Select-String -Path $tlog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue |
           Select-Object -First 1
      if ($m) { $url = $m.Matches[0].Value; break }
    }
  }
  if ($url) {
    Set-Content -Path $urlFile -Value $url -Encoding ascii
    Write-Output ("{0}  tunnel up: {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $url)
  } else {
    Write-Output ("{0}  tunnel started but no hostname seen yet" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
  }
}

function Ensure-Up {
  if (-not (Test-Listening)) { Start-Console; Start-Sleep -Seconds 5 }
  # The tunnel points at the server, so a restarted server needs a tunnel that
  # is still pointed at a live port. cloudflared reconnects on its own, so only
  # its absence matters here.
  if (-not (Test-Tunnel)) { Start-Tunnel }
}

if ($Watch) {
  # One watcher only. A second copy -- from a stray logon, a manual run, or a
  # session that never exited -- would race the first to notice a dead tunnel
  # and start a duplicate of it.
  #
  # A named mutex was the first attempt; the Global\ namespace needs rights this
  # account does not have, and PowerShell's binding of the constructor's out
  # parameter is unreliable. Counting the processes is blunt but it is true, and
  # it can be checked by eye.
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
  if (Test-Path $urlFile) { Write-Output ("current: " + (Get-Content $urlFile -Raw).Trim()) }
}
