import type { X3Plugin, X3PluginHost } from "../types";

/**
 * CMP adapters (ARCHITECTURE §14.1, x3.consent.js): translate a consent
 * management platform's state into x3.consent("granted" | "denied").
 * "granted" = the statistics/analytics purpose was accepted; ad cookies are
 * only present when the site's ad pixels were allowed by the same banner.
 * Only the CMP's own JavaScript API and events are used – no storage reads.
 */

export type CmpName = "cookiebot" | "usercentrics" | "complianz" | "borlabs" | "google_consent_mode";
type Report = (state: "granted" | "denied") => void;
type Listen = (target: EventTarget, type: string, listener: (event: Event) => void) => void;
type W = Window & Record<string, unknown>;

const w = () => window as unknown as W;
const call = (fn: unknown, ...args: unknown[]): unknown => (typeof fn === "function" ? (fn as (...a: unknown[]) => unknown)(...args) : undefined);
const asState = (value: unknown): "granted" | "denied" | null => (value === true ? "granted" : value === false ? "denied" : null);

/** Each adapter reads the current state (null = unknown yet) and subscribes to changes */
export const CMP_ADAPTERS: Record<CmpName, { read(): "granted" | "denied" | null; subscribe(listen: Listen, check: () => void, report: Report): void }> = {
  cookiebot: {
    read() {
      const bot = w().Cookiebot as { hasResponse?: boolean; consent?: { statistics?: boolean } } | undefined;
      return bot?.hasResponse ? asState(!!bot.consent?.statistics) : null;
    },
    subscribe(listen, check) {
      for (const type of ["CookiebotOnConsentReady", "CookiebotOnAccept", "CookiebotOnDecline"]) listen(window, type, check);
    },
  },
  usercentrics: {
    read() {
      const ui = w().UC_UI as { isInitialized?: () => boolean; areAllConsentsAccepted?: () => boolean } | undefined;
      if (!ui || call(ui.isInitialized) === false) return null;
      return call(ui.areAllConsentsAccepted) === true ? "granted" : null;
    },
    subscribe(listen, check, report) {
      // v2: detail.type ACCEPT_ALL | DENY_ALL | SAVE; v3: detail.consent.status ALL_ACCEPTED | ALL_DENIED | PARTIAL
      listen(window, "UC_UI_CMP_EVENT", (event) => {
        const type = ((event as CustomEvent).detail as { type?: string } | null)?.type;
        if (type === "ACCEPT_ALL") report("granted");
        else if (type === "DENY_ALL") report("denied");
        else check();
      });
      listen(window, "UC_CONSENT", (event) => {
        const detail = (event as CustomEvent).detail as { consent?: { status?: string }; categories?: Record<string, { state?: string }> } | null;
        const status = detail?.consent?.status;
        const statistics = detail?.categories?.statistics?.state ?? detail?.categories?.marketing?.state;
        if (status === "ALL_ACCEPTED" || statistics === "ALL_ACCEPTED") report("granted");
        else if (status === "ALL_DENIED" || statistics === "ALL_DENIED") report("denied");
      });
    },
  },
  complianz: {
    read() {
      const has = w().cmplz_has_consent;
      return typeof has === "function" ? asState(!!call(has, "statistics")) : null;
    },
    subscribe(listen, check) {
      for (const type of ["cmplz_status_change", "cmplz_enable_category", "cmplz_revoke"]) listen(document, type, check);
    },
  },
  borlabs: {
    read() {
      const borlabs = w().BorlabsCookie as { Consents?: { hasConsentForServiceGroup?: (group: string) => boolean }; checkCookieGroupConsent?: (group: string) => boolean } | undefined;
      if (!borlabs) return null;
      if (borlabs.Consents?.hasConsentForServiceGroup) return asState(!!borlabs.Consents.hasConsentForServiceGroup("statistics"));
      if (borlabs.checkCookieGroupConsent) return asState(!!borlabs.checkCookieGroupConsent("statistics"));
      return null;
    },
    subscribe(listen, check) {
      for (const type of ["borlabs-cookie-consent-saved", "borlabs-cookie-after-init", "borlabs-cookie-code-unblocked-after-consent"]) listen(document, type, check);
    },
  },
  google_consent_mode: {
    read() {
      const layer = w().dataLayer;
      if (!Array.isArray(layer)) return null;
      let state: "granted" | "denied" | null = null;
      for (const entry of layer) {
        const command = entry as ArrayLike<unknown> | null;
        if (!command || typeof command !== "object" || command[0] !== "consent") continue;
        const value = (command[2] as { analytics_storage?: unknown } | undefined)?.analytics_storage;
        if (value === "granted" || value === "denied") state = value;
      }
      return state;
    },
    subscribe(_listen, check) {
      const target = w();
      const layer = (target.dataLayer = Array.isArray(target.dataLayer) ? target.dataLayer : []) as unknown[] & { push: (...items: unknown[]) => number };
      const push = layer.push.bind(layer);
      layer.push = (...items: unknown[]) => {
        const result = push(...items);
        check();
        return result;
      };
    },
  },
};

export function consent(): X3Plugin {
  return {
    name: "consent",
    install(host: X3PluginHost) {
      if (host.api !== 1) return {};
      const names = host.config().consent.cmp.filter((name) => CMP_ADAPTERS[name as CmpName]) as CmpName[];
      let last: "granted" | "denied" | null = null;
      // a confirmed statistics category that names session recording grants the recordings purpose too (wizard step 1)
      const records = (name: CmpName) => !!host.behavior?.().config()?.cmpRecords?.includes(name);
      // the project config (cmpRecords) may arrive after the CMP's first answer: the recordings purpose is re-checked on every report
      let lastRecordings: "granted" | "denied" | null = null;
      const reportFor = (name: CmpName): Report => (state) => {
        if (state !== last) {
          last = state;
          host.setConsent(state);
        }
        if (records(name) && state !== lastRecordings) {
          lastRecordings = state;
          // consent proof of the recordings purpose: this CMP and the time of its decision (§5.5)
          host.behavior().cp = { cmp: name, ts: Date.now() };
          host.behavior().setRecordings(state === "granted" ? "g" : "d");
        }
      };
      const check = () => {
        for (const name of names) {
          const state = CMP_ADAPTERS[name].read();
          if (state) return reportFor(name)(state);
        }
      };
      for (const name of names) CMP_ADAPTERS[name].subscribe(host.listen, check, reportFor(name));
      check();
      // CMPs load asynchronously and do not always fire an event for a stored decision
      for (const delay of [500, 1_500, 4_000]) setTimeout(() => {
        try {
          check();
        } catch {
          // never affect the page
        }
      }, delay);
      return {};
    },
  };
}
