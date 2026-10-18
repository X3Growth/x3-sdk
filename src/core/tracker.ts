import {
  attributionFromParams,
  builtInEvent,
  canonicalPage,
  cleanAttribution,
  cleanLabel,
  cleanRefHost,
  cleanText,
  EVENT_NAME_PATTERN,
  ID_PATTERN,
  IMMEDIATE_CLICK_KINDS,
  KEY_PATTERN,
  LANG_PATTERN,
  normalizeHost,
  notFoundPage,
  NOT_FOUND_META_NAME,
  PROP_KEY_PATTERN,
  SCROLL_MILESTONES,
  storageKeys,
  TAG_PATTERN,
  trimProps,
  UUID_PATTERN,
  validFbCookie,
  VARIANT_PATTERN,
  type Attribution,
  type AttributionOrigin,
  type ClientConfig,
  type CompiledTrackingConfig,
  type NavType,
  type NotFoundVia,
  type PropValue,
  type ScrollMarks,
  type WireAdCookies,
  type WireEvent,
  type WireIdentify,
  type WirePageview,
  type WireSection,
} from "../_core/index.js";
import {
  DATA_ATTRIBUTES,
  LEGACY_DATA_ATTRIBUTES,
  type ConsentState,
  type ConversionOptions,
  type CustomVideoTracker,
  type IdentifyData,
  type MessagingApp,
  type PluginHooks,
  type PluginName,
  type Props,
  type TrackedPageview,
  type VideoOptions,
  type X3Api,
  type X3Ids,
  type X3InitOptions,
  type X3Plugin,
  type X3PluginHost,
} from "../types";
import { classifyClick, downloadPattern, type ClickContext } from "./clicks";
import { createBehavior, type ConsentInput } from "./behavior";
import { compileClient, defaultClientConfig } from "./config";
import { buildBatches, post, type OutboxItem } from "./transport";
import { coerce, guard, pathValue, readCookie, round1, stableId, storageGet, storageSet, uuid } from "./util";
import { CLICK_CONTEXT_MS, CONFIG_WAIT_MS, DEDUPE_WINDOW_MS, EXPIRE_MARGIN_MS, FIRST_FLUSH_DELAY_MS, FLUSH_DEBOUNCE_MS, HEARTBEAT_MS, IDLE_AFTER_MS, LABEL_FORWARD_MS, MAX_AGE_MS, MAX_CUSTOM_PROPS, MAX_CUSTOM_STRING_LENGTH, MAX_ENGAGED_MS, MAX_EVENTS_PER_PAGEVIEW, POPSTATE_WINDOW_MS, RESUME_AFTER_HIDDEN_MS, SESSION_TIMEOUT_MS, TICK_MS } from "./constants";

/**
 * Browser tracker (PARITY §1)
 * onto @3x/core (wire v2, ClientConfig, canonicalPage, trimProps, cleanLabel).
 *
 * Per pageview: fold and scroll depth, engaged time, clicks with a target
 * descriptor, custom/preset events; sections, video, forms, identify hashing,
 * CMP and booking adapters are plugins (bundled in x3.full.js, lazy elsewhere).
 *
 * Privacy (§ 25 TDDDG, ARCHITECTURE §17.1): without consent nothing is read
 * from or written to device storage except the consent key and the explicit
 * opt-out flag. Ids are random and live in memory; consent upgrades to a
 * sessionStorage id, screen/touch, stored first touch and ad cookies.
 */

export type IdentifyApi = { hash(data: IdentifyData, callingCode: string | null): Promise<Omit<WireIdentify, "pv"> | null> };
export type VideoApi = { track(element: HTMLVideoElement, options?: VideoOptions): void; custom(id: string, options?: VideoOptions): CustomVideoTracker };

export type TrackerEnv = {
  /** SDK name@version sent as `lib` */
  lib: string;
  version: string;
  /** host when init() names none */
  defaultHost(): string;
  /** loads a lazy plugin (script tag or dynamic import); plugins must call tracker.register() */
  load?(name: PluginName): void;
};

export type Tracker = X3Api & {
  /** React adapter: deferred stop (StrictMode-safe, TR-06) */
  stop(): void;
  register(plugin: X3Plugin): void;
  /** requests a lazy plugin now (script tag data-plugins) */
  load(name: PluginName): void;
  /** removes listeners and timers (tests, hot reload) */
  destroy(): void;
};

type Pageview = TrackedPageview & {
  fresh: boolean;
  /** location key the pageview belongs to (pathname, plus the hash route with hashRouting) */
  raw: string;
  host: string;
  variant: string | null;
  lang: string | null;
  ref: string | null;
  attrFrom: AttributionOrigin;
  attr: Attribution;
  age: number;
  seq: number;
  vw: number;
  vh: number;
  ph: number;
  sy: number;
  sp: number;
  marks: ScrollMarks;
  eng: number;
  clk: number;
  iclk: number;
  /** next event counter */
  n: number;
  queue: WireEvent[];
  once: Set<string>;
  ident: WireIdentify | null;
  /** signature of the last sent state ("" = never sent) */
  sentSig: string;
};

type Session = { sid: string; fresh: boolean; last: number };

const KEY_FORMAT = /^pk_3x_[0-9A-Za-z]{30}$/;
/** Global Privacy Control: always a stop for behavior signals (B3), a denial for core tracking when the project honours it */
const gpcOn = () => (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
const TEXT_LABEL_SELECTOR = "a,button,summary,[role=button],[role=link]";
const BASE_TARGETS = "a,button,[role=button],[role=link],input,select,textarea,label,summary";
/** queued events across all pageviews that trigger an immediate send – parity */
const FLUSH_EVENT_COUNT = 20;
const POINTERMOVE_THROTTLE_MS = 1_000;
const PRESTART_LIMIT = 50;
const QUIZ_FILL = new Set(["quiz_view", "quiz_contact", "quiz_submit"]);
/** identify()/conversion() promises resolve at the latest after this (lazy plugin blocked, tracker never started) */
const PROMISE_TIMEOUT_MS = 10_000;

type HistoryHook = () => void;
const historyHooks = new Set<HistoryHook>();
let historyPatched = false;

/** History API patch for non-React routers (TR-08 GEN): pushState/replaceState notify every live tracker */
function patchHistory(hook: HistoryHook): void {
  historyHooks.add(hook);
  if (historyPatched) return;
  historyPatched = true;
  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
      const result = original.apply(this, args);
      for (const fn of historyHooks) guard(fn)();
      return result;
    };
  }
}

