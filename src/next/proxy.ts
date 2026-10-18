/**
 * @x3growth/sdk/next/proxy – first-party proxy for the SDK (ad blockers and
 * third-party request rules never see the 3x API host):
 *
 *   // app/n3/[...path]/route.ts
 *   import { createX3ProxyHandler } from "@x3growth/sdk/next/proxy";
 *   export const { GET, POST, OPTIONS } = createX3ProxyHandler({
 *     apiOrigin: process.env.X3_API_ORIGIN!,
 *     proxyKey: process.env.X3_PROXY_KEY,
 *   });
 *
 * Web-standard Request → Response, so it also works in any fetch-based server
 * (Hono, Remix, SvelteKit, Workers): `handler.handle(request)`.
 *
 * Forwards only the SDK's path families (/v1/e|collect, /v1/c/{pk}, /v1/cb,
 * /v1/s/{file}; recordings/heatmaps/live: /v1/r, /v1/r/css, /v1/hb/{pk}, /v1/l,
 * /v1/snap[/session], /v1/privacy/{pk}[/erase|/export]); strips cookies and
 * authorization; passes user-agent, origin and the body (recording packets as
 * bytes, ≤ 1 MB); adds the visitor's IP/country/geo (x-3x-client-ip /
 * x-3x-client-country / x-3x-client-geo "CC;region;city;lat;lon" from the edge)
 * and the proxy key (x-3x-proxy-key, server env only), which the API requires
 * before it trusts those headers.
 *
 * Consented visitor id (ARCHITECTURE §10.5): `POST /v1/id` is answered here and
 * never forwarded – `{consent:true}` sets/renews the first-party HttpOnly cookie
 * `x3_vid` (13 months, SameSite=Lax, Secure; server-set, so Safari's ITP does not
 * cap it at 7 days), `{consent:false}` deletes it. On `/v1/e|collect` the cookie
 * value is injected into the batch as `vid` ONLY when the batch says
 * `consent: true` (and the cookie renewed); a batch without consent deletes it.
 * The cookie itself never travels upstream.
 */

import { CLIENT_GEO_HEADER, formatClientGeoHeader, readGeo } from "../_core/index.js";

export type X3ProxyOptions = {
  /** 3x API origin, e.g. https://api.3x.example */
  apiOrigin: string;
  /** secret key with scope ingest:proxy (X3_PROXY_KEY); without it the API sees the proxy's IP */
  proxyKey?: string | null;
  /** upstream timeout (default 10 s) */
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export type X3ProxyHandler = {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
  OPTIONS(request: Request): Promise<Response>;
  handle(request: Request): Promise<Response>;
};

const MAX_BODY_BYTES = 65_536;
const SCRIPT_CACHE = "public, max-age=3600, stale-while-revalidate=86400";
const FORWARDED_REQUEST_HEADERS = ["user-agent", "origin", "content-type", "accept", "accept-language", "referer"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "last-modified", "retry-after", "x-3x-request-id"];

/** "/v1/…" part of the incoming path when it is one the SDK uses, else null */
export function proxiedPath(pathname: string, method: string): string | null {
  const index = pathname.indexOf("/v1/");
  if (index < 0) return null;
  const path = pathname.slice(index);
  if (method === "POST") return /^\/v1\/(?:e|collect|cb|r|r\/css|l|snap|snap\/session)$/.test(path) || /^\/v1\/privacy\/pk_3x_[0-9A-Za-z]{30}\/(?:erase|export)$/.test(path) ? path : null;
  if (method === "GET") return /^\/v1\/(?:c|hb|privacy)\/pk_3x_[0-9A-Za-z]{30}$/.test(path) || /^\/v1\/s\/x3(?:\.[a-z]+)?(?:@[0-9A-Za-z.-]+)?\.js$/.test(path) ? path : null;
  return null;
}

const IP = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:.]{2,45})$/i;

/** Visitor IP from the hosting edge's headers (first x-forwarded-for entry, else x-real-ip) */
export function visitorIp(headers: Headers): string | null {
  for (const candidate of [(headers.get("x-forwarded-for") ?? "").split(",")[0], headers.get("x-real-ip"), headers.get("cf-connecting-ip")]) {
    const value = candidate?.trim().replace(/^\[|\]$/g, "");
    if (value && value.length <= 64 && IP.test(value)) return value;
  }
  return null;
}

/** Visitor country (ISO 3166-1 alpha-2) from Vercel / Cloudflare headers */
export function visitorCountry(headers: Headers): string | null {
  const value = (headers.get("x-vercel-ip-country") ?? headers.get("cf-ipcountry") ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(value) && value !== "XX" ? value : null;
}

/** Body limits per path: recording packets 1 MB (X3R_MAX_PACKET), owner snapshots 4 MB (Vercel's request limit is 4.5 MB) */
function bodyLimit(path: string): number {
  return path === "/v1/r" ? 1024 * 1024 : path === "/v1/snap" ? 4 * 1024 * 1024 : MAX_BODY_BYTES;
}

async function readBytes(request: Request, max = MAX_BODY_BYTES): Promise<ArrayBuffer | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > max) return null;
  const buffer = await request.arrayBuffer();
  return buffer.byteLength > max ? null : buffer;
}

