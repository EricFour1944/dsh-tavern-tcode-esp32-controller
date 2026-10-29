# -*- coding: utf-8 -*-
"""v2 联调：分组切换 / 新建组 / 整套连播 / 清理"""
import json
import time
import urllib.request

BASE = "http://127.0.0.1:8899"
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def post(path, payload):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    return json.loads(op.open(req, timeout=20).read().decode())


def get(path):
    return json.loads(op.open(BASE + path, timeout=20).read().decode())


print("connect :", post("/api/connect", {"prefer": "bridge", "port": "COM3"})["detail"])

r = get("/api/presets")
print("groups  :", r["groups"], "active =", r["active"])

print("create  :", post("/api/groups", {"action": "create", "name": "测试组"})["active"])
print("switch  :", post("/api/groups", {"action": "switch", "name": "测试组"})["active"])

quick = [
    {"name": "测1", "shape": "sine", "axis": "L0", "low": 0.47, "high": 0.53, "hz": 1.0, "secs": 2, "speed": 1500},
    {"name": "测2", "shape": "triangle", "axis": "L0", "low": 0.45, "high": 0.55, "hz": 1.5, "secs": 2, "speed": 1800},
]
print("save    :", post("/api/presets", {"group": "测试组", "presets": quick}))
print("seq     :", post("/api/sequence/run", {"group": "测试组"}))
time.sleep(1.2)
st = get("/api/state")
print("during  :", st["mode"], st["sequence"])
time.sleep(4.5)
st = get("/api/state")
print("after   :", st["mode"], "pos", st["position"]["L0"])

print("delete  :", post("/api/groups", {"action": "delete", "name": "测试组"})["active"])
print("final   :", get("/api/presets")["groups"], get("/api/presets")["active"])
