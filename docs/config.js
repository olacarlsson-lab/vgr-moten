// Webbappens konfiguration.
// 1) vapidPublicKey: din VAPID *public* key (npx web-push generate-vapid-keys).
// 2) subscribeEndpoint: URL till Cloudflare Worker (utan avslutande slash),
//    t.ex. "https://vgr-moten-subs.<ditt-konto>.workers.dev". Lämna tom för att
//    falla tillbaka på manuell secret-modell (visar prenumerations-JSON istället).
window.VGR_CONFIG = {
  vapidPublicKey: 'REPLACE_WITH_YOUR_VAPID_PUBLIC_KEY',
  subscribeEndpoint: ''
}
