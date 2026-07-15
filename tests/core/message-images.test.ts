import { test, expect } from "bun:test";
import { Message } from "../../src/core/context/message.ts";

type ContentPart = { type: string; text?: string; image_url?: { url: string } };

// ── Message with images ──────────────────────────────────────────────────────
// Note: basic toJSON() without images is already covered by message.test.js.

test("Message.toJSON() returns array content when images present", () => {
  const msg = new Message({
    role: "user",
    content: "What is in this image?",
    images: [{ type: "image_url", mimeType: "image/png", data: "abc123" }],
  });
  const json = msg.toJSON();

  const content = json.content as ContentPart[];
  expect(Array.isArray(content)).toBe(true);
  expect(content).toEqual([
    { type: "text", text: "What is in this image?" },
    {
      type: "image_url",
      image_url: { url: "data:image/png;base64,abc123" },
    },
  ]);
  expect(json.images).toEqual([
    { type: "image_url", mimeType: "image/png", data: "abc123" },
  ]);
});

test("Message.toJSON() handles multiple images", () => {
  const msg = new Message({
    role: "user",
    content: "Compare these images",
    images: [
      { type: "image_url", mimeType: "image/png", data: "img1" },
      { type: "image_url", mimeType: "image/jpeg", data: "img2" },
      { type: "image_url", mimeType: "image/webp", data: "img3" },
    ],
  });
  const json = msg.toJSON();

  const content = json.content as ContentPart[];
  expect(content.length).toBe(4); // 1 text + 3 images
  expect(content[0]).toEqual({ type: "text", text: "Compare these images" });
  expect(content[1]).toEqual({
    type: "image_url",
    image_url: { url: "data:image/png;base64,img1" },
  });
  expect(content[2]).toEqual({
    type: "image_url",
    image_url: { url: "data:image/jpeg;base64,img2" },
  });
  expect(content[3]).toEqual({
    type: "image_url",
    image_url: { url: "data:image/webp;base64,img3" },
  });
});

test("Message.toJSON() handles images with data: URI already present", () => {
  const msg = new Message({
    role: "user",
    content: "Look at this",
    images: [
      {
        type: "image_url",
        mimeType: "image/png",
        data: "data:image/png;base64,alreadyencoded",
      },
    ],
  });
  const json = msg.toJSON();
  const content1 = json.content as ContentPart[];

  expect(content1[1]).toEqual({
    type: "image_url",
    image_url: { url: "data:image/png;base64,alreadyencoded" },
  });
});

test("Message.toJSON() handles images without text content", () => {
  const msg = new Message({
    role: "user",
    content: null,
    images: [{ type: "image_url", mimeType: "image/png", data: "img" }],
  });
  const json = msg.toJSON();
  const content2 = json.content as ContentPart[];

  expect(content2.length).toBe(1);
  expect(content2[0]).toEqual({
    type: "image_url",
    image_url: { url: "data:image/png;base64,img" },
  });
});

test("Message.toJSON() handles array content with images", () => {
  const msg = new Message({
    role: "user",
    content: [
      { type: "text", text: "Part 1" },
      { type: "text", text: "Part 2" },
    ],
    images: [{ type: "image_url", mimeType: "image/png", data: "img" }],
  });
  const json = msg.toJSON();
  const content3 = json.content as ContentPart[];

  expect(content3.length).toBe(3);
  expect(content3[0]).toEqual({ type: "text", text: "Part 1" });
  expect(content3[1]).toEqual({ type: "text", text: "Part 2" });
  expect(content3[2]).toEqual({
    type: "image_url",
    image_url: { url: "data:image/png;base64,img" },
  });
});

test("Message.getTextContent() returns plain string for string content", () => {
  const msg = new Message({ role: "user", content: "Hello world" });
  expect(msg.getTextContent()).toBe("Hello world");
});

test("Message.getTextContent() extracts text from array content", () => {
  const msg = new Message({
    role: "user",
    content: [
      { type: "text", text: "Line 1" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      { type: "text", text: "Line 2" },
    ],
  });
  expect(msg.getTextContent()).toBe("Line 1\nLine 2");
});

test("Message.getTextContent() returns empty string for null content", () => {
  const msg = new Message({ role: "user", content: null });
  expect(msg.getTextContent()).toBe("");
});

test("Message constructor accepts snake_case images", () => {
  const msg = new Message({
    role: "user",
    content: "Hello",
    images: [{ type: "image_url", mimeType: "image/png", data: "abc" }],
  });
  expect(msg.images).toEqual([
    { type: "image_url", mimeType: "image/png", data: "abc" },
  ]);
});

test("Message with images preserves other fields", () => {
  const msg = new Message({
    role: "assistant",
    content: "Response",
    reasoningContent: "Thinking...",
    toolCalls: [{ id: "tc_1", type: "function", function: { name: "test", arguments: "{}" } }],
    images: [{ type: "image_url", mimeType: "image/png", data: "img" }],
  });
  const json = msg.toJSON();

  expect(json.role).toBe("assistant");
  expect(json.reasoning_content).toBe("Thinking...");
  expect(json.tool_calls).toEqual([
    { id: "tc_1", type: "function", function: { name: "test", arguments: "{}" } },
  ]);
  expect(json.images).toEqual([
    { type: "image_url", mimeType: "image/png", data: "img" },
  ]);
});

test("Message omits images in toJSON when absent or empty", () => {
  expect(new Message({ role: "user", content: "Hello" }).toJSON().images).toBeUndefined();
  expect(new Message({ role: "user", content: "Hello", images: [] }).toJSON().images).toBeUndefined();
});

// ── Default mimeType fallback ────────────────────────────────────────────────

test("Message.toJSON() defaults to image/png when mimeType not specified", () => {
  const msg = new Message({
    role: "user",
    content: "Test",
    images: [{ type: "image_url", mimeType: "image/png", data: "abc" }],
  });
  const json = msg.toJSON();
  const content4 = json.content as ContentPart[];

  expect(content4[1]).toEqual({
    type: "image_url",
    image_url: { url: "data:image/png;base64,abc" },
  });
});
