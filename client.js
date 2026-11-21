/**
 * 社交 —— DSH 对话流里的一个 View
 *
 * 全部逻辑在浏览器里：直接调 relay 的 HTTPS API。
 * 主页面没有 CSP，relay 已开 CORS 预检，所以不需要 Host 代理。
 *
 * v0 范围：注册/登录、好友、私聊、快照渲染。
 */
window.__ModuleLoader__.load({
  id: 'dsh-share-chat',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const K_AUTH = 'dsh-share-chat.auth'
    const K_SERVER = 'dsh-share-chat.server'
    const K_DEV = 'dsh-share-chat.dev'
    const DEFAULT_SERVER = 'https://xdxy-pet.com/relay'
    const POLL_MS = 5000
    /** 内嵌小游戏（微信小游戏的浏览器移植版，和 /api/fish/ 同源） */
    const GAME_URL = 'https://xdxy-pet.com/game/'

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

    /** 每个会话各自的聊天背景，存在本地 */
    const BG_KEY = 'dsh-share-chat.bg'
    const BG_COLORS = ['#f7f3ea', '#eaf2fb', '#f0f7ee', '#fdf0f3', '#f3f0fb', '#fff8e6', '#eef6f7', '#f4f4f5']
    const BG_GRADS = [
      'linear-gradient(160deg,#e8f3ff,#f8fcff)',
      'linear-gradient(160deg,#fff1e6,#fff9f4)',
      'linear-gradient(160deg,#eaf7ee,#f7fdf9)',
      'linear-gradient(160deg,#f3ecff,#fbf8ff)',
    ]

    /** 记住上次打开的会话，下次进来自动落在那儿 */
    const LAST_CONV_KEY = 'dsh-share-chat.lastConv'

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

    /** 图片 / 视频缩略图的统一尺寸（0.1.6 起） */
    const MEDIA_STYLE = {
      maxWidth: '100%',
      maxHeight: '340px',
      borderRadius: '14px',
      display: 'block',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2))',
    }

    /** 按类型/扩展名给一个图标，充当非图片文件的「缩略图」（0.1.6 起） */
    function fileIcon(type, name) {
      const t = String(type || '')
      const ext = String(name || '')
        .toLowerCase()
        .split('.')
        .pop()
      if (t.startsWith('image/')) return '🖼️'
      if (t.startsWith('video/')) return '🎬'
      if (t.startsWith('audio/')) return '🎵'
      if (t === 'application/pdf' || ext === 'pdf') return '📕'
      if (/zip|rar|7z|tar|gzip|xz/.test(t) || ['zip', 'rar', '7z', 'tar', 'gz', 'xz'].includes(ext)) {
        return '📦'
      }
      if (/^(xls|xlsx|csv|ods)$/.test(ext) || t.includes('spreadsheet')) return '📊'
      if (/^(doc|docx|rtf)$/.test(ext) || t.includes('word')) return '📝'
      if (/^(ppt|pptx|key)$/.test(ext) || t.includes('presentation')) return '📽️'
      if (
        /^(js|ts|tsx|jsx|mjs|json|py|go|rs|java|c|h|cpp|css|html|sh|ps1|bat|yml|yaml|toml|md)$/.test(
          ext,
        )
      ) {
        return '💻'
      }
      if (/^application\/(json|xml|javascript)/.test(t)) return '💻'
      return '📄'
    }


    /**
     * 主题自适应兜底：找自己背后真正有颜色的那一层，判断是亮面还是暗面。
     * 某些槽位（比如 main 面板）不会把 DSH 的暗色背景带下来，此时 token 可能是
     * 「白字」而背景是白的 —— 这里按实际背景强制一套可读的 token。
     */
    function parseColorToRgb(value) {
      const m = String(value || '').match(/rgba?\(([^)]+)\)/)
      if (!m) return null
      const parts = m[1].split(',').map((x) => parseFloat(x.trim()))
      if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
    }

    function relativeLuminance(c) {
      const f = (v) => {
        const x = v / 255
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
    }

    function effectiveBackground(el) {
      let node = el
      while (node && node.nodeType === 1) {
        const c = parseColorToRgb(getComputedStyle(node).backgroundColor)
        if (c && c.a > 0.5) return c
        node = node.parentElement
      }
      return { r: 255, g: 255, b: 255, a: 1 }
    }

    const LIGHT_TOKENS = {
      '--dsw-alias-label-primary': '#1f2328',
      '--dsw-alias-label-secondary': '#5b6570',
      '--dsw-alias-label-tertiary': '#8b949e',
      '--dsw-alias-label-quaternary': '#a0a8b0',
      '--dsw-alias-border-l2': 'rgba(20,20,20,.12)',
      '--dsw-alias-border-l3': 'rgba(20,20,20,.18)',
      '--dsw-alias-fill-l1': 'rgba(0,0,0,.035)',
      '--dsw-alias-fill-l2': 'rgba(0,0,0,.07)',
      '--dsw-alias-card-fill': 'rgba(0,0,0,.04)',
      '--dsw-alias-card-fill-hover': 'rgba(0,0,0,.08)',
      '--dsw-alias-interactive-bg-hover': 'rgba(0,0,0,.06)',
      '--dsw-alias-brand-primary': '#247bbf',
      '--dsw-alias-link': '#247bbf',
    }

    const DARK_TOKENS = {
      '--dsw-alias-label-primary': '#e9f2f6',
      '--dsw-alias-label-secondary': '#9fb3bd',
      '--dsw-alias-label-tertiary': '#7c939d',
      '--dsw-alias-label-quaternary': '#5f757e',
      '--dsw-alias-border-l2': 'rgba(255,255,255,.12)',
      '--dsw-alias-border-l3': 'rgba(255,255,255,.18)',
      '--dsw-alias-fill-l1': 'rgba(255,255,255,.035)',
      '--dsw-alias-fill-l2': 'rgba(255,255,255,.08)',
      '--dsw-alias-card-fill': 'rgba(255,255,255,.05)',
      '--dsw-alias-card-fill-hover': 'rgba(255,255,255,.10)',
      '--dsw-alias-interactive-bg-hover': 'rgba(255,255,255,.07)',
      '--dsw-alias-brand-primary': '#247bbf',
      '--dsw-alias-link': '#67b6ea',
    }

    /** 如果文字色和实际背景的对比度太低，就用实际背景对应的那套 token */
    function adaptSurfaceTokens(root) {
      try {
        if (!root || typeof getComputedStyle !== 'function') return
        const bg = effectiveBackground(root)
        const fg = parseColorToRgb(getComputedStyle(root).color) || { r: 0, g: 0, b: 0, a: 1 }
        const l1 = relativeLuminance(bg)
        const l2 = relativeLuminance(fg)
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
        const surfaceIsLight = l1 > 0.5
        root.setAttribute('data-sc-surface', surfaceIsLight ? 'light' : 'dark')
        if (ratio < 3) {
          const tokens = surfaceIsLight ? LIGHT_TOKENS : DARK_TOKENS
          for (const k of Object.keys(tokens)) root.style.setProperty(k, tokens[k])
        }
      } catch (e) {
        /* 取不到样式就算了，保持原样 */
      }
    }

    // ───────────────────────── 样式 ─────────────────────────

    const STYLE_ID = 'dsh-share-chat-style'

    /** 全部用 DSH 主题 token（--dsw-alias-*），带亮/暗两套都能用的兜底值 */
    const CSS = `
.sc-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;line-height:1.55;-webkit-font-smoothing:antialiased}
.sc-root *{box-sizing:border-box}
.sc-root ::-webkit-scrollbar{width:8px;height:8px}
.sc-root ::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-hover-l1,rgba(128,128,128,.32));border-radius:99px}
.sc-root ::-webkit-scrollbar-track{background:transparent}
.sc-grow{flex:1;min-width:0}

.sc-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.30));background:transparent;color:inherit;font:inherit;font-size:12.5px;cursor:pointer;transition:background .15s,border-color .15s,transform .08s;white-space:nowrap}
.sc-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10))}
.sc-btn:active{transform:scale(.97)}
.sc-btn:disabled{opacity:.42;cursor:default;transform:none}
.sc-btn-primary{border-color:transparent;background:#247bbf;color:#fff}
.sc-btn-primary:hover{background:#1f6cab}
.sc-btn-primary:disabled{background:#2f5f86;color:rgba(255,255,255,.72)}
.sc-btn-ghost{border-color:transparent}
.sc-btn-ghost:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10))}
.sc-icon-btn{width:30px;padding:0;font-size:15px}
.sc-btn-sm{height:26px;padding:0 9px;font-size:12px;border-radius:8px}

.sc-input,.sc-textarea{width:100%;padding:8px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.30));background:var(--dsw-alias-bg-base,transparent);color:inherit;font:inherit;font-size:13px;outline:none;transition:border-color .15s,box-shadow .15s}
.sc-input:focus,.sc-textarea:focus{border-color:var(--dsw-alias-brand-primary,#247bbf);box-shadow:0 0 0 3px rgba(36,123,191,.15)}
.sc-input::placeholder,.sc-textarea::placeholder{color:var(--dsw-alias-label-tertiary,#8b949e)}

.sc-avatar{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;font-weight:600;color:#fff;user-select:none;overflow:hidden}
.sc-chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:99px;background:var(--dsw-alias-fill-l2,rgba(128,128,128,.10));color:var(--dsw-alias-label-secondary,#5b6570);font-size:11px;white-space:nowrap}
.sc-err{color:var(--dsw-alias-label-error,#d9534f);font-size:12px}

/* 登录 */
.sc-login{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:24px;overflow:auto}
.sc-login-card{width:100%;max-width:400px;background:var(--dsw-alias-bg-elevated,var(--dsw-alias-card-fill,#fff));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.20));border-radius:20px;padding:26px 24px 20px;box-shadow:0 18px 50px rgba(0,0,0,.10)}
.sc-logo{width:44px;height:44px;border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:22px;background:linear-gradient(135deg,rgba(36,123,191,.18),rgba(36,123,191,.06));margin-bottom:14px}
.sc-login-title{font-size:19px;font-weight:650;letter-spacing:.2px}
.sc-login-sub{color:var(--dsw-alias-label-secondary,#5b6570);font-size:12.5px;margin-top:4px;margin-bottom:18px}
.sc-tabs{display:flex;gap:3px;padding:3px;border-radius:11px;background:var(--dsw-alias-fill-l1,rgba(128,128,128,.08));margin-bottom:16px}
.sc-tab{flex:1;height:28px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6570);font:inherit;font-size:12.5px;cursor:pointer;transition:background .15s,color .15s}
.sc-tab.on{background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2328);box-shadow:0 1px 3px rgba(0,0,0,.10)}
.sc-field{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}
.sc-field label{font-size:12px;color:var(--dsw-alias-label-secondary,#5b6570)}
.sc-login-actions{display:flex;align-items:center;gap:10px;margin-top:6px}
.sc-link{border:0;background:transparent;color:var(--dsw-alias-link,#247bbf);font:inherit;font-size:12px;cursor:pointer;padding:0}
.sc-link:hover{text-decoration:underline}
.sc-foot{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11.5px;margin-top:14px;line-height:1.6}

/* 聊天外壳 */
.sc-chat{flex:1;min-height:0;display:flex;flex-direction:column;position:relative}
.sc-chat-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.20));flex:0 0 auto;position:absolute;top:0;left:0;right:0;z-index:6;background:var(--dsw-alias-bg-l1,Canvas)}
.sc-chat-name{font-size:13.5px;font-weight:600;line-height:1.2}
.sc-chat-sub{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b949e);line-height:1.3}
.sc-chat-body{flex:1;min-height:0;display:flex}

.sc-side{width:236px;flex:0 0 236px;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.20));background:var(--dsw-alias-fill-l1,rgba(128,128,128,.035))}
.sc-side-title{padding:12px 14px 6px;font-size:11.5px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#8b949e)}
.sc-add{display:flex;gap:6px;padding:0 10px 8px}
.sc-add .sc-input{height:30px;padding:0 10px;font-size:12.5px}
.sc-friends{flex:1;min-height:0;overflow:auto;padding:0 8px 10px;display:flex;flex-direction:column;gap:2px}
.sc-friend{display:flex;align-items:center;gap:9px;padding:7px 8px;border-radius:10px;cursor:pointer;transition:background .15s;border:1px solid transparent}
.sc-friend:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10))}
.sc-friend.on{background:rgba(36,123,191,.10);border-color:rgba(36,123,191,.28)}
.sc-friend-main{flex:1;min-width:0}
.sc-friend-name{font-size:12.5px;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-friend-last{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b949e);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.sc-main{flex:1;min-width:0;display:flex;flex-direction:column}
.sc-thread{flex:1;min-height:0;overflow:auto;padding:18px}
.sc-thread-inner{max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:10px}
.sc-msg{display:flex;flex-direction:column;align-items:flex-start;gap:3px;max-width:100%}
.sc-msg.mine{align-items:flex-end}
.sc-msg-row{display:flex;gap:8px;align-items:flex-start;max-width:100%}
.sc-msg-row.mine{flex-direction:row-reverse}
.sc-msg-row>.sc-avatar{margin-top:2px}
.sc-msg-row .sc-msg{flex:1 1 auto;min-width:0;max-width:none}
.sc-bubble{max-width:min(78%,560px);padding:8px 12px;border-radius:14px 14px 14px 4px;background:var(--dsw-alias-fill-l2,rgba(128,128,128,.12));white-space:pre-wrap;word-break:break-word}
.sc-msg.mine .sc-bubble{background:var(--dsw-alias-brand-primary,#247bbf);color:var(--dsw-alias-label-on-color,#fff);border-radius:14px 14px 4px 14px}
.sc-time{font-size:10.5px;color:var(--dsw-alias-label-quaternary,#a0a8b0);padding:0 4px}
.sc-msg-img{max-width:min(78%,420px);max-height:340px;border-radius:14px;display:block;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2))}
.sc-file{display:inline-flex;align-items:center;gap:10px;padding:8px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));background:var(--dsw-alias-card-fill,rgba(128,128,128,.06));color:inherit;text-decoration:none;max-width:320px}
.sc-file:hover{background:var(--dsw-alias-card-fill-hover,rgba(128,128,128,.12))}
.sc-file-ico{font-size:24px;line-height:1}
.sc-file-main{display:flex;flex-direction:column;min-width:0}
.sc-file-name{font-size:12.5px;text-decoration:underline;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-file:hover{background:var(--dsw-alias-card-fill-hover,rgba(128,128,128,.12))}
.sc-file-name{font-size:12.5px}
.sc-file-size{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b949e)}

.sc-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--dsw-alias-label-tertiary,#8b949e);padding:40px 20px;text-align:center}
.sc-empty-ico{font-size:30px;opacity:.75;line-height:1}
.sc-empty-title{font-size:13px;color:var(--dsw-alias-label-secondary,#5b6570)}
.sc-empty-hint{font-size:11.5px;opacity:.8}

/* 输入区 */
.sc-composer{position:absolute;left:0;right:0;bottom:0;z-index:6;flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.20));padding:10px 14px 12px;background:var(--dsw-alias-bg-l1,Canvas)}
.sc-composer-inner{max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:8px}
.sc-emoji{display:flex;flex-wrap:wrap;gap:2px;max-height:112px;overflow:auto;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.20));border-radius:12px;padding:6px;background:var(--dsw-alias-bg-elevated,transparent)}
.sc-emoji button{border:0;background:transparent;font-size:17px;line-height:1;padding:4px 5px;border-radius:7px;cursor:pointer}
.sc-emoji button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}
.sc-composer-box{display:flex;align-items:flex-end;gap:6px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.30));border-radius:16px;padding:5px 6px;background:var(--dsw-alias-bg-base,transparent);transition:border-color .15s,box-shadow .15s}
.sc-composer-box:focus-within{border-color:var(--dsw-alias-brand-primary,#247bbf);box-shadow:0 0 0 3px rgba(36,123,191,.13)}
.sc-textarea{flex:1;min-height:34px;max-height:140px;padding:6px 6px 6px 8px;border:0;background:transparent;resize:none;outline:none;box-shadow:none}
.sc-textarea:focus{box-shadow:none;border:0}
.sc-send{height:30px;padding:0 14px;border-radius:10px}

/* 快照卡片 */
.sc-snap{max-width:min(88%,560px);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));border-radius:14px;overflow:hidden;background:var(--dsw-alias-card-fill,rgba(128,128,128,.05))}
.sc-snap-head{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.20));background:var(--dsw-alias-fill-l1,rgba(128,128,128,.05))}
.sc-snap-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;color:var(--dsw-alias-brand-primary,#247bbf)}
.sc-snap-title{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b949e);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-snap-body{padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.sc-blk{white-space:pre-wrap;word-break:break-word;font-size:12.5px}
.sc-blk-user{padding-left:9px;border-left:2px solid rgba(36,123,191,.55)}
.sc-blk-tool{padding:6px 9px;border-radius:8px;background:var(--dsw-alias-fill-l1,rgba(128,128,128,.08));font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary,#5b6570)}
.sc-snap-skeleton{padding:14px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b949e)}

/* 分享条 */
.sc-share{border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.20));padding:8px 14px;flex:0 0 auto;background:var(--dsw-alias-fill-l1,rgba(128,128,128,.03))}
.sc-share-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sc-share-note{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b949e)}
.sc-preview{margin-top:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));border-radius:12px;max-height:190px;overflow:auto;padding:8px 10px;display:flex;flex-direction:column;gap:5px;background:var(--dsw-alias-bg-base,transparent)}
.sc-preview-cap{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b949e)}
.sc-preview-line{font-size:11px;line-height:1.5;font-family:ui-monospace,Consolas,monospace;opacity:.85;white-space:pre-wrap;word-break:break-word}
.sc-preview-line.tool{opacity:.55}
.sc-share-err{color:var(--dsw-alias-label-error,#d9534f);font-size:11.5px}

/* 设置页 */
.sc-set{display:flex;flex-direction:column;gap:14px;padding:4px 2px}
.sc-set-title{font-size:15px;font-weight:600}
.sc-set-desc{font-size:12px;color:var(--dsw-alias-label-secondary,#5b6570);line-height:1.65}
.sc-set-group{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));border-radius:14px;padding:14px}
.sc-set-label{font-size:12px;color:var(--dsw-alias-label-secondary,#5b6570);margin-bottom:8px}
.sc-cards{display:flex;gap:8px;flex-wrap:wrap}
.sc-card-btn{flex:1 1 120px;min-width:112px;display:flex;flex-direction:column;align-items:center;gap:3px;padding:12px 10px;border-radius:12px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.28));background:transparent;color:inherit;cursor:pointer;font:inherit;transition:background .15s,border-color .15s}
.sc-card-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}
.sc-card-btn.on{border-color:var(--dsw-alias-brand-primary,#247bbf);background:rgba(36,123,191,.08)}
.sc-card-btn b{font-size:12.5px;font-weight:600}
.sc-card-btn span{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b949e)}
.sc-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sc-inline .sc-input{width:88px;height:30px;padding:0 10px}
.sc-ok{font-size:11.5px;color:var(--dsw-alias-state-success-primary,#2f8f65)}
.sc-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b949e)}

.sc-camp{flex:1;min-height:0;overflow:auto;padding:16px 18px}
.sc-camp-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.sc-camp-grid{display:flex;flex-direction:column;gap:10px;max-width:880px;margin:0 auto}
.sc-camp-card{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));border-radius:14px;background:var(--dsw-alias-card-fill,rgba(128,128,128,.05));cursor:pointer;transition:background .15s,border-color .15s}
.sc-camp-card:hover{background:var(--dsw-alias-card-fill-hover,rgba(128,128,128,.10));border-color:var(--dsw-alias-border-l3,rgba(128,128,128,.32))}
.sc-camp-emoji{width:38px;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:19px;background:rgba(36,123,191,.18)}
.sc-camp-info{flex:1;min-width:0}
.sc-camp-name{font-size:13.5px;font-weight:600}
.sc-camp-greet{font-size:12px;color:var(--dsw-alias-label-secondary,#5b6570);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-camp-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b949e)}
.sc-camp-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:99px;font-size:10.5px;white-space:nowrap}
.sc-badge-have{background:rgba(76,195,138,.16);color:#4cc38a}
.sc-badge-new{background:rgba(36,123,191,.18);color:#67b6ea}
.sc-badge-diff{background:rgba(240,180,80,.16);color:#e6b35c}
.sc-badge-builtin{background:rgba(255,255,255,.08);color:var(--dsw-alias-label-tertiary,#8b949e)}
.sc-camp-form{display:flex;flex-direction:column;gap:10px;max-width:520px;padding:16px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));border-radius:14px;background:var(--dsw-alias-card-fill,rgba(128,128,128,.05))}
.sc-camp-plugins{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.sc-camp-plug{display:flex;align-items:center;gap:8px;font-size:12px}
.sc-camp-plug .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-char-svg{display:block;overflow:visible}
.sc-scene{position:relative;height:200px;border-radius:14px;overflow:hidden;margin:0 0 14px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));background:linear-gradient(180deg,#0d2a35 0%,#0a1a20 100%)}
.sc-scene-floor{position:absolute;left:0;right:0;bottom:0;height:52px;background:linear-gradient(180deg,rgba(36,123,191,.20),rgba(36,123,191,.03));border-top:1px solid rgba(86,176,236,.28)}
.sc-scene-actor{position:absolute;bottom:16px;display:flex;flex-direction:column;align-items:center;gap:2px}
.sc-scene-bob{animation:sc-bob 2.4s ease-in-out infinite}
.sc-scene-actor.walk{animation:sc-walk-in .95s ease-out both}
.sc-scene-name{font-size:10px;line-height:1.6;padding:1px 7px;border-radius:99px;background:rgba(0,0,0,.45);color:#dfeef5;white-space:nowrap}
.sc-scene-empty{position:absolute;left:50%;top:16px;transform:translateX(-50%);font-size:11.5px;color:rgba(223,238,245,.55)}
@keyframes sc-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
@keyframes sc-walk-in{from{transform:translateX(-140px);opacity:0}to{transform:translateX(0);opacity:1}}
.sc-char-btn{display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 10px;border-radius:11px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.3));background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.sc-char-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))}
.sc-face-mask{position:fixed;inset:0;z-index:2147483645;display:flex;align-items:center;justify-content:center;background:rgba(4,10,14,.72);backdrop-filter:blur(6px)}
.sc-face{width:min(1040px,94vw);height:min(720px,92vh);display:flex;flex-direction:column;border-radius:18px;overflow:hidden;
  background:var(--dsw-alias-bg-base,#0e1116);color:var(--dsw-alias-label-primary,#e9f2f6);
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));box-shadow:0 30px 80px rgba(0,0,0,.55)}
.sc-face-head{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));flex:0 0 auto;flex-wrap:wrap}
.sc-face-title{font-size:14px;font-weight:600}
.sc-face-body{flex:1;min-height:0;display:flex}
.sc-face-left{width:340px;flex:0 0 auto;padding:16px;border-right:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));display:flex;flex-direction:column;align-items:center;gap:10px}
.sc-face-stage{width:100%;height:330px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));background:radial-gradient(120% 80% at 50% 0%,rgba(80,150,190,.20),rgba(10,20,26,.5));display:flex;align-items:center;justify-content:center;overflow:hidden}
.sc-face-right{flex:1;min-width:0;display:flex;flex-direction:column}
.sc-face-tabs{display:flex;gap:6px;padding:10px 14px;overflow-x:auto;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));flex:0 0 auto}
.sc-face-tab{height:26px;padding:0 10px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#9fb3bd);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.sc-face-tab.on{background:rgba(36,123,191,.18);border-color:rgba(86,176,236,.4);color:var(--dsw-alias-label-primary,#e9f2f6)}
.sc-face-params{flex:1;min-height:0;overflow:auto;padding:14px 16px}
.sc-face-row{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.sc-face-row .lab{width:70px;flex:0 0 auto;font-size:12px;color:var(--dsw-alias-label-secondary,#9fb3bd)}
.sc-face-row input[type=range]{flex:1;accent-color:#247bbf;height:18px}
.sc-face-row .num{width:44px;text-align:right;font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#8b949e)}
.sc-face-sw{margin-bottom:12px}
.sc-face-sw .lab{display:block;font-size:12px;color:var(--dsw-alias-label-secondary,#9fb3bd);margin-bottom:6px}
.sc-swatches{display:flex;gap:7px;flex-wrap:wrap}
.sc-swatch{width:24px;height:24px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0}
.sc-swatch.on{border-color:#67b6ea;box-shadow:0 0 0 2px rgba(103,182,234,.25)}
.sc-seg{display:flex;gap:6px;flex-wrap:wrap}
.sc-seg button{height:26px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.sc-seg button.on{background:rgba(36,123,191,.22);border-color:rgba(86,176,236,.45)}
.sc-face-foot{display:flex;align-items:center;gap:8px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));flex:0 0 auto;flex-wrap:wrap}
.sc-face-code{flex:1;min-width:160px;font-family:ui-monospace,Consolas,monospace;font-size:10.5px}
@media (max-width: 720px){
  .sc-side{width:152px;flex-basis:152px}
  .sc-side-title{padding:10px 10px 4px}
  .sc-friend-last{display:none}
  .sc-chat-sub{display:none}
  .sc-thread{padding:12px}
  .sc-thread-inner{gap:8px}
  .sc-composer{padding:8px 10px 10px}
  .sc-share{padding:6px 10px}
  .sc-login{padding:12px}
  .sc-login-card{padding:20px 16px 16px;border-radius:16px}
}
`

    /** 多巴胺主题：叠在基础样式之后，只改观感不动布局 */
    const DOPAMINE_CSS = `
.sc-root{
  --dopa-pink:#ff5fa2; --dopa-pink-soft:#ffe3ef; --dopa-violet:#a86bff;
  --dopa-blue:#4d9fff; --dopa-mint:#3ddc97; --dopa-yellow:#ffcf3d; --dopa-ink:#3b2b45;
  background:linear-gradient(180deg,#fff8fc 0%,#f7faff 100%);
}
/* 顶栏 */
.sc-chat-head{background:linear-gradient(96deg,#ffeaf4 0%,#fff7e8 45%,#eaf4ff 100%);border-bottom:2px solid #ffd9ec;box-shadow:0 4px 14px rgba(255,120,180,.10)}
.sc-chat-name{color:#4a2b52}
.sc-chat-sub{color:#a184b3}
/* 按钮 */
.sc-btn{border-radius:12px;border:1.5px solid #ffd3e6;background:#fff;font-weight:650;color:#5b3a63;transition:background .15s,border-color .15s,transform .1s}
.sc-btn:hover{background:#fff2f9;border-color:#ff9ec4}
.sc-btn:active{transform:scale(.97)}
.sc-btn-ghost{border-color:#e8e2f0;background:transparent;color:#8a7a95}
.sc-btn-primary{background:linear-gradient(135deg,#ff5fa2,#a86bff);color:#fff;border-color:transparent;box-shadow:0 6px 16px rgba(255,95,162,.30)}
.sc-btn-primary:hover{background:linear-gradient(135deg,#ff4b96,#9a58ff);border-color:transparent}
/* 侧栏 */
.sc-side{background:linear-gradient(180deg,#fff5fa 0%,#f4f9ff 100%);border-right:2px solid #ffe3f0}
.sc-contacts{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}
.sc-side-title{color:#b14a86;letter-spacing:.6px}
.sc-add .sc-input{border:1.5px solid #ffd3e6;border-radius:12px;background:#fff}
.sc-add .sc-input:focus{border-color:#ff9ec4;box-shadow:0 0 0 3px rgba(255,158,196,.25);outline:none}
.sc-friend{border-radius:14px;transition:background .15s,box-shadow .15s}
.sc-friend:hover{background:#fff6fb}
.sc-friend.on{background:linear-gradient(135deg,#ffe3f0,#e0f0ff);box-shadow:inset 0 0 0 2px #ffb3d4,0 6px 14px rgba(255,120,180,.16)}
.sc-friend-name{color:#4a2b52;font-weight:650}
.sc-friend-last{color:#a184b3}
/* 消息 */
.sc-thread{background:transparent}
.sc-bubble{background:#fff;border:1.5px solid #ffdcea;box-shadow:0 3px 10px rgba(168,107,255,.10)}
.sc-msg.mine .sc-bubble{background:linear-gradient(135deg,#ff5fa2,#a86bff);border-color:transparent;color:#fff;box-shadow:0 8px 20px rgba(255,95,162,.28)}
.sc-time{color:#a78bb5}
.sc-avatar{box-shadow:0 0 0 2px #fff,0 2px 8px rgba(60,40,80,.16)}
/* 文件卡片 */
.sc-file{background:linear-gradient(135deg,#f3f8ff,#fff4fb);border:1.5px solid #d6e6ff;border-radius:14px;transition:box-shadow .15s,transform .1s}
.sc-file:hover{box-shadow:0 6px 18px rgba(77,159,255,.20);transform:translateY(-1px)}
.sc-file-name{color:#2f4a6b;font-weight:600}
.sc-file-size{color:#8fa6bf}
/* 输入区 */
.sc-composer{background:linear-gradient(180deg,#ffffff,#fff8fc);border-top:2px solid #ffd9ec;box-shadow:0 -4px 14px rgba(255,120,180,.08)}
.sc-composer input,.sc-composer textarea{border:1.5px solid #ffd3e6;border-radius:16px;background:#fff;outline:none}
.sc-composer input:focus,.sc-composer textarea:focus{border-color:#ff9ec4;box-shadow:0 0 0 3px rgba(255,158,196,.22)}
.sc-emoji{border:1.5px solid #ffd3e6;border-radius:16px;background:#fff}
/* 空状态 / 报错 */
.sc-err{background:#fff0f5;border-radius:10px;padding:2px 8px}
/* 滚动条 */
.sc-thread::-webkit-scrollbar,.sc-friends::-webkit-scrollbar,.sc-side::-webkit-scrollbar{width:9px}
.sc-thread::-webkit-scrollbar-thumb,.sc-friends::-webkit-scrollbar-thumb,.sc-side::-webkit-scrollbar-thumb{background:#ffd0e6;border-radius:9px;border:2px solid transparent;background-clip:content-box}
.sc-thread::-webkit-scrollbar-thumb:hover{background:#ffb3d4;background-clip:content-box}
.sc-thread::-webkit-scrollbar-track,.sc-friends::-webkit-scrollbar-track{background:transparent}
/* 登录卡片 */
.sc-login-card{border:2px solid #ffe0ee;border-radius:24px;box-shadow:0 22px 60px rgba(255,120,180,.18)}
.sc-logo{background:linear-gradient(135deg,#ffd6e8,#e6f0ff);border-radius:16px}
.sc-login-title{color:#4a2b52}
`

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (!document.getElementById(STYLE_ID)) {
        const el = document.createElement('style')
        el.id = STYLE_ID
        el.textContent = CSS
        document.head.appendChild(el)
      }
      const dopaId = STYLE_ID + '-dopa'
      if (!document.getElementById(dopaId)) {
        const t = document.createElement('style')
        t.id = dopaId
        t.textContent = DOPAMINE_CSS
        document.head.appendChild(t)
      }
    }

    const LINE = '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.22))'

    function hueOf(id) {
      const s = String(id || '?')
      let x = 0
      for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) % 360
      return x
    }

    /** 当前 relay 地址，头像 URL 要拼它（插件页面和 relay 不同源） */
    let avatarBase = ''

    function avatar(name, id, size, avatarId, isGroup) {
      const sz = size || 30
      if (avatarId) {
        return h('img', {
          className: 'sc-avatar',
          src: avatarBase + '/f/' + avatarId,
          alt: String(name || id || ''),
          loading: 'lazy',
          style: { width: sz + 'px', height: sz + 'px', objectFit: 'cover', display: 'block' },
        })
      }
      const hue = hueOf(id || name)
      const initial = isGroup
        ? '👥'
        : String(name || id || '?').trim().charAt(0).toUpperCase()
      return h(
        'span',
        {
          className: 'sc-avatar',
          style: {
            width: sz + 'px',
            height: sz + 'px',
            fontSize: Math.max(11, Math.round(sz * 0.42)) + 'px',
            background:
              'linear-gradient(135deg,hsl(' +
              hue +
              ' 58% 52%),hsl(' +
              ((hue + 34) % 360) +
              ' 58% 44%))',
          },
        },
        initial,
      )
    }

    function clockText(at) {
      try {
        return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      } catch (e) {
        return ''
      }
    }

    function emptyState(ico, title, hint) {
      return h(
        'div',
        { className: 'sc-empty' },
        h('div', { className: 'sc-empty-ico' }, ico),
        h('div', { className: 'sc-empty-title' }, title),
        hint ? h('div', { className: 'sc-empty-hint' }, hint) : null,
      )
    }

    // ───────────────────────── 快照 ─────────────────────────

    /** 对方发来的对话快照：只读卡片，块按「用户 / 工具 / 回复」三种样式渲染 */
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

      const head = (title) =>
        h(
          'div',
          { className: 'sc-snap-head' },
          h('span', { className: 'sc-snap-badge' }, '🐟 对话快照'),
          h('span', { className: 'sc-snap-title' }, title || ''),
        )

      if (err) {
        return h(
          'div',
          { className: 'sc-snap' },
          head('打不开'),
          h('div', { className: 'sc-snap-body' }, h('div', { className: 'sc-err' }, err)),
        )
      }
      if (!snap) {
        return h('div', { className: 'sc-snap' }, head(''), h('div', { className: 'sc-snap-skeleton' }, '正在加载快照…'))
      }

      const blocks = Array.isArray(snap.blocks) ? snap.blocks : []
      return h(
        'div',
        { className: 'sc-snap' },
        head(snap.title || ''),
        h(
          'div',
          { className: 'sc-snap-body' },
          blocks.map((b, i) =>
            h(
              'div',
              { key: i, className: 'sc-blk sc-blk-' + (b.t || 'assistant') },
              b.t === 'tool'
                ? h('span', null, h('b', null, b.name || '工具'), '  ' + String(b.text || ''))
                : String(b.text || ''),
            ),
          ),
        ),
      )
    }

    // ───────────────────────── 登录 ─────────────────────────

    const MODE_HINTS = {
      login: '账号在服务器上，换端口、换电脑都只认密码。',
      register: '需要邀请码。密码至少 6 位，设了以后就不怕掉登录。',
      setpw: '给已有账号补一个密码，用邀请码授权。',
      token: '粘贴之前保存的 token，临时登录用。',
    }

    function LoginPanel(props) {
      const [server, setServer] = useState(() => {
        try {
          return window.localStorage.getItem(K_SERVER) || DEFAULT_SERVER
        } catch (e) {
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
            className: 'sc-tab' + (mode === value ? ' on' : ''),
            onClick: () => {
              setMode(value)
              setErr('')
            },
          },
          label,
        )

      const field = (label, placeholder, value, onChange, extra) =>
        h(
          'div',
          { className: 'sc-field' },
          h('label', null, label),
          h('input', {
            className: 'sc-input',
            placeholder,
            value,
            onChange: (e) => onChange(e.target.value),
            ...(extra || {}),
          }),
        )

      const buttonLabel =
        mode === 'login'
          ? '登录'
          : mode === 'register'
            ? '注册并进入'
            : mode === 'setpw'
              ? '设置密码并登录'
              : '用 token 登录'

      return h(
        'div',
        { className: 'sc-login' },
        h(
          'div',
          { className: 'sc-login-card' },
          h('div', { className: 'sc-logo' }, '🐟'),
          h('div', { className: 'sc-login-title' }, '社交'),
          h('div', { className: 'sc-login-sub' }, MODE_HINTS[mode]),

          h(
            'div',
            { className: 'sc-tabs' },
            tab('login', '登录'),
            tab('register', '注册'),
            tab('token', 'Token'),
          ),

          field('服务器', 'https://…', server, setServer),
          mode === 'register' || mode === 'setpw'
            ? field('邀请码', '找发插件的人要', invite, setInvite)
            : null,
          mode === 'token' ? null : field('账号名', '2–20 位，中文可以', id, setId),
          mode === 'token'
            ? h(
                'div',
                { className: 'sc-field' },
                h('label', null, 'Token'),
                h('textarea', {
                  className: 'sc-textarea',
                  style: { minHeight: '76px' },
                  placeholder: '粘贴 token',
                  value: token,
                  onChange: (e) => setToken(e.target.value),
                }),
              )
            : field(mode === 'setpw' ? '新密码' : '密码', mode === 'setpw' ? '至少 6 位' : '密码', password, setPassword, {
                type: 'password',
                onKeyDown: (e) => {
                  if (e.key === 'Enter') submit()
                },
              }),

          err ? h('div', { className: 'sc-err', style: { marginBottom: '10px' } }, err) : null,

          h(
            'div',
            { className: 'sc-login-actions' },
            h(
              'button',
              {
                className: 'sc-btn sc-btn-primary',
                style: { height: '34px', padding: '0 18px', flex: 1 },
                onClick: submit,
                disabled: busy,
              },
              busy ? '请稍候…' : buttonLabel,
            ),
            mode === 'login'
              ? h(
                  'button',
                  {
                    className: 'sc-link',
                    onClick: () => {
                      setMode('setpw')
                      setErr('')
                    },
                  },
                  '没设过密码？',
                )
              : null,
          ),

          h('div', { className: 'sc-foot' }, '消息和快照都留在你自己的服务器上，不经过模型，不消耗 token。'),
        ),
      )
    }

    // ───────────────────────── 聊天 ─────────────────────────

    function ChatPanel(props) {
      const auth = props.auth
      const [friends, setFriends] = useState([])
      const [active, setActive] = useState(() => readJson(LAST_CONV_KEY) || null)
      const [messages, setMessages] = useState([])
      const [draft, setDraft] = useState('')
      const [newFriend, setNewFriend] = useState('')
      const [err, setErr] = useState('')
      const [sending, setSending] = useState(false)
      const [uploading, setUploading] = useState(false)
      // 正在上传的附件：先占一个气泡，成功就撤掉（真消息由 pull 补上），失败就留在原地标红
      const [pending, setPending] = useState([])
      const [emojiOpen, setEmojiOpen] = useState(false)
      const [campMode, setCampMode] = useState(false)
      avatarBase = auth.server
      const [groups, setGroups] = useState([])
      const [hiddenChats, setHiddenChats] = useState([])
      const [sideTab, setSideTab] = useState('chats')
      const [myAvatar, setMyAvatar] = useState('')
      // Electron 里 window.prompt 不可用，所有需要输入的地方都走这个内联框
      const [inline, setInline] = useState(null)
      const [askMode, setAskMode] = useState(() => readJson('dsh-share-chat.ask') === true)
      useEffect(() => {
        writeJson('dsh-share-chat.ask', askMode)
      }, [askMode])
      const [bgMap, setBgMap] = useState(() => readJson(BG_KEY) || {})
      const [bgOpen, setBgOpen] = useState(false)

      const cursorRef = useRef(0)
      const listRef = useRef(null)
      const headRef = useRef(null)
      const composerRef = useRef(null)
      const chatRef = useRef(null)
      const activeRef = useRef(null)
      const friendsKeyRef = useRef('')
      const fileRef = useRef(null)

      useEffect(() => {
        activeRef.current = active
        if (active) writeJson(LAST_CONV_KEY, active)
      }, [active])

      const loadFriends = useCallback(async () => {
        try {
          const r = await api(auth.server, '/api/friends', { token: auth.token })
          setFriends(r.friends || [])
          setGroups(r.groups || [])
          setHiddenChats(Array.isArray(r.hidden) ? r.hidden : [])
          // 上次那个会话没了（退群/删好友）就退回第一个
          const keys = (r.friends || []).map((f) => f.id)
          for (const g of r.groups || []) keys.push('g:' + g.id)
          const cur = activeRef.current
          if (cur && keys.indexOf(cur) < 0) {
            setActive(keys[0] || null)
          } else if (!cur && keys.length) {
            setActive(keys[0])
          }
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
        api(auth.server, '/api/me', { token: auth.token })
          .then((me) => {
            if (alive && me && me.avatar) setMyAvatar(me.avatar)
          })
          .catch(() => {})
        // 背景以服务端为准（跨设备），本地只是缓存
        api(auth.server, '/api/bg', { token: auth.token })
          .then((r) => {
            if (!alive || !r || !r.bgs) return
            setBgMap((prev) => {
              const merged = Object.assign({}, prev, r.bgs)
              writeJson(BG_KEY, merged)
              return merged
            })
          })
          .catch(() => {})
        return () => {
          alive = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [loadFriends])

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

      // 5 秒轮询：消息 + 好友列表（对方加了你这边才看得见）
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
          } catch (e) {
            /* 消息拉取失败不打扰用户，下次再来 */
          }
          try {
            const f = await api(auth.server, '/api/friends', { token: auth.token })
            if (!alive) return
            const list = f.friends || []
            const glist = f.groups || []
            const key =
              list.map((x) => x.id + ':' + (x.displayName || '') + ':' + (x.avatar || '')).join('|') +
              '§' +
              glist
                .map((g) => g.id + ':' + g.name + ':' + (g.avatar || '') + ':' + (g.members || []).length)
                .join('|')
            if (key !== friendsKeyRef.current) {
              friendsKeyRef.current = key
              setFriends(list)
              setGroups(glist)
              if (!activeRef.current && list.length) setActive(list[0].id)
            }
          } catch (e) {
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

      // 新消息贴底；切回社交面板时列表可能是隐藏的（高度 0），
      // 所以除了立即贴底，还要在布局稳定后和高度变化时再贴一次
      useEffect(() => {
        const el = listRef.current
        if (!el) return
        const toBottom = () => {
          el.scrollTop = el.scrollHeight
        }
        toBottom()
        const t1 = window.setTimeout(toBottom, 50)
        const t2 = window.setTimeout(toBottom, 260)
        let ro = null
        if (typeof ResizeObserver !== 'undefined') {
          ro = new ResizeObserver(() => {
            if (el.scrollHeight > el.clientHeight) toBottom()
          })
          ro.observe(el)
        }
        return () => {
          window.clearTimeout(t1)
          window.clearTimeout(t2)
          if (ro) ro.disconnect()
        }
      }, [active, messages.length])

      // 顶栏和输入框是绝对定位钉住的；给整个主体让出位置，
      // 这样侧栏顶部那排（对方 ID / 添加 / 建群）不会被顶栏盖住
      useEffect(() => {
        const measure = () => {
          const chat = chatRef.current
          const head = headRef.current
          const comp = composerRef.current
          if (chat) {
            chat.style.paddingTop = (head ? head.offsetHeight : 0) + 'px'
            chat.style.paddingBottom = (comp ? comp.offsetHeight : 0) + 'px'
          }
        }
        measure()
        const timers = [80, 350].map((d) => window.setTimeout(measure, d))
        window.addEventListener('resize', measure)
        let ro = null
        if (typeof ResizeObserver !== 'undefined') {
          ro = new ResizeObserver(() => measure())
          if (headRef.current) ro.observe(headRef.current)
          if (composerRef.current) ro.observe(composerRef.current)
        }
        return () => {
          for (const t of timers) window.clearTimeout(t)
          window.removeEventListener('resize', measure)
          if (ro) ro.disconnect()
        }
      }, [active])

      /** 右键菜单：打开 / 不显示该聊天 / 恢复显示 */
      const showConvMenu = (x, y, conv) => {
        const old = document.getElementById('dsh-conv-menu')
        if (old) old.remove()
        const menu = document.createElement('div')
        menu.id = 'dsh-conv-menu'
        menu.style.cssText = [
          'position:fixed',
          'left:' + Math.min(x, window.innerWidth - 170) + 'px',
          'top:' + Math.min(y, window.innerHeight - 90) + 'px',
          'z-index:2147483647',
          'min-width:150px',
          'padding:6px',
          'border-radius:10px',
          'background:rgba(28,30,34,.96)',
          'border:1px solid rgba(255,255,255,.14)',
          'box-shadow:0 14px 34px rgba(0,0,0,.35)',
          'display:flex',
          'flex-direction:column',
          'gap:2px',
        ].join(';')

        let closed = false
        const close = () => {
          if (closed) return
          closed = true
          menu.remove()
          document.removeEventListener('mousedown', onDown, true)
        }
        // 点菜单外面才关；点菜单里的项交给按钮自己处理
        const onDown = (ev) => {
          if (!menu.contains(ev.target)) close()
        }

        const mk = (label, fn, danger) => {
          const b = document.createElement('button')
          b.textContent = label
          b.style.cssText =
            'text-align:left;padding:7px 10px;border-radius:7px;border:none;background:transparent;color:' +
            (danger ? '#ffb4c8' : '#e8eaed') +
            ';font:13px system-ui;cursor:pointer'
          b.addEventListener('mouseenter', () => (b.style.background = 'rgba(255,255,255,.1)'))
          b.addEventListener('mouseleave', () => (b.style.background = 'transparent'))
          b.addEventListener('click', () => {
            close()
            fn()
          })
          return b
        }

        menu.appendChild(
          mk('打开聊天', () => {
            setSideTab('chats')
            setActive(conv.key)
            if (conv.hidden) hideChat(conv.key, false)
          }),
        )
        if (conv.hidden) {
          menu.appendChild(mk('恢复显示该聊天', () => hideChat(conv.key, false)))
        } else {
          menu.appendChild(mk('不显示该聊天', () => hideChat(conv.key, true), true))
        }
        document.body.appendChild(menu)
        setTimeout(() => {
          if (!closed) document.addEventListener('mousedown', onDown, true)
        }, 0)
      }

      /** 不显示 / 恢复某个会话（只影响列表，好友关系不动） */
      const hideChat = async (key, hidden) => {
        try {
          // 先本地生效，界面立刻反应；失败再回滚
          if (hidden) setHiddenChats((prev) => (prev.indexOf(key) >= 0 ? prev : prev.concat(key)))
          else setHiddenChats((prev) => prev.filter((x) => x !== key))
          if (hidden && activeRef.current === key) setActive(null)
          const r = await api(auth.server, '/api/hidden', {
            method: 'POST',
            token: auth.token,
            body: { key, hidden },
          })
          setHiddenChats(Array.isArray(r.hidden) ? r.hidden : [])
        } catch (e) {
          setErr(friendly(e))
        }
      }

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
          let out = text
          if (askMode) {
            // 先用 DSH 的模型回答，再把回答发给对方
            const res = await fetch('/api/share-chat/ask', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ prompt: text }),
            })
            const j = await res.json().catch(() => null)
            if (!res.ok || !j || !j.text) {
              setErr('模型没答上来：' + ((j && (j.detail || j.error)) || res.status))
              return
            }
            out = j.text
          }
          await api(auth.server, '/api/messages', {
            method: 'POST',
            token: auth.token,
            body: { to: active, text: out },
          })
          setDraft('')
          await pull()
        } catch (e) {
          setErr(friendly(e))
        } finally {
          setSending(false)
        }
      }

      /** 选中的文件：先上传，再发一条 image / file 消息 */
      const uploadAndSend = async (file) => {
        if (!active || !file) return
        const pid = 'p' + Date.now() + Math.random().toString(36).slice(2, 6)
        const mark = (patch) =>
          setPending((prev) => prev.map((x) => (x.id === pid ? Object.assign({}, x, patch) : x)))
        setPending((prev) =>
          prev.concat({
            id: pid,
            name: file.name || '附件',
            type: file.type || '',
            size: file.size || 0,
            status: 'uploading',
            error: '',
          }),
        )
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
          } catch (e) {
            /* 非 JSON */
          }
          if (!res.ok || !up) {
            const why = up && up.error === 'too-large' ? '文件太大（服务器上限 50 MB）' : '上传失败'
            mark({ status: 'failed', error: why })
            setErr(why + '：' + (file.name || ''))
            return
          }
          const isImage = String(file.type || '').startsWith('image/')
          await api(auth.server, '/api/messages', {
            method: 'POST',
            token: auth.token,
            body: isImage ? { to: active, image: { uploadId: up.id } } : { to: active, file: { uploadId: up.id } },
          })
          setPending((prev) => prev.filter((x) => x.id !== pid))
          await pull()
        } catch (e) {
          mark({ status: 'failed', error: friendly(e) })
          setErr(friendly(e))
        } finally {
          setUploading(false)
        }
      }

      const keyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          send()
        }
      }

      /* 好友列表里的「最后一条」摘要 */
      /* ---------- 聊天背景（按会话，存本地） ---------- */
      const bgOf = (key) => (key && bgMap[key]) || null
      const setBgFor = (key, bg) => {
        if (!key) return
        setBgMap((prev) => {
          const next = Object.assign({}, prev)
          if (bg) next[key] = bg
          else delete next[key]
          writeJson(BG_KEY, next)
          return next
        })
        // 同步到账号上，换设备也跟着走
        api(auth.server, '/api/bg', {
          method: 'POST',
          token: auth.token,
          body: { key, bg: bg || null },
        }).catch(() => setErr('背景同步失败，仅本机生效'))
      }
      const bgStyle = (bg) => {
        if (!bg) return {}
        if (bg.type === 'color') return { background: bg.v }
        if (bg.type === 'grad') return { backgroundImage: bg.v }
        if (bg.type === 'image') {
          return {
            backgroundImage: 'url(' + auth.server + bg.v + ')',
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }
        }
        return {}
      }
      /** 侧栏卡片：背景铺满 + 左侧白色蒙版，保证名字和摘要读得清 */
      const cardStyle = (bg, isActive) => {
        const active = isActive
          ? { boxShadow: 'inset 0 0 0 2px var(--dsw-alias-brand-primary,#5aa9e6)' }
          : {}
        if (!bg) return active
        const layer =
          bg.type === 'color'
            ? 'linear-gradient(' + bg.v + ',' + bg.v + ')'
            : bg.type === 'grad'
              ? bg.v
              : 'url(' + auth.server + bg.v + ')'
        return Object.assign(
          {
            backgroundImage:
              'linear-gradient(90deg, rgba(255,255,255,.78), rgba(255,255,255,.28))' + ',' + layer,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            overflow: 'hidden',
          },
          active,
        )
      }

      const bgThumb = (bg, size) => {
        if (!bg) return null
        const s = size || 18
        const st = {
          width: s + 'px',
          height: s + 'px',
          borderRadius: '5px',
          flex: '0 0 auto',
          border: '1px solid rgba(128,128,128,.35)',
          display: 'block',
        }
        if (bg.type === 'color') st.background = bg.v
        else if (bg.type === 'grad') st.backgroundImage = bg.v
        else if (bg.type === 'image') {
          st.backgroundImage = 'url(' + auth.server + bg.v + ')'
          st.backgroundSize = 'cover'
          st.backgroundPosition = 'center'
        }
        return h('span', { style: st, title: '聊天背景' })
      }
      const uploadBg = (file) => {
        if (!file || !active) return
        const key = active
        file
          .arrayBuffer()
          .then((buf) =>
            fetch(auth.server + '/api/upload', {
              method: 'POST',
              headers: {
                authorization: 'Bearer ' + auth.token,
                'content-type': file.type || 'application/octet-stream',
                'x-filename': encodeURIComponent(file.name || 'bg'),
              },
              body: buf,
            }),
          )
          .then((r) => r.json())
          .then((up) => {
            if (up && up.id) {
              setBgFor(key, { type: 'image', v: '/f/' + up.id })
              setBgOpen(false)
            } else {
              setErr('背景上传失败')
            }
          })
          .catch(() => setErr('背景上传失败'))
      }

      /** 建群 / 拉人共用同一个内联输入框（Electron 没有 window.prompt） */
      const submitInline = async () => {
        const it = inline
        if (!it) return
        const v = String(it.value || '').trim()
        if (!v) return
        setErr('')
        try {
          if (it.mode === 'group') {
            const r = await api(auth.server, '/api/groups', {
              method: 'POST',
              token: auth.token,
              body: { name: v },
            })
            await loadFriends()
            setActive('g:' + r.group.id)
            cursorRef.current = 0
            setMessages([])
          } else if (it.mode === 'member') {
            if (!active || active.indexOf('g:') !== 0) return
            await api(auth.server, '/api/groups/' + active.slice(2) + '/members', {
              method: 'POST',
              token: auth.token,
              body: { id: v },
            })
            await loadFriends()
          }
          setInline(null)
        } catch (e) {
          setErr(friendly(e))
        }
      }

      const avatarInputRef = useRef(null)
      const uploadAvatar = async (file) => {
        if (!file) return
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
            up = null
          }
          if (!res.ok || !up) {
            setErr('头像上传失败')
            return
          }
          await api(auth.server, '/api/avatar', {
            method: 'POST',
            token: auth.token,
            body: { uploadId: up.id },
          })
          setMyAvatar(up.id)
        } catch (e) {
          setErr(friendly(e))
        }
      }

      const lastOf = (fid) => {
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i]
          if (m.from === fid || m.to === fid) return m
        }
        return null
      }
      const previewOf = (m) => {
        if (!m) return ''
        const b = m.body || {}
        if (b.kind === 'snapshot') return '🐟 对话快照'
        if (b.kind === 'image') return '🖼 图片'
        if (b.kind === 'file') return '📎 ' + (b.name || '文件')
        return String(b.text || '')
      }

      /** 会话 = 好友 + 群，统一成一种形状给侧栏和标题用 */
      const convs = [
        ...friends.map((f) => ({
          kind: 'dm',
          key: f.id,
          title: f.displayName || f.id,
          avatar: f.avatar || '',
          members: [],
          hidden: hiddenChats.indexOf(f.id) >= 0,
        })),
        ...groups.map((g) => ({
          kind: 'group',
          key: 'g:' + g.id,
          title: g.name,
          avatar: g.avatar || '',
          members: g.members || [],
          hidden: hiddenChats.indexOf('g:' + g.id) >= 0,
        })),
      ]
      const shownConvs = sideTab === 'contacts' ? convs : convs.filter((c) => !c.hidden)
      const current = convs.find((c) => c.key === active) || null
      const isGroup = !!(current && current.kind === 'group')
      const nameOf = (id) => {
        const mem = current && (current.members || []).find((x) => x.id === id)
        if (mem) return mem.displayName || id
        const dm = convs.find((c) => c.kind === 'dm' && c.key === id)
        return dm ? dm.title : id
      }
      const avatarOfSender = (id) => {
        const mem = current && (current.members || []).find((x) => x.id === id)
        if (mem) return mem.avatar || ''
        const dm = convs.find((c) => c.kind === 'dm' && c.key === id)
        return dm ? dm.avatar || '' : ''
      }

      const thread = messages.filter((m) => m.from === active || m.to === active)

      /** 正在上传 / 上传失败的附件，先占位显示，避免「点了没反应」 */
      const renderPending = (p) => {
        const failed = p.status === 'failed'
        return h(
          'div',
          { key: p.id, className: 'sc-msg mine' },
          h(
            'div',
            {
              className: 'sc-file',
              style: failed ? { borderColor: '#d9534f' } : { opacity: 0.7 },
            },
            h('span', { className: 'sc-file-ico' }, failed ? '⚠️' : fileIcon(p.type, p.name)),
            h(
              'span',
              { className: 'sc-file-main' },
              h('span', { className: 'sc-file-name' }, p.name),
              h(
                'span',
                { className: 'sc-file-size' },
                failed ? '失败：' + (p.error || '上传出错') : '上传中…  ' + kbText(p.size),
              ),
            ),
          ),
        )
      }

      const renderMessage = (m) => {
        const b = m.body || {}
        const kind = b.kind || 'text'
        const mine = m.from === auth.id
        let content
        if (kind === 'snapshot') {
          content = h(SnapshotCard, { snapshotId: b.snapshotId, auth })
        } else if (kind === 'image') {
          const src = auth.server + b.url
          content = h(
            'a',
            { href: src + '?download=1', target: '_blank', rel: 'noreferrer', title: '点开保存' },
            h('img', { className: 'sc-msg-img', src, alt: b.caption || '图片' }),
          )
        } else if (kind === 'file') {
          const t = String(b.type || '')
          const src = auth.server + b.url
          if (t.startsWith('image/')) {
            content = h(
              'a',
              { href: src + '?download=1', target: '_blank', rel: 'noreferrer', title: '点开保存' },
              h('img', { className: 'sc-msg-img', src, alt: b.name || '图片' }),
            )
          } else if (t.startsWith('video/')) {
            content = h('video', { src, controls: true, style: MEDIA_STYLE })
          } else if (t.startsWith('audio/')) {
            content = h('audio', { src, controls: true, style: { maxWidth: '100%' } })
          } else {
            content = h(
              'a',
              {
                className: 'sc-file',
                href: src + '?download=1',
                target: '_blank',
                rel: 'noreferrer',
                download: b.name || undefined,
              },
              h('span', { className: 'sc-file-ico' }, fileIcon(t, b.name)),
              h(
                'span',
                { className: 'sc-file-main' },
                h('span', { className: 'sc-file-name' }, b.name || '附件'),
                h(
                  'span',
                  { className: 'sc-file-size' },
                  (b.type || '未知类型') + ' · ' + kbText(b.size) + ' · 点击下载',
                ),
              ),
            )
          }
        } else {
          content = h('div', { className: 'sc-bubble' }, String(b.text || ''))
        }
        return h(
          'div',
          { key: m.seq, className: 'sc-msg-row' + (mine ? ' mine' : '') },
          avatar(
            mine ? auth.displayName || auth.id : nameOf(m.from),
            mine ? auth.id : m.from,
            32,
            mine ? myAvatar : avatarOfSender(m.from),
          ),
          h(
            'div',
            { className: 'sc-msg' + (mine ? ' mine' : '') },
            isGroup && !mine
              ? h('div', { className: 'sc-time', style: { marginBottom: '2px' } }, nameOf(m.from))
              : null,
            content,
            h('div', { className: 'sc-time' }, clockText(m.at)),
          ),
        )
      }

      /** 通讯录页：右侧内容区整块变成好友列表 */
      const contactsPane =
        sideTab === 'contacts'
          ? h(
              'div',
              { className: 'sc-contacts' },
              h('div', { className: 'sc-side-title', style: { padding: '14px 16px 6px' } }, '通讯录'),
              h(
                'div',
                { style: { flex: 1, minHeight: 0, overflow: 'auto', padding: '0 12px 12px' } },
                convs.length === 0
                  ? emptyState('👥', '通讯录是空的', '在左边输入对方 ID 加好友，或者建一个群')
                  : convs.map((c) =>
                      h(
                        'div',
                        {
                          key: 'ct-' + c.key,
                          className: 'sc-friend',
                          title: c.key,
                          onClick: () => {
                            setActive(c.key)
                            setSideTab('chats')
                            if (c.hidden) hideChat(c.key, false)
                          },
                          onContextMenu: (e) => {
                            e.preventDefault()
                            showConvMenu(e.clientX, e.clientY, c)
                          },
                        },
                        c.kind === 'group'
                          ? avatar(c.title, c.key, 34, c.avatar, true)
                          : avatar(c.title, c.key, 34, c.avatar),
                        h(
                          'div',
                          { className: 'sc-friend-main' },
                          h('div', { className: 'sc-friend-name' }, c.title),
                          h(
                            'div',
                            { className: 'sc-friend-last' },
                            c.kind === 'group' ? c.members.length + ' 人' : '@' + c.key,
                          ),
                        ),
                        c.hidden ? h('span', { className: 'sc-chip' }, '已隐藏') : null,
                      ),
                    ),
              ),
            )
          : null

      return h(
        'div',
        { className: 'sc-chat', ref: chatRef },
        /* 顶栏 */
        h(
          'div',
          { className: 'sc-chat-head', ref: headRef },
          avatar(auth.displayName || auth.id, auth.id, 30, myAvatar),
          h(
            'div',
            { style: { minWidth: 0 } },
            h('div', { className: 'sc-chat-name' }, '@' + (auth.displayName || auth.id)),
            h('div', { className: 'sc-chat-sub' }, auth.server.replace(/^https?:\/\//, '')),
          ),
          h('span', { className: 'sc-grow' }),
          err
            ? h(
                'span',
                {
                  className: 'sc-err',
                  style: { maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                },
                err,
              )
            : null,
          h(
            'button',
            {
              className: 'sc-btn' + (sideTab === 'chats' ? ' sc-btn-primary' : ''),
              onClick: () => setSideTab('chats'),
              title: '会话列表',
            },
            '💬 会话',
          ),
          h(
            'button',
            {
              className: 'sc-btn' + (sideTab === 'contacts' ? ' sc-btn-primary' : ''),
              onClick: () => setSideTab('contacts'),
              title: '通讯录',
            },
            '👥 通讯录',
          ),
          h(
            'button',
            {
              className: 'sc-btn' + (campMode ? ' sc-btn-primary' : ''),
              onClick: () => setCampMode((v) => !v),
              title: '串门：看看好友的营地',
            },
            campMode ? '💬 会话' : '🏕 串门',
          ),
          h(
            'button',
            {
              className: 'sc-btn',
              onClick: () => openMeeting({ auth, onToast: (m) => setErr(m) }),
              title: '音视频会议（点对点，无时长限制）',
            },
            '📹 开会',
          ),
          h('button', { className: 'sc-btn', onClick: props.onOpenGame, title: '玩一把鱼塘钓鱼' }, '🎮 钓鱼'),
          h(
            'button',
            {
              className: 'sc-btn',
              onClick: () => openKtv({ auth, onToast: (m) => setErr(m), target: active }),
              title: '一起唱歌：同步伴奏 + 语音',
            },
            '🎤 KTV',
          ),
          h(
            'button',
            {
              className: 'sc-btn',
              onClick: () => {
                try {
                  window.dispatchEvent(new CustomEvent('dsh-share-chat:pet-show'))
                } catch (e) {}
              },
              title: '叫出桌宠（形象独立浮在界面上）',
            },
            '🐳',
          ),
          h(
            'button',
            {
              className: 'sc-btn',
              onClick: () => openMahjong({ auth, onToast: (m) => setErr(m) }),
              title: '开一桌麻将（缺的位置机器人补）',
            },
            '🀄 麻将',
          ),
          h(
            'button',
            {
              className: 'sc-btn',
              onClick: () => openKiller({ auth, onToast: (m) => setErr(m) }),
              title: '每日杀手数独',
            },
            '🧩 数独',
          ),
          h('button', { className: 'sc-btn sc-btn-ghost', onClick: props.onLogout }, '退出'),
        ),
        /* 主体 */
        campMode
          ? h(CampPanel, { auth })
          : h(
          'div',
          { className: 'sc-chat-body' },
          h(
            'div',
            { className: 'sc-side', style: sideTab === 'contacts' ? { display: 'none' } : undefined },
            h('div', { className: 'sc-side-title' }, '会话'),
            h(
              'div',
              { className: 'sc-add' },
              h('input', {
                className: 'sc-input',
                placeholder: '对方 ID',
                value: newFriend,
                onChange: (e) => setNewFriend(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') addFriend()
                },
              }),
              h('button', { className: 'sc-btn sc-btn-sm', onClick: addFriend }, '添加'),
              h(
                'button',
                {
                  className: 'sc-btn sc-btn-sm',
                  onClick: () => setInline({ mode: 'group', value: '' }),
                  title: '建一个群',
                },
                '建群',
              ),
            ),
            inline
              ? h(
                  'div',
                  { className: 'sc-add' },
                  h('input', {
                    className: 'sc-input',
                    autoFocus: true,
                    placeholder: inline.mode === 'group' ? '群名' : '对方 ID',
                    value: inline.value,
                    onChange: (e) => setInline({ mode: inline.mode, value: e.target.value }),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter') submitInline()
                      if (e.key === 'Escape') setInline(null)
                    },
                  }),
                  h(
                    'button',
                    { className: 'sc-btn sc-btn-sm', onClick: submitInline },
                    inline.mode === 'group' ? '创建' : '拉入',
                  ),
                  h(
                    'button',
                    {
                      className: 'sc-btn sc-btn-sm sc-btn-ghost',
                      onClick: () => setInline(null),
                    },
                    '取消',
                  ),
                )
              : null,
            h(
              'div',
              { className: 'sc-friends' },
              shownConvs.length === 0
                ? emptyState(
                    '👥',
                    sideTab === 'contacts' ? '通讯录是空的' : '没有显示的会话',
                    sideTab === 'contacts' ? '在上面加好友，或者点「建群」' : '被隐起来的会话在「通讯录」里',
                  )
                : shownConvs.map((c) =>
                    h(
                      'div',
                      {
                        key: c.key,
                        className: 'sc-friend' + (active === c.key ? ' on' : ''),
                        onClick: () => {
                          setActive(c.key)
                          setSideTab('chats')
                          if (c.hidden) hideChat(c.key, false)
                        },
                        onContextMenu: (e) => {
                          e.preventDefault()
                          showConvMenu(e.clientX, e.clientY, c)
                        },
                        title: c.key,
                        // 会话卡片直接用这个会话的聊天背景铺满
                        style: cardStyle(bgOf(c.key), active === c.key),
                      },
                      c.kind === 'group'
                        ? avatar(c.title, c.key, 30, c.avatar, true)
                        : avatar(c.title, c.key, 30, c.avatar),
                      h(
                        'div',
                        { className: 'sc-friend-main' },
                        h(
                          'div',
                          { className: 'sc-friend-name' },
                          c.title + (c.kind === 'group' ? '  (' + c.members.length + ')' : ''),
                        ),
                        h('div', { className: 'sc-friend-last' }, previewOf(lastOf(c.key)) || '还没有消息'),
                      ),
                    ),
                  ),
            ),
          ),
          h(
            'div',
            { className: 'sc-main' },
            sideTab === 'contacts' ? contactsPane : null,
            current
              ? h(
                  'div',
                  { style: { flex: '0 0 auto' } },
                  h(
                    'div',
                    {
                      className: 'sc-side-title',
                      style: { display: 'flex', alignItems: 'center', gap: '8px' },
                    },
                    h('span', null, current.title + (isGroup ? '  ·  ' + current.members.length + ' 人' : '')),
                    h('span', { className: 'sc-grow' }),
                    isGroup
                      ? h(
                          'button',
                          {
                            className: 'sc-btn sc-btn-sm',
                            onClick: () => setInline({ mode: 'member', value: '' }),
                            title: '拉人进群',
                          },
                          '＋人',
                        )
                      : null,
                    h(
                      'button',
                      {
                        className: 'sc-btn sc-btn-sm' + (bgOpen ? ' sc-btn-primary' : ''),
                        onClick: () => setBgOpen((v) => !v),
                        title: '换这个会话的聊天背景',
                      },
                      '🖼',
                    ),
                  ),
                  bgOpen
                    ? h(
                        'div',
                        {
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            flexWrap: 'wrap',
                            gap: '6px',
                            padding: '4px 14px 8px',
                          },
                        },
                        BG_COLORS.map((c) =>
                          h('span', {
                            key: c,
                            title: c,
                            onClick: () => setBgFor(active, { type: 'color', v: c }),
                            style: {
                              width: '20px',
                              height: '20px',
                              borderRadius: '5px',
                              cursor: 'pointer',
                              background: c,
                              border: '1px solid rgba(128,128,128,.35)',
                            },
                          }),
                        ),
                        BG_GRADS.map((g) =>
                          h('span', {
                            key: g,
                            title: '渐变',
                            onClick: () => setBgFor(active, { type: 'grad', v: g }),
                            style: {
                              width: '20px',
                              height: '20px',
                              borderRadius: '5px',
                              cursor: 'pointer',
                              backgroundImage: g,
                              border: '1px solid rgba(128,128,128,.35)',
                            },
                          }),
                        ),
                        h(
                          'button',
                          {
                            className: 'sc-btn sc-btn-sm',
                            onClick: () => {
                              const inp = document.createElement('input')
                              inp.type = 'file'
                              inp.accept = 'image/*'
                              inp.addEventListener('change', () => {
                                const f = inp.files && inp.files[0]
                                if (f) uploadBg(f)
                              })
                              inp.click()
                            },
                          },
                          '上传图片',
                        ),
                        h(
                          'button',
                          {
                            className: 'sc-btn sc-btn-sm sc-btn-ghost',
                            onClick: () => setBgFor(active, null),
                          },
                          '默认',
                        ),
                      )
                    : null,
                )
              : null,
            h(
              'div',
              { className: 'sc-thread', ref: listRef, style: Object.assign({}, bgStyle(bgOf(active)), sideTab === 'contacts' ? { display: 'none' } : {}) },
              h(
                'div',
                { className: 'sc-thread-inner' },
                !active
                  ? emptyState('💬', '选一个会话开始聊天', '左边是会话列表，点一下就进来')
                  : thread.length === 0 && pending.length === 0
                    ? emptyState('🐟', '还没有消息', '说点什么，或者在上面的「分享这一轮」把对话发过去')
                    : thread.map(renderMessage).concat(pending.map(renderPending)),
              ),
            ),
            h(
              'div',
              { className: 'sc-composer', ref: composerRef, style: sideTab === 'contacts' ? { display: 'none' } : undefined },
              h(
                'div',
                { className: 'sc-composer-inner' },
                emojiOpen
                  ? h(
                      'div',
                      { className: 'sc-emoji' },
                      EMOJIS.map((em) =>
                        h(
                          'button',
                          {
                            key: em,
                            onClick: () => setDraft((d) => d + em),
                          },
                          em,
                        ),
                      ),
                    )
                  : null,
                h(
                  'div',
                  { className: 'sc-composer-box' },
                  h(
                    'button',
                    {
                      className: 'sc-btn sc-btn-ghost sc-icon-btn',
                      title: '表情',
                      onClick: () => setEmojiOpen((v) => !v),
                    },
                    '😀',
                  ),
                  h(
                    'button',
                    {
                      className: 'sc-btn sc-btn-ghost sc-icon-btn',
                      title: '发送图片或文件（任意类型，≤50 MB）',
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
                  h(
                    'button',
                    {
                      className:
                        'sc-btn ' + (askMode ? 'sc-btn-primary' : 'sc-btn-ghost') + ' sc-icon-btn',
                      title: askMode
                        ? '问模型已开：发出去的是模型的回答'
                        : '打开后，你发的内容会先问模型，再把它的回答发出去',
                      onClick: () => setAskMode((v) => !v),
                    },
                    askMode ? '🔮 问模型' : '🔮',
                  ),
                  h('textarea', {
                    className: 'sc-textarea',
                    placeholder: active ? 'Enter 发送，Shift+Enter 换行' : '先选一个好友',
                    value: draft,
                    disabled: !active,
                    onChange: (e) => setDraft(e.target.value),
                    onKeyDown: keyDown,
                  }),
                  h(
                    'button',
                    {
                      className: 'sc-btn sc-btn-primary sc-send',
                      disabled: !active || sending || !draft.trim(),
                      onClick: send,
                    },
                    sending ? '发送中' : '发送',
                  ),
                ),
              ),
            ),
          ),
        ),
      )
    }

    // ───────────────────────── 小游戏 ─────────────────────────

    /** 小游戏窗口尺寸：本机显示偏好，存浏览器本地，不进 profile 配置 */
    const K_GAME_SIZE = 'dsh-share-chat.game.size'
    const GAME_MIN = { w: 300, h: 420 }
    const GAME_DEFAULT = { w: 390, h: 760 }
    const GAME_PRESETS = [
      { label: '手机竖屏', w: 390, h: 760 },
      { label: '小窗', w: 340, h: 600 },
      { label: '大窗', w: 480, h: 900 },
    ]
    const GAME_SIZE_EVENT = 'dsh-share-chat:game-size'

    function clampGameSize(size) {
      const vw = typeof window === 'undefined' ? 1280 : window.innerWidth
      const vh = typeof window === 'undefined' ? 900 : window.innerHeight
      const w = Number(size && size.w) || GAME_DEFAULT.w
      const h = Number(size && size.h) || GAME_DEFAULT.h
      return {
        w: Math.round(Math.min(Math.max(w, GAME_MIN.w), Math.max(GAME_MIN.w, vw - 32))),
        h: Math.round(Math.min(Math.max(h, GAME_MIN.h), Math.max(GAME_MIN.h, vh - 96))),
      }
    }
    function readGameSize() {
      return clampGameSize(readJson(K_GAME_SIZE) || GAME_DEFAULT)
    }
    function writeGameSize(size) {
      const next = clampGameSize(size)
      writeJson(K_GAME_SIZE, next)
      try {
        window.dispatchEvent(new CustomEvent(GAME_SIZE_EVENT, { detail: next }))
      } catch (e) {
        /* 老浏览器没有 CustomEvent 构造器，忽略 */
      }
      return next
    }

    /**
     * 小游戏窗口：用原生 DOM 挂到 document.body 上（不进 React 树、不在插件的容器里），
     * 这样它不会被 DSH 面板的 stacking context / overflow 裁切，也不会被别的层抢走点击。
     * 可拖标题栏移动、拉右下角改大小；默认尺寸来自 设置 → 社交小游戏。
     */
    function GameWindow(props) {
      const onClose = props.onClose

      useEffect(() => {
        let size = readGameSize()
        const vw = () => window.innerWidth
        const vh = () => window.innerHeight
        const place = (s) => ({ x: Math.max(8, vw() - s.w - 16), y: Math.max(8, vh() - s.h - 16) })
        let pos = place(size)
        let scene = ''
        let tap = null

        const root = document.createElement('div')
        root.style.cssText = [
          'position:fixed',
          'display:flex',
          'flex-direction:column',
          'background:#0b1d24',
          'border:1px solid rgba(128,128,128,.45)',
          'border-radius:12px',
          'overflow:hidden',
          'box-shadow:0 18px 48px rgba(0,0,0,.45)',
          'z-index:2147483647',
        ].join(';')

        const head = document.createElement('div')
        head.title = '拖动窗口'
        head.style.cssText = [
          'display:flex',
          'align-items:center',
          'gap:8px',
          'padding:7px 10px',
          'border-bottom:1px solid rgba(128,128,128,.28)',
          'background:rgba(0,0,0,.25)',
          'color:#eaf3f6',
          'flex:0 0 auto',
          'cursor:move',
          'user-select:none',
          'font:12px/1.4 -apple-system,Segoe UI,Microsoft YaHei,sans-serif',
        ].join(';')

        const title = document.createElement('strong')
        title.textContent = '鱼塘钓鱼'
        title.style.cssText = 'font-size:12.5px'

        const meta = document.createElement('span')
        meta.style.cssText = 'opacity:.55;font-size:11px'

        const tapInfo = document.createElement('span')
        tapInfo.title = '最近一次点击：页面坐标 → 游戏命中区域（空表示没命中）'
        tapInfo.style.cssText = 'opacity:.7;font-size:10.5px;font-family:ui-monospace,Consolas,monospace'

        const spacer = document.createElement('span')
        spacer.style.cssText = 'flex:1'

        const openLink = document.createElement('a')
        openLink.href = GAME_URL
        openLink.target = '_blank'
        openLink.rel = 'noreferrer'
        openLink.textContent = '新窗口'
        openLink.style.cssText = 'color:inherit;font-size:11px;opacity:.7'

        const closeBtn = document.createElement('button')
        closeBtn.textContent = '关闭'
        closeBtn.style.cssText =
          'padding:3px 9px;font-size:11px;border-radius:8px;border:1px solid rgba(255,255,255,.3);background:transparent;color:#eaf3f6;cursor:pointer'

        head.append(title, meta, tapInfo, spacer, openLink, closeBtn)

        const bodyBox = document.createElement('div')
        bodyBox.style.cssText = 'position:relative;flex:1;min-height:0'

        const frame = document.createElement('iframe')
        frame.src = GAME_URL
        frame.title = '鱼塘钓鱼'
        frame.setAttribute('allow', 'autoplay; clipboard-write')
        frame.style.cssText =
          'position:absolute;inset:0;width:100%;height:100%;border:0;background:#0b1d24'
        bodyBox.appendChild(frame)

        const grip = document.createElement('div')
        grip.title = '拖动调整窗口大小（也可以在 设置 → 社交小游戏 里改默认值）'
        grip.style.cssText =
          'position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 50%,rgba(255,255,255,.35) 50%)'

        root.append(head, bodyBox, grip)
        document.body.appendChild(root)

        const paint = () => {
          root.style.left = pos.x + 'px'
          root.style.top = pos.y + 'px'
          root.style.width = size.w + 'px'
          root.style.height = size.h + 'px'
          meta.textContent = (scene ? scene + ' · ' : '') + size.w + '×' + size.h
          tapInfo.textContent = tap ? tap.x + ',' + tap.y + ' → ' + (tap.hit || '空') : ''
        }
        paint()

        closeBtn.addEventListener('click', () => onClose())

        /* 拖标题栏移动 */
        head.addEventListener('pointerdown', (e) => {
          if (e.target && e.target.closest && e.target.closest('button,a')) return
          if (e.button !== 0) return
          e.preventDefault()
          const start = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y }
          const move = (ev) => {
            pos = {
              x: Math.min(Math.max(4, start.x + ev.clientX - start.px), Math.max(4, vw() - size.w - 4)),
              y: Math.min(Math.max(4, start.y + ev.clientY - start.py), Math.max(4, vh() - size.h - 4)),
            }
            paint()
          }
          const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
        })

        /* 拉右下角改大小 */
        grip.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return
          e.preventDefault()
          e.stopPropagation()
          const start = { px: e.clientX, py: e.clientY, w: size.w, h: size.h }
          const move = (ev) => {
            size = clampGameSize({
              w: start.w + ev.clientX - start.px,
              h: start.h + ev.clientY - start.py,
            })
            paint()
          }
          const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            writeGameSize(size)
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
        })

        /* 游戏回传的场景 / 点击诊断 */
        const onMessage = (e) => {
          const d = e && e.data
          if (!d || d.source !== 'fishgame') return
          if (d.type === 'scene') {
            scene = d.scene || ''
            paint()
          } else if (d.type === 'tap') {
            tap = d
            paint()
          }
        }

        /* 设置页改尺寸 / 页面窗口变化 */
        const onSizeEvent = (e) => {
          size = clampGameSize((e && e.detail) || readGameSize())
          pos = place(size)
          paint()
        }
        const onWinResize = () => {
          size = clampGameSize(size)
          pos = {
            x: Math.min(pos.x, Math.max(4, vw() - size.w - 4)),
            y: Math.min(pos.y, Math.max(4, vh() - size.h - 4)),
          }
          paint()
        }
        const onKey = (e) => {
          if (e.key === 'Escape') onClose()
        }

        window.addEventListener('message', onMessage)
        window.addEventListener(GAME_SIZE_EVENT, onSizeEvent)
        window.addEventListener('storage', onSizeEvent)
        window.addEventListener('resize', onWinResize)
        window.addEventListener('keydown', onKey)

        return () => {
          window.removeEventListener('message', onMessage)
          window.removeEventListener(GAME_SIZE_EVENT, onSizeEvent)
          window.removeEventListener('storage', onSizeEvent)
          window.removeEventListener('resize', onWinResize)
          window.removeEventListener('keydown', onKey)
          if (root.parentNode) root.parentNode.removeChild(root)
        }
      }, [])

      return null
    }

    /** 设置 → 社交小游戏：改窗口大小（写 localStorage，已打开的窗口立即跟着变） */
    function GameSettingsSection() {
      const [size, setSize] = useState(() => readGameSize())
      const [wIn, setWIn] = useState(() => String(readGameSize().w))
      const [hIn, setHIn] = useState(() => String(readGameSize().h))
      const [note, setNote] = useState('')

      const apply = (next) => {
        const saved = writeGameSize(next)
        setSize(saved)
        setWIn(String(saved.w))
        setHIn(String(saved.h))
        setNote('已保存 ' + saved.w + ' × ' + saved.h)
      }

      const isPreset = (p) => {
        const c = clampGameSize(p)
        return size.w === c.w && size.h === c.h
      }

      return h(
        'div',
        { className: 'sc-set' },
        h('div', null,
          h('div', { className: 'sc-set-title' }, '社交小游戏'),
          h(
            'div',
            { className: 'sc-set-desc', style: { marginTop: '6px' } },
            '「🎮 钓鱼」打开的窗口大小。窗口可以拖标题栏移动、拖右下角临时改大小；这里设的是默认值，保存在这台电脑的浏览器里。',
          ),
        ),
        h(
          'div',
          { className: 'sc-set-group' },
          h('div', { className: 'sc-set-label' }, '预设尺寸'),
          h(
            'div',
            { className: 'sc-cards' },
            GAME_PRESETS.map((p) =>
              h(
                'button',
                {
                  key: p.label,
                  className: 'sc-card-btn' + (isPreset(p) ? ' on' : ''),
                  onClick: () => apply(p),
                },
                h('b', null, p.label),
                h('span', null, p.w + ' × ' + p.h),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'sc-set-group' },
          h('div', { className: 'sc-set-label' }, '自定义'),
          h(
            'div',
            { className: 'sc-inline' },
            h('input', {
              className: 'sc-input',
              value: wIn,
              inputMode: 'numeric',
              onChange: (e) => setWIn(e.target.value.replace(/[^0-9]/g, '')),
            }),
            h('span', { className: 'sc-hint' }, '×'),
            h('input', {
              className: 'sc-input',
              value: hIn,
              inputMode: 'numeric',
              onChange: (e) => setHIn(e.target.value.replace(/[^0-9]/g, '')),
            }),
            h('button', { className: 'sc-btn sc-btn-primary sc-btn-sm', onClick: () => apply({ w: Number(wIn), h: Number(hIn) }) }, '保存'),
            h('button', { className: 'sc-btn sc-btn-sm', onClick: () => apply(GAME_DEFAULT) }, '恢复默认'),
            note ? h('span', { className: 'sc-ok' }, note) : null,
          ),
          h('div', { className: 'sc-hint', style: { marginTop: '8px' } }, '最小 300×420；超过页面窗口会自动收进可视范围。'),
        ),
      )
    }

    // ───────────────────────── 串门（营地 P1：只读） ─────────────────────────

    // ───────────────────────── 3D 渲染引擎（WebGL，无依赖） ─────────────────────────

    /**
     * 迷你 3D：球面头部按参数变形 + 平面投影脸部贴图 + 卡通分层光照 + 反向外扩描边。
     * 只画到编辑器的大画布里；小头像仍走 SVG，避免几十个 WebGL 上下文。
     */
    function createFace3D(canvas, getFace, getAngle) {
      const gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false })
      if (!gl) return null

      const K = 0.62, Y0 = 0.02, TEX = 1024
      const px = (x) => (0.5 + x * K) * TEX
      const py = (y) => (0.5 - (y - Y0) * K) * TEX
      const ps = (v) => v * K * TEX

      const mat4 = {
        perspective(fovy, aspect, near, far) {
          const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far)
          return [f / aspect,0,0,0, 0,f,0,0, 0,0,(far + near) * nf,-1, 0,0,2 * far * near * nf,0]
        },
        lookAt(eye, target, up) {
          const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]]
          const dot = (a, b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2]
          const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
          const norm = (v) => { const l = Math.hypot(v[0],v[1],v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l] }
          const z = norm(sub(eye, target)), x = norm(cross(up, z)), y = cross(z, x)
          return [x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0, -dot(x,eye), -dot(y,eye), -dot(z,eye), 1]
        },
        rotY(a) { const c = Math.cos(a), s = Math.sin(a); return [c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1] },
        mul(a, b) {
          const o = new Array(16)
          for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
            let v = 0
            for (let k = 0; k < 4; k++) v += a[k * 4 + j] * b[i * 4 + k]
            o[i * 4 + j] = v
          }
          return o
        },
      }

      function compile(type, src) {
        const sh = gl.createShader(type)
        gl.shaderSource(sh, src); gl.compileShader(sh)
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh))
        return sh
      }
      function program(vs, fs) {
        const p = gl.createProgram()
        gl.attachShader(p, compile(gl.VERTEX_SHADER, vs))
        gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs))
        gl.linkProgram(p)
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p))
        return p
      }

      const TOON_VS = [
        'attribute vec3 aPos; attribute vec3 aNormal; attribute vec2 aUV;',
        'uniform mat4 uMVP; uniform mat4 uModel;',
        'varying vec3 vN; varying vec2 vUV;',
        'void main(){ vN = normalize(mat3(uModel) * aNormal); vUV = aUV; gl_Position = uMVP * vec4(aPos,1.0); }',
      ].join('\n')
      const TOON_FS = [
        'precision mediump float;',
        'varying vec3 vN; varying vec2 vUV;',
        'uniform vec3 uColor; uniform vec3 uRim; uniform vec3 uLight;',
        'uniform sampler2D uTex; uniform float uUseTex;',
        'void main(){',
        '  vec3 n = normalize(vN); vec3 l = normalize(uLight);',
        '  float d = dot(n, l);',
        '  float band = d > 0.55 ? 1.0 : (d > 0.05 ? 0.8 : (d > -0.35 ? 0.62 : 0.48));',
        '  vec3 v = normalize(vec3(0.0,0.15,1.0));',
        '  float rim = pow(1.0 - max(dot(n, v), 0.0), 2.2);',
        '  vec4 tex = texture2D(uTex, vUV);',
        '  vec3 base = mix(uColor, tex.rgb, tex.a * uUseTex);',
        '  gl_FragColor = vec4(base * band + uRim * rim * 0.5, 1.0);',
        '}',
      ].join('\n')
      const OUT_VS = [
        'attribute vec3 aPos; attribute vec3 aNormal;',
        'uniform mat4 uMVP; uniform float uThick;',
        'void main(){ gl_Position = uMVP * vec4(aPos + aNormal * uThick, 1.0); }',
      ].join('\n')
      const OUT_FS = 'precision mediump float; uniform vec3 uColor; void main(){ gl_FragColor = vec4(uColor,1.0); }'

      let progToon, progOut
      try {
        progToon = program(TOON_VS, TOON_FS)
        progOut = program(OUT_VS, OUT_FS)
      } catch (e) {
        return null
      }
      const lt = (p, n) => gl.getUniformLocation(p, n)
      const at = (p, n) => gl.getAttribLocation(p, n)

      function sphere(seg, rings) {
        const pos = [], nrm = [], uv = [], idx = []
        for (let y = 0; y <= rings; y++) {
          const v = y / rings, phi = v * Math.PI
          for (let x = 0; x <= seg; x++) {
            const u = x / seg, th = u * Math.PI * 2
            const sx = Math.sin(phi) * Math.sin(th), sy = Math.cos(phi), sz = Math.sin(phi) * Math.cos(th)
            pos.push(sx, sy, sz); nrm.push(sx, sy, sz); uv.push(0.5 + sx * K, 0.5 - (sy - Y0) * K)
          }
        }
        for (let yy = 0; yy < rings; yy++) for (let xx = 0; xx < seg; xx++) {
          const a = yy * (seg + 1) + xx, b = a + 1, c = a + seg + 1, d = c + 1
          idx.push(a, c, b, b, c, d)
        }
        return { pos, nrm, uv, idx }
      }

      function vbo(mesh) {
        const o = {}
        o.pos = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, o.pos); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mesh.pos), gl.STATIC_DRAW)
        o.nrm = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, o.nrm); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mesh.nrm), gl.STATIC_DRAW)
        o.uvb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, o.uvb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mesh.uv), gl.STATIC_DRAW)
        o.idx = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, o.idx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(mesh.idx), gl.STATIC_DRAW)
        o.count = mesh.idx.length
        return o
      }

      function buildHead(f) {
        const m = sphere(64, 40)
        for (let i = 0; i < m.pos.length; i += 3) {
          let x = m.pos[i], y = m.pos[i + 1], z = m.pos[i + 2]
          const sx = 1 + f.faceWidth * 0.0016
          const jaw = 1 - f.jaw * 0.0022 * (y < 0 ? -y : 0)
          const chin = 1 + f.chin * 0.0012 * (y < -0.3 ? 1 : 0)
          const fore = 1 + f.forehead * 0.0012 * (y > 0.4 ? 1 : 0)
          const cheek = 1 + f.cheek * 0.0012 * (Math.abs(y) < 0.35 ? 1 : 0)
          x *= sx * jaw * cheek
          z *= sx * jaw * cheek * (1 + f.noseLength * 0.0008 * (z > 0.75 ? 1 : 0))
          y *= chin * fore
          if (y > 0.78) y = 0.78 + (y - 0.78) * 0.8
          m.pos[i] = x; m.pos[i + 1] = y; m.pos[i + 2] = z
          const l = Math.hypot(x, y, z) || 1
          m.nrm[i] = x / l; m.nrm[i + 1] = y / l; m.nrm[i + 2] = z / l
          m.uv[i / 3 * 2] = 0.5 + x * K
          m.uv[i / 3 * 2 + 1] = 0.5 - (y - Y0) * K
        }
        return m
      }

      function buildHair() {
        const m = sphere(56, 36)
        const keep = new Uint8Array(m.pos.length / 3)
        for (let i = 0; i < m.pos.length; i += 3) {
          const x = m.pos[i], y = m.pos[i + 1], z = m.pos[i + 2]
          const r = 1.09 + Math.max(0, -y) * 0.05
          m.pos[i] = x * r; m.pos[i + 1] = y * r; m.pos[i + 2] = z * r
          const l = Math.hypot(m.pos[i], m.pos[i + 1], m.pos[i + 2]) || 1
          m.nrm[i] = m.pos[i] / l; m.nrm[i + 1] = m.pos[i + 1] / l; m.nrm[i + 2] = m.pos[i + 2] / l
          const front = z > 0.15
          const hairline = front ? 0.24 + 0.07 * Math.cos(x * 9) - Math.abs(x) * 0.06 : 0.02
          keep[i / 3] = y > hairline || z < -0.25 ? 1 : 0
        }
        const idx = []
        for (let k = 0; k < m.idx.length; k += 3) {
          const a = m.idx[k], b = m.idx[k + 1], c = m.idx[k + 2]
          if (keep[a] && keep[b] && keep[c]) idx.push(a, b, c)
        }
        m.idx = idx
        return m
      }

      function buildFringe() {
        const m = sphere(96, 32)
        const keep = new Uint8Array(m.pos.length / 3)
        for (let i = 0; i < m.pos.length; i += 3) {
          const x = m.pos[i], y = m.pos[i + 1], z = m.pos[i + 2]
          const r = 1.13
          m.pos[i] = x * r; m.pos[i + 1] = y * r; m.pos[i + 2] = z * r
          const l = Math.hypot(m.pos[i], m.pos[i + 1], m.pos[i + 2]) || 1
          m.nrm[i] = m.pos[i] / l; m.nrm[i + 1] = m.pos[i + 1] / l; m.nrm[i + 2] = m.pos[i + 2] / l
          const ang = Math.atan2(x, z)
          const strand = Math.sin(ang * 7 + 0.6)
          keep[i / 3] = z > 0.28 && y < 0.62 && y > 0.16 + Math.abs(x) * 0.04 && strand > -0.2 ? 1 : 0
        }
        const idx = []
        for (let k = 0; k < m.idx.length; k += 3) {
          const a = m.idx[k], b = m.idx[k + 1], c = m.idx[k + 2]
          if (keep[a] && keep[b] && keep[c]) idx.push(a, b, c)
        }
        m.idx = idx
        return m
      }

      function buildPart(scaleX, scaleY, scaleZ, dy, sx, sy) {
        const m = sphere(sx || 24, sy || 18)
        for (let i = 0; i < m.pos.length; i += 3) {
          m.pos[i] *= scaleX
          m.pos[i + 1] = m.pos[i + 1] * scaleY + dy
          m.pos[i + 2] *= scaleZ
          const l = Math.hypot(m.pos[i] / scaleX, (m.pos[i + 1] - dy) / scaleY, m.pos[i + 2] / scaleZ) || 1
          m.nrm[i] = m.pos[i] / scaleX / l
          m.nrm[i + 1] = (m.pos[i + 1] - dy) / scaleY / l
          m.nrm[i + 2] = m.pos[i + 2] / scaleZ / l
        }
        return m
      }

      function sideLock(side) {
        const m = sphere(16, 20)
        for (let i = 0; i < m.pos.length; i += 3) {
          m.pos[i] = m.pos[i] * 0.1 + side * 0.84
          m.pos[i + 1] = m.pos[i + 1] * 0.62 - 0.1
          m.pos[i + 2] = m.pos[i + 2] * 0.12 + 0.42
          const l = Math.hypot((m.pos[i] - side * 0.84) / 0.1, (m.pos[i + 1] + 0.1) / 0.62, (m.pos[i + 2] - 0.42) / 0.12) || 1
          m.nrm[i] = (m.pos[i] - side * 0.84) / 0.1 / l
          m.nrm[i + 1] = (m.pos[i + 1] + 0.1) / 0.62 / l
          m.nrm[i + 2] = (m.pos[i + 2] - 0.42) / 0.12 / l
        }
        return m
      }

      function faceTexture(f) {
        const c = document.createElement('canvas')
        c.width = TEX; c.height = TEX
        const g = c.getContext('2d')
        const hairHex = C_HAIR[f.hairColor % C_HAIR.length]
        const skinHex = F_SKIN[f.skinTone]
        const eyeY = 0 + f.eyeHeight * 0.0006
        const eyeX = 0.24 + f.eyeSpacing * 0.0011
        const erx = 0.115 * (1 + f.eyeSize * 0.005)
        const ery = 0.14 * (1 + f.eyeSize * 0.005)
        const tilt = f.eyeTilt * 0.0018

        const bA = Math.min(1, Math.max(0, f.blush / 100)) * 0.45
        if (bA > 0.01) {
          ;[-1, 1].forEach((sd) => {
            const cx = px(sd * (eyeX + erx * 0.35)), cy = py(eyeY - 0.22), rad = ps(erx * 1.5)
            const grd = g.createRadialGradient(cx, cy, 2, cx, cy, rad)
            grd.addColorStop(0, 'rgba(255,140,155,' + bA + ')')
            grd.addColorStop(1, 'rgba(255,140,155,0)')
            g.fillStyle = grd
            g.beginPath(); g.arc(cx, cy, rad, 0, 7); g.fill()
          })
        }
        ;[-1, 1].forEach((sd) => {
          g.save()
          g.translate(px(sd * eyeX), py(eyeY))
          g.rotate(sd * tilt)
          const rx = ps(erx), ry = ps(ery)
          g.beginPath(); g.ellipse(0, 0, rx, ry, 0, 0, 7); g.fillStyle = '#fbfdff'; g.fill()
          const cg = g.createRadialGradient(-rx * 0.2, -ry * 0.28, rx * 0.1, 0, 0, rx * 1.05)
          cg.addColorStop(0, '#8fb6ff'); cg.addColorStop(0.55, '#4a63b0'); cg.addColorStop(1, '#2b3a72')
          g.beginPath(); g.ellipse(0, ry * 0.06, rx * 0.68, ry * 0.72, 0, 0, 7); g.fillStyle = cg; g.fill()
          g.beginPath(); g.ellipse(0, ry * 0.08, rx * 0.34, ry * 0.4, 0, 0, 7); g.fillStyle = '#151a2c'; g.fill()
          g.beginPath(); g.ellipse(-rx * 0.3, -ry * 0.34, rx * 0.22, ry * 0.18, 0, 0, 7); g.fillStyle = '#ffffff'; g.fill()
          g.beginPath(); g.arc(rx * 0.3, ry * 0.36, rx * 0.12, 0, 7); g.fillStyle = 'rgba(255,255,255,.92)'; g.fill()
          g.beginPath(); g.ellipse(0, 0, rx * 1.02, ry * 1.02, 0, Math.PI * 0.92, Math.PI * 2.08)
          g.strokeStyle = '#232946'; g.lineWidth = rx * 0.3; g.lineCap = 'round'; g.stroke()
          g.restore()
        })
        g.strokeStyle = hairHex
        g.lineWidth = ps(0.022); g.lineCap = 'round'
        ;[-1, 1].forEach((sd) => {
          g.beginPath()
          g.moveTo(px(sd * (eyeX + erx * 1.15)), py(eyeY + 0.2))
          g.quadraticCurveTo(px(sd * eyeX), py(eyeY + 0.26 + f.browArch * 0.0008), px(sd * (eyeX - erx * 1.05)), py(eyeY + 0.19))
          g.stroke()
        })
        g.fillStyle = 'rgba(150,95,80,.45)'
        g.beginPath(); g.ellipse(px(0), py(-0.16), ps(0.012), ps(0.009), 0, 0, 7); g.fill()
        const smile = f.mouthSmile * 0.0016
        g.strokeStyle = '#b8564f'; g.lineWidth = ps(0.02); g.lineCap = 'round'
        g.beginPath()
        g.moveTo(px(-0.08), py(-0.3))
        g.quadraticCurveTo(px(0), py(-0.3 - 0.05 - smile), px(0.08), py(-0.3))
        g.stroke()

        const t = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, t)
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        return t
      }

      let meshes = null
      let tex = null
      let sig = ''

      function rebuild(f) {
        const next = JSON.stringify([f.faceWidth, f.jaw, f.cheek, f.chin, f.forehead, f.noseLength, f.eyeSize, f.eyeSpacing, f.eyeTilt, f.eyeHeight, f.mouthSmile, f.blush, f.hairColor, f.skinTone, f.browArch])
        if (next === sig && meshes) return
        sig = next
        if (meshes) {
          for (const k of Object.keys(meshes)) {
            const m = meshes[k]
            if (m && m.pos) { gl.deleteBuffer(m.pos); gl.deleteBuffer(m.nrm); gl.deleteBuffer(m.uvb); gl.deleteBuffer(m.idx) }
          }
        }
        meshes = {
          head: vbo(buildHead(f)),
          hair: vbo(buildHair(f)),
          fringe: vbo(buildFringe(f)),
          body: vbo(buildPart(1.12, 0.58, 0.78, -1.36)),
          neck: vbo(buildPart(0.26, 0.42, 0.26, -1.06)),
          lockL: vbo(sideLock(-1)),
          lockR: vbo(sideLock(1)),
        }
        if (tex) gl.deleteTexture(tex)
        tex = faceTexture(f)
      }

      function drawMesh(m, prog, attrs) {
        gl.bindBuffer(gl.ARRAY_BUFFER, m.pos); gl.enableVertexAttribArray(attrs.pos); gl.vertexAttribPointer(attrs.pos, 3, gl.FLOAT, false, 0, 0)
        gl.bindBuffer(gl.ARRAY_BUFFER, m.nrm); gl.enableVertexAttribArray(attrs.nrm); gl.vertexAttribPointer(attrs.nrm, 3, gl.FLOAT, false, 0, 0)
        if (attrs.uv >= 0) {
          gl.bindBuffer(gl.ARRAY_BUFFER, m.uvb); gl.enableVertexAttribArray(attrs.uv); gl.vertexAttribPointer(attrs.uv, 2, gl.FLOAT, false, 0, 0)
        }
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.idx)
        gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0)
      }

      const A = {
        pos: at(progToon, 'aPos'), nrm: at(progToon, 'aNormal'), uv: at(progToon, 'aUV'),
        mvp: lt(progToon, 'uMVP'), model: lt(progToon, 'uModel'), color: lt(progToon, 'uColor'),
        rim: lt(progToon, 'uRim'), light: lt(progToon, 'uLight'), tex: lt(progToon, 'uTex'), useTex: lt(progToon, 'uUseTex'),
      }
      const O = {
        pos: at(progOut, 'aPos'), nrm: at(progOut, 'aNormal'), mvp: lt(progOut, 'uMVP'), thick: lt(progOut, 'uThick'), color: lt(progOut, 'uColor'),
      }

      function render() {
        const f = getFace()
        rebuild(f)
        const w = canvas.width, h = canvas.height
        gl.viewport(0, 0, w, h)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
        gl.enable(gl.DEPTH_TEST)
        gl.enable(gl.CULL_FACE)

        const proj = mat4.perspective(Math.PI / 5, w / h, 0.1, 100)
        const view = mat4.lookAt([0, 0.2, 5.2], [0, -0.5, 0], [0, 1, 0])
        const model = mat4.rotY(((getAngle() || 0) * Math.PI) / 180)
        const mvp = mat4.mul(proj, mat4.mul(view, model))

        gl.cullFace(gl.FRONT)
        gl.useProgram(progOut)
        gl.uniformMatrix4fv(O.mvp, false, new Float32Array(mvp))
        gl.uniform3fv(O.color, new Float32Array([0.13, 0.16, 0.27]))
        ;[[meshes.hair, 0.032], [meshes.fringe, 0.016], [meshes.lockL, 0.02], [meshes.lockR, 0.02], [meshes.body, 0.024], [meshes.neck, 0.02], [meshes.head, 0.016]].forEach((pair) => {
          gl.uniformMatrix4fv(O.mvp, false, new Float32Array(mvp))
          gl.uniform1f(O.thick, pair[1])
          drawMesh(pair[0], progOut, O)
        })

        gl.cullFace(gl.BACK)
        gl.useProgram(progToon)
        gl.uniformMatrix4fv(A.mvp, false, new Float32Array(mvp))
        gl.uniformMatrix4fv(A.model, false, new Float32Array(model))
        gl.uniform3fv(A.light, new Float32Array([-0.35, 0.55, 0.78]))
        gl.uniform3fv(A.rim, new Float32Array([0.42, 0.62, 0.95]))
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.uniform1i(A.tex, 0)

        const drawPart = (mesh, color, useTex) => {
          gl.uniform3fv(A.color, new Float32Array(color))
          gl.uniform1f(A.useTex, useTex ? 1 : 0)
          drawMesh(mesh, progToon, A)
        }
        drawPart(meshes.body, [0.17, 0.22, 0.38], false)
        drawPart(meshes.neck, [0.99, 0.83, 0.73], false)
        drawPart(meshes.head, [1.0, 0.86, 0.77], true)
        drawPart(meshes.hair, [0.26, 0.32, 0.6], false)
        drawPart(meshes.fringe, [0.23, 0.28, 0.54], false)
        drawPart(meshes.lockL, [0.23, 0.28, 0.54], false)
        drawPart(meshes.lockR, [0.23, 0.28, 0.54], false)
      }

      let raf = 0
      let disposed = false
      function loop() {
        if (disposed) return
        try { render() } catch (e) { /* 单帧失败不致命 */ }
        raf = requestAnimationFrame(loop)
      }
      loop()

      return {
        dispose() {
          disposed = true
          if (raf) cancelAnimationFrame(raf)
        },
      }
    }

    /** 全屏捏脸编辑器 */
    function FaceEditor(props) {
      const [draft, setDraft] = useState(() => normalizeFace(props.initial))
      const [tab, setTab] = useState(0)
      const [angle, setAngle] = useState(0)
      const [spin, setSpin] = useState(false)
      const [history, setHistory] = useState(() => [normalizeFace(props.initial)])
      const [cursor, setCursor] = useState(0)
      const [codeOpen, setCodeOpen] = useState(false)
      const [codeInput, setCodeInput] = useState('')
      const [toast, setToast] = useState('')
      const stageRef = useRef(null)
      const canvasRef = useRef(null)
      const draftRef = useRef(draft)
      const angleRef = useRef(angle)
      draftRef.current = draft
      angleRef.current = angle
      const [mode, setMode] = useState('3d')
      const lastPush = useRef(0)

      useEffect(() => {
        const onKey = (e) => {
          if (e.key === 'Escape') props.onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [props])

      useEffect(() => {
        if (mode !== '3d') return
        const cv = canvasRef.current
        if (!cv) return
        const eng = createFace3D(cv, () => draftRef.current, () => angleRef.current)
        return () => {
          if (eng) eng.dispose()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [mode])

      useEffect(() => {
        if (!spin) return
        const t = window.setInterval(() => setAngle((a) => (a + 2 > 32 ? -32 : a + 2)), 60)
        return () => window.clearInterval(t)
      }, [spin])

      const commit = (next, pushHistory) => {
        const f = normalizeFace(next)
        setDraft(f)
        if (pushHistory) {
          const now = Date.now()
          if (now - lastPush.current > 350) {
            lastPush.current = now
            setHistory((h) => h.slice(0, cursor + 1).concat([f]).slice(-60))
            setCursor((c) => Math.min(c + 1, 59))
          }
        }
      }

      const setParam = (key, value) => commit(Object.assign({}, draft, { [key]: value }), true)

      const undo = () => {
        if (cursor <= 0) return
        setCursor(cursor - 1)
        setDraft(history[cursor - 1])
      }
      const redo = () => {
        if (cursor >= history.length - 1) return
        setCursor(cursor + 1)
        setDraft(history[cursor + 1])
      }

      const activeGroup = FACE_GROUPS[tab]
      const renderControl = (item) => {
        const [key, label, def, min, max, kind] = item
        const value = draft[key]
        if (kind && kind.indexOf('palette:') === 0) {
          const palette = kind.slice(8) === 'F_SKIN' ? F_SKIN : kind.slice(8) === 'F_HAIR' ? F_HAIR : kind.slice(8) === 'F_EYE' ? F_EYE : F_OUTFIT
          return h(
            'div',
            { className: 'sc-face-sw', key: key },
            h('span', { className: 'lab' }, label),
            h(
              'div',
              { className: 'sc-swatches' },
              palette.map((color, i) =>
                h('button', {
                  key: color + i,
                  className: 'sc-swatch' + (value === i ? ' on' : ''),
                  style: { background: color },
                  onClick: () => setParam(key, i),
                  title: color,
                }),
              ),
            ),
          )
        }
        if (kind && kind.indexOf('names:') === 0) {
          const names = kind.slice(6).split('|')
          return h(
            'div',
            { className: 'sc-face-sw', key: key },
            h('span', { className: 'lab' }, label),
            h(
              'div',
              { className: 'sc-seg' },
              names.map((n, i) =>
                h('button', { key: n, className: value === i ? 'on' : '', onClick: () => setParam(key, i) }, n),
              ),
            ),
          )
        }
        return h(
          'div',
          { className: 'sc-face-row', key: key },
          h('span', { className: 'lab' }, label),
          h('input', {
            type: 'range',
            min: min,
            max: max,
            value: value,
            onChange: (e) => setParam(key, Number(e.target.value)),
            onDoubleClick: () => setParam(key, def),
          }),
          h('span', { className: 'num' }, value > 0 ? '+' + value : String(value)),
        )
      }

      const save = () => {
        const f = normalizeFace(draft)
        writeJson(K_CHARACTER, f)
        props.onSave(f)
        props.onClose()
      }

      return h(
        'div',
        { className: 'sc-face-mask', onMouseDown: (e) => e.target === e.currentTarget && props.onClose() },
        h(
          'div',
          { className: 'sc-face', onMouseDown: (e) => e.stopPropagation() },
          h(
            'div',
            { className: 'sc-face-head' },
            h('span', { className: 'sc-face-title' }, '捏脸工作室'),
            h('span', { className: 'sc-face-meta' }, '拖动滑杆实时预览 · 双击滑杆归零'),
            h('span', { className: 'sc-grow' }),
            h(
              'div',
              { className: 'sc-seg' },
              ['3d', '2d'].map((m) =>
                h(
                  'button',
                  { key: m, className: mode === m ? 'on' : '', onClick: () => setMode(m) },
                  m === '3d' ? '3D' : '2D',
                ),
              ),
            ),
            h(
              'div',
              { className: 'sc-seg' },
              F_STYLE.map((st) =>
                h(
                  'button',
                  {
                    key: st,
                    className: draft.style === st ? 'on' : '',
                    onClick: () => commit(Object.assign({}, draft, { style: st }), true),
                  },
                  st === 'cartoon' ? 'Q 版' : '半写实',
                ),
              ),
            ),
            h('button', { className: 'sc-btn sc-btn-sm', onClick: undo, disabled: cursor <= 0 }, '撤销'),
            h('button', { className: 'sc-btn sc-btn-sm', onClick: redo, disabled: cursor >= history.length - 1 }, '重做'),
            h('button', { className: 'sc-btn sc-btn-sm', onClick: () => commit(randomFace(draft.style), true) }, '随机'),
            h('button', { className: 'sc-btn sc-btn-sm', onClick: () => commit(zeroFace(draft.style), true) }, '重置'),
            h('button', { className: 'sc-btn sc-btn-primary sc-btn-sm', onClick: save }, '保存'),
            h('button', { className: 'sc-btn sc-btn-sm', onClick: props.onClose }, '关闭'),
          ),
          h(
            'div',
            { className: 'sc-face-body' },
            h(
              'div',
              { className: 'sc-face-left' },
              h(
                'div',
                { className: 'sc-face-stage', ref: stageRef },
                mode === '3d'
                  ? h('canvas', {
                      ref: canvasRef,
                      width: 620,
                      height: 760,
                      style: { height: '100%', width: 'auto', maxWidth: '100%', display: 'block' },
                    })
                  : h(FaceRender, { face: draft, size: 300, angle, uid: 'editor' }),
              ),
              h(
                'div',
                { style: { width: '100%', display: 'flex', alignItems: 'center', gap: '8px' } },
                h('span', { className: 'sc-camp-meta' }, '转台'),
                h('button', { className: 'sc-btn sc-btn-sm', onClick: () => setAngle((a) => Math.max(-32, a - 6)) }, '◀'),
                h('input', {
                  type: 'range',
                  min: -32,
                  max: 32,
                  value: angle,
                  style: { flex: 1, accentColor: '#247bbf' },
                  onChange: (e) => setAngle(Number(e.target.value)),
                }),
                h('button', { className: 'sc-btn sc-btn-sm', onClick: () => setAngle((a) => Math.min(32, a + 6)) }, '▶'),
              ),
              h(
                'div',
                { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'center' } },
                h('button', { className: 'sc-btn sc-btn-sm' + (spin ? ' sc-btn-primary' : ''), onClick: () => setSpin((v) => !v) }, spin ? '停止转台' : '自动转台'),
                h('button', { className: 'sc-btn sc-btn-sm', onClick: () => setAngle(0) }, '正面'),
                h('button', { className: 'sc-btn sc-btn-sm', onClick: () => setCodeOpen((v) => !v) }, '脸码'),
              ),
              codeOpen
                ? h(
                    'div',
                    { style: { width: '100%', display: 'flex', flexDirection: 'column', gap: '6px' } },
                    h('input', {
                      className: 'sc-input sc-face-code',
                      style: { width: '100%', fontFamily: 'ui-monospace,Consolas,monospace' },
                      readOnly: true,
                      value: faceCodeOf(draft),
                      onFocus: (e) => e.target.select(),
                    }),
                    h(
                      'div',
                      { style: { display: 'flex', gap: '6px' } },
                      h(
                        'button',
                        {
                          className: 'sc-btn sc-btn-sm',
                          onClick: () => {
                            try {
                              navigator.clipboard.writeText(faceCodeOf(draft))
                              setToast('已复制')
                            } catch (e) {
                              setToast('复制失败，手动选中')
                            }
                          },
                        },
                        '复制',
                      ),
                      h('input', {
                        className: 'sc-input',
                        style: { flex: 1, minWidth: '90px' },
                        placeholder: '粘贴脸码…',
                        value: codeInput,
                        onChange: (e) => setCodeInput(e.target.value),
                      }),
                      h(
                        'button',
                        {
                          className: 'sc-btn sc-btn-sm',
                          onClick: () => {
                            const f = faceFromCode(codeInput)
                            if (!f) {
                              setToast('脸码无效')
                              return
                            }
                            commit(f, true)
                            setToast('已套用')
                          },
                        },
                        '套用',
                      ),
                    ),
                  )
                : null,
              toast ? h('div', { className: 'sc-camp-meta' }, toast) : null,
            ),
            h(
              'div',
              { className: 'sc-face-right' },
              h(
                'div',
                { className: 'sc-face-tabs' },
                FACE_GROUPS.map((g, i) =>
                  h(
                    'button',
                    { key: g.key, className: 'sc-face-tab' + (i === tab ? ' on' : ''), onClick: () => setTab(i) },
                    g.label,
                  ),
                ),
              ),
              h('div', { className: 'sc-face-params' }, activeGroup.items.map(renderControl)),
            ),
          ),
          h(
            'div',
            { className: 'sc-face-foot' },
            h('span', { className: 'sc-camp-meta' }, '预设'),
            FACE_PRESETS.map((p) =>
              h(
                'button',
                { key: p.name, className: 'sc-btn sc-btn-sm', onClick: () => commit(applyPreset(draft, p), true) },
                p.name,
              ),
            ),
            h('span', { className: 'sc-grow' }),
            h('span', { className: 'sc-camp-meta' }, '保存后：头像、串门现场、发布营地都会用这张脸'),
          ),
        ),
      )
    }

    /**
     * 营地快照 = 我装了哪些插件 + 营地名/一句话。
     * P1 只做「发布 / 浏览 / 看清单」：不装任何东西，复刻留到 P2。
     */
    function CampPanel(props) {
      const auth = props.auth
      const [scope, setScope] = useState('friends')
      const [camps, setCamps] = useState([])
      const [detail, setDetail] = useState(null)
      const [myPlugins, setMyPlugins] = useState(null)
      const [mine, setMine] = useState(null)
      const [showForm, setShowForm] = useState(false)
      const [form, setForm] = useState({ name: '', greeting: '', visibility: 'friends' })
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')
      const [loading, setLoading] = useState(false)
      const [shareCode, setShareCode] = useState('')
      const [picked, setPicked] = useState({})
      const [applying, setApplying] = useState(false)
      const [applyResults, setApplyResults] = useState(null)
      const [myChar, setMyChar] = useState(() => readMyCharacter())
      const [visitors, setVisitors] = useState([])
      const [faceOpen, setFaceOpen] = useState(false)

      const collect = async () => {
        try {
          const res = await fetch('/api/share-chat/camp/collect', { credentials: 'same-origin' })
          if (!res.ok) return []
          const data = await res.json()
          return Array.isArray(data.plugins) ? data.plugins : []
        } catch (e) {
          return []
        }
      }

      const loadMine = async () => {
        try {
          const r = await api(auth.server, '/api/camp/' + encodeURIComponent(auth.id), { token: auth.token })
          setMine(r)
          setForm((f) => ({
            name: f.name || r.camp.name || '',
            greeting: f.greeting || r.camp.greeting || '',
            visibility: r.visibility || f.visibility,
          }))
        } catch (e) {
          if (e.code === 'not-found') setMine(null)
        }
      }

      const loadList = async (sc) => {
        setLoading(true)
        setErr('')
        try {
          const r = await api(auth.server, '/api/camps?scope=' + sc, { token: auth.token })
          setCamps(r.camps || [])
        } catch (e) {
          setErr(friendly(e))
        } finally {
          setLoading(false)
        }
      }

      useEffect(() => {
        collect().then(setMyPlugins)
        loadMine()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      useEffect(() => {
        loadList(scope)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [scope])

      const publish = async () => {
        setBusy(true)
        setErr('')
        try {
          const all = await collect()
          const plugins = all.filter((p) => !p.builtin)
          const camp = {
            name: form.name || (auth.displayName || auth.id) + ' 的营地',
            greeting: form.greeting,
            theme: null,
            character: myChar,
            plugins,
          }
          const saved = await api(auth.server, '/api/camp', {
            method: 'POST',
            token: auth.token,
            body: { camp, visibility: form.visibility },
          })
          if (saved && saved.code) setShareCode(saved.code)
          setShowForm(false)
          await loadMine()
          await loadList(scope)
        } catch (e) {
          setErr(friendly(e))
        } finally {
          setBusy(false)
        }
      }

      const unpublish = async () => {
        setBusy(true)
        try {
          await api(auth.server, '/api/camp', { method: 'DELETE', token: auth.token })
          setMine(null)
          await loadList(scope)
        } catch (e) {
          setErr(friendly(e))
        } finally {
          setBusy(false)
        }
      }

      // 串门现场：每 5 秒心跳，每 3 秒拉一次访客
      useEffect(() => {
        if (!detail) return
        const owner = detail.owner
        const code = detail.visibility === 'unlisted' ? '' : ''
        let alive = true
        const beat = async () => {
          try {
            const r = await api(auth.server, '/api/camp/' + encodeURIComponent(owner) + '/visit' + (code ? '?code=' + code : ''), {
              method: 'POST',
              token: auth.token,
              body: { character: myChar },
            })
            if (alive && r && Array.isArray(r.visitors)) setVisitors(r.visitors)
          } catch (e) {
            /* ignore */
          }
        }
        const poll = async () => {
          try {
            const r = await api(auth.server, '/api/camp/' + encodeURIComponent(owner) + '/visitors', { token: auth.token })
            if (alive && r && Array.isArray(r.visitors)) setVisitors(r.visitors)
          } catch (e) {
            /* ignore */
          }
        }
        beat()
        const t1 = window.setInterval(beat, 5000)
        const t2 = window.setInterval(poll, 3000)
        return () => {
          alive = false
          window.clearInterval(t1)
          window.clearInterval(t2)
        }
      }, [detail, myChar, auth.server, auth.token])

      const openDetail = async (owner, rev) => {
        setErr('')
        setPicked({})
        setApplyResults(null)
        setVisitors([])
        try {
          const q = rev ? '?rev=' + rev : ''
          const r = await api(auth.server, '/api/camp/' + encodeURIComponent(owner) + q, { token: auth.token })
          setDetail(r)
        } catch (e) {
          setErr(friendly(e))
        }
      }

      const diffOf = (p) => {
        if (p.builtin) return ['内置', 'sc-badge-builtin']
        const mineP = (myPlugins || []).find((x) => x.name === p.name)
        if (!mineP) return ['可安装', 'sc-badge-new']
        if (mineP.version === p.version) return ['已有', 'sc-badge-have']
        return ['版本不同', 'sc-badge-diff']
      }

      const pickable = (p) => {
        const [tag] = diffOf(p)
        return tag === '可安装' || tag === '版本不同'
      }

      const togglePick = (p) => {
        setPicked((prev) => {
          const next = { ...prev }
          if (next[p.name]) delete next[p.name]
          else next[p.name] = p
          return next
        })
      }

      const replicate = async (camp) => {
        const chosen = Object.values(picked)
        if (!chosen.length) return
        setApplying(true)
        setApplyResults(null)
        setErr('')
        try {
          const nres = await fetch('/api/share-chat/camp/nonce', { credentials: 'same-origin' })
          if (!nres.ok) throw new Error('拿不到本机授权（' + nres.status + '）')
          const { nonce } = await nres.json()
          const res = await fetch('/api/share-chat/camp/apply', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              nonce,
              specs: chosen.map((p) => ({ spec: p.spec, name: p.name, version: p.version })),
            }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(data.error || '安装失败 ' + res.status)
          setApplyResults(data.results || [])
          setPicked({})
          const fresh = await collect()
          setMyPlugins(fresh)
        } catch (e) {
          setErr(String(e.message || e))
        } finally {
          setApplying(false)
        }
      }

      const undoApply = async (targets) => {
        setApplying(true)
        try {
          const res = await fetch('/api/share-chat/camp/remove', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ targets }),
          })
          const data = await res.json().catch(() => ({}))
          setApplyResults(data.results && data.results.length ? null : null)
          const fresh = await collect()
          setMyPlugins(fresh)
          setErr(data.results && data.results.some((r) => !r.ok) ? '部分撤销失败，看控制台' : '')
        } catch (e) {
          setErr(String(e.message || e))
        } finally {
          setApplying(false)
        }
      }

      if (faceOpen) {
        return h(FaceEditor, {
          initial: myChar,
          onSave: (f) => setMyChar(f),
          onClose: () => setFaceOpen(false),
        })
      }

      if (detail) {
        const camp = detail.camp
        const mineMap = new Map((myPlugins || []).map((p) => [p.name, p]))
        return h(
          'div',
          { className: 'sc-camp' },
          h(
            'div',
            { className: 'sc-camp-top' },
            h('button', { className: 'sc-btn sc-btn-sm', onClick: () => setDetail(null) }, '← 返回'),
            h('strong', { style: { fontSize: '14px' } }, camp.name),
            h('span', { className: 'sc-camp-meta' }, '@' + detail.owner),
            h('span', { className: 'sc-grow' }),
            detail.revisions.length > 1
              ? h(
                  'select',
                  {
                    className: 'sc-input',
                    style: { height: '28px', width: 'auto', padding: '0 8px' },
                    value: String(detail.rev),
                    onChange: (e) => openDetail(detail.owner, Number(e.target.value)),
                  },
                  detail.revisions.map((r) =>
                    h('option', { key: r.rev, value: String(r.rev) }, '第 ' + r.rev + ' 版'),
                  ),
                )
              : null,
            h('span', { style: { opacity: 0.5, fontSize: '11px' } }, '复刻功能下一步开放'),
          ),
          h(CampScene, {
            owner: detail.owner,
            ownerName: camp.name,
            ownerCharacter: camp.character,
            myCharacter: myChar,
            me: auth.id,
            visitors,
          }),
          camp.greeting ? h('div', { className: 'sc-camp-greet', style: { marginBottom: '10px' } }, camp.greeting) : null,
          h('div', { className: 'sc-camp-meta' }, '共 ' + camp.plugins.length + ' 个插件 · 与你有 ' + (myPlugins ? myPlugins.length : 0) + ' 个'),
          h(
            'div',
            { className: 'sc-camp-plugins' },
            camp.plugins.map((p, i) => {
              const [tag, cls] = diffOf(p)
              const can = pickable(p)
              return h(
                'div',
                { className: 'sc-camp-plug', key: i },
                can
                  ? h('input', {
                      type: 'checkbox',
                      checked: !!picked[p.name],
                      onChange: () => togglePick(p),
                    })
                  : null,
                h('span', { className: 'nm' }, p.name + (p.version ? '@' + p.version : '')),
                h('span', { className: 'sc-camp-meta' }, p.source === 'git' ? 'git' : p.source || ''),
                h('span', { className: 'sc-camp-badge ' + cls }, tag),
              )
            }),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '14px', flexWrap: 'wrap' } },
            h(
              'button',
              {
                className: 'sc-btn sc-btn-primary',
                disabled: applying || Object.keys(picked).length === 0,
                onClick: () => replicate(camp),
              },
              applying ? '安装中…' : '复刻选中的 ' + Object.keys(picked).length + ' 个插件',
            ),
            applyResults
              ? h(
                  'button',
                  {
                    className: 'sc-btn',
                    disabled: applying,
                    onClick: () =>
                      undoApply(applyResults.filter((r) => r.ok && r.bundle).map((r) => r.bundle)),
                  },
                  '撤销这次安装',
                )
              : null,
            h('span', { className: 'sc-camp-meta' }, '只装你勾的；装完可能需要刷新页面'),
          ),
          applyResults
            ? h(
                'div',
                { className: 'sc-camp-plugins' },
                applyResults.map((r, i) =>
                  h(
                    'div',
                    { className: 'sc-camp-plug', key: i },
                    h('span', { className: 'nm' }, r.spec || r.name || ''),
                    h(
                      'span',
                      { className: 'sc-camp-badge ' + (r.ok ? 'sc-badge-have' : 'sc-badge-diff') },
                      r.ok ? '已安装' + (r.application && r.application !== 'applied' ? '（' + r.application + '）' : '') : '失败',
                    ),
                    h('span', { className: 'sc-camp-meta' }, r.ok ? '' : String(r.error || '')),
                  ),
                ),
              )
            : null,
          err ? h('div', { className: 'sc-err', style: { marginTop: '10px' } }, err) : null,
        )
      }

      return h(
        'div',
        { className: 'sc-camp' },
        h(
          'div',
          { className: 'sc-camp-top' },
          h('strong', { style: { fontSize: '14px' } }, '串门'),
          h('span', { className: 'sc-camp-meta' }, '看看好友的营地，装了哪些插件'),
          h('span', { className: 'sc-grow' }),
          h(
            'button',
            {
              className: 'sc-char-btn',
              title: '打开捏脸工作室',
              onClick: () => setFaceOpen(true),
            },
            h(Character, { ch: myChar, size: 22 }),
            '捏脸',
          ),
          h('button', { className: 'sc-btn sc-btn-sm', onClick: () => setShowForm((v) => !v) }, mine ? '重新发布' : '发布我的营地'),
          h('button', { className: 'sc-btn sc-btn-sm', onClick: () => loadList(scope) }, '刷新'),
        ),
        h(
          'div',
          { className: 'sc-camp-top' },
          h(
            'button',
            { className: 'sc-btn sc-btn-sm' + (scope === 'friends' ? ' sc-btn-primary' : ''), onClick: () => setScope('friends') },
            '好友营地',
          ),
          h(
            'button',
            { className: 'sc-btn sc-btn-sm' + (scope === 'public' ? ' sc-btn-primary' : ''), onClick: () => setScope('public') },
            '营地广场',
          ),
          mine
            ? h(
                'span',
                { className: 'sc-camp-meta' },
                '我的营地已发布 · 第 ' + mine.rev + ' 版 · ' + mine.visibility,
              )
            : null,
          mine && shareCode
            ? h(
                'button',
                {
                  className: 'sc-camp-badge sc-badge-new',
                  style: { cursor: 'pointer', border: 0 },
                  onClick: () => navigator.clipboard && navigator.clipboard.writeText(shareCode),
                  title: '复制访问码',
                },
                '访问码 ' + shareCode,
              )
            : null,
        ),
        showForm
          ? h(
              'div',
              { className: 'sc-camp-form', style: { margin: '0 auto 14px' } },
              h('input', {
                className: 'sc-input',
                placeholder: '营地名（例如：摸鱼营地）',
                value: form.name,
                onChange: (e) => setForm({ ...form, name: e.target.value }),
              }),
              h('input', {
                className: 'sc-input',
                placeholder: '一句话签名',
                value: form.greeting,
                onChange: (e) => setForm({ ...form, greeting: e.target.value }),
              }),
              h(
                'select',
                {
                  className: 'sc-input',
                  value: form.visibility,
                  onChange: (e) => setForm({ ...form, visibility: e.target.value }),
                },
                h('option', { value: 'friends' }, '仅好友可见'),
                h('option', { value: 'public' }, '公开（进营地广场）'),
                h('option', { value: 'unlisted' }, '不列出（凭访问码）'),
              ),
              h(
                'div',
                { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
                h('button', { className: 'sc-btn sc-btn-primary', onClick: publish, disabled: busy }, busy ? '发布中…' : '发布'),
                mine ? h('button', { className: 'sc-btn', onClick: unpublish, disabled: busy }, '下线') : null,
                h('span', { className: 'sc-camp-meta' }, '发布的内容只有营地名、签名和插件清单，不含路径/凭据/会话'),
              ),
            )
          : null,
        err ? h('div', { className: 'sc-err', style: { marginBottom: '8px' } }, err) : null,
        loading ? h('div', { className: 'sc-camp-meta' }, '加载中…') : null,
        h(
          'div',
          { className: 'sc-camp-grid' },
          camps.length === 0 && !loading
            ? emptyState('🏕', scope === 'public' ? '广场上还没有营地' : '好友还没人发布营地', '发布一个自己的，或去广场看看')
            : camps.map((c) =>
                h(
                  'div',
                  { className: 'sc-camp-card', key: c.owner, onClick: () => openDetail(c.owner) },
                  h(Character, { ch: c.character, id: c.owner, size: 34 }),
                  h(
                    'div',
                    { className: 'sc-camp-info' },
                    h('div', { className: 'sc-camp-name' }, c.name),
                    h('div', { className: 'sc-camp-greet' }, c.greeting || '（没有签名）'),
                    h(
                      'div',
                      { className: 'sc-camp-meta' },
                      '@' + c.owner + ' · ' + c.pluginCount + ' 个插件 · 第 ' + c.rev + ' 版',
                    ),
                  ),
                  h('span', { className: 'sc-camp-badge sc-badge-new' }, '进去看看'),
                ),
              ),
        ),
      )
    }

    // ───────────────────────── 虚拟形象 ─────────────────────────

    const K_CHARACTER = 'dsh-share-chat.character'
    const CHAR_SKINS = ['#f3cba6', '#e8b78f', '#c98d64', '#8d5a3b']
    const CHAR_HAIRS = ['#2b2b2b', '#5a3a26', '#8a5a2b', '#d9b25f', '#3d5a80', '#a33b52']
    const CHAR_OUTFITS = ['#247bbf', '#2f8f65', '#8a5ec9', '#d0693b', '#3d7a8c', '#b03a5b']

    function charHash(str) {
      let h = 2166136261
      const t = String(str || '?')
      for (let i = 0; i < t.length; i++) {
        h ^= t.charCodeAt(i)
        h = Math.imul(h, 16777619)
      }
      return Math.abs(h)
    }

    const CHAR_HATS = ['none', 'none', 'none', 'cap', 'beanie', 'halo']

    function defaultCharacter(id) {
      const h = charHash(id)
      return {
        seed: h % 999999,
        skin: CHAR_SKINS[h % CHAR_SKINS.length],
        hair: CHAR_HAIRS[(h >> 3) % CHAR_HAIRS.length],
        outfit: CHAR_OUTFITS[(h >> 6) % CHAR_OUTFITS.length],
        hat: CHAR_HATS[(h >> 9) % CHAR_HATS.length],
      }
    }

    function normalizeCharacter(c, id) {
      const base = defaultCharacter(id || 'anon')
      const src = c && typeof c === 'object' ? c : {}
      const color = (v, fb) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : fb)
      return {
        seed: Number.isFinite(Number(src.seed)) ? Number(src.seed) : base.seed,
        skin: color(src.skin, base.skin),
        hair: color(src.hair, base.hair),
        outfit: color(src.outfit, base.outfit),
        hat: ['none', 'cap', 'beanie', 'halo'].includes(src.hat) ? src.hat : base.hat,
      }
    }

    function readMyCharacter() {
      return normalizeFace(readJson(K_CHARACTER))
    }

    function randomCharacter(prev) {
      return randomFace((prev && prev.style) || 'cartoon')
    }

    /** 小人儿：v2 捏脸参数的渲染入口（兼容 v1 哈希形象） */
    function Character(props) {
      const f = props.face ? normalizeFace(props.face, props.id) : normalizeFace(props.ch, props.id)
      const size = props.size || 56
      return h(FaceRender, {
        face: f,
        size: size,
        angle: props.angle === undefined ? 0 : props.angle,
        uid: (props.id || '') + (props.uid || ''),
      })
    }

    /** 串门现场：营地主人 + 我 + 其他访客 */
    function CampScene(props) {
      const ownerChar = normalizeFace(props.ownerCharacter, props.owner)
      const myChar = normalizeFace(props.myCharacter, props.me)
      const visitors = Array.isArray(props.visitors) ? props.visitors.filter((v) => v.id !== props.me && v.id !== props.owner) : []
      const slots = [
        { key: 'me', char: myChar, name: '我', left: '12%', walk: true },
        { key: 'owner', char: ownerChar, name: props.ownerName || props.owner, left: '72%' },
        ...visitors.slice(0, 3).map((v, i) => ({
          key: v.id,
          char: normalizeFace(v.character, v.id),
          name: v.name || v.id,
          left: 34 + i * 14 + '%',
        })),
      ]
      return h(
        'div',
        { className: 'sc-scene' },
        h('div', { className: 'sc-scene-floor' }),
        visitors.length === 0
          ? h('div', { className: 'sc-scene-empty' }, '现在只有你们俩，等别人推门进来')
          : null,
        slots.map((slot) =>
          h(
            'div',
            {
              key: slot.key,
              className: 'sc-scene-actor' + (slot.walk ? ' walk' : ''),
              style: { left: slot.left },
            },
            h('div', { className: 'sc-scene-bob' }, h(Character, { ch: slot.char, size: slot.key === 'owner' ? 62 : 50 })),
            h('div', { className: 'sc-scene-name' }, slot.name),
          ),
        ),
      )
    }

    // ───────────────────────── 捏脸引擎 v2 ─────────────────────────

    const FACE_V = 2
    const F_SKIN = ['#f7dbc4', '#f0c9a8', '#e2b189', '#cb9468', '#a9744c', '#8a5738']
    const F_HAIR = ['#241f1c', '#43301f', '#65452a', '#95683c', '#d8b05c', '#8b3646', '#3b567c', '#6f4785']
    const F_EYE = ['#26221f', '#4a3826', '#33513f', '#38557a', '#543544', '#6b5a2f']
    const F_OUTFIT = ['#247bbf', '#2f8f65', '#8a5ec9', '#d0693b', '#3d7a8c', '#b03a5b', '#5a6570', '#c9a227']
    const F_HAT = ['none', 'cap', 'beanie', 'halo']
    const F_GLASSES = ['none', 'round', 'square']
    const F_EARRING = ['none', 'dot']
    const F_STYLE = ['cartoon', 'real']

    const FACE_GROUPS = [
      {
        key: 'shape',
        label: '脸型',
        items: [
          ['faceWidth', '脸宽', 0, -100, 100],
          ['jaw', '下颌', 0, -100, 100],
          ['cheek', '颧骨', 0, -100, 100],
          ['chin', '下巴', 0, -100, 100],
          ['forehead', '额头', 0, -100, 100],
        ],
      },
      {
        key: 'eyes',
        label: '眼睛',
        items: [
          ['eyeSize', '大小', 0, -100, 100],
          ['eyeSpacing', '眼距', 0, -100, 100],
          ['eyeTilt', '眼角', 0, -100, 100],
          ['eyeHeight', '位置', 0, -100, 100],
          ['eyeLid', '眼睑', 0, 0, 100],
          ['eyePupil', '瞳孔', 0, -100, 100],
        ],
      },
      {
        key: 'brow',
        label: '眉毛',
        items: [
          ['browThick', '粗细', 0, -100, 100],
          ['browArch', '弧度', 0, -100, 100],
          ['browHeight', '高低', 0, -100, 100],
          ['browTilt', '眉头', 0, -100, 100],
        ],
      },
      {
        key: 'nose',
        label: '鼻子',
        items: [
          ['noseLength', '长短', 0, -100, 100],
          ['noseWidth', '宽窄', 0, -100, 100],
          ['noseBridge', '鼻梁', 0, 0, 100],
          ['noseTip', '鼻头', 0, -100, 100],
        ],
      },
      {
        key: 'mouth',
        label: '嘴巴',
        items: [
          ['mouthWidth', '宽窄', 0, -100, 100],
          ['mouthFull', '厚薄', 0, -100, 100],
          ['mouthSmile', '嘴角', 0, -100, 100],
          ['mouthHeight', '高低', 0, -100, 100],
        ],
      },
      {
        key: 'ears',
        label: '耳朵',
        items: [
          ['earSize', '大小', 0, -100, 100],
          ['earAngle', '角度', 0, -100, 100],
        ],
      },
      {
        key: 'look',
        label: '肤色',
        items: [
          ['skinTone', '肤色', 1, 0, F_SKIN.length - 1, 'palette:F_SKIN'],
          ['blush', '腮红', 30, 0, 100],
          ['shadow', '面部阴影', 45, 0, 100],
          ['eyeColor', '瞳色', 0, 0, F_EYE.length - 1, 'palette:F_EYE'],
          ['browColor', '眉色', 0, 0, F_HAIR.length - 1, 'palette:F_HAIR'],
        ],
      },
      {
        key: 'hair',
        label: '头发',
        items: [
          ['hairStyle', '发型', 0, 0, 7, 'names:' + ['短发', '波波', '长直', '马尾', '卷发', '寸头', '偏分', '双马尾'].join('|')],
          ['hairColor', '发色', 0, 0, F_HAIR.length - 1, 'palette:F_HAIR'],
          ['fringe', '刘海', 45, 0, 100],
        ],
      },
      {
        key: 'makeup',
        label: '妆容',
        items: [
          ['eyeliner', '眼线', 0, 0, 100],
          ['lip', '唇色', 35, 0, 100],
        ],
      },
      {
        key: 'acc',
        label: '配饰',
        items: [
          ['hat', '帽子', 0, 0, F_HAT.length - 1, 'names:' + F_HAT.join('|')],
          ['glasses', '眼镜', 0, 0, F_GLASSES.length - 1, 'names:' + F_GLASSES.join('|')],
          ['earring', '耳饰', 0, 0, F_EARRING.length - 1, 'names:' + F_EARRING.join('|')],
        ],
      },
      {
        key: 'body',
        label: '身形',
        items: [
          ['build', '体宽', 0, -100, 100],
          ['outfit', '衣服', 0, 0, F_OUTFIT.length - 1, 'palette:F_OUTFIT'],
        ],
      },
    ]

    const FACE_PARAMS = []
    for (const g of FACE_GROUPS) for (const it of g.items) FACE_PARAMS.push(it)

    const clampNum = (v, min, max, fb) => {
      const n = Number(v)
      if (!Number.isFinite(n)) return fb
      return Math.max(min, Math.min(max, Math.round(n)))
    }

    function zeroFace(style) {
      const f = { v: FACE_V, style: style || 'cartoon' }
      for (const it of FACE_PARAMS) f[it[0]] = it[2]
      return f
    }

    /** v1（seed/skin/hair/outfit/hat）→ v2 */
    function faceFromV1(old, id) {
      const h = charHash(id || 'anon')
      const seed = old && Number.isFinite(Number(old.seed)) ? Number(old.seed) : h % 999999
      const pick = (n) => ((seed >> n) % 61) - 30
      const f = zeroFace('cartoon')
      f.faceWidth = pick(0)
      f.jaw = pick(2)
      f.cheek = pick(4)
      f.chin = pick(6)
      f.forehead = pick(8)
      f.eyeSize = pick(10)
      f.eyeSpacing = pick(12)
      f.eyeTilt = pick(14)
      f.browThick = pick(16)
      f.noseLength = pick(18)
      f.mouthWidth = pick(20)
      const near = (hex, arr, fb) => {
        const c = String(hex || '')
        const i = arr.findIndex((x) => x.toLowerCase() === c.toLowerCase())
        return i >= 0 ? i : fb
      }
      f.skinTone = near(old && old.skin, F_SKIN, 1)
      f.hairColor = near(old && old.hair, F_HAIR, 0)
      f.outfit = near(old && old.outfit, F_OUTFIT, 0)
      f.hat = Math.max(0, F_HAT.indexOf(String((old && old.hat) || 'none')))
      return f
    }

    function normalizeFace(input, id) {
      const src = input && typeof input === 'object' ? input : null
      if (!src) return faceFromV1(null, id)
      if (src.v !== FACE_V && (src.shape || src.eyes) === undefined && src.faceWidth === undefined) {
        return faceFromV1(src, id)
      }
      const f = zeroFace(F_STYLE.includes(src.style) ? src.style : 'cartoon')
      for (const it of FACE_PARAMS) {
        const [key, , def, min, max] = it
        f[key] = clampNum(src[key], min, max, def)
      }
      return f
    }

    function randomFace(style) {
      const r = (min, max) => Math.round(min + Math.random() * (max - min))
      const f = zeroFace(style)
      for (const it of FACE_PARAMS) {
        const [key, , , min, max, kind] = it
        if (kind && kind.startsWith('palette:')) f[key] = r(min, max)
        else if (kind && kind.startsWith('names:')) f[key] = r(min, max)
        else if (key === 'eyeLid' || key === 'blush' || key === 'fringe' || key === 'noseBridge') f[key] = r(min, Math.min(max, 80))
        else f[key] = r(Math.max(min, -60), Math.min(max, 60))
      }
      return f
    }

    function faceCodeOf(face) {
      const f = normalizeFace(face)
      const nums = [FACE_V, F_STYLE.indexOf(f.style)].concat(FACE_PARAMS.map((it) => f[it[0]]))
      const payload = nums.join('.')
      let b64 = ''
      try {
        b64 = btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      } catch (e) {
        b64 = ''
      }
      return 'FACE2-' + b64
    }

    function faceFromCode(code) {
      try {
        const raw = String(code || '').trim()
        if (!raw.startsWith('FACE2-')) return null
        const b64 = raw.slice(6).replace(/-/g, '+').replace(/_/g, '/')
        const text = atob(b64 + '==='.slice((b64.length + 3) % 4))
        const nums = text.split('.').map((x) => Number(x))
        if (nums.length !== FACE_PARAMS.length + 2 || nums[0] !== FACE_V) return null
        const f = zeroFace(F_STYLE[nums[1]] || 'cartoon')
        FACE_PARAMS.forEach((it, i) => {
          f[it[0]] = clampNum(nums[i + 2], it[3], it[4], it[2])
        })
        return f
      } catch (e) {
        return null
      }
    }

    const FACE_PRESETS = [
      { name: '中性', patch: {} },
      { name: '清秀', patch: { faceWidth: -30, jaw: -40, chin: -20, eyeSize: 18, eyeSpacing: 6, browThick: -35, noseWidth: -30, mouthWidth: -18, lip: 60 } },
      { name: '硬朗', patch: { faceWidth: 34, jaw: 55, cheek: 40, chin: 35, eyeSize: -18, browThick: 55, browTilt: -30, noseBridge: 65, mouthWidth: 22, lip: 10 } },
      { name: '幼态', patch: { faceWidth: 22, jaw: -25, chin: -35, eyeSize: 55, eyeHeight: 20, eyeSpacing: 18, noseLength: -40, noseWidth: -35, mouthWidth: -25, blush: 70 } },
      { name: '成熟', patch: { jaw: 22, cheek: 30, chin: 18, eyeSize: -10, eyeTilt: 20, browArch: 40, noseLength: 30, noseBridge: 40, lip: 60, eyeliner: 45 } },
      { name: '搞怪', patch: { faceWidth: 55, jaw: -60, eyeSize: 70, eyeSpacing: 60, eyeTilt: -50, browThick: 80, noseTip: 70, mouthWidth: 60, mouthSmile: 80, hat: 2 } },
    ]

    function applyPreset(face, preset) {
      const f = normalizeFace(face)
      const next = Object.assign({}, f, preset.patch || {})
      return normalizeFace(next)
    }

    /** 把参数算成一条脸型轮廓 */
    function faceOutline(f) {
      const cx = 100
      const rx = 44 + f.faceWidth * 0.11 - f.cheek * 0.02
      const top = 44 - f.forehead * 0.06
      const cy = 104
      const chinY = 166 + f.chin * 0.11
      const jawW = 30 + f.jaw * 0.11 + f.cheek * 0.03
      const jawY = 132 + f.jaw * 0.05
      return {
        cx, rx, top, cy, chinY, jawW, jawY,
        d:
          'M ' + cx + ' ' + top +
          ' C ' + (cx + rx * 0.62) + ' ' + (top - 2) + ',' + (cx + rx) + ' ' + (cy - 32) + ',' + (cx + rx) + ' ' + (cy + 2) +
          ' C ' + (cx + rx) + ' ' + jawY + ',' + (cx + jawW) + ' ' + (chinY - 16) + ',' + cx + ' ' + chinY +
          ' C ' + (cx - jawW) + ' ' + (chinY - 16) + ',' + (cx - rx) + ' ' + jawY + ',' + (cx - rx) + ' ' + (cy + 2) +
          ' C ' + (cx - rx) + ' ' + (cy - 32) + ',' + (cx - rx * 0.62) + ' ' + (top - 2) + ',' + cx + ' ' + top + ' Z',
      }
    }

    /** 参数化脸部（纯 SVG） */
    function FaceSVG(props) {
      const f = normalizeFace(props.face, props.id)
      const style = f.style
      const real = style === 'real'
      const size = props.size || 120
      const angle = Math.max(-35, Math.min(35, Number(props.angle) || 0))
      const rad = (angle * Math.PI) / 180
      const sx = Math.max(0.3, Math.cos(rad))
      const depth = Math.sin(rad)
      const uid = 'f' + (props.uid || Math.abs(charHash(JSON.stringify(f))).toString(36))
      const skin = F_SKIN[f.skinTone]
      const skinDark = shade(skin, -18)
      const hair = F_HAIR[f.hairColor]
      const eyeCol = F_EYE[f.eyeColor]
      const browCol = F_HAIR[f.browColor]
      const outfit = F_OUTFIT[f.outfit]
      const o = faceOutline(f)

      const eyeY = o.cy + 8 + f.eyeHeight * 0.1
      const eyeX = 21 + f.eyeSpacing * 0.1
      const eyeRx = (real ? 6.6 : 9.6) + f.eyeSize * 0.042
      const eyeRy = (real ? 4.6 : 7.0) + f.eyeSize * 0.028
      const eyeTilt = f.eyeTilt * 0.09
      const irisR = Math.min(eyeRx * 0.78, (real ? 4.2 : 6.2) + f.eyePupil * 0.008)
      const browY = eyeY - (real ? 12 : 14) - f.browHeight * 0.08
      const browThick = (real ? 2.0 : 2.6) + f.browThick * 0.022
      const browW = eyeRx * 1.55
      const noseY = eyeY + 20 + f.noseLength * 0.1
      const noseW = 4 + f.noseWidth * 0.035
      const mouthY = o.chinY - 20 + f.mouthHeight * 0.06
      const mouthW = 12 + f.mouthWidth * 0.09
      const smile = f.mouthSmile * 0.09
      const lipFull = 2.8 + f.mouthFull * 0.035
      const earRy = 10 + f.earSize * 0.05
      const earTilt = f.earAngle * 0.2

      const eye = (side) =>
        h(
          'g',
          { transform: 'translate(' + (o.cx + side * eyeX) + ',' + eyeY + ') rotate(' + side * eyeTilt + ')' },
          h('ellipse', { rx: eyeRx, ry: eyeRy, fill: '#fdfdfd' }),
          h('ellipse', { cx: side * 0.6, cy: 0.4, rx: irisR, ry: irisR, fill: eyeCol }),
          h('ellipse', { cx: side * 0.6, cy: 0.4, rx: irisR * 0.42, ry: irisR * 0.42, fill: '#16181a' }),
          h('circle', { cx: side * 0.6 + irisR * 0.32, cy: -irisR * 0.3, r: Math.max(0.7, irisR * 0.18), fill: '#fff' }),
          f.eyeLid > 8
            ? h('path', {
                d: 'M ' + -eyeRx + ' 0 Q 0 ' + -eyeRy * (1 + f.eyeLid * 0.004) + ' ' + eyeRx + ' 0',
                fill: 'none',
                stroke: skinDark,
                strokeWidth: 1.4 + f.eyeLid * 0.01,
              })
            : null,
          f.eyeliner > 6
            ? h('path', {
                d: 'M ' + -eyeRx + ' -1 Q 0 ' + -eyeRy * 1.08 + ' ' + (eyeRx + 1.6) + ' -2.4',
                fill: 'none',
                stroke: '#2a2320',
                strokeWidth: 0.8 + f.eyeliner * 0.02,
                strokeLinecap: 'round',
              })
            : null,
        )

      const brow = (side) =>
        h('path', {
          d:
            'M ' + (o.cx + side * eyeX - browW) + ' ' + (browY + side * f.browTilt * 0.03) +
            ' Q ' + (o.cx + side * eyeX) + ' ' + (browY - browW * 0.42 - f.browArch * 0.1) + ' ' +
            (o.cx + side * eyeX + browW) + ' ' + (browY - 1.5),
          fill: 'none',
          stroke: browCol,
          strokeWidth: browThick,
          strokeLinecap: 'round',
          opacity: real ? 0.92 : 1,
        })

      const hatNode =
        f.hat === 'cap'
          ? h('g', null,
              h('path', { d: 'M ' + (o.cx - o.rx) + ' ' + (o.top + 8) + ' C ' + (o.cx - o.rx + 4) + ' ' + (o.top - 22) + ',' + (o.cx + o.rx - 4) + ' ' + (o.top - 22) + ',' + (o.cx + o.rx) + ' ' + (o.top + 8) + ' Z', fill: '#247bbf' }),
              h('rect', { x: o.cx + 6, y: o.top + 4, width: o.rx + 6, height: 4.6, rx: 2.3, fill: '#1f6cab' }))
          : f.hat === 'beanie'
            ? h('g', null,
                h('path', { d: 'M ' + (o.cx - o.rx) + ' ' + (o.top + 10) + ' C ' + (o.cx - o.rx + 2) + ' ' + (o.top - 26) + ',' + (o.cx + o.rx - 2) + ' ' + (o.top - 26) + ',' + (o.cx + o.rx) + ' ' + (o.top + 10) + ' Z', fill: '#d0693b' }),
                h('rect', { x: o.cx - o.rx - 1, y: o.top + 6, width: o.rx * 2 + 2, height: 6, rx: 3, fill: '#b3572f' }),
                h('circle', { cx: o.cx, cy: o.top - 24, r: 4, fill: '#f3d9a4' }))
            : f.hat === 'halo'
              ? h('ellipse', { cx: o.cx, cy: o.top - 16, rx: 16, ry: 3.6, fill: 'none', stroke: '#f4d06f', strokeWidth: 3 })
              : null

      const glassesNode =
        f.glasses === 'round'
          ? h('g', { fill: 'none', stroke: '#c9d6de', strokeWidth: 2, opacity: 0.9 },
              h('circle', { cx: o.cx - eyeX, cy: eyeY, r: eyeRx + 3 }),
              h('circle', { cx: o.cx + eyeX, cy: eyeY, r: eyeRx + 3 }),
              h('path', { d: 'M ' + (o.cx - eyeX + eyeRx + 3) + ' ' + eyeY + ' L ' + (o.cx + eyeX - eyeRx - 3) + ' ' + eyeY }))
          : f.glasses === 'square'
            ? h('g', { fill: 'none', stroke: '#2a2f33', strokeWidth: 2, opacity: 0.9 },
                h('rect', { x: o.cx - eyeX - eyeRx - 3, y: eyeY - eyeRy - 2, width: (eyeRx + 3) * 2, height: (eyeRy + 2) * 2, rx: 3 }),
                h('rect', { x: o.cx + eyeX - eyeRx - 3, y: eyeY - eyeRy - 2, width: (eyeRx + 3) * 2, height: (eyeRy + 2) * 2, rx: 3 }),
                h('path', { d: 'M ' + (o.cx - eyeX + eyeRx + 3) + ' ' + eyeY + ' L ' + (o.cx + eyeX - eyeRx - 3) + ' ' + eyeY }))
            : null

      const hairStyle = Number(f.hairStyle) || 0
      const fringe = 6 + f.fringe * 0.16
      const hairlineY = o.cy - 30 + f.fringe * 0.24
      const backHair =
        hairStyle === 2 || hairStyle === 7
          ? h('path', {
              d: 'M ' + (o.cx - o.rx - 6) + ' ' + (o.top + 10) + ' C ' + (o.cx - o.rx - 18) + ' ' + (o.cy + 40) + ',' + (o.cx - o.rx - 12) + ' ' + (o.chinY + 26) + ',' + o.cx + ' ' + (o.chinY + 30) + ' C ' + (o.cx + o.rx + 12) + ' ' + (o.chinY + 26) + ',' + (o.cx + o.rx + 18) + ' ' + (o.cy + 40) + ',' + (o.cx + o.rx + 6) + ' ' + (o.top + 10) + ' Z',
              fill: 'url(#' + uid + 'hair)',
            })
          : hairStyle === 1
            ? h('path', {
                d: 'M ' + (o.cx - o.rx - 4) + ' ' + (o.top + 12) + ' C ' + (o.cx - o.rx - 10) + ' ' + (o.cy + 26) + ',' + (o.cx - o.rx) + ' ' + (o.chinY - 16) + ',' + o.cx + ' ' + (o.chinY - 14) + ' C ' + (o.cx + o.rx) + ' ' + (o.chinY - 16) + ',' + (o.cx + o.rx + 10) + ' ' + (o.cy + 26) + ',' + (o.cx + o.rx + 4) + ' ' + (o.top + 12) + ' Z',
                fill: 'url(#' + uid + 'hair)',
              })
            : hairStyle === 3
              ? h('path', {
                  d: 'M ' + (o.cx + o.rx - 2) + ' ' + (o.top + 6) + ' C ' + (o.cx + o.rx + 16) + ' ' + (o.cy) + ',' + (o.cx + o.rx + 10) + ' ' + (o.chinY - 10) + ',' + (o.cx + o.rx - 8) + ' ' + (o.chinY - 18) + ' C ' + (o.cx + o.rx) + ' ' + (o.cy + 6) + ',' + (o.cx + o.rx) + ' ' + (o.top + 22) + ',' + (o.cx + o.rx - 2) + ' ' + (o.top + 6) + ' Z',
                  fill: 'url(#' + uid + 'hair)',
                })
              : null

      const hairCap = h(
        'g',
        { clipPath: 'url(#' + uid + 'headclip)' },
        h('rect', { x: o.cx - o.rx - 2, y: o.top - 30, width: o.rx * 2 + 4, height: hairlineY - (o.top - 30), fill: 'url(#' + uid + 'hair)' }),
        hairStyle === 5
          ? null
          : h('path', {
              d: 'M ' + (o.cx - o.rx) + ' ' + (hairlineY - 10) +
                ' C ' + (o.cx - o.rx * 0.55) + ' ' + (hairlineY + 10 + fringe * 0.2) + ',' + (o.cx - o.rx * 0.2) + ' ' + (hairlineY - 6) + ',' + o.cx + ' ' + (hairlineY - 2) +
                ' C ' + (o.cx + o.rx * 0.25) + ' ' + (hairlineY + 8) + ',' + (o.cx + o.rx * 0.6) + ' ' + (hairlineY + 8 + fringe * 0.18) + ',' + (o.cx + o.rx) + ' ' + (hairlineY - 12) +
                ' L ' + (o.cx + o.rx) + ' ' + (o.top - 20) + ' L ' + (o.cx - o.rx) + ' ' + (o.top - 20) + ' Z',
              fill: 'url(#' + uid + 'hair)',
            }),
      )

      const bodyW = 40 + f.build * 0.14
      const bodyNode = h(
        'g',
        null,
        h('rect', { x: o.cx - 12, y: o.chinY - 10, width: 24, height: 34, rx: 8, fill: skinDark }),
        h('path', {
          d: 'M ' + (o.cx - bodyW) + ' 280 C ' + (o.cx - bodyW + 2) + ' ' + (o.chinY + 26) + ',' + (o.cx - 20) + ' ' + (o.chinY + 16) + ',' + o.cx + ' ' + (o.chinY + 16) +
            ' C ' + (o.cx + 20) + ' ' + (o.chinY + 16) + ',' + (o.cx + bodyW - 2) + ' ' + (o.chinY + 26) + ',' + (o.cx + bodyW) + ' 280 Z',
          fill: outfit,
        }),
        h('path', { d: 'M ' + (o.cx - 11) + ' ' + (o.chinY + 15) + ' L ' + o.cx + ' ' + (o.chinY + 30) + ' L ' + (o.cx + 11) + ' ' + (o.chinY + 15) + ' Z', fill: shade(outfit, 22), opacity: 0.85 }),
      )

      return h(
        'svg',
        { className: 'sc-char-svg', width: size, height: Math.round(size * 1.4), viewBox: '0 0 200 280', role: 'img', 'aria-label': 'character' },
        h(
          'defs',
          null,
          h('radialGradient', { id: uid + 'sh', cx: '38%', cy: '30%', r: '72%' },
            h('stop', { offset: '0%', stopColor: '#ffffff', stopOpacity: real ? 0.20 : 0.14 }),
            h('stop', { offset: '62%', stopColor: '#ffffff', stopOpacity: 0 }),
            h('stop', { offset: '100%', stopColor: '#000000', stopOpacity: real ? 0.24 : 0.16 })),
          h('linearGradient', { id: uid + 'hair', x1: '0', y1: '0', x2: '0', y2: '1' },
            h('stop', { offset: '0%', stopColor: shade(hair, 16) }),
            h('stop', { offset: '100%', stopColor: shade(hair, -14) })),
          h('clipPath', { id: uid + 'headclip' }, h('path', { d: o.d })),
        ),
        h(
          'g',
          { transform: 'translate(100,0) scale(' + sx + ',1) translate(-100,0)' },
          bodyNode,
          backHair,
          h('ellipse', { cx: o.cx, cy: o.chinY + 4, rx: o.jawW * 0.9, ry: 12, fill: '#000', opacity: 0.10 }),
          h('path', { d: o.d, fill: skin }),
          h('path', { d: o.d, fill: 'url(#' + uid + 'sh)' }),
          hairCap,
          real
            ? h('g', null,
                h('ellipse', { cx: o.cx - eyeX, cy: eyeY - 2, rx: eyeRx * 1.5, ry: eyeRy * 1.6, fill: '#000', opacity: 0.06 }),
                h('ellipse', { cx: o.cx + eyeX, cy: eyeY - 2, rx: eyeRx * 1.5, ry: eyeRy * 1.6, fill: '#000', opacity: 0.06 }),
                h('ellipse', { cx: o.cx - o.rx * 0.55, cy: o.cy + 30, rx: 12, ry: 8, fill: '#000', opacity: 0.05 }),
                h('ellipse', { cx: o.cx + o.rx * 0.55, cy: o.cy + 30, rx: 12, ry: 8, fill: '#000', opacity: 0.05 }),
                h('path', { d: 'M ' + (o.cx - noseW - 0.5) + ' ' + (noseY - 12) + ' Q ' + (o.cx - noseW - 3) + ' ' + (noseY + 2) + ' ' + (o.cx - noseW) + ' ' + (noseY + 5), fill: 'none', stroke: '#000', strokeWidth: 1.6, opacity: 0.08 }),
                h('path', { d: 'M ' + (o.cx + noseW + 0.5) + ' ' + (noseY - 12) + ' Q ' + (o.cx + noseW + 3) + ' ' + (noseY + 2) + ' ' + (o.cx + noseW) + ' ' + (noseY + 5), fill: 'none', stroke: '#000', strokeWidth: 1.6, opacity: 0.08 }))
            : null,
          h('ellipse', { cx: o.cx - o.rx * 0.62, cy: o.cy + 18, rx: 10, ry: 6, fill: '#e2735f', opacity: f.blush / 100 * 0.28 }),
          h('ellipse', { cx: o.cx + o.rx * 0.62, cy: o.cy + 18, rx: 10, ry: 6, fill: '#e2735f', opacity: f.blush / 100 * 0.28 }),
          h('ellipse', { cx: o.cx - o.rx, cy: o.cy + 12, rx: 6, ry: earRy, fill: skin, transform: 'rotate(' + (-earTilt) + ' ' + (o.cx - o.rx) + ' ' + (o.cy + 12) + ')' }),
          h('ellipse', { cx: o.cx + o.rx, cy: o.cy + 12, rx: 6, ry: earRy, fill: skin, transform: 'rotate(' + earTilt + ' ' + (o.cx + o.rx) + ' ' + (o.cy + 12) + ')' }),
          f.earring === 'dot' ? h('circle', { cx: o.cx + o.rx + 1, cy: o.cy + 24, r: 2.6, fill: '#f4d06f' }) : null,
          h('path', { d: 'M ' + (o.cx - noseW) + ' ' + (noseY + 4) + ' Q ' + o.cx + ' ' + (noseY + 9) + ' ' + (o.cx + noseW) + ' ' + (noseY + 4), fill: 'none', stroke: skinDark, strokeWidth: real ? 1.8 : 1.4, opacity: 0.75, strokeLinecap: 'round' }),
          f.noseBridge > 10 ? h('rect', { x: o.cx - 1.6, y: noseY - 16, width: 3.2, height: 16, rx: 1.6, fill: '#fff', opacity: f.noseBridge / 100 * 0.22 }) : null,
          h('path', {
            d: 'M ' + (o.cx - mouthW) + ' ' + mouthY + ' Q ' + o.cx + ' ' + (mouthY + lipFull + smile) + ' ' + (o.cx + mouthW) + ' ' + mouthY,
            fill: 'none',
            stroke: lipColor(f.lip),
            strokeWidth: lipFull,
            strokeLinecap: 'round',
          }),
          eye(-1),
          eye(1),
          brow(-1),
          brow(1),
          hatNode,
          glassesNode,
        ),
      )
    }

    const C_HAIR = ['#3d4c8c', '#2b3560', '#5b6bb0', '#8a5a3c', '#d9b25f', '#b04a63', '#7a5aa8', '#4a8b8f']
    const C_EYE = ['#4a63b0', '#2f7a6a', '#8a4a7a', '#5a4a3a', '#3d5a80', '#7a5a2f']
    const C_OUTFIT = ['#2f3a63', '#eef2fb', '#7fb3e0', '#63c2b0', '#d98aa0', '#c9a227', '#8a5ec9', '#d0693b']

    /** Q 版鲸鱼娘：厚描边 + 大眼 + 圆润剪影 */
    function ChibiFace(props) {
      const f = normalizeFace(props.face, props.id)
      const size = props.size || 120
      const angle = Math.max(-28, Math.min(28, Number(props.angle) || 0))
      const rad = (angle * Math.PI) / 180
      const sx = Math.max(0.5, Math.cos(rad))
      const uid = 'c' + (props.uid || Math.abs(charHash(JSON.stringify(f))).toString(36))
      const ink = '#252b45'
      const hair = C_HAIR[f.hairColor % C_HAIR.length]
      const hairLo = shade(hair, -14)
      const hairHi = shade(hair, 42)
      const skin = F_SKIN[f.skinTone]
      const skinLo = shade(skin, -14)
      const outfit = C_OUTFIT[f.outfit % C_OUTFIT.length]
      const iris = C_EYE[f.eyeColor % C_EYE.length]

      const cx = 120
      const cy = 128
      const rx = 64 + f.faceWidth * 0.07 + f.cheek * 0.02
      const ry = 66 + f.chin * 0.03
      const eyeScale = 1 + f.eyeSize * 0.0045
      const eyeX = 29 + f.eyeSpacing * 0.07
      const eyeY = cy + 22 + f.eyeHeight * 0.06
      const eyeRx = 17 * eyeScale
      const eyeRy = 19.5 * eyeScale
      const tilt = f.eyeTilt * 0.1
      const mouthY = cy + 52 + f.mouthHeight * 0.03
      const smile = f.mouthSmile * 0.05
      const hairStyle = Number(f.hairStyle) || 0
      const hat = f.hat

      const eye = (side) =>
        h(
          'g',
          { transform: 'translate(' + (cx + side * eyeX) + ',' + eyeY + ') rotate(' + side * tilt + ')' },
          h('ellipse', { rx: eyeRx + 1.2, ry: eyeRy + 1.2, fill: '#fdfeff', stroke: ink, strokeWidth: 1.3 }),
          h('ellipse', { rx: eyeRx * 0.92, ry: eyeRy * 0.93, fill: 'url(#' + uid + 'iris)' }),
          h('ellipse', { cx: 0, cy: eyeRy * 0.12, rx: eyeRx * 0.48, ry: eyeRy * 0.5, fill: '#1b2140' }),
          h('ellipse', { cx: -eyeRx * 0.22, cy: -eyeRy * 0.4, rx: eyeRx * 0.36, ry: eyeRy * 0.24, fill: '#eaf6ff', opacity: 0.95 }),
          h('circle', { cx: -eyeRx * 0.46, cy: -eyeRy * 0.04, r: eyeRx * 0.19, fill: '#ffffff' }),
          h('circle', { cx: eyeRx * 0.32, cy: eyeRy * 0.44, r: eyeRx * 0.12, fill: '#ffffff', opacity: 0.9 }),
          h('circle', { cx: eyeRx * 0.46, cy: -eyeRy * 0.48, r: eyeRx * 0.07, fill: '#ffffff', opacity: 0.7 }),
          h('path', {
            d: 'M ' + -eyeRx * 1.14 + ' ' + -eyeRy * 0.3 + ' Q 0 ' + -eyeRy * 1.16 + ' ' + eyeRx * 1.14 + ' ' + -eyeRy * 0.18,
            fill: 'none',
            stroke: ink,
            strokeWidth: 4.2 - f.eyeLid * 0.008,
            strokeLinecap: 'round',
          }),
          h('path', {
            d: 'M ' + eyeRx * 0.88 + ' ' + -eyeRy * 0.46 + ' q 5 -5 8 -9',
            fill: 'none',
            stroke: ink,
            strokeWidth: 2.6,
            strokeLinecap: 'round',
          }),
          f.eyeliner > 25
            ? h('path', {
                d: 'M ' + -eyeRx * 1.0 + ' ' + eyeRy * 0.84 + ' Q 0 ' + eyeRy * 1.12 + ' ' + eyeRx * 0.96 + ' ' + eyeRy * 0.68,
                fill: 'none',
                stroke: ink,
                strokeWidth: 1.5,
                opacity: 0.38,
                strokeLinecap: 'round',
              })
            : null,
        )

      // 后发：一整块圆润的披发，到肩部收住
      const backHair = h('path', {
        d:
          'M ' + (cx - rx - 4) + ' ' + (cy - 18) +
          ' C ' + (cx - rx - 16) + ' ' + (cy + 50) + ' ' + (cx - rx - 12) + ' ' + (cy + 100) + ' ' + (cx - rx + 6) + ' ' + (cy + (hairStyle === 5 ? 96 : 128)) +
          ' C ' + (cx - 24) + ' ' + (cy + (hairStyle === 5 ? 68 : 102)) + ' ' + (cx + 24) + ' ' + (cy + (hairStyle === 5 ? 68 : 102)) + ' ' + (cx + rx - 8) + ' ' + (cy + (hairStyle === 5 ? 60 : 92)) +
          ' C ' + (cx + rx + 10) + ' ' + (cy + 76) + ' ' + (cx + rx + 16) + ' ' + (cy + 50) + ' ' + (cx + rx + 4) + ' ' + (cy - 18) +
          ' C ' + (cx + 40) + ' ' + (cy - ry - 22) + ' ' + (cx - 40) + ' ' + (cy - ry - 22) + ' ' + (cx - rx - 4) + ' ' + (cy - 18) + ' Z',
        fill: hairLo,
        stroke: ink,
        strokeWidth: 3.4,
        strokeLinejoin: 'round',
      })

      const twinTails =
        hairStyle === 2 || hairStyle === 7
          ? h('g', null,
              h('path', { d: 'M ' + (cx - rx + 2) + ' ' + (cy + 4) + ' C ' + (cx - rx - 30) + ' ' + (cy + 50) + ' ' + (cx - rx - 24) + ' ' + (cy + 110) + ' ' + (cx - rx + 4) + ' ' + (cy + 136) + ' C ' + (cx - rx + 2) + ' ' + (cy + 90) + ' ' + (cx - rx + 8) + ' ' + (cy + 44) + ' ' + (cx - rx + 22) + ' ' + (cy + 2) + ' Z', fill: hair, stroke: ink, strokeWidth: 3.2, strokeLinejoin: 'round' }),
              h('path', { d: 'M ' + (cx + rx - 2) + ' ' + (cy + 4) + ' C ' + (cx + rx + 30) + ' ' + (cy + 50) + ' ' + (cx + rx + 24) + ' ' + (cy + 110) + ' ' + (cx + rx - 4) + ' ' + (cy + 136) + ' C ' + (cx + rx - 2) + ' ' + (cy + 90) + ' ' + (cx + rx - 8) + ' ' + (cy + 44) + ' ' + (cx + rx - 22) + ' ' + (cy + 2) + ' Z', fill: hair, stroke: ink, strokeWidth: 3.2, strokeLinejoin: 'round' }))
          : null

      const fin = (side) =>
        h(
          'g',
          { transform: 'translate(' + (cx + side * (rx + 2)) + ',' + (cy + 34) + ') scale(' + side + ',1) rotate(10)' },
          h('path', {
            d: 'M 0 0 C 12 -9 26 -2 30 12 C 21 16 9 12 0 5 Z',
            fill: hairHi,
            stroke: ink,
            strokeWidth: 2.8,
            strokeLinejoin: 'round',
          }),
        )

      const head = h('ellipse', { cx: cx, cy: cy, rx: rx, ry: ry, fill: skin, stroke: ink, strokeWidth: 3.4 })

      // 刘海：柔和波浪
      const bangs = h(
        'g',
        null,
        h('path', {
          d:
            'M ' + (cx - rx - 2) + ' ' + (cy - 10) +
            ' C ' + (cx - rx - 12) + ' ' + (cy - ry - 16) + ' ' + (cx + rx + 12) + ' ' + (cy - ry - 16) + ' ' + (cx + rx + 2) + ' ' + (cy - 10) +
            ' Q ' + (cx + rx * 0.82) + ' ' + (cy - 4) + ' ' + (cx + rx * 0.66) + ' ' + (cy - 18) +
            ' Q ' + (cx + rx * 0.48) + ' ' + (cy - 30) + ' ' + (cx + rx * 0.3) + ' ' + (cy - 16) +
            ' Q ' + (cx + rx * 0.12) + ' ' + (cy - 4) + ' ' + (cx - rx * 0.06) + ' ' + (cy - 18) +
            ' Q ' + (cx - rx * 0.24) + ' ' + (cy - 30) + ' ' + (cx - rx * 0.42) + ' ' + (cy - 16) +
            ' Q ' + (cx - rx * 0.6) + ' ' + (cy - 4) + ' ' + (cx - rx * 0.76) + ' ' + (cy - 18) +
            ' Q ' + (cx - rx * 0.9) + ' ' + (cy - 26) + ' ' + (cx - rx - 2) + ' ' + (cy - 10) + ' Z',
          fill: hair,
          stroke: ink,
          strokeWidth: 3.2,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M ' + (cx - rx * 0.34) + ' ' + (cy - ry + 8) + ' q 18 -8 34 -2 q -16 10 -34 2 Z', fill: hairHi, opacity: 0.9 }),
        h('path', { d: 'M ' + (cx + 8) + ' ' + (cy - ry + 4) + ' q 22 -5 34 5 q -20 6 -34 -5 Z', fill: hairHi, opacity: 0.75 }),
        h('path', { d: 'M ' + (cx - rx * 0.8) + ' ' + (cy - ry + 24) + ' q 13 -6 23 0 q -13 8 -23 0 Z', fill: hairHi, opacity: 0.55 }),
      )

      const sideLock = (side) =>
        h('path', {
          d: 'M ' + (cx + side * (rx - 3)) + ' ' + (cy - 16) +
            ' C ' + (cx + side * (rx + 13)) + ' ' + (cy + 34) + ' ' + (cx + side * (rx + 9)) + ' ' + (cy + 74) + ' ' + (cx + side * (rx - 2)) + ' ' + (cy + 96) +
            ' C ' + (cx + side * (rx - 5)) + ' ' + (cy + 58) + ' ' + (cx + side * (rx - 8)) + ' ' + (cy + 18) + ' ' + (cx + side * (rx - 10)) + ' ' + (cy - 16) + ' Z',
          fill: hair,
          stroke: ink,
          strokeWidth: 3.2,
          strokeLinejoin: 'round',
        })

      const ahoge = h('path', {
        d: 'M ' + (cx - 2) + ' ' + (cy - ry - 6) + ' C ' + (cx + 8) + ' ' + (cy - ry - 34) + ' ' + (cx + 38) + ' ' + (cy - ry - 38) + ' ' + (cx + 44) + ' ' + (cy - ry - 18) + ' C ' + (cx + 36) + ' ' + (cy - ry - 28) + ' ' + (cx + 14) + ' ' + (cy - ry - 16) + ' ' + (cx + 8) + ' ' + (cy - ry + 2) + ' Z',
        fill: hair,
        stroke: ink,
        strokeWidth: 2.8,
        strokeLinejoin: 'round',
      })

      // 女仆头饰：一排白色小花边
      const frill =
        hat === 'cap'
          ? h('g', null,
              h('path', {
                d: 'M ' + (cx - 54) + ' ' + (cy - ry + 22) + ' C ' + (cx - 40) + ' ' + (cy - ry - 14) + ' ' + (cx + 40) + ' ' + (cy - ry - 14) + ' ' + (cx + 54) + ' ' + (cy - ry + 22),
                fill: 'none', stroke: '#ffffff', strokeWidth: 12, strokeLinecap: 'round',
              }),
              h('g', { fill: '#ffffff', stroke: '#dbe4f5', strokeWidth: 1.6 },
                [-46, -30, -14, 2, 18, 34, 46].map((dx, i) =>
                  h('circle', { key: i, cx: cx + dx, cy: cy - ry + 8 + Math.abs(dx) * 0.28, r: 6.4 }))))
          : hat === 'beanie'
            ? h('path', {
                d: 'M ' + (cx - 54) + ' ' + (cy - ry + 20) + ' C ' + (cx - 46) + ' ' + (cy - ry - 28) + ' ' + (cx + 46) + ' ' + (cy - ry - 28) + ' ' + (cx + 54) + ' ' + (cy - ry + 20) + ' Z',
                fill: '#7fb3e0', stroke: ink, strokeWidth: 3.2,
              })
            : hat === 'halo'
              ? h('ellipse', { cx: cx, cy: cy - ry - 22, rx: 22, ry: 5, fill: 'none', stroke: '#f4d06f', strokeWidth: 4 })
              : null

      const bowAtSide = h('g', { transform: 'translate(' + (cx + rx - 10) + ',' + (cy + 2) + ')' },
        h('path', { d: 'M 0 0 C -11 -9 -20 -6 -20 2 C -20 10 -11 11 0 0 Z', fill: '#8fc0ea', stroke: ink, strokeWidth: 2.4, strokeLinejoin: 'round' }),
        h('path', { d: 'M 0 0 C 11 -9 20 -6 20 2 C 20 10 11 11 0 0 Z', fill: '#8fc0ea', stroke: ink, strokeWidth: 2.4, strokeLinejoin: 'round' }),
        h('circle', { cx: 0, cy: 1, r: 4, fill: '#5a86c9', stroke: ink, strokeWidth: 1.8 }))

      const bodyTop = cy + ry + 6
      const neck = h('rect', { x: cx - 12, y: cy + ry - 12, width: 24, height: 24, rx: 8, fill: skin, stroke: ink, strokeWidth: 2.8 })
      const body = h('g', null,
        h('path', {
          d: 'M ' + (cx - 52 - f.build * 0.1) + ' 300 C ' + (cx - 50) + ' ' + (bodyTop + 16) + ' ' + (cx - 34) + ' ' + (bodyTop - 2) + ' ' + cx + ' ' + (bodyTop - 2) +
            ' C ' + (cx + 34) + ' ' + (bodyTop - 2) + ' ' + (cx + 50) + ' ' + (bodyTop + 16) + ' ' + (cx + 52 + f.build * 0.1) + ' 300 Z',
          fill: outfit,
          stroke: ink,
          strokeWidth: 3.4,
        }),
        h('path', {
          d: 'M ' + (cx - 20) + ' ' + bodyTop + ' L ' + cx + ' ' + (bodyTop + 28) + ' L ' + (cx + 20) + ' ' + bodyTop +
            ' C ' + (cx + 11) + ' ' + (bodyTop - 6) + ' ' + (cx - 11) + ' ' + (bodyTop - 6) + ' ' + (cx - 20) + ' ' + bodyTop + ' Z',
          fill: '#f7f9ff', stroke: ink, strokeWidth: 2.4, strokeLinejoin: 'round',
        }),
        h('path', { d: 'M ' + (cx - 8) + ' ' + (bodyTop + 6) + ' L ' + cx + ' ' + (bodyTop + 20) + ' L ' + (cx + 8) + ' ' + (bodyTop + 6) + ' L ' + cx + ' ' + (bodyTop + 12) + ' Z', fill: '#2b3350' }),
        h('circle', { cx: cx, cy: bodyTop + 26, r: 3.4, fill: '#9fd0ff', stroke: ink, strokeWidth: 1.6 }),
        h('rect', { x: cx - 60, y: bodyTop + 22, width: 14, height: 40, rx: 7, fill: outfit, stroke: ink, strokeWidth: 3, transform: 'rotate(8 ' + (cx - 53) + ' ' + (bodyTop + 42) + ')' }),
        h('rect', { x: cx + 46, y: bodyTop + 22, width: 14, height: 40, rx: 7, fill: outfit, stroke: ink, strokeWidth: 3, transform: 'rotate(-8 ' + (cx + 53) + ' ' + (bodyTop + 42) + ')' }),
      )

      const browY = eyeY - 28 - f.browHeight * 0.04
      return h(
        'svg',
        { className: 'sc-char-svg', width: size, height: Math.round(size * 1.25), viewBox: '0 0 240 300', role: 'img', 'aria-label': 'character' },
        h(
          'defs',
          null,
          h('linearGradient', { id: uid + 'iris', x1: '0', y1: '0', x2: '0', y2: '1' },
            h('stop', { offset: '0%', stopColor: shade(iris, 46) }),
            h('stop', { offset: '58%', stopColor: iris }),
            h('stop', { offset: '100%', stopColor: shade(iris, -26) })),
        ),
        h(
          'g',
          { transform: 'translate(120,0) scale(' + sx + ',1) translate(-120,0)' },
          twinTails,
          backHair,
          body,
          neck,
          head,
          ahoge,
          h('ellipse', { cx: cx - eyeX - 8, cy: eyeY + 24, rx: 12, ry: 6.5, fill: '#ff9aa8', opacity: f.blush / 100 * 0.5 }),
          h('ellipse', { cx: cx + eyeX + 8, cy: eyeY + 24, rx: 12, ry: 6.5, fill: '#ff9aa8', opacity: f.blush / 100 * 0.5 }),
          eye(-1),
          eye(1),
          h('ellipse', { cx: cx, cy: mouthY - 9, rx: 3.6, ry: 2.2, fill: skinLo, opacity: 0.45 }),
          h('path', {
            d: 'M ' + (cx - 7) + ' ' + mouthY + ' Q ' + (cx - 3.5) + ' ' + (mouthY + 4 + smile) + ' ' + cx + ' ' + mouthY + ' Q ' + (cx + 3.5) + ' ' + (mouthY + 4 + smile) + ' ' + (cx + 7) + ' ' + mouthY,
            fill: 'none', stroke: '#b8564f', strokeWidth: 2.4, strokeLinecap: 'round',
          }),
          bangs,
          sideLock(-1),
          sideLock(1),
          frill,
          bowAtSide,
          fin(-1),
          fin(1),
          f.earring === 'dot' ? h('circle', { cx: cx + rx + 6, cy: eyeY + 24, r: 2.6, fill: '#f4d06f', stroke: ink, strokeWidth: 1.3 }) : null,
        ),
      )
    }

    /** 按画风选渲染器：cartoon = Q 版鲸鱼娘，real = 半写实 */
    function FaceRender(props) {
      const f = normalizeFace(props.face, props.id)
      return f.style === 'real' ? h(FaceSVG, props) : h(ChibiFace, Object.assign({}, props, { face: f }))
    }

    function lipColor(v) {
      const t = Math.max(0, Math.min(100, Number(v) || 0)) / 100
      const a = [214, 120, 112]
      const b = [150, 52, 66]
      const c = a.map((x, i) => Math.round(x + (b[i] - x) * t))
      return 'rgb(' + c.join(',') + ')'
    }

    function shade(hex, amount) {
      const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''))
      if (!m) return hex
      const n = parseInt(m[1], 16)
      const f = (v) => Math.max(0, Math.min(255, v + amount))
      return '#' + [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)].map((v) => v.toString(16).padStart(2, '0')).join('')
    }

    // ───────────────────────── 会议 ─────────────────────────

    /**
     * 会议：纯浏览器 WebRTC 网状直连（≤6 人），relay 只做房间状态和 SDP/ICE 转发。
     * 没有媒体服务器，所以没有时长限制；代价是走 P2P，NAT 太差时需要 TURN。
     */
    const MEET_ICE = [
      { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
      // 以后加 TURN：{ urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' }
    ]

    function openMeeting(opts) {
      const auth = opts.auth
      const onToast = opts.onToast || (() => {})

      if (typeof RTCPeerConnection === 'undefined') {
        onToast('这个浏览器不支持 WebRTC，开不了会')
        return { close() {} }
      }

      let roomId = ''
      let peerId = ''
      let localStream = null
      let camTrack = null
      let sharing = false
      let muted = false
      let camOn = true
      let sse = null
      let closed = false
      const pcs = new Map() // remotePeerId -> { pc, el, name, pending: [] }
      const peers = new Map() // remotePeerId -> { id, name, muted, cam, sharing }

      /* ---------- DOM ---------- */
      const root = document.createElement('div')
      root.style.cssText = [
        'position:fixed', 'display:flex', 'flex-direction:column', 'background:#0e1116',
        'color:#eaf3f6', 'border:1px solid rgba(128,128,128,.45)', 'border-radius:14px',
        'overflow:hidden', 'box-shadow:0 24px 64px rgba(0,0,0,.5)', 'z-index:2147483646',
        'font:13px/1.5 -apple-system,Segoe UI,Microsoft YaHei,sans-serif',
      ].join(';')
      const W0 = Math.min(760, window.innerWidth - 40)
      const H0 = Math.min(540, window.innerHeight - 80)
      let pos = { x: Math.max(16, (window.innerWidth - W0) / 2), y: Math.max(48, (window.innerHeight - H0) / 2) }
      const size = { w: W0, h: H0 }

      const head = document.createElement('div')
      head.style.cssText =
        'display:flex;align-items:center;gap:8px;padding:9px 12px;background:rgba(255,255,255,.05);border-bottom:1px solid rgba(128,128,128,.25);cursor:move;user-select:none'
      const titleEl = document.createElement('strong')
      titleEl.textContent = '📹 会议'
      titleEl.style.cssText = 'font-size:13px'
      const codeEl = document.createElement('span')
      codeEl.style.cssText = 'font-size:11px;opacity:.6;font-family:ui-monospace,Consolas,monospace'
      const spacer = document.createElement('span')
      spacer.style.cssText = 'flex:1'
      const closeBtn = document.createElement('button')
      closeBtn.textContent = '关闭'
      closeBtn.style.cssText =
        'padding:3px 10px;font-size:11px;border-radius:8px;border:1px solid rgba(255,255,255,.3);background:transparent;color:#eaf3f6;cursor:pointer'
      head.append(titleEl, codeEl, spacer, closeBtn)

      const stage = document.createElement('div')
      stage.style.cssText = 'flex:1;min-height:0;display:grid;gap:8px;padding:10px;overflow:auto;grid-template-columns:1fr'

      const tools = document.createElement('div')
      tools.style.cssText =
        'display:flex;align-items:center;justify-content:center;gap:8px;padding:9px 12px;border-top:1px solid rgba(128,128,128,.25);background:rgba(0,0,0,.25)'

      const grip = document.createElement('div')
      grip.style.cssText =
        'position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 50%,rgba(255,255,255,.3) 50%)'

      root.append(head, stage, tools, grip)
      document.body.appendChild(root)

      function paint() {
        root.style.left = pos.x + 'px'
        root.style.top = pos.y + 'px'
        root.style.width = size.w + 'px'
        root.style.height = size.h + 'px'
      }
      paint()

      /* ---------- 小工具 ---------- */
      function btn(text, label, onClick, primary) {
        const b = document.createElement('button')
        b.textContent = text
        if (label) b.title = label
        b.style.cssText =
          'height:32px;min-width:36px;padding:0 12px;border-radius:10px;cursor:pointer;font:inherit;font-size:12.5px;' +
          (primary
            ? 'border:0;background:#247bbf;color:#fff'
            : 'border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.06);color:#eaf3f6')
        b.addEventListener('click', onClick)
        return b
      }

      function tile(id, name, stream, isSelf) {
        const box = document.createElement('div')
        box.style.cssText =
          'position:relative;border-radius:12px;overflow:hidden;background:#000;min-height:120px;display:flex;align-items:center;justify-content:center'
        const v = document.createElement('video')
        v.autoplay = true
        v.playsInline = true
        v.muted = !!isSelf
        v.style.cssText = 'width:100%;height:100%;object-fit:cover'
        if (stream) v.srcObject = stream
        const tag = document.createElement('div')
        tag.style.cssText =
          'position:absolute;left:8px;bottom:8px;padding:2px 8px;border-radius:8px;background:rgba(0,0,0,.55);font-size:11px'
        tag.textContent = name + (isSelf ? '（我）' : '')
        box.append(v, tag)
        stage.appendChild(box)
        return { box, video: v, tag }
      }

      function relayout() {
        const n = stage.children.length
        const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3
        stage.style.gridTemplateColumns = 'repeat(' + cols + ',1fr)'
      }

      /* ---------- 信令 / 媒体 ---------- */
      async function post(path, body) {
        return api(auth.server, path, { method: 'POST', token: auth.token, body })
      }

      function sendSignal(to, data) {
        return post('/api/meet/rooms/' + roomId + '/signal', { from: peerId, to, data }).catch(() => {})
      }

      function pcFor(remote) {
        if (pcs.has(remote)) return pcs.get(remote)
        const entry = { pc: null, el: null, name: '', pending: [], iceTried: 0 }
        const pc = new RTCPeerConnection({ iceServers: MEET_ICE })
        entry.pc = pc
        pc.onicecandidate = (e) => {
          if (e.candidate) sendSignal(remote, { type: 'ice', candidate: e.candidate })
        }
        pc.ontrack = (e) => {
          const stream = e.streams && e.streams[0]
          if (!stream) return
          if (!entry.el) {
            entry.el = tile(remote, entry.name || '好友', stream, false)
            relayout()
          } else {
            entry.el.video.srcObject = stream
          }
        }
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed') {
            const p = peers.get(remote)
            if (p) p.failed = true
            refreshTags()
          }
        }
        if (localStream) for (const t of localStream.getTracks()) pc.addTrack(t, localStream)
        pcs.set(remote, entry)
        return entry
      }

      function refreshTags() {
        for (const [id, entry] of pcs) {
          const p = peers.get(id)
          if (!entry.el) continue
          const flags = []
          if (p && p.muted) flags.push('🔇')
          if (p && p.sharing) flags.push('🖥')
          if (p && p.failed) flags.push('⚠ 可能需要对端 TURN')
          entry.el.tag.textContent = (entry.name || (p && p.name) || '好友') + (flags.length ? ' ' + flags.join(' ') : '')
        }
      }

      async function makeOffer(remote) {
        const entry = pcFor(remote)
        const offer = await entry.pc.createOffer()
        await entry.pc.setLocalDescription(offer)
        await sendSignal(remote, { type: 'offer', sdp: offer.sdp })
      }

      async function onSignal(from, data) {
        if (!data || !data.type) return
        const entry = pcFor(from)
        const pc = entry.pc
        try {
          if (data.type === 'offer') {
            await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp })
            for (const c of entry.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {})
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            await sendSignal(from, { type: 'answer', sdp: answer.sdp })
          } else if (data.type === 'answer') {
            await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp })
            for (const c of entry.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {})
          } else if (data.type === 'ice') {
            if (pc.remoteDescription && pc.remoteDescription.type) {
              await pc.addIceCandidate(data.candidate).catch(() => {})
            } else {
              entry.pending.push(data.candidate)
            }
          }
        } catch (e) {
          console.error('[meet] 处理信令失败', e)
        }
      }

      function dropPeer(id) {
        const entry = pcs.get(id)
        if (entry) {
          try {
            entry.pc.close()
          } catch (e) {}
          if (entry.el && entry.el.box.parentNode) entry.el.box.parentNode.removeChild(entry.el.box)
          pcs.delete(id)
          relayout()
        }
        peers.delete(id)
        renderToolbar()
      }

      function upsertPeer(p) {
        peers.set(p.id, p)
        const entry = pcs.get(p.id)
        if (entry) entry.name = p.name
        refreshTags()
      }

      /* ---------- SSE ---------- */
      function openStream() {
        const url =
          String(auth.server).replace(/\/+$/, '') +
          '/api/meet/rooms/' + roomId + '/events?peer=' + encodeURIComponent(peerId) +
          '&token=' + encodeURIComponent(auth.token)
        sse = new EventSource(url)
        sse.addEventListener('snapshot', async (e) => {
          const d = JSON.parse(e.data)
          peers.clear()
          for (const p of d.room.peers) if (p.id !== peerId) upsertPeer(p)
          titleEl.textContent = '📹 ' + (d.room.title || '会议')
          for (const p of d.room.peers) {
            if (p.id === peerId) continue
            if (!pcs.has(p.id)) makeOffer(p.id)
          }
          renderToolbar()
        })
        sse.addEventListener('peer-joined', (e) => {
          const d = JSON.parse(e.data)
          if (d.peer && d.peer.id !== peerId) {
            upsertPeer(d.peer)
            if (!d.peer.el) tile(d.peer.id, d.peer.name || '好友', null, false)
            relayout()
          }
        })
        sse.addEventListener('peer-left', (e) => {
          const d = JSON.parse(e.data)
          if (d.peerId) dropPeer(d.peerId)
        })
        sse.addEventListener('peer-state', (e) => {
          const d = JSON.parse(e.data)
          if (d.peer) upsertPeer(d.peer)
        })
        sse.addEventListener('signal', (e) => {
          const d = JSON.parse(e.data)
          if (d.from) onSignal(d.from, d.data)
        })
        sse.addEventListener('error', () => {
          if (closed) return
          /* EventSource 自己会重连（relay 里 retry: 3000） */
        })
      }

      async function publishState() {
        if (!roomId || !peerId) return
        await post('/api/meet/rooms/' + roomId + '/state', {
          peerId,
          muted,
          cam: camOn,
          sharing,
        }).catch(() => {})
      }

      /* ---------- 工具栏 ---------- */
      function renderToolbar() {
        tools.textContent = ''
        if (!roomId) {
          tools.append(btn('＋ 新建会议', '开一个房间', () => startMeeting('create'), true))
          const input = document.createElement('input')
          input.placeholder = '房间号'
          input.style.cssText =
            'height:32px;width:110px;padding:0 10px;border-radius:10px;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.06);color:inherit;font:inherit;outline:none'
          const go = btn('加入', '加入会议', () => startMeeting('join', input.value.trim()), true)
          tools.append(input, go)
          return
        }
        tools.append(
          btn(muted ? '🔇 已静音' : '🎤 麦克风', '切换麦克风', () => {
            if (!localStream) return
            muted = !muted
            for (const t of localStream.getAudioTracks()) t.enabled = !muted
            publishState()
            renderToolbar()
          }),
          btn(camOn ? '🎥 摄像头' : '🎥 已关', '切换摄像头', () => {
            const t = localStream && localStream.getVideoTracks()[0]
            if (!t) return
            camOn = !camOn
            t.enabled = camOn
            publishState()
            renderToolbar()
          }),
          btn(sharing ? '🖥 停止共享' : '🖥 共享屏幕', '共享屏幕', toggleShare),
          btn('📋 ' + roomId, '复制房间号', () => {
            navigator.clipboard && navigator.clipboard.writeText(roomId).then(
              () => onToast('房间号已复制：' + roomId),
              () => onToast('房间号：' + roomId),
            )
          }),
          btn('🚪 离开', '离开会议', leave, true),
        )
      }

      async function toggleShare() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
          onToast('这个浏览器不支持屏幕共享')
          return
        }
        if (sharing) {
          stopShare()
          return
        }
        try {
          const ds = await navigator.mediaDevices.getDisplayMedia({ video: true })
          const track = ds.getVideoTracks()[0]
          sharing = true
          const self = [...stage.children][0]
          for (const [, entry] of pcs) {
            const sender = entry.pc.getSenders().find((s) => s.track && s.track.kind === 'video')
            if (sender) await sender.replaceTrack(track)
          }
          track.onended = stopShare
          if (self) self.querySelector('video').srcObject = new MediaStream([track])
          publishState()
          renderToolbar()
        } catch (e) {
          onToast('共享屏幕被取消或失败')
        }
      }

      function stopShare() {
        sharing = false
        const t = localStream && localStream.getVideoTracks()[0]
        for (const [, entry] of pcs) {
          const sender = entry.pc.getSenders().find((s) => s.track && s.track.kind === 'video')
          if (sender && t) sender.replaceTrack(t).catch(() => {})
        }
        const self = [...stage.children][0]
        if (self && localStream) self.querySelector('video').srcObject = localStream
        publishState()
        renderToolbar()
      }

      /* ---------- 进出房间 ---------- */
      async function ensureMedia() {
        if (localStream) return
        if (opts.audioOnly) {
          // KTV：只要麦克风，别开摄像头
          localStream = await navigator.mediaDevices.getUserMedia({ audio: true })
          camOn = false
          tile('self', '我', localStream, true)
          relayout()
          renderToolbar()
          return
        }
        try {
          localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: { width: { ideal: 640 }, height: { ideal: 480 } },
          })
          camOn = true
        } catch (e) {
          try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true })
            camOn = false
            onToast('摄像头不可用，先只开麦克风')
          } catch (e2) {
            throw new Error('拿不到麦克风/摄像头：' + ((e2 && e2.message) || e2))
          }
        }
        tile('self', '我', localStream, true)
        relayout()
      }

      async function startMeeting(mode, code) {
        try {
          await ensureMedia()
        } catch (e) {
          alert(String(e.message || e))
          return
        }
        try {
          let room
          if (mode === 'create') {
            const r = await post('/api/meet/rooms', { title: (auth.displayName || auth.id) + ' 的会议' })
            room = r.room
          }
          if (mode === 'join' || mode === 'create') {
            const id = mode === 'create' ? room.id : String(code || '')
            if (!id) return
            const j = await post('/api/meet/rooms/' + id + '/join', { name: auth.displayName || auth.id })
            roomId = id
            peerId = j.peerId
            codeEl.textContent = '房间号 ' + roomId + '（发给好友就能进）'
            titleEl.textContent = '📹 ' + (j.room.title || '会议')
            openStream()
            renderToolbar()
          }
        } catch (e) {
          alert('进不去：' + friendly(e))
        }
      }

      // KTV 用：带房间号直接进，不用再点「加入」
      if (opts.roomId) {
        window.setTimeout(() => {
          startMeeting('join', String(opts.roomId)).catch(() => {})
        }, 250)
      }

      async function leave() {
        if (closed) return
        closed = true
        try {
          if (sse) sse.close()
        } catch (e) {}
        sse = null
        if (roomId && peerId) {
          await post('/api/meet/rooms/' + roomId + '/leave', { peerId }).catch(() => {})
        }
        for (const [, entry] of pcs) {
          try {
            entry.pc.close()
          } catch (e) {}
        }
        pcs.clear()
        if (localStream) {
          for (const t of localStream.getTracks()) t.stop()
          localStream = null
        }
        if (root.parentNode) root.parentNode.removeChild(root)
        onToast('已离开会议')
      }

      /* ---------- 窗口交互 ---------- */
      closeBtn.addEventListener('click', leave)
      head.addEventListener('pointerdown', (e) => {
        if (e.target && e.target.closest && e.target.closest('button')) return
        if (e.button !== 0) return
        e.preventDefault()
        const start = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y }
        const move = (ev) => {
          pos = {
            x: Math.min(Math.max(0, start.x + ev.clientX - start.px), Math.max(0, window.innerWidth - 120)),
            y: Math.min(Math.max(0, start.y + ev.clientY - start.py), Math.max(0, window.innerHeight - 80)),
          }
          paint()
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      })
      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const start = { px: e.clientX, py: e.clientY, w: size.w, h: size.h }
        const move = (ev) => {
          size.w = Math.max(420, Math.min(start.w + ev.clientX - start.px, window.innerWidth - 20))
          size.h = Math.max(320, Math.min(start.h + ev.clientY - start.py, window.innerHeight - 20))
          paint()
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      })
      const onKey = (e) => {
        if (e.key === 'Escape') leave()
      }
      window.addEventListener('keydown', onKey)

      renderToolbar()
      return { close: leave }
    }

    // ───────────────────────── 入口 ─────────────────────────

    /* ---------- KTV ---------- */
    /**
     * 房间里的伴奏同步：服务端存锚点（第几秒、是否在放、锚点时刻），
     * 客户端只用自己的本地时间差推算该播到哪，偶发漂移超过 0.45 秒才校正，
     * 这样既不会各唱各的，也不会因为网络抖动一直卡。
     */
    function openKtv(opts) {
      const auth = opts.auth
      const onToast = opts.onToast || (() => {})
      const target = opts.target || ''

      const B =
        'padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:inherit;font-size:12px;cursor:pointer;white-space:nowrap'
      const IN =
        'flex:1;min-width:0;padding:6px 9px;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.04);color:inherit;font-size:12px'

      const wrap = document.createElement('div')
      wrap.style.cssText = [
        'position:fixed',
        'right:18px',
        'bottom:18px',
        'width:400px',
        'max-width:calc(100vw - 20px)',
        'height:540px',
        'max-height:calc(100vh - 30px)',
        'z-index:2147483646',
        'display:flex',
        'flex-direction:column',
        'overflow:hidden',
        'border-radius:16px',
        'background:#1b1d22',
        'color:#e8eaed',
        'border:1px solid rgba(255,255,255,.12)',
        'box-shadow:0 24px 60px rgba(0,0,0,.5)',
        'font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif',
      ].join(';')

      wrap.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.1)">' +
        '<b style="font-size:14px">🎤 KTV</b>' +
        '<span data-code style="opacity:.6;font-size:12px"></span>' +
        '<span style="flex:1"></span>' +
        '<button data-close style="' +
        B +
        '">✕</button>' +
        '</div>' +
        '<div style="padding:10px 12px;display:flex;flex-direction:column;gap:8px;overflow:auto;flex:1">' +
        '<div style="display:flex;gap:6px">' +
        '<input data-room placeholder="房间号" style="' +
        IN +
        '">' +
        '<button data-join style="' +
        B +
        '">加入</button>' +
        '<button data-create style="' +
        B +
        '">建房</button>' +
        '</div>' +
        '<div style="display:flex;gap:6px;align-items:center">' +
        '<button data-upload style="' +
        B +
        '">＋ 上传伴奏</button>' +
        '<span data-hint style="opacity:.55;font-size:11px">mp3 / m4a / wav，≤50 MB</span>' +
        '</div>' +
        '<div data-tracks style="display:flex;flex-direction:column;gap:3px"></div>' +
        '</div>' +
        '<div style="border-top:1px solid rgba(255,255,255,.1);padding:10px 12px">' +
        '<div data-now style="font-size:12px;opacity:.75;margin-bottom:6px">还没选伴奏</div>' +
        '<input data-seek type="range" min="0" max="1000" value="0" style="width:100%;accent-color:#5aa9e6">' +
        '<div style="display:flex;gap:6px;align-items:center;margin-top:6px">' +
        '<button data-play style="' +
        B +
        '">▶ 播放</button>' +
        '<span data-time style="font-size:11px;opacity:.65">0:00 / 0:00</span>' +
        '<span style="flex:1"></span>' +
        '<button data-mic style="' +
        B +
        '">🎙 开麦</button>' +
        '<button data-share style="' +
        B +
        '">发到群里</button>' +
        '</div>' +
        '</div>'

      document.body.appendChild(wrap)
      attachScaler(wrap, 'ktv')
      attachDragger(wrap, 'ktv')

      const $ = (s) => wrap.querySelector(s)
      const codeEl = $('[data-code]')
      const hintEl = $('[data-hint]')
      const tracksEl = $('[data-tracks]')
      const nowEl = $('[data-now]')
      const seekEl = $('[data-seek]')
      const timeEl = $('[data-time]')
      const playBtn = $('[data-play]')

      let roomId = ''
      let tracks = []
      let current = null
      let sync = { playing: false, pos: 0, t0: 0 }
      let closeTimer = null
      let tickTimer = null
      let seekBusy = false

      const audio = new Audio()
      audio.preload = 'auto'
      audio.crossOrigin = 'anonymous'

      const fmt = (s) => {
        const n = Math.max(0, Math.floor(Number(s) || 0))
        return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0')
      }

      const setHint = (t) => {
        hintEl.textContent = t
      }

      const renderTracks = () => {
        tracksEl.textContent = ''
        if (!tracks.length) {
          const d = document.createElement('div')
          d.style.cssText = 'opacity:.5;font-size:12px;padding:6px 2px'
          d.textContent = '伴奏库是空的，先上传一首'
          tracksEl.appendChild(d)
          return
        }
        for (const t of tracks) {
          const row = document.createElement('div')
          row.style.cssText =
            'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer;' +
            (current && current.id === t.id ? 'background:rgba(90,169,230,.22)' : 'background:rgba(255,255,255,.04)')
          const name = document.createElement('div')
          name.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
          name.textContent = '♪ ' + t.title + (t.artist ? ' — ' + t.artist : '')
          name.title = (t.title || '') + ' · ' + (t.by || '')
          row.appendChild(name)
          row.addEventListener('click', () => choose(t))
          tracksEl.appendChild(row)
        }
      }

      const loadTracks = async () => {
        try {
          const r = await api(auth.server, '/api/ktv/tracks', { token: auth.token })
          tracks = r.tracks || []
          renderTracks()
        } catch (e) {
          setHint('伴奏库读取失败')
        }
      }

      const postKtv = async (patch) => {
        if (!roomId) {
          onToast('先建房或加入房间')
          return
        }
        try {
          const body = {
            trackId: current ? current.id : '',
            playing: sync.playing,
            position: sync.playing ? sync.pos + (performance.now() - sync.t0) / 1000 : sync.pos,
            ...patch,
          }
          const r = await api(auth.server, '/api/meet/rooms/' + roomId + '/ktv', {
            method: 'POST',
            token: auth.token,
            body,
          })
          applySync(r.ktv)
        } catch (e) {
          onToast('同步失败：' + friendly(e))
        }
      }

      const applySync = (ktv) => {
        if (!ktv || !ktv.trackId) return
        const t = tracks.find((x) => x.id === ktv.trackId)
        if (t && (!current || current.id !== t.id)) {
          current = t
          audio.src = auth.server + t.url
          renderTracks()
        }
        sync = { playing: !!ktv.playing, pos: Number(ktv.elapsed) || 0, t0: performance.now() }
        nowEl.textContent = current ? '正在放：' + current.title : '还没选伴奏'
        playBtn.textContent = sync.playing ? '⏸ 暂停' : '▶ 播放'
      }

      const tick = () => {
        if (!current) return
        const pos = sync.playing ? sync.pos + (performance.now() - sync.t0) / 1000 : sync.pos
        const dur = Number.isFinite(audio.duration) ? audio.duration : 0
        if (dur > 0 && !seekBusy) {
          seekEl.value = String(Math.round((pos / dur) * 1000))
          timeEl.textContent = fmt(pos) + ' / ' + fmt(dur)
        }
        if (sync.playing) {
          if (audio.paused) audio.play().catch(() => {})
          if (dur > 0 && Math.abs(audio.currentTime - pos) > 0.45) audio.currentTime = Math.min(pos, dur - 0.05)
        } else if (!audio.paused) {
          audio.pause()
          if (dur > 0) audio.currentTime = Math.min(pos, dur - 0.05)
        }
      }

      const choose = (t) => {
        current = t
        sync = { playing: false, pos: 0, t0: performance.now() }
        audio.src = auth.server + t.url
        renderTracks()
        nowEl.textContent = '正在放：' + t.title
        playBtn.textContent = '▶ 播放'
        if (roomId) postKtv({ trackId: t.id, playing: false, position: 0 })
      }

      const joinRoom = async (id) => {
        if (!id) return
        try {
          const r = await api(auth.server, '/api/meet/rooms/' + id, { token: auth.token })
          roomId = id
          codeEl.textContent = '房间 ' + id
          applySync(r.room && r.room.ktv)
          onToast('已进入 KTV 房间 ' + id)
        } catch (e) {
          onToast('房间不存在：' + id)
        }
      }

      const refresh = async () => {
        if (!roomId) return
        try {
          const r = await api(auth.server, '/api/meet/rooms/' + roomId, { token: auth.token })
          const ktv = r.room && r.room.ktv
          if (ktv && ktv.trackId) {
            const same = current && current.id === ktv.trackId
            const drift = Math.abs((Number(ktv.elapsed) || 0) - (sync.playing ? sync.pos + (performance.now() - sync.t0) / 1000 : sync.pos))
            if (!same || ktv.playing !== sync.playing || drift > 0.6) applySync(ktv)
          }
        } catch (e) {
          /* 房间没了就算了 */
        }
      }

      const upload = async (file) => {
        if (!file) return
        setHint('上传中…')
        try {
          const buf = await file.arrayBuffer()
          const res = await fetch(auth.server + '/api/upload', {
            method: 'POST',
            headers: {
              authorization: 'Bearer ' + auth.token,
              'content-type': file.type || 'application/octet-stream',
              'x-filename': encodeURIComponent(file.name || '伴奏'),
            },
            body: buf,
          })
          const up = await res.json().catch(() => null)
          if (!res.ok || !up) {
            setHint(up && up.error === 'too-large' ? '文件太大（≤50 MB）' : '上传失败')
            return
          }
          const title = String(file.name || '伴奏').replace(/\.[^.]+$/, '')
          await api(auth.server, '/api/ktv/tracks', {
            method: 'POST',
            token: auth.token,
            body: { uploadId: up.id, title },
          })
          setHint('已加入伴奏库')
          await loadTracks()
        } catch (e) {
          setHint('上传失败：' + friendly(e))
        }
      }

      /* 事件绑定 */
      $('[data-close]').addEventListener('click', () => {
        window.clearInterval(tickTimer)
        window.clearInterval(closeTimer)
        try {
          audio.pause()
          audio.src = ''
        } catch (e) {}
        wrap.remove()
      })
      $('[data-join]').addEventListener('click', () => joinRoom(String($('[data-room]').value || '').trim()))
      $('[data-create]').addEventListener('click', async () => {
        try {
          const r = await api(auth.server, '/api/meet/rooms', {
            method: 'POST',
            token: auth.token,
            body: { title: (auth.displayName || auth.id) + ' 的 KTV' },
          })
          await joinRoom(r.room.id)
        } catch (e) {
          onToast('建房失败：' + friendly(e))
        }
      })
      $('[data-upload]').addEventListener('click', () => {
        const inp = document.createElement('input')
        inp.type = 'file'
        inp.accept = 'audio/*'
        inp.addEventListener('change', () => {
          const f = inp.files && inp.files[0]
          if (f) upload(f)
        })
        inp.click()
      })
      playBtn.addEventListener('click', () => {
        if (!current) {
          onToast('先选一首伴奏')
          return
        }
        postKtv({ playing: !sync.playing })
      })
      seekEl.addEventListener('input', () => {
        seekBusy = true
      })
      seekEl.addEventListener('change', () => {
        seekBusy = false
        const dur = Number.isFinite(audio.duration) ? audio.duration : 0
        if (dur > 0) postKtv({ position: (Number(seekEl.value) / 1000) * dur })
      })
      $('[data-mic]').addEventListener('click', () => {
        if (!roomId) {
          onToast('先建房或加入房间')
          return
        }
        openMeeting({ auth, roomId, audioOnly: true, onToast })
      })
      $('[data-share]').addEventListener('click', async () => {
        if (!roomId) {
          onToast('先建房或加入房间')
          return
        }
        if (!target) {
          onToast('先在左边选一个群')
          return
        }
        try {
          await api(auth.server, '/api/messages', {
            method: 'POST',
            token: auth.token,
            body: { to: target, text: '🎤 来唱K！房间号 ' + roomId + '（点右上「KTV」→ 加入）' },
          })
          onToast('已发到群里')
        } catch (e) {
          onToast('发送失败：' + friendly(e))
        }
      })

      loadTracks()
      tickTimer = window.setInterval(tick, 400)
      closeTimer = window.setInterval(refresh, 2000)

      return { close: () => wrap.remove() }
    }

    /* ---------- 桌宠：形象独立挂在 UI 上 ---------- */
    const K_PET = 'dsh-share-chat.pet'
    const PET_ID = 'dsh-share-chat-pet'

    function PetWidget() {
      const [face, setFace] = useState(() => readMyCharacter())
      const [pos, setPos] = useState(() => {
        const p = readJson(K_PET)
        return p && typeof p.x === 'number' ? p : { x: null, y: null, hidden: false }
      })
      const [menu, setMenu] = useState(false)
      const dragRef = useRef(null)
      const nodeRef = useRef(null)

      // 设置页换了形象，这里跟上
      useEffect(() => {
        const t = window.setInterval(() => {
          const next = readMyCharacter()
          setFace((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
        }, 1500)
        return () => window.clearInterval(t)
      }, [])

      useEffect(() => {
        writeJson(K_PET, pos)
      }, [pos])

      // 从聊天里点 🐳 把它叫回来
      useEffect(() => {
        const show = () => setPos((p) => Object.assign({}, p, { hidden: false }))
        window.addEventListener('dsh-share-chat:pet-show', show)
        return () => window.removeEventListener('dsh-share-chat:pet-show', show)
      }, [])

      if (pos.hidden) return null

      const startDrag = (e) => {
        const el = nodeRef.current
        if (!el) return
        const r = el.getBoundingClientRect()
        dragRef.current = {
          dx: e.clientX - r.left,
          dy: e.clientY - r.top,
          sx: e.clientX,
          sy: e.clientY,
          moved: false,
          captured: false,
        }
      }
      const onMove = (e) => {
        const d = dragRef.current
        if (!d) return
        if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 4) d.moved = true
        if (!d.moved) return
        // 真的开始拖了才捕获指针；一按下就捕获会把按钮的 click 吃掉
        if (!d.captured) {
          d.captured = true
          try {
            nodeRef.current.setPointerCapture(e.pointerId)
          } catch (err) {}
        }
        setPos((p) => ({
          ...p,
          x: Math.max(2, Math.min(window.innerWidth - 66, e.clientX - d.dx)),
          y: Math.max(2, Math.min(window.innerHeight - 82, e.clientY - d.dy)),
        }))
      }
      const onUp = () => {
        const d = dragRef.current
        dragRef.current = null
        if (d && !d.moved) setMenu((v) => !v)
      }

      const style = {
        position: 'fixed',
        zIndex: 2147483000,
        width: '60px',
        height: '74px',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        cursor: 'grab',
        userSelect: 'none',
        touchAction: 'none',
        filter: 'drop-shadow(0 6px 10px rgba(0,0,0,.28))',
      }
      if (pos.x === null) {
        style.right = '22px'
        style.bottom = '92px'
      } else {
        style.left = pos.x + 'px'
        style.top = pos.y + 'px'
      }

      const bubble = {
        position: 'absolute',
        bottom: '100%',
        right: 0,
        marginBottom: '6px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '6px',
        borderRadius: '10px',
        background: 'rgba(28,30,34,.92)',
        border: '1px solid rgba(255,255,255,.16)',
        boxShadow: '0 10px 24px rgba(0,0,0,.35)',
      }
      const bstyle = {
        padding: '5px 10px',
        borderRadius: '7px',
        border: '1px solid rgba(255,255,255,.18)',
        background: 'rgba(255,255,255,.08)',
        color: '#e8eaed',
        fontSize: '12px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }

      return h(
        'div',
        {
          ref: nodeRef,
          style,
          title: '点一下有菜单，按住可以拖走',
          onPointerDown: startDrag,
          onPointerMove: onMove,
          onPointerUp: onUp,
          onPointerCancel: onUp,
        },
        menu
          ? h(
              'div',
              { style: bubble },
              h(
                'button',
                {
                  style: bstyle,
                  onPointerDown: (e) => e.stopPropagation(),
                  onClick: (e) => {
                    e.stopPropagation()
                    const next = randomCharacter(face)
                    setFace(next)
                    writeJson(K_CHARACTER, next)
                  },
                },
                '换形象',
              ),
              h(
                'button',
                {
                  style: bstyle,
                  onPointerDown: (e) => e.stopPropagation(),
                  onClick: (e) => {
                    e.stopPropagation()
                    setMenu(false)
                    setPos((p) => Object.assign({}, p, { hidden: true }))
                    try {
                      writeJson(K_PET, Object.assign({}, pos, { hidden: true }))
                    } catch (err) {}
                  },
                },
                '藏起来',
              ),
            )
          : null,
        h('div', { className: 'sc-pet-bob' }, h(Character, { face, size: 56 })),
      )
    }

    /** 挂到 document.body 上，不跟着任何面板卸载；拿不到 react-dom 就退化 */
    function mountPet() {
      if (typeof document === 'undefined') return () => {}
      if (document.getElementById(PET_ID)) return () => {}
      const host = document.createElement('div')
      host.id = PET_ID
      document.body.appendChild(host)

      const css = document.createElement('style')
      css.id = PET_ID + '-css'
      css.textContent =
        '@keyframes sc-pet-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}' +
        '.sc-pet-bob{animation:sc-pet-bob 2.6s ease-in-out infinite}'
      document.head.appendChild(css)

      let root = null
      try {
        const rd = require('react-dom/client')
        if (rd && rd.createRoot) {
          root = rd.createRoot(host)
          root.render(h(PetWidget))
        }
      } catch (e) {
        root = null
      }

      if (!root) {
        host.textContent = '🐳'
        host.title = '拿不到 react-dom，先放个占位'
        host.style.cssText =
          'position:fixed;right:22px;bottom:92px;z-index:2147483000;font-size:44px;cursor:default;user-select:none;filter:drop-shadow(0 6px 10px rgba(0,0,0,.28))'
      }

      return () => {
        try {
          if (root) root.unmount()
        } catch (e) {}
        host.remove()
        css.remove()
      }
    }

    /* ---------- 麻将 ---------- */
    const MJ_SUITS = ['万', '条', '筒']
    const MJ_RANKS = ['一', '二', '三', '四', '五', '六', '七', '八', '九']
    const MJ_SUIT_COLOR = ['#c0392b', '#1e8449', '#1f5fa8']

    function mjShort(t) {
      return String((t % 9) + 1) + MJ_SUITS[Math.floor(t / 9)]
    }

    /** 一张牌：图片存在就用图（<kind>.png），没有就显示文字 */
    function mjTileEl(base, t, size, opts) {
      const o = opts || {}
      const w = size || 34
      const el = document.createElement(o.button ? 'button' : 'span')
      el.style.cssText = [
        'position:relative',
        'display:inline-flex',
        'align-items:center',
        'justify-content:center',
        'width:' + w + 'px',
        'height:' + Math.round(w * 1.38) + 'px',
        'border-radius:6px',
        'background:#fffdf7',
        'border:1px solid #e4d9c4',
        'box-shadow:0 2px 0 #e4d9c4,0 3px 8px rgba(0,0,0,.12)',
        'overflow:hidden',
        'flex:0 0 auto',
        'padding:0',
        'font:700 ' + Math.max(10, Math.round(w * 0.4)) + 'px/1 system-ui,sans-serif',
        'color:' + MJ_SUIT_COLOR[Math.floor(t / 9)],
        'cursor:' + (o.onClick ? 'pointer' : 'default'),
        o.selected ? 'outline:3px solid #ff5fa2;outline-offset:1px' : '',
        o.dim ? 'opacity:.5' : '',
      ]
        .filter(Boolean)
        .join(';')
      const txt = document.createElement('span')
      txt.textContent = mjShort(t)
      el.appendChild(txt)
      const img = new Image()
      img.alt = ''
      img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover'
      img.onload = () => {
        txt.style.visibility = 'hidden'
        el.appendChild(img)
      }
      img.src = base + t + '.png'
      if (o.onClick) el.addEventListener('click', o.onClick)
      return el
    }

    function openMahjong(opts) {
      const auth = opts.auth
      const onToast = opts.onToast || (() => {})
      const base = auth.server.replace(/\/+$/, '')
      const tileBase = base + '/mj/'

      const B =
        'padding:6px 10px;border-radius:9px;border:1.5px solid #ffd3e6;background:#fff;color:#5b3a63;font-size:12px;font-weight:650;cursor:pointer'
      const wrap = document.createElement('div')
      wrap.style.cssText = [
        'position:fixed',
        'right:18px',
        'bottom:18px',
        'width:520px',
        'max-width:calc(100vw - 20px)',
        'height:600px',
        'max-height:calc(100vh - 30px)',
        'z-index:2147483646',
        'display:flex',
        'flex-direction:column',
        'border-radius:18px',
        'background:linear-gradient(180deg,#fff8fc,#f4f9ff)',
        'border:2px solid #ffd3e6',
        'box-shadow:0 26px 70px rgba(255,95,162,.28)',
        'font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif',
        'color:#3b2b45',
        'overflow:hidden',
      ].join(';')
      wrap.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:2px solid #ffd9ec">' +
        '<b style="font-size:14px">🀄 麻将</b>' +
        '<span data-room style="font-size:12px;color:#a184b3"></span>' +
        '<span data-score style="font-size:12px;color:#b14a86;font-weight:700"></span>' +
        '<span style="flex:1"></span>' +
        '<button data-close style="' +
        B +
        '">✕</button>' +
        '</div>' +
        '<div data-body style="flex:1;min-height:0;overflow:auto;padding:10px 12px"></div>'
      document.body.appendChild(wrap)
      attachScaler(wrap, 'mahjong')
      attachDragger(wrap, 'mahjong')

      const $ = (s) => wrap.querySelector(s)
      const bodyEl = $('[data-body]')
      const roomEl = $('[data-room]')
      const hint = document.createElement('div')
      hint.style.cssText = 'font-size:11px;color:#b0629a;padding:2px 4px 6px'

      let roomId = ''
      let seat = -1
      let state = null
      let room = null
      let timer = null
      let stopped = false

      const api2 = (m, path, b) =>
        api(auth.server, path, { method: m, token: auth.token, body: b })

      const chip = (t) => {
        const s = document.createElement('span')
        s.textContent = t
        s.style.cssText =
          'font-size:11px;padding:1px 7px;border-radius:99px;background:#ffe3f0;color:#b14a86;border:1px solid #ffd3e6'
        return s
      }

      const btn = (t, fn, primary) => {
        const b = document.createElement('button')
        b.textContent = t
        b.style.cssText = primary
          ? 'padding:7px 14px;border-radius:10px;border:none;background:linear-gradient(135deg,#ff5fa2,#a86bff);color:#fff;font-size:12.5px;font-weight:700;cursor:pointer;box-shadow:0 6px 16px rgba(255,95,162,.3)'
          : B
        b.addEventListener('click', fn)
        return b
      }

      /* ---------- 大厅 ---------- */
      const renderLobby = async () => {
        bodyEl.textContent = ''
        roomEl.textContent = ''
        const title = document.createElement('div')
        title.textContent = '开一桌（缺的位置由机器人补）'
        title.style.cssText = 'font-size:12px;color:#a184b3;margin:2px 0 10px'
        bodyEl.appendChild(title)
        bodyEl.appendChild(btn('＋ 新建牌桌', async () => {
          try {
            const r = await api2('POST', '/api/mj/rooms')
            roomId = r.room.id
            seat = 0
            render()
          } catch (e) {
            onToast('建房失败：' + friendly(e))
          }
        }, true))

        const listWrap = document.createElement('div')
        listWrap.style.cssText = 'margin-top:14px;display:flex;flex-direction:column;gap:6px'
        bodyEl.appendChild(listWrap)
        try {
          const r = await api2('GET', '/api/mj/rooms')
          const rooms = (r.rooms || []).filter((x) => !x.ended)
          if (!rooms.length) {
            const e = document.createElement('div')
            e.textContent = '还没有牌桌，点上面新建一个'
            e.style.cssText = 'font-size:12px;color:#b39fc4;padding:6px 2px'
            listWrap.appendChild(e)
          }
          for (const rm of rooms) {
            const row = document.createElement('div')
            row.style.cssText =
              'display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:10px;background:#fff;border:1.5px solid #ffe3f0'
            const t = document.createElement('span')
            t.textContent = '#' + rm.id + (rm.started ? ' · 进行中' : ' · 等人')
            t.style.cssText = 'flex:1;font-size:12px'
            row.appendChild(t)
            row.appendChild(chip(rm.players.filter((p) => p.id).length + '/4'))
            row.appendChild(
              btn('加入', async () => {
                try {
                  const j = await api2('POST', '/api/mj/rooms/' + rm.id + '/join')
                  roomId = rm.id
                  seat = j.seat
                  render()
                } catch (e) {
                  onToast('加入失败：' + friendly(e))
                }
              }),
            )
            listWrap.appendChild(row)
          }
        } catch (e) {
          hint.textContent = '房间列表读取失败'
        }
      }

      /* ---------- 牌桌 ---------- */
      const renderTable = () => {
        bodyEl.textContent = ''
        roomEl.textContent = '房间 ' + roomId
        const s = state
        if (!s) return

        const meInfo = room.players[seat] || { name: '我' }

        // 对家
        const top = document.createElement('div')
        top.style.cssText = 'display:flex;align-items:center;gap:8px;justify-content:center;margin-bottom:8px'
        const opp2 = room.players[2] || { name: '空位' }
        top.appendChild(
          chip(opp2.name + ' · ' + (opp2.score || 0) + '分 · ' + (s.seats[2].handCount || 0) + ' 张'),
        )
        if (s.turn === 2 && !s.ended) top.appendChild(chip('出牌中'))
        bodyEl.appendChild(top)

        // 左右 + 牌河
        const mid = document.createElement('div')
        mid.style.cssText = 'display:flex;gap:8px;align-items:flex-start'
        const side = (i) => {
          const box = document.createElement('div')
          box.style.cssText = 'width:78px;flex:0 0 auto;display:flex;flex-direction:column;gap:4px'
          const p = room.players[i] || { name: '空位' }
          box.appendChild(chip(p.name))
          box.appendChild(chip((p.score || 0) + ' 分'))
          box.appendChild(chip((s.seats[i].handCount || 0) + ' 张'))
          if (s.turn === i && !s.ended) box.appendChild(chip('出牌中'))
          return box
        }
        mid.appendChild(side(3))

        const pool = document.createElement('div')
        pool.style.cssText =
          'flex:1;min-width:0;background:#024d3a;border-radius:12px;padding:6px;display:flex;flex-wrap:wrap;gap:2px;align-content:flex-start;min-height:96px'
        s.discards.forEach((arr, i) => {
          for (const t of arr) {
            const tile = mjTileEl(tileBase, t, 20)
            if (s.lastDiscard && s.lastDiscard.tile === t && i === s.lastDiscard.seat) {
              tile.style.outline = '2px solid #ffcf3d'
            }
            pool.appendChild(tile)
          }
        })
        mid.appendChild(pool)
        mid.appendChild(side(1))
        bodyEl.appendChild(mid)

        // 我的副露
        const melds = document.createElement('div')
        melds.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin:8px 0 4px;min-height:26px'
        for (const m of s.seats[seat].melds || []) {
          const g = document.createElement('div')
          g.style.cssText = 'display:flex;gap:1px'
          const n = m.type === 'gang' ? 4 : 3
          for (let k = 0; k < n; k++) g.appendChild(mjTileEl(tileBase, m.tile, 22))
          melds.appendChild(g)
        }
        bodyEl.appendChild(melds)

        // 顶部状态
        const status = document.createElement('div')
        status.style.cssText = 'display:flex;gap:6px;align-items:center;margin:2px 0 6px'
        status.appendChild(chip('牌墙 ' + s.wallCount))
        status.appendChild(chip(meInfo.name))
        if (s.ended) {
          status.appendChild(
            chip(s.winner === null ? '流局' : (room.players[s.winner] || {}).name + ' 胡了'),
          )
        } else if (s.turn === seat) {
          status.appendChild(chip('轮到你了'))
        }
        bodyEl.appendChild(status)

        // 结算：谁赢谁输，各加减多少分
        if (s.ended && room.deltas) {
          const settleRow = document.createElement('div')
          settleRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin:0 0 8px'
          room.players.forEach((p, i) => {
            const d = room.deltas[i] || 0
            const c = document.createElement('span')
            c.textContent = p.name + ' ' + (d > 0 ? '+' : '') + d
            c.style.cssText =
              'font-size:11.5px;padding:2px 8px;border-radius:99px;border:1px solid ' +
              (d > 0 ? '#3ddc97' : d < 0 ? '#ff5fa2' : '#e4dbe8') +
              ';background:' +
              (d > 0 ? '#e9fbf2' : d < 0 ? '#ffeaf3' : '#faf7fb') +
              ';color:' +
              (d > 0 ? '#12855a' : d < 0 ? '#c0295f' : '#9a8ba6')
            settleRow.appendChild(c)
          })
          bodyEl.appendChild(settleRow)
        }

        // 我的手牌
        const handWrap = document.createElement('div')
        handWrap.style.cssText = 'display:flex;gap:3px;flex-wrap:wrap;margin-bottom:8px'
        const hand = s.seats[seat].hand || []
        for (const t of hand) {
          handWrap.appendChild(
            mjTileEl(tileBase, t, 34, {
              button: true,
              dim: !(s.turn === seat && s.phase === 'discard' && !s.ended),
              onClick:
                s.turn === seat && s.phase === 'discard' && !s.ended
                  ? () => act({ type: 'discard', tile: t })
                  : null,
            }),
          )
        }
        bodyEl.appendChild(handWrap)

        // 操作
        const acts = document.createElement('div')
        acts.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;align-items:center'
        if (!s.ended) {
          for (const op of s.options || []) {
            const label = op === 'hu' ? '胡' : op === 'gang' ? '杠' : '碰'
            acts.appendChild(btn(label, () => act({ type: op }), true))
          }
          if ((s.options || []).length) acts.appendChild(btn('过', () => act({ type: 'pass' })))
          if (s.turn === seat && s.phase === 'discard' && s.seats[seat].drawn !== null) {
            acts.appendChild(btn('自摸', () => act({ type: 'zimo' })))
          }
        } else {
          acts.appendChild(btn('再来一局', () => act({ type: 'restart' }), true))
          acts.appendChild(btn('回大厅', () => {
            state = null
            room = null
            roomId = ''
            seat = -1
            renderLobby()
          }))
        }
        bodyEl.appendChild(acts)
      }

      const render = async () => {
        if (stopped || !roomId) return
        try {
          const r = await api2('GET', '/api/mj/rooms/' + roomId + '/state')
          room = r.room
          seat = r.seat
          state = r.state
          if (room && seat >= 0 && room.players[seat]) {
            $('[data-score]').textContent = '积分 ' + (room.players[seat].score || 0)
          }
          if (!state) renderWaiting()
          else renderTable()
        } catch (e) {
          hint.textContent = '状态读取失败'
        }
      }

      const renderWaiting = () => {
        bodyEl.textContent = ''
        roomEl.textContent = '房间 ' + roomId
        const t = document.createElement('div')
        t.textContent = '等房主开局（房间号 ' + roomId + '，发给朋友就能进）'
        t.style.cssText = 'font-size:12px;color:#a184b3;margin:6px 2px'
        bodyEl.appendChild(t)
        const who = document.createElement('div')
        who.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin:8px 0'
        for (const p of room.players) who.appendChild(chip(p.seat + 1 + ' 号位 ' + p.name))
        bodyEl.appendChild(who)
        if (room.owner === auth.id) {
          bodyEl.appendChild(
            btn('开局', async () => {
              try {
                await api2('POST', '/api/mj/rooms/' + roomId + '/start')
                render()
              } catch (e) {
                onToast('开局失败：' + friendly(e))
              }
            }, true),
          )
        }
      }

      const act = async (payload) => {
        try {
          if (payload.type === 'restart') {
            await api2('POST', '/api/mj/rooms/' + roomId + '/start')
          } else {
            await api2('POST', '/api/mj/rooms/' + roomId + '/act', payload)
          }
          await render()
        } catch (e) {
          onToast('操作失败：' + friendly(e))
        }
      }

      // 只轮询牌桌；大厅不刷，避免列表一直闪
      const tick = async () => {
        if (stopped || !roomId) return
        await render()
      }

      $('[data-close]').addEventListener('click', () => {
        stopped = true
        window.clearInterval(timer)
        wrap.remove()
      })

      renderLobby()
      timer = window.setInterval(tick, 1300)
      return { close: () => wrap.remove() }
    }



    /**
     * 让浮动窗口能用标题栏拖动，位置按窗口分别记在本地。
     * 注意：窗口上有 transform: scale()，getBoundingClientRect 拿到的是缩放后的坐标，
     * 拿它回写 left/top 会形成偏移反馈（越拖越偏左上）。所以全程用未变换的 offsetLeft/Top。
     */
    function attachDragger(el, key) {
      const SK = 'dsh-share-chat.pos.' + key
      const handle = el.firstElementChild
      if (!handle) return
      const place = (x, y) => {
        const w = el.offsetWidth || 200
        x = Math.min(Math.max(-w + 80, x), window.innerWidth - 80)
        y = Math.min(Math.max(0, y), window.innerHeight - 44)
        el.style.left = x + 'px'
        el.style.top = y + 'px'
        el.style.right = 'auto'
        el.style.bottom = 'auto'
      }
      const saved = readJson(SK)
      if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
        place(saved.x, saved.y)
      } else {
        const r = el.getBoundingClientRect()
        const sc = el.__scale || 1
        place(r.left, r.top)
        if (sc !== 1) {
          // 首次接管时把缩放造成的视觉偏移换算回布局坐标
          place(el.offsetLeft, el.offsetTop)
        }
      }

      handle.style.cursor = 'move'
      handle.style.userSelect = 'none'
      handle.addEventListener('mousedown', (e) => {
        if (e.target && e.target.closest && e.target.closest('button')) return
        e.preventDefault()
        const startX = el.offsetLeft
        const startY = el.offsetTop
        const mx = e.clientX
        const my = e.clientY
        const move = (ev) => {
          const sc = el.__scale || 1
          place(startX + (ev.clientX - mx) / sc, startY + (ev.clientY - my) / sc)
        }
        const up = () => {
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
          writeJson(SK, { x: el.offsetLeft, y: el.offsetTop })
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      })
    }

    /** 给浮动窗口加一个等比缩放手柄（右下角），比例按窗口分别记在本地 */
    function attachScaler(el, key) {
      const SK = 'dsh-share-chat.scale.' + key
      let scale = Number(readJson(SK)) || 1
      if (!(scale >= 0.6 && scale <= 1.6)) scale = 1
      el.style.transformOrigin = 'bottom right'
      const apply = () => {
        el.__scale = scale
        el.style.transform = scale === 1 ? '' : 'scale(' + scale.toFixed(3) + ')'
      }
      apply()
      const h = document.createElement('div')
      h.title = '拖动改变大小'
      h.style.cssText =
        'position:absolute;right:2px;bottom:2px;width:14px;height:14px;cursor:nwse-resize;' +
        'border-radius:3px;background:rgba(0,0,0,.10);z-index:2147483647'
      el.appendChild(h)
      h.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const sx = e.clientX
        const sy = e.clientY
        const start = scale
        const move = (ev) => {
          const d = ev.clientX - sx + (ev.clientY - sy)
          scale = Math.min(1.6, Math.max(0.6, start + d / 500))
          apply()
        }
        const up = () => {
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
          writeJson(SK, scale)
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      })
    }

    /* ---------- 每日杀手数独 ---------- */
    /* ---------- 每日杀手数独 ---------- */
    function openKiller(opts) {
      const auth = opts.auth
      const onToast = opts.onToast || (() => {})

      // 组合枚举：从 1..9 里挑 n 个数，和等于 s
      const combos = (s, n) => {
        const out = []
        const cur = []
        const go = (start, left, sum) => {
          if (left === 0) {
            if (sum === s) out.push(cur.slice())
            return
          }
          for (let d = start; d <= 9; d++) {
            if (sum + d > s) break
            if (sum + d + ((left - 1) * (d + 1 + (d + left - 1))) / 2 > s + 0.5) {
              /* 粗略上界剪枝，交给下面继续 */
            }
            cur.push(d)
            go(d + 1, left - 1, sum + d)
            cur.pop()
          }
        }
        if (n > 0 && n <= 9) go(1, n, 0)
        return out
      }

      const wrap = document.createElement('div')
      wrap.style.cssText = [
        'position:fixed', 'right:18px', 'bottom:18px', 'width:820px', 'max-width:calc(100vw - 16px)',
        'height:640px', 'max-height:calc(100vh - 24px)', 'z-index:2147483646', 'display:flex', 'flex-direction:column',
        'border-radius:16px', 'background:#fbfcfe', 'border:2px solid #dbe4f0',
        'box-shadow:0 24px 60px rgba(30,50,90,.28)',
        'font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif', 'color:#1f2a37', 'overflow:hidden',
      ].join(';')
      wrap.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #e3eaf4;flex:0 0 auto">' +
        '<b style="font-size:14px">🧩 杀手数独</b>' +
        '<span data-day style="font-size:12px;color:#7b8ca6"></span>' +
        '<span data-stars style="font-size:12px;color:#d99a1f;font-weight:600"></span>' +
        '<button data-shop style="padding:4px 9px;border-radius:8px;border:1px solid #ffdca8;background:#fff8ec;color:#9a6a12;font:600 12px system-ui;cursor:pointer">🛍 商店</button>' +
        '<span data-timer style="font-size:12px;color:#7b8ca6;margin-left:auto"></span>' +
        '<button data-close style="padding:5px 9px;border-radius:8px;border:1px solid #dbe4f0;background:#fff;cursor:pointer">✕</button>' +
        '</div>' +
        '<div style="display:flex;flex:1;min-height:0;position:relative">' +
        '<div data-left style="flex:0 0 auto;overflow:auto;padding:10px 12px 12px;background:#fff">' +
        '<div data-sel></div>' +
        '<div data-body></div>' +
        '</div>' +
        '<div data-panel style="flex:1;min-width:0;border-left:1px solid #e3eaf4;overflow:auto;padding:12px">' +
        '<div data-dyn></div>' +
        '<div data-calc style="border:1px solid #e6edf6;border-radius:10px;padding:8px 10px;background:#fff"></div>' +
        '</div>' +
        '</div>'
      document.body.appendChild(wrap)
      attachScaler(wrap, 'killer')
      attachDragger(wrap, 'killer')

      const $ = (s) => wrap.querySelector(s)
      const bodyEl = $('[data-body]')
      const selEl = $('[data-sel]')
      const dynEl = $('[data-dyn]')
      const calcEl = $('[data-calc]')
      const leftEl = $('[data-left]')

      const ROW = (i) => (i / 9) | 0
      const COL = (i) => i % 9
      const BOX = (i) => ((ROW(i) / 3) | 0) * 3 + ((COL(i) / 3) | 0)

      let day = ''
      let curSource = ''
      let puzzles = []
      let curIdx = 0
      let cages = []
      let owner = null
      let marks = [] // { v, p:[], u:[] }
      let selSet = new Set()
      let cells = []
      let baseMs = 0 // 之前累计的用时
      let runFrom = 0 // 本次开始计时的时刻；0 = 停表状态
      let timer = null
      let done = false
      let pencilMode = false
      let dragSel = null
      let myStars = 0
      const starsFor = (d) => Math.min(5, Math.max(1, Math.ceil((Number(d) || 1) / 2)))
      const renderStars = () => {
        const el = $('[data-stars]')
        if (el) el.textContent = myStars > 0 ? '★ ' + myStars : ''
      }
      // 被玩家判定为「不可能」的组合：key = c<笼号>:<数字> 或 k<和>-<格数>:<数字>
      let offCombos = new Set()

      /** 组合做成开关按钮：亮＝可能，灰＝已排除；点一下切换，状态跨选格保留 */
      const comboBtn = (digits, key) => {
        const b = document.createElement('button')
        const isOff = offCombos.has(key)
        b.textContent = digits
        b.style.cssText = [
          'font:600 12.5px ui-monospace,monospace',
          'padding:5px 10px',
          'border-radius:9px',
          'cursor:pointer',
          'letter-spacing:0.5px',
          'transition:background .12s,color .12s,border-color .12s',
          'border:1px solid ' + (isOff ? '#dfe5ee' : '#a9c6ee'),
          'background:' + (isOff ? '#f1f4f8' : '#e8f1ff'),
          'color:' + (isOff ? '#b3bfcf' : '#2f558a'),
          isOff ? 'text-decoration:line-through' : '',
        ]
          .filter(Boolean)
          .join(';')
        b.addEventListener('click', () => {
          if (offCombos.has(key)) offCombos.delete(key)
          else offCombos.add(key)
          save()
          paint()
        })
        return b
      }

      // 松开鼠标就结束拖选（不管松在哪个格子）
      const endDrag = () => {
        dragSel = null
      }
      window.addEventListener('mouseup', endDrag)

      const fmt = (ms) => {
        const s = Math.floor(ms / 1000)
        return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
      }

      const puzzleKey = () =>
        'dsh-share-chat.killer.' + day + '.' + (puzzles[curIdx] ? puzzles[curIdx].number : 'x')

      const blankMarks = () => Array.from({ length: 81 }, () => ({ v: 0, p: [], u: [] }))

      const values = () => marks.map((m) => m.v)

      const save = () => {
        try {
          writeJson(puzzleKey(), {
            marks: marks.map((m) => ({ v: m.v, p: m.p, u: m.u })),
            off: [...offCombos],
            elapsed: currentMs(),
          })
        } catch (e) {}
      }

      const tickTimer = () => {
        window.clearInterval(timer)
        if (!runFrom) return
        timer = window.setInterval(() => {
          $('[data-timer]').textContent = fmt(currentMs())
        }, 1000)
      }

      /** 当前累计用时（关窗后不再增长） */
      const currentMs = () => baseMs + (runFrom ? Date.now() - runFrom : 0)

      const startClock = () => {
        if (runFrom) return
        runFrom = Date.now()
        tickTimer()
      }

      /** 停表：把本次这一段并入 baseMs */
      const stopClock = () => {
        if (runFrom) {
          baseMs += Date.now() - runFrom
          runFrom = 0
        }
        window.clearInterval(timer)
        timer = null
        $('[data-timer]').textContent = baseMs ? fmt(baseMs) : ''
      }

      const conflicts = () => {
        const g = values()
        const bad = new Set()
        for (let i = 0; i < 81; i++) {
          const v = g[i]
          if (!v) continue
          for (let j = 0; j < 81; j++) {
            if (j === i || g[j] !== v) continue
            if (ROW(j) === ROW(i) || COL(j) === COL(i) || BOX(j) === BOX(i)) bad.add(i).add(j)
          }
        }
        for (const cage of cages) {
          const seen = new Map()
          for (const i of cage.cells) {
            const v = g[i]
            if (!v) continue
            if (seen.has(v)) {
              bad.add(i)
              bad.add(seen.get(v))
            } else seen.set(v, i)
          }
          if (cage.cells.every((i) => g[i] > 0)) {
            const s = cage.cells.reduce((a, i) => a + g[i], 0)
            if (s !== cage.sum) for (const i of cage.cells) bad.add(i)
          }
        }
        return bad
      }

      const paint = () => {
        const g = values()
        // 填满之前不给对错提示，否则靠试凑就能试出来
        const bad = new Set()
        const single = selSet.size === 1 ? [...selSet][0] : -1
        const selVal = single >= 0 ? g[single] : 0
        for (let i = 0; i < 81; i++) {
          const cell = cells[i]
          const m = marks[i]
          cell.textContent = ''
          if (m.v) {
            const span = document.createElement('span')
            span.textContent = String(m.v)
            span.style.cssText =
              'font:600 21px system-ui;color:' + (bad.has(i) ? '#d9534f' : '#1f2a37')
            cell.appendChild(span)
          } else if (m.p.length) {
            const grid = document.createElement('div')
            grid.style.cssText =
              'position:absolute;inset:2px;display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);font:600 8.5px/1 system-ui;color:#5b7194'
            for (let d = 1; d <= 9; d++) {
              const c = document.createElement('span')
              c.style.cssText =
                'display:flex;align-items:center;justify-content:center;' +
                (m.p.includes(d) ? '' : 'opacity:0')
              c.textContent = String(d)
              if (m.p.includes(d) && m.u.includes(d)) c.style.textDecoration = 'underline'
              grid.appendChild(c)
            }
            cell.appendChild(grid)
          }
          if (cageStart.has(i)) {
            const lab = document.createElement('span')
            lab.textContent = String(cageSum.get(i))
            lab.style.cssText =
              'position:absolute;top:0px;left:2px;font:600 9.5px/1 ui-monospace,monospace;color:#6b7f9e'
            cell.appendChild(lab)
          }
          let bg = '#fff'
          if (bad.has(i)) bg = '#fde8e8'
          else if (selSet.has(i)) bg = '#dbe9ff'
          else if (m.v && selVal && m.v === selVal) bg = '#eef4ff'
          cell.style.background = bg
        }
        renderPanel()
      }

      let cageStart = new Set()
      let cageSum = new Map()

      const renderPanel = () => {
        dynEl.textContent = ''
        const g = values()
        const box = document.createElement('div')
        box.style.cssText = 'display:flex;flex-direction:column;gap:8px'

        // 选中信息：这一行位置固定。
        // 只有当选中范围完整覆盖了它碰到的每一个笼时，和才是「用笼能算出来」的；
        // 只要有一格所在的笼没被选全，就算不出，直接留空。
        const selList = [...selSet]
        const line = document.createElement('div')
        line.style.cssText = 'font-size:12px;min-height:19px;font-weight:600;color:#4a6a92'
        if (!selList.length) {
          line.textContent = '还没选格子 · 按住左键拖过去可以选多格'
          line.style.color = '#a7b6c9'
          line.style.fontWeight = '400'
        } else {
          const touched = new Set(selList.map((k) => owner[k]))
          const allCovered = [...touched].every(
            (ci) => cages[ci] && cages[ci].cells.every((k) => selSet.has(k)),
          )
          if (allCovered) {
            let sum = 0
            for (const ci of touched) sum += cages[ci].sum
            line.textContent = '选中 ' + selList.length + ' 格 · 和 ' + sum
          } else {
            line.textContent = ''
          }
        }
        const selBox = document.createElement('div')
        selBox.style.cssText = 'border:1px solid #e6edf6;border-radius:10px;padding:8px 10px;background:#fff;margin-bottom:8px'
        selBox.appendChild(line)
        box.appendChild(selBox)

        // 组合提示：常显。没选格子就留个说明，选一个格子就列它所在笼的组合
        {
          const head = document.createElement('div')
          head.style.cssText = 'font-size:12px;color:#4a6a92;font-weight:600;margin-top:2px'
          const bodyC = document.createElement('div')
          bodyC.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;min-height:20px'

          let list = null
          let label = ''
          let cageId = -1
          // 选中都在同一个笼里时，永远按「笼最初的和与格数」给全部组合：
          // 不管选了几格、也不管已经填了什么。跨笼选择则不显示组合。
          if (selSet.size >= 1) {
            const owners = new Set([...selSet].map((k) => owner[k]))
            if (owners.size === 1) {
              const ci = [...owners][0]
              const cage = cages[ci]
              if (cage) {
                cageId = ci
                list = combos(cage.sum, cage.cells.length)
                label =
                  '这个笼的组合（' +
                  cage.sum +
                  ' / ' +
                  cage.cells.length +
                  ' 格）' +
                  (list.length ? '：' + list.length + ' 种' : '：无解')
              }
            }
          }

          if (!label) {
            head.textContent = '这个笼的组合'
            const hint = document.createElement('span')
            hint.textContent =
              selSet.size > 1 ? '选中一格看组合' : '点一个格子，看它所在的笼能填哪些组合'
            hint.style.cssText = 'font-size:11.5px;color:#a7b6c9'
            bodyC.appendChild(hint)
          } else {
            head.textContent = label
            if (list && list.length) {
              for (const c of list.slice(0, 60)) {
                bodyC.appendChild(comboBtn(c.join(''), 'c' + cageId + ':' + c.join('')))
              }
            } else if (list) {
              const t = document.createElement('span')
              t.textContent = '没有可行组合'
              t.style.cssText = 'font-size:11.5px;color:#d9534f'
              bodyC.appendChild(t)
            }
          }

          const comboBox = document.createElement('div')
          comboBox.style.cssText = 'border:1px solid #e6edf6;border-radius:10px;padding:8px 10px;background:#fff;margin-bottom:8px'
          comboBox.appendChild(head)
          comboBox.appendChild(bodyC)
          box.appendChild(comboBox)
        }

        dynEl.appendChild(box)
      }

      const inpStyle = () =>
        'width:56px;padding:4px 6px;border-radius:7px;border:1px solid #dbe4f0;background:#fff;font:12px system-ui'

      /**
       * 计算器只建一次，放在独立的 data-calc 容器里。
       * 以前它长在 renderPanel 里，每次点格子就重建一次，输入和结果全被清掉。
       */
      const buildCalc = () => {
        calcEl.textContent = ''
        const calc = document.createElement('div')
        calc.style.cssText = 'display:flex;align-items:center;gap:6px'
        const lab = document.createElement('span')
        lab.textContent = '计算器'
        lab.style.cssText = 'font-size:12px;color:#7b8ca6'
        const inSum = document.createElement('input')
        inSum.placeholder = '和'
        inSum.style.cssText = inpStyle()
        const inN = document.createElement('input')
        inN.placeholder = '格数'
        inN.style.cssText = inpStyle()
        const btn = document.createElement('button')
        btn.textContent = '算'
        btn.style.cssText =
          'padding:4px 10px;border-radius:7px;border:1px solid #dbe4f0;background:#fff;font:600 12px system-ui;cursor:pointer'
        const outC = document.createElement('div')
        outC.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;min-height:20px;margin-top:8px'
        btn.addEventListener('click', () => {
          outC.textContent = ''
          const s = Number(inSum.value)
          const n = Number(inN.value)
          if (!s || !n) return
          const list = combos(s, n)
          if (!list.length) {
            outC.textContent = '没有组合'
            outC.style.cssText = 'font-size:12px;color:#d9534f;min-height:20px;margin-top:8px'
            return
          }
          outC.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;min-height:20px;margin-top:8px'
          for (const c of list.slice(0, 60)) {
            outC.appendChild(comboBtn(c.join(''), 'k' + s + '-' + n + ':' + c.join('')))
          }
        })
        calc.appendChild(lab)
        calc.appendChild(inSum)
        calc.appendChild(inN)
        calc.appendChild(btn)

        const tip = document.createElement('div')
        tip.style.cssText = 'font-size:11px;color:#93a3ba;line-height:1.6;margin-top:10px'
        tip.innerHTML =
          '<b>按住左键拖过去</b>刷选多格（Shift 拖 = 取消选）· 1–9 填数（再按取消）· <b>Shift+1–9</b> 加候选 · <b>U</b> 划线 · <b>C</b> 清空选中 · <b>P</b> 铅笔模式 · 方向键移动'

        calcEl.appendChild(calc)
        calcEl.appendChild(outC)
        calcEl.appendChild(tip)
      }

      buildCalc()

      /* ---------- 背景商店 ---------- */
      let shop = { items: [], owned: ['plain'], equipped: 'plain' }

      const applyBg = () => {
        const item = shop.items.find((x) => x.id === shop.equipped) || { css: '#ffffff' }
        leftEl.style.background = item.css
      }

      const loadShop = async () => {
        try {
          const r = await api(auth.server, '/api/killer/shop', { token: auth.token })
          shop = { items: r.items || [], owned: r.owned || ['plain'], equipped: r.equipped || 'plain' }
          myStars = Number(r.myStars) || myStars
          renderStars()
          applyBg()
        } catch (e) {}
      }

      const openShop = () => {
        const old = wrap.querySelector('[data-shop-panel]')
        if (old) {
          old.remove()
          return
        }
        const panel = document.createElement('div')
        panel.setAttribute('data-shop-panel', '1')
        panel.style.cssText = [
          'position:absolute',
          'inset:0',
          'z-index:5',
          'background:rgba(251,252,254,.98)',
          'padding:14px',
          'overflow:auto',
        ].join(';')

        const head = document.createElement('div')
        head.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px'
        const t = document.createElement('b')
        t.textContent = '⭐ 星星兑换'
        t.style.cssText = 'font-size:13px'
        const cnt = document.createElement('span')
        cnt.textContent = '我的星星 ' + myStars
        cnt.style.cssText = 'font-size:12px;color:#d99a1f;font-weight:600'
        const close = document.createElement('button')
        close.textContent = '返回'
        close.style.cssText =
          'margin-left:auto;padding:4px 10px;border-radius:8px;border:1px solid #dbe4f0;background:#fff;font:600 12px system-ui;cursor:pointer'
        close.addEventListener('click', () => panel.remove())
        head.appendChild(t)
        head.appendChild(cnt)
        head.appendChild(close)
        panel.appendChild(head)

        const grid = document.createElement('div')
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:10px'
        for (const item of shop.items) {
          const owned = shop.owned.includes(item.id)
          const equipped = shop.equipped === item.id
          const card = document.createElement('div')
          card.style.cssText =
            'border:1px solid ' +
            (equipped ? '#7ea8e0' : '#e3eaf4') +
            ';border-radius:12px;overflow:hidden;background:#fff;display:flex;flex-direction:column'
          const prev = document.createElement('div')
          prev.style.cssText = 'height:76px;background:' + item.css + ';border-bottom:1px solid #eef2f8'
          card.appendChild(prev)
          const nm = document.createElement('div')
          nm.textContent = item.name
          nm.style.cssText = 'font-size:12px;font-weight:600;padding:6px 8px 0'
          card.appendChild(nm)
          const cost = document.createElement('div')
          cost.textContent = item.cost ? '★ ' + item.cost : '默认'
          cost.style.cssText = 'font-size:11px;color:#93a3ba;padding:0 8px 6px'
          card.appendChild(cost)
          const btn = document.createElement('button')
          btn.textContent = equipped ? '使用中' : owned ? '使用' : myStars >= item.cost ? '兑换' : '星星不足'
          btn.disabled = equipped || (!owned && myStars < item.cost)
          btn.style.cssText =
            'margin:0 8px 8px;padding:5px 0;border-radius:8px;border:1px solid ' +
            (equipped ? '#7ea8e0' : '#dbe4f0') +
            ';background:' +
            (equipped ? '#e6f0ff' : owned ? '#fff' : '#fff8ec') +
            ';color:' +
            (equipped ? '#3f6fa8' : owned ? '#1f2a37' : '#9a6a12') +
            ';font:600 12px system-ui;cursor:pointer;opacity:' +
            (btn.disabled ? '0.6' : '1')
          btn.addEventListener('click', async () => {
            try {
              if (!owned) {
                const r = await api(auth.server, '/api/killer/buy', {
                  method: 'POST',
                  token: auth.token,
                  body: { id: item.id },
                })
                shop.owned = r.owned
                myStars = Number(r.myStars) || myStars - item.cost
                renderStars()
              }
              const e2 = await api(auth.server, '/api/killer/equip', {
                method: 'POST',
                token: auth.token,
                body: { id: item.id },
              })
              shop.equipped = e2.equipped || item.id
              applyBg()
              panel.remove()
              openShop()
            } catch (err) {
              onToast('没换成：' + friendly(err))
            }
          })
          card.appendChild(btn)
          grid.appendChild(card)
        }
        panel.appendChild(grid)
        const hint = document.createElement('div')
        hint.textContent = '星星来自每天解出的题：难度越高，给的星越多。'
        hint.style.cssText = 'font-size:11px;color:#a7b6c9;margin-top:10px'
        panel.appendChild(hint)
        $('[data-body]').parentElement.parentElement.appendChild(panel)
      }

      $('[data-shop]').addEventListener('click', openShop)



      const select = (i, additive) => {
        if (!additive) selSet = new Set([i])
        else if (selSet.has(i)) selSet.delete(i)
        else selSet.add(i)
        paint()
      }

      const touchStarted = () => {
        startClock()
      }

      /**
       * 输入一个数字：
       *   空格打一个数 → 直接是大字（当确定值）
       *   已经有数字再打别的 → 自动变成候选小字（1、4、5 那种排布）
       *   候选只剩一个 → 自动变回大字
       * 不再需要「铅笔模式」开关。
       */
      const put = (v) => {
        if (!selSet.size) return
        touchStarted()
        for (const i of selSet) {
          const m = marks[i]
          if (m.v) {
            if (m.v === v) {
              m.v = 0
              m.p = []
              m.u = []
            } else {
              m.p = [m.v, v].filter((x, k, a) => a.indexOf(x) === k).sort((a, b) => a - b)
              m.v = 0
              m.u = []
            }
            continue
          }
          const at = m.p.indexOf(v)
          if (at >= 0) m.p.splice(at, 1)
          else {
            m.p.push(v)
            m.p.sort((a, b) => a - b)
          }
          m.u = m.u.filter((x) => m.p.indexOf(x) >= 0)
          if (m.p.length === 1) {
            m.v = m.p[0]
            m.p = []
            m.u = []
          }
        }
        save()
        paint()
        // 只有全部格子都是「单个数」且完全合法，才算解出
        const g = values()
        if (g.every((x) => x > 0) && conflicts().size === 0) {
          done = true
          stopClock()
          const ms = currentMs()
          showWin(ms)
          awardStars()
        }
      }

      /** 通关弹窗：用时 + 恭喜；结果留在棋盘上 */
      const showWin = (ms) => {
        const old = wrap.querySelector('[data-win]')
        if (old) old.remove()
        const box = document.createElement('div')
        box.setAttribute('data-win', '1')
        box.style.cssText = [
          'position:absolute', 'inset:0', 'z-index:6',
          'background:rgba(251,252,254,.92)',
          'display:flex', 'flex-direction:column',
          'align-items:center', 'justify-content:center', 'gap:10px',
        ].join(';')
        const t = document.createElement('div')
        t.textContent = '解出来了'
        t.style.cssText = 'font:600 22px system-ui;color:#1f2a37'
        const tm = document.createElement('div')
        tm.textContent = '用时 ' + fmt(ms)
        tm.style.cssText = 'font:600 16px ui-monospace,monospace;color:#3f6fa8'
        const b = document.createElement('button')
        b.textContent = '回到题目'
        b.style.cssText =
          'margin-top:6px;padding:8px 18px;border-radius:10px;border:1px solid #dbe4f0;background:#fff;font:600 13px system-ui;cursor:pointer'
        b.addEventListener('click', () => box.remove())
        box.appendChild(t)
        box.appendChild(tm)
        box.appendChild(b)
        wrap.appendChild(box)
      }

      /** 复原：清空成初始状态（星星不会重复给） */
      const resetPuzzle = () => {
        marks = blankMarks()
        selSet = new Set()
        done = false
        baseMs = 0
        runFrom = 0
        window.clearInterval(timer)
        $('[data-timer]').textContent = ''
        const w = wrap.querySelector('[data-win]')
        if (w) w.remove()
        save()
        build()
      }

      /** 通关：难度 1-10 → 1-5 星，同一盘每天只算一次 */
      let awarding = false
      const awardStars = async () => {
        if (awarding) return
        awarding = true
        try {
          const pz = puzzles[curIdx] || {}
          const r = await api(auth.server, '/api/killer/solve', {
            method: 'POST',
            token: auth.token,
            body: { day, number: pz.number, difficulty: pz.difficulty || 1 },
          })
          myStars = Number(r.total) || 0
          renderStars()
          onToast(r.already ? '这盘已经算过星星了' : '解出来了 🎉 +' + r.stars + ' 星')
        } catch (e) {
          onToast('解出来了 🎉（星星没记上）')
        } finally {
          awarding = false
        }
      }

      const togglePencil = (v) => {
        if (!selSet.size || done) return
        touchStarted()
        for (const i of selSet) {
          const m = marks[i]
          if (m.v) continue
          const at = m.p.indexOf(v)
          if (at >= 0) {
            m.p.splice(at, 1)
            m.u = m.u.filter((d) => d !== v)
          } else {
            m.p.push(v)
            m.p.sort((a, b) => a - b)
          }
        }
        save()
        paint()
      }

      const clearSelected = () => {
        if (!selSet.size) return
        for (const i of selSet) {
          marks[i] = { v: 0, p: [], u: [] }
        }
        done = false
        save()
        paint()
      }

      const underline = () => {
        if (!selSet.size) return
        for (const i of selSet) {
          const m = marks[i]
          if (m.v || !m.p.length) continue
          if (m.u.length === m.p.length) m.u = []
          else m.u = m.p.slice()
        }
        save()
        paint()
      }

      const build = () => {
        bodyEl.textContent = ''
        owner = new Int8Array(81).fill(-1)
        cages.forEach((c, ci) => c.cells.forEach((i) => (owner[i] = ci)))

        const CELL = 46
        const board = document.createElement('div')
        board.style.cssText =
          'position:relative;display:grid;grid-template-columns:repeat(9,' +
          CELL +
          'px);grid-template-rows:repeat(9,' +
          CELL +
          'px);border:3px solid #1f2a37;margin:0 auto;width:max-content;background:#fbfcfe'

        cells = []
        for (let i = 0; i < 81; i++) {
          const boxRight = i % 9 === 8 || COL(i) % 3 === 2
          const boxBottom = i >= 72 || ROW(i) % 3 === 2
          const cell = document.createElement('div')
          cell.style.cssText = [
            'position:relative',
            'display:flex',
            'align-items:center',
            'justify-content:center',
            'cursor:pointer',
            'user-select:none',
            'border-right:' + (boxRight ? '2px solid #1f2a37' : '1px solid #d9e1ec'),
            'border-bottom:' + (boxBottom ? '2px solid #1f2a37' : '1px solid #d9e1ec'),
            i % 9 === 8 ? 'border-right:none' : '',
            i >= 72 ? 'border-bottom:none' : '',
          ]
            .filter(Boolean)
            .join(';')
          cell.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return
            e.preventDefault()
            dragSel = { add: !e.shiftKey }
            if (!e.shiftKey) selSet = new Set([i])
            else if (selSet.has(i)) selSet.delete(i)
            else selSet.add(i)
            paint()
          })
          cell.addEventListener('mouseenter', () => {
            if (!dragSel) return
            if (dragSel.add) selSet.add(i)
            else selSet.delete(i)
            paint()
          })
          board.appendChild(cell)
          cells.push(cell)
        }

        // 笼用一层 SVG 单独画虚线轮廓，和九宫格的实线分开
        const NS = 'http://www.w3.org/2000/svg'
        const svg = document.createElementNS(NS, 'svg')
        svg.setAttribute('width', String(CELL * 9))
        svg.setAttribute('height', String(CELL * 9))
        svg.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;overflow:visible'
        const seg = (x1, y1, x2, y2) => {
          const l = document.createElementNS(NS, 'line')
          l.setAttribute('x1', x1)
          l.setAttribute('y1', y1)
          l.setAttribute('x2', x2)
          l.setAttribute('y2', y2)
          l.setAttribute('stroke', '#7b93b5')
          l.setAttribute('stroke-width', '1.7')
          l.setAttribute('stroke-dasharray', '5 3')
          l.setAttribute('stroke-linecap', 'round')
          svg.appendChild(l)
        }
        for (let i = 0; i < 81; i++) {
          const ci = owner[i]
          const x = COL(i) * CELL
          const y = ROW(i) * CELL
          if (ROW(i) === 0 || owner[i - 9] !== ci) seg(x, y, x + CELL, y)
          if (ROW(i) === 8 || owner[i + 9] !== ci) seg(x, y + CELL, x + CELL, y + CELL)
          if (COL(i) === 0 || owner[i - 1] !== ci) seg(x, y, x, y + CELL)
          if (COL(i) === 8 || owner[i + 1] !== ci) seg(x + CELL, y, x + CELL, y + CELL)
        }
        board.appendChild(svg)

        bodyEl.appendChild(board)

        const pad = document.createElement('div')
        pad.style.cssText = 'display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-top:10px'
        for (let v = 1; v <= 9; v++) {
          const b = document.createElement('button')
          b.textContent = String(v)
          b.style.cssText =
            'padding:8px 0;border-radius:9px;border:1px solid #dbe4f0;background:#fff;font:600 15px system-ui;cursor:pointer'
          b.addEventListener('click', () => put(v))
          pad.appendChild(b)
        }
        const mk = (label, fn, color) => {
          const b = document.createElement('button')
          b.textContent = label
          b.style.cssText =
            'padding:8px 0;border-radius:9px;border:1px solid ' +
            (color || '#dbe4f0') +
            ';background:#fff;font:600 12px system-ui;cursor:pointer'
          b.addEventListener('click', fn)
          return b
        }
        pad.appendChild(mk('清除', clearSelected, '#ffd3e6'))
        pad.appendChild(mk('复原', resetPuzzle))
        bodyEl.appendChild(pad)
        paint()
      }

      const onKey = (e) => {
        if (!document.body.contains(wrap)) return
        const t = e.target
        if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return
        if (t && t.closest && t.closest('[contenteditable="true"]')) return
        const k = e.key
        if (k >= '1' && k <= '9') {
          put(Number(k))
          e.preventDefault()
          return
        }
        if (k === 'u' || k === 'U') {
          underline()
          e.preventDefault()
          return
        }
        if (k === 'c' || k === 'C') {
          clearSelected()
          e.preventDefault()
          return
        }
        if (k === 'Backspace' || k === 'Delete' || k === '0') {
          clearSelected()
          e.preventDefault()
          return
        }
        const move = { ArrowUp: -9, ArrowDown: 9, ArrowLeft: -1, ArrowRight: 1 }[k]
        if (move !== undefined) {
          e.preventDefault()
          if (!selSet.size) return select(0, false)
          const i = [...selSet][selSet.size - 1]
          const r = ROW(i)
          const c = COL(i)
          if (k === 'ArrowLeft' && c === 0) return
          if (k === 'ArrowRight' && c === 8) return
          if (k === 'ArrowUp' && r === 0) return
          if (k === 'ArrowDown' && r === 8) return
          select(i + move, e.shiftKey)
        }
      }

      window.addEventListener('keydown', onKey, true)
      $('[data-close]').addEventListener('click', () => {
        window.removeEventListener('keydown', onKey, true)
        // 关窗前把这一段用时并进累计值，再存盘：再打开就是停表时的数字
        stopClock()
        save()
        wrap.remove()
      })

      const applyPuzzle = (idx, keepProgress) => {
        curIdx = idx
        const pz = puzzles[idx] || {}
        cages = pz.cages || []
        cageStart = new Set()
        cageSum = new Map()
        cages.forEach((c) => {
          const start = Math.min(...c.cells)
          cageStart.add(start)
          cageSum.set(start, c.sum)
        })
        marks = blankMarks()
        selSet = new Set()
        done = false
        baseMs = 0
        runFrom = 0
        window.clearInterval(timer)
        $('[data-timer]').textContent = ''
        if (keepProgress) {
          const saved = readJson(puzzleKey())
          offCombos = new Set(Array.isArray(saved && saved.off) ? saved.off : [])
          if (saved && Array.isArray(saved.marks) && saved.marks.length === 81) {
            marks = saved.marks.map((m) => ({
              v: Number(m && m.v) || 0,
              p: Array.isArray(m && m.p) ? m.p.slice() : [],
              u: Array.isArray(m && m.u) ? m.u.slice() : [],
            }))
            baseMs = Number(saved.elapsed) || 0
            if (baseMs) {
              startClock()
              $('[data-timer]').textContent = fmt(baseMs)
            }
          }
        }
        $('[data-day]').textContent =
          day + (pz.number ? ' · #' + pz.number : '') + (curSource === 'generated' ? ' · 自动出题' : '')
        renderSel()
        build()
      }

      const renderSel = () => {
        selEl.textContent = ''
        if (puzzles.length < 2) return
        const bar = document.createElement('div')
        bar.style.cssText = 'display:flex;gap:6px;justify-content:center;padding:8px 0 0'
        puzzles.forEach((pz, idx) => {
          const b = document.createElement('button')
          const st = starsFor(pz.difficulty)
          b.textContent = String(idx + 1) + (pz.difficulty ? ' · 难度' + pz.difficulty : '')
          b.title = '#' + pz.number + (pz.difficulty ? ' 难度 ' + pz.difficulty + '/10' : '') + ' 通关得 ' + st + ' 星'
          b.style.cssText =
            'padding:0 10px;height:27px;border-radius:8px;border:1px solid ' +
            (idx === curIdx ? '#7ea8e0' : '#dbe4f0') +
            ';background:' +
            (idx === curIdx ? '#e6f0ff' : '#fff') +
            ';font:600 12px system-ui;cursor:pointer'
          b.addEventListener('click', () => {
            if (idx !== curIdx) applyPuzzle(idx, true)
          })
          bar.appendChild(b)
        })
        selEl.appendChild(bar)
      }

      api(auth.server, '/api/killer/today', { token: auth.token })
        .then((r) => {
          day = r.day || ''
          curSource = r.source || ''
          myStars = Number(r.myStars) || 0
          renderStars()
          loadShop()
          puzzles = Array.isArray(r.puzzles) ? r.puzzles : []
          if (!puzzles.length) {
            bodyEl.textContent = '今天没有题目'
            return
          }
          applyPuzzle(0, true)
        })
        .catch((e) => {
          bodyEl.textContent = '题目加载失败：' + friendly(e)
        })
    }
    function SocialView(props) {
      const [auth, setAuth] = useState(() => readJson(K_AUTH))
      const [gameOpen, setGameOpen] = useState(false)
      const rootRef = useRef(null)
      // 只有会话里的 View 才拿得到会话数据；全局面板没有 props
      const canShare = !!(props && props.sessionId && typeof props.useChat === 'function')

      useEffect(() => {
        const el = rootRef.current
        if (!el) return
        adaptSurfaceTokens(el)
        // 主题切换/面板尺寸变化后再校一次
        const timer = window.setTimeout(() => adaptSurfaceTokens(el), 400)
        return () => window.clearTimeout(timer)
      }, [])

      /**
       * 把面板钉成「视口剩余高度」。
       * slot 容器不一定给确定高度，`height:100%` 会退化成内容高度，
       * 结果是整个面板比窗口还高、滚的是外层页面，输入框被顶到视口外。
       * 这里按 root 的实际 top 量一次，剩下的都交给内部列表自己滚。
       */
      useEffect(() => {
        const el = rootRef.current
        if (!el) return

        // 真正的滚动容器不一定是 documentElement，也可能是 DSH 的某个内层 div
        const findScroller = (node) => {
          let p = node.parentElement
          while (p && p !== document.body && p !== document.documentElement) {
            const cs = window.getComputedStyle(p)
            if (/(auto|scroll)/.test(cs.overflowY)) return p
            p = p.parentElement
          }
          return null
        }

        const fit = () => {
          const rect = el.getBoundingClientRect()
          const sc = findScroller(el)
          let h
          if (sc) {
            const sr = sc.getBoundingClientRect()
            const offTop = Math.max(0, Math.round(rect.top - sr.top))
            h = Math.round(sr.height - offTop - 4)
          } else {
            h = Math.round(window.innerHeight - Math.max(0, Math.round(rect.top)) - 6)
          }
          h = Math.max(280, h)
          // 嵌在对话流里的版本会跟着整页滚：如果块比视口还高，
          // 底部的输入框就被推到屏幕外，怎么钉都没用。这里直接压到视口内。
          if (canShare) {
            h = Math.min(h, Math.round(window.innerHeight * 0.86))
          }
          el.style.height = h + 'px'
          el.style.maxHeight = h + 'px'
          el.style.overflow = 'hidden'

          // 万一还是把外层撑出滚动条，再按超出量回缩
          const doc = document.documentElement
          const contentH = Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0)
          const viewH = Math.max(doc.clientHeight, window.innerHeight)
          const over = contentH - viewH
          if (over > 2) {
            h = Math.max(280, h - over - 2)
            el.style.height = h + 'px'
            el.style.maxHeight = h + 'px'
          }
        }

        fit()
        const timers = [60, 260, 900].map((d) => window.setTimeout(fit, d))
        window.addEventListener('resize', fit)
        let ro = null
        const parent = el.parentElement
        if (parent && typeof ResizeObserver !== 'undefined') {
          ro = new ResizeObserver(() => fit())
          ro.observe(parent)
        }
        return () => {
          for (const t of timers) window.clearTimeout(t)
          window.removeEventListener('resize', fit)
          if (ro) ro.disconnect()
        }
      }, [auth, canShare])

      const body = !auth
        ? h(LoginPanel, { onDone: (next) => setAuth(next) })
        : h(ChatPanel, {
            auth,
            onOpenGame: () => setGameOpen(true),
            onLogout: () => {
              dropKey(K_AUTH)
              setAuth(null)
              setGameOpen(false)
            },
          })

      return h(
        'div',
        { className: 'sc-root', ref: rootRef },
        canShare && auth ? h(Boundary, null, h(ShareBar, { chatProps: props, auth })) : null,
        h('div', { style: { flex: 1, minHeight: 0, display: 'flex' } }, body),
        gameOpen ? h(GameWindow, { onClose: () => setGameOpen(false) }) : null,
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
            if (!list.length) setNote('还没有好友，先在左边的「好友」里加一个')
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
          setNote('已发给 ' + target + '，共 ' + blocks.length + ' 段')
          setOpen(false)
        } catch (e) {
          setNote(friendly(e))
        } finally {
          setBusy(false)
        }
      }

      if (!open) {
        return h(
          'div',
          { className: 'sc-share' },
          h(
            'div',
            { className: 'sc-share-row' },
            h(
              'button',
              { className: 'sc-btn sc-btn-sm', onClick: () => setOpen(true) },
              '🐟 分享这一轮',
            ),
            h('span', { className: 'sc-share-note' }, '把这一问一答发给好友，不带思考过程和运行时上下文'),
            note ? h('span', { className: 'sc-share-err' }, note) : null,
          ),
        )
      }

      return h(
        'div',
        { className: 'sc-share' },
        h(
          'div',
          { className: 'sc-share-row' },
          h('span', { className: 'sc-share-note' }, broke ? '没读到会话内容' : blocks.length + ' 段'),
          friends.length
            ? h(
                'select',
                {
                  className: 'sc-input',
                  style: { height: '28px', width: 'auto', padding: '0 10px' },
                  value: target,
                  onChange: (e) => setTarget(e.target.value),
                },
                friends.map((f) => h('option', { key: f.id, value: f.id }, f.displayName || f.id)),
              )
            : null,
          h(
            'button',
            {
              className: 'sc-btn sc-btn-primary sc-btn-sm',
              disabled: busy || broke || !target,
              onClick: send,
            },
            busy ? '发送中' : '发送',
          ),
          h('button', { className: 'sc-btn sc-btn-sm sc-btn-ghost', onClick: () => setOpen(false) }, '取消'),
          note ? h('span', { className: 'sc-share-err' }, note) : null,
        ),
        broke
          ? h(
              'pre',
              {
                style: {
                  margin: '8px 0 0',
                  fontSize: '10px',
                  lineHeight: 1.45,
                  maxHeight: '180px',
                  overflow: 'auto',
                  opacity: 0.7,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                },
              },
              diagnose(chat),
            )
          : h(
              'div',
              { className: 'sc-preview' },
              h('div', { className: 'sc-preview-cap' }, '预览 · 发送前扫一眼，别把不该发的带出去'),
              blocks.slice(0, 12).map((b, i) =>
                h(
                  'div',
                  { key: i, className: 'sc-preview-line' + (b.t === 'tool' ? ' tool' : '') },
                  '[' + b.t + '] ' + (b.name ? b.name + ' ' : '') + String(b.text || '').slice(0, 160),
                ),
              ),
            ),
      )
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
        // 桌宠：挂在 body 上，和面板解耦
        ctx.effect(() => mountPet())

        // 样式表：跟着插件生命周期建立/移除
        ctx.effect(() => {
          ensureStyles()
          return () => {
            if (typeof document === 'undefined') return
            for (const id of [STYLE_ID, STYLE_ID + '-dopa']) {
              const el = document.getElementById(id)
              if (el && el.parentNode) el.parentNode.removeChild(el)
            }
          }
        })

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

        // 4) 设置 → 社交小游戏：改「🎮 钓鱼」窗口的默认大小
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'share-chat-game',
              order: 60,
              label: () => '社交小游戏',
            },
            GameSettingsSection,
          ),
        )
      },
    }
  },
})
