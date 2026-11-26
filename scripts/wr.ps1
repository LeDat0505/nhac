# Chạy wrangler bằng Node portable của dự án (không đụng Node chung của máy).
# Ví dụ:  powershell -File .\scripts\wr.ps1 deploy
#         powershell -File .\scripts\wr.ps1 secret put B2_APP_KEY
$env:PATH = "D:\music-app\.tools\node;" + $env:PATH
Set-Location (Split-Path $PSScriptRoot -Parent)
& "D:\music-app\.tools\node\node.exe" ".\node_modules\wrangler\bin\wrangler.js" @args
