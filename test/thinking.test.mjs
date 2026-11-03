/**
 * 思考通道相关的测试。
 *
 * 三条被反复踩的坑，各用一组用例钉住：
 *   1. 思考内容不能进 transcript / 不能喂给其他席位
 *   2. 预算被思考吃光 ≠ 网关故障（不能把健康席位请出讨论）
 *   3. 被 max_tokens 截断的半句话必须留痕
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeConfig,
  openRoom,
  nextTurn,
  visibleEntries,
  renderEntries,
  splitMessage,
  textOfMessage,
  bodyTokenBudget,
  maxTokensFor,
  anthropicThinking,
  ANTHROPIC_MIN_THINK_BUDGET,
  thinkingModeFor,
  roleThinkingParams,
  ROLE,
  closeRoom,
} from '../lib/core.js'

const mk = (over = {}) => normalizeConfig({
  participants: [
    { name: 'A', baseUrl: 'https://a.test/v1', model: 'm', apiKey: 'k1', ...(over.seatA ?? {}) },
    { name: 'B', baseUrl: 'https://b.test/v1', model: 'm', apiKey: 'k2' },
  ],
  moderator: 'A',
  retryBaseMs: 0,
  ...over.cfg,
})

const sched = (next = 'A') => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: `{"next":"${next}","reason":"x"}` } }] }),
})

const speaker = (message, extra = {}) => ({
  ok: true,
  json: async () => ({ choices: [{ message, ...extra }] }),
})

/** 首轮盲写不调调度员，所以让 A 先说话之后，调度员才会被用上。 */
async function warmup(cfg, room, fetchImpl) {
  for (let i = 0; i < cfg.participants.length; i++) await nextTurn(cfg, room, fetchImpl)
}

/* ─────────────────────── 分离正文与思考 ─────────────────────── */

test('splitMessage 把正文和思考分开，各家的字段名都认', () => {
  assert.deepEqual(splitMessage({ content: '正文' }), { text: '正文', reasoning: '' })
  assert.deepEqual(
    splitMessage({ content: '正文', reasoning_content: '思考' }),
    { text: '正文', reasoning: '思考' },
  )
  assert.deepEqual(
    splitMessage({ content: '正文', reasoning: '思考' }),
    { text: '正文', reasoning: '思考' },
  )
  const blocks = splitMessage({
    content: [
      { type: 'thinking', thinking: '块里的思考' },
      { type: 'text', text: '块里的正文' },
    ],
  })
  assert.equal(blocks.text, '块里的正文')
  assert.match(blocks.reasoning, /块里的思考/)
})

test('textOfMessage 仍然只返回正文（向后兼容）', () => {
  assert.equal(textOfMessage({ content: '正文', reasoning_content: '思考' }), '正文')
  assert.equal(textOfMessage({ content: [{ type: 'thinking', thinking: '只有思考' }] }), '')
})

/* ─────────────────────── 思考不进 transcript ─────────────────────── */

test('思考不进 transcript，其他席位看不到', async () => {
  const cfg = mk()
  const room = openRoom(cfg, '思考隔离', {})
  let seenByB = ''
  const fetchImpl = async (_u, init) => {
    const b = JSON.parse(init.body)
    const sys = String(b.messages[0].content)
    if (sys.includes('调度员')) return sched('B')
    if (sys.includes('你的席位：B')) {
      seenByB = JSON.stringify(b.messages)
      return speaker({ content: 'B 的发言' })
    }
    return speaker({ content: 'A 的发言', reasoning_content: 'A 的秘密思考：我其实不确定' })
  }

  await nextTurn(cfg, room, fetchImpl)
  await nextTurn(cfg, room, fetchImpl)

  const aEntry = room.transcript.find((m) => m.name === 'A')
  assert.equal(aEntry.text, 'A 的发言')
  assert.equal(aEntry.reasoning, undefined, '思考不该被写进 transcript')
  assert.doesNotMatch(JSON.stringify(room.transcript), /秘密思考/, '记录里不能有思考原文')
  assert.doesNotMatch(seenByB, /秘密思考/, '别的席位不该看到 A 的思考')
})

