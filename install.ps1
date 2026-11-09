# install.ps1 — install the portable multi-agent pipeline (Windows).
# Works on Windows PowerShell 5.1 and PowerShell 7+. Mirrors install.sh.
#
#   Per-project install (default — bundles the core into <target>\.claude, committable):
#     .\install.ps1 [target_dir]
#     irm <raw-url>/install.ps1 | iex
#
#   Global install (one core in ~\.claude, shared by every repo on this machine):
#     .\install.ps1 -Global
#     & ([scriptblock]::Create((irm <raw-url>/install.ps1))) -Global
#
#   Update the generic core in place (keeps any generated PIPELINE.md + rendered agents):
#     .\install.ps1 -Update [target_dir]
#     .\install.ps1 -Update -Global
#
# Per-project install copies the core into <target>\.claude; global install copies it once
# into ~\.claude and registers the gate hook there. Either way you then run `/cohorte-init-pipeline`
# in each repo to generate PIPELINE.md + render the surface agents. Update refreshes ONLY the
# stack-agnostic files; generated profiles, rendered agents, gate-config.json and any project
# settings.json are left untouched.

[CmdletBinding()]
param(
    [switch]$Global,
    [switch]$Update,
    [Parameter(Position = 0)][string]$Target
)

$ErrorActionPreference = 'Stop'

$repoUrl = $env:PIPELINE_REPO
if (-not $repoUrl) { $repoUrl = 'https://github.com/TheBidouilleAgency/cohorte' }

if (-not $Target) { $Target = (Get-Location).Path }

# --- locate the source (this checkout, or clone if piped via irm|iex) --------
$tmp = $null
try {
    $src = $null
    if ($PSScriptRoot -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'core'))) {
        $src = $PSScriptRoot
    } else {
        Write-Host "-> fetching pipeline from $repoUrl"
        if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
            throw 'git is required to fetch the pipeline (or run install.ps1 from a checkout).'
        }
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("cohorte-" + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tmp | Out-Null
        # PS 5.1 turns redirected native stderr into terminating errors under EAP=Stop;
        # relax it around the clone and rely on the exit code instead.
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        git clone --depth 1 --quiet $repoUrl (Join-Path $tmp 'pipeline') 2>&1 | Out-Null
        $ErrorActionPreference = $prevEAP
        if ($LASTEXITCODE -ne 0) { throw "git clone of $repoUrl failed" }
        $src = Join-Path $tmp 'pipeline'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $src 'core'))) {
        throw "pipeline source not found (no core/ in $src)"
    }

    # --- delegate to the Node CLI --------------------------------------------
    # Since 2.2.0 the commands in core/ are runtime-NEUTRAL sources: they carry capability
    # conditionals (`<!-- cohorte:if subagents -->`) and path tokens (`<core>`, `<state>`)
    # that the adapter resolves per coding agent. Copying them verbatim, as this script used
    # to, would install prompts full of unresolved markers — an install that looks successful
    # and instructs the model with text meant for a different runtime. There is no PowerShell
    # renderer, so hand the whole job to bin/cli.js, the documented route anyway.
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
        # An old Node fails DEEP into cli.js (fs.cpSync needs >= 16.7) after some files
        # are already on disk — a half-install that reports as a crash. Refuse up front.
        $nodeMajor = 0
        try { $nodeMajor = [int](& $node.Source -p 'process.versions.node.split(".")[0]') } catch { }
        if ($nodeMajor -lt 18) {
            Write-Error "cohorte needs Node >= 18 — found $(& $node.Source --version). Upgrade Node, then re-run."
            if ($PSCommandPath) { exit 1 }
            return
        }
        $cliArgs = @((Join-Path $src 'bin\cli.js'), $(if ($Update) { 'update' } else { 'install' }))
        if ($Global) { $cliArgs += '--global' } else { $cliArgs += $Target }
        & $node.Source @cliArgs
        # `exit` under `irm … | iex` terminates the user's interactive PowerShell
        # session (there is no script file to exit from) — closing the console that
        # just ran the documented one-liner. Exit only when running as a file.
        if ($PSCommandPath) { exit $LASTEXITCODE }
        return
    }
    Write-Error @"
cohorte needs Node >= 18 to install.
  The pipeline's commands are rendered per coding agent (Claude Code, Codex, Cursor,
  Gemini CLI, OpenCode) at install time; there is no PowerShell equivalent of that
  step, and a raw copy would install prompts this runtime cannot follow.
  Install Node, then:  npm i -g cohorte; cohorte install$(if ($Global) { ' --global' })
"@
    if ($PSCommandPath) { exit 1 }
    return

} finally {
    if ($tmp -and (Test-Path -LiteralPath $tmp)) {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
