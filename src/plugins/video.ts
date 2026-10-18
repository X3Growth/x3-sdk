import { normalizeVideoId, type VideoFormat, type WireEvent, type WireVideo } from "../_core/index.js";
import type { CustomVideoTracker, TrackedPageview, VideoOptions, X3Plugin, X3PluginHost } from "../types";
import { fileName, idSafe, mergeClosest, round1 } from "../core/util";
import { MAX_VIDEO_DURATION_S, MAX_VIDEO_PLAYS_PER_PAGEVIEW, MAX_VIDEO_RANGES, MAX_VIDEO_REWATCH_RANGES, MAX_VIDEO_URL_LENGTH } from "../core/constants";

/**
 * Video retention (parity TR-60…TR-67): per play a 100-bucket coverage bitmap,
 * merged watched ranges, watched seconds, max position and completion; since 0.4
 * (BUILD-ADDENDA AG) also the ranges played again within the play (`rw`) and the
 * file URL for frame previews (`u`, http(s) without query/hash).
 * Auto-captures <video controls> and videos inside [data-x3-video]; other
 * players feed positions through x3.video.custom(id).
 */

/** Range ends closer than this (s) are one continuous watched range – parity */
const RANGE_JOIN_S = 0.3;
/** Overlaps up to this (s) are rounding of the open range, not a rewatch */
const REWATCH_MIN_S = 0.1;
const MEDIA_EVENTS = ["play", "pause", "timeupdate", "seeking", "seeked", "ended"];

/** Source of positions: a <video> element or a custom player */
type Media = { time(): number; duration(): number; paused(): boolean; ended(): boolean; connected(): boolean; format(): VideoFormat };

type Play = {
  media: Media;
  pv: TrackedPageview;
  wire: WireVideo;
  bits: Uint8Array;
  /** range currently extended by playback (null after a seek) */
  open: [number, number] | null;
  /** rewatch range currently extended (null when playback leaves watched ground) */
  rwOpen: [number, number] | null;
  /** position at the last progress sample */
  last: number;
  /** queued video_start event – its format is filled in once the metadata is known (TR-62) */
  startEvent: WireEvent | null;
};

export function bitmapHex(bits: Uint8Array): string {
  let out = "";
  for (let i = 0; i < 100; i += 4) out += (((bits[i] ?? 0) << 3) | ((bits[i + 1] ?? 0) << 2) | ((bits[i + 2] ?? 0) << 1) | (bits[i + 3] ?? 0)).toString(16);
  return out;
}

/** Adds a watched range: joins ranges closer than 0.3 s, merges overlaps, keeps ≤ 40 (TR-65) */
export function addRange(ranges: Array<[number, number]>, open: [number, number] | null, from: number, to: number, limit = MAX_VIDEO_RANGES): [number, number] | null {
  const a = round1(from);
  const b = Math.max(a, round1(to));
  if (open && a <= open[1] + RANGE_JOIN_S) {
    open[1] = Math.max(open[1], b);
  } else {
    open = [a, b];
    ranges.push(open);
  }
  ranges.sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < ranges.length; ) {
    const range = ranges[i] as [number, number];
    const before = ranges[i - 1] as [number, number];
    if (range[0] <= before[1]) {
      before[1] = Math.max(before[1], range[1]);
      ranges.splice(i, 1);
    } else {
      i++;
    }
  }
  mergeClosest(ranges, limit);
  return ranges.find((range) => range[0] <= b && b <= range[1]) ?? null;
}

/** Part of [from, to] that already lies inside the watched ranges (played again), or null */
export function rewatched(ranges: ReadonlyArray<[number, number]>, from: number, to: number): [number, number] | null {
  let a = Infinity;
  let b = -Infinity;
  for (const [x, y] of ranges) {
    if (y <= from || x >= to) continue;
    a = Math.min(a, Math.max(from, x));
    b = Math.max(b, Math.min(to, y));
  }
  return b - a > REWATCH_MIN_S ? [a, b] : null;
}

/** Absolute http(s) URL of a video file without query/hash (tokens), ≤ 300 chars – else undefined */
export function videoUrl(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, location.href);
    const clean = url.protocol === "https:" || url.protocol === "http:" ? url.origin + url.pathname : "";
    return clean && clean.length <= MAX_VIDEO_URL_LENGTH ? clean : undefined;
  } catch {
    return undefined;
  }
}

const TITLE_MAX = 80;
const clip = (value: string | null | undefined): string | null => {
  const text = (value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, TITLE_MAX).trim() : null;
};

