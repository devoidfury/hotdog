// Pure per-model token pricing for the opt-in `modelPricing` config key.
//
// Local numbers only: nothing here reads config, hits the network, or writes to
// the session log. Callers hand in the tracker's numbers and get arithmetic back.

/** Per-million-token USD rates for one model. */
export interface ModelPrice {
  /** Rate for prompt tokens that were NOT cache hits. */
  input: number;
  /**
   * Rate for cache-hit prompt tokens. Omitted means 0, matching TokenTracker's
   * "cached tokens are free" house model (sessionPromptTokens is net of cached).
   */
  cachedInput?: number;
  /** Rate for completion tokens. */
  output: number;
}

/** The subset of TokenTracker's shape this helper needs; both the session totals and the last-call numbers satisfy it. */
export interface CostableUsage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

export interface CostBreakdown {
  input: number;
  cached: number;
  output: number;
  total: number;
}

const PER_MILLION = 1_000_000;

/** Whether `modelPricing` is present at all. Absent (undefined/null/non-object) keeps every cost line off, exactly as before the feature existed. */
export function isPricingConfigured(pricing: unknown): pricing is Record<string, unknown> {
  return typeof pricing === "object" && pricing !== null && !Array.isArray(pricing);
}

function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Price entry for a session model, keyed by the model string exactly as configured.
 * Malformed entries (missing/non-numeric/negative rates) read as unmapped, so a
 * typo'd table surfaces as "no price entry" in the display instead of a bogus number.
 */
export function findModelPrice(
  pricing: unknown,
  model: string | undefined | null,
): ModelPrice | undefined {
  if (!isPricingConfigured(pricing) || !model || !Object.hasOwn(pricing, model)) return undefined;

  const entry = pricing[model];
  if (typeof entry !== "object" || entry === null) return undefined;

  const { input, cachedInput, output } = entry as Record<string, unknown>;
  if (!isRate(input) || !isRate(output)) return undefined;
  if (cachedInput !== undefined && !isRate(cachedInput)) return undefined;

  return entry as ModelPrice;
}

/**
 * Cost of one usage sample at `price`. `promptTokens` must already be NET of
 * cached (TokenTracker stores both its session and last-call prompt numbers that
 * way); `cachedTokens` is the separate bucket, so nothing here double counts.
 */
export function computeTokenCost(usage: CostableUsage, price: ModelPrice): CostBreakdown {
  const input = (usage.promptTokens / PER_MILLION) * price.input;
  const cached = (usage.cachedTokens / PER_MILLION) * (price.cachedInput ?? 0);
  const output = (usage.completionTokens / PER_MILLION) * price.output;
  return { input, cached, output, total: input + cached + output };
}
