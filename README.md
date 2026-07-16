# OneDev Webhook → 钉钉群机器人

接收 OneDev JSON Webhook 并发送钉钉 Markdown 通知。构建生命周期事件只通知配置的 Job（默认 `deploy`）。

## 本地运行

需要 Node.js 20.6.0 或更高版本。

```bash
cp .env.example .env
```

编辑 `.env`，填入钉钉配置和 OneDev 只读 Access Token，然后执行：

```bash
npm install
```

```bash
node --env-file=.env src/server.js
```

服务监听 `http://localhost:8099`。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `PORT` | 否 | 监听端口，默认 `8099` |
| `ONEDEV_WEBHOOK_SECRET` | 否 | 配置后校验 `X-OneDev-Webhook-Secret` 请求头 |
| `ONEDEV_URL` | 是 | 供服务调用 OneDev `/~api` REST 接口的内部服务根地址 |
| `ONEDEV_PUBLIC_URL` | 否 | 钉钉消息中 Build 链接使用的用户可访问根地址；未设置时使用 `ONEDEV_URL` |
| `ONEDEV_ACCESS_TOKEN` | 是 | 仅读取 Build 和 Project 所需的 OneDev Access Token；不要提交到仓库 |
| `ONEDEV_NOTIFY_JOB` | 否 | 要通知的 OneDev Job，默认 `deploy` |
| `DINGTALK_ACCESS_TOKEN` | 是 | 钉钉群机器人 access token |
| `DINGTALK_SECRET` | 否 | 钉钉机器人加签 secret |

`ONEDEV_ACCESS_TOKEN` 必须仅授予目标项目的读取权限，以读取 Build 和 Project；不要使用管理员 Token。

## 构建通知规则

服务收到 `BuildRunning` 或 `BuildFinished` 后，先验证 `buildId` 是正整数或正数字字符串，再通过 `ONEDEV_URL/~api` 查询 Build，确认其 `jobName` 与 `ONEDEV_NOTIFY_JOB` 一致，再按 `projectId` 查询 Project 以展示项目名称。OneDev API 始终使用内部 `ONEDEV_URL`；钉钉中的 Build 链接使用 `ONEDEV_PUBLIC_URL`，未设置时才回退到 `ONEDEV_URL`。

- 匹配的 `deploy` `BuildRunning` 发送一条“开始”通知。
- 匹配的 `deploy` `BuildFinished` 发送一条最终结果通知：`SUCCESSFUL` 为成功，`FAILED`、`CANCELLED`、`TIMED_OUT` 为失败。
- `BuildPending`、`BuildUpdated` 等中间构建事件、缺少或无效 `buildId` 的构建事件，以及非目标 Job 都以 `200` 确认并不发送钉钉通知；非目标 Job 不查询 Project。
- 已匹配 Job 的 `BuildFinished` 若 API 返回缺失或未知最终状态，会返回通用 `502` 且不发送钉钉，避免把不确定结果通知为 `UNKNOWN`。

## Docker 部署

```bash
cp .env.example .env
```

编辑 `.env` 后执行：

```bash
docker compose up -d --build
```

```bash
curl http://localhost:8099/health
```

如果 OneDev 与服务不在同一个 Docker network，可将服务加入 OneDev 所在 network，例如在 `docker-compose.yml` 增加该 network 的声明与 `networks` 配置。不要擅自假设现有 network 名称。

Compose 会读取当前目录的 `.env`。本仓库的容器化部署使用 `ONEDEV_URL=http://172.17.0.1:6610` 访问 Docker 宿主机上的 OneDev，并使用 `ONEDEV_PUBLIC_URL=http://175.178.115.41:6610` 生成用户可打开的钉钉链接；请确认该地址和端口可从容器访问。

## 钉钉机器人配置

1. 在钉钉群中创建自定义机器人。
2. 获取机器人 access token。
3. 可选开启加签，获取 secret。
4. 将 token 和 secret 写入 `.env` 的 `DINGTALK_ACCESS_TOKEN` 与 `DINGTALK_SECRET`。

## OneDev 配置

Webhook 请求方法使用 `POST`，请求头使用 `X-OneDev-Webhook-Secret: your-secret`。

在目标 OneDev 项目的 Job Secrets 中创建名为 `onedev-access-token` 的 Secret，并写入同一个只读 Access Token。`deploy` Job 会将它注入为 `ONEDEV_ACCESS_TOKEN`，不会把 Token 写入 buildspec。

同一 Docker network：

```text
http://onedev-dingtalk:8099/webhook/onedev
```

服务器 IP：

```text
http://服务器IP:8099/webhook/onedev
```

外网 HTTPS 域名：

```text
https://notify.example.com/webhook/onedev
```

注意：

- OneDev 与服务在同一 Docker network 时使用容器服务名。
- 不要在 OneDev 容器中使用 `localhost` 访问另一个容器。
- Docker 容器访问宿主机 OneDev API 时使用 `http://172.17.0.1:6610`；钉钉链接使用用户可访问的 `http://175.178.115.41:6610`；宿主机访问服务使用 `http://localhost:8099`。
- 使用服务器 IP 时，确保防火墙允许访问 `8099` 端口。
- 对公网开放时，建议通过 Caddy 或 Nginx 配置 HTTPS。
- OneDev Webhook 不能直接填写钉钉机器人地址，因为双方 JSON 格式不一致。

## curl 测试

```bash
curl -X POST http://localhost:8099/webhook/onedev -H "Content-Type: application/json" -H "X-OneDev-Webhook-Secret: change-me" -d '{"type":"BuildFinished","buildId":123,"date":"2026-07-16T10:00:00Z"}'
```

将示例中的 `123` 替换为目标 `deploy` Build 的真实 Build ID；服务会用该 ID 从 OneDev 查询 Job、项目和最终状态。

## 接口

- `GET /health`：返回 `{"status":"UP"}`。
- `POST /webhook/onedev`：接收任意 JSON Payload；钉钉发送成功返回 `200`，发送失败返回 `502`。

当前 MVP 只做常见 Push、Build、Pull Request、Issue 识别；不使用数据库、Redis、消息队列或事件去重缓存。每收到一次 Webhook 都会独立尝试发送一次通知，重复投递可能产生重复消息。
