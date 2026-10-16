import type { Attribution, AttributionOrigin } from "../_core/index.js";
import { createPersist } from "../core/persist";
import type { TrackedPageview, X3Plugin } from "../types";

/**
 * Customer-journey persistence (ARCHITECTURE §10.5, x3.journeys.js): after
 * consent the first-party visitor id x3_vid, persisted click ids x3_clk and the
 * Meta/TikTok match cookies (_fbp, _fbc, _ttp) per ClientConfig.journeys. The
 * core requests this plugin only on a consent decision, so visitors without
 * consent never download it; a denial/revocation deletes what it stored.
 */
export function journeys(): X3Plugin {
  return {
    name: "journeys",
    install(host) {
      const persist = createPersist(() => host.config().journeys, host.apiHost, host.consent);
      const page = (pageview: TrackedPageview) => {
        const pv = pageview as TrackedPageview & { attrFrom?: AttributionOrigin; attr?: Attribution };
        if (host.consent() && !pv.personal) persist.page(pv.attrFrom === "url" ? pv.attr : undefined);
      };
      if (host.consent()) persist.grant();
      else if (host.consentDenied()) persist.revoke(false);
      host.hook({
        begin: page,
        consent(granted, wasGranted) {
          if (!granted) return persist.revoke(wasGranted);
          persist.grant();
          const current = host.current();
          if (current) page(current);
        },
      });
      return persist;
    },
  };
}
