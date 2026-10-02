import {
  createCodemodeExtension,
  type ExtensionAPI,
  type ToolDefinition,
  type ToolLoadout,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { config } from "./src/config.js";
import { ENTRY, State, bytes, exact, revision, summary } from "./src/state.js";

const name = Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" });
const number = Type.Integer({ minimum: 1 });
const actions = Type.Union([
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
const schema = Type.Unsafe<Static<typeof actions>>(
  Type.Object(
    {
      action: Type.Union(
        ["create", "read", "patch", "run", "status"].map((a) =>
          Type.Literal(a),
        ),
      ),
      name: Type.Optional(name),
      source: Type.Optional(Type.String()),
      revision: Type.Optional(number),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })),
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
  "Persistent CodeMode source. Create once, patch exact unique text against the current baseRevision, run an immutable revision. Syntax-invalid revisions never execute. Read uses zero-based UTF-16 character offset, at most 16000 characters. Status excludes source. After errors patch, do not regenerate. Scripts use Pi CodeMode globals (text, image, tools, models, searchTools, describeTool, describeNamespace, store/load).";
const result = (data: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  details: undefined,
  isError,
});

export default function codebuffer(pi: ExtensionAPI): void {
  const options = config();
  if (!options.enabled) return;
  let prepared = false;
  let ready = false;
  let prepareCodemode: ToolDefinition["prepareLoadout"];
  let originalExecutor:
    ToolLoadout["registered"][number]["execute"] | undefined;
  const authorizedParents = new Set<string>();
  // Pi 1.0.0 marks CodeMode model-only. Re-register its PUBLIC factory's
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
    description,
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
            (contract
              ? "\nBuilt-in executor contract:\n" + contract
              : "\nUNAVAILABLE: enable Pi built-in codemode."),
        },
      };
    },
    async execute(_id, args, signal, onUpdate, ctx) {
      let buffer: string | undefined;
      try {
        if (
          !ready ||
          (!prepared && options.hideRawCodemode) ||
          typeof ctx.executeTool !== "function" ||
          !ctx.tools.some((t) => t.name === "codemode")
        )
          throw new Error(
            "INCOMPATIBLE_PI: requires Pi 1.0.0 built-in codemode, executeTool and prepareLoadout; hideRawCodemode:false is the declaration fallback",
          );
        if (signal?.aborted) throw new Error("ABORTED");
        if (!Check(actions, args))
          throw new Error(
            "INVALID_ARGUMENTS: create(name,source), read(name,revision?,offset?,limit?), patch(name,baseRevision,old,replacement), run(name,revision?), status(name?)",
          );
        const state = new State(ctx.sessionManager.getBranch());
        if (args.action === "status") return result(state.status(args.name));
        if (args.action === "create") {
          if (state.buffers.has(args.name))
            throw new Error("BUFFER_EXISTS: patch the existing buffer");
          if (state.buffers.size >= 64)
            throw new Error("BUFFER_LIMIT: maximum 64 per branch");
          const r = revision(args.name, args.source);
          pi.appendEntry(ENTRY, r);
          return result(summary({ metadata: r, source: args.source }));
        }
        if (args.action === "patch") {
          try {
            const base = state.get(args.name);
            if (base.metadata.revision !== args.baseRevision)
              throw new Error(
                "STALE_REVISION: current head is " + base.metadata.revision,
              );
            const patch = { old: args.old, replacement: args.replacement };
            const source = exact(base.source, patch.old, patch.replacement);
            const r = revision(args.name, source, base, patch);
            pi.appendEntry(ENTRY, r);
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
          const end = Math.min(r.source.length, offset + (args.limit ?? 4000));
          return result({
            buffer,
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
            recovery,
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
        "CodeBuffer unavailable: requires Pi 1.0.0 built-in codemode and prepareLoadout. Enable CodeMode or upgrade Pi.",
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
    description: "CodeBuffer status / inspect (metadata only)",
    handler: async (args, ctx) => {
      if (!["", "status", "inspect", "list"].includes(args.trim())) {
        ctx.ui.notify("Usage: /codebuffer [status|inspect|list]", "warning");
        return;
      }
      try {
        ctx.ui.notify(
          JSON.stringify(
            new State(ctx.sessionManager.getBranch()).status(),
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
