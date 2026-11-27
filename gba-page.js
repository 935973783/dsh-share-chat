// EmulatorJS 播放页（在独立窗口里打开，页面自己带 isolation 头）
export const GBA_PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>GBA 模拟器</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{margin:0;height:100%;background:#0b0d12;color:#e6e9ef;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  #bar{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #232838}
  #bar b{font-size:14px}
  #bar .tip{font-size:11.5px;color:#8b93a5}
  #pick{padding:5px 12px;border-radius:8px;border:1px solid #3a4152;background:#1d212b;color:#dbe2f0;font:600 12px system-ui;cursor:pointer}
  #wrap{position:relative;height:calc(100% - 53px);display:flex;align-items:center;justify-content:center}
  #game{width:100%;height:100%;max-width:960px;max-height:640px}
  #hint{position:absolute;color:#7c8598;text-align:center;font-size:13px;line-height:1.9}
  #hint span{font-size:11.5px;color:#5d6577}
  input[type=file]{display:none}
</style>
</head>
<body>
<div id="bar">
  <b>🎮 GBA</b>
  <span class="tip" id="st">选一个 .gba 文件</span>
  <span style="flex:1"></span>
  <button id="pick">打开 ROM</button>
</div>
<div id="wrap">
  <div id="hint">点右上角「打开 ROM」选择一个 .gba 文件<br><span>方向键 · Z=A · X=B · A=L · S=R · Enter=Start · Shift=Select</span></div>
  <div id="game"></div>
</div>
<input type="file" id="file" accept=".gba,application/octet-stream">
<script>
  const st = document.getElementById('st')
  const file = document.getElementById('file')
  const hint = document.getElementById('hint')
  let started = false

  window.EJS_player = '#game'
  window.EJS_core = 'gba'
  window.EJS_pathtodata = 'https://cdn.emulatorjs.org/stable/data/'
  window.EJS_startOnLoaded = true
  window.EJS_disableDatabases = true
  window.EJS_disableAutoLang = true
  window.EJS_language = 'zh-CN'
  window.EJS_color = '#4f8cff'
  window.EJS_backgroundColor = '#0b0d12'

  document.getElementById('pick').onclick = () => file.click()

  file.onchange = () => {
    const f = file.files && file.files[0]
    if (!f) return
    st.textContent = f.name + ' · ' + Math.round(f.size / 1048576) + ' MB'
    hint.style.display = 'none'
    const url = URL.createObjectURL(f)
    window.EJS_gameUrl = url
    window.EJS_gameName = f.name.replace(/\\.gba$/i, '')
    if (!started) {
      started = true
      const s = document.createElement('script')
      s.src = window.EJS_pathtodata + 'loader.js'
      s.onerror = () => { st.textContent = 'EmulatorJS 加载失败（需要联网）' }
      document.body.appendChild(s)
    }
  }
</script>
</body>
</html>`
