// Service worker för VGR Möten – tar emot push och öppnar mötet vid klick.

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = {} }
  const title = data.title || 'VGR Möten'
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,
    // Fallback till appens scope (inte '/'), som på GitHub Pages pekar fel.
    data: { url: data.url || self.registration.scope },
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png'
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url || self.registration.scope
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      // Fokusera ett redan öppet fönster med samma URL (ignorera ev. #fragment).
      const target = url.split('#')[0]
      for (const w of wins) {
        if (w.url.split('#')[0] === target && 'focus' in w) return w.focus()
      }
      return clients.openWindow(url)
    })
  )
})
