/**
 * 容错与状态机的回归测试：
 * 这些用例对应「席位没有重试」「失败也算轮次」「兜底轮换塌成一个人」等问题。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeConfig,
  openRoom,
  nextTurn,
  currentRound,
  visibleEntries,
  activeSeats,
  retryDelay,
  stepBudgetMs,
  textOfMessage,
  anthropicThinking,
  parseDecision,
  RETRYABLE_STATUS,
} from '../lib/core.js'

const cfg = normalizeConfig({
  participants: [
    { name: 'A', baseUrl: 'https://a.test/v1', model: 'm', apiKey: 'k1' },
    { name: 'B', baseUrl: 'https://b.test/v1', model: 'm', apiKey: 'k2' },
    { name: 'C', baseUrl: 'https://c.test/v1', model: 'm', apiKey: 'k3' },
  ],
  moderator: 'A',
  maxRounds: 3,
})

const reply = (content) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) })
const httpError = (status, body = 'boom', headers = {}) => ({
  ok: false,
  status,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  text: async () => body,
})

/** 关掉退避的配置，让测试跑得快；重试次数与请出阈值仍按用例需要覆盖。 */
const fast = (over = {}) => ({ ...cfg, retryBaseMs: 0, ...over })

/* ─────────────────────── 重试 ─────────────────────── */

test('429 会被重试，第二次成功', async () => {
  let calls = 0
  const fetchImpl = async (_u, init) => {
    const body = JSON.parse(init.body)
    if (body.messages[0].content.includes('调度员')) return reply('{"next":"A","reason":"x"}')
    calls++
    if (calls === 1) return httpError(429, 'slow down', { 'retry-after': '0' })
    return reply('第二次成功了')
  }
  const room = openRoom(cfg, '重试', {})
  const step = await nextTurn(cfg, room, fetchImpl)

  assert.equal(calls, 2, '应该重试一次')
  assert.equal(step.error, undefined)
  assert.equal(step.text, '第二次成功了')
})

test('5xx 重试到上限后放弃，并在记录上标注失败', async () => {
  let calls = 0
  const fetchImpl = async (_u, init) => {
    const body = JSON.parse(init.body)
    if (body.messages[0].content.includes('调度员')) return reply('{"next":"A","reason":"x"}')
    calls++
    return httpError(500, 'boom')
  }
  const strict = fast({ maxRetries: 2 })
  const room = openRoom(strict, '放弃', {})
  const step = await nextTurn(strict, room, fetchImpl)

  assert.equal(calls, 3, '1 次初始 + 2 次重试')
  assert.match(step.text, /调用失败/)
  assert.ok(step.error)
})

test('401 不重试：配置错误不该反复烧配额', async () => {
  let calls = 0
  const fetchImpl = async (_u, init) => {
    const body = JSON.parse(init.body)
    if (body.messages[0].content.includes('调度员')) return reply('{"next":"A","reason":"x"}')
    calls++
    return httpError(401, 'invalid api key')
  }
  const strict = fast({ maxRetries: 3 })
  const room = openRoom(strict, '鉴权', {})
  const step = await nextTurn(strict, room, fetchImpl)

  assert.equal(calls, 1, '401 立即失败')
  assert.match(step.error, /401/)
})

test('网络层抖动（TypeError）会重试', async () => {
  let calls = 0
  const fetchImpl = async (_u, init) => {
    const body = JSON.parse(init.body)
    if (body.messages[0].content.includes('调度员')) return reply('{"next":"A","reason":"x"}')
    calls++
    if (calls === 1) throw new TypeError('fetch failed')
    return reply('恢复了')
  }
  const strict = fast()
  const room = openRoom(strict, '抖动', {})
  const step = await nextTurn(strict, room, fetchImpl)

  assert.equal(calls, 2)
  assert.equal(step.text, '恢复了')
})

test('Retry-After 优先于指数退避，且受上限约束', () => {
  assert.equal(retryDelay(0, 400, 8000, 1500), 1500)
  assert.equal(retryDelay(0, 400, 8000, 999999), 8000, '超过上限要截断')
  const backoff = retryDelay(3, 400, 8000)
  assert.ok(backoff >= 0 && backoff <= 8000)
})

test('可重试状态码集合覆盖限流与上游过载', () => {
  for (const s of [429, 500, 502, 503, 504]) assert.ok(RETRYABLE_STATUS.has(s), `${s} 应可重试`)
  for (const s of [400, 401, 403, 404, 422]) assert.ok(!RETRYABLE_STATUS.has(s), `${s} 不该重试`)
})

/* ─────────────────────── 失败记账 ─────────────────────── */

