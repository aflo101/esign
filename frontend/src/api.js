// Sender-auth helpers. Auth is enforced by the backend only when SENDER_PASSWORD is set.
const KEY = 'esign_sender_token'

export const getToken = () => localStorage.getItem(KEY)
export const setToken = (t) => (t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY))

export function authHeaders(extra = {}) {
  const t = getToken()
  return t ? { ...extra, Authorization: `Bearer ${t}` } : extra
}

export async function authStatus() {
  return fetch('/api/auth/status').then(r => r.json())
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
