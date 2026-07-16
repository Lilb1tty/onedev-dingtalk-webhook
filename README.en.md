# OneDev Webhook → DingTalk Group Robot

English | [中文](README.md)

Receives OneDev webhooks and converts Push, Build, Pull Request, Issue, and other events into DingTalk Markdown notifications. Each OneDev project can route notifications to its own DingTalk group.

## How it works

```text
OneDev project event
→ POST /webhook/onedev
→ Validate X-OneDev-Webhook-Secret
→ Select a DingTalk robot by project path
→ Send a DingTalk Markdown message
```

- The default and repository deployment port is `8099`.
- Build notifications process only `BuildRunning` and `BuildFinished`, and only for configured jobs.
- An unmapped project returns `200` with `notificationSent: false`; it is never sent to another project's group.
- No database, Redis, message queue, or event deduplication cache is used.

## Fastest setup: deploy with OneDev

The repository's [.onedev-buildspec.yml](.onedev-buildspec.yml) already contains test and Docker deployment jobs. Complete the following setup, then push `master` to deploy automatically.

Before deploying, confirm that:

- OneDev has a Job Executor named `builder`, matching `jobExecutor: builder` in the buildspec.
- The executor can build Docker images and run containers on the target server.
- TCP port `8099` is not used by another service.
- The deployed container can reach both the OneDev API and the public DingTalk API.

### 1. Create a robot for each DingTalk group

1. Open the DingTalk group settings and add a custom robot.
2. Copy only the value after `access_token=` from the robot URL, not the complete URL.
3. Enabling signature verification is recommended. Copy the secret that starts with `SEC`.
4. Use a separate group robot for each OneDev project that needs independent notifications.

The project-to-robot configuration must be valid single-line JSON:

```json
{"demo-project":{"accessToken":"replace-with-access-token","secret":"replace-with-signing-secret"},"sample-project":{"accessToken":"replace-with-access-token","secret":""}}
```

If signature verification is disabled for a robot, use an empty secret:

```json
{"demo-project":{"accessToken":"replace-with-access-token","secret":""}}
```

Prefer the full OneDev project path as the JSON key. For a project at `products/demo-project`, configure:

```json
{"products/demo-project":{"accessToken":"replace-with-access-token","secret":"replace-with-signing-secret"}}
```

### 2. Create a read-only OneDev access token

Build and Issue webhooks require the service to query `/~api/builds/{id}`, `/~api/issues/{id}`, `/~api/issues/{id}/changes`, and `/~api/projects/{id}`.

1. Use a dedicated OneDev user, or create a token from your personal Access Tokens page.
2. Ensure that user can read Builds and Projects for every project that sends notifications.
3. Do not use an administrator token or commit the token to the repository.

### 3. Create three Job Secrets in the notification service project

Open `Settings → Build Settings → Job Secrets` in this notification service project. Create these exact names:

| Job Secret name | Value | Purpose |
| --- | --- | --- |
| `onedev-webhook-secret` | A random string you generate | Validates incoming OneDev webhooks |
| `onedev-access-token` | The OneDev access token from the previous step | Reads Builds, Issue Changes, and Projects |
| `dingtalk-project-robots` | The single-line project robot JSON | Routes each project to its group |

Generate a Webhook Secret with the following command, then use the output for both `onedev-webhook-secret` and the request header in every target project:

```bash
openssl rand -hex 32
```

Enter only the raw value in a Job Secret. For example, the value of `dingtalk-project-robots` is:

```json
{"demo-project":{"accessToken":"replace-with-access-token","secret":"replace-with-signing-secret"}}
```

Do not enter an environment-variable assignment:

```properties
DINGTALK_PROJECT_ROBOTS={"demo-project":{"accessToken":"replace-with-access-token","secret":"replace-with-signing-secret"}}
```

The legacy `dingtalk-access-token` and `dingtalk-secret` Job Secrets are no longer used and may be deleted.

### 4. Review the OneDev deployment values

The current buildspec uses:

```text
PORT=8099
ONEDEV_URL=http://onedev.example.internal:6610
ONEDEV_PUBLIC_URL=https://onedev.example.com
ONEDEV_NOTIFY_JOBS=deploy
```

- `ONEDEV_URL`: internal URL used by the container to call the OneDev API.
- `ONEDEV_PUBLIC_URL`: user-accessible OneDev URL included in DingTalk Build links.
- `ONEDEV_NOTIFY_JOBS`: exact job names that may send notifications, separated by commas.

The public example uses fictional hostnames. Before deploying, update these values in [.onedev-buildspec.yml](.onedev-buildspec.yml) and configure the container's OneDev address for your Docker network.

Validate the buildspec with:

```bash
tod build check-spec
```

### 5. Push and deploy

Pushing `master` automatically runs:

1. `test`: runs the test suite in a Node.js 20 container.
2. `deploy`: builds the image, replaces the `onedev-dingtalk` container, and waits for its health check.

Verify the deployment:

```bash
curl http://SERVER_IP:8099/health
```

Expected response:

```json
{"status":"UP"}
```

### 6. Configure a webhook in each target OneDev project

Each project that needs notifications must have its own webhook. Open `Settings → Web Hooks` in the target project and configure:

- Method: `POST`
- Event: select at least `BUILD`; add Push, Pull Request, or Issue if needed
- URL: choose one of the examples below for your network
- Header: `X-OneDev-Webhook-Secret`
- Header value: exactly the same value as `onedev-webhook-secret`

OneDev and this service on the same Docker network:

```text
http://onedev-dingtalk:8099/webhook/onedev
```

OneDev connecting through the server IP:

```text
http://SERVER_IP:8099/webhook/onedev
```

Public HTTPS endpoint:

```text
https://notify.example.com/webhook/onedev
```

Notes:

- Do not use `localhost` from one container to reach another container.
- Allow inbound TCP `8099` in the firewall when using the server IP.
- Use Caddy or Nginx with HTTPS when exposing the webhook publicly.
- Do not enter the DingTalk robot URL directly in OneDev; their JSON formats are different.

### 7. Send a test notification

This request does not query the OneDev Build API, so it is useful for quickly testing project routing. Replace `demo-project` with an actual key from `dingtalk-project-robots`:

```bash
curl -X POST http://localhost:8099/webhook/onedev -H "Content-Type: application/json" -H "X-OneDev-Webhook-Secret: change-me" -d '{"type":"Push","project":{"name":"demo-project"},"actor":{"name":"Tester"},"url":"https://onedev.example.com/demo-project"}'
```

Successful delivery:

```json
{"success":true,"eventType":"PUSH","notificationSent":true}
```

Unmapped project:

```json
{"success":true,"eventType":"PUSH","notificationSent":false}
```

## Deploy with Docker Compose

Docker Compose reads `.env`; it does not read OneDev Job Secrets.

```bash
cp .env.example .env
```

Edit `.env`:

```properties
PORT=8099
ONEDEV_WEBHOOK_SECRET=replace-with-random-secret
ONEDEV_URL=http://onedev.example.internal:6610
ONEDEV_PUBLIC_URL=https://onedev.example.com
ONEDEV_ACCESS_TOKEN=replace-with-read-only-token
ONEDEV_NOTIFY_JOBS=deploy
DINGTALK_PROJECT_ROBOTS={"demo-project":{"accessToken":"replace-with-access-token","secret":"replace-with-signing-secret"}}
```

Start and verify:

```bash
docker compose up -d --build
```

```bash
curl http://localhost:8099/health
```

If OneDev also runs in Docker, attach this service to OneDev's Docker network and use `onedev-dingtalk:8099`. Do not assume an existing network name; configure the actual external network used by your deployment.

## Run locally

Node.js 20.6.0 or later is required.

```bash
cp .env.example .env
```

```bash
npm install
```

```bash
node --env-file=.env src/server.js
```

The service listens at `http://localhost:8099`.

## Configuration mapping

OneDev deployment and local Docker Compose use different configuration sources:

| Application environment variable | Docker Compose `.env` | OneDev deployment |
| --- | --- | --- |
| `PORT` | `PORT` | Fixed to `8099` in the buildspec |
| `ONEDEV_WEBHOOK_SECRET` | `ONEDEV_WEBHOOK_SECRET` | Job Secret `onedev-webhook-secret` |
| `ONEDEV_URL` | `ONEDEV_URL` | Configured in the buildspec |
| `ONEDEV_PUBLIC_URL` | `ONEDEV_PUBLIC_URL` | Configured in the buildspec |
| `ONEDEV_ACCESS_TOKEN` | `ONEDEV_ACCESS_TOKEN` | Job Secret `onedev-access-token` |
| `ONEDEV_NOTIFY_JOBS` | `ONEDEV_NOTIFY_JOBS` | Configured in the buildspec |
| `DINGTALK_PROJECT_ROBOTS` | `DINGTALK_PROJECT_ROBOTS` | Job Secret `dingtalk-project-robots` |

## Notification rules

- `BuildRunning`: sends Build Started.
- `BuildFinished`: `SUCCESSFUL` sends success; `FAILED`, `CANCELLED`, and `TIMED_OUT` send failure.
- `BuildPending`, `BuildUpdated`, missing or invalid `buildId`, and non-target jobs: return `200` without sending.
- A matched job with an unknown final status: returns `502` without sending a misleading result.
- `Issue*` webhooks with a valid `issueId`: fetch the Issue and Project, then label actions as follows: `IssueOpened` is New issue created, `IssueCommentCreated` is New comment, `IssueChanged` with old and new states is Issue status changed, and other `IssueChanged` events are Issue content modified.
- Push, Pull Request, Issue payloads without an `issueId`, and unknown payloads: extract common fields when available and generate a generic notification.
- Build events select a robot by `project.path`, then `project.name`; generic events also support `repository.path` and `repository.name`.
- Every webhook is processed independently; repeated OneDev deliveries can produce duplicate notifications.

## Endpoints

### `GET /health`

```json
{"status":"UP"}
```

### `POST /webhook/onedev`

- Content-Type: `application/json`
- Optional header: `X-OneDev-Webhook-Secret`
- Successful DingTalk delivery returns `200`
- DingTalk HTTP or business errors return `502`
- A webhook secret mismatch returns `401`

## Troubleshooting

### The response contains `notificationSent: false`

The project path from the payload or OneDev API did not match `DINGTALK_PROJECT_ROBOTS`. Check the full `project.path` first and ensure the case matches exactly.

### A Build does not send a notification

Check:

1. The target project's webhook subscribes to `BUILD`.
2. OneDev emitted `BuildRunning` or `BuildFinished`.
3. The Build's `jobName` appears in `ONEDEV_NOTIFY_JOBS`.
4. `onedev-access-token` can read the target project's Builds and Project.

### An Issue operation does not send a notification

Confirm that the target project webhook subscribes to `ISSUE` and that `onedev-access-token` can read the target project's Issues and Project. `Issue*` events with an `issueId` are fetched and routed automatically.

### The service returns `401`

The target project's `X-OneDev-Webhook-Secret` header does not match the service configuration.

### The service returns `502`

Common causes include an unreachable OneDev API, insufficient OneDev token permissions, incorrect DingTalk token or signature secret, unmet DingTalk robot security settings, or a non-zero DingTalk `errcode`.

### Build links in DingTalk cannot be opened

Set `ONEDEV_PUBLIC_URL` to an address accessible to testers, not an internal container-only hostname.

## Security and current limitations

- Keep all tokens and secrets only in `.env` or OneDev Job Secrets.
- `.env` is ignored by Git. Never put real credentials in a README, buildspec, or commit.
- Use `ONEDEV_WEBHOOK_SECRET` and HTTPS for publicly accessible webhooks.
- Rotate any exposed or long-lived DingTalk and OneDev tokens.
- This MVP does not implement event deduplication, user mapping, notification aggregation, an admin UI, or persistence.
