import { createExperiments } from "../core/experiments";
import type { X3Plugin } from "../types";

/**
 * Experiments (x3.experiments.js, BUILD-ADDENDA W): assignment, exposures and the /v1/x request.
 * The core requests it only when the project config carries experiments; until it arrives
 * x3.variant() answers control (no exposure) and records the code call, so sites without
 * experiments never download it.
 */
export function experiments(): X3Plugin {
  return {
    name: "experiments",
    install(host) {
      const api = createExperiments({
        config: () => host.config(),
        page: () => {
          const pv = host.current() as (ReturnType<typeof host.current> & { host?: string; lang?: string | null }) | null;
          return pv?.host ? { host: pv.host, path: pv.path, lang: pv.lang ?? null } : null;
        },
        enrollable: () => host.enrollable(),
        consent: () => host.consent(),
        apiHost: () => host.apiHost(),
        key: () => host.publishableKey(),
        emit: (props) => void host.emit("experiment_view", props, { flush: true }),
        markTest: () => host.markTest(),
        call: (key) => host.experimentCall(key),
      });
      host.hook({ begin: () => api.pageview(), consent: () => api.refresh() });
      if (host.current()) api.pageview();
      return api;
    },
  };
}
