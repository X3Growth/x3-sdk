import { ID_PATTERN, REACT_GENERATED_ID_PREFIX_PATTERN } from "../_core/index.js";
import type { TrackedPageview, X3Plugin, X3PluginHost } from "../types";

/**
 * Forms (parity TR-50/TR-51 + form_abandon): form_start on the first focus
 * inside a form per pageview, form_submit on submit (sent right away),
 * form_abandon when a started form was not submitted before the pageview
 * ends or the page is left (pagehide; a tab switch is not one). Never values – only the form name and the
 * number of distinct fields that received focus.
 */

type FormState = { name: string; startedAt: number; fields: Set<Element>; submitted: boolean; abandoned: boolean };

export function forms(): X3Plugin {
  return {
    name: "forms",
    install(host: X3PluginHost) {
      if (host.api !== 1) return {};
      let page: TrackedPageview | null = null;
      let states = new Map<HTMLFormElement, FormState>();

      /** data-x3-form (data-track) > stable id > name > form-<index> (TR-51) */
      const nameOf = (form: HTMLFormElement): string => {
        for (const candidate of [host.attr(form, "form"), host.stableId(form), form.getAttribute("name")]) {
          if (candidate && ID_PATTERN.test(candidate) && !REACT_GENERATED_ID_PREFIX_PATTERN.test(candidate)) return candidate;
        }
        return `form-${Array.from(document.forms).indexOf(form) + 1}`;
      };

      const forPage = (): Map<HTMLFormElement, FormState> | null => {
        const pv = host.current();
        if (!pv || !host.autocapture("forms")) return null;
        if (pv !== page) {
          page = pv;
          states = new Map();
        }
        return states;
      };

      host.listen(
        document,
        "focusin",
        (event) => {
          const map = forPage();
          const field = event.target instanceof Element ? event.target : null;
          const form = field?.closest("form");
          if (!map || !form || !field) return;
          let state = map.get(form);
          if (!state) {
            state = { name: nameOf(form), startedAt: Date.now(), fields: new Set(), submitted: false, abandoned: false };
            map.set(form, state);
            host.emit("form_start", { form: state.name });
          }
          if (field !== form) state.fields.add(field);
        },
        { capture: true },
      );

      host.listen(
        document,
        "submit",
        (event) => {
          const map = forPage();
          if (!map || !(event.target instanceof HTMLFormElement)) return;
          const form = event.target;
          const state = map.get(form) ?? { name: nameOf(form), startedAt: Date.now(), fields: new Set<Element>(), submitted: false, abandoned: false };
          state.submitted = true;
          map.set(form, state);
          host.emit("form_submit", { form: state.name }, { flush: true });
        },
        { capture: true },
      );

      const abandon = (pv: TrackedPageview) => {
        if (pv !== page) return;
        for (const state of states.values()) {
          if (state.submitted || state.abandoned) continue;
          state.abandoned = true;
          host.emit("form_abandon", { form: state.name, fields: state.fields.size, ms: Date.now() - state.startedAt });
        }
      };

      host.hook({
        hide: abandon,
        end(pv) {
          abandon(pv);
          if (pv === page) {
            page = null;
            states = new Map();
          }
        },
      });
      return {};
    },
  };
}
