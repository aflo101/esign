// Sender-auth helpers. Auth is enforced by the backend only when SENDER_PASSWORD is set.
const KEY = 'esign_sender_token'

export const getToken = () => localStorage.getItem(KEY)
export const setToken = (t) => (t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY))

export function authHeaders(extra = {}) {
  const t = getToken()
  return t ? { ...extra, Authorization: `Bearer ${t}` } : extra
}

// Sends the bearer so the server can report whether it's still valid, not just present.
export async function authStatus() {
  return fetch('/api/auth/status', { headers: authHeaders() }).then(r => r.json())
}

/**
 * fetch wrapper for sender-only calls. A 401 means the stored token is dead — drop it and
 * reload so the gate re-locks and prompts, instead of leaving the app rendered in a state
 * where every action fails with "sender auth required" and there's no way to sign back in.
 */
export async function senderFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: authHeaders(opts.headers || {}) })
  if (res.status === 401) {
    setToken(null)
    window.location.reload()
    throw new Error('session expired — please sign in again')
  }
  return res
}

export async function login(password) {
  const r = await fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  }).then(r => r.json())
  if (r.error) throw new Error(r.error)
  setToken(r.token)
  return r
}
