const CAMEL_CASE_REGEX = /[_-]([a-z])/g;
const FLAG_PREFIX_REGEX = /^-+/;

const _camelTransform = (_, c) => c.toUpperCase();
export function camelCase(str) {
  return str.replace(CAMEL_CASE_REGEX, _camelTransform);
}

export function parseCliFlagKey(str) {
  return camelCase(str.replace(FLAG_PREFIX_REGEX, ""));
}
