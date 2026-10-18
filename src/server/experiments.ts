/**
 * Server-side experiment assignment and visitor follow-up notes (BUILD-ADDENDA W, EXPERIMENTS.md
 * §7.4, §7.8, D7). Self-contained (fetch only) so the Next helper and the server helper share it.
 */

export type X3Assignment = { arm: string; reason: string; unit: string | null; params: Record<string, unknown> };
export type X3Assignments = Record<string, X3Assignment>;

export type AssignRequest = {
  ip: string;
  ua: string;
  /** consented visitor id (x3_vid cookie) when present */
  vid?: string;
  keys?: string[];
  host: string;
  path: string;
  lang?: string;
  /** signed QA token (`x3_force_t`) – unsigned overrides never reach server-side assignment */
  forceToken?: string;
};

type Answer = { a?: Record<string, { arm: string; r: string; u: string | null; p?: Record<string, unknown> }> };

/** POST {api}/v1/x/{pk}/assign with the proxy key (scope ingest:proxy); {} on any error or timeout */
export async function fetchAssignments(input: { apiOrigin: string; publishableKey: string; proxyKey: string; request: AssignRequest; timeoutMs?: number; fetch?: typeof fetch }): Promise<X3Assignments> {
  try {
    const response = await (input.fetch ?? globalThis.fetch)(`${input.apiOrigin.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/x/${encodeURIComponent(input.publishableKey)}/assign`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-3x-proxy-key": input.proxyKey },
      body: JSON.stringify(input.request),
      signal: AbortSignal.timeout(input.timeoutMs ?? 150),
    });
    if (!response.ok) return {};
    const body = (await response.json()) as Answer;
    const out: X3Assignments = {};
    for (const [key, value] of Object.entries(body.a ?? {})) out[key] = { arm: value.arm, reason: value.r, unit: value.u, params: value.p ?? {} };
    return out;
  } catch {
    return {};
  }
}

/** Retries a call that answers 404/409 (lead not created yet) for up to `budgetMs` */
export async function withLeadRetry<T>(call: () => Promise<T>, isRetryable: (error: unknown) => boolean, budgetMs = 60_000, sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<T> {
  const started = Date.now();
  let delay = 500;
  for (;;) {
    try {
      return await call();
    } catch (error) {
      if (!isRetryable(error) || Date.now() - started + delay > budgetMs) throw error;
      await sleep(delay);
      delay = Math.min(delay * 2, 8_000);
    }
  }
}
