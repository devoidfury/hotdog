// Redactor extension: a RESULT-side gate. When a tool result matches a
// secret-shaped pattern, ask the human -- "send to the model, or redact?" --
// before the result reaches the provider, the session log, or the transcript.
// Imports ONLY "@read-receipt/hotdog/sdk".
// From defaults.json: { "extensionPaths": ["@extensions", "examples/extension-redactor"] }
//
// Threat model (see README): exfiltration control, NOT a sandbox. By the time
// tool:result fires the tool has already run; what is mediated here is whether
// the secret LEAVES. tool:afterExecute fires earlier and sees the raw value.
//
// Fail-closed: every non-allow answer (including a missing/non-interactive
// seam, a throwing prompt, an abort, an empty answer, and a malformed pattern
// config) redacts or withholds. The handler never throws: a throwing handler
// in this pipeline would surface as a tool crash instead of a redaction.

import {
  formatError,
  getExtensionConfig,
  HOOKS,
  logger,
  spoofSafe,
  ToolResult,
} from "@read-receipt/hotdog/sdk";
import type {
  CoreContext,
  ExtensionInstance,
  HookPayloads,
  QuestionSeam,
} from "@read-receipt/hotdog/sdk";

const ANSWER_KEY = "verdict";
const OPTIONS = ["redact", "allow once", "allow for session"];
/** The match itself, echoed to the human, bounded so a hit can't bury the question it belongs to. */
const MAX_MATCH_ECHO = 40;

interface RedactorConfig {
  enabled: boolean;
  prompt: boolean;
  patterns: Record<string, string>;
}

type ResultPayload = HookPayloads["tool:result"];

/** A tool result whose text fields are redactable (ToolResult shape, duck-checked). */
interface TextCarrier {
  output: string;
  error: string | null;
  success: boolean;
  metadata: Map<string, string> | null;
  images: unknown[] | null;
  hint: string | null;
}

function isTextCarrier(r: unknown): r is TextCarrier {
  return (
    typeof r === "object" &&
    r !== null &&
    typeof (r as { output?: unknown }).output === "string" &&
    typeof (r as { success?: unknown }).success === "boolean" &&
    ((r as { error?: unknown }).error === null ||
      typeof (r as { error?: unknown }).error === "string")
  );
}

/** Compile every pattern, or name the first one that fails (a partial matcher cannot be trusted). */
function compilePatterns(
  patterns: Record<string, string>,
): [string, RegExp][] | { error: string } {
  const compiled: [string, RegExp][] = [];
  for (const [label, source] of Object.entries(patterns)) {
    if (typeof source !== "string") {
      return { error: `pattern "${label}" is not a string` };
    }
    try {
      compiled.push([label, new RegExp(source, "g")]);
    } catch (e) {
      return { error: `pattern "${label}" is not a valid regex (${formatError(e)})` };
    }
  }
  return compiled;
}

interface Match {
  label: string;
  /** First hit, display-truncated -- the human identifies the match by it, the label keys the grant. */
  sample: string;
}

function findMatches(text: string, compiled: [string, RegExp][]): Match[] {
  const matches: Match[] = [];
  for (const [label, re] of compiled) {
    const m = re.exec(text);
    if (m) {
      matches.push({
        label,
        sample: m[0].length > MAX_MATCH_ECHO ? `${m[0].slice(0, MAX_MATCH_ECHO)}…` : m[0],
      });
    }
  }
  return matches;
}

function scrub(text: string, compiled: [string, RegExp][]): string {
  let out = text;
  for (const [label, re] of compiled) {
    out = out.replace(new RegExp(re.source, "g"), `[redacted:${label}]`);
  }
  return out;
}

function withheld(notice: string): ToolResult {
  return ToolResult.ok(`[withheld] ${notice}`);
}

/** Replace the matched bytes in a redactable result; an opaque match WITHHOLDS the whole result. */
function redactResult(result: unknown, labels: string[], compiled: [string, RegExp][]): unknown {
  if (typeof result === "string") return scrub(result, compiled);
  if (isTextCarrier(result)) {
    if (Array.isArray(result.images) && result.images.length > 0) {
      logger.warn(
        "[redactor] a match was found but the result carries images; image bytes pass through unredacted",
      );
    }
    return new ToolResult({
      output: scrub(result.output, compiled),
      error: result.error === null ? null : scrub(result.error, compiled),
      metadata: result.metadata,
      success: result.success,
      images: result.images,
      hint: result.hint,
    });
  }
  return withheld(
    `the result matched ${labels.map((l) => `"${l}"`).join(", ")} but is not a text result this redactor can rewrite`,
  );
}

/** Process-wide one-at-a-time prompt queue: parallel tool calls ask in turn (same idiom as user-gate). */
let queueTail: Promise<unknown> = Promise.resolve();

function enqueuePrompt<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task, task);
  queueTail = run.catch(() => {});
  return run;
}

/**
 * One ask -> one answer. Never throws; every failure mode resolves to
 * "redact" (the safe option is also the prompt's default).
 */
