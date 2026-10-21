# Changelog

All notable changes to `@x3growth/sdk`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the package uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- Clicks on links to another origin of the project (e.g. from `example.com` to `app.example.com`, both in the
  project's domains) are sent at once, together with their `data-x3-event` custom event – like external links.
  Before, they waited for the unload beacon, which a cross-origin navigation can drop (lost `signup_click`).

## [1.0.2] – 2026-10-19

### Added
- `x3.identify({ leadId })`: links the current visit to a lead X3 already knows – your CRM record id, your
  own lead/customer id or the X3 lead id. Sent as a SHA-256 hash (same normalization as `externalId`); it
  never creates a lead on its own. With consent the visitor id links the visitor's earlier and later visits
  too. Follows the project's identify consent rule (`identify.requireConsent`, default on).
- Consented visitor id lifetime: `x3_vid` uses the project's `journeys.visitorIdDays` (default and maximum
  395 days = 13 months, capped by the retention) for the JS cookie and passes it to the first-party proxy as
  `days` on `POST /v1/id`.

### Changed
- First-party proxy (`@x3growth/sdk/next/proxy`): `x3_vid` is set and renewed only on `POST /v1/id` (every
  page load with consent) with the lifetime the SDK sends (1–395 days); consented batches no longer re-set
  the cookie with a fixed 13 months.

### Fixed
- Experiments: `GET /v1/x` gets the page view's in-memory id (`pl`) and answers assigned arms with a signed
  receipt (`v`); `experiment_view` sends both back for day and visitor units. A visitor whose network changed
  between the assignment and the first collect (mobile networks, iCloud Private Relay) is then verified by the
  receipt instead of being dropped as a mismatching assignment. Nothing new is stored on the device.

## [1.0.1] – 2026-10-19

### Fixed
- Live board: clicks reach the board again. The live plugin read the click's anchor during the click
  itself, but the anchor is built only after the next paint (no INP cost), so every live click was dropped
  and only the scroll band moved. The plugin now reads the anchor once it exists and computes „ms ago“
  when the frame is sent.
- Live board, grouped watch (0.2 Hz, no frames): clicks are sent with an early heartbeat (`c=` JSON, at
  most 5, only where the clicks level allows) instead of not at all.
- A click the core did not capture no longer repeats the previous click's anchor on the board.

## [1.0.0] – 2026-10-19

First stable release: the public API of 0.5.0 (analytics, events, leads, experiments, React/Next/server helpers)
is unchanged and now covered by semantic versioning.

### Fixed
- Experiments: test links (`?x3_force=` and signed `?x3_force_t=`) also preview while tracking does not run
  (opted out via `x3_notrack`, consent pending): the forced arm is shown, `/v1/x` is asked once with the token
  (no unit, no consent flag), nothing is exposed, counted or sent. Before, such a visitor stayed on control.
- Experiments: a test link survives navigation and reloads in the same tab (sessionStorage `x3_xp_qa`, written
  only by test links); `?x3_force=` with an empty value ends the preview.

### Changed
- Size budget of the lazy `x3.experiments.js` 3.5 KB (measured 3.20 KB); the core stays below 16 KB.

## [0.5.0] – 2026-10-18

### Added
- Experiments (A/B/n): `x3.variant(key, { expose, fallback })` answers the arm of a flag key synchronously
  (never throws, `control` while the visitor is not enrolled or the assignment is not known yet),
  `x3.experiment(key)` returns arm, reason and arm params, `x3.expose(key)` logs the exposure at the point
  where the arms differ (once per pageview). `x3.experiments.ready(timeoutMs)`, `.onChange(listener)` and
  `.all()` for anti-flicker slots and QA.
- Script tag / dispatcher: `x3("variant", key, (arm, info) => …, { expose })` (callback once the assignment
  is known, at most 300 ms, then control) and `x3("expose", key)`. Assignment, hashing and the `/v1/x`
  request live in the lazy plugin `x3.experiments.js`, which the core loads only when the project config
  carries experiments; `x3.full.js` bundles it.
- Code-call telemetry: keys called on a pageview are sent as `xc` so X3 can show „Code live erkannt“ and
  resolve the cleanup task.
- QA overrides `?x3_force=<key>:<arm>` and signed `?x3_force_t=` links; forced visits count as test traffic.
- React (`@x3growth/sdk/react`): `useVariant`, `useExpose`, `<Variant>`, `<X3Experiments>` (server assignments
  for hydration without flicker).
- Next.js (`@x3growth/sdk/next`): `getAssignments` / `getVariant` (server helper, 150 ms timeout → control),
  `<X3Analytics experiments={…}>`; the proxy handler forwards `GET /v1/x/{pk}` (consented `x3_vid` as
  `x-3x-vid`).
- Server (`@x3growth/sdk/server`): `experiments.assign(...)`, `leads.addNote(ref, text)` for visitor follow-up
  text on an existing lead (by lead id or the create idempotency key, no new lead or conversion), CRM routing
  options `crm` / `crmWait` on `leads.create` and the CRM result in its response.
- Browser leads: `x3.lead(data)` (POST `/v1/leads`, when the project allows browser leads).

### Changed
- Size budget of the core `x3.js` raised consciously from 15.5 to 16 KB gz for the experiments stub;
  `x3.full.js` 29 KB; new budget `x3.experiments.js` 3 KB.

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
