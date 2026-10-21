import pkg from "@package.json" with { type: "json" };
import readline from "node:readline";
import { spawn } from "node:child_process";
import { CliOutputSink } from "@utils/cli/cli.ts";
import { resolveQuestionAnswer } from "@utils/question-answer.ts";
import { spoofSafe } from "@utils/spoof.ts";
import { parseCommand, Command, ACTIONS } from "@core/commands.ts";
import { parseForkArg } from "@core/command-handlers.ts";
import { HOOKS } from "@core/hooks.ts";
import type { QuestionDef } from "@core/context/input.ts";
import type { LlmClient } from "@core/llm-client/client.ts";
import { buildTaskConfigOptions, SessionManager, type AgentLike } from "@core/session/index.ts";
import { Agent } from "@core/agent.ts";
import { Message } from "@core/context/message.ts";
import { formatToolResult } from "@core/extensions/tool-utils.ts";
import { createAgentFactory } from "@core/agent-factory.ts";
import { restoreSessionIntoAgent, type PendingQuestion } from "@core/session/session-log.ts";
import { getSessionRow } from "@core/session/session-index.ts";
import { CoreContext, ExtensionInstance } from "@core/extensions/types.ts";
import { ExtensionError, formatError } from "@core/error.ts";
import type { CliArgv } from "@core/config/index.ts";
import { registerTaskManagerService } from "../subagents/index.ts";
import { CliChannel } from "./cli-channel.ts";
import { ClipboardPasteInterceptor } from "./clipboard-paste.ts";
import { DictationInterceptor, DictationCore, type CaptureFactory } from "./dictation.ts";
import { EditorPasteMarkers } from "./paste-markers.ts";
import { mountSplitRenderer, type OutputBridge } from "./split-bridge.ts";
import { StdinKeySource, type KeySource } from "@utils/cli/renderer/index.ts";
import { resolveSttTarget } from "@core/config/stt.ts";
import {
  parseCompletionContext,
  registerSlashCommandNameCompletion,
  registerCommandCompletions,
  registerShellCompletion,
  buildReadlineCompleter,
  buildEditorCompleter,
} from "./completions.ts";

export {
  parseCompletionContext,
  registerSlashCommandNameCompletion,
  registerCommandCompletions,
  registerShellCompletion,
  buildReadlineCompleter,
};

const HELP_TEXT = `
Commands:
  /quit, /exit  - Exit
  /help         - Show help
  /clear        - Clear context
  /undo         - Undo the last turn
  /rewind [N]   - Rewind the last N turns (default 1)
  /fork [N] [prompt] - Branch a new session from N turns back; optionally send prompt there
  /loop <prompt> - Repeatedly run prompt until cancelled
  /model <name> - Switch model
  /models       - List available models
  /tokens       - Show token usage
  /tools        - Toggle tool call display
  /compact [n] [--compact-debug]  - Compact context
  /compact <strategy>             - Switch compaction strategy
  /compact:<strategy>             - Switch compaction strategy
  /prompt:name [args] - Execute saved prompt
  /skill        - List skills
  /skill:<name> - Activate skill
  /thinking     - Toggle thinking display
  /theme <name> - Set theme (dark, light, monochrome)
  /regenerate   - Regenerate system prompt
  /reasoning none|minimal|low|high|xhigh|max|unset - Set reasoning effort level

Keys:
  Ctrl+X        - Start/stop voice dictation (needs an audio-capable model);
                  the transcript is inserted at the cursor, never auto-sent.
`;

// In shellMode, first words that look like common conversational openers are
// never treated as commands to execute.
const IGNORED_CMDS = new Set([
  "alert",
  "as",
  "clear",
  "continue",
  "do",
  "done",
  "else",
  "enable",
  "eval",
  "export",
  "false",
  "for",
  "help",
  "hotdog",
  "if",
  "in",
  "let",
  "local",
  "login",
  "logout",
  "man",
  "test",
  "then",
  "true",
  "wait",
  "yes",
]);
const MIN_CMD_LEN = 2;

interface ShellCommandResult {
  content?: string;
  error?: string;
  exitCode?: number;
}

interface InteractiveSessionOptions {
  createReadline?: (opts: Record<string, unknown>) => readline.Interface;
  onClose?: () => void;
  onSIGINT?: () => void;
  setupInput?: () => void;
  /**
   * Stage-3b test seams (§11: constructor-injected objects, never
   * mock.module): inject a mounted bridge built on the Grid/FakeClock rig
   * instead of mountSplitRenderer, and hand the editor input a scripted
   * KeySource instead of process.stdin. Omitted on the legacy path, so
   * existing tests drive the byte-identical readline flow.
   */
  bridge?: OutputBridge | null;
  keySource?: KeySource;
  /**
   * Test seam for the editor-path dictation: inject the fake audio capture
   * and fake transcription so a rigged ctrl-x drives the real toggle state
   * machine without arecord or an STT endpoint.
   */
  dictation?: { capture?: CaptureFactory; transcribe?: (audio: Uint8Array) => Promise<string> };
}

