import { encodeAttention, encodeScrollTimeline, type ScrollSample, type WirePageviewHeat } from "../_core/index.js";
import { buildAnchor, clickTarget, INTERACTIVE_SELECTOR, structureHash } from "../_core/index.js";
import type { TrackedPageview, X3Plugin, X3PluginHost } from "../types";

/**
 * x3.heat.js (RECORDINGS-HEATMAPS §5.2, §5.3, §20.C): anchors of clicks (box read at pointerdown,
 * string built after the next paint), scroll timeline, attention bands, exit, section reach,
 * structure hash, scroll-lock fix, dead and rage clicks, the device proof and the WhatsApp reference
 * code. Live heartbeat/frames: x3.live.js; form, copy and web-vital signals: x3.signals.js. Every
 * signal is checked against the capture level of the current consent state; the server checks again.
 */

type S = { h: WirePageviewHeat; st: ScrollSample[]; t: number; top: number; good: number; ab: number[]; sec: Array<[Element, string | null]>; clicks: number[][] };

/** the window in which a click must show an effect (§5.2) */
export const DEAD_WINDOW_MS = 1e3;
const CONTROL = `${INTERACTIVE_SELECTOR},[role=checkbox],[role=radio],[role=switch],[role=option],[onclick]`;
const NEVER_DEAD = "input,textarea,select,label,[contenteditable],video,audio,iframe";

/**
 * A click that may count as dead: on a control or an element that looks clickable (pointer cursor), not on
 * a form field or editable text (typing and focus follow), not a click that opens another tab or window
 * (modifier keys, middle button, target=_blank, download) and not on a link that leaves the page by design.
 */
export function deadCandidate(target: EventTarget | null, mouse?: MouseEvent): boolean {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!el || el.closest(NEVER_DEAD)) return false;
  if (mouse && (mouse.ctrlKey || mouse.metaKey || mouse.shiftKey || mouse.altKey || mouse.button > 0)) return false;
  const link = el.closest("a[href]") as HTMLAnchorElement | null;
  if (link && ((link.target && link.target !== "_self") || link.hasAttribute("download") || !/^https?:/.test(link.protocol))) return false;
  if (el.closest(CONTROL)) return !(el.closest("button,[role=button]") as HTMLButtonElement | null)?.disabled;
  try {
    return getComputedStyle(el).cursor === "pointer";
  } catch {
    return false;
  }
}

/** Calls `onRequest` when the page itself starts a request (fetch, XHR, script, image …) – the SDK's own beacons do not count; returns the stop function */
export function watchNetwork(apiHost: string, onRequest: () => void): () => void {
  if (typeof PerformanceObserver === "undefined") return () => undefined;
  let own = "";
  try {
    if (apiHost) own = new URL(apiHost, location.href).href.replace(/\/$/, "");
  } catch {
    // no API root: every request counts
  }
  try {
    const observer = new PerformanceObserver((list) => {
      if (list.getEntries().some((entry) => (entry as PerformanceResourceTiming).initiatorType !== "beacon" && !(own && entry.name.startsWith(own)))) onRequest();
    });
    observer.observe({ type: "resource" });
    return () => observer.disconnect();
  } catch {
    return () => undefined;
  }
}

const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

