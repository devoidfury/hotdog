import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fsSync from 'node:fs';
import path from 'node:path';
import { EditTool } from '../../src/extensions/core-tools/edit.ts';
import type { ToolResult } from '../../src/core/extensions/tool-utils.ts';
import { xmlWireFormat } from '@extensions/wire-format-xml/index.ts';
import { resultStr, tmpDir, toolCtx, cleanupDir } from '../helpers.ts';

let dir: string;

beforeAll(() => {
  dir = tmpDir();
});

afterAll(() => {
  cleanupDir(dir);
});

// ── Tool Definition ─────────────────────────────────────────────────────────

describe('EditTool.toToolDef', () => {
  it('returns a tool definition with correct name', () => {
    const def = new EditTool({ maxEditInputSize: 16000 }).toToolDef();
    expect(def.type).toBe('function');
    expect(def.function.name).toBe('edit');
  });

  it('requires path, oldString, and newString', () => {
    const def = new EditTool({ maxEditInputSize: 16000 }).toToolDef();
    expect(def.function.parameters.required).toEqual(['path', 'oldString', 'newString']);
  });

  it('has replace_all as optional boolean', () => {
    const def = new EditTool({ maxEditInputSize: 16000 }).toToolDef();
    const props = def.function.parameters.properties as Record<string, unknown>;
    expect((props.replace_all as Record<string, string>).type).toBe('boolean');
  });
});


// ── execute: exact match ────────────────────────────────────────────────────

describe('EditTool.execute — exact match', () => {
  it('replaces a single occurrence', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'hello world hello');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { path: 'file.txt', oldString: 'world', newString: 'universe' },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('hello universe hello');
    expect(resultStr(result)).toContain('Successfully edited');
    expect(resultStr(result)).toContain('found 1 match');
  });

  it('returns a failed result with a hint when the file does not exist', async () => {
    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { path: 'missing.txt', oldString: 'a', newString: 'b' },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(result.success).toBe(false);
    expect(resultStr(result)).toContain('File not found');
    expect(result.hint).toMatch(/find tool/);
    // Model-facing rendering carries the hint as a structured element. The
    // tag is built by concatenation: marker tags are mangler-protected, so test
    // sources never contain them literally.
    const rendered = xmlWireFormat.renderToolResult((result as ToolResult).toApiContent('edit'));
    expect(rendered).toContain('<' + 'hint' + '>');
    expect(rendered).toContain('find tool');
  });

  it('replaces all occurrences with replace_all', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'foo bar foo baz foo');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    await tool.execute(
      { path: 'file.txt', oldString: 'foo', newString: 'qux', replace_all: true },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('qux bar qux baz qux');
  });

  it('fails with a multi-match error instead of silently replacing the first occurrence', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'foo bar foo baz foo');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { path: 'file.txt', oldString: 'foo', newString: 'qux' },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(result.success).toBe(false);
    expect(resultStr(result)).toContain('matched 3 times');
    // Nothing was written: the file keeps all three occurrences.
    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('foo bar foo baz foo');
  });

  it('replaces multi-line content', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'line1\nhello\nline3');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    await tool.execute(
      { path: 'file.txt', oldString: 'hello', newString: 'world' },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('line1\nworld\nline3');
  });

  it('creates parent directories for new file', async () => {
    const tool = new EditTool({ maxEditInputSize: 16000 });
    const filePath = path.join(dir, 'a', 'b', 'new.txt');

    // Create initial file
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    fsSync.writeFileSync(filePath, 'old content');

    await tool.execute(
      { path: 'a/b/new.txt', oldString: 'old', newString: 'new' },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('new content');
  });

  it('does not expand $-replacement patterns in newString (single and replace_all)', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'price: 100 total: 200');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    // $& = matched text, $$ = literal $, $' = text after match — all must stay literal.
    await tool.execute(
      { path: 'file.txt', oldString: '100', newString: '$&$$100$\'$`' },
      toolCtx({ workspaceRoots: [dir] })
    );
    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe("price: $&$$100$'$` total: 200");

    fsSync.writeFileSync(filePath, 'foo bar foo');
    await tool.execute(
      { path: 'file.txt', oldString: 'foo', newString: '$&', replace_all: true },
      toolCtx({ workspaceRoots: [dir] })
    );
    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('$& bar $&');
  });
});

