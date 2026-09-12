# NapCatQQ-Code-Gids

基于 NapCat 的 QQ 农场扫码授权服务。用户完成 QQ 扫码后，插件在 NapCat 内部获取小程序授权
Code，读取已授权的 QQ 好友 OpenID，再使用 QQ 农场 WebSocket 协议执行登录和 `SyncAll`，最终
同步返回 Code、好友 OpenID 和农场好友 GID。

本项目是非官方工具，与腾讯、QQ、QQ 农场及 NapCat 官方没有隶属关系。请遵守相关服务条款，
仅处理本人有权使用的账号和数据。

## 工作流程

```text
QQ 扫码确认
    -> NapCat 小程序 OpenAuth
    -> 获取短期 Code
    -> 查询已授权 QQ 好友 OpenID
    -> 登录 QQ 农场 WebSocket
    -> FriendService.SyncAll
    -> 返回 Code + friendOpenIds + friendGids
    -> 注销 QQ 会话
```

所有步骤均在 NapCat 容器内完成。项目不会将 Code、好友 OpenID、好友 GID 或 QQ 登录目录挂载到
宿主机。

## 功能

- QQ 扫码登录和小程序授权 Code 获取。
- QQ 好友关系查询及 QQ 农场好友 GID 同步。
- 内置 QQ 农场 protobuf、WebSocket 和 TSDK 协议适配。
- 同一时间只执行一个好友同步请求，避免账号会话互相覆盖。
- WebUI 和插件 API 共用随机 Bearer Token。
- QQ 配置、登录缓存、NapCat 日志和临时文件使用 `tmpfs`，容器停止后自动清除。
- 禁止 QQ/Chromium 生成 WSL 崩溃转储，避免巨型 `.dmp` 占满系统盘。
- 针对 NapCat 4.18.19 的容器重启兼容补丁。

## 环境要求

- Docker Engine 或 Docker Desktop
- Docker Compose v2
- `linux/amd64` 或 `linux/arm64`
- 能正常访问 QQ 和 QQ 农场服务

默认基础镜像固定为 `mlikiowa/napcat-docker:v4.18.19`。不要直接改成 `latest`；升级 NapCat 前
需要重新核对 [bootstrap.cjs](./bootstrap.cjs) 中的版本相关补丁。

## 快速开始

1. 创建本地配置：

```bash
cp .env.example .env
```

Windows PowerShell 可以这样生成 Token：

```powershell
Copy-Item .env.example .env
$bytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$token = [Convert]::ToHexString($bytes).ToLowerInvariant()
(Get-Content .env) -replace '^NAPCAT_TOKEN=.*$', "NAPCAT_TOKEN=$token" | Set-Content .env
```

Linux/macOS 可以这样生成 Token：

```bash
sed -i.bak "s/^NAPCAT_TOKEN=.*/NAPCAT_TOKEN=$(openssl rand -hex 32)/" .env
rm -f .env.bak
```

`.env` 已被 Git 和 Docker 构建上下文忽略，不要提交或公开其中的 Token。

2. 构建并启动：

```bash
docker compose up -d --build
```

3. 打开 NapCat WebUI：

```text
http://localhost:6099
```

WebUI Token 就是 `.env` 中的 `NAPCAT_TOKEN`。端口默认只绑定到 `127.0.0.1`，不会直接暴露到
局域网或公网。

停止服务：

```bash
docker compose down
```

扫码和 QQ 会话数据保存在内存文件系统中，停止容器后无法恢复，需要重新扫码。这是预期行为。

## API

插件 API 前缀：

```text
http://localhost:6099/plugin/qq-miniapp-openauth/api
```

所有插件接口都要求：

```http
Authorization: Bearer <NAPCAT_TOKEN>
```

### 状态

```http
GET /plugin/qq-miniapp-openauth/api/status
```

只有 QQ 已完成登录且 NapCat 上下文可用时，`ready` 才会为 `true`。

### 获取 Code 和好友 GID

```http
POST /plugin/qq-miniapp-openauth/api/miniapp
Content-Type: application/json
Authorization: Bearer <NAPCAT_TOKEN>

{
  "appId": "1112386029",
  "clientVersion": "1.14.0.4_20260911",
  "interactive": true
}
```

成功响应结构：

```json
{
  "ok": true,
  "operation": "loginWithAppId",
  "code": "short-lived-miniapp-code",
  "uin": "current-account",
  "nickname": "current-nickname",
  "friendOpenIds": ["32-character-open-id"],
  "friendOpenIdCount": 1,
  "friendGids": [123456789],
  "friendGidCount": 1,
  "gidSync": "farm_websocket",
  "gidSyncError": ""
}
```

Code 是短期凭证，调用方应立即使用且不得记录到日志。`friendGids` 不包含当前账号和系统账号。

### 注销

```http
POST /plugin/qq-miniapp-openauth/api/logout
Authorization: Bearer <NAPCAT_TOKEN>
```

接口不会回传 NapCat 底层注销结果，避免意外暴露会话字段。

## 接入 qq-farm-bot

本 Compose 会创建 `qq-farm-network` 网络。农场后端容器加入该网络后，可使用以下地址：

```dotenv
NAPCAT_LOGIN_ENABLED=true
NAPCAT_TOKEN=<与本项目 .env 完全相同的 Token>
NAPCAT_WEBUI_URL=http://napcat:6099/api
NAPCAT_OPENAUTH_URL=http://napcat:6099/plugin/qq-miniapp-openauth/api
```

先启动本项目，再启动农场后端。Token 只通过环境变量提供，不再使用共享目录或 Token 文件。

## 数据与安全

- `.env` 是唯一需要保留的本地敏感配置，仅包含服务间认证 Token。
- QQ 登录数据、NapCat 配置和日志位于 `tmpfs`，不会写入宿主机项目目录。
- Docker 日志驱动设为 `none`，避免账号信息进入持久化容器日志。
- 源码不包含真实 Token、Cookie、私钥、个人 QQ 号或好友数据。
- AppID、农场服务地址、协议字段、版本号和依赖完整性摘要属于客户端协议配置，不是个人凭证。
- API 端口只监听本机；如需通过反向代理开放，必须额外配置 TLS、访问控制和限流。

## 排查

二维码暂未生成时，不要连续调用刷新接口。刷新只触发 QQ 原生生成流程，客户端应轮询读取二维码并
设置合理超时。容器重启通常需要十几秒，调用方应处理短暂的连接拒绝并重新认证 WebUI Credential。

检查容器状态：

```bash
docker compose ps
```

出于隐私考虑，本项目默认禁用了容器日志。临时排查时可以在本地修改 Compose 日志驱动，但不要将
包含账号、Code、OpenID 或 GID 的日志提交到仓库。

## 开源发布

仓库当前不包含个人凭证或运行数据，`.gitignore` 也会排除 `.env`、日志、转储和数据目录。正式
发布前仍需由项目所有者选择合适的开源许可证并添加 `LICENSE`；没有许可证的公开仓库不代表授权
他人复制、修改或分发。