test('思考默认不返回给调用方（showThinking 默认 false）', async () => {
  const cfg = mk()
  const room = openRoom(cfg, '默认不显示', {})
  const fetchImpl = async () => speaker({ content: '正文', reasoning_content: '思考' })
  const step = await nextTurn(cfg, room, fetchImpl)

  assert.equal(step.text, '正文')
  assert.equal(step.thinking, undefined, '默认不把思考带回对话')
})

test('打开 showThinking 后思考走旁路返回，但仍然不落 transcript', async () => {
  const cfg = mk({ cfg: { showThinking: true } })
  assert.equal(cfg.showThinking, true)
  const room = openRoom(cfg, '显示思考', {})
  const fetchImpl = async () => speaker({ content: '正文', reasoning_content: '我想了想' })
  const step = await nextTurn(cfg, room, fetchImpl)

  assert.equal(step.thinking, '我想了想', '旁路字段要能取到')
  assert.equal(room.transcript.find((m) => m.name === 'A').reasoning, undefined)
})

/* ─────────────────────── 预算耗尽 ≠ 席位故障 ─────────────────────── */

test('只有思考没有正文时，报「预算不足」而不是「空内容」', async () => {
  const cfg = mk()
  const room = openRoom(cfg, '预算耗尽', {})
  const fetchImpl = async () => speaker({ content: '', reasoning_content: '很长很长的推理' })
  const step = await nextTurn(cfg, room, fetchImpl)

  assert.equal(step.budgetExhausted, true)
  assert.match(step.text, /预算不足/)
  assert.match(step.error, /token 预算/)
  assert.doesNotMatch(step.text, /模型返回了空内容/)
})

test('预算耗尽不计入失败次数，健康席位不会被请出讨论', async () => {
  const cfg = mk({ cfg: { maxSeatFailures: 1 } })
  const room = openRoom(cfg, '不该被请出', {})
  const fetchImpl = async () => speaker({ content: '', reasoning_content: '烧光预算' })
  const step = await nextTurn(cfg, room, fetchImpl)

  assert.equal(step.benched, undefined, '预算问题不该请出席位')
  assert.equal(room.fails.get('A'), undefined, '不该累计失败')
  assert.equal(room.transcript.length, 0, '不该写进记录')
})

test('真正的空响应仍然算失败', async () => {
  const cfg = mk()
  const room = openRoom(cfg, '真空响应', {})
  const fetchImpl = async () => speaker({ content: '   ' })
  const step = await nextTurn(cfg, room, fetchImpl)

  assert.equal(step.error, '模型返回了空内容')
  assert.equal(room.fails.get('A'), 1, '真空响应要计入失败')
})

/* ─────────────────────── 截断留痕 ─────────────────────── */

test('finish_reason=length 会被标记为截断', async () => {
  const cfg = mk()
  const room = openRoom(cfg, '截断', {})
  const fetchImpl = async () => speaker({ content: '我不同意，因为成本没算' }, { finish_reason: 'length' })
  const step = await nextTurn(cfg, room, fetchImpl)

  assert.equal(step.truncated, true)
  const entry = room.transcript.find((m) => m.name === 'A')
  assert.equal(entry.truncated, true, '记录上要留痕')
  assert.equal(entry.finishReason, 'length')
})

test('截断会在渲染时提示，后面的人不会当成完整论证', async () => {
  const cfg = mk()
  const room = openRoom(cfg, '截断渲染', {})
  const fetchImpl = async () => speaker({ content: '半句话' }, { finish_reason: 'length' })
  await nextTurn(cfg, room, fetchImpl)

  const rendered = renderEntries(room.transcript)
  assert.match(rendered, /截断/)
  assert.match(rendered, /末尾不完整/)
})

