/* 原版 OSR2 建模的本地预览引擎
 * 网格来自 ayva 打包文件里的 Blender OBJ（已转成 static/device-osr2.bin），
 * 运动学按原版 OSR2 模型代码逐步移植（双伺服臂 + 俯仰 + 连杆），
 * 相机 / 灯光 / 材质参数同样取自原版，用 WebGL 直接绘制，不依赖外部库。
 */
(function (global) {
  'use strict';

  // ---------------- 数学 ----------------
  const TAU = Math.PI * 2;
  const deg2rad = (d) => (d * Math.PI) / 180;

  function v3(x, y, z) { return [x || 0, y || 0, z || 0]; }
  function vAdd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function vSub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function vScale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function vDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function vCross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function vLen(a) { return Math.hypot(a[0], a[1], a[2]); }
  function vNorm(a) { const l = vLen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function vLerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function vApplyQuat(v, q) {
    const [x, y, z, w] = q;
    const ix = w * v[0] + y * v[2] - z * v[1];
    const iy = w * v[1] + z * v[0] - x * v[2];
    const iz = w * v[2] + x * v[1] - y * v[0];
    const iw = -x * v[0] - y * v[1] - z * v[2];
    return [
      ix * w + iw * -x + iy * -z - iz * -y,
      iy * w + iw * -y + iz * -x - ix * -z,
      iz * w + iw * -z + ix * -y - iy * -x,
    ];
  }
  function vApplyAxisAngle(v, axis, angle) { return vApplyQuat(v, quatAxisAngle(axis, angle)); }

  function quatAxisAngle(axis, angle) {
    const a = vNorm(axis), h = angle / 2, s = Math.sin(h);
    return [a[0] * s, a[1] * s, a[2] * s, Math.cos(h)];
  }
  function quatMul(a, b) {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
  }
  function quatFromEulerXYZ(x, y, z) {
    const cx = Math.cos(x / 2), sx = Math.sin(x / 2);
    const cy = Math.cos(y / 2), sy = Math.sin(y / 2);
    const cz = Math.cos(z / 2), sz = Math.sin(z / 2);
    return [
      sx * cy * cz + cx * sy * sz,
      cx * sy * cz - sx * cy * sz,
      cx * cy * sz + sx * sy * cz,
      cx * cy * cz - sx * sy * sz,
    ];
  }
  // three.js 的 Object3D.lookAt 等价实现。
  // 原版部件挂在被旋转 −90°(绕 X) 的 group 里，lookAt 的 up 是"世界 (0,0,1)"，
  // 换算到设备空间就是 (0,-1,0)；退化（up 与视线平行）时 three 会给 z 加 0.0001 微扰。
  const LOOK_UP_LOCAL = [0, -1, 0];
  function quatLookAt(dir, up) {
    up = up || LOOK_UP_LOCAL;
    let z = vNorm(dir);
    if (vLen(z) < 1e-6) z = [0, 0, 1];
    let x = vCross(up, z);
    if (vLen(x) < 1e-6) {
      z = [z[0] + 0.0001, z[1], z[2]];
      z = vNorm(z);
      x = vCross(up, z);
    }
    x = vNorm(x);
    const y = vCross(z, x);
    // 基矩阵 [x y z] → 四元数
    const m00 = x[0], m01 = y[0], m02 = z[0];
    const m10 = x[1], m11 = y[1], m12 = z[1];
    const m20 = x[2], m21 = y[2], m22 = z[2];
    const tr = m00 + m11 + m22;
    if (tr > 0) {
      const s = Math.sqrt(tr + 1) * 2;
      return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
    }
    if (m00 > m11 && m00 > m22) {
      const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
      return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
    }
    if (m11 > m22) {
      const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
      return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
    }
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  function quatToMat4(q, out) {
    const [x, y, z, w] = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    out[0] = 1 - (yy + zz); out[1] = xy + wz; out[2] = xz - wy; out[3] = 0;
    out[4] = xy - wz; out[5] = 1 - (xx + zz); out[6] = yz + wx; out[7] = 0;
    out[8] = xz + wy; out[9] = yz - wx; out[10] = 1 - (xx + yy); out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
    return out;
  }
  function mat4Identity(m) {
    m[0] = 1; m[1] = 0; m[2] = 0; m[3] = 0;
    m[4] = 0; m[5] = 1; m[6] = 0; m[7] = 0;
    m[8] = 0; m[9] = 0; m[10] = 1; m[11] = 0;
    m[12] = 0; m[13] = 0; m[14] = 0; m[15] = 1;
    return m;
  }
  function mat4Mul(a, b, out) {
    for (let i = 0; i < 4; i++) {
      const ai0 = a[i], ai1 = a[i + 4], ai2 = a[i + 8], ai3 = a[i + 12];
      out[i] = ai0 * b[0] + ai1 * b[1] + ai2 * b[2] + ai3 * b[3];
      out[i + 4] = ai0 * b[4] + ai1 * b[5] + ai2 * b[6] + ai3 * b[7];
      out[i + 8] = ai0 * b[8] + ai1 * b[9] + ai2 * b[10] + ai3 * b[11];
      out[i + 12] = ai0 * b[12] + ai1 * b[13] + ai2 * b[14] + ai3 * b[15];
    }
    return out;
  }
  function mat4Perspective(fovy, aspect, near, far, out) {
    const f = 1 / Math.tan(fovy / 2);
    out.fill(0);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) / (near - far);
    out[11] = -1;
    out[14] = (2 * far * near) / (near - far);
    return out;
  }
  function mat4LookAt(eye, target, up, out) {
    const z = vNorm(vSub(eye, target));
    let x = vCross(up, z);
    if (vLen(x) < 1e-6) x = vCross([0, 1, 0], z);
    x = vNorm(x);
    const y = vCross(z, x);
    out[0] = x[0]; out[1] = y[0]; out[2] = z[0]; out[3] = 0;
    out[4] = x[1]; out[5] = y[1]; out[6] = z[1]; out[7] = 0;
    out[8] = x[2]; out[9] = y[2]; out[10] = z[2]; out[11] = 0;
    out[12] = -vDot(x, eye); out[13] = -vDot(y, eye); out[14] = -vDot(z, eye); out[15] = 1;
    return out;
  }
  function mat4Translate(m, t) {
    m[12] += m[0] * t[0] + m[4] * t[1] + m[8] * t[2];
    m[13] += m[1] * t[0] + m[5] * t[1] + m[9] * t[2];
    m[14] += m[2] * t[0] + m[6] * t[1] + m[10] * t[2];
    return m;
  }

  // ---------------- 原版辅助函数 ----------------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // Do(v, inMin, inMax, outMin, outMax) —— 原版是线性映射（不夹紧）
  function Do(v, inMin, inMax, outMin, outMax) {
    if (outMin === undefined) outMin = 0;
    if (outMax === undefined) outMax = 1;
    return ((v - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;
  }
  function No(servo, dir) {
    if (dir === undefined) dir = 1;
    return Do(servo, 0, 65535, deg2rad(-180 * dir), deg2rad(180 * dir));
  }
  // Ro：圆（球）与直线求交（原版 IK）
  // 求「到 A 点 rA、到圆心 rC」的交点：返回连线上的垂足与半弦长
  function Po(ptA, distToA, center, radius) {
    const dv = vSub(center, ptA);
    const dist = vLen(dv);
    if (dist === 0) return null;
    if (distToA + radius < dist || Math.abs(distToA - radius) > dist) return null;
    const u = vScale(dv, 1 / dist);
    const a = (distToA * distToA - radius * radius + dist * dist) / (2 * dist);
    const h2 = distToA * distToA - a * a;
    return { center: vAdd(ptA, vScale(u, a)), radius: h2 > 0 ? Math.sqrt(h2) : 0 };
  }
  function Ro(center, radius, axis, point, length) {
    const n = vNorm(axis);
    const s = vDot(n, vSub(center, point));
    if (Math.abs(s) > length) return null;
    const proj = vAdd(vScale(n, s), point);
    if (Math.abs(s) === length) return (vLen(vSub(proj, center)) === radius) ? [proj] : null;
    const hn = Math.sqrt(Math.max(0, length * length - s * s));
    const inter = Po(proj, hn, center, radius);
    if (!inter) return null;
    const { center: c, radius: rr } = inter;
    if (rr === 0) return [c];
    const perp = vNorm(vCross(vSub(proj, center), n));
    if (!Number.isFinite(perp[0])) return [c];
    return [vSub(c, vScale(perp, rr)), vAdd(c, vScale(perp, rr))];
  }
  function Co(a, b, c) {
    const i = vDot(vCross(c, a), b);
    return i > 0 ? 1 : i < 0 ? -1 : 0;
  }
  const vMul = vScale;

  // ---------------- 模型：部件表 ----------------
  const REST = {
    base: { pos: v3(0, 0, 0), lock: 'static' },
    lid: { pos: v3(0, 0, 0), lock: 'static' },
    pitcher: { pos: v3(0, 0, 0), lock: 'static' },
    pitcherArm: { pos: v3(77, 5, 17) },
    leftArm: { pos: v3(70, 5, 16.5), mesh: 'arm' },
    rightArm: { pos: v3(-70, 5, 16.5), mesh: 'arm' },
    pitcherLinkArm: { pos: v3(0, 0, 0) },
    linkStartBearing: { pos: v3(0, 0, 0), mesh: 'bearing' },
    linkEndBearing: { pos: v3(0, 0, 0), mesh: 'bearing' },
    leftBearing: { pos: v3(0, 0, 0), mesh: 'bearing' },
    rightBearing: { pos: v3(0, 0, 0), mesh: 'bearing' },
    leftJoint: { pos: v3(0, 0, 0), mesh: 'joint' },
    rightJoint: { pos: v3(0, 0, 0), mesh: 'joint' },
    linkJoint: { pos: v3(0, 0, 0), mesh: 'joint' },
    receiver: { pos: v3(0, 0, 0), mesh: 'receiver' },
    modCase: { pos: v3(0, 0, 0), mesh: 'modCase' },
  };

  // 原版只有 +x 侧有整套俯仰/连杆机构；为了让两边看起来对称，镜像到 −x 侧
const MIRROR_KEYS = ['pitcherArm', 'pitcherLinkArm', 'linkStartBearing', 'linkEndBearing', 'linkJoint'];

// 原版相机 / 灯光 / 整机朝向
  const CAM = {
    fov: deg2rad(50), near: 0.1, far: 1000,
    eye: v3(245.03116537126925, 427.3026288938325, 190.74318476308787),
    target: v3(-36.81235747311321, 6.186822929643268, 15.874049352801714),
    up: v3(0, 0, 1),
  };
  const MODEL_ROT_X = -Math.PI / 2;   // 原版 group.rotation.x
  const LIGHTS = [
    { dir: vNorm(v3(200, 180, 50)), color: [1, 1, 1], intensity: 0.75 },
    { dir: vNorm(v3(-225, 225, 225)), color: [1, 1, 1], intensity: 1.0 },
    { dir: vNorm(v3(70, -100, 200)), color: [1, 1, 1], intensity: 1.0 },
  ];
  const AMBIENT = 0.625;

  // ---------------- WebGL ----------------
  const VS = `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uMVP;
uniform mat4 uModel;
uniform mat3 uNormalMat;
varying vec3 vN;
varying vec3 vPos;
void main() {
  vN = normalize(uNormalMat * aNormal);
  vec4 wp = uModel * vec4(aPos, 1.0);
  vPos = wp.xyz;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

  const FS = `
precision highp float;
varying vec3 vN;
varying vec3 vPos;
uniform vec3 uAlbedo;
uniform float uMetal;
uniform float uRough;
uniform vec3 uLightDir[3];
uniform vec3 uLightColor[3];
uniform float uLightPow[3];
uniform float uAmbient;
uniform vec3 uEye;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(uEye - vPos);
  vec3 col = uAlbedo * (uAmbient);
  for (int i = 0; i < 3; i++) {
    vec3 L = normalize(uLightDir[i]);
    float diff = max(dot(N, L), 0.0);
    col += uAlbedo * uLightColor[i] * uLightPow[i] * diff;
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), mix(8.0, 90.0, 1.0 - uRough));
    col += uLightColor[i] * uLightPow[i] * spec * uMetal * 0.9;
  }
  col = clamp(col, 0.0, 1.0);
  gl_FragColor = vec4(col, 1.0);
}`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  const Device3D = {
    ready: false,
    error: null,
    parts: [],
    canvas: null,
    gl: null,
    prog: null,
    uni: {},
    view: new Float32Array(16),
    proj: new Float32Array(16),
    model: new Float32Array(16),
    pos: { L0: 0.5, R1: 0.5, R2: 0.5, R0: 0.5 },

    async init(canvas, binUrl) {
      this.canvas = canvas;
      try {
        const gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false });
        if (!gl) throw new Error('这个浏览器不支持 WebGL');
        this.gl = gl;
        // 带版本号取模型：浏览器可能缓存住早期的空响应，必要时用时间戳重试
        let buf = await this.fetchBin(binUrl + '?v=1');
        if (!buf || buf.byteLength < 1024) buf = await this.fetchBin(binUrl + '?t=' + Date.now());
        if (!buf || buf.byteLength < 1024) throw new Error('模型文件没有取到（服务器返回空）');
        this.loadParts(buf);
        this.buildProgram();
        this.fitCamera();
        // 读取 Blender 调出来的偏移表（没有或为空都不影响）
        this.offsets = {};
        try {
          const res = await fetch('/static/model-offsets.json?v=' + Date.now(), { cache: 'no-store' });
          if (res.ok) {
            const j = await res.json();
            if (j && j.offsets) this.offsets = j.offsets;
          }
        } catch (e) { }
        this.ready = true;
        return true;
      } catch (e) {
        this.error = e && e.message || String(e);
        return false;
      }
    },

    async fetchBin(url) {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.arrayBuffer();
    },

    loadParts(arrayBuffer) {
      const gl = this.gl;
      const dv = new DataView(arrayBuffer);
      const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
      if (magic !== 'OSR2') throw new Error('模型文件损坏');
      const count = dv.getUint32(8, true);
      let off = 12;
      const dec = new TextDecoder('utf-8');
      const meshes = {};
      for (let k = 0; k < count; k++) {
        const nameLen = dv.getUint32(off, true); off += 4;
        const name = dec.decode(new Uint8Array(arrayBuffer, off, nameLen)); off += nameLen;
        const vtxCount = dv.getUint32(off, true); off += 4;
        const idxCount = dv.getUint32(off, true); off += 4;
        const posBytes = vtxCount * 3 * 4, nrmBytes = vtxCount * 3 * 4, idxBytes = idxCount * 4;
        const pos = new Float32Array(arrayBuffer.slice(off, off + posBytes)); off += posBytes;
        const nrm = new Float32Array(arrayBuffer.slice(off, off + nrmBytes)); off += nrmBytes;
        const idx32 = new Uint32Array(arrayBuffer.slice(off, off + idxBytes)); off += idxBytes;
        const idx = new Uint16Array(idx32.length);
        for (let i = 0; i < idx32.length; i++) idx[i] = idx32[i];

        const vb = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vb);
        gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
        const nb = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, nb);
        gl.bufferData(gl.ARRAY_BUFFER, nrm, gl.STATIC_DRAW);
        const ib = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
        let bmin = [1e9, 1e9, 1e9], bmax = [-1e9, -1e9, -1e9];
        for (let i = 0; i < pos.length; i += 3) {
          for (let a = 0; a < 3; a++) {
            const v = pos[i + a];
            if (v < bmin[a]) bmin[a] = v;
            if (v > bmax[a]) bmax[a] = v;
          }
        }
        meshes[name] = { vb, nb, ib, count: idx.length, bmin, bmax };
      }
      this.meshes = meshes;
    },

    buildProgram() {
      const gl = this.gl;
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      this.prog = prog;
      this.uni = {
        aPos: gl.getAttribLocation(prog, 'aPos'),
        aNormal: gl.getAttribLocation(prog, 'aNormal'),
        uMVP: gl.getUniformLocation(prog, 'uMVP'),
        uModel: gl.getUniformLocation(prog, 'uModel'),
        uNormalMat: gl.getUniformLocation(prog, 'uNormalMat'),
        uAlbedo: gl.getUniformLocation(prog, 'uAlbedo'),
        uMetal: gl.getUniformLocation(prog, 'uMetal'),
        uRough: gl.getUniformLocation(prog, 'uRough'),
        uLightDir: gl.getUniformLocation(prog, 'uLightDir'),
        uLightColor: gl.getUniformLocation(prog, 'uLightColor'),
        uLightPow: gl.getUniformLocation(prog, 'uLightPow'),
        uAmbient: gl.getUniformLocation(prog, 'uAmbient'),
        uEye: gl.getUniformLocation(prog, 'uEye'),
      };
      const dirs = new Float32Array(9), cols = new Float32Array(9), pows = new Float32Array(3);
      LIGHTS.forEach((l, i) => {
        dirs[i * 3] = l.dir[0]; dirs[i * 3 + 1] = l.dir[1]; dirs[i * 3 + 2] = l.dir[2];
        cols[i * 3] = l.color[0]; cols[i * 3 + 1] = l.color[1]; cols[i * 3 + 2] = l.color[2];
        pows[i] = l.intensity;
      });
      gl.uniform3fv(this.uni.uLightDir, dirs);
      gl.uniform3fv(this.uni.uLightColor, cols);
      gl.uniform1fv(this.uni.uLightPow, pows);
      gl.uniform1f(this.uni.uAmbient, AMBIENT);
      gl.uniform3f(this.uni.uEye, CAM.eye[0], CAM.eye[1], CAM.eye[2]);
      this.lightUtils = { dirs, cols, pows };
    },

    // ---------------- 运动学（移植自原版 OSR2 preRender） ----------------
    partsState: {
      base: { pos: [0, 0, 0], rot: [0, 0, 0], quat: [0, 0, 0, 1] },
      lid: { pos: [0, 0, 0], rot: [0, 0, 0], quat: [0, 0, 0, 1] },
      pitcher: { pos: [0, 0, 0], rot: [0, 0, 0], quat: [0, 0, 0, 1] },
      leftArm: { pos: [70, 5, 16.5], rot: [0, 0, 0], quat: [0, 0, 0, 1] },
      rightArm: { pos: [-70, 5, 16.5], rot: [0, 0, 0], quat: [0, 0, 0, 1] },
      pitcherArm: { pos: [77, 5, 17], rot: [0, 0, 0], quat: [0, 0, 0, 1] },
      pitcherLinkArm: { pos: [0, 0, 0], rot: [0, 0, 0], quat: [0, 0, 0, 1] },
      linkStartBearing: { pos: [0, 0, 0], rot: [0, 0, 0], quat: [0, 0, 0, 1] },
      linkEndBearing: { pos: [0, 0, 0], rot: [0, 0, 0], quat: [0, 0, 0, 1] },
      leftBearing: { pos: [0, 0, 0], rot: [0, 0, 0], quat: [0, 0, 0, 1] },
      rightBearing: { pos: [0, 0, 0], rot: [0, 0, 0], quat: [0, 0, 0, 1] },
      leftJoint: { pos: [0, 0, 0], rot: [0, 0, 0], quat: [0, 0, 0, 1] },
      rightJoint: { pos: [0, 0, 0], rot: [0, 0, 0], quat: [0, 0, 0, 1] },
      linkJoint: { pos: [0, 0, 0], rot: [0, 0, 0], quat: [0, 0, 0, 1] },
      receiver: { pos: [0, 0, 0], rot: [0, 0, 0], quat: [0, 0, 0, 1] },
      modCase: { pos: [0, 0, 0], rot: [0, 0, 0], quat: [0, 0, 0, 1] },
    },

    preRender(p) {
      const st = this.partsState;
      const R0 = p.R0 === undefined ? 0.5 : p.R0;

      // 1) 伺服角换算（原样移植）
      // 注意：原版 −350*e0 里的 e0 是「轴缩放系数」（恒为 1），把 L0 本身写进去会算成二次曲线
      const o0 = Do(p.L0, 0, 0.9999, -350, 350);
      const s0 = Do(p.R1, 0, 0.9999, -132, 132);
      const a0 = Do(p.R2, 0, 0.9999, -350, 350);
      const F = 1515.105, L = 1e6 / 330;
      const v0 = Do(F + o0 + s0, 0, L, 0, 65535);
      const c0 = Do(F - o0 + s0, 0, L, 0, 65535);
      const d0 = Do(F - a0, 0, L, 0, 65535);
      const leftServo = No(v0, 1);
      const rightServo = No(c0, -1);
      const pitcherServo = No(d0, -1);
      const armBend = deg2rad(Do(Math.abs(s0), 0, 132, 0, 4));

      // 2) 手臂 / 俯仰
      st.leftArm.rot = [leftServo, -armBend, Math.PI];
      st.rightArm.rot = [rightServo, armBend, 0];
      st.pitcherArm.rot = [pitcherServo, 0, 0];

      // 3) 轴承位置：绕 Y 偏转 → 绕 X 跟随手臂 → 加上手臂位置
      const placeBearing = (target, arm, dx, bend) => {
        let v = target.slice();
        v[0] += dx;
        v = vApplyAxisAngle(v, [0, 1, 0], bend);
        v = vApplyAxisAngle(v, [1, 0, 0], arm.rot[0]);
        return vAdd(v, arm.pos);
      };
      let i0 = [0, 0, 140];
      let r0 = [0, 0, 140];
      st.leftBearing.pos = placeBearing(i0, st.leftArm, -3.5, -armBend);
      i0 = st.leftBearing.pos;
      st.rightBearing.pos = placeBearing(r0, st.rightArm, 3.5, armBend);
      r0 = st.rightBearing.pos;
      st.leftBearing.rot = [st.leftArm.rot[0], st.leftArm.rot[1], 0];
      st.rightBearing.rot = [st.rightArm.rot[0], st.rightArm.rot[1], 0];

      st.leftJoint.pos = st.leftBearing.pos.slice();
      st.rightJoint.pos = st.rightBearing.pos.slice();

      // 4) 俯仰连杆
      const linkLocal = vApplyAxisAngle([-3, -40, 0], [1, 0, 0], pitcherServo);
      st.pitcherLinkArm.pos = vAdd(linkLocal, st.pitcherArm.pos);
      st.linkStartBearing.pos = st.pitcherLinkArm.pos.slice();

      // 5) 接收器在中点
      const mid = vLerp(i0, r0, 0.5);
      st.receiver.pos = mid.slice();

      // 6) 连杆 IK
      const S0 = vNorm(vSub(r0, i0));
      const inter = Ro(i0, 40, S0, st.linkStartBearing.pos, 140);
      let solved = false;
      // 解出来的点如果离接收器太远（退化姿态），用连杆末端位置兜底，别让它飞到空中
      let cand = null;
      if (inter) {
        const t0 = (inter.length === 1 || inter[0][1] < inter[1][1]) ? inter[0] : inter[1];
        if (vLen(vSub(t0, mid)) < 210) cand = t0;
      }
      if (!cand) {
        const dir = vNorm(vSub(mid, st.pitcherLinkArm.pos));
        cand = vAdd(st.pitcherLinkArm.pos, vScale(dir, 110));
      }
      {
        const F0 = cand;
        st.linkEndBearing.pos = F0.slice();
        const tgt1 = vSub(vAdd(F0, F0), st.linkStartBearing.pos);
        st.linkEndBearing.quat = quatLookAt(vSub(tgt1, F0));
        const tgt2 = vSub(vAdd(st.linkStartBearing.pos, st.linkStartBearing.pos), F0);
        st.linkStartBearing.quat = quatLookAt(vSub(tgt2, st.linkStartBearing.pos));
        st.pitcherLinkArm.quat = quatLookAt(vSub(F0, st.pitcherLinkArm.pos));
        solved = true;
      }
      st.linkJoint.pos = st.linkEndBearing.pos.slice();

      // 俯仰连杆链按原版界面应该在「外壳那一侧」。我们的 +x 侧正好在画面右边，
      // 所以整条链沿 x 镜像到 −x（位置 x 取反、四元数 y/z 分量取反），不新增副本。
      for (const k of ['pitcherArm', 'pitcherLinkArm', 'linkStartBearing', 'linkEndBearing', 'linkJoint']) {
        const s = st[k];
        if (!s) continue;
        if (this.linkSide === -1) {
          s.dpos = [-s.pos[0], s.pos[1], s.pos[2]];
          const q = s.quat || quatFromEulerXYZ(s.rot[0], s.rot[1], s.rot[2]);
          s.dquat = [q[0], -q[1], -q[2], q[3]];
        } else {
          s.dpos = null; s.dquat = null;
        }
      }

      // 视觉修正：手臂网格 z 到 126、轴承在 140；连杆网格到 124、端头在 ~140，
      // 不拉伸的话轴承会"悬空"在杆子外面
      const ARM_TIP = 126, LINK_TIP = 124;
      st.leftArm.scaleZ = 140 / ARM_TIP;
      st.rightArm.scaleZ = 140 / ARM_TIP;
      const linkLen = Math.max(1, vLen(vSub(st.linkEndBearing.pos, st.pitcherLinkArm.pos)));
      st.pitcherLinkArm.scaleZ = Math.min(1.6, linkLen / LINK_TIP);

      // 7) 整机姿态（绕两臂连线旋转 + R0 扭转）
      const w0 = [-1, 0, 0];
      const I0 = vNorm(vCross(w0, S0));
      const ang = Math.acos(clamp(vDot(w0, S0), -1, 1));
      const D0 = quatAxisAngle(I0, ang);
      const M0 = vApplyQuat([0, -1, 0], D0);
      // 原版：O0 = linkEndBearing.position - leftBearing.position（不是左关节，之前抄错了）
      const O0 = vSub(st.linkEndBearing.pos, st.leftBearing.pos);
      const j0 = Co(M0, O0, vApplyQuat([1, 0, 0], D0));
      const q0 = Math.acos(clamp(vDot(vNorm(O0), M0), -1, 1)) * j0;
      const s1 = quatAxisAngle([1, 0, 0], q0);
      // 同上：240/120 的系数是缩放（=1），R0 是轴位置
      const l1 = quatAxisAngle([0, -1, 0], R0 * deg2rad(240) - deg2rad(120));
      const t1 = quatMul(D0, s1);

      st.receiver.quat = t1;
      st.modCase.pos = mid.slice();
      st.modCase.quat = quatMul(t1, l1);
      st.leftJoint.quat = t1;
      st.rightJoint.quat = t1;
      this.ikSolved = solved;
    },

    // 按「中立姿态」下整机的包围球自动取景：方向沿用原版相机，距离按画布比例算
    fitCamera() {
      this.pos = { L0: 0.5, R1: 0.5, R2: 0.5, R0: 0.5 };
      this.preRender(this.pos);
      const rotX = new Float32Array(16);
      quatToMat4(quatAxisAngle([1, 0, 0], MODEL_ROT_X), rotX);
      const scratch = new Float32Array(16);
      const bmin = [1e9, 1e9, 1e9], bmax = [-1e9, -1e9, -1e9];
      const PARTS = [
        ['base', 'base'], ['lid', 'lid'], ['pitcher', 'pitcher'],
        ['leftArm', 'arm'], ['rightArm', 'arm'], ['pitcherArm', 'pitcherArm'],
        ['pitcherLinkArm', 'pitcherLinkArm'],
        ['leftBearing', 'bearing'], ['rightBearing', 'bearing'],
        ['linkStartBearing', 'bearing'], ['linkEndBearing', 'bearing'],
        ['leftJoint', 'joint'], ['rightJoint', 'joint'], ['linkJoint', 'joint'],
        ['receiver', 'receiver'], ['modCase', 'modCase'],
      ];
      for (const [key, meshName] of PARTS) {
        // 隐藏的网格与隐藏的零件都不参与取景，否则取景范围被看不见的东西撑大 → 模型偏小偏位
        if (this.hidden && this.hidden.indexOf(meshName) >= 0) continue;
        if (Array.isArray(this.hiddenParts) && this.hiddenParts.indexOf(key) >= 0) continue;
        const mesh = this.meshes[meshName];
        const st = this.partsState[key];
        if (!mesh || !st) continue;
        const q = st.quat && (st.quat[3] !== 1 || st.quat[0] || st.quat[1] || st.quat[2])
          ? st.quat : quatFromEulerXYZ(st.rot[0], st.rot[1], st.rot[2]);
        quatToMat4(q, scratch);
        mat4Translate(scratch, st.pos);
        mat4Mul(rotX, scratch, this.model);
        const m = this.model;
        for (let xi = 0; xi < 2; xi++) for (let yi = 0; yi < 2; yi++) for (let zi = 0; zi < 2; zi++) {
          const p = [
            xi ? mesh.bmax[0] : mesh.bmin[0],
            yi ? mesh.bmax[1] : mesh.bmin[1],
            zi ? mesh.bmax[2] : mesh.bmin[2],
          ];
          const w = [
            m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
            m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
            m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
          ];
          for (let a = 0; a < 3; a++) { bmin[a] = Math.min(bmin[a], w[a]); bmax[a] = Math.max(bmax[a], w[a]); }
        }
      }
      const center = [0, 1, 2].map((a) => (bmin[a] + bmax[a]) / 2);
      let R = 0;
      for (let a = 0; a < 3; a++) R = Math.max(R, (bmax[a] - bmin[a]) / 2);
      R = Math.hypot((bmax[0] - bmin[0]) / 2, (bmax[1] - bmin[1]) / 2, (bmax[2] - bmin[2]) / 2);
      const dir = vNorm(vSub(CAM.eye, CAM.target));
      const canvas = this.canvas;
      const aspect = Math.max(0.2, (canvas.clientWidth || 352) / Math.max(1, canvas.clientHeight || 352));
      const fovY = CAM.fov;
      const fovX = 2 * Math.atan(Math.tan(fovY / 2) * aspect);
      // 按包围球算「刚好装下」的距离，再按画布留白系数放大一点，避免贴边
      const fitFov = Math.min(fovY, fovX);
      const needFit = (R / Math.sin(fitFov / 2)) * (this.fitMargin || 1.06);

      // 相机基向量（右 / 上 / 前），后面用来把画面偏移换算回世界坐标
      const fwd = vNorm(vScale(dir, -1));                 // 视线方向（指向物体）
      const right = vNorm(vCross(fwd, CAM.up));
      const up2 = vNorm(vCross(right, fwd));

      // 目标占画面比例（按较小的那一维算），0.86 表示模型最多占 86%
      const wantCover = this.fitCover || 0.86;
      const wantR = Math.max(wantCover, Math.min(1, (2 * R * aspect) / (R * 3.2)));
      let dist = needFit;
      let target = center.slice();

      // 两遍求解：先按投影后的真实包围盒把画面撑到 wantCover，再把中心挪到画布中心
      for (let pass = 0; pass < 2; pass++) {
        const eye = vAdd(target, vScale(dir, dist));
        mat4LookAt(eye, target, CAM.up, this.view);
        mat4Perspective(CAM.fov, aspect, CAM.near, CAM.far, this.proj);
        const W = canvas.clientWidth || 352, H = canvas.clientHeight || 352;
        let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
        for (let xi = 0; xi < 2; xi++) for (let yi = 0; yi < 2; yi++) for (let zi = 0; zi < 2; zi++) {
          const p = [xi ? bmax[0] : bmin[0], yi ? bmax[1] : bmin[1], zi ? bmax[2] : bmin[2], 1];
          const V = this.view, P = this.proj;
          const vx = V[0] * p[0] + V[4] * p[1] + V[8] * p[2] + V[12];
          const vy = V[1] * p[0] + V[5] * p[1] + V[9] * p[2] + V[13];
          const vz = V[2] * p[0] + V[6] * p[1] + V[10] * p[2] + V[14];
          const vw = V[3] * p[0] + V[7] * p[1] + V[11] * p[2] + V[15];
          const cx = P[0] * vx + P[4] * vy + P[8] * vz + P[12] * vw;
          const cy = P[1] * vx + P[5] * vy + P[9] * vz + P[13] * vw;
          const cw = P[3] * vx + P[7] * vy + P[11] * vz + P[15] * vw;
          if (Math.abs(cw) < 1e-6) continue;
          const sx = (cx / cw * 0.5 + 0.5) * W;
          const sy = (1 - (cy / cw * 0.5 + 0.5)) * H;
          minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
          minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
        }
        if (!(maxX > -1e8)) break;
        const coverX = (maxX - minX) / W, coverY = (maxY - minY) / H;
        const cover = Math.max(coverX, coverY);
        // ① 缩放：让可见包围盒达到 wantCover
        if (cover > 0.001) dist *= cover / wantCover;
        // ② 居中：把画面中心偏移换算成世界坐标，挪 target
        const halfH = Math.tan(CAM.fov / 2) * dist;
        const halfW = halfH * aspect;
        const dx = (((minX + maxX) / 2) / W - 0.5) * 2 * halfW;   // 屏幕右 = 相机 right
        const dy = ((0.5 - ((minY + maxY) / 2) / H)) * 2 * halfH;  // 屏幕上 = 相机 up2
        target = vAdd(target, vAdd(vScale(right, dx), vScale(up2, dy)));
      }

      this.viewCenter = target;
      this.viewEye = vAdd(target, vScale(dir, dist));
      this.viewTarget = target;
      this.fitInfo = { bmin, bmax, R, need: dist, needFit, aspect, wantCover };
      this.lastAspect = aspect;
    },

    // 按网格名隐藏（空 = 全显示）
    hidden: [],
    // 按零件隐藏：连杆两端的轴承与连杆关节按用户要求去掉，其余不变
    hiddenParts: ['linkStartBearing', 'linkEndBearing', 'linkJoint'],
    // 取景留白：1.0 = 刚好贴边，1.06 = 四周留 6% 余量
    fitMargin: 1.06,
    // 俯仰连杆链放在 x 负侧（底座/外壳那一侧），与原版界面一致；设 1 则放回 +x 侧
    linkSide: -1,

    // 量一下模型在画面里占多少、偏多少（调试与自适应用）
    projectedBBox() {
      try {
        const f = this.fitInfo;
        if (!f) return null;
        const cv = this.canvas;
        const W = cv.clientWidth || cv.width, H = cv.clientHeight || cv.height;
        const V = this.view, P = this.proj;
        let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
        for (let xi = 0; xi < 2; xi++) for (let yi = 0; yi < 2; yi++) for (let zi = 0; zi < 2; zi++) {
          const p = [xi ? f.bmax[0] : f.bmin[0], yi ? f.bmax[1] : f.bmin[1],
                     zi ? f.bmax[2] : f.bmin[2], 1];
          const v = [
            V[0] * p[0] + V[4] * p[1] + V[8] * p[2] + V[12],
            V[1] * p[0] + V[5] * p[1] + V[9] * p[2] + V[13],
            V[2] * p[0] + V[6] * p[1] + V[10] * p[2] + V[14],
            V[3] * p[0] + V[7] * p[1] + V[11] * p[2] + V[15],
          ];
          const c = [
            P[0] * v[0] + P[4] * v[1] + P[8] * v[2] + P[12] * v[3],
            P[1] * v[0] + P[5] * v[1] + P[9] * v[2] + P[13] * v[3],
            P[2] * v[0] + P[6] * v[1] + P[10] * v[2] + P[14] * v[3],
            P[3] * v[0] + P[7] * v[1] + P[11] * v[2] + P[15] * v[3],
          ];
          if (Math.abs(c[3]) < 1e-6) continue;
          const sx = (c[0] / c[3] * 0.5 + 0.5) * W;
          const sy = (1 - (c[1] / c[3] * 0.5 + 0.5)) * H;
          minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
          minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
        }
        if (!(maxX > -1e8)) return null;
        return {
          W, H,
          box: [Math.round(minX), Math.round(minY), Math.round(maxX), Math.round(maxY)],
          coverX: +((maxX - minX) / W * 100).toFixed(1),
          coverY: +((maxY - minY) / H * 100).toFixed(1),
          offX: +(((minX + maxX) / 2 - W / 2) / W * 100).toFixed(1),
          offY: +(((minY + maxY) / 2 - H / 2) / H * 100).toFixed(1),
          aspect: +f.aspect.toFixed(3),
        };
      } catch (e) {
        return null;
      }
    },

    // ---- 预览开关：关掉时释放 WebGL 与显存，进程内存可回落 ----
    dispose() {
      try {
        this.ready = false;
        this.paused = true;
        if (this.gl) {
          const lose = this.gl.getExtension('WEBGL_lose_context');
          if (lose) lose.loseContext();
        }
        this.meshes = null;
        this.gl = null;
        this.prog = null;
        this.uni = {};
        if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
        this.canvas = null;
      } catch (e) { this.error = e && e.message; }
    },

    // ---------------- 绘制 ----------------

    resize() {
      const c = this.canvas;
      const dpr = Math.min(this.pixelRatioCap || 1.5, global.devicePixelRatio || 1);
      const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      this.gl.viewport(0, 0, c.width, c.height);
    },

    draw() {
      const gl = this.gl, U = this.uni;
      if (!this.ready) return;
      const cv = this.canvas;
      const cw = cv.clientWidth | 0, ch = cv.clientHeight | 0;
      if (!cw || !ch) return;                    // 页面/标签页不可见时不画，也不取景
      // 画布尺寸一变就重新取景：切标签页、窗口缩放、3D 卡片左右栏换列都会走到这里
      if (this.lastW !== cw || this.lastH !== ch) {
        this.lastW = cw; this.lastH = ch;
        try { this.fitCamera(); } catch (e) { }
      }
      this.resize();
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      // OBJ 的法线方向不一定统一，开背面剔除会让部分零件"缺面/穿透"，这里双面渲染
      gl.disable(gl.CULL_FACE);

      const aspect = this.canvas.width / Math.max(1, this.canvas.height);
      if (this.lastAspect && Math.abs(aspect - this.lastAspect) > 0.02) {
        try { this.fitCamera(); } catch (e) { }
      }
      mat4Perspective(CAM.fov, aspect, CAM.near, CAM.far, this.proj);
      mat4LookAt(this.viewEye || CAM.eye, this.viewTarget || CAM.target, CAM.up, this.view);

      // 整机绕 X 轴 -90°（原版 group.rotation.x）
      const rotX = new Float32Array(16);
      quatToMat4(quatAxisAngle([1, 0, 0], MODEL_ROT_X), rotX);

      // [状态键, 网格名]
      const parts = [
        ['base', 'base'], ['lid', 'lid'], ['pitcher', 'pitcher'],
        ['leftArm', 'arm'], ['rightArm', 'arm'], ['pitcherArm', 'pitcherArm'],
        ['pitcherLinkArm', 'pitcherLinkArm'],
        ['leftBearing', 'bearing'], ['rightBearing', 'bearing'],
        ['linkStartBearing', 'bearing'], ['linkEndBearing', 'bearing'],
        ['leftJoint', 'joint'], ['rightJoint', 'joint'], ['linkJoint', 'joint'],
        ['receiver', 'receiver'], ['modCase', 'modCase'],
      ];
      const scratchA = new Float32Array(16), scratchB = new Float32Array(16);
      const DEBUG_COLORS = {
        base: [0.85, 0.2, 0.2], lid: [0.2, 0.8, 0.3], pitcher: [0.2, 0.4, 0.95],
        leftArm: [0.95, 0.85, 0.1], rightArm: [0.95, 0.55, 0.1],
        pitcherArm: [0.9, 0.2, 0.9], pitcherLinkArm: [0.1, 0.85, 0.85],
        leftBearing: [1, 1, 1], rightBearing: [0.8, 0.8, 0.8],
        linkStartBearing: [0.6, 1, 0.6], linkEndBearing: [0.6, 0.6, 1],
        leftJoint: [1, 0.6, 0.6], rightJoint: [0.6, 1, 1], linkJoint: [1, 1, 0.6],
        receiver: [0.3, 0.5, 0.95], modCase: [0.5, 0.3, 0.1],
      };
      const COLORS = {
        base: [0x1e / 255, 0x1e / 255, 0x1e / 255], lid: [0x3f / 255, 0x51 / 255, 0x73 / 255],
        receiver: [0x3f / 255, 0x51 / 255, 0x73 / 255], pitcher: [0x1e / 255, 0x1e / 255, 0x1e / 255],
        pitcherArm: [0x1e / 255, 0x1e / 255, 0x1e / 255], pitcherLinkArm: [0x1e / 255, 0x1e / 255, 0x1e / 255],
        leftArm: [0x1e / 255, 0x1e / 255, 0x1e / 255], rightArm: [0x1e / 255, 0x1e / 255, 0x1e / 255],
        modCase: [0x1e / 255, 0x1e / 255, 0x1e / 255],
        leftBearing: [0.75, 0.75, 0.75], rightBearing: [0.75, 0.75, 0.75],
        linkStartBearing: [0.75, 0.75, 0.75], linkEndBearing: [0.75, 0.75, 0.75],
        leftJoint: [0.75, 0.75, 0.75], rightJoint: [0.75, 0.75, 0.75], linkJoint: [0.75, 0.75, 0.75],
      };

      const mvp = new Float32Array(16);
      const rotLocal = new Float32Array(16);

      for (const [stateKey, meshName] of parts) {
        if (this.hidden && this.hidden.indexOf(meshName) >= 0) continue;
        if (this.hiddenParts && this.hiddenParts.indexOf(stateKey) >= 0) continue;
        const mesh = this.meshes[meshName];
        if (!mesh) continue;
        const key = stateKey;
        // 小件默认缩小并向机内收一点，避免顶出壳体（可在控制台把 tuckSmall 设为 false 关掉）
        const isSmall = (meshName === 'bearing' || meshName === 'joint');
        const tuck = isSmall && this.tuckSmall !== false;
        const st = this.partsState[stateKey] || { pos: [0, 0, 0], rot: [0, 0, 0], quat: [0, 0, 0, 1] };
        // 局部矩阵 = R(quat) + T(pos)
        let q = st.dquat || (st.quat && (st.quat[3] !== 1 || st.quat[0] || st.quat[1] || st.quat[2])
          ? st.quat
          : quatFromEulerXYZ(st.rot[0], st.rot[1], st.rot[2]));
        let pUse = st.dpos || st.pos;
        // Blender 里调出来的偏移（model-offsets.json）：叠加在部件自己的枢轴上
        const off = this.offsets && this.offsets[stateKey];
        if (off) {
          if (off.quat) q = quatMul(off.quat, q);
          if (off.pos) pUse = [pUse[0] + off.pos[0], pUse[1] + off.pos[1], pUse[2] + off.pos[2]];
        }
        quatToMat4(q, rotLocal);
        // 沿部件自身 Z 轴拉伸（杆子长度不够、够不到端头轴承时会用到）
        if (st.scaleZ && Math.abs(st.scaleZ - 1) > 1e-4) {
          rotLocal[8] *= st.scaleZ; rotLocal[9] *= st.scaleZ; rotLocal[10] *= st.scaleZ;
        }
        const model = rotLocal;
        if (tuck) {
          const s = 0.82;
          for (let i = 0; i < 11; i++) model[i] *= s;   // 均匀缩放左上 3x3
        }
        // 平移（设备空间）→ R(group) * T
        mat4Translate(model, pUse);
        mat4Mul(rotX, model, this.model);

        mat4Mul(this.view, this.model, scratchA);   // view * model
        mat4Mul(this.proj, scratchA, scratchB);     // proj * view * model
        mvp.set(scratchB);

        gl.uniformMatrix4fv(U.uMVP, false, mvp);
        gl.uniformMatrix4fv(U.uModel, false, this.model);
        // 法线矩阵：取 model 左上 3×3（正交旋转，无需逆转置）
        const nrm = new Float32Array([
          this.model[0], this.model[1], this.model[2],
          this.model[4], this.model[5], this.model[6],
          this.model[8], this.model[9], this.model[10],
        ]);
        gl.uniformMatrix3fv(U.uNormalMat, false, nrm);
        const col = (this.debugColors && DEBUG_COLORS[key]) || COLORS[key] || [0.6, 0.6, 0.6];
        gl.uniform3f(U.uAlbedo, col[0], col[1], col[2]);
        const metal = /Bearing|Joint/.test(key) ? 1.0 : 0.0;
        gl.uniform1f(U.uMetal, metal);
        gl.uniform1f(U.uRough, metal ? 0.5 : 1.0);

        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vb);
        gl.enableVertexAttribArray(U.aPos);
        gl.vertexAttribPointer(U.aPos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.nb);
        gl.enableVertexAttribArray(U.aNormal);
        gl.vertexAttribPointer(U.aNormal, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ib);
        gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);

        // 原版只有 +x 侧有俯仰/连杆机构；为了视觉对称，在 −x 侧镜像一份
        if (this.mirrorLink === true && MIRROR_KEYS.indexOf(stateKey) >= 0) {
          const MIRROR = new Float32Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
          mat4Mul(MIRROR, this.model, scratchB);
          mat4Mul(this.view, scratchB, scratchA);
          mat4Mul(this.proj, scratchA, mvp);
          gl.uniformMatrix4fv(U.uMVP, false, mvp);
          gl.uniformMatrix4fv(U.uModel, false, scratchB);
          const nrm2 = new Float32Array([
            scratchB[0], scratchB[1], scratchB[2],
            scratchB[4], scratchB[5], scratchB[6],
            scratchB[8], scratchB[9], scratchB[10],
          ]);
          gl.uniformMatrix3fv(U.uNormalMat, false, nrm2);
          gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
        }
      }
    },

    // 外部只需不断喂目标位置（可以很高频），平滑与重绘都在这里做
    setTarget(pos) {
      if (!pos) return;
      if (!this.target) this.target = Object.assign({}, this.pos);
      for (const k of ['L0', 'R1', 'R2', 'R0']) {
        const v = Number(pos[k]);
        if (Number.isFinite(v)) this.target[k] = v;
      }
    },

    update(pos) {
      if (!this.ready) return;
      if (pos) this.setTarget(pos);
      const now = performance.now();
      const dt = Math.min(0.1, (now - (this.lastT || now)) / 1000);
      this.lastT = now;
      if (this.target) {
        // 一阶平滑：时间步长无关，tau 越小越跟手
        const tau = this.smoothTau || 0.03;   // 跟手优先：数据 30ms 一帧，平滑窗口 ~30ms
        const k = 1 - Math.exp(-dt / tau);
        for (const key of ['L0', 'R1', 'R2', 'R0']) {
          const want = this.target[key];
          if (!Number.isFinite(want)) continue;
          this.pos[key] += (want - this.pos[key]) * k;
        }
      }
      // 位置几乎没变就不重绘（省 GPU，动起来才画）
      let moved = this.dirty;
      if (!moved) {
        const tgt = this.target || this.pos;
        for (const key of ['L0', 'R1', 'R2', 'R0']) {
          if (Math.abs((tgt[key] || 0) - (this.pos[key] || 0)) > 2e-4) { moved = true; break; }
        }
      }
      this.preRender(this.pos);
      if (moved || !this.skippedOnce) {
        this.dirty = false;
        this.skippedOnce = true;
        this.draw();
        const now2 = now;
        this.fpsFrames = (this.fpsFrames || 0) + 1;
        if (!this.fpsAt || now2 - this.fpsAt > 500) {
          this.fps = Math.round((this.fpsFrames * 1000) / Math.max(1, now2 - (this.fpsAt || now2 - 500)));
          this.fpsFrames = 0;
          this.fpsAt = now2;
          // 自适应画质：连续两次低于 45 帧就把渲染分辨率降到 1.0
          if (this.fps && this.fps < 45) this.slowCount = (this.slowCount || 0) + 1;
          else this.slowCount = 0;
          if (this.slowCount >= 2 && (this.pixelRatioCap || 1.5) > 1.0) {
            this.pixelRatioCap = 1.0;
            this.slowCount = 0;
            this.dirty = true;
          }
        }
      }
    },
  };

  global.Device3D = Device3D;
})(window);
