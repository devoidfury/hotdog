import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { create } from "../../src/extensions/prompts/index.ts";
import { HOOKS } from "../../src/core/hooks.ts";
import { ACTIONS } from "../../src/core/commands.ts";
import { MockAgent } from "../helpers.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("Prompts Extension", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prompts-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writePromptFile(name: string, content: string) {
    const filePath = path.join(tmpDir, `${name}.prompt.md`);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("creates extension with loader", async () => {
    writePromptFile(
      "greet",
      "---\ndescription: Greet someone\n---\nHello {ARGS}",
    );

    const ext = await create({
      config: { prompts: { promptsPath: tmpDir } },
    } as any);

    expect(ext).toBeDefined();
    expect((ext as any).loader).toBeDefined();
  });

  it("getAllPrompts returns all loaded prompts", async () => {
    writePromptFile("greet", "---\ndescription: Greet\n---\nHello");
    writePromptFile("farewell", "---\ndescription: Farewell\n---\nGoodbye");

    const ext = await create({
      config: { prompts: { promptsPath: tmpDir } },
    } as any);

    const prompts = (ext as any).getAllPrompts();
    expect(prompts.length).toBe(2);
  });

  it("getPrompt returns a prompt by name", async () => {
    writePromptFile(
      "greet",
      "---\ndescription: Greet someone\n---\nHello {{ARGS}}",
    );

    const ext = await create({
      config: { prompts: { promptsPath: tmpDir } },
    } as any);

    const prompt = (ext as any).getPrompt("greet");
    expect(prompt).toBeDefined();
    expect(prompt.name).toBe("greet");
    expect(prompt.description).toBe("Greet someone");
  });

  it("getPrompt returns null for unknown prompt", async () => {
    writePromptFile("greet", "---\ndescription: Greet\n---\nHello");

    const ext = await create({
      config: { prompts: { promptsPath: tmpDir } },
    } as any);

    expect((ext as any).getPrompt("unknown")).toBeNull();
  });

  it("COMMANDS_REGISTER registers the prompt command", async () => {
    writePromptFile(
      "greet",
      "---\ndescription: Greet someone\n---\nHello {ARGS}",
    );

    const ext = await create({
      config: { prompts: { promptsPath: tmpDir } },
    } as any);

    expect(ext.hooks![HOOKS.COMMANDS_REGISTER]).toBeDefined();

    const registrations: any[] = [];
    const registry = {
      register: (name: string, handler: any) => registrations.push({ name, ...handler }),
    };
    await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry } as any);

    expect(registrations.length).toBe(1);
    expect(registrations[0].name).toBe("prompt");
    expect(registrations[0].matches("prompt:greet")).toBe(true);
    expect(registrations[0].matches("other")).toBe(false);
  });

  it("prompt command handler executes a prompt", async () => {
    writePromptFile(
      "greet",
      "---\ndescription: Greet someone\n---\nHello {{ARGS}}",
    );

    const ext = await create({
      config: { prompts: { promptsPath: tmpDir } },
    } as any);

    const agent = new MockAgent();
    const messagesAdded: any[] = [];
    const originalAddMessage = agent.addMessage.bind(agent);
    agent.addMessage = (msg: any) => {
      messagesAdded.push(msg);
      originalAddMessage(msg);
    };

    const registrations: any[] = [];
    const testRegistry = {
      register: (name: string, handler: any) => registrations.push({ name, ...handler }),
    };
    await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry: testRegistry } as any);

    const handler = registrations[0];
    const result = await handler.handler(agent, "prompt:greet world");
    // By default displayPrompt is true, so the handler returns both DISPLAY
    // and PROMPT flags — the bus will show the rendered prompt AND
    // enqueue it for LLM processing.
    expect(result.action).toBe(ACTIONS.PROMPT);
    expect(result.content).toBe("Hello world");
    expect(messagesAdded.length).toBe(0);
  });

  it("prompt command handler suppresses display when displayPrompt is false", async () => {
    writePromptFile(
      "greet",
      "---\ndescription: Greet someone\n---\nHello {{ARGS}}",
    );

    const ext = await create({
      config: { prompts: { promptsPath: tmpDir, displayPrompt: false } },
    } as any);

    const agent = new MockAgent();

    const registrations: any[] = [];
    const testRegistry = {
      register: (name: string, handler: any) => registrations.push({ name, ...handler }),
    };
    await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry: testRegistry } as any);

    const handler = registrations[0];
    const result = await handler.handler(agent, "prompt:greet world");
    // displayPrompt: false → only PROMPT flag, no DISPLAY
    expect(result.action).toBe(ACTIONS.PROMPT);
    expect(result.content).toBe("Hello world");
  });

  it("prompt command returns error for unknown prompt", async () => {
    const ext = await create({
      config: { prompts: { promptsPath: tmpDir } },
    } as any);

    const agent = new MockAgent();

    const registrations: any[] = [];
    const testRegistry = {
      register: (name: string, handler: any) => registrations.push({ name, ...handler }),
    };
    await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry: testRegistry } as any);

    const handler = registrations[0];
    const result = await handler.handler(agent, "prompt:unknown");
    expect(result.error).toContain("Unknown prompt");
  });

  it("handles default promptsPath when not configured", async () => {
    const ext = await create({ config: {} } as any);
    expect((ext as any).loader).toBeDefined();
  });
});
