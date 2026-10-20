# Install or update omo-inbox (Windows PowerShell).
#   From a checkout:  .\install.ps1 [--no-tailscale] [--no-autostart]
#   One line, no checkout (private repo: needs `gh auth login` and Node 24+):
#   irm https://raw.githubusercontent.com/yjacket/omo-inbox/main/install.ps1 -Headers @{ Authorization = "token $(gh auth token)" } | iex
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "bin\inbox.mjs"))) {
	node (Join-Path $PSScriptRoot "bin\inbox.mjs") install @args
	return
}

# Piped through iex: fetch main into a temp dir, install from it, remove it. Never `exit`: that would close the caller's shell.
& {
	$ProgressPreference = "SilentlyContinue"
	$major = 0
	if (Get-Command node -ErrorAction SilentlyContinue) { $major = [int]((((& node -v) -replace "^v", "") -split "\.")[0]) }
	if ($major -lt 24) {
		Write-Host "omo-inbox needs Node 24 or newer on PATH."
		return
	}
	$token = $null
	if (Get-Command gh -ErrorAction SilentlyContinue) { $token = (& gh auth token 2>$null) }
	if (-not $token) { $token = $env:GITHUB_TOKEN }
	if (-not $token) {
		Write-Host "omo-inbox is a private repository: run 'gh auth login' first."
		return
	}
	$work = Join-Path $env:TEMP ("omo-inbox-install-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
	New-Item -ItemType Directory -Path $work | Out-Null
	try {
		$archive = Join-Path $work "main.tar.gz"
		Invoke-WebRequest -UseBasicParsing -Uri "https://api.github.com/repos/yjacket/omo-inbox/tarball/main" -Headers @{ Authorization = "token $token" } -OutFile $archive -ErrorAction Stop
		& tar -xzf $archive -C $work
		$src = Get-ChildItem -Path $work -Directory | Select-Object -First 1
		& node (Join-Path $src.FullName "bin\inbox.mjs") install
		if ($LASTEXITCODE -ne 0) { Write-Host "omo-inbox install failed (exit $LASTEXITCODE)." }
	} catch {
		Write-Host "omo-inbox download failed: $($_.Exception.Message)"
	} finally {
		Remove-Item -Recurse -Force -Path $work -ErrorAction SilentlyContinue
	}
}
