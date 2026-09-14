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
$NodeScript = Join-Path $ScriptDir "sync-latest-static-config.mjs"

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

if (!(Test-Path -LiteralPath $NodeScript)) {
  throw "Missing sync script: $NodeScript"
}

$nodeCandidates = @(
  (Join-Path $RootDir "node.exe"),
  "node"
)
$NodeExe = $null
foreach ($candidate in $nodeCandidates) {
  $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
  if ($cmd) {
    $NodeExe = $cmd.Source
    break
  }
}
if (!$NodeExe) {
  throw "Cannot find node executable."
}

if (!(Test-Path -LiteralPath $SecretPath)) {
  Push-Location $RootDir
  try {
    & $NodeExe $NodeScript
    if ($LASTEXITCODE -ne 0) {
      throw "sync-latest-static-config.mjs failed with exit code $LASTEXITCODE"
    }
  }
  finally {
    Pop-Location
  }
  return
}

$secrets = Get-Content -LiteralPath $SecretPath -Raw -Encoding UTF8 | ConvertFrom-Json
$oldEnv = @{
  CTOKEN = $env:CTOKEN
  PC_USER_ID = $env:PC_USER_ID
  PC_TOKEN = $env:PC_TOKEN
  BABI_TOKEN = $env:BABI_TOKEN
  OPEN_ID = $env:OPEN_ID
}

try {
  $env:CTOKEN = Unprotect-Value $secrets.CTOKEN
  $env:PC_USER_ID = [string]$secrets.PC_USER_ID
  $env:PC_TOKEN = Unprotect-Value $secrets.PC_TOKEN
  $env:BABI_TOKEN = Unprotect-Value $secrets.BABI_TOKEN
  $env:OPEN_ID = Unprotect-Value $secrets.OPEN_ID

  Push-Location $RootDir
  try {
    & $NodeExe $NodeScript
    if ($LASTEXITCODE -ne 0) {
      throw "sync-latest-static-config.mjs failed with exit code $LASTEXITCODE"
    }
  }
  finally {
    Pop-Location
  }
}
finally {
  $env:CTOKEN = $oldEnv.CTOKEN
  $env:PC_USER_ID = $oldEnv.PC_USER_ID
  $env:PC_TOKEN = $oldEnv.PC_TOKEN
  $env:BABI_TOKEN = $oldEnv.BABI_TOKEN
  $env:OPEN_ID = $oldEnv.OPEN_ID
}
