import { coreThing } from "./thing.ts"; // same-scope relative: fine

export function use(): number {
  return coreThing;
}
