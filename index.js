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
}
