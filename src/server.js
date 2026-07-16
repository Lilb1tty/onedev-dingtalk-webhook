const http = require('node:http');
const crypto = require('node:crypto');
const { EVENT_TYPES, buildDeployNotification, buildIssueNotification, buildNotification, classifyBuildWebhook, classifyIssueWebhook } = require('./onedev');
const { createOneDevClient } = require('./onedev-client');
const { createDingTalkClient } = require('./dingtalk');

const DEFAULT_PORT = 8099;
const MAX_BODY_SIZE = 1024 * 1024;
const ROBOT_ROUTES = new Set(['build', 'issue', 'pullRequest', 'default']);

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

function parseProjectRobots(value) {
  if (!value) return {};
  let robots;
  try {
    robots = JSON.parse(value);
  } catch {
    throw new Error('DINGTALK_PROJECT_ROBOTS must be valid JSON');
  }
  if (!robots || typeof robots !== 'object' || Array.isArray(robots)) {
    throw new Error('DINGTALK_PROJECT_ROBOTS must be a JSON object');
  }
  for (const [project, routes] of Object.entries(robots)) {
    if (!project || !routes || typeof routes !== 'object' || Array.isArray(routes)) {
      throw new Error('DINGTALK_PROJECT_ROBOTS contains an invalid robot route');
    }
    for (const [route, routeRobots] of Object.entries(routes)) {
      if (!ROBOT_ROUTES.has(route) || !Array.isArray(routeRobots)) {
        throw new Error('DINGTALK_PROJECT_ROBOTS contains an invalid robot route');
      }
      for (const robot of routeRobots) {
        if (!robot || typeof robot !== 'object' || Array.isArray(robot) || typeof robot.accessToken !== 'string' || !robot.accessToken || (robot.secret !== undefined && typeof robot.secret !== 'string')) {
          throw new Error('DINGTALK_PROJECT_ROBOTS contains an invalid robot');
        }
      }
    }
  }
  return robots;
}

function projectKeys(project) {
  if (typeof project === 'string' && project) return [project];
  if (!project || typeof project !== 'object') return [];
  return [project.path, project.name].filter(value => typeof value === 'string' && value);
}

function createApp({ env = process.env, fetchImpl = globalThis.fetch, logger = console } = {}) {
  const webhookSecret = env.ONEDEV_WEBHOOK_SECRET || '';
  const notifyJobs = (env.ONEDEV_NOTIFY_JOBS || env.ONEDEV_NOTIFY_JOB || 'deploy').split(',').map(job => job.trim()).filter(Boolean);
  const projectDingTalk = new Map(Object.entries(parseProjectRobots(env.DINGTALK_PROJECT_ROBOTS)).map(([project, routes]) => [
    project,
    Object.fromEntries(Object.entries(routes).map(([route, robots]) => [
      route,
      robots.map(robot => createDingTalkClient({ accessToken: robot.accessToken, secret: robot.secret || '', fetchImpl }))
    ]))
  ]));
  const dingTalkFor = (route, ...projects) => {
    for (const project of projects) {
      for (const key of projectKeys(project)) {
        const routes = projectDingTalk.get(key);
        if (routes) return routes[route] ?? routes.default ?? [];
      }
    }
    return [];
  };
  const routeFor = eventType => eventType.startsWith('BUILD_') ? 'build' : eventType === EVENT_TYPES.ISSUE ? 'issue' : eventType === EVENT_TYPES.PULL_REQUEST ? 'pullRequest' : 'default';
  const sendNotification = async (notification, ...projects) => {
    const clients = dingTalkFor(routeFor(notification.eventType), ...projects);
    if (clients.length === 0) return false;
    await Promise.all(clients.map(client => client.sendMarkdown(notification.title, notification.text)));
    return true;
  };
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
        if (!notifyJobs.includes(build.jobName)) {
          acknowledgeIgnoredBuild(res);
          return;
        }
        if (kind === 'finished' && !['SUCCESSFUL', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(build.status)) {
          throw new Error('Unexpected final build status');
        }
        const project = await oneDev.getProject(build.projectId);
        const notification = buildDeployNotification(payload, build, project, env.ONEDEV_PUBLIC_URL || env.ONEDEV_URL);
        const notificationSent = await sendNotification(notification, project);
        json(res, 200, { success: true, eventType: notification.eventType, notificationSent });
        return;
      }
      const issueId = classifyIssueWebhook(payload);
      if (issueId !== undefined) {
        const oneDev = createOneDevClient({
          baseUrl: env.ONEDEV_URL,
          accessToken: env.ONEDEV_ACCESS_TOKEN,
          fetchImpl
        });
        const issue = await oneDev.getIssue(issueId);
        const issueChanges = payload.type === 'IssueChanged' ? await oneDev.getIssueChanges(issueId) : undefined;
        const project = await oneDev.getProject(issue.projectId);
        const notification = buildIssueNotification(payload, issue, project, env.ONEDEV_PUBLIC_URL || env.ONEDEV_URL, issueChanges);
        const notificationSent = await sendNotification(notification, project);
        json(res, 200, { success: true, eventType: notification.eventType, notificationSent });
        return;
      }
      const notification = buildNotification(payload);
      const notificationSent = await sendNotification(notification, payload?.project, payload?.repository);
      json(res, 200, { success: true, eventType: notification.eventType, notificationSent });
    } catch (error) {
      logger.error?.('Webhook processing failed');
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
