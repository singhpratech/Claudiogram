# Creates a Desktop shortcut for Claudiogram with its icon (no console flash).
# Run once from the Claudiogram folder:
#   powershell -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$desktop = [Environment]::GetFolderPath('Desktop')
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $desktop 'Claudiogram.lnk'))
$lnk.TargetPath = Join-Path $root 'Claudiogram.bat'
$lnk.WorkingDirectory = $root
$lnk.IconLocation = (Join-Path $root 'Claudiogram.ico') + ',0'
$lnk.WindowStyle = 7  # launch minimized so the batch console never pops up
$lnk.Description = 'Claudiogram - Claude Code usage observatory'
$lnk.Save()
Write-Host "Desktop shortcut created: Claudiogram.lnk -> $($lnk.TargetPath)"
