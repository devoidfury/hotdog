/// <reference lib="dom" />
// Login screen lifecycle on the dom-helper DOM: the busy/error atoms drive a
// full re-render (mounted the same way app.tsx's render effect does it), and
// submit owns the token persistence + onToken handoff. The fetch/localStorage
// stubs below are swapped per test and all globals are restored in afterAll
// (serial-mode hygiene, same pattern as logview.test.tsx).

import { describe, it, expect, afterEach, afterAll } from "bun:test";
import { mount, type Mounted, type DomNode } from "@utils/jsx";
import { effect } from "@extensions/webui/ui/utils.ts";
import {
  LoginScreen,
  focusLoginInput,
  getStoredToken,
  clearStoredToken,
  loginAtoms,
} from "@extensions/webui/ui/login.tsx";

// ── Browser env ─────────────────────────────────────────────────────────────

const g = globalThis as Record<string, unknown>;
const prev = { localStorage: g.localStorage, fetch: g.fetch };
const store = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
};

type FetchReply = { ok: boolean; status: number; json: () => Promise<unknown> };
const okReply = async (): Promise<FetchReply> => ({ ok: true, status: 200, json: async () => ({ token: "tok-1" }) });

let fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let nextReply: () => Promise<FetchReply> = okReply;
g.fetch = async (url: unknown, init?: RequestInit) => {
  fetchCalls.push({ url: String(url), init: init ?? {} });
  return (await nextReply()) as unknown as Response;
};

