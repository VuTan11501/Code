<#
.SYNOPSIS
  Pull workflow run logs locally for debugging.

.DESCRIPTION
  Wraps `gh run view <run-id> --log` and saves output to
  `test-results/run-<id>.log` so the manager agent can grep/view it
  without polluting chat context.

  Also extracts the FAILED step output into a separate
  `test-results/run-<id>-fail.log` for quick triage.

.EXAMPLE
  pwsh scripts/fetch-run-logs.ps1 -RunId 9876543210
  pwsh scripts/fetch-run-logs.ps1 -RunId 9876543210 -Workflow suica-pdf-generate.yml
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RunId,

  [string]$Workflow,
  [string]$OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'test-results')
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Write-Error "gh CLI not found. Install from https://cli.github.com/"
  exit 1
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$logPath  = Join-Path $OutDir "run-$RunId.log"
$failPath = Join-Path $OutDir "run-$RunId-fail.log"
$jsonPath = Join-Path $OutDir "run-$RunId.json"

Write-Host "→ Fetching run metadata for $RunId ..." -ForegroundColor Cyan
& gh run view $RunId --json status,conclusion,name,workflowName,headBranch,createdAt,updatedAt,jobs > $jsonPath 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Error "gh run view failed for run $RunId. Check the run ID and 'gh auth status'."
  exit 2
}

$meta = Get-Content $jsonPath | ConvertFrom-Json
Write-Host "  Workflow:   $($meta.workflowName)"
Write-Host "  Status:     $($meta.status) / $($meta.conclusion)"
Write-Host "  Branch:     $($meta.headBranch)"
Write-Host "  Created:    $($meta.createdAt)"
Write-Host ""

Write-Host "→ Downloading full log to $logPath ..." -ForegroundColor Cyan
& gh run view $RunId --log > $logPath 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Warning "Full log fetch failed. Trying --log-failed instead."
}

Write-Host "→ Downloading FAILED-step log to $failPath ..." -ForegroundColor Cyan
& gh run view $RunId --log-failed > $failPath 2>$null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $failPath) -or (Get-Item $failPath).Length -eq 0) {
  Write-Host "  (no failed step — run probably succeeded)" -ForegroundColor Yellow
  Remove-Item $failPath -ErrorAction SilentlyContinue
}

# Quick summary of common verify_pdf failure signatures so the manager can
# decide whether this is a known bug class from KNOWLEDGE.md §3.
$verifySigs = @(
  @{ Pattern = 'NO-SOFT-HYPHEN';   Hint = 'KNOWLEDGE.md §3.1 (IPAGothic CMap)' }
  @{ Pattern = 'NO-EMPTY-CELLS';   Hint = 'KNOWLEDGE.md §3.1 cascade — fix CMap, not parser' }
  @{ Pattern = 'SPEND-TARGET';     Hint = 'KNOWLEDGE.md §3.7 — check if target unreachable by route pool' }
  @{ Pattern = 'BALANCE-ARITH';    Hint = 'generator opening_balance / collapse bug' }
  @{ Pattern = 'ALIGN-PIXEL';      Hint = 'GLYPH_W or BAL_RIGHT/AMT_RIGHT drift' }
  @{ Pattern = 'rate.?limit';      Hint = 'GitHub API rate limit — token usage' }
)

if (Test-Path $logPath) {
  $logContent = Get-Content $logPath -Raw
  Write-Host "`n── Known signature scan ────────────────────────────────" -ForegroundColor Cyan
  foreach ($sig in $verifySigs) {
    if ($logContent -match $sig.Pattern) {
      Write-Host "  ⚠ $($sig.Pattern) detected → $($sig.Hint)" -ForegroundColor Yellow
    }
  }
}

Write-Host "`n✅ Run logs saved." -ForegroundColor Green
Write-Host "   Full:   $logPath"
if (Test-Path $failPath) { Write-Host "   Failed: $failPath" }
Write-Host "   Meta:   $jsonPath"
