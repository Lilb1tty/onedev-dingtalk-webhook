const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { buildNotification, buildDeployNotification, classifyBuildWebhook, EVENT_TYPES } = require('../src/onedev');
const { createOneDevClient } = require('../src/onedev-client');
const { createDingTalkClient, createSignature } = require('../src/dingtalk');
const { createApp } = require('../src/server');

function invoke(app, { method = 'GET', url = '/', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = headers;
    const res = {
      headersSent: false,
      writeHead(statusCode, responseHeaders) {
        this.statusCode = statusCode;
        this.headers = responseHeaders;
        this.headersSent = true;
      },
      end(data) {
        this.body = data;
        resolve({ status: this.statusCode, json: async () => JSON.parse(data), body: data });
      }
    };
    req.on('error', reject);
    app.emit('request', req, res);
    process.nextTick(() => {
      if (body) req.emit('data', Buffer.from(body));
      req.emit('end');
    });
  });
}

async function withServer(fetchImpl, callback, secret = 'change-me') {
  const app = createApp({
    env: { ONEDEV_WEBHOOK_SECRET: secret, DINGTALK_ACCESS_TOKEN: 'test-token' },
    fetchImpl,
    logger: { warn() {}, error() {} }
  });
  return callback(options => invoke(app, { url: '/webhook/onedev', ...options }));
}

function okDingTalk() {
  return async () => ({ ok: true, status: 200, json: async () => ({ errcode: 0, errmsg: 'ok' }) });
}

function jsonResponse(body, { ok = true, status = 200, contentType = 'application/json' } = {}) {
  return {
    ok,
    status,
    headers: { get: name => name.toLowerCase() === 'content-type' ? contentType : null },
    json: async () => body
  };
}

test('OneDev client fetches builds and projects with Bearer authentication', async () => {
  const requests = [];
  const client = createOneDevClient({
    baseUrl: 'https://onedev.example.test/root/',
    accessToken: 'read-only-token',
    fetchImpl: async (url, options) => {
      requests.push({ url: url.toString(), options });
      return jsonResponse({ id: 42 });
    }
  });

  assert.deepEqual(await client.getBuild('release/42'), { id: 42 });
  assert.deepEqual(await client.getProject(9), { id: 42 });
  assert.deepEqual(requests, [
    {
      url: 'https://onedev.example.test/api/builds/release%2F42',
      options: { headers: { accept: 'application/json', authorization: 'Bearer read-only-token' } }
    },
    {
      url: 'https://onedev.example.test/api/projects/9',
      options: { headers: { accept: 'application/json', authorization: 'Bearer read-only-token' } }
    }
  ]);
});

test('OneDev client rejects failed and non-JSON responses without exposing response details', async () => {
  const client = createOneDevClient({
    baseUrl: 'https://onedev.example.test/',
    accessToken: 'read-only-token',
    fetchImpl: async id => id.toString().endsWith('/401')
      ? jsonResponse({ message: 'Bearer read-only-token' }, { ok: false, status: 401 })
      : jsonResponse('<html>Unexpected response</html>', { contentType: 'text/html' })
  });

  await assert.rejects(client.getBuild(401), error => error.message === 'OneDev API request failed with status 401');
  await assert.rejects(client.getBuild(200), error => error.message === 'OneDev API response was not JSON');
});

test('classifyBuildWebhook identifies only running and finished build lifecycle events', () => {
  assert.deepEqual(classifyBuildWebhook({ type: 'BuildRunning', buildId: 42 }), {
    kind: 'running', buildId: '42'
  });
  assert.deepEqual(classifyBuildWebhook({ type: 'BuildFinished', buildId: 42 }), {
    kind: 'finished', buildId: '42'
  });
  assert.deepEqual(classifyBuildWebhook({ type: 'BuildPending', buildId: 42 }), {
    kind: 'ignored', buildId: '42'
  });
  assert.deepEqual(classifyBuildWebhook({ type: 'BuildUpdated', buildId: 42 }), {
    kind: 'ignored', buildId: '42'
  });
});

