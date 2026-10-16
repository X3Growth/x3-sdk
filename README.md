# @x3growth/sdk

Cookieless, first-party web analytics, ad attribution and conversions for any website – the
browser tracker of **[X3 Growth Intelligence](https://intelligence.x3growth.io)**, plus React/Next.js
adapters, a first-party proxy, a server helper and a DOM-free transport for sandboxed pixels.

- No cookies, `localStorage` or `sessionStorage` before consent; ids live in memory.
- Pageviews, scroll depth and fold, engaged time, clicks (CTA, WhatsApp, messengers, downloads,
  outbound), section reach, video retention, forms, custom events, goals and funnels.
- UTM parameters and click ids (`gclid`, `gbraid`, `wbraid`, `fbclid`, `li_fat_id`, `ttclid`,
  `msclkid`) on every pageview; ad cookies `_fbp`/`_fbc`/`_ttp` only after consent.
- `identify()` hashes contact data in the browser (SHA-256, ad-platform normalization).
- Consent modes `cookieless` (default), `strict` and `require`; CMP adapters for Cookiebot,
  Usercentrics, Complianz, Borlabs and Google Consent Mode; Global Privacy Control respected.

Documentation: [api.x3growth.io/llms.txt](https://api.x3growth.io/llms.txt) (index of every guide as
markdown), the guides under [api.x3growth.io/v1/docs](https://api.x3growth.io/v1/docs/index.md) and the
dashboard's **Docs**. Want Claude to install it for you? Add the
[X3 Claude plugin](https://github.com/X3Growth/x3-claude) and ask "Connect my website to X3".

## Install

```bash
npm install @x3growth/sdk
```

Until the first registry release, every X3 API deployment serves the same package as a tarball:
`npm install https://api.x3growth.io/v1/sdk/x3growth-sdk-<version>.tgz`. The script-tag build needs no
install at all (below).

## Script tag

```html
<script>window.x3=window.x3||function(){(window.x3q=window.x3q||[]).push(arguments)}</script>
<script async src="/n3/v1/s/x3.full.js?k=pk_3x_…" data-key="pk_3x_…" data-host="/n3"></script>
```

`x3.full.js` bundles every plugin; `x3.js` is the core and loads `x3.video.js`, `x3.sections.js`,
`x3.forms.js`, `x3.identify.js`, `x3.consent.js` and `x3.bookings.js` on demand. Calls made before
the script loads are queued:

```js
x3("track", "signup_started", { plan: "pro" });
x3("goal", "demo_requested");
x3("consent", "granted");
```

Attributes: `data-key`, `data-host`, `data-consent` (`granted|denied|pending`), `data-auto`
(e.g. `"pageviews,clicks"`), `data-plugins`, `data-hash-routing`, `data-respect-dnt`, `data-test`,
`data-debug`.

## npm

```ts
import { init, track, goal, funnelStep, identify, consent, getIds } from "@x3growth/sdk";

init({ key: "pk_3x_…", host: "/n3" });
track("plan_selected", { plan: "pro", seats: 5 });
funnelStep("signup", "plan_chosen");
await identify({ email: "max@example.com", form: "contact" }); // hashed in the browser
consent("granted");
```

Plugins load on demand from the project config; to bundle them explicitly:

```ts
import { video, sections, forms } from "@x3growth/sdk/plugins";
init({ key: "pk_3x_…", plugins: [video(), sections(), forms()] });
```

Markup without code: `data-x3-event="plan_selected" data-x3-prop-plan="pro"` turns a click into a
custom event; `data-x3-cta`, `data-x3-label`, `data-x3-section`, `data-x3-ignore`, `data-x3-video`,
`data-x3-form`, `data-x3-404` refine labels, sections and names.

## React and Next.js

```tsx
// any React app
import { X3Provider, useX3 } from "@x3growth/sdk/react";
<X3Provider options={{ key: "pk_3x_…", host: "/n3" }}>{children}</X3Provider>;

// Next.js App Router – app/layout.tsx (server component)
import { X3Analytics, fetchClientConfig } from "@x3growth/sdk/next";
const config = await fetchClientConfig({ apiOrigin: process.env.X3_API_ORIGIN!, publishableKey: KEY });
<X3Analytics publishableKey={KEY} host="/n3" config={config} />;

// app/n3/[...path]/route.ts – first-party proxy
import { createX3ProxyHandler } from "@x3growth/sdk/next/proxy";
export const { GET, POST, OPTIONS } = createX3ProxyHandler({ apiOrigin: process.env.X3_API_ORIGIN!, proxyKey: process.env.X3_PROXY_KEY });
```

The proxy forwards only `/v1/e`, `/v1/c/{pk}`, `/v1/cb` and `/v1/s/*`, strips cookies and
authorization and adds the visitor's IP/country for the API (trusted only with the proxy key).

## Server helper

```ts
import { createX3Server, requestContext } from "@x3growth/sdk/server";

const x3 = createX3Server({ apiUrl: process.env.X3_API_URL!, apiKey: process.env.X3_SECRET_KEY! });
await x3.leads.create({ sessionId, email, form: "contact", conversion: { definition: "lead", ...requestContext(request) } });
await x3.conversions.create({ definition: "purchase", sessionId, value: 120, currency: "EUR" });
await x3.events.track({ sessionId, name: "invoice_paid", props: { plan: "pro" } });
```

`sessionId` comes from the browser's `getIds()`. Secret keys (`sk_3x_…`) never belong in the browser.

## Sandboxed pixels (Shopify)

```ts
import { createX3Pixel, shopifyPixel } from "@x3growth/sdk/pixel";
const x3 = createX3Pixel({ key: "pk_3x_…", host: "https://shop.example/n3" });
analytics.subscribe("all_standard_events", (event) => shopifyPixel(x3, event));
```

## Funnel presets

`@x3growth/sdk/presets` bridges an existing funnel tracker's calls (`bridgeFunnelStage`,
`bridgeQuizAnswer`, `bridgeFunnelEvent`, `listenQuizSubmitted`, `listenBookings`, `reportBooking`)
onto the standard preset events, so stored events stay comparable.

## License

[MIT](LICENSE). Source: [github.com/X3Growth/x3-sdk](https://github.com/X3Growth/x3-sdk) (mirrored from
the X3 monorepo; issues and pull requests welcome).
