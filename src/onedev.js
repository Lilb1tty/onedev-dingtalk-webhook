const EVENT_TYPES = {
  PUSH: 'PUSH',
  BUILD_STARTED: 'BUILD_STARTED',
  BUILD_SUCCEEDED: 'BUILD_SUCCEEDED',
  BUILD_FAILED: 'BUILD_FAILED',
  PULL_REQUEST: 'PULL_REQUEST',
  ISSUE: 'ISSUE',
  UNKNOWN: 'UNKNOWN'
};

const EVENT_PRESENTATION = {
  PUSH: ['📦', 'OneDev Push'],
  BUILD_STARTED: ['🚀', 'OneDev Build Started'],
  BUILD_SUCCEEDED: ['✅', 'OneDev Build Succeeded'],
  BUILD_FAILED: ['❌', 'OneDev Build Failed'],
  PULL_REQUEST: ['🔀', 'OneDev Pull Request'],
  ISSUE: ['📋', 'OneDev Issue'],
  UNKNOWN: ['🔔', 'OneDev Notification']
};

function readField(payload, path) {
  const parts = path.split('.');
  let value = payload;
  for (const part of parts) {
    if (value === null || value === undefined || typeof value !== 'object' || !(part in value)) return undefined;
    value = value[part];
  }
  return value;
}

