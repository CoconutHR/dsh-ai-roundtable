/**
 * 圆桌核心逻辑（只依赖 Node 内置模块，可脱离 DSH 单独测试）
 *
 * 与「轮流发言」的区别：每轮先问调度员「接下来谁最该说」，由它点名，
 * 而不是机械地按顺序来过一遍。
 */

import { randomUUID } from 'node:crypto'

const DEFAULTS = {
  style: 'debate',
  maxRounds: 2,
  maxTokens: 800,
  temperature: 0.8,
  // 单次 HTTP 请求的超时（不是整步的超时）
  timeoutMs: 120000,
  maxWordsPerTurn: 300,
  blindFirstRound: true,
  // 席位级容错
  maxRetries: 2,
  retryBaseMs: 400,
  retryMaxMs: 8000,
  maxSeatFailures: 2,
  // 调度员默认开思考：它做的是「读完整场再判断」，值得多花钱；
  // 发言者的思考由席位自己的 thinking 决定（默认 auto，实战建议关闭）
  moderatorThinking: 'on',
  // 0 = 由 timeoutMs × (maxRetries+1) × 2 自动推算
  stepTimeoutMs: 0,
  showThinking: false,
}

/**
 * 可重试的状态码：限流、上游过载、网关抖动。
 * 401/403/404/422 这类是配置问题，重试只会浪费配额和等待时间。
 */
export const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])

const SCHEDULER_BASE = `你是这场多 AI 圆桌讨论的调度员。你中立、不发表观点，只决定接下来谁发言。

判断依据（按优先级）：
0. 人类主持刚说过话 —— 优先让能接住这句话的人回应；没人接得住就选最可能不同意的人。
1. 上一条发言点到了谁的名字、或批评了谁的观点 —— 被点名的人优先回应。
2. 谁掌握还没被说出来的关键证据或反例。
3. 谁的观点正在被误读 —— 让本人澄清优先于让别人替他辩护。
4. 同一人不连续发言两次，除非只有他能回应。
5. 如果讨论已经收敛、或者开始重复空转 —— 直接收场。
{styleRule}
只输出一行 JSON，不要解释、不要代码块：
{"next":"<参与者名字>","reason":"<不超过20字>"}
要收场时输出：{"next":"end","reason":"<不超过20字>"}`;

const SPEAKER_BASE = `你正在参加一场多 AI 圆桌讨论，同席还有几个不同的 AI 和一位人类主持。
议题：{topic}

发言纪律：
1. 第一句先表态：同意或不同意谁的具体哪一点，点名并引用对方的关键词。
2. 然后只讲别人没讲到的：新证据、新反例、被忽略的约束。不复述、不客套、不总结全场。
3. 要纠正事实错误，直接说「这条不对，因为……」。
4. 允许说「我不同意，但证据不足」。
5. {limit} 字以内，短段落，不要写大标题。
6. 关键断言前标 [事实] / [推测] / [偏好]。没有来源的不要标成 [事实]，标了 [事实] 就要能说出处。
{styleRule}
你的席位：{name}｜定位：{persona}`;

const NOTE_BASE = `你是这场探讨的记录员，不是裁判。不要打分、不要裁决、不要给"建议采用哪个方案"。
你只做一件事：把这场讨论摊开，让人自己做判断。

本次讨论风格：{style}

写作要求：
1. 角度按新颖程度从高到低排，每条一行并标出是谁提的，重复的合并成一条。
2. 分歧部分每条固定三行：分歧点 / 甲方最强理由 / 乙方最强理由，并标明是事实分歧、价值分歧还是定义分歧。
3. 未解问题 1-4 条，按重要性排序。
4. 最后的"三个方向"是给人类的提问建议，不是行动建议。
5. 只输出下面四个标题及内容，不要输出这些要求本身，也不要加开场白。

## 出现了哪些角度

## 真正的分歧

## 还没人回答的问题

## 可以接着问的三个方向`;

/**
 * 讨论风格。每种风格同时改三处：调度员挑人的偏好、发言者的纪律、纪要的形状。
 * 只改措辞不改结构，是为了让同一套状态机跑所有风格。
 */
export const STYLES = {
  debate: {
    label: '辩论',
    hint: '两方对垒，逼出最强论证，不许和稀泥',
    schedule: '优先让立场被挑战的人回应；没人被点名时，选与上一条观点最相反的人。',
    speak: '你必须站在一个明确立场上：先把对方观点的最强版本复述一遍（steelman），再反驳。禁止「各有道理」「取决于场景」式收尾。',
    shape: `## 一句话结论

## 双方最强论点
（正方一条 / 反方一条，各不超过两行）

## 分歧的真正来源
（事实分歧 / 价值分歧 / 定义分歧，指明是哪一种）

## 什么证据能判胜负
（1-2 条可查证的事实）`,
  },
  brainstorm: {
    label: '头脑风暴',
    hint: '先求量，禁止否定，最后才排序',
    schedule: '优先让方向与上一条最不重合的人发言；没人有明显差异时，选还没说过的人。',
    speak: '这一轮只加不否：给出一个别人没提过的方向，并说清它反直觉在哪。不许评价别人的想法好坏，不许说「但是」。',
    shape: `## 方向清单
（按疯狂程度从低到高排序，每条一行）

## 值得先试的三个
（说明为什么是这三个）

## 明显不可行的
（列出并给淘汰理由，避免下一轮重复讨论）`,
  },
  redteam: {
    label: '红队',
    hint: '只找失败路径、隐藏假设和滥用场景',
    schedule: '优先让最能攻击上一条结论的人发言；同一人连续攻击两次以内允许。',
    speak: '你的任务不是评价好坏，是找它怎么失败：给出触发条件、失败路径、以及谁会被这个失败伤到。每条都要能复现，或能举出真实案例。',
    shape: `## 最可能失败的三个点
（每条：触发条件 / 失败路径 / 影响面）

## 被默认成立但没被验证的假设
（逐条列出）

## 如果只能先堵一个洞
（选一个，说明理由）`,
  },
  postmortem: {
    label: '复盘',
    hint: '还原时间线，分清根因和诱因',
    schedule: '优先让掌握时间线细节的人发言；其次是能区分根因与诱因的人。',
    speak: '用时间线说话：发生了什么、什么时候、谁做的决定。区分根因与诱因，区分可控与不可控。不评价人，只评价机制。',
    shape: `## 时间线
（按时间顺序，每条一行）

## 根因 / 诱因
（各一条，说明区别）

## 机制上该改什么
（2-3 条，要能落到流程或检查项）

## 下次怎么尽早发现
（一个可观测的信号）`,
  },
  socratic: {
    label: '苏格拉底',
    hint: '只提问和澄清定义，不给结论',
    schedule: '优先让定义最模糊的那个概念的责任人发言；其次是前提最可疑的人。',
    speak: '这一轮不给结论，只提问：追问一个关键概念的定义、一个被跳过的前提、或一个反例。问题要具体到对方必须回答，不能是「你怎么看」。',
    shape: `## 被追问的核心概念
（列出并指出各自的定义分歧）

## 尚未回答的问题
（按重要性排序）

## 目前能确定的最小结论
（一句话，只写各方都不否认的部分）`,
  },
  decision: {
    label: '决策',
    hint: '收敛到可执行选项，给出取舍判据',
    schedule: '优先让能给出可执行方案的人发言；其次是能指出方案代价的人。',
    speak: '把讨论往可执行上拉：给出一个具体选项，写清代价、前置条件、以及什么情况下它会失败。不要停在原则层面。',
    shape: `## 可选方案
（2-3 个，每个一行：做什么 / 代价 / 前置条件）

## 判据
（按重要性排序）

## 建议
（选一个，说明为什么不是另外几个）

## 第一步
（明天就能做的一件事）`,
  },
};

