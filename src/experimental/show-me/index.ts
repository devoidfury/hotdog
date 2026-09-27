// show-me - image-generation capability via tool call and slash commands
//
//   - /show-me [WIDTHxHEIGHT] <description...>  (user command)
//   - show_me tool (assistant-driven)
//
// Backend model must declare at least "text" input and "image" output.
//
// The generation model can be specified in config file (showMe.imageModel).
// When omitted (empty), AUTO mode scans the model registry for the first entry
// with declared modalities satisfying text-in / image-out.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve as resolveAbs } from "node:path";

import { HOOKS } from "@core/hooks.ts";
import { ACTIONS } from "@core/commands.ts";
import { ToolError, formatError } from "@core/error.ts";
import { findModelEntry, resolveModelConfig, type ModelConfig } from "@core/config/providers.ts";
import { Message, type ImageAttachment } from "@core/context/message.ts";
import {
  defaultCallDisplay,
  param,
  parseToolInput,
  ToolResult,
  toolDef,
} from "@core/extensions/tool-utils.ts";
import type { ToolDef, ToolMetadata } from "@core/extensions/tool-registry.ts";
import type { LlmProtocol } from "@core/llm-client/protocol.ts";
import type { WireFormat } from "@core/extensions/wire-format.ts";
import type { RoleMapping } from "@core/extensions/role-mapping.ts";
import type { MarkerMangler } from "@core/marker-mangler.ts";
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
 * empty means AUTO: scan the registry for an entry declaring "text" input and "image" output
 * (plus "image" input when requireImageInput, so input_image never lands on a text-input-only model).
 *
 * Unlike isTextGenerative's progressive-enhancement leniency, entries with ABSENT modality data are never auto-picked:
 * unknown capabilities must not hijack generation. Deterministic when several match: the first in registry
 * iteration order (Object.keys insertion order, i.e. provider declaration order) wins -- no sorting, stable across runs.
 */
