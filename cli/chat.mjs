#!/usr/bin/env node
/**
 * chat —— 给你的 relay 用的命令行客户端
 *
 * 目标用户是 agent（Codex / Claude Code / DSH），所以：
 *   - 每个命令都是无状态的，跑完就退
 *   - --json 输出给程序吃
 *   - 光标（cursor）存在本地，`read` 只吐新消息
 *
 * 零依赖，只用 Node 内置模块。用法见 `node chat.mjs help`。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'

const DEFAULT_SERVER = 'https://xdxy-pet.com/relay'
const CONFIG_DIR = path.join(os.homedir(), '.dsh-chat')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function saveConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
}

// ── 参数 ───────────────────────────────────────────────

const argv = process.argv.slice(2)
const command = argv[0]

/** 取出并移除 --flag [value] */
function takeFlag(name, hasValue) {
  const i = argv.indexOf('--' + name)
  if (i === -1) return undefined
  if (!hasValue) {
    argv.splice(i, 1)
    return true
  }
  const v = argv[i + 1]
  argv.splice(i, 2)
  return v
}

const jsonOut = !!takeFlag('json', false)
const serverFlag = takeFlag('server', true)
const tokenFlag = takeFlag('token', true)
const sinceFlag = takeFlag('since', true)
const withFlag = takeFlag('with', true)
const limitFlag = takeFlag('limit', true)
const allFlag = !!takeFlag('all', false)
const passwordFlag = takeFlag('password', true)
const inviteFlag = takeFlag('invite', true)

const positional = argv.slice(1).filter((a) => !a.startsWith('--'))

const cfg = loadConfig()
const server = String(
  serverFlag || process.env.DSH_CHAT_SERVER || cfg.server || DEFAULT_SERVER,
).replace(/\/+$/, '')
const token = tokenFlag || process.env.DSH_CHAT_TOKEN || cfg.token || ''

function fail(msg, code) {
  process.stderr.write(msg + '\n')
  process.exit(code === undefined ? 1 : code)
}

async function api(method, p, body) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = 'Bearer ' + token
  let res
  try {
    res = await fetch(server + p, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (e) {
    fail('连不上服务器 ' + server + '：' + (e && e.message))
  }
  let data = null
  try {
    data = await res.json()
  } catch {}
  if (!res.ok) {
    const code = (data && data.error) || 'http-' + res.status
    const hint = {
      'bad-credentials': '账号或密码不对',
      'invalid-invite': '邀请码不对',
      unauthorized: '没有登录，先跑 chat login',
      'not-friend': '你们还不是好友',
      'no-such-user': '没有这个账号',
    }[code]
    fail('失败：' + code + (hint ? '（' + hint + '）' : ''))
  }
  return data
}

function clockText(at) {
  try {
    return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

// ── 密码输入（不回显）────────────────────────────────────

function askPassword(prompt) {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let buf = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (c) => {
        buf += c
        if (buf.includes('\n')) resolve(buf.split('\n')[0].trim())
      })
    })
  }
  return new Promise((resolve) => {
    process.stderr.write(prompt)
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true })
    const onData = (ch) => {
      if (ch === '\n' || ch === '\r' || ch === '\u0004') process.stdin.removeListener('data', onData)
      else if (ch === '\u0003') {
        rl.close()
        process.exit(130)
      } else process.stderr.write('')
    }
    // 简单实现：行内读入但不回显（不同终端表现略有差异）
    rl.question('', (answer) => {
      rl.close()
      process.stderr.write('\n')
      resolve(answer.trim())
    })
    process.stdin.on('data', onData)
  })
}

// ── 渲染 ───────────────────────────────────────────────

const WIDTH = Math.min(process.stdout.columns || 80, 100)

function frameSnapshot(snap) {
  const title = ' 从 DSH 分享 · ' + (snap.title || '') + ' '
  const top = '┌─' + title + '─'.repeat(Math.max(0, WIDTH - title.length - 3))
  const lines = [top]
  for (const b of snap.blocks || []) {
    const tag = b.t === 'user' ? '你' : b.t === 'tool' ? b.name || '工具' : '我'
    const body = String(b.text || '').replace(/\s+/g, ' ').trim()
    // 简单折行
    let rest = '[' + tag + '] ' + body
    while (rest.length > 0) {
      const chunk = rest.slice(0, WIDTH - 4)
      rest = rest.slice(WIDTH - 4)
      lines.push('│ ' + chunk)
    }
  }
  lines.push('└' + '─'.repeat(Math.max(0, WIDTH - 1)))
  return lines.join('\n')
}

async function renderMessage(m, me) {
  const mine = m.from === me
  const who = mine ? '你' : m.from
  const body = m.body || {}
  if (body.kind === 'snapshot') {
    try {
      const r = await api('GET', '/api/snapshots/' + encodeURIComponent(body.snapshotId))
      return '[' + clockText(m.at) + '] ' + who + ' 发来一个快照\n' + frameSnapshot(r.snapshot)
    } catch {
      return '[' + clockText(m.at) + '] ' + who + ' 发来一个快照（已过期或无权查看）'
    }
  }
  return '[' + clockText(m.at) + '] ' + who + ': ' + (body.text || '')
}

// ── 命令 ───────────────────────────────────────────────

async function cmdLogin() {
  const id = positional[0]
  if (!id) fail('用法：chat login <账号> [--password xxx]')
  const password = passwordFlag || process.env.DSH_CHAT_PASSWORD || (await askPassword('密码: '))
  const r = await api('POST', '/api/login', { id, password })
  saveConfig({ ...loadConfig(), server, id: r.id, token: r.token, cursor: 0 })
  if (jsonOut) console.log(JSON.stringify({ id: r.id, displayName: r.displayName }))
  else console.log('✓ 已登录 @' + (r.displayName || r.id) + '  (' + server + ')')
}