export const STYLE_IDS = Object.keys(STYLES);

function styleOf(style) {
  return STYLES[style] ?? STYLES.debate;
}

/**
 * 模板填充。
 * 必须用函数式替换：String.replace 的替换串里 `$&` / `` $` `` / `$'` / `$1` 有特殊含义，
 * 席位人设或议题里只要出现 `$&`，整段提示词就会被上一段内容顶掉。
 */
function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
    Object.hasOwn(vars, key) ? String(vars[key]) : whole,
  );
}

function schedulerSystem(room) {
  const s = styleOf(room.style);
  return fill(SCHEDULER_BASE, { styleRule: `\n本次风格：${s.label}（${s.hint}）\n${s.schedule}\n` });
}

function speakerSystem(room, seat, limit) {
  const s = styleOf(room.style);
  return fill(SPEAKER_BASE, {
    styleRule: `\n本次风格：${s.label}（${s.hint}）\n${s.speak}\n`,
    topic: room.topic,
    limit,
    name: seat.name,
    persona: seat.persona,
  });
}

function noteSystem(room) {
  return fill(NOTE_BASE, { style: styleOf(room.style).label });
}

/**
 * 房间表：内存索引 + 可选的持久化后端。
 *
 * core.js 不直接碰文件系统（要保持可脱离 Node 的干净逻辑，也方便测试），
 * 所以持久化以「注入的存储后端」形式接进来：{ load(), save(rooms), ttlMs }。
 * 没注入后端时行为与 1.1.0 完全一致（纯进程内）。
 */
const rooms = new Map();
const DEFAULT_ROOM_TTL_MS = 2 * 60 * 60 * 1000;

let store = null;
let loaded = false;

/**
 * 注入持久化后端。
 * @param backend - { load(): room[], save(rooms: room[]): void, ttlMs?: number } 或 null
 */
export function attachRoomStore(backend) {
  store = backend && typeof backend === 'object' ? backend : null;
  loaded = false;
  if (store) hydrate();
}

/** 首次访问时把磁盘上的房间读回内存（惰性，避免 apply 阶段做 IO 拖慢启动）。 */
function hydrate() {
  if (!store || loaded) return;
  loaded = true;
  let list = [];
  try {
    list = store.load?.() ?? [];
  } catch {
    list = [];
  }
  for (const room of list) {
    if (room?.id && !rooms.has(room.id)) rooms.set(room.id, room);
  }
}

/** 把当前房间表写回磁盘。持久化失败不能影响讨论本身。 */
function persist() {
  if (!store) return false;
  try {
    store.save?.([...rooms.values()]);
    return true;
  } catch {
    return false;
  }
}

/** 有持久化时按后端的 TTL，否则用进程内的 2 小时。 */
function ttlMs() {
  const custom = Number(store?.ttlMs);
  if (Number.isFinite(custom) && custom >= 0) return custom;
  return store ? DEFAULT_ROOM_TTL_MS : DEFAULT_ROOM_TTL_MS;
}

function sweep() {
  hydrate();
  const now = Date.now();
  const ttl = ttlMs();
  if (ttl <= 0) return;
  let changed = false;
  for (const [id, room] of rooms) {
    if (now - (room.updatedAt ?? room.createdAt) > ttl) {
      rooms.delete(id);
      changed = true;
    }
  }
  if (changed) persist();
}

