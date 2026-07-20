// Channel — explicit layer between the agent harness and any UI.
// A Channel represents one UI connection (terminal, WebSocket, etc.)
// attached to one or more sessions. It is the duplex: input flows in
// via send(), output flows out via event subscriptions.

import { parseCommand, Command, ACTIONS, type ParsedCommand, type CommandRegistryLike } from "./commands.ts";
import { OutputEvent } from "./context/output.ts";

// ── Channel Commands ──────────────────────────────────────────────────────

/**
 * Channel-level command types. These are handled locally by the Channel
 * and never passed through to the agent.
 */
export const ChannelCommand = {
  Quit: "quit",
  Help: "help",
  Sessions: "sessions",
  Attach: "attach",
  Detach: "detach",
  Switch: "switch",
} as const;

export type ChannelCommandType = (typeof ChannelCommand)[keyof typeof ChannelCommand];

// ── Session Manager Interface ─────────────────────────────────────────────

/**
 * Minimal SessionManager interface that Channel depends on.
 * Avoids circular imports by describing only what's used.
 */
export interface ChannelSessionManager {
  /** Enqueue text for the given session's agent. */
  enqueue(sessionId: string, text: string): void;
  /** Cancel the run loop for the given session. */
  cancel(sessionId: string): void;
  /** Interrupt the current processing for the given session. */
  interrupt(sessionId: string): void;
  /** Execute a command on the given session. */
  executeCommand(sessionId: string, cmdText: string): Promise<number | undefined>;
  /** Subscribe to events from a specific session. Returns an unsubscribe function. */
  onSessionEvents(sessionId: string, handler: (event: OutputEvent) => void): () => void;
  /** List all session IDs. */
  sessionIds(): string[];
  /** Get session metadata. */
  getSessionInfo(sessionId: string): { id: string; model?: string; profile?: string } | null;
  /** Drain buffered QUESTION events for a session (replay on reconnect). */
  drainPendingQuestions(sessionId: string): unknown[][];
}

// ── Channel Base Class ────────────────────────────────────────────────────

export interface ChannelOptions {
  sessionManager: ChannelSessionManager;
}

/**
 * Base Channel class — provides the duplex protocol between UI and sessions.
 *
 * Subclasses must implement:
 *  - write(event) — format and deliver an event to the connection
 *  - read() — yield raw input text from the connection
 *  - _subscribe(sessionId) — wire session events to this channel
 *  - _unsubscribe(sessionId) — remove the wire
 *  - _cleanup() — release connection resources on close
 */
export abstract class Channel {
  protected sessionManager: ChannelSessionManager;

  /** Sessions this channel is attached to. */
  protected attachedSessions: Set<string>;

  /** The "current" session that send() routes to. */
  protected currentSessionId: string | null;

  /** Whether this channel is closed. */
  protected isClosed: boolean;

  /**
   * @param options
   * @param options.sessionManager — SessionManager instance
   */
  constructor(options: ChannelOptions) {
    this.sessionManager = options.sessionManager;
    this.attachedSessions = new Set();
    this.currentSessionId = null;
    this.isClosed = false;
  }

  // ── Duplex ──────────────────────────────────────────────────────────────

  /**
   * Send text input. Routes to the current session's agent.
   * Commands (prefixed with /) are checked for channel-level handling first.
   * @param text — Raw input text
   */
  async send(text: string): Promise<void> {
    if (this.isClosed) return;

    const trimmed = text.trim();
    if (!trimmed) return;

    // Check for command prefix
    if (trimmed.startsWith("/")) {
      const cmdText = trimmed.slice(1).trim().toLowerCase();
      await this.handleCommand(cmdText);
      return;
    }

    // Regular text — enqueue to current session
    if (this.currentSessionId) {
      this.sessionManager.enqueue(this.currentSessionId, trimmed);
    }
  }

  // ── Session Attachment ──────────────────────────────────────────────────

  /**
   * Attach this channel to a session.
   * Subscribes to the session's events and adds it to the attached set.
   * @param sessionId — Session ID to attach to
   */
  attach(sessionId: string): void {
    if (this.isClosed) return;
    if (this.attachedSessions.has(sessionId)) return;

    this.attachedSessions.add(sessionId);
    this._subscribe(sessionId);

    // If no current session, use this one
    if (!this.currentSessionId) {
      this.currentSessionId = sessionId;
    }
  }

  /**
   * Detach this channel from a session.
   * Unsubscribes from events and removes from the attached set.
   * @param sessionId — Session ID to detach from
   */
  detach(sessionId: string): void {
    if (!this.attachedSessions.has(sessionId)) return;

    this.attachedSessions.delete(sessionId);
    this._unsubscribe(sessionId);

    // If we detached the current session, switch to another or null
    if (this.currentSessionId === sessionId) {
      this.currentSessionId =
        this.attachedSessions.size > 0
          ? Array.from(this.attachedSessions)[0] || null
          : null;
    }
  }

  /**
   * Switch the current session to a different one.
   * @param sessionId — Session ID to switch to
   * @returns Whether the switch was successful
   */
  switchSession(sessionId: string): boolean {
    if (!this.attachedSessions.has(sessionId)) {
      return false;
    }
    this.currentSessionId = sessionId;
    return true;
  }

  /**
   * Get the current session ID.
   */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  // ── Command Routing ─────────────────────────────────────────────────────

