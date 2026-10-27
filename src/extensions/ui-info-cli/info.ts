// `hotdog info`: system info and diagnostics. Owns the provider-pool health
// sweep (through the same module the TaskManager uses, one-shot with no
// session so it probes its own view), the extension status section, and the
// text/JSON renderers. `--config-debug` delegates to config-trace.ts.
import { CONFIG_SCHEMA, getLayerDefault, loadConfig, ProviderDef, resolveConfigDir, type CliArgv } from "@core/config/index.ts";
import { CoreConfigWithExtensions } from "@core/config/index.ts";
import { discoverExtensions, isExtensionEnabled } from "@core/extensions/extensions.ts";
import { collectInfoPanels, CoreContext, ExtensionInfoPanel, InfoValue } from "@core/extensions/types.ts";
import { makeProviderHealth } from "@core/session/provider-health.ts";
import {
  execFenceDisplay,
  toolExecModeLabel,
  toolExecPlaneSettings,
  sharedToolExecDegraded,
} from "@core/tool-exec-broker.ts";
import { rendererMountPosture } from "@extensions/ui-interactive-cli/split-bridge.ts";
import type { BuildAgentConfig } from "@core/config/index.ts";
import { printConfigDebug } from "./config-trace.ts";

// Name for the synthetic baseUrl probe when no provider resolves to it.
// Deliberately not a legal provider name, so it can never collide.
const BASE_URL_PROBE = "*baseUrl";

interface ConnectivityResult {
  reachable: boolean;
  error: string | null;
}

interface McpServerDef {
  name: string;
  enabled?: boolean;
  url?: string;
  command?: string;
}

export async function runInfo(cli: CliArgv, core: CoreContext): Promise<number> {
  const buildConfig = core.buildConfig!;
  // `config` is buildConfig's merged config with extension config resolved --
  // the same object the session reads, so diagnostics cannot drift from it.
  const { resolved, config, modelRegistry, providers } = await buildConfig(cli);
  const configDir = resolved.configDir || resolveConfigDir(cli.configDir);

  if (cli.configDebug) {
    // Layer tracing wants the file values, not the resolved merge.
    return await printConfigDebug(cli, await loadConfig(cli.config, configDir), providers, resolved);
  }

  // Extension-owned status (the skills extension reports its own path and
  // counts; nothing here knows how any single extension computes them).
  const panels = collectInfoPanels(core.extensions);

  // connectivity sweep of the provider pool through the same module the TaskManager uses,
  // plus a synthetic probe for the global baseUrl when no provider resolves to it --
  // the same <base>/health request the old standalone ping made.
  // `info` is a one-shot command without a session, so it probes its own view rather than sharing a running manager's.
  // The JSON `connectivity` block and the Providers health notes all read from these verdicts.
  const baseUrl = resolved.baseUrl;
  const baseCoverer = baseUrl
    ? providers.find((p) => !p.url || p.url === baseUrl)
    : undefined;
  const baseProbe =
    baseUrl && !baseCoverer
      ? ({ name: BASE_URL_PROBE, url: baseUrl, models: [] } as ProviderDef)
      : null;
  const sweepProviders = baseProbe ? [...providers, baseProbe] : providers;

  const providerHealthMap = new Map<string, { down: boolean; reason: string | null }>();
  let baseUrlVerdict: { down: boolean; reason: string | null } | null = null;
  if (sweepProviders.length > 0) {
    const health = makeProviderHealth({
      providers: sweepProviders,
      globals: { baseUrl, apiKey: resolved.apiKey },
      intervalMs: 0,
      timeoutMs:
        (resolved.healthCheckTimeout ?? (getLayerDefault(CONFIG_SCHEMA.healthCheckTimeout) as number)) * 1000,
    });
    await health.sweep();
    health.stop();
    for (const s of health.status()) {
      if (baseProbe && s.name === BASE_URL_PROBE) {
        baseUrlVerdict = { down: s.down, reason: s.reason };
        continue;
      }
      const def = providers.find((p) => p.name === s.name);
      if (!def?.url && !baseUrl) continue;
      providerHealthMap.set(s.name, { down: s.down, reason: s.reason });
    }
  }

  // JSON `connectivity`: the verdict for the url answering for the base -- the
  // synthetic probe, else the first provider that resolves to it. Fail-open on
  // a missing verdict, like health treats unknown providers everywhere else.
  const connectivity: ConnectivityResult = (() => {
    if (!baseUrl) return { reachable: false, error: "no base url configured" };
    const v =
      baseUrlVerdict ?? (baseCoverer ? (providerHealthMap.get(baseCoverer.name) ?? null) : null);
    if (!v) return { reachable: true, error: null };
    return v.down
      ? { reachable: false, error: v.reason ?? "probe failed" }
      : { reachable: true, error: null };
  })();

  const extensionStatus = await getExtensionStatuses(config, core.extensions);

  if (cli.wantsJson) {
    return printInfoJson(resolved, modelRegistry, providers, panels, connectivity, config, extensionStatus, providerHealthMap);
  }

  return printInfoText(resolved, modelRegistry, providers, panels, config, extensionStatus, providerHealthMap, baseUrlVerdict);
}

