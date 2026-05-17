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

export class SystemMessage {
  constructor(content) {
    this.role = 'system';
    this.content = content;
  }

  toJSON() {
    return { role: this.role, content: this.content };
  }
}

/**
 * Message log for conversation context.
 */
export class MessageLog {
  constructor() {
    this.messages = [];
    this.systemMessages = [];
  }

  addMessage(role, content, reasoningContent = null, toolCalls = null, toolCallId = null) {
    this.messages.push(new Message({ role, content, reasoningContent, toolCalls, toolCallId }));
  }

  addUserMessage(content) {
    this.addMessage('user', content);
  }

  addAssistantMessage(content, reasoningContent = null, toolCalls = null) {
    this.addMessage('assistant', content, reasoningContent, toolCalls);
  }

  addSystemMessage(content) {
    this.systemMessages.push(new SystemMessage(content));
  }

  /**
   * Insert a message at a specific index in the messages array.
   * Rust: context.insert_at(index, message)
   */
  insertAt(index, message) {
    this.messages.splice(index, 0, message);
  }

  /**
   * Replace the entire messages array.
   * Rust: context.replace_messages(new_messages)
   */
  replaceMessages(newMessages) {
    this.messages = newMessages;
  }

  /**
   * Get a copy of the messages array.
   * Rust: context.messages()
   */
  messages() {
    return [...this.messages];
  }

  getMessages() {
    return [...this.systemMessages, ...this.messages];
  }

  getMessagesAsJSON() {
    return this.getMessages().map(m => m.toJSON());
  }

  size() {
    return this.messages.length;
  }

  clear() {
    this.messages = [];
    this.systemMessages = [];
  }
}
