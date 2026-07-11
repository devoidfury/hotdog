// Login screen component — API key input → POST /login → store token.

interface LoginConfig {
  /** Called with token string on successful login */
  onLogin: (token: string) => void;
}

interface LoginError {
  error?: string;
}

/**
 * Initialize the login screen.
 * @param config - Configuration object with login callback
 */
export function initLogin({ onLogin }: LoginConfig): void {
  const form = document.getElementById("login-form") as HTMLFormElement;
  const input = document.getElementById("api-key-input") as HTMLInputElement;
  const errorEl = document.getElementById("login-error") as HTMLParagraphElement;

  form.addEventListener("submit", async (e: SubmitEvent) => {
    e.preventDefault();
    const apiKey = input.value.trim();
    if (!apiKey) return;

    errorEl.classList.add("hidden");
    input.disabled = true;

    const btn = form.querySelector("button") as HTMLButtonElement;
    const originalText = btn.textContent;
    btn.textContent = "Signing in...";
    btn.disabled = true;

    try {
      const res = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });

      if (!res.ok) {
        const err = await res.json().catch<LoginError>(() => ({ error: "Login failed" }));
        showError(errorEl, err.error || `Status ${res.status}`);
        input.disabled = false;
        btn.textContent = originalText;
        btn.disabled = false;
        return;
      }

      const data = await res.json() as { token: string };
      onLogin(data.token);
    } catch (err) {
      showError(errorEl, `Connection error: ${(err as Error).message}`);
      input.disabled = false;
      btn.textContent = originalText;
      btn.disabled = false;
    }
  });

  // Focus the input on load
  input.focus();
}

function showError(el: HTMLParagraphElement, msg: string): void {
  el.textContent = msg;
  el.classList.remove("hidden");
}
