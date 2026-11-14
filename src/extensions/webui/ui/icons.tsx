/// <reference lib="dom" />
// Sink-owned static icon set for display parts. Two related uses:
//
//   1. Tool display icons (ToolDisplayWire.icon on the prose posture): the
//      sink renders only what TOOL_ICONS ships -- an unknown or absent name
//      renders no icon at all, never a broken slot.
//   2. The shared chrome glyph set. Glyph() stamps the house idiom once
//      (24 viewBox, fill=none, stroke=currentColor, rounded caps/joins,
//      aria-hidden decoration AND tabindex="-1"); callers bring the geometry
//      and CSS keeps owning the tint: the parent status/row class sets
//      `color`, the svg inherits. The status switches (row badge, subagent
//      chip) are data-driven maps from token to shape.

import type { JsxChild } from "@utils/jsx";

export const TOOL_ICONS: Record<string, () => JsxChild> = {
  hourglass: () => (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      tabindex="-1"
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

// ── Shared chrome glyphs ────────────────────────────────────────────────────

interface GlyphProps {
    size?: number;
    strokeWidth?: number;
    viewBox?: string;
    className?: string;
    children?: JsxChild;
}

/** Header chrome icons ride 20px; everything else keeps the 16px default. */
export const HEADER_ICON_SIZE = 20;

/** The house inline-glyph idiom: 16px default, currentColor stroke,
 *  decorative (aria-hidden) and tab-invisible (tabindex="-1"). Sizing rides
 *  the width/height attrs; color rides the parent's CSS `color`, so every
 *  status tint stays CSS-owned. viewBox defaults to the 24 grid; shapes that
 *  fill their whole box (the palette blob) pass a padded one to zoom out to
 *  the neighbors' optical size. */
export function Glyph({ size = 16, strokeWidth = 1.8, viewBox = "0 0 24 24", className, children }: GlyphProps): JsxChild {
  return (
    <svg
      viewBox={viewBox}
      width={size}
      height={size}
      aria-hidden="true"
      tabindex="-1"
      fill="none"
      stroke="currentColor"
      stroke-width={strokeWidth}
      stroke-linecap="round"
      stroke-linejoin="round"
      class={className}
    >
      {children}
    </svg>
  );
}

/** Artist's palette for the theme switcher: rounded blob with the thumb
 *  bite at the lower right and four paint dots at r=2. The blob fills the
 *  whole 24 grid, so at equal px it would read bigger than its stroke-icon
 *  neighbors (their content lives around r=9); the padded viewBox zooms it
 *  out to their optical size, and the stroke thickens to land back on their
 *  rendered weight after the shrink. */
export function IconPalette(): JsxChild {
  return (
    <Glyph size={HEADER_ICON_SIZE} strokeWidth={2.2} viewBox="-3 -3 30 30">
      <path d="M12 2C6.49 2 2 6.49 2 12s4.49 10 10 10c1.38 0 2.5-1.12 2.5-2.5 0-.61-.23-1.2-.64-1.67-.08-.1-.13-.21-.13-.33 0-.28.22-.5.5-.5H16c3.31 0 6-2.69 6-6 0-4.96-4.49-9-10-9Z" />
      <circle cx="17.5" cy="13" r="2" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="9" r="2" fill="currentColor" stroke="none" />
      <circle cx="9.5" cy="7" r="2" fill="currentColor" stroke="none" />
      <circle cx="6.5" cy="13" r="2" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Settings gear: solid-filled so it reads bold at the header's 20px.
 *  Eight teeth generated at exact 45-degree spacing (outer radius 9 -- the
 *  stroke icons' optical size, not the box edge -- tooth top +/-13 degrees,
 *  valley radius 6.3) with the hub punched as an evenodd hole --
 *  mirror-symmetric about both axes, which a hand-placed ring-and-tick gear
 *  never quite is. */
export function IconGear(): JsxChild {
  return (
    <Glyph size={HEADER_ICON_SIZE}>
      <path
        fill="currentColor"
        fill-rule="evenodd"
        stroke="none"
        d="M20.77 9.98 A9 9 0 0 1 20.77 14.02 L18.14 13.42 A6.3 6.3 0 0 1 17.34 15.34 L19.63 16.77 A9 9 0 0 1 16.77 19.63 L15.34 17.34 A6.3 6.3 0 0 1 13.42 18.14 L14.02 20.77 A9 9 0 0 1 9.98 20.77 L10.58 18.14 A6.3 6.3 0 0 1 8.66 17.34 L7.23 19.63 A9 9 0 0 1 4.37 16.77 L6.66 15.34 A6.3 6.3 0 0 1 5.86 13.42 L3.23 14.02 A9 9 0 0 1 3.23 9.98 L5.86 10.58 A6.3 6.3 0 0 1 6.66 8.66 L4.37 7.23 A9 9 0 0 1 7.23 4.37 L8.66 6.66 A6.3 6.3 0 0 1 10.58 5.86 L9.98 3.23 A9 9 0 0 1 14.02 3.23 L13.42 5.86 A6.3 6.3 0 0 1 15.34 6.66 L16.77 4.37 A9 9 0 0 1 19.63 7.23 L17.34 8.66 A6.3 6.3 0 0 1 18.14 10.58 Z M14.7 12.0 A2.7 2.7 0 1 0 9.3 12.0 A2.7 2.7 0 1 0 14.7 12.0 Z"
      />
    </Glyph>
  );
}

/* Shield outline, both halves exact mirrors about x=12 (the stock lucide
   shield's tip lands at 11.67, visibly off-center at chip size). */
const SHIELD = "M12 3 4.5 6v6c0 5 3.2 8 7.5 9.5 4.3-1.5 7.5-4.5 7.5-9.5V6Z";

// The fence chip's three shapes: shield-with-check (jail in force), the
// no-symbol (nothing confined), and the plain shield (no verdict about
// confinement can be drawn). Posture -> shape/tint lives with classifyFence
// in app.tsx; tints ride classes in styles.css, shapes stay literal.

export function IconShieldCheck({ className }: { className?: string }): JsxChild {
  return (
    <Glyph size={HEADER_ICON_SIZE} strokeWidth={2} className={className}>
      <path d={SHIELD} />
      <path d="m9 12 2 2 4-4" />
    </Glyph>
  );
}

export function IconShield({ className }: { className?: string }): JsxChild {
  return (
    <Glyph size={HEADER_ICON_SIZE} strokeWidth={2} className={className}>
      <path d={SHIELD} />
    </Glyph>
  );
}

export function IconBan({ className }: { className?: string }): JsxChild {
  return (
    <Glyph size={HEADER_ICON_SIZE} strokeWidth={2} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="m5.64 5.64 12.73 12.73" />
    </Glyph>
  );
}

/** Header workbench disclosure: rectangle outline, the narrow RIGHT column
 *  solid-filled; the fill's left edge is the single divider (5/16 of the box
 *  width from the right). */
export function IconWorkbench(): JsxChild {
  return (
    <Glyph size={HEADER_ICON_SIZE} strokeWidth={2}>
      <rect x="3" y="4" width="18" height="16" rx="1" />
      <rect x="15.4" y="5" width="4.6" height="14" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Reasoning-visibility toggle glyph: a thought bubble carrying the reasoning
 *  TEXT inside it -- two lines (the long, then the short) when reasoning is
 *  shown, the same bubble empty when hidden. The flip is presence-vs-absence
 *  of the content itself in the bubble's empty interior, the same structural
 *  code that beat every mark-addition when the bulb's rays were chosen; the
 *  bulb is gone entirely (owner: "a different icon than the bulb").
 *
 *  The candidates were rasterized at true 20px before choosing (sheets +
 *  device-pixel peeps under tmp/, batch notes in the run dir): a BRAIN -- the
 *  stock Lucide/Tabler brains weld into a scribble at 20px/stroke-2
 *  (rendered as reference) and every simplified left-profile survives only
 *  as a potato blob whose 1-2 creases change ~18 of 400 device pixels
 *  (flip delta ~1590); a thought CLOUD v2 (scalloped outline, NO trailing
 *  dots, nub low-left) -- a dozen redrafts all failed the same way at the
 *  device level: scallop junctions weld into a wall or a stray dot, shallow
 *  bumps read as a starfish, and the 3-lobe cloud reads as a HEART (even
 *  Lucide's own cloud, rasterized here as proof) -- so the comic cloud is
 *  dead at this size, exactly like its trailing dots were; and zzz, the
 *  sparsest glyph in the field (79 ink px vs ~180) with an unreadable 3px
 *  second Z. This bubble survives: both lines rasterize as separate marks
 *  (flip delta 3577 muted / 4570 bright, 42 changed device px, max swing
 *  full ink-to-bg) and the empty interior says "content hidden" at any ink
 *  level. A pure opacity treatment dims more pixels (5842+) but was rejected
 *  anyway: a faded glyph reads as DISABLED rather than toggled, and the
 *  hover accent at the lightest still-legible alpha (~0.6, muted ink holds
 *  >=3.5:1 on both theme headers) drops the purple hover ink to 2.2:1. Ink
 *  is 18x16 device px in both states (the shield beside it is 16x18),
 *  nothing shifts between states.
 *
 *  Color stays currentColor on both states: hiding reasoning is a benign
 *  per-browser VIEW preference, so nothing borrows the fence's error tint
 *  (color-honesty). The thinking-on / thinking-off class is the identity
 *  the tests pin plus the CSS hook; both states keep it. */
export function IconThinking({ off = false }: { off?: boolean }): JsxChild {
  return (
    <Glyph size={HEADER_ICON_SIZE} strokeWidth={2} className={off ? "thinking-off" : "thinking-on"}>
      <path d="M20.75 6v8a2 2 0 0 1-2 2H7.75l-4 3.5V16H4.75a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
      {off ? null : <path d="M7.25 9h9M7.25 12h5.5" />}
    </Glyph>
  );
}

/** Clockwise reload arrow (tree Refresh / viewer Reload / dialog Refresh). */
export function IconReload({ className }: { className?: string }): JsxChild {
  return (
    <Glyph strokeWidth={2} className={className}>
      <path d="M23 4v6h-6M20.49 15a9 9 0 1 1-2.13-9.36L23 10" />
    </Glyph>
  );
}

/** Sidebar search magnifier (header chip + panel bar). */
export function IconSearch({ size = 16, className }: { size?: number; className?: string }): JsxChild {
  return (
    <Glyph size={size} strokeWidth={2} className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="M16.5 16.5 21 21" />
    </Glyph>
  );
}

/** Vertical kebab (row menu); dots are solid fills. */
export function IconKebab(): JsxChild {
  return (
    <Glyph size={12}>
      <circle cx="12" cy="5" r="2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="2" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Client plug (live-card connected-client marker). */
export function IconPlug(): JsxChild {
  return (
    <Glyph size={11} strokeWidth={2}>
      <path d="M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8ZM12 22v-5" />
    </Glyph>
  );
}

/** Fingerprint-badge copy/check pair: both render, CSS swaps which one is
 *  visible on .copied. */
export function IconCopy({ size = 12, className }: { size?: number; className?: string }): JsxChild {
  return (
    <Glyph size={size} strokeWidth={2} className={className}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </Glyph>
  );
}

export function IconCheck({ size = 12, className }: { size?: number; className?: string }): JsxChild {
  return (
    <Glyph size={size} strokeWidth={2.5} className={className}>
      <path d="M4 12l5 5L20 6" />
    </Glyph>
  );
}

/** Chevron; the flip rides a rotation class (see .logs-toggle-glyph-up). */
export function IconChevron({ className }: { className?: string }): JsxChild {
  return (
    <Glyph size={HEADER_ICON_SIZE} strokeWidth={2} className={className}>
      <path d="M6 9l6 6 6-6" />
    </Glyph>
  );
}

/** Row status badge shapes (the sidebar's 5-token glyph set; a token with
 *  no entry renders as text -- the caller's fallback in sessions.tsx). */
const ROW_STATUS_SHAPES: Record<string, JsxChild> = {
  // bolt: working
  working: <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" />,
  // ring: idle
  idle: <circle cx="12" cy="12" r="8" />,
  // hook + dot: awaiting_question
  awaiting_question: (
    <>
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </>
  ),
  // x: interrupted
  interrupted: <path d="M6 6 18 18M18 6 6 18" />,
  // crescent moon: parked
  parked: <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />,
};

/** The badge glyph for one status token, or null when the token has no
 *  glyph (the caller renders its text fallback). The `row-glyph` +
 *  `row-glyph-<status>` classes ride the svg: the identity the tests pin
 *  plus a styling hook; color rides the parent badge's currentColor. */
export function RowStatusGlyph({ status }: { status: string }): JsxChild {
  const shape = Object.hasOwn(ROW_STATUS_SHAPES, status) ? ROW_STATUS_SHAPES[status] : null;
  if (!shape) return null;
  return (
    <Glyph size={11} strokeWidth={2} className={`row-glyph row-glyph-${status}`}>
      {shape}
    </Glyph>
  );
}

/** Subagent chip status shapes on the 24 grid. `parked` wins over status:
 *  the dashed ring is the chip's paused tell. */
const SUBAGENT_SHAPES: Record<string, JsxChild> = {
  completed: <path d="M4 12l5 5L20 6" stroke-width="2.5" />,
  failed: <path d="M6 6 18 18M18 6 6 18" />,
  cancelled: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m5.64 5.64 12.73 12.73" />
    </>
  ),
  // half-filled circle: running, "in flight"
  running: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none" />
    </>
  ),
  queued: <circle cx="12" cy="12" r="8" />,
  // dashed ring: parked/waiting
  parked: <circle cx="12" cy="12" r="8" stroke-dasharray="3.2 3.2" />,
  // broken ring (open arc): interrupted -- the worker's lifetime ended
  // mid-task (restart survivor rows); distinct from cancelled's slashed
  // ring and parked's dashed one: the line itself is SEVERED.
  interrupted: <path d="M12 4a8 8 0 1 1-5.66 2.34" />,
  // dot: the "no shape for this token" fallback
  unknown: <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />,
};

export function SubagentStatusGlyph({ status, parked = false }: { status: string; parked?: boolean }): JsxChild {
  const key = parked ? "parked" : Object.hasOwn(SUBAGENT_SHAPES, status) ? status : "unknown";
  return (
    <Glyph size={12} className={`subagent-glyph subagent-glyph-${key}`}>
      {SUBAGENT_SHAPES[key]}
    </Glyph>
  );
}
