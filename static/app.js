window.onerror = function (m, src, line) {
  document.title = 'ERR ' + m + ' @' + line;
  return false;
};
window.addEventListener('unhandledrejection', function (e) {
  document.title = 'REJ ' + (e.reason && e.reason.message || e.reason);
});
// OSR2 / SR6 中文控制器 v2 —— 前端逻辑
const $ = (s) => document.querySelector(s);
const AXIS_NAMES = {
  L0: 'L0 行程', R1: 'R1 前后', R2: 'R2 左右', R0: 'R0 扭转',
  L1: 'L1 俯仰', L2: 'L2 横滚',
};
const SHAPE_NAMES = { sine: '正弦', triangle: '三角', ramp: '单向坡道', square: '停顿方块' };

let state = null;
let presets = [];
let groups = [];
let activeGroup = '';
let localScripts = {};
const fetching = new Set();
const noData = new Set();
let editingIndex = -1;
let currentAxis = 'L0';
let estopFlag = false;      // 本地急停标记：用来立刻中止校准循环
let lastRunningIdx = null;  // 上一次运行的预设序号（用于刷新卡片）
let quiet = false;          // 拖动滑杆时不刷 UI

// ---------------- 基础 ----------------
async function api(path, body) {
  const opt = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  };
  const r = await fetch(path, opt);
  const j = await r.json();
  if (j && j.ok === false) throw new Error(j.error || '请求失败');
  return j;
}

// 有些接口用 {ok:false, reason/detail} 表示「没命中 / 连不上」，这类要当数据看，
// 不能当异常吞掉——否则界面只剩一句没头没尾的「触发失败 / 连接失败」。
async function apiRaw(path, body) {
  const opt = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  };
  const r = await fetch(path, opt);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.json();
}

