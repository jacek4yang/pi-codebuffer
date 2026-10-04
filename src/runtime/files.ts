import {
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { Buffers, type BufferScope } from "./buffers.js";
import { ScratchStore } from "../scratch.js";
import { edit as editFile } from "../files/edit.js";
import { schema as fileSchema } from "../files/schema.js";
import type { EditRequest } from "../edit.js";
import { executionRenderers } from "./render.js";

const reply = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: undefined,
});
const scope = (ctx: ExtensionContext): BufferScope => ({
  session: ctx.sessionManager.getSessionId(),
  ancestry: new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)),
  anchor: ctx.sessionManager.getLeafId(),
});

export function registerFiles(
  pi: ExtensionAPI,
  scratch: ScratchStore,
  cwd: (ctx: ExtensionContext) => string,
) {
  const buffers = new Buffers(scratch);
  const read = createReadToolDefinition(process.cwd());
  pi.registerTool({
    ...read,
    description:
      read.description +
      " For buffer:<ref>, offset/limit are UTF-16 units (0-based, max 16000); returns guarded base.",
    async execute(id, args, signal, update, ctx) {
      if (signal?.aborted) throw new Error("CANCELLED");
      if (args.path.startsWith("buffer:"))
        return reply(
          buffers.read(
            args.path,
            scope(ctx),
            args.offset ?? 0,
            args.limit ?? 16000,
          ),
        );
      return createReadToolDefinition(cwd(ctx)).execute(
        id,
        args,
        signal,
        update,
        ctx,
      );
    },
  });
  const nativeWrite = createWriteToolDefinition(process.cwd());
  const writeSchema = Type.Object(
    {
      ...nativeWrite.parameters.properties,
      base: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  );
  pi.registerTool({
    name: "write",
    label: "write",
    ...executionRenderers("write"),
    parameters: writeSchema,
    description:
      "Write a new file or intentionally replace it. For buffer:<ref>, replace retained source using required base; no execution.",
    async execute(id, args, signal, update, ctx) {
      if (signal?.aborted) throw new Error("CANCELLED");
      if (args.path.startsWith("buffer:")) {
        if (!args.base) throw new Error("BASE_REQUIRED");
        return reply(
          buffers.write(args.path, args.base, args.content, scope(ctx)),
        );
      }
      if (args.base !== undefined)
        throw new Error(
          "FILE_BASE_UNSUPPORTED: use edit for guarded file changes",
        );
      return createWriteToolDefinition(cwd(ctx)).execute(
        id,
        { path: args.path, content: args.content },
        signal,
        update,
        ctx,
      );
    },
  });
  const editSchema = Type.Object(
    {
      ...fileSchema.properties,
      base: Type.Optional(Type.String()),
      format: Type.Union([
        ...fileSchema.properties.format.anyOf,
        Type.Literal("append"),
      ]),
      text: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  );
  pi.registerTool({
    name: "edit",
    label: "edit",
    ...executionRenderers("edit"),
    parameters: editSchema,
    description:
      "Strict file or buffer:<ref> edits: replace, guarded UTF-16 range, apply_patch, snapshot. Buffer changes require base; append text assembles chunks without execution. Files use SHA-256 bases; buffers use revision IDs.",
    async execute(_id, args, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("CANCELLED");
      if (!args.path.startsWith("buffer:"))
        return editFile(args, cwd(ctx), signal);
      if (args.format === "snapshot") {
        if (
          args.edits !== undefined ||
          args.patch !== undefined ||
          args.text !== undefined
        )
          throw new Error("INVALID_EDIT");
        const result = buffers.read(
          args.path,
          scope(ctx),
          args.offset ?? 0,
          args.limit ?? 0,
        );
        if (args.base !== undefined && args.base !== result.base)
          throw new Error("STALE_REVISION");
        return reply(result);
      }
      if (!args.base) throw new Error("BASE_REQUIRED");
      if (args.offset !== undefined || args.limit !== undefined)
        throw new Error("INVALID_EDIT");
      if (args.format === "append") {
        if (
          typeof args.text !== "string" ||
          args.edits !== undefined ||
          args.patch !== undefined
        )
          throw new Error("INVALID_EDIT");
        return reply(
          buffers.append(args.path, args.base, args.text, scope(ctx)),
        );
      }
      if (args.text !== undefined || !Check(editSchema, args))
        throw new Error("INVALID_EDIT");
      const request =
        args.format === "apply_patch"
          ? { format: args.format, patch: args.patch }
          : { format: args.format, edits: args.edits };
      if (
        (args.format === "apply_patch" && args.edits !== undefined) ||
        (args.format !== "apply_patch" && args.patch !== undefined)
      )
        throw new Error("INVALID_EDIT");
      return reply(
        buffers.edit(args.path, args.base, request as EditRequest, scope(ctx)),
      );
    },
  });
}
