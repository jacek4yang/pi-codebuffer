import { ScratchStore } from "../scratch.js";
import { boundary, type EditRequest } from "../edit.js";

export interface BufferScope {
  session: string;
  ancestry: Set<string>;
  anchor: string | null;
}

/** Virtual source addresses share the scratch store's branch, quota and busy guards. */
export class Buffers {
  constructor(private readonly store: ScratchStore) {}

  private get(path: string, scope: BufferScope) {
    if (!/^buffer:[a-f0-9-]{36}$/.test(path))
      throw new Error("INVALID_BUFFER_PATH");
    return this.store.get(path.slice(7), scope.session, scope.ancestry);
  }

  read(path: string, scope: BufferScope, offset = 0, limit = 16000) {
    const record = this.get(path, scope);
    const current = record.revisions.at(-1)!;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > current.source.length ||
      !Number.isSafeInteger(limit) ||
      limit < 0 ||
      limit > 16000
    )
      throw new Error("INVALID_BUFFER_RANGE");
    if (!boundary(current.source, offset))
      throw new Error("INVALID_BUFFER_BOUNDARY");
    let end = Math.min(current.source.length, offset + limit);
    if (
      end > offset &&
      end < current.source.length &&
      /[\uD800-\uDBFF]/.test(current.source[end - 1]!)
    )
      end--;
    return {
      path,
      ref: record.ref,
      base: current.metadata.id,
      language: record.language ?? "code",
      units: current.source.length,
      offset,
      end,
      text: current.source.slice(offset, end),
    };
  }

  edit(path: string, base: string, edit: EditRequest, scope: BufferScope) {
    const record = this.get(path, scope);
    const updated = this.store.repair({
      ref: record.ref,
      base,
      edit,
      ...scope,
      run: false,
    });
    return {
      path,
      ref: updated.ref,
      base: updated.revisions.at(-1)!.metadata.id,
      units: updated.revisions.at(-1)!.source.length,
    };
  }

  append(path: string, base: string, text: string, scope: BufferScope) {
    const record = this.get(path, scope);
    const end = record.revisions.at(-1)!.source.length;
    return this.edit(
      path,
      base,
      { format: "range", edits: [{ start: end, end, text }] },
      scope,
    );
  }

  write(path: string, base: string, text: string, scope: BufferScope) {
    const record = this.get(path, scope);
    return this.edit(
      path,
      base,
      {
        format: "range",
        edits: [
          { start: 0, end: record.revisions.at(-1)!.source.length, text },
        ],
      },
      scope,
    );
  }
}