export async function isSystemCommand(cmd: string): Promise<boolean> {
  if (cmdLookupCache.has(cmd)) {
    return cmdLookupCache.get(cmd)!;
  }
  return new Promise((resolve) => {
    const proc = spawn("which", [cmd], { stdio: ["pipe", "pipe", "pipe"] });
    proc.on("close", (code: number) => {
      cmdLookupCache.set(cmd, code === 0);
      resolve(code === 0);
    });
    proc.on("error", () => {
      cmdLookupCache.set(cmd, false);
      resolve(false);
    });
  });
}
const cmdLookupCache = new Map<string, boolean>();

// Deterministic aliases applied before execution (no user bashrc sourcing).
const COMMAND_REPLACEMENTS: [string, (cmd: string) => string][] = [
  [
    "ls",
    (cmd) => {
      if (!cmd.includes("--color")) {
        return cmd.replace(/^ls(\b|$)/, "ls --color=always$1");
      }
      return cmd;
    },
  ],
];

// "cmd |@" pipes the output to the assistant; an optional note follows after a space.
export const SEND_TO_ASSISTANT_SUFFIX_RE = /\|\s*@(?:\s+(.*))?$/;

export function applyCommandReplacements(command: string): string {
  let result = command;
  for (const [pattern, transform] of COMMAND_REPLACEMENTS) {
    if (
      result.startsWith(pattern) &&
      (result[pattern.length] === " " || result[pattern.length] === "\t" || result.length === pattern.length)
    ) {
      result = transform(result);
    }
  }
  return result;
}

// Runs via bash; with captureOutput, output is still streamed but also collected.
export async function executeShellCommand(
  command: string,
  options: { captureOutput?: boolean } = {},
): Promise<ShellCommandResult> {
  const { captureOutput = false } = options;
  const finalCommand = applyCommandReplacements(command);

  return new Promise((resolve) => {
    const proc = spawn("bash", ["-c", finalCommand], {
      env: process.env,
      stdio: captureOutput ? ["inherit", "pipe", "pipe"] : "inherit",
    });

    if (!captureOutput) {
      proc.on("close", (exitCode: number) => {
        resolve({ content: "", exitCode: exitCode ?? 0 });
      });
      proc.on("error", (err: Error) => {
        resolve({ error: `Error: ${err.message}` });
      });
      return;
    }

    let captured = "";

    proc.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text);
      captured += text;
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stderr.write(text);
      captured += text;
    });

    proc.on("close", (exitCode: number) => {
      resolve({ content: captured, exitCode: exitCode ?? 0 });
    });

    proc.on("error", (err: Error) => {
      resolve({ error: `Error: ${err.message}` });
    });
  });
}

interface InputInterface {
  isInteractive(): boolean;
  /** `signal` is the run's abort */
  collectAnswers(questions: QuestionDef[], signal?: AbortSignal | null): Promise<Record<string, string>>;
}

/**
 * One cancellable wait for the next submitted line. cancel() exists for the
 * abort path: a line typed after the caller gave up must flow back to the
 * normal handler, never into a dead question loop.
 */
interface LineWait {
  line: Promise<string>;
  cancel(): void;
}

/**
 * The question/approval prompt loop shared by the readline takeover
 * (AsyncInteractiveCliInput) and the stage-3b editor focus (EditorCliInput).
 * It only knows how to print the model-supplied menu and judge answers;
 * where lines come from is the caller's waitLine(). Abort semantics are the
 * rule: the run's abort signal wins the race, ALREADY-GATHERED answers
 * resolve (never reject -- the caller drops the partials) and the pending
 * wait is cancelled, so the input is released the moment the prompt is.
 */