interface ExtensionStatus {
  name: string;
  loaded: boolean;
  enabled: boolean;
}

/**
 * Per-discovered-extension view for the Extensions section: loaded into this
 * session, and enabled per config. An enabled-but-not-loaded extension was
 * excluded by `extensions` list selection or `extensionAutoload: false`.
 */
async function getExtensionStatuses(
  config: Record<string, unknown>,
  loader: { all(): Iterable<[string, unknown]> } | null | undefined,
): Promise<ExtensionStatus[]> {
  const extensionPaths = (config?.extensionPaths as string[]) || ["@extensions"];
  const serviceOverrides = (config?.services as Record<string, string>) || {};
  const discovered = await discoverExtensions(extensionPaths, serviceOverrides);
  const loaded = new Set<string>();
  for (const [name] of loader?.all() ?? []) loaded.add(name);

  const statuses = discovered.map((ext) => ({
    name: ext.name,
    loaded: loaded.has(ext.name),
    enabled: isExtensionEnabled(ext.name, config as CoreConfigWithExtensions),
  }));
  statuses.sort((a, b) => a.name.localeCompare(b.name));
  return statuses;
}

function printInfoText(
  resolved: BuildAgentConfig,
  modelRegistry: Record<string, unknown>,
  providers: ProviderDef[],
  panels: ExtensionInfoPanel[],
  config: Record<string, unknown>,
  extensionStatus: ExtensionStatus[],
  providerHealthMap: Map<string, { down: boolean; reason: string | null }> = new Map(),
  baseUrlVerdict: { down: boolean; reason: string | null } | null = null,
): number {
  console.log("=== Agent Harness Info ===");
  console.log();
  console.log("Configuration:");
  const configDirAbs = resolved.configDir || resolveConfigDir(undefined);
  console.log(`  Config Dir:      ${configDirAbs}`);
  console.log(`  AI URL:          ${resolved.baseUrl}`);
  console.log(`  Default Model:   ${resolved.model || "(none)"}`);
  console.log(`  Chat Timeout:    ${resolved.chatTimeout}s`);
  console.log(`  Profile:         ${resolved.profileName}`);
  // Tool execution plane posture: never silent.
  // The degraded flag is runtime state on the shared broker, so it is passed
  // in rather than read from the resolved config.
  console.log(`  Tools Exec:      ${toolExecModeLabel(resolved, sharedToolExecDegraded(), execFenceDisplay(resolved))}`);
  // Split-renderer posture, same never-silent style as the fence line: the §9
  // gate is pure knob + TTY + TERM, so what it would decide in THIS
  // environment is exactly what the next interactive session does. `info`
  // runs outside any session (nothing is mounted at report time), so the
  // line honestly reports the gate decision, not a live mount.
  const rendererPosture = rendererMountPosture(
    ((config?.uiInteractiveCli as Record<string, unknown> | undefined) || {}).renderer,
    process.stdin.isTTY,
    process.stdout.isTTY,
    process.env.TERM,
  );
  console.log(`  Renderer:        ${rendererPosture.mode} (${rendererPosture.reason})`);
  if (resolved.profileDef?.whitelistTools) {
    console.log(`  Whitelist Tools: ${(resolved.profileDef.whitelistTools as string[]).join(", ")}`);
  }
  if ((resolved.profileDef?.blacklistTools as string[])?.length > 0) {
    console.log(`  Blacklist Tools: ${(resolved.profileDef!.blacklistTools as string[]).join(", ")}`);
  }

  printExtensionsSection(extensionStatus);

  if (providers.length > 0 || baseUrlVerdict) {
    console.log();
    console.log("Providers:");
    for (const p of providers) {
      const isActive = resolved.activeProvider === p.name;
      const isDefault = (config?.defaultProvider as string) === p.name;
      const marker = isActive ? " (active)" : isDefault ? " (default)" : "";
      const modelNames = (p.models || []).map((m) => m.name).join(", ");
      const displayUrl = p.url || `${resolved.baseUrl} (inherited)`;
      // Health verdict from the sweep (providers with no resolvable url are
      // never probed; map absence, treated as up elsewhere, prints nothing).
      const h = providerHealthMap.get(p.name);
      const healthNote = h ? (h.down ? `  down: ${h.reason ?? "probe failed"}` : "  up") : "";
      console.log(`  ${p.name}${marker} → ${displayUrl}  [${modelNames}]${healthNote}`);
    }
    // The synthetic baseUrl probe: shown only when no provider already answers
    // for that url (otherwise its verdict is one of the lines above).
    if (baseUrlVerdict) {
      const note = baseUrlVerdict.down
        ? `  down: ${baseUrlVerdict.reason ?? "probe failed"}`
        : "  up";
      console.log(`  (base url) → ${resolved.baseUrl}${note}`);
    }
    if (resolved.activeProvider) {
      console.log();
      console.log(`Active Provider: ${resolved.activeProvider}`);
    }
  }

  console.log();
  console.log(`Models (${Object.keys(modelRegistry).length}):`);
  for (const name of Object.keys(modelRegistry)) {
    const m = modelRegistry[name] as Record<string, unknown>;
    const tagStr = ((m.tags as string[]) || []).length > 0 ? (m.tags as string[]).join(", ") : "no tags";
    console.log(`  ${name} [${tagStr}]`);
  }
  printInfoPanels(panels);

  const mcpServers = (config?.mcpServers as McpServerDef[]) || [];
  if (mcpServers.length > 0) {
    console.log();
    console.log("MCP Servers:");
    for (const server of mcpServers) {
      const enabled = server.enabled !== false ? "enabled" : "disabled";
      const transport = server.url
        ? `HTTP (${server.url})`
        : server.command
          ? `stdio (${server.command})`
          : "unknown";
      console.log(`  ${server.name}: ${transport} [${enabled}]`);
    }
  }

  return 0;
}

