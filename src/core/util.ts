import { ID_PATTERN, REACT_GENERATED_ID_PREFIX_PATTERN } from "../_core/index.js";
import { MAX_ID_LENGTH } from "./constants";

/** Tracking must never affect the page (parity P-05): every listener and API call runs through this */
export function guard<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R | undefined {
  return (...args: A) => {
    try {
      return fn(...args);
    } catch {
      return undefined;
    }
  };
}

/** Random UUIDv4 (parity P-02) */
export function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export type StorageArea = "localStorage" | "sessionStorage";

export function storageGet(area: StorageArea, key: string): string | null {
  try {
    return window[area].getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(area: StorageArea, key: string, value: string | null): void {
  try {
    if (value === null) window[area].removeItem(key);
    else window[area].setItem(key, value);
  } catch {
    // storage blocked (private mode, sandbox) – tracking continues in memory
  }
}

/** One cookie value (decoded); null when missing, empty or undecodable */
export function readCookie(name: string): string | null {
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(document.cookie);
  try {
    return (match && decodeURIComponent(match[1] as string)) || null;
  } catch {
    return null;
  }
}

let encoder: TextEncoder | null = null;
/** UTF-8 byte length (batch budget, parity TR-81) */
export function bytes(text: string): number {
  encoder ??= new TextEncoder();
  return encoder.encode(text).length;
}

export const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Element id unless React-generated or not ID-safe (parity TR-31/TR-42) */
export function stableId(el: Element): string | null {
  const id = el.getAttribute("id");
  return id && ID_PATTERN.test(id) && !REACT_GENERATED_ID_PREFIX_PATTERN.test(id) ? id : null;
}

/** File name / free value → ID-safe */
export function idSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, MAX_ID_LENGTH) || "unknown";
}

/** File name of a media URL, ID-safe */
export function fileName(url: string): string {
  return idSafe((url.split(/[?#]/)[0] ?? "").split("/").pop() ?? "");
}

/** Merges the closest gaps until at most `limit` ranges remain (ranges sorted) – parity TR-65/TR-82 */
export function mergeClosest(ranges: Array<[number, number]>, limit: number): void {
  while (ranges.length > limit) {
    let best = 1;
    for (let i = 2; i < ranges.length; i++) {
      const range = ranges[i] as [number, number];
      const before = ranges[i - 1] as [number, number];
      const bestRange = ranges[best] as [number, number];
      const bestBefore = ranges[best - 1] as [number, number];
      if (range[0] - before[1] < bestRange[0] - bestBefore[1]) best = i;
    }
    const target = ranges[best - 1] as [number, number];
    target[1] = Math.max(target[1], (ranges[best] as [number, number])[1]);
    ranges.splice(best, 1);
  }
}

/** Value at a dotted path inside an object ("" = the value itself) */
export function pathValue(source: unknown, path: string): unknown {
  let value = source;
  if (!path) return value;
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** "42" → 42, "true" → true – data-x3-prop-* values */
export function coerce(value: string): string | number | boolean {
  if (value === "true" || value === "false") return value === "true";
  return /^-?\d{1,12}(?:\.\d{1,6})?$/.test(value) ? Number(value) : value;
}
