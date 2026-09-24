/**
 * Shared helper for the dependency-free SDK bundling paths (browser fallback
 * bundle and the edge smoke test). Rewrites one compiled ESM file so that the
 * dist sources can be concatenated and evaluated as a classic script:
 *
 *   - `import ...` and `export ... from` lines are dropped (all sources are
 *     inlined into one scope)
 *   - `export <decl>` becomes `<decl>`; `<exportsVar>.<name> = <name>;` is
 *     appended at the end of the file (declarations may span many lines)
 *   - `export { a, b as c }` becomes assignments on `<exportsVar>`
 *   - `export {};` (emitted by tsc for type-only modules) is dropped
 */

const EXPORT_DECL =
  /^export\s+(default\s+)?(?:(?:const|let|var|class|function|enum|async\s+function)\s+)?([A-Za-z0-9_$]+)/m;
const REEXPORT_ALL = /^export\s+\*\s+from\s+["']([^"']+)["']/;
const REEXPORT_NAMED = /^export\s+\{([^}]*)\}\s+from\s+["']([^"']+)["']/;
const EXPORT_LOCAL = /^export\s+\{([^}]*)\}\s*;?\s*$/;
const IMPORT_LINE =
  /^import\s+(?:(?:\{[^}]*\}|\*\s+as\s+[A-Za-z0-9_$]+|[A-Za-z0-9_$]+(?:\s*,\s*\{[^}]*\})?)\s+from\s+)?["']([^"']+)["'];?\s*$/;

export function stripImportsExports(src, exportsVar = "__EXPORTS__") {
  const out = [];
  const trailing = [];
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trimEnd();

    if (REEXPORT_ALL.test(line) || REEXPORT_NAMED.test(line) || IMPORT_LINE.test(line)) continue;

    if (/^export\s+default\s+/.test(line)) {
      out.push(`${exportsVar}.default = (${line.replace(/^export\s+default\s+/, "")});`);
      continue;
    }

    const local = EXPORT_LOCAL.exec(line);
    if (local) {
      for (const part of local[1].split(",")) {
        const bit = part.trim();
        if (!bit) continue;
        const asMatch = /^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/.exec(bit);
        trailing.push(
          asMatch
            ? `${exportsVar}.${asMatch[2]} = ${asMatch[1]};`
            : `${exportsVar}.${bit} = ${bit};`,
        );
      }
      continue;
    }

    const decl = EXPORT_DECL.exec(line);
    if (decl) {
      out.push(line.replace(/^export\s+/, ""));
      if (decl[2]) trailing.push(`${exportsVar}.${decl[2]} = ${decl[2]};`);
      continue;
    }

    out.push(line);
  }
  return [...out, ...trailing].join("\n");
}

const RELATIVE_SPECIFIER = /(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s+["'](\.{1,2}\/[^"']+)["']|(?:^|\n)\s*import\s+["'](\.{1,2}\/[^"']+)["']/g;

/**
 * Order compiled ESM files so every file comes after the relative modules it
 * imports from (depth-first post-order; ties keep the input order). Needed
 * because inlined `class`/`const` bindings are in the TDZ until their file
 * has run.
 */
export function orderByImports(files, read, resolveSpecifier) {
  const known = new Set(files);
  const state = new Map(); // file -> "visiting" | "done"
  const ordered = [];

  function visit(file) {
    if (state.get(file) === "done") return;
    if (state.get(file) === "visiting") return; // cycle: keep current order
    state.set(file, "visiting");
    const src = read(file);
    for (const m of src.matchAll(RELATIVE_SPECIFIER)) {
      const dep = resolveSpecifier(file, m[1] ?? m[2]);
      if (known.has(dep)) visit(dep);
    }
    state.set(file, "done");
    ordered.push(file);
  }

  for (const f of files) visit(f);
  return ordered;
}
