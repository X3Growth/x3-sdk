import { assignExperiment, clientTargetingMatches, EXPERIMENTS_STALE_AFTER_S, FORCE_PARAM, FORCE_TOKEN_PARAM, parseForceParam, type AssignReason, type ClientConfig, type ClientExperiment, type ClientExperiments, type JsonValue } from "../_core/index.js";
import type { ExperimentInfo, ExperimentsApi } from "../types";
import { guard, uuid } from "./util";

/**
 * Experiments in the browser (EXPERIMENTS.md §6–7): synchronous `variant()` that never throws and
 * returns control while anything is unknown; day/visitor units come from GET /v1/x (the browser
 * never sees a unit), pageload units are hashed locally from an in-memory id. Nothing is stored on
 * the device. Exposures are `experiment_view` events, at most once per pageview and key.
 */

export type ExperimentsHost = {
  config(): ClientConfig | null;
  page(): { host: string; path: string; lang: string | null } | null;
  /** tracking runs and the consent mode allows enrollment (require: only after consent) */
  enrollable(): boolean;
  /** consent granted – the proxy may then forward the consented visitor id (visitor units) */
  consent(): boolean;
  apiHost(): string;
  key(): string;
  emit(props: Record<string, string | number>): void;
  markTest(): void;
  /** records a code call (wire `xc`) on the current pageview and schedules a send */
  call(key: string): void;
};

type Answer = { arm: string; u: string | null; r: AssignReason; p?: Record<string, JsonValue>; v?: string };
export type Experiments = ExperimentsApi & {
  variant(key: string, options?: { expose?: boolean; fallback?: string }): string;
  experiment(key: string): ExperimentInfo;
  expose(key: string): void;
  /** config applied / page changed → request assignments when needed */
  refresh(): void;
  /** a new pageview started */
  pageview(): void;
  reset(): void;
};

const READY_MS = 300;
/** sessionStorage key: QA overrides/token of a test link survive navigation and reloads in this tab */
const PREVIEW_KEY = "x3_xp_qa";

type Preview = { f?: string; t?: string };

/**
 * QA preview from a test link: `?x3_force=` / `?x3_force_t=` in the URL, else what an earlier page of this tab
 * stored (a test link usually opens the home page and the visitor navigates on). Only test links write it
 * (sessionStorage, this tab only); `?x3_force=` with an empty value ends the preview.
 */
function readPreview(search: URLSearchParams): Preview {
  let stored: Preview;
  try {
    stored = JSON.parse(sessionStorage.getItem(PREVIEW_KEY) || "{}") as Preview;
  } catch {
    stored = {};
  }
  const f = search.get(FORCE_PARAM);
  const t = search.get(FORCE_TOKEN_PARAM);
  if (f === null && t === null) return { f: typeof stored.f === "string" ? stored.f : undefined, t: typeof stored.t === "string" ? stored.t : undefined };
  // an empty value ends the whole preview; a new value replaces only its own part
  const next: Preview = f === "" || t === "" ? {} : { f: f ?? stored.f, t: t ?? stored.t };
  try {
    if (next.f || next.t) sessionStorage.setItem(PREVIEW_KEY, JSON.stringify(next));
    else sessionStorage.removeItem(PREVIEW_KEY);
  } catch {
    // storage blocked: the preview still works on this page
  }
  return next;
}

