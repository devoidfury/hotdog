/// <reference lib="dom" />
// Sink-owned static icon set for display parts. Tool specs name icons by name
// (ToolDisplayWire.icon on the prose posture); the sink renders only what this
// map ships -- an unknown or absent name renders no icon at all, never a
// broken slot. Paths draw with currentColor (same idiom as the inline icons
// in message-list.ts), so CSS owns the tint.

import type { JsxChild } from "@utils/jsx";

export const TOOL_ICONS: Record<string, () => JsxChild> = {
  hourglass: () => (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M7 3h10" />
      <path d="M7 21h10" />
      <path d="M8 3v3.5L12 11l4-4.5V3" />
      <path d="M8 21v-3.5L12 13l4 4.5V21" />
    </svg>
  ),
};
