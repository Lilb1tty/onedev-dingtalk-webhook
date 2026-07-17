const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { buildNotification, buildDeployNotification, buildIssueNotification, classifyBuildWebhook, EVENT_TYPES } = require('../src/onedev');
const { createOneDevClient } = require('../src/onedev-client');
const { DINGTALK_ENDPOINT, createDingTalkClient, createSignature } = require('../src/dingtalk');
const { createApp } = require('../src/server');

const ONEDEV_URL = 'https://onedev.example.test/';
const ONEDEV_ACCESS_TOKEN = 'read-only-token';

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

async function withServer(fetchImpl, callback, { logger = { warn() {}, error() {} }, ...env } = {}) {
  const app = createApp({
    env: {
      ONEDEV_WEBHOOK_SECRET: 'change-me',
      DINGTALK_PROJECT_ROBOTS: JSON.stringify({
        DingTalkWebHook: { build: [{ accessToken: 'test-token' }], issue: [] },
        demo: { default: [{ accessToken: 'test-token' }] }
      }),
      ONEDEV_URL,
      ONEDEV_ACCESS_TOKEN,
      ...env
    },
    fetchImpl,
    logger
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

function createUrlRoutedFetchMock({
  build = { id: 856, number: 7, jobName: 'deploy', status: 'RUNNING', projectId: 35, refName: 'refs/heads/master', commitHash: 'abc123' },
  project = { id: 35, name: 'DingTalkWebHook', path: 'DingTalkWebHook' },
  issue = { id: 28, number: 28, projectId: 35, title: 'Example issue', state: 'Open', submitter: 'Owen' },
  pullRequest = { id: 123, number: 5, targetProjectId: 35, title: 'Add webhook routing', submitter: 'Owen' },
  issueChanges = [],
  buildResponse,
  issueResponse,
  pullRequestResponse,
  projectResponse,
  dingTalkFetch = okDingTalk()
} = {}) {
  const requests = { oneDev: [], dingTalk: [] };
  return {
    requests,
    fetchImpl: async (url, options) => {
      const requestUrl = url.toString();
      if (requestUrl.startsWith(ONEDEV_URL)) {
        requests.oneDev.push({ url: requestUrl, options });
        if (requestUrl === `${ONEDEV_URL}~api/builds/856`) return buildResponse || jsonResponse(build);
        if (requestUrl === `${ONEDEV_URL}~api/issues/${issue.id}`) return issueResponse || jsonResponse(issue);
        if (requestUrl === `${ONEDEV_URL}~api/issues/${issue.id}/changes`) return jsonResponse(issueChanges);
        if (requestUrl === `${ONEDEV_URL}~api/pull-requests/${pullRequest.id}`) return pullRequestResponse || jsonResponse(pullRequest);
        if (requestUrl === `${ONEDEV_URL}~api/projects/${project.id}`) return projectResponse || jsonResponse(project);
        throw new Error(`Unexpected OneDev API request: ${requestUrl}`);
      }
      if (requestUrl.startsWith(DINGTALK_ENDPOINT)) {
        requests.dingTalk.push({ url: requestUrl, options });
        return dingTalkFetch(requestUrl, options);
      }
      throw new Error(`Unexpected request: ${requestUrl}`);
    }
  };
}

test('legacy single-robot project configuration is rejected', () => {
  assert.throws(
    () => createApp({ env: { DINGTALK_PROJECT_ROBOTS: JSON.stringify({ BNA: { accessToken: 'old-token' } }) } }),
    /DINGTALK_PROJECT_ROBOTS contains an invalid robot route/
  );
});

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
      url: 'https://onedev.example.test/~api/builds/release%2F42',
      options: { headers: { accept: 'application/json', authorization: 'Bearer read-only-token' } }
    },
    {
      url: 'https://onedev.example.test/~api/projects/9',
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

test('OneDev client sanitizes network errors', async () => {
  const client = createOneDevClient({
    baseUrl: 'https://onedev.example.test/',
    accessToken: 'read-only-token',
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED https://onedev.example.test/~api/builds/1?token=read-only-token'); }
  });

  await assert.rejects(client.getBuild(1), error => error.message === 'OneDev API request failed');
});

test('OneDev client sanitizes malformed JSON responses', async () => {
  const client = createOneDevClient({
    baseUrl: 'https://onedev.example.test/',
    accessToken: 'read-only-token',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); }
    })
  });

  await assert.rejects(client.getBuild(1), error => error.message === 'OneDev API response was not JSON');
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

test('classifyBuildWebhook accepts only positive integer build IDs', () => {
  assert.deepEqual(classifyBuildWebhook({ type: 'BuildRunning', buildId: 42 }), {
    kind: 'running', buildId: '42'
  });
  assert.deepEqual(classifyBuildWebhook({ type: 'BuildFinished', buildId: '0042' }), {
    kind: 'finished', buildId: '0042'
  });

  for (const buildId of ['', ' ', ' 42 ', '42.0', 'abc', true, false, {}, [], 0, -1, 1.5]) {
    assert.deepEqual(classifyBuildWebhook({ type: 'BuildRunning', buildId }), {
      kind: 'running', buildId: undefined
    });
  }
});

test('buildDeployNotification formats an absolute token-free build link from the public build number', () => {
  const accessToken = 'read-only-token';
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
    { name: 'demo-project', path: 'platform/demo project' },
    `https://onedev.example.test/root/?access_token=${accessToken}`
  );

  assert.equal(notification.eventType, EVENT_TYPES.BUILD_STARTED);
  assert.equal(notification.title, 'OneDev Build Started: demo-project');
  assert.match(notification.text, /OneDev Build Started: demo-project/);
  assert.match(notification.text, /Project: demo-project/);
  assert.match(notification.text, /Job: deploy/);
  assert.match(notification.text, /Build: \[#128\]\(https:\/\/onedev\.example\.test\/root\/platform\/demo%20project\/~builds\/128\)/);
  assert.doesNotMatch(notification.text, new RegExp(accessToken));
  assert.match(notification.text, /Ref: main/);
  assert.match(notification.text, /Commit: abc123/);
  assert.match(notification.text, /Status: RUNNING/);
});

test('buildDeployNotification strips credentials, query strings, and fragments from build links', () => {
  const notification = buildDeployNotification(
    { type: 'BuildRunning', buildId: 42 },
    { id: 42, number: 128, status: 'RUNNING' },
    { name: 'demo-project', path: 'platform/demo' },
    'https://username:password@onedev.example.test/root/?access_token=read-only-token#fragment'
  );

  assert.match(notification.text, /Build: \[#128\]\(https:\/\/onedev\.example\.test\/root\/platform\/demo\/~builds\/128\)/);
  assert.doesNotMatch(notification.text, /username|password|access_token|fragment/);
});

test('buildDeployNotification omits the build link without a base URL, project path, or public number', () => {
  const notification = buildDeployNotification(
    { type: 'BuildRunning', buildId: 42 },
    { id: 42, jobName: 'deploy', status: 'RUNNING' },
    { name: 'demo-project' }
  );

  assert.doesNotMatch(notification.text, /\]\(.*~builds/);
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

for (const { name, payload, expectedTitle, expectedText } of [
  {
    name: 'new issue creation',
    payload: { type: 'IssueOpened', user: { name: 'Owen' } },
    expectedTitle: 'New issue created: BNA',
    expectedText: /Action: New issue created/
  },
  {
    name: 'new issue comment',
    payload: { type: 'IssueCommentCreated', user: { name: 'Owen' }, comment: { content: 'Please check the logs' } },
    expectedTitle: 'New comment: BNA',
    expectedText: /Comment: Please check the logs/
  },
  {
    name: 'issue status change',
    payload: { type: 'IssueChanged', user: { name: 'Owen' }, change: { data: { oldState: 'Open', newState: 'In Progress' } } },
    expectedTitle: 'Issue status changed: BNA',
    expectedText: /Status: Open → In Progress/
  },
  {
    name: 'issue content modification',
    payload: { type: 'IssueChanged', user: { name: 'Owen' }, change: { data: { oldFieldValues: { Title: 'Old title' }, newFieldValues: { Title: 'New title' } } } },
    expectedTitle: 'Issue content modified: BNA',
    expectedText: /Action: Issue content modified/
  }
]) {
  test(`buildIssueNotification labels ${name}`, () => {
    const notification = buildIssueNotification(
      payload,
      { id: 28, number: 28, title: 'Flight date rolls back', state: 'Open', submitter: 'Macy' },
      { id: 34, name: 'BNA', path: 'BNA' },
      ONEDEV_URL
    );
    assert.equal(notification.title, expectedTitle);
    assert.match(notification.text, expectedText);
  });
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

test('non-build events use the DingTalk robot mapped to the payload project name', async () => {
  const { fetchImpl, requests } = createUrlRoutedFetchMock();
  await withServer(fetchImpl, async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'Push', project: { name: 'CHI' } })
    });
    assert.equal(response.status, 200);
  }, {
    DINGTALK_PROJECT_ROBOTS: JSON.stringify({
      CHI: { default: [{ accessToken: 'chi-token' }] }
    })
  });

  assert.equal(requests.dingTalk.length, 1);
  assert.equal(new URL(requests.dingTalk[0].url).searchParams.get('access_token'), 'chi-token');
});

test('Pull Request events use the dedicated pr robot route', async () => {
  const { fetchImpl, requests } = createUrlRoutedFetchMock();
  await withServer(fetchImpl, async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'PullRequestOpened', project: { name: 'CHI' } })
    });
    assert.equal(response.status, 200);
  }, {
    DINGTALK_PROJECT_ROBOTS: JSON.stringify({
      CHI: {
        pr: [{ accessToken: 'pr-token' }],
        default: [{ accessToken: 'default-token' }]
      }
    })
  });

  assert.equal(requests.dingTalk.length, 1);
  assert.equal(new URL(requests.dingTalk[0].url).searchParams.get('access_token'), 'pr-token');
});

