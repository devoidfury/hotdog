/*
 * hotdog desktop shim (Linux): one GTK4 + WebKitGTK window pointed at a URL.
 *
 * The window is a dumb terminal. All app logic lives behind the URL in the
 * hotdog WebUI's websocket; this file has NO bridge, NO JS->native path, and
 * NO trust in what the page says -- remote content reaches the same ceiling
 * it would in any browser tab (plus file downloads into XDG's Downloads dir
 * and external links handed to xdg-open, both standard webview behavior).
 * Untrusted TLS (self-signed intranet servers) gets a terminal TOFU prompt
 * with an optional HOTDOG_DESKTOP_TRUST fingerprint pin -- see on_tls_errors.
 *
 * Protocol with the parent (hotdog):
 *   - The app URL (with its #tok= handoff fragment) arrives on stdin's
 *     first line, NEVER argv: argv is world-readable through /proc, and in
 *     local mode the URL carries the session token.
 *   - Exit when the window closes; the parent reads that as the app-quit
 *     signal and drains its agent sessions before exiting too.
 *   - If the target is unreachable (link down, DNS dead, tunnel not up):
 *     the real error prints to THIS terminal, the window shows a readable
 *     failure page instead of WebKit's cryptic default, and the URL is
 *     retried every 3s -- when the server answers, the app appears.
 *   - PR_SET_PDEATHSIG: if the parent dies uncleanly (SIGKILL), the window
 *     goes down with it rather than sitting on a dead server. Firing early
 *     is the safe direction: a closed window just closes the app.
 *
 * Build (done by launcher.ts, cached under the hotdog data dir):
 *   cc -O2 -o shim shim.c $(pkg-config --cflags --libs webkitgtk-6.0)
 * or, on the older GTK3 API series:
 *   cc -O2 -o shim shim.c $(pkg-config --cflags --libs webkit2gtk-4.1)
 * The two series differ in umbrella header AND GTK generation; the include
 * branch below follows whichever gtk the chosen module's flags put on the
 * include path (webkitgtk-6.0 requires gtk4, webkit2gtk-4.1 requires
 * gtk+-3.0 -- the pairing is transitive, never a flag we mix ourselves).
 */
#include <gtk/gtk.h>
#if GTK_CHECK_VERSION(4, 0, 0)
#include <webkit/webkit.h> /* webkitgtk-6.0 (GTK4) */
#define HOTDOG_GTK4 1
#else
#include <webkit2/webkit2.h> /* webkit2gtk-4.1 (GTK3) */
#define HOTDOG_GTK4 0
#endif
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>

#define URL_MAX 8192

static char g_url[URL_MAX];

/* GMainLoop, not gtk_main: GTK4 REMOVED gtk_main/gtk_main_quit entirely
 * (and webkitgtk-6.0 is a GTK4 module), while GTK3's gtk_main is just a
 * wrapper over the default loop. One loop object works on both series. */
static GMainLoop *g_loop;

/* Failure-path state: the view for the retry timer, whether the real
 * document ever committed, whether we already told the user once, and the
 * armed retry timeout (0 = none). */
static WebKitWebView *g_view;
static gboolean g_committed = 0;
static gboolean g_failed_once = 0;
static gboolean g_failure_pending = 0; /* idle_show_failure queued, not run yet */
static guint g_retry_src = 0;

/* target=_blank / window.open: send the link to the user's real browser.
 * Returning NULL refuses the in-app window; the app page never becomes a
 * browser. g_spawn is fire-and-forget; xdg-open failing is silent, which is
 * what xdg-open does everywhere else too. */
static GtkWidget *on_create(WebKitWebView *view,
                            WebKitNavigationAction *action,
                            gpointer user_data) {
  WebKitURIRequest *request = webkit_navigation_action_get_request(action);
  const char *uri = webkit_uri_request_get_uri(request);
  if (uri && g_str_has_prefix(uri, "http")) {
    char *argv[] = { (char *)"xdg-open", (char *)uri, NULL };
    g_spawn_async(NULL, argv, NULL, G_SPAWN_SEARCH_PATH,
                  NULL, NULL, NULL, NULL);
  }
  return NULL;
}

