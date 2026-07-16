const http = require('node:http');
const crypto = require('node:crypto');
const { buildDeployNotification, buildNotification, classifyBuildWebhook } = require('./onedev');
const { createOneDevClient } = require('./onedev-client');
const { createDingTalkClient } = require('./dingtalk');

const DEFAULT_PORT = 8099;
const MAX_BODY_SIZE = 1024 * 1024;

function json(res, statusCode, body) {
  const data = JSON.stringify(body);
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function secretsMatch(actual, expected) {
  const actualBuffer = Buffer.from(actual || '', 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function isBuildLifecycleWebhook(payload) {
  return typeof payload?.type === 'string' && payload.type.startsWith('Build');
}

function acknowledgeIgnoredBuild(res) {
  json(res, 200, { success: true, eventType: 'BUILD_IGNORED', notificationSent: false });
}

function createApp({ env = process.env, fetchImpl = globalThis.fetch, logger = console } = {}) {
  const webhookSecret = env.ONEDEV_WEBHOOK_SECRET || '';
  const dingTalk = createDingTalkClient({ accessToken: env.DINGTALK_ACCESS_TOKEN, secret: env.DINGTALK_SECRET || '', fetchImpl });
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      json(res, 200, { status: 'UP' });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/webhook/onedev') {
      json(res, 404, { message: 'Not found' });
      return;
    }
    if (webhookSecret && !secretsMatch(req.headers['x-onedev-webhook-secret'], webhookSecret)) {
      logger.warn?.('Rejected OneDev webhook: invalid secret');
      json(res, 401, { success: false, message: 'Unauthorized' });
      return;
    }
    try {
      const payload = await readBody(req);
      if (isBuildLifecycleWebhook(payload)) {
        const { kind, buildId } = classifyBuildWebhook(payload);
        if (kind === 'ignored' || buildId === undefined) {
          acknowledgeIgnoredBuild(res);
          return;
        }
        const oneDev = createOneDevClient({
          baseUrl: env.ONEDEV_URL,
          accessToken: env.ONEDEV_ACCESS_TOKEN,
          fetchImpl
        });
        const build = await oneDev.getBuild(buildId);
        if (build.jobName !== (env.ONEDEV_NOTIFY_JOB || 'deploy')) {
          acknowledgeIgnoredBuild(res);
          return;
        }
        const project = await oneDev.getProject(build.projectId);
        const notification = buildDeployNotification(payload, build, project, env.ONEDEV_URL);
        await dingTalk.sendMarkdown(notification.title, notification.text);
        json(res, 200, { success: true, eventType: notification.eventType, notificationSent: true });
        return;
      }
      const notification = buildNotification(payload);
      await dingTalk.sendMarkdown(notification.title, notification.text);
      json(res, 200, { success: true, eventType: notification.eventType, notificationSent: true });
    } catch (error) {
      logger.error?.(`Webhook processing failed: ${error.message}`);
      if (!res.headersSent) json(res, 502, { success: false, message: 'Failed to send DingTalk notification' });
    }
  });
}

function start() {
  const port = Number.parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port');
  const app = createApp();
  app.listen(port, () => console.log(`OneDev DingTalk webhook listening on ${port}`));
  return app;
}

if (require.main === module) {
  try {
    start();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { DEFAULT_PORT, createApp, secretsMatch, start };
