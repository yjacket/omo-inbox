# Install or update omo-inbox (Windows PowerShell).
#   From a checkout:  .\install.ps1 [--no-tailscale] [--no-autostart]
#   One line, no checkout (needs Node 24+):
#   irm https://raw.githubusercontent.com/yjacket/omo-inbox/main/install.ps1 | iex
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
	# The repository is public. A token is optional and only raises the GitHub API rate limit.
	$token = $env:GITHUB_TOKEN
	if (-not $token -and (Get-Command gh -ErrorAction SilentlyContinue)) { $token = (& gh auth token 2>$null) }
	$headers = @{}
	if ($token) { $headers["Authorization"] = "token $token" }
	$work = Join-Path $env:TEMP ("omo-inbox-install-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
	New-Item -ItemType Directory -Path $work | Out-Null
	try {
		$archive = Join-Path $work "main.tar.gz"
		Invoke-WebRequest -UseBasicParsing -Uri "https://api.github.com/repos/yjacket/omo-inbox/tarball/main" -Headers $headers -OutFile $archive -ErrorAction Stop
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