/* No download handler, deliberately. On the current API (4.1 since >= 2.42,
 * and 6.0) a download starts automatically and lands in the user's XDG
 * Downloads dir with the suggested filename -- the starter method was removed
 * from the API, and `decide-destination` only exists to override the default
 * destination. The webui's /download and /export routes therefore need no
 * help from the shim. */

/* --- TLS trust: terminal TOFU for self-signed intranet certs ---------------
 * WebKit refusing an untrusted certificate is the default working as
 * intended. The shim speaks to the terminal that launched hotdog: print the
 * certificate's SHA-256 (openssl-style), ask once. "yes"/"y" or typing the
 * fingerprint back grants trust for that host; HOTDOG_DESKTOP_TRUST=<fp>
 * skips the prompt, and a pin that does NOT match refuses WITHOUT prompting
 * -- the whole point of pinning is that a changed certificate fails hard,
 * not nags.
 *
 * Trust means the SESSION, because consent at the door means the server:
 * a per-host certificate exception covers the document load, but field
 * reports on 4.1 showed the page's own fetch/XHR connections still dying on
 * TLS -- the login submit hanging with no error was the symptom. So after
 * explicit consent we also set the context's (deprecated-but-functional)
 * ignore policy, then reload. Single origin by construction (create-refused
 * window, external links go to xdg-open), so the policy's blanket scope is
 * bounded by the server the user just pinned.
 *
 * NOTHING in this flow runs inside the signal emission. The handler refs
 * the certificate (validity ends with the emission), dups the URI, and
 * defers the whole prompt-and-decide to an idle: blocking on the operator
 * inside WebKit's own emission is hostile, and from the idle we can
 * load_uri cleanly. (The glibc "free(): invalid size" abort this deferral
 * was blamed for turned out to be a g_free of webkit_web_view_get_uri's
 * internal string on first COMMITTED -- see on_load_changed.)
 * Refusal exits the shim: a window with nothing to show is a white-screen
 * mystery; an exited app plus a terminal reason is not. */

static int g_refused = 0;

typedef struct {
  WebKitWebView *view;
  char *uri;
  gpointer certificate; /* OWNED (g_object_ref'd in the signal handler): the
                           emission's copy does not outlive the emission */
} TlsReq;

static void tls_refuse(const char *why) {
  fprintf(stderr, "%s\n[desktop shim] exiting.\n", why);
  g_refused = 1;
  g_main_loop_quit(g_loop); /* idle/quit are safe from an idle callback */
}

static void on_window_destroy(G_GNUC_UNUSED GtkWidget *window,
                              G_GNUC_UNUSED gpointer user_data) {
  g_main_loop_quit(g_loop);
}

/* SHA-256 of the certificate DER, openssl-style "AA:BB:..." uppercase.
 * (DER, not PEM: the fingerprint an operator generates with
 * `openssl x509 -fingerprint -sha256` has to match what we print/pin.)
 * The certificate is a gpointer on purpose: g_object_get takes one, and
 * naming GTlsCertificate/GTlsCertificateError here would drag gio's TLS
 * headers into our include view -- field-confirmed that the enum is not
 * reliably visible where webkitgtk's own headers are. GObject callbacks
 * pass instances as pointers; the G_CALLBACK cast erases the signature
 * check, so plain C types keep this compiling on every glib/webkit combo. */
static char *cert_fingerprint_sha256(gpointer certificate) {
  char *pem = NULL;
  g_object_get(certificate, "certificate-pem", &pem, NULL);
  if (!pem) return NULL;
  const char *body = strstr(pem, "-----BEGIN CERTIFICATE-----");
  if (!body) { g_free(pem); return NULL; }
  body += strlen("-----BEGIN CERTIFICATE-----");
  const char *end = strstr(body, "-----END CERTIFICATE-----");
  if (!end) { g_free(pem); return NULL; }
  GString *b64 = g_string_new(NULL);
  for (const char *p = body; p < end; p++)
    if (*p != '\n' && *p != '\r' && *p != ' ' && *p != '\t')
      g_string_append_c(b64, *p);
  gsize der_len = 0;
  guchar *der = g_base64_decode(b64->str, &der_len);
  g_string_free(b64, TRUE);
  g_free(pem);
  GChecksum *sum = g_checksum_new(G_CHECKSUM_SHA256);
  g_checksum_update(sum, der, (gssize)der_len);
  char *hex = g_ascii_strup(g_checksum_get_string(sum), -1);
  g_checksum_free(sum);
  g_free(der);
  GString *fp = g_string_new(NULL);
  for (gsize i = 0; hex[i]; i += 2) {
    if (i) g_string_append_c(fp, ':');
    g_string_append_len(fp, hex + i, 2);
  }
  g_free(hex);
  return g_string_free(fp, FALSE);
}

