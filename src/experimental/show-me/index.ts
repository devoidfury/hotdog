// show-me - image-generation capability via tool call and slash commands
//
//   - /show-me [WIDTHxHEIGHT] <description...>  (user command)
//   - show_me tool (assistant-driven)
//
// Backend model must declare at least "text" input and "image" output.
//
// Transport is the OpenAI Images API: POST {provider-url}/v1/images/generations
// with response_format=b64_json. Chat completions is never used for generation;
// diffusion backends do not mount image models there (they 404).
//
// The generation model can be specified in config file (showMe.imageModel).
// When omitted (empty), AUTO mode scans the model registry for the first entry
// with declared modalities satisfying text-in / image-out.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve as resolveAbs } from "node:path";

import { HOOKS } from "@core/hooks.ts";
import { ACTIONS } from "@core/commands.ts";
import { ToolError, formatError } from "@core/error.ts";
import { findModelEntry, resolveModelConfig, type ModelConfig } from "@core/config/providers.ts";
import {
  defaultCallDisplay,
  param,
  parseToolInput,
  ToolResult,
  toolDef,
} from "@core/extensions/tool-utils.ts";
import type { ToolDef, ToolMetadata } from "@core/extensions/tool-registry.ts";
import type { ToolContext } from "@core/extensions/tool-context.ts";
import { getExtensionConfig, type CoreContext, type ExtensionInstance } from "@core/extensions/types.ts";
import { logger } from "@utils/logger.ts";
import type { Agent } from "@core/agent.ts";

const DEFAULT_SIZE = "1024x1024";
const DEFAULT_OUTPUT_DIR = "generated";

interface ShowMeConfig {
  enabled?: boolean;
  imageModel?: string;
}

// ── Size Parsing ────────────────────────────────────────────────────────────

const SIZE_TOKEN_RE = /^(\d+)x(\d+)(?:\s|$)/i;

/** Split an optional leading WIDTHxHEIGHT token off a /show-me argument string. */
export function parseShowMeArgs(rest: string): { size: string; prompt: string } {
  const trimmed = rest.trim();
  const m = SIZE_TOKEN_RE.exec(trimmed);
  if (m) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w > 0 && h > 0) {
      return { size: `${w}x${h}`, prompt: trimmed.slice(m[0].length).trim() };
    }
  }
  return { size: DEFAULT_SIZE, prompt: trimmed };
}

/** Validate/normalize a tool-supplied size string (default when absent). */
export function normalizeSize(size: unknown): string {
  if (size === undefined || size === null || size === "") return DEFAULT_SIZE;
  if (typeof size !== "string") {
    throw new ToolError(`Invalid size "${String(size)}" — expected WIDTHxHEIGHT, e.g. 1024x768`);
  }
  const m = /^(\d+)x(\d+)$/i.exec(size.trim());
  if (!m || Number(m[1]) <= 0 || Number(m[2]) <= 0) {
    throw new ToolError(`Invalid size "${size}" — expected WIDTHxHEIGHT, e.g. 1024x768`);
  }
  return `${Number(m[1])}x${Number(m[2])}`;
}

// ── Model Selection ─────────────────────────────────────────────────────────

interface ModalityEntry {
  name?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  [key: string]: unknown;
}

/** Resolve an explicitly-configured image model to its registry entry, refusing anything that does not declare image output. */
export function selectImageModelEntry(registry: Record<string, unknown>, modelName: string): ModalityEntry {
  const entry = findModelEntry(modelName, registry as Record<string, ModalityEntry>);
  if (!entry) {
    throw new ToolError(
      `show-me: model "${modelName}" not found in the model registry. Add it under a provider with outputModalities: ["image"].`,
    );
  }
  const out = entry.outputModalities;
  if (!out?.includes("image")) {
    throw new ToolError(
      `show-me: model "${entry.name ?? modelName}" does not declare image output (outputModalities: ${out?.length ? out.join(", ") : "none"}). Refusing to generate.`,
    );
  }
  return entry;
}

