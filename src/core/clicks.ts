import { canonicalPage, normalizeHost, type ClickKind, type CompiledTrackingConfig, type MESSAGING_APPS } from "../_core/index.js";

/**
 * Click classification (parity TR-41) with the generalizations of PARITY §12:
 * download extensions and messaging apps come from the project config.
 */

type MessagingApp = (typeof MESSAGING_APPS)[number];

const WHATSAPP_HOST = /^(?:wa\.me|api\.whatsapp\.com|web\.whatsapp\.com)$/;

/** Protocols and hosts of messenger links (reported as kind "messaging" when the app is enabled) */
const MESSAGING: ReadonlyArray<[MessagingApp, RegExp]> = [
  ["telegram", /^(?:tg:|https?:\/\/(?:t\.me|telegram\.me)\/)/],
  ["signal", /^(?:sgnl:|https?:\/\/signal\.me\/)/],
  ["messenger", /^(?:fb-messenger:|https?:\/\/(?:m\.me|(?:www\.)?messenger\.com)\/)/],
  ["viber", /^viber:/],
  ["line", /^(?:line:|https?:\/\/line\.me\/)/],
  ["wechat", /^(?:weixin:|wechat:)/],
  ["sms", /^sms:/],
  ["skype", /^skype:/],
  ["threema", /^(?:threema:|https?:\/\/threema\.id\/)/],
];

export type ClickContext = {
  config: CompiledTrackingConfig;
  whatsapp: boolean;
  apps: readonly string[];
  downloads: RegExp;
  /** selector of elements that count as clickable controls (CLICK_TARGET_SELECTOR) */
  targets: string;
};

export const FORM_TAGS = new Set(["input", "select", "textarea", "label"]);

export function downloadPattern(extensions: readonly string[]): RegExp {
  const list = extensions.filter((ext) => /^[a-z0-9]{1,8}$/.test(ext));
  return list.length ? new RegExp(`\\.(?:${list.join("|")})$`, "i") : /$^/;
}

export type ClickClass = { kind: ClickKind; href?: string; app?: MessagingApp };

export function classifyClick(target: Element, tag: string, ctx: ClickContext): ClickClass {
  if (FORM_TAGS.has(tag)) return { kind: "form" };
  if (tag === "a" && target.hasAttribute("href")) {
    let url: URL;
    try {
      url = new URL((target as HTMLAnchorElement).href, window.location.href);
    } catch {
      return { kind: "button" };
    }
    const href = url.href;
    if (url.protocol === "tel:") return { kind: "tel" };
    if (url.protocol === "mailto:") return { kind: "mailto" };
    if (ctx.whatsapp && (url.protocol === "whatsapp:" || WHATSAPP_HOST.test(url.hostname))) return { kind: "whatsapp" };
    for (const [app, pattern] of MESSAGING) {
      if (ctx.apps.includes(app) && pattern.test(href)) return { kind: "messaging", app };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return { kind: "button" };
    if (target.hasAttribute("download") || ctx.downloads.test(url.pathname)) return { kind: "download" };
    if (url.hash && url.origin === window.location.origin && url.pathname === window.location.pathname) return { kind: "anchor" };
    const host = normalizeHost(url.hostname);
    if (ctx.config.isOwnHost(host)) return { kind: "internal", href: canonicalPage(host, url.pathname, ctx.config)?.page };
    return { kind: "external", href: host || undefined };
  }
  if (target.matches(ctx.targets)) return { kind: "button" };
  return { kind: "other" };
}
