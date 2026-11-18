// Prompt delivery (text + webui uploads) and turn cancellation.

import { modelAcceptsImages } from "@core/config/providers.ts";
import { uploadLimits } from "@core/config/upload-limits.ts";
import { parseUploadedFiles } from "./uploads.ts";
import { S2C } from "./protocol.ts";
import { SessionRegistry } from "./session-registry.ts";
import { dismissResumedQuestions } from "./resume.ts";
import type { RouteContext } from "./route-types.ts";

export function handleSend(ctx: RouteContext): void {
  const { ws, msg, registry, bridge, core } = ctx;
  const sessionManager = registry.getSessionManager();
  const sid = msg.sessionId as string | undefined;
  const text = typeof msg.content === "string" ? msg.content : "";
  const files = msg.files;
  if (!sid) return;

  // B3 refusal table (design (d), R4's attribute-not-fork): a worker row is
  // not a turn-taking session. Today this silently vanished (the private
  // SessionManager has no entry, so enqueue hit nothing); now it answers.
  if (registry.getRow(sid)?.kind === "worker") {
    SessionRegistry.sendSafe(ws, {
      type: S2C.ERROR,
      message: "Subagents are steered with a follow-up, not a turn.",
    });
    return;
  }

  // A new prompt supersedes any resumed question still on hold.
  dismissResumedQuestions(bridge, registry, sid);

  if (Array.isArray(files) && files.length > 0) {
    // Webui upload: base64 files on the send message.
    // Validation is all-or-nothing so nothing is ever silently dropped.
    // Provenance: the parse happened server-side, so this enqueue is harness-authoritative --
    // the only way file-include parts survive the bus queue boundary (sanitizeQueuedContent).
    const agent = sessionManager.getAgentBySessionId(sid);
    const limits = uploadLimits(core);
    const parsed = parseUploadedFiles(files, {
      ...limits,
      vision: modelAcceptsImages(agent?.model, (agent as { modelRegistry?: Record<string, never> } | undefined)?.modelRegistry),
    });
    if (parsed.errors.length > 0) {
      SessionRegistry.sendSafe(ws, {
        type: S2C.ERROR,
        message: `Upload rejected: ${parsed.errors.join("; ")}`,
      });
      return;
    }
    const content: Array<Record<string, unknown>> = [];
    if (text) content.push({ type: "untrusted", text });
    content.push(...parsed.parts);
    if (content.length === 0 && parsed.images.length === 0) return;
    registry.touch(sid);
    // No message-count bump here: the sidebar count is the session-log
    // writer's committed-record tally (record-count.ts), which counts this
    // send exactly once when its input record lands.
    sessionManager.enqueue(sid, content, {
      source: "harness",
      ...(parsed.images.length > 0 ? { images: parsed.images } : {}),
    });
    return;
  }

  if (text) {
    registry.touch(sid);
    sessionManager.enqueue(
      sid,
      text,
      msg.steering === true ? { steering: true } : undefined,
    );
  }
}

export function handleCancel(ctx: RouteContext): void {
  const { ws, msg, registry, bridge } = ctx;
  if (!msg.sessionId) return;
  const managerSid = msg.sessionId as string;
  // B3 refusal table: cancel on a worker sid is refused. This closes the
  // gap the B2 ledger carried: the plain bridge.cancel below resolved a
  // held worker question UNMARKED (defaults-as-answer, a D10 breach). The
  // refusal leaves the pending HELD for the manager; the kill control is
  // task-side (interrupt_task), and the manager's own cancel route above
  // stays exactly as B2 shipped it.
  if (registry.getRow(managerSid)?.kind === "worker") {
    SessionRegistry.sendSafe(ws, {
      type: S2C.ERROR,
      message: "Subagent runs are stopped with the task control (interrupt_task), not cancel.",
    });
    return;
  }
  // interrupt() keeps the bus alive for follow-ups; cancel() would abort it.
  registry.getSessionManager().interrupt(managerSid);
  // Unblock a pending question-tool call so it can't hang.
  bridge.cancel(managerSid);
  // D1's bound on the park (manager-gone closure): this manager's run is
  // over, so any of its workers held on a question will never get an
  // answer -- release those held questions IMMEDIATELY, unanswered ("answerer
  // gone, proceed"). Event-driven, no timer involved; the worker tasks
  // themselves are NOT interrupted (a kill is interrupt_task/manager/user
  // territory). The manager's own pending above is untouched by this.
  registry.getTaskManager()?.releaseQuestionsForManager(
    managerSid,
    "the delegating manager's run was cancelled",
  );
}