/* Compare a user/pin entry against the printed fingerprint: case-insensitive,
 * colons optional, an "sha256:"/"sha256/" prefix tolerated. Empty never
 * matches. */
static gboolean fp_matches(const char *candidate, const char *fp) {
  if (!candidate || !*candidate) return FALSE;
  if (g_ascii_strncasecmp(candidate, "sha256:", 7) == 0) candidate += 7;
  if (g_ascii_strncasecmp(candidate, "sha256/", 7) == 0) candidate += 7;
  GString *norm = g_string_new(NULL);
  for (const char *p = candidate; *p; p++) {
    if (*p == ':' || *p == ' ' || *p == '\n' || *p == '\r' || *p == '\t') continue;
    g_string_append_c(norm, *p);
  }
  gboolean ok = norm->len > 0 && g_ascii_strcasecmp(norm->str, fp) == 0;
  g_string_free(norm, TRUE);
  return ok;
}

/* Host of an http(s) URI, g_strdup'd (NULL if unparseable). Deliberately
 * hand-rolled rather than g_uri_parse: the input is the failing URL string
 * WebKit hands us (https://host[:port]/path, IPv6 bracketed), and one fewer
 * GLib-version assumption in a file whose whole job is compiling anywhere
 * webkitgtk exists. No userinfo expected; if one shows up, everything up to
 * the last '@' before the authority ends is dropped, like every parser does. */
static char *uri_host(const char *uri) {
  const char *p = strstr(uri, "://");
  if (!p) return NULL;
  p += 3;
  const char *end = p;
  while (*end && *end != '/' && *end != '?' && *end != '#') end++;
  const char *authority = p;
  const char *auth_end = end;
  for (const char *q = authority; q < auth_end; q++)
    if (*q == '@') authority = q + 1;
  if (authority < auth_end && *authority == '[') {
    const char *close = memchr(authority, ']', (size_t)(auth_end - authority));
    if (!close) return NULL;
    return g_strndup(authority + 1, (gsize)(close - authority - 1));
  }
  const char *colon = memchr(authority, ':', (size_t)(auth_end - authority));
  return g_strndup(authority, (gsize)((colon ? colon : auth_end) - authority));
}

