/**
 * dsh-osr-device — 让 Tavern 正文驱动本地 OSR2/SR6 控制器
 *
 * 只使用 Tavern 公开插件接口（apiVersion 3+）：
 *   promptSection / gameSettings / getGameSettings / onTurnSettled / handle / effect
 *
 * 触发来源（按优先级）：
 *   1) 正文里的代码块指令：```osr {"group":"前戏·慢"}```  或  {"stop":true}
 *   2) 开关打开时，把正文交给控制器做关键词匹配（控制器「联动」里配置的绑定表）
 *
 * 安全：模型自主触发默认关闭；有冷却与同组去重；控制器未启动时静默跳过，绝不影响正文。
 */

export const name = 'dsh-osr-device'
export const inject = ['tavern']

const DEFAULT_BASE = 'http://127.0.0.1:8899'
const FETCH_TIMEOUT = 2000

/* ---------------- 可测试的纯函数 ---------------- */

/** 从模型原始输出里取 ```osr {…}``` 指令；没有则返回 null */
export function parseCommand(rawText) {
  if (!rawText || typeof rawText !== 'string') return null
  const m = rawText.match(/```osr\s*([\s\S]*?)```/i)
  if (!m) return null
  const body = m[1].trim()
  if (!body) return null
  try {
    const v = JSON.parse(body)
    if (!v || typeof v !== 'object') return null
    if (v.stop === true) return { stop: true }
    const group = typeof v.group === 'string' ? v.group.trim() : ''
    if (!group) return null
    const out = { group }
    if (Number.isFinite(v.gain)) out.gain = clamp(v.gain, 0.2, 1.6)
    if (Number.isFinite(v.bpm)) out.bpm = clamp(v.bpm, 10, 240)
    return out
  } catch {
    return null
  }
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Number(n)))
}

/**
 * 从原始正文里取「编排」代码块。标记可配置（控制器里改，插件每轮读）。
 * 支持 {"compose":[…]} / {"cards":[…]} / 直接数组三种写法。
 */
export function parseCompose(rawText, tag) {
  if (!rawText || typeof rawText !== 'string') return null
  const t = String(tag || 'osr-compose').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = rawText.match(new RegExp('```' + t + '\\s*([\\s\\S]*?)```', 'i'))
  if (!m) return null
  const body = m[1].trim()
  if (!body) return null
  let v
  try {
    v = JSON.parse(body)
  } catch {
    return null
  }
  const list = Array.isArray(v) ? v : v && (v.compose || v.cards)
  if (!Array.isArray(list) || !list.length) return null
  const clean = list
    .filter((x) => x && typeof x === 'object' && typeof x.stroke === 'string' && x.stroke.trim())
    .map((x) => ({
      stroke: x.stroke.trim(),
      bpm: Number(x.bpm),
      secs: Number(x.secs),
      gain: Number(x.gain),
    }))
  if (!clean.length) return null
  return {
    cards: clean,
    gain: Array.isArray(v) ? null : (Number.isFinite(v.gain) ? v.gain : null),
    label: Array.isArray(v) || typeof (v && v.label) !== 'string' ? '' : v.label,
    // save 有值 = 玩家同意把这段存到控制器的「AI 暂存」里（非空字符串即视为同意）
    save: Array.isArray(v) || !v ? '' : (typeof v.save === 'string' ? v.save.trim().slice(0, 24)
      : (v.save === true ? (typeof v.label === 'string' ? v.label.trim().slice(0, 24) : '') : '')),
  }
}


/** 一轮里可能写了多个 osr 块：全部收集（正常的 osr 组指令，不含编排块） */
export function parseAllGroups(rawText) {
  if (!rawText || typeof rawText !== 'string') return []
  const out = []
  const re = /```osr\s*([\s\S]*?)```/gi
  let m
  while ((m = re.exec(rawText))) {
    const body = (m[1] || '').trim()
    if (!body) continue
    try {
      const v = JSON.parse(body)
      if (!v || typeof v !== 'object') continue
      if (v.stop === true) { return { stop: true } }
      const g = typeof v.group === 'string' ? v.group.trim() : ''
      if (g && out.indexOf(g) < 0) out.push(g)
    } catch { /* 忽略坏块 */ }
  }
  return out
}
/* ---------------- 插件本体 ---------------- */