async function runQuestions(
  questions: QuestionDef[],
  signal: AbortSignal | null | undefined,
  normalize: (line: string) => string,
  waitLine: () => LineWait,
): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};
  let onAbort: (() => void) | null = null;
  try {
    if (signal?.aborted) return answers;

    const aborted = signal
      ? new Promise<"aborted">((resolve) => {
          onAbort = () => resolve("aborted");
          signal.addEventListener("abort", onAbort, { once: true });
        })
      : null;

    for (const q of questions) {
      const key = q.key;
      const promptText = q.prompt || "";
      const options = q.options || [];
      const defaultValue = q.default ?? "";

      // prompt, options and default are model-supplied. spoofSafe is idempotent, so double neutralization upstream is harmless.
      process.stdout.write(`\n  ? ${spoofSafe(promptText)}\n`);

      if (options.length > 0) {
        for (let i = 0; i < options.length; i++) {
          process.stdout.write(`    [${i + 1}] ${spoofSafe(options[i] ?? "")}\n`);
        }
      }

      if (defaultValue !== "") {
        process.stdout.write(`    (default: ${spoofSafe(defaultValue)})\n`);
      }

      // Fix-3 echo ruling (question-echo.md): in split mode the committed
      // answer row carries this question's text as its prefix, so hand the
      // bridge the same spoof-safe question line printed above. The live
      // prompt is the editor frame, so the bare answer-prompt row (`" "` or
      // `" [default] "`) is legacy-only: split's echo is self-describing and
      // the default is already shown in its own row above. Legacy never has
      // a bridge mounted, so uiBridge doubles as the mode gate.
      const splitEcho = uiBridge !== null;
      uiBridge?.setQuestionLabel(`  ? ${spoofSafe(promptText)}`);

      let answer = "";
      let valid = false;

      while (!valid) {
        if (!splitEcho) {
          const prompt = defaultValue !== "" ? ` [${defaultValue}] ` : " ";
          process.stdout.write(prompt);
          uiFlush();
        }
        const wait = waitLine();

        // Race the line against the run abort: a cancelled run must stop
        // prompting and release the input, not keep owning it. We RESOLVE
        // (partial answers, dropped by the caller) rather than reject, so
        // the never-awaited promise can never go unhandled.
        let line: string;
        if (aborted) {
          const outcome = await Promise.race([wait.line, aborted]);
          if (outcome === "aborted") {
            wait.cancel();
            return answers;
          }
          line = outcome;
        } else {
          line = await wait.line;
        }

        const trimmed = normalize(line).trim();

        // The CLI renders options as a numbered menu, so index ("2") and
        // exact option-text input become a selection; anything else stays
        // free text for the shared resolver to judge.
        let text = trimmed;
        let selectedOption: string | null = null;
        if (trimmed !== "" && options.length > 0) {
          const idx = parseInt(trimmed, 10);
          if (!isNaN(idx) && idx >= 1 && idx <= options.length) {
            selectedOption = options[idx - 1] ?? "";
            text = "";
          } else if (options.includes(trimmed)) {
            selectedOption = trimmed;
            text = "";
          }
        }

        const resolvedAnswer = resolveQuestionAnswer(q, { text, selectedOption });
        if (resolvedAnswer.error) {
          process.stderr.write(`  ${spoofSafe(resolvedAnswer.error)}\n`);
          continue;
        }

        answer = resolvedAnswer.value;
        valid = true;
      }

      answers[key] = answer;
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }

  return answers;
}

export class AsyncInteractiveCliInput implements InputInterface {
  readonly #rl: readline.Interface;
  readonly #onLine: (line: string) => void;
  readonly #addLineHandler: (handler: (line: string) => void) => void;
  readonly #normalize: (line: string) => string;

  constructor(
    rl: readline.Interface,
    onLine: (line: string) => void,
    addLineHandler: (handler: (line: string) => void) => void,
    normalize: (line: string) => string = (line) => line,
  ) {
    this.#rl = rl;
    this.#onLine = onLine;
    this.#addLineHandler = addLineHandler;
    this.#normalize = normalize;
  }

  isInteractive(): boolean {
    return true;
  }

  async collectAnswers(questions: QuestionDef[], signal?: AbortSignal | null): Promise<Record<string, string>> {
    const rl = this.#rl;

    // Take over readline for the duration of the prompt.
    rl.removeListener("line", this.#onLine);

    // Our pending one-shot "line" listener, the cancellable stand-in for rl.question:
    // readline's question callback cannot be removed once pending, so a line typed after cancel would be fed into a dead loop.
    // A plain listener we own can be detached when the wait loses the race.
    let pendingLine: ((line: string) => void) | null = null;
    // Split mode: the takeover prints via owned channels (never raw
    // stdout); the bridge question-mode flag switches the submit echo to the
    // fix-3 answer shape (question prefix, blanks as "(no answer)") and
    // suppresses the completion popup.
    uiBridge?.setQuestionMode(true);
    try {
      return await runQuestions(questions, signal, this.#normalize, () => ({
        line: new Promise<string>((resolve) => {
          const onLine = (line: string) => {
            pendingLine = null;
            rl.removeListener("line", onLine);
            resolve(line ?? "");
          };
          pendingLine = onLine;
          rl.on("line", onLine);
        }),
        cancel: () => {
          if (pendingLine) {
            rl.removeListener("line", pendingLine);
            pendingLine = null;
          }
        },
      }));
    } finally {
      if (pendingLine) rl.removeListener("line", pendingLine);
      uiBridge?.setQuestionMode(false);
      this.#addLineHandler(this.#onLine);
    }
  }
}

/**
 * Question input for the stage-3b EDITOR path. There is no listener takeover
 * to perform: the bridge routes a submitted editor line to the open
 * question's wait instead of the normal handler, which is exactly the §8
 * exclusive question focus (Esc still interrupts, the answer buffer is the
 * editor buffer).
 */
export class EditorCliInput implements InputInterface {
  readonly #bridge: OutputBridge;
  readonly #normalize: (line: string) => string;

  constructor(bridge: OutputBridge, normalize: (line: string) => string = (line) => line) {
    this.#bridge = bridge;
    this.#normalize = normalize;
  }

  isInteractive(): boolean {
    return true;
  }

