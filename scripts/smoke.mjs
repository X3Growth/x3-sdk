// Imports every built Node-safe entry (after npm run build) and checks its public API.
const entries = { index: ["init", "track", "goal", "identify", "consent", "getIds", "x3", "VERSION"], "plugins/index": ["video", "sections", "forms"], "presets/index": [], "next/proxy": ["createX3ProxyHandler"], "server/index": ["createX3Server", "requestContext"], "pixel/index": ["createX3Pixel"] };
for (const [entry, names] of Object.entries(entries)) {
  const mod = await import(new URL(`../dist/esm/${entry}.js`, import.meta.url));
  for (const name of names) if (!(name in mod)) throw new Error(`${entry}: missing export ${name}`);
}
console.log("smoke ok");
