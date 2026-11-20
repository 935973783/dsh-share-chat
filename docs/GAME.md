# 小游戏：鱼塘摸鱼的浏览器移植

插件本身不含游戏代码，也不含移植脚手架。它只做一件事：在聊天页顶栏放一个 `🎮 摸鱼`，
用全屏 iframe 打开 `https://xdxy-pet.com/game/`（微信小游戏的浏览器移植版）。

> 为什么仓库里没有移植层：移植层里有一个把 CommonJS 模块 `eval` 起来的加载器，
> dsh.so 的安全扫描会把它判为 **critical（动态执行代码）**。它只是部署脚手架、不属于插件运行时，
> 所以放在服务器上维护，不进插件仓库。

## 移植思路（文档，不是本仓库代码）

微信小游戏的代码是 `require('./x.js') + module.exports` + 全局 `wx.*`。在浏览器里跑起来需要两样东西：

1. **`wx` 适配层**：把用到的 API 映射到浏览器
   | 类别 | API |
   |---|---|
   | 画布/图片 | `createCanvas`、`createImage` |
   | 环境 | `getWindowInfo`、`getSystemInfoSync`、`getMenuButtonBoundingClientRect` |
   | 触摸 | `onTouchStart/Move/End/Cancel`（桌面把鼠标当单指） |
   | 键盘 | `showKeyboard`、`hideKeyboard`、`onKeyboardInput/Confirm/Complete`（用透明 `<input>` 承接） |
   | 存储 | `getStorageSync`、`setStorageSync`、`removeStorageSync`（→ localStorage） |
   | 网络 | `request`（→ fetch，GET 拼 query、POST JSON、AbortController 超时） |
   | 杂项 | `login`（浏览器直接失败，游戏退回账号密码）、`setClipboardData`、`setKeepScreenOn`、`onHide` |
   | 降级 | `createRewardedVideoAd`（广告不可用）、`createGameClubButton`、`createPageManager` |
2. **模块加载**：小游戏用 CommonJS。可以构建期把 30 个模块包成一个静态 registry
   （`__modules['js/app.js'] = function(require, module, exports){…}`）再由一个几十行的 `require` 运行，
   **不要**在运行时把源码字符串当代码执行（Function 构造器 / eval）——那正是被扫描器判 critical 的写法。

## 部署（在服务器上）

```
/var/www/game/
  index.html  wx-shim.js  loader.js  game.js      ← 移植层
  js/                                             ← 小游戏工程的 js/，外加 files.json（模块清单）
  assets/                                         ← 小游戏工程的 assets/
```

nginx 只需要一条静态 location，并且要和鱼塘的 `/api/fish/` **同源**（移植层才能不带 CORS 直接 fetch）：

```nginx
location /game/ {
    alias /var/www/game/;
    index index.html;
    charset utf-8;
    add_header Cache-Control "no-cache";
    add_header X-Content-Type-Options "nosniff" always;
}
```

注意事项：

- scp 上去的目录常常是 `700`，nginx 会 403，记得 `chmod -R a+rX`；
- 不要把 `try_files` 和 `alias` 混用（解析会错位），用 `index` 就够；
- 改了 `js/` 里的文件名，要重新生成 `files.json`（`js/` 下所有 `.js` 文件名的 JSON 数组）；
- 包内的 `JSON` 文件不要带 BOM。

## 和插件的接口

游戏页每秒给父页面发 `{ source: 'fishgame', type: 'scene', scene }`；
点按时发 `{ type: 'tap', x, y, hit }`（`hit` 是游戏自己的命中结果，用来诊断「点不到」）。
插件只用这些消息显示当前场景和报错，不影响游戏逻辑。

## 已知差距（对比微信）

- 没有微信登录（`wx.login` 在浏览器直接失败，走账号密码）
- 没有激励视频与游戏圈，对应 API 是「不可用」的降级实现
- 输入用透明 `<input>` 顶系统键盘，移动端可用但不是原生输入框
- 视频/音频能否播放取决于浏览器编解码
- 游戏地址写死在 `client.js` 的 `GAME_URL`，换域名要改一版插件
