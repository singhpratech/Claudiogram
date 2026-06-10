# Creates a Desktop shortcut for Claudiogram with its icon (no console flash).
# Run once from the Claudiogram folder:
#   powershell -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1
# (If you run it with a full path that contains spaces, quote the -File argument.)
$ErrorActionPreference = 'Stop'

# Repo root is one level above this script's folder. $PSScriptRoot is reliable
# under -File; fall back to $MyInvocation for unusual hosts.
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$root = Split-Path -Parent $scriptDir

$bat = Join-Path $root 'Claudiogram.bat'
if (-not (Test-Path -LiteralPath $bat)) {
  throw "Claudiogram.bat not found at '$bat'. Keep this script inside the Claudiogram scripts folder."
}

$desktop = [Environment]::GetFolderPath('Desktop')
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $desktop 'Claudiogram.lnk'))
$lnk.TargetPath = $bat            # plain path; .lnk targets must NOT be re-quoted
$lnk.WorkingDirectory = $root
$icon = Join-Path $root 'Claudiogram.ico'
if (Test-Path -LiteralPath $icon) { $lnk.IconLocation = "$icon,0" }
$lnk.WindowStyle = 7  # launch minimized so the batch console never pops up
$lnk.Description = 'Claudiogram - Claude Code usage observatory'
$lnk.Save()
Write-Host "Desktop shortcut created: Claudiogram.lnk -> $($lnk.TargetPath)"
