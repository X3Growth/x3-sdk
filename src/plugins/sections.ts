import { ID_PATTERN, slugify } from "../_core/index.js";
import type { TrackedPageview, X3Plugin, X3PluginHost } from "../types";
import { guard } from "../core/util";
import { MAX_ID_LENGTH, MAX_SECTIONS_PER_PAGEVIEW, SECTION_VIEWPORT_COVER, SECTION_VISIBLE_RATIO } from "../core/constants";

/**
 * Section reach (parity TR-30…TR-34): which sections were in view, when first
 * and for how long. Candidates are [data-x3-section] (+ data-track-section)
 * plus top-level <section> elements, at most 40 in DOM order.
 */

const SECTION_THRESHOLDS = [0, 0.25, 0.5, 0.75, 1];
const MUTATION_DEBOUNCE_MS = 500;

export function sections(): X3Plugin {
  return {
    name: "sections",
    install(host: X3PluginHost) {
      if (host.api !== 1) return;
      const els = new Map<Element, string>();
      const intersecting = new Set<Element>();
      const visible = new Set<string>();
      let observer: IntersectionObserver | null = null;
      let mutations: MutationObserver | null = null;
      let mutationTimer: ReturnType<typeof setTimeout> | null = null;
      let page: TrackedPageview | null = null;

      const markers = () => host.selector("section");
      const candidates = () => `${markers()},section`;

      /** data-x3-section (ID-safe) > stable id > slug of the first h1–h3 > s<index>; personal pages always s<index> (TR-31) */
      const nameOf = (el: Element, index: number, personal: boolean): string => {
        // headings and ids may contain the recipient's name on personal pages
        if (personal) return `s${index}`;
        const attr = host.attr(el, "section");
        if (attr && ID_PATTERN.test(attr)) return attr;
        return host.stableId(el) ?? (slugify(el.querySelector("h1,h2,h3")?.textContent ?? null) || `s${index}`);
      };

      const unique = (base: string, used: Set<string>): string => {
        if (!used.has(base)) return base;
        for (let k = 2; ; k++) {
          const suffix = `-${k}`;
          const name = `${base.slice(0, MAX_ID_LENGTH - suffix.length)}${suffix}`;
          if (!used.has(name)) return name;
        }
      };

      /**
       * In view: at least half of the section visible, or it covers half of
       * the viewport (tall sections). Evaluated from the element rects on
       * intersection changes and on every scroll sample, because a section
       * taller than the viewport never crosses the ratio thresholds (TR-32).
       */
      const evaluate = () => {
        const pv = host.current();
        if (!pv || pv !== page || !host.deviceReads()) return;
        const viewport = window.innerHeight;
        for (const [el, name] of els) {
          let inView = false;
          if (intersecting.has(el)) {
            const rect = el.getBoundingClientRect();
            const shown = Math.min(rect.bottom, viewport) - Math.max(rect.top, 0);
            inView = shown > 0 && (shown >= rect.height * SECTION_VISIBLE_RATIO || shown >= viewport * SECTION_VIEWPORT_COVER);
          }
          if (!inView) {
            visible.delete(name);
            continue;
          }
          visible.add(name);
          if (!pv.sec[name] && Object.keys(pv.sec).length < MAX_SECTIONS_PER_PAGEVIEW) pv.sec[name] = [host.age(pv), 0];
        }
      };

      const onIntersect = (entries: IntersectionObserverEntry[]) => {
        for (const entry of entries) {
          if (entry.isIntersecting && els.has(entry.target)) intersecting.add(entry.target);
          else intersecting.delete(entry.target);
        }
        evaluate();
      };

      /** Rescan: disconnected elements are unobserved and removed, new candidates observed (TR-30, TR-34) */
      const scan = () => {
        const pv = host.current();
        if (!pv || pv !== page || !host.deviceReads() || typeof IntersectionObserver === "undefined") return;
        observer ??= new IntersectionObserver(guard(onIntersect), { threshold: SECTION_THRESHOLDS });
        for (const [el, name] of els) {
          if (el.isConnected) continue;
          observer.unobserve(el);
          els.delete(el);
          intersecting.delete(el);
          visible.delete(name);
        }
        const used = new Set(els.values());
        let index = 0;
        const all = candidates();
        const marked = markers();
        for (const el of Array.from(document.querySelectorAll(all))) {
          // nested <section>s count only when explicitly marked
          if (!el.matches(marked) && el.parentElement?.closest(all)) continue;
          index++;
          if (index > MAX_SECTIONS_PER_PAGEVIEW) break;
          if (els.has(el)) continue;
          const name = unique(nameOf(el, index, pv.personal), used);
          used.add(name);
          els.set(el, name);
          observer.observe(el);
        }
      };

      const reset = () => {
        observer?.disconnect();
        els.clear();
        intersecting.clear();
        visible.clear();
        mutations?.disconnect();
        if (mutationTimer) clearTimeout(mutationTimer);
        mutationTimer = null;
      };

      const watch = () => {
        if (typeof MutationObserver === "undefined" || !document.body) return;
        mutations ??= new MutationObserver(
          guard(() => {
            mutationTimer ??= setTimeout(
              guard(() => {
                mutationTimer = null;
                scan();
              }),
              MUTATION_DEBOUNCE_MS,
            );
          }),
        );
        mutations.observe(document.body, { childList: true, subtree: true });
      };

      const start = (pv: TrackedPageview) => {
        reset();
        if (!host.autocapture("sections")) return;
        page = pv;
        scan();
        watch();
      };

      host.hook({
        begin: start,
        reads: start,
        sample: evaluate,
        tick(pv, delta) {
          if (pv !== page) return;
          for (const name of visible) {
            const section = pv.sec[name];
            if (section) section[1] += delta;
          }
        },
        end(pv) {
          if (pv === page) {
            reset();
            page = null;
          }
        },
        sectionOf(el) {
          for (let node: Element | null = el; node; node = node.parentElement) {
            const name = els.get(node);
            if (name) return name;
          }
          return undefined;
        },
      });
      return {};
    },
  };
}
