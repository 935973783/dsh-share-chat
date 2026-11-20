# 会议（音视频）

在社交插件里开会：≤6 人，音频 + 视频 + 屏幕共享，**没有时长限制**。

## 怎么用

1. 聊天页顶栏点 **📹 开会**
2. `＋ 新建会议` → 拿到 6 位房间号；点 `📋 房间号` 复制，发给好友
3. 对方同样点 **📹 开会**，把房间号贴进输入框 → `加入`
4. 底部工具栏：`🎤` 麦克风、`🎥` 摄像头、`🖥` 共享屏幕、`📋` 复制房间号、`🚪` 离开
5. 窗口可拖标题栏移动、右下角改大小；`Esc` 离开

首次进会浏览器会要摄像头/麦克风权限。DSH 在 `http://127.0.0.1` 上，属于安全上下文，正常能授权；
如果哪天用局域网 IP 或公网 http 打开 DSH，浏览器会直接禁用摄像头。

## 它是怎么工作的

```
浏览器 A ──SDP/ICE──▶ relay(/api/meet/.../signal) ──▶ 浏览器 B
    └────────────── 媒体 P2P（SRTP，DTLS）──────────────┘
```

- **媒体不经过服务器**：浏览器之间 WebRTC 直连，relay 只转发信令和成员状态。所以不吃服务器带宽，也没有时长限制。
- **信令**：SSE 长连接（`GET /api/meet/rooms/<id>/events`），服务端零依赖手写 `text/event-stream`；nginx 侧 `proxy_buffering off`、读超时 1 小时。
- **拓扑**：网状（mesh）——新加入的人对每个已在场的人各建一条 `RTCPeerConnection` 并主动发 offer；老成员只应答，避免 glare。
- **NAT 穿透**：目前只配了公共 STUN（Cloudflare / Google）。对称 NAT 或运营商 CGNAT 下会连不上，界面标 `⚠ 可能需要对端 TURN`。

## relay 新增接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/meet/rooms` | 建会议，返回 6 位房间号 |
| GET | `/api/meet/rooms/<id>` | 房间信息（加入前探测） |
| POST | `/api/meet/rooms/<id>/join` | 加入，返回 `peerId` 与成员列表 |
| GET | `/api/meet/rooms/<id>/events?peer=&token=` | SSE：`snapshot` / `peer-joined` / `peer-left` / `peer-state` / `signal` |
| POST | `/api/meet/rooms/<id>/signal` | 转发 SDP/ICE 给指定 peer，对方不在线返回 `delivered:false` |
| POST | `/api/meet/rooms/<id>/state` | 更新静音/摄像头/共享状态并广播 |
| POST | `/api/meet/rooms/<id>/leave` | 离开；房间空了自动删 |

房间与成员只在内存里（`MEET` / `MEET_STREAMS`），不写 `db.json`；SSE 断开即视为离开。

## 规模与代价

mesh 天然适合小会：每个人要往 N-1 个人各发一路视频，**上传带宽 ×(N-1)**。
480p 大约每人 0.5–1 Mbps，6 人时上行要 3–5 Mbps。人再多就得上 SFU（LiveKit/mediasoup），那是另一个工程。

## 下一步：TURN

对称 NAT 的兜底要在服务器加 coturn：

```bash
dnf install -y coturn
# /etc/coturn/turnserver.conf：listening-port=3478、tls-listening-port=5349、realm、user/static-auth-secret
systemctl enable --now coturn
```

并在腾讯云 Lighthouse 控制台的**防火墙**放行 UDP 3478（以及 5349/TCP，如果要用 TLS）。
放行之后把地址填进 `client.js` 的 `MEET_ICE`：

```js
{ urls: 'turn:turn.你的域名:3478', username: 'u', credential: 'p' }
```

## 已知限制

- 最多 6 人（mesh），更多需要 SFU
- 没有服务端录制、没有主持人控制、没有等候室、没有密码锁（房间号就是凭据，介意的话后续加）
- 屏幕共享是「替换本路视频」，所以共享时别人看到的是屏幕而不是你的摄像头
- 只测过信令链路（无头测试覆盖 snapshot/join/signal/state/left/清理），**真实音视频需要两台机器实际连一次**才能确认 NAT 与权限
