# 自建 Remote Server 快速上手（给朋友看的教程）

> 完整版（含真实 P2P 实测记录、HTTPS 隧道选择、PM2 常驻与排查表）见
> [用安卓手机远程连接 Windows 上的 DSH](self-host-deployment.zh.md)；本文是更短的入门版。

目标：**每个人用自己的电脑当 Host、用自己的 Server 登录**，不经过作者的公共服务器，也不会出现「知乎 / GitHub 登录」。
一次登录后设备凭据会自动续期，日常打开就是无感的。

> 需要准备一台**手机和电脑都能访问**的机器当 Server：公网 VPS + 域名最省心；只在局域网用也可以（手机连同一个 Wi-Fi）。

## 1. 部署 Server

### 方式 A：Docker（推荐）

```bash
git clone https://github.com/luiluilulu/dsh-remote-lusang.git
cd dsh-remote-lusang/apps/server
cp .env.example .env
```

编辑 `.env`（最少这几项）：

```dotenv
DSH_SERVER_ACCOUNT=me@example.com      # 登录账号，建议用邮箱格式
DSH_SERVER_PASSWORD=至少12位的强密码
DSH_SERVER_PUBLIC_URL=https://remote.example.com   # 手机/浏览器实际访问的地址
DSH_SERVER_HOST=0.0.0.0                # 让反向代理能访问；仅本机测试可留 127.0.0.1
DSH_SERVER_PORT=8080
```

```bash
docker compose up -d --build
```

打开 `DSH_SERVER_PUBLIC_URL` 能看到登录页即成功。数据保存在 `server-data` 卷，`docker compose down` 不会删数据。

### 方式 B：不用 Docker

需要 Node.js 22 + pnpm 9：

```bash
pnpm install
pnpm --filter @dsh-remote/protocol build
pnpm --filter @dsh-remote/server build
cp apps/server/.env.example apps/server/.env   # 同上编辑
cd apps/server && node --env-file=.env dist/main.js
```

### HTTPS 反向代理（公网必须）

Caddy 示例（自动证书）：

```caddy
remote.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Nginx 需要额外转发 WebSocket（`/ws/v1/connect`）：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
    proxy_read_timeout 300s;
}
```

要点：`DSH_SERVER_PUBLIC_URL` 必须和浏览器地址完全一致（协议/域名/端口），否则会出现首页能开、JS/CSS 403 白屏。

## 2. 电脑端：装 Host 插件并登录

1. 在 DeepSeek Harness 的插件管理里从 GitHub 安装 `luiluilulu/dsh-remote-lusang`（或按 [安装文档](installation.zh.md) 操作），重启 DSH。
2. 打开侧边栏 **Remote** → 设置里把服务器地址改成你的 `https://remote.example.com`。
3. 登录方式选「账号密码」，填第 1 步设置的账号密码 —— **自建 Server 没有知乎/GitHub 按钮，只有账号密码**。
4. 登录后这台电脑就作为 Host 出现在你的账号下。

## 3. 手机端：同一个服务器 + 同一个账号

1. 安装 Android 客户端（本项目 Releases 里的 APK，或自己构建）。
2. 首次设置页把**服务器地址**改成同一个 `https://remote.example.com`，保存。
3. 选择账号密码登录，填同一账号 —— 登录一次后 access/refresh token 自动续期，之后打开 App 不需要再输密码。
4. 设备列表里选中你的电脑，即可打开 Workspace / 会话。

多台手机、另一台电脑同理：都填同一个 Server、登录同一个账号。**不同账号之间互相看不到对方的 Host。**

## 4. 想要 P2P 直连（可选）

默认没有 STUN/TURN 时会走加密 Relay（能用，但延迟高一些）。想直连：

```dotenv
# 公网 STUN，大多数家庭网络够用
DSH_SERVER_STUN_URLS=stun:stun.l.google.com:19302

# 对称 NAT / 移动网络打洞失败时再配 TURN（coturn）
DSH_SERVER_TURN_URLS=turn:turn.example.com:3478?transport=udp
DSH_SERVER_TURN_SECRET=你的coturn共享密钥
```

改完 `docker compose up -d --force-recreate server`。

另外：如果电脑上开着 Clash 等代理的 **TUN 模式**，请把手机 App 和 Host 插件都升到 **0.6.4-own.15 及以上**——该版本修复了代理 TUN 的 `198.18.0.0/15` ICE 候选泄漏，开着 TUN 也能正常打洞。

## 5. 常见问题

- **为什么用作者的公共服务器会让我用知乎登录？**
  公共部署（`dsh.r2049.cn` / `relay.hapi.run`）开启了知乎/GitHub OAuth 作为登录方式；登录是**按账号隔离**的：Host 只是挂在某个账号下的设备，别人用别的账号看不到你的电脑。自建 Server 只有你设置的账号密码，所以不会出现知乎按钮。
- **手机白屏 / JS 403**：`DSH_SERVER_PUBLIC_URL` 与实际访问地址不一致，或反向代理没保留 `Origin`/WebSocket。
- **一直显示 Relay**：没配 STUN（或 NAT 太严格需 TURN）；也可能本机代理 TUN 干扰（升级 own.15+）。
- **换服务器**：Host 插件和 App 的设置里都能改服务器地址，改完需要重新登录一次。
- **想「扫码即用、完全不要账号」**：仓库里有设备配对协议 v1（电脑展示二维码 → 手机扫码 → 电脑输入 8 位验证码），服务端已实现，但 Android/Host 的配对界面还没接入，属于后续开发项。

## 6. 安全提醒

- 单账号部署意味着**所有登录该账号的设备都拥有这台电脑的同等控制权**，不要把密码发到群里。
- 公网部署必须 HTTPS；不要直接把 8080 暴露到公网。
- 多账号共享 Host、Remote Web 完整站点等能力不在本仓库的最小 Server 范围内。

---

相关文档：[自部署 Server 说明](../apps/server/README.zh.md) · [安装](../docs/installation.zh.md) · [网络与传输](network.md) · [安全边界](../README.zh.md#安全边界)
