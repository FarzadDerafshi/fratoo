# release.ps1
# Cuts a Fratoo release: bumps the shared version in fratoo-bridge and
# fratoo-web, turns CHANGELOG.md's [Unreleased] section into a dated
# release, commits, and tags. Does NOT push or deploy.
# Convention: CHANGELOG.md "Versioning".
#
#   .\scripts\release.ps1 minor "UI Facelift"
#   .\scripts\release.ps1 patch "Chart gap fix" -DryRun
#
# Then:  git push origin main --follow-tags   and run ProdRelease.bat on the server.

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('major', 'minor', 'patch')]
    [string]$Bump,

    # Short release name for the CHANGELOG heading, e.g. "UI Facelift".
    [Parameter(Mandatory = $true, Position = 1)]
    [string]$Title,

    # Show what would happen without changing anything.
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
Set-Location $repoRoot

function Fail([string]$message) {
    Write-Host "[ERROR] $message" -ForegroundColor Red
    exit 1
}

# --- Preconditions -----------------------------------------------------------
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'main') { Fail "Releases are cut from main (currently on '$branch')." }
if (git status --porcelain) { Fail 'Working tree is not clean - commit or stash first.' }

$bridgePkg = Get-Content 'fratoo-bridge\package.json' -Raw | ConvertFrom-Json
$webPkg = Get-Content 'fratoo-web\package.json' -Raw | ConvertFrom-Json
if ($bridgePkg.version -ne $webPkg.version) {
    Fail "fratoo-bridge ($($bridgePkg.version)) and fratoo-web ($($webPkg.version)) versions differ - fix that first."
}

$parts = $bridgePkg.version.Split('.') | ForEach-Object { [int]$_ }
switch ($Bump) {
    'major' { $next = "$($parts[0] + 1).0.0" }
    'minor' { $next = "$($parts[0]).$($parts[1] + 1).0" }
    'patch' { $next = "$($parts[0]).$($parts[1]).$($parts[2] + 1)" }
}
$tag = "v$next"
if (git tag --list $tag) { Fail "Tag $tag already exists." }

# CHANGELOG.md: [Unreleased] must have something in it. Read and written as
# raw UTF-8 without BOM, keeping its existing line endings.
$changelogPath = Join-Path $repoRoot 'CHANGELOG.md'
$changelog = [IO.File]::ReadAllText($changelogPath)
$nl = if ($changelog.Contains("`r`n")) { "`r`n" } else { "`n" }
$match = [regex]::Match($changelog, "(?s)## \[Unreleased\]\r?\n(.*?)\r?\n---\r?\n")
if (-not $match.Success) { Fail 'CHANGELOG.md has no "## [Unreleased]" section followed by a --- separator.' }
if (-not ($match.Groups[1].Value -match '(?m)^- ')) { Fail 'CHANGELOG.md [Unreleased] has no entries - nothing to release.' }

$date = Get-Date -Format 'yyyy-MM-dd'
$heading = "## [$next] $([char]0x2014) $date $([char]0x2014) **$Title**"
Write-Host "Releasing $($bridgePkg.version) -> $next ($Bump): $Title"

if ($DryRun) {
    Write-Host "[dry run] Would set fratoo-bridge and fratoo-web to $next"
    Write-Host "[dry run] Would insert below [Unreleased]: $heading"
    Write-Host "[dry run] Would commit 'release: $tag - $Title' and tag $tag"
    exit 0
}

# --- Bump both packages (package.json + package-lock.json) --------------------
foreach ($dir in 'fratoo-bridge', 'fratoo-web') {
    Push-Location $dir
    npm version $next --no-git-tag-version --allow-same-version | Out-Null
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { Fail "npm version failed in $dir." }
}

# --- CHANGELOG: empty [Unreleased] on top, the old contents become the release
$replacement = "## [Unreleased]$nl$nl---$nl$nl$heading$nl"
$changelog = $changelog.Remove($match.Index, "## [Unreleased]".Length + $nl.Length).Insert($match.Index, $replacement)
[IO.File]::WriteAllText($changelogPath, $changelog, (New-Object System.Text.UTF8Encoding $false))

# --- Commit + annotated tag ---------------------------------------------------
git add CHANGELOG.md fratoo-bridge/package.json fratoo-bridge/package-lock.json fratoo-web/package.json fratoo-web/package-lock.json
git commit -q -m "release: $tag - $Title"
if ($LASTEXITCODE -ne 0) { Fail 'git commit failed.' }
git tag -a $tag -m "Fratoo $next - $Title"
if ($LASTEXITCODE -ne 0) { Fail 'git tag failed.' }

Write-Host "Done: committed and tagged $tag." -ForegroundColor Green
Write-Host 'Next: git push origin main --follow-tags   then run ProdRelease.bat on the server.'
