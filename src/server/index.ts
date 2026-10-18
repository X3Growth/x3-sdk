/**
 * @x3growth/sdk/server – server helper for the site's backend (Node 18+, edge
 * runtimes, Next.js route handlers / server actions):
 *
 *   import { createX3Server, requestContext } from "@x3growth/sdk/server";
 *   const x3 = createX3Server({ apiUrl: process.env.X3_API_URL!, apiKey: process.env.X3_SECRET_KEY!, project: process.env.X3_PROJECT_ID });
 *   await x3.leads.create({ sessionId, email, form: "contact", conversion: { definition: "lead", ...requestContext(request) } });
 *   await x3.purchase({ orderId: "1042", value: 89.9, currency: "EUR", sessionId, email, ...requestContext(request) });
 *   await x3.refund({ orderId: "1042", value: 20 });
 *
 * Secret keys (sk_3x_…) never belong in the browser. Contact data is sent in
 * plaintext over TLS and hashed by the API on receipt (never stored in plaintext).
 * The bundle is self-contained (no zod, no @3x/core/client at runtime).
 */
import { validFbCookie, type ConversionSource } from "../_core/index.js";
import { fetchAssignments, withLeadRetry, type AssignRequest, type X3Assignments } from "./experiments";

export { fetchAssignments, type AssignRequest, type X3Assignment, type X3Assignments } from "./experiments";

/** re-exported so declaration files of consumers can name it (TS2742) */
export type { ConversionSource };

type Scalar = string | number | boolean;

/** Request context of the visitor (transient match keys for ad-platform conversions) */
export type X3RequestContext = {
  clientIp?: string;
  clientUserAgent?: string;
  fbp?: string;
  fbc?: string;
  ttp?: string;
};

/** POST /v1/projects/{project}/conversions (schema ConversionCreate) */
export type X3ConversionInput = X3RequestContext & {
  definition?: string;
  /** default "api" */
  source?: ConversionSource;
  /** from the browser's getIds() */
  sessionId?: string;
  pageviewId?: string;
  /** no session id: find the session by time window (+ UTM / WhatsApp click) */
  match?: { at: string; windowMinutes?: number; utmContent?: string; utmCampaign?: string; requireWhatsapp?: boolean; includeTest?: boolean };
  allowUnmatched?: boolean;
  occurredAt?: string;
  value?: number;
  currency?: string;
  note?: string;
  /** shared with the browser pixel for deduplication (default: generated) */
  eventId?: string;
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  externalId?: string;
  company?: string;
  eventSourceUrl?: string;
  attribution?: Record<string, string>;
  isTest?: boolean;
  leadId?: string;
  upload?: boolean;
  allowDuplicate?: boolean;
  dryRun?: boolean;
};

/** POST /v1/projects/{project}/leads (schema LeadCreate) */
export type X3LeadInput = {
  form?: string;
  sessionId?: string;
  pageviewId?: string;
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  externalId?: string;
  traits?: Record<string, Scalar>;
  /** {questionnaire id: {question id: option value}} */
  answers?: Record<string, Record<string, string>>;
  score?: number;
  grade?: string;
  /** short qualification summary shown in the lead list */
  summary?: string;
  /** free text (stored only when the project stores plaintext PII) */
  message?: string;
  /** honeypot / spam flag: excluded from lists, MCP and conversion triggers by default */
  spam?: boolean;
  attribution?: Record<string, string>;
  isTest?: boolean;
  /** CRM routing: false = never push · connection ids, aliases („sales“) or CRM names („hubspot“); omitted = routing rules, else every connected CRM */
  crm?: false | string[];
  /** ms (0–5000) to wait for the CRM result in the response (e.g. for a link in a Slack message); default 0 = background */
  crmWait?: number;
  /** also record a conversion of this definition */
  conversion?: X3RequestContext & { definition: string; eventId?: string; value?: number };
};

/** One server-side event attached to a browser session (schema ServerEvent) */
export type X3ServerEvent = {
  /** required: getIds().sessionId from the browser */
  sessionId: string;
  pageviewId?: string;
  name: string;
  props?: Record<string, Scalar>;
  occurredAt?: string;
};

