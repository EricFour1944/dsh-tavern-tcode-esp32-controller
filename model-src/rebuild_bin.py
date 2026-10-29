"""把 model-src/parts/*.obj 重新打包成 static/device-osr2.bin。

用途：你在 Blender 里改了网格（不只是挪位置）时，覆盖 parts 里对应的 obj 后跑这个。
部件顺序固定为 PARTS 列表；缺少某个文件会直接报错，避免打歪模型。
"""
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PARTS_DIR = os.path.join(HERE, 'parts')
BIN_PATH = os.path.join(os.path.dirname(HERE), 'static', 'device-osr2.bin')

PARTS = ['base', 'receiver', 'lid', 'pitcher', 'pitcherArm', 'pitcherLinkArm',
         'arm', 'modCase', 'bearing', 'joint']


def parse_obj(path):
    verts, norms = [], []
    tris = []
    with open(path, 'r', encoding='utf-8', errors='ignore') as f:
        for line in f:
            if not line:
                continue
            if line.startswith('v '):
                p = line.split()
                verts.append((float(p[1]), float(p[2]), float(p[3])))
            elif line.startswith('vn '):
                p = line.split()
                norms.append((float(p[1]), float(p[2]), float(p[3])))
            elif line.startswith('f '):
                toks = line.split()[1:]
                idx = []
                for t in toks:
                    parts = t.split('/')
                    vi = int(parts[0])
                    ni = int(parts[2]) if len(parts) > 2 and parts[2] else 0
                    idx.append((vi - 1, ni - 1 if ni else -1))
                for i in range(1, len(idx) - 1):
                    tris.append((idx[0], idx[i], idx[i + 1]))
    # 展开成「顶点 + 法线」独立索引
    key2i = {}
    out_v, out_n, out_i = [], [], []
    for tri in tris:
        for vn in tri:
            k = vn
            if k not in key2i:
                key2i[k] = len(out_v) // 3
                v = verts[vn[0]]
                out_v.extend(v)
                n = norms[vn[1]] if vn[1] >= 0 and vn[1] < len(norms) else (0.0, 0.0, 1.0)
                out_n.extend(n)
            out_i.append(key2i[k])
    if len(out_v) // 3 > 65535:
        raise SystemExit('%s 顶点数 %d 超过 65535，当前引擎用 Uint16 索引' % (path, len(out_v) // 3))
    return out_v, out_n, out_i


def main():
    if not os.path.isdir(PARTS_DIR):
        raise SystemExit('找不到 parts 目录：' + PARTS_DIR)
    chunks = [struct.pack('<8sI', b'OSR2MOD1', len(PARTS))]
    total_v = total_t = 0
    for name in PARTS:
        path = os.path.join(PARTS_DIR, name + '.obj')
        if not os.path.isfile(path):
            raise SystemExit('缺少 %s（部件顺序固定，不能少）' % path)
        v, n, i = parse_obj(path)
        nb = name.encode('utf-8')
        chunks.append(struct.pack('<I', len(nb)) + nb)
        chunks.append(struct.pack('<II', len(v) // 3, len(i)))
        chunks.append(struct.pack('<%df' % len(v), *v))
        chunks.append(struct.pack('<%df' % len(n), *n))
        chunks.append(struct.pack('<%dI' % len(i), *i))
        total_v += len(v) // 3
        total_t += len(i) // 3
        print('%-16s v=%-6d tri=%d' % (name, len(v) // 3, len(i) // 3))

    os.makedirs(os.path.dirname(BIN_PATH), exist_ok=True)
    with open(BIN_PATH, 'wb') as f:
        for c in chunks:
            f.write(c)
    size = os.path.getsize(BIN_PATH)
    print('已写出 %s（%.2f MB，顶点 %d，三角 %d）' % (BIN_PATH, size / 1048576.0, total_v, total_t))
    print('浏览器 Ctrl+F5 生效。')


main()
