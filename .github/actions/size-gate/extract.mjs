// Run the per-language function extractors over a batch of files (LAB-7587).
// One process per language; each prints {path: {functions, comments, error?}} (plan §6).
// An extractor crash or invalid JSON throws: the gate fails closed (§5.5).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { language } from "./scope.mjs";

const here = (f) => fileURLToPath(new URL(f, import.meta.url));

function command(lang, goExtractor) {
  if (lang === "py") return ["python3", ["-I", here("./extract_py.py")]];
  if (lang === "ts" || lang === "tsx") return [process.execPath, [here("./extract-ts.mjs")]];
  if (!goExtractor) throw new Error("SIZE_GATE_GO_EXTRACTOR is not set; build extract-go and point it at the binary");
  return [goExtractor, []];
}

function runExtractor(lang, files, goExtractor) {
  const [cmd, args] = command(lang, goExtractor);
  let out;
  try {
    out = execFileSync(cmd, [...args, ...files], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    throw new Error(`the ${lang} extractor failed: ${String(e.stderr || e.message).trim()}`);
  }
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`the ${lang} extractor printed invalid JSON`);
  }
}

// A name seen k>1 times in one file gets "#k" from its second occurrence on,
// and every occurrence carries the bare name as `dup`.
export function numberDuplicates(functions) {
  const count = new Map();
  for (const f of functions) count.set(f.name, (count.get(f.name) ?? 0) + 1);
  const seen = new Map();
  return functions.map((f) => {
    if (count.get(f.name) < 2) return f;
    const k = (seen.get(f.name) ?? 0) + 1;
    seen.set(f.name, k);
    return { ...f, name: k > 1 ? `${f.name}#${k}` : f.name, dup: f.name };
  });
}

// files: absolute paths, each with a gate language extension.
// Returns Map(path -> { functions, comments, error? }); comments are [] on an error.
export function extractAll(files, goExtractor) {
  const byLang = new Map();
  for (const f of files) {
    const lang = language(f) === "tsx" ? "ts" : language(f);
    if (!byLang.has(lang)) byLang.set(lang, []);
    byLang.get(lang).push(f);
  }
  const result = new Map();
  for (const [lang, batch] of byLang) {
    const out = runExtractor(lang, batch, goExtractor);
    for (const f of batch) {
      const r = out[f];
      if (!r || !Array.isArray(r.functions)) throw new Error(`the ${lang} extractor returned no result for ${f}`);
      result.set(f, r.error ? { functions: [], comments: [], error: r.error } : { functions: numberDuplicates(r.functions), comments: r.comments });
    }
  }
  return result;
}