  async collectAnswers(questions: QuestionDef[], signal?: AbortSignal | null): Promise<Record<string, string>> {
    this.#bridge.setQuestionMode(true);
    // The bridge routes submitted lines to the OPEN wait, so at most one is
    // live per collectAnswers run and the finally drops it if the abort won.
    const activeWaits: LineWait[] = [];
    try {
      return await runQuestions(questions, signal, this.#normalize, () => {
        const wait = this.#bridge.waitForLine();
        activeWaits.push(wait);
        return wait;
      });
    } finally {
      for (const wait of activeWaits) wait.cancel();
      this.#bridge.setQuestionMode(false);
    }
  }
}

// Shared with the question tool via AGENT_TOOL_CONTEXT.
let currentInput: InputInterface | null = null;

/**
 * Printer for permanent console.log output sites (design note §2: these rows
 * commit in split mode). Default is plain console.log -- legacy mode keeps
 * today's exact bytes and stays visible to test spies. runInteractiveSession
 * rebinds it to the sink's log channel each session (which itself only
 * diverges from console.log once the split bridge installs its router).
 */
function defaultUiOut(message: string): void {
  console.log(message);
}

/** Commit pending partial rows before blocking on user input (split mode; no-op in legacy). */
function defaultUiFlush(): void {}

/** Session-scoped printer slots: rebound by runInteractiveSession at session start, released back to the defaults by resetUiSlotsForTesting. */
let uiOut: (message: string) => void = defaultUiOut;
let uiFlush: () => void = defaultUiFlush;

/** The live split bridge when the renderer is mounted; module slot like currentInput (one session per process). */
let uiBridge: OutputBridge | null = null;

/**
 * Release the session-scoped uiOut/uiFlush/uiBridge module slots back to
 * their console defaults. Production doctrine is one session per process, so
 * the rebinding normally dies with the process and this function has no role
 * there. It exists for shared test processes: plain sequential `bun test`
 * (and the coverage script, which lacks --parallel) runs every file in one
 * process, so a split-mode session that ran in an earlier file would keep
 * uiOut pointed at its dead rig sink and later files' console spies would
 * capture nothing. The split rig suite releases the slots in its afterAll;
 * any new file that mounts a bridge session must do the same.
 */
export function resetUiSlotsForTesting(): void {
  uiOut = defaultUiOut;
  uiFlush = defaultUiFlush;
  uiBridge = null;
}

/**
 * Unanswered questions reconstructed by a resume (buildInteractiveAgent),
 * consumed once by the session loop after its input interface exists.
 * Interactive hotdog is one session per process, so a module slot is enough.
 */
let resumePendingQuestions: PendingQuestion[] = [];

/**
 * Build the shared shutdown handler. Idempotent, every exit path invokes it, and the notice must print exactly once.
 */
export function buildOnQuitHandler(
  sessionManager: SessionManager,
  extensions: CoreContext["extensions"],
): () => void {
  let quitStarted = false;
  return () => {
    if (quitStarted) return;
    quitStarted = true;
    uiOut("\nGoodbye!");
    const interactiveSessionId = sessionManager.sessionId();
    if (interactiveSessionId) {
      uiOut(`Session: ${interactiveSessionId} (resume with: hotdog --session-id ${interactiveSessionId})`);
    }
    // Stop the provider-health sweep timer: unref'd so it never blocks exit,
    // but a discarded manager must not keep probing providers.
    sessionManager.getTaskManager()?.stop();
    extensions.cleanup();
    process.exit(0);
  };
}

export async function buildInteractiveAgent(
  agentConfig: Record<string, unknown>,
  core: CoreContext,
  resolved: Record<string, unknown>,
  config: Record<string, unknown>,
  llmClient: LlmClient,
  cli: Record<string, unknown>,
): Promise<Agent> {
  const factory = createAgentFactory(core, { resolved, config, llmClient });
  const agent = await factory(agentConfig);

  const explicitSessionId = cli.sessionId as string | undefined;
  const { replayed, pendingQuestions, profile } = await restoreSessionIntoAgent(agent, explicitSessionId);
  if (replayed > 0) {
    uiOut(`Session restored: ${replayed} messages replayed from ${explicitSessionId}`);
  }
  resumePendingQuestions = pendingQuestions;

  // Restore the profile the session ended on so the resumed agent runs with
  // the same tools / model / body it had before the crash.
  if (profile && core.resolved?.profileManager) {
    const profiles = core.resolved.profileManager.getProfilesForSwitch();
    const p = profiles[profile];
    if (p) agent.applyProfile(profile, p);
  }

  // Model precedence on resume: explicit -m > the model the index attests from the log (what the session actually ran on; wins over a profile-implied model from applyProfile above) > profile/boot default.
  if (explicitSessionId && agent.sessionId === explicitSessionId) {
    const cliModel = typeof cli.model === "string" && cli.model ? cli.model : null;
    const attestedModel = getSessionRow(explicitSessionId)?.model ?? null;
    if (!cliModel && attestedModel) {
      agent.model = attestedModel;
    } else if (!cliModel && !attestedModel) {
      uiOut(
        `Resuming ${explicitSessionId} with no model attested in its log (legacy log or an index rebuilt from one): ` +
          `continuing on the default model (${agent.model}). Pass -m <model> if that is wrong.`,
      );
    }
  }

  return agent;
}

