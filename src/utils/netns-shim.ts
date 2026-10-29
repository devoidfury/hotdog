// netns-shim: the pre-exec half of the hard egress tier
// (fetchPolicy.hardEgress). It creates a private user+network namespace,
// brings the new netns' loopback up (the only interface the child will ever
// have), optionally starts the egress bridge, then execs the real command --
// so enforcement is installed BEFORE the target exists, the rule the sysbox
// post-mortem ended on ("enforcement installed pre-exec, or not at all").
//
//   bun netns-shim.ts --probe                  # exit 0 = this host can do it
//   bun netns-shim.ts [--bridge <unixPath>] -- command [args...]
//   bun netns-shim.ts --exec -- command [...]  # no namespaces (test the exec/bridge mechanics only)
//
// Why not `bwrap --unshare-net`: bwrap never raises `lo` in the netns it
// creates, and the jailed process has no CAP_NET_ADMIN to raise it -- so
// nothing inside can listen on loopback, and the bridge could not exist.
// Here WE own the netns: root-in-userns raises lo, then bwrap (if the caller
// wrapped one) simply inherits the namespace without --unshare-net.
//
// Inside the jail's netns: `lo` UP with 127.0.0.1/8 and nothing else -- no
// routes, no physical interface, no path to any host or neighbor. Everything
// egress-shaped must transit 127.0.0.1:<proxy port> -> bridge -> policy unix
// socket, or it does not egress at all.
//
// No new system binaries: FFI against libc for unshare/execvp, raw netlink
// for the interface config, exactly the primitives `unshare -r` + `ip link`
// would use, without depending on those programs existing.

import { dlopen, FFIType, ptr } from "bun:ffi";
import { writeFileSync } from "node:fs";
import { BRIDGE_ENTRY_PATH, EGRESS_PROXY_PORT } from "./egress-bridge.ts";

const CLONE_NEWUSER = 0x10000000;
const CLONE_NEWNET = 0x40000000;
const AF_NETLINK = 16;
const NETLINK_ROUTE = 0;
const SOCK_RAW = 3;
const SOCK_CLOEXEC = 0o2000000;

// Exit codes: 120 = environment cannot run the shim (the probe's signal),
// 121 = setup failed after the probe passed, 122 = usage. Any other exit
// belongs to the wrapped command.

type Libc = {
  unshare(flags: number): { returns: number };
  socket(domain: number, type: number, protocol: number): { returns: number };
  send(fd: number, buf: bigint, len: number, flags: number): { returns: number };
  recv(fd: number, buf: bigint, len: number, flags: number): { returns: number };
  execvp(path: bigint, argv: bigint): { returns: number };
};

