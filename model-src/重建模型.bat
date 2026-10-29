@echo off
setlocal
cd /d "%~dp0.."
call "_find_python.bat"
if errorlevel 1 (
  echo 没找到 Python，无法重建模型
  pause & exit /b 1
)
"%PY%" "%~dp0rebuild_bin.py"
pause
