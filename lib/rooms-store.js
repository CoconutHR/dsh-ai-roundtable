/**
 * 房间持久化：把进程内的圆桌房间落盘，重启后还能接着开。
 *
 * 为什么单独一层：
 *   - core.js 是纯逻辑（可脱离文件系统测试），持久化是副作用，不该混进去
 *   - 房间结构里有 Set / Map（benched / fails），JSON 存不了，需要明确的编解码
 *
 * 存储形状：~/.dsh/roundtable-rooms.json
 *   { "version": 1, "rooms": [ { ...room }, ... ] }
 * 每次脏写都整份重写（房间数量是几十的量级，没必要做增量）。
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, unlinkSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export const ROOMS_VERSION = 1

/** 房间闲置多久后过期（毫秒）。0 表示永不过期。 */
export const DEFAULT_ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000

export const ROOMS_PATH =
  process.env.RT_ROOMS_PATH || join(homedir(), '.dsh', 'roundtable-rooms.json')

/** 单场讨论最多保留多少条记录，防止异常情况把文件撑爆。 */
const MAX_TRANSCRIPT = 400

/**
 * 席位 → 可落盘字段。
 *
 * 关键：**不带 apiKey**。
 * 房间只需要知道"谁在席上、用什么模型"，发请求时的 key 来自当前配置。
 * 把 key 抄进房间存档，等于在磁盘上多存一份明文副本（还会跟着讨论记录一起被备份或分享）。
 */
function seatForStorage(seat) {
  return {
    name: seat.name,
    baseUrl: seat.baseUrl,
    model: seat.model,
    persona: seat.persona,
    thinking: seat.thinking,
    kind: seat.kind,
  }
}

/**
 * room（带 Set/Map）→ 可 JSON 化对象。
 * 只保留重建房间真正需要的字段，避免把函数或临时状态写进去。
 */
export function encodeRoom(room) {
  return {
    id: room.id,
    topic: room.topic,
    participants: (room.participants ?? []).map(seatForStorage),
    moderator: room.moderator ? seatForStorage(room.moderator) : undefined,
    maxRounds: room.maxRounds,
    style: room.style,
    blindFirstRound: room.blindFirstRound,
    transcript: room.transcript.slice(-MAX_TRANSCRIPT),
    benched: [...(room.benched ?? [])],
    fails: [...(room.fails ?? new Map())],
    createdAt: room.createdAt,
    updatedAt: room.updatedAt ?? room.createdAt,
  }
}

/** 可 JSON 化对象 → room（恢复 Set/Map，并兜住损坏字段）。 */
export function decodeRoom(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id ?? '').trim()
  const topic = String(raw.topic ?? '').trim()
  if (!id || !topic) return null
  const participants = Array.isArray(raw.participants) ? raw.participants : []
  if (!participants.length) return null
  return {
    id,
    topic,
    participants,
    moderator: raw.moderator ?? participants[0],
    maxRounds: Number.isFinite(raw.maxRounds) ? raw.maxRounds : 2,
    style: String(raw.style ?? 'debate'),
    blindFirstRound: raw.blindFirstRound !== false,
    transcript: Array.isArray(raw.transcript)
      ? raw.transcript.filter((m) => m && typeof m.text === 'string')
      : [],
    benched: new Set(Array.isArray(raw.benched) ? raw.benched : []),
    fails: new Map(Array.isArray(raw.fails) ? raw.fails : []),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || Date.now(),
  }
}

/** 读整份房间表；文件不存在或损坏都返回空表（不能因为一个坏文件让插件加载失败）。 */
export function loadRooms() {
  try {
    if (!existsSync(ROOMS_PATH)) return []
    const parsed = JSON.parse(readFileSync(ROOMS_PATH, 'utf8'))
    const list = Array.isArray(parsed?.rooms) ? parsed.rooms : []
    return list.map(decodeRoom).filter(Boolean)
  } catch {
    return []
  }
}

/** 原子写：临时文件 + rename，避免写一半断电留下坏 JSON。 */
export function saveRooms(rooms) {
  mkdirSync(dirname(ROOMS_PATH), { recursive: true })
  const payload = JSON.stringify(
    { version: ROOMS_VERSION, savedAt: new Date().toISOString(), rooms: rooms.map(encodeRoom) },
    null,
    2,
  )
  const tmp = `${ROOMS_PATH}.tmp`
  writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {
    /* Windows 上不支持，忽略 */
  }
  renameSync(tmp, ROOMS_PATH)
  return ROOMS_PATH
}

/** 删掉整个房间存档（用户想清空时用）。 */
export function clearRooms() {
  try {
    if (existsSync(ROOMS_PATH)) unlinkSync(ROOMS_PATH)
    return true
  } catch {
    return false
  }
}

/** 房间存档文件是否已经存在（用于「首次启动」提示）。 */
export function roomsFileExists() {
  return existsSync(ROOMS_PATH)
}
