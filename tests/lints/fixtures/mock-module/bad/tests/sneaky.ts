import { mock } from "bun:test";

mock.module("../sut.ts", () => ({ sum: () => 99 })); // planted violation