function firstValue(payload, paths) {
  for (const path of paths) {
    const value = readField(payload, path);
    if ((typeof value === 'string' && value.trim()) || typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  }
  return undefined;
}

function eventText(payload) {
  return [
    readField(payload, '@class'),
    readField(payload, 'type'),
    readField(payload, 'eventType'),
    readField(payload, 'status'),
    readField(payload, 'build.status')
  ].filter(value => typeof value === 'string').join(' ').toLowerCase();
}

function detectEvent(payload) {
  const text = eventText(payload);
  const buildStatus = firstValue(payload, ['build.status']);
  const isBuild = text.includes('build') || buildStatus !== undefined;
  if (isBuild) {
    if (/(failed|failure|error|cancelled|canceled|broken)/i.test(text)) return EVENT_TYPES.BUILD_FAILED;
    if (/(succeed|success|passed|pass|finished|completed|complete)/i.test(text)) return EVENT_TYPES.BUILD_SUCCEEDED;
  }
  if (text.includes('push')) return EVENT_TYPES.PUSH;
  if (text.includes('pullrequest') || text.includes('pull request') || /\bpr\b/.test(text)) return EVENT_TYPES.PULL_REQUEST;
  if (text.includes('issue')) return EVENT_TYPES.ISSUE;
  return EVENT_TYPES.UNKNOWN;
}

function truncate(value, maxLength = 500) {
  const text = String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function safeField(value) {
  return truncate(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function buildNotification(payload) {
  const eventType = detectEvent(payload);
  const [icon, title] = EVENT_PRESENTATION[eventType];
  const lines = [`### ${icon} ${title}`, '', `- Event: ${eventType}`];
  const fields = [
    ['Project', ['project.name', 'project', 'repository.name', 'repository']],
    ['Status', ['build.status', 'status']],
    ['Branch', ['branch', 'refName', 'gitRef', 'ref.name']],
    ['Operator', ['user.name', 'actor.name', 'operator.name', 'user', 'actor']],
    ['Commit ID', ['commit.hash', 'commit.id', 'commit.sha', 'commit.commitHash']],
    ['Commit message', ['commit.message', 'commit.subject']],
    ['Build', ['build.number', 'build.id']],
    ['Link', ['url', 'link', 'build.url', 'pullRequest.url', 'issue.url']],
    ['Time', ['timestamp', 'eventTime', 'occurredAt', 'date', 'time']]
  ];
  for (const [label, paths] of fields) {
    const value = firstValue(payload, paths);
    if (value !== undefined) {
      const formattedValue = label === 'Build' && /^\d+$/.test(value) ? `#${value}` : value;
      const formatted = label === 'Link' ? `[Open Event](${safeField(formattedValue)})` : safeField(formattedValue);
      lines.push(`- ${label}: ${formatted}`);
    }
  }
  const pullRequestNumber = firstValue(payload, ['pullRequest.number', 'pullRequest.id']);
  const pullRequestTitle = firstValue(payload, ['pullRequest.title']);
  if (pullRequestNumber || pullRequestTitle) lines.push(`- Pull Request: ${safeField([pullRequestNumber && `#${pullRequestNumber}`, pullRequestTitle].filter(Boolean).join(' - '))}`);
  const issueNumber = firstValue(payload, ['issue.number', 'issue.id']);
  const issueTitle = firstValue(payload, ['issue.title']);
  if (issueNumber || issueTitle) lines.push(`- Issue: ${safeField([issueNumber && `#${issueNumber}`, issueTitle].filter(Boolean).join(' - '))}`);
  return { eventType, title: 'OneDev Notification', text: truncate(lines.join('\n'), 15000) };
}

function classifyBuildWebhook(payload) {
  const buildId = normalizeBuildId(payload?.buildId);
  if (payload?.type === 'BuildRunning') return { kind: 'running', buildId };
  if (payload?.type === 'BuildFinished') return { kind: 'finished', buildId };
  return { kind: 'ignored', buildId };
}

function normalizeBuildId(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? String(value) : undefined;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  return BigInt(value) > 0n ? value : undefined;
}

function buildOneDevBuildUrl(oneDevUrl, projectPath, buildNumber) {
  if (typeof oneDevUrl !== 'string' || !oneDevUrl.trim() || typeof projectPath !== 'string' || !projectPath.trim() || buildNumber === undefined) {
    return undefined;
  }
  const segments = projectPath.split('/');
  if (segments.some(segment => !segment)) return undefined;
  try {
    const url = new URL(oneDevUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    const baseUrl = url.toString().replace(/\/+$/, '');
    const encodedPath = segments.map(segment => encodeURIComponent(segment)).join('/');
    return `${baseUrl}/${encodedPath}/~builds/${encodeURIComponent(buildNumber)}`;
  } catch {
    return undefined;
  }
}

function buildDeployNotification(payload, build, project, oneDevUrl) {
  const status = firstValue(build, ['status']);
  let eventType = EVENT_TYPES.UNKNOWN;
  if (payload?.type === 'BuildRunning') {
    eventType = EVENT_TYPES.BUILD_STARTED;
  } else if (payload?.type === 'BuildFinished') {
    if (status === 'SUCCESSFUL') eventType = EVENT_TYPES.BUILD_SUCCEEDED;
    if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(status)) eventType = EVENT_TYPES.BUILD_FAILED;
  }

  const [icon, eventTitle] = EVENT_PRESENTATION[eventType];
  const projectName = firstValue(project, ['name']) || 'Unknown Project';
  const projectPath = firstValue(project, ['path']);
  const title = `${eventTitle}: ${projectName}`;
  const lines = [`### ${icon} ${safeField(title)}`, '', `- Project: ${safeField(projectName)}`];
  const jobName = firstValue(build, ['jobName']);
  const buildNumber = firstValue(build, ['number']);
  const refName = firstValue(build, ['refName']);
  const commitHash = firstValue(build, ['commitHash']);

  if (jobName !== undefined) lines.push(`- Job: ${safeField(jobName)}`);
  if (buildNumber !== undefined) {
    const label = `#${buildNumber}`;
    const buildUrl = buildOneDevBuildUrl(oneDevUrl, projectPath, buildNumber);
    const formatted = buildUrl === undefined ? safeField(label) : `[${safeField(label)}](${buildUrl})`;
    lines.push(`- Build: ${formatted}`);
  }
  if (refName !== undefined) lines.push(`- Ref: ${safeField(refName)}`);
  if (commitHash !== undefined) lines.push(`- Commit: ${safeField(commitHash)}`);
  if (status !== undefined) lines.push(`- Status: ${safeField(status)}`);
  return { eventType, title, text: truncate(lines.join('\n'), 15000) };
}

module.exports = {
  EVENT_TYPES,
  buildDeployNotification,
  buildNotification,
  classifyBuildWebhook,
  detectEvent,
  readField,
  truncate
};
