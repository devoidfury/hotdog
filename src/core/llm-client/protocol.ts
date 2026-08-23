// LlmProtocol — pluggable wire protocol for LLM requests/responses.
//
// A protocol owns everything backend-specific: request building, response
// stream parsing, auth headers, health checks, and model listing. The
// LlmClient resolves the protocol from `modelConfig.protocol` and delegates;
// it keeps only transport concerns (retry, timeout, cancellation).
//
// `buildRequest` takes RAW Message[] so protocols are self-contained. The
// WireFormat layer (serialize.ts) is used by protocols that need it; the
// mangler is passed via ProtocolContext so serialization can mangle at the
// wire boundary.

import type { Message } from "../context/message.ts";
import type { ModelConfig, ProviderDef } from "../config/providers.ts";
import type { ToolDef } from "../extensions/tool-registry.ts";
import type { StreamEvent } from "./client.ts";
import type { MarkerMangler } from "../marker-mangler.ts";

/** Context passed to protocol methods at call time. */
export interface ProtocolContext {
  /** The session's marker mangler (null if disabled). */
  mangler: MarkerMangler | null;
  /** Provider base URL (without trailing slash). */
  baseUrl: string;
  /** Provider API key (null if none). */
  apiKey: string | null;
  /** Session ID for affinity headers. */
  sessionId: string;
}

export interface LlmProtocol {
  id: string;

  /**
   * Build the HTTP request body and path for a chat completion.
   * @param messages - Raw internal messages.
   * @param modelConfig - Resolved model configuration.
   * @param toolDefs - Tool definitions to include, or null/empty for none.
   * @param stream - Whether to request streaming.
   * @param ctx - Call-time context (mangler, credentials, session).
   */
  buildRequest(
    messages: Message[],
    modelConfig: ModelConfig,
    toolDefs: ToolDef[] | null,
    stream: boolean,
    ctx: ProtocolContext,
  ): { path: string; body: unknown };

  /**
   * Build the HTTP headers for a request.
   */
  buildHeaders(ctx: ProtocolContext): Record<string, string>;

  /**
   * Parse a response into StreamEvents. Normalizes INTO the existing
   * StreamEvent shape so everything downstream stays untouched.
   */
  parseStream(response: Response, ctx: ProtocolContext): AsyncIterable<StreamEvent>;

  /** Optional health check. */
  health?(ctx: ProtocolContext): Promise<boolean>;

  /** Optional model listing. */
  listModels?(ctx: ProtocolContext): Promise<Array<{ id: string; [key: string]: unknown }>>;
}

// ── Registry ────────────────────────────────────────────────────────────────

export class LlmProtocolRegistry {
  #protocols: Map<string, LlmProtocol>;

  constructor() {
    this.#protocols = new Map();
  }

  register(protocol: LlmProtocol): void {
    if (!protocol || typeof protocol.id !== "string" || !protocol.id) {
      throw new Error("LlmProtocol requires a non-empty id");
    }
    this.#protocols.set(protocol.id, protocol);
  }

  has(id: string): boolean {
    return this.#protocols.has(id);
  }

  get(id: string): LlmProtocol | undefined {
    return this.#protocols.get(id);
  }

  names(): string[] {
    return Array.from(this.#protocols.keys());
  }
}

export function createLlmProtocolRegistry(): LlmProtocolRegistry {
  return new LlmProtocolRegistry();
}

/**
 * Resolve the LlmProtocol id for a model, mirroring the wireFormat/toolFormat
 * chain: model-level -> provider-level -> default ("openai"). The model entry
 * is the resolved ModelConfig (registry lookup already applied).
 */
export function resolveProtocolId(
  modelConfig: { name: string; protocol?: string },
  providers: ProviderDef[] | undefined,
): string {
  const providerName = modelConfig.name.split("/")[0];
  const provider = providers?.find((p) => p.name === providerName);
  return modelConfig.protocol ?? provider?.protocol ?? "openai";
}
