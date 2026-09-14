param(
  [switch]$ResetSecrets,
  [switch]$Loop,
  [switch]$OrderStatus,
  [int]$LoopIntervalSeconds = 0,
  [int]$LoopMinIntervalSeconds = 30,
  [int]$LoopMaxIntervalSeconds = 58,
  [int]$MaxCycles = 0,
  [switch]$ForceLoop,
  [int]$KeepLogs = 10
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
$RootDir = Resolve-Path (Join-Path $ScriptDir "..")
$SecretPath = Join-Path $ScriptDir "game-secrets.json"
$NodeScript = Join-Path $ScriptDir "inspect-garden-dryrun.mjs"
$PruneLogsScript = Join-Path $ScriptDir "log-retention.mjs"
$NameScript = Join-Path $ScriptDir "extract-flower-names.mjs"
$FlowerNamePath = Join-Path $ScriptDir "flower-names.json"
$OutputDir = Join-Path $RootDir "outputs"
$GameDataSyncLockPath = Join-Path $RootDir "runtime/status/game-data-sync.lock"

if (Test-Path -LiteralPath $GameDataSyncLockPath) {
  Write-Host "Game data synchronization is in progress. Wait for it to finish before starting automation." -ForegroundColor Red
  exit 44
}

function Get-AutoLoopInstances {
  $runScriptPattern = [regex]::Escape((Join-Path $ScriptDir "run-auto-plant.ps1"))
  $nodeScriptPattern = [regex]::Escape($NodeScript)

  Get-CimInstance Win32_Process | Where-Object {
    $cmd = [string]$_.CommandLine
    $_.ProcessId -ne $PID -and
      $cmd -and
      (
        (($cmd -match $runScriptPattern) -and ($cmd -match "(?i)(^|\s)-Loop(\s|$)")) -or
        ($cmd -match $nodeScriptPattern)
      )
  }
}

if ($Loop -and !$ForceLoop) {
  $existingLoops = @(Get-AutoLoopInstances)
  if ($existingLoops.Count -gt 0) {
    Write-Host "Another xjskp auto loop is already running. Stop it first, or pass -ForceLoop to override." -ForegroundColor Red
    foreach ($item in $existingLoops) {
      Write-Host "PID $($item.ProcessId) $($item.Name): $($item.CommandLine)" -ForegroundColor Yellow
    }
    exit 37
  }
}

function Read-ProtectedValue {
  param(
    [Parameter(Mandatory = $true)][string]$Prompt
  )
  $secure = Read-Host -Prompt $Prompt -AsSecureString
  return ConvertFrom-SecureString -SecureString $secure
}

function Unprotect-Value {
  param(
    [Parameter(Mandatory = $true)][string]$CipherText
  )
  $secure = ConvertTo-SecureString -String $CipherText
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  }
  finally {
    if ($ptr -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
  }
}

function Save-Secrets {
  Write-Host "First run or reset: paste the current game credentials from Chrome DevTools/network." -ForegroundColor Yellow
  Write-Host "Sensitive values are saved with Windows DPAPI for this Windows user only." -ForegroundColor Yellow
  Write-Host ""

  $data = [ordered]@{
    CTOKEN     = Read-ProtectedValue "ctoken, example bigfish_ctoken_xxx"
    PC_USER_ID = Read-Host "PC userId, example 2088..."
    PC_TOKEN   = Read-ProtectedValue "x-game-token-pcweb / heartbeatPing token"
    BABI_TOKEN = Read-ProtectedValue "Babigame heartbeat/login token"
    OPEN_ID    = Read-ProtectedValue "Babigame _openid"
  }

  $data | ConvertTo-Json | Set-Content -LiteralPath $SecretPath -Encoding UTF8
  Write-Host "Encrypted credential file saved: $SecretPath" -ForegroundColor Green
}

function Test-FlowerNameMapReady {
  if (!(Test-Path -LiteralPath $FlowerNamePath)) {
    return $false
  }

  try {
    $raw = Get-Content -LiteralPath $FlowerNamePath -Raw -Encoding UTF8
    if (!$raw.Trim()) {
      return $false
    }

    $json = $raw | ConvertFrom-Json
    $count = ($json.PSObject.Properties | Measure-Object).Count
    return $count -gt 10
  }
  catch {
    return $false
  }
}

function Invoke-AutoLogRetention {
  param(
    [Parameter(Mandatory = $true)][string]$Phase
  )

  if ($KeepLogs -le 0) {
    return
  }
  if (!(Test-Path -LiteralPath $PruneLogsScript)) {
    Write-Warning "Cannot find log retention script: $PruneLogsScript"
    return
  }

  try {
    $retentionOutput = & $NodeExe $PruneLogsScript $OutputDir $KeepLogs
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "Log cleanup failed during ${Phase}."
      return
    }

    $retention = $retentionOutput | Select-Object -Last 1 | ConvertFrom-Json
    if ($retention.deletedCount -gt 0) {
      Write-Host "Pruned $($retention.deletedCount) old auto log(s) during ${Phase}; keeping latest $KeepLogs." -ForegroundColor DarkGray
    }
  }
  catch {
    Write-Warning "Log cleanup failed during ${Phase}: $($_.Exception.Message)"
  }
}

if ($ResetSecrets -and (Test-Path -LiteralPath $SecretPath)) {
  Remove-Item -LiteralPath $SecretPath -Force
  Write-Host "Existing encrypted credential file removed." -ForegroundColor Yellow
}

