# -*- coding: utf-8 -*-
"""OSR2 / SR6 中文控制器 —— 本地 Web 控制台 v2

新增：
  * 预设分组（慢速/中速/快速/主题），一键切整套、整套连播
  * Funscript 与视频同步（浏览器里放视频，脚本跟着时间走）
  * 允许手机/平板访问（--host 0.0.0.0），界面显示局域网地址

启动：
  python server.py                 # 只允许本机
  python server.py --host 0.0.0.0  # 允许同 WiFi 的手机访问
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import argparse
import json
import math
import random
import socket
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from wsclient import WSClient

try:
    import serial
    import serial.tools.list_ports as list_ports
except Exception:
    serial = None
    list_ports = None

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
PRESET_FILE = os.path.join(BASE_DIR, "presets.json")
CALIB_FILE = os.path.join(BASE_DIR, "calibration.json")
MAX_PRESETS = 50
MAX_STROKES = 80          # 动作库总数上限（内置 + 自建），超了拒绝新建
AI_GROUPS_FILE = os.path.join(BASE_DIR, "ai_groups.json")
AI_STAGE_MAX = 30         # AI 暂存区上限（暂存满了丢最旧的）
BRIDGE_HOST, BRIDGE_PORT = "127.0.0.1", 7777
# 设备地址等可配置项：优先读 config.json（不进仓库），否则用示例值
_CFG = {}
try:
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json"),
              "r", encoding="utf-8") as _fh:
        _CFG = json.load(_fh)
except Exception:
    _CFG = {}

WIFI_HOST = str(_CFG.get("device_host") or "192.168.1.54")
# TCode 修饰符：S = 速度(单位/秒，推荐)  I = 时间间隔(ms)
# 本项目固件(TCode v0.4)里两者的含义见 firmware 的 TCodeModifierType
# ""  = 裸位置命令（与 ayva 网站一致，用设备默认速度，最跟手）
# "S" = 带速度（单位/秒）；"I" = 带时间间隔（ms）
TC_MODIFIER = ""
DEFAULT_PORT = 8899

DEFAULT_AXES = ("L0", "R1", "R2", "R0")

# ---- 动作库（TempestStroke，来源 ayva-stroker-lite）----
USER_STROKES_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "strokes_user.json")


STROKE_OVERRIDES = {}      # 内置动作的「覆盖层」：改内置动作不改原文件，只在这里留一份
STROKE_BASE = {}           # 内置动作的原样快照，用于「还原」


def apply_stroke_overrides():
    """把覆盖层盖到 STROKES 上（内置动作因此可以编辑，且能一键还原）"""
    for key, ov in list(STROKE_OVERRIDES.items()):
        if key not in STROKES:
            continue
        base = dict(STROKE_BASE.get(key) or STROKES[key])
        base["cn"] = (ov or {}).get("cn") or base.get("cn") or key
        if (ov or {}).get("axes"):
            base["axes"] = ov["axes"]
        base["override"] = True
        STROKES[key] = base


def load_user_strokes():
    """读 strokes_user.json。兼容两种格式：
       旧：{key: {cn, axes}}
       新：{"strokes": {…}, "overrides": {…}}
    """
    try:
        with open(USER_STROKES_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return
    if not isinstance(data, dict):
        return
    new_fmt = ("strokes" in data or "overrides" in data)
    user_part = (data.get("strokes") or {}) if new_fmt else data
    over_part = (data.get("overrides") or {}) if new_fmt else {}
    for k, v in user_part.items():
        if not isinstance(v, dict):
            continue
        STROKES[k] = {"cn": v.get("cn") or k, "axes": v.get("axes") or {},
                      "user": True}
    for k, v in over_part.items():
        if isinstance(v, dict):
            STROKE_OVERRIDES[k] = {"cn": v.get("cn"), "axes": v.get("axes") or {}}
    apply_stroke_overrides()


def save_user_strokes():
    data = {
        "strokes": {k: {"cn": v.get("cn"), "axes": v.get("axes")}
                    for k, v in STROKES.items() if v.get("user")},
        "overrides": {k: dict(v) for k, v in STROKE_OVERRIDES.items()},
    }
    try:
        with open(USER_STROKES_FILE, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
    except Exception as exc:
        print("[strokes] 保存失败: %s" % exc, flush=True)


STROKES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "strokes.json")
STROKES = {}


def _stroke_public(name, sdef):
    axes = sdef.get("axes") or {}
    moving = [(a, c) for a, c in axes.items()
              if abs(float(c["to"]) - float(c["from"])) > 1e-6]
    return {"name": name,
            "cn": sdef.get("cn") or name,
            "axes": [a for a, _ in moving],
            "user": bool(sdef.get("user")),
            "override": bool(sdef.get("override")),
            # 编辑用：全部轴参数（含不动的轴），前端弹窗直接回填
            "params": {a: [round(float(c["from"]), 4), round(float(c["to"]), 4),
                           round(float(c["phase"]), 4), round(float(c["ecc"]), 4)]
                       for a, c in axes.items()},
            "detail": [{"axis": a, "from": c["from"], "to": c["to"],
                        "phase": c["phase"], "ecc": c["ecc"]} for a, c in moving]}


KEYWORDS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "keywords.json")
KEYWORDS = {"bindings": []}


def load_keywords():
    global KEYWORDS
    try:
        with open(KEYWORDS_FILE, "r", encoding="utf-8") as fh:
            KEYWORDS = json.load(fh)
    except Exception:
        KEYWORDS = {"bindings": []}
    return KEYWORDS


def save_keywords():
    try:
        with open(KEYWORDS_FILE, "w", encoding="utf-8") as fh:
            json.dump(KEYWORDS, fh, ensure_ascii=False, indent=2)
    except Exception as exc:
        print("[keywords] 保存失败: %s" % exc, flush=True)


DEFAULTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "defaults.json")
DEFAULTS = {
    "change_bpm": "transition",     # transition | continuous
    "bpm_min": 20, "bpm_max": 60,
    "accel": 0.3, "trans": 0.25, "secs": 20,
    "twist_default": 50, "twist_range": 30, "twist_phase": 0.3, "twist_ecc": 0.0,
}


def load_defaults():
    global DEFAULTS
    try:
        with open(DEFAULTS_FILE, "r", encoding="utf-8") as fh:
            DEFAULTS.update(json.load(fh))
    except Exception:
        pass
    return DEFAULTS


def save_defaults(d):
    try:
        with open(DEFAULTS_FILE, "w", encoding="utf-8") as fh:
            json.dump(DEFAULTS, fh, ensure_ascii=False, indent=2)
    except Exception as exc:
        print("[defaults] 保存失败: %s" % exc, flush=True)


LIMITS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "limits.json")


def save_limits():
    try:
        with open(LIMITS_FILE, "w", encoding="utf-8") as fh:
            json.dump({"lo": ENGINE.lo, "hi": ENGINE.hi,
                       "speed_cap": ENGINE.speed_cap}, fh)
    except Exception as exc:
        print("[limits] 保存失败: %s" % exc, flush=True)


def apply_limits():
    try:
        with open(LIMITS_FILE, "r", encoding="utf-8") as fh:
            d = json.load(fh)
        ENGINE.lo = max(0.0, min(0.49, float(d.get("lo", ENGINE.lo))))
        ENGINE.hi = min(1.0, max(0.51, float(d.get("hi", ENGINE.hi))))
        ENGINE.speed_cap = int(max(100, min(9999, float(d.get("speed_cap", ENGINE.speed_cap)))))
        print("[limits] 已载入行程限制 %.0f%%~%.0f%%，速度上限 %d"
              % (ENGINE.lo * 100, ENGINE.hi * 100, ENGINE.speed_cap), flush=True)
    except Exception:
        pass


def _stroke_categories():
    """把 42 个动作按名字归类成预设分组"""
    def card(name, bpm, gain, secs):
        return {"kind": "stroke", "stroke": name, "bpm": bpm, "gain": gain, "secs": secs,
                "name": (STROKES.get(name) or {}).get("cn") or name}

    groups = {"长行程": [], "研磨": [], "挑逗": [], "短滚": []}
    for name in STROKES:
        if name.startswith("long-stroke") or name.startswith(("down-", "thrust-", "back-thrust",
                                                              "lean-forward", "diagonal-")):
            groups["长行程"].append(card(name, 40, 1.0, 20))
        elif name.startswith("short-"):
            groups["短滚"].append(card(name, 45, 0.7, 15))
        elif "grind" in name:
            groups["研磨"].append(card(name, 30, 0.8, 20))
        else:
            groups["挑逗"].append(card(name, 50, 0.7, 15))
    return {k: v for k, v in groups.items() if v}


def load_strokes():
    global STROKES
    try:
        with open(STROKES_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        STROKES = data.get("strokes") or {}
    except Exception as exc:
        print("[strokes] 读取失败：%s" % exc, flush=True)
        STROKES = {}
    # 留一份内置原样快照，「还原」时从这里取
    STROKE_BASE.clear()
    for k, v in STROKES.items():
        try:
            STROKE_BASE[k] = json.loads(json.dumps(v))
        except Exception:
            STROKE_BASE[k] = dict(v)
    return STROKES

# 设备型号预设：OSR2 有 3 个舵机，SR6 有 6 个
DEVICE_PROFILES = {
    "OSR2": {"label": "OSR2（3 舵机：行程 + 前后 + 左右）",
             "axes": ["L0", "R1", "R2"], "device": "OSR2"},
    "SR6": {"label": "SR6（6 舵机：行程 + 扭转 + 前后 + 左右 + 俯仰 + 横滚）",
            "axes": ["L0", "R0", "R1", "R2", "L1", "L2"], "device": "SR6"},
    "CUSTOM": {"label": "自定义（自己填轴代码）", "axes": ["L0"], "device": "自定义"},
}
SHAPES = ("sine", "triangle", "ramp", "square")


# ---------------------------------------------------------------- 默认预设组
def _p(name, shape, low, high, hz, secs, speed, axis="L0"):
    return {"name": name, "shape": shape, "axis": axis, "low": low, "high": high,
            "hz": hz, "secs": secs, "speed": speed}


DEFAULT_GROUPS = {
    "慢速": [
        _p("轻抚起手", "sine", 0.36, 0.64, 0.20, 25, 2500),
        _p("慢推慢收", "triangle", 0.30, 0.70, 0.18, 25, 2600),
        _p("深呼吸", "sine", 0.25, 0.75, 0.12, 30, 2400),
        _p("缓缓起伏", "sine", 0.32, 0.68, 0.22, 25, 2800),
        _p("半程慢摆", "sine", 0.40, 0.60, 0.25, 20, 2200),
        _p("长行程慢速", "triangle", 0.20, 0.80, 0.15, 30, 3000),
        _p("间断慢推", "square", 0.28, 0.72, 0.12, 30, 2600),
        _p("温柔环绕", "sine", 0.35, 0.65, 0.20, 25, 2500, axis="R2"),
        _p("渐入", "ramp", 0.22, 0.78, 0.10, 30, 2400),
        _p("慢速收尾", "sine", 0.40, 0.60, 0.15, 25, 2200),
    ],
    "中速": [
        _p("常规节奏", "sine", 0.30, 0.70, 0.50, 20, 4000),
        _p("中速往复", "sine", 0.28, 0.72, 0.60, 20, 4200),
        _p("稳定巡航", "triangle", 0.30, 0.70, 0.55, 20, 4000),
        _p("半程中速", "sine", 0.38, 0.62, 0.75, 15, 3800),
        _p("中速三角", "triangle", 0.25, 0.75, 0.50, 20, 4000),
        _p("中速停顿", "square", 0.30, 0.70, 0.45, 20, 4200),
        _p("中等深度", "sine", 0.25, 0.75, 0.40, 20, 3800),
        _p("中速摇摆", "sine", 0.30, 0.70, 0.45, 20, 3500, axis="R2"),
        _p("中速进退", "sine", 0.30, 0.70, 0.45, 20, 3500, axis="R1"),
        _p("匀速爬升", "ramp", 0.20, 0.80, 0.35, 20, 3600),
    ],
    "快速": [
        _p("快速冲刺", "sine", 0.40, 0.60, 1.20, 15, 4500),
        _p("浅快撩拨", "sine", 0.45, 0.55, 2.00, 10, 3000),
        _p("快速深抽", "triangle", 0.22, 0.78, 0.90, 15, 6000),
        _p("高频连击", "sine", 0.38, 0.62, 1.60, 10, 5000),
        _p("快速方块", "square", 0.30, 0.70, 0.85, 15, 5500),
        _p("急速浅抽", "triangle", 0.44, 0.56, 2.40, 8, 3200),
        _p("冲刺中段", "sine", 0.30, 0.70, 1.00, 15, 5200),
        _p("高频摇摆", "sine", 0.35, 0.65, 1.20, 12, 4000, axis="R2"),
        _p("急停急起", "square", 0.25, 0.75, 0.70, 15, 6000),
        _p("冲刺收尾", "sine", 0.40, 0.60, 0.90, 12, 4500),
    ],
    "主题": [
        _p("左右摇摆", "sine", 0.30, 0.70, 0.40, 20, 3000, axis="R2"),
        _p("前后进退", "sine", 0.30, 0.70, 0.40, 20, 3000, axis="R1"),
        _p("单向推拉", "ramp", 0.25, 0.75, 0.20, 20, 3000),
        _p("阶梯上行", "ramp", 0.20, 0.80, 0.08, 25, 2600),
        _p("心跳", "square", 0.42, 0.58, 1.10, 20, 4000),
        _p("波浪", "sine", 0.25, 0.75, 0.33, 25, 3200),
        _p("渐快", "sine", 0.32, 0.68, 0.80, 20, 4200),
        _p("渐慢", "sine", 0.32, 0.68, 0.25, 25, 3000),
        _p("停顿节奏", "square", 0.25, 0.75, 0.70, 20, 5000),
        _p("画圈", "sine", 0.35, 0.65, 0.35, 25, 3000, axis="R0"),
    ],
}


DEFAULT_AXIS_CFG = {"enabled": True, "invert": False, "min": 0.0, "max": 1.0, "maxspeed": 9999}

CALIB = {
    "device": "OSR2",
    "profile": "OSR2",
    "order": list(DEFAULT_AXES),
    "axes": {a: dict(DEFAULT_AXIS_CFG) for a in DEFAULT_AXES},
}


def _norm_axis_code(code):
    code = str(code or "").strip().upper()
    if len(code) < 2:
        return None
    if not (code[0].isalpha() and code[1:].isdigit()):
        return None
    return code[:3]


def load_calib():
    global CALIB
    try:
        with open(CALIB_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        order = []
        for a in (data.get("order") or list((data.get("axes") or {}).keys())):
            c = _norm_axis_code(a)
            if c and c not in order:
                order.append(c)
        axes = {}
        for a, src in (data.get("axes") or {}).items():
            c = _norm_axis_code(a)
            if not c:
                continue
            cfg = dict(DEFAULT_AXIS_CFG)
            cfg.update({k: v for k, v in (src or {}).items() if k in DEFAULT_AXIS_CFG})
            cfg["enabled"] = bool(cfg.get("enabled", True))
            cfg["invert"] = bool(cfg.get("invert", False))
            cfg["min"] = max(0.0, min(0.98, float(cfg.get("min", 0.0))))
            cfg["max"] = min(1.0, max(0.02, float(cfg.get("max", 1.0))))
            cfg["maxspeed"] = int(max(100, min(9999, float(cfg.get("maxspeed", 9999)))))
            axes[c] = cfg
            if c not in order:
                order.append(c)
        if order:
            CALIB["order"] = order
            CALIB["axes"] = axes
        CALIB["device"] = str(data.get("device") or CALIB["device"])[:40]
        CALIB["profile"] = str(data.get("profile") or CALIB["profile"])[:20]
    except Exception:
        pass
    return CALIB


def save_calib(data):
    global CALIB
    order = []
    axes = {}
    for a, src in (data.get("axes") or {}).items():
        code = _norm_axis_code(a)
        if not code or code in axes:
            continue
        src = src or {}
        cfg = dict(DEFAULT_AXIS_CFG)
        cfg["enabled"] = bool(src.get("enabled", True))
        cfg["invert"] = bool(src.get("invert", False))
        cfg["min"] = max(0.0, min(0.98, float(src.get("min", 0.0))))
        cfg["max"] = min(1.0, max(0.02, float(src.get("max", 1.0))))
        if cfg["min"] >= cfg["max"]:
            cfg["min"], cfg["max"] = 0.0, 1.0
        cfg["maxspeed"] = int(max(100, min(9999, float(src.get("maxspeed", 9999)))))
        axes[code] = cfg
        order.append(code)
    if not axes:
        raise ValueError("至少要保留一个轴")
    CALIB["order"] = order
    CALIB["axes"] = axes
    if data.get("device"):
        CALIB["device"] = str(data["device"])[:40]
    if data.get("profile"):
        CALIB["profile"] = str(data["profile"])[:20]
    try:
        with open(CALIB_FILE, "w", encoding="utf-8") as fh:
            json.dump(CALIB, fh, ensure_ascii=False, indent=2)
    except Exception as exc:
        print("[warn] 校准文件写不进去：%s" % exc, flush=True)
    return CALIB


# ---------------------------------------------------------------- 播放完的循环策略
LOOP_DEFAULT = {"mode": "single", "minutes": 30}   # off / single / rotate


DRIVE_DEFAULT = {"teach": True, "rewind_stop": True}


def _norm_drive(cfg):
    out = dict(DRIVE_DEFAULT)
    if isinstance(cfg, dict):
        if "teach" in cfg:
            out["teach"] = bool(cfg["teach"])
        if "rewind_stop" in cfg:
            out["rewind_stop"] = bool(cfg["rewind_stop"])
    return out


def drive_cfg():
    try:
        return _norm_drive(load_store().get("drive"))
    except Exception:
        return dict(DRIVE_DEFAULT)

def _norm_loop(cfg):
    out = dict(LOOP_DEFAULT)
    if isinstance(cfg, dict):
        mode = str(cfg.get("mode") or "single")
        if mode in ("off", "single", "rotate"):
            out["mode"] = mode
        try:
            out["minutes"] = int(max(1, min(240, int(cfg.get("minutes", 30)))))
        except Exception:
            pass
    return out


def _loop_cfg():
    try:
        return _norm_loop(load_store().get("loop"))
    except Exception:
        return dict(LOOP_DEFAULT)


# 让 /api/state 也带上循环状态，界面和卡面板都能读


def default_store():
    return {"version": 3, "active": "中速",
            "interrupt": "boundary",
            "compose": dict(COMPOSE_DEFAULT),
            "loop": dict(LOOP_DEFAULT),
            "drive": dict(DRIVE_DEFAULT),
            "groups": {k: [dict(x) for x in v] for k, v in DEFAULT_GROUPS.items()}}


_MEM_STORE = None


# 预设文件的备用位置（安装目录不可写时用）
_FALLBACK_DIR = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"),
                             "OSR控制器")
_FALLBACK_FILE = os.path.join(_FALLBACK_DIR, "presets.json")
_STORE_PATH = None


# ---------------------------------------------------------------- AI 暂存动作组（L2）
# AI 在对话里存下的组先放这里，玩家在联动页「AI 暂存」标签里确认后才变成正式动作组
def load_ai_groups():
    try:
        with open(AI_GROUPS_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        items = data.get("groups") if isinstance(data, dict) else data
        return [x for x in (items or []) if isinstance(x, dict) and x.get("cards")]
    except Exception:
        return []


def save_ai_groups(items):
    try:
        with open(AI_GROUPS_FILE, "w", encoding="utf-8") as fh:
            json.dump({"version": 1, "groups": items}, fh, ensure_ascii=False, indent=2)
    except Exception as exc:
        print("[ai] 暂存保存失败: %s" % exc, flush=True)


def _norm_ai_cards(cards):
    """把 AI 给的 cards 夹到安全范围，并按动作库白名单过滤"""
    cfg = compose_cfg()
    out = []
    for item in (cards or [])[:int(cfg["max_cards"])]:
        if not isinstance(item, dict):
            continue
        nm = str(item.get("stroke") or "").strip()
        if nm not in STROKES:
            continue
        try:
            bpm = float(item.get("bpm", 40))
            gain = float(item.get("gain", 0.8))
            secs = float(item.get("secs", 15))
        except Exception:
            continue
        out.append({"kind": "stroke", "stroke": nm,
                    "stroke_cn": STROKES[nm].get("cn") or nm,
                    "name": STROKES[nm].get("cn") or nm,
                    "bpm": round(max(5.0, min(float(cfg["bpm_cap"]), bpm)), 1),
                    "gain": round(max(0.1, min(1.0, gain)), 2),
                    "secs": round(max(1.0, min(float(cfg["max_secs"]), secs)), 1),
                    "accel": 0.3, "trans": 0.25})
    return out


def _unique_group_name(groups, want):
    name = str(want or "AI 编排").strip()[:20] or "AI 编排"
    if not name.startswith("AI·"):
        name = "AI·" + name
    name = name[:24]
    if name not in groups:
        return name
    for i in range(2, 100):
        cand = ("%s%d" % (name, i))[:24]
        if cand not in groups:
            return cand
    return name


def _store_path():
    """优先安装目录的 presets.json；不存在时用回退文件"""
    global _STORE_PATH
    if _STORE_PATH:
        return _STORE_PATH
    if os.path.exists(PRESET_FILE):
        _STORE_PATH = PRESET_FILE
    elif os.path.exists(_FALLBACK_FILE):
        _STORE_PATH = _FALLBACK_FILE
    else:
        _STORE_PATH = PRESET_FILE
    return _STORE_PATH



# ---------------------------------------------------------------- AI 编排（L1 临时组）
# 模型在正文里写的编排指令用哪个标记、是否允许、以及硬上限，全部由控制器这一份配置决定，
# 插件每轮读一次，所以在这里改完立刻生效，不用重启 DSH。
COMPOSE_DEFAULT = {"tag": "osr-compose", "enabled": True,
                   "max_cards": 6, "max_secs": 60, "bpm_cap": 120}


def _norm_compose(cfg):
    out = dict(COMPOSE_DEFAULT)
    if isinstance(cfg, dict):
        tag = str(cfg.get("tag") or "").strip()
        if tag:
            out["tag"] = tag[:24]
        if "enabled" in cfg:
            out["enabled"] = bool(cfg.get("enabled"))
        for key, lo, hi in (("max_cards", 1, 12), ("max_secs", 5, 600), ("bpm_cap", 20, 240)):
            try:
                out[key] = int(max(lo, min(hi, int(cfg.get(key, out[key])))))
            except Exception:
                pass
    return out


def compose_cfg():
    try:
        return _norm_compose(load_store().get("compose"))
    except Exception:
        return dict(COMPOSE_DEFAULT)


def _seq_playing():
    """当前组播放进度，给 /api/plugin/list 用。"""
    try:
        if ENGINE.mode != "sequence" or not ENGINE.seq:
            return None
        idx = ENGINE.seq_idx
        cur = ENGINE.seq[idx] if 0 <= idx < len(ENGINE.seq) else None
        left = 0.0
        if cur:
            left = max(0.0, float(cur.get("secs") or 0) - (time.perf_counter() - ENGINE.seq_started))
        return {"group": ENGINE.seq_group or ENGINE.seq_name, "index": idx + 1, "total": len(ENGINE.seq),
                "current": (cur or {}).get("name") or "", "left": round(left, 1)}
    except Exception:
        return None


def load_store():
    global _MEM_STORE
    if _MEM_STORE is not None:
        return _MEM_STORE
    try:
        with open(_store_path(), "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("groups"), dict) and data["groups"]:
            groups = {k: v[:MAX_PRESETS] for k, v in data["groups"].items() if isinstance(v, list)}
            if not groups:
                raise ValueError("empty")
            active = data.get("active") if data.get("active") in groups else list(groups)[0]
            mode = str(data.get("interrupt") or "boundary")
            if mode not in ("boundary", "after-group", "immediate"):
                mode = "boundary"
            return {"version": 3, "active": active, "groups": groups,
                    "interrupt": mode, "compose": _norm_compose(data.get("compose")),
                    "loop": _norm_loop(data.get("loop")),
                    "drive": _norm_drive(data.get("drive"))}
        if isinstance(data, list):            # 旧版扁平列表 → 迁移成「默认」组
            groups = {"默认": data[:MAX_PRESETS]}
            for k, v in DEFAULT_GROUPS.items():
                groups.setdefault(k, [dict(x) for x in v])
            return {"version": 3, "active": "默认", "groups": groups,
                    "interrupt": "boundary", "compose": dict(COMPOSE_DEFAULT)}
    except Exception:
        pass
    return default_store()


def save_store(store):
    """保存预设；安装目录不可写时自动改存到 %LOCALAPPDATA%\\OSR控制器\\"""
    global _MEM_STORE, _STORE_PATH
    _MEM_STORE = store
    last = None
    for path in (_store_path(), _FALLBACK_FILE):
        try:
            d = os.path.dirname(path)
            if d and not os.path.isdir(d):
                os.makedirs(d, exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(store, fh, ensure_ascii=False, indent=2)
            if path != _STORE_PATH:
                print("[store] 安装目录不可写，预设已改存到 %s" % path, flush=True)
                _STORE_PATH = path
            return True
        except Exception as exc:
            last = exc
    print("[warn] presets 保存失败: %s (本次改动只在内存)" % last, flush=True)
    return False

# ---------------------------------------------------------------- 设备
class Device:
    def __init__(self):
        self.kind = None
        self.detail = ""
        self.ser = None
        self.sock = None
        self.file = None
        self.ws = None
        self.wifi_ip = None
        self.last_error = ""
        self.dropped_frames = 0
        self.lock = threading.RLock()   # 可重入：避免 stop() 嵌套自锁

    def connect(self, port="COM3", prefer="auto", baud=115200, host=None):
        self.close()
        errors = []
        if prefer in ("auto", "wifi") or (prefer == "auto" and host):
            ip = (host or WIFI_HOST).strip()
            try:
                ws = WSClient(ip, 80, "/ws")
                ws.connect()
                self.ws = ws
                self.kind = "wifi"
                self.detail = "WiFi %s" % ip
                self.wifi_ip = ip
                return True, self.detail
            except Exception as exc:
                errors.append("WiFi: %s" % exc)
        if prefer in ("auto", "serial") and serial is not None:
            try:
                s = serial.Serial()
                s.port = port
                s.baudrate = baud
                s.timeout = 0.2
                s.write_timeout = 1.0
                s.dtr = False
                s.rts = False
                s.open()
                time.sleep(1.2)
                self.ser = s
                self.kind = "serial"
                self.detail = "%s @ %d" % (port, baud)
                return True, self.detail
            except Exception as exc:
                errors.append("串口: %s" % exc)
        if prefer in ("auto", "bridge"):
            try:
                sock = socket.create_connection((BRIDGE_HOST, BRIDGE_PORT), timeout=3)
                sock.setblocking(False)          # 只发不等回包
                self.sock = sock
                self.kind = "bridge"
                self.detail = "TCode 桥 %s:%d" % (BRIDGE_HOST, BRIDGE_PORT)
                return True, self.detail
            except Exception as exc:
                errors.append("桥: %s" % exc)
        self.kind = None
        return False, "连接失败（" + "；".join(errors) + "）"

    def send(self, tcode):
        if not self.kind:
            return False
        with self.lock:
            try:
                if self.kind == "wifi":
                    self.ws.send_text(tcode + "\n")
                elif self.kind == "serial":
                    self.ser.write((tcode + "\n").encode("ascii"))
                    self.ser.flush()
                else:
                    try:
                        self.sock.sendall(("raw " + tcode + "\n").encode("utf-8"))
                    except (BlockingIOError, InterruptedError):
                        pass                     # 发不出去就丢这一帧，别堵住引擎
                    try:
                        while self.sock.recv(8192):
                            pass
                    except (BlockingIOError, InterruptedError):
                        pass
                    except Exception:
                        pass
                return True
            except Exception as exc:
                # WiFi 拥塞/发送缓冲满（socket.timeout 等）只是这一帧没赶上，
                # 丢掉这帧即可；如果按“掉线”计，60Hz 的高频动作会把链路判死，
                # 表现就是“播放一会儿就设备连接失败”。
                if isinstance(exc, (socket.timeout, BlockingIOError, InterruptedError)):
                    self.dropped_frames = getattr(self, "dropped_frames", 0) + 1
                    return True
                self.last_error = "%s: %s" % (type(exc).__name__, exc)
                return False

    def close(self):
        try:
            if self.ser:
                self.ser.write(b"DSTOP\n")
                self.ser.flush()
                self.ser.close()
        except Exception:
            pass
        try:
            if self.ws:
                self.ws.close()
        except Exception:
            pass
        try:
            if self.sock:
                self.sock.close()
        except Exception:
            pass
        self.ser = self.sock = self.file = None
        self.ws = None
        self.kind = None
        self.detail = ""


# ---------------------------------------------------------------- 引擎
class Engine:
    def __init__(self):
        self.device = Device()
        self.lock = threading.RLock()
        self.lo, self.hi = 0.25, 0.75      # 安全行程（避免机械臂干涉）
        self.speed_cap = 3000
        self.pos = {a: 0.5 for a in CALIB["order"]}

        self.mode = "idle"          # idle / preset / sequence / funscript
        self.preset = None
        self.preset_name = ""
        self.preset_started = 0.0
        self.preset_secs = 0.0

        self.seq = []
        self.seq_idx = 0
        self.seq_started = 0.0
        self.seq_name = ""

        # 新组触发时的处理方式：boundary=播完当前动作就切 / after-group=播完整组再切 / immediate=立刻切
        try:
            self.interrupt_mode = str(load_store().get("interrupt") or "boundary")
        except Exception:
            self.interrupt_mode = "boundary"
        if self.interrupt_mode not in ("boundary", "after-group", "immediate"):
            self.interrupt_mode = "boundary"
        self.pending = None          # 等待切换的新组 {"name","cards","mode","at"}
        self.loop_mode = "off"          # off / single / rotate（插件触发播完后是否继续）
        self.loop_pool = []              # 可轮换的组 [{name, cards}]
        self.loop_until = 0.0            # 循环截止时间
        self.loop_minutes = 30
        self.loop_rounds = 0
        self.seq_group = ""              # 当前「组名」（seq_name 是当前动作名，两者不同）
        self.last_switch = None      # 最近一次切换 {"from","to","at","reason"}
        self.switch_count = 0

        self.scripts = []
        self.fs_time = 0.0
        self.fs_speed = 1.0
        self.fs_loop = False
        self.fs_duration = 0.0

        self._send_fail = 0
        self._last_reconnect = 0.0
        self.last_api = time.time()
        self.stroke = None          # 动作库：正在播放的 stroke
        self.stroke_started = 0.0
        self.estop = False          # 急停锁存：为 True 时拒绝一切运动指令
        self.rate = 60.0            # 发送频率（Hz），太高设备吃不消
        self._lp = {}
        self.freeplay = False
        self.last_trigger = None
        self.fp_next = 0.0
        self.fp_interval = 18.0
        self._last_emit = 0.0
        self._gap_max = 0.0
        self._gap_avg = 0.02

        # Windows：把系统定时器精度提到 1ms，否则 sleep 会有 15ms 抖动
        try:
            import ctypes
            ctypes.windll.winmm.timeBeginPeriod(1)
        except Exception:
            pass
        self.estop_ts = 0.0

        self.thread = threading.Thread(target=self._run, daemon=True)
        self.running = True
        self.thread.start()

    def clamp(self, v):
        return max(self.lo, min(self.hi, float(v)))

    def _cmd(self, axis, value, speed=None, cfg=None, modifier=None):
        """只生成命令字符串（不发送），供多轴合并用"""
        axis = str(axis or "").strip().upper()
        v = self.clamp(value)
        if cfg is None:
            cfg = CALIB["axes"].get(axis)
        if cfg is None or not cfg.get("enabled", True):
            return None, None
        lo, hi = cfg.get("min", 0.0), cfg.get("max", 1.0)
        mapped = (1.0 - v) if cfg.get("invert") else v
        units = int(round((lo + (hi - lo) * mapped) * 9999))
        cap = min(self.speed_cap, int(cfg.get("maxspeed", 9999)))
        spd = int(min(cap, max(30, speed or cap)))
        mod = TC_MODIFIER if modifier is None else modifier
        if mod == "S":
            cmd = "%s%04dS%d" % (axis, units, spd)
        elif mod == "I":
            cmd = "%s%04dI%d" % (axis, units, 1000)
        else:
            cmd = "%s%04d" % (axis, units)
        return cmd, v

    def emit(self, axis, value, speed=None, cfg=None, raw=False, modifier=None):
        if self.estop:
            return False            # 急停锁存期间，任何运动指令一律不执行
        axis = str(axis or "").strip().upper()
        v = self.clamp(value)          # 统一走安全窗口（lo~hi），raw 也不越界
        if cfg is None:
            cfg = CALIB["axes"].get(axis)
        if cfg is None or not cfg.get("enabled", True):
            return False                       # 这个轴没启用（例如设备没有 R1）
        lo, hi = cfg.get("min", 0.0), cfg.get("max", 1.0)
        mapped = (1.0 - v) if cfg.get("invert") else v
        units = int(round((lo + (hi - lo) * mapped) * 9999))
        cap = min(self.speed_cap, int(cfg.get("maxspeed", 9999)))
        spd = int(min(cap, max(30, speed or cap)))
        mod = TC_MODIFIER if modifier is None else modifier
        if mod == "S":
            cmd = "%s%04dS%d" % (axis, units, spd)           # 速度（单位/秒）
        elif mod == "I":
            prev = self.pos.get(axis, 0.5)
            dist = abs(units - int(round((lo + (hi - lo) * ((1.0 - prev) if cfg.get("invert") else prev)) * 9999)))
            ms = int(max(20, min(10000, dist / max(1.0, spd) * 1000.0)))
            cmd = "%s%04dI%d" % (axis, units, ms)            # 时间间隔（毫秒）
        else:
            cmd = "%s%04d" % (axis, units)                   # 裸位置（同 ayva）
        ok = self.device.send(cmd)
        now_e = time.perf_counter()
        if self._last_emit:
            gap = now_e - self._last_emit
            self._gap_avg = self._gap_avg * 0.9 + gap * 0.1
            self._gap_max = max(self._gap_max * 0.995, gap)
        self._last_emit = now_e
        if ok:
            self.pos[axis] = v
            self._send_fail = 0
        else:
            self._send_fail += 1
            if self._send_fail >= 5:      # 连续发不出去 → 判定掉线，等自动重连
                print("[link] 连续 %d 次发送失败，判定设备掉线并关闭连接（%s）"
                      % (self._send_fail, self.device.last_error or "无错误信息"), flush=True)
                self.device.close()
                self._send_fail = 0
        return ok

    def safe_raw(self, txt):
        """对原始 TCode 做安全限幅：已知轴 + 4 位位置 -> 夹进 [lo,hi]"""
        import re as _re
        out = []
        for part in txt.split():
            m = _re.match(r"^([A-Za-z]\d)(\d{4})(.*)$", part)
            if not m:
                out.append(part)
                continue
            axis, pos, rest = m.group(1).upper(), int(m.group(2)), m.group(3)
            cfg = CALIB["axes"].get(axis)
            if not cfg or not cfg.get("enabled", True):
                out.append(part)                   # 不认识的轴原样发
                continue
            cal_lo = float(cfg.get("min", 0.0))
            cal_hi = float(cfg.get("max", 1.0))
            raw_v = (pos / 9999.0 - cal_lo) / max(1e-6, cal_hi - cal_lo)
            if cfg.get("invert"):
                raw_v = 1.0 - raw_v
            clamped = self.clamp(raw_v)
            mapped = (1.0 - clamped) if cfg.get("invert") else clamped
            units = int(round((cal_lo + (cal_hi - cal_lo) * mapped) * 9999))
            out.append("%s%04d%s" % (axis, units, rest))
        return " ".join(out)

    def emit_many(self, items, modifier=None):
        """一次发多条轴命令（空格分隔，固件支持），减少网络包"""
        if self.estop:
            return False
        cmds, poses = [], {}
        for axis, value, speed in items:
            cmd, v = self._cmd(axis, value, speed, None, modifier)
            if cmd:
                cmds.append(cmd)
                poses[str(axis).upper()] = v
        if not cmds:
            return False
        ok = self.device.send(" ".join(cmds))
        if ok:
            self.pos.update(poses)
            self._send_fail = 0
        else:
            self._send_fail += 1
            if self._send_fail >= 5:
                print("[link] 连续 %d 次发送失败，判定设备掉线并关闭连接（%s）"
                      % (self._send_fail, self.device.last_error or "无错误信息"), flush=True)
                self.device.close()
                self._send_fail = 0
        return ok

    def home_all(self, speed=None):
        """把所有启用的轴慢速移动到各自行程的中点（安全位）。

        约束（防损伤）：
          * 永远回“中位”，不回 0 或 100%，避免顶到机械端点；
          * 速度强制限制在 300~2000 单位/秒，慢速移动；
          * 先发 DSTOP 清掉正在执行的动作，再逐个轴下发；
          * 只对“启用”的轴操作，未启用/不存在的轴一律跳过。
        """
        spd = int(min(2000, max(300, float(speed or 1200))))
        moved = []
        with self.lock:
            self.mode = "idle"
            self.preset = None
            self.seq = []
            self.freeplay = False
            self.device.send("DSTOP")
            for axis in list(CALIB["order"]):
                cfg = CALIB["axes"].get(axis)
                if not cfg or not cfg.get("enabled", True):
                    continue
                if self.emit(axis, 0.5, spd, modifier="S"):
                    moved.append(axis)
        return {"axes": moved, "speed": spd}

    def stop(self, hard=False):
        """停止。

        hard=True  ：红色急停按钮 / Esc —— 停 + **锁存**（之后一切运动指令被拒）
        hard=False ：顶部「全部停止」、看门狗、断开连接、退出 —— 只停，不锁存
        """
        with self.lock:
            self.mode = "idle"
            self.preset = None
            self.seq = []
            self.loop_mode = "off"      # 停就是停：循环一并结束
            self.loop_pool = []
            self.loop_until = 0.0
            if hard:
                self.estop = True
                self.estop_ts = time.time()
            for _ in range(3 if hard else 2):
                self.device.send("DSTOP")

        def _burst():
            # 分批再发几次：即使前面有指令在途中/丢包，也能在 1 秒内停住
            for delay in (0.08, 0.25, 0.6, 1.0):
                time.sleep(delay)
                if self.device.kind is None:
                    try:
                        self.device.connect(prefer="wifi", host=WIFI_HOST)
                    except Exception:
                        try:
                            self.device.connect(prefer="bridge")
                        except Exception:
                            pass
                try:
                    self.device.send("DSTOP")
                except Exception:
                    pass

        if hard:
            threading.Thread(target=_burst, daemon=True).start()
        return True

    def clear_estop(self):
        self.estop = False
        return True

    def _norm_preset(self, preset):
        kind = str(preset.get("kind") or "wave")
        if kind == "stroke":
            name = str(preset.get("stroke") or "")
            sdef = STROKES.get(name)
            if not sdef:
                raise ValueError("动作库里没有：%s" % name)
            p = {
                "kind": "stroke",
                "name": str(preset.get("name") or sdef.get("cn") or name)[:40],
                "stroke": name,
                "stroke_cn": sdef.get("cn") or name,
                "axes": sdef.get("axes") or {},
                "bpm": max(5.0, min(240.0, float(preset.get("bpm", 40)))),
                "gain": max(0.1, min(1.0, float(preset.get("gain", 1.0)))),
                "secs": max(1.0, min(1800.0, float(preset.get("secs", 20)))),
                "accel": max(0.0, min(2.0, float(preset.get("accel", 0.25)))),
                "trans": max(0.0, min(1.5, float(preset.get("trans", 0.2)))),
                "index": preset.get("index"),
            }
            return p

        p = {
            "kind": "wave",
            "name": str(preset.get("name", ""))[:40],
            "shape": preset.get("shape", "sine") if preset.get("shape") in SHAPES else "sine",
            "axis": str(preset.get("axis", "L0")).upper(),
            "low": self.clamp(preset.get("low", 0.3)),
            "high": self.clamp(preset.get("high", 0.7)),
            "hz": max(0.05, min(5.0, float(preset.get("hz", 0.5)))),
            "secs": max(1.0, min(180.0, float(preset.get("secs", 20)))),
            # speed = 0 -> 自动（按行程×频率算）；> 0 -> 手动固定速度
            "speed": (int(min(self.speed_cap, max(50, float(preset.get("speed") or 0))))
                      if float(preset.get("speed") or 0) > 0 else 0),
            "accel": max(0.0, min(2.0, float(preset.get("accel", 0.25)))),
            "trans": max(0.0, min(1.5, float(preset.get("trans", 0.2)))),
            "index": preset.get("index"),
            "speed_mode": "manual" if (str(preset.get("speed_mode") or "") == "manual"
                                       and float(preset.get("speed") or 0) > 0) else "auto",
        }
        if p["axis"] not in CALIB["axes"]:
            p["axis"] = CALIB["order"][0] if CALIB["order"] else "L0"
        if p["low"] > p["high"]:
            p["low"], p["high"] = p["high"], p["low"]
        # 关键：按形状+频率算出需要的速度（单位/秒），否则幅度会被削平
        amp = (p["high"] - p["low"]) * 9999.0
        factor = math.pi if p["shape"] == "sine" else 2.0
        need = amp * p["hz"] * factor * 1.15
        p["speed_need"] = int(round(need))
        # 只有显式标记为 manual 时才算手动速度（老卡片没有这个字段 -> 自动）
        manual = (str(preset.get("speed_mode") or "") == "manual"
                  and float(p.get("speed") or 0) > 0)
        p["speed_mode"] = "manual" if manual else "auto"
        if manual:
            p["speed_eff"] = int(min(9999, p["speed"]))
            p["hz_eff"] = p["hz"]
            p["speed_limited"] = p["speed_eff"] < need
        else:
            p["speed_eff"] = int(min(9999, max(need, 200)))
            p["speed_limited"] = need > 9999
            p["hz_eff"] = max(0.05, p["hz"] * (9999.0 / need)) if need > 9999 else p["hz"]
        return p

    # ---- 动作库（TempestStroke）----
    @staticmethod
    def _tempest_pos(cfg, t, bpm):
        """ayva / Tempest 的动作公式：mid - half*cos(h + ecc*sin(h))"""
        f = 2.0 * math.pi * float(bpm) / 60.0
        mid = 0.5 * (float(cfg["to"]) + float(cfg["from"]))
        half = 0.5 * (float(cfg["to"]) - float(cfg["from"]))
        h = f * t + 0.5 * math.pi * float(cfg.get("phase") or 0)
        return mid - half * math.cos(h + float(cfg.get("ecc") or 0) * math.sin(h))

    def run_stroke(self, name, bpm=60, secs=0, gain=1.0, force_single=False):
        sdef = STROKES.get(name)
        if not sdef:
            raise ValueError("没有这个动作：%s" % name)
        all_axes = sdef.get("axes") or {}
        moving = {}
        for a, c in all_axes.items():
            cal = CALIB["axes"].get(a)
            if cal and cal.get("enabled", True) and abs(float(c["to"]) - float(c["from"])) > 1e-6:
                moving[a] = c
        mapped = None
        if force_single and moving:
            # 单轴模式：取幅度最大的轴，压到第一个启用的轴上
            src_axis, src_cfg = max(
                moving.items(), key=lambda kv: abs(float(kv[1]["to"]) - float(kv[1]["from"])))
            dst = CALIB["order"][0] if CALIB["order"] else "L0"
            if dst != src_axis:
                moving = {dst: src_cfg}
                mapped = "%s → %s（单轴）" % (src_axis, dst)
        if not moving:
            # 设备上没有这个动作用到的轴（例如只有 L0 的机器跑纯 R2 动作）
            # -> 取幅度最大的那条轴，映射到第一个启用的轴
            src_axis, src_cfg = max(
                all_axes.items(),
                key=lambda kv: abs(float(kv[1]["to"]) - float(kv[1]["from"])))
            dst = CALIB["order"][0] if CALIB["order"] else "L0"
            if abs(float(src_cfg["to"]) - float(src_cfg["from"])) < 1e-6:
                raise ValueError("这个动作在你的设备上没有可动的轴")
            moving = {dst: src_cfg}
            mapped = "%s → %s" % (src_axis, dst)
        with self.lock:
            self.stop(hard=False)
            self.stroke = {
                "name": name,
                "cn": sdef.get("cn") or name,
                "axes": moving,
                "gain": max(0.1, min(2.0, float(gain or 1.0))),
                "mapped": mapped,
                "bpm": max(5.0, min(240.0, float(bpm or 60))),
                "secs": max(0.0, min(1800.0, float(secs or 0))),
            }
            self.stroke_started = time.perf_counter()
            self.mode = "stroke"
            return {"name": name, "cn": self.stroke["cn"], "bpm": self.stroke["bpm"],
                    "secs": self.stroke["secs"], "gain": self.stroke["gain"],
                    "mapped": self.stroke.get("mapped")}

    def _emit_stroke(self, t):
        st = self.stroke
        if not st:
            return
        hz = st["bpm"] / 60.0
        for axis, cfg in st["axes"].items():
            cal = CALIB["axes"].get(axis)
            if not cal or not cal.get("enabled", True):
                continue                      # 设备没有这个轴就跳过
            raw = self._tempest_pos(cfg, t, st["bpm"])
            mid_s = 0.5 * (float(cfg["to"]) + float(cfg["from"]))
            half_s = 0.5 * (float(cfg["to"]) - float(cfg["from"]))
            g = float(st.get("gain") or 1.0)
            sval = (raw - mid_s) / half_s if abs(half_s) > 1e-9 else 0.0
            sval = max(-1.0, min(1.0, sval))
            # 100% = 落在安全窗口 [lo,hi] 内；>100% 可扩展到 0~1 全行程
            center_out = 0.5 * (self.lo + self.hi)
            half_out = 0.5 * (self.hi - self.lo)
            pos = center_out + sval * half_out * min(g, 1.0)   # 增益不超过安全窗口
            pos = max(0.0, min(1.0, pos))
            amp = min(1.0, 2.0 * half_out * g) * 9999.0
            need = amp * hz * math.pi * 1.15
            self.emit(axis, pos, int(min(9999, max(200, need))), raw=True)

    def _next_freeplay(self):
        import random
        names = [k for k, v in STROKES.items()
                 if any(CALIB["axes"].get(a, {}).get("enabled", True)
                        for a in (v.get("axes") or {}))]
        if not names:
            self.freeplay = False
            self.mode = "idle"
            return
        name = random.choice(names)
        sdef = STROKES[name]
        d = DEFAULTS
        bpm = random.uniform(float(d.get("bpm_min", 20)), float(d.get("bpm_max", 60)))
        gain = random.uniform(0.6, 1.0)
        self.stroke = {"name": name, "cn": sdef.get("cn") or name,
                       "axes": sdef.get("axes") or {}, "bpm": bpm,
                       "gain": gain, "secs": float(d.get("secs", 20)),
                       "mapped": None}
        self.stroke_started = time.perf_counter()
        self.fp_next = self.stroke_started + self.fp_interval
        print("[freeplay] -> %s @ %.0f BPM" % (self.stroke["cn"], bpm), flush=True)

    def run_preset(self, preset, index=None):
        with self.lock:
            self.stop()
            if index is not None and isinstance(preset, dict):
                preset = dict(preset, index=index)
            self.preset = self._norm_preset(preset)
            self.mode = "preset"
            self.preset_name = self.preset["name"]
            self.preset_started = time.perf_counter()
            self.preset_secs = self.preset["secs"]
        return self.preset

    def run_sequence(self, presets, name="", interrupt=None, loop=None, pool=None):
        """播放一个动作组。

        正在播另一组时按 interrupt_mode 处理：
          boundary    → 记到 pending，播完当前动作后切过去
          after-group → 记到 pending，整组播完再切
          immediate   → 立刻停掉当前组，直接播新组

        loop/pool 只给「插件/卡触发」用：
          loop="single" 播完重播本组；"rotate" 播完在 pool 里随机换一组；None = 沿用控制器配置
          pool = [{"name": 组名, "cards": [...]}, ...]
        """
        seq = [self._norm_preset(p) for p in presets if isinstance(p, dict)]
        if not seq:
            raise ValueError("这一组没有可用预设")
        label = str(name or seq[0].get("name") or "")[:40]
        mode = str(interrupt or self.interrupt_mode or "boundary")
        if mode not in ("boundary", "after-group", "immediate"):
            mode = "boundary"
        with self.lock:
            playing = self.mode == "sequence" and bool(self.seq)
            if playing and mode in ("boundary", "after-group"):
                cur = ""
                if 0 <= self.seq_idx < len(self.seq):
                    cur = self.seq[self.seq_idx].get("name") or ""
                self.pending = {"name": label, "cards": seq, "mode": mode,
                                "at": time.time(), "after": cur}
                print("[seq] 收到新组 %s，排到当前动作之后（当前：%s）" % (label, cur), flush=True)
                return {"count": len(seq), "queued": True, "switch_after": cur,
                        "mode": mode, "group": label}
            prev_name = ""
            if playing and 0 <= self.seq_idx < len(self.seq):
                prev_name = self.seq[self.seq_idx].get("name") or ""
            self.stop()
            self.pending = None
            self.seq = seq
            self.seq_idx = 0
            self.seq_started = time.perf_counter()
            self.seq_name = seq[0]["name"]
            self.seq_group = label
            self.mode = "sequence"
            # 循环设置：显式传入优先，否则用控制器里的配置
            if loop is None:
                cfg = _loop_cfg()
                self.loop_mode = cfg["mode"]
                self.loop_minutes = cfg["minutes"]
                self.loop_until = time.time() + self.loop_minutes * 60 if self.loop_mode != "off" else 0.0
            else:
                self.loop_mode = loop if loop in ("single", "rotate") else "off"
                self.loop_minutes = int(self.loop_minutes or 30)
                self.loop_until = time.time() + self.loop_minutes * 60 if self.loop_mode != "off" else 0.0
            self.loop_pool = [dict(g) for g in (pool or [])] or [{"name": label, "cards": list(seq)}]
            self.loop_rounds = 0

            if playing and mode == "immediate":
                # 立刻切：也记一条切换记录，界面上能看出来
                self.switch_count += 1
                self.last_switch = {"from": prev_name, "to": label or self.seq_name,
                                    "at": time.time(), "reason": "immediate"}
                print("[seq] 立刻切换 → %s（打断：%s）" % (label or self.seq_name, prev_name), flush=True)
        return {"count": len(seq), "queued": False, "mode": mode, "group": label}

    def _loop_next(self, now):
        """整组播完后决定要不要接着播（一轮对话结束后设备不该干停）。

        loop_mode: off / single（重播本组）/ rotate（在最近触发的几组里随机换）
        超过 loop_minutes 自动停，避免无人看管时一直跑。
        """
        if self.loop_mode == "off" or not self.loop_pool:
            return False
        if self.loop_until and time.time() > self.loop_until:
            print("[seq] 循环到时（%d 分钟）→ 停" % int(self.loop_minutes), flush=True)
            self.loop_mode = "off"
            return False
        pick = None
        if self.loop_mode == "rotate" and len(self.loop_pool) > 1:
            others = [g for g in self.loop_pool if g.get("name") != self.seq_group]
            pick = random.choice(others or self.loop_pool)
        else:
            pick = next((g for g in self.loop_pool if g.get("name") == self.seq_group), None)
            if not pick:
                pick = {"name": self.seq_group, "cards": list(self.seq)}
        cards = pick.get("cards") or []
        if not cards:
            return False
        self.seq = list(cards)
        self.seq_idx = 0
        self.seq_started = now
        self.seq_group = pick.get("name") or self.seq_group
        self.seq_name = (cards[0].get("name") or "")
        self.loop_rounds += 1
        print("[seq] 循环 #%d → %s" % (self.loop_rounds, self.seq_name), flush=True)
        return True

    def _apply_pending(self, finished_name, now, reason):
        """把挂起的新组接上（在当前动作或整组结束的边界调用）。"""
        pend = self.pending or {}
        self.pending = None
        cards = pend.get("cards") or []
        if not cards:
            self.mode = "idle"
            self.seq = []
            return
        self.seq = cards
        self.seq_idx = 0
        self.seq_started = now
        self.seq_group = pend.get("name") or ""
        self.seq_name = cards[0].get("name") or ""
        self.mode = "sequence"
        self.switch_count += 1
        self.last_switch = {"from": finished_name, "to": self.seq_name,
                            "at": time.time(), "reason": reason}
        print("[seq] 切换 → %s（%s，上一段：%s）" % (self.seq_name, reason, finished_name), flush=True)

    def _reshape(self, axis, pos, item, t):
        """加速度（起始软启动）+ 过渡（低通平滑）"""
        center = 0.5 * (self.lo + self.hi)
        acc = float(item.get("accel") or 0)
        if acc > 0.01:
            k = min(1.0, t / acc)
            k = k * k * (3 - 2 * k)               # smoothstep
            pos = center + (pos - center) * k
        tr = float(item.get("trans") or 0)
        if tr > 0.01:
            a = min(1.0, (1.0 / self.rate) / tr)
            prev = self._lp.get(axis, pos)
            pos = prev + (pos - prev) * a
        self._lp[axis] = pos
        return pos

    def _emit_item(self, item, t):
        """按卡片类型发射一帧（wave / stroke）"""
        if item.get("kind") == "stroke":
            hz = item["bpm"] / 60.0
            g = float(item.get("gain") or 1.0)
            batch = []
            for axis, cfg in (item.get("axes") or {}).items():
                cal = CALIB["axes"].get(axis)
                if not cal or not cal.get("enabled", True):
                    continue
                raw = self._tempest_pos(cfg, t, item["bpm"])
                mid_s = 0.5 * (float(cfg["to"]) + float(cfg["from"]))
                half_s = 0.5 * (float(cfg["to"]) - float(cfg["from"]))
                sval = (raw - mid_s) / half_s if abs(half_s) > 1e-9 else 0.0
                sval = max(-1.0, min(1.0, sval))
                center = 0.5 * (self.lo + self.hi)
                half = 0.5 * (self.hi - self.lo)
                batch.append((axis, self._reshape(axis, center + sval * half * g, item, t), None))
            if batch:
                self.emit_many(batch)                          # 一条消息发全部轴
            return
        self.emit(item["axis"],
                  self._reshape(item["axis"], self._step_preset(item, t), item, t),
                  item.get("speed_eff"))

    def _step_preset(self, p, t):
        period = 1.0 / p.get("hz_eff", p["hz"])
        phase = (t % period) / period
        if p["shape"] == "triangle":
            v = 1 - abs(2 * phase - 1)
        elif p["shape"] == "ramp":
            v = phase
        elif p["shape"] == "square":
            v = 1.0 / (1.0 + math.exp(-12.0 * math.sin(2 * math.pi * phase)))
        else:
            v = (1 - math.cos(2 * math.pi * phase)) / 2
        return p["low"] + (p["high"] - p["low"]) * v

    # ---- Funscript ----
    def add_script(self, name, axis, text):
        data = json.loads(text)
        actions = []
        for a in data.get("actions", []):
            try:
                actions.append((float(a["at"]) / 1000.0,
                                max(0.0, min(1.0, float(a["pos"]) / 100.0))))
            except Exception:
                continue
        if not actions:
            raise ValueError("这个文件里没有可用的动作点")
        actions.sort(key=lambda x: x[0])
        with self.lock:
            self.scripts = [s for s in self.scripts if s["name"] != name]
            self.scripts.append({"name": name, "axis": axis.upper(), "actions": actions,
                                 "duration": actions[-1][0]})
            self.fs_duration = max(s["duration"] for s in self.scripts)
        return {"name": name, "axis": axis.upper(), "points": len(actions),
                "duration": actions[-1][0]}

    def clear_scripts(self):
        with self.lock:
            self.scripts = []
            self.fs_time = 0.0
            self.fs_duration = 0.0
            if self.mode == "funscript":
                self.mode = "idle"
                self.device.send("DSTOP")

    def play_scripts(self, speed=1.0, loop=False, start=None):
        with self.lock:
            if not self.scripts:
                raise ValueError("还没有加载 Funscript")
            self.stop()
            self.fs_speed = max(0.2, min(4.0, float(speed)))
            self.fs_loop = bool(loop)
            self.fs_time = max(0.0, float(start)) if start is not None else 0.0
            self.mode = "funscript"
        return True

    def pause_scripts(self):
        with self.lock:
            if self.mode == "funscript":
                self.mode = "idle"
                self.device.send("DSTOP")
        return True

    def seek(self, t):
        with self.lock:
            self.fs_time = max(0.0, min(self.fs_duration, float(t)))
        return self.fs_time

    @staticmethod
    def _value_at(actions, t):
        if not actions:
            return 0.5
        if t <= actions[0][0]:
            return actions[0][1]
        if t >= actions[-1][0]:
            return actions[-1][1]
        lo, hi = 0, len(actions) - 1
        while lo + 1 < hi:
            mid = (lo + hi) // 2
            if actions[mid][0] <= t:
                lo = mid
            else:
                hi = mid
        t0, p0 = actions[lo]
        t1, p1 = actions[hi]
        if t1 <= t0:
            return p1
        return p0 + (p1 - p0) * (t - t0) / (t1 - t0)

    # ---- 主循环 ----
    def _run(self):
        td = 1.0 / self.rate
        last = time.perf_counter()
        next_tick = last + td
        while self.running:
            # 固定节拍：按绝对时间累加，避免 sleep 漂移造成抖动
            now = time.perf_counter()
            wait = next_tick - now
            if wait > 0:
                time.sleep(wait)
            next_tick += td
            if next_tick < time.perf_counter() - 0.12:      # 落后太多则重新对齐
                next_tick = time.perf_counter() + td
            now = time.perf_counter()
            elapsed = now - last
            last = now
            # 看门狗：正在运动但界面 10 秒没任何请求 → 立即停（防止关页面后继续跑）
            # 例外：显式开了「播完循环」时不停——循环本来就是没人操作也继续跑，
            #       由 loop_until（最长 N 分钟）收尾；停止/急停随时可用。
            if (self.mode != "idle" and self.loop_mode == "off"
                    and (time.time() - self.last_api) > 10.0):
                print("[watchdog] idle %.1fs -> soft stop (mode=%s)"
                      % (time.time() - self.last_api, self.mode), flush=True)
                self.stop(hard=False)      # 软停：只停不锁存
                continue

            # 掉线自动重连（只试桥，不碰串口，避免 Arduino 复位）
            if self.device.kind is None and (now - self._last_reconnect) > 8.0:
                self._last_reconnect = now
                ok, _detail = self.device.connect(prefer="wifi", host=WIFI_HOST)
                if not ok:
                    ok, _detail = self.device.connect(prefer="bridge")
                if ok:
                    print("[auto] 断线重连成功: %s" % _detail, flush=True)
            try:
                with self.lock:
                    if self.mode == "freeplay" and self.freeplay:
                        if now >= self.fp_next or not self.stroke:
                            self._next_freeplay()
                            continue
                        t = now - self.stroke_started
                        self._emit_stroke(t)
                        continue

                    if self.mode == "stroke" and self.stroke:
                        t = now - self.stroke_started
                        secs = self.stroke["secs"]
                        if secs > 0 and t >= secs:
                            self.mode = "idle"
                            self.stroke = None
                            self.device.send("DSTOP")
                            continue
                        self._emit_stroke(t)

                    elif self.mode == "preset" and self.preset:
                        p = self.preset
                        t = now - self.preset_started
                        if t >= p["secs"]:
                            self.mode = "idle"
                            self.preset = None
                            self.device.send("DSTOP")
                            continue
                        self._emit_item(p, t)

                    elif self.mode == "sequence" and self.seq:
                        t = now - self.seq_started
                        p = self.seq[self.seq_idx]
                        if t >= p["secs"]:
                            # ① 动作播完：boundary 模式在这里换新组
                            if self.pending and self.pending.get("mode") == "boundary":
                                self._apply_pending(p.get("name") or "", now, "boundary")
                                continue
                            self.seq_idx += 1
                            if self.seq_idx >= len(self.seq):
                                # ② 整组播完：after-group 模式在这里换新组
                                if self.pending:
                                    self._apply_pending(p.get("name") or "", now, "group-end")
                                    continue
                                # ③ 循环：一轮没新指令就接着播，避免一轮对话结束后设备干停
                                if self._loop_next(now):
                                    continue
                                self.mode = "idle"
                                self.seq = []
                                self.device.send("DSTOP")
                                continue
                            self.seq_started = now
                            self.seq_name = self.seq[self.seq_idx]["name"]
                            continue
                        self._emit_item(p, t)

                    elif self.mode == "funscript" and self.scripts:
                        self.fs_time += elapsed * self.fs_speed
                        if self.fs_time > self.fs_duration:
                            if self.fs_loop:
                                self.fs_time = 0.0
                            else:
                                self.fs_time = self.fs_duration
                                self.mode = "idle"
                                self.emit("L0", (self.lo + self.hi) / 2, 2000)
                                self.device.send("DSTOP")
                                continue
                        for s in self.scripts:
                            v = self._value_at(s["actions"], self.fs_time)
                            self.emit(s["axis"], v, self.speed_cap)
            except Exception:
                traceback.print_exc()
                self.mode = "idle"

    def state(self):
        with self.lock:
            seq = None
            if self.mode == "sequence" and self.seq:
                p = self.seq[self.seq_idx]
                seq = {"index": self.seq_idx + 1, "total": len(self.seq),
                       "name": self.seq_name,
                       "group": self.seq_group or "",
                       "left": round(max(0.0, p["secs"] - (time.perf_counter() - self.seq_started)), 1)}
            return {
                "connected": self.device.kind is not None,
                "backend": self.device.kind,
                "backend_detail": self.device.detail,
                "mode": self.mode,
                "tcode_modifier": TC_MODIFIER,
                "freeplay": self.freeplay,
                "last_trigger": self.last_trigger,
                "send_gap_ms": {"avg": round(self._gap_avg * 1000, 1),
                                "max": round(self._gap_max * 1000, 1)},
                "dropped_frames": getattr(self.device, "dropped_frames", 0),
                "last_link_error": getattr(self.device, "last_error", ""),
                "rate": self.rate,
                "stroke": ({"name": self.stroke["name"], "cn": self.stroke["cn"],
                            "gain": self.stroke.get("gain"),
                            "mapped": self.stroke.get("mapped"),
                            "bpm": self.stroke["bpm"],
                            "left": round(max(0.0, self.stroke["secs"] -
                                              (time.perf_counter() - self.stroke_started)), 1)
                            if self.stroke["secs"] else None}
                           if (self.mode == "stroke" and self.stroke) else None),
                "estop": self.estop,
                "position": {k: round(self.pos.get(k, 0.5), 4) for k in CALIB["order"]},
                "limits": {"lo": self.lo, "hi": self.hi, "speed_cap": self.speed_cap},
                "calib": CALIB,
                "profiles": {k: {"label": v["label"], "axes": v["axes"]}
                             for k, v in DEVICE_PROFILES.items()},
                "preset": ({"name": self.preset_name, "index": self.preset.get("index"),
                            "speed": self.preset.get("speed"),
                            "speed_mode": self.preset.get("speed_mode"),
                            "speed_eff": self.preset.get("speed_eff"),
                            "hz": self.preset.get("hz"), "hz_eff": self.preset.get("hz_eff"),
                            "speed_need": self.preset.get("speed_need"),
                            "limited": self.preset.get("speed_limited"),
                            "left": round(max(0.0, self.preset_secs - (time.perf_counter() - self.preset_started)), 1)}
                           if self.mode == "preset" else None),
                "sequence": seq,
                "interrupt_mode": self.interrupt_mode,
                "loop_mode": self.loop_mode,
                "loop_rounds": self.loop_rounds,
                "loop_until": round(self.loop_until, 1) if self.loop_until else 0,
                "pending_group": (self.pending or {}).get("name"),
                "pending_after": (self.pending or {}).get("after"),
                "last_switch": self.last_switch,
                "switch_count": self.switch_count,
                "funscript": {
                    "count": len(self.scripts),
                    "duration": round(self.fs_duration, 2),
                    "time": round(self.fs_time, 2),
                    "speed": self.fs_speed,
                    "loop": self.fs_loop,
                    "files": [{"name": s["name"], "axis": s["axis"],
                               "points": len(s["actions"]), "duration": round(s["duration"], 2)}
                              for s in self.scripts],
                },
            }


load_calib()
load_strokes()
load_user_strokes()
load_keywords()
ENGINE = Engine()
apply_limits()
load_defaults()
LAN_HOST = "127.0.0.1"


def _http_json(ip, path, timeout=6):
    import gzip as _gz
    import urllib.request as _ur
    req = _ur.Request("http://%s%s" % (ip, path), headers={"Accept-Encoding": "identity"})
    with _ur.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    if raw[:2] == b"\x1f\x8b":
        raw = _gz.decompress(raw)
    return json.loads(raw.decode("utf-8", "replace"))


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "OSRCtrl/2.0"

    def log_message(self, fmt, *args):
        pass

    def _serve_file(self, path):
        full = os.path.normpath(os.path.join(STATIC_DIR, path.lstrip("/")))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            self.send_error(404)
            return
        ctype = {".html": "text/html; charset=utf-8",
                 ".css": "text/css; charset=utf-8",
                 ".js": "application/javascript; charset=utf-8"}.get(
                     os.path.splitext(full)[1], "application/octet-stream")
        with open(full, "rb") as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8"))

    # ---------------- GET ----------------
    def do_GET(self):
        ENGINE.last_api = time.time()
        parsed = urlparse(self.path)
        path = parsed.path
        if path in ("/", "/index.html"):
            return self._serve_file("index.html")
        if path.startswith("/static/"):
            return self._serve_file(path[len("/static/"):])
        if path == "/api/state":
            st = ENGINE.state()
            st["lan"] = {"host": LAN_HOST, "port": self.server.server_port,
                         "url": "http://127.0.0.1:%d" % self.server.server_port,
                         "lan_url": "http://%s:%d" % (lan_ip(), self.server.server_port),
                         "lan_enabled": LAN_HOST not in ("127.0.0.1", "localhost")}
            return self._json(200, st)
        if path == "/api/calibration":
            return self._json(200, {"ok": True, "calib": CALIB})
        if path == "/api/plugin/compose-config":
            # 插件每轮读一次：标记、开关、上限都在控制器里改，改完立刻生效
            return self._json(200, {"ok": True, "compose": compose_cfg()})
        if path == "/api/plugin/drive-config":
            # 驱动策略：教不教模型写指令块 / 回退是否停设备
            return self._json(200, {"ok": True, "drive": drive_cfg()})
        if path == "/api/plugin/ai-groups":
            items = load_ai_groups()
            return self._json(200, {"ok": True, "max": AI_STAGE_MAX, "count": len(items),
                                    "groups": [{"id": x.get("id"), "name": x.get("name"),
                                                "count": len(x.get("cards") or []),
                                                "at": x.get("at"),
                                                "source": x.get("source"),
                                                "cards": [{"stroke": c.get("stroke"),
                                                           "cn": c.get("stroke_cn"),
                                                           "bpm": c.get("bpm"),
                                                           "gain": c.get("gain"),
                                                           "secs": c.get("secs")}
                                                          for c in (x.get("cards") or [])]}
                                               for x in items]})
        if path == "/api/plugin/list":
            store = load_store()
            return self._json(200, {
                "ok": True,
                "groups": list(store["groups"].keys()),
                "active": store.get("active"),
                "cards": {k: [{"name": c.get("name"), "kind": c.get("kind", "wave"),
                                "stroke": c.get("stroke"), "bpm": c.get("bpm"),
                                "gain": c.get("gain"), "secs": c.get("secs")} for c in v]
                           for k, v in store["groups"].items()},
                "bindings": KEYWORDS.get("bindings", []),
                "last": ENGINE.last_trigger,
                "interrupt": ENGINE.interrupt_mode,
                "playing": _seq_playing(),
                "pending": (ENGINE.pending or {}).get("name"),
                "last_switch": ENGINE.last_switch,
                "switch_count": ENGINE.switch_count,
                "compose": compose_cfg(),
                "loop": _loop_cfg(),
                "drive": drive_cfg(),
                "loop_running": ENGINE.loop_mode,
                "loop_rounds": ENGINE.loop_rounds})
        if path == "/api/strokes":
            return self._json(200, {"ok": True, "count": len(STROKES),
                                    "max": MAX_STROKES,
                                    "strokes": [_stroke_public(k, v) for k, v in STROKES.items()]})
        if path == "/api/presets":
            store = load_store()
            return self._json(200, {"active": store["active"],
                                    "groups": list(store["groups"].keys()),
                                    "presets": store["groups"][store["active"]],
                                    "all": store["groups"]})
        if path == "/api/funscript/actions":
            qs = parse_qs(parsed.query)
            name = (qs.get("name") or [""])[0]
            with ENGINE.lock:
                for s in ENGINE.scripts:
                    if s["name"] == name:
                        return self._json(200, {"ok": True, "axis": s["axis"],
                                                "actions": [[round(t, 4), round(p, 4)]
                                                            for t, p in s["actions"]]})
            return self._json(404, {"ok": False, "error": "没有这个脚本"})
        if path == "/api/ports":
            return self._json(200, {"ports": [{"device": p.device, "description": p.description}
                                              for p in (list_ports.comports() if list_ports else [])]})
        self.send_error(404)

    # ---------------- POST ----------------
    def do_POST(self):
        ENGINE.last_api = time.time()
        _t0 = time.time()
        path = urlparse(self.path).path
        try:
            data = self._body()
        except Exception as exc:
            return self._json(400, {"ok": False, "error": "请求体解析失败: %s" % exc})

        try:
            if path == "/api/connect":
                ok, detail = ENGINE.device.connect(data.get("port") or "COM3",
                                                   data.get("prefer") or "auto",
                                                   host=data.get("host") or WIFI_HOST)
                print("[connect] %s：%s" % ("成功" if ok else "失败", detail), flush=True)
                return self._json(200, {"ok": ok, "detail": detail, "backend": ENGINE.device.kind})

            if path == "/api/disconnect":
                ENGINE.stop(hard=False)
                ENGINE.device.close()
                return self._json(200, {"ok": True})

            if path == "/api/move":
                ENGINE.clear_estop()          # 用户主动操作：自动解除急停
                ok = ENGINE.emit(data.get("axis", "L0"), float(data.get("pos", 0.5)), data.get("speed"))
                return self._json(200, {"ok": ok})

            if path == "/api/tcode/modifier":
                global TC_MODIFIER
                m = str(data.get("modifier", "S")).upper()
                if m not in ("", "S", "I"):
                    raise ValueError("修饰符只能是 S（速度）或 I（间隔）")
                TC_MODIFIER = m
                return self._json(200, {"ok": True, "modifier": TC_MODIFIER})

            if path == "/api/tcode/raw":
                txt = str(data.get("tcode", "")).strip()
                if not txt:
                    raise ValueError("命令为空")
                txt = ENGINE.safe_raw(txt)          # 已知轴会被夹进安全窗口
                ok = ENGINE.device.send(txt)
                return self._json(200, {"ok": ok, "sent": txt, "modifier": TC_MODIFIER})

            if path == "/api/stop":
                hard = bool(data.get("hard", False))
                ENGINE.stop(hard=hard)
                return self._json(200, {"ok": True, "estop": ENGINE.estop, "hard": hard})

            if path == "/api/stop/clear":
                ENGINE.clear_estop()
                return self._json(200, {"ok": True, "estop": False})

            if path == "/api/defaults":
                for k in DEFAULTS:
                    if k in data:
                        DEFAULTS[k] = data[k]
                save_defaults(DEFAULTS)
                return self._json(200, {"ok": True, "defaults": DEFAULTS})

            if path == "/api/limits":
                ENGINE.lo = max(0.0, min(0.49, float(data.get("lo", ENGINE.lo))))
                ENGINE.hi = min(1.0, max(0.51, float(data.get("hi", ENGINE.hi))))
                ENGINE.speed_cap = int(max(100, min(9999, float(data.get("speed_cap", ENGINE.speed_cap)))))
                save_limits()
                return self._json(200, {"ok": True, "limits": ENGINE.state()["limits"]})

            # ---- 预设组 ----
            if path == "/api/presets":
                store = load_store()
                group = data.get("group") or store["active"]
                presets = data.get("presets")
                if not isinstance(presets, list):
                    raise ValueError("presets 必须是数组")
                if group not in store["groups"]:
                    raise ValueError("没有这个分组")
                store["groups"][group] = presets[:MAX_PRESETS]
                save_store(store)
                return self._json(200, {"ok": True, "group": group, "count": len(presets[:MAX_PRESETS])})

            if path == "/api/groups":
                store = load_store()
                action = data.get("action")
                name = (data.get("name") or "").strip()
                if action == "switch":
                    if name not in store["groups"]:
                        raise ValueError("没有这个分组")
                    store["active"] = name
                    save_store(store)
                    return self._json(200, {"ok": True, "active": name,
                                            "groups": list(store["groups"]),
                                            "presets": store["groups"][name]})
                if action == "create":
                    new = name or ("分组%d" % (len(store["groups"]) + 1))
                    if new in store["groups"]:
                        raise ValueError("分组已存在")
                    store["groups"][new] = [dict(x) for x in store["groups"][store["active"]]]
                    store["active"] = new
                    save_store(store)
                    return self._json(200, {"ok": True, "active": new, "groups": list(store["groups"])})
                if action == "duplicate":
                    new = name or (store["active"] + " 副本")
                    store["groups"][new] = [dict(x) for x in store["groups"][store["active"]]]
                    store["active"] = new
                    save_store(store)
                    return self._json(200, {"ok": True, "active": new, "groups": list(store["groups"])})
                if action == "rename":
                    new = (data.get("new_name") or "").strip()
                    if not new or new in store["groups"]:
                        raise ValueError("新名字为空或已存在")
                    store["groups"][new] = store["groups"].pop(name)
                    if store["active"] == name:
                        store["active"] = new
                    save_store(store)
                    return self._json(200, {"ok": True, "active": store["active"],
                                            "groups": list(store["groups"])})
                if action == "delete":
                    if len(store["groups"]) <= 1:
                        raise ValueError("至少要保留一个分组")
                    store["groups"].pop(name, None)
                    if store["active"] == name:
                        store["active"] = list(store["groups"])[0]
                    save_store(store)
                    return self._json(200, {"ok": True, "active": store["active"],
                                            "groups": list(store["groups"])})
                raise ValueError("未知分组操作")

            # ---- 运行 ----
            if path == "/api/strokes":
                return self._json(200, {"ok": True, "count": len(STROKES),
                                        "max": MAX_STROKES,
                                        "strokes": [_stroke_public(k, v) for k, v in STROKES.items()]})

            if path == "/api/strokes/add":
                name = str(data.get("name") or "").strip()
                cn = str(data.get("cn") or name).strip()[:30]
                axes_in = data.get("axes") or {}
                if not name:
                    raise ValueError("请填动作名称")
                if len(STROKES) >= MAX_STROKES:
                    raise ValueError("动作库已满：上限 %d 个（当前 %d，先删掉一些再建）"
                                     % (MAX_STROKES, len(STROKES)))
                clean = {}
                for ax, c in axes_in.items():
                    ax = str(ax).upper()
                    if ax not in CALIB["axes"]:
                        continue
                    try:
                        clean[ax] = {
                            "from": round(max(0.0, min(1.0, float(c.get("from", 0)))), 4),
                            "to": round(max(0.0, min(1.0, float(c.get("to", 1)))), 4),
                            "phase": round(float(c.get("phase", 0)) % 1.0, 4),
                            "ecc": round(max(0.0, min(1.0, float(c.get("ecc", 0)))), 4),
                        }
                    except Exception:
                        continue
                if not clean:
                    raise ValueError("至少需要一个轴的参数")
                key = "user:" + name
                STROKES[key] = {"cn": cn or name, "axes": clean, "user": True}
                save_user_strokes()
                return self._json(200, {"ok": True, "name": key, "cn": cn})

            if path == "/api/strokes/preview":
                # 按弹窗里当前参数试播一小段，不保存、不进动作库
                axes_in = data.get("axes") or {}
                clean = {}
                for ax, c in axes_in.items():
                    ax = str(ax).upper()
                    if ax not in CALIB["axes"]:
                        continue
                    try:
                        clean[ax] = {
                            "from": round(max(0.0, min(1.0, float(c.get("from", 0)))), 4),
                            "to": round(max(0.0, min(1.0, float(c.get("to", 1)))), 4),
                            "phase": round(float(c.get("phase", 0)) % 1.0, 4),
                            "ecc": round(max(0.0, min(1.0, float(c.get("ecc", 0)))), 4),
                        }
                    except Exception:
                        continue
                if not clean:
                    raise ValueError("至少需要一个轴的参数")
                key = "__preview__"
                STROKES[key] = {"cn": "试听", "axes": clean, "user": True}
                try:
                    ENGINE.clear_estop()
                    info = ENGINE.run_stroke(key, data.get("bpm", 50),
                                             data.get("secs", 8), data.get("gain", 0.8), False)
                finally:
                    STROKES.pop(key, None)
                return self._json(200, {"ok": True, "stroke": info})

            if path == "/api/strokes/update":
                # 编辑动作：自建动作直接改；内置动作写「覆盖层」，可还原；restore=true 还原
                key = str(data.get("name") or "")
                if key not in STROKES:
                    raise ValueError("动作不存在：%s" % key)
                cur = STROKES[key]
                if data.get("restore"):
                    if key in STROKE_OVERRIDES:
                        STROKE_OVERRIDES.pop(key, None)
                        if key in STROKE_BASE:
                            STROKES[key] = json.loads(json.dumps(STROKE_BASE[key]))
                        else:
                            cur = dict(cur)
                            cur.pop("override", None)
                            STROKES[key] = cur
                        save_user_strokes()
                        return self._json(200, {"ok": True, "restored": True, "name": key})
                    raise ValueError("这个动作没有可还原的修改")
                cn = str(data.get("cn") or cur.get("cn") or key).strip()[:30]
                axes_in = data.get("axes") or {}
                clean = {}
                for ax, c in axes_in.items():
                    ax = str(ax).upper()
                    if ax not in CALIB["axes"]:
                        continue
                    try:
                        clean[ax] = {
                            "from": round(max(0.0, min(1.0, float(c.get("from", 0)))), 4),
                            "to": round(max(0.0, min(1.0, float(c.get("to", 1)))), 4),
                            "phase": round(float(c.get("phase", 0)) % 1.0, 4),
                            "ecc": round(max(0.0, min(1.0, float(c.get("ecc", 0)))), 4),
                        }
                    except Exception:
                        continue
                if not clean:
                    raise ValueError("至少需要一个轴的参数")
                if cur.get("user"):
                    STROKES[key] = {"cn": cn, "axes": clean, "user": True}
                else:
                    STROKE_OVERRIDES[key] = {"cn": cn, "axes": clean}
                    STROKES[key] = {"cn": cn, "axes": clean,
                                    "override": True}
                save_user_strokes()
                return self._json(200, {"ok": True, "name": key, "cn": cn,
                                        "override": not bool(cur.get("user"))})

            if path == "/api/strokes/delete":
                key = str(data.get("name") or "")
                if key in STROKES and STROKES[key].get("user"):
                    del STROKES[key]
                    save_user_strokes()
                    return self._json(200, {"ok": True})
                raise ValueError("只能删除自己创建的动作（内置动作请用「还原」）")

            if path == "/api/plugin/list":
                store = load_store()
                return self._json(200, {"ok": True,
                                        "groups": list(store["groups"].keys()),
                                        "active": store.get("active"),
                                        "cards": {k: [{"name": c.get("name"),
                                                       "kind": c.get("kind", "wave"),
                                                       "stroke": c.get("stroke"),
                                                       "bpm": c.get("bpm"),
                                                       "gain": c.get("gain"),
                                                       "secs": c.get("secs")}
                                                      for c in v]
                                                  for k, v in store["groups"].items()},
                                        "bindings": KEYWORDS.get("bindings", []),
                                        "last": ENGINE.last_trigger,
                "interrupt": ENGINE.interrupt_mode,
                "playing": _seq_playing(),
                "pending": (ENGINE.pending or {}).get("name"),
                "last_switch": ENGINE.last_switch,
                "switch_count": ENGINE.switch_count,
                "compose": compose_cfg(),
                "loop": _loop_cfg(),
                "loop_running": ENGINE.loop_mode,
                "loop_rounds": ENGINE.loop_rounds})

            if path == "/api/plugin/group/edit":
                act = str(data.get("action") or "")
                store = load_store()
                groups = store["groups"]

                if act == "create":
                    name = str(data.get("name") or "").strip()[:20]
                    if not name:
                        raise ValueError("请填组名")
                    if name in groups:
                        raise ValueError("已有同名分组")
                    groups[name] = []
                    store["active"] = name
                    save_store(store)
                    return self._json(200, {"ok": True, "groups": list(groups), "active": name})

                if act == "rename":
                    old = str(data.get("old") or "")
                    new = str(data.get("new") or "").strip()[:20]
                    if old not in groups:
                        raise ValueError("原分组不存在")
                    if not new:
                        raise ValueError("请填新名字")
                    if new != old and new in groups:
                        raise ValueError("已有同名分组")
                    items = groups.pop(old)
                    groups[new] = items
                    if store.get("active") == old:
                        store["active"] = new
                    save_store(store)
                    return self._json(200, {"ok": True, "groups": list(groups), "active": new})

                if act == "delete":
                    name = str(data.get("name") or "")
                    if name not in groups:
                        raise ValueError("分组不存在")
                    if len(groups) <= 1:
                        raise ValueError("至少要保留一个分组")
                    groups.pop(name)
                    store["active"] = list(groups)[0]
                    save_store(store)
                    return self._json(200, {"ok": True, "groups": list(groups), "active": store["active"]})

                if act == "duplicate":
                    src = str(data.get("name") or "")
                    new = str(data.get("new") or "").strip()[:20]
                    if src not in groups:
                        raise ValueError("原分组不存在")
                    if not new:
                        raise ValueError("请填新名字")
                    if new in groups:
                        raise ValueError("已有同名分组")
                    groups[new] = [dict(c) for c in groups[src]]
                    save_store(store)
                    return self._json(200, {"ok": True, "groups": list(groups), "active": new})

                if act == "add":
                    name = str(data.get("name") or "")
                    if name not in groups:
                        raise ValueError("分组不存在")
                    stroke = str(data.get("stroke") or "")
                    if stroke not in STROKES:
                        raise ValueError("动作库里没有：%s" % stroke)
                    card = {"kind": "stroke", "stroke": stroke,
                            "stroke_cn": STROKES[stroke].get("cn") or stroke,
                            "name": str(data.get("card_name") or STROKES[stroke].get("cn") or stroke)[:20],
                            "bpm": float(data.get("bpm", 40)),
                            "gain": float(data.get("gain", 0.8)),
                            "secs": float(data.get("secs", 20)),
                            "accel": 0.3, "trans": 0.25}
                    groups[name].append(card)
                    save_store(store)
                    return self._json(200, {"ok": True, "count": len(groups[name])})

                if act == "remove":
                    name = str(data.get("name") or "")
                    idx = int(data.get("index", -1))
                    if name not in groups or idx < 0 or idx >= len(groups[name]):
                        raise ValueError("序号不对")
                    removed = groups[name].pop(idx)
                    save_store(store)
                    return self._json(200, {"ok": True, "removed": removed.get("name"),
                                            "count": len(groups[name])})

                raise ValueError("未知操作")

            if path == "/api/plugin/bind":
                kw = str(data.get("keyword") or "").strip()
                grp = str(data.get("group") or "").strip()
                if not kw or not grp:
                    raise ValueError("关键词和分组都要填")
                store = load_store()
                if grp not in store["groups"]:
                    raise ValueError("没有这个分组：%s" % grp)
                binds = [b for b in KEYWORDS.get("bindings", [])
                         if b.get("keyword") != kw]
                binds.append({"keyword": kw, "group": grp})
                KEYWORDS["bindings"] = binds
                save_keywords()
                return self._json(200, {"ok": True, "bindings": binds})

            if path == "/api/plugin/unbind":
                kw = str(data.get("keyword") or "").strip()
                KEYWORDS["bindings"] = [b for b in KEYWORDS.get("bindings", [])
                                        if b.get("keyword") != kw]
                save_keywords()
                return self._json(200, {"ok": True, "bindings": KEYWORDS["bindings"]})

            if path == "/api/ai/tcode":
                # AI 直接发 TCode（会被安全窗口限幅）
                cmds = data.get("tcode") or data.get("commands") or ""
                if isinstance(cmds, list):
                    cmds = " ".join(str(x) for x in cmds)
                cmds = str(cmds).strip()
                if not cmds:
                    raise ValueError("tcode 为空")
                if cmds.upper().startswith("DSTOP"):
                    ENGINE.stop(hard=False)
                    return self._json(200, {"ok": True, "sent": "DSTOP"})
                safe = ENGINE.safe_raw(cmds)
                ok = ENGINE.device.send(safe)
                return self._json(200, {"ok": bool(ok), "sent": safe,
                                        "原始": cmds[:120]})

            if path == "/api/ai/stroke":
                # AI 自由创造动作：给定轴范围/频率/波形，直接播放
                axis = str(data.get("axis") or "L0").upper()
                try:
                    low = float(data.get("low", 0.3))
                    high = float(data.get("high", 0.7))
                    hz = float(data.get("hz", 0.8))
                    secs = float(data.get("secs", 10))
                except Exception:
                    raise ValueError("参数必须是数字")
                ENGINE.clear_estop()
                card = {"kind": "wave", "axis": axis,
                        "shape": str(data.get("shape") or "sine"),
                        "low": low, "high": high, "hz": hz, "secs": secs,
                        "name": str(data.get("name") or "AI 创作")[:20],
                        "accel": float(data.get("accel", 0.3)),
                        "trans": float(data.get("trans", 0.25)),
                        "speed_mode": "auto", "speed": 0}
                info = ENGINE.run_preset(card, index=-1)
                ENGINE.last_trigger = {"group": "AI 创作", "text": card["name"],
                                       "at": time.strftime("%H:%M:%S")}
                return self._json(200, {"ok": True, "stroke": info})

            if path == "/api/ai/strokes":
                # AI 自由创作 / 编排：两种入参
                #   1) {"strokes":[名字…], "bpm":40, "gain":0.8, "secs":15}   ← 统一参数
                #   2) {"cards":[{"stroke":"…","bpm":..,"gain":..,"secs":..}, …]} ← 逐张参数（L1 编排）
                # 只播内存，不写盘；未知动作名跳过；上限由控制器「AI 编排」配置夹紧。
                cfg = compose_cfg()
                if cfg.get("enabled") is False:
                    raise ValueError("AI 编排已在控制器里关闭")
                raw_cards = data.get("cards")
                cards = []
                if isinstance(raw_cards, list) and raw_cards:
                    for item in raw_cards[:int(cfg["max_cards"])]:
                        if not isinstance(item, dict):
                            continue
                        nm = str(item.get("stroke") or "").strip()
                        if nm not in STROKES:
                            continue
                        try:
                            bpm = float(item.get("bpm", data.get("bpm", 40)))
                            gain = float(item.get("gain", data.get("gain", 0.8)))
                            secs = float(item.get("secs", data.get("secs", 15)))
                        except Exception:
                            continue
                        cards.append({"kind": "stroke", "stroke": nm,
                                      "bpm": max(5.0, min(float(cfg["bpm_cap"]), bpm)),
                                      "gain": max(0.1, min(1.0, gain)),
                                      "secs": max(1.0, min(float(cfg["max_secs"]), secs)),
                                      "name": STROKES[nm].get("cn") or nm})
                else:
                    names = data.get("strokes") or []
                    if not isinstance(names, list) or not names:
                        raise ValueError("strokes 需要是非空数组")
                    for nm in names[:int(cfg["max_cards"])]:
                        nm = str(nm)
                        if nm not in STROKES:
                            continue
                        cards.append({"kind": "stroke", "stroke": nm,
                                      "bpm": max(5.0, min(float(cfg["bpm_cap"]), float(data.get("bpm", 40)))),
                                      "gain": max(0.1, min(1.0, float(data.get("gain", 0.8)))),
                                      "secs": max(1.0, min(float(cfg["max_secs"]), float(data.get("secs", 15)))),
                                      "name": STROKES[nm].get("cn") or nm})
                if not cards:
                    raise ValueError("没有合法动作名")
                label = str(data.get("label") or "AI 编排")[:40]
                ENGINE.clear_estop()
                info = ENGINE.run_sequence(cards, name=label)
                ENGINE.last_trigger = {"group": label,
                                       "text": ",".join(c["stroke"] for c in cards)[:60],
                                       "at": time.strftime("%H:%M:%S")}
                return self._json(200, {"ok": True, "group": label,
                                        "count": len(cards), "sequence": info})

            # ---- AI 暂存动作组（L2）：AI 在对话里存下的组先落在这里，等玩家确认 ----
            if path == "/api/plugin/ai-group/offer":
                cards = _norm_ai_cards(data.get("cards"))
                if not cards:
                    raise ValueError("没有合法动作，未暂存")
                want = str(data.get("name") or data.get("label") or "AI 编排").strip()
                items = load_ai_groups()
                sig = json.dumps([[c["stroke"], c["bpm"], c["secs"], c["gain"]] for c in cards],
                                 ensure_ascii=False)
                for it in items:                     # 同样的内容不重复存，只更新时间
                    if it.get("sig") == sig:
                        it["at"] = time.strftime("%m-%d %H:%M")
                        save_ai_groups(items)
                        return self._json(200, {"ok": True, "duplicate": True, "id": it.get("id")})
                gid = "ai%d" % int(time.time() * 1000)
                items.append({"id": gid,
                              "name": want[:24] or "AI 编排",
                              "cards": cards,
                              "sig": sig,
                              "count": len(cards),
                              "at": time.strftime("%m-%d %H:%M"),
                              "source": str(data.get("source") or "")[:40]})
                if len(items) > AI_STAGE_MAX:
                    items = items[-AI_STAGE_MAX:]
                save_ai_groups(items)
                print("[ai] 暂存动作组「%s」%d 张" % (want, len(cards)), flush=True)
                return self._json(200, {"ok": True, "id": gid, "count": len(cards),
                                        "staged": len(items)})

            if path == "/api/plugin/ai-group/delete":
                gid = str(data.get("id") or "")
                items = load_ai_groups()
                left = [x for x in items if x.get("id") != gid]
                if len(left) == len(items):
                    raise ValueError("没有这个暂存组")
                save_ai_groups(left)
                return self._json(200, {"ok": True, "staged": len(left)})

            if path == "/api/plugin/ai-group/clear":
                save_ai_groups([])
                return self._json(200, {"ok": True, "staged": 0})

            if path == "/api/plugin/ai-group/preview":
                gid = str(data.get("id") or "")
                items = load_ai_groups()
                one = next((x for x in items if x.get("id") == gid), None)
                if not one:
                    raise ValueError("没有这个暂存组")
                ENGINE.clear_estop()
                info = ENGINE.run_sequence(one["cards"], name=str(one.get("name") or "AI 编排"))
                return self._json(200, {"ok": True, "sequence": info})

            if path == "/api/plugin/ai-group/promote":
                gid = str(data.get("id") or "")
                items = load_ai_groups()
                one = next((x for x in items if x.get("id") == gid), None)
                if not one:
                    raise ValueError("没有这个暂存组")
                if len(one["cards"]) > MAX_PRESETS:
                    raise ValueError("超过单组上限 %d 张" % MAX_PRESETS)
                st = load_store()
                groups = st["groups"]
                name = _unique_group_name(groups, data.get("name") or one.get("name"))
                groups[name] = [dict(c) for c in one["cards"]]
                st["active"] = name
                save_store(st)
                left = [x for x in items if x.get("id") != gid]
                save_ai_groups(left)
                print("[ai] 已存为我的动作组「%s」%d 张" % (name, len(one["cards"])), flush=True)
                return self._json(200, {"ok": True, "group": name,
                                        "count": len(one["cards"]), "staged": len(left),
                                        "groups": list(groups.keys())})

            if path == "/api/plugin/drive-config":
                st = load_store()
                cur = _norm_drive(st.get("drive"))
                if isinstance(data, dict) and data:
                    merged = dict(cur)
                    for k in ("teach", "rewind_stop"):
                        if k in data:
                            merged[k] = data[k]
                    st["drive"] = _norm_drive(merged)
                    save_store(st)
                    cur = st["drive"]
                return self._json(200, {"ok": True, "drive": cur})
            if path == "/api/plugin/loop":
                st = load_store()
                cur = _norm_loop(st.get("loop"))
                if isinstance(data, dict) and data:
                    merged = dict(cur)
                    if "mode" in data:
                        merged["mode"] = data["mode"]
                    if "minutes" in data:
                        merged["minutes"] = data["minutes"]
                    st["loop"] = _norm_loop(merged)
                    save_store(st)
                    cur = st["loop"]
                    ENGINE.loop_minutes = cur["minutes"]
                return self._json(200, {"ok": True, "loop": cur,
                                        "running": ENGINE.loop_mode,
                                        "rounds": ENGINE.loop_rounds})

            if path == "/api/plugin/compose-config":
                st = load_store()
                cur = _norm_compose(st.get("compose"))
                if isinstance(data, dict) and data:
                    merged = dict(cur)
                    merged.update({k: data[k] for k in ("tag", "enabled", "max_cards", "max_secs", "bpm_cap")
                                   if k in data})
                    st["compose"] = _norm_compose(merged)
                    save_store(st)
                    cur = st["compose"]
                return self._json(200, {"ok": True, "compose": cur})

            if path == "/api/plugin/interrupt":
                mode = str(data.get("mode") or "").strip()
                if mode not in ("boundary", "after-group", "immediate"):
                    raise ValueError("mode 只能是 boundary / after-group / immediate")
                ENGINE.interrupt_mode = mode
                st = load_store()
                st["interrupt"] = mode
                save_store(st)
                return self._json(200, {"ok": True, "interrupt": mode})

            if path == "/api/plugin/trigger":
                text = str(data.get("text") or "")
                grp = str(data.get("group") or "")
                want = [str(x).strip() for x in (data.get("groups") or []) if str(x).strip()]
                if not grp and want:
                    grp = want[0]          # 一次触发多个组时，先播第一个
                if not grp:
                    # 1) 组名就是触发词：正文里出现组名 → 直接播该组
                    store0 = load_store()
                    names = sorted(store0["groups"].keys(), key=lambda k: -len(k))
                    for nm in names:
                        if nm and nm in text:
                            grp = nm
                            break
                    # 2) 再查绑定表
                    if not grp:
                        binds = sorted(KEYWORDS.get("bindings", []),
                                       key=lambda b: -len(b.get("keyword") or ""))
                        for b in binds:
                            if b.get("keyword") and b["keyword"] in text:
                                grp = b["group"]
                                break
                if not grp:
                    return self._json(200, {"ok": False, "reason": "no_match"})
                store = load_store()
                cards = store["groups"].get(grp) or []
                if not cards:
                    raise ValueError("分组为空：%s" % grp)
                # 设备没连上就别假装触发了：先自动重连一次，仍失败就明确告诉调用方
                if ENGINE.device.kind is None:
                    ok2, detail2 = ENGINE.device.connect(prefer="wifi", host=WIFI_HOST)
                    if not ok2:
                        ok2, detail2 = ENGINE.device.connect(prefer="bridge")
                    if not ok2:
                        print("[plugin] 触发被拒：设备未连接（%s）" % detail2, flush=True)
                        return self._json(200, {"ok": False, "reason": "not_connected",
                                                "detail": detail2, "group": grp})
                # 一次触发多个组：先播第一个，其余进「轮换池」，播完按循环策略接上
                pool = []
                for nm in ([grp] + [g for g in want if g != grp]):
                    cs = store["groups"].get(nm)
                    if cs:
                        pool.append({"name": nm, "cards": [dict(c) for c in cs]})
                loop_cfg = _loop_cfg()
                ENGINE.clear_estop()
                info = ENGINE.run_sequence(cards, name=grp,
                                           loop=loop_cfg["mode"], pool=pool or None)
                ENGINE.last_trigger = {"group": grp, "text": text[:60],
                                       "at": time.strftime("%H:%M:%S")}
                print("[plugin] 触发 %s（%d 张）%s" % (
                    grp, len(cards),
                    ("，轮换池：%s" % "/".join(g["name"] for g in pool)) if len(pool) > 1 else ""),
                    flush=True)
                return self._json(200, {"ok": True, "group": grp, "sequence": info,
                                        "loop": loop_cfg["mode"],
                                        "pool": [g["name"] for g in pool]})

            if path == "/api/freeplay":
                on = bool(data.get("on", True))
                with ENGINE.lock:
                    if on:
                        ENGINE.clear_estop()
                        ENGINE.freeplay = True
                        ENGINE.fp_interval = max(4.0, min(120.0, float(
                            data.get("interval") or DEFAULTS.get("secs", 20))))
                        ENGINE.mode = "freeplay"
                        ENGINE.stroke = None
                        ENGINE.fp_next = 0.0
                        ENGINE.preset = None
                        ENGINE.seq = []
                    else:
                        ENGINE.freeplay = False
                        ENGINE.mode = "idle"
                        ENGINE.stroke = None
                        ENGINE.device.send("DSTOP")
                return self._json(200, {"ok": True, "freeplay": ENGINE.freeplay,
                                        "interval": ENGINE.fp_interval})

            if path == "/api/stroke/run":
                ENGINE.clear_estop()          # 用户主动操作：自动解除急停
                info = ENGINE.run_stroke(str(data.get("name", "")),
                                         data.get("bpm", 60),
                                         data.get("secs", 0),
                                         data.get("gain", 1.0),
                                         bool(data.get("single", False)))
                return self._json(200, {"ok": True, "stroke": info})

            if path == "/api/stroke/live":
                with ENGINE.lock:
                    if ENGINE.mode != "stroke" or not ENGINE.stroke:
                        return self._json(200, {"ok": False, "reason": "not_running"})
                    if "bpm" in data:
                        ENGINE.stroke["bpm"] = max(5.0, min(240.0, float(data["bpm"])))
                    if "gain" in data:
                        ENGINE.stroke["gain"] = max(0.1, min(2.0, float(data["gain"])))
                    return self._json(200, {"ok": True, "stroke": {
                        "bpm": ENGINE.stroke["bpm"], "name": ENGINE.stroke["name"],
                        "gain": ENGINE.stroke.get("gain")}})

            if path == "/api/preset/live":
                with ENGINE.lock:
                    if ENGINE.mode != "preset" or not ENGINE.preset:
                        return self._json(200, {"ok": False, "reason": "not_running"})
                    cur = dict(ENGINE.preset)
                    keys = ("speed", "hz", "low", "high", "secs", "shape", "axis",
                            "speed_mode", "accel", "trans")
                    if cur.get("kind") == "stroke":
                        keys = ("bpm", "gain", "secs", "accel", "trans")          # 动作卡：速度/幅度/时长
                    for k in keys:
                        if k in data:
                            cur[k] = data[k]
                    if "speed" in data and "speed_mode" not in data:
                        # 只给了速度：>0 视为手动，0 视为自动
                        cur["speed_mode"] = "manual" if float(data.get("speed") or 0) > 0 else "auto"
                    cur["index"] = ENGINE.preset.get("index")
                    ENGINE.preset = ENGINE._norm_preset(cur)
                    ENGINE.preset_name = ENGINE.preset["name"]
                    ENGINE.preset_secs = ENGINE.preset["secs"]
                    return self._json(200, {"ok": True, "preset": ENGINE.preset})

            if path == "/api/preset/import_strokes":
                # 把动作库按类别做成预设分组（覆盖同名分组）
                store = load_store()
                cats = _stroke_categories()
                for gname, items in cats.items():
                    store["groups"][gname] = items
                store["active"] = list(cats.keys())[0]
                save_store(store)
                return self._json(200, {"ok": True, "groups": {k: len(v) for k, v in cats.items()},
                                        "active": store["active"]})

            if path == "/api/preset/add":
                store = load_store()
                group = data.get("group") or store["active"]
                if group not in store["groups"]:
                    raise ValueError("没有这个分组")
                cards = store["groups"][group]
                if len(cards) >= MAX_PRESETS:
                    raise ValueError("这个组最多 %d 张卡片" % MAX_PRESETS)
                last = cards[-1] if cards else {}
                card = {
                    "name": data.get("name") or ("新预设 %d" % (len(cards) + 1)),
                    "shape": data.get("shape") or last.get("shape", "sine"),
                    "axis": data.get("axis") or last.get("axis", "L0"),
                    "low": float(data.get("low", last.get("low", 0.3))),
                    "high": float(data.get("high", last.get("high", 0.7))),
                    "hz": float(data.get("hz", last.get("hz", 0.5))),
                    "secs": float(data.get("secs", 20)),
                    "speed": int(data.get("speed", last.get("speed", 4000))),
                }
                cards.append(card)
                store["groups"][group] = cards
                save_store(store)
                return self._json(200, {"ok": True, "index": len(cards) - 1,
                                        "presets": cards, "preset": card})

            if path == "/api/preset/delete":
                store = load_store()
                group = data.get("group") or store["active"]
                cards = store["groups"].get(group)
                if not cards:
                    raise ValueError("没有这个分组")
                idx = int(data.get("index", -1))
                if idx < 0 or idx >= len(cards):
                    raise ValueError("序号超出范围")
                cards.pop(idx)
                save_store(store)
                return self._json(200, {"ok": True, "presets": cards})

            if path == "/api/firmware":
                ip = str(data.get("host") or WIFI_HOST)
                try:
                    info = _http_json(ip, "/systemInfo")
                    return self._json(200, {"ok": True, "ip": ip,
                                            "url": "http://%s" % ip,
                                            "version": str(info.get("esp32Version", "")).strip(),
                                            "tcode": info.get("TCodeVersion")})
                except Exception as exc:
                    return self._json(200, {"ok": True, "ip": ip, "url": "http://%s" % ip,
                                            "version": "?", "tcode": None, "error": str(exc)})

            if path == "/api/device/info":
                ip = str(data.get("host") or WIFI_HOST)
                try:
                    info = _http_json(ip, "/systemInfo")
                    try:
                        settings = _http_json(ip, "/systemSettings")
                        dev_type = settings.get("deviceType")
                    except Exception:
                        dev_type = None
                    if dev_type is None:
                        dev_type = info.get("deviceType")
                    prof = "OSR2" if dev_type in (None, 1) else "SR6"
                    return self._json(200, {"ok": True, "deviceType": dev_type,
                                            "suggestProfile": prof,
                                            "version": info.get("esp32Version", "").strip(),
                                            "tcodeVersion": info.get("TCodeVersion"),
                                            "channels": [c.get("name") for c in info.get("availableChannels", [])]})
                except Exception as exc:
                    raise ValueError("读取设备信息失败：%s" % exc)

            if path == "/api/home":
                ENGINE.clear_estop()          # 用户主动操作：自动解除急停
                return self._json(200, {"ok": True, "home": ENGINE.home_all(data.get("speed"))})

            if path == "/api/calibration/reset":
                axes = {}
                for a in list(CALIB["order"]):
                    axes[a] = dict(DEFAULT_AXIS_CFG)      # 全部启用、0~100%、正向、9999
                saved = save_calib({"axes": axes,
                                    "device": CALIB.get("device", "OSR2"),
                                    "profile": CALIB.get("profile", "CUSTOM")})
                return self._json(200, {"ok": True, "calib": saved})

            if path == "/api/calibration":
                return self._json(200, {"ok": True, "calib": save_calib(data)})

            if path == "/api/calibration/profile":
                key = str(data.get("profile", "OSR2")).upper()
                prof = DEVICE_PROFILES.get(key)
                if not prof:
                    raise ValueError("没有这个设备型号")
                axes = {}
                for a in prof["axes"]:
                    old = CALIB["axes"].get(a) or {}
                    cfg = dict(DEFAULT_AXIS_CFG)
                    cfg.update({k: v for k, v in old.items() if k in DEFAULT_AXIS_CFG})
                    axes[a] = cfg
                saved = save_calib({"axes": axes, "device": prof["device"], "profile": key})
                return self._json(200, {"ok": True, "calib": saved})

            if path == "/api/calibration/jog":
                ENGINE.clear_estop()          # 用户主动操作：自动解除急停
                axis = str(data.get("axis", "L0")).upper()
                pos = float(data.get("pos", 0.5))
                speed = data.get("speed")
                override = data.get("override") or {}
                cfg = None
                if isinstance(override, dict) and override:
                    cfg = dict(DEFAULT_AXIS_CFG)
                    cfg.update({k: override[k] for k in DEFAULT_AXIS_CFG if k in override})
                if cfg is not None and not cfg.get("enabled", True):
                    return self._json(200, {"ok": False, "reason": "disabled"})
                ok = ENGINE.emit(axis, pos, speed, cfg=cfg)
                return self._json(200, {"ok": ok, "pos": round(ENGINE.clamp(pos), 4)})

            if path == "/api/preset/run":
                ENGINE.clear_estop()          # 用户主动操作：自动解除急停
                store = load_store()
                presets = store["groups"][store["active"]]
                idx = int(data.get("index", -1))
                if idx < 0 or idx >= len(presets):
                    raise ValueError("预设序号超出范围")
                axis = str(presets[idx].get("axis", "L0")).upper()
                cfg = CALIB["axes"].get(axis)
                if cfg is None:
                    raise ValueError("这条预设用的轴 %s 不在当前设备型号里（%s），请先到设备校准里添加或改用别的轴"
                                     % (axis, " / ".join(CALIB["order"])))
                if not cfg.get("enabled", True):
                    raise ValueError("这条预设用的轴 %s 是「未启用」状态，请到设备校准里勾选启用" % axis)
                return self._json(200, {"ok": True, "preset": ENGINE.run_preset(presets[idx], index=idx)})

            if path == "/api/sequence/run":
                ENGINE.clear_estop()          # 用户主动操作：自动解除急停
                store = load_store()
                name = data.get("group") or store["active"]
                presets = store["groups"].get(name)
                if not presets:
                    raise ValueError("没有这个分组")
                usable = []
                skipped = []
                for p in presets:
                    axis = str(p.get("axis", "L0")).upper()
                    cfg = CALIB["axes"].get(axis)
                    if cfg is None or not cfg.get("enabled", True):
                        skipped.append(p.get("name") or axis)
                    else:
                        usable.append(p)
                if not usable:
                    raise ValueError("这一组的轴都没启用（%s），请先到设备校准里勾选"
                                     % " / ".join(CALIB["order"]))
                info = ENGINE.run_sequence(usable)
                info["skipped"] = skipped
                return self._json(200, {"ok": True, "sequence": info})

            # ---- Funscript ----
            if path == "/api/play":
                # 一次性动作：给外部插件（如酒馆插件）直接下发一段运动
                preset = {
                    "name": str(data.get("name") or "外部指令")[:40],
                    "shape": data.get("shape", "sine"),
                    "axis": data.get("axis", "L0"),
                    "low": data.get("low", 0.3),
                    "high": data.get("high", 0.7),
                    "hz": data.get("hz", 0.5),
                    "secs": data.get("secs", 20),
                    "speed": data.get("speed", 4000),
                }
                return self._json(200, {"ok": True, "preset": ENGINE.run_preset(preset)})

            if path == "/api/funscript/add":
                info = ENGINE.add_script(data.get("name", "script.funscript"),
                                         data.get("axis", "L0"), data.get("text", ""))
                return self._json(200, {"ok": True, "script": info})

            if path == "/api/funscript/clear":
                ENGINE.clear_scripts()
                return self._json(200, {"ok": True})

            if path == "/api/funscript/play":
                ENGINE.clear_estop()          # 用户主动操作：自动解除急停
                ENGINE.play_scripts(data.get("speed", 1.0), data.get("loop", False),
                                    data.get("start"))
                return self._json(200, {"ok": True})

            if path == "/api/funscript/pause":
                ENGINE.pause_scripts()
                return self._json(200, {"ok": True})

            if path == "/api/funscript/seek":
                return self._json(200, {"ok": True, "time": ENGINE.seek(data.get("t", 0))})

            if path == "/api/shutdown":
                ENGINE.stop(hard=False)
                ENGINE.device.close()
                threading.Timer(0.3, lambda: os._exit(0)).start()
                return self._json(200, {"ok": True})

            return self._json(404, {"ok": False, "error": "未知接口"})
        except Exception as exc:
            try:
                print("[api] POST %s -> 500 %s" % (path, str(exc)[:80]), flush=True)
            except Exception:
                pass
            return self._json(500, {"ok": False, "error": str(exc)})


def main():
    global LAN_HOST
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0",
                    help="绑定地址；0.0.0.0 表示允许同 WiFi 的手机访问")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    LAN_HOST = args.host

    print("=" * 60)
    print(" OSR2 / SR6 中文控制器 v2")
    print(" 本机访问: http://127.0.0.1:%d" % args.port)
    if args.host == "0.0.0.0":
        print(" 手机访问: http://%s:%d   （同一 WiFi，防火墙放行后可用）" % (lan_ip(), args.port))
        print(" 注意：同一网络内任何人都能控制设备，请只在可信网络使用")
    else:
        print(" 只允许本机访问（要手机控制请加 --host 0.0.0.0）")
    print(" 关闭本窗口即停止（会先发 DSTOP）")
    print("=" * 60, flush=True)

    if not args.no_browser and args.host != "0.0.0.0":
        def _open():
            time.sleep(1.2)
            try:
                import webbrowser
                webbrowser.open("http://127.0.0.1:%d" % args.port)
            except Exception:
                pass
        threading.Thread(target=_open, daemon=True).start()

    # 启动后自动连一次 TCode 桥（只试桥，不动串口，避免 Arduino 复位）
    def _auto_connect():
        time.sleep(1.5)
        if ENGINE.device.kind is None:
            ok, detail = ENGINE.device.connect(prefer="bridge")
            print("[auto] 自动连接 %s: %s" % ("成功" if ok else "失败", detail), flush=True)
    threading.Thread(target=_auto_connect, daemon=True).start()

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        ENGINE.stop(hard=False)
        ENGINE.device.close()


if __name__ == "__main__":
    main()
