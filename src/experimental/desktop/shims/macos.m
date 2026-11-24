/*
 * hotdog desktop shim (macOS): one NSWindow + WKWebView pointed at a URL,
 * the Cocoa mirror of shims/linux.c. A dumb terminal: no JS->native bridge,
 * no trust in what the page says. Remote content reaches the same ceiling
 * it would in any browser tab (plus downloads into ~/Downloads, uploads via
 * NSOpenPanel, and external links handed to NSWorkspace).
 *
 * Protocol with the parent (hotdog), same contract as linux.c:
 *   - The app URL (with its #tok= handoff fragment) arrives on stdin's
 *     FIRST LINE, NEVER argv: argv is world-readable (ps), and in local
 *     mode the URL carries the session token.
 *   - Quit when the window closes; the parent reads that as the app-quit
 *     signal and drains its agent sessions before exiting too.
 *   - There is no PR_SET_PDEATHSIG on macOS: a getppid() watchdog polls
 *     every second, and a changed ppid means the launcher died uncleanly
 *     (a SIGKILLed parent's children adopt to launchd) -> we go down
 *     rather than sit on a dead server. The SIGTERM default kill covers
 *     the clean path.
 *
 * What this file adds over a bare WKWebView window:
 *   - setActivationPolicy:Regular. A bare CLT-compiled binary is a
 *     background process by default: no focused window, no Dock presence,
 *     no keyboard focus. Without this line the app "shows nothing".
 *   - External links: same-origin (and same-origin blob:) main-frame loads
 *     pass; anything else is cancelled and handed to NSWorkspace, and
 *     new-window requests are refused -- WKWebView never spawns a second
 *     window (linux.c's create refusal), so target=_blank becomes the
 *     user's real browser.
 *   - Downloads: unlike webkit2gtk >= 2.42, WKWebView downloads ONLY when
 *     the client asks: the policy delegates turn `shouldPerformDownload`
 *     actions and non-displayable main-frame responses into a WKDownload
 *     (the entire WKDownload API is macOS 11.3+, which is why the min
 *     target is 11.3), and the WKDownloadDelegate destination lands it in
 *     ~/Downloads with the suggested name, uniquified -- no save panel
 *     (v1 parity with the Linux ceiling). The delegate docs' "destination
 *     must not already exist" rule is honored by a "name 2.ext" loop.
 *   - Uploads + JS dialogs: WKWebView routes file pickers to the UI
 *     delegate (unimplemented = auto-CANCEL, silently) and JS confirm() to
 *     the UI delegate too (unimplemented = auto-CANCEL). The webui uses
 *     confirm() for deletions and the exec fence, and file inputs for
 *     uploads, so NSOpenPanel / NSAlert are implemented here; this is why
 *     the macOS rung carries a native dialog where linux.c has none
 *     (GTK embeds both).
 *   - TLS TOFU: didReceiveAuthenticationChallenge (ServerTrust) prints the
 *     leaf certificate's SHA-256 (openssl-style, DER-based -- the same
 *     fingerprint as linux.c) to stderr and asks once on /dev/tty;
 *     HOTDOG_DESKTOP_TRUST=<fp> skips the ask, and a pin that does NOT
 *     match refuses WITHOUT asking. Consent lives for the session
 *     (fingerprints in memory). Unlike webkit2gtk's host-exception gap,
 *     WKWebView routes every load -- the document and its subresources
 *     (downloads challenge through their own delegate) -- through this
 *     same TOFU gate, so one yes covers the whole app; no ignore-policy
 *     equivalent exists or is needed. Refusal exits 1.
 *   - Unreachable target: the real error prints to THIS terminal, the
 *     window shows a readable failure page instead of nothing, and the
 *     URL retries every 3s until the first COMMITTED.
 *   - ATS: WKWebView applies App Transport Security to an unbundled
 *     binary, which refuses http -- local mode's http://127.0.0.1:<port>
 *     and ssh -L tunnels would never load. The launcher embeds
 *     NSAllowsLocalNetworking into __TEXT,__info_plist at link time;
 *     everything non-loopback keeps the full ATS posture.
 *
 * Build (done by launcher.ts, cached under the hotdog data dir, then
 * ad-hoc codesigned -- Apple Silicon refuses to launch WKWebProcess
 * against an unsigned main binary):
 *   clang -fobjc-arc -mmacosx-version-min=11.3 -framework Cocoa \
 *       -framework WebKit -framework Security -o shim macos.m \
 *       -Wl,-sectcreate,__TEXT,__info_plist,<ats.plist>
 * Delegate signatures were taken from the WebKit headers (WKNavigation-
 * Delegate.h / WKDownloadDelegate.h / WKDownload.h / WKUIDelegate.h), not
 * the reference docs -- the linux.c lesson applied. The -mmacosx-version-
 * min makes the compiler reject any newer-than-target API use instead of
 * letting it surface as a runtime crash.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#import <Cocoa/Cocoa.h>
#import <Security/Security.h>
#import <WebKit/WebKit.h>
#import <CommonCrypto/CommonDigest.h>
#import <objc/message.h> /* the legacy -openURL: msgSend (see openExternal) */

