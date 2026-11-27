export const DEFAULT_BUY_KEY_BOT_URL = "https://t.me/ZimbolaKeyBot";
export const DEFAULT_TELEGRAM_SUPPORT_URL = "https://t.me/ZimbolaSupport";
export const DEFAULT_TELEGRAM_CHANNEL_URL = "https://t.me/ZimbolaClux";

export function normalizeBotUrl(
  raw: string | null | undefined,
  fallback: string = DEFAULT_BUY_KEY_BOT_URL,
): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return fallback;
  if (
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("tg://")
  ) {
    return trimmed;
  }
  if (/^(?:t\.me|telegram\.me)\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  const cleanHandle = trimmed.replace(/^@+/, "");
  return `https://t.me/${cleanHandle}`;
}
