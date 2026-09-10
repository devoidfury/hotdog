// sysbox supervisor worker (gate mode): holds the seccomp USER_NOTIF
// listener fd and the NOTIF_RECV -> decide -> NOTIF_SEND loop.
//
// Lives in a Worker on purpose: gate_poll_in and the recv ioctls are
// blocking FFI and must never block the hotdog main loop. Workers are
// threads of the same process; the notify fd reaches this thread via
// pidfd_getfd (the helper writes its NUMBER over the abstract socket;
// the import happens here -- fd numbers are not capabilities, so the
// supervisor must never act on one it did not import itself).
//
// Bun worker rules (measured on 1.3.14): only `onmessage` fires (not
// addEventListener), and messages are DROPPED while the module sits in a
// top-level await -- entry is a called main(), and all cc()'d strings are
// NUL-terminated Uint8Arrays (JS string -> "ptr" args segfault).
//
// Protocol with the main process (index.ts):
//   -> { type: "start", gateName }
//   <- { type: "ready" }                  listening on the abstract socket
//   <- { type: "fatal", why }             setup failed (fail closed)
//   <- { type: "notify", id, pid, nr, args[6] }   decimal strings for u64s
//   -> { type: "resp", id, error, val }   error: 0 allow | -errno deny
//   <- { type: "log", msg }               diagnostics (execve audit, etc.)
//   <- { type: "closed", why }            listener gone; loop ended
//   -> { type: "stop" }                   main is done with this child

/* SECCOMP_USER_NOTIF_FLAG_CONTINUE: an error=0 response WITHOUT this flag
 * does not execute the syscall -- it fakes return val to the task. Allow
 * semantics therefore must set it (kernel rejects CONTINUE only for
 * TSYNC-installed filters; our listener filter is deliberately no-TSYNC,
 * and post-exec threads inherit it anyway). */
const NOTIF_FLAG_CONTINUE = 1;

import { cc } from "bun:ffi";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isSeccompNotifyFd } from "./procfs.ts";

const worker = self as unknown as Worker;
const out = (m: unknown) => worker.postMessage(m);

const NOTIFY_DEADLINE_MS = 60_000;
const POLL_SLICE_MS = 500;
const EINTR = 4;
const ENOENT = 2;
/* Storm cap (docs/sysbox-sandbox.md "Supervisor loop liveness"): a script
 * looping denied writes must not become an unbounded queue of unanswered
 * notifications; beyond this many outstanding, new notifications are
 * answered -EAGAIN right here, with a single log line. */
const MAX_OUTSTANDING = 64;
const EAGAIN = 11;

interface Symbols {
  sbx_gate_listen: (name: Uint8Array, len: number) => number;
  sbx_gate_accept: (lfd: number) => number;
  sbx_read_num: (sock: number, out32: Uint8Array) => number;
  sbx_peer_cred: (sock: number, pidOut: Uint8Array, uidOut: Uint8Array) => number;
  sbx_getuid: () => number;
  sbx_import_fd: (peerPid: number, targetFd: number) => number;
  sbx_poll_in: (fd: number, ms: number) => number;
  sbx_notif_recv: (fd: number, buf: Uint8Array) => number;
  sbx_notif_id_valid: (fd: number, id8: Uint8Array) => number;
  sbx_notif_send: (fd: number, resp: Uint8Array) => number;
  sbx_close: (fd: number) => number;
}

let stopping = false;
let resolveStart: ((name: string) => void) | null = null;
/* id -> resolver, one per outstanding notification (decisions are pipelined:
 * the recv loop never waits for one before taking the next). Per-id deadline
 * timers: a single shared timer would let the newest notification disarm the
 * oldest one's -EINTR backstop. */
const pending = new Map<string, (r: { error: number; val: number }) => void>();
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function settle(id: string, r: { error: number; val: number }): void {
  const cb = pending.get(id);
  if (!cb) return;
  pending.delete(id);
  const t = pendingTimers.get(id);
  if (t) {
    clearTimeout(t);
    pendingTimers.delete(id);
  }
  cb(r);
}

worker.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m?.type === "start") { resolveStart?.(m.gateName); return; }
  if (m?.type === "stop") {
    stopping = true;
    // Release every outstanding decision toward -EINTR now (invariant 3:
    // no decision dangles once main says it is done with this child).
    for (const id of Array.from(pending.keys())) settle(id, { error: -EINTR, val: 0 });
    return;
  }
  if (m?.type === "resp") {
    settle(String(m.id), m);
  }
};