// Extensions section: what the scan found, which instances are live in this
// session, and which are switched off (`(disabled)` in config) or excluded by
// `extensionAutoload: false` / `extensions` list selection (`(not loaded)`).
function printExtensionsSection(status: ExtensionStatus[]): void {
  if (status.length === 0) return;
  const loaded = status.filter((s) => s.loaded).length;
  const disabled = status.filter((s) => !s.enabled).length;
  console.log();
  console.log(`Extensions (${loaded} loaded, ${disabled} disabled):`);
  for (const s of status) {
    const mark = s.loaded ? "" : !s.enabled ? " (disabled)" : " (not loaded)";
    console.log(`  ${s.name}${mark}`);
  }
}

// Renders extension-contributed status panels. Nothing here knows what any
// extension measures: keys come from the panel, casing and alignment from here.
function printInfoPanels(panels: ExtensionInfoPanel[]): void {
  for (const panel of panels) {
    console.log();
    console.log(`${labelFor(panel.name)}:`);
    for (const section of panel.sections) {
      // A titled block indents its fields so the grouping stays visible.
      const indent = section.title ? "    " : "  ";
      if (section.title) {
        console.log(`  ${labelFor(section.title)}:`);
      }
      // Values in a block line up on the longest key, like the Configuration block.
      const width = section.fields.reduce((max, f) => Math.max(max, f.key.length), 0);
      for (const { key, value } of section.fields) {
        console.log(`${indent}${`${labelFor(key)}:`.padEnd(width + 2)}${formatInfoValue(value)}`);
      }
    }
  }
}

