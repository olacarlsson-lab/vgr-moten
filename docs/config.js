// Webbappens konfiguration.
// 1) vapidPublicKey: din VAPID *public* key (npx web-push generate-vapid-keys).
// 2) subscribeEndpoint: URL till Cloudflare Worker (utan avslutande slash),
//    t.ex. "https://vgr-moten-subs.<ditt-konto>.workers.dev". Lämna tom för att
//    falla tillbaka på manuell secret-modell (visar prenumerations-JSON istället).
window.VGR_CONFIG = {
  vapidPublicKey: 'BIyYoH6wp0kmqUc0A3jBrBt2ubf4XDEoeM6WbZGnRndx38-nrvotLXDpz2eb8GIG1j9N-F0C3SFNfc192FMndS4',
  subscribeEndpoint: 'https://vgr-moten-subs.pfzcgp8w76.workers.dev'
}
