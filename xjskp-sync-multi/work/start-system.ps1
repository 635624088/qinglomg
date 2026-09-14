param(
  [int]$Port = 0
)

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
$ServerScript = Join-Path $ScriptDir "system\server.mjs"
$BundledNode = Join-Path $RootDir "bin\node\node.exe"
$LockPath = Join-Path $RootDir "runtime\system\server.lock.json"
$SystemRuntimeDir = Split-Path -Parent $LockPath
$ServerStdoutLog = Join-Path $SystemRuntimeDir "server-start.out.log"
$ServerStderrLog = Join-Path $SystemRuntimeDir "server-start.err.log"

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

function Test-HealthyService($Lock) {
  if (!$Lock -or [int]$Lock.version -ne 2 -or !$Lock.instanceId -or !$Lock.pid -or !$Lock.port) {
    return $false
  }
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($Lock.port)/api/health" -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 500) {
      return $false
    }
    $health = $response.Content | ConvertFrom-Json
    $healthRoot = Normalize-PathText([string]$health.rootDir)
    $rootNeedle = Normalize-PathText([string]$RootDir)
    return (
      [int]$health.version -eq 2 -and
      [string]$health.instanceId -eq [string]$Lock.instanceId -and
      [int]$health.pid -eq [int]$Lock.pid -and
      [int]$health.port -eq [int]$Lock.port -and
      [string]$health.canonicalRuntimeDir -eq [string]$Lock.canonicalRuntimeDir -and
      [string]$health.guardName -eq [string]$Lock.guardName -and
      [string]$health.lifecycle -eq "ready" -and
      [string]$Lock.lifecycle -eq "ready" -and
      $healthRoot -eq $rootNeedle
    )
  }
  catch {
    return $false
  }
}

function Show-ServerStartupDiagnostics {
  Write-Host "Server stdout log: $ServerStdoutLog" -ForegroundColor Yellow
  Write-Host "Server stderr log: $ServerStderrLog" -ForegroundColor Yellow
  if (Test-Path -LiteralPath $ServerStdoutLog) {
    $stdoutTail = @(Get-Content -LiteralPath $ServerStdoutLog -Tail 20 -ErrorAction SilentlyContinue)
    if ($stdoutTail.Count) {
      Write-Host "--- server stdout tail ---" -ForegroundColor Yellow
      $stdoutTail | ForEach-Object { Write-Host $_ }
    }
  }
  if (Test-Path -LiteralPath $ServerStderrLog) {
    $stderrTail = @(Get-Content -LiteralPath $ServerStderrLog -Tail 40 -ErrorAction SilentlyContinue)
    if ($stderrTail.Count) {
      Write-Host "--- server stderr tail ---" -ForegroundColor Yellow
      $stderrTail | ForEach-Object { Write-Host $_ -ForegroundColor Red }
    }
  }
}

function Open-Console([int]$OpenPort) {
  Start-Process "http://127.0.0.1:$OpenPort/"
}

if (Test-Path -LiteralPath $BundledNode) {
  $NodeExe = $BundledNode
}
else {
  $node = @(Get-Command node -CommandType Application -ErrorAction SilentlyContinue) | Select-Object -First 1
  if (!$node) {
    throw "Cannot find node.exe. Use package-system to create a portable copy, or install Node.js 22+."
  }
  $NodeExe = $node.Path
  if (!$NodeExe) {
    $NodeExe = $node.Source
  }
  if (!$NodeExe) {
    $NodeExe = $node.Definition
  }
  $NodeExe = [string]$NodeExe
}

if (!(Test-Path -LiteralPath $ServerScript)) {
  throw "Cannot find system server: $ServerScript"
}

$existingLock = Get-ServerLock
if (Test-HealthyService $existingLock) {
  Write-Host "Existing xjskp automation console is healthy: http://127.0.0.1:$($existingLock.port)/" -ForegroundColor Green
  Open-Console ([int]$existingLock.port)
  exit 0
}

New-Item -ItemType Directory -Force -Path $SystemRuntimeDir | Out-Null
Remove-Item -LiteralPath $ServerStdoutLog, $ServerStderrLog -Force -ErrorAction SilentlyContinue

$argsList = @($ServerScript)
if ($Port -gt 0) {
  $argsList += "--port=$Port"
}
$argsList += "--open"

Write-Host "Starting xjskp automation console..." -ForegroundColor Cyan
Write-Host "Root: $RootDir"
Write-Host "Node: $NodeExe"
Write-Host "Console will stay in this window. Closing this window stops the local service." -ForegroundColor Yellow

Push-Location $RootDir
try {
  & $NodeExe @argsList
  $exitCode = $LASTEXITCODE
}
finally {
  Pop-Location
}

if ($null -eq $exitCode) {
  $exitCode = 0
}
exit $exitCode
