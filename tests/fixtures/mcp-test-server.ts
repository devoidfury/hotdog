// Tiny MCP server for testing — reads JSON-RPC from stdin, writes to stdout.
let buffer = "";

process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString();
  let idx: number;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    handleLine(line);
  }
});

function handleLine(line: string) {
  line = line.trim();
  if (!line) return;
  try {
    const msg = JSON.parse(line);
    if (msg.jsonrpc !== "2.0" || msg.id === undefined) return;
    const id = msg.id;

    if (msg.method === "initialize") {
      console.log(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "test-server", version: "1.0.0" },
          },
        }),
      );
    } else if (msg.method === "tools/list") {
      console.log(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { tools: [] },
        }),
      );
    } else if (msg.method === "tools/call") {
      console.log(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: "ok" }] },
        }),
      );
    }
  } catch {
    // ignore malformed input
  }
}
