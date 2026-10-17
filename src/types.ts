import type { Attribution, ClientConfig, MESSAGING_APPS, NavType, PropValue, WireEvent, WireSection, WireVideo } from "./_core/index.js";

/** Shared types of the wire protocol and project config used in the SDK's public signatures */
export type { Attribution, BookingAdapter, ClientConfig, NavType, PropValue, VideoFormat, WireEvent, WireIdentify, WirePageview, WireSection, WireVideo } from "./_core/index.js";

/**
 * Public API of the 3x browser SDK.
 * The same API is available as ESM (`import { init } from "@x3growth/sdk"`) and
 * on the script-tag build as `window.x3` (queue form: `x3("track", "name", {…})`).
 *
 * Privacy contract (PARITY §0, ARCHITECTURE §17.1): nothing is read from or
 * written to cookies, localStorage or sessionStorage before consent, except the
 * project's consent key and the explicit opt-out flag. Ids live in memory. No
 * form values or typed text are ever captured.
 */

export type ConsentState = "granted" | "denied" | "pending";
export type MessagingApp = (typeof MESSAGING_APPS)[number];
export type Props = Record<string, PropValue>;
export type PluginName = "video" | "sections" | "forms" | "identify" | "consent" | "bookings" | "journeys";

export type X3InitOptions = {
  /** publishable key pk_3x_… (project) */
  key: string;
  /**
   * API root the SDK talks to: the API origin ("https://api.3x.example") or a
   * first-party proxy path ("/n3", recommended). Requests go to `${host}/v1/e`.
   * Default: derived from the script URL (script tag), else "/n3".
   */
  host?: string;
  /** client config inline (skips GET /v1/c/{pk}); the Next adapter fetches it on the server */
  config?: ClientConfig;
  /** initial consent; default: the project's consent storage key / window event / CMP adapters, else "pending" */
  consent?: ConsentState;
  /** autocapture switches (all default true; plugins additionally follow ClientConfig.plugins) */
  autocapture?: {
    pageviews?: boolean;
    clicks?: boolean;
    scroll?: boolean;
    engagement?: boolean;
    /** <form> start/submit/abandon (forms plugin) */
    forms?: boolean;
    /** <video controls> / [data-x3-video] (video plugin) */
    video?: boolean;
    /** <section> / [data-x3-section] visibility (sections plugin) */
    sections?: boolean;
  };
  /** ESM: plugins installed right away (others load lazily when the config enables them) */
  plugins?: X3Plugin[];
  /** hash routers (#/route): hash changes are pageviews, the hash route is the path */
  hashRouting?: boolean;
  /** mark all traffic of this page load as test traffic */
  test?: boolean;
  /** do not track at all when the browser sends Do Not Track (overrides the project setting when true) */
  respectDoNotTrack?: boolean;
  /** exposes window.__x3 (state, queued, flushNow) and logs diagnostics via console.warn */
  debug?: boolean;
};

/** Ids for server-side events and conversions (parity TR-86); null while not running */
export type X3Ids = {
  sessionId: string | null;
  pageviewId: string | null;
  attribution: Attribution;
  /** origin + path of the current page (no query) */
  url: string | null;
  test: boolean;
  consent: boolean;
};

export type IdentifyData = {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  externalId?: string;
  /** form the data came from (ID-safe) */
  form?: string;
  /** non-personal traits (≤ 20; e-mail/phone-like values are dropped) */
  traits?: Props;
};

export type ConversionOptions = {
  /** shared with a browser pixel for deduplication; default: a new random id */
  eventId?: string;
  /** hashed in the browser before sending (SHA-256, provider normalization) */
  contact?: { email?: string; phone?: string; firstName?: string; lastName?: string };
};

/** Custom players (YouTube/Vimeo/…): feed positions, the SDK builds coverage like for <video> */
export type CustomVideoTracker = {
  play(positionS: number, durationS: number): void;
  progress(positionS: number, durationS: number): void;
  pause(positionS: number): void;
  seek(fromS: number, toS: number): void;
  ended(): void;
};

