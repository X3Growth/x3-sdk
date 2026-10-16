# Changelog

All notable changes to `@x3growth/sdk`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the package uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- Published under the npm name `@x3growth/sdk` (previously only distributed as the tarball
  `3x-engine-sdk-<version>.tgz` by each X3 API deployment; that URL keeps working).
- License: MIT.

## [0.1.0] – 2026-10-16

### Added
- Browser tracker (ESM and script tag): cookieless pageviews, engagement, clicks (CTA, WhatsApp and
  messengers, phone, mail, downloads, outbound), section reach, video retention, forms, custom events,
  goals and funnel steps, UTM parameters and click ids.
- Consent modes `cookieless`, `strict`, `require`; CMP adapters (Cookiebot, Usercentrics, Complianz,
  Borlabs, Google Consent Mode); Global Privacy Control.
- `identify()` with in-browser hashing, journeys plugin, booking adapters and funnel bridges.
- React (`/react`) and Next.js (`/next`, `/next/proxy`) adapters, server helper (`/server`),
  DOM-free transport for sandboxed pixels (`/pixel`).