export interface PickedImageModel {
  /** Registry key to resolve provider settings and model config with. */
  key: string;
  /** Human-friendly name for logs and messages. */
  name: string;
  entry: ModalityEntry;
  /** True when the model was found by auto-scan rather than configured. */
  auto: boolean;
}

/**
 * Resolve the generation model. A non-empty imageModel resolves explicitly;
 * empty means AUTO: scan the registry for an entry declaring "text" input and "image" output.
 *
 * Unlike isTextGenerative's progressive-enhancement leniency, entries with ABSENT modality data are never auto-picked:
 * unknown capabilities must not hijack generation. Deterministic when several match: the first in registry
 * iteration order (Object.keys insertion order, i.e. provider declaration order) wins -- no sorting, stable across runs.
 */
export function pickImageModel(
  registry: Record<string, unknown>,
  modelName: string,
): PickedImageModel {
  if (modelName) {
    const entry = selectImageModelEntry(registry, modelName);
    // Pass the configured name through unchanged (resolveModelConfig handles it exactly as before).
    return { key: modelName, name: entry.name ?? modelName, entry, auto: false };
  }

  for (const [key, raw] of Object.entries(registry)) {
    const entry = raw as ModalityEntry | null;
    if (!entry || typeof entry !== "object") continue;
    if (!entry.inputModalities?.includes("text")) continue;
    if (!entry.outputModalities?.includes("image")) continue;
    const name = entry.name ?? key;
    logger.debug(`show-me: auto-selected image model "${name}"`);
    return { key, name, entry, auto: true };
  }

  throw new ToolError(
    `show-me: no image model configured and no model in the registry declares outputModalities include "image". ` +
      `Set showMe.imageModel in your config to an image-output model.`,
  );
}

// ── Response Decoding ───────────────────────────────────────────────────────

export interface GeneratedImage {
  data: Buffer;
  mimeType: string;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeBase64Payload(raw: string, mimeType: string): GeneratedImage | null {
  const compact = raw.replace(/\s+/g, "");
  if (!compact || !BASE64_RE.test(compact)) return null;
  const data = Buffer.from(compact, "base64");
  return data.length > 0 ? { data, mimeType } : null;
}

function decodeDataUrl(url: string): GeneratedImage | null {
  // Only base64 data URLs carry image bytes; percent-encoded ones are out of scope.
  const m = /^data:([^;,]+)?;base64,(.*)$/is.exec(url);
  if (!m) return null;
  return decodeBase64Payload(m[2] ?? "", m[1] || "image/png");
}

/** One image entry of an Images API response: b64_json wins; a url must be a base64 data URL. */
function decodeImageItem(item: unknown): GeneratedImage | null {
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;

  const b64 = rec.b64_json;
  if (typeof b64 === "string") {
    const img = decodeBase64Payload(b64, "image/png");
    if (img) return img;
  }
  if (typeof rec.url === "string") return decodeDataUrl(rec.url.trim());
  return null;
}

/**
 * Pull the first decodable image out of an OpenAI Images API JSON payload:
 *   { created, data: [{ b64_json | url }, ...] }
 * Remote http(s) urls are not fetched: we always request response_format=b64_json,
 * so a backend that only returns hosted urls is a misconfiguration, not a silent download.
 * Payloads without a decodable entry yield null -- the caller turns that into a clear error.
 */
export function extractGeneratedImage(payload: unknown): GeneratedImage | null {
  const data = (payload as Record<string, unknown> | null)?.data;
  if (!Array.isArray(data)) return null;

  for (const item of data) {
    const img = decodeImageItem(item);
    if (img) return img;
  }
  return null;
}

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function extensionForMime(mimeType: string): string {
  return (
    MIME_EXTENSIONS[mimeType.toLowerCase()] || mimeType.split("/")[1]?.replace(/[^a-z0-9]+/gi, "") || "png"
  );
}

/** Timestamped default output path under ./generated/ (relative to cwd). */
export function defaultOutputPath(now: Date, mimeType: string): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(resolveAbs(DEFAULT_OUTPUT_DIR), `show-me-${stamp}.${extensionForMime(mimeType)}`);
}

