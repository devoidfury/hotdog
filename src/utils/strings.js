const CAMEL_CASE_REGEX = /[_-]([a-z])/g;
const FLAG_PREFIX_REGEX = /^-+/;

const _camel_transform = (_, c) => c.toUpperCase();
export function camelCase(str) {
  return str.replace(CAMEL_CASE_REGEX, _camel_transform);
}

export function parseCliFlagKey(str) {
  return camelCase(str.replace(FLAG_PREFIX_REGEX, ""));
}
