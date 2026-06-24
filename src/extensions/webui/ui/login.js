// Login screen component — API key input → POST /login → store token.

/**
 * Initialize the login screen.
 * @param {Object} config
 * @param {Function} config.onLogin - Called with token string on successful login
 */
export function initLogin({ onLogin }) {
  const form = document.getElementById("login-form");
  const input = document.getElementById("api-key-input");
  const errorEl = document.getElementById("login-error");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const apiKey = input.value.trim();
    if (!apiKey) return;

    errorEl.classList.add("hidden");
    input.disabled = true;

    try {
      const res = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Login failed" }));
        showError(errorEl, err.error || `Status ${res.status}`);
        input.disabled = false;
        return;
      }

      const data = await res.json();
      onLogin(data.token);
    } catch (err) {
      showError(errorEl, `Connection error: ${err.message}`);
      input.disabled = false;
    }
  });

  // Focus the input on load
  input.focus();
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove("hidden");
}
