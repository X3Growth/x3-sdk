import type { X3Plugin, X3PluginHost } from "../types";

/**
 * x3("privacy") – the visitor's privacy panel on the customer's site (RECORDINGS-HEATMAPS §4.7):
 * status, stop capturing, delete and show the data of this device. The device proves ownership
 * with its secret (in memory, persisted as x3_psec only after consent); a session id alone never
 * reveals or deletes anything. In the name of the controller (the site owner), not X3.
 */

const de = () => (document.documentElement.lang || navigator.language || "de").toLowerCase().startsWith("de");
const t = (german: string, english: string) => (de() ? german : english);

export function privacy(): X3Plugin {
  return {
    name: "privacy",
    install(host: X3PluginHost) {
      const bridge = host.behavior();
      let panel: HTMLElement | null = null;
      const base = () => host.apiHost().replace(/\/$/, "");
      const request = async (path: "erase" | "export") => {
        const response = await fetch(`${base()}/v1/privacy/${bridge.key()}/${path}`, { method: "POST", body: JSON.stringify({ k: bridge.key(), proof: bridge.secret ?? "" }), credentials: "omit", headers: { "content-type": "text/plain" } });
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<Record<string, unknown>>;
      };
      const open = () => {
        panel?.remove();
        const cfg = bridge.config();
        const active = bridge.allowed("clicks") || bridge.allowed("scroll") || bridge.allowed("recording");
        panel = document.createElement("div");
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-modal", "true");
        panel.setAttribute("aria-label", t("Datenschutz", "Privacy"));
        panel.setAttribute("data-x3-ignore", "");
        panel.style.cssText = "position:fixed;inset:auto 16px 16px auto;max-width:360px;z-index:2147483647;padding:16px;border-radius:12px;background:#fff;color:#16181d;font:14px/1.5 system-ui,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.25)";
        const status = document.createElement("p");
        status.textContent = active ? t("Erfassung auf diesem Gerät: aktiv", "Capturing on this device: active") : t("Erfassung auf diesem Gerät: aus", "Capturing on this device: off");
        const who = document.createElement("p");
        who.style.cssText = "margin:0 0 12px;color:#5d6370;font-size:13px";
        who.textContent = `${t("Verantwortlich", "Controller")}: ${cfg?.privacy.controller ?? location.hostname}${cfg?.privacy.contact ? ` · ${cfg.privacy.contact}` : ""}`;
        const out = document.createElement("p");
        out.setAttribute("aria-live", "polite");
        const button = (label: string, action: () => Promise<void> | void) => {
          const el = document.createElement("button");
          el.textContent = label;
          el.style.cssText = "display:block;width:100%;margin:6px 0;padding:8px 12px;border:1px solid #d4d6db;border-radius:8px;background:#f6f6f3;font:inherit;cursor:pointer;text-align:left";
          el.onclick = async () => {
            el.disabled = true;
            try {
              await action();
            } catch {
              out.textContent = t("Das hat nicht geklappt. Bitte später erneut versuchen.", "That did not work. Please try again later.");
            }
            el.disabled = false;
          };
          return el;
        };
        const close = button(t("Schließen", "Close"), () => panel?.remove());
        panel.append(
          status,
          who,
          button(t("Nicht mehr erfassen", "Stop capturing"), () => {
            // notrack on this device (GPC-equivalent, §4.7): survives reloads and stops every signal, also those at „Immer“
            host.setConsent("denied");
            bridge.setRecordings("d");
            host.optOut();
            if (!bridge.stopped()) throw new Error("opt-out");
            status.textContent = t("Erfassung auf diesem Gerät: aus", "Capturing on this device: off");
            out.textContent = t("Erledigt. Auf diesem Gerät wird nichts mehr erfasst.", "Done. Nothing is captured on this device any more.");
          }),
          button(t("Meine Daten löschen", "Delete my data"), async () => {
            const result = await request("erase");
            out.textContent = t(`Gelöscht: ${String(result.erased ?? 0)} Besuche dieses Geräts.`, `Deleted: ${String(result.erased ?? 0)} visits of this device.`);
          }),
          button(t("Daten anzeigen", "Show my data"), async () => {
            const result = await request("export");
            const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
            const link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = "meine-daten.json";
            link.click();
            out.textContent = t("Die Datei wurde heruntergeladen.", "The file was downloaded.");
          }),
          out,
          close,
        );
        document.body.appendChild(panel);
        (panel.querySelector("button") as HTMLButtonElement | null)?.focus();
        host.listen(document, "keydown", (event) => (event as KeyboardEvent).key === "Escape" && panel?.remove());
      };
      return { open };
    },
  };
}