static gboolean handle_tls_request(gpointer data) {
  TlsReq *req = data;
  if (!g_refused) {
    char *fp = cert_fingerprint_sha256(req->certificate);
    if (!fp) {
      /* No printable identity means no meaningful prompt: refuse. */
      tls_refuse("[desktop shim] TLS error; certificate unreadable, refusing.");
    } else {
      fprintf(stderr, "\n[desktop shim] TLS refused for %s\n", req->uri);
      fprintf(stderr, "  certificate sha256 %s\n", fp);

      const char *pin = g_getenv("HOTDOG_DESKTOP_TRUST");
      gboolean trust = FALSE;
      if (pin && *pin) {
        if (fp_matches(pin, fp)) {
          fprintf(stderr, "  accepted: matches HOTDOG_DESKTOP_TRUST.\n");
          trust = TRUE;
        } else {
          fprintf(stderr,
                  "  REFUSED: HOTDOG_DESKTOP_TRUST does not match this certificate.\n"
                  "  The cert changed or this is not the machine you think it is.\n"
                  "  Re-pin only if you know the certificate was reissued.\n");
        }
      } else {
        fprintf(stderr, "  Trust this certificate for this host, this session? [yes/N]: ");
        fflush(stderr);
        char line[512] = {0};
        /* stdin is the launcher pipe (closed); the controlling terminal is
         * the operator. No tty and no answer -> refuse, never hang on a
         * ghost. Blocking here is fine: we run from an idle, not from
         * inside a WebKit signal emission. */
        FILE *tty = fopen("/dev/tty", "r");
        FILE *in = tty ? tty : stdin;
        gboolean got = fgets(line, sizeof(line), in) != NULL;
        if (tty) fclose(tty);
        if (got) {
          g_strchomp(line);
          if (g_ascii_strcasecmp(line, "yes") == 0 || g_ascii_strcasecmp(line, "y") == 0 ||
              fp_matches(line, fp)) {
            trust = TRUE;
          } else {
            fprintf(stderr, "  not trusted.\n");
          }
        } else {
          fprintf(stderr, "  no terminal to ask; not trusted.\n"
                          "  (set HOTDOG_DESKTOP_TRUST=<sha256-fingerprint> to pin)\n");
        }
      }

      if (trust) {
        WebKitWebContext *ctx = webkit_web_view_get_context(req->view);
        char *host = uri_host(req->uri);
        if (ctx && host && *host) {
          webkit_web_context_allow_tls_certificate_for_host(ctx, req->certificate, host);
#if HOTDOG_GTK4
          /* 6.0 series: the policy setter is gone from the headers with the
           * rest of the deprecated API, so the host exception is all consent
           * can buy here. If fetch/websocket still fail against a trusted
           * 6.0 host, that is the gap to close (README, ceilings) --
           * unexercised for now. */
#else
          /* See the section header: the per-host exception alone left the
           * page's own connections refusing TLS on 4.1. Consent given ->
           * the session trusts this server, blanket but bounded to this
           * one-origin app. */
          webkit_web_context_set_tls_errors_policy(ctx, WEBKIT_TLS_ERRORS_POLICY_IGNORE);
#endif
          /* Idle context: the failed load has long finished unwinding, so
           * starting the replacement load directly is safe. */
          webkit_web_view_load_uri(req->view, g_url);
        } else {
          char *msg = g_strdup_printf(
              "[desktop shim] could not resolve host from %s; refusing.", req->uri);
          tls_refuse(msg);
          g_free(msg);
        }
        g_free(host);
      } else {
        tls_refuse("[desktop shim] exiting (rerun to be asked again, or pin "
                   "HOTDOG_DESKTOP_TRUST=<sha256-fingerprint>).");
      }
      g_free(fp);
    }
  }
  g_object_unref(req->certificate);
  g_free(req->uri);
  g_free(req);
  return G_SOURCE_REMOVE;
}

static gboolean on_tls_errors(WebKitWebView *view, const gchar *failing_uri,
                              gpointer certificate,
                              G_GNUC_UNUSED int tls_error,
                              G_GNUC_UNUSED gpointer user_data) {
  /* Defer EVERYTHING (fingerprint, prompt, policy, reload) to an idle --
   * see the section header. The certificate must be ref'd to survive the
   * emission; the URI string likewise belongs to the emission. */
  TlsReq *req = g_new(TlsReq, 1);
  req->view = view;
  req->uri = g_strdup((failing_uri && *failing_uri) ? failing_uri : g_url);
  req->certificate = g_object_ref(certificate);
  g_idle_add(handle_tls_request, req);
  return TRUE; /* owned: the idle decides; WebKit's default page never shows */
}

/* Mirror the document title into the window title (the webui's title is a
 * constant today, but a session-named future just works). */
static void on_title_notify(GObject *object, GParamSpec *pspec,
                            gpointer user_data) {
  GtkWindow *window = GTK_WINDOW(user_data);
  /* get_title returns a CONST, internally-owned string (verified against
   * WebKit sources 2.44 and main: `title.data()`). Do NOT g_free it, and do
   * not "fix the leak" -- it does not leak. */
  const char *title = webkit_web_view_get_title(WEBKIT_WEB_VIEW(object));
  gtk_window_set_title(window, (title && *title) ? title : "hotdog");
}

