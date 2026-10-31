# PlanBridge installer (Windows):  irm https://raw.githubusercontent.com/CalaKuad1/planbridge/main/scripts/install.ps1 | iex
$ErrorActionPreference = 'Stop'
Write-Host "`n  PlanBridge installer`n"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '  Node.js is required (21.7+): https://nodejs.org  (or: winget install OpenJS.NodeJS.LTS)'; exit 1
}
$ok = node -e 'const [a,b]=process.versions.node.split(".").map(Number);console.log(a>21||(a===21&&b>=7)?1:0)'
if ($ok -ne '1') { Write-Host "  Node $(node -v) is too old - need 21.7+"; exit 1 }

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host '  Claude Code is not installed. Installing it first...'
  irm https://claude.ai/install.ps1 | iex
}

$src = if ($env:PLANBRIDGE_SOURCE) { $env:PLANBRIDGE_SOURCE } else { 'planbridge' }
Write-Host '  Installing planbridge...'
npm install -g $src | Out-Null

planbridge skill install
planbridge doctor
Write-Host '  Next:  planbridge start      (or: planbridge autostart on)'
Write-Host "  Then:  planbridge open       to try the playground`n"
