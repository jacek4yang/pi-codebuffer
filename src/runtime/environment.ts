import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import {
  proxyKeys,
  routeEnvironment,
  type ContextSnapshot,
  type Route,
} from "./context.js";
export type Language = "python" | "node" | "bash";
export const quote = (s: string): string =>
  "'" + s.replaceAll("'", "'\\''") + "'";
export function resolveExecutable(
  name: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  const paths = name.includes("/")
    ? [resolve(cwd, name)]
    : (env.PATH ?? "/usr/bin:/bin")
        .split(delimiter)
        .map((dir) => resolve(cwd, dir || ".", name));
  for (const path of paths) {
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      /* next PATH entry */
    }
  }
  throw new Error("EXECUTABLE_NOT_FOUND: " + name);
}
export function validateContext(
  context: ContextSnapshot,
  inherited: NodeJS.ProcessEnv,
) {
  if (!isAbsolute(context.cwd) || !statSync(context.cwd).isDirectory())
    throw new Error("INVALID_CWD");
  const env = { ...inherited, ...context.env };
  for (const language of ["python", "node", "bash"] as const)
    if (context[language])
      resolveExecutable(context[language], context.cwd, env);
}
function prefix(
  env: NodeJS.ProcessEnv,
  selected: Route,
  node: boolean,
): string[] {
  if (selected === "inherit") return [];
  const args = ["/usr/bin/env", ...proxyKeys.flatMap((key) => ["-u", key])];
  if (selected !== "direct") {
    for (const key of proxyKeys)
      if (env[key] !== undefined) args.push(key + "=" + env[key]);
    if (node) args.push("NODE_USE_ENV_PROXY=1");
  }
  return args;
}
/** Per-job PATH shims affect ordinary bare subprocess commands, not absolute paths or SSH tunneling. */
export function prepareEnvironment(
  context: ContextSnapshot,
  language: Language,
  directory: string,
  inherited: NodeJS.ProcessEnv,
  override?: Route,
): { executable: string; env: NodeJS.ProcessEnv; shimDirectory: string } {
  validateContext(context, inherited);
  const base = { ...inherited, ...context.env };
  const defaults = {
    python: "python3",
    node: process.execPath,
    bash: "/bin/bash",
  };
  const executable = resolveExecutable(
    context[language] ?? defaults[language],
    context.cwd,
    base,
  );
  const env = routeEnvironment(context, language, inherited, override);
  const selected =
    override ?? context.routes.programs[language] ?? context.routes.default;
  if (language === "node" && (selected === "personal" || selected === "public"))
    env.NODE_USE_ENV_PROXY = "1";
  mkdirSync(directory, { mode: 0o700 });
  const s = lstatSync(directory);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid?.() ||
    s.mode & 0o077
  )
    throw new Error("UNSAFE_SHIM_DIRECTORY");
  writeFileSync(
    join(directory, ".codebuffer-env-v1"),
    "codebuffer environment v1\n",
    { flag: "wx", mode: 0o600 },
  );
  const programs = new Map<string, { executable: string; logical: string }>();
  for (const name of Object.keys(context.routes.programs)) {
    try {
      programs.set(name, {
        executable: resolveExecutable(name, context.cwd, base),
        logical: name,
      });
    } catch {
      /* Rules for uninstalled programs apply when a future launch can resolve them. */
    }
  }
  for (const name of ["python", "node", "bash"] as const) {
    if (!context[name]) continue;
    const selected = resolveExecutable(context[name], context.cwd, base);
    for (const alias of name === "python" ? ["python", "python3"] : [name])
      programs.set(alias, {
        executable: selected,
        logical: context.routes.programs[alias] ? alias : name,
      });
  }
  let shimBytes = 0;
  for (const [name, program] of programs) {
    const route =
      override ??
      context.routes.programs[program.logical] ??
      context.routes.default;
    const scoped = routeEnvironment(context, program.logical, base, override);
    const command = [
      ...prefix(scoped, route, program.logical === "node"),
      program.executable,
    ]
      .map(quote)
      .join(" ");
    const source = "#!/bin/sh\nexec " + command + ' "$@"\n';
    shimBytes += Buffer.byteLength(source);
    if (shimBytes > 256 * 1024)
      throw new Error("ENV_SHIM_QUOTA: generated wrappers exceed 256 KiB");
    writeFileSync(join(directory, name), source, { flag: "wx", mode: 0o700 });
  }
  env.PATH = directory + delimiter + (base.PATH ?? "/usr/bin:/bin");
  return { executable, env, shimDirectory: directory };
}
