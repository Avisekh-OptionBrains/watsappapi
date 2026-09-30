#Requires -Version 5.1
param(
  [switch]$ApplyServerUrl,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'docker-compose.yml'))) {
  $root = $PSScriptRoot
}
Set-Location $root

if (-not $NoStart) {
  Write-Host 'Starting gateway, Typebot, and cloudflared...'
  docker compose up -d gateway typebot-viewer cloudflared | Out-Host
}

Write-Host 'Waiting for trycloudflare.com URL in cloudflared logs...'
$url = $null
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 2
  $logText = (docker compose logs cloudflared --no-color --tail 120 2>$null | Out-String)
  $m = [regex]::Match($logText, 'https://[a-z0-9-]+\.trycloudflare\.com')
  if ($m.Success) {
    $url = $m.Value.TrimEnd('/')
    break
  }
}

if (-not $url) {
  Write-Host 'Could not find tunnel URL yet. Check: docker compose logs -f cloudflared'
  exit 1
}

$verify = 'evolution'
$envPath = Join-Path $root '.env'
if (Test-Path $envPath) {
  $m = Select-String -Path $envPath -Pattern '^WA_BUSINESS_TOKEN_WEBHOOK=(.+)$'
  if ($m) { $verify = $m.Matches[0].Groups[1].Value.Trim() }
}

Write-Host ''
Write-Host 'Cloudflare tunnel is live'
Write-Host ("  Public base:     {0}" -f $url)
Write-Host ("  Meta webhook:    {0}/webhook/meta" -f $url)
Write-Host ("  Verify token:    {0}" -f $verify)
Write-Host ''
Write-Host 'In Meta Developer Console > WhatsApp > Configuration > Webhook:'
Write-Host ("  Callback URL  = {0}/webhook/meta" -f $url)
Write-Host ("  Verify token  = {0}" -f $verify)
Write-Host '  Subscribe to: messages, message_template_status_update (as needed)'
Write-Host ''

if ($ApplyServerUrl) {
  if (-not (Test-Path $envPath)) { throw '.env not found' }
  $content = Get-Content $envPath -Raw
  if ($content -match '(?m)^PUBLIC_BASE_URL=') {
    $content = [regex]::Replace($content, '(?m)^PUBLIC_BASE_URL=.*$', ("PUBLIC_BASE_URL={0}" -f $url))
  } else {
    $content = ("PUBLIC_BASE_URL={0}`n" -f $url) + $content
  }
  Set-Content -Path $envPath -Value $content -NoNewline
  Write-Host ("Updated PUBLIC_BASE_URL in .env -> {0}" -f $url)
  Write-Host 'Update the Meta callback URL if this quick-tunnel hostname changed.'
} else {
  Write-Host 'To persist this URL as PUBLIC_BASE_URL:'
  Write-Host '  .\scripts\cloudflare-tunnel.ps1 -ApplyServerUrl'
}

$outFile = Join-Path $root '.tunnel-url'
Set-Content -Path $outFile -Value $url -NoNewline
Write-Host ("Saved: {0}" -f $outFile)
