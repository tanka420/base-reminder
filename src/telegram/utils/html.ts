/**
 * src/telegram/utils/html.ts
 *
 * Safe HTML escaping utility for Telegram HTML parse mode.
 */

export function escapeHtml(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