function compile(): Symbols {
  const launcherC = join(dirname(fileURLToPath(import.meta.url)), "launcher.c");
  const { symbols } = cc({
    source: launcherC,
    symbols: {
      sbx_gate_listen: { args: ["ptr", "i32"], returns: "i32" },
      sbx_gate_accept: { args: ["i32"], returns: "i32" },
      sbx_read_num: { args: ["i32", "ptr"], returns: "i32" },
      sbx_peer_cred: { args: ["i32", "ptr", "ptr"], returns: "i32" },
      sbx_getuid: { args: [], returns: "i32" },
      sbx_import_fd: { args: ["i32", "i32"], returns: "i32" },
      sbx_poll_in: { args: ["i32", "i32"], returns: "i32" },
      sbx_notif_recv: { args: ["i32", "ptr"], returns: "i32" },
      sbx_notif_id_valid: { args: ["i32", "ptr"], returns: "i32" },
      sbx_notif_send: { args: ["i32", "ptr"], returns: "i32" },
      sbx_close: { args: ["i32"], returns: "i32" },
    },
  });
  return symbols as unknown as Symbols;
}

async function main() {
  out({ type: "need-start" });
  const gateName = await new Promise<string>((r) => { resolveStart = r; });
  if (stopping) { out({ type: "closed", why: "stopped before start" }); return; }

  let g: Symbols;
  try {
    g = compile();
  } catch (e) {
    out({ type: "fatal", why: `cc() failed: ${e}` });
    return;
  }

  const nameBuf = new TextEncoder().encode(gateName + "\0");
  const lfd = g.sbx_gate_listen(nameBuf, nameBuf.byteLength);
  if (lfd < 0) { out({ type: "fatal", why: `gate listen failed: ${lfd}` }); return; }
  out({ type: "ready" });

  let cfd = -1;
  while (!stopping) {
    const pr = g.sbx_poll_in(lfd, POLL_SLICE_MS);
    if (pr < 0) { g.sbx_close(lfd); out({ type: "fatal", why: `poll listen fd: ${pr}` }); return; }
    if (pr === 1) { cfd = g.sbx_gate_accept(lfd); break; }
  }
  g.sbx_close(lfd);
  if (stopping || cfd < 0) { out({ type: "closed", why: "no connection" }); return; }

  // Verify the peer is US before anything else. The abstract socket name is
  // guessable (pid+seq); the uid check filters cross-uid racers. A same-uid
  // racer passes it, and the uid check alone cannot stop it from naming some
  // fd of its own -- hence the notify-fd check on the imported fd below. What
  // the racer always loses is the accept itself: the genuine helper is left
  // stranded in the execve trap, never unsupervised, and the spawn fails.
  const credBuf = new Uint8Array(8);
  const credDv = new DataView(credBuf.buffer);
  const cr = g.sbx_peer_cred(cfd, credBuf.subarray(0, 4), credBuf.subarray(4, 8));
  if (cr !== 0) { g.sbx_close(cfd); out({ type: "fatal", why: `peer cred: ${cr}` }); return; }
  const peerPid = credDv.getInt32(0, true);
  const peerUid = credDv.getInt32(4, true);
  // own uid straight from the kernel (bun's process.uid is undefined here)
  if (peerPid < 0 || peerUid !== g.sbx_getuid()) {
    g.sbx_close(cfd);
    out({ type: "fatal", why: `peer uid ${peerUid} != ours ${g.sbx_getuid()}` });
    return;
  }

  // The helper write()s the notify-fd number (decimal); we import the fd
  // ourselves. The child is ordered into execve only after the write lands,
  // and execve traps at entry, so its fd table is intact when we import.
  const numBuf = new Uint8Array(4);
  const numDv = new DataView(numBuf.buffer);
  let nfd = -1;
  while (!stopping) {
    const pr = g.sbx_poll_in(cfd, POLL_SLICE_MS);
    if (pr < 0) { g.sbx_close(cfd); out({ type: "fatal", why: `poll conn: ${pr}` }); return; }
    if (pr === 1) {
      const rr = g.sbx_read_num(cfd, numBuf);
      if (rr !== 0) { g.sbx_close(cfd); out({ type: "closed", why: `read notify fd num: ${rr}` }); return; }
      nfd = g.sbx_import_fd(peerPid, numDv.getInt32(0, true));
      break;
    }
  }
  g.sbx_close(cfd);
  if (stopping || nfd < 0) { out({ type: "closed", why: `import notify fd: ${nfd}` }); return; }

  // The imported fd must actually BE the seccomp notifier. `nfd` was chosen
  // by whoever we just accepted, and the uid check alone does not constrain
  // WHICH of its fds they name: at ptrace_scope 0 the import succeeds for any
  // same-uid peer, so a racer could hand us the notify fd of a DIFFERENT
  // sandbox and put our decider in front of another supervisor's frozen tasks.
  // A non-notify fd dies on NOTIF_RECV (EINVAL) by accident; a foreign notify
  // fd would not, so the fd type is verified before anything uses it.
  if (!isSeccompNotifyFd(nfd)) {
    g.sbx_close(nfd);
    out({ type: "fatal", why: `imported fd ${nfd} is not a seccomp notify fd` });
    return;
  }

  const buf = new Uint8Array(80);
  const dv = new DataView(buf.buffer);
  const id8 = new Uint8Array(8);
  const idDv = new DataView(id8.buffer);
  const resp24 = new Uint8Array(24);
  const respDv = new DataView(resp24.buffer);

  let stormLogged = false;
  let nfdOpen = true;

  // One NOTIF_ID_VALID + NOTIF_SEND for a settled decision. Synchronous and
  // self-contained (the id buffers are written immediately before each use)
  // so concurrent answer() calls from settled-decision microtasks cannot
  // interleave. Guarded by nfdOpen: after the loop closes the fd the kernel
  // number can be recycled by anything else in this process.
  const answer = (idBig: bigint, error: number, val: number): void => {
    if (!nfdOpen) return;
    idDv.setBigUint64(0, idBig, true);
    const valid = g.sbx_notif_id_valid(nfd, id8);
    if (valid !== 0) return; // request already canceled (task killed): drop
    respDv.setBigUint64(0, idBig, true);
    respDv.setBigInt64(8, BigInt(val | 0), true);
    respDv.setInt32(16, error | 0, true);
    // allow -> CONTINUE (execute the real syscall); deny -> plain errno.
    respDv.setUint32(20, error === 0 ? NOTIF_FLAG_CONTINUE : 0, true);
    let sr = g.sbx_notif_send(nfd, resp24);
    // -EINTR: interrupted, the request is still unanswered (invariant 3:
    // never leave the child waiting) -- retry once before deciding.
    if (sr === -EINTR) sr = g.sbx_notif_send(nfd, resp24);
    if (sr === -ENOENT) return; // request already canceled (task gone): drop
    if (sr !== 0) {
      nfdOpen = false;
      out({ type: "closed", why: `notif_send: ${sr}` });
    }
  };

  while (!stopping) {
    // Tight slices while decisions are outstanding: the blocking poll is the
    // only thing keeping resp/stop messages from being handled promptly, and
    // a settled answer should reach the kernel quickly.
    const pr = g.sbx_poll_in(nfd, pending.size > 0 ? 10 : POLL_SLICE_MS);
    if (pr < 0) { out({ type: "closed", why: `poll notify fd: ${pr}` }); break; }
    if (pr === 1) {
      // Kernel (v7.1 seccomp_notify_recv) check_zeroed_user()s the whole 80-byte
      // buffer before writing it: a reused, dirty buf is -EINVAL on the 2nd recv.
      buf.fill(0);
      const rr = g.sbx_notif_recv(nfd, buf);
      if (rr === -ENOENT || rr === -EINTR) {
        /* -ENOENT: notification canceled between poll and recv (none
         * pending); -EINTR: interrupted. Nothing received, keep polling. */
      } else if (rr !== 0) {
        // Anything else (EBADF/EINVAL/...): the listener is broken or gone.
        // Nothing left to gate: fail closed. (Persistent -ENOENT = the last
        // sandboxed task exited; main stops this worker shortly after the
        // child's close, so looping there is bounded and quiet.)
        out({ type: "closed", why: `notif_recv: ${rr}` });
        break;
      } else {
        const id = dv.getBigUint64(0, true);
        const idStr = id.toString();
        if (pending.size >= MAX_OUTSTANDING) {
          // Storm backstop (docs/sysbox-sandbox.md "Supervisor loop liveness"): a denied-write
          // loop must not outrun the deciders. Answer -EAGAIN here; ONE log
          // line for the whole storm, never per event.
          if (!stormLogged) {
            stormLogged = true;
            out({
              type: "log",
              msg: `notification storm: >${MAX_OUTSTANDING} unanswered notifications; answering further requests -EAGAIN`,
            });
          }
          answer(id, -EAGAIN, 0);
        } else {
          const pid = dv.getUint32(8, true);
          const nr = dv.getUint32(16, true);
          const args: string[] = [];
          for (let i = 0; i < 6; i++) args.push(dv.getBigUint64(32 + 8 * i, true).toString());
          out({ type: "notify", id: idStr, pid, nr, args });
          // Pipelined: do NOT await here. The answer goes out from the
          // settling microtask (resp message, per-id deadline, or stop).
          const decided = new Promise<{ error: number; val: number }>((resolve) => {
            pending.set(idStr, resolve);
            pendingTimers.set(
              idStr,
              setTimeout(() => settle(idStr, { error: -EINTR, val: 0 }), NOTIFY_DEADLINE_MS),
            );
          });
          if (stopping) settle(idStr, { error: -EINTR, val: 0 });
          void decided.then((decision) => {
            if (stopping && decision.error === 0) decision.error = -EINTR;
            answer(id, decision.error, decision.val);
          });
        }
      }
    }
    // The recv loop has no other await; without this yield the thread would
    // sit in blocking poll and never deliver worker.onmessage (resp/stop),
    // deadline timers, or the answer() microtasks.
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  nfdOpen = false;
  for (const t of pendingTimers.values()) clearTimeout(t);
  pendingTimers.clear();
  pending.clear();
  g.sbx_close(nfd);
  out({ type: "closed", why: "loop end" });
}
main();
