// CLI argument parsing.
// Extracted from main.js.

export function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    config: null,
    model: null,
    aiUrl: null,
    apiKey: null,
    profile: null,
    provider: null,
    role: null,
    skillsPath: null,
    promptsPath: null,
    chatTimeout: null,
    embeddingsTimeout: null,
    stream: true,
    hideTools: true,
    hideThinking: false,
    prompt: null,
    version: false,
    help: false,
    thinker: null,
    toolfmt: null,
    toolOutputFmt: null,
    noLog: false,
    loud: false,
    compactDebug: false,
    sessionId: null,
    tokens: false,
    theme: null,
    colors: null,
    preloadSkills: [],
    subcommand: null,
    reviewToolIndex: false,
    systemPromptTemplate: null,
    wantsJson: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "-f":
      case "--config":
        options.config = args[++i];
        break;
      case "-c":
      case "--prompt":
      case "prompt":
        options.prompt = args[++i];
        break;
      case "-m":
      case "--model":
        options.model = args[++i];
        break;
      case "--ai-url":
        options.aiUrl = args[++i];
        break;
      case "--url":
        console.warn("Warning: --url is deprecated, use --ai-url");
        options.aiUrl = args[++i];
        break;
      case "-k":
      case "--api-key":
        options.apiKey = args[++i];
        break;
      case "-p":
      case "--profile":
        options.profile = args[++i];
        break;
      case "--provider":
        options.provider = args[++i];
        break;
      case "--role":
        options.role = args[++i];
        break;
      case "--skills-path":
        options.skillsPath = args[++i];
        break;
      case "--prompts-path":
        options.promptsPath = args[++i];
        break;
      case "--chat-timeout":
        options.chatTimeout = parseInt(args[++i], 10);
        break;
      case "--embeddings-timeout":
        options.embeddingsTimeout = parseInt(args[++i], 10);
        break;
      case "--no-stream":
        options.stream = false;
        break;
      case "--show-tools":
        options.hideTools = false;
        break;
      case "--hide-tools":
        options.hideTools = true;
        break;
      case "--show-thinking":
        options.hideThinking = false;
        break;
      case "--hide-thinking":
        options.hideThinking = true;
        break;
      case "-t":
      case "--thinker":
        options.thinker = args[++i];
        break;
      case "--toolfmt":
        options.toolfmt = args[++i];
        break;
      case "--tool-output-fmt":
        options.toolOutputFmt = args[++i];
        break;
      case "--no-log":
        options.noLog = true;
        break;
      case "-l":
      case "--loud":
        options.loud = true;
        break;
      case "--compact-debug":
        options.compactDebug = true;
        break;
      case "--session-id":
        options.sessionId = args[++i];
        break;
      case "--tokens":
        options.tokens = true;
        break;
      case "--theme":
        options.theme = args[++i];
        break;
      case "--colors":
        options.colors = true;
        break;
      case "--no-colors":
        options.colors = false;
        break;
      case "--preload-skills":
        options.preloadSkills.push(...args[++i].split(","));
        break;
      case "--system-prompt-template":
        options.systemPromptTemplate = args[++i];
        break;
      case "info":
        options.subcommand = "info";
        break;
      case "--json":
        options.wantsJson = true;
        break;
      case "show-prompt":
        options.subcommand = "show-prompt";
        break;
      case "review":
        options.subcommand = "review";
        break;
      case "--tool-index":
        if (options.subcommand === "review") {
          options.reviewToolIndex = true;
        }
        break;
      case "-v":
      case "--version":
        options.version = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        // TODO: warn arg unrecognized
        break;
    }
    i++;
  }

  return options;
}

export const HELP_TEXT = `oa-agent - AI agent harness with tool calling support

Usage: oa-agent [options] [prompt]
       oa-agent info
       oa-agent show-prompt
       oa-agent review [--session-id <id>] [--json] [--tool-index]
       oa-agent prompt "One-shot prompt"

Subcommands:
  info                  Show system info and diagnostics
  show-prompt           Show rendered system prompt with tool definitions
  review                Review session logs

Options:
  -f, --config <path>       Config file path
  -c, --prompt              One-shot prompt alias
  -m, --model <name>        Model name
      --ai-url <url>        AI URL (deprecated: --url)
  -k, --api-key <key>       API key
  -p, --profile <name>      Profile name
      --provider <name>     AI provider to use
      --role <text>         System prompt role
      --skills-path <path>  Skills directory path
      --prompts-path <path> Prompts directory path
      --chat-timeout <s>    Chat request timeout in seconds
      --embeddings-timeout <s> Embeddings request timeout in seconds
  --no-stream               Disable streaming
  --show-tools              Show tool calls
  --show-thinking           Show thinking output
  -t, --thinker <fmt>       Thinking format string
  --toolfmt <fmt>           Tool call format string
  --tool-output-fmt <fmt>   Tool result format string
  --no-log                  Disable session logging
  -l, --loud                Print full JSON API responses
      --compact-debug       Write compaction output to compaction.out.json
      --session-id <id>     Resumable session ID
      --tokens              Display token usage stats
  --theme <name>            Theme (dark, light, monochrome, or file path)
  --colors                  Enable colors
  --no-colors               Disable colors
  --preload-skills <name>   Preload a skill by name
  --system-prompt-template <path> Custom system prompt template
  -v, --version             Show version
  -h, --help                Show help`;
