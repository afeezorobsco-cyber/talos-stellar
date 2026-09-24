#!/usr/bin/env node
/**
 * Browser bundle script.
 *
 * Uses TypeScript compiler (typescript as devDep) + a minimal in-memory bundling
 * strategy: reads ESM dist output, concatenates and writes a IIFE-ish browser
 * bundle that exposes the SDK on `globalThis.TalosSDK`.
 *
 * If esbuild is available we prefer it; otherwise we fall back to a simple
 * concatenation strategy that is sufficient for compatibility CI (build
 * success + runtime import assertions on the exported names).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { orderByImports, stripImportsExports } from "./esm-concat.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ESM_DIR = join(ROOT, "dist", "esm");
const BROWSER_DIR = join(ROOT, "dist", "browser");
const BUNDLE_OUT = join(BROWSER_DIR, "sdk.bundle.js");

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, files);
    else if (full.endsWith(".js")) files.push(full);
  }
  return files;
}

async function bundleWithEsbuild() {
  try {
    const esbuild = await import("esbuild");
    await esbuild.build({
      entryPoints: [join(ESM_DIR, "index.js")],
      bundle: true,
      format: "iife",
      globalName: "TalosSDK",
      platform: "browser",
      target: "es2020",
      outfile: BUNDLE_OUT,
      minify: false,
      sourcemap: false,
      legalComments: "none",
      allowOverwrite: true,
    });
    console.log("[build:browser] bundled via esbuild ->", BUNDLE_OUT);
    return true;
  } catch (err) {
    console.log("[build:browser] esbuild not available, falling back:", err?.message ?? err);
    return false;
  }
}

function fallbackBundle() {
  if (!existsSync(ESM_DIR)) {
    throw new Error(`ESM dist not found at ${ESM_DIR}. Run build:esm first.`);
  }
  const sources = [];
  const files = orderByImports(
    walk(ESM_DIR).sort(),
    (f) => readFileSync(f, "utf8"),
    (from, spec) => resolve(dirname(from), spec),
  );
  for (const f of files) {
    const rel = f.slice(ESM_DIR.length + 1);
    sources.push(`// ${rel}\n` + stripImportsExports(readFileSync(f, "utf8"), "__talos_exports__"));
  }
  // Build a pseudo-module shim: inline every ESM file into one IIFE scope,
  // rewriting `export`s onto __talos_exports__. This fallback is not a real
  // bundler but lets CI assert that the sources load without Node APIs and
  // that the public exports are discoverable.
  const banner =
    "(function(global){ 'use strict';\n" +
    "var __talos_exports__ = {};\n" +
    "function __talos_export(k,v){ __talos_exports__[k]=v; }\n";
  const footer =
    "global.TalosSDK = Object.freeze(__talos_exports__);\n" +
    "})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : global);\n";

  const body = sources.join("\n");
  mkdirSync(BROWSER_DIR, { recursive: true });
  writeFileSync(BUNDLE_OUT, banner + body + footer, "utf8");
  console.log("[build:browser] fallback bundle written ->", BUNDLE_OUT);
}

async function main() {
  mkdirSync(BROWSER_DIR, { recursive: true });
  const usedEsbuild = await bundleWithEsbuild();
  if (!usedEsbuild) fallbackBundle();
  const size = statSync(BUNDLE_OUT).size;
  console.log(`[build:browser] OK (${size} bytes)`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
