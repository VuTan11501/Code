<#
.SYNOPSIS
  Pre-commit checklist for this repo. Run before `git commit`.

.DESCRIPTION
  Enforces project conventions documented in KNOWLEDGE.md / AGENTS.md:
    1. Commit message subject (passed as -Message) follows
       `type(scope): subject` Conventional Commits with an allowlisted scope.
    2. Every staged .js file under docs/js passes `node --check`.
    3. If any staged file lives under docs/css/ or docs/js/, the matching
       cache-buster `?v=NN` in docs/index.html and docs/suica.html must
       have been bumped in the same commit.

  Exits 0 on success, non-zero on the first failure. Designed to be cheap
  (typically < 1s) so the manager agent runs it before EVERY commit.

.EXAMPLE
  pwsh scripts/precommit-check.ps1 -Message "fix(suica-pdf): patch CMap"

.NOTES
  Scope allowlist mirrors KNOWLEDGE.md §2. Update both together.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Message,

  [switch]$SkipNodeCheck,
  [switch]$SkipCacheBuster
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

# ── 1. Conventional Commits with feature scope ─────────────────────────
$allowedTypes = @(
  'feat','fix','refactor','perf','test','docs','chore','style','revert','ci','build'
)
$allowedScopes = @(
  'suica-pdf','suica-ui','suica-planner','suica-history','suica-fare',
  'dokokin','ot','rakuraku','dashboard','dashboard-ui','i18n','worker',
  'ci','agents-ui','docs','repo','graph-dashboard'
)

$subject = ($Message -split "`n")[0].Trim()
if ($subject -notmatch '^(?<type>[a-z]+)\((?<scope>[a-z0-9-]+)\):\s+\S') {
  Write-Host "✗ Commit subject must be 'type(scope): subject'." -ForegroundColor Red
  Write-Host "  Got: $subject"
  Write-Host "  Example: fix(suica-pdf): patch ToUnicode CMap"
  exit 2
}
$type  = $Matches['type']
$scope = $Matches['scope']
if ($type -notin $allowedTypes) {
  Write-Host "✗ Unknown type '$type'. Allowed: $($allowedTypes -join ', ')" -ForegroundColor Red
  exit 2
}
if ($scope -notin $allowedScopes) {
  Write-Host "✗ Unknown scope '$scope'." -ForegroundColor Red
  Write-Host "  Allowed scopes (see KNOWLEDGE.md §2): $($allowedScopes -join ', ')"
  Write-Host "  If this is a new feature area, add the scope to BOTH this script and KNOWLEDGE.md §2 first."
  exit 2
}
Write-Host "✓ Commit subject OK: $type($scope)" -ForegroundColor Green

# ── 2. Staged files ─────────────────────────────────────────────────────
Push-Location $repo
try {
  $stagedRaw = (& git diff --cached --name-only --diff-filter=ACMR) 2>$null
  if (-not $stagedRaw) {
    Write-Host "✗ Nothing staged for commit." -ForegroundColor Red
    exit 3
  }
  $staged = $stagedRaw -split "`n" | Where-Object { $_ }

  # ── 2a. node --check on staged JS ────────────────────────────────────
  if (-not $SkipNodeCheck) {
    $jsFiles = $staged | Where-Object { $_ -match '^docs/js/.+\.js$' -and $_ -notmatch '\.min\.js$' }
    foreach ($f in $jsFiles) {
      $full = Join-Path $repo $f
      if (-not (Test-Path $full)) { continue }
      $out = & node --check $full 2>&1
      if ($LASTEXITCODE -ne 0) {
        Write-Host "✗ node --check failed for $f" -ForegroundColor Red
        Write-Host $out
        exit 4
      }
    }
    if ($jsFiles) { Write-Host "✓ node --check passed for $($jsFiles.Count) JS file(s)" -ForegroundColor Green }
  }

  # ── 2b. Cache-buster discipline ──────────────────────────────────────
  if (-not $SkipCacheBuster) {
    $assetTouched = $staged | Where-Object { $_ -match '^docs/(css|js)/' -and $_ -notmatch '\.min\.js$' }
    if ($assetTouched) {
      $htmlBumped = $staged | Where-Object { $_ -in @('docs/index.html','docs/suica.html') }
      if (-not $htmlBumped) {
        Write-Host "✗ Touched docs/css or docs/js asset but no docs/*.html cache-buster bump staged." -ForegroundColor Red
        Write-Host "  Touched: $($assetTouched -join ', ')"
        Write-Host "  Bump ?v=NN in docs/index.html and/or docs/suica.html for the affected file."
        exit 5
      }
      # Confirm a `?v=` line is part of the staged diff
      $diff = (& git diff --cached -- docs/index.html docs/suica.html 2>$null) -join "`n"
      if ($diff -notmatch '\?v=\d+') {
        Write-Host "✗ docs/*.html is staged but the diff doesn't contain a ?v= bump." -ForegroundColor Red
        Write-Host "  Ensure the cache-buster query string was actually incremented."
        exit 5
      }
      Write-Host "✓ Cache-buster bump detected" -ForegroundColor Green
    }
  }

  # ── 2c. Trailer check ────────────────────────────────────────────────
  if ($Message -notmatch 'Co-authored-by:\s*Copilot\s*<223556219\+Copilot@users\.noreply\.github\.com>') {
    Write-Host "⚠ Missing Co-authored-by: Copilot trailer. Add via -m flag." -ForegroundColor Yellow
    # Not blocking — but warn.
  } else {
    Write-Host "✓ Co-authored-by trailer present" -ForegroundColor Green
  }

  Write-Host "`n✅ Pre-commit checks passed." -ForegroundColor Green
  exit 0
}
finally {
  Pop-Location
}
