# Deploy Build 通知设计

## 目标

只为 OneDev 的 `deploy` Job 发送两类钉钉通知：

- `BuildRunning`：部署开始。
- `BuildFinished`：部署成功或失败。

忽略 `test` 等其他 Job，以及 `BuildSubmitted`、`BuildPending`、
`BuildUpdated`、`BuildResumed` 等中间事件。

## 约束与依据

当前 OneDev Webhook Payload 只直接提供 `buildId`、`type`、`date` 等字段，
没有展开 Job 名称和最终状态。因此服务不能只依赖 Payload 判断是否为
`deploy`，也不能把 `BuildFinished` 直接视为成功。

服务使用 `buildId` 调用 OneDev REST API 获取 Build 详情，再读取 `jobName`、
`status`、`projectId`、分支、提交和链接等字段。随后使用 `projectId` 查询项目，
取得项目名称和路径。API 使用 Bearer Access Token，Token 不得写入日志、响应或
仓库。

## 配置

新增环境变量：

- `ONEDEV_URL`：OneDev 服务地址。
- `ONEDEV_ACCESS_TOKEN`：具有目标项目 Build 读取权限的 Access Token。
- `ONEDEV_NOTIFY_JOB`：需要通知的 Job 名称，当前部署配置为 `deploy`。

已有的 `ONEDEV_WEBHOOK_SECRET` 继续只用于验证 Webhook 请求。

## 事件处理

1. 校验 `X-OneDev-Webhook-Secret`。
2. 非 Build 生命周期事件继续按现有 Push、Pull Request、Issue、Unknown 规则处理。
3. Build Payload 缺少有效 `buildId` 时返回成功但不发送通知，避免无意义消息。
4. 使用 `buildId` 查询 OneDev Build；查询失败时返回 `502`，不发送钉钉消息。
5. Build 的 `jobName` 不等于 `ONEDEV_NOTIFY_JOB` 时返回 `200`，并标记
   `notificationSent: false`。
6. 使用 Build 的 `projectId` 查询 OneDev Project；查询失败时返回 `502`。
7. `BuildRunning` 且 Job 匹配时发送“Deploy Started”。
8. `BuildFinished` 且 Job 匹配时根据真实 `status` 发送成功或失败通知。
9. 其他 Build 事件返回 `200`，不调用钉钉。

## 消息内容

通知标题直接包含项目名称，例如 `CHI Deploy Started`、
`CHI Deploy Succeeded`、`CHI Deploy Failed`。正文尽量包含项目、Job、Build 编号、
分支、提交、状态、操作者、链接和时间；缺失字段直接忽略。字段和整条 Markdown
继续沿用现有长度限制。

## 测试与验证

- `deploy` 的 `BuildRunning` 发送一次开始通知。
- `deploy` 的成功/失败 `BuildFinished` 分别生成正确通知。
- 标题和正文包含 OneDev API 返回的项目名称。
- 非 `deploy` Job 不发送通知。
- Pending、Updated 等中间事件不发送通知。
- OneDev API HTTP/业务响应失败返回 `502`，且不泄露 Token。
- 现有 Webhook 密钥、钉钉响应和签名测试继续通过。
- Docker 部署后验证 `/health`，再运行一次受控 `deploy` Build，确认钉钉只收到
  “开始”和“结果”两条消息。