/**
 * Re-present questions a killed session never answered: ask each through the
 * live input, write the answer as the held call's tool result (the executor's
 * part shape), then queue a continuation turn through the bus -- never a
 * direct agent call racing a typed prompt. No input seam (tests, piped
 * stdin): resolve honestly as unanswered rather than hang. If the
 * re-presentation is itself interrupted, sweep every still-held call closed
 * with an honest error result: context must never end on unanswered
 * tool_calls (guaranteed 400 on strict backends).
 */
export async function resumeUnansweredQuestions(
  agent: AgentLike,
  pending: PendingQuestion[],
  input: InputInterface | null,
  continueTurn: () => void,
): Promise<void> {
  uiOut(
    `Resuming: ${pending.length} unanswered question${pending.length > 1 ? "s" : ""} from before the interruption.`,
  );
  const held = pending.slice();
  const writeToolResult = (toolCallId: string, content: string, success: boolean): void => {
    agent.addMessage(
      new Message({
        role: "tool",
        content: [formatToolResult(content, "question", success)],
        toolCallId,
        source: "tool",
      }),
    );
  };
  while (held.length > 0) {
    const q = held[0]!;
    let content: string;
    let success = true;
    if (input) {
      try {
        const answers = await input.collectAnswers(q.questions as QuestionDef[], null);
        content = JSON.stringify(answers, null, 2);
      } catch (e: unknown) {
        // Sweep this and every remaining held call closed, then rethrow:
        // the prompt returns on a wire-valid context.
        const why = formatError(e);
        for (const h of held.splice(0)) {
          writeToolResult(
            h.toolCallId,
            `Question unanswered: the resume was interrupted (${why}); the question was not answered.`,
            false,
          );
        }
        throw e;
      }
    } else {
      // No human reachable: honest unanswered, same wording class as one-shot.
      content = "User is not connected (no interactive input); this question was not answered.";
      success = false;
    }
    writeToolResult(q.toolCallId, content, success);
    held.shift();
  }
  continueTurn();
}

