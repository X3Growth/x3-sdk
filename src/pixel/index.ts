/**
 * @x3growth/sdk/pixel – DOM-free transport for sandboxed environments
 * (Shopify app/custom web pixels, web workers): no document, no window, no
 * storage – only fetch(keepalive) and timers. Pageviews carry 0 dimensions
 * (like consent mode strict); events attach to the latest pageview.
 *
 *   import { createX3Pixel, shopifyPixel } from "@x3growth/sdk/pixel";
 *   const x3 = createX3Pixel({ key: "pk_3x_…", host: "https://api.3x.example" });
 *   analytics.subscribe("all_standard_events", (event) => shopifyPixel(x3, event));
 */
import { attributionFromParams, canonicalPage, cleanRefHost, cleanText, EVENT_NAME_PATTERN, normalizeHost, PROP_KEY_PATTERN, type Attribution, type ClientConfig, type WireEvent, type WirePageview } from "../_core/index.js";
import { compileClient, defaultClientConfig } from "../core/config";
import { buildBatches, type OutboxItem } from "../core/transport";
import { SESSION_TIMEOUT_MS } from "../core/constants";
import { uuid } from "../core/util";
import type { Props } from "../types";
import { LIB } from "../version";

export type X3PixelOptions = {
  key: string;
  /** API origin or first-party proxy URL (absolute: sandboxes have no page origin) */
  host: string;
  /** client config (else fetched once from {host}/v1/c/{key}) */
  config?: ClientConfig;
  /** consent at creation (Shopify: init.customerPrivacy.analyticsProcessingAllowed) */
  consent?: boolean;
  test?: boolean;
  fetch?: typeof fetch;
  /** events are sent after this delay (default 1 s) – pixels get few chances to send */
  flushDelayMs?: number;
};

export type X3PixelPage = { url: string; referrer?: string | null };

type Page = { pv: WirePageview; t0: number; n: number; queue: WireEvent[]; sentSeq: number };

const KEY_FORMAT = /^pk_3x_[0-9A-Za-z]{30}$/;

export function createX3Pixel(options: X3PixelOptions) {
  if (!options || !KEY_FORMAT.test(options.key)) throw new TypeError("createX3Pixel: invalid publishable key");
  const host = options.host.replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  let consent = options.consent === true;
  let config: ClientConfig | null = options.config ?? null;
  let configLoad: Promise<ClientConfig | null> | null = null;
  let session: { sid: string; fresh: boolean; last: number } | null = null;
  let page: Page | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  const loadConfig = (): Promise<ClientConfig | null> => {
    if (config) return Promise.resolve(config);
    configLoad ??= doFetch(`${host}/v1/c/${options.key}`, { credentials: "omit" })
      .then((response) => (response.ok ? (response.json() as Promise<ClientConfig>) : null))
      .then((value) => (config = value && typeof value === "object" ? value : null))
      .catch(() => null);
    return configLoad;
  };

  const sessionId = () => {
    const now = Date.now();
    if (!session || now - session.last > SESSION_TIMEOUT_MS) session = { sid: uuid(), fresh: true, last: now };
    return session;
  };

  const send = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const current = page;
    if (!current || !session || (!current.queue.length && current.sentSeq === current.pv.seq)) return;
    const events = current.queue.splice(0);
    const item: OutboxItem = {
      state: () => ({ ...current.pv, seq: ++current.pv.seq, age: Date.now() - current.t0 }),
      events,
      identify: null,
    };
    const cfg = await loadConfig();
    const envelope = { k: options.key, sid: session.sid, fresh: session.fresh, consent, test: options.test === true, cv: cfg?.rev, lib: LIB };
    for (const body of buildBatches(envelope, [item])) {
      await doFetch(`${host}/v1/e`, { method: "POST", keepalive: true, credentials: "omit", headers: { "content-type": "text/plain;charset=UTF-8" }, body }).catch(() => undefined);
    }
    current.sentSeq = current.pv.seq;
    session.last = Date.now();
    session.fresh = false;
  };

  const schedule = (now = false) => {
    chain = chain.then(async () => {
      if (now) return send();
      timer ??= setTimeout(() => void (chain = chain.then(send).catch(() => undefined)), options.flushDelayMs ?? 1_000);
    }).catch(() => undefined);
    return chain;
  };

  return {
    /** starts a pageview for a URL (Shopify: event.context.document.location.href) */
    async page(input: X3PixelPage): Promise<void> {
      try {
        let url: URL;
        try {
          url = new URL(input.url);
        } catch {
          return;
        }
        await schedule(true);
        const hostname = normalizeHost(url.hostname);
        const cfg = (await loadConfig()) ?? defaultClientConfig(hostname);
        const compiled = compileClient(cfg.domains.length ? cfg : defaultClientConfig(hostname));
        const target = canonicalPage(hostname, url.pathname, compiled) ?? canonicalPage(hostname, url.pathname, compileClient(defaultClientConfig(hostname)));
        if (!target) return;
        const attr: Attribution = target.personal ? {} : attributionFromParams(url.searchParams, compiled.valueRedactions);
        sessionId();
        const nav = page ? "spa" : "load";
        page = {
          t0: Date.now(),
          n: 0,
          queue: [],
          sentSeq: -1,
          pv: {
            id: uuid(),
            seq: 0,
            age: 0,
            nav,
            host: hostname,
            path: target.page,
            variant: null,
            lang: null,
            ref: nav === "load" && !target.personal ? cleanRefHost(input.referrer ?? "") : null,
            attrFrom: Object.keys(attr).length ? "url" : "none",
            attr,
            vw: 0,
            vh: 0,
            sw: 0,
            tp: false,
            ph: 0,
            sy: 0,
            sp: 0,
            marks: {},
            sec: {},
            eng: 0,
            clk: 0,
            iclk: 0,
            vids: [],
          },
        };
        // the first send registers the pageview even without events
        await schedule(true);
      } catch {
        // never throw into the pixel host
      }
    },
    /** custom or built-in event on the current pageview (scalar props ≤ 20; the API validates) */
    track(name: string, props: Props = {}, opts: { flush?: boolean } = {}): Promise<unknown> {
      try {
        if (!page || !EVENT_NAME_PATTERN.test(name) || page.n >= 500) return Promise.resolve();
        // same rules as the browser tracker: ≤ 20 scalar props, strings ≤ 200 without e-mail/phone-like text
        const p: Props = {};
        for (const [key, value] of Object.entries(props ?? {})) {
          if (Object.keys(p).length >= 20) break;
          if (!PROP_KEY_PATTERN.test(key)) continue;
          const clean = typeof value === "string" ? cleanText(value, 200) : (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean" ? value : null;
          if (clean !== null) p[key] = clean;
        }
        const event: WireEvent = { pv: page.pv.id, n: page.n++, t: Date.now() - page.t0, e: name };
        if (Object.keys(p).length) event.p = p;
        page.queue.push(event);
        return schedule(opts.flush === true);
      } catch {
        return Promise.resolve();
      }
    },
    consent(granted: boolean): void {
      consent = granted === true;
    },
    flush: (): Promise<unknown> => schedule(true),
    getIds: () => ({ sessionId: session?.sid ?? null, pageviewId: page?.pv.id ?? null }),
  };
}

