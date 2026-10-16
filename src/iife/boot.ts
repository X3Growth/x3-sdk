import { createTracker } from "../core/tracker";
import { guard } from "../core/util";
import type { PluginName, X3Api, X3InitOptions, X3Plugin } from "../types";
import { LIB, VERSION } from "../version";

/**
 * Script-tag boot (PATTERNS §1.2):
 *
 *   <script>window.x3=window.x3||function(){(window.x3q=window.x3q||[]).push(arguments)}</script>
 *   <script async src="/n3/v1/s/x3.js?k=pk_3x_…" data-key="pk_3x_…" data-host="/n3"></script>
 *
 * Reads document.currentScript synchronously, drains window.x3q in order and
 * replaces window.x3 with the dispatcher (which also carries the X3Api methods).
 * A later x3("init", {…}) in the queue overrides the data-* attributes.
 */

type QueueWindow = Window & {
  x3?: ((...args: unknown[]) => void) & Partial<X3Api>;
  x3q?: ArrayLike<unknown>[];
  __x3r?: (plugin: X3Plugin) => void;
  __x3pq?: X3Plugin[];
};

const AUTOCAPTURE = ["pageviews", "clicks", "scroll", "engagement", "forms", "video", "sections"] as const;
const SCRIPT_FILE = /^(.*\/)x3(?:\.[a-z]+)?(@[0-9A-Za-z.-]+)?\.js(?:[?#].*)?$/;

export function boot(bundled: X3Plugin[], lazy: boolean): void {
  const w = window as QueueWindow;
  if (w.x3?.version) return; // loaded twice (async scripts on SPA frameworks)
  const script = (document.currentScript as HTMLScriptElement | null) ?? document.querySelector<HTMLScriptElement>('script[data-key^="pk_3x_"]');
  const src = script?.src ?? "";
  const file = SCRIPT_FILE.exec(src);
  const data = (name: string) => script?.getAttribute(`data-${name}`) ?? null;
  // ".../n3/v1/s/x3.js" → host ".../n3"; any other location → its origin
  const scriptHost = /\/v1\/s\/[^/]*$/.test(src.split(/[?#]/)[0] ?? "") ? (src.split(/[?#]/)[0] ?? "").replace(/\/v1\/s\/[^/]*$/, "") : src ? new URL(src).origin : "";

  const loaded = new Set<string>();
  const tracker = createTracker({
    lib: LIB,
    version: VERSION,
    defaultHost: () => scriptHost,
    load: lazy
      ? (name: PluginName) => {
          if (loaded.has(name)) return;
          loaded.add(name);
          const tag = document.createElement("script");
          tag.async = true;
          tag.src = `${file?.[1] ?? `${scriptHost}/v1/s/`}x3.${name}${file?.[2] ?? ""}.js`;
          if (script?.nonce) tag.nonce = script.nonce;
          (document.head ?? document.documentElement).appendChild(tag);
        }
      : undefined,
  });
  for (const plugin of bundled) tracker.register(plugin);
  w.__x3r = (plugin) => tracker.register(plugin);
  for (const plugin of w.__x3pq?.splice(0) ?? []) tracker.register(plugin);

  const dispatch = guard((command: unknown, ...args: unknown[]) => {
    const name = command === "event" ? "track" : command;
    // "quiz.answer", "bridges.funnelStage", "video.track": namespaced methods (queued by the npm bridge)
    const [head, tail] = typeof name === "string" ? name.split(".") : [];
    const owner = (head && tail ? (tracker as unknown as Record<string, unknown>)[head] : tracker) as Record<string, unknown> | undefined;
    const fn = head && name !== "init" ? owner?.[tail ?? head] : undefined;
    if (name === "init") tracker.init(args[0] as X3InitOptions);
    else if (typeof fn === "function") (fn as (...a: unknown[]) => unknown).apply(owner, args);
  });
  const queue = Array.from(w.x3q ?? [], (entry) => Array.from(entry));
  w.x3 = Object.assign(dispatch, tracker);
  w.x3q = [];

  const options: Partial<X3InitOptions> = {};
  const key = data("key");
  if (key) options.key = key;
  const host = data("host");
  if (host) options.host = host;
  const consent = data("consent");
  if (consent === "granted" || consent === "denied" || consent === "pending") options.consent = consent;
  const auto = data("auto");
  if (auto !== null) {
    const enabled = auto.split(/[\s,]+/);
    options.autocapture = Object.fromEntries(AUTOCAPTURE.map((feature) => [feature, enabled.includes(feature)]));
  }
  if (data("hash-routing") !== null) options.hashRouting = true;
  if (data("respect-dnt") !== null) options.respectDoNotTrack = true;
  if (data("debug") !== null) options.debug = true;
  if (data("test") !== null) options.test = true;
  // data-plugins="video,forms": load these right away instead of waiting for the config
  for (const name of (data("plugins") ?? "").split(/[\s,]+/)) if (name) tracker.load(name as PluginName);
  const explicit = queue.find((entry) => entry[0] === "init");
  const merged = { ...options, ...((explicit?.[1] as Partial<X3InitOptions> | undefined) ?? {}) };
  if (merged.key) tracker.init(merged as X3InitOptions);
  for (const entry of queue) if (entry[0] !== "init") dispatch(...(entry as [unknown, ...unknown[]]));
}
