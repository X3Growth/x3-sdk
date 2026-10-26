import type { HeartbeatResponse, WireClickHeat, WireEvent } from "../_core/index.js";
import type { X3Plugin, X3PluginHost } from "../types";

/**
 * x3.live.js (RECORDINGS-HEATMAPS §10.3, §10.6, §20.F): heartbeat every 30 s on visible tabs while
 * live is on in the project ({hz, replay}); while somebody watches, frames for visitors whose
 * liveIndividual level allows it: every 500 ms for a visitor shown on a board (hz 2), 1 Hz for the
 * pointer sample (hz 1); 0.2 Hz band updates via the heartbeat for the density sample (hz 0.2).
 * The heartbeat is the presence signal of „Besucher jetzt“ (a session counts 90 s after its last
 * signal), so an answer with hz = 0 keeps the 30 s beat; only two failed requests in a row end it
 * until the tab becomes visible again.
 *
 * Pointer (only where the pointer level allows it, coordinates only, never text): pointermove is
 * coalesced to one sample per 60 ms (≈ 16 Hz) while it moves, the last position of a burst is kept,
 * a scroll with a resting pointer adds a sample (the pointer moves on the page). Samples
 * [ms, x ‰ of the viewport width, y ‱ of the page height] go delta-encoded in `m` (live-pointer.ts),
 * at most 24 per frame; nothing is sampled or sent while the tab is hidden; a frame without any
 * change is skipped (one keep-alive every 5 s).
 * Clicks: the core binds the click event in the capture phase, but its anchor is built after the
 * next paint (no INP cost), so the plugin reads it then; the heat plugin's verdict (rage at once,
 * dead after 1 s) follows as the same click with its kind, the server keeps the stronger one.
 */
export function live(): X3Plugin {
  return {
    name: "live",
    install(host: X3PluginHost) {
      start(host);
      return {};
    },
  };
}

type Click = [string, number, number, number, number, number, number];