test('正常结束不标记截断', async () => {
  const cfg = mk()
  const room = openRoom(cfg, '正常结束', {})
  const fetchImpl = async () => speaker({ content: '完整发言' }, { finish_reason: 'stop' })
  const step = await nextTurn(cfg, room, fetchImpl)

  assert.equal(step.truncated, undefined)
  assert.doesNotMatch(renderEntries(room.transcript), /截断/)
})

test('Anthropic stop_reason=max_tokens 也算截断', async () => {
  const cfg = normalizeConfig({
    participants: [
      { name: 'Claude', baseUrl: 'https://api.anthropic.com/v1', model: 'c', apiKey: 'sk-ant', kind: 'anthropic' },
      { name: 'B', baseUrl: 'https://b.test/v1', model: 'm', apiKey: 'k' },
    ],
  })
  const room = openRoom(cfg, 'Anthropic 截断', {})
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: '半句话' }], stop_reason: 'max_tokens' }),
  })
  const step = await nextTurn(cfg, room, fetchImpl)
  assert.equal(step.truncated, true)
})

test('Anthropic 只有 thinking 块没有 text 块时，报预算不足', async () => {
  const cfg = normalizeConfig({
    participants: [
      { name: 'Claude', baseUrl: 'https://api.anthropic.com/v1', model: 'c', apiKey: 'sk-ant', kind: 'anthropic', thinking: 'on' },
      { name: 'B', baseUrl: 'https://b.test/v1', model: 'm', apiKey: 'k' },
    ],
  })
  const room = openRoom(cfg, 'Anthropic 预算', {})
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'thinking', thinking: '想了很久' }], stop_reason: 'max_tokens' }),
  })
  const step = await nextTurn(cfg, room, fetchImpl)
  assert.equal(step.budgetExhausted, true)
})

/* ─────────────────────── 预算反推 ─────────────────────── */

test('正文预算按字数反推，不再固定 800', () => {
  assert.equal(bodyTokenBudget({ maxWordsPerTurn: 300 }), 480)
  assert.equal(bodyTokenBudget({ maxWordsPerTurn: 1000 }), 1600)
  assert.ok(bodyTokenBudget({ maxWordsPerTurn: 80 }) >= 256, '短发言也有下限')
})

test('不开思考时 max_tokens = 正文预算', () => {
  const cfg = normalizeConfig({ maxWordsPerTurn: 300 })
  assert.equal(maxTokensFor(cfg, { thinking: 'off' }), 480)
  assert.equal(maxTokensFor(cfg, { thinking: 'auto' }), 480)
})

test('开思考时 Anthropic 的 max_tokens 要装得下思考 + 正文', () => {
  const cfg = normalizeConfig({ maxWordsPerTurn: 300 })
  const seat = { baseUrl: 'https://api.anthropic.com', kind: 'anthropic', thinking: 'on' }
  const budget = maxTokensFor(cfg, seat)

  assert.equal(budget, ANTHROPIC_MIN_THINK_BUDGET + 480, '正文预算要单独留出来')
  const t = anthropicThinking(seat, 'on', budget)
  assert.equal(t.maxTokens, budget)
  assert.ok(t.maxTokens - t.thinking.budget_tokens >= 480, '扣掉思考后仍够写 300 字')
  assert.ok(t.thinking.budget_tokens < t.maxTokens, 'budget 必须严格小于 max_tokens')
})

test('开思考时其它网关也会多给余量', () => {
  const cfg = normalizeConfig({ maxWordsPerTurn: 300 })
  const withThink = maxTokensFor(cfg, { baseUrl: 'https://api.deepseek.com', thinking: 'on' })
  assert.ok(withThink > 480, '要留出推理空间')
})

