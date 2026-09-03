<#
.SYNOPSIS
    Builds (and optionally pushes) the webp-converter Docker image with the latest tag.
    Windows counterpart of build.sh.

.EXAMPLE
    .\build.ps1
    Builds duckautomata/webp-converter:latest, lists the images, then asks whether to push.

.EXAMPLE
    .\build.ps1 -Push
    Builds and pushes without asking.

.EXAMPLE
    .\build.ps1 -Tag 1.4.0
    Builds duckautomata/webp-converter:1.4.0 instead of :latest.

.PARAMETER Push
    Push after a successful build without prompting.

.PARAMETER Tag
    Image tag to build (default: latest).

.PARAMETER DryRun
    Print the docker commands instead of running them.
#>
[CmdletBinding()]
param(
    [switch]$Push,
    [string]$Tag = 'latest',
    [switch]$DryRun
)

# --- Configuration ---
$ImageName = 'duckautomata/webp-converter'
$FullTag = "${ImageName}:${Tag}"
# ---------------------

Write-Host '-----------------------------------'

# --- Docker check ---
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error 'Docker is not installed or not on PATH. Install Docker Desktop and reopen the terminal.'
    exit 1
}
if (-not $DryRun) {
    docker info *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Error 'Docker is not running or you lack permission to use it. Start Docker Desktop and try again.'
        exit 1
    }
}

# Build from the directory this script lives in, whatever the current location is.
Push-Location $PSScriptRoot
try {
    Write-Host "Building Docker image ${FullTag}... (libvips is compiled from source; this takes a while the first time)"
    if ($DryRun) {
        Write-Host "  docker build -t ${FullTag} ."
    } else {
        docker build -t $FullTag .
        if ($LASTEXITCODE -ne 0) {
            Write-Error 'Docker build failed. Aborting.'
            exit 1
        }
    }

    Write-Host ''
    Write-Host 'Build successful. Created images:'
    if ($DryRun) {
        Write-Host "  docker images --filter=reference=${ImageName}"
    } else {
        docker images --filter="reference=${ImageName}"
    }

    # --- Optional push to the registry ---
    $doPush = $Push
    if (-not $doPush) {
        $reply = Read-Host "Push ${FullTag} to the registry? (y/n)"
        $doPush = $reply -match '^[Yy]'
    }
    if ($doPush) {
        Write-Host "Pushing ${FullTag}..."
        if ($DryRun) {
            Write-Host "  docker push ${FullTag}"
        } else {
            docker push $FullTag
            if ($LASTEXITCODE -ne 0) {
                Write-Error 'Docker push failed.'
                exit 1
            }
            Write-Host 'Push complete.'
        }
    }
} finally {
    Pop-Location
}
