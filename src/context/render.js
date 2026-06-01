export function compile(template) {
  const tokens = tokenize(template);
  return function render(context) {
    return walkTokens(tokens, context);
  };
}

const templateCache = new Map();

/** Render a template string directly with a context object. */
export function render(template, context, cache = false) {
  if (templateCache.has(template)) return templateCache.get(template)(context);
  const artifact = compile(template);
  if (cache) templateCache.set(template, artifact);
  return artifact(context);
}

// Convenience alias used by system_prompt.js
export const renderTemplate = render;

// ── Tokenizer ──────────────────────────────────────────────────────

function tokenize(template) {
  const tokens = [];
  let i = 0;
  let plainStart = 0;
  let prevStripRight = false;

  while (i < template.length) {
    if (template[i] === "{" && template[i + 1] === "{") {
      pushText(tokens, template, plainStart, i, prevStripRight);
      const end = findClose(template, i, "}}");
      const inner = template.slice(i + 2, end);
      const stripRight = inner.trimEnd().endsWith("-");
      const expr = stripRight
        ? inner.slice(0, inner.lastIndexOf("-")).trim()
        : inner.trim();
      tokens.push({ type: "print", value: expr, stripRight });
      i = end + 2;
      plainStart = i;
      prevStripRight = stripRight;
    } else if (template[i] === "{" && template[i + 1] === "%") {
      pushText(tokens, template, plainStart, i, prevStripRight);
      const end = findClose(template, i, "%}");
      const inner = template.slice(i + 2, end);
      const stripLeft = inner.startsWith("-");
      const tag = stripLeft ? inner.slice(1).trim() : inner.trim();
      const stripRight = tag.endsWith("-");
      const cleanTag = stripRight
        ? tag.slice(0, tag.lastIndexOf("-")).trim()
        : tag;
      tokens.push({
        type: "tag",
        value: cleanTag,
        stripLeft: stripLeft || prevStripRight,
        stripRight,
      });
      i = end + 2;
      plainStart = i;
      prevStripRight = stripRight;
    } else if (template[i] === "{" && template[i + 1] === "#") {
      pushText(tokens, template, plainStart, i, prevStripRight);
      i = findClose(template, i, "#}") + 2;
      plainStart = i;
      prevStripRight = false;
    } else {
      i++;
    }
  }
  pushText(tokens, template, plainStart, template.length, prevStripRight);
  return tokens;
}

function pushText(tokens, template, start, end, stripLeft) {
  let text = template.slice(start, end);
  if (stripLeft) text = text.replace(/^\s+/, "");
  if (text.length > 0 || stripLeft)
    tokens.push({ type: "text", value: text, stripLeft });
}

function findClose(str, from, delim) {
  const idx = str.indexOf(delim, from + 2);
  if (idx === -1) throw new Error(`Unclosed ${delim}`);
  return idx;
}

// ── Main render loop ───────────────────────────────────────────────

function walkTokens(tokens, context) {
  let output = "";
  let idx = 0;
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (tok.type === "text") {
      output += tok.value;
      idx++;
    } else if (tok.type === "print") {
      output += evalPrint(tok.value, context);
      idx++;
    } else if (tok.type === "tag") {
      if (tok.value.startsWith("if ")) {
        output += walkIf(tokens, idx, context);
        idx = skipPast(tokens, idx, "if", "endif");
      } else if (tok.value.startsWith("for ")) {
        output += walkFor(tokens, idx, context);
        idx = skipPast(tokens, idx, "for", "endfor");
      } else {
        idx++;
      }
    }
  }
  return output;
}

function skipPast(tokens, idx, openTag, closeTag) {
  let depth = 1,
    j = idx + 1;
  while (j < tokens.length) {
    if (tokens[j].type !== "tag") {
      j++;
      continue;
    }
    if (tokens[j].value.match(new RegExp(`^${openTag}\\s`))) {
      depth++;
      j++;
    } else if (tokens[j].value === closeTag) {
      depth--;
      if (depth === 0) return j + 1;
      j++;
    } else {
      j++;
    }
  }
  return tokens.length;
}

function walkIf(tokens, idx, context) {
  const tok = tokens[idx];
  const cond = tok.value.slice(3);
  const { bodyStart, elseIdx, bodyEnd } = findBlock(
    tokens,
    idx,
    "if",
    "endif",
    "else",
  );
  const condValue = evalExpr(cond, context);
  const start = condValue ? bodyStart : elseIdx > 0 ? elseIdx + 1 : bodyEnd;
  const end = condValue ? (elseIdx > 0 ? elseIdx : bodyEnd) : bodyEnd;
  let output = walkTokens(tokens.slice(start, end), context);
  if (tok.stripRight) output = output.replace(/^\s+/, "");
  return output;
}

