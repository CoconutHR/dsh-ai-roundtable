/**
 * 房间持久化的测试。
 *
 * 关键场景：进程「重启」= 清空内存表 + 重新注入同一个磁盘后端，
 * 收拾完的房间必须能原样接上（轮次、席位请出状态、失败计数都不能丢）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'rt-rooms-home-'))
process.env.RT_ROOMS_PATH = join(HOME, 'roundtable-rooms.json')

const {
  encodeRoom,
  decodeRoom,
  loadRooms,
  saveRooms,
  clearRooms,
  roomsFileExists,
  ROOMS_PATH,
} = await import('../lib/rooms-store.js')

const {
  normalizeConfig,
  attachRoomStore,
  openRoom,
  getRoom,
  listRooms,
  listRoomIds,
  nextTurn,
  sayInRoom,
  closeRoom,
  dropRoom,
  currentRound,
  activeSeats,
  hydrateSeats,
  flushRooms,
} = await import('../lib/core.js')

const cfg = normalizeConfig({
  participants: [
    { name: 'A', baseUrl: 'https://a.test/v1', model: 'm', apiKey: 'k1' },
    { name: 'B', baseUrl: 'https://b.test/v1', model: 'm', apiKey: 'k2' },
    { name: 'C', baseUrl: 'https://c.test/v1', model: 'm', apiKey: 'k3' },
  ],
  moderator: 'A',
  maxRounds: 3,
  retryBaseMs: 0,
})

const reply = (content) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) })
const httpError = (status, body = 'boom') => ({ ok: false, status, headers: { get: () => null }, text: async () => body })

/** 模拟一次进程重启：清空内存 + 重新挂上同一个磁盘后端。 */
function restart() {
  attachRoomStore({ load: loadRooms, save: saveRooms, ttlMs: 7 * 24 * 60 * 60 * 1000 })
}

let freshSeq = 0
/**
 * 真正的「新进程」：用 cache-busting 拿一个全新的 core 模块实例（房间表是空的），
 * 再挂上同一个磁盘后端。restart() 只是重挂后端，内存里的房间还在，不等于重启。
 */
async function freshCore() {
  const mod = await import(`../lib/core.js?fresh=${++freshSeq}`)
  mod.attachRoomStore({ load: loadRooms, save: saveRooms, ttlMs: 7 * 24 * 60 * 60 * 1000 })
  return mod
}

const healthyFetch = async (_u, init) => {
  const body = JSON.parse(init.body)
  if (body.messages[0].content.includes('调度员')) return reply('{"next":"A","reason":"点名"}')
  if (body.messages[0].content.includes('记录员')) return reply('## 出现了哪些角度\n纪要')
  return reply('一条真实发言')
}

test.before(() => {
  clearRooms()
  attachRoomStore(null)
  restart()
})

/* ─────────────────────── 编解码 ─────────────────────── */

test('房间能编码成 JSON 再解码回来，Set/Map 不丢', () => {
  const room = openRoom(cfg, '编解码', {})
  room.transcript.push({ name: 'A', role: 'ai', text: '喂', round: 1, status: 'ok' })
  room.benched.add('C')
  room.fails.set('C', 2)

  const round = decodeRoom(JSON.parse(JSON.stringify(encodeRoom(room))))
  assert.equal(round.id, room.id)
  assert.equal(round.topic, '编解码')
  assert.ok(round.benched instanceof Set, 'benched 必须还原成 Set')
  assert.ok(round.fails instanceof Map, 'fails 必须还原成 Map')
  assert.equal(round.benched.has('C'), true)
  assert.equal(round.fails.get('C'), 2)
  assert.equal(round.transcript[0].text, '喂')
})

test('损坏的房间数据被丢弃，不会污染整份存档', () => {
  assert.equal(decodeRoom(null), null)
  assert.equal(decodeRoom({}), null)
  assert.equal(decodeRoom({ id: 'rt-1' }), null, '缺议题')
  assert.equal(decodeRoom({ id: 'rt-1', topic: 't', participants: [] }), null, '没有席位')
  const good = decodeRoom({ id: 'rt-1', topic: 't', participants: [{ name: 'A' }] })
  assert.ok(good)
  assert.deepEqual(good.transcript, [])
  assert.equal(good.blindFirstRound, true, '缺字段按默认值补齐')
})

