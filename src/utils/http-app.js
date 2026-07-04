// http-app.js — A minimal Express-like middleware framework for Bun.serve().
//
// Provides app.use(), app.get(), app.post(), etc. with middleware chaining,
// path prefix mounting, app nesting, req.locals, and error/404 handling.
//
// Usage:
//   const app = createHttpApp()
//   app.use(loggerMiddleware)
//   app.get('/', (req, res) => res.send('hello'))
//   const server = Bun.serve({ port: 3000, fetch: app.handler })

/**
 * Create a new HTTP app instance with an empty middleware stack.
 *
 * @returns {Object} app — The application object with use(), get(), post(), etc.
 */
export function createHttpApp() {
  const stack = [];
  const app = {};

  /**
   * Push a middleware function onto the stack.
   * Optionally mount under a path prefix.
   *
   * @param {string|Function} pathOrFn — Path prefix string or middleware function
   * @param {Function} [fn] — Middleware function (required if pathOrFn is a string)
   * @returns {Object} app — The app instance for chaining
   */
  app.use = function use(pathOrFn, fn) {
    if (typeof pathOrFn === "function") {
      stack.push(pathOrFn);
    } else {
      stack.push(mountPathPrefix(pathOrFn, fn));
    }
    return app;
  };

  /**
   * Wrap a middleware function so it only runs when req.path starts with prefix.
   * When matched, req.path is adjusted to strip the prefix for the inner handler.
   *
   * @param {string} prefix
   * @param {Function} fn
   * @returns {Function}
   */
  function mountPathPrefix(prefix, fn) {
    return function (req, res, next) {
      if (req.path.indexOf(prefix) === 0) {
        // Adjust path for nested routing
        const savedPath = req.path;
        const savedOriginalUrl = req.originalUrl;
        req.path = req.path.substring(prefix.length) || "/";
        req.baseUrl = req.baseUrl + prefix;
        return fn(req, res, function adjustedNext(err) {
          req.path = savedPath;
          req.originalUrl = savedOriginalUrl;
          req.baseUrl = req.baseUrl.substring(
            0,
            req.baseUrl.length - prefix.length,
          );
          next(err);
        });
      } else {
        next();
      }
    };
  }

  /**
   * Add one or more route handlers for a given HTTP verb and path.
   *
   * @param {string} verb — HTTP method (uppercase)
   * @param {string} path — Exact path to match
   * @param {Function[]} fns — Handler functions
   * @returns {Object} app
   */
  app.route = function route(verb, path, fns) {
    for (const fn of fns) {
      stack.push(function (req, res, next) {
        if (req.path === path && req.method === verb) {
          return fn(req, res, next, path);
        } else {
          next();
        }
      });
    }
    return app;
  };

  // HTTP method shorthands
  const shorthands = [
    ["get", "GET"],
    ["post", "POST"],
    ["put", "PUT"],
    ["patch", "PATCH"],
    ["del", "DELETE"],
    ["head", "HEAD"],
    ["options", "OPTIONS"],
  ];
  for (const [property, httpVerb] of shorthands) {
    app[property] = (path, ...fns) => app.route(httpVerb, path, fns);
  }

  /**
   * Wrap a Bun Request into an Express-like request object.
   *
   * @param {Request} request — The incoming Bun Request
   * @param {boolean} isRoot — Whether this is the top-level app (not nested)
   * @returns {Object} req — Express-like request with locals, path, baseUrl, etc.
   */
  function wrapRequest(request, isRoot) {
    const url = new URL(request.url);
    return {
      // Original Bun Request properties
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
      bodyUsed: request.bodyUsed,
      clone: () => request.clone(),
      arrayBuffer: () => request.arrayBuffer(),
      text: () => request.text(),
      json: () => request.json(),
      formData: () => request.formData(),

      // Reference to the original Bun Request (for server.upgrade(), etc.)
      originalRequest: request,

      // Express-like properties
      originalUrl: isRoot ? url.pathname : undefined,
      path: url.pathname,
      baseUrl: "",
      query: Object.fromEntries(url.searchParams.entries()),
      search: url.search,
      hostname: url.hostname,
      href: url.href,

      // Middleware data store
      locals: {},
    };
  }

  /**
   * Create an Express-like response helper.
   *
   * @param {Request} originalRequest — The original Bun Request (for body access)
   * @returns {Object} res — Response helper with send(), json(), status(), etc.
   */
  function wrapResponse(originalRequest) {
    // Use a mutable state object so that both property access (res.statusCode = 404)
    // and method access (res.status(404)) share the same underlying values.
    const state = {
      statusCode: 200,
      ended: false,
      responseBody: null,
      responseHeaders: new Headers(),
    };

    const res = {
      /** Current status code — readable and writable */
      get statusCode() {
        return state.statusCode;
      },
      set statusCode(val) {
        state.statusCode = val;
      },

      /** Set a response header */
      setHeader(name, value) {
        state.responseHeaders.set(name, value);
        return res;
      },

      /** Get a response header */
      getHeader(name) {
        return state.responseHeaders.get(name);
      },

      /** Remove a response header */
      removeHeader(name) {
        state.responseHeaders.delete(name);
        return res;
      },

      /** Get all response headers as a Headers object */
      getHeaders() {
        return state.responseHeaders;
      },

      /** Set the status code */
      status(code) {
        state.statusCode = code;
        return res;
      },

      /** Send a plain text response */
      send(body) {
        if (state.ended) return res;
        state.ended = true;
        state.responseBody =
          typeof body === "string" ? body : JSON.stringify(body);
        if (!state.responseHeaders.has("Content-Type")) {
          state.responseHeaders.set(
            "Content-Type",
            typeof body === "string" ? "text/plain" : "application/json",
          );
        }
        return res;
      },

      /** Alias for send() — matches pronto/Express .end() */
      end(body) {
        return this.send(body);
      },

      /** Send a JSON response */
      json(obj) {
        if (state.ended) return res;
        state.ended = true;
        state.responseBody = JSON.stringify(obj);
        state.responseHeaders.set("Content-Type", "application/json");
        return res;
      },

      /** Send an HTML response */
      html(html) {
        if (state.ended) return res;
        state.ended = true;
        state.responseBody = html;
        state.responseHeaders.set("Content-Type", "text/html");
        return res;
      },

      /** Send a redirect response */
      redirect(url, status) {
        if (state.ended) return res;
        state.ended = true;
        state.statusCode = status || 302;
        state.responseBody = `Redirecting to ${url}`;
        state.responseHeaders.set("Location", url);
        return res;
      },

      /** Send a file response (Bun.file) */
      file(file) {
        if (state.ended) return res;
        state.ended = true;
        state.responseBody = file;
        return res;
      },

      /** Check if the response has been sent */
      get ended() {
        return state.ended;
      },

      /** Build the final Bun Response from accumulated state */
      toResponse() {
        if (!state.ended) {
          state.responseBody = "No response sent";
          state.responseHeaders.set("Content-Type", "text/plain");
        }
        return new Response(state.responseBody, {
          status: state.statusCode,
          headers: state.responseHeaders,
        });
      },
    };

    return res;
  }

  /**
   * Default error handler. Override via app.setErrorHandler().
   *
   * @param {Error} err
   * @param {Object} req
   * @param {Object} res
   */
  app.errorHandler = function (err, req, res) {
    console.error(err);
    if (res.statusCode === 200) res.statusCode = 500;
    res.end("Internal Server Error");
  };

  /**
   * Default 404 handler. Override via app.setNotFoundHandler().
   *
   * @param {Object} req
   * @param {Object} res
   */
  app.notfound = function (req, res) {
    res.statusCode = 404;
    res.end(`Cannot ${req.method} ${req.url}`);
  };

  /**
   * Set a custom error handler.
   *
   * @param {Function} fn — (err, req, res) => void
   * @returns {Object} app
   */
  app.setErrorHandler = function (fn) {
    app.errorHandler = fn;
    return app;
  };

  /**
   * Set a custom 404 handler.
   *
   * @param {Function} fn — (req, res) => void
   * @returns {Object} app
   */
  app.setNotFoundHandler = function (fn) {
    app.notfound = fn;
    return app;
  };

  /**
   * The main request handler — designed to be passed to Bun.serve({ fetch }).
   * Iterates through the middleware stack, calling next() until a response is sent.
   *
   * When called from Bun.serve({ fetch }), receives (BunRequest, server).
   * When called as mounted middleware, receives (expressReq, expressRes, parentNext, mountPoint).
   *
   * @param {Request|Object} request — Bun Request or Express-like req (detected via .locals)
   * @param {Object} [serverOrRes] — Bun Server or Express-like res
   * @param {Function} [parentNext] — Called when this app is mounted inside another
   * @param {string} [mountPoint] — The mount path prefix (for nested apps)
   * @returns {Response|undefined}
   */
  app.handler = async function handler(
    request,
    serverOrRes,
    parentNext,
    mountPoint,
  ) {
    // Detect whether we're called from Bun.serve() (Bun Request) or as mounted
    // middleware (Express-like req with .locals). When mounted, reuse the parent's
    // req/res so path adjustments (baseUrl, path) are preserved.
    const isExpressReq =
      request && typeof request === "object" && "locals" in request;

    let req, res;
    if (isExpressReq) {
      // Mounted middleware: reuse parent's req/res
      req = request;
      res = serverOrRes;
      // parentNext is the 3rd arg, mountPoint is the 4th
    } else {
      // Root handler from Bun.serve(): wrap the Bun Request
      req = wrapRequest(request, true);
      res = wrapResponse(request);
      // No parentNext — this is the root app
      parentNext = undefined;
      mountPoint = undefined;
    }

    // Initialize Express-like properties for root requests
    // When called as mounted middleware (isExpressReq), the path is already
    // adjusted by mountPathPrefix, so we only set up for root requests.
    if (!parentNext) {
      req.originalUrl = req.path;
      req.baseUrl = "";
    } else if (!isExpressReq) {
      // Only adjust path if we're not receiving a pre-adjusted Express req
      req.baseUrl = (req.baseUrl || "") + mountPoint;
      req.path = req.path.substring(req.baseUrl.length) || "/";
    }

    // Iterate through the middleware stack
    let index = 0;
    let response = null;

    async function next(err) {
      if (err) {
        app.errorHandler(err, req, res);
        response = res.toResponse();
        return;
      }

      // If response already sent, stop
      if (res.ended) {
        response = res.toResponse();
        return;
      }

      // Get next middleware
      const middleware = stack[index++];
      if (!middleware) {
        // No more middleware in this app

        // If mounted inside another app, pass control back to parent
        if (parentNext) {
          parentNext();
          return;
        }

        // Otherwise, 404
        app.notfound(req, res);
        response = res.toResponse();
        return;
      }

      try {
        const result = middleware(req, res, next);
        // Support async middleware (e.g., for reading request body)
        if (result && typeof result.then === "function") {
          await result.catch((e) => next(e));
          // After async middleware completes, check if it sent a response
          if (res.ended) {
            response = res.toResponse();
          }
          return;
        }
      } catch (e) {
        next(e);
      }

      // If middleware sent a response synchronously, capture it
      if (res.ended) {
        response = res.toResponse();
      }
    }

    await next();
    return response;
  };

  /**
   * Start a Bun server with this app as the fetch handler.
   *
   * @param {Object} options — Bun.serve() options (port, hostname, etc.)
   * @returns {Bun.Serving} The server instance
   */
  app.listen = function listen(options) {
    const serveOptions = {
      ...options,
      fetch: app.handler,
    };
    return Bun.serve(serveOptions);
  };

  return app;
}