export type VideoOptions = { id?: string; format?: "landscape" | "portrait"; src?: string; /** display name in the dashboard */ title?: string };

export type X3Plugin = {
  name: PluginName | (string & {});
  /** called once with the tracker internals; may return an API object other parts of the SDK call into */
  install(host: X3PluginHost): unknown;
};

/** Per-pageview state shared with plugins (internal, versioned by X3PluginHost.api) */
export type TrackedPageview = {
  id: string;
  sid: string;
  /** canonical path */
  path: string;
  personal: boolean;
  notFound: boolean;
  nav: NavType;
  t0: number;
  /** section name → [first visible ms, visible ms] (sections plugin) */
  sec: Record<string, WireSection>;
  /** video plays (video plugin keeps these wire objects up to date) */
  vids: WireVideo[];
};

/** Lifecycle hooks a plugin registers with X3PluginHost.hook() */
export type PluginHooks = {
  /** a pageview started (after its first sample) */
  begin?(pageview: TrackedPageview): void;
  /** scroll / resize / tick sample of the current pageview (only while on its path) */
  sample?(pageview: TrackedPageview): void;
  /** 1 s engagement tick while the tab is visible; delta = ms since the last tick (≤ 2 s) */
  tick?(pageview: TrackedPageview, deltaMs: number): void;
  /** the pageview is about to be finalized (last chance to queue events) */
  end?(pageview: TrackedPageview): void;
  /** the page is being unloaded or put into the bfcache (pagehide) */
  hide?(pageview: TrackedPageview): void;
  /** media of this pageview is playing → counts as engaged (TR-35) */
  active?(pageview: TrackedPageview): boolean;
  /** tracked section around an element (click props) */
  sectionOf?(element: Element): string | undefined;
  /** device reads became allowed (consent granted in strict mode) */
  reads?(pageview: TrackedPageview): void;
  /** consent granted (true) or denied/revoked (false); wasGranted = it was granted on this page before */
  consent?(granted: boolean, wasGranted: boolean): void;
};

/** Internal surface plugins use (implemented by the SDK core) */
export type X3PluginHost = {
  /** plugin API version; lazy plugin files of another version refuse to install */
  readonly api: 1;
  /** queue an event on the current pageview (catalog trimming, once-per-pageview, dedupe); returns the queued event */
  emit(name: string, props?: Props, options?: { flush?: boolean }): WireEvent | null;
  flush(): void;
  current(): TrackedPageview | null;
  /** monotonic ms since the pageview started */
  age(pageview: TrackedPageview): number;
  hook(hooks: PluginHooks): void;
  markActivity(): void;
  config(): ClientConfig;
  /** attribute names for a data attribute (data-x3-* plus data-track-* when legacyTrackAttributes) */
  attrs(name: keyof typeof DATA_ATTRIBUTES): string[];
  /** first matching attribute value on the element itself */
  attr(element: Element, name: keyof typeof DATA_ATTRIBUTES): string | null;
  /** CSS selector matching any of the attribute names */
  selector(name: keyof typeof DATA_ATTRIBUTES): string;
  /** element id unless React-generated or not ID-safe */
  stableId(element: Element): string | null;
  /** feature enabled by the project config and not switched off in init({autocapture}) */
  autocapture(feature: "video" | "sections" | "forms"): boolean;
  /** viewport/scroll/visibility reads allowed (false in consent mode strict before consent) */
  deviceReads(): boolean;
  consent(): boolean;
  /** consent was explicitly denied or revoked on this page */
  consentDenied(): boolean;
  /** the API root the SDK talks to (proxy path such as "/n3" or the API origin) */
  apiHost(): string;
  setConsent(state: "granted" | "denied"): void;
  /** guarded listener, removed when the tracker is destroyed */
  listen(target: EventTarget, type: string, listener: (event: Event) => void, options?: AddEventListenerOptions): void;
  debug(message: string): void;
};