export type X3ServerEventsResult = { accepted: number; rejected: Array<{ index: number; code: string; message: string }> };

/** POST /v1/projects/{project}/purchases (schema PurchaseInput): one purchase = one conversion, reported every time */
export type X3PurchaseInput = X3RequestContext & {
  /** your shop's order id – the dedupe key (the same order again is answered with `duplicate`) */
  orderId: string;
  /** gross order value ≥ 0 in `currency` */
  value: number;
  /** ISO 4217, e.g. "EUR" (converted into the project currency for reports; sent as is to the platforms) */
  currency: string;
  items?: number;
  occurredAt?: string;
  /** from the browser's getIds(): attribution and click ids come from the visit */
  sessionId?: string;
  leadId?: string;
  email?: string;
  phone?: string;
  externalId?: string;
  /** shared with the browser pixel's Purchase event (default: derived from the order id) */
  eventId?: string;
  eventSourceUrl?: string;
  isTest?: boolean;
  dryRun?: boolean;
};

export type X3PurchaseResult = {
  /** created · duplicate (same order id – nothing new reported) · dry_run */
  result: "created" | "duplicate" | "dry_run";
  orderId: string;
  conversion: ConversionRow | null;
  /** platforms the purchase went (or goes) to */
  reported: string[];
  /** value in the project currency (null while no exchange rate exists) */
  projectValue: number | null;
  projectCurrency?: string;
  /** fx_missing: held until the exchange rate exists, then reported */
  heldReason?: "server_confirmation" | "fx_missing" | null;
};

/** POST /v1/projects/{project}/purchases/refunds (schema RefundInput) */
export type X3RefundInput = {
  orderId: string;
  /** refunded amount in the order's currency; omitted = everything that is left */
  value?: number;
  /** when the refund happened (default: now) – the same orderId + value + at again changes nothing */
  at?: string;
  note?: string;
};

export type X3RefundResult = { result: "refunded" | "unchanged"; orderId: string; conversionId: string; refundedValue: number; refundedAt: string; netValue: number };
type ConversionRow = Record<string, unknown> & { id: string; eventId: string; status: string };
export type X3ConversionResult =
  | { result: "created" | "duplicate"; conversion: ConversionRow }
  | { result: "ambiguous"; candidates: Array<Record<string, unknown> & { sessionId: string }> }
  | { result: "dry_run"; wouldStore: Record<string, unknown> };
export type X3LeadResult = {
  lead: Record<string, unknown> & { id: string };
  conversionId: string | null;
  /** one entry per routed CRM (status „done“ with the record url when crmWait was long enough) */
  crm?: Array<{ connection: string; provider: string; status: "queued" | "held" | "done" | "needs_review" | "skipped" | "failed"; url: string | null; decision: string | null }>;
};

export type X3ServerOptions = {
  /** API origin, e.g. https://api.3x.example (no /v1) */
  apiUrl: string;
  /** secret key sk_3x_… with the needed scopes (events:write, leads:write, conversions:write) */
  apiKey: string;
  /** project id (uuid); default: the only project the key can access */
  project?: string;
  fetch?: typeof fetch;
  /** per request (default 10 s) */
  timeoutMs?: number;
  /** experiments.assign: the project's publishable key (pk_3x_…) */
  publishableKey?: string;
  /** experiments.assign: a secret key with scope ingest:proxy (default: apiKey) */
  proxyKey?: string;
};

/** RFC 9457 problem returned by the API */
export class X3ServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly problem: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = "X3ServerError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const randomId = (): string => globalThis.crypto.randomUUID();

