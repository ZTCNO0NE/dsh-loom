[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$LoomArgs
)

$ErrorActionPreference = 'Stop'
$entry = Join-Path $PSScriptRoot 'dsh-loom.mjs'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js is required. Install Node.js, reopen PowerShell, then run this script again.'
}

# Windows Python normally registers `python`, not `python3`. Keep an explicit
# user setting intact for conda, pyenv, or a custom interpreter.
if (-not $env:PYTHON) { $env:PYTHON = 'python' }

& node $entry setup @LoomArgs
exit $LASTEXITCODE