function openLibc(): Libc {
  // glibc hosts first; musl exposes the same symbols under libc.so. Both
  // missing = unsupported platform; the probe fails and nothing fails open.
  let last: unknown = null;
  for (const name of ["libc.so.6", "libc.so"]) {
    try {
      const lib = dlopen(name, {
        unshare: { args: [FFIType.int], returns: FFIType.int },
        socket: { args: [FFIType.int, FFIType.int, FFIType.int], returns: FFIType.int },
        send: { args: [FFIType.int, FFIType.pointer, FFIType.u64, FFIType.int], returns: FFIType.i64 },
        recv: { args: [FFIType.int, FFIType.pointer, FFIType.u64, FFIType.int], returns: FFIType.i64 },
        execvp: { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.int },
      });
      const symbols = lib.symbols as unknown as Record<string, unknown>;
      if (typeof symbols["unshare"] === "function" && typeof symbols["execvp"] === "function") {
        return symbols as unknown as Libc;
      }
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`cannot load libc (unshare/execvp): ${last instanceof Error ? last.message : String(last)}`);
}

function fail(code: number, why: string): never {
  process.stderr.write(`netns-shim: ${why}\n`);
  process.exit(code);
}

/** Become root in a fresh user namespace, mapping only our own uid/gid. */
function enterUserNs(libc: Libc): void {
  if (libc.unshare(CLONE_NEWUSER).returns !== 0) {
    fail(120, "unshare(CLONE_NEWUSER) failed -- unprivileged user namespaces are disabled or restricted on this host");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const gid = typeof process.getgid === "function" ? process.getgid() : -1;
  if (uid < 0 || gid < 0) fail(120, "no numeric uid/gid");
  try {
    // Order matters: setgroups must be denied before gid_map for an
    // unprivileged writer (the `unshare -r` recipe), and all three must land
    // before CLONE_NEWNET hands us a namespace keyed to this userns.
    writeFileSync("/proc/self/setgroups", "deny");
    writeFileSync("/proc/self/uid_map", `0 ${uid} 1\n`);
    writeFileSync("/proc/self/gid_map", `0 ${gid} 1\n`);
  } catch (e) {
    fail(120, `cannot write uid/gid maps: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function enterNetNs(libc: Libc): void {
  if (libc.unshare(CLONE_NEWNET).returns !== 0) {
    fail(120, "unshare(CLONE_NEWNET) failed -- no CAP_NET_ADMIN over a private network namespace");
  }
}

// ── netlink: raise lo with 127.0.0.1/8 (the netns' only interface) ─────────

function nlMessage(type: number, payload: Buffer): Buffer {
  const len = 16 + payload.length;
  const head = Buffer.alloc(16);
  head.writeUInt32LE(len, 0);
  head.writeUInt16LE(type, 4);
  head.writeUInt16LE(0x0005 /* NLM_F_REQUEST | NLM_F_ACK */, 6);
  head.writeUInt32LE(1, 8); // seq
  head.writeUInt32LE(0, 12); // port id
  return Buffer.concat([head, payload]);
}

function netlinkAsk(
  fd: number,
  msg: Buffer,
  what: string,
  send: (fd: number, p: bigint, len: number) => number,
  recv: (fd: number, p: bigint, len: number) => number,
): void {
  const sendBuf = Bun.allocUnsafe(msg.length);
  Buffer.from(msg).copy(sendBuf);
  const sent = send(fd, ptr(sendBuf) as unknown as bigint, msg.length);
  if (sent < 0) fail(121, `netlink send (${what}) failed`);
  const reply = Bun.allocUnsafe(4096);
  const read = recv(fd, ptr(reply) as unknown as bigint, reply.length);
  if (read < 16) fail(121, `netlink: no reply for ${what}`);
  const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
  const nlType = view.getUint16(4, true);
  if (nlType === 2 /* NLMSG_ERROR */) {
    const err = view.getInt32(16, true);
    if (err !== 0) fail(121, `netlink rejected ${what} (errno ${-err})`);
  }
}

function raiseLoopback(libc: Libc): void {
  const send = (fd: number, p: bigint, len: number) => libc.send(fd, p, len, 0).returns;
  const recv = (fd: number, p: bigint, len: number) => libc.recv(fd, p, len, 0).returns;
  const fd = libc.socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_ROUTE).returns;
  if (fd < 0) fail(120, "cannot open NETLINK_ROUTE socket");

  // RTM_NEWLINK: lo (index 1 in a fresh netns) IFF_UP.
  const link = Buffer.alloc(16);
  link.writeUInt8(0, 0); // ifi_family = AF_UNSPEC
  link.writeUInt16LE(0, 2); // ifi_type
  link.writeUInt32LE(1, 4); // ifi_index = 1 (lo)
  link.writeUInt32LE(0x1 /* IFF_UP */, 8); // ifi_flags
  link.writeUInt32LE(0x1 /* IFF_UP */, 12); // ifi_change
  netlinkAsk(fd, nlMessage(16 /* RTM_NEWLINK */, link), "IFF_UP on lo", send, recv);

  // RTM_NEWADDR: 127.0.0.1/8 permanent on lo (IFA_ADDRESS + IFA_LOCAL).
  const addr = Buffer.alloc(8);
  addr.writeUInt8(2 /* AF_INET */, 0);
  addr.writeUInt8(8, 1); // prefixlen
  addr.writeUInt8(0x80 /* IFA_F_PERMANENT */, 2);
  addr.writeUInt8(0, 3); // scope
  addr.writeUInt32LE(1, 4); // index = lo
  const ip = Buffer.alloc(4);
  ip.writeUInt32LE(0x7f000001, 0); // 127.0.0.1 (LE == network order for v4 here)
  const attr = (type: number, data: Buffer): Buffer => {
    const head = Buffer.alloc(4);
    head.writeUInt16LE(4 + data.length, 0);
    head.writeUInt16LE(type, 2);
    return Buffer.concat([head, data]);
  };
  netlinkAsk(
    fd,
    nlMessage(20 /* RTM_NEWADDR */, Buffer.concat([addr, attr(1 /* IFA_ADDRESS */, ip), attr(2 /* IFA_LOCAL */, ip)])),
    "127.0.0.1/8 on lo",
    send,
    recv,
  );
}

// ── exec ─────────────────────────────────────────────────────────────────────

function cstring(s: string): ReturnType<typeof ptr> {
  const bytes = Buffer.from(`${s}\0`, "utf8");
  const buf = Bun.allocUnsafe(bytes.length);
  bytes.copy(buf);
  return ptr(buf);
}

function execInto(libc: Libc, command: string, args: string[]): never {
  const argv = [command, ...args];
  const table = Bun.allocUnsafe(8 * (argv.length + 1));
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const kept: ReturnType<typeof ptr>[] = [];
  for (let i = 0; i < argv.length; i++) {
    const c = cstring(argv[i]!);
    kept.push(c); // keep the string buffers alive until execvp
    view.setBigUint64(i * 8, BigInt(c), true);
  }
  view.setBigUint64(argv.length * 8, 0n, true);
  const path = cstring(command);
  libc.execvp(path as unknown as bigint, ptr(table) as unknown as bigint);
  fail(121, `execvp('${command}') returned -- the command could not be started`);
}

// ── main ─────────────────────────────────────────────────────────────────────

function usage(): never {
  process.stderr.write(
    "usage: netns-shim.ts --probe\n" +
      "       netns-shim.ts [--bridge <unixPath>] [--] command [args...]\n" +
      "       netns-shim.ts --exec -- command [args...]   (no namespaces; mechanics test only)\n",
  );
  fail(122, "usage");
}

const argv = process.argv.slice(2);
if (argv.length === 0) usage();

let mode: "probe" | "jail" | "exec" = "jail";
let bridgeSocket: string | null = null;
let i = 0;
for (; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--probe") {
    mode = "probe";
    continue;
  }
  if (a === "--exec") {
    mode = "exec";
    continue;
  }
  if (a === "--bridge") {
    bridgeSocket = argv[++i] ?? usage();
    continue;
  }
  if (a === "--") continue;
  break;
}
const command = argv[i];
if (mode !== "probe" && !command) usage();
const commandArgs = command ? argv.slice(i + 1) : [];

// --probe verifies the FULL chain (userns + maps + netns + lo), minus the
// exec: exactly what every spawn would attempt, so plan and probe agree.
if (mode === "exec") {
  const libc = openLibc();
  execInto(libc, command ?? fail(122, "no command to exec"), commandArgs);
}

const libc = openLibc();
enterUserNs(libc);
enterNetNs(libc);
raiseLoopback(libc);

if (bridgeSocket !== null) {
  // The bridge child shares this netns. It sets PR_SET_PDEATHSIG against us
  // (== the target process once we exec) and rides the process group kill
  // otherwise, so it cannot outlive the sandbox it serves.
  const child = Bun.spawn(
    [process.execPath, BRIDGE_ENTRY_PATH, "--pdeathsig", bridgeSocket, String(EGRESS_PROXY_PORT)],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  // A bridge that dies instantly (bad socket path, port busy) must fail the
  // sandbox loudly, not leave the child with a black-holed proxy.
  child.exited.then((code) => {
    if (code !== 0 && code !== 143 /* SIGTERM from teardown */) {
      process.stderr.write(`netns-shim: egress bridge died (exit ${code}); killing the sandboxed process\n`);
      try {
        process.kill(process.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
}

if (mode === "probe") process.exit(0);

execInto(libc, command ?? fail(121, "no command to exec"), commandArgs);