// 分组名、关键词、正文片段都是用户输入，拼进 innerHTML 前先转义
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function nowHms() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function log(msg) {
  const el = $('#log');
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  el.textContent += `[${t}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
  if (el.textContent.length > 20000) el.textContent = el.textContent.slice(-12000);
}

// ---------------- 状态轮询 ----------------
async function poll() {
  try {
    state = await api('/api/state');
  } catch (e) { return; /* 服务未启动 */ }
  try { renderState(state); } catch (e) { log('界面刷新异常：' + e.message); }
  try { lkSync(state); } catch (e) { log('联动状态刷新异常：' + e.message); }
  try { csSync(state); } catch (e) { log('控制台状态刷新异常：' + e.message); }
}

let lastConnected = null;

function renderState(s) {
  const on = s.connected;
  if (s.estop) {
    estopFlag = true;
    $('#estop-banner').hidden = false;
    $('#estop').classList.add('latched');
  } else {
    $('#estop-banner').hidden = true;
    $('#estop').classList.remove('latched');
  }
  if (lastConnected === true && on === false) {
    log('⚠ 设备连接已断开（会自动重连桥；也可点顶部「连接」）');
  }
  lastConnected = on;
  $('#conn-dot').classList.toggle('on', on);
  $('#conn-text').textContent = on ? `已连接 · ${s.backend_detail || s.backend}` : '未连接';
  const backendName = { serial: '直接串口', bridge: 'TCode 桥', wifi: 'WiFi' }[s.backend] || s.backend || '-';
  $('#st-backend').textContent = on ? backendName : '-';
  // 页面上没有 #tcode-mod（该控件已移除），不加判空会让整个 renderState 每 250ms 抛一次异常，
  // 后面所有面板（模式、预设、轴条、波形…）都刷不新。
  const tcodeMod = $('#tcode-mod');
  if (tcodeMod && s.tcode_modifier !== undefined && document.activeElement !== tcodeMod) {
    tcodeMod.value = s.tcode_modifier || '';
  }
  $('#st-mode').textContent = ({ preset: '运行预设', sequence: '整套连播', funscript: '播放脚本' })[s.mode] || '空闲';
  $('#st-preset').textContent = s.preset ? `${s.preset.name}（剩 ${s.preset.left}s）`
    : (s.sequence ? `${s.sequence.index}/${s.sequence.total} ${s.sequence.name}（剩 ${s.sequence.left}s）` : '-');

  if (s.lan) {
    $('#lan-url').textContent = s.lan.lan_enabled ? `手机：${s.lan.lan_url}` : '仅本机';
    $('#lan-url').classList.toggle('on', !!s.lan.lan_enabled);
  }

  const bars = $('#bars');
  bars.innerHTML = '';
  if (s.calib && JSON.stringify(s.calib) !== window.__lastCalib) {
    window.__lastCalib = JSON.stringify(s.calib);
    try { renderAxisTabs(); } catch (e) { }
    try { renderOutput(); } catch (e) {
      const el = $('#out-state');
      if (el) el.textContent = '输出面板错误: ' + e.message;
    }
  }
  if (s.defaults && JSON.stringify(s.defaults) !== window.__lastDefaults) {
    window.__lastDefaults = JSON.stringify(s.defaults);
    try { applyParamsToUI(); } catch (e) { }
  }

  if (s.freeplay !== undefined) {
    fpOn = !!s.freeplay;
    const b = $('#btn-freeplay');
    if (b) {
      b.textContent = fpOn ? '■ 停止自由播放（Space）' : '▶ 自由播放（Space）';
      b.classList.toggle('danger', fpOn);
    }
  }
  const runIdx = (s.mode === 'preset' && s.preset) ? Number(s.preset.index) : null;
  if (runIdx !== lastRunningIdx) {
    lastRunningIdx = runIdx;
    try { renderPresets(); } catch (e) { }
  }

  const axisOrder = (s.calib && s.calib.order) || ['L0'];
  for (const a of axisOrder) {
    const v = s.position[a] ?? 0.5;
    bars.insertAdjacentHTML('beforeend',
      `<div class="bar"><span>${a}</span><div class="track"><div class="fill" style="width:${(v * 100).toFixed(1)}%"></div></div><span class="val">${(v * 100).toFixed(0)}%</span></div>`);
  }

  document.querySelectorAll('.preset').forEach((el, i) => {
    const running = (s.preset && presets[i] && s.preset.name === presets[i].name) ||
      (s.sequence && presets[i] && s.sequence.name === presets[i].name);
    el.classList.toggle('running', !!running);
  });

  const fs = s.funscript;
  $('#fs-time').textContent = fs && fs.duration > 0 ? `${fs.time.toFixed(1)}s / ${fs.duration.toFixed(1)}s` : '0.0s / 0.0s';
  drawWave();
}

// ---------------- 连接 ----------------
async function connect() {
  const backend = $('#backend').value;
  const port = $('#port').value;
  const host = $('#wifi-ip').value.trim();
  log(`正在连接（${backend}）…`);
  try {
    const r = await apiRaw('/api/connect', { port, prefer: backend, host });
    log(r.ok ? `连接成功：${r.detail}` : `连接失败：${r.detail || '未知原因'}`);
  } catch (e) { log('连接失败：' + e.message); }
}

async function readDeviceInfo() {
  const host = $('#wifi-ip').value.trim();
  try {
    const r = await api('/api/device/info', { host });
    log(`设备：固件 ${r.version} · TCode ${r.tcodeVersion === 1 ? 'v0.4' : 'v0.3'} · ` +
        `型号 ${r.deviceType === 1 ? 'OSR' : (r.deviceType === 2 ? 'SR6' : '其他')} · 通道 ${r.channels.join('/')}`);
    return r;
  } catch (e) { log('读取设备信息失败：' + e.message); return null; }
}

async function loadPorts() {
  try {
    const r = await api('/api/ports');
    if (r.ports && r.ports.length) {
      $('#port').innerHTML = r.ports.map(p => `<option value="${p.device}">${p.device} · ${p.description}</option>`).join('');
    }
  } catch (e) { }
}

// ---------------- 手动 ----------------
// 顶部状态条：连接 / 当前轴 / 当前位置 / 模式
function csSync(s) {
  if (!s || !$('#cs-state')) return;
  $('#cs-dot').classList.toggle('on', !!s.connected);
  $('#cs-state').textContent = s.connected
    ? `已连接 · ${s.backend_detail || s.backend || ''}`
    : '设备未连接';
  $('#cs-axis').textContent = AXIS_NAMES[currentAxis] || currentAxis;
  const v = s.position ? Number(s.position[currentAxis]) : NaN;
  $('#cs-pos').textContent = Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—';
  if ($('#out-state')) $('#out-state').textContent = s.connected ? '即时生效' : '未连接';
  $('#cs-mode').textContent = ({
    preset: '运行预设', sequence: '整套连播', funscript: '播放脚本',
    freeplay: '自由播放', stroke: '单动作',
  })[s.mode] || '空闲';
}

if ($('#cs-home')) $('#cs-home').addEventListener('click', async () => {
  try { await api('/api/home', {}); log('归中：所有轴正慢速回中位'); }
  catch (e) { log('归中失败：' + e.message); }
});

if ($('#cs-stop')) $('#cs-stop').addEventListener('click', async () => {
  try { await api('/api/stop', { hard: false }); log('已停止当前动作'); }
  catch (e) { log('停止失败：' + e.message); }
});

// 轴 chip 按设备实际轴表生成（SR6 有 6 轴，不再写死 4 个）
function renderAxisTabs() {
  const box = $('#axis-tabs');
  if (!box) return;
  const order = (state && state.calib && state.calib.order) || ['L0'];
  if (!order.includes(currentAxis)) currentAxis = order[0];
  const html = order
    .map(a => `<button class="chip${a === currentAxis ? ' active' : ''}" data-axis="${a}">${AXIS_NAMES[a] || a}</button>`)
    .join('');
  if (box.innerHTML !== html) box.innerHTML = html;   // 内容没变就不重建，避免每 250ms 闪一下
}

if ($('#axis-tabs')) $('#axis-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  currentAxis = b.dataset.axis;
  // 只切换本卡片的轴 chip；以前用的是全局 .chip，会把分组/联动里的高亮一起清掉
  document.querySelectorAll('#axis-tabs .chip').forEach(c => c.classList.toggle('active', c === b));
  csSync(state);
});

// ---- 滑块 + 手动输入 双向绑定 ----
function bindCtrl(numId, rangeId, hintId, min, max, unit) {
  const num = $('#' + numId), rng = $('#' + rangeId), hint = hintId ? $('#' + hintId) : null;
  if (!num || !rng) return { setMax() { } };
  const show = () => {
    if (hint) hint.textContent = `范围 ${min}–${max} ${unit}`;
    num.max = max; num.min = min; rng.min = min; rng.max = max;
  };
  const clamp = (v) => Math.min(max, Math.max(min, Number(v) || 0));
  const setBoth = (v, from) => {
    const c = clamp(v);
    if (from !== 'range') rng.value = c;
    if (from !== 'num') num.value = c;
    if (hint) hint.textContent = Number(v) !== c
      ? `已按 ${c} 修正（范围 ${min}–${max} ${unit}）` : `范围 ${min}–${max} ${unit}`;
    return c;
  };
  rng.addEventListener('input', () => setBoth(rng.value, 'range'));
  num.addEventListener('input', () => setBoth(num.value, 'num'));
  num.addEventListener('change', () => setBoth(num.value, 'num'));
  show();
  return { setMax(nm) { max = nm; show(); setBoth(num.value, 'num'); } };
}

const ctrlPos = bindCtrl('pos-num', 'pos', 'hint-pos', 0, 100, '%');

// ---------------- 输出 Output ----------------
let outAxes = [];

function renderOutput() {
  const box = $('#out-list');
  if (!box) return;
  const calib = (state && state.calib) || { order: [], axes: {} };
  outAxes = calib.order || [];
  box.innerHTML = '';
  outAxes.forEach(ax => {
    const cfg = calib.axes[ax] || { min: 0, max: 1, enabled: true };
    const row = document.createElement('div');
    row.className = 'out-row';
    row.innerHTML = `
      <span class="nm">${axisName(ax)}</span>
      <div class="dual">
        <input type="range" class="o-min" min="0" max="99" step="1" value="${Math.round((cfg.min || 0) * 99)}" />
        <input type="range" class="o-max" min="1" max="100" step="1" value="${Math.round((cfg.max ?? 1) * 100)}" />
      </div>
      <span class="pct">${Math.round((cfg.min || 0) * 100)} – ${Math.round((cfg.max ?? 1) * 100)}%</span>`;
    box.appendChild(row);

    const lo = row.querySelector('.o-min'), hi = row.querySelector('.o-max');
    const pct = row.querySelector('.pct');
    const paint = () => {
      if (Number(lo.value) >= Number(hi.value) - 1) {
        if (document.activeElement === lo) lo.value = Number(hi.value) - 1;
        else hi.value = Number(lo.value) + 1;
      }
      pct.textContent = `${lo.value} – ${hi.value}%`;
    };
    let timer = null;
    const push = () => {
      paint();
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const axes = {};
        outAxes.forEach(a => {
          const el = box.querySelector(`[data-ax="${a}"]`);
          const c = (state.calib.axes[a] || {});
          axes[a] = {
            enabled: c.enabled !== false, invert: !!c.invert,
            min: Math.min(0.98, Math.max(0, Number(c.min ?? 0))),
            max: Math.max(0.02, Math.min(1, Number(c.max ?? 1))),
            maxspeed: c.maxspeed || 9999,
          };
        });
        // 当前行
        axes[ax].min = Number(lo.value) / 100;
        axes[ax].max = Number(hi.value) / 100;
        try { await api('/api/calibration', { axes, device: state.calib.device, profile: state.calib.profile }); } catch (e) { }
        poll();
      }, 300);
    };
    lo.addEventListener('input', push);
    hi.addEventListener('input', push);
    row.dataset.ax = ax;
  });
}

// ---------------- 参数 Parameters ----------------
function applyParamsToUI() {
  const d = (state && state.defaults) || {};
  const f = (id) => $('#' + id);
  if (f('p-change-bpm')) f('p-change-bpm').value = d.change_bpm || 'transition';
  if (f('bpm-min')) f('bpm-min').value = d.bpm_min ?? 20;
  if (f('bpm-max')) f('bpm-max').value = d.bpm_max ?? 60;
  if (f('bpm-val')) f('bpm-val').textContent = `${d.bpm_min ?? 20} – ${d.bpm_max ?? 60}`;
  if (f('p-accel')) { f('p-accel').value = Math.round((d.accel ?? 0.3) * 10); f('accel-val').textContent = ((d.accel ?? 0.3)).toFixed(1) + ' 秒'; }
  if (f('p-secs')) { f('p-secs').value = d.secs ?? 20; f('secs-val').textContent = (d.secs ?? 20) + ' 秒'; }
  if (f('p-trans')) { f('p-trans').value = Math.round((d.trans ?? 0.3) * 10); f('trans-val').textContent = ((d.trans ?? 0.3)).toFixed(1) + ' 秒'; }
  if (f('limit-val') && state && state.limits) {
    f('limit-val').textContent = `${Math.round(state.limits.lo * 100)} – ${Math.round(state.limits.hi * 100)} %`;
    f('p-lo').value = Math.round(state.limits.lo * 100);
    f('p-hi').value = Math.round(state.limits.hi * 100);
  }
}

const readParams = () => ({
  change_bpm: $('#p-change-bpm') ? $('#p-change-bpm').value : 'transition',
  bpm_min: Number($('#bpm-min').value), bpm_max: Number($('#bpm-max').value),
  accel: Number($('#p-accel').value) / 10,
  secs: Number($('#p-secs').value),
  trans: Number($('#p-trans').value) / 10,
});

async function saveParams() {
  const d = readParams();
  if (d.bpm_min >= d.bpm_max) { alert('BPM 下限要小于上限'); return; }
  try {
    await api('/api/defaults', d);
    await api('/api/limits', {
      lo: Number($('#p-lo').value) / 100,
      hi: Number($('#p-hi').value) / 100,
      speed_cap: (state && state.limits && state.limits.speed_cap) || 3000,
    });
    log(`参数已保存：BPM ${d.bpm_min}–${d.bpm_max}，加速度 ${d.accel.toFixed(1)}s，时长 ${d.secs}s，过渡 ${d.trans.toFixed(1)}s`);
    poll();
  } catch (e) { log('保存参数失败：' + e.message); }
}

if ($('#btn-save-params')) $('#btn-save-params').addEventListener('click', saveParams);
if ($('#btn-reset-params')) $('#btn-reset-params').addEventListener('click', async () => {
  await api('/api/defaults', { change_bpm: 'transition', bpm_min: 20, bpm_max: 60,
                               accel: 0.3, trans: 0.3, secs: 20 });
  poll();
  log('参数已恢复默认');
});
['bpm-min', 'bpm-max'].forEach(id => {
  const el = $('#' + id);
  if (!el) return;
  el.addEventListener('input', () => {
    const a = Number($('#bpm-min').value), b = Number($('#bpm-max').value);
    $('#bpm-val').textContent = `${a} – ${b}`;
  });
});
[['p-accel', 'accel-val', 0.1, '秒'], ['p-secs', 'secs-val', 1, '秒'],
 ['p-trans', 'trans-val', 0.1, '秒']].forEach(([id, out, k, unit]) => {
  const el = $('#' + id);
  if (!el) return;
  el.addEventListener('input', () => {
    const v = Number(el.value) * k;
    $('#' + out).textContent = (k < 1 ? v.toFixed(1) : v) + ' ' + unit;
  });
});
[['p-lo', 'p-hi', 'limit-val']].forEach(([a, b, out]) => {
  const lo = $('#' + a), hi = $('#' + b);
  if (!lo || !hi) return;
  const paint = () => { $('#' + out).textContent = `${lo.value} – ${hi.value} %`; };
  lo.addEventListener('input', paint);
  hi.addEventListener('input', paint);
});

$('#btn-apply').addEventListener('click', async () => {
  await ensureResumed();
  const pos = Number($('#pos-num').value) / 100;
  try {
    const spd = (state && state.limits && state.limits.speed_cap) || 3000;
    const r = await api('/api/move', { axis: currentAxis, pos, speed: spd });
    log(`移动 ${AXIS_NAMES[currentAxis]} → ${(pos * 100).toFixed(0)}%${r.ok ? '' : '（失败）'}`);
  } catch (e) { log('移动失败：' + e.message); }
});



$('#backend').addEventListener('change', () => {
  const v = $('#backend').value;
  $('#wifi-ip').style.opacity = (v === 'wifi' || v === 'auto') ? '1' : '0.35';
  $('#port').style.opacity = (v === 'serial' || v === 'auto') ? '1' : '0.35';
});
$('#stroke-bpm').addEventListener('input', () => {
  $('#stroke-bpm-num').value = $('#stroke-bpm').value;
  $('#stroke-bpm-hint').textContent = `${$('#stroke-bpm').value} BPM ≈ ${(Number($('#stroke-bpm').value) / 60).toFixed(2)} 次/秒`;
  liveStrokeBpm();
});
$('#stroke-bpm-num').addEventListener('input', () => {
  $('#stroke-bpm').value = $('#stroke-bpm-num').value;
  liveStrokeBpm();
});
if ($('#stroke-single')) $('#stroke-single').addEventListener('change', () => {
  localStorage.setItem('stroke_single', $('#stroke-single').checked ? '1' : '0');
  renderStrokes();
});
if ($('#stroke-stop')) $('#stroke-stop').addEventListener('click', async () => { await api('/api/stop'); log('已停止动作'); poll(); });
$('#btn-connect').addEventListener('click', connect);
$('#btn-firmware').addEventListener('click', async () => {
  try {
    const r = await api('/api/firmware', { host: $('#wifi-ip').value.trim() });
    log(`驱动固件 v${r.version}｜TCode ${r.tcode === 1 ? 'v0.4' : 'v0.3'}｜打开 ${r.url}`);
    window.open(r.url, '_blank');
  } catch (e) {
    const ip = $('#wifi-ip').value.trim() || '192.168.1.54';
    window.open('http://' + ip, '_blank');
    log('打开固件界面：http://' + ip);
  }
});
$('#btn-stop').addEventListener('click', async () => {
  await emergencyStop('全部停止');           // 与急停完全等价：DSTOP + 锁存
});

// ---------------- 分组 ----------------
async function loadPresets() {
  const r = await api('/api/presets');
  groups = r.groups;
  activeGroup = r.active;
  presets = r.presets;
  renderGroups();
  renderPresets();
}

function renderGroups() {
  const box = $('#groups');
  box.innerHTML = '';
  if ($('#cs-group')) $('#cs-group').textContent = activeGroup || '—';
  groups.forEach(g => {
    const b = document.createElement('button');
    b.className = 'chip' + (g === activeGroup ? ' active' : '');
    b.textContent = g;
    b.onclick = () => switchGroup(g);
    box.appendChild(b);
  });
  updateScrollHints();
}

async function switchGroup(name) {
  try {
    const r = await api('/api/groups', { action: 'switch', name });
    activeGroup = r.active;
    groups = r.groups;
    presets = r.presets;
    renderGroups();
    renderPresets();
    log(`切换到分组「${name}」，整套 ${presets.length} 个预设已换`);
  } catch (e) { log('切换分组失败：' + e.message); }
}

$('#btn-g-new').onclick = async () => {
  const name = prompt('新分组名称：', '我的分组');
  if (!name) return;
  try {
    const r = await api('/api/groups', { action: 'create', name });
    groups = r.groups; activeGroup = r.active;
    await loadPresets();
    log(`已新建分组「${activeGroup}」（复制了当前组的 10 个预设）`);
  } catch (e) { log('新建失败：' + e.message); }
};

$('#btn-g-copy').onclick = async () => {
  try {
    const r = await api('/api/groups', { action: 'duplicate' });
    groups = r.groups; activeGroup = r.active;
    await loadPresets();
    log(`已复制为「${activeGroup}」`);
  } catch (e) { log('复制失败：' + e.message); }
};

$('#btn-g-rename').onclick = async () => {
  const name = prompt('新的分组名称：', activeGroup);
  if (!name || name === activeGroup) return;
  try {
    const r = await api('/api/groups', { action: 'rename', name: activeGroup, new_name: name });
    groups = r.groups; activeGroup = r.active;
    await loadPresets();
    log(`分组已改名为「${activeGroup}」`);
  } catch (e) { log('重命名失败：' + e.message); }
};

$('#btn-g-del').onclick = async () => {
  if (groups.length <= 1) { alert('至少要保留一个分组'); return; }
  if (!confirm(`确定删除分组「${activeGroup}」？`)) return;
  try {
    const r = await api('/api/groups', { action: 'delete', name: activeGroup });
    groups = r.groups; activeGroup = r.active;
    await loadPresets();
    log(`已删除分组，当前「${activeGroup}」`);
  } catch (e) { log('删除失败：' + e.message); }
};

$('#btn-add-card').onclick = async () => {
  try {
    const r = await api('/api/preset/add', { group: activeGroup });
    presets = r.presets;
    renderPresets();
    log(`已添加卡片：${r.preset.name}（第 ${r.index + 1} 张）`);
  } catch (e) { log('添加失败：' + e.message); }
};

$('#btn-seq').onclick = async () => {
  await ensureResumed();
  try {
    const r = await api('/api/sequence/run', { group: activeGroup });
    log(`整套连播开始：${activeGroup} 共 ${r.sequence.count} 个预设，按顺序跑完自动停`);
  } catch (e) { log('连播失败：' + e.message); }
};

// ---------------- 预设卡片 ----------------
function axisName(a) {
  const map = { L0: 'L0 行程', R0: 'R0 扭转', R1: 'R1 前后', R2: 'R2 左右', L1: 'L1 俯仰', L2: 'L2 横滚' };
  return map[a] || a;
}
function axisOptions(selected) {
  const axes = (state && state.calib && state.calib.order) || ['L0'];
  return axes.map(a => {
    const cfg = (state && state.calib && state.calib.axes && state.calib.axes[a]) || {};
    const off = cfg.enabled === false ? '（未启用）' : '';
    return `<option value="${a}" ${a === selected ? 'selected' : ''}>${axisName(a)}${off}</option>`;
  }).join('');
}

function presetNeed(p) {
  const amp = (p.high - p.low) * 9999;
  const factor = p.shape === 'sine' ? Math.PI : 2;
  return Math.round(amp * p.hz * factor * 1.15);
}

let saveTimer = null;
function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await api('/api/presets', { group: activeGroup, presets });
      log(`已保存「${activeGroup}」组的修改`);
    } catch (e) { log('保存失败：' + e.message); }
  }, 400);
}

function renderPresets() {
  const box = $('#presets');
  box.innerHTML = '';
  const running = (state && state.mode === 'preset' && state.preset) ? state.preset : null;

  presets.forEach((p, i) => {
    const isRunning = running && Number(running.index) === i;
    const isStroke = p.kind === 'stroke';
    const el = document.createElement('div');
    el.className = 'preset' + (isRunning ? ' running' : '') + (isStroke ? ' is-stroke' : '');
    const head = `
      <div class="prow head">
        <span class="idx">${i + 1}</span>
        <input class="pname" maxlength="20" value="${p.name || ''}" />
        ${isRunning ? '<span class="live-badge">● 运行中</span>' : ''}
        <button class="del-card" title="删除这张卡片">✕</button>
      </div>`;

    if (isStroke) {
      const cn = p.stroke_cn || p.name || p.stroke;
      el.innerHTML = head + `
        <div class="prow"><span class="tag-stroke">动作库</span>
          <span class="hint" style="margin-left:auto">${p.stroke}</span></div>
        <div class="prow num2"><label>速度</label>
          <input type="range" class="sbpm-r" min="10" max="120" step="1" value="${p.bpm || 40}" />
          <input type="number" class="sbpm" min="5" max="240" step="1" value="${p.bpm || 40}" />
          <span>BPM</span></div>
        <div class="prow num2"><label>幅度</label>
          <input type="range" class="sgain-r" min="10" max="100" step="5" value="${Math.round((p.gain || 1) * 100)}" />
          <input type="number" class="sgain" min="10" max="100" step="5" value="${Math.round((p.gain || 1) * 100)}" />
          <span>%</span></div>
        <div class="prow num2"><label>时长</label>
          <input type="range" class="ssecs-r" min="2" max="120" step="1" value="${p.secs || 20}" />
          <input type="number" class="ssecs" min="1" max="1800" step="1" value="${p.secs || 20}" />
          <span>秒</span></div>
        <div class="prow num2"><label title="启动时逐渐加力">加速</label>
          <input type="range" class="sacc-r" min="0" max="20" step="1" value="${Math.round((p.accel ?? 0.25) * 10)}" />
          <input type="number" class="sacc" min="0" max="20" step="1" value="${Math.round((p.accel ?? 0.25) * 10)}" />
          <span>×0.1秒</span></div>
        <div class="prow num2"><label title="动作切换/变化时的柔化时间">过渡</label>
          <input type="range" class="strn-r" min="0" max="15" step="1" value="${Math.round((p.trans ?? 0.2) * 10)}" />
          <input type="number" class="strn" min="0" max="15" step="1" value="${Math.round((p.trans ?? 0.2) * 10)}" />
          <span>×0.1秒</span></div>
        <div class="prow"><button class="btn small primary run">▶ 运行</button>
          <button class="btn small stp">■ 停止</button></div>`;
    } else {
      const need = presetNeed(p);
      const manual = p.speed_mode === 'manual' && Number(p.speed) > 0;
      const spdVal = manual ? Number(p.speed) : Math.min(9999, Math.max(50, need || 4000));
      el.innerHTML = head + `
        <div class="prow">
          <select class="paxis">${axisOptions(p.axis)}</select>
          <select class="pshape">${Object.keys(SHAPE_NAMES).map(s =>
            `<option value="${s}" ${s === p.shape ? 'selected' : ''}>${SHAPE_NAMES[s]}</option>`).join('')}</select>
        </div>
        <div class="prow num"><label>行程下限</label>
          <input type="range" class="plow-r" min="0" max="49" step="1" value="${Math.round((p.low ?? 0.3) * 100)}" />
          <input type="number" class="plow" min="0" max="49" step="1" value="${Math.round((p.low ?? 0.3) * 100)}" />
          <span>%</span></div>
        <div class="prow num"><label>行程上限</label>
          <input type="range" class="phigh-r" min="51" max="100" step="1" value="${Math.round((p.high ?? 0.7) * 100)}" />
          <input type="number" class="phigh" min="51" max="100" step="1" value="${Math.round((p.high ?? 0.7) * 100)}" />
          <span>%</span></div>
        <div class="prow num2"><label>频率</label>
          <input type="range" class="phz-r" min="0.05" max="5" step="0.05" value="${p.hz ?? 1}" />
          <input type="number" class="phz" min="0.05" max="5" step="0.05" value="${p.hz ?? 1}" />
          <span>次/秒</span></div>
        <div class="prow num2"><label>动作时长</label>
          <input type="range" class="psecs-r" min="1" max="120" step="1" value="${p.secs ?? 15}" />
          <input type="number" class="psecs" min="1" max="180" step="1" value="${p.secs ?? 15}" />
          <span>秒</span></div>
        <div class="prow num2"><label>速度</label>
          <input type="checkbox" class="pauto" ${manual ? '' : 'checked'} />
          <input type="range" class="pspd-r" min="50" max="9999" step="50" value="${spdVal}" ${manual ? '' : 'disabled'} />
          <input type="number" class="pspd" min="50" max="9999" step="50" value="${spdVal}" ${manual ? '' : 'disabled'} />
          <span>单位/秒</span></div>
        <div class="prow num2"><label title="启动时逐渐加力">加速</label>
          <input type="range" class="wacc-r" min="0" max="20" step="1" value="${Math.round((p.accel ?? 0.25) * 10)}" />
          <input type="number" class="wacc" min="0" max="20" step="1" value="${Math.round((p.accel ?? 0.25) * 10)}" />
          <span>×0.1秒</span></div>
        <div class="prow num2"><label title="变化时的柔化时间">过渡</label>
          <input type="range" class="wtrn-r" min="0" max="15" step="1" value="${Math.round((p.trans ?? 0.2) * 10)}" />
          <input type="number" class="wtrn" min="0" max="15" step="1" value="${Math.round((p.trans ?? 0.2) * 10)}" />
          <span>×0.1秒</span></div>
        <div class="prow need"></div>
        <div class="prow"><button class="btn small primary run">▶ 运行</button>
          <button class="btn small stp">■ 停止</button></div>`;
    }

    const q = (sel) => el.querySelector(sel);
    let liveTimer = null;

    const pushLive = () => {
      if (!isRunning) return;
      clearTimeout(liveTimer);
      liveTimer = setTimeout(async () => {
        try {
          const payload = isStroke
            ? { bpm: p.bpm, gain: p.gain, secs: p.secs, accel: p.accel, trans: p.trans }
            : { speed: p.speed, hz: p.hz, low: p.low, high: p.high, secs: p.secs,
                shape: p.shape, accel: p.accel, trans: p.trans };
          await api('/api/preset/live', payload);
        } catch (e) { }
      }, 120);
    };

    const pair = (rangeSel, numSel) => {
      const r = q(rangeSel), n = q(numSel);
      if (!r || !n) return;
      r.addEventListener('input', () => { n.value = r.value; commit(); });
      n.addEventListener('input', () => { r.value = n.value; commit(); });
      n.addEventListener('change', () => commit());
    };

    const refreshNeed = () => {
      if (isStroke) return;
      const n = presetNeed(p);
      const man = p.speed_mode === 'manual' && Number(p.speed) > 0;
      q('.need').innerHTML = man
        ? (Number(p.speed) >= n ? `手动速度 ${p.speed}（需 ${n}，足够）`
          : `<b class="warn">手动速度 ${p.speed} 低于需求 ${n}，幅度会被压缩</b>`)
        : `需 ≈${n} 单位/秒（自动）`;
    };

    const commit = () => {
      p.name = q('.pname').value.trim() || `卡片${i + 1}`;
      if (isStroke) {
        p.bpm = Number(q('.sbpm').value);
        p.gain = Number(q('.sgain').value) / 100;
        p.secs = Number(q('.ssecs').value);
        p.accel = Number(q('.sacc').value) / 10;
        p.trans = Number(q('.strn').value) / 10;
      } else {
        const low = Number(q('.plow').value) / 100;
        const high = Number(q('.phigh').value) / 100;
        if (!(low < high)) { alert('行程下限必须小于上限'); return; }
        p.axis = q('.paxis').value;
        p.shape = q('.pshape').value;
        p.low = low; p.high = high;
        p.hz = Number(q('.phz').value);
        p.secs = Number(q('.psecs').value);
        const man = !q('.pauto').checked;
        p.speed_mode = man ? 'manual' : 'auto';
        p.speed = man ? Number(q('.pspd').value) : 0;
        p.accel = Number(q('.wacc').value) / 10;
        p.trans = Number(q('.wtrn').value) / 10;
      }
      queueSave();
      refreshNeed();
      pushLive();
    };

    if (isStroke) {
      pair('.sbpm-r', '.sbpm');
      pair('.sgain-r', '.sgain');
      pair('.ssecs-r', '.ssecs');
      pair('.sacc-r', '.sacc');
      pair('.strn-r', '.strn');
    } else {
      pair('.plow-r', '.plow');
      pair('.phigh-r', '.phigh');
      pair('.phz-r', '.phz');
      pair('.psecs-r', '.psecs');
      pair('.pspd-r', '.pspd');
      pair('.wacc-r', '.wacc');
      pair('.wtrn-r', '.wtrn');
      q('.pauto').addEventListener('change', () => {
        const man = !q('.pauto').checked;
        q('.pspd-r').disabled = !man;
        q('.pspd').disabled = !man;
        commit();
      });
      ['paxis', 'pshape'].forEach(c => {
        el.querySelector('.' + c).addEventListener('change', commit);
      });
      refreshNeed();
    }

    q('.pname').addEventListener('change', commit);
    q('.pname').addEventListener('input', () => { queueSave(); });

    el.querySelector('.del-card').onclick = async () => {
      if (!confirm(`删除卡片「${p.name}」？`)) return;
      presets.splice(i, 1);
      renderPresets();
      queueSave();
      log(`已删除卡片：${p.name}`);
    };
    el.querySelector('.run').onclick = async () => {
      await ensureResumed();
      try {
        await api('/api/preset/run', { index: i });
        log(`运行：${p.name}`);
      } catch (e) { log('运行失败：' + e.message); }
    };
    el.querySelector('.stp').onclick = async () => { await api('/api/stop'); log('已停止'); };
    box.appendChild(el);
  });
  if ($('#cs-group')) $('#cs-group').textContent = (activeGroup || '—') + ' · ' + presets.length + ' 张';
  updateScrollHints();
}

// ---------- 从动作库加卡片 ----------
async function openStrokePicker() {
  if (!strokes.length) await loadStrokes();
  $('#pick-group').textContent = activeGroup;
  const grid = $('#pick-grid');
  const render = (kw) => {
    grid.innerHTML = '';
    strokes.filter(s => !kw || (s.cn + s.name).toLowerCase().includes(kw.toLowerCase()))
      .forEach(s => {
        const b = document.createElement('button');
        b.className = 'btn small pick-item';
        b.textContent = s.cn;
        b.title = s.name;
        b.onclick = async () => {
          presets.push({ kind: 'stroke', stroke: s.name, stroke_cn: s.cn, name: s.cn,
                         bpm: 40, gain: 0.8, secs: 20 });
          renderPresets();
          try { await api('/api/presets', { group: activeGroup, presets }); } catch (e) { }
          $('#pick-modal').hidden = true;
          log(`已加入动作卡片：${s.cn} → 分组「${activeGroup}」`);
        };
        grid.appendChild(b);
      });
  };
  render('');
  $('#pick-search').value = '';
  $('#pick-search').oninput = (e) => render(e.target.value);
  $('#pick-modal').hidden = false;
}

if ($('#btn-pick-stroke')) $('#btn-pick-stroke').addEventListener('click', openStrokePicker);
$('#pick-cancel').addEventListener('click', () => { $('#pick-modal').hidden = true; });

if ($('#btn-import-strokes')) $('#btn-import-strokes').addEventListener('click', async () => {
  if (!confirm('把动作库的 42 个动作按类别导入为 4 个分组（长行程/研磨/挑逗/短滚）？\\n同名分组会被覆盖。')) return;
  try {
    const r = await api('/api/preset/import_strokes', {});
    await loadPresets();
    await switchGroup(r.active);
    log('已导入动作库分组：' + Object.entries(r.groups).map(([k, v]) => `${k}(${v})`).join(' '));
  } catch (e) { log('导入失败：' + e.message); }
});

// ---------------- Funscript ----------------
function axisFromName(name) {
  const n = name.toLowerCase();
  if (n.includes('surge')) return 'R1';
  if (n.includes('sway')) return 'R2';
  if (n.includes('twist') || n.includes('roll') || n.includes('pitch')) return 'R0';
  return 'L0';
}

async function addFile(file) {
  const text = await file.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { log(`✗ ${file.name} 不是合法 JSON`); return; }
  const actions = (json.actions || []).map(a => [a.at / 1000, Math.max(0, Math.min(1, a.pos / 100))]);
  if (!actions.length) { log(`✗ ${file.name} 没有动作点`); return; }
  const axis = axisFromName(file.name);
  try {
    const r = await api('/api/funscript/add', { name: file.name, axis, text });
    localScripts[file.name] = actions;
    log(`✓ 已加载 ${file.name}（${r.script.points} 点，${r.script.duration.toFixed(1)}s，轴 ${axis}）`);
    renderFiles();
    drawWave();
  } catch (e) { log('加载失败：' + e.message); }
}

function renderFiles() {
  const box = $('#files');
  box.innerHTML = '';
  const files = (state && state.funscript && state.funscript.files) || [];
  files.forEach(f => {
    const el = document.createElement('div');
    el.className = 'file';
    el.innerHTML = `<span class="fname" title="${f.name}">${f.name}</span>
      <select>${Object.keys(AXIS_NAMES).map(a => `<option value="${a}" ${a === f.axis ? 'selected' : ''}>${AXIS_NAMES[a]}</option>`).join('')}</select>
      <span class="muted">${f.points}点 / ${f.duration.toFixed(1)}s</span>
      <button class="del" title="移除">✕</button>`;

    const reload = async (list, msg) => {
      await api('/api/funscript/clear');
      for (const k of list) {
        if (localScripts[k.name]) {
          await api('/api/funscript/add', {
            name: k.name, axis: k.axis,
            text: JSON.stringify({ actions: localScripts[k.name].map(([t, p]) => ({ at: t * 1000, pos: p * 100 })) })
          });
        }
      }
      log(msg);
      renderFiles(); drawWave();
    };

    el.querySelector('.del').onclick = () => reload(files.filter(x => x.name !== f.name), `已移除 ${f.name}`);
    el.querySelector('select').onchange = (ev) =>
      reload(files.map(x => x.name === f.name ? { ...x, axis: ev.target.value } : x), `${f.name} 改为 ${ev.target.value}`);
    box.appendChild(el);
  });

  const total = files.reduce((m, f) => Math.max(m, f.duration), 0);
  $('#fs-info').textContent = files.length ? `${files.length} 个文件，最长 ${total.toFixed(1)}s` : '拖入 .funscript 文件';
}

// 拖拽
function wireDrop(selector, onFiles) {
  const el = $(selector);
  ['dragenter', 'dragover'].forEach(ev => el.addEventListener(ev, e => { e.preventDefault(); el.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => el.addEventListener(ev, e => { e.preventDefault(); el.classList.remove('over'); }));
  el.addEventListener('drop', async (e) => { for (const f of e.dataTransfer.files) await onFiles(f); });
}
wireDrop('#drop', addFile);
wireDrop('#vdrop', loadVideo);

$('#file').addEventListener('change', async (e) => {
  for (const f of e.target.files) await addFile(f);
  e.target.value = '';
});

$('#btn-play').onclick = async () => {
  await ensureResumed();
  try {
    await api('/api/funscript/play', { speed: Number($('#fs-speed').value), loop: $('#loop').checked });
    log('开始播放 Funscript');
  } catch (e) { log('播放失败：' + e.message); }
};
$('#btn-pause').onclick = async () => { await api('/api/funscript/pause'); log('已暂停'); };
$('#btn-fsclear').onclick = async () => {
  await api('/api/funscript/clear'); localScripts = {}; log('已清空脚本'); renderFiles(); drawWave();
};

// ---------------- 视频 ----------------
const video = $('#video');
video.style.display = 'none';
  if (document.getElementById('vph')) document.getElementById('vph').hidden = false;

function hasScript() {
  return !!(state && state.funscript && state.funscript.duration > 0);
}

async function loadVideo(file) {
  if (!/^video\//.test(file.type) && !/\.(mp4|webm|mkv|mov|avi)$/i.test(file.name)) {
    log(`✗ ${file.name} 看起来不是视频文件`); return;
  }
  const url = URL.createObjectURL(file);
  video.src = url;
  video.style.display = 'block';
  if (document.getElementById('vph')) document.getElementById('vph').hidden = true;
  $('#video-info').textContent = file.name;
  log(`已载入视频：${file.name}`);
}

$('#vfile').addEventListener('change', (e) => {
  if (e.target.files[0]) loadVideo(e.target.files[0]);
  e.target.value = '';
});

$('#sync').addEventListener('change', () => {
  $('#sync-info').textContent = $('#sync').checked
    ? '播放视频时自动开始，暂停/拖动自动对齐'
    : '已关闭同步（只放视频，不动设备）';
});

video.addEventListener('play', async () => {
  if (!$('#sync').checked || !hasScript()) return;
  try {
    await api('/api/funscript/play', { speed: video.playbackRate, start: video.currentTime });
    log(`视频播放 → 脚本从 ${video.currentTime.toFixed(1)}s 开始`);
  } catch (e) { log('同步失败：' + e.message); }
});

video.addEventListener('pause', async () => {
  if (!$('#sync').checked) return;
  try { await api('/api/funscript/pause'); } catch (e) { }
});

video.addEventListener('seeked', async () => {
  if (!$('#sync').checked || !hasScript()) return;
  try { await api('/api/funscript/seek', { t: video.currentTime }); } catch (e) { }
});

video.addEventListener('ratechange', async () => {
  if (!$('#sync').checked || video.paused || !hasScript()) return;
  try { await api('/api/funscript/play', { speed: video.playbackRate, start: video.currentTime }); } catch (e) { }
});

video.addEventListener('ended', async () => {
  try { await api('/api/funscript/pause'); } catch (e) { }
});

setInterval(async () => {
  if (video.paused || !$('#sync').checked || !hasScript()) return;
  const drift = Math.abs((state.funscript.time || 0) - video.currentTime);
  if (drift > 0.35) {
    try { await api('/api/funscript/seek', { t: video.currentTime }); } catch (e) { }
  }
}, 1200);

// ---------------- 波形 ----------------
const wave = $('#wave');
wave.addEventListener('click', async (e) => {
  if (!state || !state.funscript || !state.funscript.duration) return;
  const rect = wave.getBoundingClientRect();
  const k = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const t = k * state.funscript.duration;
  await api('/api/funscript/seek', { t });
  if (video.style.display !== 'none' && video.duration) video.currentTime = Math.min(t, video.duration);
  log(`定位到 ${t.toFixed(1)}s`);
});

function drawWave() {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = Math.round(wave.clientWidth || 0);
  const h = Math.round(wave.clientHeight || 0);
  if (!w || !h) return;                 // 页面隐藏时不画
  const bw = Math.min(4096, Math.round(w * dpr));
  const bh = Math.min(4096, Math.round(h * dpr));
  if (wave.width !== bw || wave.height !== bh) {   // 只在尺寸变化时重置
    wave.width = bw; wave.height = bh;
  }
  const ctx = wave.getContext('2d');
  ctx.setTransform(bw / w, 0, 0, bh / h, 0, 0);
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = '#1e2331'; ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  const files = (state && state.funscript && state.funscript.files) || [];
  const duration = (state && state.funscript && state.funscript.duration) || 0;
  if (!files.length || !duration) {
    ctx.fillStyle = '#4c5468'; ctx.font = '13px "Microsoft YaHei"';
    ctx.fillText('（加载 .funscript 后这里显示波形）', 14, h / 2);
    return;
  }

  for (const f of files) {
    let actions = localScripts[f.name];
    if (!actions) {
      if (!fetching.has(f.name) && !noData.has(f.name)) {
        fetching.add(f.name);
        fetch(`/api/funscript/actions?name=${encodeURIComponent(f.name)}`)
          .then(r => r.json())
          .then(j => {
            if (j && j.ok && j.actions && j.actions.length) localScripts[f.name] = j.actions;
            else noData.add(f.name);
          })
          .catch(() => noData.add(f.name))
          .finally(() => { fetching.delete(f.name); drawWave(); });
      }
      continue;
    }
    ctx.strokeStyle = '#7c5cff'; ctx.lineWidth = 1.6; ctx.beginPath();
    let started = false;
    for (let x = 0; x < w; x++) {
      const t = (x / w) * duration;
      let v = 0.5;
      let lo = 0, hi = actions.length - 1;
      if (t <= actions[0][0]) v = actions[0][1];
      else if (t >= actions[hi][0]) v = actions[hi][1];
      else {
        while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (actions[m][0] <= t) lo = m; else hi = m; }
        const [t0, p0] = actions[lo], [t1, p1] = actions[hi];
        v = t1 > t0 ? p0 + (p1 - p0) * (t - t0) / (t1 - t0) : p1;
      }
      const y = h - 10 - v * (h - 20);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  if (state.mode === 'funscript') {
    const x = (state.funscript.time / duration) * w;
    ctx.strokeStyle = '#3ddc97'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
}

// ---------------- 设备校准 ----------------
const AXIS_ALL = ['L0', 'R1', 'R2', 'R0'];

function openCalib() {
  const calib = (state && state.calib) || { axes: {}, order: ['L0'] };
  const order = calib.order && calib.order.length ? calib.order : ['L0'];

  const box = $('#calib-table');
  box.innerHTML = `<tr><th>轴代码</th><th>启用</th><th>反向</th><th>行程下限%</th><th>行程上限%</th><th>速度上限</th><th>试动（点一下就走）</th></tr>`;

  order.forEach(a => {
    const c = (calib.axes && calib.axes[a]) || { enabled: true, invert: false, min: 0, max: 1, maxspeed: 9999 };
    const tr = document.createElement('tr');
    tr.className = 'calib-row';
    tr.innerHTML = `
      <td><input class="c-code" value="${a}" maxlength="3" style="width:56px;text-transform:uppercase" />
        <span class="hint">${axisName(a)}</span></td>
      <td><input type="checkbox" class="c-en" ${c.enabled ? 'checked' : ''} /></td>
      <td><input type="checkbox" class="c-inv" ${c.invert ? 'checked' : ''} /></td>
      <td><input type="number" class="c-min" min="0" max="98" value="${Math.round(c.min * 100)}" /></td>
      <td><input type="number" class="c-max" min="2" max="100" value="${Math.round(c.max * 100)}" /></td>
      <td><input type="number" class="c-spd" min="100" max="9999" step="100" value="${c.maxspeed}" /></td>
      <td class="jog">
        <button class="btn tiny" data-p="0">0%</button>
        <button class="btn tiny" data-p="0.25">25%</button>
        <button class="btn tiny" data-p="0.5">50%</button>
        <button class="btn tiny" data-p="0.75">75%</button>
        <button class="btn tiny" data-p="1">100%</button>
        <button class="btn tiny wide" data-run="1">▶ 慢速来回</button>
      </td>`;

    const axisCode = () => tr.querySelector('.c-code').value.trim().toUpperCase() || a;
    const rowCfg = () => ({
      enabled: tr.querySelector('.c-en').checked,
      invert: tr.querySelector('.c-inv').checked,
      min: Number(tr.querySelector('.c-min').value) / 100,
      max: Number(tr.querySelector('.c-max').value) / 100,
      maxspeed: Number(tr.querySelector('.c-spd').value),
    });
    const testSpeed = () => Number($('#calib-speed').value) || 800;

    tr.querySelectorAll('.jog button').forEach(b => {
      b.onclick = async () => {
        await ensureResumed();
        try {
          if (b.dataset.run) {
            const sp = testSpeed();
            const cfg = rowCfg();
            const seq = [cfg.min, cfg.max, (cfg.min + cfg.max) / 2];
            for (const p of seq) {
              if (estopFlag) { log('🛑 已急停，试动中止'); return; }
              await api('/api/calibration/jog', { axis: axisCode(), pos: p, speed: sp, override: cfg });
              await new Promise(r => setTimeout(r, Math.max(700, 2600 / (sp / 800))));
              if (estopFlag) { log('🛑 已急停，试动中止'); return; }
            }
            log(`试动 ${axisCode()}：慢速来回完成`);
            return;
          }
          const pos = Number(b.dataset.p);
          const r = await api('/api/calibration/jog', {
            axis: axisCode(), pos, speed: testSpeed(), override: rowCfg(),
          });
          log(r.ok ? `试动 ${axisCode()} → ${(pos * 100).toFixed(0)}%`
                   : `试动 ${axisCode()} 被拒绝（未启用或轴不存在）`);
        } catch (e) { log('试动失败：' + e.message); }
      };
    });
    box.appendChild(tr);
  });

  // 型号选择框同步
  const sel = $('#calib-profile');
  if (sel) sel.value = calib.profile || 'OSR2';
  $('#calib-modal').hidden = false;
}

$('#calib-add-axis').onclick = () => {
  const box = $('#calib-table');
  const used = [...box.querySelectorAll('.c-code')].map(i => i.value.toUpperCase());
  const candidates = ['L0', 'R0', 'R1', 'R2', 'L1', 'L2', 'V0', 'A0'];
  const code = candidates.find(c => !used.includes(c)) || 'L3';
  const tr = document.createElement('tr');
  tr.className = 'calib-row';
  tr.innerHTML = `
    <td><input class="c-code" value="${code}" maxlength="3" style="width:56px;text-transform:uppercase" />
      <span class="hint">新轴</span></td>
    <td><input type="checkbox" class="c-en" checked /></td>
    <td><input type="checkbox" class="c-inv" /></td>
    <td><input type="number" class="c-min" min="0" max="98" value="0" /></td>
    <td><input type="number" class="c-max" min="2" max="100" value="100" /></td>
    <td><input type="number" class="c-spd" min="100" max="9999" step="100" value="9999" /></td>
    <td class="jog"><span class="hint">保存后再试动</span></td>`;
  box.appendChild(tr);
};

$('#calib-apply').onclick = async () => {
  const key = $('#calib-profile').value;
  if (!confirm(`按「${$('#calib-profile').selectedOptions[0].textContent}」重建轴列表？\n（会覆盖当前表格里的轴与参数）`)) return;
  try {
    const r = await api('/api/calibration/profile', { profile: key });
    await poll();
    openCalib();
    log(`已切换设备型号：${r.calib.device}（轴：${r.calib.order.join(' / ')}）`);
  } catch (e) { alert('切换失败：' + e.message); }
};

$('#btn-calib').onclick = openCalib;
$('#calib-cancel').onclick = () => { $('#calib-modal').hidden = true; };
$('#btn-home').onclick = async () => {
  await ensureResumed();
  const spd = Math.min(2000, Math.max(300, Number($('#home-speed').value) || 1200));
  const axes = [...document.querySelectorAll('#calib-table tr.calib-row')]
    .filter(tr => tr.querySelector('.c-en').checked)
    .map(tr => (tr.querySelector('.c-code').value || '').toUpperCase())
    .filter(Boolean);
  if (!axes.length) { alert('没有启用的轴'); return; }
  if (!confirm(`将以 ${spd} 单位/秒 依次把这些轴移动到行程中点：\n${axes.join(' / ')}\n\n中点是最安全的位置，不会回 0/100%。继续？`)) return;
  try {
    const r = await api('/api/home', { speed: spd });
    log(`已归中：${r.home.axes.join(' / ')}（速度 ${r.home.speed}）`);
  } catch (e) { log('归中失败：' + e.message); }
};

$('#btn-reset-calib').onclick = async () => {
  if (!confirm('重置校准：\n把当前所有轴的行程恢复为 0%~100%、方向正向、速度上限 9999。\n（轴列表和型号不变）\n\n确定？')) return;
  try {
    const r = await api('/api/calibration/reset', {});
    await poll();
    openCalib();
    log('校准已重置为默认（0~100% / 正向 / 9999）');
  } catch (e) { alert('重置失败：' + e.message); }
};

$('#calib-save').onclick = async () => {
  const axes = {};
  document.querySelectorAll('#calib-table tr.calib-row').forEach(tr => {
    const code = (tr.querySelector('.c-code').value || '').trim().toUpperCase();
    if (!code) return;
    axes[code] = {
      enabled: tr.querySelector('.c-en').checked,
      invert: tr.querySelector('.c-inv').checked,
      min: Number(tr.querySelector('.c-min').value) / 100,
      max: Number(tr.querySelector('.c-max').value) / 100,
      maxspeed: Number(tr.querySelector('.c-spd').value),
    };
  });
  if (!Object.keys(axes).length) { alert('至少要有一个轴'); return; }
  try {
    const r = await api('/api/calibration', {
      axes,
      device: (state && state.calib && state.calib.device) || 'OSR2',
      profile: (state && state.calib && state.calib.profile) || 'CUSTOM',
    });
    $('#calib-modal').hidden = true;
    const parts = Object.keys(axes).map(a => a + (axes[a].enabled ? '' : '(关)') + (axes[a].invert ? '(反)' : ''));
    log('校准已保存：' + parts.join(' '));
    await poll();
  } catch (e) { alert('保存失败：' + e.message); }
};

// ---------------- 卡片拖拽布局 ----------------
let _dragReady = false;
function initDragLayout() {
  if (_dragReady) return;
  const stack = document.querySelector('.console-grid .stack');
  if (!stack) return;
  _dragReady = true;
  const key = 'osr_card_order';
  const apply = () => {
    let order = [];
    try { order = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { }
    if (!Array.isArray(order) || !order.length) return;
    order.forEach(id => {
      const el = stack.querySelector(`[data-card="${id}"]`);
      if (el) stack.appendChild(el);
    });
  };
  const cards = [...stack.children];
  cards.forEach((el, i) => {
    el.setAttribute('draggable', 'true');
    el.dataset.card = el.dataset.card || ('c' + i);
    el.style.cursor = 'grab';
    el.addEventListener('dragstart', (e) => {
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      const order = [...stack.children].map(c => c.dataset.card);
      try { localStorage.setItem(key, JSON.stringify(order)); } catch (e) { }
      log('布局已保存');
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      const after = [...stack.children].filter(c => c !== el);
      const rect = el.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      if (before) stack.insertBefore(el, el.previousSibling === after[after.length - 1] ? el : el);
    });
  });
  stack.addEventListener('dragover', (e) => {
    e.preventDefault();
    const dragging = stack.querySelector('.dragging');
    if (!dragging) return;
    const siblings = [...stack.querySelectorAll('.card:not(.dragging)')];
    const next = siblings.find(s => e.clientY < s.getBoundingClientRect().top + s.offsetHeight / 2);
    if (next) stack.insertBefore(dragging, next); else stack.appendChild(dragging);
  });
  apply();
}

// ---------------- 3D 预览（透视投影 + 光照着色，跟随设备实时位置） ----------------
const view3d = {
  cur: { L0: 0.5, R1: 0.5, R2: 0.5, R0: 0.5 },
  vel: { L0: 0, R1: 0, R2: 0, R0: 0 },
  err: null, hudAt: 0,
};

const V3D_CAM = { eye: [0.52, 0.94, 2.30], target: [0, 0.60, 0], fov: 0.78 };
const V3D_LIGHT = (() => { const l = [-0.42, 0.86, 0.42]; const n = Math.hypot(l[0], l[1], l[2]); return [l[0] / n, l[1] / n, l[2] / n]; })();

function v3sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function v3dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function v3cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function v3norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

function rot3(rx, ry, rz) {
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  return [
    cy * cz, cz * sx * sy - cx * sz, cx * cz * sy + sx * sz,
    cy * sz, cx * cz + sx * sy * sz, -cz * sx + cx * sy * sz,
    -sy, cy * sx, cx * cy,
  ];
}
function apply3(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

const V3D_FACES = [
  { n: [0, 0, 1], c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { n: [0, 0, -1], c: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
  { n: [1, 0, 0], c: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { n: [-1, 0, 0], c: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { n: [0, 1, 0], c: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { n: [0, -1, 0], c: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
];

/* 把一块长方体拆成 6 个面塞进 faces（世界坐标 + 法线 + 颜色） */
function pushBox3d(out, center, size, color, rot) {
  const m = rot3(rot ? rot[0] : 0, rot ? rot[1] : 0, rot ? rot[2] : 0);
  const h = [size[0] / 2, size[1] / 2, size[2] / 2];
  for (const f of V3D_FACES) {
    const nrm = apply3(m, f.n);
    const pts = f.c.map(c => {
      const q = apply3(m, [c[0] * h[0], c[1] * h[1], c[2] * h[2]]);
      return [q[0] + center[0], q[1] + center[1], q[2] + center[2]];
    });
    out.push({ pts, nrm, color });
  }
}

/* 沿 +Z 的圆柱：侧面 N 个四边形 + 前后两个多边形盖，法线按径向给，能吃到同一套光照 */
function pushCylinder3d(out, center, radius, length, color, rot, segments) {
  const N = segments || 14;
  const m = rot3(rot ? rot[0] : 0, rot ? rot[1] : 0, rot ? rot[2] : 0);
  const z0 = -length / 2, z1 = length / 2;
  const pt = (a, z) => {
    const local = [Math.cos(a) * radius, Math.sin(a) * radius, z];
    const q = apply3(m, local);
    return [q[0] + center[0], q[1] + center[1], q[2] + center[2]];
  };
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    const nrm = apply3(m, [Math.cos(am), Math.sin(am), 0]);
    out.push({ pts: [pt(a0, z0), pt(a1, z0), pt(a1, z1), pt(a0, z1)], nrm, color });
  }
  const capF = [], capB = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    capF.push(pt(a, z1));
    capB.unshift(pt(a, z0));
  }
  out.push({ pts: capF, nrm: apply3(m, [0, 0, 1]), color });
  out.push({ pts: capB, nrm: apply3(m, [0, 0, -1]), color });
}
function shade(hex, k) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const f = v => Math.max(0, Math.min(255, Math.round(v * k)));
  return 'rgb(' + f(r) + ',' + f(g) + ',' + f(b) + ')';
}

function drawStroker3d(canvas) {
  if (!canvas) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = Math.round(canvas.clientWidth || 0);
  const ch = Math.round(canvas.clientHeight || 0);
  if (!cw || !ch) return;
  const bw = Math.round(cw * dpr), bh = Math.round(ch * dpr);
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cw, ch);

  const eye = V3D_CAM.eye, tgt = V3D_CAM.target;
  const fwd = v3norm(v3sub(tgt, eye));
  const right = v3norm(v3cross(fwd, [0, 1, 0]));
  const up = v3cross(right, fwd);
  const focal = (ch / 2) / Math.tan(V3D_CAM.fov / 2);

  const toCam = (p) => {
    const d = v3sub(p, eye);
    return [v3dot(d, right), v3dot(d, up), v3dot(d, fwd)];
  };
  const toScreen = (c) => [cw / 2 + (c[0] * focal) / Math.max(0.05, c[2]), ch / 2 - (c[1] * focal) / Math.max(0.05, c[2])];

  // 地面网格
  g.lineWidth = 1;
  g.strokeStyle = 'rgba(120,140,190,0.10)';
  for (let i = -3; i <= 3; i++) {
    const t = i * 0.26;
    const a = toScreen(toCam([t, 0, -1.4])), b = toScreen(toCam([t, 0, 1.1]));
    g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
    const c = toScreen(toCam([-1.12, 0, t])), d2 = toScreen(toCam([1.12, 0, t]));
    g.beginPath(); g.moveTo(c[0], c[1]); g.lineTo(d2[0], d2[1]); g.stroke();
  }

  // 地面阴影
  const sh = toCam([0, 0.004, 0.06]);
  const shp = toScreen(sh);
  const rr = (focal / Math.max(0.05, sh[2])) * 0.78;
  const grd = g.createRadialGradient(shp[0], shp[1], rr * 0.15, shp[0], shp[1], rr);
  grd.addColorStop(0, 'rgba(0,0,0,0.55)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.beginPath(); g.ellipse(shp[0], shp[1], rr, rr * 0.34, 0, 0, Math.PI * 2); g.fill();

  const P = view3d.cur;
  const faces = [];

  // 底座
  pushBox3d(faces, [0, 0.05, 0], [1.30, 0.09, 0.80], '#333a52');
  pushBox3d(faces, [0, 0.106, 0], [1.06, 0.022, 0.60], '#3d4560');
  // 两根立柱 + 顶梁
  pushBox3d(faces, [-0.45, 0.66, 0.02], [0.085, 1.02, 0.10], '#3a4260');
  pushBox3d(faces, [0.45, 0.66, 0.02], [0.085, 1.02, 0.10], '#3a4260');
  pushBox3d(faces, [0, 1.19, 0.02], [0.98, 0.065, 0.105], '#3a4260');

  // 滑座：L0 决定高度，R1 绕 X 俯仰、R2 绕 Z 侧倾、R0 绕 Y 旋转
  const y = 0.30 + Math.max(0, Math.min(1, P.L0)) * 0.76;
  const tiltX = (0.5 - P.R1) * 0.55;
  const tiltZ = (P.R2 - 0.5) * 0.55;
  const yaw = (P.R0 - 0.5) * 0.7;
  const rot = [tiltX, yaw, tiltZ];

  pushBox3d(faces, [0, y, 0.02], [0.78, 0.22, 0.22], '#4b3fb0', rot);        // 滑座主体
  pushBox3d(faces, [0, y + 0.115, 0.02], [0.80, 0.03, 0.24], '#6f57e8', rot); // 顶盖
  pushBox3d(faces, [0, y - 0.10, 0.02], [0.72, 0.03, 0.22], '#3a3193', rot); // 底缘
  pushCylinder3d(faces, [0, y, 0.30], 0.102, 0.34, '#8f74ff', rot, 16);       // 套筒（圆柱）
  pushCylinder3d(faces, [0, y, 0.475], 0.126, 0.045, '#b7a6ff', rot, 16);      // 前端法兰
  pushCylinder3d(faces, [0, y, 0.145], 0.118, 0.05, '#5b4bd0', rot, 16);      // 后端接口
  pushBox3d(faces, [0, y, -0.14], [0.16, 0.16, 0.08], '#3b3292', rot);       // 后部配重
  pushBox3d(faces, [0, y + 0.17, -0.08], [0.09, 0.12, 0.09], '#2f2a72', rot);// 上方小件
  pushBox3d(faces, [0.33, 0.19, 0.14], [0.24, 0.16, 0.22], '#333a52');        // 底座电机箱
  pushBox3d(faces, [-0.33, 0.19, 0.14], [0.24, 0.16, 0.22], '#333a52');
  // 滑座在两柱上的位置指示（贴柱、小）
  pushBox3d(faces, [-0.45, y, 0.05], [0.075, 0.05, 0.02], '#3ddc97');
  pushBox3d(faces, [0.45, y, 0.05], [0.075, 0.05, 0.02], '#3ddc97');

  // 投影 + 背面剔除 + 深度排序
  const items = [];
  for (const f of faces) {
    const c0 = toCam(f.pts[0]);
    const ctr = toCam([
      (f.pts[0][0] + f.pts[1][0] + f.pts[2][0] + f.pts[3][0]) / 4,
      (f.pts[0][1] + f.pts[1][1] + f.pts[2][1] + f.pts[3][1]) / 4,
      (f.pts[0][2] + f.pts[1][2] + f.pts[2][2] + f.pts[3][2]) / 4,
    ]);
    if (v3dot(f.nrm, v3sub(eye, f.pts[0])) <= 0) continue;   // 背向相机
    items.push({ screen: f.pts.map(p => toScreen(toCam(p))), depth: ctr[2], nrm: f.nrm, color: f.color });
  }
  items.sort((a, b) => b.depth - a.depth);

  for (const it of items) {
    const lam = Math.max(0, v3dot(it.nrm, V3D_LIGHT));
    const k = 0.30 + 0.78 * lam;
    g.fillStyle = shade(it.color, k);
    g.beginPath();
    g.moveTo(it.screen[0][0], it.screen[0][1]);
    for (let i = 1; i < it.screen.length; i++) g.lineTo(it.screen[i][0], it.screen[i][1]);
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(8,10,16,0.55)';
    g.lineWidth = 1;
    g.stroke();
  }

  if (view3d.err) {
    g.fillStyle = '#ff5d6c';
    g.font = '12px "Microsoft YaHei"';
    g.fillText(String(view3d.err).slice(0, 40), 12, ch - 10);
  }
}

function updateV3dHud() {
  const set = (id, v) => { const el = $('#' + id); if (el) el.textContent = Math.round(v * 100) + '%'; };
  set('v3d-l0', view3d.cur.L0); set('v3d-r1', view3d.cur.R1); set('v3d-r2', view3d.cur.R2);
}

function global_Device3D_ok() {
  return !!(window.Device3D && Device3D.ready);
}

// ---------------- 3D 预览开关（关掉可释放模型内存与 WebGL 显存） ----------------
let previewOn = (function () { try { return localStorage.getItem('osr_3d_preview') !== '0'; } catch (e) { return true; } })();

async function startPreview() {
  const hint = $('#v3d-state');
  const off = $('#v3d-off');
  if (!window.Device3D) return;
  let canvas = $('#view3d');
  if (!canvas) {
    // 关闭预览时画布被移除，这里重新建一个（复用同一个 WebGL 上下文会失败）
    canvas = document.createElement('canvas');
    canvas.id = 'view3d';
    canvas.className = 'sl-canvas';
    const host = off && off.parentNode ? off.parentNode : null;
    if (host) host.insertBefore(canvas, off);
    else return;
  }
  if (off) off.hidden = true;
  canvas.hidden = false;
  canvas.style.display = '';
  if (hint) hint.textContent = '正在载入原版模型…';
  const ok = await Device3D.init(canvas, '/static/device-osr2.bin');
  if (!ok) {
    if (hint) hint.textContent = '模型载入失败：' + (Device3D.error || '未知');
    return;
  }
  Device3D.paused = false;
  if (hint) hint.textContent = '跟随设备实时位置';
  // 调试/自检用：window.__v3dInfo() 返回模型在画面里的占比与偏移
  window.__v3dInfo = () => {
    try {
      return { fitted: Device3D.projectedBBox(), fit: Device3D.fitInfo || null };
    } catch (e) { return { error: String(e && e.message) }; }
  };
}

function stopPreview() {
  const hint = $('#v3d-state');
  const off = $('#v3d-off');
  try { Device3D.dispose(); } catch (e) { }
  if (off) off.hidden = false;
  if (hint) hint.textContent = '预览已关闭（省内存）';
  if ($('#v3d-fps')) $('#v3d-fps').textContent = '';
}

async function applyPreviewSetting(want, silent) {
  previewOn = !!want;
  try { localStorage.setItem('osr_3d_preview', previewOn ? '1' : '0'); } catch (e) { }
  const cb = $('#v3d-toggle');
  if (cb) cb.checked = previewOn;
  if (previewOn) await startPreview();
  else stopPreview();
  if (!silent) log(previewOn ? '3D 预览已开启' : '3D 预览已关闭，模型与显存已释放');
}

// 载入原版 OSR2 建模（来自 ayva 打包文件的 Blender OBJ），失败则回落到 2D 画法
// ---------------- 3D 部件显示开关 ----------------
const V3D_MESHES = [
  ['base', '底座'], ['lid', '上盖'], ['pitcher', '管身'], ['receiver', '接收器'],
  ['modCase', '外壳'], ['arm', '手臂'], ['pitcherArm', '俯仰臂'], ['pitcherLinkArm', '连杆'],
  ['bearing', '轴承'], ['joint', '关节'],
];
let hiddenParts = [];
try {
  const saved = localStorage.getItem('osr_3d_hidden');
  // 没存过就沿用引擎的默认隐藏项（例如挡住连杆的竖盖板），而不是强制清空
  hiddenParts = saved !== null
    ? (JSON.parse(saved) || [])
    : (window.Device3D && Device3D.hidden ? Device3D.hidden.slice() : []);
} catch (e) { hiddenParts = []; }

function renderPartToggles() {
  const box = $('#v3d-parts-list');
  if (!box) return;
  box.innerHTML = V3D_MESHES.map(function (pair) {
    const name = pair[0], label = pair[1];
    const checked = hiddenParts.indexOf(name) < 0 ? 'checked' : '';
    return '<label title="' + name + '"><input type="checkbox" data-mesh="' + name + '" ' + checked + ' />' + label + '</label>';
  }).join('');
  box.querySelectorAll('input[data-mesh]').forEach(function (cb) {
    cb.addEventListener('change', function () {
      const name = cb.dataset.mesh;
      hiddenParts = hiddenParts.filter(function (n) { return n !== name; });
      if (!cb.checked) hiddenParts.push(name);
      try { localStorage.setItem('osr_3d_hidden', JSON.stringify(hiddenParts)); } catch (e) { }
      if (window.Device3D) { Device3D.hidden = hiddenParts.slice(); Device3D.dirty = true; }
    });
  });
}

(function initDevice3d() {
  if (!window.Device3D) return;
  const cb = $('#v3d-toggle');
  if (cb) {
    cb.checked = previewOn;
    cb.addEventListener('change', () => { applyPreviewSetting(cb.checked); });
  }
  if (window.Device3D) Device3D.hidden = hiddenParts.slice();
  renderPartToggles();
  // 3D 放大（全屏）：Esc 退出
  const fullBtn = $('#v3d-full');
  const viewerCard = document.querySelector('.sl-viewer-card');
  function setFull(on) {
    if (!viewerCard) return;
    viewerCard.classList.toggle('is-full', !!on);
    document.body.classList.toggle('sl-lock', !!on);
    if (fullBtn) fullBtn.textContent = on ? '⤢' : '⛶';
    try { if (window.Device3D && Device3D.resize) setTimeout(function () { Device3D.resize(); Device3D.dirty = true; }, 60); } catch (e) { }
    try { localStorage.setItem('osr_3d_full', on ? '1' : '0'); } catch (e) { }
  }
  if (fullBtn) {
    fullBtn.addEventListener('click', function () { setFull(!viewerCard.classList.contains('is-full')); });
  }
  // 捕获阶段拦下 Esc：只退出全屏，不要连带触发页面上的「急停」
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && viewerCard && viewerCard.classList.contains('is-full')) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      setFull(false);
    }
  }, true);
  window.addEventListener('resize', function () {
    try { if (window.Device3D && Device3D.resize) Device3D.resize(); } catch (e) { }
  });

  const dbg = document.getElementById('v3d-dbg');
  if (dbg) {
    dbg.checked = localStorage.getItem('osr_3d_dbg') === '1';
    if (window.Device3D) Device3D.debugColors = dbg.checked;
    dbg.addEventListener('change', function () {
      try { localStorage.setItem('osr_3d_dbg', dbg.checked ? '1' : '0'); } catch (e) { }
      if (window.Device3D) { Device3D.debugColors = dbg.checked; Device3D.dirty = true; }
    });
  }
  const lc = $('#v3d-linkchain');
  if (lc) {
    const shown = localStorage.getItem('osr_3d_linkchain') !== '0';   // 默认显示
    lc.checked = shown;
    const apply = (on) => {
      if (!window.Device3D) return;
      // 连杆两端的轴承/关节固定不显示；这个开关只管连杆杆身
      const base = ['linkStartBearing', 'linkEndBearing', 'linkJoint'];
      Device3D.hiddenParts = on ? base : base.concat(['pitcherLinkArm']);
      Device3D.dirty = true;
    };
    apply(shown);
    lc.addEventListener('change', () => {
      try { localStorage.setItem('osr_3d_linkchain', lc.checked ? '1' : '0'); } catch (e) { }
      apply(lc.checked);
    });
  }
  applyPreviewSetting(previewOn, true);
})();

function tick3d() {
  try {
    const st = (typeof state !== 'undefined' && state) ? state : null;
    const targets = { L0: 0.5, R1: 0.5, R2: 0.5, R0: 0.5 };
    if (st && st.position) {
      for (const k in targets) {
        const v = Number(st.position[k]);
        if (Number.isFinite(v)) targets[k] = v;
      }
    }
    const pageEl = document.getElementById('page-strokes');
    const onStrokes = !!(pageEl && pageEl.classList.contains('active'));
    const d3 = window.Device3D;
    if (onStrokes && !document.hidden) {
      if (d3 && d3.ready && !d3.paused) {
        d3.setTarget(targets);
        d3.update();
      } else {
        drawStroker3d($('#view3d'));
      }
    }
    const now = performance.now();
    if (now - view3d.hudAt > 120) {
      view3d.hudAt = now;
      updateV3dHud();
      if (d3 && d3.fps && $('#v3d-fps')) $('#v3d-fps').textContent = d3.fps + ' fps';
    }
    view3d.err = null;
  } catch (e) {
    view3d.err = e && e.message;
  }
  requestAnimationFrame(tick3d);
}

// ---------------- 自由播放 ----------------
let fpOn = false;

async function toggleFreeplay(force) {
  const want = (force === undefined) ? !fpOn : !!force;
  try {
    const r = await api('/api/freeplay', { on: want, interval: Number($('#fp-interval').value) || 18 });
    fpOn = r.freeplay;
    const b = $('#btn-freeplay');
    if (b) {
      b.textContent = fpOn ? '■ 停止自由播放（Space）' : '▶ 自由播放（Space）';
      b.classList.toggle('danger', fpOn);
    }
    log(fpOn ? `自由播放开始，每 ${r.interval} 秒随机换动作` : '自由播放已停止');
  } catch (e) { log('自由播放失败：' + e.message); }
}

if ($('#btn-freeplay')) $('#btn-freeplay').addEventListener('click', () => toggleFreeplay());
if ($('#fp-interval')) $('#fp-interval').addEventListener('input', (e) => {
  $('#fp-interval-val').textContent = e.target.value + ' 秒';
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
    e.preventDefault();
    const onStrokes = document.querySelector('.page.active') &&
      document.querySelector('.page.active').id === 'page-strokes';
    if (onStrokes) toggleFreeplay();
  }
});






// ---------------- 动作组编辑 ----------------
let geActive = null;
let geTab = 'mine';        // mine | ai

// 标签页切换：我的动作组 / AI 暂存
function geShowTab(which) {
  geTab = which === 'ai' ? 'ai' : 'mine';
  const mine = $('#ge-pane-mine'), ai = $('#ge-pane-ai');
  if (mine) mine.hidden = geTab !== 'mine';
  if (ai) ai.hidden = geTab !== 'ai';
  const bm = $('#ge-tab-mine'), ba = $('#ge-tab-ai');
  if (bm) bm.classList.toggle('active', geTab === 'mine');
  if (ba) ba.classList.toggle('active', geTab === 'ai');
  if (geTab === 'ai') aiLoad();
}

// AI 暂存组：拉列表 + 渲染（界面照动作组编辑的样子）
async function aiLoad() {
  let r;
  try { r = await api('/api/plugin/ai-groups'); } catch (e) { return; }
  const items = r.groups || [];
  const badge = $('#ge-ai-badge');
  if (badge) {
    badge.textContent = items.length;
    badge.classList.toggle('zero', items.length === 0);
  }
  const hint = $('#ai-hint');
  if (hint) hint.textContent = items.length ? `暂存区 ${items.length} / ${r.max || 30} 组` : '';
  const box = $('#ai-list');
  if (!box) return;
  if (!items.length) {
    box.innerHTML = '<div class="ai-empty">还没有 AI 暂存的组。<br>在酒馆里让 AI 用「编排」并把这一段存下来，就会出现在这里。</div>';
    return;
  }
  box.innerHTML = items.map(g => `
    <div class="ai-item" data-id="${g.id}">
      <div class="ai-head">
        <span class="ai-name">${escHtml(g.name || 'AI 编排')}</span>
        <span class="ge-badge">${g.count} 张</span>
        <span class="ai-meta">${escHtml(g.at || '')}${g.source ? ' · ' + escHtml(g.source) : ''}</span>
      </div>
      <div class="ai-cards">${(g.cards || []).map(c =>
        `${escHtml(c.cn || c.stroke)}<span class="hint">（${c.bpm}BPM·${Math.round((c.gain || 1) * 100)}%·${c.secs}s）</span>`).join(' → ')}</div>
      <div class="ai-ops">
        <button class="btn tiny ai-play">▶ 试播</button>
        <button class="btn tiny primary ai-save">保存为我的动作组</button>
        <button class="btn tiny danger ai-del">删除</button>
      </div>
    </div>`).join('');

  box.querySelectorAll('.ai-item').forEach(el => {
    const id = el.dataset.id;
    el.querySelector('.ai-play').onclick = async () => {
      try {
        await api('/api/plugin/ai-group/preview', { id });
        log('试播 AI 暂存组');
      } catch (e) { alert('试播失败：' + e.message); }
    };
    el.querySelector('.ai-save').onclick = async () => {
      try {
        const r2 = await api('/api/plugin/ai-group/promote', { id });
        log(`已存为我的动作组：${r2.group}（${r2.count} 张）`);
        await geLoad();
        await aiLoad();
      } catch (e) { alert('保存失败：' + e.message); }
    };
    el.querySelector('.ai-del').onclick = async () => {
      if (!confirm('删除这条 AI 暂存？')) return;
      try {
        await api('/api/plugin/ai-group/delete', { id });
        await aiLoad();
      } catch (e) { alert('删除失败：' + e.message); }
    };
  });
}

async function geLoad() {
  const r = await api('/api/plugin/list');
  const sel = $('#ge-group');
  if (!sel) return;
  const names = r.groups || [];
  if (!geActive || !names.includes(geActive)) geActive = r.active || names[0];
  sel.innerHTML = names.map(g => `<option value="${g}" ${g === geActive ? 'selected' : ''}>${g}</option>`).join('');
  // 多组并列显示
  const chips = $('#ge-groups');
  if (chips) {
    chips.innerHTML = names.map(g => {
      const n = ((r.cards || {})[g] || []).length;
      return `<button class="chip ${g === geActive ? 'active' : ''}" data-g="${g}">${g}<span class="chip-n">${n}</span></button>`;
    }).join('');
    chips.querySelectorAll('.chip').forEach(b => {
      b.onclick = () => { geActive = b.dataset.g; geLoad(); };
    });
  }

  const cards = (r.cards || {})[geActive] || [];
  const total = cards.reduce((a, c) => a + (Number(c.secs) || 0), 0);
  const cnt = $('#ge-count');
  if (cnt) {
    cnt.textContent = cards.length
      ? `${cards.length} 张 · 共 ${Math.round(total)} 秒`
      : '空组';
  }
  const box = $('#ge-list');
  box.innerHTML = cards.length ? '' : '<p class="hint">这一组还没有动作，下面挑一个加进来</p>';
  cards.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'ge-row';
    const sub = [
      c.stroke_cn || c.stroke || '',
      `${c.bpm || '-'} BPM`,
      `${Math.round((c.gain || 1) * 100)}%`,
      `${c.secs || '-'}s`,
    ].filter(Boolean).join(' · ');
    row.innerHTML = `<span class="ge-idx">${i + 1}</span>
      <span class="ge-main">
        <span class="ge-name" title="${escHtml(c.name)}">${escHtml(c.name)}</span>
        <span class="ge-sub">${escHtml(sub)}</span>
      </span>
      <button class="btn tiny danger" title="移除">✕</button>`;
    row.querySelector('button').onclick = async () => {
      await api('/api/plugin/group/edit', { action: 'remove', name: geActive, index: i });
      geLoad(); log(`已从「${geActive}」移除：${c.name}`);
    };
    box.appendChild(row);
  });
  // 动作下拉
  const ss = $('#ge-stroke');
  if (ss && !ss.options.length) {
    if (!strokes.length) { try { await loadStrokes(); } catch (e) { } }
    ss.innerHTML = strokes.map(s => `<option value="${s.name}">${s.cn}</option>`).join('');
  }
  updateScrollHints();
}

if ($('#ge-group')) $('#ge-group').addEventListener('change', (e) => { geActive = e.target.value; geLoad(); });
if ($('#ge-add')) $('#ge-add').addEventListener('click', async () => {
  try {
    await api('/api/plugin/group/edit', {
      action: 'add', name: geActive, stroke: $('#ge-stroke').value,
      bpm: Number($('#ge-bpm').value), gain: Number($('#ge-gain').value) / 100,
      secs: Number($('#ge-secs').value),
    });
    geLoad(); log(`已加入「${geActive}」`);
  } catch (e) { alert('加入失败：' + e.message); }
});
if ($('#ge-create')) $('#ge-create').addEventListener('click', async () => {
  const name = prompt('新组名（同时是触发词）', '亲热');
  if (!name) return;
  try {
    const r = await api('/api/plugin/group/edit', { action: 'create', name });
    geActive = r.active; geLoad(); loadPlugin(); log(`已新建组：${name}`);
  } catch (e) { alert('新建失败：' + e.message); }
});
if ($('#ge-rename')) $('#ge-rename').addEventListener('click', async () => {
  const name = prompt('新的组名（就是新的触发词）', geActive);
  if (!name || name === geActive) return;
  try {
    const r = await api('/api/plugin/group/edit', { action: 'rename', old: geActive, new: name });
    geActive = r.active; geLoad(); loadPlugin(); log(`已重命名：${name}（触发词同步）`);
  } catch (e) { alert('重命名失败：' + e.message); }
});
if ($('#ge-dup')) $('#ge-dup').addEventListener('click', async () => {
  const name = prompt('复制为（新组名 = 新触发词）', geActive + '·副本');
  if (!name) return;
  try {
    const r = await api('/api/plugin/group/edit', { action: 'duplicate', name: geActive, new: name });
    geActive = r.active; geLoad(); loadPlugin(); log(`已复制组：${name}`);
  } catch (e) { alert('复制失败：' + e.message); }
});

if ($('#ge-del')) $('#ge-del').addEventListener('click', async () => {
  if (!confirm(`删除动作组「${geActive}」？`)) return;
  try {
    await api('/api/plugin/group/edit', { action: 'delete', name: geActive });
    geActive = null; geLoad(); loadPlugin(); log('已删除组');
  } catch (e) { alert('删除失败：' + e.message); }
});

// 标签页：我的 / AI 暂存
if ($('#ge-tab-mine')) $('#ge-tab-mine').addEventListener('click', () => geShowTab('mine'));
if ($('#ge-tab-ai')) $('#ge-tab-ai').addEventListener('click', () => geShowTab('ai'));
if ($('#ai-clear')) $('#ai-clear').addEventListener('click', async () => {
  const r = await api('/api/plugin/ai-groups').catch(() => null);
  const n = (r && r.count) || 0;
  if (!n) { log('AI 暂存区已经是空的'); return; }
  if (!confirm(`清空 AI 暂存区的 ${n} 组？（不影响你的动作组）`)) return;
  try {
    await api('/api/plugin/ai-group/clear');
    log(`已清空 AI 暂存区（${n} 组）`);
    await aiLoad();
  } catch (e) { alert('清空失败：' + e.message); }
});
// 首次进来先拉一次暂存数量，好显示角标
setTimeout(() => { try { aiLoad(); } catch (e) { } }, 1200);

// ---------------- 联动：关键词 → 动作组 ----------------
let kwBindings = [];        // 服务器当前绑定
let kwGroups = [];          // 服务器当前分组名
let lkHistory = [];         // 最近触发（本地记录 + 服务器 last）
let lkBusy = false;
let lkSeenLast = null;   // 已同步过的服务器最近触发（用于补外部触发记录）
let lkServerLastAt = null;  // 服务器当前记录的最近触发时间，清空本地记录后用它挡住回填

function lkStoreHistory() {
  try { localStorage.setItem('osr_lk_history', JSON.stringify(lkHistory.slice(0, 20))); } catch (e) { }
}
function lkLoadHistory() {
  try {
    const raw = localStorage.getItem('osr_lk_history');
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) lkHistory = arr.slice(0, 20);
  } catch (e) { lkHistory = []; }
}

function renderHistory() {
  const box = $('#lk-history');
  if (!box) return;
  if (!lkHistory.length) {
    box.innerHTML = '<div class="lk-empty">还没有触发记录。<br>在上面「测试触发」里试一段文本，命中就会出现在这里。</div>';
    return;
  }
  box.innerHTML = lkHistory.slice(0, 8).map(h => `<div class="lk-hi">
      <span class="t">${escHtml(h.at || '')}</span><span class="g">${escHtml(h.group || '')}</span>
      <span class="x" title="${escHtml(h.text || '')}">${escHtml(h.text || '')}</span>
    </div>`).join('');
  updateScrollHints();
}

function lkSetFlag(el, kind, text) {
  if (!el) return;
  el.textContent = text || '';
  el.className = 'lk-flag' + (kind ? ' ' + kind : '');
}

function renderKwList() {
  const box = $('#kw-list');
  if (!box) return;
  const q = ($('#kw-filter') ? $('#kw-filter').value : '').trim().toLowerCase();
  const info = $('#kw-filter-info');
  const bs = kwBindings.filter(b => !q
    || String(b.keyword || '').toLowerCase().includes(q)
    || String(b.group || '').toLowerCase().includes(q));
  if (info) info.textContent = q ? `筛出 ${bs.length} / ${kwBindings.length}` : '';

  if (!kwBindings.length) {
    box.innerHTML = `<div class="lk-empty">还没有绑定。<br>填一个关键词 → 选动作组 → 点「绑定」。<br>
      也可以完全不绑定：正文里直接出现分组名（${escHtml(kwGroups.join(' / ') || '—')}）也会触发。</div>`;
    return;
  }
  if (!bs.length) {
    box.innerHTML = `<div class="lk-empty">没有匹配「${escHtml(q)}」的关键词</div>`;
    return;
  }
  box.innerHTML = bs.map(b => `<div class="kw-row">
      <span class="kw-word">${escHtml(b.keyword)}</span>
      <span class="kw-arrow">→</span>
      <span class="kw-group">${escHtml(b.group)}</span>
      <button class="btn tiny danger" data-kw="${escHtml(b.keyword)}" title="解除绑定">✕</button>
    </div>`).join('');
  box.querySelectorAll('button[data-kw]').forEach(btn => {
    btn.onclick = () => unbindKeyword(btn.dataset.kw);
  });
  updateScrollHints();
}

// 滚动区提示：内容真的超出时才显示「滚轮浏览」，未滚到底时给底部渐隐
function updateScrollHints() {
  const pairs = [['#kw-list', '#kw-scrollhint'], ['#ge-list', '#ge-scrollhint'], ['#lk-history', '#lk-histhint'], ['#presets', '#cs-preset-hint'], ['#stroke-grid', '#stroke-scrollhint']];
  pairs.forEach(pair => {
    const el = $(pair[0]);
    if (!el) return;
    const hint = $(pair[1]);
    const more = el.scrollHeight - el.clientHeight > 6;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
    if (hint) hint.hidden = !more;
    el.classList.toggle('lk-hasmore', more && !atBottom);
  });
}

['#kw-list', '#ge-list'].forEach(sel => {
  const el = $(sel);
  if (el) el.addEventListener('scroll', updateScrollHints, { passive: true });
});
window.addEventListener('resize', () => { try { updateScrollHints(); } catch (e) { } });

async function loadPlugin() {
  try {
    const r = await api('/api/plugin/list');
    kwGroups = r.groups || [];
    kwBindings = r.bindings || [];

    const sel = $('#kw-group');
    if (sel) {
      const cur = sel.value;
      sel.innerHTML = kwGroups.map(g => `<option value="${escHtml(g)}">${escHtml(g)}</option>`).join('');
      if (cur && kwGroups.includes(cur)) sel.value = cur;
    }
    const cnt = $('#kw-count');
    if (cnt) cnt.textContent = kwBindings.length;

    renderKwList();
    try { geLoad(); } catch (e) { }

    if (r.last && r.last.at) {
      const hint = $('#kw-last');
      if (hint) hint.textContent = `上次 ${r.last.group} · ${r.last.at}`;
      // 服务器记的是"最近一次触发"，本地没这条就补进历史——酒馆等外部触发也能看到
      lkServerLastAt = r.last.at;
      if (r.last.at !== lkSeenLast) {
        lkSeenLast = r.last.at;
        const dup = lkHistory.some(h => h.at === r.last.at && h.group === r.last.group);
        if (!dup) {
          lkHistory.unshift({ at: r.last.at, group: r.last.group, text: r.last.text || '（外部触发）' });
          lkHistory = lkHistory.slice(0, 20);
          lkStoreHistory();
        }
      }
    }
    renderHistory();
  } catch (e) {
    log('联动面板加载失败：' + e.message);
  }
}

async function bindKeyword() {
  const inp = $('#kw-word');
  const kw = (inp ? inp.value : '').trim();
  const grp = $('#kw-group') ? $('#kw-group').value : '';
  if (!kw) { inp && inp.focus(); log('联动：请先填关键词'); return; }
  if (!grp) { log('联动：还没有动作组，先在下面「动作组编辑」里新建一个'); return; }
  const existed = kwBindings.find(b => b.keyword === kw);
  try {
    await api('/api/plugin/bind', { keyword: kw, group: grp });
    if (inp) inp.value = '';
    log(existed && existed.group !== grp
      ? `联动：已把「${kw}」从「${existed.group}」改绑到「${grp}」`
      : `联动：已绑定「${kw}」→「${grp}」`);
    await loadPlugin();
    if (inp) inp.focus();
  } catch (e) { log('联动绑定失败：' + e.message); }
}

async function unbindKeyword(kw) {
  try {
    await api('/api/plugin/unbind', { keyword: kw });
    log(`联动：已解除「${kw}」`);
    await loadPlugin();
  } catch (e) { log('联动解绑失败：' + e.message); }
}

function setLkHit(kind, html) {
  const hit = $('#lk-hit');
  if (!hit) return;
  if (!html) { hit.hidden = true; hit.innerHTML = ''; return; }
  hit.hidden = false;
  hit.style.borderLeftColor = kind === 'ok' ? 'var(--ok)' : (kind === 'warn' ? 'var(--warn)' : 'var(--bad)');
  hit.innerHTML = html;
}

async function fireTest() {
  if (lkBusy) return;
  const ta = $('#kw-test');
  const text = (ta ? ta.value : '').trim();
  const flag = $('#kw-result');
  if (!text) {
    lkSetFlag(flag, 'warn', '先输入一段文本');
    setLkHit('warn', '把要测的正文粘到上面的输入框里，再点「触发」。');
    if (ta) ta.focus();
    return;
  }
  lkBusy = true;
  lkSetFlag(flag, '', '触发中…');
  try {
    const r = await apiRaw('/api/plugin/trigger', { text });
    if (r.ok) {
      const n = (r.sequence && r.sequence.count) || 0;
      lkSetFlag(flag, 'ok', `命中「${r.group}」`);
      setLkHit('ok', `<b>${escHtml(r.group)}</b> · ${n} 张卡片 · 正在播放
        <span class="hint">（播放中再次触发会切到新组）</span>`);
      log(`联动触发：${r.group}（${n} 张）`);
    } else if (r.reason === 'no_match') {
      const words = kwBindings.map(b => b.keyword).slice(0, 10).join('、') || '（还没绑定任何关键词）';
      lkSetFlag(flag, 'warn', '没有命中');
      setLkHit('warn', `这段文本没有命中任何触发词。<br>
        <span class="hint">现有关键词：${escHtml(words)}<br>
        分组名也算触发词：${escHtml(kwGroups.join(' / ') || '—')}<br>
        想让它命中，就把文本里的词绑到某个组（上面「② 关键词 → 动作组」）。</span>`);
      log('联动测试：没有命中关键词，设备没有动作');
    } else if (r.reason === 'not_connected') {
      lkSetFlag(flag, 'bad', '设备未连接');
      setLkHit('bad', `命中了「${escHtml(r.group)}」，但设备没连上：${escHtml(r.detail || '未知原因')}。
        <br><span class="hint">点页面顶部「连接」后再试。</span>`);
      log(`联动触发失败：设备未连接（${r.detail || ''}）`);
    } else {
      lkSetFlag(flag, 'bad', '触发失败');
      setLkHit('bad', escHtml(r.error || r.reason || '未知原因'));
    }
  } catch (e) {
    lkSetFlag(flag, 'bad', '触发失败');
    setLkHit('bad', escHtml(e.message));
  } finally {
    lkBusy = false;
    try { await loadPlugin(); } catch (e) { }
  }
}

async function lkStop() {
  try {
    await api('/api/stop', { hard: false });
    log('联动：已停止播放');
  } catch (e) { log('停止失败：' + e.message); }
}

// ---- 事件 ----
if ($('#kw-bind')) $('#kw-bind').addEventListener('click', bindKeyword);
if ($('#kw-word')) $('#kw-word').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); bindKeyword(); }
});
if ($('#kw-fire')) $('#kw-fire').addEventListener('click', fireTest);
if ($('#kw-test')) $('#kw-test').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); fireTest(); }
});
if ($('#lk-clear')) $('#lk-clear').addEventListener('click', () => {
  const ta = $('#kw-test');
  if (ta) { ta.value = ''; ta.focus(); }
  lkSetFlag($('#kw-result'), '', '');
  setLkHit('', '');
});
if ($('#lk-stop')) $('#lk-stop').addEventListener('click', lkStop);
if ($('#kw-refresh')) $('#kw-refresh').addEventListener('click', async () => {
  await loadPlugin();
  log('联动：已刷新绑定与分组');
});
if ($('#kw-filter')) $('#kw-filter').addEventListener('input', renderKwList);

if ($('#lk-clear-history')) $('#lk-clear-history').addEventListener('click', () => {
  lkHistory = [];
  lkSeenLast = lkServerLastAt;   // 挡住刚清掉的那条被服务器状态回填
  lkStoreHistory();
  renderHistory();
  log('联动：已清空本机触发记录');
});
document.querySelectorAll('.lk-samples .chip').forEach(b => {
  b.addEventListener('click', () => {
    const ta = $('#kw-test');
    if (ta) { ta.value = b.dataset.sample || ''; ta.focus(); }
  });
});
if ($('#lk-try')) $('#lk-try').addEventListener('click', async () => {
  if (!geActive) return;
  lkSetFlag($('#kw-result'), '', '试播中…');
  try {
    const r = await apiRaw('/api/plugin/trigger', { group: geActive });
    if (r.ok) {
      lkSetFlag($('#kw-result'), 'ok', `播放「${geActive}」`);
      setLkHit('ok', `<b>${escHtml(geActive)}</b> · ${(r.sequence && r.sequence.count) || 0} 张卡片 · 正在播放`);
      log(`联动试播：${geActive}`);
    } else {
      lkSetFlag($('#kw-result'), 'bad', '试播失败');
      setLkHit('bad', escHtml(r.detail || r.error || r.reason || '未知原因'));
    }
  } catch (e) {
    lkSetFlag($('#kw-result'), 'bad', '试播失败');
    setLkHit('bad', escHtml(e.message));
  }
});
document.querySelectorAll('[data-copy]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const src = document.getElementById(btn.dataset.copy);
    if (!src) return;
    const text = src.textContent;
    try {
      await navigator.clipboard.writeText(text);
      const old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = old; }, 1200);
    } catch (e) {
      log('复制失败，请手动选中复制：' + e.message);
    }
  });
});

// 顶部状态条：跟随 /api/state 实时更新
function lkSync(s) {
  if (!s || !$('#lk-conn')) return;
  $('#lk-dot').classList.toggle('on', !!s.connected);
  $('#lk-conn').textContent = s.connected
    ? `已连接 · ${s.backend_detail || s.backend || ''}`
    : '设备未连接';
  let playing = '—';
  if (s.freeplay) playing = '自由播放';
  else if (s.sequence) playing = `${s.sequence.name}（${s.sequence.index}/${s.sequence.total}，剩 ${s.sequence.left}s）`;
  else if (s.stroke) playing = `${s.stroke.cn || s.stroke.name}（剩 ${s.stroke.left}s）`;
  else if (s.preset) playing = `${s.preset.name}（剩 ${s.preset.left}s）`;
  $('#lk-playing').textContent = playing;

  // 打断方式 + 待切换
  const sel = $('#lk-interrupt');
  if (sel && s.interrupt_mode && document.activeElement !== sel && sel.value !== s.interrupt_mode) {
    sel.value = s.interrupt_mode;
  }
  const pend = $('#lk-pending');
  if (pend) {
    if (s.pending_group) {
      pend.textContent = `${s.pending_group}（等「${s.pending_after || '当前动作'}」播完）`;
      pend.className = 'lk-warn';
    } else {
      pend.textContent = '—';
      pend.className = '';
    }
  }

  const link = $('#lk-link');
  const drop = Number(s.dropped_frames || 0);
  if (s.last_link_error) {
    link.textContent = '异常：' + s.last_link_error;
    link.className = 'lk-bad';
  } else if (drop > 0) {
    link.textContent = `拥塞丢帧 ${drop}`;
    link.className = 'lk-warn';
  } else {
    link.textContent = '正常';
    link.className = '';
  }
}
lkLoadHistory();

// 打断方式：改了就存到服务器
(function bindInterruptSelect() {
  const sel = $('#lk-interrupt');
  if (!sel) return;
  sel.addEventListener('change', async () => {
    const mode = sel.value;
    try {
      const r = await api('/api/plugin/interrupt', { mode });
      if (r && r.ok) {
        const label = { boundary: '播完当前动作就切', 'after-group': '播完整组再切', immediate: '立即切' }[mode] || mode;
        log(`动作组打断方式：${label}`);
      }
    } catch (e) {
      log('设置打断方式失败：' + (e && e.message));
    }
  });
})();
// AI 编排（L1）：标记与上限，存到控制器
async function cpLoad() {
  if (!$('#cp-tag')) return;
  try {
    const r = await api('/api/plugin/compose-config');
    const c = (r && r.compose) || {};
    $('#cp-enabled').checked = c.enabled !== false;
    $('#cp-tag').value = c.tag || 'osr-compose';
    $('#cp-cards').value = c.max_cards || 6;
    $('#cp-secs').value = c.max_secs || 60;
    $('#cp-bpm').value = c.bpm_cap || 120;
  } catch (e) { }
}

(function bindComposeBox() {
  const btn = $('#cp-save');
  if (!btn) return;
  const out = $('#cp-state');
  cpLoad();
  btn.addEventListener('click', async () => {
    const body = {
      enabled: $('#cp-enabled').checked,
      tag: ($('#cp-tag').value || '').trim() || 'osr-compose',
      max_cards: Number($('#cp-cards').value) || 6,
      max_secs: Number($('#cp-secs').value) || 60,
      bpm_cap: Number($('#cp-bpm').value) || 120,
    };
    try {
      const r = await api('/api/plugin/compose-config', body);
      const c = (r && r.compose) || {};
      if (out) {
        out.className = 'hint ok';
        out.textContent = `已保存：标记 ${c.tag} · 最多 ${c.max_cards} 段 · 单段 ≤ ${c.max_secs}s · BPM ≤ ${c.bpm_cap}`;
      }
      log(`AI 编排设置已更新：${c.tag}`);
    } catch (e) {
      if (out) { out.className = 'hint bad'; out.textContent = '保存失败：' + (e && e.message); }
    }
  });
})();


// ---------------- 新建 / 编辑动作 ----------------
// editingStroke 非空时进入「编辑」模式，保存走 /api/strokes/update
let editingStroke = null;
const SE_COLORS = { L0: '#7aa2ff', L1: '#7ee0a5', L2: '#ffd479', R0: '#ff9bd2', R1: '#9b8cff', R2: '#5fd7d0' };

function seReadRows() {
  const axes = {};
  document.querySelectorAll('#ns-axes .se-axis').forEach(row => {
    if (row.querySelector('.se-on') && !row.querySelector('.se-on').checked) return;
    const ax = row.dataset.ax;
    const from = Number(row.querySelector('.ns-from').value) / 100;
    const to = Number(row.querySelector('.ns-to').value) / 100;
    axes[ax] = { from, to, phase: Number(row.querySelector('.ns-phase').value), ecc: Number(row.querySelector('.ns-ecc').value) };
  });
  return axes;
}

// 波形示意：pos = mid − half·cos(h + ecc·sin(h))，h = 2π(t·循环数 + phase)
function seDraw() {
  const cv = $('#se-wave');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  // 网格
  ctx.strokeStyle = 'rgba(255,255,255,.07)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = (H * i) / 4;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  const axes = seReadRows();
  const cycles = 2;
  Object.keys(axes).forEach((ax, idx) => {
    const p = axes[ax];
    const mid = (p.from + p.to) / 2, half = (p.to - p.from) / 2;
    ctx.beginPath();
    for (let x = 0; x <= W; x++) {
      const t = x / W;
      const h = 2 * Math.PI * (t * cycles + p.phase);
      const pos = mid - half * Math.cos(h + p.ecc * Math.sin(h));
      const y = H - 8 - pos * (H - 16);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = SE_COLORS[ax] || `hsl(${(idx * 60) % 360},70%,65%)`;
    ctx.lineWidth = 2;
    ctx.stroke();
  });
  const legend = $('#se-legend');
  if (legend) {
    legend.innerHTML = Object.keys(axes).map(ax =>
      `<span class="se-lg"><i style="background:${SE_COLORS[ax] || '#999'}"></i>${ax}</span>`).join('');
  }
}

function openStrokeEditor(existing) {
  editingStroke = existing || null;
  const box = $('#ns-axes');
  box.innerHTML = '';
  const axes = ((state && state.calib && state.calib.order) || ['L0']);
  const params = (existing && existing.params) || {};
  axes.forEach((ax) => {
    const p = params[ax];      // [from,to,phase,ecc]
    const from = p ? Math.round(p[0] * 100) : (ax === 'L0' ? 20 : 50);
    const to = p ? Math.round(p[1] * 100) : (ax === 'L0' ? 80 : 50);
    const phase = p ? p[2] : 0;
    const ecc = p ? p[3] : 0.5;
    const color = SE_COLORS[ax] || '#9aa3b8';
    const row = document.createElement('div');
    row.className = 'se-axis';
    row.dataset.ax = ax;
    row.innerHTML = `
      <div class="se-axis-head">
        <i class="se-dot" style="background:${color}"></i>
        <b>${axisName(ax)}</b><span class="se-code">${ax}</span>
        <label class="se-mini se-flat" style="margin-left:auto"><input type="checkbox" class="se-on" checked /> 启用</label>
      </div>
      <div class="se-row">
        <label>起</label>
        <input type="range" class="ns-from" min="0" max="100" step="1" value="${from}" />
        <b class="se-v ns-from-v">${from}%</b>
        <label>止</label>
        <input type="range" class="ns-to" min="0" max="100" step="1" value="${to}" />
        <b class="se-v ns-to-v">${to}%</b>
      </div>
      <div class="se-row">
        <label>相位</label>
        <input type="range" class="ns-phase" min="0" max="1" step="0.05" value="${phase}" />
        <b class="se-v ns-phase-v">${phase}</b>
        <label>偏心</label>
        <input type="range" class="ns-ecc" min="0" max="1" step="0.05" value="${ecc}" />
        <b class="se-v ns-ecc-v">${ecc}</b>
      </div>`;
    box.appendChild(row);
    row.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('input', () => {
        row.querySelector('.ns-from-v').textContent = row.querySelector('.ns-from').value + '%';
        row.querySelector('.ns-to-v').textContent = row.querySelector('.ns-to').value + '%';
        row.querySelector('.ns-phase-v').textContent = row.querySelector('.ns-phase').value;
        row.querySelector('.ns-ecc-v').textContent = row.querySelector('.ns-ecc').value;
        seDraw();
      });
    });
  });

  const title = $('#se-title');
  const sub = $('#se-sub');
  const nameInput = $('#ns-name');
  const saveBtn = $('#ns-save');
  const idHint = $('#se-id');
  if (existing) {
    if (title) title.textContent = `编辑动作 · ${existing.cn || existing.name}`;
    if (sub) sub.textContent = existing.user ? '自建动作：改完直接生效' : '内置动作：改动存为覆盖层，卡片上的 ↺ 可还原';
    if (saveBtn) saveBtn.textContent = '保存修改';
    nameInput.value = existing.cn || existing.name;
    if (idHint) idHint.textContent = `英文 id：${existing.name}（固定，动作组与编排按它引用）`;
  } else {
    if (title) title.textContent = '新建动作';
    if (sub) sub.textContent = '每个轴：起→止往复；相位让各轴错开；偏心让往复不对称';
    if (saveBtn) saveBtn.textContent = '保存到动作库';
    nameInput.value = '';
    if (idHint) idHint.textContent = '';
  }
  editingStroke = existing || null;
  seOpenModal();
  seDraw();
  // 内置动作被动作组引用时提醒：改曲线会让那些组一起变
  if (existing && idHint) {
    api('/api/plugin/list').then(r => {
      const groups = r.groups || [];
      const used = groups.filter(g => ((r.cards || {})[g] || []).some(c => c.stroke === existing.name));
      if (!used.length) {
        idHint.textContent = `英文 id：${existing.name} · 暂无动作组使用`;
      } else {
        idHint.innerHTML = `英文 id：${existing.name} · <b style="color:#ffcf7a">被 ${used.length} 个动作组使用（${used.slice(0, 3).join('、')}${used.length > 3 ? '…' : ''}），改曲线会一起变</b>`;
      }
    }).catch(() => { });
  }
}

// 打开/关闭弹窗：除了 CSS，这里再显式钉成「贴住视口的浮层」，并锁住背后页面滚动，
// 免得在窄窗口/被滚动过的页面上弹层跟着页面走、看得到却滚不到。
function seOpenModal() {
  const m = $('#stroke-modal');
  if (!m) return;
  // 钉到 body 下：万一被某个带 transform 的容器包住，fixed 会以那个容器为参照，弹层就会跟着页面跑
  if (m.parentElement !== document.body) document.body.appendChild(m);
  m.hidden = false;
  m.style.position = 'fixed';
  // 老内核（360 等旧 Chromium）不认 inset 简写，逐个写边位
  m.style.top = '0'; m.style.right = '0'; m.style.bottom = '0'; m.style.left = '0';
  m.style.width = '100%'; m.style.height = '100%';
  try { m.style.inset = '0'; } catch (e) { }
  m.style.zIndex = '999';
  m.style.display = 'flex';
  m.style.display = '-webkit-flex';
  m.style.alignItems = 'flex-start';
  m.style.justifyContent = 'center';
  m.style.overflow = 'auto';
  m.style.padding = '16px';
  m.style.background = '#000000aa';
  m.style.boxSizing = 'border-box';
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
  const box = m.querySelector('.se-box');
  if (box) {
    box.style.margin = 'auto';
    box.style.width = '96%';
    box.style.maxWidth = '960px';
    box.style.maxHeight = 'calc(100vh - 136px)';
    box.style.overflow = 'auto';
  }
}

function seCloseModal() {
  const m = $('#stroke-modal');
  if (m) {
    m.hidden = true;
    m.removeAttribute('style');
  }
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
  editingStroke = null;
}

if ($('#btn-new-stroke')) $('#btn-new-stroke').addEventListener('click', () => openStrokeEditor(null));
if ($('#stroke-search')) $('#stroke-search').addEventListener('input', () => { try { renderStrokes(); } catch (e) { } });
if ($('#ns-cancel')) $('#ns-cancel').addEventListener('click', () => seCloseModal());
if ($('#ns-try')) $('#ns-try').addEventListener('click', async () => {
  const axes = seReadRows();
  if (!Object.keys(axes).length) { alert('至少启用一个轴'); return; }
  try {
    await api('/api/strokes/preview', { axes, bpm: 50, secs: 8, gain: 0.8 });
    log('试听 8 秒（未保存）');
  } catch (e) { alert('试听失败：' + e.message); }
});
if ($('#ns-save')) $('#ns-save').addEventListener('click', async () => {
  const label = $('#ns-name').value.trim();
  if (!label) { alert('请填名称'); return; }
  const axes = seReadRows();
  if (!Object.keys(axes).length) { alert('至少启用一个轴'); return; }
  try {
    if (editingStroke) {
      await api('/api/strokes/update', { name: editingStroke.name, cn: label, axes });
      log(`已保存修改：${label}${editingStroke.user ? '' : '（内置动作，写覆盖层，可 ↺ 还原）'}`);
    } else {
      await api('/api/strokes/add', { name: label, cn: label, axes });
      log(`已新建动作：${label}`);
    }
    seCloseModal();
    await loadStrokes();
  } catch (e) { alert('保存失败：' + e.message); }
});

// ---------------- 动作库（Strokes） ----------------
let strokes = [];
let strokeMax = 80;
let lastStrokeName = null;

async function loadStrokes() {
  try {
    const r = await api('/api/strokes');
    strokes = r.strokes || [];
    const max = Number(r.max) || 80;
    strokeMax = max;
    const c = $('#stroke-count');
    if (c) {
      c.textContent = `${strokes.length} / ${max}`;
      c.style.color = strokes.length >= max ? '#ff8a8a' : '';
    }
    const addBtn = $('#btn-new-stroke');
    if (addBtn) {
      const full = strokes.length >= max;
      addBtn.disabled = full;
      addBtn.title = full ? `动作库已满（${max} 个），先删掉一些自建动作` : '';
      addBtn.textContent = full ? `＋ 新建动作（已达上限 ${max}）` : '＋ 新建动作';
    }
    renderStrokes();
  } catch (e) {
    const c = $('#stroke-count');
    if (c) c.textContent = '加载失败: ' + e.message;
    log('动作库加载失败：' + e.message);
  }
}

function strokeBpm() { return Number($('#stroke-bpm').value) || 60; }

function sparkline(canvas, axes) {
  const dpr = window.devicePixelRatio || 1;
  const w = 132, h = 34;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  g.strokeStyle = '#7c5cff'; g.lineWidth = 1.4;
  g.beginPath();
  const N = 60;
  for (let i = 0; i <= N; i++) {
    const t = i / N;                        // 一个周期
    const ang = 2 * Math.PI * t;
    let v = 0.5;
    for (const a of axes) {
      const mid = (a.to + a.from) / 2, half = (a.to - a.from) / 2;
      const hh = ang + Math.PI * 0.5 * a.phase;
      v = mid - half * Math.cos(hh + a.ecc * Math.sin(hh));
      break;                                 // 只画第一条有位移的轴
    }
    const x = t * w, y = h - 3 - v * (h - 6);
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.stroke();
}

function strokeGain(name) {
  const v = Number(localStorage.getItem('stroke_gain_' + name));
  return Number.isFinite(v) && v > 0 ? v : 100;      // 百分比
}

function renderStrokes() {
  const grid = $('#stroke-grid');
  if (!grid) { log('找不到 #stroke-grid'); return; }
  if (!strokes.length) { log('动作库为空（loadStrokes 未完成）'); }
  grid.innerHTML = '';
  const q = (($('#stroke-search') && $('#stroke-search').value) || '').trim().toLowerCase();
  const list = q ? strokes.filter(s => ((s.cn || '') + ' ' + (s.name || '')).toLowerCase().includes(q)) : strokes;
  const cnt = $('#stroke-count');
  if (cnt) cnt.textContent = q ? `${list.length} / ${strokes.length}` : `${strokes.length} / ${strokeMax}`;
  const running = (state && state.mode === 'stroke' && state.stroke) ? state.stroke.name : null;
  const enabled = new Set(((state && state.calib && state.calib.order) || ['L0']));

  if (!list.length) {
    grid.innerHTML = '<div class="lk-empty">没有匹配「' + escHtml(q) + '」的动作</div>';
  }
  list.forEach(s => {
    const isRun = running === s.name;
    const singleMode = $('#stroke-single') && $('#stroke-single').checked;
    const usable = singleMode ? ['__single__'] : (s.axes || []).filter(a => enabled.has(a));
    const gain = strokeGain(s.name);
    const el = document.createElement('div');
    el.className = 'stroke-card' + (isRun ? ' running' : '');
    const chips = (s.axes || []).map(a =>
      `<span class="axis-chip ${enabled.has(a) ? 'on' : 'off'}">${axisName(a)}</span>`).join('');
    const firstAxis = (state && state.calib && state.calib.order && state.calib.order[0]) || 'L0';
    const mapNote = singleMode
      ? `<div class="sc-note">单轴模式：映射到 ${firstAxis}</div>`
      : (usable.length ? '' :
        `<div class="sc-note">设备上没有这个动作的轴，将自动映射到 ${firstAxis}</div>`);
    el.innerHTML = `
      <div class="sc-head">
        <div>
          <div class="sc-cn">${s.cn}${isRun ? ' <span class="live-badge">● 运行中</span>' : ''}</div>
          <div class="sc-en">${s.name}${s.user ? ' <span class="sc-tag">自建</span>' : (s.override ? ' <span class="sc-tag">已改</span>' : '')}</div>
        </div>
        <div class="sc-ops">
          <button class="btn tiny sc-edit" title="编辑这个动作的参数">✎</button>
          ${s.override ? '<button class="btn tiny sc-restore" title="还原成内置原样">↺</button>' : ''}
          ${s.user ? '<button class="btn tiny del sc-del" title="删除这个自建动作">✕</button>' : ''}
          <button class="btn small primary sc-run">▶</button>
        </div>
      </div>
      <div class="sc-chips">${chips || '<span class="hint">单轴</span>'}</div>
      ${mapNote}
      <canvas class="sc-wave"></canvas>
      <div class="sc-gain">
        <label>幅度</label>
        <input type="range" class="sc-gain-r" min="10" max="100" step="5" value="${gain}" />
        <span class="sc-gain-v">${gain}%</span>
      </div>`;
    grid.appendChild(el);

    if (s.detail && s.detail.length) sparkline(el.querySelector('.sc-wave'), s.detail);

    el.querySelector('.sc-edit').onclick = () => openStrokeEditor(s);
    const restoreBtn = el.querySelector('.sc-restore');
    if (restoreBtn) {
      restoreBtn.onclick = async () => {
        if (!confirm(`把「${s.cn}」还原成内置原样？`)) return;
        try {
          await api('/api/strokes/update', { name: s.name, restore: true });
          log(`已还原：${s.cn}`);
          await loadStrokes();
        } catch (e) { alert('还原失败：' + e.message); }
      };
    }
    const delBtn = el.querySelector('.sc-del');
    if (delBtn) {
      delBtn.onclick = async () => {
        if (!confirm(`删除自建动作「${s.cn}」？用到它的动作组会失效。`)) return;
        try {
          await api('/api/strokes/delete', { name: s.name });
          log(`已删除：${s.cn}`);
          await loadStrokes();
        } catch (e) { alert('删除失败：' + e.message); }
      };
    }

    const gainR = el.querySelector('.sc-gain-r');
    const gainV = el.querySelector('.sc-gain-v');
    let t = null;
    gainR.addEventListener('input', () => {
      gainV.textContent = gainR.value + '%';
      localStorage.setItem('stroke_gain_' + s.name, gainR.value);
      if (isRun) {
        clearTimeout(t);
        t = setTimeout(() => api('/api/stroke/live', { gain: Number(gainR.value) / 100 }).catch(() => { }), 120);
      }
    });

    el.querySelector('.sc-run').onclick = async () => {
      await ensureResumed();
      try {
        const r = await api('/api/stroke/run', {
          name: s.name,
          bpm: strokeBpm(),
          secs: Number($('#stroke-secs').value) || 0,
          gain: Number(gainR.value) / 100,
          single: $('#stroke-single').checked,
        });
        log(`运行动作：${s.cn}（${strokeBpm()} BPM · 幅度 ${gainR.value}%`
            + (r.stroke && r.stroke.mapped ? ` · ${r.stroke.mapped}` : '') + '）');
        poll();
      } catch (e) { log('运行失败：' + e.message); }
    };
  });
  updateScrollHints();
}

async function liveStrokeBpm() {
  if (!state || state.mode !== 'stroke') return;
  try { await api('/api/stroke/live', { bpm: strokeBpm() }); } catch (e) { }
}

// ---------------- 急停解除 ----------------
async function ensureResumed() {
  if (state && state.estop) {
    try {
      await api('/api/stop/clear');
      log('已解除急停（设备仍保持原位，不会自己动）');
    } catch (e) { log('解除急停失败：' + e.message); }
  }
  estopFlag = false;
}

// ---------------- 急停 ----------------
async function emergencyStop(reason) {
  estopFlag = true;
  try { video.pause(); } catch (e) { }
  try {
    await api('/api/stop', { hard: true });
    log(`🛑 急停（${reason}）→ 已 DSTOP`);
  } catch (e) {
    log('急停请求失败：' + e.message + '（请直接关掉服务器窗口）');
  }
}
$('#estop-banner').addEventListener('click', () => ensureResumed());

$('#btn-recover').addEventListener('click', async () => {
  const btn = $('#btn-recover');
  const wasEstop = !!(state && state.estop);
  btn.classList.add('busy');
  btn.innerHTML = '归中…<span class="sub">请稍等</span>';
  try {
    await ensureResumed();                     // 先解除急停锁存（这是唯一的手动恢复入口）
    const r = await api('/api/home', { speed: 1200 });
    log(`⌂ 已恢复并归中：${r.home.axes.join(' / ')}（速度 ${r.home.speed} 单位/秒）`
        + (wasEstop ? '，急停已解除' : ''));
  } catch (e) {
    log('归中失败：' + e.message);
  } finally {
    btn.classList.remove('busy');
    btn.innerHTML = '归中<span class="sub">恢复</span>';
  }
});

$('#estop').addEventListener('click', async () => {
  if (state && state.estop) {                 // 已经是急停状态 → 这一次是“解除”
    await ensureResumed();
    return;
  }
  await emergencyStop('按钮');
});

// 日志下方的安全提示里那颗急停：始终硬停（锁存），不受当前状态影响
(function bindSafetyEstop() {
  const b = $('#safety-estop');
  if (!b) return;
  b.addEventListener('click', async () => {
    await emergencyStop('安全提示按钮');
  });
})();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); emergencyStop('ESC'); }
});

// ---------------- 左侧标签页 ----------------
function showPage(name) {
  document.querySelectorAll('.rail-btn[data-page]').forEach(b => {
    b.classList.toggle('active', b.dataset.page === name);
  });
  document.querySelectorAll('.page').forEach(p => {
    p.classList.toggle('active', p.id === 'page-' + name);
  });
  // 联动页把测试台放进右侧栏（和运行状态 / 日志同栏），其余页面隐藏
  try { document.body.classList.toggle('on-plugin', name === 'plugin'); } catch (e) { }
  try { localStorage.setItem('osr_page', name); } catch (e) { }
  try { history.replaceState(null, '', '#page-' + name); } catch (e) { }
  try { window.scrollTo(0, 0); } catch (e) { }
  if (name === 'media') requestAnimationFrame(drawWave);
  if (name === 'plugin') { try { loadPlugin(); } catch (e) { } }

  if (name === 'strokes') {
    try { if (!strokes.length) loadStrokes(); else renderStrokes(); } catch (e) { }
    try { renderOutput(); } catch (e) { }
  }
  if (name === 'console') { try { renderOutput(); } catch (e) { } }
}

document.querySelectorAll('.rail-btn[data-page]').forEach(b => {
  b.addEventListener('click', () => showPage(b.dataset.page));
});
if ($('#rail-calib')) $('#rail-calib').addEventListener('click', () => openCalib());


// ---------------- 启动 ----------------
(async function init() {
  try { loadPorts(); } catch (e) { }
  try { await loadPresets(); } catch (e) { log('预设加载异常：' + e.message); }
  try { await poll(); } catch (e) { log('状态轮询异常：' + e.message); }
  renderFiles();
  drawWave();
  setInterval(poll, 250);

// 3D 预览专用高速轮询：250ms 的整页刷新不足以驱动流畅动画，这里只取位置喂给 3D
let fastPending = 0;
const fastPoll = async () => {
  if (fastPending >= 2) return;
  if (!(window.Device3D && Device3D.ready) || Device3D.paused) return;
  const page = document.getElementById('page-strokes');
  if (!page || !page.classList.contains('active')) return;
  if (document.hidden) return;
  fastPending++;
  try {
    const s = await api('/api/state');
    if (s && s.position) Device3D.setTarget(s.position);
  } catch (e) { }
  fastPending--;
};
setInterval(fastPoll, 30);
  // 输出面板独立刷新（不依赖状态渲染链路）
  renderOutput();
  setInterval(() => {
    const box = $('#out-list');
    const c = (state && state.calib) ? JSON.stringify(state.calib) : '';
    const empty = !box || box.children.length === 0;
    if (empty || (c && c !== window.__lastCalib2)) {
      window.__lastCalib2 = c;
      try { renderOutput(); } catch (e) { }
    }
  }, 600);
  try { initDragLayout(); } catch (e) { log('布局初始化失败：' + e.message); }
  requestAnimationFrame(tick3d);
  try { $('#stroke-single').checked = localStorage.getItem('stroke_single') === '1'; } catch (e) { }
  loadStrokes().then(() => log(`动作库已载入 ${strokes.length} 个`))
    .catch(e => log('动作库异常：' + e.message));
  const hashPage = (location.hash || '').match(/^#page-(console|media|strokes|plugin)$/);
  if (hashPage) {
    showPage(hashPage[1]);
  } else {
    showPage((function () { try { return localStorage.getItem('osr_page') || 'console'; } catch (e) { return 'console'; } })());
  }
  log('控制器已就绪：分组预设 / 整套连播 / 视频同步 / 设备校准');
  if (location.hash === '#calib') openCalib();
})();
// ---------------- 独立启动器（不受前面的异常影响）----------------
setTimeout(function () {
  try { if (typeof loadStrokes === 'function') loadStrokes(); } catch (e) { }
  try { if (typeof renderOutput === 'function') renderOutput(); } catch (e) { }
  try {
    var m = (location.hash || '').match(/^#page-(console|media|strokes|plugin)$/);
    if (m && typeof showPage === 'function') showPage(m[1]);
  } catch (e) { }
}, 500);


// 播完循环：停止 / 循环本组 / 循环并换组（存在控制器里，插件和卡都按它走）
(async function bindLoopCtl() {
  const sel = $('#lk-loop'), minIn = $('#lk-loop-min');
  if (!sel) return;
  async function loadLoop() {
    try {
      const r = await api('/api/plugin/list');
      const c = (r && r.loop) || {};
      if (c.mode) sel.value = c.mode;
      if (c.minutes) minIn.value = c.minutes;
    } catch (e) { }
  }
  async function saveLoop() {
    try {
      const r = await api('/api/plugin/loop', { mode: sel.value, minutes: Number(minIn.value) || 30 });
      const c = (r && r.loop) || {};
      const label = { off: '播完停止', single: '循环本组', rotate: '循环并换组' }[c.mode] || c.mode;
      log(`播完策略：${label} · 最长 ${c.minutes} 分钟`);
    } catch (e) { log('设置循环失败：' + (e && e.message)); }
  }
  sel.addEventListener('change', saveLoop);
  if (minIn) minIn.addEventListener('change', saveLoop);
  loadLoop();
})();

// 驱动策略：教模型写块 / 回退停设备
(async function bindDriveCfg() {
  const teach = $('#dv-teach'), rewind = $('#dv-rewind');
  if (!teach) return;
  async function load() {
    try {
      const r = await api('/api/plugin/list');
      const c = (r && r.drive) || {};
      teach.checked = c.teach !== false;
      if (rewind) rewind.checked = c.rewind_stop !== false;
    } catch (e) { }
  }
  async function save() {
    try {
      const r = await api('/api/plugin/drive-config', {
        teach: teach.checked,
        rewind_stop: rewind ? rewind.checked : true,
      });
      const c = (r && r.drive) || {};
      log(`驱动策略：${c.teach ? '教模型写指令块' : '不教（正文只写故事）'} · 回退${c.rewind_stop ? '停设备' : '不停'}`);
    } catch (e) { log('保存驱动策略失败：' + (e && e.message)); }
  }
  teach.addEventListener('change', save);
  if (rewind) rewind.addEventListener('change', save);
  load();
})();
