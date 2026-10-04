import {
  createCodemodeExtension,
  type ExtensionAPI,
  type ToolDefinition,
  type ToolLoadout,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { config } from "./src/config.js";
import { Fused, fusedSchema, editSchema, isFused } from "./src/fused.js";
import { BranchIndex, durableBytes } from "./src/index-cache.js";
import { applyIR, compileEdit, boundary } from "./src/edit.js";
import { ENTRY, State, bytes, exact, revision, summary } from "./src/state.js";

const name = Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" });
const number = Type.Integer({ minimum: 1 });
const actions = Type.Union([
  fusedSchema,
  Type.Object(
    { action: Type.Literal("retire"), name },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("patch"),
      name,
      baseRevision: number,
      base: Type.String(),
      edit: editSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("create"), name, source: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("read"),
      name,
      revision: Type.Optional(number),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("patch"),
      name,
      baseRevision: number,
      old: Type.String({ minLength: 1 }),
      replacement: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("run"), name, revision: Type.Optional(number) },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("status"), name: Type.Optional(name) },
    { additionalProperties: false },
  ),
]);
// Provider-portable object root; validate the discriminated contract locally too.
type Compact =
  | { code: string }
  | {
      ref: string;
      base: string;
      edit?: Static<typeof editSchema>;
      rerun?: "from-start";
      run?: boolean;
    };
const schema = Type.Unsafe<Static<typeof actions> | Compact>(
  Type.Object(
    {
      code: Type.Optional(Type.String()),
      action: Type.Optional(
        Type.Union(
          [
            "create",
            "read",
            "patch",
            "run",
            "status",
            "exec",
            "repair",
            "reuse",
            "readScratch",
            "release",
            "promote",
            "retire",
          ].map((a) => Type.Literal(a)),
        ),
      ),
      ref: Type.Optional(Type.String()),
      base: Type.Optional(Type.String()),
      edit: Type.Optional(editSchema),
      rerun: Type.Optional(Type.Literal("from-start")),
      run: Type.Optional(Type.Boolean()),
      name: Type.Optional(name),
      source: Type.Optional(Type.String()),
      revision: Type.Optional(number),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })),
      lines: Type.Optional(Type.Boolean()),
      baseRevision: Type.Optional(number),
      old: Type.Optional(Type.String({ minLength: 1 })),
      replacement: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
);
const recovery =
  "Patch the existing buffer and rerun it; do not recreate the entire program. Rerunning repeats earlier side effects.";
const description =
  "Run {code: JavaScript}; use return for one final result (e.g. return tools.read({path})), text for incremental output. Success receipts retain ref/base: reuse with {ref,base,rerun:'from-start'}, or add edit for a similar program without resending source. repair runs from the beginning: after delegation require rerun:from-start; run:false edits only. edit formats: replace {edits:[{old,replacement,count?}]}, range {edits:[{start,end,text}]} (UTF-16 half-open), apply_patch {patch} (Codex envelope, virtual Update File: buffer). readScratch(ref,base?,offset?,limit?,lines?) returns guarded offsets; lines:true gives exact text spans for range edits (max256 spans/16000 units). Scratch expires; promote(ref,base,name) preserves durable source; release(ref) frees scratch. Legacy create/read/patch/run/status and retire(name) remain. Invalid syntax never executes. Outer orchestrator is not callable from CodeMode.";
const result = (data: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  details: undefined,
  isError,
});