/** 把插件配置规整成运行时结构；缺字段不抛错，留到调用时给提示。 */
export function normalizeConfig(raw = {}) {
  const participants = (Array.isArray(raw.participants) ? raw.participants : [])
    .map((p) => ({
      name: String(p.name ?? '').trim(),
      baseUrl: String(p.baseUrl ?? '').trim().replace(/\/+$/, ''),
      model: String(p.model ?? '').trim(),
      apiKey: String(p.apiKey ?? '').trim() || (p.apiKeyEnv ? String(process.env[p.apiKeyEnv] ?? '').trim() : ''),
      apiKeyEnv: String(p.apiKeyEnv ?? '').trim() || undefined,
      persona: String(p.persona ?? '').trim() || '独立判断者',
      thinking: ['auto', 'on', 'off'].includes(p.thinking) ? p.thinking : 'auto',
      kind: ['auto', 'openai', 'anthropic'].includes(p.kind) ? p.kind : 'auto',
      // 供应商私有参数的透传口：盖不住的情况从这里兜底。
      extraBody: p.extraBody && typeof p.extraBody === 'object' ? p.extraBody : undefined,
    }))
    .filter((p) => p.name && p.baseUrl && p.model);

    const int = (v, fallback, min, max) => {
    const n = Number(v);
    if (v === '' || v === null || v === undefined || !Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  };

  const moderator = participants.find((p) => p.name === raw.moderator) ?? participants[0];
  return {
    participants,
    moderator,
    style: STYLES[raw.style] ? raw.style : DEFAULTS.style,
    maxRounds: int(raw.maxRounds, DEFAULTS.maxRounds, 1, 6),
    maxTokens: int(raw.maxTokens, DEFAULTS.maxTokens, 64, 32000),
    temperature: int(raw.temperature, DEFAULTS.temperature, 0, 2),
    timeoutMs: int(raw.timeoutMs, DEFAULTS.timeoutMs, 5000, 600000),
    maxWordsPerTurn: int(raw.maxWordsPerTurn, DEFAULTS.maxWordsPerTurn, 80, 4000),
    blindFirstRound: raw.blindFirstRound !== false,
    maxRetries: int(raw.maxRetries, DEFAULTS.maxRetries, 0, 5),
    retryBaseMs: int(raw.retryBaseMs, DEFAULTS.retryBaseMs, 0, 60000),
    retryMaxMs: int(raw.retryMaxMs, DEFAULTS.retryMaxMs, 0, 120000),
    maxSeatFailures: int(raw.maxSeatFailures, DEFAULTS.maxSeatFailures, 1, 10),
    stepTimeoutMs: int(raw.stepTimeoutMs, 0, 0, 3600000),
    moderatorThinking: ['auto', 'on', 'off'].includes(raw.moderatorThinking)
      ? raw.moderatorThinking
      : DEFAULTS.moderatorThinking,
    // 思考旁路：默认不显示；显示也不落盘、不进 transcript
    showThinking: raw.showThinking === true,
  };
}

/** 配置体检：返回人话错误，全部通过则返回 null。 */
export function checkConfig(cfg) {
  if (!cfg.participants.length) {
    return '还没有配置参与者。请在 DSH 插件配置里填 participants（name / baseUrl / model / apiKey）。';
  }
  const ready = cfg.participants.filter((p) => p.apiKey);
  if (ready.length < 2) {
    const missing = cfg.participants.filter((p) => !p.apiKey).map((p) => p.name);
    return (
      '至少需要 2 个配好 apiKey 的席位。' +
      (missing.length ? `当前缺少：${missing.join('、')}。` : '当前一个都没有。') +
      '请在 DSH 插件配置的 participants 里填 apiKey 或 apiKeyEnv。'
    );
  }
  return null;
}

/* ─────────────────────────── 思考模式 ─────────────────────────── */

/**
 * 角色决定思考策略。
 *
 * 调度员和发言者要的东西正相反：
 *   - 调度员要读完整场记录，判断谁最该说、讨论是否收敛、有没有空转 —— 真正的深推理
 *   - 发言者要尖锐、具体、敢反驳；实测开思考慢 3–4 倍、贵一倍，
 *     而且推理模型倾向自我审查，容易把「各有道理」这类和稀泥话术带回来，
 *     恰好是发言纪律里明令禁止的
 *
 * 所以「席位级 thinking」管发言，「moderatorThinking」管调度与纪要。
 */
export const ROLE = {
  speaker: 'speaker',
  moderator: 'moderator',
};

/**
 * 这个角色这一次该用哪种思考模式。
 *
 * 优先级：显式配置 > 角色默认。
 * 席位的 `thinking` 只在说话时生效；调度 / 纪要走 `cfg.moderatorThinking`。
 */
export function thinkingModeFor(cfg, seat, role = ROLE.speaker) {
  if (role === ROLE.moderator) {
    return cfg?.moderatorThinking ?? DEFAULTS.moderatorThinking;
  }
  return seat?.thinking ?? 'auto';
}

/** 按角色把思考模式翻译成请求参数（Anthropic 由 anthropicThinking 处理）。 */
export function roleThinkingParams(cfg, seat, role) {
  return thinkingParams(seat, thinkingModeFor(cfg, seat, role));
}

/**
 * 把「思考模式」翻译成各家真实参数。
 * 不同供应商的开关名字完全不一样，所以这层必须集中在一处，不能散到调用点。
 * auto = 不动，跟随供应商默认。
 *
 * 注意：Anthropic 的形状完全不同（且与 temperature 互斥），
 * 由 anthropicThinking() 单独处理，这里不回传任何字段。
 */
export function thinkingParams(seat, mode) {
  if (!mode || mode === 'auto') return {};
  if (isAnthropic(seat)) return {};
  const url = String(seat.baseUrl ?? '');
  if (/volces\.com/.test(url)) {
    // 火山方舟：thinking 显式开关
    return { thinking: { type: mode === 'on' ? 'enabled' : 'disabled' } };
  }
  if (/api\.openai\.com/.test(url)) {
    // OpenAI 推理模型：没有布尔开关，只有强度
    return { reasoning_effort: mode === 'on' ? 'medium' : 'minimal' };
  }
  // 其它网关不猜，交给 extraBody
  return {};
}

/** Anthropic 扩展思考：budget_tokens 必须 ≥1024 且严格小于 max_tokens。 */
export const ANTHROPIC_MIN_THINK_BUDGET = 1024;

/**
 * 按「正文需要的 token」反推 max_tokens。
 *
 * 早先是先定死 maxTokens=800，再在 Anthropic 那边硬塞 1024 的思考预算，
 * 结果正文只剩 500 出头 —— 中文 300 字大约就要 450+ token，贴着上限被截断。
 * 正确顺序是：先算正文要多少，再把思考预算加上去。
 *
 * 中文 1 字 ≈ 1.5 token（含标点与 markdown 结构），留 1.6 的系数并把下限兜住。
 */
export function bodyTokenBudget(cfg) {
  const words = Math.max(80, Number(cfg?.maxWordsPerTurn) || DEFAULTS.maxWordsPerTurn);
  return Math.max(256, Math.ceil(words * 1.6));
}

/**
 * 这一次调用实际该给多少 max_tokens。
 *
 * - 不想思考：按正文字数算，不再用固定的 800
 * - 要思考（Anthropic）：正文预算 + 思考预算，保证思考吃不掉正文
 * - 要思考（其它网关）：正文预算再宽一些，给推理留余量
 */
export function maxTokensFor(cfg, seat) {
  const body = bodyTokenBudget(cfg);
  const thinking = seat?.thinking === 'on';
  if (!thinking) return body;
  if (isAnthropic(seat)) return ANTHROPIC_MIN_THINK_BUDGET + body;
  // 其它网关的 reasoning 也吃 completion 预算，多给一半兜底
  return Math.ceil(body * 1.5);
}

/** Anthropic 扩展思考：budget_tokens 固定下限，正文额度由 maxTokensFor 保证。 */
export function anthropicThinking(seat, mode, maxTokens) {
  if (mode !== 'on' || !isAnthropic(seat)) return null;
  const budget = ANTHROPIC_MIN_THINK_BUDGET;
  const requested = Number(maxTokens) || 0;
  // 模型限制：budget 必须严格小于 max_tokens
  const total = Math.max(requested, budget + 256);
  return { thinking: { type: 'enabled', budget_tokens: budget }, maxTokens: total };
}

/* ─────────────────────────── 地址与协议 ─────────────────────────── */

/**
 * 拼出 completions 地址，并容忍用户把完整 endpoint 也填进 baseUrl 的情况。
 * 常见错误：baseUrl = https://open.bigmodel.cn/api/paas/v4/chat/completions
 * 直接拼会变成 .../chat/completions/chat/completions → 404。
 */
export function completionsUrl(baseUrl) {
  const clean = String(baseUrl ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
  return `${clean}/chat/completions`
}

/**
 * 协议识别：Anthropic 与 OpenAI 兼容接口的差别不是"地址不同"，是整套请求/响应形状不同。
 * kind 显式指定优先；否则按域名猜（api.anthropic.com）。
 */
export function isAnthropic(seat) {
  if (seat?.kind === 'anthropic') return true;
  if (seat?.kind === 'openai') return false;
  return /anthropic\.com/i.test(String(seat?.baseUrl ?? ''));
}

/** 拼接请求地址：OpenAI 兼容是 /chat/completions，Anthropic 是 /messages。 */
export function requestUrl(seat) {
  if (!isAnthropic(seat)) return completionsUrl(seat.baseUrl);
  const clean = String(seat.baseUrl ?? '').trim().replace(/\/+$/, '').replace(/\/messages$/i, '');
  return `${clean}/messages`;
}

/* ─────────────────────────── 重试层 ─────────────────────────── */

/** 外部取消（用户按了停止）不该重试；自身超时（TimeoutError）应该重试。 */
function isUserAbort(err, signal) {
  if (!err) return false;
  if (signal?.aborted) return true;
  return err.name === 'AbortError';
}

/** 网络层抖动：fetch 的 TypeError、ECONNRESET、EAI_AGAIN 等。 */
function isRetryableNetworkError(err) {
  if (!err) return false;
  if (err.name === 'TimeoutError') return true;
  if (err.name === 'AbortError') return false;
  if (err.name === 'TypeError') return true; // undici 把连接类错误统一抛成 TypeError
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|socket hang up|network/i.test(
    String(err.code ?? '') + ' ' + String(err.message ?? ''),
  );
}

/** Retry-After 可能是秒数，也可能是 HTTP 日期；解析不出来就当没有。 */
function parseRetryAfter(headers) {
  if (!headers) return null;
  let raw = null;
  try {
    raw = typeof headers.get === 'function' ? headers.get('retry-after') : null;
  } catch {
    raw = null;
  }
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const at = Date.parse(text);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return null;
}

/** 指数退避 + 抖动；服务端给了 Retry-After 就听它的（但有上限）。 */
export function retryDelay(attempt, baseMs = DEFAULTS.retryBaseMs, maxMs = DEFAULTS.retryMaxMs, retryAfterMs = null) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return Math.min(maxMs, retryAfterMs);
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(exp * (0.5 + Math.random() * 0.5));
}

function sleep(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error('已取消');
      err.name = 'AbortError';
      err.aborted = true;
      reject(err);
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/** 一步（一次 next）的总预算：调度员 + 发言，各自最多 maxRetries+1 次。 */
export function stepBudgetMs(cfg) {
  if (Number.isFinite(cfg?.stepTimeoutMs) && cfg.stepTimeoutMs > 0) return cfg.stepTimeoutMs;
  const perCall = Number(cfg?.timeoutMs) || DEFAULTS.timeoutMs;
  const attempts = (Number(cfg?.maxRetries) || 0) + 1;
  return perCall * attempts * 2 + 5000;
}

/**
 * 单次 HTTP POST，带重试。
 *
 * 重试策略：
 *   - 只重试 408/409/425/429/5xx 与网络层抖动、自身超时
 *   - 401/403/404/422 这类配置错误立即失败，不浪费配额
 *   - 尊重 Retry-After
 *   - 用户主动取消立即失败，绝不重试
 */
async function postJson({ cfg, url, headers, payload, fetchImpl, signal }) {
  const retries = Math.max(0, Math.min(5, Number(cfg.maxRetries) || 0));
  const baseMs = Number.isFinite(cfg.retryBaseMs) ? cfg.retryBaseMs : DEFAULTS.retryBaseMs;
  const maxMs = Number.isFinite(cfg.retryMaxMs) ? cfg.retryMaxMs : DEFAULTS.retryMaxMs;
  const body = JSON.stringify(payload);

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) {
      const err = new Error('已取消');
      err.name = 'AbortError';
      err.aborted = true;
      throw err;
    }

    let failure;
    try {
      const timeout = AbortSignal.timeout(Number(cfg.timeoutMs) || DEFAULTS.timeoutMs);
      const attemptSignal =
        signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal || timeout;
      const res = await fetchImpl(url, { method: 'POST', headers, body, signal: attemptSignal });
      if (res.ok) return await res.json();
      const text = await res.text().catch(() => '');
      failure = {
        message: `HTTP ${res.status} ${String(text).slice(0, 180)}`.trim(),
        retryable: RETRYABLE_STATUS.has(res.status),
        retryAfterMs: parseRetryAfter(res.headers),
        attempts: attempt + 1,
      };
    } catch (e) {
      const aborted = isUserAbort(e, signal);
      failure = {
        message: e?.name === 'TimeoutError' ? `请求超时（${cfg.timeoutMs}ms）` : (e?.message ?? String(e)),
        retryable: !aborted && isRetryableNetworkError(e),
        retryAfterMs: null,
        aborted,
        attempts: attempt + 1,
      };
    }

    if (failure.aborted) {
      const err = new Error('已取消');
      err.name = 'AbortError';
      err.aborted = true;
      throw err;
    }
    if (!failure.retryable || attempt >= retries) {
      const err = new Error(failure.message);
      err.retryable = failure.retryable;
      err.attempts = failure.attempts;
      throw err;
    }
    await sleep(retryDelay(attempt, baseMs, maxMs, failure.retryAfterMs), signal);
  }
}