test('Pull Request webhooks with requestId and projectId resolve project before routing', async () => {
  const { fetchImpl, requests } = createUrlRoutedFetchMock({
    project: { id: 35, name: 'CHI', path: 'products/CHI' }
  });

  await withServer(fetchImpl, async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'PullRequestOpened', projectId: 35, requestId: 123 })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.eventType, EVENT_TYPES.PULL_REQUEST);
    assert.equal(body.notificationSent, true);
  }, {
    DINGTALK_PROJECT_ROBOTS: JSON.stringify({
      'products/CHI': {
        pr: [{ accessToken: 'pr-token' }],
        default: [{ accessToken: 'default-token' }]
      }
    })
  });

  assert.deepEqual(requests.oneDev.map(request => request.url), [
    `${ONEDEV_URL}~api/projects/35`,
    `${ONEDEV_URL}~api/pull-requests/123`
  ]);
  assert.equal(requests.dingTalk.length, 1);
  assert.equal(new URL(requests.dingTalk[0].url).searchParams.get('access_token'), 'pr-token');
});

test('Pull Request webhooks route by projectId when pull request lookup fails', async () => {
  const logs = [];
  const { fetchImpl, requests } = createUrlRoutedFetchMock({
    project: { id: 35, name: 'CHI', path: 'products/CHI' },
    pullRequestResponse: jsonResponse({ message: 'not found' }, { ok: false, status: 404 })
  });

  await withServer(fetchImpl, async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'PullRequestOpened', projectId: 35, requestId: 123 })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.eventType, EVENT_TYPES.PULL_REQUEST);
    assert.equal(body.notificationSent, true);
  }, {
    logger: {
      info() {},
      warn: (message, context) => logs.push({ message, context }),
      error() {}
    },
    DINGTALK_PROJECT_ROBOTS: JSON.stringify({
      'products/CHI': { pr: [{ accessToken: 'pr-token' }] }
    })
  });

  assert.deepEqual(requests.oneDev.map(request => request.url), [
    `${ONEDEV_URL}~api/projects/35`,
    `${ONEDEV_URL}~api/pull-requests/123`
  ]);
  assert.equal(requests.dingTalk.length, 1);
  assert.equal(new URL(requests.dingTalk[0].url).searchParams.get('access_token'), 'pr-token');
  assert.deepEqual(logs, [
    {
      message: 'OneDev pull request lookup failed',
      context: {
        type: 'PullRequestOpened',
        projectPath: 'products/CHI',
        projectName: 'CHI',
        error: 'OneDev API request failed with status 404'
      }
    }
  ]);
});

