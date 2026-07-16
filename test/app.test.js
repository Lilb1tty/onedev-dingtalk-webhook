const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { buildNotification, EVENT_TYPES } = require('../src/onedev');
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
