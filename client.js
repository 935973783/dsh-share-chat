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
.sc-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#247bbf);color:var(--dsw-alias-label-on-color,#fff)}
.sc-btn-primary:hover{background:var(--dsw-alias-button-primary-hover,#1f6cab)}
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
.sc-chat{flex:1;min-height:0;display:flex;flex-direction:column}
.sc-chat-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.20));flex:0 0 auto}
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
.sc-composer{flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.20));padding:10px 14px 12px}
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

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
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
      avatarBase = auth.server
      const [friends, setFriends] = useState([])
      const [groups, setGroups] = useState([])
      const [active, setActive] = useState(null)
      const [messages, setMessages] = useState([])
      const [draft, setDraft] = useState('')
      const [newFriend, setNewFriend] = useState('')
      const [err, setErr] = useState('')
      const [sending, setSending] = useState(false)
      const [uploading, setUploading] = useState(false)
      const [emojiOpen, setEmojiOpen] = useState(false)
      const [myAvatar, setMyAvatar] = useState('')

      const cursorRef = useRef(0)
      const listRef = useRef(null)
      const activeRef = useRef(null)
      const friendsKeyRef = useRef('')
      const fileRef = useRef(null)

      useEffect(() => {
        activeRef.current = active
      }, [active])

      const loadFriends = useCallback(async () => {
        try {
          const r = await api(auth.server, '/api/friends', { token: auth.token })
          setFriends(r.friends || [])
          setGroups(r.groups || [])
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
          if (!res.ok) {
            setErr(up && up.error === 'too-large' ? '文件太大（服务器上限 50 MB）' : '上传失败')
            return
          }
          const isImage = String(file.type || '').startsWith('image/')
          await api(auth.server, '/api/messages', {
            method: 'POST',
            token: auth.token,
            body: isImage ? { to: active, image: { uploadId: up.id } } : { to: active, file: { uploadId: up.id } },
          })
          await pull()
        } catch (e) {
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
      /** 建群 / 拉人 / 换自己的头像 */
      const createGroup = async () => {
        let name = ''
        try {
          name = (window.prompt('群名？') || '').trim()
        } catch (e) {
          name = ''
        }
        if (!name) return
        setErr('')
        try {
          const r = await api(auth.server, '/api/groups', {
            method: 'POST',
            token: auth.token,
            body: { name },
          })
          await loadFriends()
          setActive('g:' + r.group.id)
          cursorRef.current = 0
          setMessages([])
        } catch (e) {
          setErr(friendly(e))
        }
      }

      const addMember = async () => {
        if (!active || active.indexOf('g:') !== 0) return
        let id = ''
        try {
          id = (window.prompt('把谁的 ID 拉进群？') || '').trim()
        } catch (e) {
          id = ''
        }
        if (!id) return
        setErr('')
        try {
          await api(auth.server, '/api/groups/' + active.slice(2) + '/members', {
            method: 'POST',
            token: auth.token,
            body: { id },
          })
          await loadFriends()
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
        })),
        ...groups.map((g) => ({
          kind: 'group',
          key: 'g:' + g.id,
          title: g.name,
          avatar: g.avatar || '',
          members: g.members || [],
        })),
      ]
      const current = convs.find((c) => c.key === active) || null
      const isGroup = !!(current && current.kind === 'group')
      const nameOf = (id) => {
        const mem = current && (current.members || []).find((x) => x.id === id)
        if (mem) return mem.displayName || id
        const dm = convs.find((c) => c.kind === 'dm' && c.key === id)
        return dm ? dm.title : id
      }

      const thread = messages.filter((m) => m.from === active || m.to === active)

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
          { key: m.seq, className: 'sc-msg' + (mine ? ' mine' : '') },
          isGroup && !mine
            ? h('div', { className: 'sc-time', style: { marginBottom: '2px' } }, nameOf(m.from))
            : null,
          content,
          h('div', { className: 'sc-time' }, clockText(m.at)),
        )
      }

      return h(
        'div',
        { className: 'sc-chat' },
        /* 顶栏 */
        h(
          'div',
          { className: 'sc-chat-head' },
          avatar(auth.displayName || auth.id, auth.id, 30, myAvatar, false),
          h('input', {
            ref: avatarInputRef,
            type: 'file',
            accept: 'image/*',
            style: { display: 'none' },
            onChange: (e) => {
              const f = e.target.files && e.target.files[0]
              if (f) uploadAvatar(f)
              e.target.value = ''
            },
          }),
          h(
            'div',
            { style: { minWidth: 0 } },
            h(
              'div',
              {
                className: 'sc-chat-name',
                style: { cursor: 'pointer' },
                title: '点一下换我的头像',
                onClick: () => avatarInputRef.current && avatarInputRef.current.click(),
              },
              '@' + (auth.displayName || auth.id),
            ),
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
              className: 'sc-btn',
              onClick: () => openMeeting({ auth, onToast: (m) => setErr(m) }),
              title: '音视频会议（点对点，无时长限制）',
            },
            '📹 开会',
          ),
          h('button', { className: 'sc-btn', onClick: props.onOpenGame, title: '玩一把鱼塘摸鱼' }, '🎮 摸鱼'),
          h('button', { className: 'sc-btn sc-btn-ghost', onClick: props.onLogout }, '退出'),
        ),
        /* 主体 */
        h(
          'div',
          { className: 'sc-chat-body' },
          h(
            'div',
            { className: 'sc-side' },
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
              h('button', { className: 'sc-btn sc-btn-sm', onClick: createGroup, title: '建一个群' }, '建群'),
            ),
            h(
              'div',
              { className: 'sc-friends' },
              convs.length === 0
                ? emptyState('👥', '还没有会话', '在上面加好友，或者点「建群」')
                : convs.map((c) =>
                    h(
                      'div',
                      {
                        key: c.key,
                        className: 'sc-friend' + (active === c.key ? ' on' : ''),
                        onClick: () => {
                          setActive(c.key)
                          cursorRef.current = 0
                          setMessages([])
                        },
                        title: c.key,
                      },
                      avatar(c.title, c.key, 28, c.avatar, c.kind === 'group'),
                      h(
                        'div',
                        { className: 'sc-friend-main' },
                        h(
                          'div',
                          { className: 'sc-friend-name' },
                          c.title + (c.kind === 'group' ? '  (' + c.members.length + ')' : ''),
                        ),
                        h(
                          'div',
                          { className: 'sc-friend-last' },
                          previewOf(lastOf(c.key)) || '还没有消息',
                        ),
                      ),
                    ),
                  ),
            ),
          ),
          h(
            'div',
            { className: 'sc-main' },
            current
              ? h(
                  'div',
                  {
                    className: 'sc-side-title',
                    style: {
                      padding: '10px 14px 4px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    },
                  },
                  h(
                    'span',
                    null,
                    current.title + (isGroup ? '  ·  ' + current.members.length + ' 人' : ''),
                  ),
                  h('span', { className: 'sc-grow' }),
                  isGroup
                    ? h(
                        'button',
                        { className: 'sc-btn sc-btn-sm', onClick: addMember, title: '拉人进群' },
                        '＋人',
                      )
                    : null,
                )
              : null,
            h(
              'div',
              { className: 'sc-thread', ref: listRef },
              h(
                'div',
                { className: 'sc-thread-inner' },
                !active
                  ? emptyState('💬', '选一个好友开始聊天', '左边是好友列表，点一下就进来')
                  : thread.length === 0
                    ? emptyState('🐟', '还没有消息', '说点什么，或者在上面的「分享这一轮」把对话发过去')
                    : thread.map(renderMessage),
              ),
            ),
            h(
              'div',
              { className: 'sc-composer' },
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
        title.textContent = '鱼塘摸鱼'
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
        frame.title = '鱼塘摸鱼'
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
            '「🎮 摸鱼」打开的窗口大小。窗口可以拖标题栏移动、拖右下角临时改大小；这里设的是默认值，保存在这台电脑的浏览器里。',
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

    function SocialView(props) {
      const [auth, setAuth] = useState(() => readJson(K_AUTH))
      const [gameOpen, setGameOpen] = useState(false)

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

      // 只有会话里的 View 才拿得到会话数据；全局面板没有 props
      const canShare = !!(props && props.sessionId && typeof props.useChat === 'function')

      return h(
        'div',
        { className: 'sc-root' },
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
        // 样式表：跟着插件生命周期建立/移除
        ctx.effect(() => {
          ensureStyles()
          return () => {
            const el = typeof document !== 'undefined' ? document.getElementById(STYLE_ID) : null
            if (el && el.parentNode) el.parentNode.removeChild(el)
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

        // 4) 设置 → 社交小游戏：改「🎮 摸鱼」窗口的默认大小
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