test('Pull Request events fall back to the default robot route', async () => {
  const { fetchImpl, requests } = createUrlRoutedFetchMock();
  await withServer(fetchImpl, async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'PullRequestOpened', project: { name: 'CHI' } })
    });
    assert.equal(response.status, 200);
  }, {
    DINGTALK_PROJECT_ROBOTS: JSON.stringify({
      CHI: { default: [{ accessToken: 'default-token' }] }
    })
  });

  assert.equal(requests.dingTalk.length, 1);
  assert.equal(new URL(requests.dingTalk[0].url).searchParams.get('access_token'), 'default-token');
});

test('webhook logs Pull Request receipt and successful processing without secrets', async () => {
  const logs = [];
  const { fetchImpl } = createUrlRoutedFetchMock();
  await withServer(fetchImpl, async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({
        type: 'PullRequestOpened',
        project: { path: 'products/CHI', name: 'CHI' },
        secret: 'payload-secret',
        accessToken: 'payload-token'
      })
    });
    assert.equal(response.status, 200);
  }, {
    logger: {
      info: (message, context) => logs.push({ message, context }),
      warn() {},
      error() {}
    },
    DINGTALK_PROJECT_ROBOTS: JSON.stringify({
      'products/CHI': { pr: [{ accessToken: 'pr-token', secret: 'robot-secret' }] }
    })
  });

  assert.deepEqual(logs, [
    {
      message: 'OneDev webhook received',
      context: { type: 'PullRequestOpened', projectPath: 'products/CHI', projectName: 'CHI' }
    },
    {
      message: 'OneDev webhook processed',
      context: {
        type: 'PullRequestOpened',
        projectPath: 'products/CHI',
        projectName: 'CHI',
        eventType: EVENT_TYPES.PULL_REQUEST,
        notificationSent: true
      }
    }
  ]);
  assert.doesNotMatch(JSON.stringify(logs), /payload-secret|payload-token|pr-token|robot-secret/);
});

