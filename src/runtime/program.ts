import type { Language } from "./environment.js";
/** Source travels over stdin, not shell-escaped CLI arguments or agent-authored temp files. */
export function hostProgram(
  language: Language,
  executable: string,
  source: string,
): { args: string[]; stdin: string } {
  if (source.includes("\0") || Buffer.byteLength(source) > 262144)
    throw new Error("SOURCE_LIMIT: NUL-free source up to 256 KiB");
  if (language === "python") return { args: ["-"], stdin: source };
  if (language === "node")
    return { args: ["--input-type=module"], stdin: source };
  // Bash otherwise executes early statements before discovering a later syntax error.
  // Preserve trailing newlines with a sentinel; suppress BASH_ENV only for the parse-only child.
  const wrapper =
    '_pi_buffer_source="$(/usr/bin/cat; printf .)"; _pi_buffer_source="${_pi_buffer_source%.}"; /usr/bin/env -u BASH_ENV "$0" -n <<< "$_pi_buffer_source" && eval -- "$_pi_buffer_source"';
  return { args: ["-c", wrapper, executable], stdin: source };
}
