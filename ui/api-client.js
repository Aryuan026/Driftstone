function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function withQuery(base, path, params = {}) {
  const root = trimTrailingSlash(base)
    || (typeof window !== 'undefined' ? window.location.origin : '');
  const url = new URL(path, `${root}/`);
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    const text = String(value).trim();
    if (!text) return;
    url.searchParams.set(key, text);
  });
  return url.toString();
}

async function parseJson(resp) {
  const text = await resp.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: 'Invalid JSON response',
      raw: text
    };
  }
}

async function request(base, path, options = {}) {
  const { method = 'GET', params = {}, body } = options;
  const url = withQuery(base, path, params);
  const headers = {};
  const init = { method, headers };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const resp = await fetch(url, init);
  const payload = await parseJson(resp);
  return {
    ok: resp.ok,
    status: resp.status,
    url,
    payload
  };
}

export async function getJson(base, path, params = {}) {
  return request(base, path, { method: 'GET', params });
}

export async function postJson(base, path, body = {}) {
  return request(base, path, { method: 'POST', body });
}
