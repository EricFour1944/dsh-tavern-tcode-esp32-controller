@echo off
chcp 936 >nul
cd /d "%~dp0"
powershell -NoProfile -Command "try{ $s=Invoke-RestMethod -Uri 'http://127.0.0.1:8899/api/state' -TimeoutSec 3; '运行中：' + $s.backend + ' / ' + $s.mode; }catch{ '没有运行中' }"
timeout /t 3 /nobreak >nul
exit /b 0
