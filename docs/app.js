// VGR Möten – frontend. Läser docs/data.json, renderar möten och hanterar
// registrering för Web Push (personlig modell: prenumerationen klistras in i
// repots secret PUSH_SUBSCRIPTIONS).

const $ = (sel) => document.querySelector(sel)
const banner = $('#banner')
const listEl = $('#list')

let allMeetings = []
let allBoards = []
let activeBoards = new Set() // tomt = visa alla
let timeFilter = 'upcoming'  // 'upcoming' | 'past' | 'all'

// ---- Notispreferenser (per enhet, sparas lokalt + i Workern) ----------------
const PREFS_KEY = 'vgr-prefs'
const DEFAULT_TYPES = { meeting: true, published: true, document: true, handling: true }

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY))
    if (p && typeof p === 'object') return { boards: p.boards ?? 'all', types: { ...DEFAULT_TYPES, ...p.types } }
  } catch { /* ignore */ }
  return { boards: 'all', types: { ...DEFAULT_TYPES } }
}

function buildPrefBoards(boards) {
  const el = $('#prefBoards')
  el.innerHTML = ''
  for (const b of boards) {
    const label = document.createElement('label')
    label.innerHTML = `<input type="checkbox" data-board="${b.id}" checked> ${escapeHtml(b.name)}`
    el.appendChild(label)
  }
}

function applyPrefsToUI(prefs) {
  const boardSet = prefs.boards === 'all' ? null : new Set(prefs.boards)
  document.querySelectorAll('#prefBoards input[data-board]').forEach((cb) => {
    cb.checked = !boardSet || boardSet.has(cb.dataset.board)
  })
  document.querySelectorAll('#settings input[data-type]').forEach((cb) => {
    cb.checked = prefs.types[cb.dataset.type] !== false
  })
}

function gatherPrefs() {
  const boardInputs = [...document.querySelectorAll('#prefBoards input[data-board]')]
  const checked = boardInputs.filter((cb) => cb.checked).map((cb) => cb.dataset.board)
  const boards = checked.length === boardInputs.length ? 'all' : checked
  const types = {}
  document.querySelectorAll('#settings input[data-type]').forEach((cb) => { types[cb.dataset.type] = cb.checked })
  return { boards, types }
}

function persistPrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* ignore */ }
}

function showBanner(text, kind = 'info') {
  banner.textContent = text
  banner.className = `banner ${kind}`
  banner.hidden = false
}

// ---- Datum/status -----------------------------------------------------------
const today = new Date().toISOString().slice(0, 10)
const isUpcoming = (m) => m.date >= today
const isPublished = (m) => Boolean(m.published) // handlingar/agenda finns

function formatDate(iso) {
  try {
    return new Date(iso + 'T00:00:00').toLocaleDateString('sv-SE', {
      weekday: 'short', year: 'numeric', month: 'long', day: 'numeric'
    })
  } catch { return iso }
}

// ---- Rendering --------------------------------------------------------------
function render() {
  const meetings = allMeetings
    .filter((m) => activeBoards.size === 0 || activeBoards.has(m.boardId))
    .filter((m) => timeFilter === 'all' || (timeFilter === 'upcoming' ? isUpcoming(m) : !isUpcoming(m)))
    .sort((a, b) => {
      const au = isUpcoming(a), bu = isUpcoming(b)
      if (au !== bu) return au ? -1 : 1                 // kommande före tidigare
      return au ? a.date.localeCompare(b.date)          // kommande: närmast först
                : b.date.localeCompare(a.date)          // tidigare: senast först
    })

  listEl.innerHTML = ''
  $('#empty').hidden = meetings.length > 0

  // Avdelare mellan kommande och tidigare – bara i "Alla"-läget.
  let pastDividerInserted = false
  for (const m of meetings) {
    if (timeFilter === 'all' && !isUpcoming(m) && !pastDividerInserted) {
      pastDividerInserted = true
      const sep = document.createElement('li')
      sep.className = 'divider'
      sep.innerHTML = '<span>Tidigare möten</span>'
      listEl.appendChild(sep)
    }

    const li = document.createElement('li')
    li.className = 'card'

    const tags = []
    if (isUpcoming(m)) tags.push('<span class="tag upcoming">Kommande</span>')
    if (isPublished(m)) tags.push('<span class="tag published">Handlingar publicerade</span>')
    else tags.push('<span class="tag">Inplanerat</span>')
    const docCount = m.documents?.length || 0
    if (docCount) tags.push(`<span class="tag">${docCount} dokument</span>`)
    const handlingar = m.agendaDocCount || 0
    if (handlingar) tags.push(`<span class="tag">${handlingar} handlingar</span>`)

    li.innerHTML = `
      <h2 class="title"><a href="${escapeHtml(m.url)}" rel="noopener">${escapeHtml(m.board)}</a></h2>
      <div class="row">
        <span>${escapeHtml(formatDate(m.date))}</span>
        ${tags.join(' ')}
      </div>`
    listEl.appendChild(li)
  }

  const label = timeFilter === 'past' ? 'tidigare' : timeFilter === 'upcoming' ? 'kommande' : 'totalt'
  $('#meta').textContent = `${meetings.length} möten (${label})`
}

