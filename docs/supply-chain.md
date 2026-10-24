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

## What actually happened, 2025-2026

The properties above are design claims, so here are the attacks they're meant to survive, dated and linked. Scope is restricted to what the linked writeups support; numbers are as reported by the cited source at the time, not independently verified.

### 2025

- **March 2025 -- tj-actions/changed-files (GitHub Actions).** A compromised release of a widely pinned marketplace action dumped OIDC tokens from the runner process memory (`/proc/<pid>/mem` of the Runner.Worker). The memory-extraction script was later reused verbatim by other attackers.
- **September 15, 2025 -- Shai-Hulud.** The first large self-replicating npm worm: stolen maintainer publish tokens backdoored hundreds of packages (Securelist reported 500+, including `@ctrl/tinycolor` and CrowdStrike libraries). It harvested secrets using a *legitimate* tool -- TruffleHog -- and republished victims' own packages with the payload, propagating through the dependency graph via trust, not new exploits. ([Securelist](https://securelist.com/shai-hulud-worm-infects-500-npm-packages-in-a-supply-chain-attack/117547/))
- **November 24, 2025 -- Shai-Hulud 2.0.** Second wave, same tactics; reports put cumulative compromised packages in the tens of thousands ([Datadog](https://securitylabs.datadoghq.com/articles/shai-hulud-2.0-npm-worm/), [HackMag](https://hackmag.com/news/shai-hulud-2-0)).

### 2026

- **May 11 -- TanStack, and a coordinated multi-vendor day.** An attacker chained a `pull_request_target` "Pwn Request", GitHub Actions cache poisoning across the fork-to-base trust boundary, and OIDC token extraction from runner memory to publish **84 malicious versions across 42 `@tanstack/*` packages -- through TanStack's own legitimate OIDC trusted-publisher binding, with no npm token stolen**. Downstream, installing an affected version fetched the payload via a `github:` orphan-commit `optionalDependencies` entry and detonated it in a `prepare` lifecycle script. ([TanStack's postmortem](https://tanstack.com/blog/npm-supply-chain-compromise-postmortem) -- read it in full; it is the best public account of a publish-pipeline compromise.) Per [SafeDep](https://safedep.io/mass-npm-supply-chain-attack-tanstack-mistral/), the same coordinated wave hit 170+ npm packages and 2 PyPI packages (404 malicious versions) the same day, including Mistral AI's SDK suite, UiPath tooling, OpenSearch, and Guardrails AI.
- **May 20 -- Mini Shai-Hulud via `@antv`.** Compromised packages ran their payload during install and stole CI/CD credentials across GitHub, AWS, Kubernetes, Vault, npm, and 1Password. ([Microsoft](https://www.microsoft.com/en-us/security/blog/2026-05-20/mini-shai-hulud-compromised-antv-npm-packages-enable-ci-cd-credential-theft/))
- **May 29 -- dependency-confusion recon campaign.** 33 malicious npm packages profiling developer and build environments. ([Microsoft](https://www.microsoft.com/en-us/security/blog/2026-05-29/33-malicious-npm-packages-abuse-dependency-confusion-profile-developer-environments/))
- **August 4 -- ChainDrop.** A self-propagating worm across 400+ npm packages (including `keyv`, `flat-cache`, `cache-manager`), delivered through a `preinstall` hook as a large obfuscated Bun-based JS bundle -- note that: the runtime was Bun, which protected nothing. It harvested credentials, verified them against live cloud APIs, and republished infected packages under stolen maintainer tokens, **including via GitHub Actions OIDC abuse that produced malicious versions carrying valid provenance attestations**. Its persistence mechanism included injecting Claude and VS Code configuration files into repositories -- compromised packages poisoning the *agent instruction surface*, as observed tradecraft. ([Microsoft](https://www.microsoft.com/en-us/security/blog/2026-08-04/chaindrop-supply-chain-compromise-anatomy-self-propagating-worm/))
- **October 8 -- Tensorlake.** `tensorlake@0.5.144`, a serverless sandbox platform for AI agents, shipped a Shai-Hulud variant; 100k+ lifetime downloads. Agent infrastructure is now a named target. ([CyberSecurityNews](https://cybersecuritynews.com/tensorlake-npm-package/))
- **October 2026 -- MALFEX.** Eight packages hiding executables inside PNG files; 40,767 downloads recorded by October 1. ([CyberSecurityNews](https://cybersecuritynews.com/malfex-npm-malware/))
- **2026 -- jscrambler.** A compromised release grew the package from 37.8 kB to 7.9 MB versus the last clean version -- the tarball-diff-as-detection-signal case study. ([NH img](https://nhimg.org/articles/jscrambler-npm-compromise-shows-how-package-installs-become-credential-theft/))

## How these map to hotdog

| Attack step | Seen in | In hotdog |
|---|---|---|
| Lifecycle hook fires during install | ChainDrop, TanStack, Shai-Hulud | Nothing installs. `git clone` runs no hooks; the npm package ships no lifecycle scripts. |
| Payload fetched via (optional)Dependencies at install time | TanStack (`github:` orphan-commit dep) | No dependency resolution in the run path. `dependencies: {}`; installing the package pulls nothing transitively. |
| Malicious transitive package | Shai-Hulud, ChainDrop, @antv | No runtime tree to poison. Dev-time surface is `typescript` + `@types/bun` pinned in `bun.lock`, used only by the typecheck gate, never shipped or executed at runtime. |
| Poisoned build artifact | classic release-pipeline attacks | No build step; the npm tarball is a copy of the repo's source files and diffs clean against the git tag. |
| Publish-pipeline compromise (tokens, OIDC, CI cache) | TanStack, ChainDrop | **Not eliminated -- see the honest caveat below.** |
| Poisoned config files on disk | ChainDrop (Claude/VS Code injection) | A runtime concern, not a distribution one; the mangler and spoof neutralizer are the defense, and they assume you can read your own repo. |

**The honest caveat on the publish pipeline.** hotdog's npm releases go out through npm trusted publishing (OIDC) from this repo's own Actions workflow, so the TanStack class of attack is the one the design does *not* delete. Read the postmortem's hardest lesson carefully: once a trusted-publisher binding exists, any code path that executes inside an authorized workflow can mint a publish-capable token, and ChainDrop proved the resulting versions can carry valid attestations. What narrows the exposure here is hotdog's shape, not the pipeline's: the published tarball *is* the source tree, so a poisoned package means a poisoned commit -- visible in the same diff you'd audit anyway, with no 2.3 MB obfuscated `router_init.js` able to hide in a tree whose bytes are all supposed to be readable TypeScript. But a small, clever injection could in principle land in both the repo and the tarball, which is exactly the residual trust every source distribution carries: **the commit you run is the trust anchor, so pin the commit you actually read.** `provenance` tells you which workflow produced a tarball; it does not tell you the code is good. That distinction is worth internalizing about any npm package you use, including this one.

## Boundaries to be aware of

- **The Bun runtime is a trust boundary.** Zero dependencies doesn't cover the runtime. Install Bun from an official source and pin the version. That binary is the one third-party build artifact in your path, and it isn't hotdog's to guarantee.
- **Opt-in extensions are explicit trust boundaries.** The MCP client and skill scripts can load third-party code *you* choose to add. That's the customizability, and it's the one place hotdog runs code it didn't ship. It's off by default and deliberately opt-in.
- **The publish pipeline is a trust boundary you cannot audit away.** The npm release path is OIDC-trusted from this repo's CI, which is the vector the TanStack and ChainDrop incidents exploited despite valid attestations. See the caveat under [How these map to hotdog](#how-these-map-to-hotdog); the practical mitigation is yours, not ours -- clone at a pinned tag and read what you run.
- **Poisoned files inside the workspace are the runtime axis.** ChainDrop's persistence was malicious Claude/VS Code config files sitting in repos -- after distribution is over. No packaging property defends against that; the marker mangler, the spoof neutralizer, and the injection evals are the defenses for it.

This is a different axis from the Safety section in the README. That one is about what the *agent* can do to you; this one is about what could be *in the code* before it ever runs. hotdog keeps both surfaces as small as it can.
