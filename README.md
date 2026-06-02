# VGR Möten

Bevakar politiska möten i Västra Götalandsregionen
([opengov.360online.com/Meetings/vgregion](https://opengov.360online.com/Meetings/vgregion))
och skickar **push-notiser** när nya möten planeras in, när handlingar publiceras,
och när **enskilda nya dokument** dyker upp. Webapp på **GitHub Pages**, scraping +
push via **GitHub Actions**, och prenumerationer lagras i en **Cloudflare Worker**.

Bevakade nämnder (ändra i [`config.json`](config.json)):
Regionfullmäktige · Regionstyrelsen · Ägarutskottet · Styrelsen för fastighet, stöd och service.

## Hur det funkar

Sajten saknar API och RSS — allt bygger på screen-scraping via paketet
[`opengov-meetings`](https://github.com/zrrrzzt/opengov-meetings).

```
GitHub Actions (cron var 3:e timme)
  scripts/scrape.mjs  → docs/data.json + docs/feed.xml
                        · för publicerade möten hämtas även dokumentlistan
                        · diffar mot förra körningen
  scripts/push.mjs    → hämtar prenumeranter från Cloudflare Worker
                        → skickar Web Push för nya/ändrade möten + nya dokument
  → committar uppdaterad data tillbaka till repot

Cloudflare Worker (worker/)         GitHub Pages (servar /docs)
  KV-lagring av prenumerationer       index.html / app.js  → VGR-vy + "Aktivera notiser"
  POST /subscribe                     sw.js                → visar notiser
  POST /unsubscribe                   feed.xml             → bonus RSS-flöde
  GET  /subscriptions (token)
```

**Notistyper**
- **Nytt möte** – ett nytt mötesdatum dyker upp för en bevakad nämnd.
- **Handlingar publicerade** – ett inplanerat möte får sin agenda/länk.
- **Nytt dokument** – ett nytt dokument läggs till på ett redan publicerat möte
  (notisen länkar direkt till PDF:en).

Ett möte identifieras av **nämnd + datum**. Mötets `meetingId` (länken till
handlingarna) är tomt tills handlingarna publiceras.

## Köra lokalt

```sh
npm install
npm run scrape     # skriver docs/data.json + docs/feed.xml (hämtar även agendor)
npm run serve      # öppna http://localhost:3000 (eller porten serve visar)
```

## Setup

### 1. VAPID-nycklar
```sh
npx web-push generate-vapid-keys
```

### 2. Cloudflare Worker (prenumerationslagring – gratis)
```sh
cd worker
npm install
npx wrangler login
npx wrangler kv namespace create SUBS      # kopiera id:t som skrivs ut
```
- Klistra in KV-id:t i [`worker/wrangler.toml`](worker/wrangler.toml) (`id = "…"`).
- Sätt `ALLOWED_ORIGINS` i samma fil till din Pages-URL, t.ex.
  `"https://<användarnamn>.github.io"`.
- Sätt en delad token (samma som secret `SUBS_TOKEN` nedan):
  ```sh
  npx wrangler secret put SUBS_TOKEN
  ```
- Deploya:
  ```sh
  npx wrangler deploy
  ```
  Du får en URL: `https://vgr-moten-subs.<konto>.workers.dev`.

### 3. Webappen
I [`docs/config.js`](docs/config.js):
- `vapidPublicKey` = din VAPID **public** key.
- `subscribeEndpoint` = Worker-URL:en från steg 2.

### 4. GitHub Pages
Pusha repot. *Settings → Pages → Deploy from a branch →* branch `main`, mapp **`/docs`**.

### 5. Repo-secrets
*Settings → Secrets and variables → Actions:*
| Secret | Värde |
|---|---|
| `VAPID_PUBLIC` | publika nyckeln |
| `VAPID_PRIVATE` | privata nyckeln |
| `VAPID_SUBJECT` | `mailto:din@mail.se` |
| `SUBS_ENDPOINT` | Worker-URL:en (steg 2) |
| `SUBS_TOKEN` | samma token som i Workern |

`PUSH_SUBSCRIPTIONS` behövs **inte** när Workern används (den är bara en
fallback om du kör utan endpoint).

### 6. Kör igång
- *Actions → "Scrape & notify" → Run workflow* (fyller `data.json`/`feed.xml`).
- Öppna sidan, klicka **Aktivera notiser**, godkänn → prenumerationen registreras
  automatiskt i Workern. Klart.

### Notisinställningar (per enhet)
Under **Notisinställningar** på sidan väljer varje enhet vilka **nämnder** och
vilka **notistyper** (Nya möten · Handlingar publicerade · Nya dokument ·
Nya handlingar i ärenden) som ska ge notiser. Inställningarna sparas lokalt och
skickas med till Workern (samma `/subscribe` uppdaterar dem). `push.mjs` filtrerar
per prenumerant innan sändning. Prenumeranter utan inställningar får allt.

### iPhone/iPad
iOS stöder Web Push först från **16.4** och **bara** för appar på hemskärmen:
öppna i Safari → Dela → *Lägg till på hemskärmen*, öppna ikonen, klicka
**Aktivera notiser**. Android och desktop (Chrome/Firefox/Edge) funkar direkt.

## RSS-alternativ
Vill du hellre använda en vanlig RSS-läsare: prenumerera på
`https://<användarnamn>.github.io/<repo>/feed.xml`.

## Anpassa
- **Andra nämnder:** ändra `boards` i [`config.json`](config.json). Id:n hittas på
  `…/Boards` (varje nämndlänk slutar på sitt id).
- **Andra år / intervall:** `years` i `config.json`, cron i
  [`.github/workflows/scrape.yml`](.github/workflows/scrape.yml).
- **Dokumentfönster:** `docLookbackDays` i `config.json` (default 120) – hur långt
  bakåt agendor hämtas för att upptäcka nya dokument.

## Begränsningar
- Screen-scraping — kan gå sönder om TietoEVRY ändrar HTML:en.
- Dokumentnotiser täcker mötets **dokumentlista** (kallelse, handlingar, protokoll).
  Dokument som ligger djupt inne i enskilda agendapunkter
  (`LoadAgendaItemDetail`) fångas inte i v1.