test('真实请求里 max_tokens 确实按配置算', async () => {
  let body = null
  const cfg = normalizeConfig({
    maxWordsPerTurn: 500,
    participants: [
      { name: 'A', baseUrl: 'https://a.test/v1', model: 'm', apiKey: 'k1' },
      { name: 'B', baseUrl: 'https://b.test/v1', model: 'm', apiKey: 'k2' },
    ],
  })
  const room = openRoom(cfg, '实际请求', {})
  const fetchImpl = async (_u, init) => {
    body = JSON.parse(init.body)
    return speaker({ content: 'r' })
  }
  await nextTurn(cfg, room, fetchImpl)
  assert.equal(body.max_tokens, 800, '500 字 × 1.6')
})

/* ─────────────────────── 调度员 / 发言者分开 ─────────────────────── */

test('调度员默认开思考，发言席位默认跟随供应商', () => {
  const cfg = normalizeConfig({})
  assert.equal(cfg.moderatorThinking, 'on', '调度员默认开')
  const seat = { thinking: 'auto' }
  assert.equal(thinkingModeFor(cfg, seat, ROLE.moderator), 'on')
  assert.equal(thinkingModeFor(cfg, seat, ROLE.speaker), 'auto')
})

test('角色优先级：席位 thinking 只管说话，调度走 moderatorThinking', () => {
  const cfg = normalizeConfig({ moderatorThinking: 'off' })
  const seat = { thinking: 'on' }
  assert.equal(thinkingModeFor(cfg, seat, ROLE.speaker), 'on', '说话用席位的设置')
  assert.equal(thinkingModeFor(cfg, seat, ROLE.moderator), 'off', '调度用全局设置')
})

test('同一场讨论里，调度请求和发言请求带不同的思考参数', async () => {
  const bodies = []
  const cfg = normalizeConfig({
    moderatorThinking: 'on',
    participants: [
      // 火山方舟：thinking 是显式布尔开关，最容易观察
      { name: 'A', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'm', apiKey: 'k1', thinking: 'off' },
      { name: 'B', baseUrl: 'https://b.test/v1', model: 'm', apiKey: 'k2' },
    ],
    retryBaseMs: 0,
  })
  const room = openRoom(cfg, '角色分离', {})

  const fetchImpl = async (_u, init) => {
    const b = JSON.parse(init.body)
    bodies.push({ system: String(b.messages[0].content).slice(0, 30), body: b })
    if (String(b.messages[0].content).includes('调度员')) return sched('A')
    return speaker({ content: '发言' })
  }

  // 首轮盲写不调调度员，先跑完两人，第三轮才会有调度员
  for (let i = 0; i < 3; i++) await nextTurn(cfg, room, fetchImpl)

  const schedCall = bodies.find((x) => x.system.includes('调度员'))
  const speakCall = bodies.findLast((x) => !x.system.includes('调度员'))
  assert.ok(schedCall, '应该有调度员调用')
  assert.deepEqual(schedCall.body.thinking, { type: 'enabled' }, '调度员要开思考')
  assert.deepEqual(speakCall.body.thinking, { type: 'disabled' }, '发言席位按自己的设置关掉')
})

test('发言席位开思考时，正文预算仍被保住', async () => {
  let body = null
  const cfg = normalizeConfig({
    maxWordsPerTurn: 300,
    participants: [
      { name: 'A', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'm', apiKey: 'k1', thinking: 'on' },
      { name: 'B', baseUrl: 'https://b.test/v1', model: 'm', apiKey: 'k2' },
    ],
  })
  const room = openRoom(cfg, '发言开思考', {})
  const fetchImpl = async (_u, init) => {
    body = JSON.parse(init.body)
    return speaker({ content: 'r' })
  }
  await nextTurn(cfg, room, fetchImpl)

  assert.deepEqual(body.thinking, { type: 'enabled' })
  assert.ok(body.max_tokens >= 480, `思考时正文额度要够，实际 ${body.max_tokens}`)
})

