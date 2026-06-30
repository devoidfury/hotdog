// Message types and message log for conversation management.

export class Message {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.role]
   * @param {string|Array} [opts.content] — Plain text string or array of content parts
   * @param {string|null} [opts.reasoningContent] — camelCase (API / JS)
   * @param {string|null} [opts.reasoning_content] — snake_case (JSON / log files)
   * @param {*} [opts.toolCalls] — camelCase (API / JS)
   * @param {*} [opts.tool_calls] — snake_case (JSON / log files)
   * @param {string|null} [opts.toolCallId] — camelCase (API / JS)
   * @param {string|null} [opts.tool_call_id] — snake_case (JSON / log files)
   * @param {Array<{type: string, mimeType: string, data: string}>} [opts.images] — Array of image objects
   *   Each image: { type: "image_url", mimeType: "image/png", data: "<base64>" }
   */
  constructor(src = {}) {
    this.role = src.role;
    this.content = src.content;
    // Accept both camelCase (API) and snake_case (JSON / log files)
    this.reasoningContent =
      src.reasoningContent ?? src.reasoning_content ?? null;
    this.toolCalls = src.toolCalls ?? src.tool_calls ?? null;
    this.toolCallId = src.toolCallId ?? src.tool_call_id ?? null;
    // Images: array of { type: "image_url", mimeType: "image/png", data: "<base64>" }
    this.images = src.images ?? null;
  }

  /**
   * Build the OpenAI-compatible content field.
   * - If no images, returns the content string as-is.
   * - If images present, returns array of { type: "text", text } and { type: "image_url", image_url } parts.
   * @returns {string|Array}
   */
  _buildContent() {
    if (!this.images || this.images.length === 0) {
      return this.content ?? "";
    }

    const parts = [];

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
  toJSON() {
    const obj = { role: this.role, content: this._buildContent() };
    if (this.reasoningContent) obj.reasoning_content = this.reasoningContent;
    if (this.toolCalls) obj.tool_calls = this.toolCalls;
    if (this.toolCallId) obj.tool_call_id = this.toolCallId;
    if (this.images?.length > 0) {
      obj.images = this.images;
    }
    return obj;
  }

  /**
   * Get the plain text content for logging/display purposes.
   * Strips image parts from content arrays.
   * @returns {string}
   */
  getTextContent() {
    if (!this.content) return "";
    if (typeof this.content === "string") return this.content;
    if (Array.isArray(this.content)) {
      return this.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
    }
    return String(this.content);
  }
}