/* --- Unreachable server: real reason, readable page, auto-retry -----------
 * A dead link (internet out, DNS down, tunnel not up yet) fired plain
 * load-failed, which nobody claimed -- WebKit's default page then showed a
 * white window reading "Operation was cancelled." with no cause (field
 * report: a dropped wifi looked like a hung app). Now: print the real
 * GError to the terminal, replace the blank with a page naming the target
 * and the reason, and retry every 3s. The common case -- the link coming
 * back -- heals the window without a relaunch. Both the printed and the
 * rendered URL drop the #tok= fragment (local mode's handoff token has no
 * business appearing on a failure page). Refusal (g_refused) stops the
 * loop; once the real document has committed, later (sub-resource) failures
 * reach the terminal only -- the live app never gets paved over. Claiming
 * the signal (TRUE) keeps WebKit's default page from fighting ours. */

static char *strip_frag(const char *uri) {
  const char *h = strchr(uri, '#');
  return h ? g_strndup(uri, (gsize)(h - uri)) : g_strdup(uri);
}

static void show_failure_page(const char *uri_no_frag, const char *reason) {
  char *esc_uri = g_markup_escape_text(uri_no_frag, -1);
  char *esc_reason = g_markup_escape_text(reason ? reason : "(no details)", -1);
  char *html = g_strdup_printf(
      "<!doctype html><meta charset=utf-8>"
      "<title>hotdog: server unreachable</title>"
      "<body style=\"font:15px/1.6 system-ui,sans-serif;background:#111;"
      "color:#ddd;margin:0;min-height:100vh;display:flex;"
      "align-items:center;justify-content:center\">"
      "<div style=\"max-width:36rem;padding:2rem\">"
      "<h2 style=\"margin:0 0 .5rem\">Can&#39;t reach the server</h2>"
      "<p><code>%s</code></p>"
      "<p style=\"color:#f99\">%s</p>"
      "<p style=\"color:#999\">This window retries every 3 seconds. When the "
      "server answers, the app appears by itself. Quit with Ctrl+C in the "
      "terminal.</p>"
      "</div>",
      esc_uri, esc_reason);
  webkit_web_view_load_html(g_view, html, "about:blank");
  g_free(html);
  g_free(esc_uri);
  g_free(esc_reason);
}

typedef struct {
  char *uri;
  char *reason;
} FailureReq;

static gboolean retry_tick(G_GNUC_UNUSED gpointer data) {
  if (g_committed || g_refused) {
    g_retry_src = 0;
    return G_SOURCE_REMOVE;
  }
  webkit_web_view_load_uri(g_view, g_url);
  return G_SOURCE_CONTINUE;
}

static void arm_retry(void) {
  if (g_retry_src == 0) g_retry_src = g_timeout_add_seconds(3, retry_tick, NULL);
}

/* The page render happens HERE (idle), never inside load-failed: load_html
 * while WebKit is mid-emission is needless re-entrancy; let the failed
 * load finish unwinding first. */
static gboolean idle_show_failure(gpointer data) {
  FailureReq *r = data;
  g_failure_pending = 0;
  if (!g_committed && !g_refused) {
    g_failed_once = 1;
    show_failure_page(r->uri, r->reason);
    arm_retry();
  }
  g_free(r->uri);
  g_free(r->reason);
  g_free(r);
  return G_SOURCE_REMOVE;
}

/* load-failed's REAL arity is (web_view, load_event, failing_uri, error,
 * user_data): the signal is registered with 3 params (LOAD_EVENT, STRING,
 * ERROR) in WebKit sources 2.44 and main -- the reference docs' 2-arg
 * callback signature lies. Match the REGISTRATION: a shifted handler reads
 * the event int as a pointer (field-adjacent: this exact mistake turns any
 * plain load failure into heap chaos). */
