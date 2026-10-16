/**
 * @x3growth/sdk/presets – bridges for existing funnel tracking hooks (funnel
 * stages, quiz answers, quiz-submitted window event, booking adapters, booking
 * conversion beacon) and CMP adapters. They store the standard preset events,
 * so history stays comparable (parity TR-74…TR-79, CV-04).
 *
 *   import { bridgeFunnelStage, reportBooking } from "@x3growth/sdk/presets";
 */
import type { BookingAdapter } from "../_core/index.js";
import { uuid } from "../core/util";
import { tracker } from "../instance";
import { bookingFromMessage } from "../plugins/bookings";
import { CMP_ADAPTERS, type CmpName } from "../plugins/consent";
import type { ConversionOptions } from "../types";

export { CMP_ADAPTERS, type CmpName };

/** funnelBeacon reach(): quiz_seen → quiz_view, contact_reached → quiz_contact, cta_click → cta_click with the last click's label/section (TR-74) */
export function bridgeFunnelStage(stage: string, variant?: string): void {
  tracker.bridges.funnelStage(stage, variant);
}

/** funnelBeacon recordAnswer() → quiz_answer {variant, q, value}; the server adds the 1-based step (TR-75) */
export function bridgeQuizAnswer(variant: string, questionId: string, value: string): void {
  tracker.bridges.quizAnswer(variant, questionId, value);
}

/** funnelBeacon track(): whatsapp_click (with the last click's section), calculator_used (TR-76) */
export function bridgeFunnelEvent(event: string): void {
  tracker.bridges.funnelEvent(event);
}

const detailOf = (event: Event): Record<string, unknown> | null => {
  const detail = (event as CustomEvent<unknown>).detail;
  return detail && typeof detail === "object" ? (detail as Record<string, unknown>) : null;
};

/** Window event {variant} → quiz_submit + immediate send (TR-77; pass your site's event name, default "x3:quiz-submitted"). Returns an unsubscribe function. */
export function listenQuizSubmitted(eventName = "x3:quiz-submitted"): () => void {
  if (typeof window === "undefined") return () => undefined;
  const listener = (event: Event) => {
    try {
      const variant = detailOf(event)?.variant;
      tracker.quiz.submit(typeof variant === "string" ? variant : undefined);
    } catch {
      // never affect the page
    }
  };
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
}

/**
 * Booking adapters without project config (TR-78): postMessage embeds
 * (HubSpot meetings, Calendly), same-origin message types, window events and
 * thank-you pages → booking {via} once per pageview. Returns an unsubscribe function.
 */
export function listenBookings(adapters: BookingAdapter[]): () => void {
  if (typeof window === "undefined") return () => undefined;
  const cleanups: Array<() => void> = [];
  const on = (type: string, listener: (event: Event) => void) => {
    const guarded = (event: Event) => {
      try {
        listener(event);
      } catch {
        // never affect the page
      }
    };
    window.addEventListener(type, guarded);
    cleanups.push(() => window.removeEventListener(type, guarded));
  };
  on("message", (event) => {
    const message = event as MessageEvent;
    const via = bookingFromMessage(adapters, message.origin, message.data);
    if (via) tracker.booking(via);
  });
  for (const adapter of adapters) {
    if (adapter.type === "window_event") on(adapter.event, () => tracker.booking(adapter.via));
    if (adapter.type === "thank_you") {
      const flag = adapter.windowFlag ? (window as unknown as Record<string, unknown>)[adapter.windowFlag] : true;
      const path = window.location.pathname.replace(/\/+$/, "") || "/";
      if (flag && adapter.paths.includes(path)) tracker.booking(adapter.via);
    }
  }
  return () => cleanups.splice(0).forEach((fn) => fn());
}

/** Unique id shared by a browser pixel event and the server-side conversion (dedupe, CV-04) */
export function newEventId(): string {
  try {
    return uuid();
  } catch {
    return `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

type BookingWindow = Window & { __x3BookingEventId?: string; __x3BookingReported?: boolean };

/** One event id per booking and page – the site's pixel, adapters and the beacon share it (CV-04) */
export function bookingEventId(): string {
  if (typeof window === "undefined") return newEventId();
  const w = window as BookingWindow;
  w.__x3BookingEventId ??= newEventId();
  return w.__x3BookingEventId;
}

export type BookingContact = NonNullable<ConversionOptions["contact"]>;

/**
 * Reports a booking conversion once per page through the browser beacon
 * (POST {host}/v1/cb); contact data is hashed in the browser. Resolves with the event id (null when not sent).
 */
export async function reportBooking(contact: BookingContact = {}, options: { definition?: string } = {}): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const w = window as BookingWindow;
  if (w.__x3BookingReported) return null;
  w.__x3BookingReported = true;
  const clean = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
  return tracker.conversion(options.definition ?? "booking", {
    eventId: bookingEventId(),
    contact: { email: clean(contact.email, 320), phone: clean(contact.phone, 40), firstName: clean(contact.firstName, 100), lastName: clean(contact.lastName, 100) },
  });
}

/** Subscribes one CMP adapter without project config: its decisions call consent() (ARCHITECTURE §14.1) */
export function bridgeCmp(name: CmpName): () => void {
  if (typeof window === "undefined") return () => undefined;
  const adapter = CMP_ADAPTERS[name];
  const controller = new AbortController();
  let last: string | null = null;
  const report = (state: "granted" | "denied") => {
    if (state === last) return;
    last = state;
    tracker.consent(state);
  };
  const check = () => {
    try {
      const state = adapter.read();
      if (state) report(state);
    } catch {
      // CMP not ready
    }
  };
  adapter.subscribe((target, type, listener) => target.addEventListener(type, listener, { signal: controller.signal }), check, report);
  check();
  return () => controller.abort();
}
