# Contributing

This repository is the public mirror of the X3 Growth Intelligence browser SDK. It is developed in the
X3 monorepo and synced here on every change, together with the generated `src/_core` folder (the part of
the shared core the SDK uses).

- Issues and pull requests are welcome; accepted changes are ported to the monorepo and come back with the
  next sync (your commit is credited).
- Please do not edit `src/_core/` – it is generated.
- `npm install && npm run typecheck && npm run build && npm run smoke` must pass.
- Releases: a maintainer bumps the version in the monorepo, the sync updates this repo and a `v<version>`
  tag publishes to npm with provenance (.github/workflows/publish.yml).
- Security issues: please report privately via GitHub security advisories, not as an issue.