async function askHuman(
  toolName: string,
  matches: Match[],
  seam: QuestionSeam,
  signal: AbortSignal | null,
): Promise<string> {
  try {
    if (signal?.aborted) return "redact";
    const lines = [
      `A tool result matched ${matches.length} redaction pattern${matches.length === 1 ? "" : "s"}:`,
      ...matches.map((m) => `  ${m.label}: ${m.sample}`),
      `Send it to the model as-is, or redact? (${toolName})`,
    ];
    const question = {
      key: ANSWER_KEY,
      prompt: spoofSafe(lines.join("\n")),
      options: OPTIONS,
      required: true,
      default: "redact",
      allowOther: false,
    };
    // A prompt nobody will answer (run cancelled) must resolve toward redact
    // rather than dangle.
    const aborted = new Promise<"redact">((resolve) => {
      if (!signal) return;
      signal.addEventListener("abort", () => resolve("redact"), { once: true });
    });
    const answered = Promise.resolve(seam.collectAnswers([question], signal))
      .then((answers) => String(answers?.[ANSWER_KEY] ?? "").trim().toLowerCase())
      .catch(() => "redact");
    const answer = await Promise.race([answered, aborted]);
    return answer === "allow once" || answer === "allow for session" ? answer : "redact";
  } catch {
    return "redact";
  }
}

export function create(core: CoreContext): ExtensionInstance {
  /**
   * "Allow for session" grants, in-memory only, keyed by the requesting
   * agent's sessionId (one process serves many sessions; a grant made in one
   * must not silence another). No session id -> no memo: the grant degrades
   * to "allow once" and the log line says so.
   */
  const sessionGrants = new Map<string, Set<string>>();

  const handler = async (
    payload: ResultPayload,
  ): Promise<{ result: unknown } | undefined> => {
    try {
      // Config at the point of use: a knob flip lands on the next result.
      const cfg = getExtensionConfig<RedactorConfig>(core, "extensionRedactor");
      const compiled = compilePatterns(cfg.patterns);
      if (!Array.isArray(compiled)) {
        // A broken matcher cannot be trusted to let anything through.
        logger.error(`[redactor] invalid config: ${compiled.error} - results withheld until fixed`);
        return { result: withheld(`the redactor config is invalid (${compiled.error})`) };
      }

      const result = payload.result;
      let scan: string;
      if (typeof result === "string") scan = result;
      else if (isTextCarrier(result)) scan = `${result.output}\n${result.error ?? ""}`;
      else {
        try {
          scan = JSON.stringify(result) ?? "";
        } catch {
          // Unscannable (circular, exotic) -- unknown is not "clean".
          return { result: withheld("the result could not be scanned for secrets") };
        }
      }

      const matches = findMatches(scan, compiled);
      if (matches.length === 0) return undefined; // no opinion
      const labels = matches.map((m) => m.label).sort();

      if (!cfg.prompt) {
        logger.info(
          `[redactor] ${payload.toolName}: redacted ${labels.join(", ")} (prompt: false)`,
        );
        return { result: redactResult(result, labels, compiled) };
      }

      const rawSessionId = (payload.agent as { sessionId?: unknown } | undefined)?.sessionId;
      const grantKey = typeof rawSessionId === "string" ? rawSessionId : null;
      // Keyed by the label SET: an allow for {aws} must not cover a later
      // result that also matches {github}. Stricter than the human said,
      // which is the direction a gate errs.
      const memoKey = `${payload.toolName}\u0000${labels.join(",")}`;
      if (grantKey !== null && sessionGrants.get(grantKey)?.has(memoKey)) return undefined;

      const seam = payload.toolCtx?.get("input") as QuestionSeam | undefined;
      const signal =
        (payload.toolCtx?.get("abortSignal") as AbortSignal | null | undefined) ?? null;
      if (!seam || !seam.isInteractive()) {
        logger.warn(
          `[redactor] ${payload.toolName}: matched ${labels.join(", ")} with no interactive UI to ask - redacted`,
        );
        return { result: redactResult(result, labels, compiled) };
      }

      const answer = await enqueuePrompt(() =>
        askHuman(payload.toolName, matches, seam, signal),
      );
      if (answer === "allow for session" || answer === "allow once") {
        const remembered = answer === "allow for session" && grantKey !== null;
        if (remembered) {
          let mine = sessionGrants.get(grantKey!);
          if (!mine) {
            mine = new Set();
            sessionGrants.set(grantKey!, mine);
          }
          mine.add(memoKey);
        }
        logger.info(
          `[redactor] allowed ${labels.join(",")} on ${payload.toolName} ${
            remembered ? "for session" : "once"
          }${answer === "allow for session" && !remembered ? " (no session id: degraded to once)" : ""}`,
        );
        return undefined; // the result passes through untouched
      }
      return { result: redactResult(result, labels, compiled) };
    } catch (e) {
      // Belt and braces: never throw into the pipeline -- a throw reads as a
      // tool crash. Withholding is the safe verdict for the machinery itself.
      logger.error(`[redactor] handler failed: ${formatError(e)}`);
      return { result: withheld(`the redactor failed (${formatError(e)})`) };
    }
  };

  return {
    hooks: {
      [HOOKS.TOOL_RESULT]: handler,
      // Dead sessions must not keep grants alive in a 24/7 host (same reclaim
      // posture as user-gate's).
      [HOOKS.SESSION_END]: ({ sessionId }) => {
        sessionGrants.delete(sessionId);
      },
    },
  };
}
