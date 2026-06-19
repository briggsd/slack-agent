/**
 * Wrap untrusted text (tool output, a reviewer's reply) as labelled data for an agent
 * prompt. Two defenses:
 *   - length-cap so a huge blob can't blow the prompt budget;
 *   - neutralize any closing `</tag>` inside the text so it cannot break out of the
 *     delimiter and have the rest read as instructions.
 *
 * Prompt hygiene only — the container is the real security boundary — but it keeps the
 * delimiter honest. Used by the implement node (check output) and the plan node (gate
 * feedback).
 */
export function delimitAsData(tag: string, text: string, maxChars: number): string {
  const capped = text.slice(0, maxChars);
  // Defang any closing tag for THIS delimiter (case-insensitive). Inserting a space breaks
  // the `</tag>` token so it reads as plain text, not the end of the data block.
  const closing = new RegExp(`</${tag}\\s*>`, 'gi');
  const safe = capped.replace(closing, `</${tag} (escaped)>`);
  return `<${tag}>\n${safe}\n</${tag}>`;
}
