import { compileHostMatcher, compileMatcher, compileMatchers, isSafeRegex, type ClientConfig, type CompiledTrackingConfig, type TrackingConfig } from "../_core/index.js";

/**
 * Browser side of the client config. `compileClient` builds exactly the parts
 * of CompiledTrackingConfig that canonicalPage/notFoundPage/attribution use in
 * the browser (no origin matcher, no page groups – those are server-only),
 * which keeps x3.js small. `DEFAULT_CLIENT_CONFIG` equals
 * toClientConfig(defaultTrackingConfig([host]), 0, 2, null) (asserted in tests)
 * and is used when no config arrives within TIMING.configWaitMs.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

export function compileClient(config: ClientConfig): CompiledTrackingConfig {
  const own = compileHostMatcher(config.domains);
  return {
    source: config as unknown as TrackingConfig,
    isOwnHost: (host) => own(host) || (config.allowLocalhost && LOCAL_HOSTS.has(host)),
    isAllowedOrigin: () => false,
    hostPrefixes: new Map(Object.entries(config.hostPrefixes)),
    isExcluded: compileMatchers(config.excludePaths),
    personal: config.personalPaths.map((rule) => ({ test: compileMatcher(rule.match), replacement: rule.replacement })),
    groups: [],
    defaultGroup: "main",
    groupKeys: ["main"],
    valueRedactions: config.valueRedactions
      .filter((redaction) => isSafeRegex(redaction.pattern))
      .map((redaction) => ({ pattern: new RegExp(redaction.pattern, redaction.ignoreCase ? "gi" : "g"), replacement: redaction.replacement })),
    personalMode: config.personalMode,
    allowLocalhost: config.allowLocalhost,
  };
}

export function defaultClientConfig(host: string): ClientConfig {
  return {
    rev: 0,
    domains: [host],
    hostPrefixes: {},
    excludePaths: ["/api", "/_next", "/_vercel", "/n3"].map((value) => ({ kind: "prefix" as const, value })),
    personalPaths: [],
    personalMode: "isolate",
    valueRedactions: [],
    variantParam: null,
    testParams: ["x3_test"],
    notrackParam: "x3_notrack",
    storagePrefix: "x3_",
    consent: {
      mode: "cookieless",
      storageKey: null,
      grantedValues: ["granted"],
      deniedValues: ["denied"],
      windowEvent: null,
      cmp: [],
      respectDoNotTrack: false,
      respectGlobalPrivacyControl: true,
    },
    legacyTrackAttributes: false,
    cta: { selectors: [] },
    messaging: { whatsapp: true, apps: [] },
    downloads: { extensions: ["pdf", "zip", "docx", "xlsx", "pptx", "csv"] },
    notFound: { path: "/404", markerAttr: "data-x3-404" },
    bookings: [],
    bridges: [],
    plugins: { video: true, sections: true, forms: true },
    firstTouch: { enabled: false },
    identify: { requireConsent: true },
    allowLocalhost: false,
    channelRules: 2,
    callingCode: null,
    journeys: { visitorId: true, clickIds: true, fbp: false, ttp: false },
  };
}