test('webhook logs notificationSent false for an unmapped project', async () => {
  const logs = [];
  const { fetchImpl, requests } = createUrlRoutedFetchMock();
  await withServer(fetchImpl, async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'PullRequestOpened', project: { name: 'BNA' } })
    });
    assert.equal(response.status, 200);
  }, {
    logger: {
      info: (message, context) => logs.push({ message, context }),
      warn() {},
      error() {}
    },
    DINGTALK_PROJECT_ROBOTS: JSON.stringify({
      CHI: { pr: [{ accessToken: 'chi-token' }] }
    })
  });

  assert.deepEqual(logs.at(-1), {
    message: 'OneDev webhook processed',
    context: {
      type: 'PullRequestOpened',
      projectName: 'BNA',
      eventType: EVENT_TYPES.PULL_REQUEST,
      notificationSent: false
    }
  });
  assert.deepEqual(requests.dingTalk, []);
});

test('Issue webhook enriches the issue and routes it to the project robot', async () => {
  const { fetchImpl, requests } = createUrlRoutedFetchMock({
    issue: { id: 28, number: 28, projectId: 34, title: 'Flight date rolls back', state: 'In Progress', submitter: 'Macy' },
    project: { id: 34, name: 'BNA', path: 'BNA' }
  });
  await withServer(fetchImpl, async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'IssueChanged', issueId: 28, user: { name: 'Owen' } })
    });
    assert.deepEqual(await response.json(), {
      success: true, eventType: EVENT_TYPES.ISSUE, notificationSent: true
    });
  }, {
    DINGTALK_PROJECT_ROBOTS: JSON.stringify({ BNA: { build: [{ accessToken: 'build-token' }], issue: [{ accessToken: 'issue-token' }] } })
  });

  assert.deepEqual(requests.oneDev.map(request => request.url), [
    `${ONEDEV_URL}~api/issues/28`,
    `${ONEDEV_URL}~api/issues/28/changes`,
    `${ONEDEV_URL}~api/projects/34`
  ]);
  assert.equal(requests.dingTalk.length, 1);
  assert.equal(new URL(requests.dingTalk[0].url).searchParams.get('access_token'), 'issue-token');
  const markdown = JSON.parse(requests.dingTalk[0].options.body).markdown;
  assert.equal(markdown.title, 'Issue content modified: BNA');
  assert.match(markdown.text, /Issue: \[#28 - Flight date rolls back\]\(https:\/\/onedev\.example\.test\/BNA\/~issues\/28\)/);
  assert.match(markdown.text, /Action: Issue content modified/);
  assert.match(markdown.text, /State: In Progress/);
  assert.match(markdown.text, /Operator: Owen/);
});

