import { createHash } from "node:crypto";
export const MAX_SOURCE = 262144;
export const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
export const hash = (s: string): string =>
  createHash("sha256").update(s).digest("hex");
