// Cloudflare Worker – lagrar Web Push-prenumerationer i KV.
// Skickar INTE push själv (det gör GitHub Action med web-push); workern är
// lagring + ett litet API.
//
// Routes:
//   POST /subscribe     { subscription }      → lagra (öppet, CORS)
//   POST /unsubscribe   { endpoint }          → ta bort (öppet, CORS)
//   GET  /subscriptions Authorization: Bearer → lista (kräver SUBS_TOKEN)
//
// Bindningar: KV-namespace `SUBS`. Secret `SUBS_TOKEN`. Var `ALLOWED_ORIGINS`.

const KEY_PREFIX = 'sub:'

async function hash(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || ''
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim())
  const allow = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0] || '')
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  }
}

const json = (data, status, headers) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } })

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env)
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })

    try {
      // ---- Registrera/uppdatera prenumeration (+ ev. preferenser) ----
      if (request.method === 'POST' && url.pathname === '/subscribe') {
        const body = await request.json()
        const sub = body.subscription || body
        if (!sub || typeof sub.endpoint !== 'string') return json({ error: 'invalid subscription' }, 400, cors)
        const record = { subscription: sub }
        if (body.prefs && typeof body.prefs === 'object') record.prefs = body.prefs
        await env.SUBS.put(KEY_PREFIX + (await hash(sub.endpoint)), JSON.stringify(record))
        return json({ ok: true }, 201, cors)
      }

      // ---- Avregistrera ----
      if (request.method === 'POST' && url.pathname === '/unsubscribe') {
        const { endpoint } = await request.json()
        if (typeof endpoint !== 'string') return json({ error: 'missing endpoint' }, 400, cors)
        await env.SUBS.delete(KEY_PREFIX + (await hash(endpoint)))
        return json({ ok: true }, 200, cors)
      }

      // ---- Lista (skyddad) ----
      if (request.method === 'GET' && url.pathname === '/subscriptions') {
        const auth = request.headers.get('Authorization') || ''
        if (!env.SUBS_TOKEN || auth !== `Bearer ${env.SUBS_TOKEN}`) {
          return json({ error: 'unauthorized' }, 401, cors)
        }
        const out = []
        let cursor
        do {
          const list = await env.SUBS.list({ prefix: KEY_PREFIX, cursor })
          for (const k of list.keys) {
            const v = await env.SUBS.get(k.name)
            if (!v) continue
            const parsed = JSON.parse(v)
            // Normalisera: äldre poster lagrades som råa subscription-objekt.
            out.push(parsed.subscription ? parsed : { subscription: parsed })
          }
          cursor = list.list_complete ? undefined : list.cursor
        } while (cursor)
        return json(out, 200, cors)
      }

      return json({ error: 'not found' }, 404, cors)
    } catch (err) {
      return json({ error: String(err.message || err) }, 500, cors)
    }
  }
}
