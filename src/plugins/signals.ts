import type { WirePageviewHeat } from "../_core/index.js";
import type { TrackedPageview, X3Plugin, X3PluginHost } from "../types";

/**
 * x3.signals.js (RECORDINGS-HEATMAPS §1.2 ideas 51/55, §16.3): form field focus/abandon counters
 * (never values), copy intent per element and web vitals (INP, LCP, CLS, LoAF) for the RUM holdout
 * comparison – each only where its capture level allows the current consent state. Element anchors
 * come from x3.heat.js through the bridge; without it, form and copy signals stay empty.
 */
export function signals(): X3Plugin {
  return {
    name: "signals",
    install(host: X3PluginHost) {
      const b = host.behavior();
      const ok = b.allowed;
      // the anchor builder of x3.heat.js (always requested together with this plugin), not a second copy
      const anchor = (el: Element) => b.anchor?.(el) ?? null;
      const forms: Record<string, Record<string, [string, number, 0 | 1, number]>> = {};
      const state = (pv: TrackedPageview): { h: WirePageviewHeat; fm: Record<string, [string, number, 0 | 1, number]> } => ({ h: b.heat(pv.id), fm: (forms[pv.id] ??= {}) });
      // written on hide too: a full page load (link, form post) never ends the pageview in the tracker, only hides it
      const write = (pv: TrackedPageview) => {
        const fm = Object.values(state(pv).fm);
        if (fm.length && ok("forms")) state(pv).h.fm = fm.map((entry) => [...entry] as [string, number, 0 | 1, number]);
      };
      host.hook({
        hide: write,
        end(pv) {
          write(pv);
          delete forms[pv.id];
        },
      });
      // form fields: focus count, focused time, abandoned unless submitted – never values (idea 55)
      let focus: [string, number] | null = null;
      host.listen(document, "focusin", (event) => {
        const el = event.target as Element;
        const pv = host.current();
        const a = pv && ok("forms") && el.matches?.("input,textarea,select") ? anchor(el) : null;
        if (!pv || !a) return;
        const fm = state(pv).fm;
        if (Object.keys(fm).length < 20 || fm[a]) ((fm[a] ??= [a, 0, 1, 0])[1] as number)++;
        focus = [a, Date.now()];
      });
      host.listen(document, "focusout", () => {
        const entry = focus && host.current() && state(host.current() as TrackedPageview).fm[focus[0]];
        if (entry && focus) entry[3] += Date.now() - focus[1];
        focus = null;
      });
      host.listen(document, "submit", () => {
        const pv = host.current();
        if (pv) for (const entry of Object.values(state(pv).fm)) entry[2] = 0;
      });
      // copy intent (idea 51)
      host.listen(document, "copy", () => {
        const pv = host.current();
        const node = getSelection()?.anchorNode;
        const el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
        const a = pv && el && ok("clicks") ? anchor(el) : null;
        if (!pv || !a) return;
        const list = (state(pv).h.cp ??= []);
        const hit = list.find((entry) => entry[0] === a);
        if (hit) hit[1]++;
        else if (list.length < 10) list.push([a, 1]);
      });
      // web vitals for the RUM holdout comparison (§16.3)
      const vital = (type: string, key: "inp" | "lcp" | "cls" | "loaf", read: (entry: PerformanceEntry & { value?: number; hadRecentInput?: boolean }) => number) => {
        try {
          new PerformanceObserver((list) => {
            const pv = host.current();
            if (!pv || !ok("scroll")) return;
            const perf = (state(pv).h.perf ??= {});
            for (const entry of list.getEntries()) perf[key] = key === "cls" ? Math.round(((perf.cls ?? 0) + read(entry)) * 1e3) / 1e3 : Math.max(perf[key] ?? 0, Math.round(read(entry)));
          }).observe({ type, buffered: true } as PerformanceObserverInit);
        } catch {
          // entry type not supported by this browser
        }
      };
      vital("event", "inp", (entry) => entry.duration);
      vital("largest-contentful-paint", "lcp", (entry) => entry.startTime);
      vital("layout-shift", "cls", (entry) => (entry.hadRecentInput ? 0 : (entry.value ?? 0)));
      vital("long-animation-frame", "loaf", (entry) => entry.duration);
      return {};
    },
  };
}