// ---- Tidsfilter (Kommande / Tidigare / Alla) --------------------------------
function setupTimeFilter() {
  const buttons = [...document.querySelectorAll('#timeFilter button')]
  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      timeFilter = btn.dataset.time
      for (const b of buttons) b.setAttribute('aria-pressed', b === btn ? 'true' : 'false')
      render()
    })
  }
}

function escapeHtml(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))
}

// ---- Filterchips ------------------------------------------------------------
function buildFilters(boards) {
  const el = $('#filters')
  el.innerHTML = ''
  for (const b of boards) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'chip'
    btn.textContent = b.name
    btn.setAttribute('aria-pressed', 'false')
    btn.addEventListener('click', () => {
      if (activeBoards.has(b.id)) activeBoards.delete(b.id)
      else activeBoards.add(b.id)
      btn.setAttribute('aria-pressed', activeBoards.has(b.id) ? 'true' : 'false')
      render()
    })
    el.appendChild(btn)
  }
}

// ---- Data -------------------------------------------------------------------
async function loadData() {
  try {
    const res = await fetch('data.json', { cache: 'no-store' })
    if (!res.ok) throw new Error(res.status)
    const data = await res.json()
    allMeetings = data.meetings || []
    allBoards = data.boards || []
    buildFilters(allBoards)
    buildPrefBoards(allBoards)
    applyPrefsToUI(loadPrefs())
    render()
    if (allMeetings.length === 0) {
      showBanner('Ingen data ännu – kör scrape-workflowet i GitHub Actions.', 'info')
    }
  } catch (err) {
    $('#empty').hidden = false
    showBanner('Kunde inte ladda data.json.', 'error')
  }
}

// ---- Web Push ---------------------------------------------------------------
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

let swReg = null
async function registerSW() {
  if (!('serviceWorker' in navigator)) return
  try {
    swReg = await navigator.serviceWorker.register('sw.js')
  } catch (err) {
    console.error('SW-registrering misslyckades', err)
  }
}

async function enableNotifications() {
  const btn = $('#notify')
  const key = window.VGR_CONFIG?.vapidPublicKey
  if (!key || key.startsWith('REPLACE_')) {
    showBanner('VAPID-nyckel saknas i config.js – se README.', 'error')
    return
  }
  if (!('PushManager' in window) || !swReg) {
    showBanner('Den här webbläsaren stöder inte push. På iPhone: lägg först till på hemskärmen.', 'error')
    return
  }
  btn.disabled = true
  try {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      showBanner('Notiser nekades.', 'error')
      btn.disabled = false
      return
    }
    const existing = await swReg.pushManager.getSubscription()
    const sub = existing || await swReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key)
    })

    const prefs = gatherPrefs()
    persistPrefs(prefs)
    const endpoint = window.VGR_CONFIG?.subscribeEndpoint
    if (endpoint) {
      await postSubscription(sub, prefs)
      showBanner('Notiser aktiverade på den här enheten.', 'success')
    } else {
      // Ingen endpoint konfigurerad – visa JSON för manuell secret-modell.
      showSubscription(sub)
      showBanner('Notiser aktiverade. Klistra in prenumerationen enligt README.', 'success')
    }
  } catch (err) {
    showBanner('Kunde inte aktivera notiser: ' + err.message, 'error')
  } finally {
    btn.disabled = false
  }
}

// POST:ar prenumeration + prefs till Workern (samma endpoint uppdaterar prefs).
async function postSubscription(sub, prefs) {
  const endpoint = window.VGR_CONFIG?.subscribeEndpoint
  if (!endpoint) throw new Error('ingen endpoint konfigurerad')
  const res = await fetch(endpoint.replace(/\/$/, '') + '/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subscription: sub.toJSON(), prefs })
  })
  if (!res.ok) throw new Error('servern svarade ' + res.status)
}

// "Spara inställningar" – uppdaterar prefs för en redan aktiverad prenumeration.
async function savePrefs() {
  const prefs = gatherPrefs()
  persistPrefs(prefs)
  const hint = $('#prefsHint')
  const endpoint = window.VGR_CONFIG?.subscribeEndpoint
  const sub = swReg && (await swReg.pushManager.getSubscription())
  if (!sub || !endpoint) {
    hint.textContent = 'Sparat. Inställningarna gäller när du aktiverar notiser.'
    return
  }
  try {
    await postSubscription(sub, prefs)
    hint.textContent = 'Inställningar sparade.'
  } catch (err) {
    hint.textContent = 'Kunde inte spara mot servern: ' + err.message
  }
}

function showSubscription(sub) {
  const json = JSON.stringify(sub.toJSON())
  $('#subJson').value = json
  $('#copySub').onclick = async () => {
    try { await navigator.clipboard.writeText(json); $('#copySub').textContent = 'Kopierat!' }
    catch { $('#subJson').select() }
  }
  $('#subDialog').showModal()
}

// ---- Init -------------------------------------------------------------------
$('#notify').addEventListener('click', enableNotifications)
$('#savePrefs').addEventListener('click', savePrefs)
setupTimeFilter()
registerSW()
loadData()
