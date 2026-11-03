/**
 * 配置存储：~/.dsh/roundtable.json
 *
 * 为什么不用 profile 的 cordis.patch.yml：
 *   - 那是 YAML，改写容易破坏注释与其它插件的配置
 *   - 设置页每次保存都动它，风险不对等
 * 所以：Loader 的 config 只当"初始种子"，用户在设置页改的东西落在自己的 JSON 里。
 * 一旦 store 存在，就以 store 为准（YAML 后续改动不再生效，README 里写明）。
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

// RT_STORE_PATH 只用于测试：让集成测试能把存储指到临时目录
/**
 * 新用户第一次打开设置页时的默认席位：只有骨架，没有 key。
 * 不给这个，别人装完看到的是一个空页面，不知道该填什么。
 */
export const DEFAULT_PARTICIPANTS = [
  {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    persona: '结构化拆解与收敛：把模糊争论拆成可验证的判断',
    thinking: 'auto',
    kind: 'auto',
    apiKey: '',
  },
  {
    name: '豆包',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-2-1-pro-260915',
    persona: '中文语境与落地细节：国内用户习惯、合规、执行阻力',
    thinking: 'off',
    kind: 'auto',
    apiKey: '',
  },
]

/** 数值字段的默认值与合法区间，集中一处，避免每个入口各写一套。 */
export const NUMERIC_FIELDS = {
  maxRounds: { def: 2, min: 1, max: 6 },
  maxWordsPerTurn: { def: 300, min: 80, max: 4000 },
  maxTokens: { def: 800, min: 64, max: 32000 },
  temperature: { def: 0.8, min: 0, max: 2 },
  timeoutMs: { def: 120000, min: 5000, max: 600000 },
  maxRetries: { def: 2, min: 0, max: 5 },
  retryBaseMs: { def: 400, min: 0, max: 60000 },
  maxSeatFailures: { def: 2, min: 1, max: 10 },
}

/**
 * 把用户输入的数字收敛到合法区间。
 * 关键：空字符串返回默认值，而不是 0 —— Number('') === 0，
 * 早先的写法会把"温度留空"存成 0.0（确定性输出），且没有任何提示。
 */
export function clampNumber(value, field) {
  const spec = NUMERIC_FIELDS[field] ?? { def: 0, min: -Infinity, max: Infinity }
  if (value === '' || value === null || value === undefined || typeof value === 'boolean') return spec.def
  const n = Number(value)
  if (!Number.isFinite(n)) return spec.def
  return Math.max(spec.min, Math.min(spec.max, n))
}

/** 配置为空时补上默认席位，避免新用户面对空白页。 */
export function withDefaults(cfg) {
  const base = cfg && typeof cfg === 'object' ? cfg : {}
  const participants = Array.isArray(base.participants) && base.participants.length
    ? base.participants
    : DEFAULT_PARTICIPANTS
  const nums = Object.fromEntries(Object.keys(NUMERIC_FIELDS).map((k) => [k, NUMERIC_FIELDS[k].def]))
  return {
    moderator: '',
    style: 'debate',
    blindFirstRound: true,
    moderatorThinking: 'on',
    showThinking: false,
    ...nums,
    ...base,
    participants,
  }
}

export const STORE_PATH = process.env.RT_STORE_PATH || join(homedir(), '.dsh', 'roundtable.json')

