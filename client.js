/**
 * 社交 —— DSH 对话流里的一个 View
 *
 * 全部逻辑在浏览器里：直接调 relay 的 HTTPS API。
 * 主页面没有 CSP，relay 已开 CORS 预检，所以不需要 Host 代理。
 *
 * v0 范围：注册/登录、好友、私聊、快照渲染。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-share-chat',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const K_AUTH = 'dsh-share-chat.auth'
    const K_SERVER = 'dsh-share-chat.server'
    const K_DEV = 'dsh-share-chat.dev'
    const DEFAULT_SERVER = 'https://xdxy-pet.com/relay'
    const POLL_MS = 5000

    /**
     * 开发开关：只有本地把 dsh-share-chat.dev 设成 '1' 才显示未完成的调试入口。
     * 发给朋友的版本里这些入口默认不可见。
     */
    const DEV = (() => {
      try {
        return window.localStorage.getItem(K_DEV) === '1'
      } catch {
        return false
      }
    })()

    // ───────────────────────── 存取 ─────────────────────────

    function readJson(key) {
      try {
        return JSON.parse(window.localStorage.getItem(key) || 'null')
      } catch {
        return null
      }
    }
    function writeJson(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch {
        /* 隐私模式下写不进去，忽略 */
      }
    }
    function dropKey(key) {
      try {
        window.localStorage.removeItem(key)
      } catch {
        /* 同上 */
      }
    }

    // ───────────────────────── API ─────────────────────────

    async function api(server, path, options) {
      const opts = options || {}
      const headers = {}
      if (opts.body !== undefined) headers['content-type'] = 'application/json'
      if (opts.token) headers.authorization = 'Bearer ' + opts.token
      const res = await fetch(String(server).replace(/\/+$/, '') + path, {
        method: opts.method || 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      })
      let data = null
      try {
        data = await res.json()
      } catch {
        /* 非 JSON 响应 */
      }
      if (!res.ok) {
        const err = new Error((data && data.error) || 'http-' + res.status)
        err.code = (data && data.error) || 'http-' + res.status
        throw err
      }
      return data
    }

    const MESSAGES = {
      'invalid-invite': '邀请码不对',
      'invalid-id': '账号名不合法（2–20 个字母/数字/下划线/连字符）',
      'id-taken': '这个账号已经被注册了',
      'unauthorized': '登录已失效，请重新登录',
      'bad-credentials': '账号或密码不对',
      'password-too-short': '密码至少 6 位',
      'no-such-user': '没有这个账号',
      'not-friend': '你们还不是好友',
      'not-allowed': '无权查看这段内容',
      'expired': '这段内容已过期',
      'not-found': '内容不存在',
      'empty': '不能发空消息',
    }
    function friendly(err) {
      const code = (err && err.code) || ''
      if (MESSAGES[code]) return MESSAGES[code]
      if (err && /Failed to fetch|NetworkError|load failed/i.test(err.message || '')) {
        return '连不上服务器，检查地址和网络'
      }
      return code || (err && err.message) || '出错了'
    }

    /** 表情面板里的一批常用表情（unicode，直接当文字发） */
    const EMOJIS = [
      '😀', '😄', '😁', '😂', '🤣', '😊', '😍', '🤔', '😅', '😭',
      '😡', '😱', '🥳', '😴', '🤤', '🤝', '👍', '👎', '👏', '🙏',
      '💪', '🔥', '✨', '🎉', '❤️', '💔', '💡', '✅', '❌', '⚠️',
      '🐳', '🐱', '🐶', '🍜', '☕', '🌙', '☀️', '🚀', '👀', '🤯',
    ]

    function kbText(size) {
      const n = Number(size) || 0
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      return (n / 1024 / 1024).toFixed(1) + ' MB'
    }

    // ───────────────────────── 样式 ─────────────────────────

    const LINE = '1px solid rgba(128,128,128,0.28)'
    const S = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
        color: 'inherit',
        font: 'inherit',
        fontSize: '13px',
      },
      bar: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 14px',
        borderBottom: LINE,
        flex: '0 0 auto',
      },
      grow: { flex: 1 },
      muted: { opacity: 0.6, fontSize: '12px' },
      body: { display: 'flex', flex: 1, minHeight: 0 },
      side: {
        width: '220px',
        flex: '0 0 220px',
        borderRight: LINE,
        overflowY: 'auto',
        padding: '10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        background: 'rgba(128,128,128,0.045)',
      },
      main: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' },
      list: {
        flex: 1,
        minWidth: 0,
        // flex 子项必须能收缩，否则它撑到内容高度，滚轮就滚不动列表了
        minHeight: 0,
        overflowY: 'auto',
        // 永远预留滚动条位置：消息变多时宽度不会突然缩一截
        scrollbarGutter: 'stable',
        overscrollBehavior: 'contain',
        paddingTop: '18px',
        paddingBottom: '18px',
        paddingLeft: 'max(18px, calc((100% - 820px) / 2))',
        paddingRight: 'max(18px, calc((100% - 820px) / 2))',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      },
      empty: { ...{ opacity: 0.55 }, margin: 'auto', textAlign: 'center', fontSize: '13px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px' },
      input: {
        flex: 1,
        minWidth: 0,
        padding: '7px 10px',
        borderRadius: '8px',
        border: '1px solid rgba(128,128,128,0.35)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
      },
      composer: {
        flex: 1,
        minHeight: '38px',
        maxHeight: '140px',
        resize: 'none',
        padding: '9px 11px',
        borderRadius: '10px',
        border: '1px solid rgba(128,128,128,0.35)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        lineHeight: 1.5,
      },
      btn: {
        padding: '6px 14px',
        borderRadius: '8px',
        border: '1px solid rgba(128,128,128,0.35)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        whiteSpace: 'nowrap',
      },
      btnPrimary: {
        padding: '7px 16px',
        borderRadius: '8px',
        border: 'none',
        background: '#247bbf',
        color: '#fff',
        cursor: 'pointer',
        font: 'inherit',
        whiteSpace: 'nowrap',
        textAlign: 'center',
        // 固定宽度：发送 / 发送中 字数不同时不跳
        minWidth: '76px',
      },
      btnDisabled: { opacity: 0.45, cursor: 'default' },
      friend: {
        padding: '7px 9px',
        borderRadius: '8px',
        cursor: 'pointer',
        border: '1px solid transparent',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      friendActive: { background: 'rgba(36,123,191,0.14)', borderColor: 'rgba(36,123,191,0.4)' },
      err: { color: '#d9534f', fontSize: '12px' },
    }

    function bubble(mine) {
      return {
        maxWidth: '76%',
        alignSelf: mine ? 'flex-end' : 'flex-start',
        padding: '7px 11px',
        borderRadius: '12px',
        background: mine ? '#247bbf' : 'rgba(128,128,128,0.16)',
        color: mine ? '#fff' : 'inherit',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        lineHeight: 1.55,
      }
    }

    function clockText(at) {
      try {
        return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    // ───────────────────────── 快照 ─────────────────────────

    function SnapshotCard(props) {
      const { snapshotId, auth } = props
      const [snap, setSnap] = useState(null)
      const [err, setErr] = useState('')

      useEffect(() => {
        let alive = true
        api(auth.server, '/api/snapshots/' + encodeURIComponent(snapshotId), { token: auth.token })
          .then((data) => {
            if (alive) setSnap(data.snapshot)
          })
          .catch((e) => {
            if (alive) setErr(friendly(e))
          })
        return () => {
          alive = false
        }
      }, [snapshotId, auth.server, auth.token])

      const box = {
        border: '1px solid rgba(128,128,128,0.3)',
        borderRadius: '10px',
        padding: '10px 12px',
        minWidth: '240px',
        maxWidth: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }

      if (err) return h('div', { style: { ...box, color: '#d9534f' } }, '快照打不开：' + err)
      if (!snap) return h('div', { ...box, style: { ...box, opacity: 0.6 } }, '正在加载快照…')

      const blocks = Array.isArray(snap.blocks) ? snap.blocks : []
      return h(
        'div',
        { style: box },
        h('div', { style: { fontWeight: 600 } }, snap.title || '对话快照'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          blocks.map((b, i) => {
            if (b.t === 'tool') {
              return h(
                'div',
                {
                  key: i,
                  style: {
                    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                    fontSize: '12px',
                    opacity: 0.75,
                    paddingLeft: '8px',
                    borderLeft: '2px solid rgba(128,128,128,0.35)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  },
                },
                (b.name ? b.name + '  ' : '') + String(b.text || ''),
              )
            }
            if (b.t === 'user') {
              return h(
                'div',
                {
                  key: i,
                  style: {
                    paddingLeft: '8px',
                    borderLeft: '2px solid rgba(36,123,191,0.5)',
                    opacity: 0.85,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  },
                },
                String(b.text || ''),
              )
            }
            return h(
              'div',
              { key: i, style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
              String(b.text || ''),
            )
          }),
        ),
      )
    }

    // ───────────────────────── 登录 ─────────────────────────

    function LoginPanel(props) {
      const [server, setServer] = useState(() => {
        try {
          return window.localStorage.getItem(K_SERVER) || DEFAULT_SERVER
        } catch {
          return DEFAULT_SERVER
        }
      })
      const [mode, setMode] = useState('login')
      const [id, setId] = useState('')
      const [invite, setInvite] = useState('')
      const [password, setPassword] = useState('')
      const [token, setToken] = useState('')
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')

      const submit = async () => {
        if (busy) return
        setErr('')
        setBusy(true)
        try {
          window.localStorage.setItem(K_SERVER, server)
          let auth
          if (mode === 'login') {
            const r = await api(server, '/api/login', { method: 'POST', body: { id, password } })
            auth = { id: r.id, displayName: r.displayName, token: r.token, server }
          } else if (mode === 'register') {
            const r = await api(server, '/api/register', {
              method: 'POST',
              body: { invite, id, displayName: id, password },
            })
            auth = { id: r.id, displayName: r.displayName, token: r.token, server }
          } else if (mode === 'setpw') {
            const r = await api(server, '/api/password', {
              method: 'POST',
              body: { invite, id, password },
            })
            auth = { id: r.id, displayName: r.displayName, token: r.token, server }
          } else {
            const me = await api(server, '/api/me', { token })
            auth = { id: me.id, displayName: me.displayName, token, server }
          }
          writeJson(K_AUTH, auth)
          props.onDone(auth)
        } catch (e) {
          setErr(friendly(e))
        } finally {
          setBusy(false)
        }
      }

      const tab = (value, label) =>
        h(
          'button',
          {
            style: {
              ...S.btn,
              ...(mode === value ? { borderColor: '#247bbf', color: '#247bbf' } : null),
            },
            onClick: () => {
              setMode(value)
              setErr('')
            },
          },
          label,
        )

      const field = (placeholder, value, onChange, extra) =>
        h('input', {
          style: S.input,
          placeholder,
          value,
          onChange: (e) => onChange(e.target.value),
          ...(extra || {}),
        })

      const buttonLabel =
        mode === 'login'
          ? '登录'
          : mode === 'register'
            ? '注册并进入'
            : mode === 'setpw'
              ? '设置密码并登录'
              : '用 token 登录'

      const hint =
        mode === 'login'
          ? '账号在服务器上，换端口、换电脑都只认密码。'
          : mode === 'register'
            ? '需要邀请码。密码至少 6 位，设了以后就不怕掉登录。'
            : mode === 'setpw'
              ? '给已有账号补一个密码，用邀请码授权。'
              : '粘贴之前保存的 token。'

      return h(
        'div',
        { style: { ...S.root, padding: '28px', gap: '12px', maxWidth: '460px' } },
        h('div', { style: { fontSize: '15px', fontWeight: 600 } }, '社交'),
        h('div', { style: S.muted }, hint),
        h('div', { style: S.row }, tab('login', '登录'), tab('register', '注册'), tab('token', 'token')),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '2px' } },
          field('服务器地址', server, setServer),
          mode === 'register' || mode === 'setpw' ? field('邀请码', invite, setInvite) : null,
          mode === 'token' ? null : field('账号名', id, setId),
          mode === 'token'
            ? h('textarea', {
                style: { ...S.input, minHeight: '72px', resize: 'vertical' },
                placeholder: '粘贴 token',
                value: token,
                onChange: (e) => setToken(e.target.value),
              })
            : field(mode === 'setpw' ? '新密码（至少 6 位）' : '密码', password, setPassword, {
                type: 'password',
              }),
        ),
        err ? h('div', { style: S.err }, err) : null,
        h(
          'div',
          { style: { ...S.row, flexWrap: 'wrap' } },
          h(
            'button',
            {
              style: { ...S.btnPrimary, ...(busy ? S.btnDisabled : null) },
              onClick: submit,
              disabled: busy,
            },
            busy ? '请稍候…' : buttonLabel,
          ),
          mode === 'login'
            ? h(
                'button',
                {
                  style: { ...S.btn, border: 'none', textDecoration: 'underline' },
                  onClick: () => {
                    setMode('setpw')
                    setErr('')
                  },
                },
                '没设过密码？',
              )
            : null,
        ),
      )
    }

    // ───────────────────────── 聊天 ─────────────────────────

    function ChatPanel(props) {
      const auth = props.auth
      const [friends, setFriends] = useState([])
      const [active, setActive] = useState(null)
      const [messages, setMessages] = useState([])
      const [draft, setDraft] = useState('')
      const [newFriend, setNewFriend] = useState('')
      const [err, setErr] = useState('')
      const [sending, setSending] = useState(false)
      const [emojiOpen, setEmojiOpen] = useState(false)
      const [uploading, setUploading] = useState(false)
      const fileRef = useRef(null)

      /** 上次之后的新消息，拉一次并追加 */
      const pull = async () => {
        const r = await api(auth.server, '/api/messages?since=' + cursorRef.current, {
          token: auth.token,
        })
        if (r.messages && r.messages.length) {
          cursorRef.current = r.cursor
          setMessages((prev) => prev.concat(r.messages))
        }
      }

      /** 选中的文件：上传 → 发消息 */
      const uploadAndSend = async (file) => {
        if (!active || !file) return
        setUploading(true)
        setErr('')
        try {
          const buf = await file.arrayBuffer()
          const res = await fetch(auth.server + '/api/upload', {
            method: 'POST',
            headers: {
              authorization: 'Bearer ' + auth.token,
              'content-type': file.type || 'application/octet-stream',
              'x-filename': encodeURIComponent(file.name || ''),
            },
            body: buf,
          })
          let up = null
          try {
            up = await res.json()
          } catch {
            /* 非 JSON */
          }
          if (!res.ok) {
            setErr(up && up.error === 'too-large' ? '文件太大（上限 8 MB）' : '上传失败')
            return
          }
          const isImage = String(file.type || '').startsWith('image/')
          await api(auth.server, '/api/messages', {
            method: 'POST',
            token: auth.token,
            body: isImage
              ? { to: active, image: { uploadId: up.id } }
              : { to: active, file: { uploadId: up.id } },
          })
          await pull()
        } catch (e) {
          setErr(friendly(e))
        } finally {
          setUploading(false)
        }
      }
      const [probe, setProbe] = useState(null)
      const [probeBusy, setProbeBusy] = useState(false)
      const [sessions, setSessions] = useState(null)

      /** 读 Host 侧的会话列表 */
      const loadSessions = async () => {
        setProbeBusy(true)
        setSessions(null)
        setProbe('正在读取会话列表…')
        try {
          const res = await fetch('/api/share-chat/sessions', { credentials: 'same-origin' })
          const text = await res.text()
          let data = null
          try {
            data = JSON.parse(text)
          } catch {
            /* 非 JSON */
          }
          if (res.ok && data && Array.isArray(data.sessions) && data.sessions.length > 0) {
            setSessions(data.sessions)
            setProbe(
              'HTTP ' + res.status + ' · ' + (data.count ?? data.sessions.length) + ' 个会话\n' +
                '可识别的 id 键: ' + ((data.shape || []).join(', ') || '(元素是字符串或非对象)'),
            )
          } else if (res.ok && data) {
            setSessions(null)
            setProbe(
              'HTTP ' + res.status + ' · 共 ' + data.count + ' 个会话，但没解析出 id' +
                (data.note ? '（' + data.note + '）' : '') + '\n' +
                '字段: ' + ((data.shape || []).join(', ') || '(元素不是对象)') + '\n\n原始第一条:\n' +
                (data.sample || '(空)'),
            )
          } else {
            setProbe('HTTP ' + res.status + '\n\n' + text.slice(0, 4000))
          }
        } catch (e) {
          setProbe('fetch 失败：' + ((e && e.message) || e))
        } finally {
          setProbeBusy(false)
        }
      }

      /** 读某个会话的事件日志 */
      const loadTranscript = async (id) => {
        setProbeBusy(true)
        setProbe('正在读会话 ' + id + ' …')
        try {
          const res = await fetch('/api/share-chat/transcript?id=' + encodeURIComponent(id), {
            credentials: 'same-origin',
          })
          const text = await res.text()
          let data = null
          try {
            data = JSON.parse(text)
          } catch {
            /* 非 JSON */
          }
          if (!res.ok || !data || !Array.isArray(data.events)) {
            setProbe('HTTP ' + res.status + '\n\n' + text.slice(0, 4000))
            return
          }
          const evs = data.events
          const lines = [
            'HTTP ' + res.status + ' · 会话共 ' + data.count + ' 条事件，抽出 ' + evs.length + ' 条',
            '类型: ' + JSON.stringify(data.types),
            '事件字段: ' + ((data.eventKeys || []).join(', ') || '(未知)'),
          ]
          for (const e of evs.slice(-2)) {
            lines.push('-----')
            lines.push('type=' + String(e && e.type) + '  keys=' + Object.keys(e || {}).join(','))
            try {
              lines.push(JSON.stringify(e).slice(0, 900))
            } catch {
              lines.push('<无法序列化>')
            }
          }
          setProbe(lines.join('\n'))
        } catch (e) {
          setProbe('fetch 失败：' + ((e && e.message) || e))
        } finally {
          setProbeBusy(false)
        }
      }
      const cursorRef = useRef(0)
      const listRef = useRef(null)
      const activeRef = useRef(null)
      const friendsKeyRef = useRef('')

      useEffect(() => {
        activeRef.current = active
      }, [active])

      const loadFriends = useCallback(async () => {
        try {
          const r = await api(auth.server, '/api/friends', { token: auth.token })
          setFriends(r.friends || [])
          return r.friends || []
        } catch (e) {
          setErr(friendly(e))
          return []
        }
      }, [auth.server, auth.token])

      useEffect(() => {
        let alive = true
        loadFriends().then((list) => {
          if (alive && list.length && !active) setActive(list[0].id)
        })
        return () => {
          alive = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [loadFriends])

      // 轮询收消息
      useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const r = await api(auth.server, '/api/messages?since=' + cursorRef.current, {
              token: auth.token,
            })
            if (!alive) return
            if (r.messages && r.messages.length) {
              cursorRef.current = r.cursor
              setMessages((prev) => prev.concat(r.messages))
            }
          } catch {
            /* 消息拉取失败不打扰用户，下次再来 */
          }
          try {
            // 好友列表也一起刷：对方加了你，这边才看得见
            const f = await api(auth.server, '/api/friends', { token: auth.token })
            if (!alive) return
            const list = f.friends || []
            const key = list.map((x) => x.id + ':' + (x.displayName || '')).join('|')
            if (key !== friendsKeyRef.current) {
              friendsKeyRef.current = key
              setFriends(list)
              if (!activeRef.current && list.length) setActive(list[0].id)
            }
          } catch {
            /* 同上 */
          }
        }
        tick()
        const timer = window.setInterval(tick, POLL_MS)
        return () => {
          alive = false
          window.clearInterval(timer)
        }
      }, [auth.server, auth.token])

      // 新消息贴底
      useEffect(() => {
        const el = listRef.current
        if (el) el.scrollTop = el.scrollHeight
      }, [messages, active])

      const addFriend = async () => {
        const target = newFriend.trim()
        if (!target) return
        setErr('')
        try {
          await api(auth.server, '/api/friends', {
            method: 'POST',
            token: auth.token,
            body: { id: target },
          })
          setNewFriend('')
          const list = await loadFriends()
          setActive(list.find((f) => f.id === target) ? target : active)
        } catch (e) {
          setErr(friendly(e))
        }
      }

      const send = async () => {
        const text = draft.trim()
        if (!text || !active || sending) return
        setSending(true)
        setErr('')
        try {
          await api(auth.server, '/api/messages', {
            method: 'POST',
            token: auth.token,
            body: { to: active, text },
          })
          setDraft('')
          const r = await api(auth.server, '/api/messages?since=' + cursorRef.current, {
            token: auth.token,
          })
          if (r.messages && r.messages.length) {
            cursorRef.current = r.cursor
            setMessages((prev) => prev.concat(r.messages))
          }
        } catch (e) {
          setErr(friendly(e))
        } finally {
          setSending(false)
        }
      }

      const thread = messages.filter((m) => m.from === active || m.to === active)

      const keyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          send()
        }
      }

      return h(
        'div',
        { style: S.root },
        h(
          'div',
          { style: S.bar },
          h('strong', null, '@' + (auth.displayName || auth.id)),
          h('span', { style: S.muted }, auth.server.replace(/^https?:\/\//, '')),
          h('span', { style: S.grow }),
          err ? h('span', { style: S.err }, err) : null,
          DEV
            ? h(
                'button',
                {
                  style: { ...S.btn, ...(probeBusy ? S.btnDisabled : null) },
                  disabled: probeBusy,
                  onClick: loadSessions,
                  title: '列出所有会话，选一个分享（未完成）',
                },
                '选择会话',
              )
            : null,
          h('button', { style: S.btn, onClick: props.onLogout }, '退出'),
        ),
        h(
          'div',
          { style: S.body },
          h(
            'div',
            { style: S.side },
            h('div', { style: { ...S.muted, padding: '2px 2px 4px' } }, '好友'),
            friends.length === 0
              ? h('div', { style: { ...S.muted, padding: '4px 2px' } }, '还没有好友，先加一个')
              : friends.map((f) =>
                  h(
                    'div',
                    {
                      key: f.id,
                      style: { ...S.friend, ...(active === f.id ? S.friendActive : null) },
                      onClick: () => setActive(f.id),
                      title: f.id,
                    },
                    f.displayName || f.id,
                  ),
                ),
            h('div', { style: { height: '8px' } }),
            h('input', {
              // 竖排容器里不能用 flex:1，否则会被纵向撑满
              style: { ...S.input, flex: '0 0 auto', fontSize: '12px' },
              placeholder: '加好友：对方的 ID',
              value: newFriend,
              onChange: (e) => setNewFriend(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') addFriend()
              },
            }),
            h(
              'button',
              { style: { ...S.btn, width: '100%', marginTop: '4px' }, onClick: addFriend },
              '添加',
            ),
          ),
          h(
            'div',
            { style: S.main },
            h(
              'div',
              { style: { ...S.bar, borderBottom: LINE } },
              active
                ? h('strong', null, (friends.find((f) => f.id === active) || {}).displayName || active)
                : h('span', { style: S.muted }, '选一个好友'),
            ),
            DEV && (probe !== null || sessions)
              ? h(
                  'div',
                  {
                    style: {
                      flex: '0 0 auto',
                      borderBottom: LINE,
                      maxHeight: '46vh',
                      overflow: 'auto',
                      padding: '8px 12px',
                      background: 'rgba(128,128,128,0.06)',
                    },
                  },
                  h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        marginBottom: '6px',
                      },
                    },
                    h('strong', { style: { fontSize: '12px' } }, '选择要分享的会话'),
                    h('span', { style: S.grow }),
                    h(
                      'button',
                      {
                        style: { ...S.btn, padding: '2px 8px' },
                        onClick: () => {
                          setProbe(null)
                          setSessions(null)
                        },
                      },
                      '关闭',
                    ),
                  ),
                  sessions && sessions.length
                    ? h(
                        'div',
                        {
                          style: {
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '2px',
                            marginBottom: '8px',
                          },
                        },
                        sessions.slice(0, 40).map((s) =>
                          h(
                            'button',
                            {
                              key: s.id,
                              style: {
                                ...S.btn,
                                textAlign: 'left',
                                padding: '5px 8px',
                                fontSize: '12px',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              },
                              title: s.id,
                              onClick: () => loadTranscript(s.id),
                            },
                            (() => {
                              const when = s.createdAt
                                ? new Date(s.createdAt).toLocaleString('zh-CN', {
                                    month: '2-digit',
                                    day: '2-digit',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })
                                : '(无标题)'
                              return (s.title || when) + '  ·  ' + String(s.id).slice(-8)
                            })(),
                          ),
                        ),
                      )
                    : null,
                  probe
                    ? h(
                        'pre',
                        {
                          style: {
                            margin: 0,
                            fontSize: '10px',
                            lineHeight: 1.5,
                            fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                            opacity: 0.8,
                          },
                        },
                        probe,
                      )
                    : null,
                ) : null,
            h(
              'div',
              { style: S.list, ref: listRef },
              !active
                ? h('div', { style: S.empty }, '左边选一个好友开始聊天')
                : thread.length === 0
                  ? h('div', { style: S.empty }, '还没有消息，说点什么')
                  : thread.map((m) => {
                      const mine = m.from === auth.id
                      const b = m.body || {}
                      const kind = b.kind || 'text'
                      // 快照卡片、图片自己带形状，不要再套一层彩色气泡
                      const bare = kind === 'snapshot' || kind === 'image'
                      const shell = bare
                        ? {
                            alignSelf: mine ? 'flex-end' : 'flex-start',
                            maxWidth: '88%',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: mine ? 'flex-end' : 'flex-start',
                          }
                        : bubble(mine)

                      let content
                      if (kind === 'snapshot') {
                        content = h(SnapshotCard, { snapshotId: b.snapshotId, auth })
                      } else if (kind === 'image') {
                        content = h('img', {
                          src: auth.server + b.url,
                          alt: b.caption || '图片',
                          style: {
                            maxWidth: '100%',
                            maxHeight: '360px',
                            borderRadius: '10px',
                            display: 'block',
                          },
                        })
                      } else if (kind === 'file') {
                        content = h(
                          'a',
                          {
                            href: auth.server + b.url,
                            target: '_blank',
                            rel: 'noreferrer',
                            style: { color: 'inherit', textDecoration: 'underline' },
                          },
                          (b.name || '附件') + '  ' + kbText(b.size),
                        )
                      } else {
                        content = h('span', null, b.text || '')
                      }

                      return h(
                        'div',
                        { key: m.seq, style: shell },
                        content,
                        h(
                          'div',
                          {
                            style: {
                              fontSize: '11px',
                              opacity: 0.65,
                              marginTop: '3px',
                              color: 'inherit',
                            },
                          },
                          clockText(m.at),
                        ),
                      )
                    }),
            ),
            h(
              'div',
              {
                style: {
                  borderTop: LINE,
                  flex: '0 0 auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  paddingTop: '8px',
                  paddingBottom: '8px',
                  paddingLeft: 'max(18px, calc((100% - 820px) / 2))',
                  paddingRight: 'max(18px, calc((100% - 820px) / 2))',
                },
              },
              emojiOpen
                ? h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: '2px',
                        maxHeight: '110px',
                        overflowY: 'auto',
                        border: '1px solid rgba(128,128,128,0.28)',
                        borderRadius: '10px',
                        padding: '6px',
                      },
                    },
                    EMOJIS.map((em) =>
                      h(
                        'button',
                        {
                          key: em,
                          style: { ...S.btn, border: 'none', padding: '2px 5px', fontSize: '18px' },
                          onClick: () => setDraft((d) => d + em),
                        },
                        em,
                      ),
                    ),
                  )
                : null,
              h(
                'div',
                { style: { display: 'flex', alignItems: 'flex-end', gap: '8px' } },
                h(
                  'button',
                  {
                    style: { ...S.btn, padding: '6px 10px' },
                    title: '表情',
                    onClick: () => setEmojiOpen((v) => !v),
                  },
                  '😀',
                ),
                h(
                  'button',
                  {
                    style: {
                      ...S.btn,
                      padding: '6px 10px',
                      ...(!active || uploading ? S.btnDisabled : null),
                    },
                    title: '发送图片或文件（≤8 MB）',
                    disabled: !active || uploading,
                    onClick: () => fileRef.current && fileRef.current.click(),
                  },
                  uploading ? '…' : '📎',
                ),
                h('input', {
                  ref: fileRef,
                  type: 'file',
                  style: { display: 'none' },
                  onChange: (e) => {
                    const f = e.target.files && e.target.files[0]
                    if (f) uploadAndSend(f)
                    e.target.value = ''
                  },
                }),
                h('textarea', {
                  style: S.composer,
                  placeholder: active ? 'Enter 发送，Shift+Enter 换行' : '先选一个好友',
                  value: draft,
                  disabled: !active,
                  onChange: (e) => setDraft(e.target.value),
                  onKeyDown: keyDown,
                }),
                h(
                  'button',
                  {
                    style: {
                      ...S.btnPrimary,
                      ...(!active || sending ? S.btnDisabled : null),
                    },
                    disabled: !active || sending,
                    onClick: send,
                  },
                  sending ? '发送中' : '发送',
                ),
              ),
            ),
          ),
        ),
      )
    }

    // ───────────────────────── 入口 ─────────────────────────

    function SocialView(props) {
      const [auth, setAuth] = useState(() => readJson(K_AUTH))

      const body = !auth
        ? h(LoginPanel, {
            onDone: (next) => setAuth(next),
          })
        : h(ChatPanel, {
            auth,
            onLogout: () => {
              dropKey(K_AUTH)
              setAuth(null)
            },
          })

      // 只有会话里的 View 才拿得到会话数据；全局面板没有 props
      const canShare = !!(props && props.sessionId && typeof props.useChat === 'function')

      return h(
        'div',
        { style: S.root },
        canShare && auth ? h(Boundary, null, h(ShareBar, { chatProps: props, auth })) : null,
        h('div', { style: { flex: 1, minHeight: 0, display: 'flex' } }, body),
      )
    }

    // ─────────────────────── 一键分享 ───────────────────────

    /** 兜住探针/适配器的异常，别让整个 slot 变空白 */
    class Boundary extends React.Component {
      constructor(p) {
        super(p)
        this.state = { err: null }
      }
      static getDerivedStateFromError(e) {
        return { err: String((e && e.message) || e) }
      }
      render() {
        if (this.state.err) {
          return h(
            'div',
            { style: { padding: '6px 12px', fontSize: '11px', color: '#d9534f', borderBottom: LINE } },
            '分享组件出错：' + this.state.err,
          )
        }
        return this.props.children
      }
    }

    function shapeOf(v) {
      if (v === null) return 'null'
      if (v === undefined) return 'undefined'
      if (Array.isArray(v)) {
        const first = v.length ? Object.keys(v[0] || {}).join(',') : ''
        return `array(${v.length})` + (first ? ` item: {${first}}` : '')
      }
      if (typeof v === 'object') return 'object { ' + Object.keys(v).join(', ') + ' }'
      return typeof v + ' = ' + String(v).slice(0, 80)
    }

    /** 在几种常见形状里找出条目数组 */
    function pickArray(v) {
      if (Array.isArray(v)) return v
      if (!v || typeof v !== 'object') return null
      const keys = [
        'rows',
        'nodes',
        'messages',
        'items',
        'entries',
        'turns',
        'data',
        'list',
        'chat',
        'snapshot',
        'timeline',
        'events',
        'groups',
      ]
      for (const k of keys) if (Array.isArray(v[k])) return v[k]
      // 兜底：只有唯一一个数组字段时就用它
      const arrays = Object.keys(v).filter((k) => Array.isArray(v[k]))
      if (arrays.length === 1) return v[arrays[0]]
      return null
    }

    function textOf(it) {
      if (typeof it === 'string') return it
      if (!it || typeof it !== 'object') return ''
      const cand = it.text ?? it.markdown ?? it.plain ?? it.content ?? it.body
      if (typeof cand === 'string') return cand
      if (Array.isArray(cand)) {
        return cand
          .map((c) => (typeof c === 'string' ? c : (c && (c.text || c.content)) || ''))
          .join('')
      }
      if (cand && typeof cand === 'object') {
        const t = cand.text ?? cand.content
        if (typeof t === 'string') return t
      }
      return ''
    }

    /** 长得像内部 id 的字符串，不能当正文用 */
    const ID_LIKE = /^(\d+:[a-z]|[0-9a-f]{8}-[0-9a-f]{4}|call_|toolu_|msg_|req_|turn-|step-)/i

    function looksLikeIdText(s) {
      const t = String(s).trim()
      if (!t) return false
      if (ID_LIKE.test(t)) return true
      // 长串、无空格、只有 id 字符
      if (t.length > 24 && !/\s/.test(t) && /^[0-9a-zA-Z:_-]+$/.test(t)) return true
      return false
    }

    /** 这些键装的是元数据，不是正文 */
    const SKIP_KEY =
      /^(id|ids|key|nodeId|eventId|kind|type|role|seq|at|ts|time|status|state|phase|channel|visibility|variant|surface|stage|mode|level|turnId|stepId|requestId|callId|toolCallId|parentId|sessionId|hash|signature|uri|url|path|name|toolName|model|usage|timing|duration|error|code)$/i

    /** 思考过程的键名——绝不能分享出去 */
    const REASON_KEY = /reason|think|thought|scratch|cot$/i

    /**
     * 分组/分段结构里的枚举值，单个单词出现时必是噪音。
     * 中文回复不受影响（不在这个表里）。
     */
    const NOISE_WORDS = new Set([
      'chat',
      'visible',
      'hidden',
      'exchange',
      'tool',
      'tools',
      'assistant',
      'user',
      'system',
      'reasoning',
      'text',
      'markdown',
      'plain',
      'js',
      'json',
      'html',
      'css',
      'null',
      'true',
      'false',
      'queued',
      'pending',
      'done',
      'notice',
      'stream',
      'delta',
      'start',
      'end',
      'input',
      'output',
      'call',
      'result',
      'content',
      'step',
      'turn',
    ])

    function isNoiseWord(s) {
      if (s.length > 14) return false
      return NOISE_WORDS.has(String(s).toLowerCase())
    }

    function collectText(node, depth, out) {
      if (depth > 4 || out.length > 300) return
      if (typeof node === 'string') {
        const s = node.trim()
        if (!s || looksLikeIdText(s) || isNoiseWord(s)) return
        // 大段 JSON 是工具参数，不是正文
        if ((s.startsWith('{') || s.startsWith('[')) && s.length > 60) return
        out.push(s)
        return
      }
      if (Array.isArray(node)) {
        for (const v of node) collectText(v, depth + 1, out)
        return
      }
      if (!node || typeof node !== 'object') return
      // 整棵子树是思考过程就整段跳过
      const sig = node.kind || node.type || node.role
      if (typeof sig === 'string' && /reason|think|thought/i.test(sig)) return
      for (const k of Object.keys(node)) {
        if (SKIP_KEY.test(k) || REASON_KEY.test(k)) continue
        const v = node[k]
        if (typeof v === 'string' || (v && typeof v === 'object')) collectText(v, depth + 1, out)
      }
    }

    /**
     * 去掉运行时注入的上下文。
     * 用户消息节点里会带着 system-reminder 那一整块，分享出去是噪音。
     */
    function stripInjected(text) {
      let t = String(text || '')
      t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
      t = t.replace(/<system-reminder>[\s\S]*$/gi, '')
      const dropLine =
        /^(Time sampled|Browser time zone|Elapsed since|Current working directory|Current DSH file policy|Current DeepSeek Harness|You are the root agent|You are an AI agent|You are a coding agent|To message other agents|When you are asked|A skill is a reusable|Non-zero exits|Tokens prefixed with|Use the read tool|Use the glob tool|Use the grep tool|Use the workflow tool|Only create or modify scheduled)/i
      return t
        .split(/\r?\n/)
        .filter((line) => !dropLine.test(line.trim()))
        .join('\n')
        .trim()
    }

    /** 从节点对象里挖正文：先试常用字段，不行就整节点深扫 */
    function textFromNode(node) {
      if (node === null || node === undefined) return ''
      for (const k of ['text', 'markdown', 'plain', 'content', 'message', 'body']) {
        const v = node[k]
        if (v === undefined || v === null) continue
        const out = []
        collectText(v, 0, out)
        const t = out.join('\n').trim()
        if (t) return t
      }
      const out = []
      collectText(node, 0, out)
      // 去重相邻重复行
      const seen = []
      for (const line of out) if (seen[seen.length - 1] !== line) seen.push(line)
      return seen.join('\n').trim()
    }

    /** state 里哪些字段是对象型 map（不是数组） */
    function mapFields(state) {
      if (!state || typeof state !== 'object') return []
      return Object.keys(state).filter((k) => {
        const v = state[k]
        return v && typeof v === 'object' && !Array.isArray(v)
      })
    }

    /** 看起来像节点的对象（有 id / kind / seq 之一） */
    function looksLikeNode(v) {
      return (
        !!v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        (typeof v.id === 'string' ||
          typeof v.kind === 'string' ||
          typeof v.seq === 'number' ||
          typeof v.type === 'string')
      )
    }

    /**
     * 递归收集「id → 节点」索引。
     * 关键：state.nodes.byKey 是 Map，不是普通对象，必须用 instanceof Map 处理。
     */
    function buildLookup(state) {
      const idx = new Map()
      let nodeCount = 0
      const put = (key, val) => {
        if (key !== undefined && key !== null) idx.set(String(key), val)
        const idf = val.id || val.nodeId || val.key
        if (typeof idf === 'string') idx.set(idf, val)
        nodeCount += 1
      }
      const visit = (v, depth) => {
        if (depth > 3 || !v || typeof v !== 'object') return
        if (v instanceof Map) {
          for (const [k, val] of v) {
            if (looksLikeNode(val)) put(k, val)
          }
          // Map 的值里还可能套着 Map
          for (const [, val] of v) if (val && typeof val === 'object') visit(val, depth + 1)
          return
        }
        if (Array.isArray(v)) {
          for (const item of v) if (item && typeof item === 'object') visit(item, depth + 1)
          return
        }
        for (const [k, val] of Object.entries(v)) {
          if (!val || typeof val !== 'object') continue
          if (looksLikeNode(val)) put(k, val)
          else visit(val, depth + 1)
        }
      }
      visit(state, 0)
      return { idx, nodeCount }
    }

    /** 按 id 里的关键字给节点分类；分不出就是 null（结构节点，跳过） */
    function kindOfId(id) {
      const s = String(id)
      if (/input-message|user/i.test(s)) return 'user'
      if (/tool-call|tool-result|toolCall/i.test(s)) return 'tool'
      if (/assistant|reason/i.test(s)) return 'assistant'
      return null
    }

    /**
     * 把会话 state 折成快照块。
     * 只取「最后一轮」：order 里的 turn-tail 是轮次边界，从倒数第二个之后开始。
     */
    function extractBlocks(state, limit) {
      const ids = pickArray(state)
      if (!ids) return null
      const lookup = buildLookup(state)
      if (lookup.idx.size === 0) return null

      const tails = []
      for (let i = 0; i < ids.length; i++) {
        if (typeof ids[i] === 'string' && /turn-tail/i.test(ids[i])) tails.push(i)
      }
      const start = tails.length >= 2 ? tails[tails.length - 2] + 1 : 0
      const window = ids.slice(start)

      const out = []
      let lastText = ''
      for (const id of window) {
        if (typeof id !== 'string') continue
        const kind = kindOfId(id)
        if (!kind) continue
        const node = lookup.idx.get(id)
        if (!node) continue

        // 工具节点不深扫：只要名字 + 一行短摘要，避免把参数 JSON 全带出去
        if (kind === 'tool') {
          const rawName = node.name || node.toolName || node.tool?.name || ''
          const rawArg = node.args ?? node.input ?? node.arguments
          let preview = ''
          if (typeof rawArg === 'string') preview = rawArg
          else if (rawArg && typeof rawArg === 'object') {
            try {
              preview = JSON.stringify(rawArg)
            } catch {
              preview = ''
            }
          }
          preview = stripInjected(preview).replace(/\s+/g, ' ').trim().slice(0, 140)
          // 名字和摘要都拿不到，这个工具节点没信息量，别占位置
          if (!rawName && !preview) continue
          out.push({ t: 'tool', name: String(rawName || 'tool').slice(0, 40), text: preview })
          continue
        }

        const text = stripInjected(textFromNode(node))
        if (!text) continue
        if (text === lastText) continue
        lastText = text
        out.push({ t: kind, text: text.slice(0, 1500) })
      }
      return out.slice(-limit)
    }

    /** 挖不出来时，把一个真实消息节点的形状摊开 */
    function diagnose(state) {
      const lines = ['state: ' + shapeOf(state)]
      const ids = pickArray(state)
      const lookup = buildLookup(state)
      if (ids) {
        lines.push('id 数组长度 ' + ids.length + '，末项 ' + shapeOf(ids[ids.length - 1]))
      }
      lines.push('索引到节点数: ' + lookup.idx.size)
      lines.push('nodes.byKey 是 Map? ' + (state && state.nodes && state.nodes.byKey instanceof Map))
      if (ids) {
        // 优先取样「回复」节点——它是最可能挖不出文本的那类
        const pickProbe = (re) => {
          for (let i = ids.length - 1; i >= 0; i--) {
            if (typeof ids[i] === 'string' && re.test(ids[i])) return ids[i]
          }
          return null
        }
        const probeId =
          pickProbe(/assistant/i) || pickProbe(/tool-call/i) || pickProbe(/input-message/i)
        lines.push('取样 id: ' + String(probeId))
        if (probeId) {
          const node = lookup.idx.get(probeId)
          if (!node) {
            lines.push('索引里没有这个 id')
          } else {
            lines.push('节点字段: ' + Object.keys(node).join(', '))
            lines.push('提取文本长度: ' + stripInjected(textFromNode(node)).length)
            try {
              lines.push('节点 JSON: ' + JSON.stringify(node).slice(0, 700))
            } catch {
              lines.push('节点 JSON: <无法序列化>')
            }
          }
        }
      }
      return lines.join('\n')
    }

    function ShareBar(props) {
      const { chatProps, auth } = props
      // 这些是 selector hook：必须传选择器。先要整个 state，不猜字段名。
      const chat = chatProps.useChat((s) => s)
      const [open, setOpen] = useState(false)
      const [friends, setFriends] = useState([])
      const [target, setTarget] = useState('')
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')

      useEffect(() => {
        if (!open) return
        let alive = true
        api(auth.server, '/api/friends', { token: auth.token })
          .then((r) => {
            if (!alive) return
            const list = r.friends || []
            setFriends(list)
            if (!target && list.length) setTarget(list[0].id)
            if (!list.length) setNote('还没有好友，先在下面加一个')
          })
          .catch((e) => {
            if (alive) setNote(friendly(e))
          })
        return () => {
          alive = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [open, auth.server, auth.token])

      const blocks = extractBlocks(chat, 8)
      // 抓到的全是「13:input-message…」这种 id，说明回查没成功
      const looksLikeIds =
        !!blocks && blocks.length > 0 && blocks.every((b) => /^\d+:[a-z]/i.test(String(b.text)))
      const broke = !blocks || blocks.length === 0 || looksLikeIds

      const send = async () => {
        if (!target || busy) return
        if (!blocks || blocks.length === 0) {
          setNote('没读到会话内容，形状：' + shapeOf(chat))
          return
        }
        setBusy(true)
        setNote('')
        try {
          await api(auth.server, '/api/messages', {
            method: 'POST',
            token: auth.token,
            body: {
              to: target,
              snapshot: {
                v: 0,
                title: '从 DSH 分享 · ' + new Date().toLocaleString('zh-CN'),
                blocks,
              },
            },
          })
          setNote(`已发给 ${target}，共 ${blocks.length} 段`)
          setOpen(false)
        } catch (e) {
          setNote(friendly(e))
        } finally {
          setBusy(false)
        }
      }

      const bar = {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 12px',
        borderBottom: LINE,
        fontSize: '12px',
        flexWrap: 'wrap',
      }

      if (!open) {
        return h(
          'div',
          { style: bar },
          h(
            'button',
            { style: { ...S.btn, padding: '4px 10px' }, onClick: () => setOpen(true) },
            '分享这一轮',
          ),
          note ? h('span', { style: S.muted }, note) : null,
        )
      }

      const controls = h(
        'div',
        { style: bar },
        h(
          'span',
          { style: S.muted },
          broke ? '没读到会话内容' : `将发送最近 ${blocks.length} 段`,
        ),
        friends.length
          ? h(
              'select',
              {
                style: { ...S.input, flex: '0 0 auto', padding: '4px 8px' },
                value: target,
                onChange: (e) => setTarget(e.target.value),
              },
              friends.map((f) => h('option', { key: f.id, value: f.id }, f.displayName || f.id)),
            )
          : null,
        h(
          'button',
          {
            style: {
              ...S.btnPrimary,
              padding: '4px 12px',
              ...(busy || broke ? S.btnDisabled : null),
            },
            disabled: busy || !target || broke,
            onClick: send,
          },
          busy ? '发送中' : '发送',
        ),
        h('button', { style: { ...S.btn, padding: '4px 10px' }, onClick: () => setOpen(false) }, '取消'),
        note ? h('span', { style: S.err }, note) : null,
      )

      // 兜底诊断：把 state 和真实节点形状摊开，好让我照着改
      const dump = broke
        ? h(
            'pre',
            {
              style: {
                margin: 0,
                padding: '6px 12px 8px',
                fontSize: '10px',
                lineHeight: 1.45,
                fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                opacity: 0.8,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                maxHeight: '220px',
                overflow: 'auto',
              },
            },
            diagnose(chat),
          )
        : null

      // 发送前预览：一行一段，方便扫一眼有没有不该发的东西
      const preview =
        broke || !blocks
          ? null
          : h(
              'div',
              {
                style: {
                  margin: '0 12px 8px',
                  border: '1px solid rgba(128,128,128,0.3)',
                  borderRadius: '8px',
                  maxHeight: '190px',
                  overflowY: 'auto',
                  padding: '8px 10px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '5px',
                },
              },
              h(
                'div',
                { style: { ...S.muted, fontSize: '11px' } },
                `预览 · ${blocks.length} 段（发送前扫一眼有没有不该发的）`,
              ),
              blocks.map((b, i) =>
                h(
                  'div',
                  {
                    key: i,
                    style: {
                      fontSize: '11px',
                      lineHeight: 1.5,
                      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                      opacity: b.t === 'tool' ? 0.6 : 1,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    },
                  },
                  `[${b.t}] ${b.name ? b.name + ' ' : ''}${String(b.text || '').slice(0, 180)}`,
                ),
              ),
            )

      return h('div', { style: { borderBottom: LINE, flex: '0 0 auto' } }, controls, preview, dump)
    }

    // ───────────── 全局面板（左侧栏常驻入口，不依赖会话）─────────────

    const PANEL_ID = 'dsh-share-chat'

    /** 左侧栏图标：用 currentColor，跟着主题走 */
    function SocialIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 18,
          height: 18,
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          d: 'M4.2 5h15.6A1.7 1.7 0 0 1 21.5 6.7v9.1a1.7 1.7 0 0 1-1.7 1.7h-8.1l-3.9 3v-3H4.2a1.7 1.7 0 0 1-1.7-1.7V6.7A1.7 1.7 0 0 1 4.2 5Z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 8.6, cy: 11.2, r: 1.15, fill: 'currentColor' }),
        h('circle', { cx: 12, cy: 11.2, r: 1.15, fill: 'currentColor' }),
        h('circle', { cx: 15.4, cy: 11.2, r: 1.15, fill: 'currentColor' }),
      )
    }

    /** 主区域的整页版本：给标题栏让出 top clearance */
    function SocialPanel() {
      return h(
        'div',
        {
          style: {
            height: '100%',
            width: '100%',
            minHeight: 0,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            paddingTop: 'var(--dsh-frame-top-clearance, 0px)',
            boxSizing: 'border-box',
            overflow: 'hidden',
          },
        },
        h(SocialView),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 1) 会话里的 View：保留，顺手能在某个会话里看一眼
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            {
              name: 'conversation.view',
              id: 'dsh-share-chat',
              order: 40,
              label: '社交',
            },
            SocialView,
          ),
        )

        // 2) 左侧栏常驻入口
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              label: () => '社交',
            },
            SocialIcon,
          ),
        )

        // 3) 全局面板：和侧栏入口同一个 id，点入口就切到这个面板
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
            },
            SocialPanel,
          ),
        )
      },
    }
  },
})
