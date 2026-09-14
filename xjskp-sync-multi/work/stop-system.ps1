param()

$ErrorActionPreference = "Stop"
try {
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [Console]::InputEncoding = $utf8NoBom
  [Console]::OutputEncoding = $utf8NoBom
  $OutputEncoding = $utf8NoBom
}
catch {
  Write-Warning "Unable to set console UTF-8 encoding: $($_.Exception.Message)"
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$SystemDir = Join-Path $RootDir "runtime\system"
$LockPath = Join-Path $SystemDir "server.lock.json"
$RuntimeDir = Join-Path $RootDir "runtime"

function Normalize-PathText([string]$Value) {
  return $Value.Replace("/", "\").ToLowerInvariant()
}

function Get-ServerLock {
  if (!(Test-Path -LiteralPath $LockPath)) {
    return $null
  }
  try {
    return (Get-Content -LiteralPath $LockPath -Raw -Encoding UTF8 | ConvertFrom-Json)
  }
  catch {
    return $null
  }
}

function Stop-ByApi {
  $lock = Get-ServerLock
  if (!$lock -or [int]$lock.version -ne 2 -or !$lock.instanceId -or !$lock.port) {
    return $false
  }
  try {
    $session = Invoke-RestMethod -Uri "http://127.0.0.1:$($lock.port)/api/session" -Method Get -TimeoutSec 2
    if (!$session.token) {
      return $false
    }
    $headers = @{ "x-xjskp-session-token" = [string]$session.token }
    $body = @{ instanceId = [string]$lock.instanceId } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "http://127.0.0.1:$($lock.port)/api/system/stop" -Method Post -Headers $headers -ContentType "application/json" -Body $body -TimeoutSec 3 | Out-Null
    Start-Sleep -Milliseconds 700
    return $true
  }
  catch {
    return $false
  }
}

function Stop-RelatedProcesses($Lock) {
  if (!$Lock -or [int]$Lock.version -ne 2 -or !$Lock.instanceId -or !$Lock.pid) {
    return 0
  }
  $rootNeedle = Normalize-PathText([string]$RootDir)
  $runtimeNeedle = Normalize-PathText([string]$RuntimeDir)
  if (
    (Normalize-PathText([string]$Lock.rootDir)) -ne $rootNeedle -or
    (Normalize-PathText([string]$Lock.runtimeDir)) -ne $runtimeNeedle
  ) {
    return 0
  }
  $allProcesses = @(Get-CimInstance Win32_Process)
  $targetIds = @{}

  $owner = $allProcesses | Where-Object { [int]$_.ProcessId -eq [int]$Lock.pid } | Select-Object -First 1
  if (!$owner) {
    return 0
  }
  $ownerCommandLine = Normalize-PathText([string]$owner.CommandLine)
  if (!$ownerCommandLine.Contains($rootNeedle) -or !$ownerCommandLine.Contains("work\system\server.mjs")) {
    return 0
  }
  $targetIds[[int]$owner.ProcessId] = $true

  $allowedWrapperMarkers = @(
    "start-system.cmd",
    "work\start-system.ps1",
    "run-auto-plant.cmd",
    "work\run-auto-plant.ps1"
  )
  $parentId = [int]$owner.ParentProcessId
  while ($parentId -gt 0) {
    $parent = $allProcesses | Where-Object { [int]$_.ProcessId -eq $parentId } | Select-Object -First 1
    if (!$parent) {
      break
    }
    $parentCommandLine = Normalize-PathText([string]$parent.CommandLine)
    $isVerifiedWrapper = $parentCommandLine.Contains($rootNeedle) -and @(
      $allowedWrapperMarkers | Where-Object { $parentCommandLine.Contains($_) }
    ).Count -gt 0
    if (!$isVerifiedWrapper) {
      break
    }
    $targetIds[[int]$parent.ProcessId] = $true
    $parentId = [int]$parent.ParentProcessId
  }

  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($proc in $allProcesses) {
      $processId = [int]$proc.ProcessId
      $parentProcessId = [int]$proc.ParentProcessId
      if ($targetIds.ContainsKey($processId)) {
        continue
      }
      if ($targetIds.ContainsKey($parentProcessId)) {
        $targetIds[$processId] = $true
        $changed = $true
      }
    }
  }

  $processes = $allProcesses | Where-Object {
    $targetIds.ContainsKey([int]$_.ProcessId)
  } | Sort-Object ParentProcessId -Descending

  $stopped = 0
  foreach ($proc in $processes) {
    try {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
      $stopped += 1
    }
    catch {
      Write-Warning "Unable to stop PID $($proc.ProcessId): $($_.Exception.Message)"
    }
  }
  return $stopped
}

Write-Host "Stopping xjskp automation console..." -ForegroundColor Cyan
$ownerLock = Get-ServerLock
$apiStopped = Stop-ByApi
$fallbackStopped = if ($apiStopped) { 0 } else { Stop-RelatedProcesses $ownerLock }

if ($apiStopped -or $fallbackStopped -gt 0) {
  Write-Host "Stopped. API: $apiStopped, fallback processes: $fallbackStopped" -ForegroundColor Green
}
else {
  Write-Host "No running console or managed task was found." -ForegroundColor Yellow
}
