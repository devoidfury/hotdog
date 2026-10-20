// KeyEvent: the decoded-key currency between StdinBuffer and the editor
// (design note §5/§11). StdinBuffer turns raw chunks into these; nothing
// downstream sees escape bytes.

/**
 * Named keys. Control chords are `ctrl-<char>` (ctrl-a, ctrl-\, ctrl-space);
 * meta/alt is `alt-<char>` or `alt-<ctrlname>`. CSI modifiers are composed in
 * a fixed order: ctrl-, alt-, shift- (e.g. "ctrl-alt-left").
 */
export type KeyName = string;

export type KeyEvent =
  | { kind: "text"; text: string }
  | { kind: "key"; name: KeyName }
  | { kind: "paste"; text: string };

export const isText = (e: KeyEvent): e is { kind: "text"; text: string } => e.kind === "text";
export const isKey = (e: KeyEvent, name?: KeyName): e is { kind: "key"; name: KeyName } =>
  e.kind === "key" && (name === undefined || e.name === name);
export const isPaste = (e: KeyEvent): e is { kind: "paste"; text: string } => e.kind === "paste";