test('buildDeployNotification formats a running deploy build with its project details', () => {
  const notification = buildDeployNotification(
    { type: 'BuildRunning', buildId: 42, date: '2026-07-16T10:00:00Z' },
    {
      id: 42,
      jobName: 'deploy',
      number: 128,
      refName: 'main',
      commitHash: 'abc123',
      status: 'RUNNING'
    },
    { name: 'demo-project' }
  );

  assert.equal(notification.eventType, EVENT_TYPES.BUILD_STARTED);
  assert.equal(notification.title, 'OneDev Build Started: demo-project');
  assert.match(notification.text, /OneDev Build Started: demo-project/);
  assert.match(notification.text, /Project: demo-project/);
  assert.match(notification.text, /Job: deploy/);
  assert.match(notification.text, /Build: \[#128\]\(\/~builds\/42\)/);
  assert.match(notification.text, /Ref: main/);
  assert.match(notification.text, /Commit: abc123/);
  assert.match(notification.text, /Status: RUNNING/);
});

test('buildDeployNotification derives final status only from the fetched build', () => {
  const project = { name: 'demo-project' };

  assert.equal(
    buildDeployNotification({ type: 'BuildFinished' }, { id: 1, status: 'SUCCESSFUL' }, project).eventType,
    EVENT_TYPES.BUILD_SUCCEEDED
  );
  for (const status of ['FAILED', 'CANCELLED', 'TIMED_OUT']) {
    assert.equal(
      buildDeployNotification({ type: 'BuildFinished', status: 'SUCCESSFUL' }, { id: 1, status }, project).eventType,
      EVENT_TYPES.BUILD_FAILED
    );
  }
});

test('correct webhook secret allows a notification', async () => {
  await withServer(okDingTalk(), async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'Push', project: { name: 'demo' } })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).notificationSent, true);
  });
});

test('wrong webhook secret returns 401', async () => {
  let called = false;
  await withServer(async () => { called = true; return { ok: true, status: 200, json: async () => ({ errcode: 0 }) }; }, async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'wrong' },
      body: '{}'
    });
    assert.equal(response.status, 401);
    assert.equal(called, false);
  });
});

test('build failed payload generates a readable notification', () => {
  const notification = buildNotification({
    '@class': 'io.onedev.server.event.build.BuildFinished',
    project: { name: 'demo-project' },
    build: { number: 128, status: 'FAILED' },
    branch: 'main',
    user: { name: 'Owen' },
    url: 'https://example.com/build/128'
  });
  assert.equal(notification.eventType, EVENT_TYPES.BUILD_FAILED);
  assert.match(notification.text, /OneDev Build Failed/);
  assert.match(notification.text, /Build: #128/);
  assert.match(notification.text, /Status: FAILED/);
});

test('unknown payload generates a generic notification', () => {
  const notification = buildNotification({ arbitrary: { value: true } });
  assert.equal(notification.eventType, EVENT_TYPES.UNKNOWN);
  assert.match(notification.text, /OneDev Notification/);
});

test('DingTalk errcode 0 is success', async () => {
  const client = createDingTalkClient({ accessToken: 'token', fetchImpl: okDingTalk() });
  await assert.doesNotReject(() => client.sendMarkdown('title', 'text'));
});

test('DingTalk business error is returned as a failed webhook', async () => {
  await withServer(async () => ({ ok: true, status: 200, json: async () => ({ errcode: 310000, errmsg: 'invalid token' }) }), async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'Push' })
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { success: false, message: 'Failed to send DingTalk notification' });
  });
});

test('DingTalk signature follows the UTF-8 HMAC rule', () => {
  const timestamp = '1700000000000';
  const secret = '测试 secret';
  const expected = encodeURIComponent(crypto.createHmac('sha256', secret).update(`${timestamp}\n${secret}`, 'utf8').digest('base64'));
  assert.equal(createSignature(timestamp, secret), expected);
});

test('signed DingTalk request encodes sign exactly once', async () => {
  const timestamp = 1700000000000;
  const secret = '测试 secret';
  let requestedUrl;
  const client = createDingTalkClient({
    accessToken: 'token',
    secret,
    now: () => timestamp,
    fetchImpl: async url => {
      requestedUrl = url;
      return { ok: true, status: 200, json: async () => ({ errcode: 0, errmsg: 'ok' }) };
    }
  });
  await client.sendMarkdown('title', 'text');
  assert.equal(
    requestedUrl,
    `${require('../src/dingtalk').DINGTALK_ENDPOINT}?access_token=token&timestamp=${timestamp}&sign=${createSignature(String(timestamp), secret)}`
  );
});
