/**
 * Staged npm package of @x3growth/sdk (ARCHITECTURE §14.3):
 *
 *   npm run pack:staged -w @x3growth/sdk   → packages/sdk/.publish/ + dist/pkg/x3growth-sdk-<version>.tgz
 *   cd packages/sdk/.publish && npm publish  (never from packages/sdk itself)
 *
 * The workspace manifest exports src/*.ts for local development; npm ignores
 * publishConfig.exports, so the published manifest is generated here:
 * `exports` per subpath (types → bundled .d.ts, import → dist/esm, require →
 * dist/cjs where a CJS build exists), no dependency on @3x/core (inlined into
 * the JS by esbuild and into the declarations by rollup-plugin-dts).
 *
 * Also runs unchanged in the public repo X3Growth/x3-sdk (scripts/export-public.ts): there the used
 * part of @3x/core is vendored as src/_core/index.{js,d.ts} ("standalone"), so only the SDK's own
 * declarations are emitted and tools resolve from that repo's node_modules.
 */
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { rollup, type Plugin } from "rollup";
import { dts } from "rollup-plugin-dts";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = `${root}.publish/`;
const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8")) as { name: string; version: string; description: string; peerDependencies: Record<string, string>; peerDependenciesMeta: Record<string, unknown> };
/** public repo layout: vendored core declarations next to the sources */
const standalone = existsSync(`${root}src/_core/index.d.ts`);
const requireFromRoot = createRequire(`${root}package.json`);
/** a tool's CLI file from the nearest node_modules (monorepo root or the public repo) */
const bin = (pkgName: string, file: string) => `${dirname(requireFromRoot.resolve(`${pkgName}/package.json`))}/${file}`;

/** npm metadata of the public package (MIT, source in X3Growth/x3-sdk) */
export const PUBLIC_METADATA = {
  license: "MIT",
  author: "X3 Growth",
  homepage: "https://github.com/X3Growth/x3-sdk#readme",
  repository: { type: "git", url: "git+https://github.com/X3Growth/x3-sdk.git" },
  bugs: { url: "https://github.com/X3Growth/x3-sdk/issues" },
} as const;

/** subpath → source entry (relative to src/, without extension) and whether a CJS build exists */
export const SUBPATHS: Array<{ subpath: string; entry: string; tsx?: boolean; cjs: boolean }> = [
  { subpath: ".", entry: "index", cjs: true },
  { subpath: "./plugins", entry: "plugins/index", cjs: true },
  { subpath: "./presets", entry: "presets/index", cjs: true },
  { subpath: "./react", entry: "react/index", tsx: true, cjs: false },
  { subpath: "./next", entry: "next/index", tsx: true, cjs: false },
  { subpath: "./next/proxy", entry: "next/proxy", cjs: true },
  { subpath: "./server", entry: "server/index", cjs: true },
  { subpath: "./pixel", entry: "pixel/index", cjs: false },
];

