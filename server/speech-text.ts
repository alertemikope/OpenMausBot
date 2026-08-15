/** A tool-activity chip as concise progress context for Jarvis. */
export function narrateTool(toolName: string): string | null {
  const name = toolName.replace(/^mcp__[^_]+__/, "").trim();
  if (!name || /^(auto-approved|error):/i.test(name)) return null;
  const bare = name.toLowerCase();
  const verbs: Array<[RegExp, string]> = [
    [/^(bash|shell|terminal|run_command|execute|computer_exec)$/, "running a command"],
    [/^(read|read_file|view)$/, "reading a file"],
    [/^(write|create_file)$/, "writing a file"],
    [/^(edit|apply_patch|str_replace|multiedit)$/, "editing a file"],
    [/^(grep|search|glob|find)$/, "searching"],
    [/^(web_?search|websearch)$/, "searching the web"],
    [/^(web_?fetch|fetch)$/, "reading a page"],
    [/^screenshot$/, "looking at the screen"],
    [/^(click|type_text|press_key|scroll|computer_batch)$/, "using the computer"],
    [/^open_url$/, "opening a page"],
    [/^list_bots$/, "checking who's around"],
    [/^ask_bot$/, "asking a teammate"],
  ];
  for (const [pattern, phrase] of verbs) if (pattern.test(bare)) return phrase;
  const short = name.split("/").at(-1)?.slice(0, 40) ?? "tool";
  return /^[\w .:-]+$/.test(short) ? `running ${short}` : null;
}
