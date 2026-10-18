import { CHOICE_CONTAINER_SELECTOR } from "../../_core/index.js";
import { attributeRule, CONTENTEDITABLE_SELECTOR, isScriptUrl, MASK_ALWAYS_SELECTOR, maskShape, MASKED_VALUE, scrubLinkUrl, scrubPii } from "../../_core/index.js";

/**
 * Masking in the browser, before anything leaves the device (RECORDINGS-HEATMAPS §4.2):
 * - strict (default, not switchable off): every text keeps only its shape („Xxxxx xxx“) unless an
 *   element is unmasked; balanced: texts visible, PII patterns removed
 * - input values never (not even their length), no per-keystroke events (only „Feld bearbeitet“)
 * - choice containers (quiz, radiogroup, listbox) stay masked even inside an unmasked area
 * - alt/title/aria-label/placeholder/value attributes masked like text (own transform stage)
 * - always: choice state (checked, selected, aria-checked/selected/pressed/current) removed, custom
 *   widget state constant, contenteditable blocked, address/[data-x3-mask] shape-masked, link
 *   targets scrubbed (mailto/tel, query, e-mail/token path segments)
 */

export type MaskOptions = { profile: "strict" | "balanced"; unmask: string[]; block: string[] };

const BASE_BLOCK = `[data-x3-block],[data-hj-suppress],[data-clarity-mask],iframe,canvas,video,input[type=password],input[type=file],[autocomplete^=cc-],${CONTENTEDITABLE_SELECTOR}`;

export function blockSelector(options: MaskOptions): string {
  return [BASE_BLOCK, ...options.block].join(",");
}

export function unmaskSelector(options: MaskOptions): string {
  return ["[data-x3-unmask]", ...options.unmask].join(",");
}

// every selector that changes how a text is masked, in one ancestor walk (most texts match none of them)
let specialKey = "";
let special = "";
function specialSelector(options: MaskOptions): string {
  const key = options.unmask.join("\u0000");
  if (key !== specialKey || !special) {
    specialKey = key;
    special = [CONTENTEDITABLE_SELECTOR, MASK_ALWAYS_SELECTOR, CHOICE_CONTAINER_SELECTOR, unmaskSelector(options)].join(",");
  }
  return special;
}

/** Text of an element (rrweb maskTextFn) */
export function maskText(text: string, element: Element | null, options: MaskOptions): string {
  if (!text.trim()) return text;
  // fast path (full snapshot budget §16.1): no editable, always-masked, choice or unmasked ancestor
  if (!element?.closest(specialSelector(options))) return options.profile === "balanced" ? scrubPii(text) : maskShape(text);
  if (element.closest(CONTENTEDITABLE_SELECTOR)) return MASKED_VALUE;
  if (element?.closest(MASK_ALWAYS_SELECTOR)) return maskShape(text);
  const choice = !!element?.closest(CHOICE_CONTAINER_SELECTOR);
  const unmasked = !choice && !!element?.closest(unmaskSelector(options));
  if (options.profile === "balanced" && !choice) return scrubPii(text);
  return unmasked ? scrubPii(text) : maskShape(text);
}

type Node = { type: number; id: number; tagName?: string; attributes?: Record<string, unknown>; childNodes?: Node[]; textContent?: string };

/** Attribute stage on serialized nodes (full snapshots and mutation adds) */
export function maskAttributes(attributes: Record<string, unknown>, element: Element | null, options: MaskOptions): void {
  let choice: boolean | undefined;
  const inChoice = () => (choice ??= !!element?.closest(CHOICE_CONTAINER_SELECTOR));
  for (const [name, value] of Object.entries(attributes)) {
    const lower = name.toLowerCase();
    if (lower.startsWith("on") || (typeof value === "string" && (lower === "href" || lower === "src" || lower === "action" || lower === "formaction") && isScriptUrl(value))) {
      delete attributes[name];
      continue;
    }
    const rule = attributeRule(lower, value, inChoice);
    if (rule === "delete") delete attributes[name];
    else if (rule === "constant") attributes[name] = MASKED_VALUE;
    else if (rule === "text") attributes[name] = maskText(value as string, element, options);
    else if (rule === "aria") attributes[name] = options.profile === "strict" ? MASKED_VALUE : scrubPii(value as string);
    // stylesheet/sprite hrefs are assets (the server proxies them), every other link target is scrubbed
    else if (rule === "link" && !(lower === "href" && /^(?:link|use|image)$/i.test(element?.tagName ?? ""))) attributes[name] = scrubLinkUrl(value as string);
  }
}

export function maskNode(node: Node, lookup: (id: number) => Element | null, options: MaskOptions): void {
  if (node.attributes) maskAttributes(node.attributes, lookup(node.id), options);
  for (const child of node.childNodes ?? []) maskNode(child, lookup, options);
}

type Event = { type: number; timestamp: number; data: Record<string, unknown> };

/**
 * Transform of one emitted rrweb event: attributes masked, input events replaced by a synthetic
 * „field edited“ marker on change (never per keystroke). Returns null to drop the event.
 */
export function transformEvent(event: Event, lookup: (id: number) => Element | null, options: MaskOptions): Event | null {
  if (event.type === 2 && event.data.node) maskNode(event.data.node as Node, lookup, options);
  if (event.type === 3) {
    const source = event.data.source;
    if (source === 5) return null;
    if (source === 0) {
      for (const add of (event.data.adds as Array<{ node: Node }> | undefined) ?? []) maskNode(add.node, lookup, options);
      for (const attr of (event.data.attributes as Array<{ id: number; attributes: Record<string, unknown> }> | undefined) ?? []) maskAttributes(attr.attributes, lookup(attr.id), options);
    }
  }
  return event;
}