#define URL_MAX 8192

static NSString *gUrl = nil;
/* Normalized "scheme://host:port" of the app server; the navigation gate
 * is "same origin as this, or one of our own loads". Re-based on every
 * committed http(s) load so a legitimate same-origin server port shift
 * does not external-open the app from itself. */
static NSString *gTargetOrigin = nil;
static WKWebView *gWebView = nil;
static BOOL gCommitted = NO;
static BOOL gFailedOnce = NO;
/* Our own programmatic loads (initial, failure page, retry, TLS reload)
 * are not page-driven navigation: they bypass the origin gate once.
 * Cleared at the policy decision or the provisional start. */
static BOOL gSelfLoad = NO;
static NSString *gInitialPpid = nil;
static dispatch_source_t gWatchdog = nil;
static dispatch_source_t gRetryTimer = nil;
/* Fingerprints trusted this session (memory only, never persisted). */
static NSMutableArray<NSString *> *gTrustedFps = nil;
/* Chosen destination per in-flight download (weak keys: the download owns
 * itself), so didFinish can name the file it wrote. */
static NSMapTable<WKDownload *, NSString *> *gDownloadPaths = nil;

/* ── small helpers ─────────────────────────────────────────────────────── */

static NSString *stripFragment(NSString *uri) {
  NSRange h = [uri rangeOfString:@"#" options:NSLiteralSearch];
  return h.location == NSNotFound ? uri : [uri substringToIndex:h.location];
}

static NSString *htmlEscape(NSString *s) {
  NSMutableString *o = [(s ?: @"") mutableCopy];
  NSArray<NSString *> *pairs =
      @[ @"&", @"&amp;", @"<", @"&lt;", @">", @"&gt;", @"\"", @"&quot;" ];
  for (NSUInteger i = 0; i < pairs.count; i += 2)
    [o replaceOccurrencesOfString:pairs[i]
                       withString:pairs[i + 1]
                          options:NSLiteralSearch
                            range:NSMakeRange(0, o.length)];
  return o;
}

/* Normalized origin: lowercase scheme/host, explicit port (defaults
 * filled), IPv6 brackets stripped. nil for anything not http(s) -- mailto,
 * file, data, and friends are external by definition here. */
static NSString *originOfUrl(NSURL *url) {
  NSString *scheme = url.scheme.lowercaseString;
  if (![scheme isEqualToString:@"http"] && ![scheme isEqualToString:@"https"]) return nil;
  NSString *host = url.host.lowercaseString;
  if (host.length == 0) return nil;
  if ([host hasPrefix:@"["] && [host hasSuffix:@"]"])
    host = [host substringWithRange:NSMakeRange(1, host.length - 2)];
  NSString *port = url.port.stringValue;
  if (port.length == 0) port = [scheme isEqualToString:@"https"] ? @"443" : @"80";
  return [NSString stringWithFormat:@"%@://%@:%@", scheme, host, port];
}

/* blob: URLs inherit the creating document's origin ("blob:http://host/"
 * uuid"): a same-server blob (webui export) is same-origin, everything
 * else is external. */
static BOOL urlIsSameOrigin(NSURL *url) {
  NSString *origin = originOfUrl(url);
  if (origin && gTargetOrigin) {
    if ([origin isEqualToString:gTargetOrigin]) return YES;
  }
  if ([url.scheme.lowercaseString isEqualToString:@"blob"]) {
    NSString *inner = [url.absoluteString hasPrefix:@"blob:"]
        ? [url.absoluteString substringFromIndex:5]
        : nil;
    NSString *innerOrigin = originOfUrl([NSURL URLWithString:inner]);
    if (innerOrigin && gTargetOrigin && [innerOrigin isEqualToString:gTargetOrigin]) return YES;
  }
  return NO;
}

static void openExternal(NSURL *url) {
  if (!url) return;
  void (^report)(BOOL) = ^(BOOL success) {
    if (!success)
      fprintf(stderr, "[desktop shim] the system browser refused: %s\n",
              (url.absoluteString ?: @"?").UTF8String);
  };
  /* -openURL:completionHandler: is gone from the macOS 26 SDK headers; the
   * replacement -openURL:configuration:completionHandler: is macOS 12+. The
   * 11.x fallback rides the legacy synchronous -openURL: through
   * objc_msgSend, so this compiles even where newer SDKs dropped the
   * declaration, and runs everywhere in the deployment range. */
  if (@available(macOS 12.0, *)) {
    [[NSWorkspace sharedWorkspace] openURL:url
                             configuration:@{}
                         completionHandler:report];
    return;
  }
  NSWorkspace *ws = [NSWorkspace sharedWorkspace];
  if ([ws respondsToSelector:@selector(openURL:)]) {
    report(((BOOL (*)(id, SEL, id))objc_msgSend)(ws, @selector(openURL:), url));
  } else {
    report(NO);
  }
}