export function loadStore() {
  try {
    const raw = readFileSync(STORE_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 原子写：先写临时文件再 rename，避免写一半断电留下坏 JSON。
 * 权限：POSIX 上 chmod 到 0600；Windows 的 NTFS 不认 POSIX 位，
 * chmod 不会报错但也不生效，所以这里不把权限当成唯一防线（见 README 安全说明）。
 */
export function saveStore(config) {
  mkdirSync(dirname(STORE_PATH), { recursive: true })
  const tmp = `${STORE_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {
    /* Windows 上可能不支持，忽略 */
  }
  renameSync(tmp, STORE_PATH)
  try {
    chmodSync(STORE_PATH, 0o600)
  } catch {
    /* 同上 */
  }
  return STORE_PATH
}

/** 本次进程实际生效的存储权限（测试与诊断用）。 */
export function storeMode() {
  try {
    return statSync(STORE_PATH).mode & 0o777
  } catch {
    return null
  }
}

/** 落盘前做一次体检：key 的明文不该以人类可读的形式到处飞。 */
export function redactStoreForLog(config) {
  return (config.participants ?? []).map((p) => ({ name: p.name, hasKey: Boolean(p.apiKey) }))
}

/**
 * 对外只暴露"有没有 key"，绝不把 key 发到浏览器。
 * 前端拿不到原文，也就无法通过页面脚本或扩展读走。
 */
export function publicView(cfg) {
  return {
    moderator: cfg.moderator ?? '',
    style: cfg.style ?? 'debate',
    blindFirstRound: cfg.blindFirstRound !== false,
    moderatorThinking: cfg.moderatorThinking ?? 'on',
    showThinking: cfg.showThinking === true,
    maxRounds: cfg.maxRounds ?? NUMERIC_FIELDS.maxRounds.def,
    maxWordsPerTurn: cfg.maxWordsPerTurn ?? NUMERIC_FIELDS.maxWordsPerTurn.def,
    maxTokens: cfg.maxTokens ?? NUMERIC_FIELDS.maxTokens.def,
    temperature: cfg.temperature ?? NUMERIC_FIELDS.temperature.def,
    timeoutMs: cfg.timeoutMs ?? NUMERIC_FIELDS.timeoutMs.def,
    maxRetries: cfg.maxRetries ?? NUMERIC_FIELDS.maxRetries.def,
    maxSeatFailures: cfg.maxSeatFailures ?? NUMERIC_FIELDS.maxSeatFailures.def,
    participants: (cfg.participants ?? []).map((p) => ({
      name: p.name,
      baseUrl: p.baseUrl,
      model: p.model,
      persona: p.persona,
      thinking: p.thinking ?? 'auto',
      kind: p.kind ?? 'auto',
      hasKey: Boolean(p.apiKey),
      keyHint: p.apiKey ? maskKey(p.apiKey) : '',
    })),
  }
}

/** sk-abcd...wxyz：够认出来是哪把，又不足以复用。 */
export function maskKey(key) {
  const s = String(key)
  if (s.length <= 10) return '••••'
  return `${s.slice(0, 5)}…${s.slice(-4)}`
}

/**
 * 把设置页提交的表单合并成新配置。
 *
 * 两条铁律：
 *   1. 前端留空的 apiKey = 不修改（页面永远不回显明文）
 *   2. 旧 key 按**名称**匹配，绝不按数组下标继承 ——
 *      早先按 index 取旧席位，删掉第一个席位后，第二个席位会拿到第一个席位的 key：
 *      用别人的账号扣费，还只报一句 401。
 */
export function mergeForm(prev, form) {
  const before = Array.isArray(prev?.participants) ? prev.participants : []
  const byName = new Map(before.filter((p) => p?.name).map((p) => [String(p.name).trim(), p]))

  const participants = (Array.isArray(form?.participants) ? form.participants : []).map((p) => {
    const name = String(p.name ?? '').trim()
    const old = name ? byName.get(name) : undefined
    const typed = String(p.apiKey ?? '').trim()
    return {
      name,
      baseUrl: String(p.baseUrl ?? '').trim(),
      model: String(p.model ?? '').trim(),
      persona: String(p.persona ?? '').trim(),
      thinking: ['auto', 'on', 'off'].includes(p.thinking) ? p.thinking : 'auto',
      kind: ['auto', 'openai', 'anthropic'].includes(p.kind) ? p.kind : 'auto',
      // 同名才继承；改名或新增一律留空，强制重新填 key
      apiKey: typed || old?.apiKey || '',
      ...(old?.apiKeyEnv && !typed ? { apiKeyEnv: old.apiKeyEnv } : {}),
      ...(p.extraBody && typeof p.extraBody === 'object' ? { extraBody: p.extraBody } : old?.extraBody ? { extraBody: old.extraBody } : {}),
    }
  })

  const moderatorWanted = String(form?.moderator ?? prev?.moderator ?? '')
  const moderator = participants.some((p) => p.name === moderatorWanted)
    ? moderatorWanted
    : (participants.find((p) => p.apiKey)?.name ?? participants[0]?.name ?? '')

  return {
    ...prev,
    moderator,
    style: String(form?.style ?? prev?.style ?? 'debate'),
    blindFirstRound: form?.blindFirstRound !== false,
    // 思考策略：调度员默认开，发言者由席位自己的 thinking 决定
    moderatorThinking: ['auto', 'on', 'off'].includes(form?.moderatorThinking)
      ? form.moderatorThinking
      : (prev?.moderatorThinking ?? 'on'),
    // 思考旁路只影响显示，不影响记录
    showThinking: form?.showThinking === true,
    ...Object.fromEntries(
      Object.keys(NUMERIC_FIELDS).map((k) => [k, clampNumber(form?.[k] ?? prev?.[k], k)]),
    ),
    participants,
  }
}

/* ─────────────────────── 设置页写操作的来源校验 ─────────────────────── */

/**
 * 配置台只监听 127.0.0.1，但这不等于安全：
 * 用户浏览的任意网页都能向 http://127.0.0.1:8766 发 POST（DNS rebinding / 表单提交），
 * 一旦能改 baseUrl，所有 key 就跟着请求发到攻击者服务器。
 *
 * 对策（两层，任一成立即拒绝）：
 *   1. 启动时生成一次性 token，打印在终端里；写操作必须带上它
 *   2. Origin / Host 必须是本机，拒绝外部站点发起的跨站请求
 */
export const SESSION_TOKEN = randomBytes(18).toString('base64url')

function safeEqual(a, b) {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ab.length !== bb.length) return false
  try {
    return timingSafeEqual(ab, bb)
  } catch {
    return false
  }
}

/** 请求是否来自本机页面（防 DNS rebinding / 跨站表单）。 */
export function isLocalRequest(headers = {}) {
  const host = String(headers.host ?? '').split(':')[0].toLowerCase()
  if (host && !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) return false

  const origin = headers.origin
  if (origin) {
    try {
      const u = new URL(origin)
      if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname.toLowerCase())) return false
    } catch {
      return false
    }
  }
  // 跨站预检之后浏览器会带这个头；只有被显式允许的跨站请求才会有值
  if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return false
  return true
}

/**
 * 写操作校验。
 *   - 必须来自本机页面（Origin / Host / Sec-Fetch-Site）
 *   - 必须是 application/json：跨站表单发不出这个类型，发得出就必须过预检，而预检会被拒
 *   - requireToken 时再要求 X-Roundtable-Token（独立配置台用，DSH 内嵌页拿不到）
 */
export function checkWriteAuth(headers = {}, { requireToken = false } = {}) {
  if (!isLocalRequest(headers)) return '拒绝：请求不是来自本机页面'
  const ctype = String(headers['content-type'] ?? '').toLowerCase()
  if (!ctype.includes('application/json')) return '拒绝：写操作必须使用 application/json'
  if (requireToken) {
    const token = String(headers['x-roundtable-token'] ?? '')
    if (!safeEqual(token, SESSION_TOKEN)) return '拒绝：缺少或错误的 X-Roundtable-Token'
  }
  return null
}

/** 给页面用的常量时间指纹，方便前端判断 token 是否已注入（不泄露 token 本身）。 */
export function tokenFingerprint() {
  return createHash('sha256').update(SESSION_TOKEN).digest('hex').slice(0, 12)
}