// ── execute: line-trimmed fallback ──────────────────────────────────────────

describe('EditTool.execute — line-trimmed fallback', () => {
  it('matches with different indentation', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, '  hello world  \n  foo bar  ');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    await tool.execute(
      { path: 'file.txt', oldString: 'hello world', newString: 'universe' },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('  universe  \n  foo bar  ');
  });

  it('throws AssistantRetryableError with helpful message when text not found', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'line1\nline2\nline3');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    await expect(
      tool.execute(
        { path: 'file.txt', oldString: 'notfound', newString: 'replacement' },
        toolCtx({ workspaceRoots: [dir] })
      )
    ).rejects.toThrow(/text not found in file/);
  });

  it('falls back to the file preview when nothing is similar', async () => {
    const filePath = path.join(dir, 'preview.txt');
    fsSync.writeFileSync(filePath, 'alpha\nbeta\ngamma');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    const err = await tool
      .execute(
        { path: 'preview.txt', oldString: 'zzzqqqxyz', newString: 'x' },
        toolCtx({ workspaceRoots: [dir] })
      )
      .then(() => null, (e: unknown) => e as Error);

    expect(err).not.toBeNull();
    expect(err!.message).toContain('File content:');
    expect(err!.message).not.toContain('Closest matches');
  });

  it('reports the closest matching line when oldString has a typo', async () => {
    const filePath = path.join(dir, 'nearest.txt');
    fsSync.writeFileSync(
      filePath,
      [
        ...Array.from({ length: 40 }, (_, i) => `padding line ${i}`),
        'const computedValue = aggregate(items);',
        ...Array.from({ length: 40 }, (_, i) => `more padding ${i}`),
      ].join('\n')
    );

    const tool = new EditTool({ maxEditInputSize: 16000 });
    const err = await tool
      .execute(
        {
          path: 'nearest.txt',
          oldString: 'const computedValue = agregate(items);',
          newString: 'x',
        },
        toolCtx({ workspaceRoots: [dir] })
      )
      .then(() => null, (e: unknown) => e as Error);

    expect(err).not.toBeNull();
    expect(err!.message).toContain('Closest matches');
    expect(err!.message).toContain('line 41');
    expect(err!.message).toContain('aggregate(items)');
  });

  it('multi-line match with different indentation does not duplicate or drop lines', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(
      filePath,
      'function outer() {\n' +
        '    const a = 1;\n' +
        '    const b = 2;\n' +
        '    if (a > b) {\n' +
        '        console.log("a wins");\n' +
        '    } else {\n' +
        '        console.log("b wins");\n' +
        '    }\n' +
        '}\n'
    );

    const tool = new EditTool({ maxEditInputSize: 16000 });
    await tool.execute(
      {
        path: 'file.txt',
        oldString:
          'if (a > b) {\n' +
          'console.log("a wins");\n' +
          '} else {\n' +
          'console.log("b wins");\n' +
          '}',
        newString:
          'if (a > b) {\n' +
          'console.log("A WINS");\n' +
          '} else {\n' +
          'console.log("B WINS");\n' +
          '}',
      },
      toolCtx({ workspaceRoots: [dir] })
    );

    const result = fsSync.readFileSync(filePath, 'utf-8');
    // No duplicated lines
    expect(result.split('\n').filter((l) => l.trim() === 'if (a > b) {')).toHaveLength(1);
    // Closing brace of the function is preserved
    expect(result.endsWith('}\n')).toBe(true);
    // Replacement applied
    expect(result).toContain('console.log("A WINS")');
    expect(result).toContain('console.log("B WINS")');
  });

  it('multi-line match with less indentation than file preserves the file\'s indent', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(
      filePath,
      'function outer() {\n' +
        '    const a = 1;\n' +
        '    if (a > b) {\n' +
        '        console.log("a wins");\n' +
        '    } else {\n' +
        '        console.log("b wins");\n' +
        '    }\n' +
        '}\n'
    );

    const tool = new EditTool({ maxEditInputSize: 16000 });
    await tool.execute(
      {
        path: 'file.txt',
        oldString:
          'if (a > b) {\n' +
          '  console.log("a wins");\n' +
          '} else {\n' +
          '  console.log("b wins");\n' +
          '}',
        newString:
          'if (a > b) {\n' +
          '  console.log("A WINS!");\n' +
          '} else {\n' +
          '  console.log("B WINS!");\n' +
          '}',
      },
      toolCtx({ workspaceRoots: [dir] })
    );

    const result = fsSync.readFileSync(filePath, 'utf-8');
    // First line of the replacement gets the file's original indentation
    expect(result).toContain('    if (a > b) {\n');
    // The rest is inserted as-is (no per-line re-indenting)
    expect(result).toContain('  console.log("A WINS!");\n');
    expect(result.split('\n').filter((l) => l.trim() === 'if (a > b) {')).toHaveLength(1);
  });

  it('multi-line match at file start works', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'alpha\nbeta\ngamma\ndelta');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    await tool.execute(
      {
        path: 'file.txt',
        oldString: 'alpha\nbeta',
        newString: 'one\ntwo',
      },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('one\ntwo\ngamma\ndelta');
  });

  it('multi-line match at file end works', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'alpha\nbeta\ngamma\ndelta');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    await tool.execute(
      {
        path: 'file.txt',
        oldString: 'gamma\ndelta',
        newString: 'three\nfour',
      },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('alpha\nbeta\nthree\nfour');
  });
});

