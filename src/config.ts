import { isAbsolute } from "node:path";
import { defaults as scratchDefaults, type Limits } from "./scratch.js";
export interface Config {
  enabled: boolean;
  hideRawCodemode: boolean;
  debug: boolean;
  scratchDirectory?: string;
  scratch: Limits;
  cacheBytes: number;
  durableBytes: number;
  preferredFormat: "replace" | "range" | "apply_patch";
}
export function config(raw = process.env.PI_CODEBUFFER): Config {
  const defaults: Config = {
    enabled: true,
    hideRawCodemode: true,
    debug: false,
    scratch: { ...scratchDefaults },
    cacheBytes: 32 * 1024 * 1024,
    durableBytes: 64 * 1024 * 1024,
    preferredFormat: "replace",
  };
  if (raw === undefined) return defaults;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("PI_CODEBUFFER must be a JSON object");
  for (const [key, v] of Object.entries(value)) {
    if (
      ["enabled", "hideRawCodemode", "debug"].includes(key) &&
      typeof v === "boolean"
    )
      continue;
    if (key === "scratchDirectory" && typeof v === "string" && isAbsolute(v))
      continue;
    if (
      key === "preferredFormat" &&
      ["replace", "range", "apply_patch"].includes(v as string)
    )
      continue;
    if (
      ["cacheBytes", "durableBytes"].includes(key) &&
      Number.isSafeInteger(v) &&
      Number(v) >= 4096 &&
      Number(v) <= 256 * 1024 * 1024
    )
      continue;
    if (key === "scratch" && v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k, n] of Object.entries(v)) {
        if (
          !Object.hasOwn(scratchDefaults, k) ||
          !Number.isSafeInteger(n) ||
          Number(n) < 1 ||
          Number(n) >
            (k === "scratchBytes"
              ? 256 * 1024 * 1024
              : k === "ttlMs"
                ? 7 * 86400000
                : k === "revisions"
                  ? 8
                  : 64)
        )
          throw new Error("PI_CODEBUFFER invalid scratch limit " + k);
      }
      continue;
    }
    throw new Error("PI_CODEBUFFER: unknown key or invalid value: " + key);
  }
  const result = { ...defaults, ...value } as Config;
  result.scratch = { ...scratchDefaults, ...result.scratch };
  return result;
}
