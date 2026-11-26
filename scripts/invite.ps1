# Tạo / thu hồi mã mời vào thư viện chung.
#   Tạo mã:      powershell -File .\scripts\invite.ps1 -Name "Minh"
#   Mã chủ:      powershell -File .\scripts\invite.ps1 -Name "Đạt" -Owner
#   Thu hồi:     powershell -File .\scripts\invite.ps1 -Remove "Minh"
#   Xem danh sách: powershell -File .\scripts\invite.ps1 -List
#
# Mã gốc chỉ hiện MỘT LẦN ở đây. Cloudflare chỉ giữ bản băm SHA-256 (không ai đọc ngược ra mã được).
# Danh sách bản băm lưu ở D:\music-app\access-keys.json (ngoài repo, không đưa lên GitHub).
param([string]$Name, [switch]$Owner, [string]$Remove, [switch]$List)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8     # gõ được tên có dấu
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$store = 'D:\music-app\access-keys.json'
$keys = @{}
if (Test-Path $store) {
  (Get-Content $store -Raw -Encoding UTF8 | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $keys[$_.Name] = $_.Value }
}

if ($List) {
  if (-not $keys.Count) { 'Chưa có mã mời nào.' } else { $keys.Values | ForEach-Object { '- {0}{1}' -f $_.name, $(if ($_.owner) { ' (chủ thư viện)' }) } }
  exit 0
}
if (-not $Name -and -not $Remove) {
  $Name = (Read-Host 'Tên hiển thị của người được mời (vd. Đạt, Minh)').Trim()
  if (-not $Name) { 'Chưa nhập tên.'; exit 1 }
}
if ($Remove) {
  $hit = @($keys.Keys | Where-Object { $keys[$_].name -eq $Remove })
  if (-not $hit.Count) { "Không có ai tên '$Remove'."; exit 1 }
  $hit | ForEach-Object { $keys.Remove($_) }
  "Đã thu hồi mã của $Remove."
} elseif ($Name) {
  if (@($keys.Values | Where-Object { $_.name -eq $Name }).Count) { "Đã có người tên '$Name'. Hãy -Remove trước hoặc dùng tên khác."; exit 1 }
  $bytes = New-Object byte[] 18
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $code = 'nhac-' + ([Convert]::ToBase64String($bytes) -replace '\+', 'x' -replace '/', 'y' -replace '=', '')
  $sha = [Security.Cryptography.SHA256]::Create()
  $hash = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($code)) | ForEach-Object { $_.ToString('x2') })
  $keys[$hash] = [ordered]@{ name = $Name; owner = [bool]$Owner }
} else { Get-Content $PSCommandPath -TotalCount 8; exit 0 }

# Lưu danh sách và cập nhật lên Cloudflare
$json = ($keys | ConvertTo-Json -Compress -Depth 3)
if (-not $keys.Count) { $json = '{}' }
[IO.File]::WriteAllText($store, $json, (New-Object Text.UTF8Encoding $false))
$env:PATH = "D:\music-app\.tools\node;" + $env:PATH
Set-Location (Split-Path $PSScriptRoot -Parent)
$tmp = [IO.Path]::GetTempFileName()
[IO.File]::WriteAllText($tmp, $json, (New-Object Text.UTF8Encoding $false))
cmd /c "`"D:\music-app\.tools\node\node.exe`" node_modules\wrangler\bin\wrangler.js secret put ACCESS_KEYS < `"$tmp`"" | Select-String 'Success|ERROR'
Remove-Item $tmp

if ($code) {
  ''
  '================ MÃ MỜI ================'
  "  Người dùng : $Name$(if ($Owner) { ' (chủ thư viện)' })"
  "  Mã        : $code"
  '  Mở app    : https://nhac.lethiendat0505.workers.dev'
  '========================================'
  'Mã chỉ hiện một lần này. Gửi riêng cho người đó (Zalo/Messenger), đừng đăng công khai.'
}