// ── execute: error cases ────────────────────────────────────────────────────

describe('EditTool.execute — error cases', () => {
  it('rejects empty oldString', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'hello');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { path: 'file.txt', oldString: '', newString: 'world' },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(resultStr(result)).toContain('oldString must not be empty');
  });

  it('rejects identical oldString and newString', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'hello');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { path: 'file.txt', oldString: 'hello', newString: 'hello' },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(resultStr(result)).toContain('no changes to apply');
  });

  it('returns error on invalid JSON input', async () => {
    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute('not json', toolCtx({ workspaceRoots: [dir] }));
    expect(resultStr(result)).toContain('Error parsing arguments');
  });

  it('returns error on missing path', async () => {
    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { oldString: 'a', newString: 'b' },
      toolCtx({ workspaceRoots: [dir] })
    );
    expect(resultStr(result)).toContain('Error parsing arguments');
  });

  it('returns error on missing oldString', async () => {
    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { path: 'file.txt', newString: 'b' },
      toolCtx({ workspaceRoots: [dir] })
    );
    expect(resultStr(result)).toContain('Error parsing arguments');
  });

  it('returns error on missing newString', async () => {
    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { path: 'file.txt', oldString: 'a' },
      toolCtx({ workspaceRoots: [dir] })
    );
    expect(resultStr(result)).toContain('Error parsing arguments');
  });

  it('rejects path outside cwd boundary', async () => {
    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { path: '/etc/evil.txt', oldString: 'a', newString: 'b' },
      toolCtx({ workspaceRoots: [dir] })
    );
    expect(resultStr(result)).toContain('Path escape rejected');
  });

  it('throws AssistantRetryableError when input is too large', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'hello');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    const bigString = 'x'.repeat(16001); // DEFAULT_MAX_EDIT_INPUT_SIZE (16000) + 1
    await expect(
      tool.execute(
        { path: 'file.txt', oldString: bigString, newString: 'y' },
        toolCtx({ workspaceRoots: [dir] })
      )
    ).rejects.toThrow(/Edit input too large/);
  });

  it('handles input as string JSON', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'hello world');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    await tool.execute(
      JSON.stringify({ path: 'file.txt', oldString: 'hello', newString: 'goodbye' }),
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('goodbye world');
  });
});

