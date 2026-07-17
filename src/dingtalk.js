const crypto = require('node:crypto');

const DINGTALK_ENDPOINT = 'https://oapi.dingtalk.com/robot/send';

function createSignature(timestamp, secret) {
  const stringToSign = `${timestamp}\n${secret}`;
  return encodeURIComponent(crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64'));
}

function createDingTalkClient({ accessToken, secret = '', fetchImpl = globalThis.fetch, now = Date.now }) {
  if (!accessToken) throw new Error('DingTalk access token is required');
  return {
    async sendMarkdown(title, text) {
      const query = [`access_token=${encodeURIComponent(accessToken)}`];
      if (secret) {
        const timestamp = String(now());
        query.push(`timestamp=${timestamp}`);
        query.push(`sign=${createSignature(timestamp, secret)}`);
      }
      const response = await fetchImpl(`${DINGTALK_ENDPOINT}?${query.join('&')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { title, text } })
      });
      if (!response.ok) throw new Error(`DingTalk HTTP status ${response.status}`);
      let result;
      try {
        result = await response.json();
      } catch {
        throw new Error('DingTalk returned invalid JSON');
      }
      if (!result || result.errcode !== 0) {
        const detail = typeof result?.errmsg === 'string' && result.errmsg.trim() ? `: ${result.errmsg.trim()}` : '';
        throw new Error(`DingTalk error code ${result?.errcode ?? 'unknown'}${detail}`);
      }
      return result;
    }
  };
}

module.exports = { DINGTALK_ENDPOINT, createDingTalkClient, createSignature };
