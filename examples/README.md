# Examples

Minimal, copy-ready integrations. They use the placeholder `pk_3x_YOUR_PUBLISHABLE_KEY` (find yours in
the X3 dashboard under *Project → Settings → Keys*) and the hosted API `https://api.x3growth.io`.

| Folder | Stack |
|---|---|
| [`html/`](html/index.html) | Script tag for plain HTML, Webflow, WordPress head code, Google Tag Manager (Custom HTML) |
| [`next-app/`](next-app/) | Next.js App Router: `<X3Analytics>`, first-party proxy route, `window.x3` helper |
| [`react-vite/`](react-vite/src/main.tsx) | React single-page app with `<X3Provider>` |
| [`server/`](server/lead.ts) | Server-side lead + conversion with a secret key |

The complete, always-current recipes (consent/CMP adapters, CSP, proxies for other hosts, events) are in
the docs: [api.x3growth.io/llms.txt](https://api.x3growth.io/llms.txt). Or let Claude do it with the
[X3 Claude plugin](https://github.com/X3Growth/x3-claude).
