# OneDev Webhook → 钉钉群机器人

[English](README.en.md) | 中文

接收 OneDev Webhook，将 Push、Build、Pull Request、Issue 等事件转换为钉钉 Markdown 通知。支持按 OneDev 项目把通知发送到不同钉钉群。

## 工作方式

```text
OneDev 项目事件
→ POST /webhook/onedev
→ 校验 X-OneDev-Webhook-Secret
→ 根据项目路径选择钉钉机器人
→ 发送钉钉 Markdown 消息
```

- 默认端口和仓库部署端口均为 `8099`。
- Build 通知只处理 `BuildRunning` 和 `BuildFinished`，并只通知配置的 Job。
- 未配置钉钉机器人的项目会返回 `200`，但 `notificationSent` 为 `false`，不会误发到其他群。
- 不使用数据库、Redis、消息队列或事件去重缓存。

## 最快配置：使用 OneDev 自动部署

当前仓库的 [.onedev-buildspec.yml](.onedev-buildspec.yml) 已包含测试和 Docker 部署任务。按下面步骤配置后，推送 `master` 即可自动部署。

部署前请确认：

- OneDev 中存在名为 `builder` 的 Job Executor，与 buildspec 的 `jobExecutor: builder` 一致。
- 该 Executor 可以使用 Docker 构建镜像并在目标服务器运行容器。
- 服务器 TCP `8099` 未被其他服务占用。
- 部署容器可以访问 OneDev API 和公网钉钉 API。

### 1. 为每个钉钉群创建机器人

1. 进入钉钉群设置，添加“自定义机器人”。
2. 复制机器人 URL 中 `access_token=` 后面的值，只保存 token，不要保存完整 URL。
3. 建议开启“加签”，复制 `SEC` 开头的 secret。
4. 每个需要独立通知的 OneDev 项目使用自己的群机器人。

项目机器人配置格式如下，必须是单行合法 JSON：

```json
{"BNA":{"accessToken":"BNA_ACCESS_TOKEN","secret":"BNA_SIGN_SECRET"},"CHI":{"accessToken":"CHI_ACCESS_TOKEN","secret":"CHI_SIGN_SECRET"}}
```

如果某个机器人没有开启加签，将 `secret` 设置为空字符串：

```json
{"BNA":{"accessToken":"BNA_ACCESS_TOKEN","secret":""}}
```

JSON 的键应优先使用 OneDev 完整项目路径。例如项目位于 `products/BNA`，应配置：

```json
{"products/BNA":{"accessToken":"BNA_ACCESS_TOKEN","secret":"BNA_SIGN_SECRET"}}
```

### 2. 创建 OneDev 只读 Access Token

服务处理 Build 或 Issue Webhook 时，需要调用 OneDev `/~api/builds/{id}`、`/~api/issues/{id}` 和 `/~api/projects/{id}` 查询事件详情与所属项目。

1. 使用专用 OneDev 用户，或在个人 Access Tokens 页面创建 Token。
2. 确保该用户对需要通知的项目具有 Build 和 Project 读取权限。
3. 不要使用管理员 Token，也不要把 Token 提交到仓库。

### 3. 在通知服务项目中创建三个 Job Secrets

进入本通知服务项目的 `Settings → Build Settings → Job Secrets`，创建以下 Secret。名称必须完全一致：

| Job Secret 名称 | 值 | 用途 |
| --- | --- | --- |
| `onedev-webhook-secret` | 自己生成的随机字符串 | 校验 OneDev Webhook 请求头 |
| `onedev-access-token` | 上一步创建的 OneDev Access Token | 查询 Build、Issue 和 Project |
| `dingtalk-project-robots` | 上面的单行项目机器人 JSON | 按项目选择钉钉群 |

可以使用下面的命令生成 Webhook Secret，然后将输出同时用于 `onedev-webhook-secret` 和各目标项目的请求头：

```bash
openssl rand -hex 32
```

Job Secret 中只填写原始值，不要填写环境变量名。例如 `dingtalk-project-robots` 的值应该是：

```json
{"BNA":{"accessToken":"BNA_ACCESS_TOKEN","secret":"BNA_SIGN_SECRET"}}
```

不要填写：

```properties
DINGTALK_PROJECT_ROBOTS={"BNA":{"accessToken":"BNA_ACCESS_TOKEN","secret":"BNA_SIGN_SECRET"}}
```

旧的 `dingtalk-access-token` 和 `dingtalk-secret` 已不再使用，可以删除。

