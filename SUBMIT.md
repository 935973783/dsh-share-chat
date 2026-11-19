# 提交到 dsh.so 的清单

dsh.so 只接受 **GitHub / Gitee / GitLab 仓库** 或 **npm 包**，不支持任意 git 地址。
所以本项目当前的裸仓库（`xdxy-pet.com/git/...`）**过不了它的检查器**——那套自建索引只供朋友手动添加。

## 硬性验收项对照

| dsh.so 要求 | 本项目状态 |
|---|---|
| `package.json` 里有 `dsh` 字段 | ✅ `dsh.bundle` + `dsh.client` |
| README 含安装说明 | ✅ `README.md` |
| 开源许可证 + SPDX 标识 | ✅ MIT（`LICENSE` + `package.json` 的 `license`） |
| 插件 id 形如 `^[a-z0-9]+(-[a-z0-9]+)*$` | ✅ 仓库名 `dsh-share-chat` |
| 有可扫描的源码 | ✅ `client.js` / `index.js` |
| 安全扫描无阻断项 | ⚠️ 待它扫；见下方风险 |

> 注意：`package.json` 的 `name` 是 `@local/dsh-share-chat`。dsh.so 用**仓库名**作插件 id，
> 所以仓库一定要叫 `dsh-share-chat`，别用别的名字。

## 需要你做的（我没有你的代码托管账号）

1. 在 **Gitee 或 GitHub** 建一个**公开**仓库，名字必须是 **`dsh-share-chat`**
2. 把本地仓库推上去（一条命令，见下）
3. 给仓库加 topic：**`dsh-plugin`**（加上后 dsh.so 会自动索引，不用手动提交）
4. 打开 https://www.dsh.so/submit/ ，粘贴仓库地址 → Run checks → 通过后点 Submit

## 推送命令

在 `plugins/share-chat` 目录下：

```sh
git remote add origin https://gitee.com/<你的用户名>/dsh-share-chat.git
git push -u origin main
```

（GitHub 换成 `https://github.com/<用户名>/dsh-share-chat.git`）

## 已知的安全扫描风险

dsh.so 的扫描器会查「硬编码密钥 / 外发端点 / 破坏性操作 / 挖矿」。本插件有两处可能被标为**警告级**（需人工复核，不是阻断）：

1. **硬编码服务器地址** `https://xdxy-pet.com/relay` —— 这是插件自己的后端，不是外发窃取；登录页可改
2. **Host 侧会读会话日志**（`/api/share-chat/transcript`）—— 已限制只回答 loopback 请求

如果被打回，可以在 README 里加一段「数据流向说明」解释这两点，我再补。
