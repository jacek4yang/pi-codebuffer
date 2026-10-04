import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema, type Static } from "typebox";
import { Check } from "typebox/value";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import type { Fused } from "../fused.js";
import { ExecutionContext } from "./context.js";
import { validateContext, type Language } from "./environment.js";
import { Host, type HostInput, type HostPlan, type Scope } from "./host.js";
import type { JobView } from "./jobs.js";
import { registerFiles } from "./files.js";
import { runtimeStorage } from "./storage.js";
import { loadPresets, projectPatch } from "./presets.js";
import { executionRenderers } from "./render.js";
const CONTEXT = "codebuffer.context.v1";
const result = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: undefined,
  isError,
});
const route = Type.Union(
  ["inherit", "direct", "public", "personal"].map((v) => Type.Literal(v)),
);
const contextSchema = Type.Union([
  Type.Literal("show"),
  Type.Null(),
  Type.Object(
    {
      project: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      python: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      node: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      bash: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      env: Type.Optional(
        Type.Union([
          Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()])),
          Type.Null(),
        ]),
      ),
      routes: Type.Optional(
        Type.Union([
          Type.Object(
            {
              default: Type.Optional(Type.Union([route, Type.Null()])),
              programs: Type.Optional(
                Type.Union([
                  Type.Record(Type.String(), Type.Union([route, Type.Null()])),
                  Type.Null(),
                ]),
              ),
              proxies: Type.Optional(
                Type.Union([
                  Type.Object(
                    {
                      public: Type.Optional(
                        Type.Union([Type.String(), Type.Null()]),
                      ),
                      personal: Type.Optional(
                        Type.Union([Type.String(), Type.Null()]),
                      ),
                    },
                    { additionalProperties: false },
                  ),
                  Type.Null(),
                ]),
              ),
            },
            { additionalProperties: false },
          ),
          Type.Null(),
        ]),
      ),
    },
    { additionalProperties: false },
  ),
]);
const jobSchema = Type.Union([
  Type.Literal("list"),
  Type.Object(
    {
      id: Type.String(),
      action: Type.Union([Type.Literal("inspect"), Type.Literal("cancel")]),
    },
    { additionalProperties: false },
  ),
]);
function languageSchema(language: Language) {
  return Type.Object(
    {
      [language === "bash" ? "command" : "code"]: Type.Optional(Type.String()),
      ref: Type.Optional(Type.String()),
      base: Type.Optional(Type.String()),
      run: Type.Optional(Type.Boolean()),
      rerun: Type.Optional(Type.Literal("from-start")),
      wait: Type.Optional(Type.Number({ minimum: 0, maximum: 60 })),
      limit: Type.Optional(
        Type.Number({ exclusiveMinimum: 0, maximum: 86400 }),
      ),
      route: Type.Optional(route),
    },
    { additionalProperties: false },
  );
}
interface Runtime {
  host: Host;
  ctx: ExtensionContext;
  session: string;
  busy: boolean;
  paused: boolean;
  compacting: boolean;
  detached: Map<string, { user: string | null; anchor: string | null }>;
  notices: Map<string, JobView>;
  flush?: ReturnType<typeof setTimeout>;
}
const scope = (ctx: ExtensionContext): Scope => ({
  session: ctx.sessionManager.getSessionId(),
  anchor: ctx.sessionManager.getLeafId(),
  ancestry: new Set(ctx.sessionManager.getBranch().map((e) => e.id)),
});
const userHead = (ctx: ExtensionContext) =>
  ctx.sessionManager
    .getBranch()
    .findLast((e) => e.type === "message" && e.message.role === "user")?.id ??
  null;
