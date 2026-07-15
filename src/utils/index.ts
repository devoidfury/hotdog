// ── JSON Schema validation ──────────────────────────────────────────────────
export { validate, validateParams, formatValidationErrors, typeName } from "./json-schema.ts";

// ── Template rendering (Mustache-like) ──────────────────────────────────────
export { compile, render } from "./render.ts";

// ── Reactive state (signal/atom) ──────────────────────────────────────────────
export { reactiveState, effect } from "./reactive-state.ts";

// ── General utilities ────────────────────────────────────────────────────────
export {
  parseFrontMatter,
  validateNameable,
  loadAspects,
  writeFileWithParents,
  validateCwdBoundary,
  resolvePath,
  fileSize,
  resolvePathAndValidate,
  checkWritable,
  checkReadable,
  IOError,
  correctCommonPathMistakes,
} from "./file-utils.ts";
export { stripNulls, deepMerge, getNested } from "./objects.ts";

// ── Static file serving ──────────────────────────────────────────────────────
export { serveStaticFile, getMimeType } from "./static-files.ts";

// ── HTML to Markdown ─────────────────────────────────────────────────────────
export { htmlToMarkdown } from "./html-to-markdown.ts";

// ── String utilities ─────────────────────────────────────────────────────────
export { camelCase, parseCliFlagKey } from "./strings.ts";

// ── Gitignore filtering ──────────────────────────────────────────────────────
export { compileGitignore } from "./gitignore.ts";
