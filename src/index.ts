/**
 * @x3growth/sdk – cookieless first-party analytics for any website.
 *
 *   import { init, track } from "@x3growth/sdk";
 *   init({ key: "pk_3x_…", host: "/n3" });
 *   track("signup_started", { plan: "pro" });
 *
 * The script-tag build exposes the same API as window.x3 (x3.js / x3.full.js).
 */
import { tracker } from "./instance";
import type { X3Api } from "./types";

export * from "./types";
export { VERSION } from "./version";

/** the tracker as one object (same shape as window.x3 of the script-tag build) */
export const x3: X3Api = tracker;

export const init: X3Api["init"] = (options) => tracker.init(options);
export const track: X3Api["track"] = (name, props, options) => tracker.track(name, props, options);
export const goal: X3Api["goal"] = (name, props) => tracker.goal(name, props);
export const funnelStep: X3Api["funnelStep"] = (funnel, step) => tracker.funnelStep(funnel, step);
export const page: X3Api["page"] = (path) => tracker.page(path);
export const identify: X3Api["identify"] = (data) => tracker.identify(data);
export const conversion: X3Api["conversion"] = (definition, options) => tracker.conversion(definition, options);
export const lead: X3Api["lead"] = (data) => tracker.lead(data);
export const consent: X3Api["consent"] = (state) => tracker.consent(state);
export const flush: X3Api["flush"] = () => tracker.flush();
export const getIds: X3Api["getIds"] = () => tracker.getIds();
export const optOut: X3Api["optOut"] = () => tracker.optOut();
export const optIn: X3Api["optIn"] = () => tracker.optIn();
