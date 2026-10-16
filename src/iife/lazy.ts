import type { X3Plugin } from "../types";

/** Lazy plugin files (x3.<plugin>.js) hand their plugin to the core script, or queue it until the core boots */
export function registerLazy(plugin: X3Plugin): void {
  const w = window as Window & { __x3r?: (plugin: X3Plugin) => void; __x3pq?: X3Plugin[] };
  if (typeof w.__x3r === "function") w.__x3r(plugin);
  else (w.__x3pq ??= []).push(plugin);
}
