import type { HeartbeatResponse, WireClickHeat, WireEvent } from "../_core/index.js";
import type { X3Plugin, X3PluginHost } from "../types";

/**
 * x3.live.js (RECORDINGS-HEATMAPS §10.3, §20.F): heartbeat every 30 s on visible tabs while live is
 * on in the project ({hz, replay}); while somebody watches, 1 Hz frames (band, clicks, cursor only
 * where the pointer level allows) for visitors whose liveIndividual level allows it, 0.2 Hz band
 * updates via the heartbeat otherwise. The heartbeat is the presence signal of „Besucher jetzt“
 * (a session counts 90 s after its last signal), so an answer with hz = 0 (nobody watches) keeps
 * the 30 s beat; only two failed requests in a row end it until the tab becomes visible again.
 * Clicks: the core binds the click event in the capture phase, but its anchor is built after the
 * next paint (no INP cost), so the plugin reads it then; frames carry them at 1 Hz, a grouped watch
 * (0.2 Hz) sends them with an early heartbeat (`c=` JSON), so the board pulses within ~1 s.
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
  /** failed heartbeat requests in a row (network, HTTP error); hz = 0 is an answer, not a miss */
  let misses = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  /** [anchor, ax, ay, performance.now() of the click, page x ‰, page y ‰]; „ms ago“ is computed when sent */
  const clicks: Array<[string, number, number, number, number, number]> = [];
  const take = (max: number) => clicks.splice(0, max).map(([a, ax, ay, at, x, y]) => [a, ax, ay, Math.max(0, Math.round(performance.now() - at)), x, y]);
  const cursor: number[][] = [];
  const api = () => host.apiHost().replace(/\/$/, "");
  const band = () => {
    const h = Math.max(document.documentElement.scrollHeight, 1);
    return [Math.round((scrollY / h) * 1e3), Math.min(1e3, Math.round(((scrollY + innerHeight) / h) * 1e3))];
  };
  const frame = () => {
    const pv = host.current();
    if (!pv || pv.personal || document.hidden || !b.allowed("liveIndividual")) return;
    const body = JSON.stringify({ k: b.key(), s: pv.sid, p: pv.id, cs: b.cs(), b: band(), c: take(10), u: b.allowed("pointer") ? cursor.splice(0) : undefined });
    if (body.length <= 2048) fetch(`${api()}/v1/l`, { method: "POST", body, keepalive: true, credentials: "omit" }).catch(() => 0);
  };
  const beat = async () => {
    const pv = host.current();
    // personal pages (QR letters, tokens) never reach the live board; opt-out/GPC end the heartbeat (§4.7, TR-16)
    if (!pv || pv.personal || b.stopped() || !b.config()?.live.enabled || document.hidden || misses > 1) return;
    try {
      const [top, bottom] = b.allowed("scroll") ? band() : [0, 0];
      // grouped watch (no frames): the clicks since the last beat ride along
      const c = hz && hz !== 1 && clicks.length ? `&c=${encodeURIComponent(JSON.stringify(take(5)))}` : "";
      // the path lets the first heartbeat place a new visitor before the first event batch arrives
      const response = await fetch(`${api()}/v1/hb/${b.key()}?s=${pv.sid}&p=${pv.id}&cs=${b.cs()}${bottom ? `&b=${top},${bottom}` : ""}&u=${encodeURIComponent(pv.path)}&w=${innerWidth}${c}`, { credentials: "omit" });
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
    // 1 Hz: individual frames; 0.2 Hz: grouped density only – the heartbeat itself carries the band
    timer = hz === 1 ? setInterval(frame, 1e3) : hz ? setInterval(beat, 5e3) : undefined;
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
    const y = Math.round(((e.clientY + scrollY) / Math.max(document.documentElement.scrollHeight, 1)) * 1e3);
    // the heat plugin builds the anchor after the next paint (core finalize, queued before this): read it after that
    requestAnimationFrame(() =>
      setTimeout(() => {
        const h = clicked.h;
        if (!hz || !h?.a || clicks.length > 19) return;
        clicks.push([h.a, h.ax ?? -1, h.ay ?? -1, at, x, y]);
        if (hz !== 1) restart(400);
      }),
    );
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
