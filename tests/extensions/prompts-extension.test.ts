import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { create } from "../../src/extensions/prompts/index.ts";
import { HOOKS } from "../../src/core/hooks.ts";
import { ACTIONS } from "../../src/core/commands.ts";
import { MockAgent } from "../helpers.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("Prompts Extension", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prompts-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writePromptFile(name, content) {
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
    });

    expect(ext).toBeDefined();
    expect(ext.loader).toBeDefined();
  });

  it("getAllPrompts returns all loaded prompts", async () => {
    writePromptFile("greet", "---\ndescription: Greet\n---\nHello");
    writePromptFile("farewell", "---\ndescription: Farewell\n---\nGoodbye");

    const ext = await create({
      config: { prompts: { promptsPath: tmpDir } },
    });

    const prompts = ext.getAllPrompts();
    expect(prompts.length).toBe(2);
  });

  it("getPrompt returns a prompt by name", async () => {
    writePromptFile(
      "greet",
      "---\ndescription: Greet someone\n---\nHello {{ARGS}}",
    );

    const ext = await create({
      config: { prompts: { promptsPath: tmpDir } },
    });

    const prompt = ext.getPrompt("greet");
    expect(prompt).toBeDefined();
    expect(prompt.name).toBe("greet");
    expect(prompt.description).toBe("Greet someone");
  });

  it("getPrompt returns null for unknown prompt", async () => {
    writePromptFile("greet", "---\ndescription: Greet\n---\nHello");

    const ext = await create({
      config: { prompts: { promptsPath: tmpDir } },
    });

    expect(ext.getPrompt("unknown")).toBeNull();
  });

  it("COMMANDS_REGISTER registers the prompt command", async () => {
    writePromptFile(
      "greet",
      "---\ndescription: Greet someone\n---\nHello {ARGS}",
    );

    const ext = await create({
      config: { prompts: { promptsPath: tmpDir } },
    });

    expect(ext.hooks[HOOKS.COMMANDS_REGISTER]).toBeDefined();

    const registrations = [];
    const registry = {
      register: (name, handler) => registrations.push({ name, handler }),
    };
    await ext.hooks[HOOKS.COMMANDS_REGISTER]({ registry });

    expect(registrations.length).toBe(1);
    expect(registrations[0].name).toBe("prompt");
    expect(registrations[0].handler.matches("prompt:greet")).toBe(true);
    expect(registrations[0].handler.matches("other")).toBe(false);
  });

  it("prompt command handler executes a prompt", async () => {
    writePromptFile(
      "greet",
      "---\ndescription: Greet someone\n---\nHello {{ARGS}}",
    );

    const ext = await create({
      config: { prompts: { promptsPath: tmpDir } },
    });

    const agent = new MockAgent();
    const messagesAdded = [];
    const originalAddMessage = agent.addMessage.bind(agent);
    agent.addMessage = (msg) => {
      messagesAdded.push(msg);
      originalAddMessage(msg);
    };

    const registrations = [];
    const testRegistry = {
      register: (name, handler) => registrations.push({ name, ...handler }),
    };
    await ext.hooks[HOOKS.COMMANDS_REGISTER]({ registry: testRegistry });

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
    });

    const agent = new MockAgent();

    const registrations = [];
    const testRegistry = {
      register: (name, handler) => registrations.push({ name, ...handler }),
    };
    await ext.hooks[HOOKS.COMMANDS_REGISTER]({ registry: testRegistry });

    const handler = registrations[0];
    const result = await handler.handler(agent, "prompt:greet world");
    // displayPrompt: false → only PROMPT flag, no DISPLAY
    expect(result.action).toBe(ACTIONS.PROMPT);
    expect(result.content).toBe("Hello world");
  });

  it("prompt command returns error for unknown prompt", async () => {
    const ext = await create({
      config: { prompts: { promptsPath: tmpDir } },
    });

    const agent = new MockAgent();

    const registrations = [];
    const testRegistry = {
      register: (name, handler) => registrations.push({ name, ...handler }),
    };
    await ext.hooks[HOOKS.COMMANDS_REGISTER]({ registry: testRegistry });

    const handler = registrations[0];
    const result = await handler.handler(agent, "prompt:unknown");
    expect(result.error).toContain("Unknown prompt");
  });

  it("handles default promptsPath when not configured", async () => {
    const ext = await create({ config: {} });
    expect(ext.loader).toBeDefined();
  });
});
