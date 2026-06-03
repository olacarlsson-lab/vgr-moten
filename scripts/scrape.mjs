// Scrapar möten för de nämnder som någon faktiskt bevakar (demand-styrt) och
// skriver docs/data.json + docs/feed.xml. Diffar mot förra körningen och skriver
// nya/ändrade poster till docs/_changes.json som push.mjs notifierar om.
//
// Två lägen (env SCRAPE_MODE, default 'full'):
//   light – billigt & ofta: hämtar board-listor för bevakade nämnder, och hämtar
//           mötessidor/djupskannar BARA möten som är nya eller flippat till
//           publicerat. Färska notiser för möten/publicering till låg kostnad.
//   full  – sällan & tungt: hämtar mötesnivå-dokument för alla publicerade möten
//           och per-ärende-djupskannar aktiva fönstret (för handlingBoards).
//
// Identitet: ett möte = (nämnd + datum). meetingId är tomt tills handlingarna
// publiceras; tomt → satt = "handlingar publicerade".
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import openGov from 'opengov-meetings'
import { fetchText, parseAgendaItems, parseDetailDocuments, mapLimit, fetchDemand } from './agenda.mjs'

const { getMeetings, getBoards } = openGov

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const docs = join(root, 'docs')

const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
const { host, path, siteName, years } = config
const fallbackBoards = config.fallbackBoards ?? []

const DOC_LOOKBACK_DAYS = config.docLookbackDays ?? 120
const AGENDA_PAST_DAYS = config.agendaPastDays ?? 21
const AGENDA_CONCURRENCY = config.agendaConcurrency ?? 6
const AGENDA_NOTIFY_CAP = config.agendaNotifyCap ?? 6

const MODE = (process.env.SCRAPE_MODE || 'full').toLowerCase()
const { SUBS_ENDPOINT, SUBS_TOKEN } = process.env

const meetingUrl = (m) =>
  m.meetingId
    ? `${host}${path}/Meetings/Details/${m.meetingId}`
    : `${host}${path}/Boards/Details/${m.boardId}`
const agendaDetailUrl = (id) => `${host}${path}/Meetings/LoadAgendaItemDetail/${id}`

// --- 1. Alla instanser (för UI-väljaren) ----------------------------------
let allBoards = []
try {
  allBoards = (await getBoards({ host, path })).map((b) => ({ id: String(b.id), name: b.name }))
} catch (err) {
  console.error(`Kunde inte hämta nämndlistan: ${err.message}`)
}
if (allBoards.length === 0) allBoards = fallbackBoards.map((b) => ({ id: String(b.id), name: b.name }))

// --- 2. Demand: vilka nämnder ska skannas? --------------------------------
let demand = null
if (SUBS_ENDPOINT && SUBS_TOKEN) {
  try {
    demand = await fetchDemand(SUBS_ENDPOINT, SUBS_TOKEN)
  } catch (err) {
    console.error(`Kunde inte hämta demand (${err.message}) – använder fallbackBoards.`)
  }
}
// demand=null (Workern onåbar) → fallback. demand med tomma listor = giltigt
// (ingen vill ha något) → skanna inget.
const meetingBoardIds = new Set(demand ? demand.meetingBoards : fallbackBoards.map((b) => String(b.id)))
const handlingBoardIds = new Set(demand ? demand.handlingBoards : fallbackBoards.map((b) => String(b.id)))
const scanBoards = allBoards.filter((b) => meetingBoardIds.has(b.id))

// --- 3. Hämta möten för de bevakade nämnderna -----------------------------
const rows = []
for (const board of scanBoards) {
  for (const year of years) {
    try {
      const data = await getMeetings({ host, path, boardId: board.id, year })
      for (const m of data?.meetings ?? []) {
        const date = (m.date || '').slice(0, 10)
        if (!date) continue
        rows.push({
          key: `${board.id}|${date}`,
          meetingId: String(m.id || ''),
          boardId: board.id,
          board: board.name,
          date,
          status: (m.status || '').trim(),
          published: Boolean(m.id)
        })
      }
    } catch (err) {
      console.error(`Kunde inte hämta ${board.name} ${year}: ${err.message}`)
    }
  }
}

