/**
 * @x3growth/sdk/next – Next.js App Router adapter. Server-component safe (no
 * hooks, no "use client"): renders next/script with strategy afterInteractive.
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
};

/** JSON for an inline <script>: "<" escaped so the payload cannot close the tag */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function X3Analytics({ publishableKey, host = "/n3", config, nonce, build = "full", consent, debug, hashRouting }: X3AnalyticsProps) {
  const base = host.replace(/\/+$/, "");
  const file = build === "core" ? "x3.js" : "x3.full.js";
  const inline = `${QUEUE_STUB}${config ? `window.__x3cfg=${inlineJson(config)};` : ""}`;
  const src = `${base}/v1/s/${file}${config ? "" : `?k=${encodeURIComponent(publishableKey)}`}`;
  const data: Record<string, string> = { "data-key": publishableKey, "data-host": base };
  if (consent) data["data-consent"] = consent;
  if (debug) data["data-debug"] = "";
  if (hashRouting) data["data-hash-routing"] = "";
  return (
    <>
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
