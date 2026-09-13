// toolContentText — the display-only flattener used by output surfaces
// (CLI, websocket bridge, web log view). Display, not a wire format.

import { describe, it, expect } from 'bun:test';
import { toolContentText, wrapperContentText } from '@utils/tool-content.ts';
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
});