test('moderatorThinking 支持 auto，映射成不干预', () => {
  const cfg = normalizeConfig({ moderatorThinking: 'auto' })
  assert.equal(cfg.moderatorThinking, 'auto')
  assert.deepEqual(roleThinkingParams(cfg, { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' }, ROLE.moderator), {})
})

test('非法 moderatorThinking 回落默认值', () => {
  assert.equal(normalizeConfig({ moderatorThinking: '乱写' }).moderatorThinking, 'on')
  assert.equal(normalizeConfig({ moderatorThinking: '' }).moderatorThinking, 'on')
})

/* ─────────────────────── 纪要独立开关 ─────────────────────── */

test('纪要默认关思考，调度默认开——两者互不影响', () => {
  const cfg = normalizeConfig({})
  assert.equal(cfg.moderatorThinking, 'on', '调度员默认开')
  assert.equal(cfg.noteThinking, 'off', '纪要默认关')

  const seat = { thinking: 'auto' }
  assert.equal(thinkingModeFor(cfg, seat, ROLE.moderator), 'on')
  assert.equal(thinkingModeFor(cfg, seat, ROLE.note), 'off')
  assert.equal(thinkingModeFor(cfg, seat, ROLE.speaker), 'auto')
})

test('三个角色可以各设各的，互不串味', () => {
  const cfg = normalizeConfig({ moderatorThinking: 'off', noteThinking: 'on' })
  const seat = { thinking: 'auto' }
  assert.equal(thinkingModeFor(cfg, seat, ROLE.moderator), 'off')
  assert.equal(thinkingModeFor(cfg, seat, ROLE.note), 'on')
  assert.equal(thinkingModeFor(cfg, seat, ROLE.speaker), 'auto')
})

test('关掉调度员思考后，纪要不会被连带关掉', () => {
  const cfg = normalizeConfig({ moderatorThinking: 'off', noteThinking: 'auto' })
  assert.equal(thinkingModeFor(cfg, {}, ROLE.moderator), 'off')
  assert.equal(thinkingModeFor(cfg, {}, ROLE.note), 'auto', '纪要跟自己的设置走')
})

test('纪要请求带 noteThinking 的参数，与调度请求不同', async () => {
  const calls = []
  const cfg = normalizeConfig({
    moderatorThinking: 'on',
    noteThinking: 'off',
    participants: [
      { name: 'A', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'm', apiKey: 'k1', thinking: 'off' },
      { name: 'B', baseUrl: 'https://b.test/v1', model: 'm', apiKey: 'k2' },
    ],
  })
  const room = openRoom(cfg, '纪要开关', {})

  const fetchImpl = async (_u, init) => {
    const b = JSON.parse(init.body)
    const sys = String(b.messages[0].content)
    const kind = sys.includes('调度员') ? 'moderator' : sys.includes('记录员') ? 'note' : 'speaker'
    calls.push({ kind, thinking: b.thinking ?? null, max_tokens: b.max_tokens })
    if (kind === 'moderator') return sched('A')
    if (kind === 'note') return speaker({ content: '## 出现了哪些角度\n纪要' })
    return speaker({ content: '发言' })
  }

  for (let i = 0; i < 3; i++) await nextTurn(cfg, room, fetchImpl)
  await closeRoom(cfg, room, fetchImpl)

  const mod = calls.find((c) => c.kind === 'moderator')
  const note = calls.find((c) => c.kind === 'note')
  assert.ok(mod, '应该有调度员调用')
  assert.ok(note, '应该有纪要调用')
  assert.deepEqual(mod.thinking, { type: 'enabled' }, '调度开思考')
  assert.deepEqual(note.thinking, { type: 'disabled' }, '纪要关思考')
})

test('纪要关思考时预算也更省', async () => {
  const cfg = normalizeConfig({ noteThinking: 'off', maxWordsPerTurn: 300 })
  // 纪要只输出四个标题，不需要 300 字发言量的预算那么宽
  const noteBudget = maxTokensFor(cfg, { ...cfg.participants[0], thinking: 'off' })
  const modBudget = maxTokensFor(cfg, { ...cfg.participants[0], thinking: 'on' })
  assert.ok(noteBudget <= modBudget, '不思考时不该比思考时还贵')
})
