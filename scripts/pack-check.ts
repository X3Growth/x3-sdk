/**
 * The published @x3growth/sdk stays self-contained (x3-design mobile/ARCHITECTURE.md §5.8): the
 * packed manifest names no workspace package (@3x/*) in any dependency field, and no file in the
 * tarball imports or requires one. Pure, so test/pack-check.test.ts covers it without packing.
 */

export type PackedFile = { path: string; text: string };

const DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies", "bundleDependencies", "bundledDependencies"] as const;

/** static import/export, dynamic import() and require() of a workspace package (scope @3x) */
const WORKSPACE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']@3x\/[^"']*["']/;

export function selfContainedProblems(manifest: Record<string, unknown>, files: readonly PackedFile[]): string[] {
  const problems: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const value = manifest[field];
    const names = Array.isArray(value) ? value.map(String) : value && typeof value === "object" ? Object.keys(value) : [];
    for (const name of names) if (name.startsWith("@3x/")) problems.push(`package.json ${field} names ${name}`);
  }
  for (const file of files) {
    if (!/\.(c|m)?js$|\.d\.(c|m)?ts$/.test(file.path)) continue;
    const match = WORKSPACE_IMPORT.exec(file.text);
    if (match) problems.push(`${file.path} imports a workspace package (${match[0]})`);
  }
  return problems;
}
