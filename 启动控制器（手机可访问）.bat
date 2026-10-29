@echo off
chcp 936 >nul
title OSR2 / SR6 中文控制器（手机可访问）
cd /d "%~dp0"

call "_find_python.bat"
if not defined PY goto nopython

echo 正在以局域网模式启动（绑定 0.0.0.0）...
echo   电脑访问：http://127.0.0.1:8899
echo   手机访问：看下面启动信息里的「手机访问」地址（同一 WiFi）
echo   第一次运行如弹防火墙，请点「允许访问」
echo.
"%PY%" server.py --host 0.0.0.0
echo.
pause
exit /b 0

:nopython
echo.
echo   [x] 没有找到可用的 Python，控制器无法启动。
echo   请安装 Python 3.10+（勾选 Add to PATH），或把 Python 文件夹放到本目录改名 Python310。
echo.
pause
exit /b 1