import { describe, it, expect, beforeEach } from 'bun:test';
import { CliOutputSink } from '../../src/ui/cli.js';
import { OUTPUT_EVENT } from '../../src/context/output.js';
import { ColorPalette } from '../../src/ui/colors.js';

describe('CliOutputSink.emitSessionState', () => {
  let sink;

  beforeEach(() => {
    sink = new CliOutputSink({
      palette: ColorPalette.default(),
      hideTools: true,
      hideThinking: false,
    });
  });

  it('updates hideTools when SESSION_STATE event received', () => {
    expect(sink.hideTools).toBe(true);
    sink.emit({
      type: OUTPUT_EVENT.SESSION_STATE,
      key: 'hideTools',
      value: false,
    });
    expect(sink.hideTools).toBe(false);

    sink.emit({
      type: OUTPUT_EVENT.SESSION_STATE,
      key: 'hideTools',
      value: true,
    });
    expect(sink.hideTools).toBe(true);
  });

  it('updates hideThinking when SESSION_STATE event received', () => {
    expect(sink.hideThinking).toBe(false);
    sink.emit({
      type: OUTPUT_EVENT.SESSION_STATE,
      key: 'hideThinking',
      value: true,
    });
    expect(sink.hideThinking).toBe(true);

    sink.emit({
      type: OUTPUT_EVENT.SESSION_STATE,
      key: 'hideThinking',
      value: false,
    });
    expect(sink.hideThinking).toBe(false);
  });

  it('ignores unknown state keys', () => {
    const originalHideTools = sink.hideTools;
    const originalHideThinking = sink.hideThinking;
    sink.emit({
      type: OUTPUT_EVENT.SESSION_STATE,
      key: 'unknownKey',
      value: true,
    });
    expect(sink.hideTools).toBe(originalHideTools);
    expect(sink.hideThinking).toBe(originalHideThinking);
  });
});