// Avdubblettera per (nämnd+datum). Behåll varianten med meetingId.
const byKey = new Map()
for (const r of rows) {
  const existing = byKey.get(r.key)
  if (!existing || (!existing.meetingId && r.meetingId)) byKey.set(r.key, r)
}
const all = [...byKey.values()]
  .map((m) => ({ ...m, url: meetingUrl(m) }))
  .sort((a, b) => b.date.localeCompare(a.date))

// --- 4. Förra körningens data (för diff + återanvändning) -----------------
let previous = []
try {
  previous = JSON.parse(await readFile(join(docs, 'data.json'), 'utf8')).meetings ?? []
} catch {
  previous = []
}
const prevByKey = new Map(previous.map((m) => [m.key, m]))
const firstRun = previous.length === 0
const effectiveMode = firstRun ? 'full' : MODE // första körningen = full baseline

let prevIndex = {}
try {
  prevIndex = JSON.parse(await readFile(join(docs, 'agenda-index.json'), 'utf8')).meetings ?? {}
} catch {
  prevIndex = {}
}

// --- 5. Hämta dokument / djupskanna ---------------------------------------
const cutoff = new Date(Date.now() - DOC_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10)
const agendaCutoff = new Date(Date.now() - AGENDA_PAST_DAYS * 86400000).toISOString().slice(0, 10)
const agendaIndex = {}
let docFetches = 0
let itemFetches = 0
const sumDocs = (entry) => (entry?.items ?? []).reduce((a, it) => a + it.documents.length, 0)

async function deepScanMeeting(m, html) {
  const items = parseAgendaItems(html)
  const withDocs = await mapLimit(items, AGENDA_CONCURRENCY, async (it) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const dh = await fetchText(agendaDetailUrl(it.agendaId))
        itemFetches++
        return {
          agendaId: it.agendaId,
          title: it.title,
          documents: parseDetailDocuments(dh).map((d) => ({ title: d.title, url: host + d.url, category: d.category }))
        }
      } catch {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
      }
    }
    const prevItem = prevIndex[m.key]?.items?.find((p) => p.agendaId === it.agendaId)
    return { agendaId: it.agendaId, title: it.title, documents: prevItem?.documents ?? [] }
  })
  return { meetingId: m.meetingId, items: withDocs }
}

for (const m of all) {
  // Standard: behåll det vi redan visste.
  m.documents = prevByKey.get(m.key)?.documents ?? []
  if (prevIndex[m.key]) agendaIndex[m.key] = prevIndex[m.key]
  m.agendaDocCount = sumDocs(agendaIndex[m.key])

  if (!m.meetingId || m.date < cutoff) continue

  const before = prevByKey.get(m.key)
  const structurallyChanged = (!before && m.published) || (before && !before.published && m.published)
  // Hämta mötessidan: i full-läge för alla publicerade; i light bara för
  // strukturellt ändrade möten (nytt/flippat) – billigt.
  if (effectiveMode !== 'full' && !structurallyChanged) continue

  let html
  try {
    html = await fetchText(m.url)
    docFetches++
  } catch (err) {
    console.error(`Kunde inte hämta möte ${m.board} ${m.date}: ${err.message}`)
    continue
  }
  m.documents = parseDetailDocuments(html).map((d) => ({ title: d.title, url: host + d.url }))

  // Djupskanna agendapunkter: full-läge för handlingBoards i aktiva fönstret;
  // light-läge bara för flippade/nya möten i handlingBoards (bundet till ETT möte).
  const wantDeep =
    handlingBoardIds.has(m.boardId) &&
    m.date >= agendaCutoff &&
    (effectiveMode === 'full' || structurallyChanged)
  if (wantDeep) {
    agendaIndex[m.key] = await deepScanMeeting(m, html)
    m.agendaDocCount = sumDocs(agendaIndex[m.key])
  }
}