static gboolean on_load_failed(G_GNUC_UNUSED WebKitWebView *view,
                               G_GNUC_UNUSED int load_event,
                               gchar *failing_uri, GError *error,
                               G_GNUC_UNUSED gpointer data) {
  char *shown = strip_frag((failing_uri && *failing_uri) ? failing_uri : g_url);
  fprintf(stderr, "[desktop shim] load failed for %s: %s (domain %s, code %d)\n",
          shown, error ? error->message : "(unknown error)",
          g_quark_to_string(error ? error->domain : 0), error ? error->code : 0);
  if (!g_committed && !g_failure_pending) {
    FailureReq *r = g_new(FailureReq, 1);
    r->uri = shown; /* ownership moves to the idle */
    shown = NULL;
    r->reason = g_strdup(error ? error->message : "(unknown error)");
    g_failure_pending = 1;
    g_idle_add(idle_show_failure, r);
  }
  g_free(shown); /* no-op when ownership moved */
  return TRUE;   /* owned: our page, our retry -- never the default one */
}

static void on_load_changed(WebKitWebView *view, WebKitLoadEvent event,
                            G_GNUC_UNUSED gpointer data) {
  if (event != WEBKIT_LOAD_COMMITTED) return;
  /* get_uri returns a CONST, internally-owned pointer (both webkit series:
   * activeURI.data()). The g_free that used to live here is THE bug of this
   * file: it aborted the shim with "free(): invalid size" on the first
   * successful commit -- i.e. right after a TOFU trust reload. Never free
   * it. */
  const char *uri = webkit_web_view_get_uri(view);
  if (uri && (g_str_has_prefix(uri, "http://") || g_str_has_prefix(uri, "https://"))) {
    if (g_failed_once)
      fprintf(stderr, "[desktop shim] server reached, resuming.\n");
    g_committed = 1;
  }
}

int main(int argc, char **argv) {
  if (!fgets(g_url, sizeof(g_url), stdin)) {
    fprintf(stderr, "hotdog-shim: no URL on stdin\n");
    return 1;
  }
  g_url[strcspn(g_url, "\r\n")] = '\0';
  if (g_url[0] == '\0') {
    fprintf(stderr, "hotdog-shim: empty URL on stdin\n");
    return 1;
  }

  /* Parent (the hotdog process) dies -> we get SIGTERM. Must be first: the
   * flag is cleared across exec, and every step below is window dressing. */
  prctl(PR_SET_PDEATHSIG, SIGTERM);
  g_loop = g_main_loop_new(NULL, FALSE); /* before any load: quit callbacks
                                            must find a loop to stop */

#if HOTDOG_GTK4
  gtk_init();
  GtkWidget *window = gtk_window_new();
#else
  gtk_init(&argc, &argv);
  GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  (void)argc; /* consumed by gtk_init on the GTK3 branch only */
  (void)argv;
#endif
  gtk_window_set_title(GTK_WINDOW(window), "hotdog");
  gtk_window_set_default_size(GTK_WINDOW(window), 1280, 800);

  WebKitWebView *view = WEBKIT_WEB_VIEW(webkit_web_view_new());
  g_view = view; /* the retry timer needs it; load_html too */
  WebKitSettings *settings = webkit_web_view_get_settings(view);
  webkit_settings_set_enable_developer_extras(settings, 1); /* gboolean */

  g_signal_connect(view, "create", G_CALLBACK(on_create), NULL);
  g_signal_connect(view, "load-failed", G_CALLBACK(on_load_failed), NULL);
  g_signal_connect(view, "load-failed-with-tls-errors", G_CALLBACK(on_tls_errors), NULL);
  g_signal_connect(view, "load-changed", G_CALLBACK(on_load_changed), NULL);
  g_signal_connect(view, "notify::title", G_CALLBACK(on_title_notify), window);

#if HOTDOG_GTK4
  gtk_window_set_child(GTK_WINDOW(window), GTK_WIDGET(view));
#else
  gtk_container_add(GTK_CONTAINER(window), GTK_WIDGET(view));
#endif
  g_signal_connect(window, "destroy", G_CALLBACK(on_window_destroy), NULL);

  webkit_web_view_load_uri(view, g_url);
#if HOTDOG_GTK4
  gtk_window_present(GTK_WINDOW(window));
#else
  gtk_widget_show_all(window);
#endif
  gtk_widget_grab_focus(GTK_WIDGET(view));

  g_main_loop_run(g_loop);
  return 0;
}