export function heat(): X3Plugin {
  return {
    name: "heat",
    install(host: X3PluginHost) {
      const b = host.behavior();
      const ok = b.allowed;
      const anchor = (b.anchor = (el: Element) => buildAnchor(el, { containerOnlyChoices: !!b.config()?.containerOnlyChoices }));
      const doc = document.documentElement;
      // device proof (§4.7): in memory, persisted as x3_psec only after consent
      let secret = hex(crypto.getRandomValues(new Uint8Array(16)));
      const prove = () => {
        try {
          if (host.consent()) secret = localStorage.getItem("x3_psec") ?? (localStorage.setItem("x3_psec", secret), secret);
        } catch {
          // storage blocked: the in-memory secret proves this visit
        }
        void crypto.subtle?.digest("SHA-256", new TextEncoder().encode(secret)).then((d) => (b.dp = hex(d)));
        b.secret = secret;
      };
      prove();
      b.on.push(prove);
      // the element box is read at pointerdown, before the click's effects change the layout (§5.2)
      let down: [EventTarget | null, DOMRect] | null = null;
      host.listen(document, "pointerdown", (event) => (down = event.target instanceof Element ? [event.target, event.target.getBoundingClientRect()] : null), { capture: true, passive: true });
      const refs = new WeakMap<Element, string>();
      b.fin = (item) => {
        const a = anchor(clickTarget(item.t) ?? item.t);
        if (!a) return;
        const wr = refs.get(item.t.closest?.("a[href]") as Element);
        const r = down && (down[0] === item.t || item.t.contains(down[0] as Node)) ? down[1] : item.t.getBoundingClientRect();
        const { clientX: x, clientY: y } = item.m;
        const vw = innerWidth;
        item.e.h = { ...item.e.h, a, vw, px: Math.round((x / vw) * 1e3), py: Math.round(y + item.s), ...(wr ? { wr } : {}), ...(r.width && r.height ? { ax: Math.round(Math.min(1, Math.max(0, (x - r.left) / r.width)) * 1e3), ay: Math.round(Math.min(1, Math.max(0, (y - r.top) / r.height)) * 1e3) } : {}) };
      };
      b.pending.splice(0).forEach(b.fin);
      const states: Record<string, S> = {};
      const state = (pv: TrackedPageview): S =>
        (states[pv.id] ??= { h: b.heat(pv.id), st: [], t: 0, top: -99, good: 0, ab: Array(50).fill(0), sec: Array.from(document.querySelectorAll("[data-x3-section],main h2"), (el): [Element, null] => [el, null]).slice(0, 30), clicks: [] });
      const height = (s: S) => {
        const h = doc.scrollHeight;
        // scroll-lock fix: a modal with overflow:hidden must not look like a fully read page (Spike B §0.6)
        const locked = /hidden/.test(getComputedStyle(document.body).overflow + getComputedStyle(doc).overflow) || (s.good > 0 && h <= innerHeight * 1.05);
        if (!locked) s.good = Math.max(s.good, h);
        return [s.good || h, locked ? 1 : 0] as const;
      };
      const exit = (pv: TrackedPageview, r: "hide" | "nav" | "close") => {
        if (ok("scroll")) state(pv).h.ex = { t: Math.round(host.age(pv)), p: Math.min(1e3, Math.round(((scrollY + innerHeight) / height(state(pv))[0]) * 1e3)), r };
      };
      host.hook({
        begin(pv) {
          const s = state(pv);
          setTimeout(() => (ok("scroll") || ok("clicks")) && (s.h.sh = structureHash(document.body)), 1500);
        },
        sample(pv) {
          if (!ok("scroll")) return;
          const s = state(pv);
          const now = host.age(pv);
          const top = Math.min(1e3, Math.round((scrollY / height(s)[0]) * 1e3));
          if (Math.abs(top - s.top) >= 10 && now - s.t >= 500 && s.st.length < 240) {
            s.st.push({ dt: Math.min(255, Math.round((now - s.t) / 100)), top });
            s.t = now;
            s.top = top;
            s.h.st = encodeScrollTimeline(s.st);
          }
          if (!ok("sections")) return;
          for (const entry of s.sec) {
            if (entry[1] || entry[0].getBoundingClientRect().top > innerHeight || !(entry[1] = anchor(entry[0]))) continue;
            (s.h.sr ??= []).push([entry[1], Math.round(now)]);
          }
        },
        tick(pv, delta) {
          const s = state(pv);
          const [h, locked] = height(s);
          if (locked) s.h.lk = (s.h.lk ?? 0) + Math.round(delta);
          if (!ok("scroll")) return;
          for (let i = Math.max(0, Math.floor((scrollY / h) * 50)); i <= Math.min(49, Math.floor(((scrollY + innerHeight) / h) * 50)); i++) s.ab[i] = (s.ab[i] ?? 0) + delta / 100;
          s.h.ab = encodeAttention(s.ab);
        },
        // a visit that leaves before the 1.5 s hash still belongs to this page version (bounces count in its views)
        hide: (pv) => {
          const s = state(pv);
          if (!s.h.sh && (ok("scroll") || ok("clicks"))) s.h.sh = structureHash(document.body);
          exit(pv, "close");
        },
        end(pv) {
          exit(pv, document.visibilityState === "hidden" ? "hide" : "nav");
          delete states[pv.id];
        },
      });
      // dead and rage clicks (§5.2): rage = ≥ 3 in 700 ms within 30 px; dead = a click on a clickable-looking
      // element (control or pointer cursor) with no visible effect within 1 s: no DOM change (structure,
      // state attributes, text), no scroll, navigation, focus change and no network request of the page
      let seen: unknown = null;
      host.listen(document, "click", (event) => {
        const pv = host.current();
        const clicked = b.last;
        // b.last is the click event the core queued for THIS click; a click the core did not capture leaves the previous one
        if (!pv || !clicked || clicked === seen || !ok("clicks")) return;
        seen = clicked;
        const s = state(pv);
        const mouse = event as MouseEvent;
        const { clientX: x, clientY: y } = mouse;
        const now = Date.now();
        s.clicks = s.clicks.filter((c) => now - (c[0] as number) < 700);
        const near = s.clicks.filter((c) => Math.hypot((c[1] as number) - x, (c[2] as number) - y) <= 30);
        const first = (near[0]?.[3] ?? clicked.n) as number;
        s.clicks.push([now, x, y, first]);
        if (near.length > 1) {
          s.h.rc = [...(s.h.rc ?? []).filter((r) => r[0] !== first), [first, near.length + 1]];
          b.flag?.(clicked, 1);
        }
        if (!deadCandidate(event.target, mouse) || (s.h.dc?.length ?? 0) >= 50) return;
        let moved = false;
        const before = [scrollY, location.href, document.activeElement, document.visibilityState];
        const observer = new MutationObserver(() => ((moved = true), observer.disconnect()));
        observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "aria-expanded", "aria-hidden", "aria-pressed", "aria-selected", "data-state", "open", "hidden", "style", "disabled"] });
        const net = watchNetwork(host.apiHost(), () => (moved = true));
        setTimeout(() => {
          observer.disconnect();
          net();
          if (!moved && before[0] === scrollY && before[1] === location.href && before[2] === document.activeElement && before[3] === document.visibilityState && (s.h.dc?.length ?? 0) < 50) {
            (s.h.dc ??= []).push(clicked.n);
            b.flag?.(clicked, 2);
          }
        }, DEAD_WINDOW_MS);
      }, { capture: true });
      // WhatsApp reference code in the prefilled text (§11.1, idea 49): on window in the capture phase, so the
      // link carries it before the core emits (WhatsApp clicks are sent at once) and fin adds it to the click
      host.listen(window, "click", (event) => {
        const link = (event.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
        if (!link || !ok("clicks") || !b.config()?.whatsappRef || !/(^|\.)(wa\.me|whatsapp\.com)$/.test(new URL(link.href, location.href).hostname)) return;
        const code = Array.from(crypto.getRandomValues(new Uint8Array(4)), (n) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[n % 32]).join("");
        const url = new URL(link.href);
        url.searchParams.set("text", `${(url.searchParams.get("text") ?? "").replace(/\s*Ref [A-Z2-9]{4}$/, "")} Ref ${code}`.trim());
        link.href = url.href;
        refs.set(link, code);
      }, { capture: true });
      return {};
    },
  };
}

