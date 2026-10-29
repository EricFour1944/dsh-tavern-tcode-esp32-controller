# 以「独立进程」方式启动 OSR 控制器：父进程是 WmiPrvSE，不属于 DSH 的进程树。
# 这样 DSH 重启 / 关闭窗口 / 重启 Agent 都不会把它带走；控制器照常跑，设备照常能动。
#
# 用法（PowerShell）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\_start_detached.ps1
# 想停止：powershell -NoProfile -Command "Get-Process pythonw | Where-Object { $_.Path -like '*miniconda3*' } | Stop-Process -Force"
param([string]$Python = "")

$ErrorActionPreference = "Stop"
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $base "_bg_run.py"
if (-not (Test-Path $runner)) { Write-Host "[x] 找不到 _bg_run.py：$runner"; exit 1 }

# 已经在跑就不重复起
try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8899/api/state" -TimeoutSec 2
    if ($r.StatusCode -eq 200) { Write-Host "[i] 控制器已在运行（http://127.0.0.1:8899）"; exit 0 }
} catch { }

# 找 pythonw：优先参数，其次 _find_python.bat 的结果，最后常见路径
$pyw = $null
if ($Python -and (Test-Path $Python)) { $pyw = $Python }
if (-not $pyw) {
    foreach ($c in @("C:\Users\$env:USERNAME\miniconda3\pythonw.exe",
                     "C:\Python310\pythonw.exe", "C:\Python311\pythonw.exe",
                     "C:\Python312\pythonw.exe")) {
        if (Test-Path $c) { $pyw = $c; break }
    }
}
if (-not $pyw) {
    $cmd = Get-Command pythonw.exe -ErrorAction SilentlyContinue
    if ($cmd) { $pyw = $cmd.Source }
}
if (-not $pyw) { Write-Host "[x] 找不到 pythonw.exe，请用 -Python 指定完整路径"; exit 1 }

$cmdline = '"' + $pyw + '" "' + $runner + '"'
$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
        -Arguments @{ CommandLine = $cmdline; CurrentDirectory = $base }
if ($res.ReturnValue -ne 0) { Write-Host "[x] 启动失败，ReturnValue=$($res.ReturnValue)"; exit 1 }

for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 600
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8899/api/state" -TimeoutSec 2
        if ($r.StatusCode -eq 200) {
            Write-Host "[ok] 控制器已启动（独立进程，PID=$($res.ProcessId)）"
            Write-Host "     http://127.0.0.1:8899"
            exit 0
        }
    } catch { }
}
Write-Host "[x] 进程起来了但端口没响应，看看 server.log"
exit 1
