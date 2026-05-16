<#
.SYNOPSIS
  Sync user-level skills (~/.copilot/skills) INTO this repo (.github/skills).

.DESCRIPTION
  User dir is the source of truth. Repo dir is the mirror. Files that exist
  only in the repo will be DELETED (since /MIR is used) — review with -DryRun
  first if unsure. .zip archives are excluded.

.PARAMETER DryRun
  Show what robocopy would do without making changes (uses /L).

.PARAMETER Reverse
  Sync the OTHER direction: repo → user. Use only if you intentionally edited
  the repo copy and want to promote those changes back to user.

.EXAMPLE
  ./.github/sync-skills.ps1 -DryRun
  ./.github/sync-skills.ps1
  ./.github/sync-skills.ps1 -Reverse
#>
[CmdletBinding()]
param(
  [switch] $DryRun,
  [switch] $Reverse
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$RepoSkills = Join-Path $RepoRoot '.github\skills'
$UserSkills = Join-Path $HOME '.copilot\skills'

if (-not (Test-Path $UserSkills)) {
  New-Item -ItemType Directory -Path $UserSkills -Force | Out-Null
}
if (-not (Test-Path $RepoSkills)) {
  New-Item -ItemType Directory -Path $RepoSkills -Force | Out-Null
}

if ($Reverse) {
  $src = $RepoSkills
  $dst = $UserSkills
  Write-Host "Direction: REPO -> USER" -ForegroundColor Yellow
} else {
  $src = $UserSkills
  $dst = $RepoSkills
  Write-Host "Direction: USER -> REPO (default)" -ForegroundColor Cyan
}

Write-Host "  Source: $src"
Write-Host "  Target: $dst"

$flags = @('/MIR', '/XF', '*.zip', '/R:1', '/W:1', '/NFL', '/NDL', '/NP')
if ($DryRun) {
  $flags += '/L'
  Write-Host "  Mode:   DRY RUN (no changes)" -ForegroundColor Magenta
}

& robocopy $src $dst @flags
$code = $LASTEXITCODE

# Robocopy exit codes 0-7 = success; 8+ = failure.
Write-Host ""
if ($code -lt 8) {
  Write-Host ("Done. Robocopy exit code: {0} (success)" -f $code) -ForegroundColor Green
  $meaning = @{
    0 = 'No files copied. Source and target already in sync.'
    1 = 'Files copied successfully.'
    2 = 'Extra files/dirs in target were detected/removed.'
    3 = 'Files copied + extras handled.'
    5 = 'Some files copied + mismatches.'
    7 = 'Files copied + mismatches + extras.'
  }
  if ($meaning.ContainsKey($code)) { Write-Host "  -> $($meaning[$code])" }
} else {
  Write-Error "Robocopy failed with exit code $code"
  exit $code
}

exit 0
