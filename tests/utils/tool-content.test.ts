// toolContentText — the display-only flattener used by output surfaces
// (CLI, websocket bridge, web log view). Display, not a wire format.

import { describe, it, expect } from 'bun:test';
import { toolContentMeta, toolContentSuccess, toolContentText, wrapperContentText, splitFileIncludes } from '@utils/tool-content.ts';
import type { ToolResultPart } from '@core/context/wrappers.ts';

const part = (over: Partial<ToolResultPart> = {}): ToolResultPart => ({
  type: 'tool-result',
  tool: 'read',
  status: 'success',
  meta: [],
  error: null,
  hint: null,
  output: 'body',
  ...over,
});

describe('toolContentText', () => {
  it('passes harness strings through and maps null/undefined to ""', () => {
    expect(toolContentText('plain text')).toBe('plain text');
    expect(toolContentText(null)).toBe('');
    expect(toolContentText(undefined)).toBe('');
  });

  it('renders output, then Error:, then HINT:, then the META dump', () => {
    const p = part({
      status: 'failure',
      output: 'partial output',
      error: 'boom',
      hint: 'use the find tool',
      meta: [['exit_code', '1'], ['duration_ms', '12']],
    });
    expect(toolContentText([p])).toBe(
      'partial output\nError: boom\nHINT: use the find tool\nMETA: {"exit_code":"1","duration_ms":"12"}',
    );
  });

  it('omits empty lines: absent output/error/hint/meta contribute nothing', () => {
    expect(toolContentText([part({ output: '' })])).toBe('');
    expect(toolContentText([part()])).toBe('body');
    expect(toolContentText([part({ status: 'error', error: 'only error', output: '' })])).toBe(
      'Error: only error',
    );
  });

  it('META preserves declaration order and rides even when the payload is empty', () => {
    const p = part({ output: '', meta: [['b', '2'], ['a', '1']] });
    expect(toolContentText([p])).toBe('META: {"b":"2","a":"1"}');
  });

  it('paint transforms each part\'s own bytes only: chrome and harness strings stay raw', () => {
    const paint = (s: string) => `[${s}]`;
    const p = part({
      status: 'failure',
      output: 'partial',
      error: 'boom',
      hint: 'try again',
      meta: [['exit_code', '1']],
    });
    expect(toolContentText([p], paint)).toBe(
      '[partial]\nError: boom\nHINT: try again\nMETA: {"exit_code":"1"}',
    );
    // per part, in order; absent output paints nothing
    expect(toolContentText([part({ output: 'a' }), part({ output: 'b', meta: [['k', 'v']] })], paint)).toBe(
      '[a]\n[b]\nMETA: {"k":"v"}',
    );
    expect(toolContentText([part({ output: '' })], paint)).toBe('');
    // bare string content is harness text: never painted
    expect(toolContentText('plain', paint)).toBe('plain');
  });

  it('degrades the bookkeeping plain-object shape to "" (cold-log entries)', () => {
    expect(toolContentText({ session: 'x', foo: 'bar' } as unknown as never)).toBe('');
  });

  it('flattens several parts in order and ignores non-tool parts', () => {
    const parts = [
      { type: 'text', text: 'harness text is ignored here' },
      part({ tool: 'a', output: 'first' }),
      part({ tool: 'b', output: 'second' }),
    ];
    expect(toolContentText(parts)).toBe('first\nsecond');
  });
});

describe("wrapperContentText (display flattener)", () => {
  it("flattens text/untrusted like contentToText", () => {
    expect(
      wrapperContentText([
        { type: "text", text: "a" },
        { type: "untrusted", text: "b" },
      ]),
    ).toBe("a\nb");
  });

  it("renders wrappers as prose, not the at-rest JSON", () => {
    const out = wrapperContentText([
      { type: "system-notice", text: "resumed" },
      { type: "file-include", path: "note.md", content: "body" },
      { type: "tool-result", tool: "read", status: "success", meta: [["page", "1"]], error: null, hint: null, output: "hi" },
    ]);
    expect(out).toBe(
      "[notice] resumed\n[file note.md]\nbody\nhi\nMETA: {\"page\":\"1\"}",
    );
    expect(out).not.toContain('"type":"system-notice"');
  });

  it("passes strings through and maps null/undefined to empty", () => {
    expect(wrapperContentText("plain")).toBe("plain");
    expect(wrapperContentText(null)).toBe("");
    expect(wrapperContentText(undefined)).toBe("");
  });

  it("degrades the bookkeeping plain-object shape to '' (cold-log entries)", () => {
    expect(wrapperContentText({ session: "x", foo: "bar" } as unknown as never)).toBe("");
  });
});

