// Core tools defaults — shared configuration values for core tools.
// Config defaults are defined in extension.json configSchema.
// These exports are for backward compatibility and test use only.

export const DEFAULT_MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB — not configurable via configSchema

// Re-export default values that match extension.json configSchema defaults
// for backward compatibility and test use
export const DEFAULT_MAX_TOOL_OUTPUT_LINES = 600;
export const DEFAULT_READ_TOOL_LIMIT = 500;
export const DEFAULT_FIND_MAX_RESULTS = 200;
export const DEFAULT_GREP_MAX_RESULTS = 100;
export const DEFAULT_MAX_EDIT_INPUT_SIZE = 16000;