/* SHA-256 of the leaf DER, openssl-style "AA:BB:..." uppercase -- the same
 * string shape (and the same source of truth, the DER) as linux.c's
 * fingerprint, so one `openssl x509 -fingerprint -sha256` output works on
 * both platforms, and HOTDOG_DESKTOP_TRUST means the same thing here. */
static NSString *tlsFingerprint(SecTrustRef trust) {
  /* SecTrustCopyCertificateChain is macOS 12+ while this binary deploys to
   * 11.3: an unguarded call is a null-symbol crash on 11.x. Only the leaf
   * is ever read, so the legacy count/index pair covers the fallback. */
  CFArrayRef chain = NULL;
  if (@available(macOS 12.0, *)) {
    chain = SecTrustCopyCertificateChain(trust);
  } else if (SecTrustGetCertificateCount(trust) > 0) {
    const void *leafOnly[1] = { SecTrustGetCertificateAtIndex(trust, 0) };
    chain = CFArrayCreate(NULL, leafOnly, 1, &kCFTypeArrayCallBacks);
  }
  if (!chain) return nil;
  NSString *fp = nil;
  if (CFArrayGetCount(chain) > 0) {
    SecCertificateRef leaf = (SecCertificateRef)CFArrayGetValueAtIndex(chain, 0);
    CFDataRef der = SecCertificateCopyData(leaf);
    if (der) {
      unsigned char md[CC_SHA256_DIGEST_LENGTH];
      CC_SHA256(CFDataGetBytePtr(der), (CC_LONG)CFDataGetLength(der), md);
      NSMutableString *s = [NSMutableString stringWithCapacity:95];
      for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) {
        if (i) [s appendString:@":"];
        [s appendFormat:@"%02X", (unsigned)md[i]];
      }
      fp = [s copy];
      CFRelease(der);
    }
  }
  CFRelease(chain);
  return fp;
}

/* Compare a user/pin entry against the printed fingerprint: case-
 * insensitive, colons/spaces optional, "sha256:"/"sha256/" prefix
 * tolerated, empty never matches. (linux.c's fp_matches, same rules.) */
static BOOL fpMatches(NSString *candidate, NSString *fp) {
  if (candidate.length == 0) return NO;
  NSString *c = candidate;
  if ([c.lowercaseString hasPrefix:@"sha256:"]) c = [c substringFromIndex:7];
  if ([c.lowercaseString hasPrefix:@"sha256/"]) c = [c substringFromIndex:7];
  NSMutableString *norm = [NSMutableString string];
  for (NSUInteger i = 0; i < c.length; i++) {
    unichar ch = [c characterAtIndex:i];
    if (ch == ':' || ch == ' ' || ch == '\n' || ch == '\r' || ch == '\t') continue;
    [norm appendFormat:@"%C", ch];
  }
  return norm.length > 0 && [norm caseInsensitiveCompare:fp] == NSOrderedSame;
}

/* The TOFU decision, shared by the webview's challenges and the downloads'
 * (WKWebView routes the document AND its subresources through a challenge;
 * each challenge path hands us a fresh opportunity, so the consent answer
 * lives in gTrustedFps). Prints exactly the linux.c protocol:
 * HOTDOG_DESKTOP_TRUST matching skips the ask; a mismatching pin refuses
 * WITHOUT asking; no terminal means no trust; refusal exits 1 -- a window
 * with nothing to show is a white-screen mystery, an exited app plus a
 * terminal reason is not. Call on the main queue, never inside WebKit's
 * callback machinery. */