/** Public tool hooks authorize the final resolved bash command before the host process starts. */
export function registerRuntime<T extends TSchema>(
  pi: ExtensionAPI,
  legacy: ToolDefinition<T>,
  fused: Fused,
) {
  const runtimes = new Map<string, Runtime>();
  const plans = new Map<
    string,
    { parent: string; runtime: Runtime; plan: HostPlan }
  >();
  const approved = new Map<string, { runtime: Runtime; plan: HostPlan }>();
  let activeSession: string | undefined;
  let shuttingDown = false;
  const schedule = (runtime: Runtime) => {
    if (shuttingDown || runtime.flush || !runtime.notices.size) return;
    runtime.flush = setTimeout(() => {
      runtime.flush = undefined;
      if (
        shuttingDown ||
        !runtime.notices.size ||
        runtime.session !== activeSession ||
        runtime.busy ||
        runtime.compacting ||
        runtime.paused
      )
        return;
      // A queued notification may outlive SDK disposal/reload. Never resume a stale context.
      try {
        if (!runtime.ctx.isIdle()) return;
      } catch {
        return;
      }
      const notices = [...runtime.notices.values()];
      runtime.notices.clear();
      const current = userHead(runtime.ctx);
      const ancestry = scope(runtime.ctx).ancestry;
      const resume = notices.some((j) => {
        const owner = runtime.detached.get(j.id);
        return (
          owner?.user === current &&
          owner.anchor !== null &&
          ancestry.has(owner.anchor)
        );
      });
      for (const j of notices) runtime.detached.delete(j.id);
      pi.sendMessage(
        {
          customType: "codebuffer.jobs.v1",
          content: JSON.stringify({
            completedJobs: notices.map((j) => ({
              id: j.id,
              state: j.state,
              exitCode: j.exitCode,
              log: j.log,
              output: j.output.slice(-2000),
            })),
          }),
          display: true,
        },
        { triggerTurn: resume },
      );
    }, 0);
    runtime.flush.unref();
  };
  function get(ctx: ExtensionContext): Runtime {
    const session = ctx.sessionManager.getSessionId();
    const prior = runtimes.get(session);
    if (prior) {
      prior.ctx = ctx;
      return prior;
    }
    if (runtimes.size >= 8) throw new Error("RUNTIME_SESSION_LIMIT");
    const root = join(dirname(fused.store.root), "runtime");
    const name = createHash("sha256").update(session).digest("hex");
    const context = new ExecutionContext(ctx.cwd);
    const presets = loadPresets(join(getAgentDir(), "workflow.json"), ctx.cwd);
    const saved = ctx.sessionManager
      .getBranch()
      .findLast(
        (entry) => entry.type === "custom" && entry.customType === CONTEXT,
      );
    if (saved?.type === "custom") context.update(saved.data);
    else if (presets.routes) context.update({ routes: presets.routes });
    const runtime = {
      ctx,
      session,
      busy: !ctx.isIdle(),
      paused: false,
      compacting: false,
      detached: new Map(),
      notices: new Map(),
    } as Runtime;
    runtime.host = runtimeStorage(
      root,
      name,
      (path) =>
        new Host(
          fused.store,
          context,
          path,
          (job) => {
            if (shuttingDown || !runtime.detached.has(job.id)) return;
            runtime.notices.set(job.id, job);
            runtime.ctx.ui.notify(
              `Background ${job.id.slice(0, 8)}: ${job.state}`,
              job.state === "completed" ? "info" : "warning",
            );
            schedule(runtime);
          },
          { active: 4, records: 16, logBytes: 262144, outputBytes: 8192 },
        ),
    );
    runtimes.set(session, runtime);
    return runtime;
  }
  pi.on("tool_call", (event) => {
    if (
      ["code", "python", "node", "bash", "edit", "write"].includes(
        event.toolName,
      ) &&
      pi.getAllTools().some((tool) => tool.name === "workflow")
    )
      return {
        block: true,
        reason:
          "UNIFIED_TOOL_CONFLICT: remove standalone pi-workflow from this loadout (keep workflow.json), then reload; or disable unified mode.",
      };
    if (event.toolName !== "bash") return;
    const command = event.input.command;
    if (typeof command !== "string") return;
    const planned = plans.get(command);
    if (planned) {
      if (event.parentToolCallId !== planned.parent)
        return { block: true, reason: "HOST_PLAN_OWNER_MISMATCH" };
      approved.set(event.toolCallId, planned);
    } else if (
      [...plans.values()].some((p) => p.parent === event.parentToolCallId)
    )
      return {
        block: true,
        reason:
          "HOST_PLAN_CHANGED: final command requires a fresh authorization",
      };
  });
  const raw = legacy.parameters as unknown as {
    properties: Record<string, TSchema>;
  };
  registerFiles(pi, fused.store, (ctx) => get(ctx).host.context.snapshot().cwd);

  const codeParameters = Type.Object(
    {
      ...raw.properties,
      context: Type.Optional(contextSchema),
      job: Type.Optional(jobSchema),
      workflow: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  );
  pi.registerTool({
    name: "code",
    label: "Code",
    ...executionRenderers("code"),
    exposure: "model-only",
    executionMode: "sequential",
    description:
      "QuickJS orchestration with retained ref/base and Edit IR. Context patches select cwd/interpreters/env/per-program routes or a workflow.json project; omitted stays, null clears. Use workflow:'list' or a configured name. Context/workflow/job controls run alone; jobs list/inspect/cancel and notify on completion.",
    parameters: codeParameters,
    prepareLoadout(loadout) {
      const prepared = legacy.prepareLoadout?.(loadout);
      return {
        ...prepared,
        descriptions: {
          ...prepared?.descriptions,
          code:
            (prepared?.descriptions?.codebuffer ?? legacy.description) +
            " Context patches select cwd/interpreters/env/per-program routes or workflow.json project; omitted stays, null clears. workflow:'list' or configured name. context/workflow/job controls run alone; jobs list/inspect/cancel and notify on completion.",
        },
      };
    },
    async execute(id, args, signal, update, ctx) {
      try {
        if ("context" in args || "job" in args || "workflow" in args) {
          if (Object.keys(args).length !== 1)
            throw new Error("INPUT_CONFLICT: controls cannot execute source");
          const runtime = get(ctx);
          if ("workflow" in args) {
            const presets = loadPresets(
              join(getAgentDir(), "workflow.json"),
              ctx.cwd,
            );
            if (args.workflow === "list")
              return result({
                workflows: Object.keys(presets.workflows),
                projects: Object.keys(presets.projects),
              });
            if (
              typeof args.workflow !== "string" ||
              !Object.hasOwn(presets.workflows, args.workflow)
            )
              throw new Error("UNKNOWN_WORKFLOW");
            const outcome = await ctx.executeTool(
              "bash",
              { command: presets.workflows[args.workflow] },
              { signal },
            );
            return { ...outcome.result, isError: outcome.isError };
          }
          if ("context" in args) {
            if (args.context === "show")
              return result(runtime.host.context.snapshot());
            const patch = args.context
              ? projectPatch(
                  args.context,
                  loadPresets(join(getAgentDir(), "workflow.json"), ctx.cwd),
                )
              : {
                  cwd: null,
                  python: null,
                  node: null,
                  bash: null,
                  env: null,
                  routes: null,
                };
            const snapshot = runtime.host.context.update(
              patch,
              (value) => validateContext(value, process.env),
              (value) => {
                if (
                  JSON.stringify(value) ===
                  JSON.stringify(runtime.host.context.snapshot())
                )
                  return;
                const prior = ctx.sessionManager
                  .getEntries()
                  .filter(
                    (e) => e.type === "custom" && e.customType === CONTEXT,
                  )
                  .reduce(
                    (n, e) => n + Buffer.byteLength(JSON.stringify(e)),
                    0,
                  );
                if (
                  prior + Buffer.byteLength(JSON.stringify(value)) >
                  8 * 1024 * 1024
                )
                  throw new Error("CONTEXT_HISTORY_LIMIT");
                pi.appendEntry(CONTEXT, value);
              },
            );
            return result({
              context: "updated",
              cwd: snapshot.cwd,
              changed: Object.keys(patch),
            });
          }
          if (args.job === "list")
            return result({
              jobs: runtime.host.jobs
                .list()
                .map(({ id, state, exitCode, started }) => ({
                  id,
                  state,
                  exitCode,
                  started,
                })),
            });
          const job = args.job as Static<typeof jobSchema>;
          if (!job || typeof job === "string") throw new Error("INVALID_JOB");
          if (job.action === "cancel") runtime.host.jobs.cancel(job.id);
          return result(runtime.host.jobs.get(job.id));
        }
        if (!Check(legacy.parameters, args)) throw new Error("INVALID_CODE");
        return await legacy.execute(id, args, signal, update, ctx);
      } catch (error) {
        return result(
          { error: error instanceof Error ? error.message : String(error) },
          true,
        );
      }
    },
  });
  for (const language of ["python", "node", "bash"] as const) {
    pi.registerTool({
      name: language,
      label: language,
      ...executionRenderers(language),
      executionMode: "sequential",
      description: `${language} in the session environment. Source retained for guarded edits/reuse; run:false builds a draft. wait seconds detaches without killing; limit seconds terminates the process group. Completed jobs notify; do not poll.`,
      parameters: languageSchema(language),
      async execute(id, args, signal, _update, ctx) {
        let plan: HostPlan | undefined;
        let runtime: Runtime | undefined;
        try {
          const granted = approved.get(id);
          if (granted) {
            approved.delete(id);
            if (args.command !== granted.plan.command)
              throw new Error("HOST_PLAN_CHANGED");
            const receipt = await granted.runtime.host.execute(
              granted.plan,
              signal,
            );
            if (receipt.job.state === "running") {
              granted.runtime.detached.set(receipt.job.id, {
                user: userHead(ctx),
                anchor: granted.plan.scope.anchor,
              });
              // Completion can race the wait promise and detach registration.
              const current = granted.runtime.host.jobs.get(receipt.job.id);
              if (current.state !== "running") {
                granted.runtime.notices.set(current.id, current);
                schedule(granted.runtime);
              }
            }
            return result(
              receipt,
              !["running", "completed"].includes(receipt.job.state) ||
                !!receipt.job.storageError ||
                !!receipt.job.cleanupError,
            );
          }
          runtime = get(ctx);
          const input: HostInput = {
            ...args,
            code:
              language === "bash"
                ? (args.command as string | undefined)
                : (args.code as string | undefined),
          };
          if (input.run !== false && runtime.detached.size >= 16)
            throw new Error(
              "JOB_NOTIFICATION_LIMIT: pending completions must be delivered before starting more jobs",
            );
          const prepared = runtime.host.prepare(language, input, scope(ctx));
          if (!("command" in prepared)) return result(prepared);
          plan = prepared;
          plans.set(plan.command, { parent: id, runtime, plan });
          const outcome = await ctx.executeTool(
            "bash",
            { command: plan.command },
            { signal },
          );
          return { ...outcome.result, isError: outcome.isError };
        } catch (error) {
          return result(
            {
              error: error instanceof Error ? error.message : String(error),
              ...(plan ? plan.draft : {}),
            },
            true,
          );
        } finally {
          if (plan) {
            plans.delete(plan.command);
            for (const [key, value] of approved)
              if (value.plan === plan) approved.delete(key);
            runtime?.host.discard(plan);
          }
        }
      },
    });
  }
  pi.on("session_start", (_event, ctx) => {
    activeSession = ctx.sessionManager.getSessionId();
    pi.setActiveTools([
      ...new Set([
        ...pi
          .getActiveTools()
          .filter((name) => !["codebuffer", "workflow"].includes(name)),
        "code",
        "python",
        "node",
        "bash",
      ]),
    ]);
  });
  pi.on("session_tree", (_event, ctx) => {
    const runtime = runtimes.get(ctx.sessionManager.getSessionId());
    if (!runtime) return;
    const restored = new ExecutionContext(ctx.cwd);
    const saved = ctx.sessionManager
      .getBranch()
      .findLast(
        (entry) => entry.type === "custom" && entry.customType === CONTEXT,
      );
    if (saved?.type === "custom") restored.restore(saved.data);
    else {
      const presets = loadPresets(
        join(getAgentDir(), "workflow.json"),
        ctx.cwd,
      );
      if (presets.routes) restored.update({ routes: presets.routes });
    }
    runtime.host.context.restore(restored.snapshot());
    runtime.ctx = ctx;
    runtime.paused = true; // Navigation must never start a provider turn by itself.
  });
  pi.on("before_agent_start", (_event, ctx) => {
    const r = runtimes.get(ctx.sessionManager.getSessionId());
    if (r) {
      r.busy = true;
      r.paused = false;
    }
  });
  pi.on("agent_end", (event, ctx) => {
    const r = runtimes.get(ctx.sessionManager.getSessionId());
    const last = event.messages.findLast((m) => m.role === "assistant");
    if (
      r &&
      last?.role === "assistant" &&
      ["error", "aborted"].includes(last.stopReason)
    )
      r.paused = true;
  });
  pi.on("agent_settled", (_event, ctx) => {
    const r = runtimes.get(ctx.sessionManager.getSessionId());
    if (r) {
      r.busy = false;
      schedule(r);
    }
  });
  pi.on("session_before_compact", (_event, ctx) => {
    const r = runtimes.get(ctx.sessionManager.getSessionId());
    if (r) r.compacting = true;
  });
  pi.on("session_compact", (_event, ctx) => {
    const r = runtimes.get(ctx.sessionManager.getSessionId());
    if (r) {
      r.compacting = false;
      schedule(r);
    }
  });
  pi.on("session_compact_failed", (_event, ctx) => {
    const r = runtimes.get(ctx.sessionManager.getSessionId());
    if (r) {
      r.compacting = false;
      r.paused = true;
    }
  });
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    for (const r of runtimes.values()) {
      clearTimeout(r.flush);
      r.notices.clear();
      r.detached.clear();
      await r.host.close();
    }
  });
}
