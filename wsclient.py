# -*- coding: utf-8 -*-
"""极简 WebSocket 客户端（纯标准库，无第三方依赖）。

用途：连 TCode ESP32 固件的 ws://<ip>/ws，直接发送 TCode 文本行。
只实现本项目需要的部分：文本帧发送、帧读取（含 ping/pong/close）。
"""
from __future__ import annotations

import base64
import hashlib
import os
import socket
import struct
import threading
import time


class WSClient:
    def __init__(self, host, port=80, path="/ws", timeout=5.0):
        self.host = host
        self.port = port
        self.path = path
        self.sock = None
        self.lock = threading.Lock()
        self.alive = False
        self.on_text = None          # 收到文本帧的回调
        self._rx_thread = None
        self._buf = b""

    # ---------- 握手 ----------
    def connect(self):
        self.close()
        sock = socket.create_connection((self.host, self.port), timeout=5.0)
        sock.settimeout(0.5)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            "GET %s HTTP/1.1\r\n"
            "Host: %s:%d\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "Origin: http://%s\r\n"
            "\r\n" % (self.path, self.host, self.port, key, self.host)
        )
        sock.sendall(req.encode())
        resp = b""
        deadline = time.time() + 5
        while b"\r\n\r\n" not in resp and time.time() < deadline:
            try:
                chunk = sock.recv(1024)
            except socket.timeout:
                continue
            if not chunk:
                break
            resp += chunk
        if b"101" not in resp.split(b"\r\n", 1)[0]:
            sock.close()
            raise RuntimeError("WebSocket 握手失败：%r" % resp[:120])
        try:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 8192)
        except Exception:
            pass
        self.sock = sock
        self.alive = True
        self._rx_thread = threading.Thread(target=self._rx_loop, daemon=True)
        self._rx_thread.start()
        return True

    # ---------- 发送 ----------
    def send_text(self, text: str):
        data = text.encode("utf-8")
        header = bytearray()
        header.append(0x81)                      # FIN + text
        length = len(data)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", length)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        with self.lock:
            if not self.sock:
                raise RuntimeError("未连接")
            self.sock.sendall(bytes(header) + masked)

    # ---------- 接收 ----------
    def _recv_exact(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("连接已关闭")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _rx_loop(self):
        try:
            while self.alive:
                try:
                    b1, b2 = self._recv_exact(2)
                except socket.timeout:
                    continue
                opcode = b1 & 0x0F
                masked = b2 & 0x80
                length = b2 & 0x7F
                if length == 126:
                    length = struct.unpack(">H", self._recv_exact(2))[0]
                elif length == 127:
                    length = struct.unpack(">Q", self._recv_exact(8))[0]
                mask = self._recv_exact(4) if masked else None
                payload = self._recv_exact(length) if length else b""
                if mask:
                    payload = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))
                if opcode == 0x8:                 # close
                    break
                if opcode == 0x9:                 # ping -> pong
                    with self.lock:
                        self.sock.sendall(bytes([0x8A, 0x80]) + os.urandom(4))
                    continue
                if opcode in (0x1, 0x0) and self.on_text:
                    try:
                        self.on_text(payload.decode("utf-8", "replace"))
                    except Exception:
                        pass
        except Exception:
            pass
        finally:
            self.alive = False

    def close(self):
        self.alive = False
        sock, self.sock = self.sock, None
        if sock:
            try:
                sock.close()
            except Exception:
                pass