async function cmdRegister() {
  const id = positional[0]
  if (!id) fail('用法：chat register <账号> --invite <邀请码> [--password xxx]')
  const invite = inviteFlag || process.env.DSH_CHAT_INVITE
  if (!invite) fail('缺 --invite 邀请码')
  const password = passwordFlag || process.env.DSH_CHAT_PASSWORD || (await askPassword('设置密码: '))
  const r = await api('POST', '/api/register', { invite, id, displayName: id, password })
  saveConfig({ ...loadConfig(), server, id: r.id, token: r.token, cursor: 0 })
  if (jsonOut) console.log(JSON.stringify({ id: r.id, displayName: r.displayName }))
  else console.log('✓ 已注册并登录 @' + (r.displayName || r.id))
}

async function cmdWhoami() {
  const me = await api('GET', '/api/me')
  if (jsonOut) console.log(JSON.stringify(me))
  else console.log('@' + (me.displayName || me.id) + '  (' + server + ')')
}

async function cmdFriends() {
  const r = await api('GET', '/api/friends')
  if (jsonOut) console.log(JSON.stringify(r.friends))
  else if (!r.friends.length) console.log('还没有好友。chat add <账号>')
  else for (const f of r.friends) console.log((f.displayName || f.id).padEnd(16) + f.id)
}

async function cmdAdd() {
  const id = positional[0]
  if (!id) fail('用法：chat add <账号>')
  const r = await api('POST', '/api/friends', { id })
  if (jsonOut) console.log(JSON.stringify(r))
  else console.log('✓ 已加好友 ' + id)
}

async function cmdSend() {
  const to = positional[0]
  const text = positional.slice(1).join(' ')
  if (!to || !text) fail('用法：chat send <账号> "消息"')
  const r = await api('POST', '/api/messages', { to, text })
  if (jsonOut) console.log(JSON.stringify(r))
  else console.log('✓ 已发送 seq=' + r.seq)
}

async function cmdRead() {
  const since = sinceFlag !== undefined ? Number(sinceFlag) : allFlag ? 0 : cfg.cursor || 0
  const r = await api('GET', '/api/messages?since=' + since)
  let msgs = r.messages || []
  if (withFlag) msgs = msgs.filter((m) => m.from === withFlag || m.to === withFlag)
  msgs.sort((a, b) => a.seq - b.seq)

  const me = cfg.id || ''
  if (jsonOut) {
    const out = []
    for (const m of msgs) {
      const item = { seq: m.seq, from: m.from, to: m.to, at: m.at, body: m.body }
      if (m.body && m.body.kind === 'snapshot') {
        try {
          const s = await api('GET', '/api/snapshots/' + encodeURIComponent(m.body.snapshotId))
          item.snapshot = s.snapshot
        } catch (e) {
          item.snapshotError = String((e && e.message) || e)
        }
      }
      out.push(item)
    }
    console.log(JSON.stringify({ cursor: r.cursor, messages: out }, null, 2))
  } else {
    if (msgs.length === 0) console.log('（没有新消息）')
    for (const m of msgs) console.log(await renderMessage(m, me))
  }
  if (sinceFlag === undefined && !allFlag && limitFlag === undefined) {
    saveConfig({ ...loadConfig(), cursor: r.cursor })
  }
}

async function cmdWatch() {
  let cursor = sinceFlag !== undefined ? Number(sinceFlag) : allFlag ? 0 : cfg.cursor || 0
  const me = cfg.id || ''
  console.error('监听中' + (withFlag ? '（只显示与 ' + withFlag + ' 的往來）' : '') + ' · Ctrl+C 退出')
  let stop = false
  process.on('SIGINT', () => {
    stop = true
    console.error('\n已退出')
    process.exit(0)
  })
  while (!stop) {
    try {
      const r = await api('GET', '/api/messages?since=' + cursor)
      let msgs = r.messages || []
      if (withFlag) msgs = msgs.filter((m) => m.from === withFlag || m.to === withFlag)
      for (const m of msgs) console.log(await renderMessage(m, me))
      if (msgs.length) saveConfig({ ...loadConfig(), cursor: r.cursor })
      cursor = r.cursor
    } catch {
      /* 网络抖动，继续 */
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
}

function help() {
  console.log(`chat —— relay 命令行客户端

  chat login <账号> [--password x]        登录（password 不填会提示输入）
  chat register <账号> --invite <码>      注册并登录
  chat whoami                            当前身份
  chat friends                           好友列表
  chat add <账号>                         加好友
  chat send <账号> "内容"                  发消息
  chat read [--since N] [--with 账号]     收消息（默认只给上次之后的新消息）
  chat watch [--with 账号]                前台持续收，Ctrl+C 退出

通用参数
  --json              输出 JSON（给 agent / 脚本用）
  --server <url>      指定服务器（默认 ${DEFAULT_SERVER}）
  --token <token>     临时指定 token
  --all               忽略本地光标，从头读

环境变量
  DSH_CHAT_SERVER  DSH_CHAT_TOKEN  DSH_CHAT_PASSWORD  DSH_CHAT_INVITE

配置存放在 ${CONFIG_FILE}`)
}

const commands = {
  login: cmdLogin,
  register: cmdRegister,
  whoami: cmdWhoami,
  friends: cmdFriends,
  add: cmdAdd,
  send: cmdSend,
  read: cmdRead,
  watch: cmdWatch,
  help,
}

const fn = commands[command || 'help']
if (!fn) fail('未知命令：' + command + '\n跑 chat help 看用法')
await fn()
