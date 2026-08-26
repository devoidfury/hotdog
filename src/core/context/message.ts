export interface ImageAttachment {
  type: "image_url";
  mimeType: string;
  data: string;
}

export interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

/**
 * Provenance of a message: who produced its content. Pure provenance --
 * carries no wire semantics. The serializer maps (role, source, wireFormat)
 * to the wire role and decides escaping:
 *   - "system"  -- system prompt / harness instructions (never escaped)
 *   - "user"    -- user input (always escaped)
 *   - "model"   -- LLM output (always escaped)
 *   - "harness" -- code-generated; trusted except segments marked with the
 *                  `untrusted` content part, which the wire serializer always
 *                  mangles (raw everywhere else: context, logs, display)
 *   - "tool"    -- tool execution results; content is untrusted external
 *                  data (always escaped)
 * `undefined` is legacy only (pre-provenance logs); treated as untrusted.
 */
export type MessageSource = "user" | "harness" | "model" | "system" | "tool";

export const MESSAGE_SOURCES: readonly MessageSource[] = ["user", "harness", "model", "system", "tool"];

// CamelCase only; use Message.fromJSON() for snake_case persistence data.
/**
 * Content parts (for `content` arrays):
 *  - { type: "text", text } -- plain text
 *  - { type: "untrusted", text } -- untrusted payload (model or tool output)
 *    embedded in a trusted (harness/system) message. Stored RAW in the
 *    context, session log, and display; the wire serializer (serialize.ts)
 *    is the only place it is mangled. Emitted as a "text" part on the wire.
 *  - { type: "image_url", image_url: { url } }
 */
export interface MessageParams {
  role?: string;
  content?: string | Array<unknown> | null;
  reasoningContent?: string | null;
  toolCalls?: ToolCall[] | null;
  toolCallId?: string | null;
  images?: ImageAttachment[];
  source?: MessageSource;
}

export class Message {
  role: string | undefined;
  content: string | Array<unknown> | undefined;
  reasoningContent: string | null;
  toolCalls: ToolCall[] | null;
  toolCallId: string | null;
  images: ImageAttachment[] | undefined;
  source: MessageSource | undefined;

  constructor(opts: MessageParams = {}) {
    this.role = opts.role;
    this.content = opts.content ?? undefined;
    this.reasoningContent = opts.reasoningContent ?? null;
    this.toolCalls = opts.toolCalls ?? null;
    this.toolCallId = opts.toolCallId ?? null;
    this.images = opts.images ?? undefined;
    this.source = opts.source;
  }

  /** Deserialize persistence/log JSON; normalizes snake_case keys to camelCase. */
  static fromJSON(data: Record<string, unknown>): Message {
    const source =
      typeof data.source === "string" && (MESSAGE_SOURCES as readonly string[]).includes(data.source)
        ? (data.source as MessageSource)
        : undefined;
    const images = Array.isArray(data.images) ? (data.images as ImageAttachment[]) : undefined;
    let content = data.content as string | Array<unknown> | undefined;
    // Legacy heal: pre-fix toJSON() inlined image parts into content AND kept
    // the images array, so restoring such data would re-inline them on the
    // wire. `images` is canonical -- drop inlined image_url parts whose URL
    // matches a derived images URL; anything else is preserved.
    if (images?.length && Array.isArray(content)) {
      const expectedUrls = new Set(images.map((img) => Message.imagePartUrl(img)));
      content = content.filter((part) => {
        if (!part || typeof part !== "object" || (part as Record<string, unknown>).type !== "image_url") {
          return true;
        }
        const url = (part as { image_url?: { url?: unknown } }).image_url?.url;
        return typeof url !== "string" || !expectedUrls.has(url);
      });
    }
    return new Message({
      role: data.role as string | undefined,
      content,
      reasoningContent: (data.reasoning_content ?? data.reasoningContent) as string | undefined,
      toolCalls: (data.tool_calls ?? data.toolCalls) as ToolCall[] | undefined ?? null,
      toolCallId: (data.tool_call_id ?? data.toolCallId) as string | undefined,
      images,
      source,
    });
  }

  /** OpenAI-compatible content field; wraps text + images as part arrays when images are present. */
  _buildContent(): string | Array<unknown> {
    if (!this.images || this.images.length === 0) {
      return this.content ?? "";
    }

    const parts: Array<unknown> = [];

    if (this.content) {
      if (Array.isArray(this.content)) {
        parts.push(...this.content);
      } else {
        parts.push({ type: "text", text: this.content });
      }
    }

    for (const img of this.images) {
      parts.push({ type: "image_url", image_url: { url: Message.imagePartUrl(img) } });
    }
    return parts;
  }

  /** Derive the wire data-URL for an attachment (same rule as legacy inlined parts). */
  private static imagePartUrl(img: ImageAttachment): string {
    const mimeType = img.mimeType || "image/png";
    const data = img.data || "";
    return data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
  }

  /**
   * Serialize to snake_case JSON for persistence.
   *
   * Content is stored RAW (as set), never via _buildContent(): images ride
   * the separate `images` field, and _buildContent() is the only place they
   * get merged into content parts. Inlining them here too would duplicate
   * every image on each serialize/deserialize round-trip.
   */
  toJSON(): Record<string, unknown> {
    const obj: Record<string, unknown> = {
      role: this.role,
      content: this.content ?? "",
    };
    if (this.reasoningContent) obj.reasoning_content = this.reasoningContent;
    if (this.toolCalls) obj.tool_calls = this.toolCalls;
    if (this.toolCallId) obj.tool_call_id = this.toolCallId;
    if (this.images && this.images.length > 0) {
      obj.images = this.images;
    }
    if (this.source !== undefined) {
      obj.source = this.source;
    }
    return obj;
  }

  /** Plain text for logging/display; strips image parts from content arrays. */
  getTextContent(): string {
    return contentToText(this.content);
  }
}

/**
 * Plain-text form of a content value: strings pass through, part arrays are
 * flattened (text + untrusted parts, images dropped). For hooks, logs,
 * and display; the wire serializer works on the raw parts.
 */
export function contentToText(content: string | Array<unknown> | null | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is Record<string, unknown> => {
        if (part == null || typeof part !== "object") return false;
        const p = part as Record<string, unknown>;
        return (p.type === "text" || p.type === "untrusted") && typeof p.text === "string";
      })
      .map((part) => part.text as string)
      .join("\n");
  }
  return String(content);
}