// ── LlmClient Call ──────────────────────────────────────────────────────────

/** The Images API endpoint every generation request is posted to. */
export const IMAGES_API_PATH = "/v1/images/generations";

/**
 * The slice of LlmClient this extension uses, declared structurally so tests can pass a duck-typed fake.
 * `_doRequest` is the client's transport: it resolves the protocol headers (Bearer auth),
 * applies timeouts, and classifies failures into LlmErrors.
 */
export interface ImageChatClient {
  resolveProviderSettings(name: string): {
    url: string;
    apiKey: string | null;
    provider: string | null;
  };
  _doRequest(
    url: string,
    apiKey: string | null,
    request: Record<string, unknown>,
    signal: AbortSignal | null,
    modelConfig: ModelConfig,
    path: string,
  ): Promise<Response>;
}

/**
 * One non-streaming POST to the provider's Images API; returns the parsed JSON payload.
 * JSON parse failures propagate to the caller's catch.
 */
export async function requestImageGeneration(
  client: ImageChatClient,
  modelConfig: ModelConfig,
  request: Record<string, unknown>,
  signal: AbortSignal | null,
): Promise<unknown> {
  const { url, apiKey } = client.resolveProviderSettings(modelConfig.name);
  const response = await client._doRequest(
    url,
    apiKey,
    request,
    signal,
    modelConfig,
    IMAGES_API_PATH,
  );
  return (await response.json()) as unknown;
}

// ── Generation ──────────────────────────────────────────────────────────────

export interface GenerateImageParams {
  client: ImageChatClient;
  modelRegistry: Record<string, unknown>;
  imageModel: string;
  contextLimit: number;
  prompt: string;
  size: string;
  outputPath?: string | null;
  signal?: AbortSignal | null;
  emit?: (line: string) => void;
}

/** Generate an image and write it to disk. Returns the written path. */
export async function generateImage(p: GenerateImageParams): Promise<string> {
  const { key: modelKey, name: modelName, auto } = pickImageModel(p.modelRegistry, p.imageModel);
  // Auto mode tells the user which model was picked (command output + tool emit).
  if (auto) p.emit?.(`Using image model: ${modelName}`);

  const modelConfig = resolveModelConfig(
    modelKey,
    p.modelRegistry as unknown as Parameters<typeof resolveModelConfig>[1],
    p.contextLimit,
    undefined,
  );

  // Images API request: the wire model name is the registry key without its provider prefix,
  // matching how the chat protocol addresses models. b64_json keeps bytes in-band; no download step.
  const payload = await requestImageGeneration(
    p.client,
    modelConfig,
    {
      model: modelConfig.name.split("/").pop() || modelConfig.name,
      prompt: p.prompt,
      size: p.size,
      response_format: "b64_json",
    },
    p.signal ?? null,
  );
  const image = extractGeneratedImage(payload);
  if (!image) {
    throw new ToolError(
      `show-me: model "${modelConfig.name}" returned no image in its response; nothing was written.`,
    );
  }

  const outPath = p.outputPath?.trim()
    ? resolveAbs(p.outputPath.trim())
    : defaultOutputPath(new Date(), image.mimeType);

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, image.data);

  p.emit?.(`Image saved: ${outPath}`);
  return outPath;
}

// ── Tool ────────────────────────────────────────────────────────────────────

interface ShowMeToolInput {
  description?: string;
  size?: string;
  output_path?: string;
  [key: string]: unknown;
}

class ShowMeTool {
  static readonly TOOL_NAME = "show_me";
  metadata: ToolMetadata = { sideEffects: true, difficulty: 2 };

