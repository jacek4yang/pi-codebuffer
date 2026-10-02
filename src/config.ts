export interface Config {
  enabled: boolean;
  hideRawCodemode: boolean;
  debug: boolean;
}
export function config(raw = process.env.PI_CODEBUFFER): Config {
  const defaults: Config = {
    enabled: true,
    hideRawCodemode: true,
    debug: false,
  };
  if (raw === undefined) return defaults;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("PI_CODEBUFFER must be a JSON object");
  for (const [key, v] of Object.entries(value)) {
    if (
      !(key in defaults) ||
      !Object.hasOwn(defaults, key) ||
      typeof v !== "boolean"
    )
      throw new Error(
        "PI_CODEBUFFER: unknown key or non-boolean value: " + key,
      );
  }
  return { ...defaults, ...value };
}