export type X3Api = {
  init(options: X3InitOptions): void;
  /** built-in or custom event; props are trimmed to the event's spec on the client and validated on the server */
  track(name: string, props?: Props, options?: { flush?: boolean }): void;
  /** event meant as a goal: track + immediate send (define the goal in the dashboard/API) */
  goal(name: string, props?: Props): void;
  /** funnel_step {funnel, step} */
  funnelStep(funnel: string, step: string): void;
  /** manual pageview for routers without the History API (path defaults to location) */
  page(path?: string): void;
  /** hashed in the browser (SHA-256, provider normalization); sent only with consent unless the project allows it */
  identify(data: IdentifyData): Promise<void>;
  /** browser conversion beacon (POST {host}/v1/cb) for a conversion definition; resolves with the event id */
  conversion(definition: string, options?: ConversionOptions): Promise<string | null>;
  consent(state: "granted" | "denied"): void;
  /** send everything queued now (sendBeacon) */
  flush(): void;
  getIds(): X3Ids;
  /** this browser opts out / back in (same as ?<notrackParam>=1 / =0) */
  optOut(): void;
  optIn(): void;

  /* presets – generic names, stable stored events */
  quiz: {
    view(variant?: string): void;
    answer(variant: string, question: string, value: string): void;
    contact(variant?: string): void;
    submit(variant?: string): void;
  };
  cta(label?: string, section?: string): void;
  whatsapp(section?: string): void;
  messaging(app: MessagingApp, section?: string): void;
  calculator(): void;
  booking(via: string): void;
  video: {
    /** track a <video> without controls / outside autocapture */
    track(element: HTMLVideoElement, options?: VideoOptions): void;
    custom(id: string, options?: VideoOptions): CustomVideoTracker;
  };
  /** bridges for existing funnel tracking hooks (stage/answer/event calls) – parity TR-74…TR-76 */
  bridges: {
    funnelStage(stage: string, variant?: string): void;
    quizAnswer(variant: string, questionId: string, value: string): void;
    funnelEvent(event: string): void;
  };
  readonly version: string;
};

/** Script-tag queue commands: window.x3(command, ...args) – any X3Api method name; "event" = "track" */
export type X3QueueCommand =
  | ["init", X3InitOptions]
  | ["track" | "event", string, Props?, { flush?: boolean }?]
  | ["goal", string, Props?]
  | ["funnelStep", string, string]
  | ["page", string?]
  | ["identify", IdentifyData]
  | ["conversion", string, ConversionOptions?]
  | ["consent", "granted" | "denied"]
  | ["flush"]
  | ["optOut"]
  | ["optIn"];

/**
 * Declarative markup (no code). `data-x3-*` always; `data-track-*` too when
 * the project enables legacyTrackAttributes (legacy markup).
 */
export const DATA_ATTRIBUTES = {
  /** click → custom event; props from data-x3-prop-<key>="value" */
  event: "data-x3-event",
  propPrefix: "data-x3-prop-",
  /** CTA (cta_click) */
  cta: "data-x3-cta",
  /** click label override (data-track) */
  label: "data-x3-label",
  /** section name (data-track-section) */
  section: "data-x3-section",
  /** no labels captured inside (data-track-ignore) */
  ignore: "data-x3-ignore",
  /** video id / format (data-track-video, data-track-video-format) */
  video: "data-x3-video",
  videoFormat: "data-x3-video-format",
  /** display name of a video in the dashboard (else title/aria-label, figcaption, file name) */
  videoTitle: "data-x3-video-title",
  /** form name (data-track on forms) */
  form: "data-x3-form",
  /** not-found page marker (data-track-404); the project's notFound.markerAttr is used in any case */
  notFound: "data-x3-404",
} as const;

export const LEGACY_DATA_ATTRIBUTES: Partial<Record<keyof typeof DATA_ATTRIBUTES, string>> = {
  label: "data-track",
  cta: "data-track-cta",
  section: "data-track-section",
  ignore: "data-track-ignore",
  video: "data-track-video",
  videoFormat: "data-track-video-format",
  form: "data-track",
  notFound: "data-track-404",
};
