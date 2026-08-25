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
  fileSize,
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

// ── Env scrubbing for spawned processes ─────────────────────────────────────
export { isSensitiveEnvVar, copyScrubbedEnv } from "./env.ts";

// ── Process-group control for spawned processes ─────────────────────────────
export { IS_POSIX, OWN_PROCESS_GROUP, killProcessGroup } from "./process-group.ts";

// ── Promise utilities ────────────────────────────────────────────────────────
export { isPromise } from "./promise.ts";

// ── SSE stream parsing ───────────────────────────────────────────────────────
export { parseSse, SseParser } from "./sse-parser.ts";
export type { SseParserOptions } from "./sse-parser.ts";

// ── Markdown Parser ──────────────────────────────────────────────────────────
export {
  parseMarkdown,
  createStreamingParser,
  mdTreeToPlainText,
  walkTree,
} from "./md-parser.ts";
export type {
  MdDocument,
  MdBlock,
  MdInline,
  MdHeading,
  MdParagraph,
  MdCodeBlock,
  MdList,
  MdListItem,
  MdBlockquote,
  MdHorizontalRule,
  MdThematicBreak,
  MdText,
  MdBold,
  MdItalic,
  MdStrikethrough,
  MdInlineCode,
  MdLink,
  MdImage,
} from "./md-parser.ts";