### 4. 检查 OneDev 部署参数

仓库 buildspec 当前使用：

```text
PORT=8099
ONEDEV_URL=http://172.17.0.1:6610
ONEDEV_PUBLIC_URL=
ONEDEV_NOTIFY_JOBS=deploy,CD Backend - dev,CD Sites - dev
```

- `ONEDEV_URL`：容器访问 OneDev API 的内部地址。
- `ONEDEV_PUBLIC_URL`：钉钉消息中可供用户打开的 OneDev 地址。
- `ONEDEV_NOTIFY_JOBS`：允许发送通知的 Job 名称，逗号分隔并精确匹配。

如果部署到其他服务器，请先修改 [.onedev-buildspec.yml](.onedev-buildspec.yml) 中这三个值。Linux Docker 容器访问宿主机时常用 `172.17.0.1`，但实际地址应以你的 Docker 网络为准。

运行以下命令校验 buildspec：

```bash
tod build check-spec
```

### 5. 推送并部署

推送 `master` 后，OneDev 会自动运行：

1. `test`：在 Node.js 20 容器中执行测试。
2. `deploy`：构建镜像、替换 `onedev-dingtalk` 容器并等待健康检查通过。

部署后验证：

```bash
curl http://服务器IP:8099/health
```

预期返回：

```json
{"status":"UP"}
```

### 6. 在目标 OneDev 项目配置 Webhook

每个需要通知的项目都要配置 Webhook。进入目标项目的 `Settings → Web Hooks`，填写：

- Method：`POST`
- Event：至少选择 `BUILD`；需要其他通知时再选择 Push、Pull Request 或 Issue
- URL：根据网络环境选择下面之一
- Header：`X-OneDev-Webhook-Secret`
- Header 值：必须与 `onedev-webhook-secret` 完全一致

OneDev 与通知服务在同一 Docker network：

```text
http://onedev-dingtalk:8099/webhook/onedev
```

OneDev 通过服务器 IP 访问：

```text
http://服务器IP:8099/webhook/onedev
```

通过公网 HTTPS 域名访问：

```text
https://notify.example.com/webhook/onedev
```

注意：

- 不要在 OneDev 容器中使用 `localhost` 访问另一个容器。
- 使用服务器 IP 时，确保防火墙允许访问 TCP `8099`。
- 对公网开放时，建议使用 Caddy 或 Nginx 配置 HTTPS。
- OneDev Webhook 不能直接填写钉钉机器人 URL，因为双方 JSON 格式不一致。

### 7. 发送测试通知

下面的命令不查询 OneDev Build API，适合快速验证项目路由。把 `BNA` 改成 `dingtalk-project-robots` 中真实存在的项目键：

```bash
curl -X POST http://localhost:8099/webhook/onedev -H "Content-Type: application/json" -H "X-OneDev-Webhook-Secret: change-me" -d '{"type":"Push","project":{"name":"BNA"},"actor":{"name":"Tester"},"url":"https://onedev.example.com/BNA"}'
```

成功发送：

```json
{"success":true,"eventType":"PUSH","notificationSent":true}
```

项目未匹配：

```json
{"success":true,"eventType":"PUSH","notificationSent":false}
```

## 使用 Docker Compose 部署

Docker Compose 使用 `.env`，不读取 OneDev Job Secrets。

```bash
cp .env.example .env
```

编辑 `.env`：

```properties
PORT=8099
ONEDEV_WEBHOOK_SECRET=replace-with-random-secret
ONEDEV_URL=http://172.17.0.1:6610
ONEDEV_PUBLIC_URL=https://onedev.example.com
ONEDEV_ACCESS_TOKEN=replace-with-read-only-token
ONEDEV_NOTIFY_JOBS="deploy,CD Backend - dev,CD Sites - dev"
DINGTALK_PROJECT_ROBOTS={"BNA":{"accessToken":"BNA_ACCESS_TOKEN","secret":"BNA_SIGN_SECRET"}}
```

启动并验证：

```bash
docker compose up -d --build
```

```bash
curl http://localhost:8099/health
```

如果 OneDev 也运行在 Docker 中，可将服务加入 OneDev 所在的 Docker network，并使用服务名 `onedev-dingtalk:8099`。不要假设现有 network 名称，请根据实际 Compose 配置添加 external network。

## 本地运行

需要 Node.js 20.6.0 或更高版本。

```bash
cp .env.example .env
```

```bash
npm install
```

```bash
node --env-file=.env src/server.js
```

服务监听 `http://localhost:8099`。

