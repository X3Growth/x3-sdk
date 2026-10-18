# Changelog

All notable changes to `@x3growth/sdk`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the package uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.0] – 2026-10-18

### Added
- Video: ranges a viewer watched again within the same play (seeking back, rewinding) are sent as `rw`
  (merged, at most 20 per play) – the dashboard shows rewatched parts and the per-visit watch strip.
- Video: the absolute URL of the played file (`u`, without query string and hash, at most 300 characters)
  for frame previews in the dashboard; `blob:`/`data:` sources send none, the server keeps it only on the
  site's own hosts. Custom players and `x3.video.track()` take it as option `url`.
- Oversized states merge the rewatch ranges to 5 and drop the preview URL before any section.

### Fixed
- Recordings keep what a page recorded when the recording stops (too noisy, too slow, page excluded on an
  SPA navigation): the full snapshot and the events since the last packet are still uploaded – before, a
  stop right after the snapshot discarded it and the page had no recording at all.
- A slow full snapshot (above 150 ms, e.g. a heavy landing page on a phone) no longer ends the recording:
  the snapshot is already paid for, so it is uploaded and the cheap incremental recording goes on (quiz
  overlays and their steps reach the player). Slow devices take no further full snapshots (sparse-sampling
  checkouts and SPA navigations stop the recording instead).
- Sparse sampling: the ring buffer keeps the newest complete checkout (meta event + full snapshot) and
  everything after it, instead of dropping the meta event and never trimming afterwards.

## [0.3.0] – 2026-10-18

### Added
- Masking of recordings as a project setting: `x3.replay.js` applies the project's policy per category
  (page texts, form inputs, choices, attributes, links, images, own mask/unmask/block selectors) from the
  config – a change in X3 reaches the site with the next config fetch, no redeploy. Passwords, payment
  fields (`cc-*`), one-time codes, hidden and file inputs are never recorded under any option.
- Test and internal visits: when the project relaxes masking for them only, test traffic (test parameter,
  `test: true`, `data-test`) is recorded with the relaxed rules – every other behavior signal still stops
  for test traffic. `?x3_internal=1` marks a browser as internal (stored like the opt-out flag, undo with
  `=0`); its visits count as test traffic.

### Fixed

- `x3.live.js`: the live heartbeat no longer stops after two answers with `hz = 0` (nobody watching). It is the presence signal of „Besucher jetzt“, so a visitor who arrived before anyone opened Live stays counted; only two failed requests in a row (not a 429) end it until the tab is visible again. The browser script is served by the API, so sites pick it up without a package update.

## [0.2.0] – 2026-10-18

### Added
- Recordings, heatmaps and live (X3 Growth Intelligence): lazy plugins `x3.heat.js`, `x3.signals.js`,
  `x3.live.js`, `x3.replay.js` (rrweb-based, inputs and personal-looking text masked in the browser),
  `x3.fflate.js` and `x3.privacy.js`, loaded only when the project enables the signal and the visitor's
  consent state allows it. `x3.consent({ analytics, recordings })` sets the purposes separately; Global
  Privacy Control, opt-out and test traffic stop every behavior signal.
- `createX3ProxyHandler` (`@x3growth/sdk/next/proxy`) forwards the new path families `/v1/r`, `/v1/r/css`,
  `/v1/hb/{pk}`, `/v1/l`, `/v1/snap[/session]` and `/v1/privacy/{pk}[/erase|/export]` (recording chunks up
  to 1 MB, snapshots up to 4 MB) and passes the visitor's coarse location from Vercel/Cloudflare headers.
  Sites using the first-party proxy need this version for recordings; nothing else changes.

## [0.1.2] – 2026-10-17

### Fixed
- A pageview that leaves with the leave-page beacon (0.1.1: page left before the config arrived) is dated
  from the navigation start instead of the moment of leaving, so it is the entry of the session and sorts
  before the next page.
- `x3.consent("granted")` called before the config arrived could override Global Privacy Control; GPC now
  always wins once the config is applied.

### Server (X3 API, no SDK change needed)
- Page A's leave beacon and page B's first send of one visitor arriving at the same time could each open a
  session (cookieless visitors are linked by the daily visitor hash); the ingest now serializes the hash
  lookup per visitor, so A and B are one session.

## [0.1.1] – 2026-10-16

### Fixed
- A visitor who left with a full page navigation before the tracker had its client config (config request
  still in flight) lost that first pageview and every call queued before. Hiding or leaving the page now starts
  the pageview with the default config right away (what the 5 s config timeout did later) and sends it, with
  the queued events, through `sendBeacon` (`fetch` `keepalive` as fallback) in the same `pagehide` /
  `visibilitychange` – exactly once; a config arriving later is ignored for that page.
- `<X3Analytics>` (`@x3growth/sdk/next`) started the SDK only after hydration (`next/script`
  `afterInteractive`), seconds after the page was visible on slow devices – a visitor leaving earlier was not
  counted. It now renders an inline loader that starts the script while the HTML is parsed; `next/script`
  stays as fallback (the SDK ignores a second load). `strategy="afterInteractive"` restores the old behaviour
  (CSP without a nonce for inline scripts).

### Changed
- The first send of a pageview happens 1 s after it started (was 5 s), so the pageview is recorded even when
  the browser drops the unload beacon or suspends the tab. Later sends carry the cumulative state with a
  higher `seq`; the server keeps the latest, so nothing is counted twice.

## [0.1.0] – 2026-10-16

First release on the npm registry as `@x3growth/sdk` (MIT). Before, the package was only distributed as the
tarball `3x-engine-sdk-<version>.tgz` / `x3growth-sdk-<version>.tgz` by each X3 API deployment; that URL keeps
working.

### Added
- Browser tracker (ESM and script tag): cookieless pageviews, engagement, clicks (CTA, WhatsApp and
  messengers, phone, mail, downloads, outbound), section reach, video retention, forms, custom events,
  goals and funnel steps, UTM parameters and click ids.
- Consent modes `cookieless`, `strict`, `require`; CMP adapters (Cookiebot, Usercentrics, Complianz,
  Borlabs, Google Consent Mode); Global Privacy Control.
- `identify()` with in-browser hashing, journeys plugin, booking adapters and funnel bridges.
- React (`/react`) and Next.js (`/next`, `/next/proxy`) adapters, server helper (`/server`),
  DOM-free transport for sandboxed pixels (`/pixel`).