static BOOL tofuDecideTrust(SecTrustRef trust, NSString *where) {
  NSString *fp = tlsFingerprint(trust);
  if (!fp) {
    /* No printable identity means no meaningful prompt: refuse. */
    fprintf(stderr, "[desktop shim] TLS error; certificate unreadable, refusing.\n"
                    "[desktop shim] exiting.\n");
    exit(1);
  }
  if ([gTrustedFps containsObject:fp]) return YES; /* consented earlier this session */
  BOOL trustIt = NO;
  fprintf(stderr, "\n[desktop shim] TLS refused for %s\n  certificate sha256 %s\n",
          where.UTF8String, fp.UTF8String);
  const char *pin = getenv("HOTDOG_DESKTOP_TRUST");
  if (pin && *pin) {
    if (fpMatches([NSString stringWithUTF8String:pin], fp)) {
      fprintf(stderr, "  accepted: matches HOTDOG_DESKTOP_TRUST.\n");
      trustIt = YES;
    } else {
      fprintf(stderr,
              "  REFUSED: HOTDOG_DESKTOP_TRUST does not match this certificate.\n"
              "  The cert changed or this is not the machine you think it is.\n"
              "  Re-pin only if you know the certificate was reissued.\n");
    }
  } else {
    fprintf(stderr, "  Trust this certificate for this host, this session? [yes/N]: ");
    fflush(stderr);
    /* stdin is the launcher pipe (closed); the controlling terminal is
     * the operator. No tty and no answer -> refuse, never hang on a
     * ghost. */
    FILE *tty = fopen("/dev/tty", "r");
    FILE *in = tty ? tty : stdin;
    char line[512] = {0};
    BOOL got = fgets(line, sizeof(line), in) != NULL;
    if (tty) fclose(tty);
    if (got) {
      NSString *answer = [[[NSString stringWithUTF8String:line]
          stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet]
          lowercaseString];
      if ([answer isEqualToString:@"yes"] || [answer isEqualToString:@"y"] ||
          fpMatches(answer, fp)) {
        trustIt = YES;
      } else {
        fprintf(stderr, "  not trusted.\n");
      }
    } else {
      fprintf(stderr, "  no terminal to ask; not trusted.\n"
                      "  (set HOTDOG_DESKTOP_TRUST=<sha256-fingerprint> to pin)\n");
    }
  }
  if (trustIt) {
    [gTrustedFps addObject:fp];
    return YES;
  }
  fprintf(stderr, "[desktop shim] exiting (rerun to be asked again, or pin "
                  "HOTDOG_DESKTOP_TRUST=<sha256-fingerprint>).\n");
  exit(1);
}

/* ── unreachable server: readable page + 3s retry until first COMMITTED ── */

static void armRetry(void) {
  if (gRetryTimer) return;
  gRetryTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
  dispatch_source_set_timer(gRetryTimer, dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC),
                            3 * NSEC_PER_SEC, NSEC_PER_SEC / 10);
  dispatch_source_set_event_handler(gRetryTimer, ^{
    if (gCommitted) {
      dispatch_source_cancel(gRetryTimer);
      gRetryTimer = nil;
      return;
    }
    gSelfLoad = YES;
    [gWebView loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:gUrl]]];
  });
  dispatch_resume(gRetryTimer);
}

static void showFailurePage(NSString *reason) {
  NSString *html = [NSString stringWithFormat:
      @"<!doctype html><meta charset=utf-8>"
      @"<title>hotdog: server unreachable</title>"
      @"<body style=\"font:15px/1.6 system-ui,sans-serif;background:#111;"
      @"color:#ddd;margin:0;min-height:100vh;display:flex;"
      @"align-items:center;justify-content:center\">"
      @"<div style=\"max-width:36rem;padding:2rem\">"
      @"<h2 style=\"margin:0 0 .5rem\">Can&#39;t reach the server</h2>"
      @"<p><code>%@</code></p>"
      @"<p style=\"color:#f99\">%@</p>"
      @"<p style=\"color:#999\">This window retries every 3 seconds. When the "
      @"server answers, the app appears by itself. Quit with Ctrl+C in the "
      @"terminal.</p>"
      @"</div>",
      htmlEscape(stripFragment(gUrl)), htmlEscape(reason)];
  gSelfLoad = YES;
  [gWebView loadHTMLString:html baseURL:nil]; /* nil base => about:blank */
}

/* ── the window's delegate: navigation, downloads, TOFU, failure ───────── */

@interface HotdogDelegate : NSObject <NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate,
                                       WKDownloadDelegate>
@property(strong) NSWindow *window;
@end

@implementation HotdogDelegate

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
  (void)sender;
  return YES; /* window close = app quit; WillTerminate below makes it exit(0) */
}

- (void)applicationWillTerminate:(NSNotification *)notification {
  (void)notification;
  exit(0); /* the parent reads the process exit as "window gone" and drains */
}

/* KVO on webView.title: mirror the document title into the window title
 * (the webui's is a constant today; a session-named future just works).
 * The KVO value is WKWebView's own -- read-only use, nothing to free (the
 * linux.c const-getter lesson). */
- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary<NSKeyValueChangeKey, id> *)change
                       context:(void *)context {
  (void)change;
  (void)context;
  if ([keyPath isEqualToString:@"title"] && object == gWebView) {
    NSString *title = gWebView.title;
    [self.window setTitle:(title.length ? title : @"hotdog")];
    return;
  }
  [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
}

/* One-window app: anything asking for a second window goes to the system
 * browser (if there is a URL) and nil -- refused (the header's default for
 * unimplemented is "cancel"; we add the browser handoff). The app page
 * never becomes a browser (linux.c's create refusal, same ceiling). */
- (WKWebView *)webView:(WKWebView *)webView
    createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
               forNavigationAction:(WKNavigationAction *)navigationAction
                    windowFeatures:(WKWindowFeatures *)windowFeatures {
  (void)webView;
  (void)configuration;
  (void)windowFeatures;
  NSURL *url = navigationAction.request.URL;
  if (url) {
    fprintf(stderr, "[desktop shim] popup -> system browser: %s\n",
            (url.absoluteString ?: @"?").UTF8String);
    openExternal(url);
  }
  return nil;
}

/* Main frame: allow same-origin loads (and same-origin blob:); anything
 * else (off-origin sites, mailto:, file:, ...) is cancelled and opened in
 * the user's real browser. Subframes: same-origin passes, off-origin
 * cancels silently (linux.c parity: the window never browses). Our own
 * loads bypass once. A same-origin `download`-attribute click goes
 * straight to the download flow (the header: didBecomeDownload fires
 * "after using WKNavigationActionPolicyDownload"). */
- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction
                    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
  (void)webView;
  BOOL selfLoad = gSelfLoad;
  gSelfLoad = NO;
  NSURL *url = navigationAction.request.URL;
  if (selfLoad || urlIsSameOrigin(url)) {
    decisionHandler(navigationAction.shouldPerformDownload ? WKNavigationActionPolicyDownload
                                                           : WKNavigationActionPolicyAllow);
    return;
  }
  decisionHandler(WKNavigationActionPolicyCancel);
  WKFrameInfo *frame = navigationAction.targetFrame;
  if (frame == nil || frame.isMainFrame) {
    fprintf(stderr, "[desktop shim] external link -> system browser: %s\n",
            (url.absoluteString ?: @"?").UTF8String);
    openExternal(url);
  }
}

/* Response gate: off-origin responses (server redirects that left the
 * app) cancel and hand off; displayable same-origin content loads; a
 * NON-displayable MAIN-frame response is what a file download looks like
 * to WebKit, and becomes a WKDownload -- the class only exists because we
 * ask for it (11.3+). Subframe non-displayables allow through: blank
 * instead of surprising, never a browser trip. */
- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationResponse:(WKNavigationResponse *)navigationResponse
                      decisionHandler:(void (^)(WKNavigationResponsePolicy))decisionHandler {
  (void)webView;
  NSURL *url = navigationResponse.response.URL;
  if (!urlIsSameOrigin(url)) {
    decisionHandler(WKNavigationResponsePolicyCancel);
    if (navigationResponse.forMainFrame) {
      fprintf(stderr, "[desktop shim] off-origin response -> system browser: %s\n",
              (url.absoluteString ?: @"?").UTF8String);
      openExternal(url);
    }
    return;
  }
  if (navigationResponse.canShowMIMEType || !navigationResponse.forMainFrame) {
    decisionHandler(WKNavigationResponsePolicyAllow);
    return;
  }
  decisionHandler(WKNavigationResponsePolicyDownload);
}

- (void)webView:(WKWebView *)webView didStartProvisionalNavigation:(null_unspecified WKNavigation *)navigation {
  (void)navigation;
  gSelfLoad = NO; /* past the policy check either way */
}

- (void)webView:(WKWebView *)webView didCommitNavigation:(null_unspecified WKNavigation *)navigation {
  (void)navigation;
  NSString *uri = webView.URL.absoluteString ?: @"";
  if ([uri hasPrefix:@"http://"] || [uri hasPrefix:@"https://"]) {
    if (gFailedOnce) fprintf(stderr, "[desktop shim] server reached, resuming.\n");
    NSString *origin = originOfUrl(webView.URL);
    if (origin) gTargetOrigin = origin; /* same-family redirect re-bases the gate */
    gCommitted = YES;
  }
}

/* The main-frame provisional load died (link down, DNS dead, tunnel not
 * up). Print the real cause, and until the first commit replace the blank
 * window with a readable page and keep retrying. After the first commit
 * the app handles its own reconnects; we only log. */
- (void)webView:(WKWebView *)webView
    didFailProvisionalNavigation:(null_unspecified WKNavigation *)navigation
                       withError:(NSError *)error {
  (void)navigation;
  fprintf(stderr, "[desktop shim] load failed for %s: %s (domain %s, code %ld)\n",
          stripFragment(gUrl).UTF8String,
          (error.localizedDescription ?: @"(unknown error)").UTF8String,
          (error.domain ?: @"?").UTF8String,
          (long)error.code);
  if (!gCommitted) {
    gFailedOnce = YES;
    showFailurePage(error.localizedDescription ?: @"(unknown error)");
    armRetry();
  }
}