/** Live heartbeat (30 s, visible tab) and frames while somebody watches (§10.3, §20.F) */
function start(host: X3PluginHost): void {
  const b = host.behavior();
  let hz: HeartbeatResponse["hz"] = 0;
  /** failed heartbeat requests in a row (network, HTTP error); hz = 0 is an answer, not a miss */
  let misses = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  /** [anchor, ax, ay, performance.now() of the click, page x ‰, page y ‰, kind]; „ms ago“ is computed when sent */
  const clicks: Click[] = [];
  const sent = new WeakMap<WireEvent, Click>();
  /** a verdict that came before the anchor (rage is known in the click's own capture phase) */
  const early = new WeakMap<WireEvent, 1 | 2>();
  const take = (max: number) => clicks.splice(0, max).map(([a, ax, ay, at, x, y, k]) => (k ? [a, ax, ay, Math.max(0, Math.round(performance.now() - at)), x, y, k] : [a, ax, ay, Math.max(0, Math.round(performance.now() - at)), x, y]));
  /** pointer samples [performance.now(), x ‰, y ‱] since the last frame */
  let samples: Array<[number, number, number]> = [];
  /** last pointer position in the viewport (client px) and when it was sampled */
  let px = -1;
  let py = 0;
  let sampledAt = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let lastBody = "";
  let lastSent = 0;
  const api = () => host.apiHost().replace(/\/$/, "");
  const height = () => Math.max(document.documentElement.scrollHeight, 1);
  const band = () => {
    const h = height();
    return [Math.round((scrollY / h) * 1e3), Math.min(1e3, Math.round(((scrollY + innerHeight) / h) * 1e3))];
  };
  const pointerOn = () => hz >= 1 && !document.hidden && b.allowed("pointer");
  const sample = (at: number) => {
    if (px < 0) return;
    const point: [number, number, number] = [at, Math.max(0, Math.min(1e3, Math.round((px / innerWidth) * 1e3))), Math.max(0, Math.min(1e4, Math.round(((py + scrollY) / height()) * 1e4)))];
    const prev = samples[samples.length - 1];
    if (prev && prev[1] === point[1] && prev[2] === point[2]) return;
    samples.push(point);
    sampledAt = at;
    // size cap: thin out every second sample of the older half instead of growing past 24
    if (samples.length > 24) samples = samples.filter((_, i) => i >= 12 || i % 2 === 0);
  };
  const move = (x: number, y: number, at: number) => {
    px = x;
    py = y;
    clearTimeout(pending);
    if (at - sampledAt >= 60) sample(at);
    // the last position of a burst always lands (coalesced, no event storm)
    else pending = setTimeout(() => sample(performance.now()), 60);
  };
  const frame = () => {
    const pv = host.current();
    if (!pv || pv.personal || document.hidden || !b.allowed("liveIndividual")) return;
    const now = performance.now();
    const pointer = b.allowed("pointer");
    let m: number[] | undefined;
    if (pointer && samples.length) {
      m = [];
      let prev: [number, number, number] | undefined;
      for (const s of samples) {
        m.push(...(prev ? [Math.round(s[0] - prev[0]), s[1] - prev[1], s[2] - prev[2]] : [Math.max(0, Math.round(now - s[0])), s[1], s[2]]));
        prev = s;
      }
    }
    samples = [];
    const c = take(10);
    const shape = JSON.stringify([band(), c.length, m]);
    // nothing changed: one keep-alive every 5 s instead of a frame every 500 ms
    if (!m && !c.length && shape === lastBody && now - lastSent < 5e3) return;
    lastBody = shape;
    lastSent = now;
    const body = JSON.stringify({ k: b.key(), s: pv.sid, p: pv.id, cs: b.cs(), b: band(), c, m });
    if (body.length <= 2048) fetch(`${api()}/v1/l`, { method: "POST", body, keepalive: true, credentials: "omit" }).catch(() => 0);
  };
  const beat = async () => {
    const pv = host.current();
    // personal pages (QR letters, tokens) never reach the live board; opt-out/GPC end the heartbeat (§4.7, TR-16)
    if (!pv || pv.personal || b.stopped() || !b.config()?.live.enabled || document.hidden || misses > 1) return;
    try {
      const [top, bottom] = b.allowed("scroll") ? band() : [0, 0];
      // grouped watch (no frames): the clicks since the last beat ride along
      const c = hz && hz < 1 && clicks.length ? `&c=${encodeURIComponent(JSON.stringify(take(5)))}` : "";
      // the path lets the first heartbeat place a new visitor before the first event batch arrives; v=2: this SDK knows hz 2
      const response = await fetch(`${api()}/v1/hb/${b.key()}?s=${pv.sid}&p=${pv.id}&cs=${b.cs()}${bottom ? `&b=${top},${bottom}` : ""}&u=${encodeURIComponent(pv.path)}&w=${innerWidth}&v=2${c}`, { credentials: "omit" });
      // rate limited (429): try again on the next beat; any other error status counts as a miss
      if (response.status === 429) hz = 0;
      else if (!response.ok) throw new Error(String(response.status));
      else hz = ((await response.json()) as HeartbeatResponse).hz;
      misses = 0;
    } catch {
      hz = 0;
      misses += 1;
    }
    clearInterval(timer);
    if (!hz) clicks.length = 0;
    if (hz < 1) samples = [];
    // 2: shown on a board (500 ms); 1: pointer sample (1 s); 0.2: grouped density only – the heartbeat itself carries the band
    timer = hz >= 1 ? setInterval(frame, hz === 2 ? 500 : 1e3) : hz ? setInterval(beat, 5e3) : undefined;
  };
  let seen: (WireEvent & { h?: WireClickHeat }) | undefined;
  host.listen(document, "click", (event) => {
    // the core bound this click's event in the capture phase; an unchanged `last` is an earlier click (this one was not captured)
    const clicked = b.last;
    if (!hz || !clicked || clicked === seen) return;
    seen = clicked;
    const e = event as MouseEvent;
    const at = performance.now();
    // page position ‰ (viewport width, page height) at the click: the board pulses on the element, not at the band edge
    const x = Math.round((e.clientX / innerWidth) * 1e3);
    const y = Math.round(((e.clientY + scrollY) / height()) * 1e3);
    if (pointerOn()) move(e.clientX, e.clientY, at);
    // the heat plugin builds the anchor after the next paint (core finalize, queued before this): read it after that
    requestAnimationFrame(() =>
      setTimeout(() => {
        const h = clicked.h;
        if (!hz || !h?.a || clicks.length > 19) return;
        const row: Click = [h.a, h.ax ?? -1, h.ay ?? -1, at, x, y, early.get(clicked) ?? 0];
        sent.set(clicked, row);
        clicks.push(row);
        if (hz < 1) restart(400);
      }),
    );
  });
  // rage (at once) and dead (after 1 s) from the heat plugin: the same click once more with its kind
  b.flag = (click, kind) => {
    const row = sent.get(click);
    if (!row) return void early.set(click, kind);
    if (!hz || clicks.length > 19) return;
    clicks.push([row[0], row[1], row[2], row[3], row[4], row[5], kind]);
  };
  host.listen(document, "pointermove", (event) => {
    const e = event as PointerEvent;
    if (pointerOn()) move(e.clientX, e.clientY, performance.now());
  }, { passive: true });
  // a resting pointer moves on the page while the page scrolls
  host.listen(window, "scroll", () => {
    if (pointerOn() && px >= 0) move(px, py, performance.now());
  }, { passive: true });
  // one debounced heartbeat for bursts of state changes (start, consent, visibility)
  let soon: ReturnType<typeof setTimeout> | undefined;
  const restart = (ms = 300) => {
    misses = 0;
    clearTimeout(soon);
    soon = setTimeout(beat, ms);
  };
  host.listen(document, "visibilitychange", () => {
    // hidden: nothing is sampled or sent; visible again: ask at once
    if (document.hidden) samples = [];
    else restart();
  });
  b.on.push(() => restart());
  restart(1500);
  setInterval(beat, 3e4);
}
