/**
 * Host 半：会话读取通道
 *
 * 两条只读路由：
 *   GET /api/share-chat/sessions   列出会话（id / 标题 / 可用性）
 *   GET /api/share-chat/transcript?id=<sessionId>   读某个会话的事件日志
 *
 * 安全口径：
 *   - 只在监听器是 loopback 时回答；公用部署（--public-url 反代）下直接 403。
 *     理由：会话日志包含你机器上的绝对路径和全部对话，不能挂在公网上。
 *   - webServer / sessionQuery 用 ctx.inject 可选注入，服务不在时插件照常加载，
 *     不会把已经能用的聊天一起拖下水。
 */

import { randomBytes } from 'node:crypto'

const PREFIX = '/api/share-chat'

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function isLoopbackOrigin(scope) {
  try {
    const origin = scope.webServer.getOrigin()
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '::1' || /^127\./.test(host)
  } catch {
    // 还没绑端口时拿不到 origin，保守放行（此时也只有本机能访问）
    return true
  }
}

/** 从各种可能的形状里取标题 */
function pickTitle(snap) {
  if (!snap) return ''
  if (typeof snap === 'string') return snap
  if (typeof snap.title === 'string') return snap.title
  if (snap.value && typeof snap.value.title === 'string') return snap.value.title
  if (snap.folded && typeof snap.folded.title === 'string') return snap.folded.title
  return ''
}