/* --- downloads (WKDownload, macOS 11.3+) ----------------------------------
 * See the policy methods above for how a download comes into existence.
 * The delegate's destination must not point at an existing file (header
 * contract), so names get the classic uniquifier. ~/Downloads with the
 * server's suggested name, no save panel (v1 ceiling, same posture as
 * Linux's silent default). Untrusted TLS during a download challenges
 * HERE, on the download's own delegate -- same TOFU gate. */

- (void)webView:(WKWebView *)webView
        navigationAction:(WKNavigationAction *)navigationAction
      didBecomeDownload:(WKDownload *)download {
  (void)webView;
  (void)navigationAction;
  download.delegate = self;
}

- (void)webView:(WKWebView *)webView
        navigationResponse:(WKNavigationResponse *)navigationResponse
         didBecomeDownload:(WKDownload *)download {
  (void)webView;
  (void)navigationResponse;
  download.delegate = self;
}

- (void)download:(WKDownload *)download
    decideDestinationUsingResponse:(NSURLResponse *)response
                 suggestedFilename:(NSString *)suggestedFilename
                 completionHandler:(void (^)(NSURL *_Nullable destination))completionHandler {
  NSString *name = suggestedFilename.lastPathComponent; /* no path traversal */
  if (!name.length) name = response.suggestedFilename.lastPathComponent;
  if (!name.length) name = @"download";
  NSFileManager *fm = NSFileManager.defaultManager;
  NSURL *dir = [[fm URLsForDirectory:NSDownloadsDirectory inDomains:NSUserDomainMask] firstObject];
  if (!dir) {
    completionHandler(nil); /* nowhere to put it: cancel rather than fail odd */
    return;
  }
  NSURL *dest = [dir URLByAppendingPathComponent:name];
  NSString *stem = dest.URLByDeletingPathExtension.lastPathComponent;
  NSString *ext = dest.pathExtension;
  for (int i = 2; [fm fileExistsAtPath:dest.path] && i < 1000; i++) {
    NSString *candidate = [NSString stringWithFormat:@"%@ %d", stem, i];
    dest = ext.length ? [[dir URLByAppendingPathComponent:candidate] URLByAppendingPathExtension:ext]
                      : [dir URLByAppendingPathComponent:candidate];
  }
  [gDownloadPaths setObject:dest.path forKey:download];
  completionHandler(dest);
}

- (void)downloadDidFinish:(WKDownload *)download {
  fprintf(stderr, "[desktop shim] downloaded: %s\n",
          ([gDownloadPaths objectForKey:download] ?: @"?").UTF8String);
  [gDownloadPaths removeObjectForKey:download];
}

- (void)download:(WKDownload *)download
    didFailWithError:(NSError *)error
          resumeData:(NSData *)resumeData {
  (void)resumeData; /* no resume store in v1; retry is the user's click */
  fprintf(stderr, "[desktop shim] download failed (%s); continuing.\n",
          (error.localizedDescription ?: @"?").UTF8String);
  [gDownloadPaths removeObjectForKey:download];
}

/* Untrusted TLS on a download: same TOFU gate, but there is no reload to
 * do -- useCredential resumes THIS connection. */
- (void)download:(WKDownload *)download
    didReceiveAuthenticationChallenge:(NSURLAuthenticationChallenge *)challenge
                    completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition,
                                               NSURLCredential *_Nullable))completionHandler {
  (void)download;
  NSString *method = challenge.protectionSpace.authenticationMethod;
  SecTrustRef _Nullable maybeTrust =
      (__bridge SecTrustRef _Nullable)challenge.protectionSpace.serverTrust;
  if (![method isEqualToString:NSURLAuthenticationMethodServerTrust] || !maybeTrust) {
    completionHandler(NSURLSessionAuthChallengePerformDefaultHandling, nil);
    return;
  }
  SecTrustRef trust = maybeTrust; /* flow-guarded: nonnull past the nil check */
  NSString *where = [self challengeWhere:challenge];
  dispatch_async(dispatch_get_main_queue(), ^{
    if (tofuDecideTrust(trust, where)) {
      completionHandler(NSURLSessionAuthChallengeUseCredential,
                        [NSURLCredential credentialForTrust:trust]);
    } /* refusal exits in tofuDecideTrust */
  });
}

- (NSString *)challengeWhere:(NSURLAuthenticationChallenge *)challenge {
  NSString *host = challenge.protectionSpace.host ?: @"(unknown host)";
  NSInteger port = challenge.protectionSpace.port; /* NSURLProtectionSpace: 0 = unknown */
  return (port != 0 && port != 443)
      ? [NSString stringWithFormat:@"https://%@:%ld", host, (long)port]
      : [NSString stringWithFormat:@"https://%@", host];
}

