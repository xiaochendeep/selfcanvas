interface BrowserSessionPayload {
  csrfToken: string;
  expiresAt: string;
}

let sessionPromise: Promise<BrowserSessionPayload> | null = null;

async function browserSession(force = false) {
  if (force) sessionPromise = null;
  if (!sessionPromise) {
    sessionPromise = fetch('/api/browser/session', {
      cache: 'no-store',
      credentials: 'same-origin',
    }).then(async (response) => {
      const payload = await response.json() as Partial<BrowserSessionPayload> & { error?: string };
      if (!response.ok || !payload.csrfToken) throw new Error(payload.error || '无法建立 SelfCanvas 浏览器会话');
      return payload as BrowserSessionPayload;
    }).catch((error) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

export async function browserApiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const execute = async (forceSession = false) => {
    const session = await browserSession(forceSession);
    return fetch(input, {
      ...init,
      credentials: 'same-origin',
      headers: {
        ...Object.fromEntries(new Headers(init.headers).entries()),
        'X-SelfCanvas-CSRF': session.csrfToken,
      },
    });
  };
  let response = await execute(false);
  if (response.status === 401) response = await execute(true);
  return response;
}

export async function browserCsrfToken() {
  return (await browserSession()).csrfToken;
}