const skipBuild = process.argv.includes("--no-build");
if (!skipBuild) execFileSync(process.execPath, [bin("tsx", "dist/cli.mjs"), `${root}scripts/build.ts`], { stdio: "inherit" });
for (const { entry, cjs } of SUBPATHS) {
  if (!existsSync(`${root}dist/esm/${entry}.js`)) throw new Error(`dist/esm/${entry}.js missing – build first`);
  if (cjs && !existsSync(`${root}dist/cjs/${entry}.cjs`)) throw new Error(`dist/cjs/${entry}.cjs missing – build first`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}dist`, { recursive: true });
for (const dir of ["esm", "cjs", "iife"]) cpSync(`${root}dist/${dir}`, `${out}dist/${dir}`, { recursive: true, filter: (path) => !path.endsWith(".map") });

/* ---------------------------------------------------------------- declarations */

// 1. tsc emits declarations of the SDK and of @3x/core (its source is a workspace package);
//    standalone (public repo): only the SDK, the vendored src/_core/index.d.ts is copied next to them
const tmp = `${out}.dts/`;
const tsc = bin("typescript", "bin/tsc");
const emit = (extendsConfig: string, rootDir: string, include: string, outDir: string, name: string) => {
  const config = `${tmp}tsconfig.${name}.json`;
  mkdirSync(tmp, { recursive: true });
  writeFileSync(config, JSON.stringify({ extends: extendsConfig, compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, rootDir, outDir, types: [] }, include: [include] }));
  execFileSync(process.execPath, [tsc, "-p", config], { stdio: "inherit" });
};
let sdkTypes: string;
if (standalone) {
  emit(`${root}tsconfig.json`, `${root}src`, `${root}src`, `${tmp}src`, "sdk");
  mkdirSync(`${tmp}src/_core`, { recursive: true });
  cpSync(`${root}src/_core/index.d.ts`, `${tmp}src/_core/index.d.ts`);
  sdkTypes = `${tmp}src/`;
} else {
  const packages = fileURLToPath(new URL("../../", import.meta.url));
  for (const dir of ["core", "sdk"]) emit(`${packages}${dir}/tsconfig.json`, packages, `${packages}${dir}/src`, tmp, dir);
  sdkTypes = `${tmp}sdk/src/`;
}

// 2. rollup-plugin-dts bundles them per subpath; @3x/core is inlined, React/Next stay external (peer dependencies)
const external = [/^react($|\/)/, /^react-dom($|\/)/, /^next($|\/)/];
const coreTypes: Plugin = {
  name: "core-types",
  resolveId(id) {
    if (id === "@3x/core") return `${tmp}core/src/index.d.ts`;
    if (id.startsWith("@3x/core/")) return `${tmp}core/src/${id.slice("@3x/core/".length)}/index.d.ts`;
    return null;
  },
};
const bundle = await rollup({
  input: Object.fromEntries(SUBPATHS.map(({ entry }) => [entry, `${sdkTypes}${entry}.d.ts`])),
  external: (id) => external.some((pattern) => pattern.test(id)),
  plugins: [coreTypes, dts({ respectExternal: true })],
  onwarn(warning, warn) {
    if (warning.code === "CIRCULAR_DEPENDENCY") return;
    warn(warning);
  },
});
await bundle.write({ dir: `${out}dist/types`, format: "es", entryFileNames: "[name].d.ts", chunkFileNames: "_chunks/[name]-[hash].d.ts" });
await bundle.close();
// CommonJS consumers (moduleResolution node16, require condition) need .d.cts files without ESM chunk imports
for (const { entry } of SUBPATHS.filter((item) => item.cjs)) {
  const single = await rollup({
    input: `${sdkTypes}${entry}.d.ts`,
    external: (id) => external.some((pattern) => pattern.test(id)),
    plugins: [coreTypes, dts({ respectExternal: true })],
    onwarn(warning, warn) {
      if (warning.code !== "CIRCULAR_DEPENDENCY") warn(warning);
    },
  });
  await single.write({ file: `${out}dist/types/${entry}.d.cts`, format: "es" });
  await single.close();
}
rmSync(tmp, { recursive: true, force: true });
const leaked = readdirSync(`${out}dist/types`, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".d.ts") && /from ['"](?:@3x\/|zod)/.test(readFileSync(`${out}dist/types/${file}`, "utf8")));
if (leaked.length) throw new Error(`declarations still import workspace packages or zod: ${leaked.join(", ")}`);

/* ---------------------------------------------------------------- manifest */

const exportsMap: Record<string, unknown> = {};
for (const { subpath, entry, cjs } of SUBPATHS) {
  const types = `./dist/types/${entry}.d.ts`;
  exportsMap[subpath] = cjs
    ? { import: { types, default: `./dist/esm/${entry}.js` }, require: { types: `./dist/types/${entry}.d.cts`, default: `./dist/cjs/${entry}.cjs` } }
    : { types, import: `./dist/esm/${entry}.js`, default: `./dist/esm/${entry}.js` };
}
exportsMap["./iife/*"] = "./dist/iife/*";
exportsMap["./package.json"] = "./package.json";

const manifest = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  ...PUBLIC_METADATA,
  type: "module",
  main: "./dist/cjs/index.cjs",
  module: "./dist/esm/index.js",
  types: "./dist/types/index.d.cts",
  unpkg: "./dist/iife/x3.full.js",
  jsdelivr: "./dist/iife/x3.full.js",
  exports: exportsMap,
  files: ["dist", "README.md", "CHANGELOG.md", "LICENSE"],
  sideEffects: ["./dist/iife/*.js"],
  peerDependencies: pkg.peerDependencies,
  peerDependenciesMeta: pkg.peerDependenciesMeta,
  engines: { node: ">=18" },
  keywords: ["analytics", "cookieless", "privacy", "attribution", "conversions", "tracking", "gdpr"],
};
writeFileSync(`${out}package.json`, `${JSON.stringify(manifest, null, 2)}\n`);
for (const file of ["README.md", "CHANGELOG.md", "LICENSE"]) if (existsSync(`${root}${file}`)) cpSync(`${root}${file}`, `${out}${file}`);
console.log(`staged ${pkg.name}@${pkg.version} in ${out}`);

/* ---------------------------------------------------------------- tarball */

// Each API deployment also serves this tarball at GET /v1/sdk/<file> (apps/api/scripts/build.ts
// copies it next to the IIFE files) – for self-hosters and installs made before the npm release
// (the install recipes use `npm install @x3growth/sdk` from the registry).
const TARBALL = `x3growth-sdk-${pkg.version}.tgz`;
mkdirSync(`${root}dist/pkg`, { recursive: true });
rmSync(`${root}dist/pkg/${TARBALL}`, { force: true });
execFileSync("npm", ["pack", "--silent", "--pack-destination", `${root}dist/pkg`], { cwd: out, stdio: ["ignore", "ignore", "inherit"] });
if (!existsSync(`${root}dist/pkg/${TARBALL}`)) throw new Error(`npm pack did not write dist/pkg/${TARBALL}`);
console.log(`packed dist/pkg/${TARBALL}`);
