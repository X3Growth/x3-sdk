import { WIRE_VERSION, type WireAdCookies, type WireClickIds, type WireEvent, type WireIdentify, type WirePageview } from "../_core/index.js";
import { bytes, mergeClosest } from "./util";
import { MAX_BODY_BYTES, MAX_EVENTS_PER_BATCH, MAX_PAGEVIEWS_PER_BATCH, SHRINK_VIDEO_RANGES } from "./constants";

/**
 * Batching and transport (parity TR-80…TR-82). Batches stay below
 * maxBodyBytes − 512 (UTF-8), hold at most maxPageviewsPerBatch states and
 * maxEventsPerBatch events, every event travels with its pageview's state,
 * one sid per batch, at most one identify per batch.
 */

/** Room left in a batch for events next to a (shrunk) pageview state – parity */
const EVENT_ROOM_BYTES = 1_024;
export const BATCH_BUDGET = MAX_BODY_BYTES - 512;

export type Envelope = {
  k: string;
  sid: string;
  fresh: boolean;
  consent: boolean;
  test: boolean;
  cv?: number;
  lib?: string;
  ac?: WireAdCookies;
  vid?: string;
  ck?: WireClickIds;
};

export type OutboxItem = {
  /** cumulative state; every call is a send and increments seq */
  state(): WirePageview;
  events: WireEvent[];
  identify: WireIdentify | null;
};

/** State JSON within `limit` bytes: video ranges merged first, then the least visible sections dropped (TR-82) */
export function statePart(state: WirePageview, limit: number): string {
  let part = JSON.stringify(state);
  if (bytes(part) <= limit) return part;
  for (const video of state.vids) mergeClosest(video.r, SHRINK_VIDEO_RANGES);
  part = JSON.stringify(state);
  const leastVisibleFirst = Object.keys(state.sec).sort((x, y) => (state.sec[x]?.[1] ?? 0) - (state.sec[y]?.[1] ?? 0));
  for (const name of leastVisibleFirst) {
    if (bytes(part) <= limit) break;
    delete state.sec[name];
    part = JSON.stringify(state);
  }
  return part;
}

/** Splits the pageviews of one sid into wire batches (JSON strings) */
export function buildBatches(envelope: Envelope, items: readonly OutboxItem[], budget: number = BATCH_BUDGET): string[] {
  const head = JSON.stringify({ v: WIRE_VERSION, ...envelope }).slice(0, -1);
  const out: string[] = [];
  const shell = (identify: string) => `${head}${identify ? `,"id":${identify}` : ""},"pvs":[`;
  const base = bytes(`${shell("")}],"ev":[]}`);
  let states: string[] = [];
  let events: string[] = [];
  let identify = "";
  let used = base;
  const cost = (parts: string[], part: string) => bytes(part) + (parts.length ? 1 : 0);
  const send = () => {
    if (states.length) out.push(`${shell(identify)}${states.join(",")}],"ev":[${events.join(",")}]}`);
    states = [];
    events = [];
    identify = "";
    used = base;
  };
  const addState = (item: OutboxItem) => {
    const part = statePart(item.state(), budget - base - EVENT_ROOM_BYTES);
    if (states.length && (used + cost(states, part) > budget || states.length >= MAX_PAGEVIEWS_PER_BATCH)) send();
    used += cost(states, part);
    states.push(part);
  };
  for (const item of items) {
    const ident = item.identify ? JSON.stringify(item.identify) : "";
    if (ident && (identify || used + bytes(ident) + 6 > budget)) send();
    addState(item);
    if (ident) {
      identify = ident;
      used += bytes(ident) + 6;
    }
    for (const event of item.events) {
      const part = JSON.stringify(event);
      if (used + cost(events, part) > budget || events.length >= MAX_EVENTS_PER_BATCH) {
        send();
        addState(item);
      }
      used += cost(events, part);
      events.push(part);
    }
  }
  send();
  return out;
}

/** text/plain JSON via sendBeacon, fallback fetch(keepalive, credentials same-origin: cookies only reach a same-origin proxy) – a CORS simple request (TR-80) */
export function post(url: string, body: string): void {
  try {
    if (typeof navigator.sendBeacon === "function" && navigator.sendBeacon(url, new Blob([body], { type: "text/plain;charset=UTF-8" }))) return;
  } catch {
    // fall through to fetch
  }
  try {
    void fetch(url, { method: "POST", keepalive: true, credentials: "same-origin", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body }).catch(() => {});
  } catch {
    // never affect the page
  }
}
