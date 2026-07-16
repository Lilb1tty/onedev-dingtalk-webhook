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
  const buildId = normalizeEntityId(payload?.buildId);
  if (payload?.type === 'BuildRunning') return { kind: 'running', buildId };
  if (payload?.type === 'BuildFinished') return { kind: 'finished', buildId };
  return { kind: 'ignored', buildId };
}

function classifyIssueWebhook(payload) {
  if (typeof payload?.type !== 'string' || !payload.type.startsWith('Issue')) return undefined;
  return normalizeEntityId(payload.issueId);
}

function normalizeEntityId(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? String(value) : undefined;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  return BigInt(value) > 0n ? value : undefined;
}

function buildOneDevEntityUrl(oneDevUrl, projectPath, entityPath, number) {
  if (typeof oneDevUrl !== 'string' || !oneDevUrl.trim() || typeof projectPath !== 'string' || !projectPath.trim() || number === undefined) {
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
    return `${baseUrl}/${encodedPath}/~${entityPath}/${encodeURIComponent(number)}`;
  } catch {
    return undefined;
  }
}

function buildOneDevBuildUrl(oneDevUrl, projectPath, buildNumber) {
  return buildOneDevEntityUrl(oneDevUrl, projectPath, 'builds', buildNumber);
}

function buildOneDevIssueUrl(oneDevUrl, projectPath, issueNumber) {
  return buildOneDevEntityUrl(oneDevUrl, projectPath, 'issues', issueNumber);
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

function getLatestIssueChange(changes) {
  if (!Array.isArray(changes) || changes.length === 0) return undefined;
  return changes.reduce((latest, change) => {
    const latestId = Number(firstValue(latest, ['id']));
    const changeId = Number(firstValue(change, ['id']));
    return Number.isFinite(changeId) && (!Number.isFinite(latestId) || changeId > latestId) ? change : latest;
  });
}

function getIssueNotificationAction(payload, issue, issueChanges) {
  const event = firstValue(payload, ['type', '@class', 'eventType']) || '';
  if (/issueopened/i.test(event)) return { icon: '🆕', label: 'New issue created' };

  if (/issuecommentcreated/i.test(event)) {
    return {
      icon: '💬',
      label: 'New comment',
      comment: firstValue(payload, ['comment.content', 'comment.text', 'comment.body', 'content', 'commentText'])
    };
  }

  if (/issuechanged/i.test(event)) {
    const latestChange = getLatestIssueChange(issueChanges);
    const oldState = firstValue(payload, [
      'oldState',
      'previousState',
      'change.data.oldState',
      'change.oldState',
      'change.data.oldFieldValues.State',
      'change.oldFieldValues.State'
    ]) || firstValue(latestChange, ['data.oldState', 'oldState', 'data.oldFieldValues.State', 'oldFieldValues.State']);
    const newState = firstValue(payload, [
      'newState',
      'change.data.newState',
      'change.newState',
      'change.data.newFieldValues.State',
      'change.newFieldValues.State'
    ]) || firstValue(latestChange, ['data.newState', 'newState', 'data.newFieldValues.State', 'newFieldValues.State']) || firstValue(issue, ['state', 'status']);
    if (oldState !== undefined && newState !== undefined && oldState !== newState) {
      return { icon: '🔄', label: 'Issue status changed', oldState, newState };
    }
    return { icon: '✏️', label: 'Issue content modified' };
  }

  return { icon: '📋', label: 'Issue updated' };
}

function buildIssueNotification(payload, issue, project, oneDevUrl, issueChanges) {
  const projectName = firstValue(project, ['name']) || 'Unknown Project';
  const projectPath = firstValue(project, ['path']);
  const action = getIssueNotificationAction(payload, issue, issueChanges);
  const title = `${action.label}: ${projectName}`;
  const lines = [`### ${action.icon} ${safeField(title)}`, '', `- Project: ${safeField(projectName)}`];
  const issueNumber = firstValue(issue, ['number']);
  const issueTitle = firstValue(issue, ['title']);
  const state = firstValue(issue, ['state', 'status']);
  const operator = firstValue(payload, ['user.name', 'actor.name', 'operator.name', 'user', 'actor']);
  const submitter = firstValue(issue, ['submitter.name', 'submitter']);

  if (issueNumber !== undefined || issueTitle !== undefined) {
    const label = [issueNumber !== undefined && `#${issueNumber}`, issueTitle].filter(Boolean).join(' - ');
    const issueUrl = issueNumber === undefined ? undefined : buildOneDevIssueUrl(oneDevUrl, projectPath, issueNumber);
    const formattedIssue = issueUrl === undefined ? safeField(label) : `[${safeField(label)}](${issueUrl})`;
    lines.push(`- Issue: ${formattedIssue}`);
  }
  if (action.oldState !== undefined && action.newState !== undefined) {
    lines.push(`- Status: ${safeField(action.oldState)} → ${safeField(action.newState)}`);
  } else {
    lines.push(`- Action: ${safeField(action.label)}`);
    if (state !== undefined) lines.push(`- State: ${safeField(state)}`);
  }
  if (action.comment !== undefined) lines.push(`- Comment: ${safeField(action.comment)}`);
  if (operator !== undefined) lines.push(`- Operator: ${safeField(operator)}`);
  if (submitter !== undefined) lines.push(`- Submitter: ${safeField(submitter)}`);
  const time = firstValue(payload, ['timestamp', 'eventTime', 'occurredAt', 'date', 'time']);
  if (time !== undefined) lines.push(`- Time: ${safeField(time)}`);
  return { eventType: EVENT_TYPES.ISSUE, title, text: truncate(lines.join('\n'), 15000) };
}

module.exports = {
  EVENT_TYPES,
  buildDeployNotification,
  buildIssueNotification,
  buildNotification,
  classifyBuildWebhook,
  classifyIssueWebhook,
  detectEvent,
  readField,
  truncate
};