export function createX3Server(options: X3ServerOptions) {
  if (!options || typeof options.apiUrl !== "string" || !options.apiUrl) throw new TypeError("createX3Server: apiUrl is required");
  if (typeof options.apiKey !== "string" || !options.apiKey.startsWith("sk_3x_")) throw new TypeError("createX3Server: apiKey must be a secret key (sk_3x_…)");
  if (options.project !== undefined && !UUID.test(options.project)) throw new TypeError("createX3Server: project must be a project id (uuid)");
  const base = options.apiUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  let projectId: Promise<string> | null = options.project ? Promise.resolve(options.project.toLowerCase()) : null;

  async function request<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${options.apiKey}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const response = await doFetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (!response.ok) {
      let problem: Record<string, unknown> | null = null;
      try {
        problem = (await response.json()) as Record<string, unknown>;
      } catch {
        // no problem body
      }
      const code = typeof problem?.code === "string" ? problem.code : `http_${response.status}`;
      const detail = typeof problem?.detail === "string" ? problem.detail : typeof problem?.title === "string" ? problem.title : response.statusText;
      throw new X3ServerError(response.status, code, detail || code, problem);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  const project = (): Promise<string> => {
    projectId ??= request<{ data: Array<{ id: string }> }>("GET", "/v1/projects").then((result) => {
      const ids = result.data.map((entry) => entry.id);
      if (ids.length !== 1) throw new X3ServerError(400, "project_required", `the key can access ${ids.length} projects – pass createX3Server({ project })`, null);
      return ids[0] as string;
    });
    projectId.catch(() => {
      projectId = null;
    });
    return projectId;
  };

  const projectPath = async (suffix: string) => `/v1/projects/${encodeURIComponent(await project())}${suffix}`;

  return {
    /** project id the helper talks to (resolved once when not configured) */
    project,
    conversions: {
      /**
       * Records a conversion and uploads it to the configured destinations. Deduplicated by the
       * API on `eventId` (a repeat answers `duplicate`). Without `eventId` the API generates one –
       * and a call with `sessionId` + `definition` then confirms the session's held web
       * conversion (requireServerConfirmation), so the helper never invents an eventId. The
       * Idempotency-Key is random per call (stable across this request only): reusing the
       * eventId as key would replay the first answer (`created`) instead of `duplicate` and
       * reject a real call after a dry run with the same eventId.
       */
      async create(input: X3ConversionInput): Promise<X3ConversionResult> {
        const body = { source: "api" as const, ...input };
        return request("POST", await projectPath("/conversions"), body, randomId());
      },
    },
    events: {
      /** server-side events attached to a browser session (sessionId from getIds() is required) */
      async track(events: X3ServerEvent | X3ServerEvent[], idempotencyKey?: string): Promise<X3ServerEventsResult> {
        const list = Array.isArray(events) ? events : [events];
        if (!list.length) return { accepted: 0, rejected: [] };
        for (const event of list) {
          if (!event || typeof event.sessionId !== "string" || !UUID.test(event.sessionId)) throw new TypeError("events.track: sessionId (from the browser's getIds()) is required");
        }
        return request("POST", await projectPath("/events"), { events: list }, idempotencyKey ?? randomId());
      },
    },
    leads: {
      /** records a lead (optionally with a conversion); contact data is hashed by the API */
      async create(input: X3LeadInput, idempotencyKey?: string): Promise<X3LeadResult> {
        return request("POST", await projectPath("/leads"), input, idempotencyKey ?? randomId());
      },
      /**
       * Follow-up free text from the visitor for an existing lead (quiz step „Möchtest Du noch etwas
       * ergänzen?“): by lead id or by the Idempotency-Key used for leads.create – works while the
       * create is still in flight (retries 404/409 for up to 60 s). Never a new lead or conversion;
       * the text is personal data (readable with leads:read only). Needs leads:write.
       */
      async addNote(ref: { leadId: string } | { idempotencyKey: string }, text: string): Promise<{ id: string; leadId: string }> {
        const path = await projectPath("/leads/notes");
        return withLeadRetry(
          () => request<{ id: string; leadId: string }>("POST", path, { ...ref, text }),
          (error) => error instanceof X3ServerError && (error.status === 404 || error.status === 409),
        );
      },
    },
    experiments: {
      /**
       * Server-side assignment (prices/offers, server-rendered arms): the visitor's IP/UA (+ consented
       * x3_vid) → arms of the running experiments. Answers {} after 150 ms or on any error (= control).
       */
      async assign(input: AssignRequest): Promise<X3Assignments> {
        if (!options.publishableKey) throw new TypeError("experiments.assign: createX3Server({ publishableKey }) is required");
        return fetchAssignments({ apiOrigin: base, publishableKey: options.publishableKey, proxyKey: options.proxyKey ?? options.apiKey, request: input, fetch: doFetch });
      },
    },
    purchases: { create: purchase, refund },
    /**
     * Records a completed purchase (shop mode). Every order is its own conversion and is reported to
     * the enabled platforms (Meta Purchase, Google Ads, TikTok) with value, currency and order id –
     * repeat purchases of the same person count. Sending the same orderId again is safe: the API
     * answers `duplicate`.
     */
    purchase,
    /** Refunds an order fully (value omitted) or partly; revenue becomes net of refunds, nothing is re-reported */
    refund,
    requestContext,
  };

  async function purchase(input: X3PurchaseInput): Promise<X3PurchaseResult> {
    assertPurchase(input);
    // the order id is the dedupe key on the server (a repeat answers `duplicate`); the Idempotency-Key is
    // random per call – a key derived from the order would replay `created` and reject a corrected body
    return request("POST", await projectPath("/purchases"), input, randomId());
  }

  async function refund(input: X3RefundInput): Promise<X3RefundResult> {
    if (!input || typeof input.orderId !== "string" || !ORDER_ID.test(input.orderId)) throw new TypeError("refund: orderId (1–100 chars [A-Za-z0-9_.:#/-]) is required");
    if (input.value !== undefined && (typeof input.value !== "number" || !Number.isFinite(input.value) || input.value <= 0)) throw new TypeError("refund: value must be a positive number");
    const body = { ...input, at: input.at ?? new Date().toISOString() };
    // orderId + value + at identify a refund on the server: sending the same body again changes nothing
    return request("POST", await projectPath("/purchases/refunds"), body, randomId());
  }
}

export type X3Server = ReturnType<typeof createX3Server>;

const ORDER_ID = /^[A-Za-z0-9_.:#/-]{1,100}$/;

function assertPurchase(input: X3PurchaseInput): void {
  if (!input || typeof input.orderId !== "string" || !ORDER_ID.test(input.orderId)) throw new TypeError("purchase: orderId (1–100 chars [A-Za-z0-9_.:#/-]) is required");
  if (typeof input.value !== "number" || !Number.isFinite(input.value) || input.value < 0) throw new TypeError("purchase: value must be a number ≥ 0");
  if (typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency)) throw new TypeError("purchase: currency must be an ISO 4217 code like EUR");
  if (input.sessionId !== undefined && !UUID.test(input.sessionId)) throw new TypeError("purchase: sessionId must be the browser's getIds().sessionId");
}

type HeaderSource = Request | { headers: Headers | Record<string, string | string[] | undefined> };

function header(source: HeaderSource, name: string): string | null {
  const headers = source.headers;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  const value = (headers as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

const IP = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:.]{2,45})$/i;

/** First valid address of x-forwarded-for, else x-real-ip / cf-connecting-ip (set by the hosting edge) */
export function clientIpFrom(source: HeaderSource): string | undefined {
  const candidates = [(header(source, "x-forwarded-for") ?? "").split(",")[0], header(source, "x-real-ip"), header(source, "cf-connecting-ip")];
  for (const candidate of candidates) {
    const value = candidate?.trim().replace(/^\[|\]$/g, "");
    if (value && value.length <= 64 && IP.test(value)) return value;
  }
  return undefined;
}

/** Cookie value by name from a Cookie header */
export function cookieValue(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/**
 * Visitor context for conversions: client IP (trusted edge headers), user agent
 * and the ad cookies _fbp/_fbc/_ttp (shape-checked; set by the site's pixels
 * only after consent). Spread it into conversions.create / leads.create({conversion}).
 */
export function requestContext(source: HeaderSource): X3RequestContext {
  const out: X3RequestContext = {};
  const ip = clientIpFrom(source);
  if (ip) out.clientIp = ip;
  const ua = header(source, "user-agent");
  if (ua) out.clientUserAgent = ua.slice(0, 500);
  const cookies = header(source, "cookie");
  for (const [name, kind] of [["_fbp", "fbp"], ["_fbc", "fbc"], ["_ttp", "ttp"]] as const) {
    const valid = validFbCookie(cookieValue(cookies, name), kind);
    if (valid) out[kind] = valid;
  }
  return out;
}
