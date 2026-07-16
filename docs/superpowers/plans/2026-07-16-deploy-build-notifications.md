# Deploy Build Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only send DingTalk notifications when the configured OneDev `deploy` Job starts or finishes, with the project name and true final status.

**Architecture:** Detect OneDev Build lifecycle events from the webhook's `type` and `buildId`. For `BuildRunning` and `BuildFinished`, query OneDev's REST API for Build and Project details, filter by configured Job name, and build an enriched Markdown message; acknowledge all other Build events without calling DingTalk.

**Tech Stack:** Node.js 20 CommonJS, built-in `http`, `fetch`, `node:test`, Docker.

## Global Constraints

- Keep port `8099` everywhere.
- Add no database, Redis, queue, cache, framework, or runtime dependency.
- Never log or return OneDev/DingTalk tokens or complete sensitive URLs.
- `ONEDEV_NOTIFY_JOB` defaults to `deploy`.
- `ONEDEV_PUBLIC_URL` is optional and defaults to `ONEDEV_URL`; API calls keep using `ONEDEV_URL` while DingTalk links use the public URL.
- Ignored Build events return HTTP `200` with `notificationSent: false`.

---

### Task 1: OneDev REST client and enriched notification

**Files:**
- Create: `src/onedev-client.js`
- Modify: `src/onedev.js`
- Test: `test/app.test.js`

**Interfaces:**
- Produces: `createOneDevClient({ baseUrl, accessToken, fetchImpl })` with `getBuild(buildId)` and `getProject(projectId)`.
- Produces: `classifyBuildWebhook(payload)` returning `{ kind, buildId }`.
- Produces: `buildDeployNotification(payload, build, project, publicUrl)` returning `{ eventType, title, text }`.

- [ ] **Step 1: Write failing tests for API lookup and event classification**

Add tests that assert Bearer authentication, `/api/builds/{id}` and `/api/projects/{id}` paths, exact classification of `BuildRunning`/`BuildFinished` with only positive integer or digit-string IDs, ignoring invalid IDs and `BuildPending`/`BuildUpdated`, final-status rejection, and credential/query/fragment-free public links.

```js
assert.deepEqual(classifyBuildWebhook({ type: 'BuildRunning', buildId: 42 }), {
  kind: 'running', buildId: '42'
});
assert.deepEqual(classifyBuildWebhook({ type: 'BuildPending', buildId: 42 }), {
  kind: 'ignored', buildId: '42'
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test`

Expected: FAIL because `onedev-client.js`, `classifyBuildWebhook`, and `buildDeployNotification` do not exist.

- [ ] **Step 3: Implement the minimal OneDev client and message builder**

Use `new URL('/~api/builds/' + encodeURIComponent(id), baseUrl)` and:

```js
const response = await fetchImpl(url, {
  headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` }
});
```

Reject non-2xx and non-JSON responses with sanitized errors. Add `BUILD_STARTED`; determine final result only from Build `status`: `SUCCESSFUL` maps to succeeded, while `FAILED`, `CANCELLED`, and `TIMED_OUT` map to failed. Include `project.name` in both title and Markdown, and include `build.jobName`, `number`, `refName`, `commitHash`, `status`, and a constructed Build link when present.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test`

Expected: all OneDev client and message tests pass.

### Task 2: Webhook filtering and error handling

**Files:**
- Modify: `src/server.js`
- Test: `test/app.test.js`

**Interfaces:**
- Consumes: `createOneDevClient`, `classifyBuildWebhook`, `buildDeployNotification` from Task 1.
- Produces: HTTP `200` ignored responses and DingTalk sends only for matching start/final events.

- [ ] **Step 1: Write failing end-to-end handler tests**

Cover these observable cases:

```js
// BuildPending: no OneDev API call, no DingTalk call, HTTP 200.
assert.deepEqual(await response.json(), {
  success: true, eventType: 'BUILD_IGNORED', notificationSent: false
});

// BuildRunning for jobName=test: API lookup occurs, DingTalk is not called.
// BuildRunning for jobName=deploy: title contains project name and one DingTalk call occurs.
// BuildFinished SUCCESSFUL/FAILED: the matching result notification is sent.
// OneDev API failure: HTTP 502 without token or complete API URL in the body.
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test`

Expected: FAIL because the server still sends every payload directly to DingTalk.

- [ ] **Step 3: Implement minimal server orchestration**

Create the OneDev client from internal `ONEDEV_URL` and `ONEDEV_ACCESS_TOKEN`; pass `ONEDEV_PUBLIC_URL || ONEDEV_URL` only to the notification link builder. For Build events:

1. Immediately acknowledge ignored lifecycle events.
2. Fetch Build for running/finished events.
3. Compare `build.jobName` with `ONEDEV_NOTIFY_JOB || 'deploy'`.
4. Immediately acknowledge non-matching Jobs.
5. Reject a matching `BuildFinished` whose fetched status is not `SUCCESSFUL`, `FAILED`, `CANCELLED`, or `TIMED_OUT` with the existing generic `502` body and no DingTalk call.
6. Fetch Project and send the enriched message for matching Jobs.
7. Return `502` on lookup or DingTalk failure using the existing generic error body.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test`

Expected: all handler and existing tests pass with zero failures.

### Task 3: Deployment configuration and documentation

**Files:**
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `.onedev-buildspec.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: `ONEDEV_URL`, `ONEDEV_ACCESS_TOKEN`, and `ONEDEV_NOTIFY_JOB` from Task 2.
- Produces: deployable local, Compose, and OneDev CI configuration.

- [ ] **Step 1: Add environment examples and deployment wiring**

Add:

```properties
ONEDEV_URL=http://172.17.0.1:6610
ONEDEV_PUBLIC_URL=http://175.178.115.41:6610
ONEDEV_ACCESS_TOKEN=replace-with-read-only-access-token
ONEDEV_NOTIFY_JOB=deploy
```

Pass the same values through Compose. In `.onedev-buildspec.yml`, set `ONEDEV_URL=http://172.17.0.1:6610`, `ONEDEV_PUBLIC_URL=http://175.178.115.41:6610`, `ONEDEV_NOTIFY_JOB=deploy`, and source `ONEDEV_ACCESS_TOKEN` from `@secret:onedev-access-token@`.

- [ ] **Step 2: Update Chinese README**

Document both internal API and public link origins, the required read-only OneDev Access Token, project-name lookup, valid Build ID requirement, ignored intermediate events, unrecognized-final-status `502`, the live top-level `type`/`buildId`/`date` curl payload, and duplicate-delivery limitation. Keep all shell commands single-line.

- [ ] **Step 3: Validate files and run the full local suite**

Run: `npm test`

Run: `tod build check-spec`

Run: `git grep -n "[8]080"`

Run: `git diff --check`

Expected: tests and buildspec validation pass; no forbidden-port matches; no whitespace errors.

- [ ] **Step 4: Request code review and resolve findings**

Review the complete diff against the design, with special attention to secret leakage, exact Build status handling, ignored-event responses, and project/Job filtering.

- [ ] **Step 5: Commit, push, and deploy**

Generate a OneDev-compliant commit message, commit after confirmation, push `master`, and verify OneDev's `test` and `deploy` Builds. Confirm `http://175.178.115.41:8099/health` returns `{"status":"UP"}`. Run one controlled target-project deploy only after explicit consent, then verify exactly two DingTalk notifications.
