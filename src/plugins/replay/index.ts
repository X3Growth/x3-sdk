import { record } from "@rrweb/record";
import { X3R_FLAGS } from "../../_core/index.js";
import type { TrackedPageview, X3Plugin, X3PluginHost } from "../../types";
import { createChunker, preloadSyncGzip, setFflateLoader, type Chunker } from "./chunker";
import { BUFFER_LIMIT, evaluateGate, MUTATION_LIMIT_PER_S, predictSnapshotMs, PREDICTION_LIMIT_MS, SNAPSHOT_ABORT_MS } from "./gate";
import { blockSelector, maskText, transformEvent, type MaskOptions } from "./mask";

/**
 * x3.replay.js (RECORDINGS-HEATMAPS §5.4–5.6, §20.C): @rrweb/record 2.1.7 with masking transforms,
 * X3R1 packets, CSS dedupe, ring buffer (sparse sampling), guards (prediction, too_slow, too_noisy),
 * holdout, revoke and the owner capture mode. Loaded only when the recording level allows the
 * current consent state – without it the visitor downloads 0 bytes of rrweb.
 */

type RrwebEvent = { type: number; timestamp: number; data: Record<string, unknown> };
const RING_MS = 60_000;

function scriptBase(host: X3PluginHost): string {
  const tag = document.querySelector<HTMLScriptElement>('script[src*="/x3"][src$=".js"],script[src*="/v1/s/x3"]');
  const match = tag?.src.match(/^(.*\/)x3(?:\.[a-z]+)?(@[\d.]+)?\.js/);
  return match?.[1] ?? `${host.apiHost().replace(/\/$/, "")}/v1/s/`;
}

