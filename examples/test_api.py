# -*- coding: utf-8 -*-
"""联调测试：连接 → 小位移 → 加载 funscript → 播放 → 停止"""
import json
import math
import time
import urllib.request

BASE = "http://127.0.0.1:8899"
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def post(path, payload):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    return json.loads(op.open(req, timeout=15).read().decode())


def get(path):
    return json.loads(op.open(BASE + path, timeout=15).read().decode())


print("connect :", post("/api/connect", {"prefer": "bridge", "port": "COM3"}))
print("state   :", get("/api/state")["backend"], get("/api/state")["connected"])

print("move    :", post("/api/move", {"axis": "L0", "pos": 0.52, "speed": 1200}))
time.sleep(1.5)

# 生成 6 秒的测试 funscript：0.45~0.55 正弦
actions = []
for i in range(0, 601):
    t = i * 10.0
    pos = 50 + 5 * math.sin(2 * math.pi * (t / 1000.0) / 2.0)
    actions.append({"at": t, "pos": round(pos, 3)})
script = {"actions": actions}
print("add     :", post("/api/funscript/add", {"name": "test_sine.funscript", "axis": "L0",
                                              "text": json.dumps(script)}))
print("play    :", post("/api/funscript/play", {"speed": 1.0, "loop": False}))
time.sleep(3)
st = get("/api/state")
print("during  :", st["mode"], st["funscript"]["time"])
time.sleep(4)
st = get("/api/state")
print("after   :", st["mode"], st["funscript"]["time"], "pos", st["position"]["L0"])
print("stop    :", post("/api/stop", {}))