test('存档文件损坏时读取不抛异常，返回空表', () => {
  writeFileSync(ROOMS_PATH, '{ 这不是 JSON', 'utf8')
  assert.deepEqual(loadRooms(), [])
})

/* ─────────────────────── 落盘与恢复 ─────────────────────── */

test('开房后立刻落盘', () => {
  clearRooms()
  const room = openRoom(cfg, '落盘测试', {})
  assert.ok(existsSync(ROOMS_PATH), '开房就该有存档')
  const saved = JSON.parse(readFileSync(ROOMS_PATH, 'utf8'))
  assert.equal(saved.version, 1)
  assert.ok(saved.rooms.some((r) => r.id === room.id))
})

test('重启后房间还在，能接着往下说', async () => {
  clearRooms()
  restart()
  const room = openRoom(cfg, '重启续聊', {})
  await nextTurn(cfg, room, healthyFetch)
  await nextTurn(cfg, room, healthyFetch)
  const before = room.transcript.length

  restart(); // 模拟重启
  const restored = getRoom(room.id)
  assert.ok(restored, '重启后还能按 id 找回房间')
  assert.equal(restored.topic, '重启续聊')
  assert.equal(restored.transcript.length, before, '记录条数要一致')

  const step = await nextTurn(cfg, restored, healthyFetch)
  assert.equal(step.done, false)
  assert.equal(restored.transcript.length, before + 1, '续聊要接着原来的记录往下写')
})

test('重启后轮次计算与请出状态都保持', async () => {
  clearRooms()
  restart()
  const strict = { ...cfg, maxRetries: 0, maxSeatFailures: 1 }
  const room = openRoom(strict, '状态保持', {})

  // A 连续失败一次就被请出
  const failing = async (_u, init) => {
    const body = JSON.parse(init.body)
    if (body.messages[0].content.includes('调度员')) return reply('{"next":"A","reason":"x"}')
    return httpError(500, 'A 挂了')
  }
  await nextTurn(strict, room, failing)
  const roundBefore = currentRound(room)
  const spokenBefore = room.transcript.length

  restart()
  const restored = getRoom(room.id)
  assert.equal(restored.benched.has('A'), true, '被请出的席位，重启后仍然被请出')
  assert.equal(activeSeats(restored).some((p) => p.name === 'A'), false)
  assert.equal(currentRound(restored), roundBefore)
  assert.equal(restored.transcript.length, spokenBefore)
})

test('失败计数跨重启累计，不会因为重启无限续命', async () => {
  clearRooms()
  restart()
  const strict = { ...cfg, maxRetries: 0, maxSeatFailures: 2 }
  const room = openRoom(strict, '计数', {})

  // 先让每个人都真说一次，结束盲写阶段，之后调度员点名才有意义
  for (let i = 0; i < 3; i++) await nextTurn(strict, room, healthyFetch)

  const failA = async (_u, init) => {
    const body = JSON.parse(init.body)
    const sys = String(body.messages[0].content)
    if (sys.includes('调度员')) return reply('{"next":"A","reason":"继续追问 A"}')
    if (sys.includes('你的席位：A')) return httpError(500, 'boom')
    return reply('别人还能说')
  }

  await nextTurn(strict, room, failA)
  assert.equal(getRoom(room.id).fails.get('A'), 1)

  restart()
  const restored = getRoom(room.id)
  assert.equal(restored.fails.get('A'), 1, '失败次数要跨重启累计')

  await nextTurn(strict, restored, failA)
  assert.equal(restored.fails.get('A'), 2)
  assert.equal(restored.benched.has('A'), true, '第二次失败后请出')
})