test('Issue state changes use the latest OneDev change record', async () => {
  const { fetchImpl, requests } = createUrlRoutedFetchMock({
    issue: { id: 28, number: 28, projectId: 34, title: 'Flight date rolls back', state: 'In Progress', submitter: 'Macy' },
    project: { id: 34, name: 'BNA', path: 'BNA' },
    issueChanges: [{ data: { oldFieldValues: { State: 'Open' }, newFieldValues: { State: 'In Progress' } } }]
  });
  await withServer(fetchImpl, async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'IssueChanged', issueId: 28, user: { name: 'Owen' } })
    });
    assert.equal(response.status, 200);
  }, {
    DINGTALK_PROJECT_ROBOTS: JSON.stringify({ BNA: { issue: [{ accessToken: 'bna-token' }] } })
  });

  assert.deepEqual(requests.oneDev.map(request => request.url), [
    `${ONEDEV_URL}~api/issues/28`,
    `${ONEDEV_URL}~api/issues/28/changes`,
    `${ONEDEV_URL}~api/projects/34`
  ]);
  const markdown = JSON.parse(requests.dingTalk[0].options.body).markdown;
  assert.equal(markdown.title, 'Issue status changed: BNA');
  assert.match(markdown.text, /Status: Open → In Progress/);
});

test('an unmapped project is acknowledged without sending a notification', async () => {
  const { fetchImpl, requests } = createUrlRoutedFetchMock();
  await withServer(fetchImpl, async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'Push', project: { name: 'BNA' } })
    });
    assert.deepEqual(await response.json(), {
      success: true, eventType: EVENT_TYPES.PUSH, notificationSent: false
    });
  }, {
    DINGTALK_PROJECT_ROBOTS: JSON.stringify({
      CHI: { default: [{ accessToken: 'chi-token' }] }
    })
  });

  assert.deepEqual(requests.dingTalk, []);
});

test('BuildPending is acknowledged without OneDev or DingTalk calls', async () => {
  const { fetchImpl, requests } = createUrlRoutedFetchMock();
  await withServer(fetchImpl, async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'BuildPending', buildId: 856 })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true, eventType: 'BUILD_IGNORED', notificationSent: false
    });
  });
  assert.deepEqual(requests.oneDev, []);
  assert.deepEqual(requests.dingTalk, []);
});

