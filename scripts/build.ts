/**
 * SDK builds (esbuild, ARCHITECTURE §14.1):
 *  - dist/esm  every subpath, code-split (lazy plugins are dynamic-import chunks)
 *  - dist/cjs  ".", "/server", "/next/proxy", "/presets", "/plugins"
 *  - dist/iife x3.js (core, lazy plugins), x3.full.js (all plugins), x3.<plugin>.js,
 *              plus versioned copies x3@<version>.js / x3.<plugin>@<version>.js
 * Size budgets: npm run size -w @x3growth/sdk (scripts/size.ts).
 */
import { build, type BuildOptions, type Plugin } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8")) as { version: string };

// keep src/version.ts in sync with package.json
const versionFile = `${root}src/version.ts`;
const versionSource = readFileSync(versionFile, "utf8");
const synced = versionSource.replace(/VERSION = "[^"]*"/, `VERSION = "${pkg.version}"`);
if (synced !== versionSource) writeFileSync(versionFile, synced);

rmSync(`${root}dist`, { recursive: true, force: true });

const external = ["react", "react-dom", "react/jsx-runtime", "next", "next/*", "zod"];
/** next has no "exports" map: Node ESM (and strict ESM bundlers) need the file name, e.g. next/script.js */
const nextFileImports: Plugin = {
  name: "next-file-imports",
  setup(b) {
    b.onResolve({ filter: /^next\/[a-z-]+$/ }, (args) => ({ path: `${args.path}.js`, external: true }));
  },
};
const common: BuildOptions = { bundle: true, minify: true, legalComments: "none", logLevel: "warning", target: "es2020", jsx: "automatic", plugins: [nextFileImports] };

const esmEntries = ["src/index.ts", "src/plugins/index.ts", "src/presets/index.ts", "src/react/index.tsx", "src/next/index.tsx", "src/next/proxy.ts", "src/server/index.ts", "src/pixel/index.ts"];
await build({
  ...common,
  entryPoints: esmEntries.map((entry) => `${root}${entry}`),
  outdir: `${root}dist/esm`,
  outbase: `${root}src`,
  splitting: true,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  sourcemap: true,
  chunkNames: "chunks/[name]-[hash]",
  external,
});
// client-only entry: keep the directive esbuild drops while bundling
const reactEntry = `${root}dist/esm/react/index.js`;
writeFileSync(reactEntry, `"use client";\n${readFileSync(reactEntry, "utf8")}`);

const cjsEntries = ["src/index.ts", "src/server/index.ts", "src/next/proxy.ts", "src/presets/index.ts", "src/plugins/index.ts"];
for (const entry of cjsEntries) {
  await build({
    ...common,
    entryPoints: [`${root}${entry}`],
    outfile: `${root}dist/cjs/${entry.replace(/^src\//, "").replace(/\.tsx?$/, ".cjs")}`,
    format: "cjs",
    platform: "neutral",
    mainFields: ["module", "main"],
    external,
  });
}

const iifeEntries: Array<[string, string]> = [
  ["src/iife/core.ts", "x3"],
  ["src/iife/full.ts", "x3.full"],
  ...["video", "sections", "forms", "identify", "consent", "bookings", "journeys"].map((name): [string, string] => [`src/iife/plugin-${name}.ts`, `x3.${name}`]),
];
mkdirSync(`${root}dist/iife`, { recursive: true });
for (const [entry, name] of iifeEntries) {
  const outfile = `${root}dist/iife/${name}.js`;
  await build({ ...common, entryPoints: [`${root}${entry}`], outfile, format: "iife", platform: "browser" });
  copyFileSync(outfile, `${root}dist/iife/${name}@${pkg.version}.js`);
}
/**
 * esbuild keeps non-ASCII characters inside regex literals (core's label and slug
 * patterns: «», umlauts, combining marks). A script served without a charset is
 * decoded as Latin-1 and those patterns break, so every output is made pure ASCII
 * (\uXXXX escapes are equivalent inside strings, templates and regex literals).
 */
function asciiOnly(dir: string): void {
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (!/\.(?:c?js)$/.test(entry)) continue;
    const file = `${dir}/${entry}`;
    const text = readFileSync(file, "utf8");
    const escaped = text.replace(/[^\x00-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
    if (escaped !== text) writeFileSync(file, escaped);
  }
}
for (const dir of ["esm", "cjs", "iife"]) asciiOnly(`${root}dist/${dir}`);

console.log(`built @x3growth/sdk ${pkg.version}: ${readdirSync(`${root}dist/iife`).length} script files`);