test('插话也会落盘', async () => {
  clearRooms()
  restart()
  const room = openRoom(cfg, '插话落盘', {})
  sayInRoom(room, '别忘了成本')

  restart()
  const restored = getRoom(room.id)
  const human = restored.transcript.find((m) => m.role === 'human')
  assert.ok(human)
  assert.equal(human.text, '别忘了成本')
})

test('删房会同步落盘', () => {
  clearRooms()
  restart()
  const room = openRoom(cfg, '要删掉的', {})
  assert.ok(getRoom(room.id))
  assert.equal(dropRoom(room.id), true)

  restart()
  assert.equal(getRoom(room.id), undefined, '删掉的房间不该在重启后复活')
})

test('list 能给出每间房的进度摘要', async () => {
  clearRooms()
  restart()
  const room = openRoom(cfg, '摘要测试', {})
  await nextTurn(cfg, room, healthyFetch)

  const list = listRooms()
  const item = list.find((r) => r.id === room.id)
  assert.ok(item)
  assert.equal(item.topic, '摘要测试')
  assert.equal(item.spoken, 1)
  assert.equal(item.round, 1)
  assert.equal(item.maxRounds, 3)
  assert.deepEqual(item.participants, ['A', 'B', 'C'])
  assert.ok(Array.isArray(item.benched))
  assert.ok(listRoomIds().includes(room.id))
})

test('收场不删除房间，还能再问一次', async () => {
  clearRooms()
  restart()
  const room = openRoom(cfg, '收场留存', {})
  await nextTurn(cfg, room, healthyFetch)
  const { summary } = await closeRoom(cfg, room, healthyFetch)
  assert.match(summary, /角度/)

  restart()
  assert.ok(getRoom(room.id), '收场后房间应保留，方便再出一次纪要')
})

test('磁盘写失败不影响讨论本身', async () => {
  clearRooms()
  // 故意给一个不可写的路径
  attachRoomStore({
    load: loadRooms,
    save: () => {
      throw new Error('disk full')
    },
  })
  const room = openRoom(cfg, '写盘失败', {})
  const step = await nextTurn(cfg, room, healthyFetch)
  assert.equal(step.done, false, '写盘失败不该中断讨论')
  assert.equal(step.text, '一条真实发言')

  // 还原成正常后端，避免影响后续用例
  restart()
})

test('flushRooms 能把内存状态立刻写盘', () => {
  clearRooms()
  restart()
  const room = openRoom(cfg, 'flush', {})
  room.transcript.push({ name: 'A', role: 'ai', text: '手动补一条', round: 1, status: 'ok' })
  assert.equal(flushRooms(), true)

  const saved = JSON.parse(readFileSync(ROOMS_PATH, 'utf8'))
  const found = saved.rooms.find((r) => r.id === room.id)
  assert.equal(found.transcript.at(-1).text, '手动补一条')
})

test('没有注入后端时退回纯进程内（不写文件）', () => {
  clearRooms()
  attachRoomStore(null)
  const room = openRoom(cfg, '无持久化', {})
  assert.ok(getRoom(room.id), '内存里仍然可用')
  assert.equal(existsSync(ROOMS_PATH), false, '不该产生存档文件')
  restart()
})

test('TTL 过期的房间会被清理并落盘', async () => {
  clearRooms()
  attachRoomStore({ load: loadRooms, save: saveRooms, ttlMs: 1 }) // 1ms 立刻过期
  const room = openRoom(cfg, '会过期的', {})
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(getRoom(room.id), undefined, '过期房间应被扫掉')

  const saved = JSON.parse(readFileSync(ROOMS_PATH, 'utf8'))
  assert.equal(saved.rooms.some((r) => r.id === room.id), false, '清理结果要落盘')
  restart()
})

test('存档文件权限在 POSIX 上是 0600', () => {
  clearRooms()
  attachRoomStore({ load: loadRooms, save: saveRooms })
  openRoom(cfg, '权限', {})
  if (process.platform === 'win32') return // NTFS 不认 POSIX 位
  assert.equal(statSync(ROOMS_PATH).mode & 0o777, 0o600)
  restart()
})