test('Build lifecycle payload without buildId is acknowledged without calls', async () => {
  const { fetchImpl, requests } = createUrlRoutedFetchMock();
  await withServer(fetchImpl, async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'BuildRunning' })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true, eventType: 'BUILD_IGNORED', notificationSent: false
    });
  });
  assert.deepEqual(requests.oneDev, []);
  assert.deepEqual(requests.dingTalk, []);
});

test('Build lifecycle payload with an invalid buildId is acknowledged without calls', async () => {
  for (const buildId of ['', ' ', true, {}, [], 0, -1, 1.5, 'invalid']) {
    const { fetchImpl, requests } = createUrlRoutedFetchMock();
    await withServer(fetchImpl, async request => {
      const response = await request({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
        body: JSON.stringify({ type: 'BuildRunning', buildId })
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        success: true, eventType: 'BUILD_IGNORED', notificationSent: false
      });
    });
    assert.deepEqual(requests.oneDev, []);
    assert.deepEqual(requests.dingTalk, []);
  }
});

test('BuildRunning for a non-matching Job skips project lookup and DingTalk', async () => {
  const { fetchImpl, requests } = createUrlRoutedFetchMock({
    build: { id: 856, jobName: 'test', status: 'RUNNING', projectId: 35 }
  });
  await withServer(fetchImpl, async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'BuildRunning', buildId: 856 })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true, eventType: 'BUILD_IGNORED', notificationSent: false
    });
  });
  assert.deepEqual(requests.oneDev, [{
    url: `${ONEDEV_URL}~api/builds/856`,
    options: { headers: { accept: 'application/json', authorization: `Bearer ${ONEDEV_ACCESS_TOKEN}` } }
  }]);
  assert.deepEqual(requests.dingTalk, []);
});

test('BuildRunning for the configured Job sends an enriched DingTalk notification', async () => {
  const { fetchImpl, requests } = createUrlRoutedFetchMock();
  await withServer(fetchImpl, async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'BuildRunning', buildId: 856 })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true, eventType: EVENT_TYPES.BUILD_STARTED, notificationSent: true
    });
  });
  assert.deepEqual(requests.oneDev.map(request => request.url), [
    `${ONEDEV_URL}~api/builds/856`,
    `${ONEDEV_URL}~api/projects/35`
  ]);
  assert.equal(requests.dingTalk.length, 1);
  const body = JSON.parse(requests.dingTalk[0].options.body);
  assert.equal(body.markdown.title, 'OneDev Build Started: DingTalkWebHook');
  assert.match(body.markdown.text, /Project: DingTalkWebHook/);
});

test('Build notifications send to every configured build robot', async () => {
  const { fetchImpl, requests } = createUrlRoutedFetchMock();
  await withServer(fetchImpl, async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'BuildRunning', buildId: 856 })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).notificationSent, true);
  }, {
    DINGTALK_PROJECT_ROBOTS: JSON.stringify({
      DingTalkWebHook: {
        build: [{ accessToken: 'build-a-token' }, { accessToken: 'build-b-token' }],
        issue: [{ accessToken: 'issue-token' }]
      }
    })
  });

  assert.equal(requests.dingTalk.length, 2);
  assert.deepEqual(
    requests.dingTalk.map(request => new URL(request.url).searchParams.get('access_token')).sort(),
    ['build-a-token', 'build-b-token']
  );
});

test('BuildRunning uses the DingTalk robot mapped to the project path', async () => {
  const { fetchImpl, requests } = createUrlRoutedFetchMock({
    project: { id: 35, name: 'BNA', path: 'products/BNA' }
  });
  await withServer(fetchImpl, async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'BuildRunning', buildId: 856 })
    });
    assert.equal(response.status, 200);
  }, {
    DINGTALK_PROJECT_ROBOTS: JSON.stringify({
      'products/BNA': { build: [{ accessToken: 'bna-token', secret: 'bna-secret' }] }
    })
  });

  assert.equal(requests.dingTalk.length, 1);
  const url = new URL(requests.dingTalk[0].url);
  assert.equal(url.searchParams.get('access_token'), 'bna-token');
  assert.ok(url.searchParams.get('timestamp'));
  assert.ok(url.searchParams.get('sign'));
});

