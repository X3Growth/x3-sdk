import { createX3ProxyHandler } from "@x3growth/sdk/next/proxy";

// First-party proxy: the browser talks to your domain, the handler forwards to X3 with the proxy key.
// X3_PROXY_KEY is a server-only secret – never prefix it with NEXT_PUBLIC_.
export const { GET, POST, OPTIONS } = createX3ProxyHandler({
  apiOrigin: process.env.X3_API_ORIGIN ?? "https://api.x3growth.io",
  proxyKey: process.env.X3_PROXY_KEY,
});
