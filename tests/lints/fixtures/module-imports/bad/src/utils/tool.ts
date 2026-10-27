import { coreThing } from "../core/thing.ts"; // cross-scope: @utils -> @core

export function use(): number {
  return coreThing;
}
