// ── JSON Schema validation ──────────────────────────────────────────────────
export { validate, validateParams, formatValidationErrors, typeName } from "./json-schema.js";

// ── Template rendering (Mustache-like) ──────────────────────────────────────
export { compile, render } from "./render.js";

// ── Reactive state (signal/atom) ──────────────────────────────────────────────
export { reactiveState, effect } from "./reactive-state.js";

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
} from "./file-utils.js";
export { stripNulls, deepMerge } from "./objects.js";

// ── Static file serving ──────────────────────────────────────────────────────
export { serveStaticFile, getMimeType } from "./static-files.js";
