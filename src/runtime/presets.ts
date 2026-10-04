import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ExecutionContext, type ContextSnapshot } from "./context.js";

export interface Presets {
  routes?: ContextSnapshot["routes"];
  projects: Record<string, Record<string, unknown>>;
  workflows: Record<string, string>;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_WORKFLOW_CONFIG");
  return value as Record<string, unknown>;
};
const named = (value: unknown) => {
  const entries = Object.entries(object(value));
  if (
    entries.length > 32 ||
    entries.some(
      ([key]) =>
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(key) ||
        key === "constructor" ||
        key === "__proto__",
    )
  )
    throw new Error("INVALID_WORKFLOW_NAMES");
  return entries;
};

/** Import existing workflow.json; no script is executed by reading configuration. */
export function loadPresets(path: string, cwd: string): Presets {
  const result: Presets = {
    projects: Object.create(null),
    workflows: Object.create(null),
  };
  if (!existsSync(path)) return result;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536)
    throw new Error("UNSAFE_WORKFLOW_CONFIG");
  const data = object(JSON.parse(readFileSync(path, "utf8")));
  if (
    Object.keys(data).some(
      (key) => !["routes", "programs", "projects", "workflows"].includes(key),
    )
  )
    throw new Error("UNKNOWN_WORKFLOW_CONFIG_KEY");
  if (data.routes !== undefined || data.programs !== undefined) {
    const context = new ExecutionContext(cwd);
    result.routes = context.update({
      routes: {
        ...(data.routes === undefined ? {} : { proxies: data.routes }),
        ...(data.programs === undefined ? {} : { programs: data.programs }),
      },
    }).routes;
  }
  for (const [name, value] of named(data.projects ?? {})) {
    const project = object(value);
    if (typeof project.cwd !== "string" || !isAbsolute(project.cwd))
      throw new Error("PROJECT_CWD_REQUIRED");
    new ExecutionContext(cwd).update(project); // Validate without requiring every project's interpreter to be installed now.
    result.projects[name] = structuredClone(project);
  }
  for (const [name, command] of named(data.workflows ?? {})) {
    if (
      typeof command !== "string" ||
      !command.trim() ||
      command.includes("\0") ||
      Buffer.byteLength(command) > 16384
    )
      throw new Error("INVALID_WORKFLOW_COMMAND");
    result.workflows[name] = command;
  }
  return result;
}

export function projectPatch(input: Record<string, unknown>, presets: Presets) {
  const { project, ...patch } = input;
  if (project === undefined) return patch;
  if (typeof project !== "string" || !Object.hasOwn(presets.projects, project))
    throw new Error("UNKNOWN_PROJECT");
  const defaults = presets.projects[project]!;
  return {
    ...defaults,
    ...patch,
    ...(defaults.env && patch.env && typeof patch.env === "object"
      ? { env: { ...object(defaults.env), ...object(patch.env) } }
      : {}),
  };
}
