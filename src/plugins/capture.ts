import { record } from "@rrweb/record";
import { buildAnchor, elementText, inFixed, INTERACTIVE_SELECTOR, structureHash } from "../_core/index.js";
import type { X3Plugin, X3PluginHost } from "../types";

/**
 * Owner capture (RECORDINGS-HEATMAPS §5.8): the one-time token of the capture link is exchanged
 * for a handle and removed from the URL at once; a bar asks the owner to bring the page into the
 * state (menu open, quiz step 2) and to confirm. Inputs stay masked, the WordPress admin bar is
 * removed, and nothing is uploaded before the owner confirms the summary.
 */

const de = () => (document.documentElement.lang || "de").toLowerCase().startsWith("de");
const t = (german: string, english: string) => (de() ? german : english);

function bar(): { root: HTMLElement; message: HTMLElement; primary: HTMLButtonElement; secondary: HTMLButtonElement } {
  const root = document.createElement("div");
  root.setAttribute("data-x3-ignore", "");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "X3");
  root.style.cssText = "position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483647;display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 16px;border-radius:12px;background:#111317;color:#ecece6;font:14px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35)";
  const message = document.createElement("span");
  message.style.flex = "1 1 240px";
  const primary = document.createElement("button");
  const secondary = document.createElement("button");
  for (const button of [primary, secondary]) button.style.cssText = "border:0;border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer";
  primary.style.background = "#BDF904";
  primary.style.color = "#111317";
  secondary.style.background = "transparent";
  secondary.style.color = "#ecece6";
  secondary.style.boxShadow = "inset 0 0 0 1px #5d6370";
  root.append(message, secondary, primary);
  document.body.appendChild(root);
  return { root, message, primary, secondary };
}

async function ownerCapture(host: X3PluginHost): Promise<void> {
  const url = new URL(location.href);
  const token = url.searchParams.get("x3_capture") ?? "";
  url.searchParams.delete("x3_capture");
  // the link is worthless once used: out of the URL before anything else (referrer, history, third-party analytics)
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  const bridge = host.behavior();
  const base = host.apiHost().replace(/\/$/, "");
  const ui = bar();
  let handle = "";
  try {
    const response = await fetch(`${base}/v1/snap/session`, { method: "POST", body: JSON.stringify({ k: bridge.key(), token }), credentials: "omit", headers: { "content-type": "text/plain" } });
    if (!response.ok) throw new Error(String(response.status));
    handle = ((await response.json()) as { handle: string }).handle;
  } catch {
    ui.message.textContent = t("Dieser Aufnahme-Link ist abgelaufen oder wurde schon benutzt. Erzeuge im Dashboard einen neuen.", "This capture link has expired or was already used. Create a new one in the dashboard.");
    ui.primary.remove();
    ui.secondary.textContent = t("Schließen", "Close");
    ui.secondary.onclick = () => ui.root.remove();
    return;
  }
  ui.message.textContent = t("Du nimmst als Inhaber auf. Zustand herstellen, dann ‚Aufnehmen‘ klicken.", "You are capturing as the owner. Set up the state, then click “Capture”.");
  ui.primary.textContent = t("Aufnehmen", "Capture");
  ui.secondary.textContent = t("Abbrechen", "Cancel");
  ui.secondary.onclick = () => ui.root.remove();
  ui.primary.onclick = () => {
    ui.root.remove();
    for (const el of Array.from(document.querySelectorAll("#wpadminbar,#wp-admin-bar,.admin-bar-toolbar,[data-x3-ignore]"))) (el as HTMLElement).style.setProperty("display", "none", "important");
    // the full snapshot of @rrweb/record (same serializer as rrweb-snapshot, shared with x3.replay.js), taken once
    let serialized: unknown = null;
    record({ emit: (event) => void ((event as { type: number }).type === 2 && (serialized = (event as unknown as { data: { node: unknown } }).data.node)), maskAllInputs: true, maskInputFn: () => "••••", inlineStylesheet: true, recordCanvas: false, slimDOMOptions: "all" })?.();
    const anchors: Record<string, unknown[]> = {};
    for (const el of Array.from(document.querySelectorAll(`${INTERACTIVE_SELECTOR},h1,h2,h3,[data-x3-section]`)).slice(0, 4000)) {
      const anchor = buildAnchor(el);
      if (!anchor || anchors[anchor]) continue;
      const box = el.getBoundingClientRect();
      anchors[anchor] = [Math.round(box.left + scrollX), Math.round(box.top + scrollY), Math.round(box.width), Math.round(box.height), inFixed(el), box.width > 0 && box.height > 0, elementText(el).replace(/\s+/g, " ").trim().slice(0, 80)];
    }
    const body = JSON.stringify({ k: bridge.key(), handle, snapshot: serialized, width: innerWidth, height: document.documentElement.scrollHeight, sh: structureHash(document.body), anchors });
    const confirm = bar();
    confirm.message.textContent = t(
      `Vorschau: „${document.title.slice(0, 60)}“, ${Object.keys(anchors).length} Elemente, ${innerWidth} px breit, ${(body.length / 1024).toFixed(0)} KB. Eingaben sind maskiert. Hochladen?`,
      `Preview: “${document.title.slice(0, 60)}”, ${Object.keys(anchors).length} elements, ${innerWidth} px wide, ${(body.length / 1024).toFixed(0)} KB. Inputs are masked. Upload?`,
    );
    confirm.primary.textContent = t("Hochladen", "Upload");
    confirm.secondary.textContent = t("Verwerfen", "Discard");
    confirm.secondary.onclick = () => confirm.root.remove();
    confirm.primary.onclick = async () => {
      confirm.primary.disabled = true;
      const response = await fetch(`${base}/v1/snap`, { method: "POST", body, credentials: "omit", headers: { "content-type": "text/plain" } }).catch(() => null);
      confirm.message.textContent = response?.status === 201 ? t("Gespeichert. Du kannst dieses Fenster schließen.", "Saved. You can close this window.") : t("Hochladen fehlgeschlagen. Bitte erneut versuchen.", "Upload failed. Please try again.");
      confirm.primary.remove();
      confirm.secondary.textContent = t("Schließen", "Close");
    };
  };
}

/** x3.capture.js – loaded by the core only when the URL carries ?x3_capture=<token> */
export function capture(): X3Plugin {
  return {
    name: "capture",
    install(host: X3PluginHost) {
      void ownerCapture(host);
      return {};
    },
  };
}