/**
 * 从 OpenAI 兼容响应里抽出正文与思考。
 *
 * 各家把思考放在不同字段：`reasoning_content`（DeepSeek-R1 系）、`reasoning`（OpenRouter）、
 * 或者内联在 content 块里。这里统一收口，**正文与思考分开返回**，绝不混在一起。
 */
export function splitMessage(message) {
  const reasoning = String(
    message?.reasoning_content ?? message?.reasoning ?? message?.thinking ?? '',
  ).trim();
  const c = message?.content;
  if (typeof c === 'string') return { text: c.trim(), reasoning };
  if (Array.isArray(c)) {
    const texts = [];
    const thinks = [];
    for (const b of c) {
      if (!b || typeof b.text !== 'string') {
        // Anthropic 风格的 thinking 块用 thinking 字段
        if (b && typeof b.thinking === 'string' && b.type === 'thinking') thinks.push(b.thinking);
        continue;
      }
      if (b.type === 'text' || b.type === 'output_text' || !b.type) texts.push(b.text);
      else if (b.type === 'thinking' || b.type === 'reasoning') thinks.push(b.text);
    }
    return { text: texts.join('\n').trim(), reasoning: [reasoning, ...thinks].filter(Boolean).join('\n').trim() };
  }
  if (typeof message?.text === 'string') return { text: message.text.trim(), reasoning };
  return { text: '', reasoning };
}

