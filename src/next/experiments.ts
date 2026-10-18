import { fetchAssignments, type X3Assignments } from "../server/experiments";

/**
 * Server-side assignments for Next.js Server Components and route handlers (EXPERIMENTS.md §7.4):
 *
 *   const assignments = await getAssignments({ apiOrigin, publishableKey, proxyKey: process.env.X3_PROXY_KEY!, headers: await headers(), path: "/" });
 *   <X3Analytics publishableKey={KEY} experiments={assignments} />   // the browser starts with the same arms
 *
 * In-memory cache per (IP, user agent, day) for 60 s – short, so harm stops and rollouts arrive
 * within a minute (C18); a timeout of 150 ms answers {} (everyone control, nothing exposed).
 * Pages rendering an arm must not be cached across visitors (dynamic rendering or `private`).
 */

type HeaderLike = { get(name: string): string | null };

export type GetAssignmentsInput = {
  apiOrigin: string;
  publishableKey: string;
  /** secret key with scope ingest:proxy – server env only */
  proxyKey: string;
  headers: HeaderLike;
  /** canonical path of the page being rendered (targeting) */
  path: string;
  keys?: string[];
  timeoutMs?: number;
  fetch?: typeof fetch;
};

const TTL_MS = 60_000;
const MAX_ENTRIES = 5_000;
const cache = new Map<string, { at: number; value: X3Assignments }>();
const IP = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:.]{2,45})$/i;

function ipOf(headers: HeaderLike): string | null {
  for (const candidate of [(headers.get("x-forwarded-for") ?? "").split(",")[0], headers.get("x-real-ip"), headers.get("cf-connecting-ip")]) {
    const value = candidate?.trim();
    if (value && IP.test(value)) return value;
  }
  return null;
}

function vidOf(headers: HeaderLike): string | undefined {
  const match = /(?:^|;\s*)x3_vid=([0-9a-f-]{36})/i.exec(headers.get("cookie") ?? "");
  return match?.[1]?.toLowerCase();
}

export async function getAssignments(input: GetAssignmentsInput): Promise<X3Assignments> {
  const ip = ipOf(input.headers);
  const ua = (input.headers.get("user-agent") ?? "").slice(0, 500);
  if (!ip) return {};
  const host = (input.headers.get("x-forwarded-host") ?? input.headers.get("host") ?? "").split(",")[0]!.trim().toLowerCase().replace(/:\d+$/, "");
  const vid = vidOf(input.headers);
  const key = `${ip}\n${ua}\n${new Date().toISOString().slice(0, 10)}\n${host}${input.path}\n${vid ?? ""}\n${(input.keys ?? []).join(",")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await fetchAssignments({
    apiOrigin: input.apiOrigin,
    publishableKey: input.publishableKey,
    proxyKey: input.proxyKey,
    timeoutMs: input.timeoutMs ?? 150,
    fetch: input.fetch,
    request: { ip, ua, host, path: input.path, ...(vid ? { vid } : {}), ...(input.keys ? { keys: input.keys } : {}) },
  });
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** One key: the arm (control when not enrolled or unknown) */
export async function getVariant(key: string, input: Omit<GetAssignmentsInput, "keys">): Promise<{ arm: string; params: Record<string, unknown>; reason: string }> {
  const assignments = await getAssignments({ ...input, keys: [key] });
  const one = assignments[key];
  return one ? { arm: one.arm, params: one.params, reason: one.reason } : { arm: "control", params: {}, reason: "pending" };
}

/** Tests */
export function forgetAssignments(): void {
  cache.clear();
}

/** window.__x3xp payload for <X3Analytics experiments> (the browser plugin starts with these arms) */
export function inlineAssignments(assignments: X3Assignments): Record<string, { arm: string; u: string | null; r: string; p?: Record<string, unknown> }> {
  return Object.fromEntries(Object.entries(assignments).map(([key, value]) => [key, { arm: value.arm, u: value.unit, r: value.reason, ...(Object.keys(value.params).length ? { p: value.params } : {}) }]));
}
