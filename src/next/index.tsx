/**
 * @x3growth/sdk/next – Next.js App Router adapter. Server-component safe (no
 * hooks, no "use client"). An inline script in the server-rendered HTML starts
 * the SDK script right away, so the first pageview does not wait for hydration
 * (a visitor who leaves before hydration finished was not counted); the same
 * script through next/script (afterInteractive) is the fallback when a CSP
 * blocks the inline part (the SDK ignores a second load).
 *
 *   // app/layout.tsx
 *   import { X3Analytics, fetchClientConfig } from "@x3growth/sdk/next";
 *   const config = await fetchClientConfig({ apiOrigin: process.env.X3_API_ORIGIN!, publishableKey: KEY });
 *   <X3Analytics publishableKey={KEY} host="/n3" config={config} />
 *
 * The script is served through the first-party proxy (app/n3/[...path]/route.ts,
 * @x3growth/sdk/next/proxy). Route changes are detected by the SDK's History
 * API hook – no usePathname/useSearchParams, so static rendering stays intact.
 */
import Script from "next/script";
import type { ClientConfig } from "../_core/index.js";
import type { ConsentState } from "../types";
import type { X3Assignments } from "../server/experiments";
import { inlineAssignments } from "./experiments";

export { getAssignments, getVariant, type GetAssignmentsInput } from "./experiments";
export type { X3Assignment, X3Assignments } from "../server/experiments";

export const QUEUE_STUB = "window.x3=window.x3||function(){(window.x3q=window.x3q||[]).push(arguments)};";

export type X3AnalyticsProps = {
  publishableKey: string;
  /** proxy path or API origin (default "/n3") */
  host?: string;
  /** client config fetched on the server (skips the config request in the browser) */
  config?: ClientConfig | null;
  /** CSP nonce for the inline queue stub and the script */
  nonce?: string;
  /** "full" (default: every plugin bundled) or "core" (plugins load lazily) */
  build?: "full" | "core";
  consent?: ConsentState;
  debug?: boolean;
  /** hash routers */
  hashRouting?: boolean;
  /**
   * "early" (default): an inline script starts the SDK before hydration, next/script is the fallback;
   * "afterInteractive": only next/script (e.g. a CSP without nonce for inline scripts)
   */
  strategy?: "early" | "afterInteractive";
  /** server-side experiment assignments (getAssignments) – the browser starts with the same arms (no flicker, no /v1/x request) */
  experiments?: X3Assignments | null;
};

/** JSON for an inline <script>: "<" escaped so the payload cannot close the tag */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * Inline loader: appends the async SDK script while the HTML is parsed (not after hydration).
 * document.currentScript.nonce carries the nonce over; boot() reads the data-* attributes.
 */
export function earlyLoader(src: string, data: Record<string, string>): string {
  return `(function(d){var c=d.currentScript,s=d.createElement("script");s.async=true;s.src=${inlineJson(src)};var a=${inlineJson(data)};for(var k in a)s.setAttribute(k,a[k]);if(c&&c.nonce)s.nonce=c.nonce;(d.head||d.documentElement).appendChild(s)})(document);`;
}

export function X3Analytics({ publishableKey, host = "/n3", config, nonce, build = "full", consent, debug, hashRouting, strategy = "early", experiments }: X3AnalyticsProps) {
  const base = host.replace(/\/+$/, "");
  const file = build === "core" ? "x3.js" : "x3.full.js";
  const assigned = experiments && Object.keys(experiments).length > 0 ? `window.__x3xp=${inlineJson(inlineAssignments(experiments))};` : "";
  const inline = `${QUEUE_STUB}${config ? `window.__x3cfg=${inlineJson(config)};` : ""}${assigned}`;
  const src = `${base}/v1/s/${file}${config ? "" : `?k=${encodeURIComponent(publishableKey)}`}`;
  const data: Record<string, string> = { "data-key": publishableKey, "data-host": base };
  if (consent) data["data-consent"] = consent;
  if (debug) data["data-debug"] = "";
  if (hashRouting) data["data-hash-routing"] = "";
  return (
    <>
      {strategy === "early" && <script id="x3-early" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: `${inline}${earlyLoader(src, data)}` }} />}
      <Script id="x3-init" strategy="afterInteractive" nonce={nonce} dangerouslySetInnerHTML={{ __html: inline }} />
      <Script id="x3" strategy="afterInteractive" src={src} nonce={nonce} {...data} />
    </>
  );
}

/**
 * GET {apiOrigin}/v1/c/{publishableKey} on the server (cached 60 s by Next's
 * fetch cache). Returns null on any error – the browser then fetches the
 * config itself.
 */
export async function fetchClientConfig(input: { apiOrigin: string; publishableKey: string; revalidate?: number; timeoutMs?: number }): Promise<ClientConfig | null> {
  try {
    const response = await fetch(`${input.apiOrigin.replace(/\/+$/, "")}/v1/c/${encodeURIComponent(input.publishableKey)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(input.timeoutMs ?? 3_000),
      next: { revalidate: input.revalidate ?? 60 },
    } as RequestInit);
    if (!response.ok) return null;
    const config = (await response.json()) as unknown;
    return config && typeof config === "object" && typeof (config as ClientConfig).rev === "number" ? (config as ClientConfig) : null;
  } catch {
    return null;
  }
}
