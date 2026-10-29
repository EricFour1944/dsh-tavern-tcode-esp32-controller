@echo off
chcp 936 >nul
cd /d "%~dp0"

call "_find_python.bat"
if not defined PY goto nopython

rem 已经在跑就直接开页面，不重复启动
powershell -NoProfile -Command "try{ $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8899/api/state' -TimeoutSec 2; if($r.StatusCode -eq 200){ exit 0 } else { exit 1 } }catch{ exit 1 }"
if %errorlevel%==0 (
    echo 控制器已经在运行中，直接打开页面...
    start "" "http://127.0.0.1:8899"
    exit /b 0
)

echo 正在后台启动控制器（无窗口，日志写入 server.log）...
rem pythonw 没有控制台、print 会被丢弃，所以用 _bg_run.py 把输出接进 server.log
start "" /min "%PYW%" _bg_run.py --no-browser

rem 等它把端口起来再开页面
timeout /t 3 /nobreak >nul
powershell -NoProfile -Command "try{ $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8899/api/state' -TimeoutSec 3; exit 0 }catch{ exit 1 }"
if not %errorlevel%==0 goto failed

echo 已启动，正在打开页面...
start "" "http://127.0.0.1:8899"
exit /b 0

:failed
echo.
echo   [x] 控制器没能启动起来。server.log 最后几行：
echo ------------------------------------------------------------
powershell -NoProfile -Command "if(Test-Path '%~dp0server.log'){ Get-Content -Path '%~dp0server.log' -Tail 20 -Encoding UTF8 } else { '（没有 server.log）' }"
echo ------------------------------------------------------------
echo   把上面内容发我即可定位；也可以改用「启动控制器.bat」看实时报错。
echo.
pause
exit /b 1

:nopython
echo.
echo   [x] 没有找到可用的 Python，控制器无法启动。
echo   请安装 Python 3.10+（勾选 Add to PATH），或把 Python 文件夹放到本目录改名 Python310。
echo.
pause
exit /b 1