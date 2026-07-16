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
- `ONEDEV_PUBLIC_URL`：钉钉 Build 链接使用的用户可访问地址；未设置时使用 `ONEDEV_URL`。OneDev API 始终使用内部 `ONEDEV_URL`。
- `ONEDEV_ACCESS_TOKEN`：具有目标项目 Build 读取权限的 Access Token。
- `ONEDEV_NOTIFY_JOB`：需要通知的 Job 名称，当前部署配置为 `deploy`。

已有的 `ONEDEV_WEBHOOK_SECRET` 继续只用于验证 Webhook 请求。

## 事件处理

1. 校验 `X-OneDev-Webhook-Secret`。
2. 非 Build 生命周期事件继续按现有 Push、Pull Request、Issue、Unknown 规则处理。
3. `buildId` 仅接受正整数或正数字字符串；缺失、空白、布尔值、对象、数组、零、负数、小数和非数字字符串均返回成功但不发送通知，且不调用 OneDev 或钉钉。
4. 使用 `buildId` 查询 OneDev Build；查询失败时返回 `502`，不发送钉钉消息。
5. Build 的 `jobName` 不等于 `ONEDEV_NOTIFY_JOB` 时返回 `200`，并标记
   `notificationSent: false`。
6. `BuildFinished` 的真实 `status` 仅允许 `SUCCESSFUL`、`FAILED`、`CANCELLED`、`TIMED_OUT`；缺失或其他值返回通用 `502`，不查询 Project，也不发送钉钉。
7. 使用 Build 的 `projectId` 查询 OneDev Project；查询失败时返回 `502`。
8. `BuildRunning` 且 Job 匹配时发送“Deploy Started”。
9. `BuildFinished` 且 Job 匹配时根据真实 `status` 发送成功或失败通知。
10. 其他 Build 事件返回 `200`，不调用钉钉。

## 消息内容

通知标题直接包含项目名称，例如 `CHI Deploy Started`、
`CHI Deploy Succeeded`、`CHI Deploy Failed`。正文尽量包含项目、Job、Build 编号、
分支、提交、状态、操作者、链接和时间；Build 链接使用 `ONEDEV_PUBLIC_URL`（或回退后的 `ONEDEV_URL`），并移除用户名、密码、查询参数和片段。缺失字段直接忽略。字段和整条 Markdown
继续沿用现有长度限制。

## 重复投递限制

MVP 不使用事件去重缓存：每次收到 Webhook 都独立发送一次通知，重复投递可能产生重复消息。

## 测试与验证

- `deploy` 的 `BuildRunning` 发送一次开始通知。
- `deploy` 的成功/失败 `BuildFinished` 分别生成正确通知。
- 标题和正文包含 OneDev API 返回的项目名称。
- 非 `deploy` Job 不发送通知。
- Pending、Updated 等中间事件不发送通知。
- 缺失或未知最终状态返回通用 `502`，不发送 `UNKNOWN` 通知。
- 无效 `buildId` 不调用 OneDev 或钉钉。
- API 查询保持使用内部 `ONEDEV_URL`，钉钉链接使用可访问的 `ONEDEV_PUBLIC_URL`。
- OneDev API HTTP/业务响应失败返回 `502`，且不泄露 Token。
- 现有 Webhook 密钥、钉钉响应和签名测试继续通过。
- Docker 部署后验证 `/health`，再运行一次受控 `deploy` Build，确认钉钉只收到
  “开始”和“结果”两条消息。
