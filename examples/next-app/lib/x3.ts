// Calls the tracker that <X3Analytics> loads (window.x3). Commands issued before the
// script has loaded are queued and replayed in order.
type X3Command = (...args: unknown[]) => void;

export function x3(...args: unknown[]): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { x3?: X3Command; x3q?: unknown[][] };
  w.x3 ??= (...queued: unknown[]) => void (w.x3q ??= []).push(queued);
  w.x3(...args);
}

// usage in a client component:
//   x3("track", "plan_selected", { plan: "pro" });
//   x3("consent", "granted");