export async function runInteractiveSession(
  cli: Record<string, unknown>,
  core: CoreContext,
  options: InteractiveSessionOptions = {},
): Promise<void> {
  const { resolved, config } = core;

  if (!resolved) {
    throw ExtensionError.ConfigFailed("ui-interactive-cli", "configuration must be resolved first");
  }

  const palette = await CliOutputSink.resolve(
    cli.colors !== false,
    (resolved.theme as string) || "dark",
    (config.colors as Record<string, unknown>) || null,
  );

  const sink = new CliOutputSink({
    ...resolved,
    palette,
    thinkerFormat: resolved.thinkerFormat,
    toolCallDisplayFormat: resolved.toolCallDisplayFormat,
    toolOutputFmt: resolved.toolOutputFmt,
    hideUserMessage: true,
  });

  // Split-renderer kill switch (design note §9/§12): mounts iff the knob says
  // "split" AND both stdio streams are TTYs AND TERM is not the "dumb"
  // convention string (the exact comparison colors.ts makes). Non-TTY is
  // passthrough regardless of the knob; "legacy" (the default) never touches a
  // global.
  // options.bridge injects an already-mounted rig bridge for the split-mode
  // session tests (§11 constructor injection); omitting it keeps the real
  // mount decision untouched.
  const uiCli = (config.uiInteractiveCli as Record<string, unknown>) || {};
  const bridge =
    options.bridge !== undefined
      ? options.bridge
      : mountSplitRenderer({
          knob: uiCli.renderer,
          stdinIsTTY: process.stdin.isTTY,
          stdoutIsTTY: process.stdout.isTTY,
        });
  uiBridge = bridge;
  if (bridge) {
    sink.logRouter = (message: string) => bridge.commitText(message + "\n");
  }
  uiOut = (message: string) => sink.log(message);
  uiFlush = () => {
    bridge?.flushPending();
  };

  const llmClient = core.createLlmClient();

  const buildAgent = async (agentConfig: Record<string, unknown>): Promise<AgentLike> => {
    return buildInteractiveAgent(agentConfig, core, resolved, config, llmClient, cli);
  };

  // Wire up completion handlers BEFORE the session (and its agent) is created:
  // the initial agent fires COMMANDS_REGISTER during SessionManager.create, so a
  // listener registered afterwards would miss it and command-argument completions
  // (e.g. /reasoning <levels>) would never be registered.
  registerSlashCommandNameCompletion(core.completion);
  core.hooks.on(
    HOOKS.COMMANDS_REGISTER,
    ({ registry }) => {
      registerCommandCompletions(core.completion, registry, "ui-interactive-cli");
    },
    "ui-interactive-cli",
  );

  const sessionManager = await SessionManager.create({
    hooks: core.hooks,
    extensions: core.extensions,
    buildAgent,
    initialConfig: cli,
    llmClient,
    modelRegistry: resolved.modelRegistry,
    coreConfig: config,
    taskConfig: buildTaskConfigOptions(resolved),
    profileManager: resolved.profileManager,
  });

  // Publish the TaskManager for lazy lookup by subagent tools; extensions
  // (and their tools) were loaded before this session existed.
  registerTaskManagerService(core, sessionManager.getTaskManager());

  const agent = sessionManager.getAgent();
  sink.log(`hotdog ${pkg.version} (interactive mode)`);
  sink.log(`Model: ${resolved.model}`);
  sink.log(`Profile: ${resolved.profileName}`);
  sink.log(`Session: ${agent?.sessionId || "unknown"}`);
  sink.log("Type /quit or /exit to exit.\n");

  const shellMode = uiCli.shellMode;

  // Stage-3b swap: when a bridge is mounted the session runs ENTIRELY on the
  // editor input path. node:readline is never constructed there and neither
  // the rl-shaped paste nor dictation interceptor exists; their semantics
  // re-hang off the editor's events (paste markers on the view's paste hook,
  // ctrl-x on unhandled keys, questions on the bridge's line focus). The
  // legacy branch keeps its pre-swap construction shape exactly.
  let rl: readline.Interface | null = null;
  let normalizeLine: (line: string) => string = (line) => line;
  let resetPasteState: () => void = () => {};
  let cancelDictation: () => void = () => {};
  let toggleDictation: () => void = () => {};
  let editorPasteHandler: ((raw: string) => void) | null = null;

  const sttTarget = resolveSttTarget(resolved, llmClient);

  const onQuit = buildOnQuitHandler(sessionManager, core.extensions);
  // Teardown pairs with every exit path (§10): restore the terminal first so
  // the goodbye rows land on a plain screen via passthrough stdout. An
  // in-flight dictation recording exits with the session too.
  const exitSession = bridge
    ? (): void => {
        cancelDictation();
        bridge.shutdown();
        onQuit();
      }
    : onQuit;

  if (bridge) {
    // The prompt text is echoed into committed rows on submit, so the bridge
    // tracks it (the same string the readline prompt used to carry).
    bridge.setPrompt(`(${resolved.model})> `);

    // Bracketed-paste payloads on the editor path: multi-line (or long)
    // pastes collapse into an inline `[Paste #N - M lines]` marker in the
    // buffer with the real content restored by normalize() at submit; short
    // single-line pastes insert as-is. config record is untyped; the
    // constructor validates and fails loud on a missing or invalid value.
    const pasteMarkers = new EditorPasteMarkers({
      pasteMarkerMinChars: uiCli.pasteMarkerMinChars as number,
      insert: (text) => bridge.editor?.insertText(text),
    });
    normalizeLine = (line) => pasteMarkers.normalize(line);
    resetPasteState = () => pasteMarkers.onInterrupt();
    editorPasteHandler = (raw) => pasteMarkers.handlePaste(raw);

    // Ctrl+X dictation on the editor path: it binds from the editor's
    // unhandled-key event (stage 3a deliberately left ctrl-x unhandled) and
    // the transcript lands at the cursor via the view -- never auto-sent.
    if (sttTarget) {
      const dictationCore = new DictationCore({
        target: sttTarget,
        capture: options.dictation?.capture,
        transcribe: options.dictation?.transcribe,
        hooks: {
          recording: () => sink.log("● Recording… press Ctrl+X to stop"),
          transcribing: () => sink.log("Transcribing…"),
          transcript: (text) => bridge.editor?.insertText(text),
          failed: (err) => sink.log(`Dictation failed: ${formatError(err)}`),
        },
      });
      toggleDictation = () => dictationCore.toggle();
      cancelDictation = () => dictationCore.cancel();
    }
  } else {
    const createReadline = options.createReadline || readline.createInterface;

    rl = createReadline({
      input: process.stdin,
      output: process.stdout,
      prompt: `(${resolved.model})> `,
      completer: buildReadlineCompleter(sessionManager, core),
    });

    // Intercept bracketed paste before readline: pasted payloads become inline
    // `[Paste #N - M lines]` markers (real content restored in `lineHandler`),
    // except short single-line pastes which are inserted as-is.
    const paste = new ClipboardPasteInterceptor(rl, {
      pasteMarkerMinChars: uiCli.pasteMarkerMinChars as number,
    });

    // Ctrl+X dictation: sits in front of the paste chain, swallows only the
    // Ctrl+X byte. Disables itself when no STT target resolved (no sttUrl and
    // no audio-capable registry model) or input is not a TTY.
    const dictation = new DictationInterceptor(rl, { target: sttTarget });

    normalizeLine = (line) => paste.normalize(line);
    resetPasteState = () => paste.onInterrupt();
    cancelDictation = () => dictation.cancel();
  }

  const channel = new CliChannel({
    sessionManager,
    sessionId: sessionManager.sessionId()!,
    sink,
    rl,
    onQuit: exitSession,
  });

  // Define the line handler
  let lineHandler: (line: string) => Promise<void>;

  const addLineHandler = (handler: (line: string) => void) => {
    rl?.on("line", handler);
  };

  // The prompt surface handleSlashCommand drives: readline on the legacy
  // path; on the editor path there is nothing to repaint (the frame keeps the
  // live editor row on screen) and close() performs the bridge teardown that
  // readline's "close" event used to trigger on /quit.
  const uiHost: PromptUi = bridge
    ? { prompt: () => {}, close: () => bridge.shutdown() }
    : (rl as readline.Interface);

  // Listen for model changes and update the prompt: the mounted editor's
  // frame is the prompt painter when the bridge is up, readline's echo when
  // it is not.
  core.hooks.on(HOOKS.MODEL_CHANGE, ({ newModel }) => {
    if (bridge) bridge.setPrompt(`(${newModel})> `);
    else (rl as readline.Interface).setPrompt(`(${newModel})> `);
  });

  // Re-display prompt after agent finishes
  core.hooks.on(HOOKS.TURN_END, ({ stopped }) => {
    if (stopped) {
      setImmediate(() => {
        sink.log("");
        // The editor path has no readline to re-prompt: its frame is
        // persistently on screen.
        if (!bridge) (rl as readline.Interface).prompt();
      });
    }
  });

  registerShellCompletion(core.completion, !!shellMode);

  async function handleShellMode(trimmed: string) {
    const match = trimmed.match(SEND_TO_ASSISTANT_SUFFIX_RE);
    const sendToAssistant = !!match;
    const note = sendToAssistant ? (match[1] || "").trim() : "";
    const cmd = sendToAssistant ? trimmed.replace(SEND_TO_ASSISTANT_SUFFIX_RE, "").trim() : trimmed;

    const firstWord = cmd.split(/\s+/)[0];

    if (!firstWord || firstWord.length < MIN_CMD_LEN || IGNORED_CMDS.has(firstWord) || !(await isSystemCommand(firstWord))) {
      return false;
    }
    
    // The child handoff (§5): rl.pause() is the legacy half of the bracket
    // and a no-op on the editor path, which has no readline; while the
    // renderer is mounted the real work is bridge.suspend() -- stdin.pause is
    // neutered there (pitfall 6), so releasing the input listeners is what
    // stops hotdog racing a stdio-inherit child for tty bytes (arrow escapes
    // arrive shredded otherwise). The paired restore repaints and re-attaches
    // on child close; settled shell output lands before the rows printed
    // below.
    rl?.pause();
    const resumeChildTerminal = bridge?.suspend(process.stdin);
    const result = await executeShellCommand(cmd, {
      captureOutput: sendToAssistant,
    });
    resumeChildTerminal?.();
    rl?.resume();
    uiFlush();

    if (sendToAssistant) {
      const notePart = note ? `Note: ${note}\n\n` : "";
      const msg = `I ran: ${cmd}\n\n${notePart}Output:\n${result.content || "(no output)"}`;
      await channel.send(msg);
    } else {
      if (result.content) {
        sink.log(result.content);
      } else if (result.error) {
        sink.log(`${result.error}`);
      }
      if (result.exitCode != 0) {
        sink.log(`[exec: exit code ${result.exitCode}]`);
      }
    }
    rl?.prompt();
    return true;
  };

  lineHandler = async (line: string) => {
    const trimmed = normalizeLine(line).trim();

    if (!trimmed) {
      rl?.prompt();
      return;
    }

    if (trimmed.startsWith("/")) {
      const cmdText = trimmed.slice(1).trim();
      handleSlashCommand(cmdText, sessionManager, channel, uiHost, exitSession);
      return;
    }

    if (shellMode) {
      const handled = await handleShellMode(trimmed);
      if (handled) return;
    }

    await channel.send(trimmed);
  };

  // Create the input interface for question tool
  const setupInput =
    options.setupInput ||
    (bridge
      ? () => {
          currentInput = new EditorCliInput(bridge, normalizeLine);
        }
      : () => {
          currentInput = new AsyncInteractiveCliInput(
            rl as readline.Interface,
            lineHandler,
            addLineHandler,
            normalizeLine,
          );
        });
  setupInput();

  const handleSigint =
    options.onSIGINT ||
    (() => {
      channel.interrupt();
      // Drop any in-flight dictation recording with the interrupted turn.
      cancelDictation();
      // Blank readline's line buffer. The editor path has no buffer to blank
      // (the view stashed the draft itself before firing the interrupt event,
      // and the bridge already pinned the echoed rows -- flushing the echo
      // again here would commit them twice).
      if (rl) {
        (rl as { line: string; cursor: number }).line = "";
        (rl as { line: string; cursor: number }).cursor = 0;
      }
      resetPasteState();
      sink.log("\nInterrupted (/quit, /exit, or ctrl-d to exit)");
      rl?.prompt();
    });

  if (bridge) {
    // Editor input mount (stage 3b): submit/interrupt/quit replace readline's
    // line/SIGINT/close listeners, popup answers Tab synchronously, and
    // unhandled keys carry the ctrl-x dictation toggle. The KeySource attaches
    // HERE, after bridge.mount() established raw mode + bracketed paste (§5;
    // mount() is idempotent), and stopping input only ever means detaching
    // listeners -- the shared stream is never paused (pitfall 6).
    bridge.mount();
    const editorCompleter = buildEditorCompleter(sessionManager, core, () => bridge.editor, !!shellMode);
    bridge.mountEditorInput(options.keySource ?? new StdinKeySource(process.stdin), {
      submit: (line) => {
        // Fire-and-forget like the readline "line" wiring, with the
        // rejection reported instead of left dangling.
        void lineHandler(line).catch((e: unknown) => {
          sink.log(formatError(e));
        });
      },
      interrupt: handleSigint,
      quit: options.onClose || exitSession,
      popup: (word, from) => {
        // The completion popup is suppressed while a question owns the
        // input (§8: numbers + free text need no interference).
        if (bridge.questionMode) return undefined;
        return editorCompleter(word, from);
      },
      unhandled: (key) => {
        if (key === "ctrl-x") toggleDictation();
      },
    });
    if (bridge.editor && editorPasteHandler) {
      // Raw paste payloads route to the marker controller instead of the
      // view's default as-is insertion.
      bridge.editor.pasteHandler = editorPasteHandler;
    }
  } else {
    const legacyRl = rl as readline.Interface;
    legacyRl.on("line", lineHandler);
    legacyRl.on("SIGINT", handleSigint);
    // Ctrl+D (EOF) closes readline: shut down through the shared handler so the session id still prints.
    // options.onClose overrides (tests).
    legacyRl.on("close", options.onClose || exitSession);
  }

  // Mid-question resume: re-present the restored log's unanswered questions
  // before the first prompt; the TURN_END hook re-prompts when done.
  if (agent && resumePendingQuestions.length > 0) {
    const pending = resumePendingQuestions;
    resumePendingQuestions = [];
    void resumeUnansweredQuestions(agent, pending, currentInput, () => {
      // Through the bus like every other turn: lane bookkeeping applies and
      // a mid-continuation prompt queues instead of racing.
      sessionManager.getBus(agent.sessionId)?.enqueue("", { continuation: true });
    }).catch((e: unknown) => {
      sink.log(formatError(e));
      rl?.prompt();
    });
  } else {
    // First prompt on the legacy path; the editor path's mounted input is
    // already painting the prompt row inside the frame.
    rl?.prompt();
  }

  // Keep the process alive until the bus ends. SessionManager.create already
  // started the run loop; bus.run() is join-idempotent, so this JOINS that
  // loop (it used to start a second consumer on the same queue — the
  // duplicate-delivery bug; see MessageBus.#ensureLoop).
  const bus = sessionManager.getBus(sessionManager.sessionId()!);
  if (bus) {
    await bus.run();
  }
}

