import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
const replace = Type.Object(
  {
    old: Type.String({ minLength: 1 }),
    replacement: Type.String(),
    count: Type.Optional(Type.Integer({ minimum: 1, maximum: 1024 })),
  },
  { additionalProperties: false },
);
const range = Type.Object(
  {
    start: Type.Integer({ minimum: 0 }),
    end: Type.Integer({ minimum: 0 }),
    text: Type.String(),
  },
  { additionalProperties: false },
);
export const schema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    format: Type.Union([
      Type.Literal("replace"),
      Type.Literal("range"),
      Type.Literal("apply_patch"),
      Type.Literal("snapshot"),
    ]),
    base: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
    edits: Type.Optional(
      Type.Array(Type.Union([replace, range]), { minItems: 1, maxItems: 1024 }),
    ),
    patch: Type.Optional(Type.String()),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 16000 })),
  },
  { additionalProperties: false },
);
export type Input = Static<typeof schema>;
export function prepare(input: unknown): Input {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("INVALID_EDIT");
  const a = { ...input } as Record<string, unknown>;
  if (a.format === undefined) {
    a.format = "replace";
    if ("oldText" in a || "newText" in a) {
      if (a.edits !== undefined)
        throw new Error("INVALID_EDIT: mixed legacy inputs");
      a.edits = [{ oldText: a.oldText, newText: a.newText }];
      delete a.oldText;
      delete a.newText;
    }
    if (Array.isArray(a.edits))
      a.edits = a.edits.map((e) => {
        if (e && typeof e === "object" && "oldText" in e) {
          if (Object.keys(e).some((k) => !["oldText", "newText"].includes(k)))
            throw new Error("INVALID_EDIT");
          return { old: e.oldText, replacement: e.newText };
        }
        return e;
      });
  }
  if (!Check(schema, a))
    throw new Error("INVALID_EDIT: input does not match schema");
  if (a.format === "replace" || a.format === "range") {
    if (
      !a.edits ||
      a.patch !== undefined ||
      a.offset !== undefined ||
      a.limit !== undefined
    )
      throw new Error("INVALID_EDIT");
    const item = a.format === "replace" ? replace : range;
    if (!(a.edits as unknown[]).every((e) => Check(item, e)))
      throw new Error("INVALID_EDIT");
    if (a.format === "range" && !a.base)
      throw new Error(
        "BASE_REQUIRED: use edit format:snapshot for guarded UTF-16 coordinates",
      );
  } else if (
    a.edits !== undefined ||
    (a.format === "apply_patch"
      ? typeof a.patch !== "string" ||
        a.offset !== undefined ||
        a.limit !== undefined
      : a.patch !== undefined)
  )
    throw new Error("INVALID_EDIT");
  return a as Input;
}
