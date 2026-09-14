# Supply Chain

hotdog ships as a source tree. There is no build step, no published artifact, and no install step that runs third-party code. You clone the repo and run it directly:

```sh
git clone https://github.com/devoidfury/hotdog.git
cd hotdog
bun bin/hotdog
```

The versions are all tagged so you can check out any specific version you want to run, if you're worried about the churn on my main branch.

Three properties follow, and each removes a step that supply-chain attacks need:

- **Nothing is installed.** No `npm install`, no `node_modules`. There's no `postinstall`/`prepare` hook and no `optionalDependencies`. The whole class of payload that ships *inside* a package and detonates during install has nowhere to sit.
- **Zero runtime dependencies.** `dependencies` is empty -- no runtime dependencies, no transitive tree, so a compromised upstream package has no path in. The entire runtime is the TypeScript in `src/`, all in the repo, all readable. The repo does carry a `bun.lock`, but it pins only the single dev-time dependency (`@types/bun`) and its type-only peers -- nothing it references is shipped or executed.
- **Nothing is built by someone else's CI.** You're not running an artifact a third-party build runner produced. The failure mode where a poisoned build cache or a compromised release pipeline emits a "legitimate-looking" tarball (right version, right author, right signature) requires a build-and-publish step. hotdog has none in your install path; the source you run is the source in the repo, and it's small enough to read.

Put together, the common vectors (install-time lifecycle execution, malicious transitive dependencies, and compromised build/CI pipelines producing poisoned published artifacts) have no foothold in how hotdog is distributed. An attacker would have to compromise the git repo you clone or the Bun runtime itself; both are things you can see, pin, and audit.

## Boundaries to be aware of

- **The Bun runtime is a trust boundary.** Zero dependencies doesn't cover the runtime. Install Bun from an official source and pin the version. That binary is the one third-party build artifact in your path, and it isn't hotdog's to guarantee.
- **Opt-in extensions are explicit trust boundaries.** The MCP client and skill scripts can load third-party code *you* choose to add. That's the customizability, and it's the one place hotdog runs code it didn't ship. It's off by default and deliberately opt-in.

This is a different axis from the Safety section in the README. That one is about what the *agent* can do to you; this one is about what could be *in the code* before it ever runs. hotdog keeps both surfaces as small as it can.
