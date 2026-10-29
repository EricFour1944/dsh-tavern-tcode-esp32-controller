# -*- coding: utf-8 -*-
"""后台常驻启动包装器。

pythonw.exe 没有控制台，sys.stdout / sys.stderr 为 None，server.py 的所有
print 都会被直接丢弃，server.log 里永远看不到东西 —— 一旦起不来就没证据可查。
所以由这个包装器先把 stdout/stderr 接到 server.log，再照常执行 server.py。
"""
import os
import runpy
import sys
import time

BASE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(BASE, "server.py")
LOG = os.path.join(BASE, "server.log")

try:
    stream = open(LOG, "a", encoding="utf-8", buffering=1)
    sys.stdout = stream
    sys.stderr = stream
except Exception:
    stream = None

print("\n[bg] %s 启动：%s" % (time.strftime("%Y-%m-%d %H:%M:%S"), sys.executable), flush=True)
try:
    sys.argv = [SERVER] + sys.argv[1:]
    runpy.run_path(SERVER, run_name="__main__")
except SystemExit:
    raise
except BaseException:
    import traceback
    traceback.print_exc()
    print("[bg] 启动失败，见上面的报错", flush=True)
    raise
finally:
    if stream is not None:
        try:
            stream.flush()
            stream.close()
        except Exception:
            pass