test('BuildRunning uses ONEDEV_PUBLIC_URL for DingTalk links while querying ONEDEV_URL', async () => {
  const publicUrl = 'http://175.178.115.41:6610';
  const { fetchImpl, requests } = createUrlRoutedFetchMock();
  await withServer(fetchImpl, async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'BuildRunning', buildId: 856 })
    });
    assert.equal(response.status, 200);
  }, { ONEDEV_PUBLIC_URL: publicUrl });

  assert.deepEqual(requests.oneDev.map(request => request.url), [
    `${ONEDEV_URL}~api/builds/856`,
    `${ONEDEV_URL}~api/projects/35`
  ]);
  assert.ok(JSON.parse(requests.dingTalk[0].options.body).markdown.text.includes(
    `Build: [#7](${publicUrl}/DingTalkWebHook/~builds/7)`
  ));
});

test('BuildRunning uses ONEDEV_NOTIFY_JOB when it overrides deploy', async () => {
  const { fetchImpl, requests } = createUrlRoutedFetchMock({
    build: { id: 856, jobName: 'release', status: 'RUNNING', projectId: 35 }
  });
  await withServer(fetchImpl, async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'BuildRunning', buildId: 856 })
    });
    assert.deepEqual(await response.json(), {
      success: true, eventType: EVENT_TYPES.BUILD_STARTED, notificationSent: true
    });
  }, { ONEDEV_NOTIFY_JOB: 'release' });
  assert.deepEqual(requests.oneDev.map(request => request.url), [
    `${ONEDEV_URL}~api/builds/856`,
    `${ONEDEV_URL}~api/projects/35`
  ]);
  assert.equal(requests.dingTalk.length, 1);
});

test('BuildRunning matches a trimmed ONEDEV_NOTIFY_JOBS list', async () => {
  const { fetchImpl, requests } = createUrlRoutedFetchMock({
    build: { id: 856, number: 275, jobName: 'CD Backend - dev', status: 'RUNNING', projectId: 35 }
  });
  await withServer(fetchImpl, async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'BuildRunning', buildId: 856 })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).notificationSent, true);
  }, { ONEDEV_NOTIFY_JOBS: 'deploy, CD Backend - dev, CD Sites - dev' });
  assert.equal(requests.dingTalk.length, 1);
});

for (const { status, eventType, title } of [
  { status: 'SUCCESSFUL', eventType: EVENT_TYPES.BUILD_SUCCEEDED, title: 'OneDev Build Succeeded: DingTalkWebHook' },
  { status: 'FAILED', eventType: EVENT_TYPES.BUILD_FAILED, title: 'OneDev Build Failed: DingTalkWebHook' }
]) {
  test(`BuildFinished ${status} sends the matching result notification`, async () => {
    const { fetchImpl, requests } = createUrlRoutedFetchMock({
      build: { id: 856, number: 7, jobName: 'deploy', status, projectId: 35 }
    });
    await withServer(fetchImpl, async request => {
      const response = await request({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
        body: JSON.stringify({ type: 'BuildFinished', buildId: 856 })
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { success: true, eventType, notificationSent: true });
    });
    assert.equal(requests.dingTalk.length, 1);
    assert.equal(JSON.parse(requests.dingTalk[0].options.body).markdown.title, title);
  });
}

for (const { label, build } of [
  { label: 'missing status', build: { id: 856, number: 7, jobName: 'deploy', projectId: 35 } },
  { label: 'unexpected status', build: { id: 856, number: 7, jobName: 'deploy', status: 'PAUSED', projectId: 35 } }
]) {
  test(`BuildFinished with ${label} returns a sanitized 502 without calling DingTalk`, async () => {
    const { fetchImpl, requests } = createUrlRoutedFetchMock({ build });
    await withServer(fetchImpl, async request => {
      const response = await request({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
        body: JSON.stringify({ type: 'BuildFinished', buildId: 856 })
      });
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { success: false, message: 'Failed to send DingTalk notification' });
    });
    assert.deepEqual(requests.oneDev.map(request => request.url), [`${ONEDEV_URL}~api/builds/856`]);
    assert.deepEqual(requests.dingTalk, []);
  });
}

