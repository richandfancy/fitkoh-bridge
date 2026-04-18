class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })

  if (resp.status === 401) {
    // Only dashboard-auth routes should kick users to the login screen.
    // Public /api/v1/* endpoints 401 for missing API keys and shouldn't
    // affect the dashboard session.
    if (/^\/(api\/(dashboard|admin|auth)|auth\/)/.test(url)) {
      window.dispatchEvent(new CustomEvent('auth:logout'))
    }
    throw new ApiError(401, 'Unauthorized')
  }

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({ error: 'Unknown error' })) as { error?: string }
    throw new ApiError(resp.status, body.error || `HTTP ${resp.status}`)
  }

  return resp.json() as Promise<T>
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
}