async function readBody(request: Request, max = MAX_BODY_BYTES): Promise<string | null> {
  const buffer = await readBytes(request, max);
  return buffer && new TextDecoder().decode(buffer);
}

/** x-3x-client-geo from the hosting edge (Vercel, else Cloudflare); null when the edge sends no country */
export function visitorGeo(headers: Headers): string | null {
  const geo = readGeo((name) => headers.get(name), false);
  return geo ? formatClientGeoHeader(geo) : null;
}

const empty = (status: number, headers?: Record<string, string>) => new Response(null, { status, headers: { "cache-control": "no-store", ...headers } });

export const VISITOR_COOKIE = "x3_vid";
const VISITOR_MAX_AGE_S = 395 * 86_400;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Valid x3_vid of the request's Cookie header, else null */
export function visitorCookie(headers: Headers): string | null {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.split("=");
    const value = rest.join("=").trim();
    if (name?.trim() === VISITOR_COOKIE && UUID.test(value)) return value.toLowerCase();
  }
  return null;
}

/** Set-Cookie for x3_vid (null = delete); Secure except on plain-http localhost */
export function visitorSetCookie(value: string | null, url: URL): string {
  const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  return `${VISITOR_COOKIE}=${value ?? ""}; Path=/; Max-Age=${value ? VISITOR_MAX_AGE_S : 0}; HttpOnly; SameSite=Lax${local ? "" : "; Secure"}`;
}

export function createX3ProxyHandler(options: X3ProxyOptions): X3ProxyHandler {
  if (!options || typeof options.apiOrigin !== "string" || !/^https?:\/\//.test(options.apiOrigin)) {
    throw new TypeError("createX3ProxyHandler: apiOrigin must be an http(s) origin");
  }
  const origin = options.apiOrigin.replace(/\/+$/, "").replace(/\/v1$/, "");
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  const handle = async (request: Request): Promise<Response> => {
    const method = request.method.toUpperCase();
    if (method === "OPTIONS") return empty(204, { allow: "GET, POST, OPTIONS" });
    if (method !== "GET" && method !== "POST") return empty(405, { allow: "GET, POST, OPTIONS" });
    const url = new URL(request.url);
    const vid = visitorCookie(request.headers);
    if (method === "POST" && url.pathname.endsWith("/v1/id")) {
      const text = await readBody(request);
      let consent = false;
      try {
        consent = (JSON.parse(text ?? "") as { consent?: unknown }).consent === true;
      } catch {
        // not JSON: treated as no consent
      }
      return empty(204, { "set-cookie": visitorSetCookie(consent ? (vid ?? crypto.randomUUID()) : null, url), "x-3x-vid": consent ? "1" : "0" });
    }
    const path = proxiedPath(url.pathname, method);
    if (!path) return empty(404);

    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const ip = visitorIp(request.headers);
    if (ip) headers.set("x-3x-client-ip", ip);
    const country = visitorCountry(request.headers);
    if (country) headers.set("x-3x-client-country", country);
    const geo = visitorGeo(request.headers);
    if (geo) headers.set(CLIENT_GEO_HEADER, geo);
    if (options.proxyKey) headers.set("x-3x-proxy-key", options.proxyKey);

    let body: string | ArrayBuffer | undefined;
    let setCookie: string | null = null;
    if (method === "POST") {
      // recording packets are binary (X3R1 + gzip): forwarded byte for byte
      const text = path === "/v1/r" ? await readBytes(request, bodyLimit(path)) : await readBody(request, bodyLimit(path));
      if (text === null) return empty(413);
      body = text;
      if (/^\/v1\/(?:e|collect)$/.test(path)) {
        try {
          const batch = JSON.parse(text as string) as Record<string, unknown>;
          if (batch && batch.consent === true && vid) {
            body = JSON.stringify({ ...batch, vid });
            setCookie = visitorSetCookie(vid, url);
          } else if (batch && batch.consent === false && vid) {
            setCookie = visitorSetCookie(null, url);
          }
        } catch {
          // forwarded unchanged; the API answers 400
        }
      }
      if (!headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8");
    }
    const query = /^\/v1\/(?:s|hb)\//.test(path) ? url.search : "";

    let upstream: Response;
    try {
      upstream = await doFetch(`${origin}${path}${query}`, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch {
      return empty(502);
    }
    const out = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    // scripts with an inlined config (?k=) keep the API's shorter cache time, so config changes arrive quickly
    if (path.startsWith("/v1/s/") && upstream.ok && !(url.searchParams.has("k") && out.has("cache-control"))) out.set("cache-control", SCRIPT_CACHE);
    if (!out.has("cache-control")) out.set("cache-control", "no-store");
    if (setCookie) out.set("set-cookie", setCookie);
    const payload = upstream.status === 204 || upstream.status === 304 ? null : await upstream.arrayBuffer();
    return new Response(payload, { status: upstream.status, headers: out });
  };

  return { GET: handle, POST: handle, OPTIONS: handle, handle };
}
