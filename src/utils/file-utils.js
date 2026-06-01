import { YAML } from "bun";

/**
 * Parse YAML front matter from a markdown string.
 * Returns { frontMatter: object, body: string } or null if no front matter.
 */
export function parseFrontMatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const body = m[2] || "";
  const fm = YAML.parse(m[1]);
  return { frontMatter: fm, body };
}
