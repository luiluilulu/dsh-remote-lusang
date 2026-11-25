# 用安卓手机远程连接 Windows 上的 DSH（自建 Server + P2P 实测指南）

适用版本：DSH Remote **`0.6.4-own.15`**（本 fork：`luiluilulu/dsh-remote-lusang`，MIT）。
你需要一台已能正常对话的 Windows 10/11 DSH Desktop、一部可安装 APK 的安卓手机，以及一个带有效证书的固定 HTTPS 入口。

> 本文整理自作者 2026-11-11 的真实部署与 P2P 实测记录（原文档在本地 `DSH-Remote-P2P-通用部署指南.md`），
> 已按本 fork 的仓库与版本更新链接。快速版见 [自建 Server 快速上手](self-host-quickstart.zh.md)。

先让手机连上并发出一条消息，再看是否走 P2P。**显示 Relay 也可以正常使用；要确认 P2P，以手机显示的实际路径为准。**

- **登录、发现设备、建立连接**：手机和电脑上的 Host 都访问同一个 Remote Server。Server 跑在电脑上，通过 HTTPS 隧道对外提供入口。
- **传输会话数据**：WebRTC 能直连就走 LAN/P2P，否则经加密 Relay 转发。STUN 只帮两端发现公网候选地址，不转发聊天；TURN 是另一种可选中继。即使 P2P 成功，公网入口仍负责登录和连接协调。
- **自建 Server 只有账号密码登录**：知乎 / GitHub 按钮是作者公共托管部署开启的登录方式，自建实例不会出现。

## 1. 选一个固定入口

已有固定 HTTPS 入口就直接复用。它应转发到 Windows 的 `http://127.0.0.1:3006`，支持 `/ws/v1/connect` 的 WebSocket Upgrade，空闲超时大于 75 秒，并保留客户端的 `Origin`。不要直接开放 Node 的 3006 端口。

**已有 Cloudflare 域名时**，可用命名隧道。安装 [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/) 后，在 PowerShell 执行：

```powershell
cloudflared tunnel login
cloudflared tunnel create dsh-remote
cloudflared tunnel route dns dsh-remote remote.example.com
```

把示例域名换成你的域名。将以下配置存到 `C:\dsh-remote-tunnel\config.yml`，用创建命令返回的隧道 ID 和凭据文件路径替换示例值：

```yaml
tunnel: <隧道 ID>
credentials-file: "C:/Users/<Windows 用户名>/.cloudflared/<隧道 ID>.json"
ingress:
  - hostname: remote.example.com
    service: http://127.0.0.1:3006
  - service: http_status:404
```

用 `cloudflared tunnel --config C:\dsh-remote-tunnel\config.yml run dsh-remote` 启动。等第 2 步的 Server 启动后再检查公网地址。Quick Tunnel 适合临时演示，重建后地址会变，手机保存的入口会失效。

