# install.ps1 — install cohorte (the multi-agent dev pipeline for Claude Code) on this machine (Windows).
# Works on Windows PowerShell 5.1 and PowerShell 7+. A thin wrapper around bin\cli.js: Node >= 20 is required.
#
#   irm https://raw.githubusercontent.com/TheBidouilleAgency/cohorte/main/install.ps1 | iex
#   .\install.ps1            # from a checkout: installs that working tree
#   .\install.ps1 -Update    # same thing — install is idempotent
#
# The documented route is `npm i -g cohorte; cohorte install`. Piped, this script installs the
# LATEST RELEASE tag (never the tip of main). Then, in each project, run /cohorte-init-pipeline once.

[CmdletBinding()]
param(
    [switch]$Update,
    [switch]$Global  # 2.x flag — 3.x has a single mode
)

$ErrorActionPreference = 'Stop'
$repoUrl = $env:PIPELINE_REPO
if (-not $repoUrl) { $repoUrl = 'https://github.com/TheBidouilleAgency/cohorte' }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error 'cohorte needs Node >= 20 (https://nodejs.org), then: npm i -g cohorte; cohorte install'
    if ($PSCommandPath) { exit 1 }
    return
}
# Parse `node --version` rather than `node -p "...split('.')..."`: Windows PowerShell 5.1 strips
# the inner quotes of a native argument, which made the old probe report every Node as v0.
$nodeMajor = 0
try { $nodeMajor = [int](((& $node.Source --version) -replace '^v', '') -split '\.')[0] } catch { }
if ($nodeMajor -lt 20) {
    Write-Error "cohorte needs Node >= 20 — found $(& $node.Source --version)."
    if ($PSCommandPath) { exit 1 }
    return
}

$tmp = $null
try {
    if ($PSScriptRoot -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'bin\cli.js'))) {
        $src = $PSScriptRoot
    } else {
        if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
            throw 'git is required (or use: npm i -g cohorte; cohorte install).'
        }
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $tags = git ls-remote --tags --refs $repoUrl 'v*' 2>$null
        $ErrorActionPreference = $prevEAP
        $tag = $tags | ForEach-Object { ($_ -split 'refs/tags/')[1] } |
            Where-Object { $_ -match '^v\d+\.\d+\.\d+$' } |
            Sort-Object { [version]($_.TrimStart('v')) } | Select-Object -Last 1
        if (-not $tag) { throw "could not list the releases of $repoUrl" }
        Write-Host "-> fetching cohorte $tag from $repoUrl"
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("cohorte-" + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tmp | Out-Null
        $ErrorActionPreference = 'Continue'
        git clone --quiet --depth 1 --branch $tag $repoUrl (Join-Path $tmp 'cohorte') 2>&1 | Out-Null
        $ErrorActionPreference = $prevEAP
        if ($LASTEXITCODE -ne 0) { throw "git clone of $repoUrl ($tag) failed" }
        $src = Join-Path $tmp 'cohorte'
    }
    & $node.Source (Join-Path $src 'bin\cli.js') $(if ($Update) { 'update' } else { 'install' })
    # `exit` under `irm … | iex` would close the user's interactive session. Exit only as a file.
    if ($PSCommandPath) { exit $LASTEXITCODE }
} finally {
    if ($tmp -and (Test-Path -LiteralPath $tmp)) {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
