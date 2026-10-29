@echo off
chcp 65001 >nul
setlocal
rem 用 PATH 里的 blender；如果你装在别处，把这行改成完整路径，例如：
rem set BLENDER=C:\Program Files\Blender Foundation\Blender\blender.exe
set BLENDER=blender
where %BLENDER% >nul 2>&1
if errorlevel 1 (
  echo 没在 PATH 里找到 blender。
  echo 请把 Blender 加入 PATH，或用记事本编辑本文件，把 BLENDER 改成 blender.exe 的完整路径。
  pause & exit /b 1
)
echo 正在启动 Blender 并载入 OSR2 模型...
start "" %BLENDER% --python "%~dp0assemble.py"