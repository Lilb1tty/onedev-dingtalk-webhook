# OneDev Webhook → 钉钉群机器人

最小可用通知服务：接收 OneDev JSON Webhook，生成 Markdown 消息，并发送到钉钉群机器人。

## 本地运行

需要 Node.js 20 或更高版本。

```bash
cp .env.example .env
```

编辑 `.env` 填入钉钉配置，然后执行：

```bash
npm install
```

```bash
node src/server.js
```

服务监听 `http://localhost:8099`。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `PORT` | 否 | 监听端口，默认 `8099` |
| `ONEDEV_WEBHOOK_SECRET` | 否 | 配置后校验 `X-OneDev-Webhook-Secret` 请求头 |
| `DINGTALK_ACCESS_TOKEN` | 是 | 钉钉群机器人 access token |
| `DINGTALK_SECRET` | 否 | 钉钉机器人加签 secret |

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

## 钉钉机器人配置

1. 在钉钉群中创建自定义机器人。
2. 获取机器人 access token。
3. 可选开启加签，获取 secret。
4. 将 token 和 secret 写入 `.env` 的 `DINGTALK_ACCESS_TOKEN` 与 `DINGTALK_SECRET`。

## OneDev 配置

Webhook 请求方法使用 `POST`，请求头使用 `X-OneDev-Webhook-Secret: your-secret`。

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
- 使用服务器 IP 时，确保防火墙允许访问 `8099` 端口。
- 对公网开放时，建议通过 Caddy 或 Nginx 配置 HTTPS。
- OneDev Webhook 不能直接填写钉钉机器人地址，因为双方 JSON 格式不一致。

## curl 测试

```bash
curl -X POST http://localhost:8099/webhook/onedev -H "Content-Type: application/json" -H "X-OneDev-Webhook-Secret: change-me" -d '{"@class":"io.onedev.server.event.build.BuildFinished","project":{"name":"demo-project"},"build":{"number":128,"status":"FAILED"},"user":{"name":"Owen"},"url":"https://onedev.example.com/demo/~builds/128"}'
```

## 接口

- `GET /health`：返回 `{"status":"UP"}`。
- `POST /webhook/onedev`：接收任意 JSON Payload；钉钉发送成功返回 `200`，发送失败返回 `502`。

当前 MVP 只做常见 Push、Build、Pull Request、Issue 识别；不使用数据库、Redis、消息队列或事件去重缓存。