if (!(Test-Path -LiteralPath $SecretPath)) {
  Save-Secrets
}

if (!(Test-Path -LiteralPath $NodeScript)) {
  throw "Cannot find Node automation script: $NodeScript"
}

$node = @(Get-Command node -CommandType Application -ErrorAction SilentlyContinue) | Select-Object -First 1
if (!$node) {
  throw "Cannot find node.exe in PATH. Install Node.js or add node.exe to PATH."
}
$NodeExe = $node.Path
if (!$NodeExe) {
  $NodeExe = $node.Source
}
if (!$NodeExe) {
  $NodeExe = $node.Definition
}
$NodeExe = [string]$NodeExe
if (!$NodeExe -or !(Test-Path -LiteralPath $NodeExe)) {
  throw "Cannot resolve node.exe path from PATH."
}

if ((Test-Path -LiteralPath $NameScript) -and !(Test-FlowerNameMapReady)) {
  Write-Host "Preparing flower name map..." -ForegroundColor Cyan
  & $NodeExe $NameScript
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Flower name extraction failed; automation will continue with fallback flower IDs."
  }
}

$secrets = Get-Content -LiteralPath $SecretPath -Raw | ConvertFrom-Json
$env:CTOKEN = Unprotect-Value $secrets.CTOKEN
$env:PC_USER_ID = [string]$secrets.PC_USER_ID
$env:PC_TOKEN = Unprotect-Value $secrets.PC_TOKEN
$env:BABI_TOKEN = Unprotect-Value $secrets.BABI_TOKEN
$env:OPEN_ID = Unprotect-Value $secrets.OPEN_ID
$env:ACTION = if ($OrderStatus) { "orders-status" } elseif ($Loop) { "auto-loop" } else { "auto-loop" }
$env:SUMMARY_ONLY = "1"
if ($LoopIntervalSeconds -gt 0) {
  $env:LOOP_INTERVAL_SECONDS = [string]$LoopIntervalSeconds
  Remove-Item Env:\LOOP_INTERVAL_MIN_SECONDS -ErrorAction SilentlyContinue
  Remove-Item Env:\LOOP_INTERVAL_MAX_SECONDS -ErrorAction SilentlyContinue
}
else {
  Remove-Item Env:\LOOP_INTERVAL_SECONDS -ErrorAction SilentlyContinue
  $env:LOOP_INTERVAL_MIN_SECONDS = [string]$LoopMinIntervalSeconds
  $env:LOOP_INTERVAL_MAX_SECONDS = [string]$LoopMaxIntervalSeconds
}
if ($MaxCycles -gt 0) {
  $env:MAX_CYCLES = [string]$MaxCycles
}
elseif (!$OrderStatus -and !$Loop) {
  $env:MAX_CYCLES = "1"
}
else {
  Remove-Item Env:\MAX_CYCLES -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
Invoke-AutoLogRetention -Phase "startup"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $OutputDir "auto-plant-$timestamp.log"
$statusHtml = Join-Path $OutputDir "garden-status.html"
$statusMd = Join-Path $OutputDir "garden-status.md"
$statusJson = Join-Path $OutputDir "garden-status.json"

if ($OrderStatus) {
  Write-Host "Running read-only order status query..." -ForegroundColor Cyan
}
elseif ($Loop) {
  Write-Host "Running auto garden loop. Close this window to stop." -ForegroundColor Cyan
  if ($LoopIntervalSeconds -gt 0) {
    Write-Host "Cycle interval: $LoopIntervalSeconds seconds"
  }
  else {
    Write-Host "Cycle interval: random $LoopMinIntervalSeconds-$LoopMaxIntervalSeconds seconds"
  }
}
else {
  Write-Host "Running one-shot safe automation cycle..." -ForegroundColor Cyan
}
Write-Host "Log: $logPath"
Write-Host "Status HTML: $statusHtml"
Write-Host "Status Markdown: $statusMd"
Write-Host "Status JSON: $statusJson"
Write-Host ""

Push-Location $RootDir
try {
  [System.IO.File]::WriteAllText($logPath, "", $utf8NoBom)
  $env:AUTO_PLANT_LOG_PATH = $logPath
  $previousNativeCommandPreference = $null
  $hasNativeCommandPreference = Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue
  if ($hasNativeCommandPreference) {
    $previousNativeCommandPreference = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
  }
  try {
    & $NodeExe $NodeScript
    $exitCode = $LASTEXITCODE
  }
  finally {
    if ($hasNativeCommandPreference) {
      $PSNativeCommandUseErrorActionPreference = $previousNativeCommandPreference
    }
  }
}
finally {
  Remove-Item Env:\AUTO_PLANT_LOG_PATH -ErrorAction SilentlyContinue
  Pop-Location
}

Invoke-AutoLogRetention -Phase "finish"

if ($exitCode -ne 0) {
  Write-Host ""
  Write-Host "Automation failed. If credentials expired, run reset-auto-plant-secrets.cmd and paste fresh values." -ForegroundColor Red
  exit $exitCode
}

Write-Host ""
if ($OrderStatus) {
  Write-Host "Order status query completed." -ForegroundColor Green
}
elseif ($Loop) {
  Write-Host "Automation loop stopped." -ForegroundColor Green
}
else {
  Write-Host "Automation completed." -ForegroundColor Green
}
