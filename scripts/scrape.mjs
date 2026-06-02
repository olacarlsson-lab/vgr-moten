// Scrapar möten för de bevakade nämnderna och skriver docs/data.json + docs/feed.xml.
// Diffar mot förra körningens data.json och skriver nya/ändrade möten till docs/_changes.json
// som push.mjs sedan notifierar om.
//
// Identitet: ett möte = (nämnd + datum). meetingId är tomt tills handlingarna
// publiceras (då dyker länken/agendan upp). Att meetingId går från tomt → satt
// är signalen "handlingar publicerade". För publicerade möten hämtas dessutom
// dokumentlistan så att enskilda nya dokument kan upptäckas.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import openGov from 'opengov-meetings'
import { fetchText, parseAgendaItems, parseDetailDocuments, mapLimit } from './agenda.mjs'

const { getMeetings } = openGov

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const docs = join(root, 'docs')

const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
const { host, path, siteName, years, boards } = config

// Hämta agendadokument bara för möten inom det här fönstret (dagar bakåt) +
// alla framtida — gamla möten ändras sällan och vi sparar requests.
const DOC_LOOKBACK_DAYS = config.docLookbackDays ?? 120

// Djupskanning av agendapunkter (handlingar per ärende) görs bara för
// publicerade möten i ett kortare aktivt fönster (dyrare: ett anrop per punkt).
const AGENDA_PAST_DAYS = config.agendaPastDays ?? 21
const AGENDA_CONCURRENCY = config.agendaConcurrency ?? 6
const AGENDA_NOTIFY_CAP = config.agendaNotifyCap ?? 6

const meetingUrl = (m) =>
  m.meetingId
    ? `${host}${path}/Meetings/Details/${m.meetingId}`
    : `${host}${path}/Boards/Details/${m.boardId}`

// --- Hämta alla möten för varje nämnd och år ------------------------------
const rows = []
for (const board of boards) {
  for (const year of years) {
    try {
      const data = await getMeetings({ host, path, boardId: board.id, year })
      for (const m of data?.meetings ?? []) {
        // Paketet har en känd bugg i `day`/`yearMonthDay`; vi litar bara på `date`.
        const date = (m.date || '').slice(0, 10)
        if (!date) continue
        rows.push({
          key: `${board.id}|${date}`,
          meetingId: String(m.id || ''),
          boardId: board.id,
          board: board.name,
          date,
          status: (m.status || '').trim(),
          published: Boolean(m.id) // handlingar/agenda-länk finns
        })
      }
    } catch (err) {
      console.error(`Kunde inte hämta ${board.name} ${year}: ${err.message}`)
    }
  }
}

// Avdubblettera per (nämnd+datum). Behåll den variant som har ett meetingId.
const byKey = new Map()
for (const r of rows) {
  const existing = byKey.get(r.key)
  if (!existing || (!existing.meetingId && r.meetingId)) byKey.set(r.key, r)
}
const all = [...byKey.values()]
  .map((m) => ({ ...m, url: meetingUrl(m) }))
  .sort((a, b) => b.date.localeCompare(a.date))

// --- Läs förra data.json (för diff + för att återanvända dokumentlistor) ---
let previous = []
try {
  previous = JSON.parse(await readFile(join(docs, 'data.json'), 'utf8')).meetings ?? []
} catch {
  previous = [] // första körningen
}
const prevByKey = new Map(previous.map((m) => [m.key, m]))
const firstRun = previous.length === 0

// --- Hämta dokument för publicerade möten ---------------------------------
// En enda sidhämtning per möte ger både mötesnivå-dokumenten (Kallelse/protokoll)
// och listan över agendapunkter. För möten i det aktiva fönstret djupskannar vi
// dessutom varje agendapunkts handlingar (LoadAgendaItemDetail).
// Tung per-ärende-data lagras i separat agenda-index.json (inte i data.json,
// så webbappens nedladdning förblir liten).
const cutoff = new Date(Date.now() - DOC_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10)
const agendaCutoff = new Date(Date.now() - AGENDA_PAST_DAYS * 86400000).toISOString().slice(0, 10)
const agendaDetailUrl = (id) => `${host}${path}/Meetings/LoadAgendaItemDetail/${id}`