**没有域名时**，可用自己已有授权的 [tunwg 中继](https://github.com/tiann/tunwg)；本次实测用的是这个方案。按服务方说明配置 `TUNWG_API`、`TUNWG_AUTH` 和持久化的 `TUNWG_PATH`，以 `tunwg.exe --json --log_level=0 --forward=http://127.0.0.1:3006` 启动。等日志给出 HTTPS 地址、证书可用后，将其作为下文的公网入口。保留隧道身份和证书目录；`TUNWG_RELAY=true` 是外层隧道的 TCP 回退，与 DSH Remote 是否走 P2P 无关。已有 VPS 也可以用反向隧道接 HTTPS 反代，要求相同；走 DSH Relay 时，业务密文也会经过该入口。

## 2. 在电脑上启动 Remote Server

安装 Git 和 Node.js 24.9+。PowerShell 中用固定版本的 pnpm 构建 Server 和它依赖的协议包：

```powershell
git clone --depth 1 --branch v0.6.4-own.15 https://github.com/luiluilulu/dsh-remote-lusang.git C:\dsh-remote
Set-Location C:\dsh-remote
npx.cmd --yes pnpm@9.15.4 --filter '@dsh-remote/server...' install --frozen-lockfile --ignore-scripts
npx.cmd --yes pnpm@9.15.4 --filter @dsh-remote/protocol build
npx.cmd --yes pnpm@9.15.4 --filter @dsh-remote/server build
New-Item -ItemType Directory -Path C:\dsh-remote-data -Force | Out-Null
```

在 `C:\dsh-remote-data\server.env` 填入以下配置。换成自己的邮箱格式账号、随机强密码（至少 12 个字符）和第 1 步的 HTTPS 地址。`PUBLIC_URL` 只填协议、域名及非默认端口，不带页面路径；它必须与客户端访问的 origin 一致。

```dotenv
DSH_SERVER_ACCOUNT=you@example.com
DSH_SERVER_PASSWORD=<换成你的随机强密码>
DSH_SERVER_PUBLIC_URL=https://remote.example.com
DSH_SERVER_HOST=127.0.0.1
DSH_SERVER_PORT=3006
DSH_SERVER_DATA_FILE=C:/dsh-remote-data/state.json
DSH_SERVER_STUN_URLS=stun:stun.cloudflare.com:3478,stun:global.stun.twilio.com:3478
```

STUN 地址由 Server 下发给 Host 和手机。这里是本次用过的两项，可按两端的实际 UDP 可达性调整；先不配 TURN。`state.json` 存设备记录，连同 `server.env` 和隧道凭据一起保存在本机，别提交到 Git 或发到聊天里。

```powershell
Set-Location C:\dsh-remote\apps\server
node --env-file=C:/dsh-remote-data/server.env dist/main.js
```

保持窗口运行，在另一个 PowerShell 检查下面两条。都应返回 `{"status":"ok"}`。本机通而公网不通，先查隧道和证书。

```powershell
curl.exe --fail --max-time 10 http://127.0.0.1:3006/healthz
curl.exe --fail --max-time 10 https://remote.example.com/healthz
```

## 3. 把电脑和手机接进来

1. **电脑**：在 DSH Desktop 的插件管理里从 GitHub 安装 `luiluilulu/dsh-remote-lusang`（或按 [安装文档](installation.zh.md) 操作 npm/本地包安装），按桌面端提示重载；有运行中的任务时先等它结束。打开 **Remote** 面板，切换到自己的 Server，登录第 2 步设的账号密码，确认“允许控制本机”已开启。Host 的 `forceRelay` 保持默认 `false`。
2. **手机**：从本 fork 的 [v0.6.4-own.15 Release](https://github.com/luiluilulu/dsh-remote-lusang/releases/tag/v0.6.4-own.15) 下载 `dsh-remote-own-0.6.4-own15-arm64.apk`（arm64 试用包，`.trial` 包名），核对 Release 说明里的 SHA-256 后覆盖安装。在首次设置页把**服务器地址**改成同一个地址，保存后用同一账号密码登录。账号属于你自己的 Remote Server，与社区站点和模型平台的账号分开。
3. **试用**：在手机选电脑和一个工作区，发一条测试消息，确认电脑端会话收到且回复能回到手机。若要用 Codex，再确认 Host 能启动本机 `codex app-server`、手机能看到 CodeX 工作区；模型仍使用电脑上的 Codex 配置。

## 4. 确认实际走 P2P

把 App 的传输偏好设为 **自动**。手机切到移动数据后重新连接，在设备详情里看 **连接 → 路径**。显示 **P2P / WebRTC 直连**，并确认手机和电脑不在同一局域网，才算这次跨网验证通过。`srflx` 是 STUN 得到的公网候选；出现它说明收集成功，不能证明最终选中了直连。记录时看实际路径或选中的候选对，不只看候选列表。

**本次实测：**同一台电脑在校园 Wi-Fi 上已经能收集公网候选，但直连失败；把协商等待从 6 秒延长到 20 秒也没解决。电脑改走校园**有线**、手机仍用移动数据后，App 显示 P2P。这是该网络组合的结果；排查时先确认电脑实际走哪块网卡，再比较有线和 Wi-Fi，不据此断言所有校园 Wi-Fi 都不能直连。STUN 可达也不代表两端的 NAT 和 UDP 路径能互通。

**代理 TUN 干扰：**电脑开着 Clash / Mihomo 等代理的 **TUN 模式**时，旧版本会把 `198.18.0.0/15` 等代理网卡地址当作 ICE 候选发出去，导致打洞失败、只能走 Relay。本 fork 从 `own.15` 起修复了这类候选过滤，并识别 Tailscale 接口；仍建议按上面的方法确认实际路径。

## 5. 跑通后再做常驻

手动验证通过后，结束刚启动的 Server 测试进程，避免和守护实例争用端口。示例把 Server 交给 PM2：

```powershell
npm.cmd install -g pm2
Set-Location C:\dsh-remote\apps\server
pm2.cmd start dist/main.js --name dsh-remote-server --node-args="--env-file=C:/dsh-remote-data/server.env"
pm2.cmd list
```

隧道已由系统服务管理时，沿用即可。手动启动的 Cloudflare 命名隧道，可先结束测试进程，再交给 PM2：

```powershell
$dshTunnel = (Get-Command cloudflared.exe -CommandType Application).Source
pm2.cmd start $dshTunnel --name dsh-remote-tunnel --interpreter none -- tunnel --config C:/dsh-remote-tunnel/config.yml run dsh-remote
```

确认 Server 和隧道健康后运行 `pm2.cmd save`。要随 Windows 用户登录启动，把调用 `pm2.cmd resurrect` 的脚本放进该用户的 Startup 文件夹，并使用同一 Windows 账号、同一 `PM2_HOME`。tunwg 若也用 PM2 管理，沿用原有环境变量和身份目录。

验收时确认两条 `/healthz` 都正常，`pm2.cmd logs dsh-remote-server --lines 50 --nostream` 中有 Host 的 `ws_hello_authenticated`，再用手机发一条消息。改 `server.env` 后，只需重启对应 Server 进程让它重新读取文件。

**看门狗按需加。** 本次遇到过隧道进程还在线，但卡在握手循环。可让看门狗每 60 秒检查本机和公网健康接口；连续三次“本机正常、公网失败”才重启隧道，间隔至少五分钟，记录动作与恢复结果。它只解决隧道僵死，和 P2P 成败无关。

## 连不上时先看哪里

| 现象 | 下一步 |
|---|---|
| 本机 `/healthz` 不通 | 看 Server 是否启动、端口是否冲突、配置和启动日志。 |
| 本机通，公网不通 | 看隧道是否连上、证书是否有效、目标端口是否正确。 |
| 两处都通，但找不到 Host | 看 Host 和手机是否用了相同的地址与账号、是否允许控制本机；查 Server 日志里是否有 Host 的 `ws_hello_authenticated`。健康检查 200 不代表 WebSocket 已通过。 |
| 能发消息，但一直显示 Relay | 确认手机选“自动”、Host 没强制 Relay。看 App 连接日志：没有 `srflx`，先查 STUN 下发与 UDP 可达性；有候选但没连上，再换接入网络。已授权连接才能查 `/api/v1/turn/credentials`，未登录请求返回 401 属正常。开了代理 TUN 的先升级到 own.15+。 |
| 页面白屏、JS/CSS 403 | 核对 `DSH_SERVER_PUBLIC_URL` 和访问地址是否为同一 origin，再查反代是否保留 `Origin`。 |
| 登录页只有「账号密码」、没有知乎/GitHub | 正常：自建 Server 不启用 OAuth；OAuth 只存在于作者公共托管部署。 |