  /**
   * Handle a command (already stripped of / prefix).
   * Channel-level commands are handled locally; everything else
   * passes through to the session's agent.
   * @param cmdText — Command text without / prefix
   */
  protected async handleCommand(cmdText: string): Promise<void> {
    const cmd = parseCommand(cmdText) as ParsedCommand;

    // Channel-level commands — handled locally
    switch (cmd.type) {
      case Command.Quit:
        await this.handleQuit();
        return;

      case Command.Help:
        await this.handleHelp();
        return;
    }

    // Check for channel-specific commands
    if (this.isChannelCommand(cmdText)) {
      await this.handleChannelCommand(cmdText);
      return;
    }

    // Pass through to the session's agent
    if (this.currentSessionId) {
      await this.sessionManager.executeCommand(this.currentSessionId, cmdText);
    }
  }

  /**
   * Check if a command is a channel-level command.
   * @param cmdText — Command text without / prefix
   */
  protected isChannelCommand(cmdText: string): boolean {
    const channelCmds = Object.values(ChannelCommand);
    return channelCmds.includes(cmdText as ChannelCommandType) ||
      cmdText.startsWith("attach ") ||
      cmdText.startsWith("detach ") ||
      cmdText.startsWith("switch ");
  }

  /**
   * Handle a channel-level command.
   * @param cmdText — Command text without / prefix
   */
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

  // ── Command Handlers (overridable) ──────────────────────────────────────

  /** Handle /quit — default is to close the channel. */
  protected async handleQuit(): Promise<void> {
    this.close();
  }

  /** Handle /help — override to show channel-specific help. */
  protected async handleHelp(): Promise<void> {
    // Default no-op — subclasses override
  }

  /** Handle /sessions — list available sessions. */
  protected async handleSessions(): Promise<void> {
    const ids = this.sessionManager.sessionIds();
    const lines = ["Available sessions:"];
    for (const id of ids) {
      const info = this.sessionManager.getSessionInfo(id);
      const current = id === this.currentSessionId ? " (current)" : "";
      const model = info?.model ? ` [${info.model}]` : "";
      const profile = info?.profile ? ` (${info.profile})` : "";
      lines.push(`  ${id}${model}${profile}${current}`);
    }
    this.write({ type: 7, content: lines.join("\n") }); // COMMAND_RESULT
  }

  /** Handle /attach <sessionId>. */
  protected async handleAttach(cmdText: string): Promise<void> {
    const sessionId = cmdText.replace("attach ", "").trim();
    if (!sessionId) {
      this.write({ type: 7, content: "Usage: /attach <sessionId>" });
      return;
    }
    const info = this.sessionManager.getSessionInfo(sessionId);
    if (!info) {
      this.write({ type: 7, content: `Session not found: ${sessionId}` });
      return;
    }
    this.attach(sessionId);
    this.write({ type: 7, content: `Attached to session ${sessionId}` });
  }

  /** Handle /detach <sessionId>. */
  protected async handleDetach(cmdText: string): Promise<void> {
    const sessionId = cmdText.replace("detach ", "").trim();
    if (!sessionId) {
      this.write({ type: 7, content: "Usage: /detach <sessionId>" });
      return;
    }
    this.detach(sessionId);
    this.write({ type: 7, content: `Detached from session ${sessionId}` });
  }

  /** Handle /switch <sessionId>. */
  protected async handleSwitch(cmdText: string): Promise<void> {
    const sessionId = cmdText.replace("switch ", "").trim();
    if (!sessionId) {
      this.write({ type: 7, content: "Usage: /switch <sessionId>" });
      return;
    }
    if (!this.switchSession(sessionId)) {
      this.write({ type: 7, content: `Cannot switch to session ${sessionId} — not attached` });
      return;
    }
    this.write({ type: 7, content: `Switched to session ${sessionId}` });
  }

  /** Handle unknown channel command. */
  protected async handleUnknown(cmdText: string): Promise<void> {
    this.write({ type: 7, content: `Unknown command: ${cmdText}` });
  }

  // ── Control ─────────────────────────────────────────────────────────────

  /**
   * Cancel the current session's run loop.
   */
  cancel(): void {
    if (this.currentSessionId) {
      this.sessionManager.cancel(this.currentSessionId);
    }
  }

  /**
   * Interrupt the current session's processing.
   */
  interrupt(): void {
    if (this.currentSessionId) {
      this.sessionManager.interrupt(this.currentSessionId);
    }
  }

  /**
   * Close the channel — detach from all sessions and clean up.
   */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;

    // Detach from all sessions
    for (const sessionId of this.attachedSessions) {
      this.detach(sessionId);
    }

    this._cleanup();
  }

  // ── Abstract Protocol Methods ───────────────────────────────────────────

  /**
   * Format and deliver an event to the connection.
   * Must be implemented by subclasses.
   * @param event — Output event to deliver
   */
  protected abstract write(event: OutputEvent): void;

  /**
   * Read raw input from the connection.
   * Returns an async iterable of input strings.
   * Must be implemented by subclasses.
   */
  abstract read(): AsyncIterable<string>;

  /**
   * Wire session events to this channel.
   * Called when attaching to a session.
   * Must be implemented by subclasses.
   * @param sessionId — Session ID to subscribe to
   */
  protected abstract _subscribe(sessionId: string): void;

  /**
   * Remove the wire from a session.
   * Called when detaching from a session.
   * Must be implemented by subclasses.
   * @param sessionId — Session ID to unsubscribe from
   */
  protected abstract _unsubscribe(sessionId: string): void;

  /**
   * Release connection resources on close.
   * Must be implemented by subclasses.
   */
  protected abstract _cleanup(): void;
}
