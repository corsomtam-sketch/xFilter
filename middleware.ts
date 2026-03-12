import { NextRequest, NextResponse } from 'next/server'

/**
 * Security middleware:
 *
 * 1. Optional HTTP Basic Auth — set SIFTLY_USERNAME + SIFTLY_PASSWORD in .env.
 *    Defaults to open for local-only use.
 *
 * 2. CSRF / origin validation — mutating requests (POST/PUT/DELETE/PATCH) must
 *    originate from the same host. Requests with no Origin header (e.g. direct
 *    curl, server-to-server) are allowed through so CLI tools keep working.
 *
 * 3. Bookmarklet endpoint — excluded from Basic Auth (can't send credentials
 *    cross-origin), but restricted to requests from x.com / twitter.com only.
 */

const BOOKMARKLET_PATH = '/api/import/bookmarklet'
const ALLOWED_BOOKMARKLET_ORIGINS = new Set(['https://x.com', 'https://twitter.com', 'https://www.twitter.com'])
const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH'])

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl
  const origin = request.headers.get('Origin') ?? null
  const host = request.headers.get('Host') ?? null

  // ── Bookmarklet: cross-origin POST from x.com only ────────────────────────
  if (pathname === BOOKMARKLET_PATH) {
    if (origin && !ALLOWED_BOOKMARKLET_ORIGINS.has(origin)) {
      return new NextResponse('Forbidden', { status: 403 })
    }
    return NextResponse.next()
  }

  // ── CSRF: reject cross-origin mutating requests ───────────────────────────
  if (MUTATING_METHODS.has(request.method) && origin !== null && host !== null) {
    try {
      const originHost = new URL(origin).host
      if (originHost !== host) {
        return new NextResponse('Forbidden', { status: 403 })
      }
    } catch {
      return new NextResponse('Forbidden', { status: 403 })
    }
  }

  // ── Optional Basic Auth ───────────────────────────────────────────────────
  const username = process.env.SIFTLY_USERNAME?.trim()
  const password = process.env.SIFTLY_PASSWORD?.trim()

  if (!username || !password) return NextResponse.next()

  const authHeader = request.headers.get('Authorization')

  if (authHeader?.startsWith('Basic ')) {
    try {
      const decoded = atob(authHeader.slice(6))
      const colonIdx = decoded.indexOf(':')
      if (colonIdx !== -1) {
        const user = decoded.slice(0, colonIdx)
        const pass = decoded.slice(colonIdx + 1)
        if (user === username && pass === password) {
          return NextResponse.next()
        }
      }
    } catch {
      // malformed base64 → fall through to 401
    }
  }

  return new NextResponse('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Siftly"' },
  })
}

export const config = {
  matcher: [
    // Match everything except Next.js internals (_next/static, _next/image,
    // _next/webpack-hmr dev HMR websocket, etc.) and static root files.
    '/((?!_next/|favicon.ico|icon.svg).*)',
  ],
}
