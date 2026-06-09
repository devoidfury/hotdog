// ── JSON Schema validation ──────────────────────────────────────────────────
export { validate, validateParams, formatValidationErrors, typeName } from "./json-schema.js";

// ── Template rendering (Mustache-like) ──────────────────────────────────────
export { compile, render } from "./render.js";

// ── General utilities ────────────────────────────────────────────────────────
export { parseFrontMatter } from "./file-utils.js";
export { parseFrontMatter, validateNameable, loadAspects } from "./file-utils.js";
export { stripNulls, deepMerge } from "./objects.js";
