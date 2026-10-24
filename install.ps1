# BirbMod installer. In PowerShell:
#
#   irm https://raw.githubusercontent.com/ZeldoKavira/BirbMod/main/install.ps1 | iex
#
# Downloads the latest release into %LOCALAPPDATA%\BirbMod\app and adds a "Birb (Mods)" shortcut to the desktop and
# Start menu. Start the game with that shortcut; the launcher keeps itself and the mods up to date. Running this again
# reinstalls. Steam's own settings aren't touched. To remove: delete %LOCALAPPDATA%\BirbMod and the two shortcuts.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with its progress bar on
$repo = 'ZeldoKavira/BirbMod'
$app = Join-Path $env:LOCALAPPDATA 'BirbMod\app'

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

Write-Host 'BirbMod: finding the latest release...'
$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'BirbMod-installer' }
$asset = $release.assets | Where-Object { $_.name -like '*.zip' } | Select-Object -First 1
if (-not $asset) { throw "Release $($release.tag_name) has no zip to install." }

$zip = Join-Path $env:TEMP $asset.name
Write-Host "BirbMod: downloading $($release.tag_name)..."
Invoke-WebRequest $asset.browser_download_url -OutFile $zip -UseBasicParsing

# A launcher running from this install holds its exe open; it'll be started again from the shortcut. (Copies
# running from anywhere else are left alone.)
Get-Process BirbLauncher -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($app, [StringComparison]::OrdinalIgnoreCase) } |
    Stop-Process -Force
Start-Sleep -Milliseconds 500
New-Item -ItemType Directory -Force $app | Out-Null
Expand-Archive $zip -DestinationPath $app -Force
Remove-Item $zip -Force

# Use the game's own icon for the shortcut when Birb can be found through Steam.
$icon = $null
try {
    $steam = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction Stop).SteamPath -replace '/', '\'
    $libraries = @($steam)
    $vdf = Join-Path $steam 'steamapps\libraryfolders.vdf'
    if (Test-Path $vdf) {
        $libraries += [regex]::Matches((Get-Content $vdf -Raw), '"path"\s*"([^"]+)"') | ForEach-Object { $_.Groups[1].Value -replace '\\\\', '\' }
    }
    foreach ($lib in $libraries) {
        $exe = Join-Path $lib 'steamapps\common\Birb\birb.exe'
        if (Test-Path $exe) { $icon = $exe; break }
    }
} catch { }
if (-not $icon) { Write-Host 'BirbMod: note - Birb was not found through Steam yet. Install it from Steam before using the shortcut.' }

$launcher = Join-Path $app 'BirbLauncher.exe'
$shell = New-Object -ComObject WScript.Shell
$folders = @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'))
foreach ($folder in $folders) {
    $link = $shell.CreateShortcut((Join-Path $folder 'Birb (Mods).lnk'))
    $link.TargetPath = $launcher
    $link.WorkingDirectory = $app
    $link.Description = 'Birb with mods'
    if ($icon) { $link.IconLocation = "$icon,0" }
    $link.Save()
}

Write-Host ''
Write-Host "BirbMod $($release.tag_name) installed. Start Birb with the 'Birb (Mods)' shortcut on the desktop or in the Start menu."
Write-Host 'Mod options are in the game under Settings > Mods (or press F10).'