export function createExperiments(host: ExperimentsHost): Experiments {
  const pageload = uuid();
  let answers: Record<string, Answer> = {};
  let fresh: ClientExperiments | null = null;
  let requested = new Set<string>();
  let inflight: Promise<void> | null = null;
  let settled = false;
  const waiters: Array<() => void> = [];
  let exposed = new Set<string>();
  const listeners = new Set<(key: string) => void>();
  const search = typeof location === "undefined" ? new URLSearchParams() : new URLSearchParams(location.search);
  const preview = typeof location === "undefined" ? {} : readPreview(search);
  const overrides = parseForceParam(preview.f ?? null);
  const token = preview.t ?? null;
  const previewing = Object.keys(overrides).length > 0 || !!token;
  if (previewing) host.markTest();
  /** a test link also previews without tracking (opt-out/x3_notrack, consent pending): the page from the URL */
  const urlPage = () => ({ host: location.hostname.toLowerCase(), path: location.pathname || "/", lang: document.documentElement.lang ? document.documentElement.lang.slice(0, 2).toLowerCase() : null });
  let previewRequested = false;
  // assignments rendered on the server (<X3Analytics experiments>) – no /v1/x request needed
  const server = (typeof window === "undefined" ? undefined : (window as Window & { __x3xp?: Record<string, Answer> }).__x3xp) ?? {};
  answers = { ...server };

  const section = (): ClientExperiments | null => fresh ?? host.config()?.experiments ?? null;
  const stale = () => {
    const current = section();
    return !fresh && !!current && Date.now() / 1000 - current.at > EXPERIMENTS_STALE_AFTER_S;
  };
  const notify = (key: string) => {
    for (const listener of listeners) guard(listener)(key);
  };

  const resolve = (key: string): ExperimentInfo => {
    const info = (arm: string, reason: AssignReason, inExperiment = false, params: Record<string, JsonValue> = {}, exposable = false): ExperimentInfo & { exposable: boolean } => ({ key, arm, reason, inExperiment, params, exposable });
    const current = section();
    const retired = current?.retired?.find((entry) => entry.k === key);
    const entry: ClientExperiment | undefined = current?.list.find((candidate) => candidate.key === key);
    const page = host.page();
    const answer = answers[key];
    // a signed QA link may preview a draft that is not in the public config yet
    if (!entry) return answer?.r === "override" ? info(answer.arm, "override", true, answer.p ?? {}, true) : retired ? info(retired.o, "rolled_out") : info("control", "unknown_key");
    const override = overrides[key] ?? (answer?.r === "override" ? answer.arm : undefined);
    if (!page || !host.enrollable()) {
      // test link without tracking: the forced arm is shown, nothing is exposed or counted
      if (previewing && override && entry.arms.some((arm) => arm.k === override)) return info(override, "override", true, entry.arms.find((arm) => arm.k === override)?.p ?? answer?.p ?? {});
      return info("control", page ? "no_consent" : "pending");
    }
    if (stale() && entry.status !== "rolled_out" && !answer) return info("control", "pending");
    if (entry.scope !== "pageload" && (entry.status === "running" || entry.status === "cooldown") && !override) {
      if (!answer) return info("control", settled ? "unit_unavailable" : "pending");
      const params = entry.arms.find((arm) => arm.k === answer.arm)?.p ?? answer.p ?? {};
      return info(answer.arm, answer.r, answer.r === "assigned", params, answer.r === "assigned");
    }
    const result = assignExperiment(entry, pageload, { ...page, server: false }, override);
    // server-only targeting on a pageload unit: the /v1/x answer decides
    if (result.reason === "pending" && answer) return info(answer.arm, answer.r, answer.r === "assigned", answer.p ?? {}, answer.r === "assigned");
    return info(result.arm, result.reason, result.inExperiment, result.params, result.exposable);
  };

  const record = (key: string) => {
    if (section()) host.call(key);
  };
  const settle = () => {
    settled = true;
    for (const done of waiters.splice(0)) done();
  };

  const expose = guard((key: string) => {
    record(key);
    const result = resolve(key) as ExperimentInfo & { exposable?: boolean };
    if (!result.exposable || exposed.has(key)) return;
    exposed.add(key);
    const entry = section()?.list.find((candidate) => candidate.key === key);
    const unit = entry?.scope ?? "day";
    // day/visitor units: the signed receipt of /v1/x and this page view's id go back with the exposure, so
    // X3 can verify the arm even when the daily hash changed after /v1/x (network switch, C36)
    const receipt = unit !== "pageload" && result.reason === "assigned" ? answers[key]?.v : undefined;
    host.emit({ k: key, a: result.arm, r: section()?.rev ?? 0, u: unit, ...(unit === "pageload" || receipt ? { pl: pageload } : {}), ...(receipt ? { v: receipt } : {}) });
  });

  const variant = (key: string, options: { expose?: boolean; fallback?: string } = {}): string => {
    try {
      record(key);
      const result = resolve(key);
      if (result.reason === "unknown_key" && options.fallback) return options.fallback;
      if (options.expose !== false) expose(key);
      return result.arm;
    } catch {
      return options.fallback ?? "control";
    }
  };

  /** GET /v1/x with the page facts (and the QA token); answers merge into `answers`, listeners hear changes */
  const request = (page: { host: string; path: string; lang: string | null }, current: ClientExperiments | null, consented: boolean) => {
    // pl: random id of this page view (memory only) – binds the signed arm receipt of the answer to it
    const query = new URLSearchParams({ h: page.host, p: page.path, cv: String(current?.rev ?? 0), l: page.lang ?? "", t: token ?? "", pl: pageload });
    // channel targeting (server-side): UTM values and which click ids are present – never the ids themselves
    for (const name of ["utm_source", "utm_medium", "utm_campaign", "gclid", "gbraid", "wbraid", "fbclid", "li_fat_id", "ttclid", "msclkid"]) {
      const value = search.get(name);
      if (value) query.set(name, name.startsWith("utm") ? value.slice(0, 100) : "1");
    }
    if (document.referrer) query.set("rh", document.referrer.split("/")[2] ?? "");
    if (consented) query.set("c", "1");
    inflight = fetch(`${host.apiHost()}/v1/x/${host.key()}?${query.toString()}`, { credentials: "omit" })
      .then((response) => (response.ok ? (response.json() as Promise<{ a?: Record<string, Answer>; cfg?: ClientExperiments | null }>) : null))
      .then((body) => {
        if (!body) return;
        if (body.cfg !== undefined) fresh = body.cfg ?? { rev: 0, at: Date.now() / 1000, list: [] };
        const before = answers;
        answers = { ...answers, ...(body.a ?? {}) };
        for (const key of new Set([...Object.keys(before), ...Object.keys(answers)])) if (before[key]?.arm !== answers[key]?.arm) notify(key);
        if (body.cfg !== undefined) for (const entry of fresh?.list ?? []) notify(entry.key);
      })
      .catch(() => undefined)
      .finally(() => {
        inflight = null;
        settle();
      });
  };

  /** /v1/x only when an entry with a server unit matches this page, or the config is stale (C18, C28) */
  const refresh = guard(() => {
    const current = section();
    const page = host.page();
    if (inflight) return;
    if (!page || !host.enrollable()) {
      // test link without tracking (opt-out, x3_notrack, consent pending): one request for the token's arm, no unit, no consent
      if (!token || previewRequested || typeof location === "undefined") return;
      previewRequested = true;
      return request(urlPage(), current, false);
    }
    if (!current && !token) return;
    const wanted = (current?.list ?? []).filter((entry) => (entry.scope !== "pageload" || entry.tgt?.channels || entry.tgt?.devices || entry.tgt?.countries) && (entry.status === "running" || entry.status === "cooldown" || stale()) && clientTargetingMatches(entry.tgt, page) && !requested.has(entry.key));
    if (wanted.length === 0 && !stale() && !token) return settle();
    for (const entry of wanted) requested.add(entry.key);
    request(page, current, host.consent());
  });

  const api: Experiments = {
    variant,
    experiment: (key) => {
      record(key);
      const { exposable: _ignored, ...info } = resolve(key) as ExperimentInfo & { exposable?: boolean };
      return info;
    },
    expose: (key) => void expose(key),
    ready: (timeoutMs = READY_MS) =>
      new Promise<void>((done) => {
        if (settled && !inflight) return done();
        const timer = setTimeout(done, timeoutMs);
        waiters.push(() => {
          clearTimeout(timer);
          done();
        });
      }),
    onChange: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    all: () => Object.fromEntries((section()?.list ?? []).map((entry) => [entry.key, resolve(entry.key).arm])),
    refresh,
    pageview: () => {
      exposed = new Set();
      refresh();
    },
    reset: () => {
      answers = {};
      requested = new Set();
      exposed = new Set();
      fresh = null;
      settle();
    },
  };
  return api;
}
