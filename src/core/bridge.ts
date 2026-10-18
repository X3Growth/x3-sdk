import type { CustomVideoTracker, VideoOptions, X3Api } from "../types";
import type { Tracker } from "./tracker";

/**
 * Lets the npm API (`import { track } from "@x3growth/sdk"`, `/presets`) drive
 * the script-tag tracker when a page loads x3.js (e.g. Next.js <X3Analytics>)
 * instead of calling init() itself: one tracker per page, never two sessions.
 *
 * - npm init() was called → everything stays local.
 * - window.x3 is the booted dispatcher → calls go straight to it.
 * - window.x3 is still the queue stub → void calls are queued (`x3("quiz.answer", …)`),
 *   calls that return something wait for the boot (at most BOOT_WAIT_MS).
 */

type Remote = ((...args: unknown[]) => void) & Partial<X3Api>;
type Fn = (...args: unknown[]) => unknown;

export const BOOT_WAIT_MS = 10_000;
const POLL_MS = 50;

export function bridgeToScriptTag(local: Tracker): Tracker {
  let ownInit = false;
  const pending: Array<(remote: Remote | null) => void> = [];
  let poller: ReturnType<typeof setInterval> | null = null;

  const remote = (): Remote | null => {
    if (ownInit || typeof window === "undefined") return null;
    const candidate = (window as unknown as { x3?: unknown }).x3;
    return typeof candidate === "function" ? (candidate as Remote) : null;
  };
  const booted = (x: Remote | null): x is Remote & X3Api => Boolean(x && typeof x.version === "string" && x.version);

  /** runs `work` with the booted script tracker, or with null once the wait is over */
  const whenBooted = (work: (remote: Remote | null) => void) => {
    const now = remote();
    if (booted(now)) return work(now);
    pending.push(work);
    if (poller) return;
    const started = Date.now();
    poller = setInterval(() => {
      const x = remote();
      const ready = booted(x);
      if (!ready && Date.now() - started < BOOT_WAIT_MS && x) return;
      if (poller) clearInterval(poller);
      poller = null;
      for (const job of pending.splice(0)) {
        try {
          job(ready ? x : null);
        } catch {
          // a page's own error must not stop the remaining calls
        }
      }
    }, POLL_MS);
  };

  const method = (path: string): Fn | null => {
    const x = remote();
    if (!booted(x)) return null;
    const [head, tail] = path.split(".") as [string, string | undefined];
    const owner = (tail ? (x as unknown as Record<string, unknown>)[head] : x) as Record<string, unknown> | undefined;
    const fn = owner?.[tail ?? head];
    return typeof fn === "function" ? (...args: unknown[]) => (fn as Fn).apply(owner, args) : null;
  };

  const localFn = (path: string): Fn => {
    const [head, tail] = path.split(".") as [string, string | undefined];
    const owner = (tail ? (local as unknown as Record<string, unknown>)[head] : local) as Record<string, unknown>;
    return (...args: unknown[]) => (owner[tail ?? head] as Fn).apply(owner, args);
  };

  /** fire-and-forget calls: direct, queued on the stub, or local */
  const voidCall =
    (path: string) =>
    (...args: unknown[]): void => {
      const x = remote();
      if (!x) return void localFn(path)(...args);
      const direct = method(path);
      if (direct) direct(...args);
      else if (!booted(x)) x(path, ...args);
    };

  /** calls with a result: direct, after the boot, or local */
  const asyncCall =
    <T>(path: string, fallback: T) =>
    (...args: unknown[]): Promise<T> => {
      if (!remote()) return localFn(path)(...args) as Promise<T>;
      return new Promise<T>((resolve) => {
        whenBooted((x) => {
          const direct = x ? method(path) : null;
          if (!direct) return resolve(fallback);
          Promise.resolve(direct(...args) as T).then(resolve, () => resolve(fallback));
        });
      });
    };

  const videoCustom = (id: string, options?: VideoOptions): CustomVideoTracker => {
    if (!remote()) return local.video.custom(id, options);
    let inner: CustomVideoTracker | null = null;
    const forward =
      (name: keyof CustomVideoTracker) =>
      (...args: unknown[]) =>
        whenBooted((x) => {
          if (!x) return;
          inner ??= (x as X3Api).video.custom(id, options);
          (inner[name] as Fn)(...args);
        });
    return { play: forward("play"), progress: forward("progress"), pause: forward("pause"), seek: forward("seek"), ended: forward("ended") };
  };

  /** synchronous calls with a result: the booted script tracker answers, else the local one (control while unknown) */
  const syncCall =
    <T>(path: string) =>
    (...args: unknown[]): T => {
      const direct = remote() ? method(path) : null;
      return (direct ? direct(...args) : localFn(path)(...args)) as T;
    };

  /** experiments: listeners and ready() follow the script tracker once it booted */
  const experiments: Tracker["experiments"] = {
    ready: (timeoutMs) => {
      if (!remote()) return local.experiments.ready(timeoutMs);
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs ?? 300);
        whenBooted((x) => {
          const ready = (x as X3Api | null)?.experiments?.ready;
          if (!ready) return resolve();
          void ready(timeoutMs).then(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      });
    },
    onChange: (listener) => {
      if (!remote()) return local.experiments.onChange(listener);
      let off: (() => void) | null = null;
      let cancelled = false;
      whenBooted((x) => {
        if (!cancelled) off = (x as X3Api | null)?.experiments?.onChange(listener) ?? null;
      });
      return () => {
        cancelled = true;
        off?.();
      };
    },
    all: () => syncCall<Record<string, string>>("experiments.all")(),
  };

  const bridged: Tracker = {
    ...local,
    init: (options) => {
      ownInit = true;
      local.init(options);
    },
    track: voidCall("track") as Tracker["track"],
    goal: voidCall("goal") as Tracker["goal"],
    funnelStep: voidCall("funnelStep") as Tracker["funnelStep"],
    page: voidCall("page") as Tracker["page"],
    identify: asyncCall<void>("identify", undefined) as Tracker["identify"],
    conversion: asyncCall<string | null>("conversion", null) as Tracker["conversion"],
    lead: asyncCall<boolean>("lead", false) as Tracker["lead"],
    consent: voidCall("consent") as Tracker["consent"],
    flush: voidCall("flush") as Tracker["flush"],
    getIds: () => {
      const direct = method("getIds");
      return direct ? (direct() as ReturnType<Tracker["getIds"]>) : local.getIds();
    },
    optOut: voidCall("optOut") as Tracker["optOut"],
    optIn: voidCall("optIn") as Tracker["optIn"],
    variant: syncCall<string>("variant") as Tracker["variant"],
    experiment: syncCall<ReturnType<Tracker["experiment"]>>("experiment") as Tracker["experiment"],
    expose: voidCall("expose") as Tracker["expose"],
    experiments,
    quiz: {
      view: voidCall("quiz.view") as Tracker["quiz"]["view"],
      answer: voidCall("quiz.answer") as Tracker["quiz"]["answer"],
      contact: voidCall("quiz.contact") as Tracker["quiz"]["contact"],
      submit: voidCall("quiz.submit") as Tracker["quiz"]["submit"],
    },
    cta: voidCall("cta") as Tracker["cta"],
    whatsapp: voidCall("whatsapp") as Tracker["whatsapp"],
    messaging: voidCall("messaging") as Tracker["messaging"],
    calculator: voidCall("calculator") as Tracker["calculator"],
    booking: voidCall("booking") as Tracker["booking"],
    video: {
      track: voidCall("video.track") as Tracker["video"]["track"],
      custom: videoCustom,
    },
    bridges: {
      funnelStage: voidCall("bridges.funnelStage") as Tracker["bridges"]["funnelStage"],
      quizAnswer: voidCall("bridges.quizAnswer") as Tracker["bridges"]["quizAnswer"],
      funnelEvent: voidCall("bridges.funnelEvent") as Tracker["bridges"]["funnelEvent"],
    },
    version: local.version,
  };
  return bridged;
}
