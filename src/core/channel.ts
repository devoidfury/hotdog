import { parseCommand, Command, type ParsedCommand } from "./commands.ts";
import { OUTPUT_EVENT, OutputEvent } from "./context/output.ts";
import type { QuestionOption } from "./session/index.ts";

// Handled locally by the Channel; never passed through to the agent.
export const ChannelCommand = {
  Quit: "quit",
  Help: "help",
  Sessions: "sessions",
  Attach: "attach",
  Detach: "detach",
  Switch: "switch",
} as const;

export type ChannelCommandType =
  (typeof ChannelCommand)[keyof typeof ChannelCommand];

// Minimal SessionManager surface, so Channel avoids a circular import.
export interface ChannelSessionManager {
  enqueue(sessionId: string, text: string): void;
  cancel(sessionId: string): void;
  interrupt(sessionId: string): void;
  executeCommand(
    sessionId: string,
    cmdText: string,
  ): Promise<number | undefined>;
  onSessionEvents(
    sessionId: string,
    handler: (event: OutputEvent) => void,
  ): () => void;
  sessionIds(): string[];
  getSessionInfo(
    sessionId: string,
  ): { id: string; model?: string; profile?: string } | null;
  /** Replay on reconnect. */
  drainPendingQuestions(sessionId: string): QuestionOption[][];
}

export abstract class Channel {
  // Public for testing
  public sessionManager: ChannelSessionManager;
  public attachedSessions: Set<string>;
  /** Session that send() routes to. */
  public currentSessionId: string | null;
  public isClosed: boolean;

  constructor(options: { sessionManager: ChannelSessionManager }) {
    this.sessionManager = options.sessionManager;
    this.attachedSessions = new Set();
    this.currentSessionId = null;
    this.isClosed = false;
  }

  async send(text: string): Promise<void> {
    if (this.isClosed) return;

    const trimmed = text.trim();
    if (!trimmed) return;

    if (trimmed.startsWith("/")) {
      await this.handleCommand(trimmed.slice(1).trim());
      return;
    }

    if (this.currentSessionId) {
      this.sessionManager.enqueue(this.currentSessionId, trimmed);
    }
  }

  attach(sessionId: string): void {
    if (this.isClosed) return;
    if (this.attachedSessions.has(sessionId)) return;

    this.attachedSessions.add(sessionId);
    this._subscribe(sessionId);

    if (!this.currentSessionId) {
      this.currentSessionId = sessionId;
    }
  }

  detach(sessionId: string): void {
    if (!this.attachedSessions.has(sessionId)) return;

    this.attachedSessions.delete(sessionId);
    this._unsubscribe(sessionId);

    if (this.currentSessionId === sessionId) {
      this.currentSessionId =
        this.attachedSessions.size > 0
          ? Array.from(this.attachedSessions)[0] || null
          : null;
    }
  }

