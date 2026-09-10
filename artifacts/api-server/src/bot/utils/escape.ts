/**
 * Text safety utilities for Telegram Markdown v1 messages.
 *
 * Rule: NEVER embed raw user-provided text inside a Markdown message.
 * Always wrap dynamic content with md() before embedding in a template.
 *
 * For messages with NO formatting needed, omit parse_mode entirely — plain text
 * never throws entity parse errors regardless of content.
 */

/** Escape user text for safe embedding in Telegram Markdown v1 */
export function md(text: string | number | null | undefined): string {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(/\*/g, "")
    .replace(/_/g, " ")
    .replace(/`/g, "'")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")");
}

/** Safe username: strips special chars, wraps in (@...) */
export function safeUsername(username: string | null | undefined): string {
  if (!username) return "";
  return " (@" + md(username) + ")";
}

/** Safe display name with fallback */
export function safeName(name: string | null | undefined, fallback = "User"): string {
  return md(name) || fallback;
}
