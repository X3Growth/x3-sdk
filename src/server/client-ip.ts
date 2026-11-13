/**
 * The visitor's IP address on the customer's server (security audit 12.11.2026, FE-04): the first-party proxy hands it
 * to the API with the proxy key, which makes the API trust it for rate limits, budgets, the visitor hash and the
 * conversion context. A client may send its own `X-Forwarded-For`; Cloudflare, nginx (proxy_add_x_forwarded_for), Fly,
 * Render and most Node setups append the address they saw to it, so its FIRST entry is whatever the client wrote.
 *
 * Rule, in this order:
 * 1. `clientIp(headers)` of the options (e.g. the socket address of your own Node server);
 * 2. the header the hosting platform sets itself: Vercel `x-real-ip`, Netlify `x-nf-client-connection-ip`,
 *    Cloudflare Workers `cf-connecting-ip` (detected from the runtime, never from a request header);
 * 3. `x-forwarded-for` read from the RIGHT, like Rails' RemoteIp: internal proxies (private, loopback, link-local
 *    addresses) are skipped, then `trustedProxies - 1` further public proxies (a CDN in front of the load balancer); the
 *    next entry is the visitor. Entries left of it are whatever the client wrote and never count;
 * 4. `x-real-ip`.
 */

export type HeaderGetter = { get(name: string): string | null };

export type ClientIpOptions = {
  /** your own extraction of the visitor address; wins over every header rule */
  clientIp?: (headers: HeaderGetter) => string | null | undefined;
  /** proxies in front of this server that append to x-forwarded-for (default 1: the address the nearest one saw) */
  trustedProxies?: number;
};

export type HostingPlatform = "vercel" | "netlify" | "cloudflare" | null;

/** IPv4, or IPv6 (at least one colon); brackets of `[2001:db8::1]` are removed before */
const IP = /^(?:\d{1,3}(?:\.\d{1,3}){3}|(?=[0-9a-f.]*:)[0-9a-f:.]{2,45})$/i;

/** A well-formed address or null */
export function validIp(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/^\[|\]$/g, "");
  return trimmed && trimmed.length <= 64 && IP.test(trimmed) ? trimmed : null;
}

/** The hosting platform this code runs on (from the runtime, never from a request) */
export function hostingPlatform(): HostingPlatform {
  // no Node types here: the declarations of the package are emitted without them (edge runtimes have no `process`)
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (env?.VERCEL) return "vercel";
  if (env?.NETLIFY || (globalThis as { Netlify?: unknown }).Netlify) return "netlify";
  if (typeof navigator !== "undefined" && (navigator as { userAgent?: string }).userAgent === "Cloudflare-Workers") return "cloudflare";
  return null;
}

const PLATFORM_HEADER: Record<Exclude<HostingPlatform, null>, string> = { vercel: "x-real-ip", netlify: "x-nf-client-connection-ip", cloudflare: "cf-connecting-ip" };

/** The visitor's address by the rule above; null when none is determinable */
export function clientIpOf(headers: HeaderGetter, options: ClientIpOptions = {}, platform: HostingPlatform = hostingPlatform()): string | null {
  if (options.clientIp) return validIp(options.clientIp(headers) ?? null);
  if (platform) {
    const own = validIp(headers.get(PLATFORM_HEADER[platform]));
    if (own) return own;
  }
  return fromForwardedFor(headers.get("x-forwarded-for"), options.trustedProxies ?? 1) ?? validIp(headers.get("x-real-ip"));
}

/**
 * An address of an internal proxy (never a visitor on the internet): RFC 1918, loopback, link-local, carrier-grade NAT,
 * IPv6 loopback, unique-local and link-local, also as IPv4-mapped IPv6. Documentation ranges count as public here.
 */
export function isInternalAddress(address: string): boolean {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  const v4 = mapped ? mapped[1] : /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address) ? address : null;
  if (v4) {
    const [a, b] = v4.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = address.toLowerCase();
  return v6 === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(v6) || /^fe[89ab][0-9a-f]?:/.test(v6);
}

/** The visitor's entry of an x-forwarded-for chain, read from the right (see the rule above); null when none */
function fromForwardedFor(header: string | null, trustedProxies: number): string | null {
  if (!header) return null;
  const chain = header.split(",").map((entry) => validIp(entry));
  let index = chain.length - 1;
  // internal proxies (load balancers, ingress) append their private neighbours: skip them
  while (index >= 0 && chain[index] !== null && isInternalAddress(chain[index] as string)) index -= 1;
  // all internal: the visitor is in the same network, the nearest entry stands
  if (index < 0) return chain[chain.length - 1] ?? null;
  // public proxies in front of this server (a CDN before the load balancer)
  index -= Math.max(0, Math.floor(trustedProxies) - 1);
  return index >= 0 ? (chain[index] ?? null) : null;
}
