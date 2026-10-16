import { bridgeToScriptTag } from "./core/bridge";
import { createTracker, type Tracker } from "./core/tracker";
import type { PluginName, X3Plugin } from "./types";
import { LIB, VERSION } from "./version";

/**
 * The npm build's tracker singleton (shared by ".", "/react", "/presets").
 * Kept on globalThis so ESM and CJS copies of the package share one tracker.
 * Plugins the project config enables are code-split and loaded on demand.
 * Without init() on a page that loads x3.js, calls go to the script-tag tracker.
 */

const loaders: Record<PluginName, () => Promise<X3Plugin>> = {
  video: () => import("./plugins/video").then((m) => m.video()),
  sections: () => import("./plugins/sections").then((m) => m.sections()),
  forms: () => import("./plugins/forms").then((m) => m.forms()),
  identify: () => import("./plugins/identify").then((m) => m.identify()),
  consent: () => import("./plugins/consent").then((m) => m.consent()),
  bookings: () => import("./plugins/bookings").then((m) => m.bookings()),
  journeys: () => import("./plugins/journeys").then((m) => m.journeys()),
};

const store = globalThis as typeof globalThis & { __x3sdk?: Tracker };

function createLocal(): Tracker {
  const local: Tracker = createTracker({
    lib: LIB,
    version: VERSION,
    defaultHost: () => "/n3",
    load(name) {
      void loaders[name]()
        .then((plugin) => local.register(plugin))
        .catch(() => undefined);
    },
  });
  return local;
}

/** forwards to window.x3 when the page uses the script tag and never calls init() (core/bridge.ts) */
export const tracker: Tracker = (store.__x3sdk ??= bridgeToScriptTag(createLocal()));
