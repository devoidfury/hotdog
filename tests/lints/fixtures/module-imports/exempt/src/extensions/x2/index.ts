import { shared } from "../x1/leaf.ts"; // same @extensions scope: allowed by the rule

export function use(): number {
  return shared;
}