  switchSession(sessionId: string): boolean {
    if (!this.attachedSessions.has(sessionId)) {
      return false;
    }
    this.currentSessionId = sessionId;
    return true;
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /** Commands without / prefix: channel-level ones handled locally, rest passed to the session's agent. */
  protected async handleCommand(cmdText: string): Promise<void> {
    const cmd = parseCommand(cmdText) as ParsedCommand;

    switch (cmd.type) {
      case Command.Quit:
        await this.handleQuit();
        return;

      case Command.Help:
        await this.handleHelp();
        return;
    }

    if (this.isChannelCommand(cmdText)) {
      await this.handleChannelCommand(cmdText);
      return;
    }

    if (this.currentSessionId) {
      await this.sessionManager.executeCommand(this.currentSessionId, cmdText);
    }
  }

  isChannelCommand(cmdText: string): boolean {
    const channelCmds = Object.values(ChannelCommand);
    return (
      channelCmds.includes(cmdText as ChannelCommandType) ||
      cmdText.startsWith("attach ") ||
      cmdText.startsWith("detach ") ||
      cmdText.startsWith("switch ")
    );
  }

  protected async handleChannelCommand(cmdText: string): Promise<void> {
    switch (true) {
      case cmdText === ChannelCommand.Sessions:
        await this.handleSessions();
        break;
      case cmdText === ChannelCommand.Attach || cmdText.startsWith("attach "):
        await this.handleAttach(cmdText);
        break;
      case cmdText === ChannelCommand.Detach || cmdText.startsWith("detach "):
        await this.handleDetach(cmdText);
        break;
      case cmdText === ChannelCommand.Switch || cmdText.startsWith("switch "):
        await this.handleSwitch(cmdText);
        break;
      default:
        await this.handleUnknown(cmdText);
        break;
    }
  }

  protected async handleQuit(): Promise<void> {
    this.close();
  }

  /** Default no-op; subclasses override to show channel-specific help. */
  protected async handleHelp(): Promise<void> {}

  public async handleSessions(): Promise<void> {
    const ids = this.sessionManager.sessionIds();
    const lines = ["Available sessions:"];
    for (const id of ids) {
      const info = this.sessionManager.getSessionInfo(id);
      const current = id === this.currentSessionId ? " (current)" : "";
      const model = info?.model ? ` [${info.model}]` : "";
      const profile = info?.profile ? ` (${info.profile})` : "";
      lines.push(`  ${id}${model}${profile}${current}`);
    }
    this.write({ type: OUTPUT_EVENT.COMMAND_RESULT, content: lines.join("\n") });
  }

  public async handleAttach(cmdText: string): Promise<void> {
    const sessionId = cmdText.replace("attach ", "").trim();
    if (!sessionId) {
      this.write({ type: OUTPUT_EVENT.COMMAND_RESULT, content: "Usage: /attach <sessionId>" });
      return;
    }
    const info = this.sessionManager.getSessionInfo(sessionId);
    if (!info) {
      this.write({ type: OUTPUT_EVENT.COMMAND_RESULT, content: `Session not found: ${sessionId}` });
      return;
    }
    this.attach(sessionId);
    this.write({ type: OUTPUT_EVENT.COMMAND_RESULT, content: `Attached to session ${sessionId}` });
  }

  public async handleDetach(cmdText: string): Promise<void> {
    const sessionId = cmdText.replace("detach ", "").trim();
    if (!sessionId) {
      this.write({ type: OUTPUT_EVENT.COMMAND_RESULT, content: "Usage: /detach <sessionId>" });
      return;
    }
    this.detach(sessionId);
    this.write({ type: OUTPUT_EVENT.COMMAND_RESULT, content: `Detached from session ${sessionId}` });
  }

  public async handleSwitch(cmdText: string): Promise<void> {
    const sessionId = cmdText.replace("switch ", "").trim();
    if (!sessionId) {
      this.write({ type: OUTPUT_EVENT.COMMAND_RESULT, content: "Usage: /switch <sessionId>" });
      return;
    }
    if (!this.switchSession(sessionId)) {
      this.write({
        type: OUTPUT_EVENT.COMMAND_RESULT,
        content: `Cannot switch to session ${sessionId} — not attached`,
      });
      return;
    }
    this.write({ type: OUTPUT_EVENT.COMMAND_RESULT, content: `Switched to session ${sessionId}` });
  }

  public async handleUnknown(cmdText: string): Promise<void> {
    this.write({ type: OUTPUT_EVENT.COMMAND_RESULT, content: `Unknown command: ${cmdText}` });
  }

  cancel(): void {
    if (this.currentSessionId) {
      this.sessionManager.cancel(this.currentSessionId);
    }
  }

  interrupt(): void {
    if (this.currentSessionId) {
      this.sessionManager.interrupt(this.currentSessionId);
    }
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;

    for (const sessionId of this.attachedSessions) {
      this.detach(sessionId);
    }

    this._cleanup();
  }

  protected abstract write(event: OutputEvent): void;
  abstract read(): AsyncIterable<string>;
  protected abstract _subscribe(sessionId: string): void;
  protected abstract _unsubscribe(sessionId: string): void;
  protected abstract _cleanup(): void;
}
