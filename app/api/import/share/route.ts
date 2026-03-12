import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { resolveAnthropicClient } from '@/lib/claude-cli-auth'

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function isPrivateUrl(raw: string): boolean {
  try {
    const { protocol, hostname } = new URL(raw)
    if (protocol !== 'http:' && protocol !== 'https:') return true
    if (hostname === 'localhost' || hostname === '0.0.0.0') return true
    if (/^127\./.test(hostname)) return true
    if (/^10\./.test(hostname)) return true
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) return true
    if (/^192\.168\./.test(hostname)) return true
    if (/^169\.254\./.test(hostname)) return true
    if (hostname === '::1' || /^\[::1\]$/.test(hostname)) return true
    if (/^fd[0-9a-f]{2,}:/i.test(hostname)) return true
    return false
  } catch {
    return true
  }
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
}

function extractMeta(html: string, ...patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match?.[1]) return decodeHtmlEntities(match[1].trim())
  }
  return ''
}

async function fetchPageMeta(url: string): Promise<{
  title: string
  description: string
  image: string
  domain: string
}> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok || isPrivateUrl(res.url)) return { title: '', description: '', image: '', domain: '' }

    const reader = res.body?.getReader()
    if (!reader) return { title: '', description: '', image: '', domain: '' }

    let html = ''
    let bytes = 0
    while (bytes < 50_000) {
      const { done, value } = await reader.read()
      if (done) break
      html += new TextDecoder().decode(value)
      bytes += value.length
      if (html.includes('</head>')) break
    }
    reader.cancel().catch(() => {})

    const domain = (() => {
      try { return new URL(res.url).hostname.replace(/^www\./, '') } catch { return '' }
    })()

    const title = extractMeta(html,
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
      /<title[^>]*>([^<]+)<\/title>/i,
    )
    const description = extractMeta(html,
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i,
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    )
    const image = extractMeta(html,
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    )

    return { title, description, image, domain }
  } catch {
    return { title: '', description: '', image: '', domain: '' }
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Optional bearer token auth — set XFILTER_SHARE_TOKEN in .env to require it.
  // iOS Shortcut should send: Authorization: Bearer <your-token>
  const shareToken = process.env.XFILTER_SHARE_TOKEN?.trim()
  if (shareToken) {
    const authHeader = request.headers.get('Authorization')
    const queryToken = request.nextUrl.searchParams.get('token')
    const provided = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : queryToken?.trim()
    if (provided !== shareToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  let body: { url?: string; title?: string; note?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const rawUrl = body.url?.trim()
  if (!rawUrl) return NextResponse.json({ error: 'url is required' }, { status: 400 })

  try { new URL(rawUrl) } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
  }
  if (isPrivateUrl(rawUrl)) {
    return NextResponse.json({ error: 'URL not allowed' }, { status: 400 })
  }

  // Stable unique ID derived from the URL — same link won't be imported twice
  const shareId = `share_${Buffer.from(rawUrl).toString('base64url').slice(0, 40)}`

  const existing = await prisma.bookmark.findUnique({
    where: { tweetId: shareId },
    select: { id: true, text: true },
  })
  if (existing) {
    return NextResponse.json({ status: 'exists', id: existing.id, text: existing.text })
  }

  // Fetch OG metadata from the page
  const meta = await fetchPageMeta(rawUrl)
  const parsedHost = (() => { try { return new URL(rawUrl).hostname.replace(/^www\./, '') } catch { return '' } })()
  const title = body.title?.trim() || meta.title || parsedHost
  const domain = meta.domain || parsedHost

  // AI summary using Claude
  let summary = meta.description
  const context = [title, meta.description, body.note].filter(Boolean).join('\n')
  if (context.trim()) {
    try {
      const dbKey = await prisma.setting.findUnique({ where: { key: 'anthropicApiKey' } })
      const ai = resolveAnthropicClient({ dbKey: dbKey?.value })
      const msg = await ai.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: `Summarize this link in 1–2 sentences. Plain text only, no markdown, no bullet points.\n\nURL: ${rawUrl}\nTitle: ${title}${meta.description ? `\nDescription: ${meta.description}` : ''}${body.note ? `\nUser note: ${body.note}` : ''}`,
        }],
      })
      const block = msg.content[0]
      if (block.type === 'text') summary = block.text.trim()
    } catch {
      // Non-fatal — fall back to OG description
    }
  }

  const bookmarkText = [summary, rawUrl].filter(Boolean).join('\n\n')

  const created = await prisma.bookmark.create({
    data: {
      tweetId: shareId,
      text: bookmarkText,
      authorHandle: domain,
      authorName: title,
      source: 'share',
      rawJson: JSON.stringify({
        url: rawUrl,
        title,
        description: meta.description,
        domain,
        note: body.note ?? null,
        sharedAt: new Date().toISOString(),
      }),
    },
  })

  if (meta.image) {
    await prisma.mediaItem.create({
      data: {
        bookmarkId: created.id,
        type: 'photo',
        url: meta.image,
        thumbnailUrl: meta.image,
      },
    }).catch(() => { /* non-fatal */ })
  }

  return NextResponse.json(
    { status: 'saved', id: created.id, title, summary, url: rawUrl },
    { status: 201 },
  )
}