export function apply(ctx, config) {   // config 由 Tavern 的加载器传入，别用 ctx.config（需要 inject）
  const api = ctx.tavern
  const log = ctx.logger || console
  if (!api) {
    log.warn?.('[osr] 没有拿到 tavern 服务，插件不启用')
    return
  }
  if (typeof api.apiVersion === 'number' && api.apiVersion < 3) {
    log.warn?.(`[osr] 需要插件接口 v3 以上，当前 v${api.apiVersion}`)
    return
  }

  const base = String((config && (config.baseUrl || config.osrBaseUrl)) || DEFAULT_BASE).replace(/\/+$/, '')

  const TEACH_TEXT = [
    '【动作指令】',
    '需要让她的身体配合当前情节时，单独输出一个 osr 代码块，正文里不要解释它：',
    '```osr',
    '{"group":"动作组名"}',
    '```',
    '动作组名必须来自控制器里已有的组；不确定或不需要时省略整段。',
    '要停止时输出：```osr {"stop":true}```。',
    '同一段情节只输出一次；换成明显不同的动作时再输出。',
    '正文里不要把执行动作的一方写成机器、装置、设备或程序：它就是她的身体，按情节写成她的手、嘴、胸、腿、穴或后庭，',
    '并且写她自己的身体感受（她在含、她在收、她哪里发烫），不要写器械运转。',
  ].join('\n')

  /* --- 编排协议：标记与上限每轮从控制器读，内容不变时提示词缓存不受影响 --- */
  /* --- 驱动策略（教不教模型写块 / 回退是否停）--- */
  let driveCfgCache = { at: 0, cfg: { teach: true, rewind_stop: true } }
  async function getDriveCfg() {
    if (Date.now() - driveCfgCache.at < 3000) return driveCfgCache.cfg
    const r = await get('/api/plugin/drive-config')
    const cfg = (r && r.drive) || { teach: true, rewind_stop: true }
    driveCfgCache = { at: Date.now(), cfg }
    return cfg
  }

  const composeProtocol = async () => {
    const drive = await getDriveCfg()
    const parts = []
    if (drive.teach !== false) parts.push(TEACH_TEXT)
    const cfg = await getComposeCfg()
    if (cfg.enabled !== false) {
      const names = await getStrokeNames()
      const list = names.length ? names.join('、') : '（控制器未返回动作清单）'
      parts.push([
        `【编排协议 · ${cfg.tag}】`,
        '想自己组合一段节奏、由她的身体执行时，单独输出一个 ' + cfg.tag + ' 代码块，内容是 JSON：',
        '```' + cfg.tag,
        '{"compose":[{"stroke":"动作英文名","bpm":40,"secs":20}],"gain":0.7,"label":"一句中文描述"}',
        '```',
        `规则：最多 ${cfg.max_cards} 段；每段 secs ≤ ${cfg.max_secs} 秒；bpm ≤ ${cfg.bpm_cap}；gain 0.2–1.0。`,
        '动作英文名只能从下面这些里挑，写错的名字会被丢弃：',
        list,
      ].join('\n'))
    }
    return parts.join('\n\n')
  }
  if (typeof api.turnSection === 'function') {
    api.turnSection({ name: 'osr-compose', text: composeProtocol })
  } else {
    // 旧版 Tavern 没有 turnSection：退化成固定段落（此时标记只能用默认值）
    api.promptSection({
      name: 'osr-compose',
      text: '想让设备按组合播放时，输出 ```osr-compose {"compose":[{"stroke":"…","bpm":40,"secs":20}]}```。',
    })
  }


  // 每轮把「设备到底连没连」告诉模型：只给状态块用，别影响正文口风
  api.turnSection({
    name: 'osr-status',
    text: async () => {
      const s = await get('/api/state')
      const online = !!(s && s.connected)
      const playing = (s && s.sequence) ? `${s.sequence.group} ${s.sequence.index}/${s.sequence.total}` : ''
      return [
        '【设备状态】' + (online ? '已连接' : '未连接') + '，' + (playing ? '正在播：' + playing : '当前无动作'),
        '- 这个只用来填状态块的「设备/连接」字段：已连接 → 正常，未连接 → 断开。',
        '- 正文照常写她的身体与感受，不因未连接而改语气，也不要提醒玩家去开控制器或检查线。',
      ].join('\n')
    },
  })
  /* --- 本局设置项 --- */
  api.gameSettings({
    title: '设备联动',
    fields: [
      {
        key: 'enabled',
        type: 'boolean',
        label: '启用设备联动',
        description: '关闭后本局不再向控制器发任何指令。',
        default: true,
      },
      {
        key: 'allowModel',
        type: 'boolean',
        label: '允许模型自主决定动作',
        description: '关闭时只处理代码块指令里的 group，不理会纯关键词。',
        default: false,
      },
      {
        key: 'keywordFallback',
        type: 'boolean',
        label: '无指令时用关键词匹配',
        description: '把正文交给控制器「联动」里的关键词表匹配。',
        default: true,
      },
      {
        key: 'cooldown',
        type: 'number',
        label: '最短间隔（秒）',
        min: 3,
        max: 300,
        step: 1,
        default: 20,
      },
      {
        key: 'strength',
        type: 'number',
        label: '幅度（%）',
        description: '换算成控制器的 gain，60% 为原始幅度。',
        min: 20,
        max: 100,
        step: 5,
        default: 60,
      },
    ],
  })

  /* --- HTTP --- */
  async function post(path, body) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT)
    try {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: ctrl.signal,
      })
      return await res.json()
    } catch (e) {
      log.warn?.(`[osr] 调用 ${path} 失败：${(e && e.message) || e}`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  async function get(path) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT)
    try {
      const res = await fetch(base + path, { signal: ctrl.signal })
      return await res.json()
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /* --- AI 编排（L1）：读控制器配置、解析标记、校验后临时播放 --- */
  let composeCache = { at: 0, cfg: null }
  let strokeCache = { at: 0, names: [] }

  async function getComposeCfg() {
    if (Date.now() - composeCache.at < 3000 && composeCache.cfg) return composeCache.cfg
    const r = await get('/api/plugin/compose-config')
    if (r && r.ok && r.compose) {
      composeCache = { at: Date.now(), cfg: r.compose }
      return r.compose
    }
    return composeCache.cfg || { tag: 'osr-compose', enabled: true, max_cards: 6, max_secs: 60, bpm_cap: 120 }
  }

  async function getStrokeNames() {
    if (Date.now() - strokeCache.at < 60000 && strokeCache.names.length) return strokeCache.names
    const r = await get('/api/strokes')
    const names = ((r && r.strokes) || []).map((s) => s && s.name).filter(Boolean)
    if (names.length) strokeCache = { at: Date.now(), names }
    return strokeCache.names
  }

  async function playCompose(gameId, plan, cfg, settings, source) {
    const now = Date.now()
    const cooldownMs = Math.max(3, Number(settings && settings.cooldown) || 20) * 1000
    if (now - (lastAt.get(gameId) || 0) < cooldownMs) return { ok: false, reason: 'cooldown' }

    const known = new Set(await getStrokeNames())
    const maxCards = Math.max(1, Number(cfg.max_cards) || 6)
    const maxSecs = Math.max(5, Number(cfg.max_secs) || 60)
    const bpmCap = Math.max(20, Number(cfg.bpm_cap) || 120)
    const baseGain = plan.gain
    const cards = []
    for (const item of plan.cards.slice(0, maxCards)) {
      const nm = String((item && item.stroke) || '').trim()
      if (!nm) continue
      if (known.size && !known.has(nm)) continue      // 名字不在动作库里就丢掉
      const bpm = Math.max(5, Math.min(bpmCap, Number(item.bpm) || 40))
      const secs = Math.max(1, Math.min(maxSecs, Number(item.secs) || 15))
      let gain = Number(item.gain)
      if (!Number.isFinite(gain)) gain = Number(baseGain)
      if (!Number.isFinite(gain)) gain = 0.7
      cards.push({ stroke: nm, bpm: +bpm.toFixed(1), secs: +secs.toFixed(1), gain: +Math.max(0.2, Math.min(1, gain)).toFixed(2) })
    }
    if (!cards.length) {
      log.info?.('[osr] 编排被丢弃：没有合法动作名')
      return { ok: false, reason: 'no-valid-stroke' }
    }

    const label = (plan.label || 'AI 编排').slice(0, 40)
    const r = await post('/api/ai/strokes', { cards, label })
    if (!r) return { ok: false, reason: 'no-controller' }
    if (!r.ok) {
      log.info?.(`[osr] 编排未播放：${r.reason || r.error || 'unknown'}`)
      return r
    }
    lastAt.set(gameId, now)
    log.info?.(`[osr] 编排播放「${label}」${cards.length} 段：` + cards.map((c) => `${c.stroke}@${c.bpm}/${c.secs}s`).join(' → '))

    // 玩家同意保存（编排块里带 "save"）→ 送到控制器的「AI 暂存」区，等玩家在控制器里确认
    if (plan.save) {
      const off = await post('/api/plugin/ai-group/offer', {
        name: plan.save,
        cards,
        source: source || 'AI 对话',
      })
      if (off && off.ok) {
        log.info?.(`[osr] 已送到控制器 AI 暂存区：「${plan.save}」（${cards.length} 张）`)
      } else {
        log.warn?.(`[osr] 暂存失败：${(off && (off.error || off.reason)) || '控制器无响应'}`)
      }
    }
    return r
  }

  /* --- 触发节流 --- */
  const lastAt = new Map() // gameId → 时间戳
  const lastGroup = new Map() // gameId → 组名

  async function trigger(gameId, cmd, strength) {
    const now = Date.now()
    const cooldownMs = Math.max(3, Number(strength?.cooldown) || 20) * 1000
    if (now - (lastAt.get(gameId) || 0) < cooldownMs) return { ok: false, reason: 'cooldown' }
    if (cmd.group && lastGroup.get(gameId) === cmd.group) return { ok: false, reason: 'same-group' }

    const payload = cmd.group ? { group: cmd.group } : { text: cmd.text || '' }
    const r = await post('/api/plugin/trigger', payload)
    if (!r) return { ok: false, reason: 'no-controller' }
    if (!r.ok) {
      log.info?.(`[osr] 未触发：${r.reason || 'unknown'}${r.detail ? '（' + r.detail + '）' : ''}`)
      return r
    }

    lastAt.set(gameId, now)
    if (cmd.group) lastGroup.set(gameId, cmd.group)
    log.info?.(`[osr] 触发动作组 ${r.group}`)

    // 幅度：60% 视为 1.0
    const pct = Math.max(20, Math.min(100, Number(strength?.strength) || 60))
    const gain = +(pct / 60).toFixed(2)
    if (Number.isFinite(gain) && gain !== 1) await post('/api/stroke/live', { gain })
    if (Number.isFinite(cmd.bpm)) await post('/api/stroke/live', { bpm: cmd.bpm })
    return r
  }


  /* --- 设备在线探测：没连设备就完全不下发指令，剧情照常 --- */
  let onlineCache = { at: 0, online: false, warnedAt: 0 }
  async function deviceOnline() {
    if (Date.now() - onlineCache.at < 5000) return onlineCache.online
    const s = await get('/api/state')
    const online = !!(s && s.connected)
    onlineCache = { at: Date.now(), online, warnedAt: onlineCache.warnedAt }
    if (!online && Date.now() - onlineCache.warnedAt > 60000) {
      onlineCache.warnedAt = Date.now()
      log.info?.('[osr] 设备未连接：本轮不下发指令（剧情照常）')
    }
    return online
  }
  /* --- 每轮结算 --- */
  const settleHandler = async (turn) => {
    if (!turn || !turn.gameId) return
    let settings = {}
    try {
      settings = (await api.getGameSettings({ gameId: turn.gameId })) || {}
    } catch (e) {
      log.warn?.(`[osr] 读本局设置失败：${(e && e.message) || e}`)
    }
    if (settings.enabled === false) return
    // 没接设备就不发任何指令：不连设备也能正常玩（用来塑造性格），要体验时玩家自己接上
    if (!(await deviceOnline())) return

    // ① AI 编排（L1：只播一次，不写盘）——标记与上限由控制器配置
    const cfg = await getComposeCfg()
    if (cfg.enabled !== false) {
      const plan = parseCompose(turn.rawText, cfg.tag)
      if (plan) {
        const r = await playCompose(turn.gameId, plan, cfg, settings, (turn.card && turn.card.name) || '')
        if (r && r.ok) return
        // 编排失败就继续往下走，别整轮哑掉
      }
    }

    const allGroups = parseAllGroups(turn.rawText)
    if (allGroups && allGroups.stop === true) {
      await post('/api/stop', { hard: false })
      log.info?.('[osr] 已按指令停止')
      return
    }
    if (Array.isArray(allGroups) && allGroups.length > 1) {
      if (settings.allowModel !== true) return
      const r = await post('/api/plugin/trigger', { groups: allGroups })
      if (r && r.ok) {
        lastAt.set(turn.gameId, Date.now())
        log.info?.(`[osr] 一次触发 ${allGroups.length} 组：${allGroups.join(' / ')}（先播 ${r.group}）`)
      } else {
        log.info?.(`[osr] 多组未触发：${(r && (r.reason || r.error)) || 'unknown'}`)
      }
      return
    }

    const cmd = parseCommand(turn.rawText)
    if (cmd) {
      if (cmd.stop) {
        const r = await post('/api/stop', { hard: false })
        if (r && r.ok) {
          lastGroup.delete(turn.gameId)
          lastAt.set(turn.gameId, 0)
          log.info?.('[osr] 已按指令停止')
        }
        return
      }
      // 模型自己给出的 group 是否执行，取决于开关
      if (settings.allowModel !== true) return
      await trigger(turn.gameId, cmd, settings)
      return
    }

    // 没有指令：可选的关键词兜底
    if (settings.keywordFallback === false) return
    const text = turn.text || ''
    if (!text.trim()) return
    await trigger(turn.gameId, { text: text.slice(0, 4000) }, settings)
  }

  /* --- 注册：优先用后台任务（可见、可回退），旧宿主退化成 onTurnSettled --- */
  async function heardToTurn(heard) {
    if (!heard) return null
    const gameId = heard.gameId
    let rawText = heard.rawText
    let text = heard.text
    let card = heard.card || null
    if (!rawText && !text && typeof api.getTurn === 'function') {
      const t = await api.getTurn({ gameId, turn: heard.turn }).catch(() => null)
      if (t) { rawText = t.rawText || t.text || ''; text = t.text || ''; card = t.card || card }
    }
    return { gameId, turn: heard.turn, rawText: rawText || '', text: text || rawText || '', card }
  }

  if (typeof api.job === 'function') {
    api.job({
      name: 'drive',
      title: '驱动设备',
      description: '本轮结算完后，按「显式指令 → 关键词/组名 → 导演」的顺序决定播什么',
      on: 'turn-settled',
      if: ({ turn }) => Boolean(turn),
      run: async (heard) => {
        const turn = await heardToTurn(heard)
        if (!turn) return null
        const r = await settleHandler(turn)
        return { ok: !!(r && r.ok), group: (r && r.group) || null, reason: (r && r.reason) || null }
      },
    })
    log.info?.('[osr] 已注册后台任务 turn-settled / drive')
  } else {
    api.onTurnSettled(settleHandler)
  }

  /* --- 剧情回退/改写：设备不该继续演旧剧情 --- */
  if (typeof api.on === 'function') {
    api.on('story-rewound', async (heard) => {
      try {
        const cfg = await getDriveCfg()
        if (cfg.rewind_stop === false) return
        if (!(await deviceOnline())) return
        await post('/api/stop', { hard: false })
        lastAt.clear()
        lastGroup.clear()
        log.info?.('[osr] 剧情回退/改写：已停止播放')
      } catch (e) {
        log.warn?.('[osr] 回退处理失败：' + ((e && e.message) || e))
      }
    })
    log.info?.('[osr] 已注册 story-rewound → 停设备')
  }

  /* --- 给界面用的手动入口（浏览器侧可用 tavernUi.callHost 调） --- */
  api.handle('dsh-osr-device/play', async ({ group } = {}) => {
    if (!group) throw new Error('缺少 group')
    return await post('/api/plugin/trigger', { group })
  })

  api.handle('dsh-osr-device/stop', async () => {
    return await post('/api/stop', { hard: false })
  })

  api.handle('dsh-osr-device/state', async () => {
    const s = await get('/api/state')
    if (!s) return { ok: false }
    // sequence / pending 给「面板显示进度」用：编排与动作组走同一条播放通道
    return {
      ok: true,
      connected: s.connected,
      mode: s.mode,
      estop: s.estop,
      position: s.position,
      sequence: s.sequence
        ? { group: s.sequence.name, index: s.sequence.index, total: s.sequence.total,
            left: s.sequence.left, current: s.sequence.current }
        : null,
      pending: s.pending_group || null,
      interrupt: s.interrupt_mode || null,
    }
  })

  api.handle('dsh-osr-device/groups', async () => {
    const r = await get('/api/plugin/list')
    return r && r.ok ? { ok: true, groups: r.groups, bindings: r.bindings } : { ok: false }
  })

  // 卸载时清掉节流状态（没有定时器需要清理，预留位）
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      lastAt.clear()
      lastGroup.clear()
    })
  }

  log.info?.(`[osr] 已加载，控制器 ${base}`)
}