export default function codebuffer(pi: ExtensionAPI): void {
  const options = config();
  const fused = new Fused(options.scratchDirectory, options.scratch);
  const index = new BranchIndex(options.cacheBytes);
  if (!options.enabled) return;
  let prepared = false;
  let ready = false;
  let prepareCodemode: ToolDefinition["prepareLoadout"];
  let originalExecutor:
    ToolLoadout["registered"][number]["execute"] | undefined;
  const authorizedParents = new Set<string>();
  // Pi 1.0.2 marks CodeMode model-only. Re-register its PUBLIC factory's
  // unchanged executor with callable exposure, never a copied implementation.
  pi.on("tool_call", (event) => {
    if (
      event.toolName === "codemode" &&
      event.parentToolCallId &&
      !authorizedParents.has(event.parentToolCallId)
    ) {
      return {
        block: true,
        reason:
          "CODEMODE_RECURSION_BLOCKED: only CodeBuffer may orchestrate CodeMode",
      };
    }
  });
  pi.registerTool({
    name: "codebuffer",
    label: "CodeBuffer",
    description: description + " Preferred format: " + options.preferredFormat,
    exposure: "model-only",
    executionMode: "sequential",
    parameters: schema,
    prepareLoadout(loadout) {
      prepared = true;
      const raw = loadout.registered.find((t) => t.name === "codemode");
      originalExecutor ??= raw?.execute;
      const contract =
        prepareCodemode?.(loadout)?.descriptions?.codemode ?? raw?.description;
      return {
        hiddenDeclarations: options.hideRawCodemode ? ["codemode"] : [],
        descriptions: {
          codebuffer:
            description +
            " Preferred format: " +
            options.preferredFormat +
            (contract
              ? "\nBuilt-in executor contract:\n" + contract
              : "\nUNAVAILABLE: enable Pi built-in codemode."),
        },
      };
    },
    async execute(_id, input, signal, onUpdate, ctx) {
      const shorthand = !("action" in input);
      const hasCode = "code" in input;
      let args: Static<typeof actions> = input as Static<typeof actions>;
      let buffer: string | undefined;
      try {
        if (hasCode) {
          if (Object.keys(input).length !== 1 || typeof input.code !== "string")
            throw new Error(
              "INVALID_ARGUMENTS: code cannot be mixed with action or source",
            );
          args = { action: "exec", source: input.code };
        } else if (shorthand && "ref" in input && "base" in input) {
          args = {
            ...input,
            action: "edit" in input ? "repair" : "reuse",
          } as Static<typeof actions>;
        }
        if (
          !ready ||
          (!prepared && options.hideRawCodemode) ||
          typeof ctx.executeTool !== "function" ||
          !ctx.tools.some((t) => t.name === "codemode")
        )
          throw new Error(
            "INCOMPATIBLE_PI: requires Pi built-in codemode, executeTool and prepareLoadout; hideRawCodemode:false is the declaration fallback",
          );
        if (
          signal?.aborted &&
          args.action !== "exec" &&
          args.action !== "repair"
        )
          throw new Error("ABORTED");
        if (!Check(actions, args))
          throw new Error(
            "INVALID_ARGUMENTS: {code}, {ref,base,edit?,rerun?,run?}, exec(source), reuse(ref,base,rerun?), repair(ref,base,edit,rerun?,run?), readScratch(ref,base?,offset?,limit?), release(ref), promote(ref,base,name), retire(name), create(name,source), read(name,revision?,offset?,limit?), patch(name,baseRevision,old,replacement), run(name,revision?), status(name?)",
          );
        const appendRevision = (r: ReturnType<typeof revision>) => {
          if (
            durableBytes(ctx.sessionManager.getEntries()) +
              bytes(JSON.stringify(r)) >
            options.durableBytes
          )
            throw new Error(
              "DURABLE_QUOTA: session source budget reached; independent scratch exec remains available. History was not freed.",
            );
          pi.appendEntry(ENTRY, r);
        };
        if (isFused(args)) {
          const { record: r, value, execute } = fused.prepare(args, ctx);
          if (args.action === "readScratch")
            return result(
              fused.read(r, args.base, args.offset, args.limit, args.lines),
            );
          if (args.action === "release") {
            fused.store.release(r);
            return result({ ref: r.ref, retention: "released" });
          }
          if (args.action === "promote") {
            if (value.metadata.id !== args.base)
              throw new Error("STALE_REVISION");
            const named = new State(ctx.sessionManager.getBranch());
            if (named.buffers.has(args.name)) throw new Error("BUFFER_EXISTS");
            if (named.active.size >= 64) throw new Error("BUFFER_LIMIT");
            const durable = revision(args.name, value.source);
            appendRevision(durable);
            return result(summary({ metadata: durable, source: value.source }));
          }
          if (!execute || !value.metadata.syntax.valid)
            return result(
              fused.describe(r),
              execute && !value.metadata.syntax.valid,
            );
          const base = value.metadata.id;
          const previouslyDelegated = r.delegated;
          r.execution = "running";
          r.delegated = true;
          const settle = () => {
            try {
              fused.store.update(r, base);
              return undefined;
            } catch (error) {
              return error instanceof Error
                ? error.message
                : "Scratch settlement failed";
            }
          };
          const startError = settle();
          if (startError)
            return result(
              {
                ...fused.describe(r),
                storageError: startError,
                retention: "recovery_required",
              },
              true,
            );
          authorizedParents.add(_id);
          try {
            if (signal?.aborted) {
              r.execution = "interrupted";
              r.delegated = previouslyDelegated;
              const storageError = settle();
              return result({ ...fused.describe(r), storageError }, true);
            }
            const outcome = await ctx.executeTool(
              "codemode",
              { code: value.source },
              { signal, onUpdate },
            );
            r.execution = signal?.aborted
              ? "interrupted"
              : outcome.isError
                ? "failed"
                : "completed";
            const storageError = settle();
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    ...(shorthand &&
                    r.execution === "completed" &&
                    !storageError
                      ? { ref: r.ref, base: value.metadata.id }
                      : fused.describe(r)),
                    ...(storageError
                      ? { storageError, retention: "recovery_required" }
                      : {}),
                  }),
                },
                ...outcome.result.content,
              ],
              details: outcome.result.details,
              isError: outcome.isError || !!signal?.aborted || !!storageError,
            };
          } catch (error) {
            r.execution = "interrupted";
            const storageError = settle();
            return result(
              {
                ...fused.describe(r),
                storageError,
                error:
                  error instanceof Error
                    ? error.message
                    : "Execution interrupted",
              },
              true,
            );
          } finally {
            authorizedParents.delete(_id);
          }
        }
        const state = index.get(
          ctx.sessionManager.getSessionId(),
          ctx.sessionManager.getBranch(),
        );
        if (args.action === "status")
          return result({
            ...state.status(args.name),
            cache: index.status(),
            durableSourceBytes: durableBytes(ctx.sessionManager.getEntries()),
            scratch:
              process.platform === "win32"
                ? { unavailable: "INCOMPATIBLE_SCRATCH_ACL" }
                : fused.store.status(
                    ctx.sessionManager.getSessionId(),
                    new Set(ctx.sessionManager.getBranch().map((e) => e.id)),
                  ),
          });
        if (args.action === "retire") {
          state.get(args.name);
          if (state.active.has(args.name))
            pi.appendEntry(ENTRY, { kind: "retire", name: args.name });
          return result({
            name: args.name,
            retention: "retired",
            history: "preserved",
          });
        }
        if (args.action === "create") {
          if (state.buffers.has(args.name))
            throw new Error("BUFFER_EXISTS: patch the existing buffer");
          if (state.active.size >= 64)
            throw new Error("BUFFER_LIMIT: maximum 64 per branch");
          const r = revision(args.name, args.source);
          appendRevision(r);
          return result(summary({ metadata: r, source: args.source }));
        }
        if (args.action === "patch") {
          try {
            if (!state.active.has(args.name))
              throw new Error(
                "BUFFER_RETIRED: historical read/run remain available; create a new lineage name",
              );
            const base = state.get(args.name);
            if (base.metadata.revision !== args.baseRevision)
              throw new Error(
                "STALE_REVISION: current head is " + base.metadata.revision,
              );
            if ("edit" in args && args.base !== base.metadata.id)
              throw new Error(
                "STALE_REVISION: expected immutable base identity",
              );
            const ir =
              "edit" in args ? compileEdit(base.source, args.edit) : undefined;
            const patch =
              "old" in args
                ? { old: args.old, replacement: args.replacement }
                : undefined;
            const source = ir
              ? applyIR(base.source, ir)
              : exact(base.source, patch!.old, patch!.replacement);
            const r = revision(args.name, source, base, patch, ir);
            appendRevision(r);
            return result(summary({ metadata: r, source }));
          } catch (error) {
            pi.appendEntry(ENTRY, {
              kind: "metric",
              metric: "patchFailures",
              bytes: 0,
            });
            throw error;
          }
        }
        const r = state.get(args.name, args.revision);
        buffer = args.name + "@" + r.metadata.revision;
        if (args.action === "read") {
          const offset = args.offset ?? 0;
          if (!boundary(r.source, offset)) throw new Error("INVALID_RANGE");
          let end = Math.min(r.source.length, offset + (args.limit ?? 4000));
          if (!boundary(r.source, end)) end--;
          if (end === offset && offset < r.source.length)
            throw new Error(
              "INVALID_RANGE: increase limit to include a complete Unicode character",
            );
          return result({
            buffer,
            base: r.metadata.id,
            end,
            hash: r.metadata.hash,
            offset,
            source: r.source.slice(offset, end),
            nextOffset: end < r.source.length ? end : null,
          });
        }
        if (!r.metadata.syntax.valid)
          return result(
            { buffer, status: "failed", syntax: r.metadata.syntax, recovery },
            true,
          );
        pi.appendEntry(ENTRY, {
          kind: "metric",
          metric: "runs",
          bytes: bytes(r.source),
        });
        authorizedParents.add(_id);
        const outcome = await (async () => {
          try {
            return await ctx.executeTool(
              "codemode",
              { code: r.source },
              { signal, onUpdate },
            );
          } finally {
            authorizedParents.delete(_id);
          }
        })();
        // Pi accounts for nested usage; forwarding it would double count.
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                buffer,
                hash: r.metadata.hash,
                status: outcome.isError ? "failed" : "completed",
                ...(outcome.isError ? { recovery } : {}),
              }),
            },
            ...outcome.result.content,
          ],
          details: outcome.result.details,
          isError: outcome.isError,
        };
      } catch (error) {
        return result(
          {
            buffer,
            status: "failed",
            error: error instanceof Error ? error.message : "CodeBuffer failed",
            ...(isFused(args)
              ? {
                  execution: "not_started",
                  ...("ref" in args ? { ref: args.ref } : {}),
                  ...("base" in args ? { requestedBase: args.base } : {}),
                  recovery:
                    error instanceof Error &&
                    error.message.startsWith("STALE_REVISION")
                      ? "readScratch(ref) for the current base; no edit was committed"
                      : error instanceof Error &&
                          error.message.startsWith("RERUN_ACK_REQUIRED")
                        ? "Retry repair with rerun: from-start only if repeating prior effects is intended"
                        : "No execution attempted; resolve the reported error before retrying",
                }
              : { recovery }),
          },
          true,
        );
      }
    },
  });
  pi.on("session_start", (_event, ctx) => {
    ready = false;
    if (
      !pi.getAllTools().some((t) => t.name === "codemode") ||
      !originalExecutor
    ) {
      ctx.ui.notify(
        "CodeBuffer unavailable: requires Pi built-in codemode and prepareLoadout. Enable CodeMode or upgrade Pi.",
        "error",
      );
      return;
    }
    createCodemodeExtension()({
      ...pi,
      registerTool(definition) {
        prepareCodemode = definition.prepareLoadout;
        pi.registerTool({
          ...definition,
          exposure: "direct",
          execute: originalExecutor!,
        });
      },
    });
    pi.setActiveTools([
      ...new Set([...pi.getActiveTools(), "codemode", "codebuffer"]),
    ]);
    ready = prepared || !options.hideRawCodemode;
    if (!ready)
      ctx.ui.notify(
        "CodeBuffer: prepareLoadout unavailable; set PI_CODEBUFFER hideRawCodemode:false or upgrade Pi.",
        "error",
      );
    if (options.debug)
      ctx.ui.notify("CodeBuffer ready; source logging disabled.", "info");
  });
  pi.registerCommand("codebuffer", {
    description: "CodeBuffer status / recover (read-only inspection)",
    handler: async (args, ctx) => {
      if (!["", "status", "inspect", "list", "recover"].includes(args.trim())) {
        ctx.ui.notify("Usage: /codebuffer [status|recover]", "warning");
        return;
      }
      try {
        ctx.ui.notify(
          JSON.stringify(
            args.trim() === "recover"
              ? fused.store.inspect()
              : new State(ctx.sessionManager.getBranch()).status(),
            null,
            2,
          ),
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : "State error",
          "error",
        );
      }
    },
  });
}
