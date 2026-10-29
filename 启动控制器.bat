@echo off
chcp 936 >nul
title OSR2 / SR6 中文控制器
cd /d "%~dp0"

call "_find_python.bat"
if not defined PY goto nopython

echo ============================================================
echo   OSR2 / SR6 中文控制器
echo   Python : %PY%
echo ============================================================
echo.
echo   是否启用「浏览器内网页工具」？
echo   开启后 ayva 网页可直接内嵌进来（更省内存，但首次打开稍慢）
echo.
choice /C YN /N /M "   启用 [Y] / 不启用 [N] : "
if errorlevel 2 goto noweb
if errorlevel 1 goto web

:web
set WEB=--web-tool
goto run

:noweb
set WEB=--no-web-tool

:run
echo.
echo   电脑访问：http://127.0.0.1:8899
echo   手机访问：同一 WiFi 打开 http://电脑IP:8899
echo   关闭本窗口 = 停止并断开
echo.
"%PY%" server.py %WEB%
echo.
pause
exit /b 0

:nopython
echo.
echo   [x] 没有找到可用的 Python，控制器无法启动。
echo.
echo   处理办法（任选一种）：
echo     1. 安装 Python 3.10 或更高版本，安装时勾选 Add Python to PATH
echo     2. 或把 Python 文件夹放到本目录下并改名为 Python310
echo     3. 或在本窗口手动运行：python server.py
echo.
echo   当前查过的位置见 _find_python.bat 里的顺序。
echo.
pause
exit /b 1