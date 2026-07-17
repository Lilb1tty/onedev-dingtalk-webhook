function createOneDevClient({ baseUrl, accessToken, fetchImpl = globalThis.fetch }) {
  async function get(path) {
    let response;
    try {
      response = await fetchImpl(new URL(path, baseUrl), {
        headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` }
      });
    } catch {
      throw new Error('OneDev API request failed');
    }
    if (!response.ok) throw new Error(`OneDev API request failed with status ${response.status}`);
    if (!response.headers?.get('content-type')?.toLowerCase().includes('application/json')) {
      throw new Error('OneDev API response was not JSON');
    }
    try {
      return await response.json();
    } catch {
      throw new Error('OneDev API response was not JSON');
    }
  }

  return {
    getBuild(buildId) {
      return get('/~api/builds/' + encodeURIComponent(buildId));
    },
    getIssue(issueId) {
      return get('/~api/issues/' + encodeURIComponent(issueId));
    },
    getIssueChanges(issueId) {
      return get('/~api/issues/' + encodeURIComponent(issueId) + '/changes');
    },
    getPullRequest(requestId) {
      return get('/~api/pulls/' + encodeURIComponent(requestId));
    },
    getProject(projectId) {
      return get('/~api/projects/' + encodeURIComponent(projectId));
    }
  };
}

module.exports = { createOneDevClient };