test('失败不占轮次：一直失败也不会「说满轮数」', async () => {
  const fetchImpl = async (_u, init) => {
    const body = JSON.parse(init.body)
    if (body.messages[0].content.includes('调度员')) return reply('{"next":"A","reason":"x"}')
    return httpError(500, 'boom')
  }
  const strict = fast({ maxRounds: 3, maxRetries: 0, maxSeatFailures: 10 })
  const room = openRoom(strict, '全挂', {})
  for (let i = 0; i < 3; i++) await nextTurn(strict, room, fetchImpl)

  assert.equal(currentRound(room), 1, '一条真实发言都没有，轮次仍应是第 1 轮')
  const realTurns = room.transcript.filter((m) => m.status === 'ok').length
  assert.equal(realTurns, 0)
})

test('失败记录不参与首轮盲区计数', async () => {
  const fetchImpl = async () => httpError(500, 'boom')
  const strict = fast({ maxRetries: 0, maxSeatFailures: 10 })
  const room = openRoom(strict, '盲区', {})
  await nextTurn(strict, room, fetchImpl)
  await nextTurn(strict, room, fetchImpl)

  assert.deepEqual(visibleEntries(room), [], '失败记录不该让盲区提前解除')
})

test('连续失败到阈值后席位被请出讨论，轮换不再点它', async () => {
  const fetchImpl = async (_u, init) => {
    const body = JSON.parse(init.body)
    if (body.messages[0].content.includes('调度员')) return reply('{"next":"A","reason":"x"}')
    if (String(body.messages[0].content).includes('你的席位：A')) return httpError(500, 'A 挂了')
    return reply('我还能说')
  }
  // 注意：maxRetries / maxSeatFailures 是调用时的 cfg 字段，必须用同一份配置
  const strict = { ...cfg, maxRetries: 0, retryBaseMs: 0, maxSeatFailures: 1 }
  const room = openRoom(strict, '请出', {})
  const first = await nextTurn(strict, room, fetchImpl)

  assert.equal(first.benched, 'A')
  assert.equal(activeSeats(room).some((p) => p.name === 'A'), false)
})

test('用户取消不写记录、不占轮次', async () => {
  const ac = new AbortController()
  ac.abort()
  const fetchImpl = async (_u, init) => {
    const body = JSON.parse(init.body)
    if (body.messages[0].content.includes('调度员')) return reply('{"next":"A","reason":"x"}')
    const err = new DOMException('aborted', 'AbortError')
    throw err
  }
  const room = openRoom(cfg, '取消', {})
  const step = await nextTurn(cfg, room, fetchImpl, ac.signal)

  assert.equal(step.aborted, true)
  assert.deepEqual(room.transcript, [], '取消不该污染记录')
})

test('超时也算可重试，不会被当成永久失败', async () => {
  let calls = 0
  const fetchImpl = async (_u, init) => {
    const body = JSON.parse(init.body)
    if (body.messages[0].content.includes('调度员')) return reply('{"next":"A","reason":"x"}')
    calls++
    if (calls === 1) {
      const err = new Error('The operation was aborted due to timeout')
      err.name = 'TimeoutError'
      throw err
    }
    return reply('超时后恢复')
  }
  const strict = fast()
  const room = openRoom(strict, '超时', {})
  const step = await nextTurn(strict, room, fetchImpl)
  assert.equal(calls, 2)
  assert.equal(step.text, '超时后恢复')
})

/* ─────────────────────── 轮换 ─────────────────────── */

test('调度员持续失败时兜底轮换仍然轮转，不塌成同一个人', async () => {
  const fetchImpl = async (_u, init) => {
    const body = JSON.parse(init.body)
    if (body.messages[0].content.includes('调度员')) return httpError(401, 'moderator down')
    return reply('发言')
  }
  const room = openRoom(cfg, '轮转', { maxRounds: 3 })
  const order = []
  for (let i = 0; i < 9; i++) {
    const step = await nextTurn(cfg, room, fetchImpl)
    if (step.done) break
    order.push(step.speaker)
  }
  assert.deepEqual(order.slice(0, 6), ['A', 'B', 'C', 'A', 'B', 'C'], `实际顺序 ${order.join('→')}`)
})

/* ─────────────────────── 协议与内容 ─────────────────────── */

test('content 是内容块数组时也能取到文本', () => {
  assert.equal(textOfMessage({ content: '纯文本' }), '纯文本')
  assert.equal(textOfMessage({ content: [{ type: 'text', text: '块一' }, { type: 'text', text: '块二' }] }), '块一\n块二')
  assert.equal(textOfMessage({ content: [] }), '')
  assert.equal(textOfMessage(undefined), '')
})