/**
 * Display name of a <video> for the dashboard: data-x3-video-title (on the video or a wrapper) ›
 * title / aria-label › the <figcaption> of its <figure> › the file name. The server cleans it
 * again (no e-mail/phone-like text, ≤ 80 chars).
 */
export function videoTitleOf(el: HTMLVideoElement, attr: (el: Element) => string | null, selectors: { title: string; wrapper: string }, file: string): { tt: string; ts: NonNullable<WireVideo["ts"]> } | null {
  const marked = el.closest(selectors.title);
  const fromAttr = clip(marked ? attr(marked) : null);
  if (fromAttr) return { tt: fromAttr, ts: "attribute" };
  for (const node of [el, el.closest(selectors.wrapper)]) {
    const label = clip(node?.getAttribute("title")) ?? clip(node?.getAttribute("aria-label"));
    if (label) return { tt: label, ts: "label" };
  }
  const caption = clip(el.closest("figure")?.querySelector("figcaption")?.textContent);
  if (caption) return { tt: caption, ts: "caption" };
  const name = clip(fileName(file).replace(/\.[A-Za-z0-9]+$/, ""));
  return name ? { tt: name, ts: "file" } : null;
}

export function video(): X3Plugin {
  return {
    name: "video",
    install(host: X3PluginHost) {
      if (host.api !== 1) return {};
      const plays = new WeakMap<object, Play>();
      const all = new Set<Play>();
      const manual = new WeakSet<HTMLVideoElement>();
      const declared = new WeakMap<HTMLVideoElement, VideoOptions>();

      const formatOf = (el: HTMLVideoElement): VideoFormat => {
        const fixed = declared.get(el)?.format;
        if (fixed) return fixed;
        const marked = el.closest(host.selector("videoFormat"));
        const value = marked ? host.attr(marked, "videoFormat") : null;
        if (value === "quer" || value === "landscape") return "landscape";
        if (value === "hoch" || value === "portrait") return "portrait";
        if (!el.videoWidth || !el.videoHeight) return "unknown";
        return el.videoHeight > el.videoWidth ? "portrait" : "landscape";
      };

      const elementMedia = (el: HTMLVideoElement): Media => ({
        time: () => el.currentTime,
        duration: () => (Number.isFinite(el.duration) && el.duration > 0 ? Math.min(MAX_VIDEO_DURATION_S, el.duration) : 0),
        paused: () => el.paused,
        ended: () => el.ended,
        connected: () => el.isConnected,
        format: () => formatOf(el),
      });

      /** Counts normal playback since the last sample (no seeking) into seconds, ranges and buckets (TR-64) */
      const progress = (play: Play) => {
        const { media, wire } = play;
        const now = media.time();
        const duration = media.duration();
        if (duration) wire.dur = duration;
        if (wire.fmt === "unknown") {
          wire.fmt = media.format();
          if (play.startEvent?.p && wire.fmt !== "unknown") play.startEvent.p.format = wire.fmt;
        }
        const delta = now - play.last;
        // the final timeupdate before `ended` fires with paused already true
        if (delta > 0 && delta < 1.5 && (!media.paused() || media.ended())) {
          wire.ws += delta;
          const again = rewatched(wire.r, play.last, now);
          if (again) play.rwOpen = addRange((wire.rw ??= []), play.rwOpen, again[0], again[1], MAX_VIDEO_REWATCH_RANGES);
          else play.rwOpen = null;
          play.open = addRange(wire.r, play.open, play.last, now);
          if (duration) {
            const to = Math.min(99, Math.floor((now / duration) * 100));
            for (let i = Math.min(99, Math.floor((play.last / duration) * 100)); i <= to; i++) play.bits[i] = 1;
            wire.b = bitmapHex(play.bits);
          }
        }
        if (duration) wire.mp = Math.max(wire.mp, Math.min(100, Math.round((now / duration) * 100)));
        play.last = now;
      };

      /** New play from < 1 s or after `ended`; resuming a running play is not a new play; ≤ 10 per pageview (TR-63) */
      const onPlay = (ref: object, media: Media, id: string, src: string, title: { tt: string; ts: NonNullable<WireVideo["ts"]> } | null = null, url?: string) => {
        const pv = host.current();
        if (!pv) return;
        host.markActivity();
        const play = plays.get(ref);
        if (play && play.pv === pv && !play.wire.done && media.time() >= 1) {
          play.last = media.time();
          return;
        }
        if (pv.vids.length >= MAX_VIDEO_PLAYS_PER_PAGEVIEW) return;
        const wire: WireVideo = {
          n: pv.vids.length,
          id: idSafe(normalizeVideoId(id)),
          src,
          fmt: media.format(),
          t: host.age(pv),
          dur: media.duration(),
          ws: 0,
          mp: 0,
          done: false,
          b: "0".repeat(25),
          r: [],
          ...(title ? title : {}),
          ...(url ? { u: url } : {}),
        };
        const next: Play = { media, pv, wire, bits: new Uint8Array(100), open: null, rwOpen: null, last: media.time(), startEvent: null };
        plays.set(ref, next);
        all.add(next);
        pv.vids.push(wire);
        next.startEvent = host.emit("video_start", { video: wire.id, n: wire.n, format: wire.fmt });
      };

      const onMediaEvent = (ref: object, type: string) => {
        const play = plays.get(ref);
        const pv = host.current();
        if (!play || !pv || play.pv !== pv) return;
        if (type === "seeking" || type === "seeked") {
          play.last = play.media.time();
          play.open = null;
          play.rwOpen = null;
          return;
        }
        progress(play);
        if (type === "ended" && !play.wire.done) {
          play.wire.done = true;
          host.emit("video_complete", { video: play.wire.id, n: play.wire.n }, { flush: true });
        }
      };

      const tracked = (target: EventTarget | null): HTMLVideoElement | null => {
        if (!(target instanceof HTMLVideoElement)) return null;
        if (manual.has(target)) return target;
        return host.autocapture("video") && (target.hasAttribute("controls") || target.closest(host.selector("video"))) ? target : null;
      };

      const playElement = (el: HTMLVideoElement) => {
        const options = declared.get(el);
        const file = el.currentSrc || el.getAttribute("src") || "";
        const marked = el.closest(host.selector("video"));
        const id = options?.id || (marked ? host.attr(marked, "video") : null) || fileName(file).replace(/\.[A-Za-z0-9]+$/, "");
        const declaredTitle = clip(options?.title);
        const title = declaredTitle ? { tt: declaredTitle, ts: "attribute" as const } : videoTitleOf(el, (node) => host.attr(node, "videoTitle"), { title: host.selector("videoTitle"), wrapper: host.selector("video") }, file);
        onPlay(el, elementMedia(el), id, options?.src ? idSafe(options.src) : fileName(file), title, videoUrl(options?.url ?? file));
      };

      const onElement = (event: Event) => {
        const el = tracked(event.target);
        if (!el) return;
        if (event.type === "play") playElement(el);
        else onMediaEvent(el, event.type);
      };

      // media events do not bubble: capture phase on the document sees every <video> (TR-60)
      for (const type of MEDIA_EVENTS) host.listen(document, type, onElement, { capture: true });

      host.hook({
        active(pv) {
          for (const play of all) {
            if (play.pv !== pv) continue;
            if (!play.media.paused() && !play.media.ended() && play.media.connected()) return true;
          }
          return false;
        },
        end(pv) {
          for (const play of all) if (play.pv === pv) all.delete(play);
        },
      });

      /** Custom players: positions in seconds from the player's API */
      const custom = (id: string, options: VideoOptions = {}): CustomVideoTracker => {
        const ref = {};
        let position = 0;
        let duration = 0;
        let paused = true;
        let ended = false;
        const media: Media = {
          time: () => position,
          duration: () => (duration > 0 ? Math.min(MAX_VIDEO_DURATION_S, duration) : 0),
          paused: () => paused,
          ended: () => ended,
          connected: () => true,
          format: () => options.format ?? "unknown",
        };
        const at = (value: number) => (Number.isFinite(value) && value >= 0 ? value : position);
        return {
          play(positionS, durationS) {
            position = at(positionS);
            duration = at(durationS);
            if (ended) {
              ended = false;
              plays.delete(ref);
            }
            paused = false;
            const title = clip(options.title);
            onPlay(ref, media, id, idSafe(options.src ?? id), title ? { tt: title, ts: "attribute" } : null, videoUrl(options.url));
          },
          progress(positionS, durationS) {
            position = at(positionS);
            if (Number.isFinite(durationS) && durationS > 0) duration = durationS;
            onMediaEvent(ref, "timeupdate");
          },
          pause(positionS) {
            position = at(positionS);
            onMediaEvent(ref, "timeupdate");
            paused = true;
          },
          seek(_fromS, toS) {
            position = at(toS);
            onMediaEvent(ref, "seeked");
          },
          ended() {
            ended = true;
            paused = true;
            onMediaEvent(ref, "ended");
          },
        };
      };

      return {
        track(element: HTMLVideoElement, options: VideoOptions = {}) {
          if (!(element instanceof HTMLVideoElement) || manual.has(element)) return;
          manual.add(element);
          declared.set(element, options);
          if (!element.paused) playElement(element);
        },
        custom,
      };
    },
  };
}
