import { CLICK_ID_KEYS, UUID_PATTERN, type Attribution, type ClientJourneys, type WireClickIds } from "../_core/index.js";
import { readCookie, uuid } from "./util";

/**
 * Consent-gated journey persistence (ARCHITECTURE §10.5, §17.1). Nothing here
 * runs before consent (§ 25 Abs. 1 TDDDG): the tracker only calls page()/grant()
 * with consent and wire() returns nothing without it.
 *
 *  x3_vid  first-party visitor id (ClientConfig.journeys.visitorIdDays: 13 months by default,
 *          shorter when the project says so or its retention is shorter; renewed per page load).
 *          Behind the Next.js proxy it is an HttpOnly cookie set by POST {host}/v1/id (the SDK
 *          sends the lifetime as `days`) and injected into batches by the proxy; otherwise a
 *          JS cookie sent as `vid`.
 *  x3_clk  URL click ids with their first sighting (90 days), sent as `ck`.
 *  _fbp/_fbc/_ttp created when missing (ClientConfig.journeys.fbp/ttp, 90 days);
 *          the ones created here are listed in x3_clk "_own" and deleted on revocation.
 * Values mirror JOURNEY / VISITOR_ID_COOKIE / CLICK_ID_COOKIE in @3x/core (inlined for size).
 */

export type Persist = {
  grant(): void;
  revoke(granted: boolean): void;
  page(attr?: Attribution): void;
  wire(): { vid?: string; ck?: WireClickIds };
};

type Clicks = Record<string, [string, number]> & { _own?: string[] };

const VID = "x3_vid";
const CLK = "x3_clk";
const DAY = 86_400;
const AD_DAYS = 90;

export { readCookie };

let root: string | undefined;

/** Registrable domain via trial cookies ("" = host-only, e.g. localhost; IP hosts reject Domain) */
function rootDomain(): string {
  if (root === undefined) {
    root = "";
    const labels = location.hostname.split(".");
    if (labels.length > 1) {
      for (let i = labels.length - 2; i >= 0 && !root; i--) {
        const candidate = labels.slice(i).join(".");
        writeCookie("x3_t", "1", 1, candidate);
        if (readCookie("x3_t")) {
          writeCookie("x3_t", "", 0, candidate);
          root = candidate;
        }
      }
    }
  }
  return root;
}

function writeCookie(name: string, value: string, days: number, domain = rootDomain()): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${days * DAY}; Path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}${domain ? `; Domain=${domain}` : ""}`;
}

export function createPersist(journeys: () => ClientJourneys | undefined, host: () => string, consent: () => boolean): Persist {
  /** js: JS cookie; proxy: HttpOnly cookie of the first-party proxy; pending: /v1/id asked */
  let mode: string | null = null;

  const clicks = (): Clicks => {
    try {
      return (JSON.parse(readCookie(CLK) || "{}") as Clicks) || {};
    } catch {
      return {};
    }
  };
  const days = () => journeys()?.visitorIdDays ?? 395;
  const ensureVid = () => {
    const vid = readCookie(VID);
    writeCookie(VID, vid && UUID_PATTERN.test(vid) ? vid : uuid(), days());
  };
  const ask = (granted: boolean) =>
    fetch(`${host()}/v1/id`, { method: "POST", credentials: "same-origin", keepalive: true, body: granted ? `{"consent":true,"days":${days()}}` : `{"consent":false}` });

  return {
    grant() {
      if (!journeys()?.visitorId || mode) return;
      mode = "js";
      if (new URL(host(), location.href).origin !== location.origin) return;
      mode = "pending";
      const fallback = () => {
        mode = "js";
        if (consent()) ensureVid();
      };
      ask(true)
        .then((response) => (response.status === 204 && response.headers.get("x-3x-vid") ? (mode = "proxy") : fallback()))
        .catch(fallback);
    },

    revoke(granted) {
      // ad cookies are named "_" + kind (_fbp, _fbc, _ttp)
      for (const name of [VID, CLK, ...(clicks()._own ?? []).map((kind) => `_${kind}`)]) {
        writeCookie(name, "", 0, "");
        writeCookie(name, "", 0);
      }
      if (granted && mode === "proxy") ask(false).catch(() => undefined);
      mode = null;
    },

    page(attr) {
      const j = journeys();
      if (!j || !consent()) return;
      if (j.visitorId && mode === "js") ensureVid();
      const stored = clicks();
      const own = new Set(stored._own);
      const now = Date.now();
      const next: Clicks = {};
      for (const kind of j.clickIds ? CLICK_ID_KEYS : []) {
        const entry = stored[kind];
        const value = attr?.[kind];
        if (value) next[kind] = entry?.[0] === value ? entry : [value, now];
        else if (entry && now - entry[1] < AD_DAYS * DAY * 1000) next[kind] = entry;
      }
      const index = j.fbp || j.ttp ? (rootDomain() || location.hostname).split(".").length - 1 : 0;
      const ensure = (kind: string, on: boolean | undefined, create: string, keep?: (value: string) => boolean) => {
        if (!on) return;
        const value = readCookie(`_${kind}`);
        const fresh = !value || (keep && !keep(value));
        if (fresh) own.add(kind);
        writeCookie(`_${kind}`, fresh ? create : (value as string), AD_DAYS);
      };
      ensure("fbp", j.fbp, `fb.${index}.${now}.${1e9 + Math.floor(Math.random() * 9e9)}`);
      const fbclid = attr?.fbclid;
      if (fbclid) ensure("fbc", j.fbp, `fb.${index}.${now}.${fbclid}`, (value) => value.endsWith(`.${fbclid}`));
      ensure("ttp", j.ttp, uuid().replace(/-/g, "").slice(0, 27));
      if (own.size) next._own = [...own];
      if (Object.keys(next).length) writeCookie(CLK, JSON.stringify(next), AD_DAYS);
      else if (readCookie(CLK)) writeCookie(CLK, "", 0);
    },

    wire() {
      const j = journeys();
      if (!j || !consent()) return {};
      const vid = j.visitorId && mode === "js" ? readCookie(VID) : null;
      const { _own, ...ck } = clicks();
      return { ...(vid && UUID_PATTERN.test(vid) ? { vid } : {}), ...(j.clickIds && Object.keys(ck).length ? { ck } : {}) };
    },
  };
}

/** Tests: forget the detected cookie domain */
export function resetCookieDomain(): void {
  root = undefined;
}
