#!/usr/bin/env node
/**
 * 圆桌配置台（独立版）
 *
 * 不依赖 DSH 的客户端插件系统：起一个只监听 127.0.0.1 的小服务，
 * 直接读写 ~/.dsh/roundtable.json。插件每次调用都会重读这个文件，
 * 所以这里点保存之后立刻生效，不需要重启任何东西。
 *
 *   node tools/settings-server.mjs          # 默认 8766，自动打开带 token 的链接
 *   node tools/settings-server.mjs 8800     # 指定端口
 *
 * 安全：只监听本机还不够 —— 浏览器里的任意网页也能向 127.0.0.1:8766 发 POST。
 * 所以启动时生成一次性 token，打印在终端里并拼进自动打开的 URL；
 * 写操作必须带上它，且必须是 JSON 类型（跨站表单发不出来）。
 */
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import {
  loadStore,
  publicView,
  saveStore,
  mergeForm,
  withDefaults,
  SESSION_TOKEN,
  checkWriteAuth,
} from '../lib/store.js'
import { makeHandler } from '../lib/routes.js'

const PORT = Number(process.argv[2]) || 8766
const SEED = {
  moderator: 'DeepSeek',
  style: 'debate',
  maxRounds: 2,
  maxWordsPerTurn: 300,
  maxTokens: 800,
  temperature: 0.8,
  timeoutMs: 120000,
  maxRetries: 2,
  maxSeatFailures: 2,
  participants: [
    { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', persona: '结构化拆解与收敛', thinking: 'auto', apiKey: '' },
    { name: '豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-2-1-pro-260915', persona: '中文语境与落地细节', thinking: 'off', apiKey: '' },
  ],
}

const PROFILE = join(homedir(), '.dsh/profiles/desktop')

/** 没有 store 时，从 profile 的 patch 里读种子配置，这样第一次打开就能看到真实的席位和 key 状态。 */
function seedFromPatch() {
  try {
    const req = createRequire(join(PROFILE, 'package.json'))
    const yaml = req('js-yaml')
    const file = join(PROFILE, 'cordis.patch.yml')
    const doc = yaml.load(readFileSync(file, 'utf8'))
    const entry = Array.isArray(doc) ? doc.find((e) => e && e.id === 'dsh-ai-roundtable') : null
    return entry?.config ?? null
  } catch {
    return null
  }
}

function readRaw() {
  return loadStore() ?? seedFromPatch() ?? SEED
}

function send(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

/** 页面渲染时把 token 注进去：只出现在返回给本机浏览器的 HTML 里。 */
function renderPage() {
  const html = readFileSync(new URL('./settings-page.html', import.meta.url), 'utf8')
  return html.replace(
    '<head>',
    `<head>\n<script>window.__RT_TOKEN__ = ${JSON.stringify(SESSION_TOKEN)};</script>`,
  )
}

const PAGE = renderPage()

// 与插件内嵌路由共用一套逻辑，避免两边行为漂移（试连曾是两套实现，协议判定还不一致）。
const handler = makeHandler({
  getRaw: readRaw,
  onSave: () => {},
  requireToken: true,
})

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  try {
    if (url.pathname === '/' || url.pathname === '/settings') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(PAGE)
    }

    if (url.pathname === '/api/config' && req.method === 'GET') {
      return send(res, 200, { config: publicView(withDefaults(readRaw())) })
    }

    if (url.pathname === '/api/config' && req.method === 'POST') {
      const denied = checkWriteAuth(req.headers, { requireToken: true })
      if (denied) return send(res, 403, { error: denied })
      const chunks = []
      for await (const c of req) chunks.push(c)
      const text = Buffer.concat(chunks).toString('utf8')
      const body = text ? JSON.parse(text) : {}
      const next = mergeForm(withDefaults(readRaw()), body)
      if (!Array.isArray(next.participants) || next.participants.length === 0) {
        return send(res, 400, { error: '至少要保留一个席位' })
      }
      saveStore(next)
      return send(res, 200, { config: publicView(next) })
    }

    if (url.pathname === '/api/test' && req.method === 'POST') {
      const denied = checkWriteAuth(req.headers, { requireToken: true })
      if (denied) return send(res, 403, { error: denied })
      // /api/test 与插件的 /dsh-roundtable/test 是同一份实现，改前缀后交给共用 handler。
      req.url = '/dsh-roundtable/test'
      return handler(req, res)
    }

    return send(res, 404, { error: 'not found' })
  } catch (e) {
    return send(res, 500, { error: e?.message ?? String(e) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/?token=${encodeURIComponent(SESSION_TOKEN)}`
  console.log(`圆桌配置台：${url}`)
  console.log('提示：链接里的 token 仅供本次会话使用，关掉服务即失效。')
  console.log('Ctrl+C 结束')
  if (!process.env.RT_NO_OPEN) {
    // Windows 用 start，macOS 用 open，Linux 用 xdg-open
    const opener = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    execFile(opener, args, () => {})
  }
})
