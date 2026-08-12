// Manuellt test-/återutskick: skickar EN notis till utvalda prenumeranter.
// Körs av workflowen .github/workflows/test-push.yml (där VAPID-secrets finns).
//
// Mottagare väljs med ONLY = kommaseparerade endpoint-substrängar (t.ex. de
// sista tecknen i en endpoint, eller "web.push.apple.com"). ONLY är OBLIGATORISKT
// – utan det avbryter skriptet, så man inte råkar spamma alla prenumeranter.
import webpush from 'web-push'

const {
  VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT,
  SUBS_ENDPOINT, SUBS_TOKEN,
  ONLY, TEST_TITLE, TEST_BODY, TEST_URL
} = process.env

if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  console.error('VAPID_PUBLIC/VAPID_PRIVATE saknas.'); process.exit(1)
}
if (!SUBS_ENDPOINT || !SUBS_TOKEN) {
  console.error('SUBS_ENDPOINT/SUBS_TOKEN saknas – kan inte hämta prenumeranter.'); process.exit(1)
}

const filters = (ONLY || '').split(',').map((s) => s.trim()).filter(Boolean)
if (filters.length === 0) {
  console.error('ONLY är tomt. Sätt ett endpoint-filter (kommaseparerat) för att välja mottagare. Avbryter.')
  process.exit(1)
}

const res = await fetch(`${SUBS_ENDPOINT.replace(/\/$/, '')}/subscriptions`, {
  headers: { authorization: `Bearer ${SUBS_TOKEN}` }
})
if (!res.ok) { console.error(`Kunde inte hämta prenumeranter: HTTP ${res.status}`); process.exit(1) }

const raw = await res.json()
const records = (Array.isArray(raw) ? raw : [])
  .map((r) => (r && r.subscription ? r : { subscription: r }))
  .filter((r) => r.subscription && typeof r.subscription.endpoint === 'string')

const targets = records.filter((r) => filters.some((f) => r.subscription.endpoint.includes(f)))
console.log(`Matchade ${targets.length} av ${records.length} prenumeranter mot ONLY=[${filters.join(', ')}].`)
if (targets.length === 0) { console.log('Inga mottagare – inget skickat.'); process.exit(0) }

webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:noreply@example.com', VAPID_PUBLIC, VAPID_PRIVATE)

const payload = JSON.stringify({
  title: TEST_TITLE || 'VGR Möten – testnotis',
  body: TEST_BODY || 'Om du ser den här funkar notiserna på den här enheten.',
  url: TEST_URL || 'https://olacarlsson-lab.github.io/vgr-moten/',
  tag: `vgr-test-${Date.now()}`
})

let ok = 0, fail = 0
for (const r of targets) {
  const ep = r.subscription.endpoint
  const tail = `...${ep.slice(-14)}`
  try {
    await webpush.sendNotification(r.subscription, payload)
    ok++
    console.log(`OK   ${tail}`)
  } catch (err) {
    fail++
    const detail = err.body ? String(err.body).replace(/\s+/g, ' ').slice(0, 100) : (err.message || '')
    console.log(`FEL  ${tail}  status=${err.statusCode || '?'}  ${detail}`)
  }
}
console.log(`Klart: ${ok} OK, ${fail} fel av ${targets.length} mottagare.`)