/** 把模型的 content 字段抽成文本（保留此导出，向后兼容）。 */
export function textOfMessage(message) {
  return splitMessage(message).text;
}

/**
 * 「预算被思考吃光」专用错误。
 *
 * 这不是网关故障，是配置问题：推理模型把 max_tokens 全花在思考上，
 * 正文为空。早先会被记成「模型返回了空内容」，然后计入 maxSeatFailures，
 * 连续两次就把一个完全健康的席位请出讨论。
 */
export class BudgetExhaustedError extends Error {
  constructor(reasoning, maxTokens) {
    super(
      `思考用尽了 ${maxTokens} token 预算，没有留下正文（思考长度 ${String(reasoning ?? '').length} 字）。` +
        '把「单次 max_tokens」调大，或把这个席位的思考关掉。',
    );
    this.name = 'BudgetExhaustedError';
    this.budgetExhausted = true;
  }
}

/** Anthropic Messages API：system 是顶层字段，不放在 messages 里。 */
async function anthropicChat(cfg, seat, messages, fetchImpl, externalSignal, role = ROLE.speaker) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system');
  const mode = thinkingModeFor(cfg, seat, role);
  const budget = maxTokensFor(cfg, { ...seat, thinking: mode });
  const think = anthropicThinking(seat, mode, budget);
  const body = {
    model: seat.model,
    max_tokens: think ? think.maxTokens : budget,
    messages: turns.length ? turns : [{ role: 'user', content: '……' }],
    ...(system ? { system } : {}),
    // 扩展思考开启时 Anthropic 不接受 temperature，必须整个省掉
    ...(think ? { thinking: think.thinking } : { temperature: cfg.temperature }),
    ...(seat.extraBody ?? {}),
  };

  const data = await postJson({
    cfg,
    url: requestUrl(seat),
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': seat.apiKey,
      'anthropic-version': '2023-06-01',
    },
    payload: body,
    fetchImpl,
    signal: externalSignal,
  });
  const content = Array.isArray(data?.content) ? data.content : [];
  const text = content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
  const reasoning = content
    .filter((b) => b?.type === 'thinking' && typeof b.thinking === 'string')
    .map((b) => b.thinking)
    .join('\n')
    .trim();

  if (!text && reasoning) throw new BudgetExhaustedError(reasoning, body.max_tokens);
  if (!text) throw new Error('模型返回了空内容');
  return {
    text,
    reasoning,
    finishReason: data?.stop_reason ?? null,
    truncated: data?.stop_reason === 'max_tokens',
    usage: data?.usage ?? null,
  };
}