/**
 * The slice handleSlashCommand needs to redraw the prompt after a command
 * finishes (and to tear the input down on /quit): readline satisfies it on
 * the legacy path, the editor path passes a no-op host whose close() runs
 * the bridge teardown.
 */
export interface PromptUi {
  prompt(): unknown;
  close(): unknown;
}

export function handleSlashCommand(
  cmdText: string,
  sessionManager: SessionManager,
  channel: CliChannel,
  ui: PromptUi,
  onQuit: () => void,
): void {
  const cmd = parseCommand(cmdText);

  // UI-only commands handled directly by the UI layer
  switch (cmd.type) {
    case Command.Help:
      uiOut(HELP_TEXT);
      ui.prompt();
      return;

    case Command.Quit:
      ui.close();
      onQuit();
      return;
  }

  sessionManager.executeCommand(sessionManager.sessionId()!, cmdText).then(
    (action: number | undefined) => {
      if (cmd.type === Command.Fork) {
        // Successful fork only (a running-session rejection or failure returns ERROR and
        // current still points at the source). The manager switched to the fork; retarget
        // this channel's input and event subscription onto it -- THEN enqueue the optional
        // prompt, so no fork output fires before anyone is listening.
        // The source session stays attached, reachable via /switch back.
        const forkedSessionId = sessionManager.sessionId();
        if (forkedSessionId && action !== undefined && !(action & ACTIONS.ERROR)) {
          channel.attach(forkedSessionId);
          channel.switchSession(forkedSessionId);
          const { prompt } = parseForkArg(cmd.value ?? "");
          if (prompt) {
            sessionManager.enqueue(forkedSessionId, prompt);
          }
        }
      }
      if (!action || !(action & ACTIONS.PROMPT)) {
        uiOut("");
        ui.prompt();
      }
    },
    () => {
      uiOut("");
      ui.prompt();
    },
  );
}

/** Create the interactive-cli extension. */
export function create(_core: CoreContext): ExtensionInstance {
  return {
    hooks: {
      [HOOKS.CLI_SUBCOMMANDS_REGISTER]: async (registry) => {
        registry.register("cli", {
          description: "Interactive CLI session",
          handler: async (cli: CliArgv, core: CoreContext) => {
            await runInteractiveSession(cli, core);
            return 0;
          },
        });
      },

      [HOOKS.AGENT_TOOL_CONTEXT]: (payload) => {
        const toolCtx = payload.toolCtx;
        if (currentInput) {
          toolCtx.set("input", currentInput);
        }
      },
    },

    cleanup: async () => {
      currentInput = null;
    },
  };
}
