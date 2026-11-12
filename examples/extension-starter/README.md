# extension-starter

The smallest complete hotdog extension: one tool, one config block, imports
nothing outside the `hotdog/sdk` surface.

```
extension.json   manifest: name, provides, configSchema (the default's ONLY home)
index.ts         create(core) -> ExtensionInstance; registers the word_count tool
```

## Load it

`extensionPaths` entries are bundle roots (every subdirectory holding an
`extension.json` is one extension) or a single extension directory. The
setting *replaces* the built-in set, so usually you want both:

```json
{
  "extensionPaths": ["@extensions", "examples/extension-starter"]
}
```

Relative paths resolve against the process CWD; absolute paths work too.
Configure the knob the same way as any extension block:

```json
{
  "extensionStarter": { "topWords": 3 }
}
```

## The rules this demonstrates

- **SDK-only imports.** Everything an extension needs is re-exported from
  `src/sdk.ts` (`hotdog/sdk`). Zero-dep utilities live under
  `hotdog/utils/*` (e.g. `@read-receipt/hotdog/utils/strings`). Anything else
  under `src/` is internal.
- **No backup defaults.** `configSchema` in `extension.json` owns defaults;
  the code reads the value and trusts the config system.
- **Read config at the point of use.** The tool resolves `topWords` inside
  `execute()`, so a mid-session config change lands on the next call.
- **`enabled: false` means never loaded.** The loader gates on the manifest +
  config; `create()` does not re-check it.

## Authoring from outside the tree

The import specifier is identical everywhere; only the *anchor* differs:

- **In this clone** (this directory): package self-reference resolves
  `@read-receipt/hotdog/sdk` through `exports`. Nothing to do.
- **Your own bundle directory, developing against a clone**: `bun link` in the
  hotdog checkout, then `bun link @read-receipt/hotdog` in your bundle.
- **Your own project**: `bun add @read-receipt/hotdog` (zero transitive deps,
  no lifecycle scripts).

A bundle directory with no link and no install fails loudly with
`Cannot find package '@read-receipt/hotdog'` -- that is the signal to link.

## Try it

```sh
bun bin/hotdog -p "count the words in: the quick brown fox jumps over the lazy dog"
```

The repo's test suite boots this extension through the real discovery and
loader path (`extension-starter.test.ts` next to this README).