// --- 6. Diffa mötesnivå ----------------------------------------------------
const changes = []
for (const m of all) {
  const before = prevByKey.get(m.key)
  if (!before) {
    if (!firstRun) changes.push({ ...m, change: 'new' })
    continue
  }
  if (!before.published && m.published) {
    changes.push({ ...m, change: 'documents' })
    continue
  }
  const had = new Set((before.documents ?? []).map((d) => d.url))
  for (const d of m.documents ?? []) {
    if (!had.has(d.url)) changes.push({ ...m, change: 'document', document: d })
  }
}

// --- 7. Diffa agendapunkternas handlingar ---------------------------------
for (const m of all) {
  const cur = agendaIndex[m.key]
  const prev = prevIndex[m.key]
  if (!cur || !prev) continue // ej skannat, eller första djupskanningen (baseline → tyst)
  const hadUrls = new Set(prev.items.flatMap((it) => it.documents.map((d) => d.url)))
  const newDocs = []
  for (const it of cur.items) {
    for (const d of it.documents) {
      if (!hadUrls.has(d.url)) newDocs.push({ itemTitle: it.title, doc: d })
    }
  }
  if (newDocs.length === 0) continue
  if (newDocs.length > AGENDA_NOTIFY_CAP) {
    changes.push({ ...m, change: 'handlingar', count: newDocs.length })
  } else {
    for (const nd of newDocs) changes.push({ ...m, change: 'handling', itemTitle: nd.itemTitle, document: nd.doc })
  }
}

// --- 8. Skriv data.json (boards = alla 76 för väljaren; meetings = bevakade) -
const generatedAt = new Date().toISOString()
await writeFile(
  join(docs, 'data.json'),
  JSON.stringify({ generatedAt, siteName, boards: allBoards, meetings: all }, null, 2) + '\n'
)

// --- 9. feed.xml (RSS 2.0) -------------------------------------------------
const esc = (s) =>
  String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]))
const scanNames = scanBoards.map((b) => b.name).join(', ') || '(inga bevakade nämnder)'
const items = all
  .map((m) => {
    const label = m.published ? `handlingar publicerade, ${m.documents?.length ?? 0} dokument` : 'inplanerat'
    const title = `${m.board} – ${m.date} (${label})`
    return `    <item>
      <title>${esc(title)}</title>
      <link>${esc(m.url)}</link>
      <guid isPermaLink="false">${esc(m.key)}-${m.published ? 'pub' : 'plan'}-${m.documents?.length ?? 0}</guid>
      <pubDate>${new Date(m.date).toUTCString()}</pubDate>
      <description>${esc(title)}</description>
    </item>`
  })
  .join('\n')
const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${esc(siteName)} – bevakade nämnder</title>
    <link>${esc(host + path)}</link>
    <description>Möten för ${esc(scanNames)}</description>
    <lastBuildDate>${new Date(generatedAt).toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`
await writeFile(join(docs, 'feed.xml'), rss)

// --- 10. agenda-index.json (utan generatedAt) + _changes.json -------------
await writeFile(join(docs, 'agenda-index.json'), JSON.stringify({ meetings: agendaIndex }, null, 2) + '\n')
await writeFile(join(docs, '_changes.json'), JSON.stringify({ generatedAt, changes }, null, 2) + '\n')

console.log(
  `Klart [${effectiveMode}]: ${allBoards.length} instanser, ${scanBoards.length} bevakade, ` +
    `${all.length} möten, ${docFetches} mötessidor, ${itemFetches} agendapunkter, ` +
    `${changes.length} ändring(ar)${firstRun ? ' (första körningen, inga notiser)' : ''}.`
)
