// Slow-importing wire-factory fixture for the register-replacement race pin
// (tests/core/tool-exec-broker-spawn.test.ts): the runner's lazy import stays
// in flight across a second register frame, and the factory names an outcome
// that must NOT happen once the descriptor has been evicted.

await new Promise((r) => setTimeout(r, 400));

export const WIRE_TOOL_FACTORIES: Record<string, () => never> = {
  slow: () => {
    throw new Error("slow factory ran after register replacement");
  },
};
