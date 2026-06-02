// Skickar Web Push-notiser för ändringarna i docs/_changes.json.
// Prenumerationer hämtas i första hand från Cloudflare Worker-endpointen
// (SUBS_ENDPOINT + SUBS_TOKEN); annars från secret PUSH_SUBSCRIPTIONS.
// VAPID-nycklar kommer från env (repo-secrets).
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import webpush from 'web-push'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const docs = join(root, 'docs')

const {
  VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT,
  PUSH_SUBSCRIPTIONS, SUBS_ENDPOINT, SUBS_TOKEN
} = process.env

if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  console.log('Hoppar över push: VAPID_PUBLIC/VAPID_PRIVATE saknas.')
  process.exit(0)
}

// --- Hämta prenumerationer -------------------------------------------------
async function loadSubscriptions() {
  if (SUBS_ENDPOINT && SUBS_TOKEN) {
    try {
      const res = await fetch(`${SUBS_ENDPOINT.replace(/\/$/, '')}/subscriptions`, {
        headers: { authorization: `Bearer ${SUBS_TOKEN}` }
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const list = await res.json()
      console.log(`Hämtade ${list.length} prenumeration(er) från endpointen.`)
      return list
    } catch (err) {
      console.error(`Kunde inte hämta från endpointen (${err.message}), faller tillbaka på secret.`)
    }
  }
  try {
    return JSON.parse(PUSH_SUBSCRIPTIONS || '[]')
  } catch {
    console.error('PUSH_SUBSCRIPTIONS är inte giltig JSON.')
    return []
  }
}

async function pruneSubscription(endpoint) {
  if (!SUBS_ENDPOINT || !SUBS_TOKEN) return
  try {
    await fetch(`${SUBS_ENDPOINT.replace(/\/$/, '')}/unsubscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SUBS_TOKEN}` },
      body: JSON.stringify({ endpoint })
    })
  } catch { /* best effort */ }
}

const subscriptions = await loadSubscriptions()
if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
  console.log('Inga prenumerationer – hoppar över push.')
  process.exit(0)
}

let changes = []
try {
  changes = JSON.parse(await readFile(join(docs, '_changes.json'), 'utf8')).changes ?? []
} catch {
  changes = []
}
if (changes.length === 0) {
  console.log('Inga ändringar att notifiera om.')
  process.exit(0)
}

webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:noreply@example.com', VAPID_PUBLIC, VAPID_PRIVATE)

function notice(c) {
  if (c.change === 'new') return { title: `Nytt möte: ${c.board}`, body: `Inplanerat ${c.date}` }
  if (c.change === 'documents') return { title: `Handlingar publicerade: ${c.board}`, body: `Möte ${c.date}` }
  if (c.change === 'document') return { title: `Nytt dokument: ${c.board}`, body: `${c.date} · ${c.document?.title || 'dokument'}` }
  if (c.change === 'handlingar') return { title: `${c.count} nya handlingar: ${c.board}`, body: `Möte ${c.date}` }
  // 'handling' – ny handling i en agendapunkt
  return { title: `Ny handling: ${c.board}`, body: `${c.itemTitle || ''} · ${c.document?.title || 'dokument'}`.trim() }
}

let sent = 0
const dead = []
for (const c of changes) {
  const n = notice(c)
  const url = c.document?.url || c.url
  const payload = JSON.stringify({ title: n.title, body: n.body, url, tag: `${c.key}-${c.change}-${c.document?.url || ''}` })
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub, payload)
      sent++
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        if (!dead.includes(sub)) dead.push(sub)
      } else {
        console.error(`Push misslyckades: ${err.statusCode || err.message}`)
      }
    }
  }
}

for (const sub of dead) await pruneSubscription(sub.endpoint)

console.log(`Skickade ${sent} notis(er) för ${changes.length} ändring(ar).` +
  (dead.length ? ` Rensade ${dead.length} död(a) prenumeration(er).` : ''))