let prevIndex = {}
try {
  prevIndex = JSON.parse(await readFile(join(docs, 'agenda-index.json'), 'utf8')).meetings ?? {}
} catch {
  prevIndex = {}
}
const agendaIndex = {}
let docFetches = 0
let itemFetches = 0
const sumDocs = (entry) => (entry?.items ?? []).reduce((a, it) => a + it.documents.length, 0)

for (const m of all) {
  // Standard: behåll det vi redan visste (för möten utanför fönstren).
  m.documents = prevByKey.get(m.key)?.documents ?? []
  if (prevIndex[m.key]) agendaIndex[m.key] = prevIndex[m.key]
  m.agendaDocCount = sumDocs(agendaIndex[m.key])

  if (!m.meetingId || m.date < cutoff) continue

  let html
  try {
    html = await fetchText(m.url)
    docFetches++
  } catch (err) {
    console.error(`Kunde inte hämta möte ${m.board} ${m.date}: ${err.message}`)
    continue
  }
  // Mötesnivå-dokument.
  m.documents = parseDetailDocuments(html).map((d) => ({ title: d.title, url: host + d.url }))

  // Djupskanna agendapunkter endast i det aktiva fönstret.
  if (m.date < agendaCutoff) continue
  const items = parseAgendaItems(html)
  const withDocs = await mapLimit(items, AGENDA_CONCURRENCY, async (it) => {
    // Ett försök + en retry; vid bestående fel behåll tidigare kända dokument
    // (radera inte baseline → undvik falsk notis-skur nästa körning).
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
  agendaIndex[m.key] = { meetingId: m.meetingId, items: withDocs }
  m.agendaDocCount = sumDocs(agendaIndex[m.key])
}

// --- Diffa mot förra data.json --------------------------------------------
const changes = []
for (const m of all) {
  const before = prevByKey.get(m.key)
  if (!before) {
    if (!firstRun) changes.push({ ...m, change: 'new' }) // nytt inplanerat möte
    continue
  }
  if (!before.published && m.published) {
    // Handlingar publicerade. Baseline för dokument sätts nu; inga per-dokumentnotiser.
    changes.push({ ...m, change: 'documents' })
    continue
  }
  // Redan publicerat tidigare → upptäck enskilda nya dokument (mötesnivå).
  const had = new Set((before.documents ?? []).map((d) => d.url))
  for (const d of m.documents ?? []) {
    if (!had.has(d.url)) {
      changes.push({ ...m, change: 'document', document: d })
    }
  }
}

// --- Diffa agendapunkternas handlingar ------------------------------------
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
    changes.push({ ...m, change: 'handlingar', count: newDocs.length }) // summerande notis
  } else {
    for (const nd of newDocs) changes.push({ ...m, change: 'handling', itemTitle: nd.itemTitle, document: nd.doc })
  }
}

// --- Skriv data.json -------------------------------------------------------
const generatedAt = new Date().toISOString()
await writeFile(
  join(docs, 'data.json'),
  JSON.stringify({ generatedAt, siteName, boards, meetings: all }, null, 2) + '\n'
)

// --- Skriv feed.xml (RSS 2.0) ---------------------------------------------
const esc = (s) =>
  String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]))

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
    <description>Möten för ${esc(boards.map((b) => b.name).join(', '))}</description>
    <lastBuildDate>${new Date(generatedAt).toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`
await writeFile(join(docs, 'feed.xml'), rss)

// --- Skriv agenda-index.json (per-ärende-handlingar, bara för diff) --------
// Medvetet UTAN generatedAt: filen ändras då bara när innehållet faktiskt
// ändras, så den committas inte i onödan var 3:e timme.
await writeFile(
  join(docs, 'agenda-index.json'),
  JSON.stringify({ meetings: agendaIndex }, null, 2) + '\n'
)

// --- Skriv _changes.json för push-steget ----------------------------------
await writeFile(join(docs, '_changes.json'), JSON.stringify({ generatedAt, changes }, null, 2) + '\n')

console.log(
  `Klart: ${all.length} möten, ${docFetches} agendor, ${itemFetches} agendapunkter, ` +
    `${changes.length} ändring(ar)${firstRun ? ' (första körningen, inga notiser)' : ''}.`
)
