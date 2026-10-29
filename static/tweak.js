/* 3D 部件微调面板：选中部件后用数值挪位置/转角度，实时生效并记忆。
   数据走 Device3D.offsets（与 model-offsets.json 同一套格式），导出后可直接固化成默认值。 */
(function () {
  'use strict';

  var PARTS = [
    ['base', '底座'], ['lid', '上盖'], ['pitcher', '管身'], ['receiver', '接收器'],
    ['modCase', '外壳'], ['leftArm', '左臂'], ['rightArm', '右臂'],
    ['pitcherArm', '俯仰摇臂'], ['pitcherLinkArm', '连杆'],
    ['leftBearing', '左轴承'], ['rightBearing', '右轴承'],
    ['linkStartBearing', '连杆起端轴承'], ['linkEndBearing', '连杆末端轴承'],
    ['leftJoint', '左关节'], ['rightJoint', '右关节'], ['linkJoint', '连杆关节'],
  ];
  var KEY = 'osr_3d_offsets';

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function save(data) {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { }
  }
  function quatFromEulerDeg(rx, ry, rz) {
    var x = rx * Math.PI / 360, y = ry * Math.PI / 360, z = rz * Math.PI / 360; // 半角
    var c1 = Math.cos(x), s1 = Math.sin(x), c2 = Math.cos(y), s2 = Math.sin(y), c3 = Math.cos(z), s3 = Math.sin(z);
    return [
      s1 * c2 * c3 + c1 * s2 * s3,
      c1 * s2 * c3 - s1 * c2 * s3,
      c1 * c2 * s3 + s1 * s2 * c3,
      c1 * c2 * c3 - s1 * s2 * s3,
    ].map(function (v) { return +v.toFixed(6); });
  }

  function apply(data) {
    var d3 = window.Device3D;
    if (!d3) return;
    d3.offsets = data;
    d3.dirty = true;
  }

  function build(box) {
    var data = load();
    apply(data);

    var wrap = document.createElement('div');
    wrap.className = 'tw-wrap';
    wrap.innerHTML = [
      '<div class="tw-row"><select id="tw-part"></select></div>',
      '<div class="tw-grid">',
      '<label>X<input type="number" step="1" id="tw-px" value="0"></label>',
      '<label>Y<input type="number" step="1" id="tw-py" value="0"></label>',
      '<label>Z<input type="number" step="1" id="tw-pz" value="0"></label>',
      '<label>转X<input type="number" step="1" id="tw-rx" value="0"></label>',
      '<label>转Y<input type="number" step="1" id="tw-ry" value="0"></label>',
      '<label>转Z<input type="number" step="1" id="tw-rz" value="0"></label>',
      '</div>',
      '<div class="tw-row"><button id="tw-export" type="button">导出数值</button><button id="tw-reset" type="button">清空</button></div>',
      '<div class="tw-out" id="tw-out"></div>',
    ].join('');
    box.appendChild(wrap);

    var sel = wrap.querySelector('#tw-part');
    PARTS.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p[0];
      o.textContent = p[1] + '（' + p[0] + '）';
      sel.appendChild(o);
    });

    var fields = {
      px: wrap.querySelector('#tw-px'), py: wrap.querySelector('#tw-py'), pz: wrap.querySelector('#tw-pz'),
      rx: wrap.querySelector('#tw-rx'), ry: wrap.querySelector('#tw-ry'), rz: wrap.querySelector('#tw-rz'),
    };

    function eulerDegFromQuat(q) {
      var x = q[0], y = q[1], z = q[2], w = q[3];
      var t0 = 2 * (w * x + y * z), t1 = 1 - 2 * (x * x + y * y);
      var t2 = Math.max(-1, Math.min(1, 2 * (w * y - z * x)));
      var t3 = 2 * (w * z + x * y), t4 = 1 - 2 * (y * y + z * z);
      return [Math.atan2(t0, t1), Math.asin(t2), Math.atan2(t3, t4)].map(function (v) {
        return Math.round(v * 180 / Math.PI * 10) / 10;
      });
    }

    function show() {
      var key = sel.value;
      var cur = (load()[key]) || { pos: [0, 0, 0], quat: [0, 0, 0, 1] };
      fields.px.value = cur.pos[0] || 0;
      fields.py.value = cur.pos[1] || 0;
      fields.pz.value = cur.pos[2] || 0;
      var e = eulerDegFromQuat(cur.quat || [0, 0, 0, 1]);
      fields.rx.value = e[0]; fields.ry.value = e[1]; fields.rz.value = e[2];
    }

    function commit() {
      var key = sel.value;
      var data2 = load();
      var pos = [+fields.px.value || 0, +fields.py.value || 0, +fields.pz.value || 0];
      var quat = quatFromEulerDeg(+fields.rx.value || 0, +fields.ry.value || 0, +fields.rz.value || 0);
      var zero = pos[0] === 0 && pos[1] === 0 && pos[2] === 0 &&
        quat[0] === 0 && quat[1] === 0 && quat[2] === 0;
      if (zero) delete data2[key];
      else data2[key] = { pos: pos, quat: quat };
      save(data2);
      apply(data2);
    }

    sel.addEventListener('change', show);
    Object.keys(fields).forEach(function (k) {
      fields[k].addEventListener('input', commit);
      fields[k].addEventListener('change', commit);
    });
    wrap.querySelector('#tw-export').addEventListener('click', function () {
      var text = JSON.stringify({ offsets: load() }, null, 1);
      var out = wrap.querySelector('#tw-out');
      out.textContent = text;
      try { navigator.clipboard.writeText(text); } catch (e) { }
      console.log('[OSR2 部件偏移]\n' + text);
    });
    wrap.querySelector('#tw-reset').addEventListener('click', function () {
      save({});
      apply({});
      show();
      wrap.querySelector('#tw-out').textContent = '已清空';
    });

    show();
  }

  function boot() {
    var host = document.getElementById('v3d-parts');
    if (!host) return;
    if (host.querySelector('.tw-wrap')) return;
    build(host);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(boot, 800);
  else window.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 800); });
})();
