@echo off
chcp 936 >nul
cd /d "%~dp0"
powershell -NoProfile -Command "try{ Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8899/api/shutdown' -ContentType 'application/json' -Body '{}' -TimeoutSec 4 | Out-Null; '已停止控制器（设备已 DSTOP）' }catch{ '控制器没有在运行' }"
timeout /t 2 /nobreak >nul
exit /b 0