## 配置对照

OneDev 自动部署和本地 Docker Compose 使用不同的配置入口：

| 应用环境变量 | Docker Compose `.env` | OneDev 自动部署 |
| --- | --- | --- |
| `PORT` | `PORT` | buildspec 固定为 `8099` |
| `ONEDEV_WEBHOOK_SECRET` | `ONEDEV_WEBHOOK_SECRET` | Job Secret `onedev-webhook-secret` |
| `ONEDEV_URL` | `ONEDEV_URL` | buildspec 中配置 |
| `ONEDEV_PUBLIC_URL` | `ONEDEV_PUBLIC_URL` | buildspec 中配置 |
| `ONEDEV_ACCESS_TOKEN` | `ONEDEV_ACCESS_TOKEN` | Job Secret `onedev-access-token` |
| `ONEDEV_NOTIFY_JOBS` | `ONEDEV_NOTIFY_JOBS` | buildspec 中配置 |
| `DINGTALK_PROJECT_ROBOTS` | `DINGTALK_PROJECT_ROBOTS` | Job Secret `dingtalk-project-robots` |

## 通知规则

- `BuildRunning`：发送 Build Started。
- `BuildFinished`：`SUCCESSFUL` 发送成功；`FAILED`、`CANCELLED`、`TIMED_OUT` 发送失败。
- `BuildPending`、`BuildUpdated`、缺少或无效 `buildId`、非目标 Job：返回 `200`，不发送。
- 已匹配 Job 但最终状态未知：返回 `502`，不发送错误结论。
- 带有效 `issueId` 的 `Issue*` Webhook：查询 Issue 和 Project，并按动作发送通知：`IssueOpened` 为 New issue created，`IssueCommentCreated` 为 New comment，带旧/新状态的 `IssueChanged` 为 Issue status changed，其他 `IssueChanged` 为 Issue content modified。
- Push、Pull Request、没有 `issueId` 的 Issue Payload 和未知 Payload：尽可能提取常见字段并生成通用消息。
- Build 事件优先按 `project.path`，再按 `project.name` 选择机器人；普通事件还支持 `repository.path` 和 `repository.name`。
- 每次 Webhook 都独立处理；OneDev 重复投递可能产生重复通知。

## 接口

### `GET /health`

```json
{"status":"UP"}
```

### `POST /webhook/onedev`

- Content-Type：`application/json`
- 可选请求头：`X-OneDev-Webhook-Secret`
- 发送成功返回 `200`
- 钉钉 HTTP 或业务错误返回 `502`
- Webhook secret 不匹配返回 `401`

## 常见问题

### 返回 `notificationSent: false`

Payload 或 OneDev API 返回的项目路径没有匹配 `DINGTALK_PROJECT_ROBOTS`。优先检查完整 `project.path`，并确认大小写完全一致。

### Build 没有通知

检查：

1. 目标项目 Webhook 是否订阅 `BUILD`。
2. 是否产生 `BuildRunning` 或 `BuildFinished`。
3. Build 的 `jobName` 是否在 `ONEDEV_NOTIFY_JOBS` 中。
4. `onedev-access-token` 是否能读取目标项目的 Build 和 Project。

### Issue 操作没有通知

检查目标项目 Webhook 是否订阅 `ISSUE`，并确认 `onedev-access-token` 可以读取目标项目的 Issue 和 Project。带 `issueId` 的 `Issue*` 事件会自动查询详情后按项目路由。

### 返回 `401`

目标项目 Webhook Header 中的 `X-OneDev-Webhook-Secret` 与通知服务配置不一致。

### 返回 `502`

常见原因是 OneDev API 不可访问、Access Token 权限不足、钉钉 token/secret 错误、钉钉机器人安全设置不满足，或钉钉返回非零 `errcode`。

### 钉钉中的 Build 链接打不开

将 `ONEDEV_PUBLIC_URL` 配置为测试人员可访问的地址，不要使用仅容器内部可访问的主机名。

## 安全建议与限制

- 所有 Token 和 Secret 只存放在 `.env` 或 OneDev Job Secrets 中。
- `.env` 已被 `.gitignore` 忽略；不要把真实密钥写入 README、buildspec 或提交记录。
- 对外开放 Webhook 时应配置 `ONEDEV_WEBHOOK_SECRET` 和 HTTPS。
- 建议定期轮换已暴露或长期使用的钉钉与 OneDev Token。
- 当前 MVP 没有事件去重、用户映射、通知聚合、管理后台或持久化。
