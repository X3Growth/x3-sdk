/** A text of the SDK's language files: German and English */
export type SdkMessage = { readonly de: string; readonly en: string };
export type SdkValues = Readonly<Record<string, string | number>>;

/** The page's language (German pages German, everything else English), read on every call: SPAs switch `<html lang>` */
export const pageLocale = (fallback = "de"): "de" | "en" => ((document.documentElement.lang || fallback).toLowerCase().startsWith("de") ? "de" : "en");

/** The message in the page's language with its `{name}` placeholders filled (a formatter of its own: the widgets keep their size budget) */
export const say = (message: SdkMessage, values?: SdkValues, fallback?: string): string => message[pageLocale(fallback)].replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? ""));

/** `{n, plural, one {…} other {…}}` messages: the form for n (`#` = n), then the placeholders */
export function sayCount(message: SdkMessage, n: number, values?: SdkValues, fallback?: string): string {
  const text = message[pageLocale(fallback)].replace(/\{n, plural, one \{([^{}]*)\} other \{([^{}]*)\}\}/, (_match, one: string, other: string) => (n === 1 ? one : other).replace(/#/g, String(n)));
  return say({ de: text, en: text }, values, fallback);
}

/** A namespace module: `{ key: { de, en } }` from the two language files (built at load, no per-key code in the bundle) */
export const sdkMessages = <K extends string>(de: Readonly<Record<K, string>>, en: Readonly<Record<K, string>>): Readonly<Record<K, SdkMessage>> =>
  Object.fromEntries(Object.keys(de).map((key) => [key, { de: de[key as K], en: en[key as K] ?? de[key as K] }])) as Record<K, SdkMessage>;
