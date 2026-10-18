import { encodeX3r, X3R_FLAGS, type X3rHeader } from "../../_core/index.js";

/**
 * Packets of a recording (RECORDINGS-HEATMAPS §5.6): flush every 10 s or 100 KB, the first packet
 * right after the full snapshot, gzip via CompressionStream (fflate as fallback), X3R1 framing with
 * the upload secret, CSS dedupe against /v1/r/css, `ok`/`off` text answers, two retries with
 * backoff, the last packet ≤ 40 KB with keepalive after the core beacon.
 */

type Event = { type: number; timestamp: number; data: Record<string, unknown> };
export type Sender = { host: string; key: string; secret: string; header: () => Omit<X3rHeader, "seq" | "t0" | "f" | "k" | "us" | "v"> };

export const FLUSH_MS = 10_000;
export const FLUSH_BYTES = 100 * 1024;
export const FINAL_MAX = 40 * 1024;

let fflateLoader: (() => Promise<(data: Uint8Array) => Uint8Array>) | null = null;
let syncGzip: ((data: Uint8Array) => Uint8Array) | null = null;
/** Registered by the plugin: lazy x3.fflate.js (script tag) or import("fflate") (npm) */
export function setFflateLoader(loader: () => Promise<(data: Uint8Array) => Uint8Array>): void {
  fflateLoader = loader;
}
/** Preloads fflate's gzipSync for the last packet (pagehide leaves no time for async compression) */
export async function preloadSyncGzip(): Promise<void> {
  if (!syncGzip && fflateLoader) syncGzip = await fflateLoader().catch(() => null);
}

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "function") {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (!fflateLoader) throw new Error("no gzip available");
  return (await fflateLoader())(data);
}

async function sha256(text: string): Promise<string> {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Replaces inline stylesheets the server already knows with {_x3css: sha} (65 % of a typical snapshot, §5.6) */
export async function dedupeCss(events: Event[], known: Set<string>, ask: (hashes: string[]) => Promise<string[]>): Promise<void> {
  const nodes: Array<{ attributes: Record<string, unknown> }> = [];
  const walk = (node: { attributes?: Record<string, unknown>; childNodes?: unknown[] }) => {
    if (node.attributes && typeof node.attributes._cssText === "string") nodes.push(node as { attributes: Record<string, unknown> });
    for (const child of node.childNodes ?? []) walk(child as typeof node);
  };
  for (const event of events) if (event.type === 2 && event.data.node) walk(event.data.node as never);
  if (nodes.length === 0) return;
  const hashes = await Promise.all(nodes.map((node) => sha256(node.attributes._cssText as string)));
  const unknown = [...new Set(hashes.filter((hash) => !known.has(hash)))];
  const missing = new Set(unknown.length > 0 ? await ask(unknown).catch(() => unknown) : []);
  hashes.forEach((hash, index) => {
    const node = nodes[index] as { attributes: Record<string, unknown> };
    if (!missing.has(hash)) {
      delete node.attributes._cssText;
      node.attributes._x3css = hash;
    }
    known.add(hash);
  });
}

export type Chunker = {
  push(event: Event): void;
  flush(final?: boolean): Promise<void>;
  stopped(): boolean;
  stop(reason?: "off" | "revoke"): void;
  bytes(): number;
};

export function createChunker(sender: Sender, options: { onOff: () => void; known: Set<string> }): Chunker {
  let buffer: Event[] = [];
  let size = 0;
  let seq = 0;
  let total = 0;
  let off = false;
  let busy = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const post = async (bytes: Uint8Array, keepalive: boolean): Promise<string> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(`${sender.host}/v1/r`, { method: "POST", body: new Blob([bytes as BlobPart], { type: "text/plain" }), credentials: "omit", keepalive });
        if (response.status === 429 || response.status === 403 || response.status === 413 || response.status === 422) return "off";
        return (await response.text()).trim();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    return "error";
  };

  const send = async (events: Event[], flags: number, keepalive: boolean) => {
    if (events.length === 0 && !(flags & X3R_FLAGS.revoke)) return;
    if (events.some((event) => event.type === 2)) {
      flags |= X3R_FLAGS.full;
      await dedupeCss(events, options.known, async (hashes) => {
        const response = await fetch(`${sender.host}/v1/r/css`, { method: "POST", body: JSON.stringify({ k: sender.key, hashes }), credentials: "omit", headers: { "content-type": "text/plain" } });
        return ((await response.json()) as { missing: string[] }).missing;
      });
    }
    const raw = new TextEncoder().encode(events.map((event) => JSON.stringify(event)).join("\n"));
    // last packet: synchronous gzip if fflate is there, else raw when it fits (the server accepts both)
    const body = keepalive ? (syncGzip ? syncGzip(raw) : raw) : await gzip(raw);
    if (keepalive && body.byteLength > FINAL_MAX) return;
    const packet = encodeX3r({ ...sender.header(), k: sender.key, us: sender.secret, v: 1, seq: seq++, t0: events[0]?.timestamp ?? Date.now(), f: flags }, body);
    total += packet.byteLength;
    const answer = await post(packet, keepalive);
    if (answer === "off") {
      off = true;
      options.onOff();
    }
  };

  const chunker: Chunker = {
    push(event) {
      if (off) return;
      buffer.push(event);
      const full = event.type === 2;
      // a full snapshot flushes at once: no size estimate (a JSON.stringify of the whole DOM on the main thread)
      if (!full) size += JSON.stringify(event.data).length;
      if (full || size >= FLUSH_BYTES) void chunker.flush();
      else timer ??= setTimeout(() => void chunker.flush(), FLUSH_MS);
    },
    flush(final = false) {
      if (timer) clearTimeout(timer);
      timer = null;
      const events = buffer;
      buffer = [];
      size = 0;
      busy = busy.then(() => (off ? undefined : send(events, final ? X3R_FLAGS.final : 0, final))).catch(() => undefined);
      return busy;
    },
    stopped: () => off,
    stop(reason = "off") {
      if (timer) clearTimeout(timer);
      buffer = [];
      if (reason === "revoke" && !off) busy = busy.then(() => send([], X3R_FLAGS.revoke, true)).catch(() => undefined);
      off = true;
    },
    bytes: () => total,
  };
  return chunker;
}
