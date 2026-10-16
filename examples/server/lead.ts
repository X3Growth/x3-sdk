import { createX3Server, requestContext } from "@x3growth/sdk/server";

// Server-side only: X3_SECRET_KEY (sk_3x_…) must never reach the browser.
const x3 = createX3Server({ apiUrl: process.env.X3_API_URL ?? "https://api.x3growth.io", apiKey: process.env.X3_SECRET_KEY! });

/**
 * Call from your form handler. `sessionId` comes from the browser (`getIds()` / `x3("getIds")`), so the
 * lead is joined to the visit and its campaign; the conversion is deduplicated with the ad pixels.
 */
export async function onContactForm(request: Request, form: { email: string; sessionId: string }) {
  await x3.leads.create({ sessionId: form.sessionId, email: form.email, form: "contact", conversion: { definition: "lead", ...requestContext(request) } });
}
