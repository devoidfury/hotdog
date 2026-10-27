import { mock } from "bun:test";

mock.module("../sut.ts", () => ({ sum: () => 42 })); // planted violation #2
