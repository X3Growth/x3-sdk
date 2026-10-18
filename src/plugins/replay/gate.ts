import { clientSamples, pathExcluded, sessionFraction, type BehaviorClientConfig } from "../../_core/index.js";

/**
 * Recording gate after the consent check of the core (RECORDINGS-HEATMAPS §5.4): page rules,
 * device guard, sampling (deterministic per session), RUM holdout, cost prediction before the
 * full snapshot. Each failed condition says why (debug output and tests).
 */

export type GateResult = { record: true; mode: "record" | "ring"; holdout: false } | { record: false; reason: string; holdout?: boolean };

type NavigatorExtras = Navigator & { connection?: { saveData?: boolean; effectiveType?: string }; deviceMemory?: number; webdriver?: boolean };

export function deviceGuard(nav: NavigatorExtras = navigator, win: Window = window): string | null {
  if (nav.webdriver || /HeadlessChrome|bot|crawler|spider/i.test(nav.userAgent)) return "automation";
  if (nav.connection?.saveData) return "save_data";
  if (nav.connection?.effectiveType && ["slow-2g", "2g"].includes(nav.connection.effectiveType)) return "slow_network";
  if (typeof nav.deviceMemory === "number" && nav.deviceMemory < 2) return "low_memory";
  const mobile = /Mobi|Android|iPhone/i.test(nav.userAgent);
  if (mobile && typeof nav.hardwareConcurrency === "number" && nav.hardwareConcurrency < 4) return "low_cpu";
  if (win.matchMedia?.("(prefers-reduced-data: reduce)").matches) return "reduced_data";
  return null;
}

export function pageAllowed(config: BehaviorClientConfig, path: string, search: string, personal: boolean, doc: Document = document): string | null {
  if (personal) return "personal_page";
  if (doc.documentElement.hasAttribute("data-x3-no-replay")) return "page_opt_out";
  if (pathExcluded(path, config.replay.rules.excludePaths)) return "page_excluded";
  const params = new URLSearchParams(search);
  if (config.replay.rules.excludeQuery.some((key) => params.has(key))) return "query_excluded";
  return null;
}

export function evaluateGate(config: BehaviorClientConfig, input: { sid: string; path: string; search: string; personal: boolean; allowed: boolean }): GateResult {
  if (!config.replay.enabled) return { record: false, reason: "disabled" };
  if (!config.replay.allow) return { record: false, reason: "server_off" };
  if (!input.allowed) return { record: false, reason: "consent" };
  const page = pageAllowed(config, input.path, input.search, input.personal);
  if (page) return { record: false, reason: page };
  const device = deviceGuard();
  if (device) return { record: false, reason: device };
  // RUM holdout: 5 % of eligible sessions in the measuring windows are not recorded (§16.3)
  if (config.replay.holdout.active && sessionFraction(`ho:${input.sid}`) < config.replay.holdout.rate) return { record: false, reason: "holdout", holdout: true };
  return { record: true, mode: clientSamples(config.replay.sampling.mode, input.sid, config.replay.sampling.randomRate), holdout: false };
}

/** ≤ 2 ms micro benchmark → device factor (ms per 1,000 nodes); snapshot prediction > 100 ms → no recording (§5.4) */
export function predictSnapshotMs(doc: Document = document): number {
  const nodes = doc.getElementsByTagName("*").length;
  const start = performance.now();
  let walked = 0;
  const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, 1);
  while (walker.nextNode() && performance.now() - start < 2) walked++;
  const elapsed = Math.max(0.05, performance.now() - start);
  // serializing + masking ≈ 36× the cost of walking, measured in test/perf.replay.test.ts (real Chrome, 1× and 4× CPU,
  // ~2,200 elements); Spike A's 6× predicted a sixth of the real cost. 40× keeps a ~10 % margin, so what is recorded
  // stays within the 100 ms budget and the rest is skipped (§16.1)
  const perNode = (elapsed / Math.max(walked, 1)) * 40;
  return perNode * nodes;
}

export const PREDICTION_LIMIT_MS = 100;
export const SNAPSHOT_ABORT_MS = 150;
export const MUTATION_LIMIT_PER_S = 500;
export const BUFFER_LIMIT = 2 * 1024 * 1024;
