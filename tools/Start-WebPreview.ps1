param(
    [Parameter(Mandatory=$true)][string]$Ip,
    [Parameter(Mandatory=$true)][string]$Certificate,
    [switch]$LiveInput,
    [int]$Port = 9443
)
$ErrorActionPreference = 'Stop'
[void][System.Net.IPAddress]::Parse($Ip)
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be 1024–65535.' }
$certPath = (Resolve-Path -LiteralPath $Certificate).Path
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$hostRoot = Join-Path $projectRoot 'web-host'
$dll = Join-Path $hostRoot 'bin\Release\net10.0-windows\OpenDisplay.Web.dll'
if (!(Test-Path -LiteralPath $dll)) { throw 'Build the C++ Release target and web-host project first.' }
if ($LiveInput) { Write-Warning 'LIVE INPUT: an approved paired device can control the explicitly selected Windows display.' }
else { Write-Output 'DRY RUN: input is validated but never injected. Mirror/Extend still capture video.' }
Push-Location -LiteralPath $hostRoot
try {
    & dotnet $dll --ip $Ip --port $Port --cert $certPath --dry-run $((!$LiveInput.IsPresent).ToString().ToLowerInvariant())
    if ($LASTEXITCODE -ne 0) { throw "Web Host exited with code $LASTEXITCODE" }
} finally { Pop-Location }