test('房间记录有上限，防止异常膨胀', () => {
  const room = openRoom(cfg, '超长记录', {})
  for (let i = 0; i < 500; i++) {
    room.transcript.push({ name: 'A', role: 'ai', text: `第 ${i} 条`, round: 1, status: 'ok' })
  }
  const encoded = encodeRoom(room)
  assert.equal(encoded.transcript.length, 400, '只留最近 400 条')
  assert.equal(encoded.transcript.at(-1).text, '第 499 条', '保留的是最近的')
})

/* ─────────────────────── 密钥不外泄进房间存档 ─────────────────────── */

test('房间存档里不含 apiKey 明文', () => {
  clearRooms()
  restart()
  const room = openRoom(cfg, '密钥不外泄', {})
  room.transcript.push({ name: 'A', role: 'ai', text: '发言', round: 1, status: 'ok' })
  flushRooms()

  const raw = readFileSync(ROOMS_PATH, 'utf8')
  for (const key of ['k1', 'k2', 'k3']) {
    assert.ok(!raw.includes(`"${key}"`), `存档里不该出现密钥 ${key}`)
  }
  assert.doesNotMatch(raw, /apiKey/, '存档不该有 apiKey 字段')

  const saved = JSON.parse(raw)
  const found = saved.rooms.find((r) => r.id === room.id)
  assert.equal(found.participants.length, 3, '席位本身要保留')
  assert.equal(found.participants[0].name, 'A')
  assert.equal(found.participants[0].model, 'm', '模型等渲染字段要留着')
})

test('重启后用当前配置回填密钥，能接着说话', async () => {
  clearRooms()
  restart()
  const room = openRoom(cfg, '回填密钥', {})
  await nextTurn(cfg, room, healthyFetch)

  // 真正的新进程：内存房间表是空的，只能从磁盘读回
  const core2 = await freshCore()
  const restored = core2.getRoom(room.id)
  assert.ok(restored, '新进程要能从磁盘读回房间')
  assert.equal(restored.participants[0].apiKey, undefined, '存档阶段确实没有 key')

  // 模拟插件入口的行为：先用当前配置回填再调用
  core2.hydrateSeats(restored, cfg)
  assert.equal(restored.participants[0].apiKey, 'k1', '回填后拿到当前配置的 key')

  const step = await core2.nextTurn(cfg, restored, healthyFetch)
  assert.equal(step.done, false, '回填后能正常续聊')
  assert.equal(step.error, undefined)
})

test('席位已从配置里删掉时，给出人话提示而不是静默 401', async () => {
  clearRooms()
  restart()
  const room = openRoom(cfg, '席位被删', {})
  // 先把盲写首轮跑完，之后调度员点名才会生效
  for (let i = 0; i < 3; i++) await nextTurn(cfg, room, healthyFetch)

  const core2 = await freshCore()
  const restored = core2.getRoom(room.id)
  // 配置里只剩 B 和 C —— A 已经不在配置里，回填不出来
  const trimmed = { ...cfg, participants: cfg.participants.filter((p) => p.name !== 'A') }
  core2.hydrateSeats(restored, trimmed)
  assert.equal(restored.participants.find((p) => p.name === 'A').apiKey, '', '删掉的席位没有 key')

  // 让调度员点名 A，确认返回的是可读提示而不是静默 401
  let aWasCalled = false
  const pointAtA = async (_u, init) => {
    const body = JSON.parse(init.body)
    const sys = String(body.messages[0].content)
    if (sys.includes('调度员')) return reply('{"next":"A","reason":"让他回应"}')
    if (sys.includes('你的席位：A')) {
      aWasCalled = true
      throw new Error('缺 key 的席位不该真的发出请求')
    }
    return reply('别人说')
  }
  const step = await core2.nextTurn(trimmed, restored, pointAtA)
  assert.equal(aWasCalled, false, '缺 key 时不该打上游')
  assert.match(JSON.stringify(step), /apiKey/, `应提示缺 key，实际 ${JSON.stringify(step)}`)
})
