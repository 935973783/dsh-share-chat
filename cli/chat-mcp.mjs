#!/usr/bin/env node
/**
 * chat-mcp —— 把 relay 的收发消息暴露成 MCP 工具，给 WorkBuddy / Claude Desktop 等用
 *
 * 协议：JSON-RPC over stdio，按行分隔。不依赖 MCP SDK，只用 Node 内置模块。
 * 凭据：复用 CLI 的 ~/.dsh-chat/config.json（先跑一次 `node chat.mjs login`）
 *       也可以用环境变量 DSH_CHAT_SERVER / DSH_CHAT_TOKEN 覆盖。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const CONFIG_FILE = path.join(os.homedir(), '.dsh-chat', 'config.json')
const PROTOCOL = '2024-11-05'
const NAME = 'dsh-chat'
const VERSION = '0.1.0'

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return {}
  }
}

const cfg = loadConfig()
const server = String(process.env.DSH_CHAT_SERVER || cfg.server || 'https://xdxy-pet.com/relay').replace(/\/+$/, '')
const token = process.env.DSH_CHAT_TOKEN || cfg.token || ''
const me = cfg.id || ''

async function api(method, p, body) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = 'Bearer ' + token
  const res = await fetch(server + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = null
  try {
    data = await res.json()
  } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || 'http-' + res.status)
    err.code = (data && data.error) || 'http-' + res.status
    throw err
  }
  return data
}

// ── 工具实现 ────────────────────────────────────────────

const TOOLS = [
  {
    name: 'chat_friends',
    description: '列出当前账号的好友。返回每个好友的账号 id 与显示名。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'chat_read',
    description:
      '读取新消息（只返回上次读取之后的新消息）。用于看同事有没有找你。消息里的 kind=snapshot 表示对方分享了 DSH 对话快照，快照内容会一并取回。',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: '忽略本地光标，从头读取全部消息' },
        with: { type: 'string', description: '只看与某个账号的往来' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'chat_send',
    description: '给一个好友发一条文字消息。只在用户明确要求时调用，不要自动发送。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '对方的账号 id' },
        text: { type: 'string', description: '消息内容' },
      },
      required: ['to', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'chat_add_friend',
    description: '添加好友（对方会自动反向添加）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '对方的账号 id' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
]

async function callTool(name, args) {
  if (!token) {
    return {
      isError: true,
      text: '还没登录。先在终端跑一次：node chat.mjs login <你的账号>',
    }
  }
  if (name === 'chat_friends') {
    const r = await api('GET', '/api/friends')
    if (!r.friends.length) return { text: '还没有好友。可以用 chat_add_friend 加。' }
    return { text: r.friends.map((f) => `${f.id}（${f.displayName || f.id}）`).join('\n') }
  }
  if (name === 'chat_read') {
    const since = args.all ? 0 : cfg.cursor || 0
    const r = await api('GET', '/api/messages?since=' + since)
    let msgs = r.messages || []
    if (args.with) msgs = msgs.filter((m) => m.from === args.with || m.to === args.with)
    msgs.sort((a, b) => a.seq - b.seq)
    if (!msgs.length) return { text: '没有新消息。' }
    const out = []
    for (const m of msgs) {
      const who = m.from === me ? '我' : m.from
      const body = m.body || {}
      if (body.kind === 'snapshot') {
        let snapText = '（快照内容取不到，可能已过期）'
        try {
          const s = await api('GET', '/api/snapshots/' + encodeURIComponent(body.snapshotId))
          const blocks = (s.snapshot && s.snapshot.blocks) || []
          snapText =
            '【' + ((s.snapshot && s.snapshot.title) || '对话快照') + '】\n' +
            blocks
              .map((b) => {
                const tag = b.t === 'user' ? '用户' : b.t === 'tool' ? b.name || '工具' : '助手'
                return `[${tag}] ${String(b.text || '').replace(/\s+/g, ' ').trim()}`
              })
              .join('\n')
        } catch {}
        out.push(`[${new Date(m.at).toLocaleTimeString('zh-CN')}] ${who} 分享了快照：\n${snapText}`)
      } else {
        out.push(`[${new Date(m.at).toLocaleTimeString('zh-CN')}] ${who}: ${body.text || ''}`)
      }
    }
    return { text: out.join('\n') }
  }
  if (name === 'chat_send') {
    if (!args.to || !args.text) return { isError: true, text: 'to 和 text 都不能为空' }
    const r = await api('POST', '/api/messages', { to: args.to, text: args.text })
    return { text: `已发送给 ${args.to}（seq=${r.seq}）` }
  }
  if (name === 'chat_add_friend') {
    await api('POST', '/api/friends', { id: args.id })
    return { text: `已添加 ${args.id} 为好友` }
  }
  return { isError: true, text: '未知工具：' + name }
}

// ── JSON-RPC over stdio ─────────────────────────────────

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: VERSION },
    })
    return
  }
  if (method === 'notifications/initialized') return
  if (method === 'ping') {
    reply(id, {})
    return
  }
  if (method === 'tools/list') {
    reply(id, { tools: TOOLS })
    return
  }
  if (method === 'tools/call') {
    const name = params && params.name
    const args = (params && params.arguments) || {}
    try {
      const out = await callTool(name, args)
      reply(id, {
        content: [{ type: 'text', text: out.text }],
        isError: !!out.isError,
      })
    } catch (e) {
      reply(id, {
        content: [{ type: 'text', text: '失败：' + ((e && (e.code || e.message)) || e) }],
        isError: true,
      })
    }
    return
  }
  if (id !== undefined) replyError(id, -32601, 'Method not found: ' + method)
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let idx
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    handle(msg).catch(() => {})
  }
})
process.stdin.on('end', () => process.exit(0))