describe("splitFileIncludes (attachment splitter)", () => {
  it("splits file-include parts out of the text", () => {
    const { text, files } = splitFileIncludes([
      { type: "untrusted", text: "look at this" },
      { type: "file-include", path: "a.txt", content: "AAA" },
      { type: "file-include", path: "b.txt", content: "BBB" },
    ]);
    expect(text).toBe("look at this");
    expect(files).toEqual([
      { path: "a.txt", content: "AAA" },
      { path: "b.txt", content: "BBB" },
    ]);
  });

  it("keeps other parts in the text", () => {
    const { text, files } = splitFileIncludes([
      { type: "untrusted", text: "hi" },
      { type: "system-notice", text: "noted" },
    ]);
    expect(text).toBe("hi\n[notice] noted");
    expect(files).toEqual([]);
  });

  it("passes strings through with no files", () => {
    expect(splitFileIncludes("plain")).toEqual({ text: "plain", files: [] });
    expect(splitFileIncludes(null)).toEqual({ text: "", files: [] });
  });

  it("degrades the bookkeeping plain-object shape to empty text", () => {
    expect(splitFileIncludes({ session: "x" } as unknown as never)).toEqual({ text: "", files: [] });
  });
});

describe('toolContentMeta', () => {
  it('reads the first value under the key from the part meta', () => {
    const p = part({ meta: [['path', 'a.ts'], ['start_line', '207']] });
    expect(toolContentMeta([p], 'start_line')).toBe('207');
    expect(toolContentMeta([p], 'nope')).toBeNull();
  });

  it('degrades to null for strings, non-arrays, and non-part entries', () => {
    expect(toolContentMeta('plain', 'start_line')).toBeNull();
    expect(toolContentMeta(null, 'start_line')).toBeNull();
    expect(toolContentMeta([{ type: 'other', meta: [['start_line', '3']] }], 'start_line')).toBeNull();
  });

  it('takes the first part hit when several parts carry the key', () => {
    expect(
      toolContentMeta([part({ meta: [['start_line', '5']] }), part({ meta: [['start_line', '9']] })], 'start_line'),
    ).toBe('5');
  });
});

describe('toolContentSuccess', () => {
  // The question the terminal's diff posture asks: does the stored result
  // ATTEST success? Every shape core actually emits is pinned here, because a
  // false true prints a never-written change with the real path and gutter.
  it('is true only for the attested success shapes', () => {
    expect(toolContentSuccess([part()])).toBe(true);
    expect(toolContentSuccess([part({ meta: [['start_line', '41']], output: 'Replaced 1 occurrence' })])).toBe(true);
    // A plain payload wrapped by formatToolResult(result, name, true).
    expect(toolContentSuccess([{ type: 'tool-result', tool: 'edit', status: 'success', meta: [], error: null, hint: null, output: 'ok' }])).toBe(true);
  });

  it('is false for every failure shape core produces', () => {
    // ToolResult.toApiContent() failure.
    expect(toolContentSuccess([part({ status: 'failure', error: 'boom', output: '' })])).toBe(false);
    // formatToolResult(x, name, false): thrown tool error, gate block, handled
    // verdict -- the failure text is in `output`, `error` stays null.
    expect(
      toolContentSuccess([part({ status: 'error', error: null, hint: 'Use the exact text', output: 'Error executing tool edit: text not found.' })]),
    ).toBe(false);
    // A part that failed but says nothing else.
    expect(toolContentSuccess([part({ status: 'error', error: null, output: 'User denied this tool call.' })])).toBe(false);
  });

  it('is false for the harness string shapes (no part, no attestation)', () => {
    for (const harness of [
      'Parameter validation error:\nmissing path',
      'Unknown tool: edit',
      'Tool execution failed: EACCES: permission denied',
      'Skipped due to maxToolCallsPerIteration limit (5)',
      '[skipped: loop stop requested]',
      '[Tool execution was interrupted]',
    ]) {
      expect(toolContentSuccess(harness)).toBe(false);
    }
  });

  it('is false for nothing-at-all, the plain-object bookkeeping shape, and arrays with no part', () => {
    expect(toolContentSuccess(null)).toBe(false);
    expect(toolContentSuccess(undefined)).toBe(false);
    expect(toolContentSuccess('')).toBe(false);
    expect(toolContentSuccess([])).toBe(false);
    expect(toolContentSuccess([{ type: 'other', status: 'success' }])).toBe(false);
    // A part with no status recorded attests nothing (a loose double is not evidence).
    expect(toolContentSuccess([{ type: 'tool-result', tool: 'edit' }])).toBe(false);
  });

  it('the first part decides, so a failure first is never overwritten by a later success', () => {
    expect(toolContentSuccess([part({ status: 'failure', error: 'boom' }), part()])).toBe(false);
    expect(toolContentSuccess([part(), part({ status: 'failure', error: 'boom' })])).toBe(true);
  });
});