export type X3Pixel = ReturnType<typeof createX3Pixel>;

/** Minimal shape of a Shopify Web Pixels standard event */
export type ShopifyStandardEvent = {
  name: string;
  context?: { document?: { location?: { href?: string }; referrer?: string } };
  data?: Record<string, unknown>;
};

const money = (value: unknown): { value?: number; currency?: string } => {
  const amount = value && typeof value === "object" ? (value as { amount?: unknown; currencyCode?: unknown }) : null;
  const out: { value?: number; currency?: string } = {};
  if (typeof amount?.amount === "number" && Number.isFinite(amount.amount)) out.value = Math.round(amount.amount * 100) / 100;
  if (typeof amount?.currencyCode === "string" && /^[A-Z]{3}$/.test(amount.currencyCode)) out.currency = amount.currencyCode;
  return out;
};

/**
 * Maps Shopify standard events onto 3x: page_viewed → pageview; checkout_completed →
 * `purchase {value, currency}` (sent right away); product_added_to_cart → `add_to_cart`;
 * checkout_started → `checkout_started`; product_viewed → `product_viewed`; search_submitted → `search`.
 * No order ids, e-mail addresses or line items are sent.
 */
export async function shopifyPixel(pixel: X3Pixel, event: ShopifyStandardEvent): Promise<void> {
  try {
    const data = event.data ?? {};
    if (event.name === "page_viewed") {
      const href = event.context?.document?.location?.href;
      if (href) await pixel.page({ url: href, referrer: event.context?.document?.referrer ?? null });
      return;
    }
    if (event.name === "checkout_completed") {
      const checkout = (data.checkout ?? {}) as Record<string, unknown>;
      await pixel.track("purchase", money(checkout.totalPrice), { flush: true });
    } else if (event.name === "checkout_started") {
      const checkout = (data.checkout ?? {}) as Record<string, unknown>;
      await pixel.track("checkout_started", money(checkout.totalPrice), { flush: true });
    } else if (event.name === "product_added_to_cart") {
      const line = (data.cartLine ?? {}) as Record<string, unknown>;
      await pixel.track("add_to_cart", money(line.cost && (line.cost as Record<string, unknown>).totalAmount));
    } else if (event.name === "product_viewed") {
      await pixel.track("product_viewed");
    } else if (event.name === "search_submitted") {
      await pixel.track("search");
    }
  } catch {
    // never throw into the pixel host
  }
}
