// Message types and message log for conversation management.

export class Message {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.role]
   * @param {string} [opts.content]
   * @param {string|null} [opts.reasoningContent] — camelCase (API / JS)
   * @param {string|null} [opts.reasoning_content] — snake_case (JSON / log files)
   * @param {*} [opts.toolCalls] — camelCase (API / JS)
   * @param {*} [opts.tool_calls] — snake_case (JSON / log files)
   * @param {string|null} [opts.toolCallId] — camelCase (API / JS)
   * @param {string|null} [opts.tool_call_id] — snake_case (JSON / log files)
   */
  constructor({
    role,
    content,
    reasoningContent,
    reasoning_content,
    toolCalls,
    tool_calls,
    toolCallId,
    tool_call_id,
  } = {}) {
    this.role = role;
    this.content = content;
    // Accept both camelCase (API) and snake_case (JSON / log files)
    this.reasoningContent = reasoningContent ?? reasoning_content ?? null;
    this.toolCalls = toolCalls ?? tool_calls ?? null;
    this.toolCallId = toolCallId ?? tool_call_id ?? null;
  }

  toJSON() {
    const obj = { role: this.role, content: this.content ?? "" };
    if (this.reasoningContent) obj.reasoning_content = this.reasoningContent;
    if (this.toolCalls !== null) obj.tool_calls = this.toolCalls;
    if (this.toolCallId !== null) obj.tool_call_id = this.toolCallId;
    return obj;
  }
}