export function apply(ctx) {
  // ── 问模型：走 DSH 自己的 LLM 服务（消耗当前账号额度）──
  // 只在 loopback 下开放，公用部署直接 403。
  ctx.inject(['webServer', 'llm'], (scope) => {
    scope.effect(() =>
      scope.webServer.register({
        path: PREFIX + '/ask',
        kind: 'exact',
        resource: async (req) => {
          if (!isLoopbackOrigin(scope)) {
            return json(403, { error: 'not-loopback', hint: '公用部署下不开放模型调用' })
          }
          if (req.method !== 'POST') return json(405, { error: 'method' })
          let prompt = ''
          try {
            const body = await req.json()
            prompt = String(body && body.prompt ? body.prompt : '').slice(0, 4000)
          } catch {
            prompt = ''
          }
          if (!prompt) return json(400, { error: 'empty' })

          const pickId = (v) =>
            typeof v === 'string' ? v : (v && (v.id || v.provider || v.name || v.route)) || ''

          try {
            const providers = await Promise.resolve(scope.llm.listProviders())
            const provider = pickId((providers || [])[0])
            if (!provider) return json(503, { error: 'no-provider' })

            let models = []
            try {
              models = await Promise.resolve(scope.llm.listModels(provider))
            } catch {
              models = []
            }
            const model = pickId((models || [])[0])
            if (!model) return json(503, { error: 'no-model' })

            const messages = [
              {
                role: 'system',
                content: [
                  {
                    type: 'text',
                    text: '你是聊天里的助手。用简体中文回答，300 字以内，直接给结论，不要客套和重复问题。',
                  },
                ],
              },
              { role: 'user', content: [{ type: 'text', text: prompt }] },
            ]

            let text = ''
            for await (const chunk of scope.llm.stream({ provider, model, messages })) {
              if (!chunk) continue
              if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
                text += chunk.text
              } else if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
                const f = chunk.reason.failure || {}
                return json(502, { error: 'llm-error', detail: String(f.message || f.code || '') })
              }
            }
            text = String(text || '').trim()
            if (!text) return json(502, { error: 'empty-answer' })
            return json(200, { text, provider, model })
          } catch (e) {
            return json(500, { error: 'ask-failed', detail: String((e && e.message) || e) })
          }
        },
      }),
    )
  })

  ctx.inject(['webServer', 'sessionQuery'], (scope) => {
    // ── 会话列表 ──
    scope.effect(
      () =>
        scope.webServer.register({
          path: PREFIX + '/sessions',
          kind: 'exact',
          resource: async () => {
            if (!isLoopbackOrigin(scope)) {
              return json(403, { error: 'not-loopback', hint: '公用部署下不开放会话读取' })
            }
            try {
              const all = await scope.sessionQuery.listSessions()
              const list = Array.isArray(all) ? all : []
              // listSessions 的元素形如 { header: { id, createdAt, cwd }, live, persisted }
              const norm = (x) => {
                if (typeof x === 'string') return { id: x, createdAt: null, cwd: '', live: false, persisted: true }
                if (!x || typeof x !== 'object') {
                  return { id: '', createdAt: null, cwd: '', live: false, persisted: true }
                }
                const h = x.header && typeof x.header === 'object' ? x.header : {}
                const id = h.id ?? x.id ?? x.sessionId ?? x.sessionID ?? x.key ?? x.name ?? x.session
                return {
                  id: id === undefined || id === null ? '' : String(id),
                  createdAt: h.createdAt ?? x.createdAt ?? null,
                  cwd: h.cwd ?? x.cwd ?? '',
                  live: !!x.live,
                  persisted: x.persisted !== false,
                }
              }
              const items = list.map(norm)
              const ids = items.map((s) => s.id).filter(Boolean)
              let titles = {}
              let titleSample = ''
              try {
                const snaps = await scope.sessionQuery.readTitleSnapshots(ids)
                try {
                  titleSample = JSON.stringify(Array.isArray(snaps) ? snaps[0] : snaps).slice(0, 300)
                } catch {
                  titleSample = '<无法序列化>'
                }
                if (Array.isArray(snaps)) {
                  for (let i = 0; i < snaps.length; i++) {
                    const t = pickTitle(snaps[i])
                    if (t && ids[i]) titles[ids[i]] = t
                  }
                } else if (snaps && typeof snaps === 'object') {
                  for (const [k, v] of Object.entries(snaps)) {
                    const t = pickTitle(v)
                    if (t) titles[k] = t
                  }
                }
              } catch (e) {
                titleSample = 'readTitleSnapshots 抛错: ' + String((e && e.message) || e)
              }
              return json(200, {
                count: list.length,
                sample: list[0] ? JSON.stringify(list[0]).slice(0, 500) : '',
                shape: list[0] && typeof list[0] === 'object' ? Object.keys(list[0]) : [],
                titleSample,
                note: ids.length === 0 ? 'no-id-field' : '',
                sessions: items
                  .filter((s) => s.id)
                  .slice(0, 200)
                  .map((s) => ({
                    id: s.id,
                    title: titles[s.id] || '',
                    createdAt: s.createdAt,
                    cwd: s.cwd,
                    live: s.live,
                    persisted: s.persisted,
                  })),
              })
            } catch (e) {
              return json(500, { error: String((e && e.message) || e) })
            }
          },
        }),
      'share-chat: sessions route',
    )

    // ── 单个会话的事件日志（先回形状摘要）──
    scope.effect(
      () =>
        scope.webServer.register({
          path: PREFIX + '/transcript',
          kind: 'exact',
          resource: async (request) => {
            if (!isLoopbackOrigin(scope)) {
              return json(403, { error: 'not-loopback' })
            }
            const id = new URL(request.url).searchParams.get('id')
            if (!id) return json(400, { error: 'missing-id' })
            try {
              const log = await scope.sessionQuery.readSession(id)
              const events = Array.isArray(log) ? log : (log && log.events) || []
              const types = {}
              for (const e of events) {
                const t = String((e && (e.type || e.kind)) || '?')
                types[t] = (types[t] || 0) + 1
              }
              // 直接把原始事件交给客户端解析：格式迭代就不必再重启 Host
              const interesting = events.filter((e) =>
                /message|assistant|user|tool/i.test(String((e && e.type) || '')),
              )
              return json(200, {
                id,
                count: events.length,
                types,
                inheritedEventCount: log && log.inheritedEventCount,
                eventKeys: events[0] ? Object.keys(events[0]) : [],
                events: interesting.slice(-160),
              })
            } catch (e) {
              return json(500, { error: String((e && e.message) || e) })
            }
          },
        }),
      'share-chat: transcript route',
    )
  })

  // ── 营地：采集本机插件清单（给「串门」发布用，只读）──
  ctx.inject(['webServer', 'pluginManager'], (scope) => {
    scope.effect(
      () =>
        scope.webServer.register({
          path: PREFIX + '/camp/collect',
          kind: 'exact',
          resource: async () => {
            if (!isLoopbackOrigin(scope)) return json(403, { error: 'not-loopback' })
            try {
              const raw = await scope.pluginManager.listBundles()
              const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.entries) ? raw.entries : []
              const plugins = list
                .map((b) => {
                  const name = String((b && b.name) || '')
                  const spec = String((b && b.source) || '')
                  // 本地路径来源不能分享：别人装不了，也不该知道你的磁盘布局
                  if (/^(file|link):/i.test(spec)) return null
                  const builtin = !spec
                  const source = spec.startsWith('git+') ? 'git' : builtin ? 'builtin' : 'npm'
                  return {
                    name,
                    version: String((b && b.version) || ''),
                    spec,
                    source,
                    builtin,
                    enabled: !!(b && b.enabled),
                  }
                })
                .filter((p) => p && p.name)
              return json(200, { collectedAt: Date.now(), plugins })
            } catch (e) {
              return json(500, { error: String((e && e.message) || e) })
            }
          },
        }),
      'share-chat: camp collect route',
    )
  })

  // ── 营地：复刻（装插件 / 撤销），仅本机 + 一次性 nonce ──
  ctx.inject(['webServer', 'pluginManager'], (scope) => {
    let nonceValue = ''
    let nonceExpires = 0

    /** 只放行 npm 精确版本、pinned git、https tgz；本地路径一律拒绝 */
    const okSpec = (spec) => {
      const v = String(spec || '').trim()
      if (!v || /^(file|link):/i.test(v)) return false
      if (/^git\+https?:\/\/[^\s#]+#[0-9a-f]{40}$/i.test(v)) return true
      if (/^https:\/\/[^\s?#]+\.tgz$/i.test(v)) return true
      if (/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@[0-9][0-9A-Za-z.+-]*$/i.test(v)) return true
      return false
    }

    /** handler 是 node 风格：resource 只接 GET/HEAD，POST 必须用 handler */
    const sendJson = (res, status, body) => {
      const text = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(text)
    }

    const readJsonBody = (req) =>
      new Promise((resolve) => {
        let size = 0
        const chunks = []
        req.on('data', (c) => {
          size += c.length
          if (size > 256 * 1024) {
            resolve(null)
            req.destroy()
            return
          }
          chunks.push(c)
        })
        req.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
          } catch {
            resolve(null)
          }
        })
        req.on('error', () => resolve(null))
      })

    scope.effect(
      () =>
        scope.webServer.register({
          path: PREFIX + '/camp/nonce',
          kind: 'exact',
          resource: async () => {
            if (!isLoopbackOrigin(scope)) return json(403, { error: 'not-loopback' })
            nonceValue = randomBytes(16).toString('hex')
            nonceExpires = Date.now() + 5 * 60 * 1000
            return json(200, { nonce: nonceValue, expiresAt: nonceExpires })
          },
        }),
      'share-chat: camp nonce route',
    )

    scope.effect(
      () =>
        scope.webServer.register({
          path: PREFIX + '/camp/apply',
          kind: 'exact',
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method', allow: 'POST' })
            if (!isLoopbackOrigin(scope)) return sendJson(res, 403, { error: 'not-loopback' })
            const body = await readJsonBody(req)
            if (!body) return sendJson(res, 400, { error: 'bad-json' })
            const token = String(body.nonce || '')
            if (!nonceValue || token !== nonceValue || Date.now() > nonceExpires) {
              return sendJson(res, 403, { error: 'bad-nonce' })
            }
            nonceValue = ''
            const items = Array.isArray(body.specs) ? body.specs.slice(0, 12) : []
            const results = []
            for (const item of items) {
              const spec = String((item && item.spec) || '')
              if (!okSpec(spec)) {
                results.push({ spec, ok: false, error: 'bad-spec' })
                continue
              }
              try {
                const r = await scope.pluginManager.installBundle(spec, { saveExact: true, enabled: true })
                const application = String((r && r.application) || '')
                const ok = application !== 'failed' && application !== 'cancelled'
                const failure = r && r.error
                const detail = failure
                  ? String(failure.diagnostic || failure.message || failure.code || failure)
                  : 'install-failed'
                results.push({
                  spec,
                  ok,
                  bundle: String((r && r.bundle) || spec.replace(/@[^@]*$/, '')),
                  version: String((r && r.version) || ''),
                  application,
                  error: ok ? '' : detail,
                })
              } catch (e) {
                results.push({ spec, ok: false, error: String((e && e.message) || e) })
              }
            }
            return sendJson(res, 200, { results })
          },
        }),
      'share-chat: camp apply route',
    )

    scope.effect(
      () =>
        scope.webServer.register({
          path: PREFIX + '/camp/remove',
          kind: 'exact',
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method', allow: 'POST' })
            if (!isLoopbackOrigin(scope)) return sendJson(res, 403, { error: 'not-loopback' })
            const body = await readJsonBody(req)
            if (!body) return sendJson(res, 400, { error: 'bad-json' })
            const targets = Array.isArray(body.targets) ? body.targets.slice(0, 12) : []
            const results = []
            for (const t of targets) {
              const name = String(t || '')
              if (!name || /\s/.test(name)) {
                results.push({ name, ok: false, error: 'bad-name' })
                continue
              }
              try {
                const r = await scope.pluginManager.removeBundle(name)
                results.push({ name, ok: true, application: String((r && r.application) || '') })
              } catch (e) {
                results.push({ name, ok: false, error: String((e && e.message) || e) })
              }
            }
            return sendJson(res, 200, { results })
          },
        }),
      'share-chat: camp remove route',
    )
  })
}
