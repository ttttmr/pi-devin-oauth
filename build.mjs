// Build the extension entry into a single dist/extension.js.
//
// Why: Pi loads extensions through jiti, which pays per-file module
// resolution + transform cost on every startup. A single .js file skips
// all of that (~40ms -> <1ms on this package).
//
// Only the exact specifier "@earendil-works/pi-ai" stays external: Pi
// resolves it to a bundled virtual module at runtime. Subpath imports like
// "@earendil-works/pi-ai/api/simple-options" are NOT in Pi's virtual table
// and would otherwise need a real node_modules copy, so they get bundled.
import { build } from "esbuild";

const HOST_MODULES = new Set([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-coding-agent",
]);

await build({
  entryPoints: ["extensions/index.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  outfile: "dist/extension.js",
  plugins: [
    {
      name: "pi-host-externals",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) =>
          HOST_MODULES.has(args.path) ? { external: true } : undefined,
        );
      },
    },
  ],
});