  #imageModel: string;

  constructor(imageModel: string) {
    this.#imageModel = imageModel;
  }

  toToolDef(): ToolDef {
    return toolDef(
      ShowMeTool.TOOL_NAME,
      "Generate an image from a text description using the configured image-output model. Optionally choose the output size or file path.",
      {
        properties: {
          description: param("string", "Text description of the image to generate."),
          size: param("string", `Output size as WIDTHxHEIGHT (default ${DEFAULT_SIZE}).`),
          output_path: param(
            "string",
            "Optional file path for the generated image; defaults to a timestamped file under ./generated/.",
          ),
        },
        required: ["description"],
      },
    );
  }

  callDisplay(input: string | Record<string, unknown> | null): string {
    return defaultCallDisplay(input, (args) => `show_me: ${(args as ShowMeToolInput).description}`);
  }

  async execute(input: string | Record<string, unknown> | null, ctx?: ToolContext): Promise<ToolResult> {
    const args = parseToolInput(input) as ShowMeToolInput | null;
    if (!args) return ToolResult.err("Error parsing arguments");

    const description = typeof args.description === "string" ? args.description.trim() : "";
    if (!description) {
      return ToolResult.err("Error: description is required and cannot be empty");
    }

    const agent = ctx?.get("agent") as Agent | undefined;
    if (!agent?.llmClient) {
      return ToolResult.err("show_me: no agent available in tool context");
    }

    try {
      const written = await generateImage({
        client: agent.llmClient as unknown as ImageChatClient,
        modelRegistry: agent.modelRegistry as Record<string, unknown>,
        imageModel: this.#imageModel,
        contextLimit: agent.contextLimit,
        prompt: description,
        size: normalizeSize(args.size),
        outputPath: typeof args.output_path === "string" ? args.output_path : null,
        signal: agent.abortSignal ?? null,
        emit: (line) => agent.emitOutput("command_result", { content: line }),
      });
      return ToolResult.ok(`Image written to ${written}`);
    } catch (err) {
      return ToolResult.err(formatError(err));
    }
  }
}

// ── Extension ───────────────────────────────────────────────────────────────

export function create(core: CoreContext): ExtensionInstance {
  const config = getExtensionConfig<ShowMeConfig>(core, "showMe");
  if (config.enabled === false) return {};

  const imageModel = (config.imageModel ?? "").trim();

  async function runForAgent(agent: Agent, prompt: string, size: string): Promise<string> {
    return generateImage({
      client: agent.llmClient as unknown as ImageChatClient,
      modelRegistry: agent.modelRegistry as Record<string, unknown>,
      imageModel,
      contextLimit: agent.contextLimit,
      prompt,
      size,
      signal: agent.abortSignal ?? null,
      emit: (line) => agent.emitOutput("command_result", { content: line }),
    });
  }

  return {
    hooks: {
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        registry.register(ShowMeTool.TOOL_NAME, new ShowMeTool(imageModel));
      },

      [HOOKS.COMMANDS_REGISTER]: async ({ registry }) => {
        registry.register("show-me", {
          description: "Generate an image from a description (/show-me [WIDTHxHEIGHT] <description>)",
          matches: (cmd: string) => cmd === "show-me" || cmd.startsWith("show-me "),
          handler: async (agent: Agent, cmdValue: string | null) => {
            const rest = (cmdValue ?? "").slice("show-me".length);
            const { size, prompt } = parseShowMeArgs(rest);
            if (!prompt) {
              return {
                action: ACTIONS.DISPLAY,
                content: "Usage: /show-me [WIDTHxHEIGHT] <description>",
              };
            }
            try {
              await runForAgent(agent, prompt, size);
              return { action: ACTIONS.DISPLAY, content: "" };
            } catch (err) {
              return { action: ACTIONS.ERROR, error: formatError(err) };
            }
          },
        });
      },
    },
  };
}