/* --- TLS trust: terminal TOFU for self-signed intranet certs --------------
 * Same protocol as linux.c's on_tls_errors, simpler machinery: nothing is
 * decided inside WebKit's callback -- the completion handler is held, and
 * the fingerprint/prompt/decision runs on the main queue (deferring is the
 * documented async-challenge pattern; the handler stays valid across
 * runloop turns). The prompt blocks on fgets exactly like the Linux idle
 * does. On trust, useCredential resolves the challenged connection; the
 * lost main load re-issues with the consented certificate (same posture
 * as linux.c's reload), and every later challenge -- subresources included,
 * WKWebView routes ALL loads here, no webkit2gtk-style host-exception gap
 * and no ignore-policy equivalent -- passes the gTrustedFps check without
 * a second prompt. */

- (void)webView:(WKWebView *)webView
    didReceiveAuthenticationChallenge:(NSURLAuthenticationChallenge *)challenge
                    completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition,
                                               NSURLCredential *_Nullable))completionHandler {
  (void)webView;
  NSString *method = challenge.protectionSpace.authenticationMethod;
  SecTrustRef _Nullable maybeTrust =
      (__bridge SecTrustRef _Nullable)challenge.protectionSpace.serverTrust;
  if (![method isEqualToString:NSURLAuthenticationMethodServerTrust] || !maybeTrust) {
    completionHandler(NSURLSessionAuthChallengePerformDefaultHandling, nil);
    return;
  }
  SecTrustRef trust = maybeTrust; /* flow-guarded: nonnull past the nil check */
  NSString *where = [self challengeWhere:challenge];
  dispatch_async(dispatch_get_main_queue(), ^{
    if (tofuDecideTrust(trust, where)) {
      completionHandler(NSURLSessionAuthChallengeUseCredential,
                        [NSURLCredential credentialForTrust:trust]);
      /* The lost provisional load does not resurrect itself: re-issue with
       * the certificate now consented (same posture as linux.c). */
      gSelfLoad = YES;
      [gWebView loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:gUrl]]];
    } /* refusal exits in tofuDecideTrust */
  });
}

/* --- native bits the webui needs that WebKit does not provide itself ------
 * macOS routes file pickers and JS dialogs to the UI delegate; the
 * defaults are silent auto-Cancel, which would kill uploads and every
 * confirm() in the webui (deletions, the exec fence). linux.c gets both
 * for free from GTK; here they are NSOpenPanel + NSAlert, no more. */

- (void)webView:(WKWebView *)webView
    runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters
              initiatedByFrame:(WKFrameInfo *)frame
             completionHandler:(void (^)(NSArray<NSURL *> *_Nullable URLs))completionHandler {
  (void)frame;
  NSOpenPanel *panel = [NSOpenPanel openPanel];
  panel.canChooseFiles = YES;
  panel.canChooseDirectories = parameters.allowsDirectories;
  panel.allowsMultipleSelection = parameters.allowsMultipleSelection;
  [panel beginWithCompletionHandler:^(NSModalResponse result) {
    completionHandler(result == NSModalResponseOK ? panel.URLs : nil);
  }];
}

- (void)webView:(WKWebView *)webView
    runJavaScriptAlertPanelWithMessage:(NSString *)message
                      initiatedByFrame:(WKFrameInfo *)frame
                     completionHandler:(void (^)(void))completionHandler {
  (void)frame;
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = message ?: @"";
  [alert addButtonWithTitle:@"OK"];
  [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse) {
    completionHandler();
  }];
}

- (void)webView:(WKWebView *)webView
    runJavaScriptConfirmPanelWithMessage:(NSString *)message
                        initiatedByFrame:(WKFrameInfo *)frame
                       completionHandler:(void (^)(BOOL))completionHandler {
  (void)frame;
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = message ?: @"";
  [alert addButtonWithTitle:@"OK"];
  [alert addButtonWithTitle:@"Cancel"];
  [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
    completionHandler(response == NSAlertFirstButtonReturn);
  }];
}

@end

/* ── window, watchdog, menu, main ───────────────────────────────────────── */

/* No PDEATHSIG on macOS: poll getppid(). Changed == reparented == the
 * launcher is gone (SIGKILL leaves no time for our SIGTERM story); a
 * closed window just closes the app. */
