import type { BookingAdapter, ClientConfig } from "../_core/index.js";
import type { Props, TrackedPageview, X3Plugin, X3PluginHost } from "../types";
import { pathValue } from "../core/util";

/**
 * Booking adapters and window-event bridges (parity TR-77/TR-78, PARITY §12):
 * HubSpot meetings postMessage, same-origin message types, window events,
 * thank-you pages and Calendly → booking {via}; configured window events →
 * any event (e.g. site:quiz-submitted → quiz_submit).
 */

type Bridge = ClientConfig["bridges"][number];

const CALENDLY_ORIGIN = "https://calendly.com";

/** The adapter's `via` when a postMessage reports a booking, else null */
export function bookingFromMessage(adapters: readonly BookingAdapter[], origin: string, data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  for (const adapter of adapters) {
    if (adapter.type === "postmessage") {
      if (origin === adapter.origin && Object.entries(adapter.match).every(([name, value]) => record[name] === value)) return adapter.via;
    } else if (adapter.type === "message_type") {
      if (origin === window.location.origin && record.type === adapter.messageType) return adapter.via;
    } else if (adapter.type === "calendly") {
      if (origin === CALENDLY_ORIGIN && record.event === "calendly.event_scheduled") return adapter.via;
    }
  }
  return null;
}

/** Props of a bridged window event: prop name → dotted path into event.detail */
export function bridgeProps(bridge: Bridge, detail: unknown): Props {
  const props: Props = {};
  for (const [name, path] of Object.entries(bridge.props)) {
    const value = pathValue(detail, path);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") props[name] = value;
  }
  return props;
}

export function bookings(): X3Plugin {
  return {
    name: "bookings",
    install(host: X3PluginHost) {
      if (host.api !== 1) return {};
      const config = host.config();
      const booked = (via: string) => host.emit("booking", { via }, { flush: true });

      host.listen(window, "message", (event) => {
        const message = event as MessageEvent;
        const via = bookingFromMessage(config.bookings, message.origin, message.data);
        if (via) booked(via);
      });
      for (const adapter of config.bookings) {
        if (adapter.type === "window_event") host.listen(window, adapter.event, () => booked(adapter.via));
      }
      for (const bridge of config.bridges) {
        host.listen(window, bridge.event, (event) => {
          host.emit(bridge.emit, bridgeProps(bridge, (event as CustomEvent<unknown>).detail), { flush: bridge.flush });
        });
      }

      /** thank-you pages reached while the site's pending flag is set (e.g. __bookingPending) */
      const thankYou = (pv: TrackedPageview) => {
        for (const adapter of config.bookings) {
          if (adapter.type !== "thank_you" || !adapter.paths.includes(pv.path)) continue;
          if (adapter.windowFlag && !(window as unknown as Record<string, unknown>)[adapter.windowFlag]) continue;
          booked(adapter.via);
        }
      };
      host.hook({ begin: thankYou });
      return {};
    },
  };
}