// ── execute: text deletion (empty newString) ────────────────────────────────

describe('EditTool.execute — text deletion', () => {
  it('deletes text with an empty newString', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'hello world hello');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { path: 'file.txt', oldString: ' world', newString: '' },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('hello hello');
    expect(resultStr(result)).toContain('Successfully edited');
    expect(resultStr(result)).toContain('deleted 1 line');
    expect((result as any).metadata.get('lines_replaced')).toBe('0');
  });

  it('deletes a whole line including its newline', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'line1\nbye\nline3');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    await tool.execute(
      { path: 'file.txt', oldString: 'bye\n', newString: '' },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('line1\nline3');
  });

  it('deletes multiple lines with replace_all', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'keep\ndrop\nkeep\ndrop\nkeep');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { path: 'file.txt', oldString: 'drop\n', newString: '', replace_all: true },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('keep\nkeep\nkeep');
    expect(resultStr(result)).toContain('found 2 matches');
  });

  it('deletes multi-line text via line-trimmed fallback without leaving blank lines', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(
      filePath,
      '  if (a > b) {\n' +
        '      doIt();\n' +
        '  }\n' +
        '  keep\n'
    );

    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      {
        path: 'file.txt',
        // Indentation differs from the file, so this only matches via the
        // line-trimmed fallback.
        oldString: 'if (a > b) {\n  doIt();\n}',
        newString: '',
      },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('  keep\n');
    // start_line/end_line must not invert on a zero-length replacement
    const meta = (result as any).metadata;
    expect(Number(meta.get('start_line'))).toBeLessThanOrEqual(Number(meta.get('end_line')));
  });

  it('accepts empty new_string via snake_case alias', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'a b a');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    await tool.execute(
      { path: 'file.txt', old_string: ' b', new_string: '' },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('a a');
  });

  it('accepts empty newString in string JSON input', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'x foo bar');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    await tool.execute(
      JSON.stringify({ path: 'file.txt', oldString: ' foo', newString: '' }),
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('x bar');
  });

  it('still rejects a missing (undefined) newString', async () => {
    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { path: 'file.txt', oldString: 'a' },
      toolCtx({ workspaceRoots: [dir] })
    );
    expect(resultStr(result)).toContain('Error parsing arguments');
  });
});

// ── snake_case aliases ──────────────────────────────────────────────────────

describe('EditTool.execute — snake_case aliases', () => {
  it('accepts old_string and new_string', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'hello world');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    await tool.execute(
      { path: 'file.txt', old_string: 'hello', new_string: 'goodbye' },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('goodbye world');
  });
});

// ── BOM/CRLF fidelity ────────────────────────────────────────────────────────

