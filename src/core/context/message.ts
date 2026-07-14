// Message types and message log for conversation management.

export interface ImageAttachment {
  type: "image_url";
  mimeType: string;
  data: string;
}

/**
 * Canonical constructor parameters — camelCase only.
 * Use Message.fromJSON() to deserialize from snake_case persistence.
 */
export interface MessageParams {
  role?: string;
  content?: string | Array<unknown>;
  reasoningContent?: string | null;
  toolCalls?: unknown;
  toolCallId?: string | null;
  images?: ImageAttachment[];
}

export class Message {
  role: string | undefined;
  content: string | Array<unknown> | undefined;
  reasoningContent: string | null;
  toolCalls: unknown;
  toolCallId: string | null;
  images: ImageAttachment[] | null | undefined;

  /**
   * @param opts — camelCase parameters only.
   *   content: Plain text string or array of content parts.
   *   images: Array of { type: "image_url", mimeType, data }.
   */
  constructor(opts: MessageParams = {}) {
    this.role = opts.role;
    this.content = opts.content;
    this.reasoningContent = opts.reasoningContent ?? null;
    this.toolCalls = opts.toolCalls ?? null;
    this.toolCallId = opts.toolCallId ?? null;
    this.images = opts.images ?? null;
  }

  /**
   * Deserialize from JSON/snake_case data (persistence/log format).
   * Normalizes snake_case keys to camelCase.
   *
   * @param data — Raw deserialized object, possibly with snake_case keys.
   */
  static fromJSON(data: Record<string, unknown>): Message {
    return new Message({
      role: data.role as string | undefined,
      content: data.content as string | Array<unknown> | undefined,
      reasoningContent: (data.reasoning_content ?? data.reasoningContent) as string | null,
      toolCalls: data.tool_calls ?? data.toolCalls ?? null,
      toolCallId: (data.tool_call_id ?? data.toolCallId) as string | null,
      images: data.images as ImageAttachment[] | undefined,
    });
  }

  /**
   * Build the OpenAI-compatible content field.
   * - If no images, returns the content string as-is.
   * - If images present, returns array of { type: "text", text } and { type: "image_url", image_url } parts.
   */
  _buildContent(): string | Array<unknown> {
    if (!this.images || this.images.length === 0) {
      return this.content ?? "";
    }

    const parts: Array<unknown> = [];

    // Add text part if content exists
    if (this.content) {
      // If content is already an array of parts, spread it
      if (Array.isArray(this.content)) {
        parts.push(...this.content);
      } else {
        parts.push({ type: "text", text: this.content });
      }
    }

    // Add image parts
    for (const img of this.images) {
      const mimeType = img.mimeType || "image/png";
      const data = img.data || "";
      const url = data.startsWith("data:")
        ? data
        : `data:${mimeType};base64,${data}`;
      parts.push({
        type: "image_url",
        image_url: { url },
      });
    }

    return parts;
  }

  /**
   * Serialize to JSON (snake_case for persistence).
   */
  toJSON(): Record<string, unknown> {
    const obj: Record<string, unknown> = {
      role: this.role,
      content: this._buildContent(),
    };
    if (this.reasoningContent) obj.reasoning_content = this.reasoningContent;
    if (this.toolCalls) obj.tool_calls = this.toolCalls;
    if (this.toolCallId) obj.tool_call_id = this.toolCallId;
    if (this.images && this.images.length > 0) {
      obj.images = this.images;
    }
    return obj;
  }

  /**
   * Get the plain text content for logging/display purposes.
   * Strips image parts from content arrays.
   */
  getTextContent(): string {
    if (!this.content) return "";
    if (typeof this.content === "string") return this.content;
    if (Array.isArray(this.content)) {
      return this.content
        .filter((part: Record<string, unknown>) => part.type === "text")
        .map((part: Record<string, unknown>) => part.text as string)
        .join("\n");
    }
    return String(this.content);
  }
}