export function createTracker(env: TrackerEnv): Tracker {
  /* ------------------------------------------------------------ state */
  let options: X3InitOptions | null = null;
  let key = "";
  let host = "";
  let cfg: ClientConfig | null = null;
  let compiled: CompiledTrackingConfig | null = null;
  let clickCtx: ClickContext | null = null;
  /** 404 auto-capture (T5): event switch, meta hint, compiled title rule */
  let notFoundOn = true;
  let notFoundMeta = true;
  let notFoundTitle: RegExp | null = null;
  let ctaSelector = "";
  let keys = storageKeys("x3_");

  let initialized = false;
  let running = false;
  let destroyed = false;
  let started = false;
  /** tracking will not run (opt-out, DNT, consent mode require without consent): queued calls are dropped */
  let blocked = false;
  let consent = false;
  /** GPC (or an explicit denial before consent mode "require") forces denial */
  let consentLocked = false;
  let testTraffic = false;
  let popstateAt = 0;
  let session: Session | null = null;
  let current: Pageview | null = null;
  let currentRaw: string | null = null;
  let afterPersonal = false;
  let expired = false;
  let outbox: Pageview[] = [];

  let lastActivity = 0;
  let lastPointerMove = 0;
  let lastTick = 0;
  let hiddenAt = 0;
  let heartbeatAt = 0;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let firstFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;
  let configTimer: ReturnType<typeof setTimeout> | null = null;
  let scrollFrame = 0;

  const recentEvents = new Map<string, number>();
  let lastClick: { at: number; label?: string; section?: string } | null = null;
  let labelForward: { control: Element; at: number } | null = null;
  let quizVariant: string | undefined;
  const preStart: Array<() => void> = [];
  const pendingPlugins: X3Plugin[] = [];

  const hooks: PluginHooks[] = [];
  const pluginApis = new Map<string, unknown>();
  const pluginWaiters = new Map<string, Array<(api: unknown) => void>>();
  const requested = new Set<string>();
  const listeners = new AbortController();
  const sent: string[] = [];
  /** explicit denial seen (consent journeys plugin deletes its cookies) */
  let denied = false;
  // recordings/heatmaps/live gate + anchor capture (RECORDINGS-HEATMAPS §20.B/C)
  const behavior = createBehavior({ config: () => cfg?.behavior, consent: () => consent, denied: () => denied || consentLocked, hard: () => !running || gpcOn(), test: () => testTraffic, request: (name) => requestPlugin(name), key: () => key });
  hooks.push({ consent: () => behavior.changed() });

  const debug = (message: string) => {
    if (options?.debug) console.warn(`[3x] ${message}`);
  };

  /* ------------------------------------------------------------ helpers */

  const listen = (target: EventTarget, type: string, fn: (event: Event) => void, opts: AddEventListenerOptions = {}) => {
    target.addEventListener(type, guard(fn) as EventListener, { ...opts, signal: listeners.signal });
  };

  /** viewport/scroll/visibility reads allowed (consent mode strict: only after consent) */
  const deviceReads = () => cfg?.consent.mode !== "strict" || consent;

  const age = (pv: TrackedPageview): number => {
    const page = pv as Pageview;
    page.age = Math.max(page.age, Date.now() - page.t0);
    return page.age;
  };

  const attrNames = (name: keyof typeof DATA_ATTRIBUTES): string[] => {
    const legacy = cfg?.legacyTrackAttributes ? LEGACY_DATA_ATTRIBUTES[name] : undefined;
    return legacy ? [DATA_ATTRIBUTES[name], legacy] : [DATA_ATTRIBUTES[name]];
  };
  const attrSelector = (name: keyof typeof DATA_ATTRIBUTES) => attrNames(name).map((attr) => `[${attr}]`).join(",");
  const attrOf = (el: Element, name: keyof typeof DATA_ATTRIBUTES): string | null => {
    for (const attr of attrNames(name)) {
      const value = el.getAttribute(attr);
      if (value !== null) return value;
    }
    return null;
  };

  const routePath = (): string => {
    const { pathname, hash } = window.location;
    return options?.hashRouting && hash.startsWith("#/") ? (hash.slice(1).split("?")[0] ?? "/") : pathname;
  };
  const locationKey = (): string => (options?.hashRouting ? `${window.location.pathname}${window.location.hash.split("?")[0] ?? ""}` : window.location.pathname);

  /**
   * False once the router moved to another path but the current pageview is
   * not finalized yet: the DOM already shows the next page, so its scroll
   * position and sections must not be credited to the outgoing pageview (TR-27).
   */
  const onCurrentPath = () => locationKey() === currentRaw;

  const queuedCount = () => outbox.reduce((sum, pv) => sum + pv.queue.length, 0);

  const readConsentKey = (): ConsentState => {
    const config = cfg?.consent;
    if (!config?.storageKey) return "pending";
    const value = storageGet("localStorage", config.storageKey);
    if (value !== null && config.grantedValues.includes(value)) return "granted";
    if (value !== null && config.deniedValues.includes(value)) return "denied";
    return "pending";
  };

  const saveSession = () => {
    if (!consent || !session) return;
    storageSet("sessionStorage", keys.session, JSON.stringify({ sid: session.sid, last: session.last }));
  };

  /** Session id restored from sessionStorage (consent only, within the timeout) – TR-12 */
  const restoreSession = (): Session | null => {
    if (!consent) return null;
    try {
      const stored = JSON.parse(storageGet("sessionStorage", keys.session) || "null") as { sid?: unknown; last?: unknown } | null;
      if (!stored || typeof stored.sid !== "string" || !UUID_PATTERN.test(stored.sid) || typeof stored.last !== "number") return null;
      if (Date.now() - stored.last > SESSION_TIMEOUT_MS) return null;
      return { sid: stored.sid.toLowerCase(), fresh: false, last: stored.last };
    } catch {
      return null;
    }
  };

  const storedAttribution = (): Attribution => {
    if (!consent || !cfg?.firstTouch.enabled || !compiled) return {};
    try {
      return cleanAttribution(JSON.parse(storageGet("localStorage", keys.attribution) || "null") as Record<string, unknown> | null, compiled.valueRedactions);
    } catch {
      return {};
    }
  };

  const navTypeFromPerformance = (prerendered: boolean): NavType => {
    if (!deviceReads()) return "load";
    if (prerendered) return "prerender";
    try {
      const entry = performance.getEntriesByType("navigation")[0] as (PerformanceNavigationTiming & { activationStart?: number }) | undefined;
      if ((entry?.activationStart ?? 0) > 0) return "prerender";
      if (entry?.type === "reload") return "reload";
      if (entry?.type === "back_forward") return "back_forward";
      if ((entry?.type as string | undefined) === "prerender") return "prerender";
    } catch {
      // Navigation Timing unavailable
    }
    return "load";
  };

  /** _fbp / _fbc / _ttp – read ONLY after consent, shape-checked (CV-05) */
  const adCookies = (): WireAdCookies | undefined => {
    if (!consent) return undefined;
    const out: WireAdCookies = {};
    try {
      for (const kind of ["fbp", "fbc", "ttp"] as const) {
        const valid = validFbCookie(readCookie(`_${kind}`), kind);
        if (valid) out[kind] = valid;
      }
    } catch {
      return undefined;
    }
    return out.fbp || out.fbc || out.ttp ? out : undefined;
  };

  /* ------------------------------------------------------------ events */

  /** Custom event props without a known schema: ≤ 20 keys, scalar values, strings ≤ 200 without e-mail/phone-like text */
  const customProps = (raw: unknown): Props => {
    const out: Props = {};
    if (!raw || typeof raw !== "object") return out;
    let count = 0;
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (count >= MAX_CUSTOM_PROPS) break;
      if (!PROP_KEY_PATTERN.test(name)) continue;
      let clean: PropValue | null = null;
      if (typeof value === "string") clean = cleanText(value, MAX_CUSTOM_STRING_LENGTH);
      else if (typeof value === "number" && Number.isFinite(value)) clean = value;
      else if (typeof value === "boolean") clean = value;
      if (clean === null) continue;
      out[name] = clean;
      count++;
    }
    return out;
  };

  /**
   * Queues an event for a pageview (TR-71…TR-73, TR-79). Drops repeats:
   * once-per-pageview events; within dedupeWindowMs cta_click/whatsapp_click
   * by name (the first, auto-captured one wins), everything else except plain
   * clicks by name + props.
   */
  const emit = (pv: Pageview | null, name: string, raw: object = {}, flushNow = false): WireEvent | null => {
    if (!pv || pv.n >= MAX_EVENTS_PER_PAGEVIEW) return null;
    const definition = builtInEvent(name);
    let props: Props | null;
    if (definition) {
      props = trimProps(definition, raw);
      if (!props) return null;
      if (definition.preset === "quiz") {
        if (typeof props.variant === "string") quizVariant = props.variant;
        else if (quizVariant && QUIZ_FILL.has(name)) props.variant = quizVariant;
      }
    } else {
      if (!EVENT_NAME_PATTERN.test(name)) {
        debug(`invalid event name "${name}"`);
        return null;
      }
      props = customProps(raw);
    }
    const mode = definition?.dedupe ?? "name_props";
    const dedupeKey = mode === "name" ? name : `${name}|${JSON.stringify(props)}`;
    const now = Date.now();
    // every click is a separate user action, so only derived signals are deduplicated
    if (mode !== "none" && now - (recentEvents.get(dedupeKey) ?? -Infinity) < DEDUPE_WINDOW_MS) return null;
    if (definition?.oncePerPageview) {
      if (pv.once.has(name)) return null;
      pv.once.add(name);
    }
    if (mode !== "none") recentEvents.set(dedupeKey, now);
    if (recentEvents.size > 50) {
      for (const [entry, at] of recentEvents) if (now - at >= DEDUPE_WINDOW_MS) recentEvents.delete(entry);
    }
    const event: WireEvent = { pv: pv.id, n: pv.n++, t: Math.round(age(pv)), e: name };
    if (Object.keys(props).length) event.p = props;
    pv.queue.push(event);
    behavior.bind(name, event);
    if (flushNow || definition?.flush || queuedCount() >= FLUSH_EVENT_COUNT) flush();
    else flushTimer ??= setTimeout(guard(flush), FLUSH_DEBOUNCE_MS);
    return event;
  };

  /** Calls made before the first pageview (config still loading) are replayed once it starts */
  const whenStarted = (fn: () => void) => {
    if (started || blocked) fn();
    else if (preStart.length < PRESTART_LIMIT) preStart.push(fn);
  };

  const drain = () => {
    for (const fn of preStart.splice(0)) guard(fn)();
  };

  /** start() decided not to track: calls waiting for the first pageview resolve as no-ops */
  const block = (reason: string) => {
    debug(reason);
    blocked = true;
    drain();
  };

  const recentClick = (): { label?: string; section?: string } => {
    if (!lastClick || Date.now() - lastClick.at > CLICK_CONTEXT_MS) return {};
    return { label: lastClick.label, section: lastClick.section };
  };

  /* ------------------------------------------------------------ plugins */

  const withPlugin = <T>(name: PluginName, fn: (api: T) => void) => {
    if (pluginApis.has(name)) {
      fn(pluginApis.get(name) as T);
      return;
    }
    const waiters = pluginWaiters.get(name) ?? [];
    if (waiters.length < PRESTART_LIMIT) waiters.push(fn as (api: unknown) => void);
    pluginWaiters.set(name, waiters);
    requestPlugin(name);
  };

  const requestPlugin = (name: PluginName) => {
    if (pluginApis.has(name) || requested.has(name) || !env.load) return;
    requested.add(name);
    try {
      env.load(name);
    } catch {
      debug(`plugin ${name} could not be loaded`);
    }
  };

  const hostApi: X3PluginHost = {
    api: 1,
    emit: (name, props, opts) => emit(current, name, props, opts?.flush),
    flush: () => flush(),
    current: () => current,
    age,
    hook: (hook) => {
      hooks.push(hook);
      if (current) guard(() => hook.begin?.(current as Pageview))();
    },
    markActivity: () => markActivity(),
    config: () => cfg as ClientConfig,
    attrs: attrNames,
    attr: attrOf,
    selector: attrSelector,
    stableId,
    autocapture: (feature) => !!cfg?.plugins[feature] && options?.autocapture?.[feature] !== false,
    deviceReads,
    consent: () => consent,
    consentDenied: () => denied,
    apiHost: () => host,
    behavior: () => behavior.bridge,
    setConsent: (state) => setConsent(state),
    optOut: () => optOut(),
    listen,
    debug,
  };

  const register = guard((plugin: X3Plugin) => {
    if (destroyed || pluginApis.has(plugin.name)) return;
    // plugins read the config while installing: wait until it is applied
    if (!cfg) return void pendingPlugins.push(plugin);
    const api = plugin.install(hostApi) ?? {};
    pluginApis.set(plugin.name, api);
    const waiters = pluginWaiters.get(plugin.name) ?? [];
    pluginWaiters.delete(plugin.name);
    for (const waiter of waiters) guard(waiter)(api);
  });

  const runHooks = <K extends keyof PluginHooks>(name: K, ...args: Parameters<NonNullable<PluginHooks[K]>>) => {
    for (const hook of hooks) {
      const fn = hook[name] as ((...a: unknown[]) => unknown) | undefined;
      if (fn) guard(fn)(...args);
    }
  };

  /* ------------------------------------------------------------ scroll and fold */

  const sample = () => {
    const pv = current;
    if (!pv || !onCurrentPath() || !deviceReads()) return;
    const root = document.documentElement;
    const height = Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0);
    const viewport = window.innerHeight;
    if (!pv.vh) pv.vh = viewport;
    pv.vw = window.innerWidth;
    if (options?.autocapture?.scroll !== false) {
      const y = Math.max(0, window.scrollY);
      pv.ph = Math.max(pv.ph, height);
      pv.sy = Math.max(pv.sy, Math.round(y));
      if (height > 0) pv.sp = Math.max(pv.sp, Math.min(100, Math.round(((y + viewport) / height) * 100)));
      const t = age(pv);
      for (const milestone of SCROLL_MILESTONES) {
        if (pv.sp >= milestone && pv.marks[`${milestone}`] === undefined) pv.marks[`${milestone}`] = t;
      }
    }
    runHooks("sample", pv);
  };

  const onScroll = () => {
    markActivity();
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(
      guard(() => {
        scrollFrame = 0;
        sample();
      }),
    );
  };

  /* ------------------------------------------------------------ engagement clock */

  const markActivity = () => {
    lastActivity = Date.now();
    if (expired && !current) begin("resume", true);
  };

  /** Adds the time since the last tick to engaged time; plugins accrue section time (TR-33, TR-35) */
  const accrue = () => {
    const now = performance.now();
    const delta = Math.min(2_000, Math.max(0, now - lastTick));
    lastTick = now;
    const pv = current;
    if (!pv || !deviceReads() || document.visibilityState !== "visible") return;
    if (options?.autocapture?.engagement !== false) {
      const media = hooks.some((hook) => hook.active && guard(hook.active)(pv));
      if (Date.now() - lastActivity < IDLE_AFTER_MS || media) pv.eng = Math.min(MAX_ENGAGED_MS, pv.eng + delta);
    }
    runHooks("tick", pv, delta);
  };

  const tick = () => {
    const pv = current;
    if (!pv) return;
    accrue();
    sample();
    const now = Date.now();
    if (now - pv.t0 > MAX_AGE_MS - EXPIRE_MARGIN_MS) {
      finalize();
      pause();
      expired = true;
      return;
    }
    if (document.visibilityState === "visible" && now - heartbeatAt >= HEARTBEAT_MS) {
      heartbeatAt = now;
      flush();
    }
  };

  /* ------------------------------------------------------------ clicks */

  /** data-x3-label > stable id > aria-label > visible text (interactive elements only) – TR-42 */
  const labelOf = (el: Element, allowText: boolean): string | undefined => {
    if ((el as HTMLElement).isContentEditable) return undefined;
    for (const candidate of [attrOf(el, "label"), stableId(el), el.getAttribute("aria-label")]) {
      const label = cleanLabel(candidate);
      if (label) return label;
    }
    if (allowText && el.matches(TEXT_LABEL_SELECTOR)) return cleanLabel((el.textContent ?? "").slice(0, 300)) ?? undefined;
    return undefined;
  };

  /** Nearest tracked section (sections plugin), else the nearest data-x3-section value */
  const sectionOf = (el: Element, personal: boolean): string | undefined => {
    for (const hook of hooks) {
      if (!hook.sectionOf) continue;
      const name = guard(hook.sectionOf)(el);
      if (name) return name;
    }
    if (personal) return undefined;
    const marked = el.closest(attrSelector("section"));
    const value = marked ? attrOf(marked, "section") : null;
    return value && ID_PATTERN.test(value) ? value : undefined;
  };

  const onClick = (event: Event) => {
    markActivity();
    const pv = current;
    if (!pv || !clickCtx) return;
    const raw = event.target;
    const origin = raw instanceof Element ? raw : raw instanceof Node ? raw.parentElement : null;
    if (!origin) return;
    // a click on a <label> makes the browser click its control as well: that second click is not counted (TR-44)
    const forwarded = labelForward;
    labelForward = null;
    if (forwarded && forwarded.control === origin && Date.now() - forwarded.at < LABEL_FORWARD_MS) return;
    const control = origin.closest("label")?.control;
    if (control && control !== origin && !control.contains(origin)) labelForward = { control, at: Date.now() };

    const target = origin.closest(clickCtx.targets) ?? origin;
    const tag = target.tagName.toLowerCase().slice(0, 20);
    const { kind, href, app, ext } = classifyClick(target, tag, clickCtx);
    const labelsAllowed = !pv.personal && !origin.closest(attrSelector("ignore"));
    const label = labelsAllowed && kind !== "form" ? labelOf(target, kind !== "other") : undefined;
    const section = sectionOf(origin, pv.personal);
    const mouse = event as MouseEvent;
    let y: number | undefined;
    // keyboard activation has no pointer position; strict consent mode: no page geometry before consent
    if ((mouse.clientX || mouse.clientY) && deviceReads()) {
      y = Math.min(100, Math.max(0, Math.round((mouse.pageY / Math.max(document.documentElement.scrollHeight, 1)) * 100)));
    }

    pv.clk++;
    if (kind !== "other") pv.iclk++;
    behavior.arm(target, mouse);
    emit(pv, "click", { kind, tag: TAG_PATTERN.test(tag) ? tag : "unknown", label, href, section, y, ext });
    lastClick = { at: Date.now(), label, section };

    const cta = pv.notFound || !ctaSelector ? null : origin.closest(ctaSelector);
    if (cta) emit(pv, "cta_click", { label: labelsAllowed ? labelOf(cta, true) : undefined, section });
    if (kind === "whatsapp") emit(pv, "whatsapp_click", { section });
    if (kind === "messaging") emit(pv, "messaging_click", { app, section });

    const custom = origin.closest(`[${DATA_ATTRIBUTES.event}]`);
    const name = custom?.getAttribute(DATA_ATTRIBUTES.event);
    if (custom && name) {
      const props: Props = {};
      for (const attribute of Array.from(custom.attributes)) {
        if (attribute.name.startsWith(DATA_ATTRIBUTES.propPrefix)) {
          props[attribute.name.slice(DATA_ATTRIBUTES.propPrefix.length).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = coerce(attribute.value);
        }
      }
      emit(pv, name, props);
    }
    if (IMMEDIATE_CLICK_KINDS.includes(kind)) flush();
  };

  /* ------------------------------------------------------------ consent */

  const setConsent = (state: "granted" | "denied") => {
    if (state === "granted" && consentLocked) return;
    if (state === "granted") {
      const before = consent;
      consent = true;
      saveSession();
      denied = false;
      // consent-gated journey persistence (x3.journeys.js) is only downloaded on a consent decision
      if (cfg?.journeys) requestPlugin("journeys");
      if (!before) runHooks("consent", true, false);
      if (!running && initialized && cfg?.consent.mode === "require") start();
      else if (!before && current) {
        runHooks("reads", current);
        sample();
      }
      return;
    }
    const wasGranted = consent;
    consent = false;
    storageSet("sessionStorage", keys.session, null);
    denied = true;
    if (cfg?.journeys) requestPlugin("journeys");
    runHooks("consent", false, wasGranted);
    if (cfg?.consent.mode === "require" && wasGranted && running) {
      halt();
      blocked = true;
    }
  };

  const consentFromEvent = (event: Event) => {
    const config = cfg?.consent.windowEvent;
    if (!config) return;
    const value = pathValue((event as CustomEvent<unknown>).detail, config.detailPath);
    const text = typeof value === "boolean" ? String(value) : value;
    if (typeof text !== "string") return;
    if (config.grantedValues.includes(text)) setConsent("granted");
    else if (config.deniedValues.includes(text)) setConsent("denied");
  };

  /* ------------------------------------------------------------ window signals */

  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      accrue();
      hiddenAt = Date.now();
      flush();
      return;
    }
    lastTick = performance.now();
    const longHidden = hiddenAt > 0 && Date.now() - hiddenAt > RESUME_AFTER_HIDDEN_MS;
    hiddenAt = 0;
    lastActivity = Date.now();
    if (longHidden && (current || expired)) {
      // long-lived tab: a new visit starts with a new session id (TR-13)
      session = null;
      begin("resume", true);
    }
  };

  const onPageHide = () => {
    accrue();
    if (current) runHooks("hide", current);
    flush();
  };

  /** bfcache restore (TR-14). A long-hidden tab may already have started a "resume" pageview in onVisibility. */
  const onPageShow = (event: Event) => {
    if (!(event as PageTransitionEvent).persisted || (current && Date.now() - current.t0 < 1_000)) return;
    if (hiddenAt > 0 && Date.now() - hiddenAt > RESUME_AFTER_HIDDEN_MS) session = null;
    hiddenAt = 0;
    begin("back_forward", true);
  };

  /* ------------------------------------------------------------ sending */

  /** Cumulative pageview state; `bump` increments seq (every send does) – TR-83 */
  const wireState = (pv: Pageview, bump: boolean): WirePageview => {
    if (bump) pv.seq++;
    const sec: Record<string, WireSection> = {};
    for (const [name, [first, visible]] of Object.entries(pv.sec)) sec[name] = [Math.round(first), Math.round(visible)];
    return {
      id: pv.id,
      seq: pv.seq,
      age: Math.round(age(pv)),
      nav: pv.nav,
      host: pv.host,
      path: pv.path,
      variant: pv.variant,
      lang: pv.lang,
      ref: pv.ref,
      attrFrom: pv.attrFrom,
      attr: pv.attr,
      vw: pv.vw,
      vh: pv.vh,
      // device properties beyond the viewport only after consent (TR-25)
      sw: consent && deviceReads() ? window.screen.width : pv.vw,
      tp: consent ? navigator.maxTouchPoints > 0 : false,
      ph: pv.ph,
      sy: pv.sy,
      sp: pv.sp,
      marks: { ...pv.marks },
      sec,
      eng: Math.round(pv.eng),
      clk: pv.clk,
      iclk: pv.iclk,
      vids: pv.vids.map((video) => ({ ...video, t: Math.round(video.t), dur: round1(video.dur), ws: Math.round(video.ws), mp: Math.round(video.mp), r: video.r.map(([from, to]): [number, number] => [from, to]) })),
      ...behavior.pageview(pv.id),
    };
  };

  // the consent flag is part of the signature: an upgrade re-sends the state with screen/touch and the fold (strict mode)
  const signature = (pv: Pageview): string =>
    [
      consent ? 1 : 0,
      Math.round(pv.eng / 1000),
      pv.sp,
      pv.sy,
      pv.ph,
      pv.clk,
      pv.iclk,
      Object.entries(pv.sec)
        .map(([name, [, visible]]) => `${name}:${Math.round(visible / 1000)}`)
        .join(","),
      pv.vids.map((video) => `${Math.round(video.ws)}${video.done ? "e" : ""}`).join(","),
      JSON.stringify(behavior.pageview(pv.id)),
    ].join("|");

  const send = (body: string) => {
    if (options?.debug) {
      sent.push(body);
      if (sent.length > 20) sent.shift();
    }
    post(`${host}/v1/e`, body);
  };

  /**
   * Sends every pageview whose state changed or that has queued events or an
   * identify, then forgets finalized pageviews (TR-83…TR-85). Hidden/pagehide/
   * heartbeat use the same path, so an unchanged pageview never produces a
   * duplicate beacon.
   */
  const flush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (!cfg) return;
    behavior.finalize();
    if (current) {
      lateNotFound(current);
      sample();
    }
    const now = Date.now();
    const groups = new Map<string, Pageview[]>();
    for (const pv of outbox) {
      if (now - pv.t0 > MAX_AGE_MS) continue;
      const sig = signature(pv);
      if (!pv.queue.length && !pv.ident && sig === pv.sentSig) continue;
      pv.sentSig = sig;
      const group = groups.get(pv.sid);
      if (group) group.push(pv);
      else groups.set(pv.sid, [pv]);
    }
    outbox = current ? [current] : [];
    if (!groups.size) return;
    const cookies = adCookies();
    const ids = (pluginApis.get("journeys") as { wire?(): object } | undefined)?.wire?.();
    for (const [sid, group] of groups) {
      const items: OutboxItem[] = group.map((pv) => {
        const item: OutboxItem = { state: () => wireState(pv, true), events: pv.queue, identify: pv.ident };
        pv.queue = [];
        pv.ident = null;
        return item;
      });
      const envelope = { k: key, sid, fresh: group[0]?.fresh ?? false, consent, test: testTraffic, cv: cfg.rev, lib: env.lib, ac: cookies, ...ids, ...behavior.envelope() };
      for (const body of buildBatches(envelope, items)) send(body);
    }
    heartbeatAt = now;
    if (session && groups.has(session.sid)) {
      session.last = now;
      saveSession();
    }
  };

  /* ------------------------------------------------------------ lifecycle */

  const startClock = () => {
    lastTick = performance.now();
    tickTimer ??= setInterval(guard(tick), TICK_MS);
  };

  const pause = () => {
    current = null;
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    if (firstFlushTimer) clearTimeout(firstFlushTimer);
    firstFlushTimer = null;
  };

  /** Ends the current pageview: last engagement delta, final state + events sent */
  const finalize = () => {
    if (!current) return;
    accrue();
    sample();
    runHooks("end", current);
    current = null;
    flush();
  };

  /**
   * Starts a pageview for the current location (TR-05). `force` starts a new
   * pageview for the same path (bfcache restore, resume, manual page()).
   */
  /**
   * Not-found page (T5): the marker attribute always counts (TR-21); with 404 auto-capture on also
   * <meta name="x3-status" content="404"> and the project's title rule. Reads only the DOM.
   */
  const detectNotFound = (): NotFoundVia | null => {
    if (!cfg) return null;
    if (document.querySelector(`[${cfg.notFound.markerAttr}],[${DATA_ATTRIBUTES.notFound}]`)) return "marker";
    if (notFoundMeta && document.querySelector(`meta[name="${NOT_FOUND_META_NAME}"][content="404"]`)) return "meta";
    if (notFoundTitle?.test(document.title)) return "title";
    return null;
  };

  /**
   * Routers render the not-found view (and set its title) after the navigation: checked again
   * after the commit and before the first send – only while the pageview was never sent.
   */
  const lateNotFound = (pv: Pageview) => {
    if (pv.notFound || pv.seq > 0 || pv.personal || current !== pv || !cfg || !compiled || !notFoundOn) return;
    const via = detectNotFound();
    const page = via ? canonicalPage(pv.host, notFoundPage(pv.path, cfg.notFound.path, compiled), compiled) : null;
    if (!via || !page || page.personal) return;
    emit(pv, "not_found", { path: pv.path, via });
    pv.path = page.page;
    pv.notFound = true;
  };

  const begin = (nav: NavType, force: boolean, pathOverride?: string) => {
    if (!running || !cfg || !compiled) return;
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = null;
    const raw = locationKey();
    if (!force && raw === currentRaw) return;
    // router navigation from the browser's back/forward buttons: the browser restores the old
    // scroll position, so it is reported like a full back_forward load (TR-29)
    const routed = nav === "spa";
    if (routed && Date.now() - popstateAt < POPSTATE_WINDOW_MS) nav = "back_forward";
    popstateAt = 0;
    // the outgoing pageview keeps its last sample: sample() skips it once the path changed
    finalize();
    pause();
    currentRaw = raw;
    expired = false;

    const hostname = normalizeHost(window.location.hostname);
    const via = detectNotFound();
    const notFound = via !== null;
    let target = canonicalPage(hostname, pathOverride ?? routePath(), compiled);
    const requested = target;
    if (target && notFound) target = canonicalPage(hostname, notFoundPage(target.page, cfg.notFound.path, compiled), compiled);
    if (!target) return;

    const now = Date.now();
    let sid: string;
    let fresh: boolean;
    if (target.personal) {
      // isolated: throwaway id, never stored, never linked (TR-16)
      sid = uuid();
      fresh = false;
      afterPersonal = true;
    } else {
      if (!session || afterPersonal || now - session.last > SESSION_TIMEOUT_MS) {
        session = { sid: uuid(), fresh: !afterPersonal, last: now };
      }
      afterPersonal = false;
      ({ sid, fresh } = session);
    }

    const params = new URLSearchParams(window.location.search);
    if (cfg.testParams.some((param) => params.get(param) === "1")) testTraffic = true;
    let attrFrom: AttributionOrigin = "none";
    let attr: Attribution = {};
    if (!target.personal) {
      attr = attributionFromParams(params, compiled.valueRedactions);
      if (Object.keys(attr).length) {
        attrFrom = "url";
        // first touch is remembered only after consent (ARCHITECTURE §10.1)
        if (consent && cfg.firstTouch.enabled) {
          storageSet("localStorage", keys.attribution, JSON.stringify({ ...attr, landing_page: target.page, first_touch_at: new Date(now).toISOString() }));
        }
      } else {
        attr = storedAttribution();
        if (Object.keys(attr).length) attrFrom = "stored";
      }
    }
    const variant = cfg.variantParam ? params.get(cfg.variantParam) : null;
    const lang = (document.documentElement.lang || "").slice(0, 2).toLowerCase();
    const pv: Pageview = {
      id: uuid(),
      sid,
      fresh,
      raw,
      personal: target.personal,
      notFound,
      nav,
      host: hostname,
      path: target.page,
      variant: variant && VARIANT_PATTERN.test(variant) ? variant : null,
      lang: LANG_PATTERN.test(lang) ? lang : null,
      ref: target.personal || routed || nav === "resume" ? null : cleanRefHost(document.referrer),
      attrFrom,
      attr,
      t0: now,
      age: 0,
      seq: 0,
      vw: 0,
      vh: 0,
      ph: 0,
      sy: 0,
      sp: 0,
      marks: {},
      sec: {},
      eng: 0,
      clk: 0,
      iclk: 0,
      vids: [],
      n: 0,
      queue: [],
      once: new Set(),
      ident: null,
      sentSig: "",
    };
    current = pv;
    outbox.push(pv);
    lastActivity = now;
    heartbeatAt = now;
    // 404 auto-capture (T5): the requested path – the pageview itself is reported under notFound.path
    if (via && notFoundOn && requested && !requested.personal && !target.personal) emit(pv, "not_found", { path: requested.page, via });

    sample();
    if (nav === "spa") {
      // routers scroll to the top after the commit: the fold sample of a client navigation is taken once that happened (TR-28)
      requestAnimationFrame(() =>
        requestAnimationFrame(
          guard(() => {
            if (current !== pv) return;
            pv.sy = 0;
            pv.sp = 0;
            pv.marks = {};
            sample();
            lateNotFound(pv);
          }),
        ),
      );
    }
    runHooks("begin", pv);
    startClock();
    firstFlushTimer = setTimeout(guard(flush), FIRST_FLUSH_DELAY_MS);
    if (!started) {
      started = true;
      drain();
    }
  };

  /** Stops tracking (opt-out, consent revoked in mode require); listeners stay, begin() is a no-op */
  const halt = () => {
    finalize();
    pause();
    running = false;
    started = false;
    currentRaw = null;
    // recording, live and heat plugins re-check their gate now (opt-out stops every signal at once, §4.7)
    behavior.changed();
  };

  /** Route change (history patch, popstate, hashchange): handled after the router rendered */
  const onRoute = () => {
    if (options?.autocapture?.pageviews === false) return;
    setTimeout(
      guard(() => begin("spa", false)),
      0,
    );
  };

  const run = (prerendered: boolean) => {
    if (running || destroyed) return;
    running = true;
    blocked = false;
    session = restoreSession() ?? { sid: uuid(), fresh: true, last: Date.now() };
    if (options?.autocapture?.pageviews === false) {
      // manual pageviews only: page() starts them
      started = true;
      drain();
      return;
    }
    begin(navTypeFromPerformance(prerendered), true);
  };

  /** Opt-out, DNT and consent mode decide whether tracking runs; then the first pageview starts */
  const start = () => {
    if (!cfg || running || destroyed) return;
    const notrack = new URLSearchParams(window.location.search).get(cfg.notrackParam);
    if (notrack === "1") storageSet("localStorage", keys.notrack, "1");
    if (notrack === "0") storageSet("localStorage", keys.notrack, null);
    if (storageGet("localStorage", keys.notrack) === "1") return block("opted out");
    // device marked internal (?x3_internal=1, undo with =0): its visits count as test traffic (AC: relaxed masking for internal sessions)
    const internal = new URLSearchParams(window.location.search).get("x3_internal");
    if (internal === "1") storageSet("localStorage", keys.internal, "1");
    if (internal === "0") storageSet("localStorage", keys.internal, null);
    if (storageGet("localStorage", keys.internal) === "1") testTraffic = true;
    if ((options?.respectDoNotTrack || cfg.consent.respectDoNotTrack) && navigator.doNotTrack === "1") return block("Do Not Track");
    if (cfg.consent.mode === "require" && !consent) return block("waiting for consent");
    const doc = document as Document & { prerendering?: boolean };
    if (doc.prerendering) {
      listen(doc, "prerenderingchange", () => run(true), { once: true });
      return;
    }
    run(false);
  };

  const setupListeners = () => {
    const passive = { passive: true, capture: true };
    if (options?.autocapture?.clicks !== false) listen(document, "click", onClick, { capture: true });
    for (const type of ["pointerdown", "keydown", "touchstart", "wheel"]) listen(document, type, markActivity, passive);
    listen(
      document,
      "pointermove",
      () => {
        const now = Date.now();
        if (now - lastPointerMove < POINTERMOVE_THROTTLE_MS) return;
        lastPointerMove = now;
        markActivity();
      },
      passive,
    );
    listen(window, "scroll", onScroll, { passive: true });
    listen(window, "resize", onScroll, { passive: true });
    listen(document, "visibilitychange", onVisibility);
    listen(window, "pagehide", onPageHide);
    listen(window, "pageshow", onPageShow);
    listen(window, "popstate", () => {
      popstateAt = Date.now();
      onRoute();
    });
    if (options?.hashRouting) listen(window, "hashchange", onRoute);
    patchHistory(routeHook);
    const windowEvent = cfg?.consent.windowEvent;
    if (windowEvent) listen(window, windowEvent.name, consentFromEvent);
  };
  const routeHook = () => {
    if (!destroyed) onRoute();
  };

  /** Applies the client config (inline, init option, fetched, or defaults after configWaitMs) */
  const applyConfig = (config: ClientConfig) => {
    if (cfg || destroyed) return;
    if (configTimer) clearTimeout(configTimer);
    const fallback = defaultConfig();
    let next: ClientConfig = { ...fallback, ...config, consent: { ...fallback.consent, ...config.consent } };
    try {
      compiled = compileClient(next);
    } catch {
      next = fallback;
      compiled = compileClient(next);
    }
    cfg = next;
    keys = storageKeys(next.storagePrefix);
    const validSelectors = [attrSelector("cta"), ...next.cta.selectors].filter((selector) => {
      try {
        document.createDocumentFragment().querySelector(selector);
        return true;
      } catch {
        return false;
      }
    });
    ctaSelector = validSelectors.join(",");
    const auto = options?.autocapture ?? {};
    // auto-capture switches of the project (T5); init({autocapture}) can only switch them off
    const ac = next.autoCapture ?? fallback.autoCapture!;
    notFoundOn = ac.notFound.enabled && auto.notFound !== false;
    notFoundMeta = notFoundOn && ac.notFound.meta;
    try {
      notFoundTitle = notFoundOn && ac.notFound.titlePattern ? new RegExp(ac.notFound.titlePattern, "i") : null;
    } catch {
      debug("invalid notFound.titlePattern");
    }
    clickCtx = {
      config: compiled,
      whatsapp: next.messaging.whatsapp,
      apps: next.messaging.apps,
      downloads: downloadPattern(next.downloads.extensions),
      outbound: ac.outboundLinks && auto.outboundLinks !== false,
      fileDownloads: ac.fileDownloads && auto.downloads !== false,
      targets: `${BASE_TARGETS},${attrSelector("label")},[${DATA_ATTRIBUTES.event}]`,
    };

    // consent: GPC is a denial; then explicit init option, the banner's storage key, CMP adapters later
    if (next.consent.respectGlobalPrivacyControl && gpcOn()) {
      consentLocked = true;
      // x3.consent("granted") before the config arrived does not override GPC
      consent = false;
    }
    const initial = options?.consent && options.consent !== "pending" ? options.consent : readConsentKey();
    if (initial !== "pending") setConsent(initial);

    setupListeners();
    for (const plugin of pendingPlugins.splice(0)) register(plugin);
    if (next.consent.cmp.length) requestPlugin("consent");
    if (next.plugins.sections && auto.sections !== false) requestPlugin("sections");
    if (next.plugins.video && auto.video !== false) requestPlugin("video");
    if (next.plugins.forms && auto.forms !== false) requestPlugin("forms");
    if (next.bookings.length || next.bridges.length) requestPlugin("bookings");
    if (options?.debug) exposeDebug();
    start();
    behavior.changed();
  };

  const defaultConfig = (): ClientConfig => defaultClientConfig(normalizeHost(window.location.hostname) || "localhost");

  const loadConfig = () => {
    const inline = options?.config ?? (window as Window & { __x3cfg?: ClientConfig }).__x3cfg;
    if (inline && typeof inline === "object") return applyConfig(inline);
    configTimer = setTimeout(
      guard(() => applyConfig(defaultConfig())),
      CONFIG_WAIT_MS,
    );
    // Leaving (or hiding) the page before the config arrived: start with the defaults right away – what
    // the timer above would do later – so the first pageview and queued calls go out with the unload
    // flush instead of being lost. Listeners added by applyConfig() do not see the event being dispatched.
    const leaving = (event: Event) => {
      if (cfg || (event.type === "visibilitychange" && document.visibilityState !== "hidden")) return;
      applyConfig(defaultConfig());
      // the page was shown since the navigation started, not since now: the server dates the pageview (and
      // orders it before the next page's) by its age
      if (current && current.seq === 0) current.t0 = Math.min(current.t0, Date.now() - Math.max(0, performance.now()));
      if (event.type === "pagehide") onPageHide();
      else onVisibility();
    };
    listen(window, "pagehide", leaving);
    listen(document, "visibilitychange", leaving);
    try {
      fetch(`${host}/v1/c/${key}`, { credentials: "omit" })
        .then((response) => (response.ok ? (response.json() as Promise<ClientConfig>) : null))
        .then((config) => (config && typeof config === "object" ? applyConfig(config) : undefined))
        .catch(() => undefined);
    } catch {
      // the timer applies the defaults
    }
  };

  const exposeDebug = () => {
    (window as Window & { __x3?: unknown }).__x3 = {
      get state() {
        return {
          session,
          consent,
          test: testTraffic,
          running,
          config: cfg,
          current: current ? wireState(current, false) : null,
          queued: queuedCount(),
          plugins: [...pluginApis.keys()],
        };
      },
      sent,
      flushNow: guard(flush),
    };
  };

  /* ------------------------------------------------------------ public API */

  const init = guard((init: X3InitOptions) => {
    if (typeof window === "undefined" || destroyed) return;
    if (initialized) {
      // second call (React remount, SPA effect) behaves like a route change (TR-01) and cancels a pending stop (TR-06)
      begin("spa", false);
      return;
    }
    if (!init || typeof init.key !== "string" || !KEY_FORMAT.test(init.key)) {
      console.warn("[3x] init: invalid publishable key");
      return;
    }
    initialized = true;
    options = init;
    key = init.key;
    host = (init.host ?? env.defaultHost()).replace(/\/+$/, "");
    if (init.test) testTraffic = true;
    try {
      if (window.top !== window.self) return;
    } catch {
      return;
    }
    if (navigator.webdriver) return;
    for (const plugin of init.plugins ?? []) register(plugin);
    loadConfig();
  });

  const stop = guard(() => {
    if (!running || stopTimer) return;
    // deferred by a macrotask: React StrictMode unmounts and remounts synchronously,
    // and the remount's init() cancels the pending stop instead of splitting the pageview (TR-06)
    stopTimer = setTimeout(
      guard(() => {
        stopTimer = null;
        finalize();
        pause();
        currentRaw = null;
        expired = false;
      }),
      0,
    );
  });

  const track = guard((name: string, props?: Props, opts?: { flush?: boolean }) => {
    whenStarted(() => emit(current, name, props ?? {}, opts?.flush));
  });

  /**
   * Runs `fn` for a promise-returning API call: errors resolve with `fallback`,
   * and so does a lazy plugin that never arrives (blocked script) after
   * PROMISE_TIMEOUT_MS – awaiting page code must never hang on tracking.
   */
  const settled = <T>(resolve: (value: T) => void, fallback: T, fn: () => void) => {
    setTimeout(() => resolve(fallback), PROMISE_TIMEOUT_MS);
    return () => {
      try {
        fn();
      } catch {
        resolve(fallback);
      }
    };
  };

  const identify = (data: IdentifyData): Promise<void> =>
    new Promise<void>((resolve) => {
      const go = settled(resolve, undefined, () => {
        const pv = current;
        if (!cfg || !pv || pv.personal || !data || typeof data !== "object") return resolve();
        if (cfg.identify.requireConsent && !consent) {
          debug("identify() needs consent");
          return resolve();
        }
        withPlugin<IdentifyApi>("identify", (api) => {
          api
            .hash(data, cfg?.callingCode ?? null)
            .then((hashed) => {
              if (hashed) {
                pv.ident = { pv: pv.id, ...hashed };
                if (!outbox.includes(pv)) outbox.push(pv);
                flush();
              }
            })
            .catch(() => undefined)
            .finally(resolve);
        });
      });
      // before init() the call is queued; awaiting code must not hang on a tracker that may never start
      if (!initialized) resolve();
      whenStarted(go);
    });

  const conversion = (definition: string, opts: ConversionOptions = {}): Promise<string | null> =>
    new Promise<string | null>((resolve) => {
      const valid = typeof definition === "string" && KEY_PATTERN.test(definition);
      const eventId = opts?.eventId && /^[A-Za-z0-9_.:-]{8,100}$/.test(opts.eventId) ? opts.eventId : uuid();
      const go = settled(resolve, null, () => {
        if (!running || !valid) return resolve(null);
        const pv = current;
        const sendBeacon = (hashed: Omit<WireIdentify, "pv"> | null) => {
          const attr: Record<string, string> = { ...storedAttribution(), ...(pv?.attr ?? {}) } as Record<string, string>;
          const body: Record<string, unknown> = {
            k: key,
            definition,
            eventId,
            sid: pv?.sid ?? session?.sid ?? null,
            pv: pv?.id ?? null,
            url: `${window.location.origin}${window.location.pathname}`,
            attr: Object.keys(attr).length ? attr : null,
            test: testTraffic,
          };
          if (hashed) for (const field of ["em", "emg", "fn", "ln", "ph"] as const) if (hashed[field]) body[field] = hashed[field];
          Object.assign(body, adCookies() ?? {});
          // the pageview (session, engaged time) goes out first: the server checks it before accepting the beacon
          flush();
          post(`${host}/v1/cb`, JSON.stringify(body));
          resolve(eventId);
        };
        const contact = opts?.contact;
        if (contact && (contact.email || contact.phone || contact.firstName || contact.lastName)) {
          withPlugin<IdentifyApi>("identify", (api) => {
            api
              .hash(contact, cfg?.callingCode ?? null)
              .then((hashed) => sendBeacon(hashed))
              .catch(() => sendBeacon(null));
          });
        } else sendBeacon(null);
      });
      // queued before init(): the beacon is sent once tracking starts, with this event id
      if (!initialized) resolve(valid ? eventId : null);
      whenStarted(go);
    });

  const getIds = (): X3Ids => {
    try {
      if (!running) return { sessionId: null, pageviewId: null, attribution: {}, url: null, test: false, consent: false };
      return {
        sessionId: current?.sid ?? session?.sid ?? null,
        pageviewId: current?.id ?? null,
        attribution: current ? { ...current.attr } : {},
        url: `${window.location.origin}${window.location.pathname}`,
        test: testTraffic,
        consent,
      };
    } catch {
      return { sessionId: null, pageviewId: null, attribution: {}, url: null, test: false, consent: false };
    }
  };

  const optOut = guard(() => {
    storageSet("localStorage", keys.notrack, "1");
    halt();
    blocked = true;
  });

  const optIn = guard(() => {
    storageSet("localStorage", keys.notrack, null);
    if (cfg && !running) start();
  });

  const page = guard((path?: string) => {
    whenStarted(() => begin("spa", true, typeof path === "string" && path.startsWith("/") ? path : undefined));
  });

  const videoCustom = (id: string, opts?: VideoOptions): CustomVideoTracker => {
    let inner: CustomVideoTracker | null = null;
    const call =
      <K extends keyof CustomVideoTracker>(method: K) =>
      (...args: Parameters<CustomVideoTracker[K]>) =>
        withPlugin<VideoApi>("video", (api) => {
          inner ??= api.custom(id, opts);
          (inner[method] as (...a: unknown[]) => void)(...args);
        });
    return { play: call("play"), progress: call("progress"), pause: call("pause"), seek: call("seek"), ended: call("ended") };
  };

  const preset = (name: string, props: object = {}) => track(name, props as Props);

  const api: Tracker = {
    init,
    track,
    goal: guard((name: string, props?: Props) => track(name, props, { flush: true })),
    funnelStep: guard((funnel: string, step: string) => preset("funnel_step", { funnel, step })),
    page,
    identify,
    conversion,
    consent: guard((state: ConsentInput) => behavior.consent(state, setConsent)),
    privacy: guard(() => withPlugin<{ open(): void }>("privacy", (api) => api.open())),
    flush: guard(() => flush()),
    getIds,
    optOut,
    optIn,
    quiz: {
      view: guard((variant?: string) => preset("quiz_view", { variant })),
      answer: guard((variant: string, q: string, value: string) => preset("quiz_answer", { variant, q, value })),
      contact: guard((variant?: string) => preset("quiz_contact", { variant })),
      submit: guard((variant?: string) => preset("quiz_submit", { variant })),
    },
    cta: guard((label?: string, section?: string) => preset("cta_click", { label: cleanLabel(label) ?? undefined, section })),
    whatsapp: guard((section?: string) => preset("whatsapp_click", { section })),
    messaging: guard((app: MessagingApp, section?: string) => preset("messaging_click", { app, section })),
    calculator: guard(() => preset("calculator_used")),
    booking: guard((via: string) => preset("booking", { via })),
    video: {
      track: guard((element: HTMLVideoElement, opts?: VideoOptions) => withPlugin<VideoApi>("video", (video) => video.track(element, opts))),
      custom: (id: string, opts?: VideoOptions) => videoCustom(id, opts),
    },
    bridges: {
      funnelStage: guard((stage: string, variant?: string) =>
        whenStarted(() => {
          if (variant && ID_PATTERN.test(variant)) quizVariant = variant;
          if (stage === "quiz_seen") emit(current, "quiz_view", { variant: quizVariant });
          else if (stage === "contact_reached") emit(current, "quiz_contact", { variant: quizVariant });
          else if (stage === "cta_click") emit(current, "cta_click", recentClick());
        }),
      ),
      quizAnswer: guard((variant: string, questionId: string, value: string) => preset("quiz_answer", { variant, q: questionId, value })),
      funnelEvent: guard((event: string) =>
        whenStarted(() => {
          if (event === "whatsapp_click") emit(current, "whatsapp_click", { section: recentClick().section });
          else if (event === "calculator_used") emit(current, "calculator_used", {});
        }),
      ),
    },
    version: env.version,
    stop,
    register: (plugin: X3Plugin) => register(plugin),
    load: (name: PluginName) => requestPlugin(name),
    destroy: () => {
      destroyed = true;
      running = false;
      listeners.abort();
      historyHooks.delete(routeHook);
      for (const timer of [flushTimer, firstFlushTimer, stopTimer, configTimer]) if (timer) clearTimeout(timer);
      if (tickTimer) clearInterval(tickTimer);
      current = null;
    },
  };
  return api;
}

