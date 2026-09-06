/// <reference lib="dom" />
// Login screen owns auth state and the stored-token lifecycle.
// On success persists the token and hands it to onToken.

import type { Ref } from "@utils/jsx";
import { reactiveState } from "./utils.ts";

const TOKEN_STORAGE_KEY = "hotdog-webui-token";

const busyAtom = reactiveState<boolean>(false);
const errorAtom = reactiveState<string | null>(null);

/** Atoms the app's render effect must subscribe to. */
export const loginAtoms = [busyAtom, errorAtom];

let inputEl: HTMLInputElement | null = null;
// Stable ref identity: an inline closure would be new every render, making
// patch() detach (null) and re-attach the ref each time.
const inputRef: Ref = (el) => {
  inputEl = el as unknown as HTMLInputElement | null;
};

export function focusLoginInput(): void {
  inputEl?.focus();
}

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

interface LoginProps {
  hidden: boolean;
  onToken: (token: string) => void;
}

export function LoginScreen({ hidden, onToken }: LoginProps) {
  async function submit(): Promise<void> {
    const apiKey = (inputEl?.value ?? "").trim();
    if (!apiKey || busyAtom()) return;

    busyAtom(true);
    errorAtom(null);
    try {
      const res = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      if (!res.ok) {
        let msg = "Login failed";
        try {
          const err = (await res.json()) as { error?: string };
          msg = err.error || `Status ${res.status}`;
        } catch {
          // keep default error message
        }
        errorAtom(msg);
        return;
      }
      const data = (await res.json()) as { token: string };
      localStorage.setItem(TOKEN_STORAGE_KEY, data.token);
      onToken(data.token);
    } catch (err) {
      errorAtom(`Connection error: ${(err as Error).message}`);
    } finally {
      busyAtom(false);
      inputEl?.focus();
    }
  }

  return (
    <div id="login-screen" className={`screen${hidden ? " hidden" : ""}`}>
      <div className="login-container">
        <h1>hotdog</h1>
        <p className="subtitle">AI Agent Harness</p>
        <form
          id="login-form"
          onSubmit={(e: Event) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            type="password"
            id="api-key-input"
            placeholder="Enter API key"
            autocomplete="off"
            disabled={busyAtom()}
            ref={inputRef}
          />
          <button type="submit" disabled={busyAtom()}>
            {busyAtom() ? "Signing in..." : "Sign In"}
          </button>
        </form>
        {errorAtom() ? <p className="error-message">{errorAtom()}</p> : null}
      </div>
    </div>
  );
}