describe("EditTool.execute — BOM/CRLF fidelity", () => {
  it("preserves CRLF line endings on a direct single-line match", async () => {
    const filePath = path.join(dir, "crlf-direct.txt");
    fsSync.writeFileSync(filePath, "one\r\ntwo\r\n");

    const tool = new EditTool({ maxEditInputSize: 16000 });
    await tool.execute(
      { path: "crlf-direct.txt", oldString: "two", newString: "2" },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(fsSync.readFileSync(filePath, "utf-8")).toBe("one\r\n2\r\n");
  });

  it("replaces a trimmed-fallback block without mixing line endings", async () => {
    const filePath = path.join(dir, "crlf-fallback.txt");
    fsSync.writeFileSync(filePath, "f(){\r\n    foo();\r\n    baz();\r\n}\r\n");

    const tool = new EditTool({ maxEditInputSize: 16000 });
    // Indentation mismatch forces the trimmed-line fallback; the LF-only
    // old/new strings must not leak bare \n into a CRLF file.
    await tool.execute(
      { path: "crlf-fallback.txt", oldString: "  foo();\n  baz();", newString: "x();\ny();" },
      toolCtx({ workspaceRoots: [dir] })
    );

    const written = fsSync.readFileSync(filePath, "utf-8");
    // Only the first replacement line re-indents (existing fallback rule).
    expect(written).toBe("f(){\r\n    x();\r\ny();\r\n}\r\n");
    expect(written).not.toMatch(/(^|[^\r])\n/);
  });

  it("keeps a leading BOM when the first line is replaced", async () => {
    const filePath = path.join(dir, "bom-edit.txt");
    fsSync.writeFileSync(filePath, Buffer.from("\uFEFFhello world"));

    const tool = new EditTool({ maxEditInputSize: 16000 });
    await tool.execute(
      { path: "bom-edit.txt", oldString: "hello world", newString: "goodbye" },
      toolCtx({ workspaceRoots: [dir] })
    );

    const buf = fsSync.readFileSync(filePath);
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(buf.toString("utf-8")).toBe("\uFEFFgoodbye");
  });
});


// ── Nearest-region recovery (stale-context block edits) ───────────────────

describe("EditTool.execute — nearest-region recovery", () => {
  const block = (drifted: string) => [
    "function render(state) {",
    "  const nodes = layout(state);",
    drifted,
    "  paint(nodes);",
    "}",
  ].join("\n");
  const padded = (blockText: string) =>
    Array.from({ length: 40 }, (_, i) => `padding ${i}`).join("\n") + "\n" + blockText;

  // "state" must stay out of padding so the anchor token scan lands only on
  // the block itself.

  it("pinpoints the interior line and the retry from the report succeeds", async () => {
    const filePath = path.join(dir, "region-interior.txt");
    fsSync.writeFileSync(filePath, padded(block("  const scale = zoom(state);")));

    const tool = new EditTool({ maxEditInputSize: 16000 });
    // Stale context: interior line renamed, indentation off (so strategy 2 can't match).
    const stale =
      "  function render(state) {\n" +
      "    const nodes = layout(state);\n" +
      "    const scale = computeZoom(state);\n" +
      "    paint(nodes);\n" +
      "  }";
    const err = await tool
      .execute({ path: "region-interior.txt", oldString: stale, newString: "x" }, toolCtx({ workspaceRoots: [dir] }))
      .then(() => null, (e: unknown) => e as Error);

    expect(err).not.toBeNull();
    expect(err!.message).toContain("Nearest region: lines 41-45");
    expect(err!.message).toContain("first difference at file line 43 (oldString line 3)");
    expect(err!.message).toContain('file:      "const scale = zoom(state);"');
    expect(err!.message).toContain('oldString: "const scale = computeZoom(state);"');
    expect(err!.message).toContain("All other in-file lines of the region match");
    expect(err!.message).not.toContain("Closest matches");

    // The acceptance property: one retry assembled from the reported line, no re-read.
    const fixed = stale.replace("computeZoom(state)", "zoom(state)");
    const ok = await tool.execute(
      { path: "region-interior.txt", oldString: fixed, newString: "rendered()" },
      toolCtx({ workspaceRoots: [dir] })
    );
    expect(resultStr(ok)).toContain("Successfully edited");
    expect(fsSync.readFileSync(filePath, "utf-8")).toContain("rendered()");
  });

  it("reports the anchor line itself when only it is stale", async () => {
    const filePath = path.join(dir, "region-anchor.txt");
    fsSync.writeFileSync(filePath, padded(block("  const scale = zoom(state);")));

    const stale =
      "funtion render(state) {\n" +
      "  const nodes = layout(state);\n" +
      "  const scale = zoom(state);\n" +
      "  paint(nodes);\n" +
      "}";
    const err = await new EditTool({ maxEditInputSize: 16000 })
      .execute({ path: "region-anchor.txt", oldString: stale, newString: "x" }, toolCtx({ workspaceRoots: [dir] }))
      .then(() => null, (e: unknown) => e as Error);

    expect(err!.message).toContain("first difference at file line 41 (oldString line 1)");
    expect(err!.message).toContain('file:      "function render(state) {"');
  });

  it("reports EOF when the file ends mid-block", async () => {
    const filePath = path.join(dir, "region-eof.txt");
    fsSync.writeFileSync(
      filePath,
      Array.from({ length: 40 }, (_, i) => `padding ${i}`).join("\n") +
        "\nalpha block one\nalpha block two\nalpha block three"
    );

    const stale = "alpha block one\nalpha block two\nalpha block three\nalpha block four\nalpha block five";
    const err = await new EditTool({ maxEditInputSize: 16000 })
      .execute({ path: "region-eof.txt", oldString: stale, newString: "x" }, toolCtx({ workspaceRoots: [dir] }))
      .then(() => null, (e: unknown) => e as Error);

    expect(err!.message).toContain("Nearest region: lines 41-43; the file ends at line 43.");
    expect(err!.message).toContain('oldString line 4 has no counterpart in the file: "alpha block four"');
  });

  it("warns when more differences follow the first", async () => {
    const filePath = path.join(dir, "region-multi.txt");
    fsSync.writeFileSync(filePath, padded(block("  const scale = zoom(state);\n  return scale;")));

    const stale =
      "function render(state) {\n" +
      "  const nodes = layout(state);\n" +
      "  const scale = computeZoom(state);\n" +
      "  return nodes;\n" +
      "}";
    const err = await new EditTool({ maxEditInputSize: 16000 })
      .execute({ path: "region-multi.txt", oldString: stale, newString: "x" }, toolCtx({ workspaceRoots: [dir] }))
      .then(() => null, (e: unknown) => e as Error);

    expect(err!.message).toContain("first difference at file line 43");
    expect(err!.message).toContain("More differences follow after this line.");
  });

  it("falls back to the closest-line list when no window has two agreeing lines", async () => {
    const filePath = path.join(dir, "region-single.txt");
    fsSync.writeFileSync(
      filePath,
      Array.from({ length: 10 }, (_, i) => `padding ${i}`).join("\n") + "\nconst needleValue = 1;"
    );

    const stale = "const needleValue = 1;\nconst unrelatedLine = compute();\nreturn unrelatedLine;";
    const err = await new EditTool({ maxEditInputSize: 16000 })
      .execute({ path: "region-single.txt", oldString: stale, newString: "x" }, toolCtx({ workspaceRoots: [dir] }))
      .then(() => null, (e: unknown) => e as Error);

    expect(err!.message).toContain("Closest matches");
    expect(err!.message).not.toContain("Nearest region");
  });

  it("reports the first of two identical drifted blocks", async () => {
    const filePath = path.join(dir, "region-dupe.txt");
    fsSync.writeFileSync(
      filePath,
      [
        "const markerValue = init();",
        "process(markerValue);",
        "finish(markerValue);",
        ...Array.from({ length: 10 }, (_, i) => `padding ${i}`),
        "const markerValue = init();",
        "process(markerValue);",
        "finish(markerValue);",
      ].join("\n")
    );

    const stale = "const markerValue = initX();\nprocess(markerValue);\nfinish(markerValue);";
    const err = await new EditTool({ maxEditInputSize: 16000 })
      .execute({ path: "region-dupe.txt", oldString: stale, newString: "x" }, toolCtx({ workspaceRoots: [dir] }))
      .then(() => null, (e: unknown) => e as Error);

    expect(err!.message).toContain("Nearest region: lines 1-3");
  });

  it("aligns the window when oldString starts with a blank line", async () => {
    const filePath = path.join(dir, "region-blank.txt");
    fsSync.writeFileSync(filePath, padded(block("  const scale = zoom(state);")));

    const stale =
      "\n  function render(state) {\n" +
      "    const nodes = layout(state);\n" +
      "    const scale = computeZoom(state);\n" +
      "    paint(nodes);\n" +
      "  }";
    const err = await new EditTool({ maxEditInputSize: 16000 })
      .execute({ path: "region-blank.txt", oldString: stale, newString: "x" }, toolCtx({ workspaceRoots: [dir] }))
      .then(() => null, (e: unknown) => e as Error);

    // Anchor is oldString line 2; the region starts at the anchor line,
    // not at the blank line dangling above it.
    expect(err!.message).toContain("Nearest region: lines 41-45");
    expect(err!.message).toContain("first difference at file line 43");
  });
});

// ── Multi-match guard (TL-03 / H5) ─────────────────────────────────────────

describe('EditTool.execute — multi-match guard', () => {
  it('exact path: multi-match error names the count and the 1-based line numbers', async () => {
    const filePath = path.join(dir, 'mm-exact.txt');
    fsSync.writeFileSync(
      filePath,
      'header\nuse the thing;\nfiller filler filler\nuse the thing;\ntrailer'
    );

    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { path: 'mm-exact.txt', oldString: 'use the thing;', newString: 'x' },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(result.success).toBe(false);
    const msg = resultStr(result);
    expect(msg).toContain('matched 2 times');
    expect(msg).toContain('lines 2, 4');
    expect(msg).toContain('more surrounding context');
    expect(msg).toContain('replace_all=true');
    expect(fsSync.readFileSync(filePath, 'utf-8')).toContain('use the thing;');
  });

  it('exact path: multi-line oldString counts its own newlines for later line numbers', async () => {
    const filePath = path.join(dir, 'mm-multiline.txt');
    fsSync.writeFileSync(filePath, 'x\naaa\nbbb\ny\naaa\nbbb\nz');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { path: 'mm-multiline.txt', oldString: 'aaa\nbbb', newString: 'c' },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(result.success).toBe(false);
    expect(resultStr(result)).toContain('matched 2 times');
    expect(resultStr(result)).toContain('lines 2, 5');
  });

  it('exact path: a single match still edits and reports one match', async () => {
    const filePath = path.join(dir, 'mm-single.txt');
    fsSync.writeFileSync(filePath, 'alpha\nbeta unique gamma\ndelta');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { path: 'mm-single.txt', oldString: 'unique', newString: 'ONLY' },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('alpha\nbeta ONLY gamma\ndelta');
    expect(resultStr(result)).toContain('found 1 match');
  });

  it('exact path: replace_all still replaces every occurrence', async () => {
    const filePath = path.join(dir, 'mm-all.txt');
    fsSync.writeFileSync(filePath, 'a\nb\na\nb\na');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { path: 'mm-all.txt', oldString: 'a', newString: 'c', replace_all: true },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('c\nb\nc\nb\nc');
    expect(resultStr(result)).toContain('found 3 matches');
  });

  it('zero-match error is unchanged (still throws text-not-found)', async () => {
    const filePath = path.join(dir, 'mm-miss.txt');
    fsSync.writeFileSync(filePath, 'line1\nline2\nline3');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    await expect(
      tool.execute(
        { path: 'mm-miss.txt', oldString: 'nothing here at all', newString: 'x' },
        toolCtx({ workspaceRoots: [dir] })
      )
    ).rejects.toThrow(/text not found in file/);
    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('line1\nline2\nline3');
  });

  it('trimmed-fallback path: multi-match fails with the matched line numbers', async () => {
    const filePath = path.join(dir, 'mm-fallback.txt');
    // Exact match misses (indentation differs); two windows match trimmed.
    fsSync.writeFileSync(filePath, '  aaa\n    bbb\nsep\n  aaa\n    bbb\n');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { path: 'mm-fallback.txt', oldString: 'aaa\nbbb', newString: 'c' },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(result.success).toBe(false);
    const msg = resultStr(result);
    expect(msg).toContain('matched 2 times');
    expect(msg).toContain('lines 1, 4');
    expect(msg).toContain('replace_all=true');
    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('  aaa\n    bbb\nsep\n  aaa\n    bbb\n');
  });

  it('trimmed-fallback path: a single window still edits', async () => {
    const filePath = path.join(dir, 'mm-fallback1.txt');
    fsSync.writeFileSync(filePath, '  aaa\n    bbb\nend');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { path: 'mm-fallback1.txt', oldString: 'aaa\nbbb', newString: 'c' },
      toolCtx({ workspaceRoots: [dir] })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('  c\nend');
    expect(resultStr(result)).toContain('found 1 match');
  });
});
