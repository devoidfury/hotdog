// Message types and message log for conversation management.

export class Message {
  constructor({ role, content, reasoningContent = null, toolCalls = null, toolCallId = null } = {}) {
    this.role = role;
    this.content = content;
    this.reasoningContent = reasoningContent;
    this.toolCalls = toolCalls;
    this.toolCallId = toolCallId;
  }

  toJSON() {
    const obj = { role: this.role, content: this.content ?? "" };
    if (this.reasoningContent) obj.reasoning_content = this.reasoningContent;
    if (this.toolCalls !== null) obj.tool_calls = this.toolCalls;
    if (this.toolCallId !== null) obj.tool_call_id = this.toolCallId;
    return obj;
  }
}