test('OneDev API failures return a generic 502 response without sensitive details', async () => {
  const { fetchImpl, requests } = createUrlRoutedFetchMock({
    buildResponse: jsonResponse({ message: `Bearer ${ONEDEV_ACCESS_TOKEN}` }, { ok: false, status: 401 })
  });
  await withServer(fetchImpl, async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'BuildRunning', buildId: 856 })
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { success: false, message: 'Failed to send DingTalk notification' });
    assert.doesNotMatch(response.body, new RegExp(ONEDEV_ACCESS_TOKEN));
    assert.doesNotMatch(response.body, /https:\/\/onedev\.example\.test\/~api\/builds\/856/);
  });
  assert.deepEqual(requests.oneDev.map(request => request.url), [`${ONEDEV_URL}~api/builds/856`]);
  assert.deepEqual(requests.dingTalk, []);
});

test('Project lookup failures return a generic 502 response without sending DingTalk', async () => {
  const { fetchImpl, requests } = createUrlRoutedFetchMock({
    projectResponse: jsonResponse({ message: `Bearer ${ONEDEV_ACCESS_TOKEN}` }, { ok: false, status: 403 })
  });
  await withServer(fetchImpl, async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'BuildRunning', buildId: 856 })
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { success: false, message: 'Failed to send DingTalk notification' });
  });
  assert.deepEqual(requests.oneDev.map(request => request.url), [
    `${ONEDEV_URL}~api/builds/856`,
    `${ONEDEV_URL}~api/projects/35`
  ]);
  assert.deepEqual(requests.dingTalk, []);
});

test('DingTalk transport failures after a matching Build do not leak sensitive URLs to logs', async () => {
  const fakeToken = 'fake-dingtalk-access-token';
  const sensitiveUrl = `${DINGTALK_ENDPOINT}?access_token=${fakeToken}&timestamp=1700000000000&sign=fake-signature`;
  const errors = [];
  const { fetchImpl, requests } = createUrlRoutedFetchMock({
    dingTalkFetch: async () => { throw new Error(`connect ECONNREFUSED ${sensitiveUrl}`); }
  });
  await withServer(fetchImpl, async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'BuildRunning', buildId: 856 })
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { success: false, message: 'Failed to send DingTalk notification' });
  }, {
    DINGTALK_PROJECT_ROBOTS: JSON.stringify({ DingTalkWebHook: { build: [{ accessToken: fakeToken }] } }),
    logger: { warn() {}, error: message => errors.push(message) }
  });
  assert.equal(requests.dingTalk.length, 1);
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0], new RegExp(fakeToken));
  assert.doesNotMatch(errors[0], new RegExp(sensitiveUrl.replace(/[.?]/g, '\\$&')));
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

test('DingTalk business errors include safe errmsg details', async () => {
  const client = createDingTalkClient({
    accessToken: 'token',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ errcode: 310000, errmsg: 'keywords not in content' }) })
  });

  await assert.rejects(
    () => client.sendMarkdown('title', 'text'),
    error => error.message === 'DingTalk error code 310000: keywords not in content'
  );
});

test('DingTalk business error is returned as a failed webhook', async () => {
  await withServer(async () => ({ ok: true, status: 200, json: async () => ({ errcode: 310000, errmsg: 'invalid token' }) }), async request => {
    const response = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onedev-webhook-secret': 'change-me' },
      body: JSON.stringify({ type: 'Push', project: { name: 'demo' } })
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
