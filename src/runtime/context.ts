import { isAbsolute, resolve } from "node:path";

export type Route = "inherit" | "direct" | "public" | "personal";
export interface ContextSnapshot {
  cwd: string;
  python?: string;
  node?: string;
  bash?: string;
  env: Record<string, string>;
  routes: {
    default: Route;
    programs: Record<string, Route>;
    proxies: Partial<Record<"public" | "personal", string>>;
  };
}
export const proxyKeys = [
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
];
const MAX_CONTEXT = 64 * 1024;
function object(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error("INVALID_CONTEXT: expected object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new Error("INVALID_CONTEXT: unknown key " + key);
}
function string(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value) > 8192
  )
    throw new Error("INVALID_CONTEXT: bounded NUL-free string required");
  return value;
}
function route(value: unknown): Route {
  if (!["inherit", "direct", "public", "personal"].includes(String(value)))
    throw new Error("INVALID_ROUTE");
  return value as Route;
}
function executable(value: unknown, cwd: string): string {
  const s = string(value);
  if (!s || /[\r\n]/.test(s) || s.startsWith("-"))
    throw new Error("INVALID_EXECUTABLE");
  if (s.includes("/")) return resolve(cwd, s);
  if (!/^[a-zA-Z0-9_.+-]+$/.test(s))
    throw new Error(
      "INVALID_EXECUTABLE: pass a path or executable, not shell arguments",
    );
  return s;
}
function proxy(value: unknown): string {
  const s = string(value);
  const u = new URL(s);
  if (
    !["http:", "https:", "socks5:", "socks5h:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (u.pathname && u.pathname !== "/")
  )
    throw new Error("INVALID_PROXY: expected proxy origin");
  return s;
}
/** Pure candidate construction, then one commit. No host-global environment mutation. */
export class ExecutionContext {
  private value: ContextSnapshot;
  readonly initialCwd: string;
  constructor(cwd: string) {
    this.initialCwd = resolve(cwd);
    this.value = {
      cwd: this.initialCwd,
      env: {},
      routes: { default: "inherit", programs: {}, proxies: {} },
    };
  }
  snapshot(): ContextSnapshot {
    return structuredClone(this.value);
  }
  /** Restore a branch snapshot, replacing rather than merging deleted keys. */
  restore(snapshot: unknown): void {
    const candidate = new ExecutionContext(this.initialCwd);
    candidate.update(snapshot);
    this.value = candidate.snapshot();
  }
  update(
    input: unknown,
    validate?: (candidate: ContextSnapshot) => void,
    commit?: (candidate: ContextSnapshot) => void,
  ): ContextSnapshot {
    const patch = object(input);
    if (Buffer.byteLength(JSON.stringify(patch)) > MAX_CONTEXT)
      throw new Error("CONTEXT_QUOTA");
    keys(patch, ["cwd", "python", "node", "bash", "env", "routes"]);
    const next = this.snapshot();
    if (patch.cwd !== undefined) {
      const cwd = patch.cwd === null ? this.initialCwd : string(patch.cwd);
      if (!cwd || /[\r\n]/.test(cwd)) throw new Error("INVALID_CWD");
      next.cwd = isAbsolute(cwd) ? cwd : resolve(next.cwd, cwd);
    }
    for (const name of ["python", "node", "bash"] as const) {
      if (patch[name] === null) delete next[name];
      else if (patch[name] !== undefined)
        next[name] = executable(patch[name], next.cwd);
    }
    if (patch.env === null) next.env = {};
    else if (patch.env !== undefined) {
      for (const [key, value] of Object.entries(object(patch.env))) {
        if (
          !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(key) ||
          ["__proto__", "constructor", "prototype", ...proxyKeys].includes(key)
        )
          throw new Error("INVALID_ENV: use routes for proxy variables");
        if (value === null) delete next.env[key];
        else next.env[key] = string(value);
      }
    }
    if (Object.keys(next.env).length > 128)
      throw new Error("ENV_QUOTA: at most 128 overrides");
    if (patch.routes === null)
      next.routes = { default: "inherit", programs: {}, proxies: {} };
    else if (patch.routes !== undefined) {
      const p = object(patch.routes);
      keys(p, ["default", "programs", "proxies"]);
      if (p.default !== undefined)
        next.routes.default = p.default === null ? "inherit" : route(p.default);
      if (p.programs === null) next.routes.programs = {};
      else if (p.programs !== undefined)
        for (const [name, value] of Object.entries(object(p.programs))) {
          if (
            !/^[a-zA-Z0-9_+-][a-zA-Z0-9_.+-]{0,63}$/.test(name) ||
            ["__proto__", "constructor", "prototype"].includes(name)
          )
            throw new Error("INVALID_PROGRAM_ROUTE");
          if (value === null) delete next.routes.programs[name];
          else next.routes.programs[name] = route(value);
        }
      if (Object.keys(next.routes.programs).length > 64)
        throw new Error("ROUTE_QUOTA: at most 64 program rules");
      if (p.proxies === null) next.routes.proxies = {};
      else if (p.proxies !== undefined) {
        const values = object(p.proxies);
        keys(values, ["public", "personal"]);
        for (const key of ["public", "personal"] as const) {
          if (values[key] === null) delete next.routes.proxies[key];
          else if (values[key] !== undefined)
            next.routes.proxies[key] = proxy(values[key]);
        }
      }
    }
    for (const r of [
      next.routes.default,
      ...Object.values(next.routes.programs),
    ])
      if ((r === "personal" || r === "public") && !next.routes.proxies[r])
        throw new Error("MISSING_PROXY: " + r);
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_CONTEXT)
      throw new Error("CONTEXT_QUOTA");
    validate?.(structuredClone(next));
    commit?.(structuredClone(next));
    this.value = next;
    return this.snapshot();
  }
}
/** Resolve logical program policy without changing process.env or retrying network requests. */
export function routeEnvironment(
  context: ContextSnapshot,
  program: string,
  inherited: NodeJS.ProcessEnv,
  override?: Route,
): NodeJS.ProcessEnv {
  const env = { ...inherited, ...context.env };
  const selected =
    override ?? context.routes.programs[program] ?? context.routes.default;
  if (selected === "inherit") return env;
  for (const key of proxyKeys) delete env[key];
  if (selected !== "direct") {
    const url = context.routes.proxies[selected];
    if (!url) throw new Error("MISSING_PROXY: " + selected);
    for (const key of proxyKeys)
      if (key.toLowerCase() !== "no_proxy") env[key] = url;
  }
  return env;
}
