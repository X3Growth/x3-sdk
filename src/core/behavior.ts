import type { BehaviorClientConfig, CaptureSignal, WireClickHeat, WireEvent, WirePageviewHeat } from "../_core/index.js";

/**
 * Behavior bridge in the core script (RECORDINGS-HEATMAPS §20.B/C): the tiny gate (consent state
 * per purpose, level lookup, hard stops) and the click CAPTURE (target, position, queued event;
 * the heat plugin reads the element box at pointerdown and builds the anchor after the next paint).
 * Anchor strings, timelines, live frames, the device proof and recordings live in lazy plugins
 * (x3.heat.js, x3.replay.js, x3.capture.js) that reach this bridge through the plugin host.
 * Nothing here touches device storage.
 */

export type Cs = "g" | "p" | "d";
/** a click waiting for its anchor: event, target, the mouse event and scrollY at the click */
export type PendingClick = { e: WireEvent & { h?: WireClickHeat }; t: Element; m: MouseEvent; s: number };

export type BehaviorBridge = {
  /** consent state per purpose "ar" */
  cs(): string;
  /** a signal may be captured in the current state (false while stopped: GPC, opt-out, test) */
  allowed(signal: CaptureSignal): boolean;
  config(): BehaviorClientConfig | null | undefined;
  setRecordings(state: Cs): void;
  /** proof of the recordings grant: who reported it (CMP name, null = x3.consent API) and when (§5.5); set by whoever grants */
  cp?: { cmp: string | null; ts: number };
  /** per-pageview heat state the heat plugin keeps up to date */
  heat(pageviewId: string): WirePageviewHeat;
  /** clicks waiting for their anchor; the heat plugin sets `fin` and finishes them */
  pending: PendingClick[];
  fin?: (item: PendingClick) => void;
  /** anchor builder of the heat plugin (x3.signals.js uses it instead of bundling its own) */
  anchor?: (element: Element) => string | null;
  /** hard stop: opt-out, GPC, test traffic, tracking halted – every behavior signal ends (recordings of test traffic: see test) */
  stopped(): boolean;
  /** test/internal session (test parameter, `test: true`, device marked internal); recorded only when the project relaxes masking for tests (AC) */
  test?(): boolean;
  /** listeners for state changes (consent, stop) */
  on: Array<() => void>;
  /** sha256 hex of the device secret (privacy center proof), set by the heat plugin */
  dp?: string;
  /** device secret (heat plugin); the privacy panel proves this device with it */
  secret?: string;
  key(): string;
  last?: WireEvent & { h?: WireClickHeat };
  /** the heat plugin's verdict on a click (1 rage, 2 dead after 1 s without reaction); the live plugin forwards it to the board */
  flag?: (click: WireEvent, kind: 1 | 2) => void;
};


/** x3.consent("granted" | "denied") or x3.consent({ analytics?, recordings? }) – the purposes are separate (§5.4 step 3) */
export type ConsentInput = "granted" | "denied" | { analytics?: boolean; recordings?: boolean };

export function createBehavior(deps: { config(): BehaviorClientConfig | null | undefined; consent(): boolean; denied(): boolean; hard(): boolean; test(): boolean; request(name: "heat" | "live" | "signals" | "replay" | "capture"): void; key(): string }) {
  let recordings: Cs = "p";
  let armed: Omit<PendingClick, "e"> | null = null;
  const states: Record<string, WirePageviewHeat> = {};
  const analytics = (): Cs => (deps.denied() ? "d" : deps.consent() ? "g" : "p");
  const rec = (): Cs => (analytics() === "d" ? "d" : recordings);
  const stopped = () => deps.hard() || deps.test();
  const allowed = (signal: CaptureSignal): boolean => {
    const cfg = deps.config();
    const gate = cfg?.gate[signal];
    // test traffic stops every signal, except recordings when the project relaxes masking for test/internal sessions (AC); opt-out/GPC always stop
    const stop = signal === "recording" && cfg?.replay.mask.test ? deps.hard() : stopped();
    // granted needs ≥ consent, pending ≥ until_rejected, rejected = always (levels precomputed by the server)
    return !!gate && !stop && gate[0] > "gpd".indexOf(gate[1] ? rec() : analytics());
  };
  /** clicks still waiting for their anchor are finished now (before every beacon) */
  const finalize = () => {
    if (bridge.fin) bridge.pending.splice(0).forEach(bridge.fin);
  };
  const changed = () => {
    const cfg = deps.config();
    // while stopped nothing new loads; the listeners still run so running plugins end at once (opt-out, GPC)
    if (!stopped()) {
      if (cfg?.heat.enabled && (allowed("clicks") || allowed("scroll"))) (["heat", "signals"] as const).forEach(deps.request);
      if (cfg?.live.enabled) deps.request("live");
    }
    if (cfg?.replay.enabled && cfg.replay.allow && allowed("recording")) deps.request("replay");
    // owner capture mode (signed link) works on test traffic too
    if (/[?&]x3_capture=/.test(location.search)) deps.request("capture");
    bridge.on.forEach((fn) => fn());
  };
  const bridge: BehaviorBridge = {
    cs: () => analytics() + rec(),
    allowed,
    stopped,
    test: deps.test,
    config: deps.config,
    setRecordings: (state) => {
      recordings = state;
      changed();
    },
    heat: (id) => (states[id] ??= {}),
    pending: [],
    on: [],
    key: deps.key,
  };
  return {
    bridge,
    changed,
    /** before the click event is emitted: remember target and position (emit may flush at once, e.g. WhatsApp links) */
    arm(target: Element, mouse: MouseEvent) {
      armed = allowed("clicks") ? { t: target, m: mouse, s: scrollY } : null;
    },
    /** called by emit right after queueing, before any flush: the armed click joins its event */
    bind(name: string, event: WireEvent) {
      if (name !== "click" || !armed) return;
      bridge.last = event;
      if (bridge.pending.length < 50) bridge.pending.push({ e: event, ...armed });
      armed = null;
      // after the next paint (no INP cost); a beacon before that finishes them synchronously (finalize)
      requestAnimationFrame(() => setTimeout(finalize));
    },
    finalize,
    envelope: () => ({ cs: bridge.cs(), dp: bridge.dp }),
    pageview: (id: string) => ({ h: states[id] }),
    consent(state: ConsentInput, set: (state: "granted" | "denied") => void) {
      if (typeof state == "string") return set(state);
      if (state.analytics != null) set(state.analytics ? "granted" : "denied");
      if (state.recordings != null) {
        bridge.cp = { cmp: null, ts: Date.now() };
        bridge.setRecordings(state.recordings ? "g" : "d");
      }
    },
  };
}
