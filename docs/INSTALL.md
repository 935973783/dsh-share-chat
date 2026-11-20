# 安装与排错

DSH 安装插件的三条通道，和「为什么有的插件要 Git」的来龙去脉。

## 一、DSH 怎么装插件

DSH 的插件管理器（`@deepseek-ai/dsh-plugin-manager`）在你的 **profile 目录**里跑 pnpm：

```
<profile>/package.json      dependencies: { "<包名>": "<spec>" }
<profile>/cordis.patch.yml  插件行（由 bundle 的 cordis.patch.yml 合并进来）
```

装什么、要不要 Git，全看这个 `<spec>`：

| spec 形态 | 例子 | 需要 Git |
|---|---|---|
| registry 名称 | `dsh-share-chat@0.2.1` | ❌ |
| tarball 地址 | `https://example.com/dsh-share-chat-0.2.1.tgz` | ❌ |
| 本地路径 | `file:../dsh-share-chat` / `link:…` | ❌ |
| Git 地址 | `git+https://gitee.com/you/repo.git`、`github:you/repo`、`git+ssh://…` | ✅ |

pnpm 对 Git spec 会执行 `git ls-remote` 解析 commit、再 `git clone`/`git archive` 取内容，
所以机器上必须有 `git` 可执行文件。典型报错：

```
[ERR_PNPM_GIT_RESOLVE_FAILED] Failed to resolve git dependency "git+https://…":
git ls-remote failed: 'git' 不是内部或外部命令，也不是可运行的程序
```

另外 DSH 自己还有一层预检：装 **github.com** 地址前会先 `git ls-remote` 探活（`failedAt: 'spec-host'`）。
Gitee / 自建 Git 服务不在这个预检里，但 pnpm 那一关仍然要 Git。

## 二、三种不需要 Git 的装法

### A. tgz（推荐）

```bash
# 发布者（在仓库根目录）
npm pack                       # 生成 dsh-share-chat-0.2.1.tgz
# 也可以手打，注意包内路径必须是 package/ 开头：
tar -czf dsh-share-chat-0.2.1.tgz -C dist package
```

把 tgz 放到能直接 200 返回的地方（不要 302），然后：

```bash
dsh plugin add https://<你的域名>/dl/dsh-share-chat-0.2.1.tgz
```

注意：

- 地址必须是**最终地址**（DSH 的一些 fetch 不跟随重定向）；
- tgz 里的 `package.json` **不能带 BOM**，否则安装器会报 `Unexpected token '\ufeff'` 并自动回滚；
- 包必须声明 `dsh.bundle.patch`（本仓库已声明）。

### B. 本地文件夹

DSH → **插件** → **添加插件** → 选文件夹。等价于 `pnpm add file:<folder>`，不碰 Git。
适合自己改着玩；升级时要重新选一次目录。

### C. npm registry

发布后 `dsh plugin add <包名>` 走 registry，同样不碰 Git。
发布前需要：

1. `package.json` 去掉 `"private": true`
2. `name` 改成你能发布的（如 `dsh-share-chat` 或 `@scope/dsh-share-chat`）
3. `npm publish --access public`

> dsh.so 等插件市场用**仓库名**作为插件 id，仓库名保持 `dsh-share-chat` 最省事。

## 三、常见问题

**Q：同事装的时候提示要 Git，我自己的机器不用？**
他大概是把 `git+https://…` 地址交给了 DSH（或从写着 git 地址的说明里复制的）。
让他改用 tgz 地址，或 `插件 → 添加插件 → 选文件夹`。

**Q：能不能让 DSH 自带 Git？**
不能，DSH 不捆绑 Git。要么改分发方式（上面 A/B/C），要么让用户自己装 Git。

**Q：装完侧栏没有「社交」？**
1. 刷新页面（client 侧是单独打包的，装/更新后需要重载）
2. 左侧栏底部「更多」里找「社交」，点右侧图钉固定
3. 插件页确认 `@local/dsh-share-chat`（或发布名）这一条是启用状态

**Q：更新到新版本怎么做？**
换个 tgz 地址重新安装即可（插件页的更新也是同一套逻辑）；文件目录安装则重新选一次目录。

**Q：公司内网/离线环境？**
把 tgz 下载到内网可访问的静态服务器，或直接用文件夹安装。relay 与小游戏地址可以在登录页 / 设置里改（小游戏地址目前写死，见 `docs/GAME.md`）。

**Q：profile 里装坏了怎么回滚？**
装失败的安装会自动还原 `package.json` / `pnpm-lock.yaml` / `node_modules`；
真要手动改，删掉 profile `package.json` 里那条依赖、去掉 `dsh.profile.bundles` 里的名字，再把 `cordis.patch.yml` 里对应行删掉即可。
