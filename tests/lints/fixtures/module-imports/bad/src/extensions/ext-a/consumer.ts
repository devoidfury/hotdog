import { coreThing } from "../../core/thing.ts"; // cross-scope: @extensions -> @core

export function use(): number {
  return coreThing + 1;
}
