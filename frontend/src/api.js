// Sender-auth helpers. Senders sign in with an emailed magic link; the backend returns a session JWT.
const KEY = 'esign_sender_token'
const USER_KEY = 'esign_sender_user'

export const getToken = () => localStorage.getItem(KEY)
export const setToken = (t) => (t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY))

// Display-only cache of {email,name} for the header; the JWT is the real credential.
export const getUser = () => { try { return JSON.parse(localStorage.getItem(USER_KEY)) } catch { return null } }
export const setUser = (u) => (u ? localStorage.setItem(USER_KEY, JSON.stringify(u)) : localStorage.removeItem(USER_KEY))

export function signOut() {
  setToken(null); setUser(null)
  window.location.assign('/')
}

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
    setToken(null); setUser(null)
    window.location.reload()
    throw new Error('session expired — please sign in again')
  }
  return res
}

// Always resolves for a well-formed request: the server answers {ok:true} whether or not the
// address has an account (no enumeration), so the UI must say the same thing either way.
export async function requestMagicLink(email) {
  const res = await fetch('/api/auth/magic-link', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (res.status === 429) throw new Error('Too many attempts — please wait a few minutes and try again.')
  if (!res.ok) throw new Error('Could not send the sign-in link. Please try again.')
}

// Exchanges the single-use emailed token for a session. Memoized per token: React StrictMode
// runs effects twice in dev, and a second verify would hit an already-consumed token.
const verifies = new Map()
export function verifyLoginToken(token) {
  if (!verifies.has(token)) {
    verifies.set(token, (async () => {
      const res = await fetch('/api/auth/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const r = await res.json().catch(() => ({}))
      if (!res.ok || !r.token) throw new Error('This sign-in link is invalid or has expired.')
      setToken(r.token); setUser(r.user)
      return r
    })())
  }
  return verifies.get(token)
}

// Fetches a presigned {url} from a sender endpoint, then navigates to it to download.
export async function downloadVia(path) {
  const r = await senderFetch(path).then(r => r.json())
  if (r.error || !r.url) throw new Error(r.error || 'download unavailable')
  window.location.assign(r.url)
}