function walkFor(tokens, idx, context) {
  const tok = tokens[idx];
  const { varName, expr } = parseFor(tok.value);
  const { bodyStart, bodyEnd } = findBlock(tokens, idx, "for", "endfor");
  const items = resolveValue(expr, context);
  let output = "";
  if (Array.isArray(items)) {
    for (const item of items) {
      output += walkTokens(tokens.slice(bodyStart, bodyEnd), {
        ...context,
        [varName]: item,
      });
    }
  }
  if (tok.stripRight) output = output.replace(/^\s+/, "");
  return output;
}

function parseFor(tag) {
  const m = tag.match(/^for\s+(\w+)\s+in\s+(.+)$/);
  return { varName: m[1], expr: m[2] };
}

// ── Block finding ──────────────────────────────────────────────────

function findBlock(tokens, fromIdx, openTag, closeTag, elseTag) {
  let depth = 1,
    bodyStart = fromIdx + 1,
    elseIdx = -1,
    bodyEnd = tokens.length;
  for (let j = bodyStart; j < tokens.length; j++) {
    if (tokens[j].type !== "tag") continue;
    if (tokens[j].value.match(new RegExp(`^${openTag}\s`))) depth++;
    else if (tokens[j].value === closeTag) {
      depth--;
      if (depth === 0) {
        bodyEnd = j;
        break;
      }
    } else if (elseTag && tokens[j].value === elseTag && depth === 1)
      elseIdx = j;
  }
  return { bodyStart, elseIdx, bodyEnd };
}

// ── Expressions & filters ──────────────────────────────────────────

function evalPrint(expr, context) {
  const pipeIdx = expr.indexOf("|");
  if (pipeIdx === -1) return resolveExpr(expr.trim(), context);
  const value = resolveExpr(expr.slice(0, pipeIdx).trim(), context);
  return applyFilter(value, expr.slice(pipeIdx + 1).trim());
}

function applyFilter(value, filterSpec) {
  const parenIdx = filterSpec.indexOf("(");
  if (parenIdx === -1) return applySimpleFilter(value, filterSpec.trim());
  const name = filterSpec.slice(0, parenIdx).trim();
  const argsStr = filterSpec
    .slice(parenIdx + 1, filterSpec.lastIndexOf(")"))
    .trim();
  const namedArgs = parseNamedArgs(argsStr);
  if (name === "default") {
    const fallback =
      namedArgs.value !== undefined
        ? namedArgs.value
        : argsStr.replace(/^['"']/, "").replace(/['"']$/, "");
    return value === "" || value == null ? fallback : String(value);
  }
  if (name === "length") return String((value ?? "").length);
  return String(value);
}

function applySimpleFilter(value, name) {
  if (name === "default")
    return value === "" || value == null ? "" : String(value);
  if (name === "length") return String((value ?? "").length);
  if (name === "trim") return String(value).trim();
  if (name === "exec") {
    const { execSync } = require("child_process");
    const cmd = typeof value === "string" ? value : String(value);
    try {
      return execSync(cmd, { encoding: "utf-8" }).trimEnd();
    } catch {
      return "";
    }
  }
  return String(value);
}

function parseNamedArgs(str) {
  const m = str.match(/(\w+)\s*=\s*["']([^'"]*)["']/);
  return m ? { [m[1]]: m[2] } : {};
}

function resolveExpr(expr, context) {
  expr = expr.trim();
  if (expr.startsWith("not "))
    return !resolveExpr(expr.slice(4).trim(), context);
  if (isStringLit(expr)) return expr.slice(1, -1);
  let value = context;
  for (const key of expr.split(".")) {
    if (value == null) return "";
    value = value[key];
  }
  return value ?? "";
}

function resolveValue(expr, context) {
  expr = expr.trim();
  if (expr.startsWith("not "))
    return !resolveValue(expr.slice(4).trim(), context);
  let value = context;
  for (const key of expr.split(".")) {
    if (value == null) return undefined;
    value = value[key];
  }
  return value;
}

function evalExpr(expr, context) {
  expr = expr.trim();
  if (expr.startsWith("not ")) return !evalExpr(expr.slice(4).trim(), context);
  if (expr.startsWith("!")) return !evalExpr(expr.slice(1).trim(), context);
  const pipeIdx = expr.indexOf("|");
  if (pipeIdx !== -1) {
    const value = resolveExpr(expr.slice(0, pipeIdx).trim(), context);
    const filterPart = expr.slice(pipeIdx + 1).trim();
    if (filterPart === "length > 0") return (value ?? "").length > 0;
    return Boolean(value);
  }
  return Boolean(resolveValue(expr, context));
}

function isStringLit(s) {
  return (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  );
}
