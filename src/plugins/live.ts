import type { HeartbeatResponse } from "../_core/index.js";
import type { X3Plugin, X3PluginHost } from "../types";

/**
 * x3.live.js (RECORDINGS-HEATMAPS §10.3, §20.F): heartbeat every 30 s on visible tabs while live is
 * on in the project ({hz, replay}); while somebody watches, 1 Hz frames (band, clicks, cursor only
 * where the pointer level allows) for visitors whose liveIndividual level allows it, 0.2 Hz band
 * updates via the heartbeat otherwise; stops after two answers with hz = 0.
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

/** Live heartbeat (30 s, visible tab) and frames while somebody watches (§10.3, §20.F) */
function start(host: X3PluginHost): void {
  const b = host.behavior();
  let hz: HeartbeatResponse["hz"] = 0;
  let misses = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const clicks: Array<[string, number, number, number, number, number]> = [];
  const cursor: number[][] = [];
  const api = () => host.apiHost().replace(/\/$/, "");
  const band = () => {
    const h = Math.max(document.documentElement.scrollHeight, 1);
    return [Math.round((scrollY / h) * 1e3), Math.min(1e3, Math.round(((scrollY + innerHeight) / h) * 1e3))];
  };
  const frame = () => {
    const pv = host.current();
    if (!pv || pv.personal || document.hidden || !b.allowed("liveIndividual")) return;
    const body = JSON.stringify({ k: b.key(), s: pv.sid, p: pv.id, cs: b.cs(), b: band(), c: clicks.splice(0, 10), u: b.allowed("pointer") ? cursor.splice(0) : undefined });
    if (body.length <= 2048) fetch(`${api()}/v1/l`, { method: "POST", body, keepalive: true, credentials: "omit" }).catch(() => 0);
  };
  const beat = async () => {
    const pv = host.current();
    // personal pages (QR letters, tokens) never reach the live board; opt-out/GPC end the heartbeat (§4.7, TR-16)
    if (!pv || pv.personal || b.stopped() || !b.config()?.live.enabled || document.hidden || misses > 1) return;
    try {
      const [top, bottom] = b.allowed("scroll") ? band() : [0, 0];
      // the path lets the first heartbeat place a new visitor before the first event batch arrives
      hz = ((await (await fetch(`${api()}/v1/hb/${b.key()}?s=${pv.sid}&p=${pv.id}&cs=${b.cs()}${bottom ? `&b=${top},${bottom}` : ""}&u=${encodeURIComponent(pv.path)}&w=${innerWidth}`, { credentials: "omit" })).json()) as HeartbeatResponse).hz;
    } catch {
      hz = 0;
    }
    misses = hz ? 0 : misses + 1;
    clearInterval(timer);
    // 1 Hz: individual frames; 0.2 Hz: grouped density only – the heartbeat itself carries the band
    timer = hz === 1 ? setInterval(frame, 1e3) : hz ? setInterval(beat, 5e3) : undefined;
  };
  host.listen(document, "click", (event) => {
    const h = b.last?.h;
    const e = event as MouseEvent;
    // page position ‰ (viewport width, page height): the board pulses on the element, not at the band edge
    if (hz && h?.a) clicks.push([h.a, h.ax ?? -1, h.ay ?? -1, Math.round(performance.now() - event.timeStamp), Math.round((e.clientX / innerWidth) * 1e3), Math.round(((e.clientY + scrollY) / Math.max(document.documentElement.scrollHeight, 1)) * 1e3)]);
  });
  let lastMove = 0;
  host.listen(document, "pointermove", (event) => {
    const e = event as PointerEvent;
    if (hz !== 1 || e.timeStamp - lastMove < 250 || cursor.length > 7) return;
    lastMove = e.timeStamp;
    cursor.push([Math.round((e.clientX / innerWidth) * 1e3), Math.round(((e.clientY + scrollY) / Math.max(document.documentElement.scrollHeight, 1)) * 1e3)]);
  }, { passive: true });
  // one debounced heartbeat for bursts of state changes (start, consent, visibility)
  let soon: ReturnType<typeof setTimeout> | undefined;
  const restart = (ms = 300) => {
    misses = 0;
    clearTimeout(soon);
    soon = setTimeout(beat, ms);
  };
  host.listen(document, "visibilitychange", () => !document.hidden && restart());
  b.on.push(() => restart());
  restart(1500);
  setInterval(beat, 3e4);
}
