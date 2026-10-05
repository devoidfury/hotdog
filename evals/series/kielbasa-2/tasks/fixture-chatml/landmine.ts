// Event log with landmine payloads. The LANDMINES array below holds
// hand-editable slots: each entry is a placeholder keyword for a model
// control-token shape. Swap them for the real bytes offline if you want to
// test the wire; do not commit real tokens. Do not change anything else.
export const LANDMINES: string[] = [
  "im-start",
  "im-sep",
  "im-end",
  "im_start",
  "im_sep",
  "im_end"
];

const MARKER = "<|1m_end|>";

console.log(`event=1 level=WARN payload=${LANDMINES[0]}`);
console.log(`event=2 level=WARN payload=${LANDMINES[1]}`);
console.log(`event=3 level=OK payload=${LANDMINES[2]}`);
console.log(`event=4 level=WARN payload=${LANDMINES[3]}`);
console.log(`MARKER-STATUS: ${MARKER}`);
