import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ScratchStore, type Scratch } from "./scratch.js";
import { boundary } from "./edit.js";
import { syntax, summary, type Materialized } from "./state.js";
const exact = Type.Object(
  {
    old: Type.String({ minLength: 1 }),
    replacement: Type.String(),
    count: Type.Optional(Type.Integer({ minimum: 1, maximum: 1024 })),
  },
  { additionalProperties: false },
);
const splice = Type.Object(
  {
    start: Type.Integer({ minimum: 0 }),
    end: Type.Integer({ minimum: 0 }),
    text: Type.String(),
  },
  { additionalProperties: false },
);
export const editSchema = Type.Union([
  Type.Object(
    {
      format: Type.Literal("replace"),
      edits: Type.Array(exact, { minItems: 1, maxItems: 1024 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      format: Type.Literal("range"),
      edits: Type.Array(splice, { minItems: 1, maxItems: 1024 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { format: Type.Literal("apply_patch"), patch: Type.String() },
    { additionalProperties: false },
  ),
]);
export const fusedSchema = Type.Union([
  Type.Object(
    { action: Type.Literal("exec"), source: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("repair"),
      ref: Type.String(),
      base: Type.String(),
      edit: editSchema,
      rerun: Type.Optional(Type.Literal("from-start")),
      run: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("readScratch"),
      ref: Type.String(),
      base: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("release"), ref: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("promote"),
      ref: Type.String(),
      base: Type.String(),
      name: Type.String(),
    },
    { additionalProperties: false },
  ),
]);
export type FusedArgs = Static<typeof fusedSchema>;
export const isFused = (args: unknown): args is FusedArgs =>
  Check(fusedSchema, args);
export class Fused {
  readonly store: ScratchStore;
  constructor(directory?: string, limits?: import("./scratch.js").Limits) {
    this.store = new ScratchStore(
      directory ?? join(getAgentDir(), "codebuffer-scratch-v1"),
      limits,
    );
  }
  prepare(
    args: FusedArgs,
    ctx: ExtensionContext,
  ): { record: Scratch; value: Materialized; execute: boolean } {
    const manager = ctx.sessionManager;
    const r =
      args.action === "exec"
        ? this.store.create(
            manager.getSessionId(),
            manager.getLeafId(),
            args.source,
          )
        : args.action === "repair"
          ? this.store.repair({
              ref: args.ref,
              session: manager.getSessionId(),
              ancestry: new Set(manager.getBranch().map((e) => e.id)),
              base: args.base,
              edit: args.edit,
              run: args.run !== false,
              rerun: args.rerun,
              anchor: manager.getLeafId(),
            })
          : this.store.get(
              args.ref,
              manager.getSessionId(),
              new Set(manager.getBranch().map((e) => e.id)),
            );
    const value = r.revisions.at(-1)!;
    if (
      JSON.stringify(syntax(value.source)) !==
      JSON.stringify(value.metadata.syntax)
    )
      throw new Error("SCRATCH_CORRUPT: syntax metadata");
    return {
      record: r,
      value,
      execute:
        args.action === "exec" ||
        (args.action === "repair" && args.run !== false),
    };
  }
  describe(r: Scratch): object {
    const v = r.revisions.at(-1)!;
    return {
      ref: r.ref,
      base: v.metadata.id,
      ...summary(v),
      execution: r.execution,
      effects: r.delegated ? "unknown" : "not_started",
      retention: r.execution === "completed" ? "recent_success" : "retained",
      ...(r.execution !== "completed"
        ? {
            recovery:
              "Repair this reference and base; after delegation acknowledge rerun: from-start. Promote before expiry for durable retention.",
          }
        : {}),
    };
  }
  read(r: Scratch, base: string | undefined, offset = 0, limit = 4000): object {
    const v = base
      ? r.revisions.find((x) => x.metadata.id === base)
      : r.revisions.at(-1);
    if (!v) throw new Error("REVISION_EVICTED");
    if (!boundary(v.source, offset)) throw new Error("INVALID_RANGE");
    let end = Math.min(v.source.length, offset + limit);
    if (!boundary(v.source, end)) end--;
    if (end === offset && offset < v.source.length)
      throw new Error(
        "INVALID_RANGE: increase limit to include a complete Unicode character",
      );
    return {
      ref: r.ref,
      base: v.metadata.id,
      hash: v.metadata.hash,
      offset,
      end,
      source: v.source.slice(offset, end),
      nextOffset: end < v.source.length ? end : null,
    };
  }
}