test('网关返回数组 content 时不再误判为「空内容」', async () => {
  const fetchImpl = async (_u, init) => {
    const body = JSON.parse(init.body)
    if (body.messages[0].content.includes('调度员')) return reply('{"next":"A","reason":"x"}')
    return { ok: true, json: async () => ({ choices: [{ message: { content: [{ type: 'text', text: '分段的回答' }] } }] }) }
  }
  const room = openRoom(cfg, '数组', {})
  const step = await nextTurn(cfg, room, fetchImpl)
  assert.equal(step.text, '分段的回答')
  assert.equal(step.error, undefined)
})

test('人设或议题里的 $& 不会把提示词顶掉', async () => {
  const special = normalizeConfig({
    participants: [
      { name: 'A', baseUrl: 'https://a.test/v1', model: 'm', apiKey: 'k1', persona: '省钱就是 $& 和 $`' },
      { name: 'B', baseUrl: 'https://b.test/v1', model: 'm', apiKey: 'k2' },
    ],
    moderator: 'A',
  })
  let sent = ''
  const fetchImpl = async (_u, init) => {
    const body = JSON.parse(init.body)
    if (body.messages[0].content.includes('调度员')) return reply('{"next":"A","reason":"x"}')
    sent = body.messages[0].content
    return reply('ok')
  }
  const room = openRoom(special, '议题里有 $& 怎么办', {})
  await nextTurn(special, room, fetchImpl)

  assert.match(sent, /省钱就是 \$& 和 \$`/, '人设原文应完整保留')
  assert.match(sent, /议题里有 \$& 怎么办/, '议题原文应完整保留')
  assert.doesNotMatch(sent, /\{persona\}|\{topic\}/, '不能残留未替换的占位符')
})

test('Anthropic 席位开启思考时带 budget_tokens 且不给 temperature', async () => {
  let body = null
  const fetchImpl = async (_u, init) => {
    body = JSON.parse(init.body)
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: '思考后的回答' }] }) }
  }
  const c = normalizeConfig({
    participants: [
      { name: 'Claude', baseUrl: 'https://api.anthropic.com/v1', model: 'claude', apiKey: 'sk-ant', kind: 'anthropic', thinking: 'on' },
      { name: 'B', baseUrl: 'https://b.test', model: 'm', apiKey: 'k' },
    ],
  })
  const room = openRoom(c, 'thinking', {})
  await nextTurn(c, room, fetchImpl)

  assert.equal(body.thinking?.type, 'enabled')
  assert.ok(body.thinking.budget_tokens >= 1024)
  assert.ok(body.max_tokens > body.thinking.budget_tokens, 'budget 必须小于 max_tokens')
  assert.equal(body.temperature, undefined, 'Anthropic 开启思考时不允许 temperature')
})

test('anthropicThinking 只对 Anthropic 生效', () => {
  assert.equal(anthropicThinking({ baseUrl: 'https://a' }, 'on', 800), null)
  assert.equal(anthropicThinking({ baseUrl: 'https://api.anthropic.com', kind: 'anthropic' }, 'off', 800), null)
  assert.ok(anthropicThinking({ baseUrl: 'https://api.anthropic.com', kind: 'anthropic' }, 'on', 800))
})

test('parseDecision 能处理前面带解释、后面带尾巴的输出', () => {
  const names = ['A', 'B']
  assert.deepEqual(parseDecision('好的，我决定：{"next":"A","reason":"该他"} 以上。', names), { next: 'A', reason: '该他' })
  assert.equal(parseDecision('', names), null)
})

/* ─────────────────────── 配置与预算 ─────────────────────── */

test('单步预算覆盖「调度员 + 发言」两次调用', () => {
  const c = normalizeConfig({ maxRetries: 2, timeoutMs: 120000 })
  assert.ok(stepBudgetMs(c) >= 120000 * 3 * 2, '要留够两次调用各自重试的余量')
})

test('重试配置能规范化，并夹到合法区间', () => {
  assert.equal(normalizeConfig({ maxRetries: 99 }).maxRetries, 5)
  assert.equal(normalizeConfig({ maxRetries: -1 }).maxRetries, 0)
  assert.equal(normalizeConfig({ maxRetries: '' }).maxRetries, 2, '空值回默认，不是 0')
  assert.equal(normalizeConfig({}).maxSeatFailures, 2)
})

test('房间 id 空间足够大，短时间大量建房不撞', () => {
  const ids = new Set()
  for (let i = 0; i < 500; i++) ids.add(openRoom(cfg, `t${i}`, {}).id)
  assert.equal(ids.size, 500, '500 个房间不该有碰撞')
})
