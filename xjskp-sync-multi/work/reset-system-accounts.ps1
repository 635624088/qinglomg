param(
  [switch]$Confirm,
  [string]$ResumeOperationId = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$CliScript = Join-Path $ScriptDir "system\account-reset-cli.mjs"
$BundledNode = Join-Path $RootDir "bin\node\node.exe"
$NodeExe = if (Test-Path -LiteralPath $BundledNode) { $BundledNode } else { "node" }

if (!(Test-Path -LiteralPath $CliScript)) {
  throw "Account reset CLI not found: $CliScript"
}

$CliArgs = @($CliScript, "--root=$RootDir")
if ($Confirm) {
  $CliArgs += "--confirm=RESET-CREDENTIALS"
}
if ($ResumeOperationId) {
  $CliArgs += "--resume=$ResumeOperationId"
}

& $NodeExe @CliArgs
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
