import { CHOICE_CONTAINER_SELECTOR } from "../../_core/index.js";
import { attributeRule, CHOICE_INPUT_TYPES, CONTENTEDITABLE_SELECTOR, isScriptUrl, MASK_ALWAYS_SELECTOR, maskLink, maskShape, MASKED_VALUE, scrubPii, valueRecordable, type MaskPolicy } from "../../_core/index.js";

/**
 * Masking in the browser, before anything leaves the device (RECORDINGS-HEATMAPS §4.2, BUILD-ADDENDA AC).
 * The project chooses per category (policy `p`, test/internal sessions may get the relaxed `t`):
 * - texts: shape („Xxxxx xxx“) · visible with PII filter · visible; unmask selectors make shapes readable (PII filtered)
 * - inputs: masked (never, not even the length; only „Feld bearbeitet“) · final value with PII filter · final value
 * - choices: masked (checked/selected state removed, widget state constant, answer texts as shapes) · visible
 * - attributes (alt/title/placeholder/aria-label/data-…): shape · PII filter · visible
 * - links: scrubbed (mailto/tel, query except utm_…, click ids, id/token segments) · PII filter · complete
 * - images: visible · placeholder
 * Never switchable (floor): password/hidden/file inputs, autocomplete cc-*, one-time-code/…-password,
 * contenteditable, address/[data-x3-mask] and own mask selectors (shape), keystrokes.
 * Link targets inside [data-x3-mask-links] (a page that carries tenant names in its own paths, e.g. an
 * app's onboarding) are never recorded, and the page address of the meta event follows the links option.
 */

export type MaskOptions = { profile: "strict" | "balanced"; unmask: string[]; block: string[]; mask?: string[]; p?: MaskPolicy };

/** containers whose link targets are never recorded (any links option) */
export const MASK_LINKS_SELECTOR = "[data-x3-mask-links]";

const BASE_BLOCK = `[data-x3-block],[data-hj-suppress],[data-clarity-mask],iframe,canvas,video,input[type=password],input[type=file],[autocomplete^=cc-],[autocomplete~=one-time-code],${CONTENTEDITABLE_SELECTOR}`;

/** Policy of this session; recorders talking to an API before AC only get the profile */
export function policyOf(options: MaskOptions): MaskPolicy {
  if (options.p) return options.p;
  const strict = options.profile !== "balanced";
  return { text: strict ? "shape" : "pii", inputs: "masked", choices: "masked", attributes: strict ? "shape" : "pii", links: "scrubbed", images: "visible" };
}

export function blockSelector(options: MaskOptions): string {
  return [BASE_BLOCK, ...(policyOf(options).images === "placeholder" ? ["img", "picture", "svg image"] : []), ...options.block].join(",");
}

export function unmaskSelector(options: MaskOptions): string {
  return ["[data-x3-unmask]", ...options.unmask].join(",");
}

function alwaysSelector(options: MaskOptions): string {
  return [MASK_ALWAYS_SELECTOR, ...(options.mask ?? [])].join(",");
}

// every selector that changes how a text is masked, in one ancestor walk (most texts match none of them)
let specialKey = "";
let special = "";
function specialSelector(options: MaskOptions): string {
  const key = `${options.unmask.join("\u0000")}\u0001${(options.mask ?? []).join("\u0000")}`;
  if (key !== specialKey || !special) {
    specialKey = key;
    special = [CONTENTEDITABLE_SELECTOR, alwaysSelector(options), CHOICE_CONTAINER_SELECTOR, unmaskSelector(options)].join(",");
  }
  return special;
}

const byOption = (option: "shape" | "pii" | "visible", text: string): string => (option === "shape" ? maskShape(text) : option === "pii" ? scrubPii(text) : text);

/** Text of an element (rrweb maskTextFn); `category` attributes for alt/title/… under their own option */
export function maskText(text: string, element: Element | null, options: MaskOptions, category: "text" | "attributes" = "text"): string {
  if (!text.trim()) return text;
  const policy = policyOf(options);
  const option = policy[category];
  // fast path (full snapshot budget §16.1): no editable, always-masked, choice or unmasked ancestor
  if (!element?.closest(specialSelector(options))) return byOption(option, text);
  if (element.closest(CONTENTEDITABLE_SELECTOR)) return MASKED_VALUE;
  if (element.closest(alwaysSelector(options))) return maskShape(text);
  if (policy.choices === "masked" && element.closest(CHOICE_CONTAINER_SELECTOR)) return maskShape(text);
  if (option !== "shape") return byOption(option, text);
  return element.closest(unmaskSelector(options)) ? scrubPii(text) : maskShape(text);
}

const FIELD_TAGS = /^(?:input|textarea|select)$/i;

