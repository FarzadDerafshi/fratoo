# build-icons.ps1
# Renders the app icons (fratoo-web/icons/*.svg) to the PNGs the PWA
# manifest and iOS need, into fratoo-web/public/icons/. Uses headless
# Microsoft Edge (installed on every Windows 10/11 machine), so it needs no
# npm packages. The PNGs are committed; re-run only after changing an SVG.
#
#   .\scripts\build-icons.ps1

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path $PSScriptRoot -Parent
$srcDir = Join-Path $repoRoot 'fratoo-web\icons'
$outDir = Join-Path $repoRoot 'fratoo-web\public\icons'
$edge = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { Write-Error 'Microsoft Edge not found.'; exit 1 }

New-Item -ItemType Directory -Force $outDir | Out-Null
$work = Join-Path ([IO.Path]::GetTempPath()) "fratoo-icons-$PID"
New-Item -ItemType Directory -Force $work | Out-Null

# source svg, output png, size, transparent background?
$jobs = @(
    @('app-icon.svg', 'icon-192.png', 192, $true),
    @('app-icon.svg', 'icon-512.png', 512, $true),
    @('app-icon-maskable.svg', 'icon-maskable-512.png', 512, $false),
    @('app-icon-maskable.svg', 'apple-touch-icon.png', 180, $false),
    @('..\public\favicon.svg', 'favicon-32.png', 32, $true)
)

foreach ($job in $jobs) {
    $svgPath = (Resolve-Path (Join-Path $srcDir $job[0])).Path
    $size = $job[2]
    $svg = [IO.File]::ReadAllText($svgPath)
    $html = "<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}" +
        "svg{display:block;width:${size}px;height:${size}px}</style></head><body>$svg</body></html>"
    $htmlPath = Join-Path $work "$($job[1]).html"
    [IO.File]::WriteAllText($htmlPath, $html, (New-Object System.Text.UTF8Encoding $false))

    $outPath = Join-Path $outDir $job[1]
    $bg = if ($job[3]) { '--default-background-color=00000000' } else { '--default-background-color=0F2250FF' }
    # --user-data-dir keeps headless Edge away from the user's real profile.
    # Start-Process -Wait: calling msedge.exe directly returns before the
    # screenshot is written. Windows PowerShell joins ArgumentList without
    # quoting, so each argument is quoted here (paths may contain spaces).
    $edgeArgs = @('--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
        "--user-data-dir=$work\profile", "--window-size=$size,$size", $bg,
        "--screenshot=$outPath", "file:///$($htmlPath -replace '\\','/')") | ForEach-Object { '"' + $_ + '"' }
    Start-Process -FilePath $edge -ArgumentList $edgeArgs -Wait -NoNewWindow
    if (-not (Test-Path $outPath)) { Write-Error "Failed to render $($job[1])"; exit 1 }
    Write-Host "  $($job[1]) (${size}px)"
}

Remove-Item -Recurse -Force $work
Write-Host "Icons written to $outDir"