// path -> Path. Panels send lowercase machine keys; surfaces pick the display case.
function labelFor(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function formatInfoValue(value: InfoValue): string {
  if (value === null) return "(none)";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "(none)";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

// Panels as JSON: fields of the main block inline, titled sections nested,
// keyed by panel name. Keeps the machine-readable shape flat where it can be.
function infoPanelsToJson(panels: ExtensionInfoPanel[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const panel of panels) {
    const body: Record<string, unknown> = {};
    for (const section of panel.sections) {
      const fields = Object.fromEntries(section.fields.map((f) => [f.key, f.value]));
      if (section.title) Object.assign(body, { [section.title]: fields });
      else Object.assign(body, fields);
    }
    if (panel.detail !== undefined) body.detail = panel.detail;
    result[panel.name] = body;
  }
  return result;
}

function printInfoJson(
  resolved: BuildAgentConfig,
  modelRegistry: Record<string, unknown>,
  providers: ProviderDef[],
  panels: ExtensionInfoPanel[],
  connectivity: ConnectivityResult,
  config: Record<string, unknown>,
  extensionStatus: ExtensionStatus[],
  providerHealthMap: Map<string, { down: boolean; reason: string | null }> = new Map(),
): number {
  // Tool plane posture in the JSON mirror of the text line above: the fence
  // is the probe result -- "bwrap" jailed, "off" by policy, "none" wanted but
  // unavailable (probe failed; the text line carries that wording).
  const plane = toolExecPlaneSettings(resolved);
  const planeDegraded = sharedToolExecDegraded();
  const fenceDisplay = execFenceDisplay(resolved);
  const json = {
    config: {
      ai_url: resolved.baseUrl,
      default_model: resolved.model,
      chat_timeout_secs: resolved.chatTimeout,
      profile: resolved.profileName,
      profile_whitelist: resolved.profileDef?.whitelistTools || null,
      profile_blacklist: resolved.profileDef?.blacklistTools || [],
      tools_exec: plane.mode,
      tools_fence:
        plane.mode === "worker"
          ? fenceDisplay === "bwrap" || fenceDisplay === "off"
            ? fenceDisplay
            : "none"
          : null,
      // Runtime flag: crash-respawn budget exhausted, never an
      // inline downgrade -- a degraded plane still rejects loudly.
      tools_exec_degraded: planeDegraded,
      // Split-renderer §9 gate projection for this environment (mirror of the
      // text line; info never runs inside a mounted session, so "mount" is
      // what the next interactive session would decide, never a live state).
      renderer: rendererMountPosture(
        ((config?.uiInteractiveCli as Record<string, unknown> | undefined) || {}).renderer,
        process.stdin.isTTY,
        process.stdout.isTTY,
        process.env.TERM,
      ),
    },
    providers: {
      configured: providers.map((p) => ({
        name: p.name,
        url: p.url || null,
        resolvedUrl: p.url || resolved.baseUrl,
        models: (p.models || []).map((m) => m.name),
        health: (() => {
          const h = providerHealthMap.get(p.name);
          return h ? (h.down ? "down" : "up") : null;
        })(),
        health_error: providerHealthMap.get(p.name)?.down
          ? providerHealthMap.get(p.name)!.reason
          : null,
      })),
      active: resolved.activeProvider || null,
    },
    models: Object.keys(modelRegistry).map((name) => {
      const m = modelRegistry[name] as Record<string, unknown>;
      return { name, tags: (m.tags as string[]) || [] };
    }),
    extensions: infoPanelsToJson(panels),
    extension_status: extensionStatus,
    mcp_servers: ((config?.mcpServers as McpServerDef[]) || []).map((s) => ({
      name: s.name,
      enabled: s.enabled !== false,
      url: s.url || null,
      command: s.command || null,
    })),
    connectivity: {
      url: resolved.baseUrl,
      reachable: connectivity.reachable,
      error: connectivity.error || null,
    },
  };
  console.log(JSON.stringify(json, null, 2));
  return 0;
}