async function openaiChat(cfg, seat, messages, fetchImpl, externalSignal, role = ROLE.speaker) {
  const mode = thinkingModeFor(cfg, seat, role);
  const budget = maxTokensFor(cfg, { ...seat, thinking: mode });
  const data = await postJson({
    cfg,
    url: completionsUrl(seat.baseUrl),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${seat.apiKey}`,
    },
    payload: {
      model: seat.model,
      messages,
      max_tokens: budget,
      temperature: cfg.temperature,
      ...thinkingParams(seat, mode),
      // 席位级透传：放最后，允许覆盖上面的默认值
      ...(seat.extraBody ?? {}),
    },
    fetchImpl,
    signal: externalSignal,
  });
  const choice = data?.choices?.[0] ?? {};
  const { text, reasoning } = splitMessage(choice.message ?? choice);
  const finishReason = choice.finish_reason ?? null;

  if (!text && reasoning) throw new BudgetExhaustedError(reasoning, budget);
  if (!text) throw new Error('模型返回了空内容');
  return {
    text,
    reasoning,
    finishReason,
    // OpenAI 兼容网关普遍用 finish_reason=length 表示撞到 max_tokens
    truncated: finishReason === 'length',
    usage: data?.usage ?? null,
  };
}

/** 统一出口：所有调用返回 { text, reasoning, finishReason, truncated, usage }。 */
async function chat(cfg, seat, messages, fetchImpl = fetch, signal, role = ROLE.speaker) {
  if (!seat?.apiKey) {
    const why = seat?.name ? `席位「${seat.name}」没有 apiKey` : '这个席位没有 apiKey';
    throw new Error(`${why}（如果是重启后接着聊，请确认它仍在插件配置里）`);
  }
  return isAnthropic(seat)
    ? await anthropicChat(cfg, seat, messages, fetchImpl, signal, role)
    : await openaiChat(cfg, seat, messages, fetchImpl, signal, role);
}

/** 只要正文的调用方用这个（调度员的 JSON 解析、纪要）。 */
async function chatText(cfg, seat, messages, fetchImpl, signal, role = ROLE.speaker) {
  return (await chat(cfg, seat, messages, fetchImpl, signal, role)).text;
}

/* ─────────────────────────── 记录与渲染 ─────────────────────────── */

/** 一条记录是不是「真实发言」。失败与中断都不算。 */
export function isRealTurn(entry) {
  return entry?.role === 'ai' && entry?.status !== 'failed' && entry?.status !== 'aborted';
}

function realTurns(room) {
  return room.transcript.filter(isRealTurn).length;
}

/** 因连续失败被请出讨论的席位，不参与轮换，也不占轮次额度。 */
function benched(room) {
  return room.benched instanceof Set ? room.benched : new Set();
}

/** 还能说话的席位。 */
export function activeSeats(room) {
  const out = benched(room);
  return room.participants.filter((p) => !out.has(p.name));
}

/**
 * 首轮互不可见：每人各说一次之前，AI 之间看不到彼此的发言，只能看到人类说的话。
 * 这是独立性保证 —— 先看别人再开口，观点必然趋同。
 * 失败记录不参与计数，否则会提前打破盲区，把别人的报错喂进上下文。
 */
export function visibleEntries(room) {
  const real = room.transcript.filter((m) => m.status !== 'failed' && m.status !== 'aborted');
  if (room.blindFirstRound === false) return real;
  const quota = Math.max(1, activeSeats(room).length);
  if (realTurns(room) < quota) return real.filter((m) => m.role === 'human');
  return real;
}

export function renderTranscript(room, perMsg = 900) {
  return renderEntries(visibleEntries(room), perMsg);
}

export function renderEntries(entries, perMsg = 900) {
  if (!entries.length) return '【还没有人发言】';
  const lines = entries.map((m) => {
    const who = m.role === 'human' ? `${m.name}（人类主持）` : m.name;
    const failed = m.status === 'failed' ? '（本条发言失败，内容不可用）' : '';
    // 截断也要标出来：让后面的人知道这是半句，别当成完整论证去反驳
    const cut = m.truncated ? '（本条被长度上限截断，末尾不完整）' : '';
    return `[第${m.round}轮] ${who}${failed}${cut}：${m.text.slice(0, perMsg)}`;
  });
  return `【已有发言】\n\n${lines.join('\n\n')}`;
}

function schedulerMessages(room) {
  const names = activeSeats(room).map((p) => p.name).join('、');
  return [
    { role: 'system', content: schedulerSystem(room) },
    {
      role: 'user',
      content: `议题：${room.topic}\n参与者：${names}\n\n${renderEntries(visibleEntries(room))}\n\n请决定下一位发言者。`,
    },
  ];
}

/** 从调度员的自由文本里抠出 JSON（模型偶尔会包代码块或加解释）。 */
export function parseDecision(raw, names) {
  const text = String(raw ?? '');
  // 模型有时会把 JSON 前面加一句中文，这里从第一个 { 开始贪到最后一个 }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) return null;
    try {
      obj = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  const next = String(obj?.next ?? '').trim();
  const reason = String(obj?.reason ?? '').trim().slice(0, 60);
  if (!next) return null;
  if (next.toLowerCase() === 'end') return { next: 'end', reason };
  const hit = names.find((n) => n.toLowerCase() === next.toLowerCase());
  return hit ? { next: hit, reason } : null;
}

/**
 * 兜底轮换：调度员抽风或被请出场时不要卡死整场讨论。
 * 必须真的轮转 —— 早先的实现「全员都说过就返回 participants[0]」，
 * 会让整场讨论塌成同一个人自言自语。
 */
function rotate(room) {
  const pool = activeSeats(room);
  if (!pool.length) return null;
  const counts = new Map(pool.map((p) => [p.name, 0]));
  let lastIndex = -1;
  for (const m of room.transcript) {
    if (m.role === 'ai' && counts.has(m.name)) counts.set(m.name, counts.get(m.name) + 1);
    if (m.role === 'ai') {
      const idx = pool.findIndex((p) => p.name === m.name);
      if (idx >= 0) lastIndex = idx;
    }
  }
  let best = null;
  for (let i = 0; i < pool.length; i++) {
    const idx = (lastIndex + 1 + i) % pool.length;
    const seat = pool[idx];
    const n = counts.get(seat.name);
    if (!best || n < best.n) best = { seat, n };
  }
  return best?.seat.name ?? pool[0].name;
}

/**
 * 开一间房。
 * @param cfg - normalizeConfig 的产物
 * @param topic - 议题
 * @param opts - { maxRounds, style, blindFirstRound }
 */
export function openRoom(cfg, topic, opts = {}) {
  sweep();
  const clean = String(topic ?? '').trim();
  if (!clean) throw new Error('议题不能为空');
  // 8 位十六进制：36^4 的空间在几十个房间时就会撞，撞了会串房
  const id = `rt-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const room = {
    id,
    topic: clean,
    participants: cfg.participants,
    moderator: cfg.moderator,
    maxRounds: Number.isFinite(opts.maxRounds) ? Math.max(1, Math.min(6, opts.maxRounds)) : cfg.maxRounds,
    style: STYLES[opts.style] ? opts.style : cfg.style,
    blindFirstRound: opts.blindFirstRound ?? cfg.blindFirstRound,
    transcript: [],
    benched: new Set(),
    fails: new Map(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  rooms.set(id, room);
  persist();
  return room;
}

export function getRoom(roomId) {
  sweep();
  return rooms.get(String(roomId ?? '').trim());
}

/**
 * 用当前配置的密钥补给房间里的席位。
 *
 * 房间存档**故意不存 apiKey**（磁盘上少一份明文），所以重启后恢复的房间是"空壳席位"。
 * 发请求前按名字回填；配置里已经删掉的席位就保持无 key，调用时会给出人话提示
 * （「席位 X 没有 apiKey」），而不是悄无声息地 401。
 *
 * @returns 补好 key 的 room（原地修改，返回自身便于链式调用）
 */
export function hydrateSeats(room, cfg) {
  if (!room || !cfg) return room;
  const byName = new Map((cfg.participants ?? []).map((p) => [p.name, p]));
  room.participants = (room.participants ?? []).map((seat) => {
    const live = byName.get(seat.name);
    if (!live) return { ...seat, apiKey: seat.apiKey ?? '' };
    return { ...seat, apiKey: live.apiKey || seat.apiKey || '', thinking: live.thinking ?? seat.thinking, kind: live.kind ?? seat.kind };
  });
  if (room.moderator?.name) {
    const live = byName.get(room.moderator.name);
    room.moderator = room.participants.find((p) => p.name === room.moderator.name)
      ?? { ...room.moderator, apiKey: live?.apiKey ?? '' };
  }
  return room;
}

export function listRoomIds() {
  sweep();
  return [...rooms.keys()];
}

/** 当前轮次：每人各说一次算一轮（失败不计）。 */
export function currentRound(room) {
  const seats = Math.max(1, activeSeats(room).length);
  return Math.floor(realTurns(room) / seats) + 1;
}

/** 记录一次失败，连续失败到阈值就把席位请出讨论，避免整场卡在一张死席位上。 */
function recordFailure(cfg, room, seat, message, round) {
  room.transcript.push({ name: seat.name, role: 'ai', text: `[调用失败] ${message}`, round, status: 'failed' });
  const n = (room.fails.get(seat.name) ?? 0) + 1;
  room.fails.set(seat.name, n);
  const limit = Math.max(1, Number(cfg.maxSeatFailures) || DEFAULTS.maxSeatFailures);
  if (n >= limit) room.benched.add(seat.name);
  room.updatedAt = Date.now();
  return { benched: room.benched.has(seat.name), fails: n, limit };
}
/** 一步的总预算：外部取消与自身预算合成一个 signal。 */
function stepSignal(cfg, external) {
  const ctrl = new AbortController();
  let budgetHit = false;
  const budget = stepBudgetMs(cfg);
  const timer = setTimeout(() => {
    budgetHit = true;
    ctrl.abort();
  }, budget);
  timer.unref?.();
  const signal =
    external && typeof AbortSignal.any === 'function' ? AbortSignal.any([external, ctrl.signal]) : external || ctrl.signal;
  return {
    signal,
    budget,
    hitBudget: () => budgetHit,
    cleanup: () => clearTimeout(timer),
  };
}

function abortedResult() {
  return { done: false, aborted: true, error: '已取消，本轮不计入记录' };
}

/**
 * 走一步：调度员点名 → 被点名者发言。
 * @returns {{done:boolean, speaker?:string, text?:string, reason?:string, round?:number, error?:string, aborted?:boolean, benched?:string}}
 */
export async function nextTurn(cfg, room, fetchImpl = fetch, signal) {
  const active = activeSeats(room);
  if (active.length < 2) {
    return { done: true, reason: '可用席位不足两个，讨论提前结束' };
  }
  if (realTurns(room) >= active.length * room.maxRounds) {
    return { done: true, reason: `已经说满 ${room.maxRounds} 轮` };
  }

  const budget = stepSignal(cfg, signal);
  try {
    const names = active.map((p) => p.name);
    const blind = realTurns(room) < active.length;
    let decision = null;
    let schedulerNote = '';

    // 调度员自己也可能挂掉或被请出；这时自动落到另一个还在的席位
    const moderator = active.find((p) => p.name === room.moderator?.name) ?? active[0];

    if (blind) {
      // 首轮：不调调度员。大家都看不到别人，点名没有意义，还白花一次调用。
      schedulerNote = '首轮互不可见，按轮换';
    } else {
      try {
        const raw = await chatText(
          cfg,
          moderator,
          schedulerMessages(room),
          fetchImpl,
          budget.signal,
          ROLE.moderator,
        );
        decision = parseDecision(raw, names);
        if (!decision) schedulerNote = '调度员输出无法解析，按轮换兜底';
      } catch (e) {
        if (e?.aborted || budget.hitBudget()) return abortedResult();
        schedulerNote = `调度员调用失败（${e.message}），按轮换兜底`;
      }
    }

    if (decision?.next === 'end') {
      return { done: true, reason: decision.reason || '调度员判断讨论已收敛' };
    }

    const speakerName = decision?.next ?? rotate(room);
    const seat = active.find((p) => p.name === speakerName) ?? active[0];
    if (!seat) return { done: true, reason: '没有可发言的席位' };

    const messages = [
      {
        role: 'system',
        content: speakerSystem(room, seat, cfg.maxWordsPerTurn ?? DEFAULTS.maxWordsPerTurn),
      },
      {
        role: 'user',
        content: (() => {
          const seen = visibleEntries(room);
          const head = renderEntries(seen);
          if (!seen.some((m) => m.role === 'ai')) {
            return `${head}\n\n首轮互不可见：你还没看到任何人的发言。直接给出你的判断、三条理由、以及你最可能错在哪。不要假设别人说过什么，也不要虚构反方观点。`;
          }
          return `${head}\n\n现在轮到你（${seat.name}）发言。直接输出发言内容，不要重复自己的席位名。`;
        })(),
      },
    ];

    const round = currentRound(room);
    let result;
    try {
      result = await chat(cfg, seat, messages, fetchImpl, budget.signal);
    } catch (e) {
      // 用户主动取消 / 整步预算耗尽：不写记录，不占轮次，房间保持干净
      if (e?.aborted || budget.hitBudget()) return abortedResult();

      // 预算被思考吃光不是「席位坏了」，是配置问题：不该计入 maxSeatFailures
      if (e?.budgetExhausted) {
        return {
          done: false,
          speaker: seat.name,
          text: `[预算不足] ${e.message}`,
          reason: `${decision?.reason || schedulerNote || '按轮换'}｜思考挤占了正文预算`,
          round,
          error: e.message,
          budgetExhausted: true,
        };
      }

      const fail = recordFailure(cfg, room, seat, e.message, round);
      persist();
      const tail = fail.benched ? `（连续失败 ${fail.fails} 次，已请出讨论）` : '';
      const left = activeSeats(room).length;
      return {
        done: left < 2,
        speaker: seat.name,
        text: `[调用失败] ${e.message}`,
        reason: left < 2
          ? `可用席位不足两个，讨论提前结束${tail}`
          : `${decision?.reason || schedulerNote || '按轮换'}｜重试 ${e.attempts ?? 1} 次仍失败${tail}`,
        round,
        error: e.message,
        benched: fail.benched ? seat.name : undefined,
      };
    }

    const text = result.text;
    room.fails.delete(seat.name);
    room.transcript.push({
      name: seat.name,
      role: 'ai',
      text,
      round,
      status: 'ok',
      // 被 max_tokens 截断的半句话要留痕：后面的人不该把断句当完整论证来反驳
      ...(result.truncated ? { truncated: true, finishReason: result.finishReason } : {}),
    });
    room.updatedAt = Date.now();
    persist();
    return {
      done: false,
      speaker: seat.name,
      text,
      // 思考走旁路：给人类看，不进 transcript、不喂给其他席位
      ...(result.reasoning && cfg.showThinking !== false ? { thinking: result.reasoning } : {}),
      ...(result.truncated ? { truncated: true } : {}),
      reason: decision?.reason || schedulerNote || '按轮换',
      round,
    };
  } finally {
    budget.cleanup();
  }
}

/** 让人（或主持 AI）插一句话，下一轮所有人都会看到。 */
export function sayInRoom(room, text, name = '人类主持') {
  const clean = String(text ?? '').trim();
  if (!clean) throw new Error('插话内容不能为空');
  room.transcript.push({ name, role: 'human', text: clean, round: currentRound(room), status: 'ok' });
  room.updatedAt = Date.now();
  persist();
  return room.transcript.length;
}

/** 纪要失败的兜底：至少把记录按人头摊开，不要只丢一句报错。 */
function fallbackSummary(room) {
  const lines = ['## 出现了哪些角度', '（纪要模型不可用，以下是原始发言索引）', ''];
  for (const m of room.transcript) {
    if (m.status === 'failed') continue;
    const who = m.role === 'human' ? `${m.name}（人类主持）` : m.name;
    lines.push(`- [第${m.round}轮] ${who}：${m.text.slice(0, 120)}`);
  }
  return lines.join('\n');
}

/** 收场：出纪要。 */
export async function closeRoom(cfg, room, fetchImpl = fetch, signal) {
  const usable = room.transcript.filter((m) => m.status !== 'failed' && m.status !== 'aborted');
  if (!usable.length) return { summary: '还没有人发言。', transcript: '【还没有人发言】' };
  const messages = [
    { role: 'system', content: noteSystem(room) },
    { role: 'user', content: `议题：${room.topic}\n\n${renderEntries(usable, 1200)}` },
  ];
  const moderator = activeSeats(room).find((p) => p.name === room.moderator?.name) ?? activeSeats(room)[0] ?? room.moderator;
  let summary;
  try {
    summary = await chatText(cfg, moderator, messages, fetchImpl, signal, ROLE.moderator);
  } catch (e) {
    if (e?.aborted) throw e;
    summary = `[纪要生成失败] ${e.message}\n\n${fallbackSummary(room)}`;
  }
  return { summary, transcript: renderEntries(usable) };
}

/**
 * 清掉一间房。
 * 注意：本操作是破坏性的，且会同步落盘 —— 误删就找不回来了。
 */
export function dropRoom(roomId) {
  sweep();
  const removed = rooms.delete(String(roomId ?? '').trim());
  if (removed) persist();
  return removed;
}

/** 房间摘要，给 list 用：重启后还能看出每间房聊到哪了。 */
export function roomSummary(room) {
  return {
    id: room.id,
    topic: room.topic,
    style: room.style,
    round: currentRound(room),
    maxRounds: room.maxRounds,
    spoken: realTurns(room),
    participants: room.participants.map((p) => p.name),
    benched: [...benched(room)],
    updatedAt: room.updatedAt ?? room.createdAt,
  };
}

/** 列出房间摘要（最近活跃的排在前面）。 */
export function listRooms() {
  sweep();
  return [...rooms.values()]
    .map(roomSummary)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 当前进程里是否有持久化后端（给 config 动作显示状态用）。 */
export function hasRoomStore() {
  return Boolean(store);
}

/** 把内存里的房间立刻写盘（收场、退出前调用，确保最后一句不丢）。 */
export function flushRooms() {
  return persist();
}
