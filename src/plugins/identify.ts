import { cleanIdentifier, hashIdentifiers, ID_PATTERN, PROP_KEY_PATTERN, type Props, type PropValue, type WireIdentify } from "../_core/index.js";
import type { IdentifyData, X3Plugin, X3PluginHost } from "../types";
import { MAX_TRAITS } from "../core/constants";

/**
 * identify() hashing (lazy in the script-tag build): provider normalization
 * (core pii.ts) + SHA-256 via WebCrypto. Plaintext contact data never leaves
 * the browser; national phone numbers need the project's calling code.
 */

export type HashedIdentify = Omit<WireIdentify, "pv">;

/**
 * Identify traits: same rules as core cleanCustomProps (identifier-like strings,
 * finite numbers rounded to 4 decimals, booleans; ≤ MAX_TRAITS keys) – kept here
 * so the lazy plugin does not ship the built-in event catalog (asserted equal in tests).
 */
export function cleanTraits(raw: unknown): Props {
  const out: Props = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_TRAITS) break;
    if (!PROP_KEY_PATTERN.test(key)) continue;
    let clean: PropValue | null = null;
    if (typeof value === "string") clean = cleanIdentifier(value);
    else if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e12) clean = Math.round(value * 10_000) / 10_000;
    else if (typeof value === "boolean") clean = value;
    if (clean === null) continue;
    out[key] = clean;
    count += 1;
  }
  return out;
}

export async function hashIdentify(data: IdentifyData, callingCode: string | null): Promise<HashedIdentify | null> {
  if (!globalThis.crypto?.subtle) return null;
  const hashed = await hashIdentifiers(data, callingCode);
  const out: HashedIdentify = {};
  if (hashed.emailSha256) out.em = hashed.emailSha256;
  if (hashed.emailGoogleSha256) out.emg = hashed.emailGoogleSha256;
  if (hashed.phoneSha256) out.ph = hashed.phoneSha256;
  if (hashed.firstNameSha256) out.fn = hashed.firstNameSha256;
  if (hashed.lastNameSha256) out.ln = hashed.lastNameSha256;
  if (hashed.externalIdSha256) out.xid = hashed.externalIdSha256;
  if (!out.em && !out.ph && !out.xid && !out.fn && !out.ln) return null;
  if (typeof data.form === "string" && ID_PATTERN.test(data.form)) out.form = data.form;
  const traits = cleanTraits(data.traits);
  if (Object.keys(traits).length) out.tr = traits;
  return out;
}

export function identify(): X3Plugin {
  return {
    name: "identify",
    install(host: X3PluginHost) {
      if (host.api !== 1) return {};
      return { hash: hashIdentify };
    },
  };
}
