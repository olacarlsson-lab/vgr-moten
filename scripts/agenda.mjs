// Hjälpfunktioner för att djupskanna agendapunkter på en mötessida.
// Paketets getAgenda parsar inte VGR:s nuvarande agenda-HTML, så vi parsar
// agendapunkternas id + titel själva och hämtar dokumenten per punkt via
// paketets getDetails (LoadAgendaItemDetail).

export async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'vgr-moten-bot' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

export const decode = (s) =>
  String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&aring;/g, 'å').replace(/&auml;/g, 'ä').replace(/&ouml;/g, 'ö')
    .replace(/&Aring;/g, 'Å').replace(/&Auml;/g, 'Ä').replace(/&Ouml;/g, 'Ö')
    .trim()

// Parsar dokumentlistan ur en filesList (på en mötessida eller en
// agendapunkt-detalj). Paketets egna parsers (getAgenda/getDetails) kastar fel
// på VGR:s nuvarande HTML, så vi gör det robust själva.
// Returnerar [{ title, url, category }] med relativa url:er (host läggs på av anroparen).
export function parseDetailDocuments(html) {
  const start = html.search(/class="filesList"/)
  if (start === -1) return []
  // Begränsa till första filesList-blockets <ul>…</ul> så vi inte råkar fånga
  // agenda-accordionens <li> längre ned på en mötessida.
  const ulStart = html.indexOf('<ul', start)
  const ulEnd = html.indexOf('</ul>', ulStart === -1 ? start : ulStart)
  const region = html.slice(start, ulEnd === -1 ? undefined : ulEnd)

  const docs = []
  const seen = new Set()
  for (const part of region.split(/<li\b/i).slice(1)) {
    const href = part.match(/href="([^"]*File\/Details\/[^"]+)"/i)
    if (!href) continue
    const url = decode(href[1])
    if (seen.has(url)) continue
    seen.add(url)
    const titleAttr = part.match(/^[^>]*\btitle="([^"]*)"/) // titel på <li>
    const cat = part.match(/fileDocumentCategory[^>]*>\s*([^<]*?)\s*</i)
    docs.push({ url, title: decode(titleAttr ? titleAttr[1] : ''), category: cat ? decode(cat[1]) : '' })
  }
  return docs
}

// Parsar agendapunkter ur mötessidans HTML. Returnerar [{ agendaId, title }].
// Id:n och titlar förekommer i samma dokumentordning, så vi zippar ihop dem.
export function parseAgendaItems(html) {
  const rawIds = [...html.matchAll(/LoadAgendaItemDetail\/(\d+)/g)].map((m) => m[1])
  const ids = rawIds.filter((id, i) => id !== rawIds[i - 1]) // ta bort konsekutiva dubbletter (onclick+onkeydown)
  const titles = [...html.matchAll(/accordionTitleText">([^<]*)<\/h5>/g)].map((m) => decode(m[1]))
  return ids.map((id, i) => ({ agendaId: id, title: titles[i] || '' }))
}

// Enkel concurrency-begränsare: kör fn över items med högst `limit` samtidigt.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const idx = next++
      results[idx] = await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