export function replay(): X3Plugin {
  return {
    name: "replay",
    install(host: X3PluginHost) {
      const bridge = host.behavior();
      const on = (fn: () => void) => bridge.on.push(fn);
      const known = new Set<string>();
      setFflateLoader(
        () =>
          new Promise((resolve, reject) => {
            const w = window as Window & { __x3gz?: (data: Uint8Array) => Uint8Array };
            if (w.__x3gz) return resolve(w.__x3gz);
            const tag = document.createElement("script");
            tag.src = `${scriptBase(host)}x3.fflate.js`;
            tag.onload = () => (w.__x3gz ? resolve(w.__x3gz) : reject(new Error("fflate")));
            tag.onerror = reject;
            document.head.appendChild(tag);
          }),
      );
      const secret = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
      let stopRecording: (() => void) | null = null;
      let chunker: Chunker | null = null;
      let mode: "record" | "ring" = "record";
      const ring: RrwebEvent[] = [];
      let mutations = 0;
      let noisySeconds = 0;
      let bytes = 0;
      let reason: string | null = null;

      const config = () => bridge.config();
      const mask = (): MaskOptions => ({ profile: config()?.replay.mask.profile ?? "strict", unmask: config()?.replay.mask.unmask ?? [], block: config()?.replay.mask.block ?? [] });

      const newChunker = (pv: TrackedPageview) =>
        createChunker(
          {
            host: host.apiHost().replace(/\/$/, ""),
            key: bridge.key(),
            secret,
            header: () => ({ sid: pv.sid, pv: pv.id, m: mask().profile === "balanced" ? "b" : "s", cs: bridge.cs(), page: pv.path, vw: innerWidth, vh: innerHeight, ...(bridge.cs()[1] === "g" && bridge.cp ? { cp: { cmp: bridge.cp.cmp, purpose: "recordings", ts: bridge.cp.ts } } : {}) }),
          },
          { known, onOff: () => stop("server_off") },
        );

      const stop = (why: string, revoke = false) => {
        reason = why;
        stopRecording?.();
        stopRecording = null;
        chunker?.stop(revoke ? "revoke" : "off");
        host.debug(`recording stopped: ${why}`);
      };

      const emit = (event: RrwebEvent) => {
        const transformed = transformEvent(event, (id) => record.mirror.getNode(id) as Element | null, mask());
        if (!transformed) return;
        if (transformed.type === 3 && transformed.data.source === 0) {
          const data = transformed.data as { adds?: unknown[]; removes?: unknown[]; texts?: unknown[]; attributes?: unknown[] };
          mutations += (data.adds?.length ?? 0) + (data.removes?.length ?? 0) + (data.texts?.length ?? 0) + (data.attributes?.length ?? 0);
        }
        bytes += 64;
        if (bytes > BUFFER_LIMIT * 4) return stop("too_noisy");
        if (mode === "ring") {
          ring.push(transformed);
          const cutoff = Date.now() - RING_MS;
          while (ring.length && (ring[0] as RrwebEvent).timestamp < cutoff && (ring[0] as RrwebEvent).type !== 2) ring.shift();
          return;
        }
        chunker?.push(transformed);
      };

      // sparse sampling: the ring buffer is uploaded only when something happens (§4.3)
      const trigger = () => {
        if (mode !== "ring" || !chunker) return;
        mode = "record";
        for (const event of ring.splice(0)) chunker.push(event);
        void chunker.flush();
      };

      const start = (pv: TrackedPageview) => {
        const cfg = config();
        if (!cfg || stopRecording || reason) return;
        const gate = evaluateGate(cfg, { sid: pv.sid, path: pv.path, search: location.search, personal: pv.personal, allowed: bridge.allowed("recording") });
        if (!gate.record) {
          if (gate.holdout) bridge.heat(pv.id).perf = { ...bridge.heat(pv.id).perf, ho: 1 };
          host.debug(`not recording: ${gate.reason}`);
          return;
        }
        const predicted = predictSnapshotMs();
        performance.mark("x3:snapshot-predicted", { detail: predicted });
        if (predicted > PREDICTION_LIMIT_MS) return void (reason = "too_slow_predicted");
        mode = gate.mode;
        chunker = newChunker(pv);
        void preloadSyncGzip();
        const t0 = performance.now();
        stopRecording =
          record({
            emit: (event) => emit(event as RrwebEvent),
            maskAllInputs: true,
            maskInputFn: () => "••••",
            maskTextSelector: "*",
            maskTextFn: (text, element) => maskText(text, element, mask()),
            blockSelector: blockSelector(mask()),
            recordCanvas: false,
            recordCrossOriginIframes: false,
            collectFonts: false,
            inlineImages: false,
            inlineStylesheet: true,
            slimDOMOptions: "all",
            sampling: { mousemove: 50, scroll: 150, input: "last", media: 800 },
            checkoutEveryNms: mode === "ring" ? 30_000 : undefined,
          }) ?? null;
        // the snapshot cost as a User Timing entry (perf CI §16.2, RUM tools); emergency brake above 150 ms (§5.4)
        performance.measure("x3:snapshot", { start: t0 });
        if (performance.now() - t0 > SNAPSHOT_ABORT_MS) return stop("too_slow");
        bridge.heat(pv.id).perf = { ...bridge.heat(pv.id).perf, rec: 1 };
      };

      const second = setInterval(() => {
        noisySeconds = mutations > MUTATION_LIMIT_PER_S ? noisySeconds + 1 : 0;
        mutations = 0;
        if (noisySeconds >= 2) stop("too_noisy");
      }, 1000);
      void second;

      host.hook({
        begin(pv) {
          if (stopRecording && chunker) {
            // SPA navigation: close the previous pageview's packets, new packets for the new one with a fresh snapshot
            void chunker.flush();
            chunker = newChunker(pv);
            record.takeFullSnapshot();
            return;
          }
          const run = () => start(pv);
          // after load and LCP, in idle time, not while the visitor interacts (§5.4)
          if (document.readyState === "complete") requestIdle(run);
          else addEventListener("load", () => requestIdle(run), { once: true });
        },
        hide() {
          void chunker?.flush(true);
        },
        consent() {
          if (!bridge.allowed("recording") && stopRecording) stop("consent", bridge.cs().endsWith("d") || bridge.stopped());
        },
      });
      on(() => {
        if (!bridge.allowed("recording")) {
          // a rejection or an opt-out (stopped) sends the revoke packet: the server erases what this device uploaded
          if (stopRecording || chunker) stop(bridge.stopped() ? "stopped" : "consent", bridge.cs().endsWith("d") || bridge.stopped());
        } else {
          const pv = host.current();
          if (pv && !stopRecording) {
            reason = null;
            requestIdle(() => start(pv));
          }
        }
      });
      host.listen(document, "change", () => {
        if (stopRecording) record.addCustomEvent("x3", { e: "field", p: {} });
      }, { capture: true });
      for (const type of ["error", "submit"]) host.listen(window, type, trigger, { capture: true });
      // loaded after consent: the pageview that is already running gets recorded from now on
      const running = host.current();
      if (running && bridge.allowed("recording")) requestIdle(() => start(running));
      host.listen(document, "click", (event) => {
        const el = (event.target as Element | null)?.closest?.("a[href*='wa.me'],[data-x3-cta],button[type=submit],[data-x3-quiz]");
        if (el) trigger();
      }, { capture: true });
      return { flags: X3R_FLAGS, stop: (why: string) => stop(why) };
    },
  };
}

function requestIdle(fn: () => void): void {
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) idle(fn, { timeout: 4000 });
  else setTimeout(fn, 300);
}
