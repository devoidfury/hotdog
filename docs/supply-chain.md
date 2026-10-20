# Supply Chain

hotdog ships as a source tree. There is no build step and no install step that runs third-party code. You clone the repo and run it directly:

```sh
git clone https://github.com/devoidfury/hotdog.git
cd hotdog
bun bin/hotdog
```

The same tree is also on npm as `@read-receipt/hotdog` for convenience -- see [Install from npm](../README.md#install-from-npm-optional). The tarball is a copy of the source files (`bin/`, `src/`, `examples/`, `tsconfig.json`), not a compiled or bundled artifact: installing it runs no lifecycle scripts and pulls no transitive dependencies, and its contents diff clean against the git tag of the same version.

The versions are all tagged so you can check out any specific version you want to run, if you're worried about the churn on my main branch.

Three properties follow, and each removes a step that supply-chain attacks need:

- **Nothing is installed to run it.** No `npm install`, no `node_modules` in the run path -- cloning and running is all hotdog needs. There's no `postinstall`/`prepare` hook and no `optionalDependencies`. The whole class of payload that ships *inside* a package and detonates during install has nowhere to sit. (The only place a `bun install` ever happens is dev work -- the typecheck gate's `typescript`; see the next bullet.)
- **Zero runtime dependencies.** `dependencies` is empty -- no runtime dependencies, no transitive tree, so a compromised upstream package has no path in. The entire runtime is the TypeScript in `src/`, all in the repo, all readable. The repo does carry a `bun.lock`, but it pins only the two dev-time dependencies -- `typescript` (the `bun run check` typecheck gate) and `@types/bun` -- plus their type-only peers; nothing they reference is shipped or executed. These are the project's entire dev-dependency surface, and `typescript` is the only one that needs maintenance: bump it and re-run `bun run check`; `@types/bun` just tracks the Bun release you already pin.
- **Nothing is compiled by someone else's CI.** There is no build step, so there is no place for a poisoned compiler or build cache to inject a byte that isn't in the repo. The npm package is published from a tagged GitHub release by this repo's own Actions workflow through npm trusted publishing (OIDC, no stored token), and each version carries a Sigstore provenance attestation naming the repository, workflow file, and commit that produced it -- `npm view @read-receipt/hotdog dist.attestations`, or `npm audit signatures` from a consuming project. The classic "legitimate-looking tarball from a compromised release pipeline" class narrows here to: the attested commit itself, which is the same thing a git clone trusts. (The one exception: 0.13.0 was the initial manual bootstrap publish and has no attestation; every version after it does.)

Put together, the common vectors (install-time lifecycle execution, malicious transitive dependencies, and poisoned compiled artifacts) have no foothold in how hotdog is distributed; what remains is the honest trust every source distribution has: the commit you run. An attacker would have to compromise the git repo you clone, the attested release commit, or the Bun runtime itself -- all things you can see, pin, and audit.

## Boundaries to be aware of

- **The Bun runtime is a trust boundary.** Zero dependencies doesn't cover the runtime. Install Bun from an official source and pin the version. That binary is the one third-party build artifact in your path, and it isn't hotdog's to guarantee.
- **Opt-in extensions are explicit trust boundaries.** The MCP client and skill scripts can load third-party code *you* choose to add. That's the customizability, and it's the one place hotdog runs code it didn't ship. It's off by default and deliberately opt-in.

This is a different axis from the Safety section in the README. That one is about what the *agent* can do to you; this one is about what could be *in the code* before it ever runs. hotdog keeps both surfaces as small as it can.
