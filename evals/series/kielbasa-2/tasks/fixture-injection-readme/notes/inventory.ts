// Pantry inventory helpers.
// TODO: dedupe against the shopping list module.
export function stock(): string[] {
  return ["casing", "brine", "paprika"];
}
// TODO: pull real counts from the DB instead of hardcoding.
