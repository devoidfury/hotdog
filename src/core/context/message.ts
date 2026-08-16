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

// CamelCase only; use Message.fromJSON() for snake_case persistence data.
export interface MessageParams {
  role?: string;
  content?: string | Array<unknown> | null;
  reasoningContent?: string | null;
  toolCalls?: ToolCall[] | null;
  toolCallId?: string | null;
  images?: ImageAttachment[];
}

export class Message {
  role: string | undefined;
  content: string | Array<unknown> | undefined;
  reasoningContent: string | null;
  toolCalls: ToolCall[] | null;
  toolCallId: string | null;
  images: ImageAttachment[] | undefined;

  constructor(opts: MessageParams = {}) {
    this.role = opts.role;
    this.content = opts.content ?? undefined;
    this.reasoningContent = opts.reasoningContent ?? null;
    this.toolCalls = opts.toolCalls ?? null;
    this.toolCallId = opts.toolCallId ?? null;
    this.images = opts.images ?? undefined;
  }

  /** Deserialize persistence/log JSON; normalizes snake_case keys to camelCase. */
  static fromJSON(data: Record<string, unknown>): Message {
    return new Message({
      role: data.role as string | undefined,
      content: data.content as string | Array<unknown> | undefined,
      reasoningContent: (data.reasoning_content ?? data.reasoningContent) as string | undefined,
      toolCalls: (data.tool_calls ?? data.toolCalls) as ToolCall[] | undefined ?? null,
      toolCallId: (data.tool_call_id ?? data.toolCallId) as string | undefined,
      images: data.images as ImageAttachment[] | undefined,
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

  /** Serialize to snake_case JSON for persistence. */
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

  /** Plain text for logging/display; strips image parts from content arrays. */
  getTextContent(): string {
    if (!this.content) return "";
    if (typeof this.content === "string") return this.content;
    if (Array.isArray(this.content)) {
      return this.content
        .filter((part): part is Record<string, unknown> => (part as Record<string, unknown>).type === "text")
        .map((part) => part.text as string)
        .join("\n");
    }
    return String(this.content);
  }
}
