param(
  [string]$OutputDir = ""
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
$PortableMarker = Join-Path $RootDir "PORTABLE-RUNTIME.txt"

if ((Test-Path -LiteralPath $PortableMarker) -and !$OutputDir) {
  Write-Host "This folder is already the portable package: $RootDir" -ForegroundColor Green
  Write-Host "No nested package was created." -ForegroundColor Yellow
  exit 0
}

if (!$OutputDir) {
  $OutputDir = Join-Path $RootDir "release\xjskp-sync-multi-next"
}
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)
$ReleaseRoot = [System.IO.Path]::GetFullPath((Join-Path $RootDir "release"))
$ReleaseRootWithSlash = $ReleaseRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

if (!$OutputDir.StartsWith($ReleaseRootWithSlash, [System.StringComparison]::OrdinalIgnoreCase) -and
    !$OutputDir.Equals($ReleaseRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write package outside release: $OutputDir"
}

$BundledNode = Join-Path $RootDir "bin\node\node.exe"
if (Test-Path -LiteralPath $BundledNode) {
  $NodeExe = $BundledNode
}
else {
  $node = @(Get-Command node -CommandType Application -ErrorAction SilentlyContinue) | Select-Object -First 1
  if (!$node) {
    throw "Cannot find node.exe in PATH."
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

$Packager = Join-Path $RootDir "work\system\package-green.mjs"
if (!(Test-Path -LiteralPath $Packager)) {
  throw "Cannot find package generator: $Packager"
}

& $NodeExe $Packager "--root=$RootDir" "--out=$OutputDir" "--node=$NodeExe"
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Write-Host "Portable package created: $OutputDir" -ForegroundColor Green
Write-Host "Use this folder as the only runtime source." -ForegroundColor Cyan