/** Value of a form field (rrweb maskInputFn, snapshot value and input events) */
export function maskInput(text: string, element: Element | null, options: MaskOptions): string {
  const policy = policyOf(options);
  if (!element || (policy.inputs === "masked" && policy.choices === "masked")) return MASKED_VALUE;
  const type = (element.getAttribute("type") ?? "").toLowerCase();
  if (!valueRecordable({ type, autocomplete: element.getAttribute("autocomplete") }) || element.closest(`${CONTENTEDITABLE_SELECTOR},${alwaysSelector(options)}`)) return MASKED_VALUE;
  if (CHOICE_INPUT_TYPES.has(type) || /^select$/i.test(element.tagName)) return policy.choices === "visible" ? text : MASKED_VALUE;
  return policy.inputs === "masked" ? MASKED_VALUE : policy.inputs === "pii" ? scrubPii(text) : text;
}

type Node = { type: number; id: number; tagName?: string; attributes?: Record<string, unknown>; childNodes?: Node[]; textContent?: string };

/** Attribute stage on serialized nodes (full snapshots and mutation adds) */
export function maskAttributes(attributes: Record<string, unknown>, element: Element | null, options: MaskOptions): void {
  const policy = policyOf(options);
  let choice: boolean | undefined;
  const inChoice = () => (choice ??= !!element?.closest(CHOICE_CONTAINER_SELECTOR));
  const tag = element?.tagName ?? "";
  for (const [name, value] of Object.entries(attributes)) {
    const lower = name.toLowerCase();
    if (lower.startsWith("on") || (typeof value === "string" && (lower === "href" || lower === "src" || lower === "action" || lower === "formaction") && isScriptUrl(value))) {
      delete attributes[name];
      continue;
    }
    const rule = attributeRule(lower, value, inChoice);
    if (rule === "delete") {
      // checked/selected/aria-checked/…: which answer was picked
      if (policy.choices === "masked") delete attributes[name];
    } else if (rule === "constant") {
      // field values through maskInput (idempotent; floor, inputs and choices decided per field), option values and widget state by the choices option
      if (lower === "value" && FIELD_TAGS.test(tag)) attributes[name] = typeof value === "string" ? maskInput(value, element, options) : MASKED_VALUE;
      else if (!((lower !== "value" || /^option$/i.test(tag)) && policy.choices === "visible")) attributes[name] = MASKED_VALUE;
    } else if (rule === "text") attributes[name] = maskText(value as string, element, options, "attributes");
    else if (rule === "aria") attributes[name] = policy.attributes === "shape" ? MASKED_VALUE : policy.attributes === "pii" ? scrubPii(value as string) : value;
    // stylesheet/sprite hrefs are assets (the server proxies them), every other link target follows the links option
    else if (rule === "link" && !(lower === "href" && /^(?:link|use|image)$/i.test(tag))) attributes[name] = element?.closest(MASK_LINKS_SELECTOR) ? MASKED_VALUE : maskLink(value as string, policy.links);
  }
}

export function maskNode(node: Node, lookup: (id: number) => Element | null, options: MaskOptions): void {
  if (node.attributes) maskAttributes(node.attributes, lookup(node.id), options);
  for (const child of node.childNodes ?? []) maskNode(child, lookup, options);
}

type Event = { type: number; timestamp: number; data: Record<string, unknown> };

/** An rrweb input event may leave the device only when its category is relaxed and the field is not under the floor (same decision as maskInput) */
const inputEventAllowed = (element: Element | null, options: MaskOptions): boolean => maskInput("\u0001", element, options) !== MASKED_VALUE;

/**
 * Transform of one emitted rrweb event: attributes masked; input events dropped (a synthetic
 * „field edited“ marker is sent on change instead) unless inputs/choices are relaxed – then only
 * the final value per field (rrweb input sampling "last"). Returns null to drop the event.
 */
export function transformEvent(event: Event, lookup: (id: number) => Element | null, options: MaskOptions): Event | null {
  // meta: the page address follows the links option (query except utm_*/click ids, id and token segments)
  if (event.type === 4 && typeof event.data.href === "string") event.data = { ...event.data, href: maskLink(event.data.href, policyOf(options).links) };
  if (event.type === 2 && event.data.node) maskNode(event.data.node as Node, lookup, options);
  if (event.type === 3) {
    const source = event.data.source;
    if (source === 5) return inputEventAllowed(lookup(event.data.id as number), options) ? event : null;
    if (source === 0) {
      for (const add of (event.data.adds as Array<{ node: Node }> | undefined) ?? []) maskNode(add.node, lookup, options);
      for (const attr of (event.data.attributes as Array<{ id: number; attributes: Record<string, unknown> }> | undefined) ?? []) maskAttributes(attr.attributes, lookup(attr.id), options);
    }
  }
  return event;
}