export function pickImageModel(
  registry: Record<string, unknown>,
  modelName: string,
  requireImageInput: boolean,
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
    if (requireImageInput && !entry.inputModalities.includes("image")) continue;
    const name = entry.name ?? key;
    logger.debug(`show-me: auto-selected image model "${name}"`);
    return { key, name, entry, auto: true };
  }

  const need = requireImageInput
    ? 'inputModalities include "text" and "image" AND outputModalities include "image"'
    : 'outputModalities include "image"';
  throw new ToolError(
    `show-me: no image model configured and no model in the registry declares ${need}. ` +
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

/** One image-bearing part of a chat response: url object, inline url part, or b64 field. */
function decodeImagePart(part: unknown): GeneratedImage | null {
  if (typeof part === "string") return decodeDataUrl(part.trim());
  if (!part || typeof part !== "object") return null;
  const rec = part as Record<string, unknown>;

  const imageUrl = rec.image_url ?? rec.imageUrl;
  const url =
    typeof imageUrl === "string"
      ? imageUrl
      : typeof (imageUrl as Record<string, unknown> | undefined)?.url === "string"
        ? ((imageUrl as Record<string, unknown>).url as string)
        : null;
  if (url) {
    const img = decodeDataUrl(url.trim());
    if (img) return img;
  }

  const b64 = rec.b64_json ?? rec.b64JSON;
  if (typeof b64 === "string") {
    const mime = typeof rec.mime_type === "string" ? rec.mime_type : "image/png";
    return decodeBase64Payload(b64, mime);
  }
  return null;
}

/**
 * Pull the first decodable image out of a chat-completion JSON payload.
 * Shapes handled (defensively, backends disagree):
 *   - choices[].message.images[] with image_url.url (data URL) or b64_json
 *   - choices[].message.content[] parts of type "image_url"
 *   - choices[].message.content as a bare data:image/...;base64, string
 * Text-only responses yield null -- the caller turns that into a clear error.
 */
export function extractGeneratedImage(payload: unknown): GeneratedImage | null {
  const choices = (payload as Record<string, unknown> | null)?.choices;
  if (!Array.isArray(choices)) return null;

  for (const choice of choices) {
    const message = (choice as Record<string, unknown> | null)?.message as
      Record<string, unknown> | null | undefined;
    if (!message) continue;

    const candidates: unknown[] = [];
    if (Array.isArray(message.images)) candidates.push(...message.images);
    const content = message.content;
    if (Array.isArray(content)) candidates.push(...content);
    else if (typeof content === "string" && /^data:image\//i.test(content.trim())) {
      candidates.push(content);
    }

    for (const candidate of candidates) {
      const img = decodeImagePart(candidate);
      if (img) return img;
    }
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

const INPUT_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function mimeForInputImage(path: string): string {
  const mime = INPUT_MIME_BY_EXT[extname(path).toLowerCase()];
  if (!mime) {
    throw new ToolError(
      `show-me: cannot infer the image type of input_image "${path}" (supported: png, jpg, webp, gif).`,
    );
  }
  return mime;
}

/** Timestamped default output path under ./generated/ (relative to cwd). */
export function defaultOutputPath(now: Date, mimeType: string): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(resolveAbs(DEFAULT_OUTPUT_DIR), `show-me-${stamp}.${extensionForMime(mimeType)}`);
}

// ── LlmClient Call ──────────────────────────────────────────────────────────

/**
 * The slice of LlmClient this extension uses, declared structurally so tests can pass a duck-typed fake.
 * `_doRequest` is the client's transport: it resolves the protocol headers, applies timeouts, and
 *  classifies failures into LlmErrors.
 */
export interface ImageChatClient {
  sessionId?: string;
  markerMangler?: MarkerMangler | null;
  ensureManglerCovers?(modelConfig: ModelConfig): void;
  protocolFor(modelConfig: ModelConfig): LlmProtocol;
  resolveWireFormat?(modelConfig: ModelConfig): WireFormat | null;
  resolveRoleMapping?(modelConfig: ModelConfig): RoleMapping | null;
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
 * One non-streaming chat request through the session's LlmProtocol; returns the parsed JSON payload.
 * JSON parse failures propagate to the caller's catch.
 */
export async function requestImageJson(
  client: ImageChatClient,
  modelConfig: ModelConfig,
  message: Message,
  signal: AbortSignal | null,
): Promise<unknown> {
  const protocol = client.protocolFor(modelConfig);
  const { url, apiKey } = client.resolveProviderSettings(modelConfig.name);
  client.ensureManglerCovers?.(modelConfig);

  const ctx: Parameters<LlmProtocol["buildRequest"]>[4] = {
    mangler: client.markerMangler ?? null,
    wireFormat: client.resolveWireFormat?.(modelConfig) ?? null,
    roleMapping: client.resolveRoleMapping?.(modelConfig) ?? null,
    baseUrl: url,
    apiKey,
    sessionId: client.sessionId ?? "",
  };

  const { path, body } = protocol.buildRequest([message], modelConfig, null, false, ctx);
  const response = await client._doRequest(
    url,
    apiKey,
    body as Record<string, unknown>,
    signal,
    modelConfig,
    path,
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
  inputImage?: string | null;
  signal?: AbortSignal | null;
  emit?: (line: string) => void;
}

/** Generate an image and write it to disk. Returns the written path. */
export async function generateImage(p: GenerateImageParams): Promise<string> {
  const { key: modelKey, name: modelName, entry, auto } = pickImageModel(
    p.modelRegistry,
    p.imageModel,
    Boolean(p.inputImage),
  );
  // Auto mode tells the user which model was picked (command output + tool emit).
  if (auto) p.emit?.(`Using image model: ${modelName}`);

  let images: ImageAttachment[] | undefined;
  if (p.inputImage) {
    if (!entry.inputModalities?.includes("image")) {
      throw new ToolError(
        `show-me: model "${modelName}" does not accept image input (inputModalities: ${entry.inputModalities?.length ? entry.inputModalities.join(", ") : "none"}); input_image cannot be used.`,
      );
    }
    const mimeType = mimeForInputImage(p.inputImage);
    let bytes: Buffer;
    try {
      bytes = await readFile(p.inputImage);
    } catch {
      throw ToolError.NotReadable(p.inputImage);
    }
    images = [{ type: "image_url", mimeType, data: bytes.toString("base64") }];
  }

  const modelConfig = resolveModelConfig(
    modelKey,
    p.modelRegistry as unknown as Parameters<typeof resolveModelConfig>[1],
    p.contextLimit,
    undefined,
  );

  // The chat protocol has no size field; the request body is protocol-owned, so the requested dimensions ride in the prompt text.
  const content = `${p.prompt}\n\n[Image size: ${p.size}]`;
  const message = new Message({ role: "user", source: "user", content, images });

  const payload = await requestImageJson(p.client, modelConfig, message, p.signal ?? null);
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
  input_image?: string;
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
      "Generate an image from a text description using the configured image-output model. Optionally condition on an input image (only if the model accepts image input) and choose the output size or file path.",
      {
        properties: {
          description: param("string", "Text description of the image to generate."),
          size: param("string", `Output size as WIDTHxHEIGHT (default ${DEFAULT_SIZE}).`),
          output_path: param(
            "string",
            "Optional file path for the generated image; defaults to a timestamped file under ./generated/.",
          ),
          input_image: param(
            "string",
            "Optional path to an input image to condition on; requires the selected model to declare image input.",
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
        inputImage: typeof args.input_image === "string" ? args.input_image : null,
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
