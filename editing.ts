// Pure builders/compilers only. No globals, host I/O or implicit mutation.
export {
  compileEdit,
  applyIR,
  boundary,
  validText,
  type EditIR,
  type EditRequest,
  type Splice,
} from "./src/edit.js";
export { parsePatch, type PatchFile, type Chunk } from "./src/patch.js";
export { compileTextPatchSet, type TextChange } from "./src/patch-set.js";
