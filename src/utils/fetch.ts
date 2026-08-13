import pkg from "@package.json" with { type: "json" };

const USER_AGENT = `hotdog/v${pkg.version} NOT Mozilla/5.0 (probably running linux; probably x64) AND NOT AppleWebKit/666.42 (NOT KHTML, unlike Gecko) NOR Chrome/127.0.0.1 ALSO NOT Safari/420.69`;

export const VALID_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"];
export const METHODS_WITH_BODY = ["POST", "PUT", "PATCH"];

export async function hotdogFetch(url: string, args?: RequestInit) {
  if (!VALID_METHODS.includes(args?.method ?? "GET")) {
    throw new Error(
      `Invalid HTTP method: '${args?.method}'. Supported: ${VALID_METHODS.join(", ")}`,
    );
  }
  const headers = args?.headers ?? {};
  return await fetch(url, {
    ...args,
    body:
      (METHODS_WITH_BODY.includes(args?.method ?? "") && args?.body) || undefined,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      ...headers,
    },
  });
}