static void installParentWatchdog(void) {
  gWatchdog = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
  dispatch_source_set_timer(gWatchdog, dispatch_time(DISPATCH_TIME_NOW, 1 * NSEC_PER_SEC),
                            1 * NSEC_PER_SEC, NSEC_PER_SEC / 4);
  dispatch_source_set_event_handler(gWatchdog, ^{
    if (![gInitialPpid isEqualToString:[NSString stringWithFormat:@"%d", getppid()]]) {
      fprintf(stderr, "[desktop shim] launcher gone; exiting.\n");
      exit(0);
    }
  });
  dispatch_resume(gWatchdog);
}

/* Bare binaries have no nibs: this menu is what makes Cmd-Q/Cmd-W real
 * key equivalents (the activation policy alone gets the window focused,
 * not the shortcuts). */
static void installMenu(void) {
  NSMenu *mainMenu = [[NSMenu alloc] initWithTitle:@"hotdog"];
  NSMenuItem *appItem = [[NSMenuItem alloc] initWithTitle:@"hotdog" action:NULL keyEquivalent:@""];
  NSMenu *appMenu = [[NSMenu alloc] initWithTitle:@"hotdog"];
  [appMenu addItemWithTitle:@"Quit hotdog" action:@selector(terminate:) keyEquivalent:@"q"];
  appItem.submenu = appMenu;
  [mainMenu addItem:appItem];
  NSMenuItem *fileItem = [[NSMenuItem alloc] initWithTitle:@"File" action:NULL keyEquivalent:@""];
  NSMenu *fileMenu = [[NSMenu alloc] initWithTitle:@"File"];
  [fileMenu addItemWithTitle:@"Close Window" action:@selector(performClose:) keyEquivalent:@"w"];
  fileItem.submenu = fileMenu;
  [mainMenu addItem:fileItem];
  NSApp.mainMenu = mainMenu;
}

int main(int argc, char **argv) {
  (void)argc;
  (void)argv;
  char buf[URL_MAX];
  if (!fgets(buf, sizeof(buf), stdin)) {
    fprintf(stderr, "hotdog-shim: no URL on stdin\n");
    return 1;
  }
  buf[strcspn(buf, "\r\n")] = '\0';
  if (buf[0] == '\0') {
    fprintf(stderr, "hotdog-shim: empty URL on stdin\n");
    return 1;
  }
  gUrl = [NSString stringWithUTF8String:buf];
  gTargetOrigin = originOfUrl([NSURL URLWithString:gUrl]);
  if (!gTargetOrigin) {
    fprintf(stderr, "hotdog-shim: URL must be http(s)\n");
    return 1;
  }
  gInitialPpid = [NSString stringWithFormat:@"%d", getppid()];
  gTrustedFps = [NSMutableArray new];
  gDownloadPaths = [NSMapTable weakToStrongObjectsMapTable];

  HotdogDelegate *delegate = [HotdogDelegate new];
  NSApplication *app = [NSApplication sharedApplication];
  app.delegate = delegate;
  /* Regular, not the default Prohibited a bundleless CLT binary gets:
     without it the window lands unfocused behind everything -- "nothing
     happened" from the user's seat. */
  [app setActivationPolicy:NSApplicationActivationPolicyRegular];
  installMenu();

  NSWindow *window = [[NSWindow alloc]
      initWithContentRect:NSMakeRect(0, 0, 1280, 800)
                styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                           NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable)
                  backing:NSBackingStoreBuffered
                    defer:NO];
  [window setTitle:@"hotdog"];
  [window center];
  delegate.window = window;

  WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
  config.dataStore = [WKWebsiteDataStore nonPersistentDataStore]; /* v1 ephemerality,
      parity with the Linux shim's non-persistent web context: local mode re-mints
      the #tok= handoff every boot; remote mode re-logs in every launch (ceiling). */
  WKWebView *webView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 1280, 800)
                                          configuration:config];
  gWebView = webView;
  webView.navigationDelegate = delegate;
  webView.UIDelegate = delegate;
  [webView addObserver:delegate forKeyPath:@"title" options:0 context:NULL];
  /* inspectable: right-click inspect, the WKWebView form of linux.c's
   * developer_extras. SDK-macro-guarded so older CLT headers compile too
   * (the two spellings ship in the same 13.3+ SDK that declares the
   * property; an absent macro just means the feature is off, never a
   * build break). */
#if defined(MAC_OS_VERSION_13_3) || defined(MAC_VERSION_13_3)
  if (@available(macOS 13.3, *)) webView.inspectable = YES;
#endif

  [window setContentView:webView];
  [window makeKeyAndOrderFront:nil];
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  [NSApp activateIgnoringOtherApps:YES]; /* still the way on SDKs without activate */
#pragma clang diagnostic pop

  installParentWatchdog();

  gSelfLoad = YES;
  [webView loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:gUrl]]];
  [app run]; /* returns only via terminate: -> WillTerminate -> exit(0) */
  return 0;
}
