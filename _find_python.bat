@echo off
rem ============================================================
rem  查找可用的 Python，并设置 PY / PYW，供其他启动脚本 call 使用
rem  顺序：本目录 Python310 → 本目录 python → PATH 里的 python
rem        → py 启动器 → 常见安装位置
rem  找不到时 PY 为空，由调用方给出提示
rem ============================================================
setlocal
set "PY="
set "PYW="

call :try "%~dp0Python310\python.exe"
if not defined PY call :try "%~dp0python\python.exe"

if not defined PY (
  for /f "delims=" %%I in ('where python 2^>nul') do (
    if not defined PY call :try "%%~I"
  )
)

if not defined PY (
  for /f "delims=" %%I in ('py -3 -c "import sys;print(sys.executable)" 2^>nul') do (
    if not defined PY call :try "%%~I"
  )
)

if not defined PY (
  for %%D in (
    "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
    "C:\Python313\python.exe"
    "C:\Python312\python.exe"
    "C:\Python311\python.exe"
    "C:\Python310\python.exe"
    "%USERPROFILE%\miniconda3\python.exe"
    "C:\ProgramData\miniconda3\python.exe"
    "%USERPROFILE%\anaconda3\python.exe"
  ) do (
    if not defined PY call :try %%D
  )
)

endlocal & set "PY=%PY%" & set "PYW=%PYW%"
exit /b 0

:try
rem 参数 %~1 = 候选路径。必须是真实文件、不是应用商店存根，并且真的能运行
if not exist "%~1" goto :eof
echo %~1 | find /i "WindowsApps" >nul && goto :eof
"%~1" -c "import sys" >nul 2>&1
if errorlevel 1 goto :eof
set "PY=%~1"
set "PYW=%~dp1pythonw.exe"
if not exist "%PYW%" set "PYW=%PY%"
goto :eof