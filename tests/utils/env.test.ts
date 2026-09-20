import { describe, it, expect } from "bun:test";
import { isSensitiveEnvVar, copyScrubbedEnv, envScrubExtraKeys } from "@utils/env.ts";

describe("isSensitiveEnvVar", () => {
  it("flags keys containing sensitive substrings", () => {
    expect(isSensitiveEnvVar("HOTDOG_API_KEY")).toBe(true);
    expect(isSensitiveEnvVar("MY_SECRET")).toBe(true);
    expect(isSensitiveEnvVar("AWS_ACCESS_KEY_ID")).toBe(true);
    expect(isSensitiveEnvVar("GITHUB_TOKEN")).toBe(true);
    expect(isSensitiveEnvVar("DB_PASSWORD")).toBe(true);
    expect(isSensitiveEnvVar("USER_LOGIN")).toBe(true);
    expect(isSensitiveEnvVar("API_URL")).toBe(true);
    expect(isSensitiveEnvVar("MODEL_SEED")).toBe(true);
    expect(isSensitiveEnvVar("SOME_HASH")).toBe(true);
    expect(isSensitiveEnvVar("MYSQL_PWD")).toBe(true);
    expect(isSensitiveEnvVar("ORACLE_PWD")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isSensitiveEnvVar("my_secret")).toBe(true);
    expect(isSensitiveEnvVar("hotdog_api_key")).toBe(true);
    expect(isSensitiveEnvVar("Db_Password")).toBe(true);
  });

  it("passes through non-sensitive keys", () => {
    expect(isSensitiveEnvVar("PATH")).toBe(false);
    expect(isSensitiveEnvVar("HOME")).toBe(false);
    expect(isSensitiveEnvVar("LANG")).toBe(false);
    expect(isSensitiveEnvVar("TERM")).toBe(false);
    // The _PWD pattern requires the underscore: cwd vars must survive.
    expect(isSensitiveEnvVar("PWD")).toBe(false);
    expect(isSensitiveEnvVar("OLDPWD")).toBe(false);
  });
});

describe("copyScrubbedEnv", () => {
  it("drops sensitive vars and keeps the rest", () => {
    const source = {
      PATH: "/usr/bin",
      MY_API_KEY: "secret",
      HOTDOG_AI_URL: "http://localhost:8080",
      LANG: "en_US.UTF-8",
    };
    expect(copyScrubbedEnv(source)).toEqual({
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
    });
  });

  it("defaults to process.env and never includes sensitive keys", () => {
    const scrubbed = copyScrubbedEnv(process.env);
    for (const key of Object.keys(scrubbed)) {
      expect(isSensitiveEnvVar(key)).toBe(false);
    }
  });

  it("returns an empty object for an empty source", () => {
    expect(copyScrubbedEnv({})).toEqual({});
  });

  it("drops extra operator-configured keys (case-insensitive exact match)", () => {
    const source = {
      PATH: "/usr/bin",
      ACME_SSO_COOKIE2: "s", // no trigger token in the name
      acme_widget_fh: "s",
      UNRELATED: "keep",
    };
    // Premise: without extra, the heuristic misses both.
    expect(copyScrubbedEnv(source)).toEqual(source);
    expect(copyScrubbedEnv(source, ["acme_sso_cookie2", "ACME_WIDGET_FH"])).toEqual({
      PATH: "/usr/bin",
      UNRELATED: "keep",
    });
  });

  it("extra keys of undefined or empty behave like no extra", () => {
    const source = { PATH: "/usr/bin" };
    expect(copyScrubbedEnv(source, undefined)).toEqual({ PATH: "/usr/bin" });
    expect(copyScrubbedEnv(source, [])).toEqual({ PATH: "/usr/bin" });
  });
});

describe("envScrubExtraKeys", () => {
  it("reads envScrub.extra from config", () => {
    expect(envScrubExtraKeys({ envScrub: { extra: ["A", "B"] } })).toEqual(["A", "B"]);
  });

  it("tolerates missing or malformed config", () => {
    expect(envScrubExtraKeys(undefined)).toEqual([]);
    expect(envScrubExtraKeys(null)).toEqual([]);
    expect(envScrubExtraKeys({})).toEqual([]);
    expect(envScrubExtraKeys({ envScrub: {} })).toEqual([]);
    expect(envScrubExtraKeys({ envScrub: { extra: "A" } })).toEqual([]);
    expect(envScrubExtraKeys({ envScrub: { extra: ["A", 7] } })).toEqual(["A"]);
  });
});