afterAll(() => {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

// ── Harness ─────────────────────────────────────────────────────────────────

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const busyAtom = loginAtoms[0] as (v?: boolean) => unknown;
const errorAtom = loginAtoms[1] as (v?: string | null) => unknown;

let app: Mounted | null = null;
let tokens: string[] = [];

function renderLogin(hidden = false): Element {
  const host = document.createElement("div");
  const draw = () => <LoginScreen hidden={hidden} onToken={(t) => tokens.push(t)} />;
  app = mount(draw(), host as unknown as DomNode);
  // Same contract as app.tsx: the render effect subscribes to loginAtoms.
  effect(() => app?.render(draw()), loginAtoms);
  return host;
}

afterEach(() => {
  app?.unmount();
  app = null;
  tokens = [];
  fetchCalls = [];
  nextReply = okReply;
  store.clear();
  busyAtom(false);
  errorAtom(null);
});

const el = (root: Element, sel: string): HTMLElement => root.querySelector(sel) as unknown as HTMLElement;

// dom-helper has no focus(); stub it on the live node so submit's
// finally-focus (and focusLoginInput) are observable, not fatal.
function stubFocus(e: Element): { count: () => number } {
  let n = 0;
  (e as unknown as { focus: () => void }).focus = () => {
    n++;
  };
  return { count: () => n };
}

function setInput(root: Element, value: string): { count: () => number } {
  const input = el(root, "#api-key-input");
  (input as unknown as { value: string }).value = value;
  return stubFocus(input);
}

const submit = (root: Element) => el(root, "#login-form").dispatchEvent(new Event("submit"));

// ── Pure token helpers ──────────────────────────────────────────────────────

describe("stored-token helpers", () => {
  it("get/clear round-trip the hotdog-webui-token key", () => {
    expect(getStoredToken()).toBeNull();
    store.set("hotdog-webui-token", "abc");
    expect(getStoredToken()).toBe("abc");
    clearStoredToken();
    expect(store.has("hotdog-webui-token")).toBe(false);
    expect(getStoredToken()).toBeNull();
  });
});

// ── Render grammar ──────────────────────────────────────────────────────────

describe("render", () => {
  it("visible by default, disabled controls when busy", async () => {
    const root = renderLogin();
    expect(el(root, "#login-screen").getAttribute("class")).toBe("screen");

    // busy flips the module atoms; the render effect repaints the tree.
    busyAtom(true);
    await tick();
    expect(el(root, "#api-key-input").hasAttribute("disabled")).toBe(true);
    expect(el(root, "button[type=submit]").textContent).toBe("Signing in...");
    busyAtom(false);
    await tick();
    expect(el(root, "button[type=submit]").textContent).toBe("Sign In");
  });

  it("hidden class when hidden; error atom renders the paragraph, null omits it", async () => {
    const root = renderLogin(true);
    expect(el(root, "#login-screen").getAttribute("class")).toBe("screen hidden");
    expect(root.querySelector(".error-message")).toBeNull();
    errorAtom("boom");
    await tick();
    expect(el(root, ".error-message").textContent).toBe("boom");
  });
});

// ── Submit flow ─────────────────────────────────────────────────────────────

describe("submit", () => {
  it("empty input is inert: no fetch, no token, no error", async () => {
    const root = renderLogin();
    setInput(root, "   ");
    submit(root);
    await tick();
    expect(fetchCalls).toHaveLength(0);
    expect(tokens).toEqual([]);
    expect(root.querySelector(".error-message")).toBeNull();
  });

  it("success: posts the trimmed key, persists the token, calls onToken, refocuses", async () => {
    const root = renderLogin();
    const focus = setInput(root, "  s3cret  ");
    submit(root);
    await tick();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("/login");
    expect(fetchCalls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(fetchCalls[0]!.init.body))).toEqual({ apiKey: "s3cret" });
    expect(getStoredToken()).toBe("tok-1");
    expect(tokens).toEqual(["tok-1"]);
    expect(focus.count()).toBe(1); // finally-focus
    expect(root.querySelector(".error-message")).toBeNull();
  });

  it("rejection with an error body surfaces the server's message", async () => {
    nextReply = async () => ({ ok: false, status: 401, json: async () => ({ error: "bad key" }) });
    const root = renderLogin();
    setInput(root, "nope");
    submit(root);
    await tick();
    expect(el(root, ".error-message").textContent).toBe("bad key");
    expect(tokens).toEqual([]);
    expect(getStoredToken()).toBeNull();
  });

  it("rejection with an empty error field falls back to the status text", async () => {
    nextReply = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const root = renderLogin();
    setInput(root, "x");
    submit(root);
    await tick();
    expect(el(root, ".error-message").textContent).toBe("Status 503");
  });

  it("rejection with an unparseable body keeps the default message", async () => {
    nextReply = async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    });
    const root = renderLogin();
    setInput(root, "x");
    submit(root);
    await tick();
    expect(el(root, ".error-message").textContent).toBe("Login failed");
  });

  it("a thrown fetch surfaces as a connection error", async () => {
    nextReply = async () => {
      throw new Error("connection refused");
    };
    const root = renderLogin();
    setInput(root, "x");
    submit(root);
    await tick();
    expect(el(root, ".error-message").textContent).toBe("Connection error: connection refused");
    expect(tokens).toEqual([]);
  });

  it("while busy, submits are ignored (no second POST)", async () => {
    let release: (() => void) | null = null;
    nextReply = () =>
      new Promise<FetchReply>((resolve) => {
        release = () => resolve({ ok: true, status: 200, json: async () => ({ token: "tok-1" }) });
      });
    const root = renderLogin();
    setInput(root, "x");
    submit(root);
    await tick(); // request in flight, busyAtom still true
    submit(root);
    expect(fetchCalls).toHaveLength(1);
    release!();
    await tick();
    expect(tokens).toEqual(["tok-1"]);
  });

  it("focusLoginInput focuses the mounted input and is a no-op once unmounted", () => {
    const root = renderLogin();
    const focus = stubFocus(el(root, "#api-key-input"));
    focusLoginInput();
    expect(focus.count()).toBe(1);
    app?.unmount();
    app = null;
    // Ref detached to null on unmount: must not throw.
    focusLoginInput();
  });
});
