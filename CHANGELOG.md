# Changelog

All notable changes to `@x3growth/sdk`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the package uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
