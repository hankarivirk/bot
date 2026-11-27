import { webcrypto } from "node:crypto";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { ensureNeonSchema, type AppSettingRow } from "../db/neon.js";
import {
  encryptKeyForStorage,
  generateRandomLicenseKey,
  logAuditEvent,
  sha256Hex,
} from "./security.js";
import { normalizeBotUrl } from "./botUrl.js";
import {
  createCashfreeOrderAndQr,
  fetchCashfreeOrderStatus,
  verifyCashfreePayment,
  type CashfreeConfig,
  type CashfreeEnv,
  type CashfreeQrMode,
} from "./cashfree.js";

// ============================================================================
// Configuration (read dynamically from process.env)
// ============================================================================
const BULK_PRESETS = [10, 25, 50, 100];

let cachedBotUsername = "";

export type BotConfig = {
  botToken: string;
  adminIds: Set<string>;
  cashfreeAppId: string;
  cashfreeSecretKey: string;
  cashfreeEnv: CashfreeEnv;
  cashfreeQrMode: CashfreeQrMode;
  cashfreeWhitelistedUrl: string;
  publicBaseUrl: string;
  localPort: number;
  shopName: string;
  productName: string;
  singlePrice: number;
  bulkPrice: number;
  bulkMin: number;
  bulkMax: number;
  keyDays: number;
  orderTimeoutMin: number;
  supportUrlEnv: string;
};

function resolveWhitelistedOrigin(): string {
  const raw = (
    process.env["CASHFREE_WHITELISTED_URL"] ??
    process.env["CASHFREE_WHITELISTED_DOMAIN"] ??
    process.env["CASHFREE_ORIGIN"] ??
    ""
  ).trim();
  if (!raw) return "";
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withProto).origin;
  } catch {
    return "";
  }
}

function resolvePublicBaseUrl(): string {
  const explicit = (process.env["PUBLIC_URL"] ?? process.env["BOT_PUBLIC_URL"] ?? "").trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }
  const railwayDomain = (process.env["RAILWAY_PUBLIC_DOMAIN"] ?? "").trim();
  if (railwayDomain) {
    return /^https?:\/\//i.test(railwayDomain)
      ? railwayDomain.replace(/\/+$/, "")
      : `https://${railwayDomain.replace(/\/+$/, "")}`;
  }
  return "";
}

function parseCashfreeEnv(raw: string | undefined): CashfreeEnv {
  const v = (raw ?? "PROD").trim().toUpperCase();
  return v === "SANDBOX" || v === "TEST" ? "SANDBOX" : "PROD";
}

function parseCashfreeQrMode(raw: string | undefined): CashfreeQrMode {
  const v = (raw ?? "auto").trim().toLowerCase();
  if (v === "direct" || v === "s2s") return "direct";
  if (v === "playwright" || v === "browser") return "playwright";
  if (v === "checkout" || v === "link") return "checkout";
  return "auto";
}

export function getBotConfig(): BotConfig {
  const rawAdmins = (process.env["ADMIN_ID"] ?? "").replace(/\s+/g, "");
  const adminIds = new Set(
    rawAdmins
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s)),
  );

  const singlePrice = Number(process.env["SINGLE_PRICE"] ?? "99");
  const bulkPrice = Number(process.env["BULK_PRICE"] ?? "59");
  const bulkMin = Math.max(2, Math.floor(Number(process.env["BULK_MIN"] ?? "10") || 10));
  const bulkMax = Math.max(bulkMin, Math.floor(Number(process.env["BULK_MAX"] ?? "1000") || 1000));
  const keyDays = Math.max(0, Math.floor(Number(process.env["KEY_DAYS"] ?? "0") || 0));
  const orderTimeoutMin = Math.max(
    1,
    Math.floor(Number(process.env["ORDER_TIMEOUT_MIN"] ?? "10") || 10),
  );
  const localPort = Number(process.env["PORT"] ?? "3000") || 3000;

  return {
    botToken: (process.env["BOT_TOKEN"] ?? "").trim(),
    adminIds,
    cashfreeAppId: (
      process.env["CASHFREE_APP_ID"] ??
      process.env["CASHFREE_CLIENT_ID"] ??
      ""
    ).trim(),
    cashfreeSecretKey: (
      process.env["CASHFREE_SECRET_KEY"] ??
      process.env["CASHFREE_CLIENT_SECRET"] ??
      ""
    ).trim(),
    cashfreeEnv: parseCashfreeEnv(process.env["CASHFREE_ENV"]),
    cashfreeQrMode: parseCashfreeQrMode(process.env["CASHFREE_QR_MODE"]),
    cashfreeWhitelistedUrl: resolveWhitelistedOrigin(),
    publicBaseUrl: resolvePublicBaseUrl(),
    localPort,
    shopName: (process.env["SHOP_NAME"] ?? "Digital Store").trim() || "Digital Store",
    productName:
      (process.env["PRODUCT_NAME"] ?? "Access Key").trim() ||
      "Access Key",
    singlePrice: Number.isFinite(singlePrice) && singlePrice > 0 ? singlePrice : 99,
    bulkPrice: Number.isFinite(bulkPrice) && bulkPrice > 0 ? bulkPrice : 59,
    bulkMin,
    bulkMax,
    keyDays,
    orderTimeoutMin,
    supportUrlEnv: (
      process.env["SUPPORT_URL"] ??
      process.env["TELEGRAM_SUPPORT_URL"] ??
      ""
    ).trim(),
  };
}

function toCashfreeConfig(cfg: BotConfig): CashfreeConfig {
  return {
    appId: cfg.cashfreeAppId,
    secretKey: cfg.cashfreeSecretKey,
    env: cfg.cashfreeEnv,
    qrMode: cfg.cashfreeQrMode,
    localPort: cfg.localPort,
    publicBaseUrl: cfg.publicBaseUrl,
    whitelistedOrigin: cfg.cashfreeWhitelistedUrl,
  };
}

function parseLivePrice(raw: string | null | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 100000 ? Math.round(n) : fallback;
}

export async function getEffectiveBotConfig(
  sql: NeonQueryFunction<false, false>,
): Promise<BotConfig> {
  const base = getBotConfig();
  try {
    const rows = (await sql`
      SELECT key, value FROM public.app_settings
      WHERE key IN ('single_price', 'bulk_price')
    `) as Pick<AppSettingRow, "key" | "value">[];
    let singlePrice = base.singlePrice;
    let bulkPrice = base.bulkPrice;
    for (const row of rows) {
      if (row.key === "single_price" && row.value) {
        singlePrice = parseLivePrice(row.value, singlePrice);
      } else if (row.key === "bulk_price" && row.value) {
        bulkPrice = parseLivePrice(row.value, bulkPrice);
      }
    }
    return { ...base, singlePrice, bulkPrice };
  } catch {
    return base;
  }
}

export async function getWebhookSecretToken(): Promise<string> {
  const explicit = (process.env["TELEGRAM_WEBHOOK_SECRET"] ?? "").trim();
  if (explicit.length >= 16) return explicit.slice(0, 128);
  const cfg = getBotConfig();
  const salt = (process.env["ACCESS_SESSION_SECRET"] ?? "zimbola-webhook").trim();
  const hash = await sha256Hex(`tg-webhook:v1:${cfg.botToken}:${salt}`);
  return hash.slice(0, 48);
}

function isAdminUser(userId: string | number, cfg: BotConfig): boolean {
  return cfg.adminIds.has(String(userId));
}

// ============================================================================
// Formatting & Telegram Bot API 9.4+ Helpers (Colored Buttons + Copy + Articles)
// ============================================================================
type ButtonStyle = "primary" | "danger";

type InlineButton = {
  text: string;
  style?: ButtonStyle;
  callback_data?: string;
  url?: string;
  copy_text?: { text: string };
};

type InlineKeyboard = { inline_keyboard: InlineButton[][] };

const btnBlue = (text: string, callback_data: string): InlineButton => ({
  text,
  callback_data,
  style: "primary",
});

const btnRed = (text: string, callback_data: string): InlineButton => ({
  text,
  callback_data,
  style: "danger",
});

const btnCopyBlue = (text: string, copyValue: string): InlineButton => ({
  text,
  copy_text: { text: copyValue.slice(0, 256) },
  style: "primary",
});

const btnNeutral = (text: string, callback_data: string): InlineButton => ({
  text,
  callback_data,
});

const btnUrl = (text: string, url: string, style?: ButtonStyle): InlineButton => ({
  text,
  url,
  ...(style ? { style } : {}),
});

type TgUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
};

type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
};

type TgCallbackQuery = {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
};

function esc(val: unknown): string {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmtInr(amount: number): string {
  const n = Number(amount) || 0;
  if (Math.abs(n - Math.round(n)) < 0.001) {
    return `₹${Math.round(n).toLocaleString("en-IN")}`;
  }
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(isoOrDate: string | Date | null | undefined): string {
  if (!isoOrDate) return "—";
  const d = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

function savePct(cfg: BotConfig): number {
  if (cfg.singlePrice <= 0) return 0;
  return Math.max(0, Math.round((1 - cfg.bulkPrice / cfg.singlePrice) * 100));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tgApi<T = unknown>(
  botToken: string,
  method: string,
  body?: Record<string, unknown> | FormData,
): Promise<{
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}> {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  const isForm = body instanceof FormData;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: isForm ? undefined : { "content-type": "application/json" },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
      signal: controller.signal,
    });
    const data = (await resp
      .json()
      .catch(() => ({ ok: false, description: `HTTP ${resp.status}` }))) as {
      ok: boolean;
      result?: T;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    return data;
  } catch (err) {
    return {
      ok: false,
      description: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function getBotUsername(botToken: string): Promise<string> {
  if (cachedBotUsername) return cachedBotUsername;
  const res = await tgApi<{ username?: string }>(botToken, "getMe");
  if (res.ok && res.result?.username) {
    cachedBotUsername = res.result.username;
    return cachedBotUsername;
  }
  return "";
}

async function sendText(
  botToken: string,
  chatId: number | string,
  text: string,
  replyMarkup?: InlineKeyboard,
): Promise<TgMessage | null> {
  const res = await tgApi<TgMessage>(botToken, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  return res.ok ? (res.result ?? null) : null;
}

async function editOrSend(
  botToken: string,
  chatId: number | string,
  messageId: number | undefined,
  text: string,
  replyMarkup?: InlineKeyboard,
): Promise<void> {
  if (messageId) {
    const res = await tgApi(botToken, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    if (res.ok || (res.description ?? "").toLowerCase().includes("message is not modified")) {
      return;
    }
  }
  await sendText(botToken, chatId, text, replyMarkup);
}

async function deleteMsg(
  botToken: string,
  chatId: number | string | null | undefined,
  msgId: number | string | null | undefined,
): Promise<void> {
  if (!chatId || !msgId) return;
  await tgApi(botToken, "deleteMessage", { chat_id: chatId, message_id: Number(msgId) }).catch(
    () => {},
  );
}

async function answerCb(
  botToken: string,
  callbackQueryId: string,
  text?: string,
  showAlert = false,
): Promise<void> {
  await tgApi(botToken, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
    ...(showAlert ? { show_alert: true } : {}),
  }).catch(() => {});
}

async function sendPhotoBuffer(
  botToken: string,
  chatId: number | string,
  pngBytes: Uint8Array,
  filename: string,
  caption: string,
  replyMarkup?: InlineKeyboard,
): Promise<TgMessage | null> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  if (replyMarkup) {
    form.append("reply_markup", JSON.stringify(replyMarkup));
  }
  const ab = pngBytes.buffer.slice(
    pngBytes.byteOffset,
    pngBytes.byteOffset + pngBytes.byteLength,
  ) as ArrayBuffer;
  form.append("photo", new Blob([ab], { type: "image/png" }), filename);
  const res = await tgApi<TgMessage>(botToken, "sendPhoto", form);
  return res.ok ? (res.result ?? null) : null;
}

async function sendDocumentText(
  botToken: string,
  chatId: number | string,
  content: string,
  filename: string,
  caption: string,
): Promise<TgMessage | null> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("document", new Blob([content], { type: "text/plain;charset=utf-8" }), filename);
  const res = await tgApi<TgMessage>(botToken, "sendDocument", form);
  return res.ok ? (res.result ?? null) : null;
}

async function getSupportUrl(
  sql: NeonQueryFunction<false, false>,
  cfg: BotConfig,
): Promise<string> {
  try {
    const rows = (await sql`
      SELECT value FROM public.app_settings WHERE key = 'telegram_support_url' LIMIT 1
    `) as Pick<AppSettingRow, "value">[];
    if (rows[0]?.value) {
      return normalizeBotUrl(rows[0].value, "");
    }
  } catch {
    // Fallback to env
  }
  return cfg.supportUrlEnv ? normalizeBotUrl(cfg.supportUrlEnv, "") : "";
}

// ============================================================================
// Cashfree Gateway Helpers (see ./cashfree.ts)
// ============================================================================
function isCashfreeConfigured(cfg: BotConfig): boolean {
  return Boolean(cfg.cashfreeAppId && cfg.cashfreeSecretKey);
}

// ============================================================================
// Neon DB Helpers for Bot Users, Seller Links & Orders
// ============================================================================
type BotUserRow = {
  user_id: string;
  username: string | null;
  first_name: string | null;
  ref_code: string | null;
  pending_state: string | null;
  state_data: Record<string, unknown> | null;
  is_blocked: boolean;
  first_seen: string;
  last_seen: string;
};

type BotOrderRow = {
  order_id: string;
  user_id: string;
  username: string | null;
  quantity: number;
  unit_price: string;
  amount: string;
  order_type: string;
  ref_code: string | null;
  status: string;
  txn_id: string | null;
  delivered_keys: string[] | null;
  created_at: string;
  paid_at: string | null;
  qr_chat_id: string | null;
  qr_msg_id: string | null;
  payment_session_id?: string | null;
};

function newOrderId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    String(now.getUTCFullYear()).slice(-2) +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds());
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `OD${stamp}${rand}`;
}

function generateSellerCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = webcrypto.getRandomValues(new Uint8Array(6));
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += alphabet[(bytes[i] ?? 0) & 31];
  }
  return out;
}

function parseOrderKeys(order: BotOrderRow): string[] {
  if (!order.delivered_keys) return [];
  if (Array.isArray(order.delivered_keys)) return order.delivered_keys.map(String);
  return [];
}

async function upsertBotUser(
  sql: NeonQueryFunction<false, false>,
  user: TgUser,
  refCode?: string | null,
): Promise<BotUserRow> {
  const uid = String(user.id);
  const uname = user.username ?? null;
  const fname = user.first_name ?? null;

  let validRef: string | null = null;
  if (refCode) {
    const linkRows = (await sql`
      SELECT code FROM public.bot_seller_links
      WHERE UPPER(code) = UPPER(${refCode.trim()}) AND is_active = true
      LIMIT 1
    `) as { code: string }[];
    validRef = linkRows[0]?.code ?? null;
  }

  const existingRows = (await sql`
    SELECT * FROM public.bot_users WHERE user_id = ${uid}::bigint LIMIT 1
  `) as BotUserRow[];
  const existing = existingRows[0];

  if (!existing) {
    const inserted = (await sql`
      INSERT INTO public.bot_users (user_id, username, first_name, ref_code, is_blocked)
      VALUES (${uid}::bigint, ${uname}, ${fname}, ${validRef}, false)
      RETURNING *
    `) as BotUserRow[];
    return inserted[0]!;
  }

  let nextRef = existing.ref_code;
  if (validRef && !nextRef) {
    nextRef = validRef;
  } else if (validRef && nextRef !== validRef) {
    const paidRows = (await sql`
      SELECT 1 AS ok FROM public.bot_orders
      WHERE user_id = ${uid}::bigint AND status = 'paid'
      LIMIT 1
    `) as { ok: number }[];
    if (paidRows.length === 0) {
      nextRef = validRef;
    }
  }

  const updated = (await sql`
    UPDATE public.bot_users
    SET
      username = ${uname},
      first_name = ${fname},
      ref_code = ${nextRef},
      is_blocked = false,
      last_seen = now()
    WHERE user_id = ${uid}::bigint
    RETURNING *
  `) as BotUserRow[];
  return updated[0]!;
}

async function setBotUserState(
  sql: NeonQueryFunction<false, false>,
  userId: number | string,
  state: string | null,
  stateData: Record<string, unknown> | null = null,
): Promise<void> {
  const jsonStr = stateData ? JSON.stringify(stateData) : null;
  await sql`
    UPDATE public.bot_users
    SET pending_state = ${state}, state_data = ${jsonStr}::jsonb
    WHERE user_id = ${String(userId)}::bigint
  `;
}

async function getGlobalStats(sql: NeonQueryFunction<false, false>) {
  const uRows = (await sql`
    SELECT
      COUNT(*)::int AS total_users,
      COUNT(*) FILTER (WHERE is_blocked = true)::int AS blocked_users
    FROM public.bot_users
  `) as { total_users: number; blocked_users: number }[];

  const lRows = (await sql`
    SELECT COUNT(*)::int AS active_links
    FROM public.bot_seller_links
    WHERE is_active = true
  `) as { active_links: number }[];

  const oRows = (await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_orders,
      COUNT(DISTINCT user_id) FILTER (WHERE status = 'paid')::int AS total_buyers,
      COUNT(*) FILTER (WHERE status = 'paid' AND order_type = 'single')::int AS single_orders,
      COUNT(*) FILTER (WHERE status = 'paid' AND order_type = 'bulk')::int AS bulk_orders,
      COALESCE(SUM(quantity) FILTER (WHERE status = 'paid'), 0)::int AS total_keys,
      COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)::float8 AS total_revenue,
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_orders,
      COUNT(*) FILTER (WHERE status = 'delivery_failed')::int AS failed_deliveries,
      COUNT(*) FILTER (WHERE status = 'paid' AND paid_at >= now() - interval '24 hours')::int AS orders_24h,
      COALESCE(SUM(quantity) FILTER (WHERE status = 'paid' AND paid_at >= now() - interval '24 hours'), 0)::int AS keys_24h,
      COALESCE(SUM(amount) FILTER (WHERE status = 'paid' AND paid_at >= now() - interval '24 hours'), 0)::float8 AS revenue_24h
    FROM public.bot_orders
  `) as {
    paid_orders: number;
    total_buyers: number;
    single_orders: number;
    bulk_orders: number;
    total_keys: number;
    total_revenue: number;
    pending_orders: number;
    failed_deliveries: number;
    orders_24h: number;
    keys_24h: number;
    revenue_24h: number;
  }[];

  const u = uRows[0] ?? { total_users: 0, blocked_users: 0 };
  const l = lRows[0] ?? { active_links: 0 };
  const o = oRows[0] ?? {
    paid_orders: 0,
    total_buyers: 0,
    single_orders: 0,
    bulk_orders: 0,
    total_keys: 0,
    total_revenue: 0,
    pending_orders: 0,
    failed_deliveries: 0,
    orders_24h: 0,
    keys_24h: 0,
    revenue_24h: 0,
  };

  return { ...u, ...l, ...o };
}

type SellerLinkStat = {
  code: string;
  name: string;
  created_at: string;
  total_users: number;
  total_buyers: number;
  paid_orders: number;
  single_orders: number;
  bulk_orders: number;
  total_keys: number;
  total_revenue: number;
};

async function listSellerLinksWithStats(
  sql: NeonQueryFunction<false, false>,
): Promise<SellerLinkStat[]> {
  const rows = (await sql`
    SELECT
      l.code,
      l.name,
      l.created_at,
      COALESCE(u.total_users, 0)::int AS total_users,
      COALESCE(o.total_buyers, 0)::int AS total_buyers,
      COALESCE(o.paid_orders, 0)::int AS paid_orders,
      COALESCE(o.single_orders, 0)::int AS single_orders,
      COALESCE(o.bulk_orders, 0)::int AS bulk_orders,
      COALESCE(o.total_keys, 0)::int AS total_keys,
      COALESCE(o.total_revenue, 0)::float8 AS total_revenue
    FROM public.bot_seller_links l
    LEFT JOIN (
      SELECT ref_code, COUNT(*)::int AS total_users
      FROM public.bot_users
      WHERE ref_code IS NOT NULL
      GROUP BY ref_code
    ) u ON u.ref_code = l.code
    LEFT JOIN (
      SELECT
        ref_code,
        COUNT(*)::int AS paid_orders,
        COUNT(DISTINCT user_id)::int AS total_buyers,
        COUNT(*) FILTER (WHERE order_type = 'single')::int AS single_orders,
        COUNT(*) FILTER (WHERE order_type = 'bulk')::int AS bulk_orders,
        COALESCE(SUM(quantity), 0)::int AS total_keys,
        COALESCE(SUM(amount), 0)::float8 AS total_revenue
      FROM public.bot_orders
      WHERE status = 'paid' AND ref_code IS NOT NULL
      GROUP BY ref_code
    ) o ON o.ref_code = l.code
    WHERE l.is_active = true
    ORDER BY l.created_at DESC
  `) as SellerLinkStat[];
  return rows;
}

async function getSellerLinkStats(
  sql: NeonQueryFunction<false, false>,
  code: string,
): Promise<SellerLinkStat | null> {
  const rows = (await sql`
    SELECT
      l.code,
      l.name,
      l.created_at,
      (SELECT COUNT(*)::int FROM public.bot_users WHERE ref_code = l.code) AS total_users,
      COALESCE(o.total_buyers, 0)::int AS total_buyers,
      COALESCE(o.paid_orders, 0)::int AS paid_orders,
      COALESCE(o.single_orders, 0)::int AS single_orders,
      COALESCE(o.bulk_orders, 0)::int AS bulk_orders,
      COALESCE(o.total_keys, 0)::int AS total_keys,
      COALESCE(o.total_revenue, 0)::float8 AS total_revenue
    FROM public.bot_seller_links l
    LEFT JOIN (
      SELECT
        ref_code,
        COUNT(*)::int AS paid_orders,
        COUNT(DISTINCT user_id)::int AS total_buyers,
        COUNT(*) FILTER (WHERE order_type = 'single')::int AS single_orders,
        COUNT(*) FILTER (WHERE order_type = 'bulk')::int AS bulk_orders,
        COALESCE(SUM(quantity), 0)::int AS total_keys,
        COALESCE(SUM(amount), 0)::float8 AS total_revenue
      FROM public.bot_orders
      WHERE status = 'paid' AND ref_code = ${code}
      GROUP BY ref_code
    ) o ON o.ref_code = l.code
    WHERE l.code = ${code}
    LIMIT 1
  `) as SellerLinkStat[];
  return rows[0] ?? null;
}

// ============================================================================
// Direct Neon Access Key Generation (shares public.access_keys directly!)
// ============================================================================
async function generateDirectNeonKeys(
  sql: NeonQueryFunction<false, false>,
  quantity: number,
  label: string,
  days: number,
  existingKeys: string[] = [],
): Promise<string[]> {
  const keys = [...existingKeys];
  const remaining = Math.max(0, quantity - keys.length);
  const expiresAt =
    days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null;

  for (let i = 0; i < remaining; i += 1) {
    const idx = keys.length + 1;
    const itemLabel = (quantity > 1 ? `${label} #${idx}` : label).slice(0, 80);

    let createdKey = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generateRandomLicenseKey();
      const keyHash = await sha256Hex(candidate);
      const keyEnc = await encryptKeyForStorage(candidate);
      try {
        await sql`
          INSERT INTO public.access_keys (key_hash, key_enc, key_plain, key_label, is_custom, expires_at)
          VALUES (${keyHash}, ${keyEnc}, NULL, ${itemLabel}, false, ${expiresAt}::timestamptz)
        `;
        createdKey = candidate;
        break;
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === "23505") continue;
        throw err;
      }
    }

    if (!createdKey) {
      throw new Error("Could not generate unique access key");
    }
    keys.push(createdKey);
  }

  await logAuditEvent(sql, {
    eventType: "bot_key_generated",
    actor: "bot",
    severity: "info",
    summary: `Bot sold & generated ${quantity} key${quantity > 1 ? "s" : ""} (${label})`,
  });

  return keys;
}

// ============================================================================
// UI Builders (Blue & Red Button Styles + Single Buy Menu + Telegram Article Blocks)
// ============================================================================
function mainMenuKb(userId: number | string, cfg: BotConfig, supportUrl: string): InlineKeyboard {
  const rows: InlineButton[][] = [
    [btnBlue(`🛒 Buy Keys`, "menu:buy")],
    [btnNeutral("🔑 My Orders", "menu:orders"), btnNeutral("📖 Guide & FAQ", "menu:guide")],
  ];

  if (supportUrl) {
    rows.push([btnUrl("💬 Contact Support", supportUrl)]);
  }

  if (isAdminUser(userId, cfg)) {
    rows.push([btnBlue("👑 Admin Control Panel", "adm:home")]);
  }

  return { inline_keyboard: rows };
}

function welcomeText(firstName: string | null | undefined, cfg: BotConfig): string {
  const validity = cfg.keyDays === 0 ? "Lifetime Access" : `${cfg.keyDays}-Day Validity`;
  return (
    `💎 <b>${esc(cfg.shopName).toUpperCase()}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `👋 Welcome, <b>${esc(firstName || "Member")}</b>!\n` +
    `Automated 24/7 store for instant, verified access keys.\n\n` +
    `<blockquote>` +
    `⚡ <b>Single Key:</b> ${fmtInr(cfg.singlePrice)} / device\n` +
    `💎 <b>Bulk Keys:</b> ${fmtInr(cfg.bulkPrice)} / key <i>(Min ${cfg.bulkMin} · Save ${savePct(cfg)}%)</i>\n` +
    `🛡️ <b>Validity:</b> ${validity}\n` +
    `🚀 <b>Delivery:</b> Instant after UPI payment` +
    `</blockquote>\n\n` +
    `<blockquote expandable>` +
    `📖 <b>HOW IT WORKS (TAP TO EXPAND)</b>\n` +
    `1. Tap <b>🛒 Buy Keys</b> and pick <b>Single Key</b> or <b>Bulk Keys</b>.\n` +
    `2. Scan the UPI QR with PhonePe, GPay, Paytm, or any UPI app.\n` +
    `3. Pay the exact amount and tap <b>Check Payment Status</b>.\n` +
    `4. Your unique access key is generated and delivered immediately.` +
    `</blockquote>\n\n` +
    `👇 Tap <b>Buy Keys</b> below to get started:`
  );
}

function buyChoiceUi(cfg: BotConfig): { text: string; kb: InlineKeyboard } {
  const validity = cfg.keyDays === 0 ? "Lifetime" : `${cfg.keyDays} Days`;
  const text =
    `🛒 <b>BUY ACCESS KEYS</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Choose the package that fits your needs:\n\n` +
    `<blockquote>` +
    `⚡ <b>Single Key — ${fmtInr(cfg.singlePrice)}</b>\n` +
    `• Ideal for personal use on 1 device\n` +
    `• Instant key delivery · ${validity}\n\n` +
    `💎 <b>Bulk Keys — ${fmtInr(cfg.bulkPrice)} / key</b> <i>(Save ${savePct(cfg)}%)</i>\n` +
    `• Minimum ${cfg.bulkMin} keys · Best for resellers &amp; teams\n` +
    `• Delivered as copyable list + <code>.txt</code> file` +
    `</blockquote>\n\n` +
    `<blockquote expandable>` +
    `🛡️ <b>GUARANTEE &amp; DELIVERY DETAILS</b>\n` +
    `• Every key is freshly generated right after payment.\n` +
    `• Each key binds securely to the first device that signs in.\n` +
    `• All past orders remain saved under <b>🔑 My Orders</b>.` +
    `</blockquote>`;

  // Exactly 3 options: Single Key (Blue), Bulk Keys (Blue), Cancel / Back (Red)
  const kb: InlineKeyboard = {
    inline_keyboard: [
      [btnBlue(`⚡ Single Key — ${fmtInr(cfg.singlePrice)}`, "buy:1")],
      [btnBlue(`💎 Bulk Keys — ${fmtInr(cfg.bulkPrice)}/key (Save ${savePct(cfg)}%)`, "menu:bulk")],
      [btnRed("❌ Back", "menu:home")],
    ],
  };
  return { text, kb };
}

function bulkMenuUi(cfg: BotConfig): { text: string; kb: InlineKeyboard } {
  const text =
    `💎 <b>BULK RESELLER PACKAGES</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🔥 <b>Bulk Rate:</b> <s>${fmtInr(cfg.singlePrice)}</s> → <b>${fmtInr(cfg.bulkPrice)} / key</b>\n` +
    `💰 <b>Instant Savings:</b> <b>${savePct(cfg)}% OFF</b> every key\n` +
    `📦 <b>Minimum Order:</b> ${cfg.bulkMin} keys\n\n` +
    `<blockquote expandable>` +
    `📄 <b>WHAT YOU RECEIVE</b>\n` +
    `• Freshly generated unique keys (never reused).\n` +
    `• Clean numbered list right inside Telegram.\n` +
    `• Ready-to-share <code>Bulk_Keys.txt</code> file attached automatically.` +
    `</blockquote>\n\n` +
    `👇 Select a pack or enter a custom quantity:`;

  const rows: InlineButton[][] = [];
  let row: InlineButton[] = [];
  for (const qty of BULK_PRESETS) {
    if (qty < cfg.bulkMin || qty > cfg.bulkMax) continue;
    row.push(btnBlue(`📦 ${qty} Keys · ${fmtInr(qty * cfg.bulkPrice)}`, `buy:${qty}`));
    if (row.length === 2) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0) rows.push(row);

  rows.push([btnBlue("✏️ Enter Custom Quantity", "menu:bulk_custom")]);
  rows.push([btnRed("❌ Back", "menu:buy")]);
  return { text, kb: { inline_keyboard: rows } };
}

function guideArticleUi(cfg: BotConfig, supportUrl: string): { text: string; kb: InlineKeyboard } {
  const validity = cfg.keyDays === 0 ? "Lifetime Access" : `${cfg.keyDays} Days`;
  const text =
    `📖 <b>QUICK GUIDE &amp; FAQ</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>1. How to Purchase</b>\n` +
    `<blockquote>` +
    `Tap <b>🛒 Buy Keys</b> → pick <b>Single Key</b> or <b>Bulk Keys</b> → scan the UPI QR with any UPI app and pay the exact amount → tap <b>Check Payment Status</b>.` +
    `</blockquote>\n\n` +
    `<blockquote expandable>` +
    `<b>2. How to Activate Your Key</b>\n` +
    `• Tap the blue <b>📋 Copy Access Key</b> button on your delivery card.\n` +
    `• Paste the key on the sign-in screen and tap Unlock.\n` +
    `• Your key automatically stays remembered on that device (${validity}).` +
    `</blockquote>\n\n` +
    `<blockquote expandable>` +
    `<b>3. Device Binding &amp; Security</b>\n` +
    `• 1 key works on 1 device only.\n` +
    `• If you log out yourself, you can sign back in on the same device.\n` +
    `• Sharing a key with another device will automatically block access.` +
    `</blockquote>\n\n` +
    `<blockquote expandable>` +
    `<b>4. Payment Troubleshooting</b>\n` +
    `• Always pay the <b>exact amount</b> shown on the QR card.\n` +
    `• Wait 10–15 seconds after payment before tapping <b>Check Payment Status</b>.\n` +
    `• If money was deducted after expiry, send your <code>Order ID</code> to Support.` +
    `</blockquote>`;

  const rows: InlineButton[][] = [[btnBlue("🛒 Buy Keys Now", "menu:buy")]];
  if (supportUrl) {
    rows.push([btnUrl("💬 Contact Support", supportUrl)]);
  }
  rows.push([btnRed("❌ Back", "menu:home")]);
  return { text, kb: { inline_keyboard: rows } };
}

async function adminHomeUi(
  sql: NeonQueryFunction<false, false>,
): Promise<{ text: string; kb: InlineKeyboard }> {
  const st = await getGlobalStats(sql);
  const text =
    `👑 <b>ADMIN COMMAND CENTER</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<blockquote>` +
    `👥 <b>Total Users:</b> ${st.total_users.toLocaleString("en-IN")}\n` +
    `🛍️ <b>Total Buyers:</b> ${st.total_buyers.toLocaleString("en-IN")}\n` +
    `🔑 <b>Keys Sold:</b> ${st.total_keys.toLocaleString("en-IN")}\n` +
    `💰 <b>Total Revenue:</b> ${fmtInr(st.total_revenue)}\n` +
    `📈 <b>Last 24h:</b> ${st.orders_24h} orders · ${fmtInr(st.revenue_24h)}\n` +
    `⏳ <b>Pending Orders:</b> ${st.pending_orders}` +
    `</blockquote>\n\n` +
    `Select a module below:`;

  const kb: InlineKeyboard = {
    inline_keyboard: [
      [btnBlue("📊 Detailed Stats", "adm:stats"), btnBlue("📢 Broadcast", "adm:bc")],
      [btnBlue("🔗 Seller Links & Team", "adm:links"), btnBlue("🧾 Orders", "adm:orders:all")],
      [btnBlue("💰 Update Prices", "adm:pricing"), btnNeutral("⚙️ System Health", "adm:health")],
      [btnNeutral("🔄 Refresh", "adm:home")],
      [btnRed("❌ Back to Store Menu", "menu:home")],
    ],
  };
  return { text, kb };
}

// ============================================================================
// Checkout & Order Delivery Engine
// ============================================================================
function parseStartArg(rawArg: string, cfg: BotConfig): { refCode: string | null; intent: string } {
  const arg = rawArg.trim();
  if (!arg) return { refCode: null, intent: "menu" };

  const low = arg.toLowerCase();
  if (low === "buy_1") return { refCode: null, intent: "buy_1" };

  const mBulk = /^bulk_(\d+)$/i.exec(low);
  if (mBulk?.[1]) {
    const qty = Math.max(cfg.bulkMin, Math.min(cfg.bulkMax, Number(mBulk[1])));
    return { refCode: null, intent: `bulk_${qty}` };
  }

  const mRefBuy = /^ref_([a-z0-9]+)_buy_1$/i.exec(arg);
  if (mRefBuy?.[1]) {
    return { refCode: mRefBuy[1].toUpperCase(), intent: "buy_1" };
  }

  const mRefBulk = /^ref_([a-z0-9]+)_bulk_(\d+)$/i.exec(arg);
  if (mRefBulk?.[1] && mRefBulk[2]) {
    const qty = Math.max(cfg.bulkMin, Math.min(cfg.bulkMax, Number(mRefBulk[2])));
    return { refCode: mRefBulk[1].toUpperCase(), intent: `bulk_${qty}` };
  }

  const mRef = /^ref_([a-z0-9]+)$/i.exec(arg);
  if (mRef?.[1]) {
    return { refCode: mRef[1].toUpperCase(), intent: "menu" };
  }

  return { refCode: null, intent: "menu" };
}

async function sendPaymentQr(
  sql: NeonQueryFunction<false, false>,
  cfg: BotConfig,
  user: TgUser,
  requestedQty: number,
): Promise<void> {
  if (!isCashfreeConfigured(cfg)) {
    await sendText(
      cfg.botToken,
      user.id,
      "⚠️ Payment gateway is not configured yet. Please contact the administrator.",
    );
    return;
  }

  let qty = Math.max(1, Math.min(cfg.bulkMax, Math.floor(requestedQty)));
  const isBulk = qty > 1;
  if (isBulk && qty < cfg.bulkMin) qty = cfg.bulkMin;

  const unitPrice = isBulk ? cfg.bulkPrice : cfg.singlePrice;
  const amount = Math.round(unitPrice * qty * 100) / 100;
  const orderType = isBulk ? "bulk" : "single";

  const oldOrders = (await sql`
    UPDATE public.bot_orders
    SET status = 'cancelled'
    WHERE user_id = ${String(user.id)}::bigint AND status = 'pending'
    RETURNING qr_chat_id, qr_msg_id
  `) as { qr_chat_id: string | null; qr_msg_id: string | null }[];

  for (const old of oldOrders) {
    await deleteMsg(cfg.botToken, old.qr_chat_id, old.qr_msg_id);
  }

  const userRows = (await sql`
    SELECT ref_code FROM public.bot_users WHERE user_id = ${String(user.id)}::bigint LIMIT 1
  `) as { ref_code: string | null }[];
  const refCode = userRows[0]?.ref_code ?? null;

  const orderId = newOrderId();

  // Instant visual feedback while Cashfree order + official signed UPI QR is fetched (3-5s)
  const loadingMsg = await sendText(
    cfg.botToken,
    user.id,
    `⏳ <b>Generating official UPI QR for ${fmtInr(amount)}...</b>\n<i>Please wait 3–5 seconds.</i>`,
  );

  const cfRes = await createCashfreeOrderAndQr(toCashfreeConfig(cfg), {
    orderId,
    amount,
    customerId: `tg_${user.id}`,
    customerName: user.first_name || user.username || `User ${user.id}`,
    orderNote: `${cfg.shopName} - ${qty}x ${cfg.productName}`,
  });

  if (loadingMsg) {
    await deleteMsg(cfg.botToken, loadingMsg.chat.id, loadingMsg.message_id);
  }

  if (!cfRes.ok || !cfRes.paymentSessionId) {
    console.error("[bot] Cashfree order creation failed:", orderId, cfRes.error);
    await sendText(
      cfg.botToken,
      user.id,
      `⚠️ Could not generate payment QR right now. Please try again in a few seconds.\n<i>Ref: ${esc(cfRes.error || "Gateway Error")}</i>`,
    );
    return;
  }

  let titleLine: string;
  let priceBlock: string;
  if (isBulk) {
    const savings = Math.round((cfg.singlePrice - cfg.bulkPrice) * qty * 100) / 100;
    titleLine = `💎 <b>BULK ORDER CHECKOUT (${qty} KEYS)</b>`;
    priceBlock =
      `📦 <b>Package:</b> ${qty} × ${esc(cfg.productName)}\n` +
      `🏷️ <b>Rate:</b> ${fmtInr(unitPrice)} / key <i>(Save ${fmtInr(savings)})</i>\n` +
      `💳 <b>Total Payable:</b> <b>${fmtInr(amount)}</b>`;
  } else {
    titleLine = `⚡ <b>INSTANT KEY CHECKOUT</b>`;
    priceBlock =
      `📦 <b>Product:</b> 1 × ${esc(cfg.productName)}\n` +
      `💳 <b>Amount Payable:</b> <b>${fmtInr(amount)}</b>`;
  }

  const caption =
    `${titleLine}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🧾 <b>Order ID:</b> <code>${orderId}</code>\n` +
    `${priceBlock}\n` +
    `⏳ <b>Valid For:</b> ${cfg.orderTimeoutMin} minutes\n\n` +
    `<blockquote expandable>` +
    `📲 <b>PAYMENT INSTRUCTIONS (TAP TO EXPAND)</b>\n` +
    `1. Scan this official UPI QR with PhonePe, GPay, Paytm, or any UPI app.\n` +
    `2. Amount <b>${fmtInr(amount)}</b> &amp; Order ID auto-fill automatically.\n` +
    `3. Key delivers automatically in seconds — or tap <b>🔄 Check Payment Status</b> below.` +
    `</blockquote>`;

  const qrKb: InlineKeyboard = {
    inline_keyboard: [
      [btnBlue("🔄 Check Payment Status", `chk:${orderId}`)],
      [btnRed("❌ Cancel Order", `cancel:${orderId}`)],
    ],
  };

  let sent: TgMessage | null = cfRes.qrPng
    ? await sendPhotoBuffer(cfg.botToken, user.id, cfRes.qrPng, `QR_${orderId}.png`, caption, qrKb)
    : null;

  // Graceful fallback only if QR PNG capture failed (so buyer is never stuck)
  if (!sent) {
    console.warn("[bot] Direct QR photo unavailable for", orderId, "method=", cfRes.method, "err=", cfRes.error);
    const fallbackRows: InlineButton[][] = [];
    if (cfRes.checkoutUrl) {
      fallbackRows.push([btnUrl(`💳 Open UPI QR (${fmtInr(amount)})`, cfRes.checkoutUrl, "primary")]);
    }
    fallbackRows.push([btnBlue("🔄 Check Payment Status", `chk:${orderId}`)]);
    fallbackRows.push([btnRed("❌ Cancel Order", `cancel:${orderId}`)]);

    const fallbackNote = cfRes.checkoutUrl
      ? `\n\n⚠️ Direct QR photo took too long to load. Tap <b>Open UPI QR</b> above to scan &amp; pay, then return here for automatic delivery.`
      : `\n\n⚠️ Could not load QR image. Please tap Cancel and try again.`;

    sent = await sendText(
      cfg.botToken,
      user.id,
      `${caption}${fallbackNote}`,
      { inline_keyboard: fallbackRows },
    );
  }

  await sql`
    INSERT INTO public.bot_orders (
      order_id, user_id, username, quantity, unit_price, amount,
      order_type, ref_code, status, qr_chat_id, qr_msg_id, payment_session_id
    )
    VALUES (
      ${orderId},
      ${String(user.id)}::bigint,
      ${user.username ?? null},
      ${qty},
      ${unitPrice},
      ${amount},
      ${orderType},
      ${refCode},
      'pending',
      ${sent ? String(sent.chat.id) : null}::bigint,
      ${sent ? String(sent.message_id) : null}::bigint,
      ${cfRes.paymentSessionId}
    )
  `;
}

async function deliverOrder(
  sql: NeonQueryFunction<false, false>,
  cfg: BotConfig,
  order: BotOrderRow,
  txnId: string | null,
  verifiedBy: string,
  retryMode = false,
): Promise<boolean> {
  const orderId = order.order_id;

  if (!retryMode) {
    try {
      const claimed = (await sql`
        UPDATE public.bot_orders
        SET
          status = 'generating',
          txn_id = COALESCE(${txnId}, txn_id),
          paid_at = COALESCE(paid_at, now())
        WHERE order_id = ${orderId} AND status = 'pending'
        RETURNING order_id
      `) as { order_id: string }[];
      if (claimed.length === 0) return false;
    } catch {
      return false;
    }
  }

  await deleteMsg(cfg.botToken, order.qr_chat_id, order.qr_msg_id);

  const qty = Number(order.quantity) || 1;
  const amount = Number(order.amount) || 0;
  const userId = order.user_id;
  const buyerTag = order.username ? `@${order.username}` : `ID:${userId}`;

  let sellerName: string | null = null;
  if (order.ref_code) {
    const lkRows = (await sql`
      SELECT name FROM public.bot_seller_links WHERE code = ${order.ref_code} LIMIT 1
    `) as { name: string }[];
    sellerName = lkRows[0]?.name ?? null;
  }

  const keyLabel = sellerName ? `${sellerName} | ${buyerTag}` : `Bot ${buyerTag}`;
  const existingKeys = retryMode ? parseOrderKeys(order) : [];

  let keys: string[] = [];
  try {
    keys = await generateDirectNeonKeys(sql, qty, keyLabel, cfg.keyDays, existingKeys);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await sql`
      UPDATE public.bot_orders
      SET status = 'delivery_failed', delivered_keys = ${JSON.stringify(existingKeys)}::jsonb
      WHERE order_id = ${orderId}
    `;
    await sendText(
      cfg.botToken,
      userId,
      `✅ <b>Payment Received!</b>\n\n` +
        `🧾 Order: <code>${orderId}</code>\n` +
        `⚠️ Temporary key generation issue. Admin has been notified and will deliver your key shortly.`,
    );
    for (const adminId of cfg.adminIds) {
      await sendText(
        cfg.botToken,
        adminId,
        `🚨 <b>KEY GENERATION FAILED (PAID ORDER)</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `🧾 Order: <code>${orderId}</code>\n` +
          `👤 Buyer: <code>${userId}</code> (${esc(buyerTag)})\n` +
          `💰 Paid: <b>${fmtInr(amount)}</b>\n` +
          `❌ Error: <code>${esc(errMsg)}</code>`,
        {
          inline_keyboard: [[btnBlue("🔁 Retry Key Delivery", `adm:retry:${orderId}`)]],
        },
      );
    }
    return false;
  }

  await sql`
    UPDATE public.bot_orders
    SET
      status = 'paid',
      delivered_keys = ${JSON.stringify(keys)}::jsonb,
      paid_at = COALESCE(paid_at, now())
    WHERE order_id = ${orderId}
  `;

  if (qty === 1) {
    const singleKey = keys[0] ?? "";
    const singleKb: InlineKeyboard = {
      inline_keyboard: [
        [btnCopyBlue("📋 Copy Access Key", singleKey)],
        [btnBlue("🛒 Buy More Keys", "menu:buy"), btnNeutral("🏠 Main Menu", "menu:home")],
      ],
    };

    await sendText(
      cfg.botToken,
      userId,
      `🎉 <b>PAYMENT CONFIRMED!</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🧾 <b>Order ID:</b> <code>${orderId}</code>\n` +
        `💰 <b>Paid:</b> ${fmtInr(amount)}\n` +
        `📦 <b>Product:</b> ${esc(cfg.productName)}\n\n` +
        `🔑 <b>Your Access Key:</b>\n` +
        `<blockquote><code>${esc(singleKey)}</code></blockquote>\n\n` +
        `<blockquote expandable>` +
        `🛡️ <b>ACTIVATION NOTES</b>\n` +
        `• Tap <b>📋 Copy Access Key</b> below to copy in one tap.\n` +
        `• Valid for 1 device only — keep your key private.\n` +
        `• Access your past keys anytime under <b>🔑 My Orders</b>.` +
        `</blockquote>`,
      singleKb,
    );
  } else {
    let preview = "";
    if (qty <= 30) {
      const numbered = keys.map((k, idx) => `${idx + 1}. <code>${esc(k)}</code>`).join("\n");
      preview =
        `\n\n<blockquote expandable>` +
        `🔑 <b>YOUR ${qty} BULK KEYS (TAP TO EXPAND)</b>\n` +
        `${numbered}` +
        `</blockquote>`;
    }

    const bulkKb: InlineKeyboard = {
      inline_keyboard: [
        [btnBlue(`📄 Download ${qty} Keys (.txt)`, `dl:${orderId}`)],
        [btnBlue("🛒 Buy More Keys", "menu:buy"), btnNeutral("🏠 Main Menu", "menu:home")],
      ],
    };

    await sendText(
      cfg.botToken,
      userId,
      `🎉 <b>BULK ORDER DELIVERED!</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🧾 <b>Order ID:</b> <code>${orderId}</code>\n` +
        `📦 <b>Quantity:</b> <b>${qty} Keys</b>\n` +
        `💰 <b>Paid:</b> ${fmtInr(amount)}` +
        `${preview}\n\n` +
        `📄 <i>All ${qty} keys are attached below as a clean text file.</i>`,
      bulkKb,
    );

    const txtContent =
      `${cfg.shopName} — Bulk Access Keys\n` +
      `Order ID: ${orderId}\n` +
      `Quantity: ${qty} Keys\n` +
      `Generated: ${fmtDate(new Date())}\n` +
      `${"=".repeat(38)}\n\n` +
      keys.join("\n") +
      "\n";

    await sendDocumentText(
      cfg.botToken,
      userId,
      txtContent,
      `Bulk_Keys_${orderId}.txt`,
      `📦 <b>${qty} Access Keys</b> · Order <code>${orderId}</code>`,
    );
  }

  const sellerLine = sellerName
    ? `\n🔗 <b>Seller Link:</b> ${esc(sellerName)} (<code>${esc(order.ref_code)}</code>)`
    : "";
  for (const adminId of cfg.adminIds) {
    await sendText(
      cfg.botToken,
      adminId,
      `💸 <b>NEW SALE COMPLETED</b> <i>(${esc(verifiedBy)})</i>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `<blockquote>` +
        `🧾 <b>Order:</b> <code>${orderId}</code>\n` +
        `👤 <b>Buyer:</b> <code>${userId}</code> (${esc(buyerTag)})\n` +
        `📦 <b>Type:</b> ${qty > 1 ? "Bulk" : "Single"} (${qty} key${qty > 1 ? "s" : ""})\n` +
        `💰 <b>Amount:</b> <b>${fmtInr(amount)}</b>\n` +
        `🔖 <b>Txn ID:</b> <code>${esc(txnId || "Manual")}</code>` +
        `${sellerLine}` +
        `</blockquote>`,
    );
  }

  return true;
}

async function checkSingleOrder(
  sql: NeonQueryFunction<false, false>,
  cfg: BotConfig,
  order: BotOrderRow,
  source = "cashfree-auto",
): Promise<boolean> {
  if (!isCashfreeConfigured(cfg)) return false;
  const { data, payments } = await fetchCashfreeOrderStatus(toCashfreeConfig(cfg), order.order_id);
  const { ok, txnId } = verifyCashfreePayment(data, payments, order.order_id, Number(order.amount));
  if (ok) {
    return deliverOrder(sql, cfg, order, txnId, source);
  }
  return false;
}

export async function handleCashfreeWebhookOrder(orderId: string): Promise<{
  found: boolean;
  delivered: boolean;
}> {
  const cleanId = orderId.trim();
  if (!cleanId) return { found: false, delivered: false };
  const baseCfg = getBotConfig();
  if (!baseCfg.botToken || !isCashfreeConfigured(baseCfg)) {
    return { found: false, delivered: false };
  }

  const sql = await ensureNeonSchema();
  const cfg = await getEffectiveBotConfig(sql);
  const rows = (await sql`
    SELECT * FROM public.bot_orders
    WHERE order_id = ${cleanId}
    LIMIT 1
  `) as BotOrderRow[];
  const order = rows[0];
  if (!order) return { found: false, delivered: false };
  if (order.status === "paid") return { found: true, delivered: false };

  // Re-verify directly against Cashfree API before delivering keys
  const { data, payments } = await fetchCashfreeOrderStatus(toCashfreeConfig(cfg), order.order_id);
  const { ok, txnId } = verifyCashfreePayment(data, payments, order.order_id, Number(order.amount));
  if (!ok) return { found: true, delivered: false };

  // If payment arrived slightly after local expiry/cancel, allow automatic recovery
  if (order.status === "expired" || order.status === "cancelled") {
    await sql`
      UPDATE public.bot_orders
      SET status = 'pending'
      WHERE order_id = ${order.order_id} AND status IN ('expired', 'cancelled')
    `;
  }

  const delivered = await deliverOrder(sql, cfg, order, txnId, "cashfree-webhook");
  return { found: true, delivered };
}

export async function getOrderCheckoutSession(orderId: string): Promise<{
  paymentSessionId: string;
  amount: number;
  status: string;
} | null> {
  const cleanId = orderId.trim();
  if (!cleanId) return null;
  const sql = await ensureNeonSchema();
  const rows = (await sql`
    SELECT payment_session_id, amount, status
    FROM public.bot_orders
    WHERE order_id = ${cleanId}
    LIMIT 1
  `) as { payment_session_id: string | null; amount: string; status: string }[];
  const row = rows[0];
  if (!row || !row.payment_session_id) return null;
  return {
    paymentSessionId: row.payment_session_id,
    amount: Number(row.amount),
    status: row.status,
  };
}

export async function pollPendingBotOrders(): Promise<{
  checked: number;
  delivered: number;
  expired: number;
}> {
  const baseCfg = getBotConfig();
  if (!baseCfg.botToken || !isCashfreeConfigured(baseCfg)) {
    return { checked: 0, delivered: 0, expired: 0 };
  }

  const sql = await ensureNeonSchema();
  const cfg = await getEffectiveBotConfig(sql);
  const pending = (await sql`
    SELECT * FROM public.bot_orders
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT 30
  `) as BotOrderRow[];

  let delivered = 0;
  let expired = 0;
  const timeoutMs = cfg.orderTimeoutMin * 60 * 1000;
  const nowMs = Date.now();
  const supportUrl = await getSupportUrl(sql, cfg);

  for (const order of pending) {
    const createdMs = new Date(order.created_at).getTime();
    const isTimedOut = Number.isFinite(createdMs) && nowMs - createdMs > timeoutMs;

    try {
      const paid = await checkSingleOrder(sql, cfg, order, "cashfree-poller");
      if (paid) {
        delivered += 1;
        continue;
      }
    } catch {
      // Ignore transient Cashfree network hiccup
    }

    if (isTimedOut) {
      const expRows = (await sql`
        UPDATE public.bot_orders
        SET status = 'expired'
        WHERE order_id = ${order.order_id} AND status = 'pending'
        RETURNING order_id
      `) as { order_id: string }[];
      if (expRows.length > 0) {
        expired += 1;
        await deleteMsg(cfg.botToken, order.qr_chat_id, order.qr_msg_id);
        await sendText(
          cfg.botToken,
          order.user_id,
          `⌛ <b>Order Expired</b>\n\n` +
            `Order <code>${order.order_id}</code> timed out after ${cfg.orderTimeoutMin} minutes.\n` +
            `If your payment was deducted, please contact support with your Order ID.`,
          mainMenuKb(order.user_id, cfg, supportUrl),
        );
      }
    }
  }

  return { checked: pending.length, delivered, expired };
}

// ============================================================================
// Admin Callback Handler (Blue & Red Button Hierarchy + Expandable Article Cards)
// ============================================================================
async function handleAdminCallback(
  sql: NeonQueryFunction<false, false>,
  cfg: BotConfig,
  q: TgCallbackQuery,
): Promise<void> {
  const userId = q.from.id;
  const chatId = q.message?.chat.id ?? userId;
  const msgId = q.message?.message_id;

  if (!isAdminUser(userId, cfg)) {
    await answerCb(cfg.botToken, q.id, "⛔ Admin access only.", true);
    return;
  }

  const parts = (q.data ?? "").split(":");
  const section = parts[1] ?? "home";

  if (section !== "bc_go") {
    await setBotUserState(sql, userId, null, null);
  }
  await answerCb(cfg.botToken, q.id);

  // ---------- HOME ----------
  if (section === "home") {
    const { text, kb } = await adminHomeUi(sql);
    await editOrSend(cfg.botToken, chatId, msgId, text, kb);
    return;
  }

  // ---------- DETAILED STATS ----------
  if (section === "stats") {
    const st = await getGlobalStats(sql);
    const conv = st.total_users > 0 ? (st.total_buyers / st.total_users) * 100 : 0;
    const links = await listSellerLinksWithStats(sql);
    const topLinks = [...links].sort((a, b) => b.total_revenue - a.total_revenue).slice(0, 5);

    const topLines =
      topLinks.length > 0
        ? `\n\n<blockquote expandable>` +
          `🏆 <b>TOP SELLER LINKS</b>\n` +
          topLinks
            .map(
              (l, i) =>
                `${i + 1}. <b>${esc(l.name)}</b> — ${l.total_buyers} buyers · ${l.total_keys} keys · <b>${fmtInr(l.total_revenue)}</b>`,
            )
            .join("\n") +
          `</blockquote>`
        : "";

    const text =
      `📊 <b>STORE ANALYTICS &amp; STATS</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<blockquote>` +
      `👥 <b>Total Users:</b> ${st.total_users.toLocaleString("en-IN")} <i>(${st.blocked_users.toLocaleString("en-IN")} unreachable)</i>\n` +
      `🛍️ <b>Total Buyers:</b> ${st.total_buyers.toLocaleString("en-IN")} <i>(${conv.toFixed(1)}% conversion)</i>\n` +
      `🧾 <b>Paid Orders:</b> ${st.paid_orders.toLocaleString("en-IN")} <i>(${st.single_orders} single · ${st.bulk_orders} bulk)</i>\n` +
      `🔑 <b>Total Keys Delivered:</b> ${st.total_keys.toLocaleString("en-IN")}\n` +
      `💰 <b>All-Time Revenue:</b> <b>${fmtInr(st.total_revenue)}</b>` +
      `</blockquote>\n\n` +
      `⚡ <b>Last 24 Hours:</b>\n` +
      `• Orders: <b>${st.orders_24h}</b> · Keys: <b>${st.keys_24h}</b> · Revenue: <b>${fmtInr(st.revenue_24h)}</b>\n` +
      `• Pending Orders: <b>${st.pending_orders}</b> · Failed Deliveries: <b>${st.failed_deliveries}</b>\n` +
      `• Active Seller Links: <b>${st.active_links}</b>` +
      `${topLines}`;

    await editOrSend(cfg.botToken, chatId, msgId, text, {
      inline_keyboard: [
        [btnBlue("🔗 Seller Links", "adm:links"), btnNeutral("🔄 Refresh", "adm:stats")],
        [btnRed("❌ Back to Admin", "adm:home")],
      ],
    });
    return;
  }

  // ---------- BROADCAST ----------
  if (section === "bc") {
    const cntRows = (await sql`SELECT COUNT(*)::int AS cnt FROM public.bot_users`) as {
      cnt: number;
    }[];
    const total = cntRows[0]?.cnt ?? 0;
    await setBotUserState(sql, userId, "broadcast_content", null);

    await editOrSend(
      cfg.botToken,
      chatId,
      msgId,
      `📢 <b>ADMIN BROADCAST</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `👥 <b>Target Audience:</b> ${total.toLocaleString("en-IN")} total users\n\n` +
        `<blockquote>Send the message you want to broadcast now.\n` +
        `Supports text, photos, videos, captions, documents, and formatting.</blockquote>`,
      { inline_keyboard: [[btnRed("❌ Cancel", "adm:home")]] },
    );
    return;
  }

  if (section === "bc_go") {
    const uRows = (await sql`
      SELECT state_data FROM public.bot_users WHERE user_id = ${String(userId)}::bigint LIMIT 1
    `) as { state_data: Record<string, unknown> | null }[];
    const stateData = uRows[0]?.state_data ?? null;
    await setBotUserState(sql, userId, null, null);

    const srcChat = stateData?.["bc_chat_id"];
    const srcMsg = stateData?.["bc_message_id"];
    if (!srcChat || !srcMsg) {
      await editOrSend(cfg.botToken, chatId, msgId, "⚠️ Broadcast session expired. Start again.", {
        inline_keyboard: [[btnRed("❌ Back to Admin", "adm:home")]],
      });
      return;
    }

    const targets = (await sql`
      SELECT user_id FROM public.bot_users ORDER BY first_seen ASC
    `) as { user_id: string }[];
    const total = targets.length;
    let completed = 0;
    let failed = 0;
    const startedAt = Date.now();

    await editOrSend(
      cfg.botToken,
      chatId,
      msgId,
      `🚀 <b>BROADCAST IN PROGRESS</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `👥 Total Users: <b>${total.toLocaleString("en-IN")}</b>\n` +
        `✅ Completed: <b>0</b>\n` +
        `❌ Failed: <b>0</b>`,
    );

    for (let i = 0; i < targets.length; i += 1) {
      const targetId = targets[i]!.user_id;
      const res = await tgApi(cfg.botToken, "copyMessage", {
        chat_id: targetId,
        from_chat_id: srcChat,
        message_id: Number(srcMsg),
      });

      if (res.ok) {
        completed += 1;
      } else if (res.error_code === 429 && res.parameters?.retry_after) {
        await delay((Number(res.parameters.retry_after) + 0.5) * 1000);
        const retry = await tgApi(cfg.botToken, "copyMessage", {
          chat_id: targetId,
          from_chat_id: srcChat,
          message_id: Number(srcMsg),
        });
        if (retry.ok) completed += 1;
        else failed += 1;
      } else {
        failed += 1;
        if (res.error_code === 403) {
          await sql`
            UPDATE public.bot_users SET is_blocked = true WHERE user_id = ${targetId}::bigint
          `.catch(() => {});
        }
      }

      await delay(35);
      if ((i + 1) % 25 === 0 && i + 1 < total) {
        await editOrSend(
          cfg.botToken,
          chatId,
          msgId,
          `🚀 <b>BROADCAST IN PROGRESS</b> (${i + 1}/${total})\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `👥 Total Users: <b>${total.toLocaleString("en-IN")}</b>\n` +
            `✅ Completed: <b>${completed.toLocaleString("en-IN")}</b>\n` +
            `❌ Failed: <b>${failed.toLocaleString("en-IN")}</b>`,
        );
      }
    }

    const elapsedSec = Math.max(0.1, (Date.now() - startedAt) / 1000).toFixed(1);
    await editOrSend(
      cfg.botToken,
      chatId,
      msgId,
      `✅ <b>BROADCAST COMPLETED</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `<blockquote>` +
        `👥 <b>Total Broadcast Users:</b> ${total.toLocaleString("en-IN")}\n` +
        `✅ <b>Completed:</b> ${completed.toLocaleString("en-IN")}\n` +
        `❌ <b>Failed / Blocked:</b> ${failed.toLocaleString("en-IN")}\n` +
        `⏱️ <b>Time Taken:</b> ${elapsedSec}s` +
        `</blockquote>`,
      {
        inline_keyboard: [
          [btnBlue("📢 New Broadcast", "adm:bc")],
          [btnRed("❌ Back to Admin", "adm:home")],
        ],
      },
    );
    return;
  }

  // ---------- SELLER / TEAM LINKS ----------
  if (section === "links") {
    const links = await listSellerLinksWithStats(sql);
    const teamBuyers = links.reduce((acc, l) => acc + l.total_buyers, 0);
    const teamRev = links.reduce((acc, l) => acc + l.total_revenue, 0);

    const lines = [
      `🔗 <b>SELLER &amp; TEAM REFERRAL LINKS</b>`,
      `━━━━━━━━━━━━━━━━━━━━\n`,
      `<blockquote>` +
        `🏷️ <b>Active Links:</b> ${links.length}\n` +
        `🛍️ <b>Team Buyers:</b> ${teamBuyers.toLocaleString("en-IN")}\n` +
        `💰 <b>Team Revenue:</b> <b>${fmtInr(teamRev)}</b>` +
        `</blockquote>\n`,
      links.length === 0
        ? "No seller links created yet. Tap <b>➕ Create New Seller Link</b> to generate one for your team."
        : "👇 Tap any seller link below to view its individual stats:",
    ];

    const kbRows: InlineButton[][] = [
      [btnBlue("➕ Create New Seller Link", "adm:link_new")],
    ];
    for (const l of links.slice(0, 15)) {
      kbRows.push([
        btnNeutral(
          `👤 ${l.name} · ${l.total_buyers} buyers · ${fmtInr(l.total_revenue)}`,
          `adm:link_view:${l.code}`,
        ),
      ]);
    }
    if (links.length > 0) {
      kbRows.push([btnBlue("📈 All Links Summary Report", "adm:links_report")]);
    }
    kbRows.push([btnRed("❌ Back to Admin", "adm:home")]);

    await editOrSend(cfg.botToken, chatId, msgId, lines.join("\n"), { inline_keyboard: kbRows });
    return;
  }

  if (section === "link_new") {
    await setBotUserState(sql, userId, "seller_link_name", null);
    await editOrSend(
      cfg.botToken,
      chatId,
      msgId,
      `➕ <b>CREATE SELLER / TEAM LINK</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `✏️ Enter a <b>name</b> for this seller link\n` +
        `<i>(Example: Rahul Team, Instagram Ads, Reseller 1)</i>:`,
      { inline_keyboard: [[btnRed("❌ Cancel", "adm:links")]] },
    );
    return;
  }

  if (section === "links_report") {
    const links = await listSellerLinksWithStats(sql);
    if (links.length === 0) {
      await editOrSend(cfg.botToken, chatId, msgId, "📈 No active seller links yet.", {
        inline_keyboard: [[btnRed("❌ Back", "adm:links")]],
      });
      return;
    }
    const sorted = [...links].sort(
      (a, b) => b.total_revenue - a.total_revenue || b.total_buyers - a.total_buyers,
    );
    const body = sorted
      .map((l, idx) => {
        const conv = l.total_users > 0 ? Math.round((l.total_buyers / l.total_users) * 100) : 0;
        return (
          `<b>${idx + 1}. ${esc(l.name)}</b> (<code>${l.code}</code>)\n` +
          `   👥 Users: <b>${l.total_users}</b> · 🛍️ Buyers: <b>${l.total_buyers}</b> (${conv}%)\n` +
          `   🔑 Keys: <b>${l.total_keys}</b> · 💰 Revenue: <b>${fmtInr(l.total_revenue)}</b>`
        );
      })
      .join("\n\n");

    await editOrSend(
      cfg.botToken,
      chatId,
      msgId,
      `📈 <b>ALL SELLER LINKS REPORT</b>\n━━━━━━━━━━━━━━━━━━━━\n\n<blockquote expandable>${body}</blockquote>`.slice(
        0,
        4000,
      ),
      {
        inline_keyboard: [
          [btnNeutral("🔄 Refresh", "adm:links_report")],
          [btnRed("❌ Back to Seller Links", "adm:links")],
        ],
      },
    );
    return;
  }

  if (section === "link_view" && parts[2]) {
    const code = parts[2];
    const st = await getSellerLinkStats(sql, code);
    if (!st) {
      await editOrSend(cfg.botToken, chatId, msgId, "⚠️ Seller link not found.", {
        inline_keyboard: [[btnRed("❌ Back", "adm:links")]],
      });
      return;
    }

    const botUsername = await getBotUsername(cfg.botToken);
    const shareUrl = `https://t.me/${botUsername}?start=ref_${st.code}`;
    const conv = st.total_users > 0 ? (st.total_buyers / st.total_users) * 100 : 0;

    await editOrSend(
      cfg.botToken,
      chatId,
      msgId,
      `🔗 <b>SELLER LINK STATS</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🏷️ <b>Name:</b> ${esc(st.name)}\n` +
        `🗓️ <b>Created:</b> ${fmtDate(st.created_at)}\n\n` +
        `🔗 <b>Shareable Link:</b>\n` +
        `<code>${esc(shareUrl)}</code>\n\n` +
        `<blockquote>` +
        `👥 <b>Total Users Started:</b> ${st.total_users.toLocaleString("en-IN")}\n` +
        `🛍️ <b>Total Buyers:</b> ${st.total_buyers.toLocaleString("en-IN")} <i>(${conv.toFixed(1)}% conversion)</i>\n` +
        `🧾 <b>Paid Orders:</b> ${st.paid_orders.toLocaleString("en-IN")} <i>(${st.single_orders} single · ${st.bulk_orders} bulk)</i>\n` +
        `🔑 <b>Total Keys Sold:</b> ${st.total_keys.toLocaleString("en-IN")}\n` +
        `💰 <b>Total Revenue:</b> <b>${fmtInr(st.total_revenue)}</b>` +
        `</blockquote>`,
      {
        inline_keyboard: [
          [btnCopyBlue("📋 Copy Seller Link", shareUrl)],
          [
            btnBlue("🛍️ Buyers List", `adm:link_buyers:${code}`),
            btnNeutral("🔄 Refresh", `adm:link_view:${code}`),
          ],
          [btnRed("🗑️ Delete Link", `adm:link_del:${code}`)],
          [btnRed("❌ Back to Seller Links", "adm:links")],
        ],
      },
    );
    return;
  }

  if (section === "link_buyers" && parts[2]) {
    const code = parts[2];
    const lkRows = (await sql`
      SELECT name FROM public.bot_seller_links WHERE code = ${code} LIMIT 1
    `) as { name: string }[];
    if (!lkRows[0]) {
      await editOrSend(cfg.botToken, chatId, msgId, "⚠️ Seller link not found.", {
        inline_keyboard: [[btnRed("❌ Back", "adm:links")]],
      });
      return;
    }

    const buyers = (await sql`
      SELECT order_id, user_id, username, quantity, amount, paid_at
      FROM public.bot_orders
      WHERE ref_code = ${code} AND status = 'paid'
      ORDER BY paid_at DESC
      LIMIT 15
    `) as {
      order_id: string;
      user_id: string;
      username: string | null;
      quantity: number;
      amount: string;
      paid_at: string | null;
    }[];

    const body =
      buyers.length === 0
        ? "No paid buyers from this link yet."
        : `<blockquote expandable>` +
          buyers
            .map(
              (b) =>
                `• <code>${b.order_id}</code> · <b>${fmtInr(Number(b.amount))}</b> (${b.quantity} key${b.quantity > 1 ? "s" : ""})\n` +
                `  👤 <code>${b.user_id}</code> (@${esc(b.username || "none")}) · <i>${fmtDate(b.paid_at)}</i>`,
            )
            .join("\n\n") +
          `</blockquote>`;

    await editOrSend(
      cfg.botToken,
      chatId,
      msgId,
      `🛍️ <b>BUYERS — ${esc(lkRows[0].name)}</b>\n━━━━━━━━━━━━━━━━━━━━\n\n${body}`,
      {
        inline_keyboard: [[btnRed("❌ Back to Link Stats", `adm:link_view:${code}`)]],
      },
    );
    return;
  }

  if (section === "link_del" && parts[2]) {
    const code = parts[2];
    await sql`UPDATE public.bot_seller_links SET is_active = false WHERE code = ${code}`;
    await editOrSend(
      cfg.botToken,
      chatId,
      msgId,
      `🗑️ Seller link <code>${esc(code)}</code> has been deleted.`,
      { inline_keyboard: [[btnRed("❌ Back to Seller Links", "adm:links")]] },
    );
    return;
  }

  // ---------- ORDERS ----------
  if (section === "orders") {
    const filt = parts[2] ?? "all";
    const rows = (
      filt === "all"
        ? await sql`SELECT * FROM public.bot_orders ORDER BY created_at DESC LIMIT 10`
        : await sql`SELECT * FROM public.bot_orders WHERE status = ${filt} ORDER BY created_at DESC LIMIT 10`
    ) as BotOrderRow[];

    const titles: Record<string, string> = {
      all: "ALL RECENT ORDERS",
      pending: "PENDING ORDERS",
      paid: "PAID ORDERS",
    };
    const header = titles[filt] ?? "ORDERS";
    const lines = [`🧾 <b>${header}</b>\n━━━━━━━━━━━━━━━━━━━━\n`];
    const kbRows: InlineButton[][] = [
      [
        filt === "all" ? btnBlue("📋 All •", "adm:orders:all") : btnNeutral("📋 All", "adm:orders:all"),
        filt === "pending"
          ? btnBlue("⏳ Pending •", "adm:orders:pending")
          : btnNeutral("⏳ Pending", "adm:orders:pending"),
        filt === "paid" ? btnBlue("✅ Paid •", "adm:orders:paid") : btnNeutral("✅ Paid", "adm:orders:paid"),
      ],
    ];

    if (rows.length === 0) {
      lines.push("No orders found in this category.");
    } else {
      const emMap: Record<string, string> = {
        paid: "✅",
        pending: "⏳",
        expired: "⌛",
        cancelled: "❌",
        delivery_failed: "🚨",
        generating: "⚡",
      };
      const orderSummaries: string[] = [];
      for (const r of rows) {
        const em = emMap[r.status] ?? "•";
        orderSummaries.push(
          `${em} <code>${r.order_id}</code> · <b>${fmtInr(Number(r.amount))}</b> (${r.quantity}k) · ${r.status}`,
        );
        kbRows.push([
          btnNeutral(
            `${em} ${r.order_id} · ${fmtInr(Number(r.amount))} (${r.quantity}k)`,
            `adm:ord:${r.order_id}`,
          ),
        ]);
      }
      lines.push(`<blockquote expandable>${orderSummaries.join("\n")}</blockquote>`);
    }

    kbRows.push([btnRed("❌ Back to Admin", "adm:home")]);
    await editOrSend(cfg.botToken, chatId, msgId, lines.join("\n"), { inline_keyboard: kbRows });
    return;
  }

  if (section === "ord" && parts[2]) {
    const orderId = parts[2];
    const rows = (await sql`
      SELECT * FROM public.bot_orders WHERE order_id = ${orderId} LIMIT 1
    `) as BotOrderRow[];
    const o = rows[0];
    if (!o) {
      await editOrSend(cfg.botToken, chatId, msgId, "⚠️ Order not found.", {
        inline_keyboard: [[btnRed("❌ Back", "adm:orders:all")]],
      });
      return;
    }

    const keys = parseOrderKeys(o);
    let refStr = "Direct";
    if (o.ref_code) {
      const lk = (await sql`
        SELECT name FROM public.bot_seller_links WHERE code = ${o.ref_code} LIMIT 1
      `) as { name: string }[];
      refStr = lk[0] ? `${lk[0].name} (${o.ref_code})` : o.ref_code;
    }

    const text =
      `🧾 <b>ORDER INSPECTOR</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<blockquote>` +
      `🆔 <b>Order ID:</b> <code>${o.order_id}</code>\n` +
      `📌 <b>Status:</b> <b>${esc(o.status).toUpperCase()}</b>\n` +
      `👤 <b>User:</b> <code>${o.user_id}</code> (@${esc(o.username || "none")})\n` +
      `📦 <b>Quantity:</b> ${o.quantity} (${o.order_type})\n` +
      `💰 <b>Amount:</b> <b>${fmtInr(Number(o.amount))}</b>\n` +
      `🔗 <b>Source:</b> ${esc(refStr)}\n` +
      `🔖 <b>Txn ID:</b> <code>${esc(o.txn_id || "—")}</code>\n` +
      `🔑 <b>Keys Generated:</b> ${keys.length}/${o.quantity}\n` +
      `🕒 <b>Created:</b> ${fmtDate(o.created_at)}\n` +
      `✅ <b>Paid At:</b> ${fmtDate(o.paid_at)}` +
      `</blockquote>`;

    const kbRows: InlineButton[][] = [];
    if (o.status === "pending" || o.status === "expired" || o.status === "cancelled") {
      kbRows.push([
        btnBlue("✅ Approve & Deliver", `adm:approve:${orderId}`),
        btnNeutral("🔍 Cashfree Check", `adm:cf:${orderId}`),
      ]);
    } else if (o.status === "delivery_failed") {
      kbRows.push([btnBlue("🔁 Retry Key Delivery", `adm:retry:${orderId}`)]);
    } else if (o.status === "paid" && keys.length > 0) {
      kbRows.push([btnBlue("📄 Download Keys File", `dl:${orderId}`)]);
    }
    kbRows.push([btnRed("❌ Back to Orders", "adm:orders:all")]);
    await editOrSend(cfg.botToken, chatId, msgId, text, { inline_keyboard: kbRows });
    return;
  }

  if (section === "approve" && parts[2]) {
    const orderId = parts[2];
    const rows = (await sql`
      SELECT * FROM public.bot_orders WHERE order_id = ${orderId} LIMIT 1
    `) as BotOrderRow[];
    const order = rows[0];
    if (!order) {
      await editOrSend(cfg.botToken, chatId, msgId, "⚠️ Order not found.");
      return;
    }
    if (order.status === "paid") {
      await editOrSend(
        cfg.botToken,
        chatId,
        msgId,
        `✅ Order <code>${orderId}</code> is already delivered.`,
        { inline_keyboard: [[btnRed("❌ Back", `adm:ord:${orderId}`)]] },
      );
      return;
    }
    await sql`UPDATE public.bot_orders SET status = 'pending' WHERE order_id = ${orderId}`;
    const refreshed = (await sql`
      SELECT * FROM public.bot_orders WHERE order_id = ${orderId} LIMIT 1
    `) as BotOrderRow[];
    const ok = await deliverOrder(sql, cfg, refreshed[0]!, null, `manual by ${userId}`);
    await editOrSend(
      cfg.botToken,
      chatId,
      msgId,
      ok
        ? `✅ Order <code>${orderId}</code> manually approved &amp; delivered!`
        : `⚠️ Order <code>${orderId}</code> key delivery failed.`,
      { inline_keyboard: [[btnRed("❌ Back to Order", `adm:ord:${orderId}`)]] },
    );
    return;
  }

  if (section === "retry" && parts[2]) {
    const orderId = parts[2];
    const rows = (await sql`
      SELECT * FROM public.bot_orders WHERE order_id = ${orderId} LIMIT 1
    `) as BotOrderRow[];
    const order = rows[0];
    if (!order) {
      await editOrSend(cfg.botToken, chatId, msgId, "⚠️ Order not found.");
      return;
    }
    const ok = await deliverOrder(sql, cfg, order, order.txn_id, `retry by ${userId}`, true);
    await editOrSend(
      cfg.botToken,
      chatId,
      msgId,
      ok
        ? `✅ Order <code>${orderId}</code> keys delivered successfully!`
        : `❌ Retry failed for <code>${orderId}</code>.`,
      { inline_keyboard: [[btnRed("❌ Back to Order", `adm:ord:${orderId}`)]] },
    );
    return;
  }

  if ((section === "cf" || section === "paytm") && parts[2]) {
    const orderId = parts[2];
    const rows = (await sql`
      SELECT amount FROM public.bot_orders WHERE order_id = ${orderId} LIMIT 1
    `) as { amount: string }[];
    const expected = rows[0] ? Number(rows[0].amount) : cfg.singlePrice;
    const { data, payments, raw } = await fetchCashfreeOrderStatus(toCashfreeConfig(cfg), orderId);
    const { ok, txnId, status } = verifyCashfreePayment(data, payments, orderId, expected);
    const masked = cfg.cashfreeAppId ? raw.split(cfg.cashfreeAppId).join("***APP_ID***") : raw;
    await editOrSend(
      cfg.botToken,
      chatId,
      msgId,
      `🔍 <b>CASHFREE STATUS CHECK</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🧾 Order: <code>${orderId}</code>\n` +
        `📡 Status: <b>${esc(status)}</b> · Verified: <b>${ok}</b>\n` +
        `🔖 Txn/UTR: <code>${esc(txnId || "—")}</code>\n\n` +
        `<blockquote expandable><pre>${esc(masked.slice(0, 2400))}</pre></blockquote>`,
      { inline_keyboard: [[btnRed("❌ Back to Order", `adm:ord:${orderId}`)]] },
    );
    return;
  }

  // ---------- LIVE PRICING (SYNCED WITH WEBSITE & BOT) ----------
  if (section === "pricing") {
    const liveCfg = await getEffectiveBotConfig(sql);
    await editOrSend(
      cfg.botToken,
      chatId,
      msgId,
      `💰 <b>KEY PRICING MANAGER</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `<blockquote>` +
        `⚡ <b>Single Key Price:</b> <b>${fmtInr(liveCfg.singlePrice)}</b>\n` +
        `💎 <b>Bulk Key Price:</b> <b>${fmtInr(liveCfg.bulkPrice)} / key</b> <i>(Save ${savePct(liveCfg)}%)</i>\n` +
        `📦 <b>Bulk Min Order:</b> ${liveCfg.bulkMin} keys (${fmtInr(liveCfg.bulkMin * liveCfg.bulkPrice)})` +
        `</blockquote>\n\n` +
        `<i>Any price update here syncs instantly across both the Website and this Telegram Bot.</i>`,
      {
        inline_keyboard: [
          [
            btnBlue(`⚡ Edit Single (${fmtInr(liveCfg.singlePrice)})`, "adm:price_single"),
            btnBlue(`💎 Edit Bulk (${fmtInr(liveCfg.bulkPrice)})`, "adm:price_bulk"),
          ],
          [btnRed("❌ Back to Admin", "adm:home")],
        ],
      },
    );
    return;
  }

  if (section === "price_single") {
    await setBotUserState(sql, userId, "admin_price_single", null);
    await editOrSend(
      cfg.botToken,
      chatId,
      msgId,
      `⚡ <b>UPDATE SINGLE KEY PRICE</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Current Single Price: <b>${fmtInr(cfg.singlePrice)}</b>\n\n` +
        `<blockquote>Send the new Single Key price in ₹ (numbers only, e.g. <code>99</code> or <code>149</code>):</blockquote>`,
      { inline_keyboard: [[btnRed("❌ Cancel", "adm:pricing")]] },
    );
    return;
  }

  if (section === "price_bulk") {
    await setBotUserState(sql, userId, "admin_price_bulk", null);
    await editOrSend(
      cfg.botToken,
      chatId,
      msgId,
      `💎 <b>UPDATE BULK KEY PRICE</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Current Bulk Price: <b>${fmtInr(cfg.bulkPrice)} / key</b>\n\n` +
        `<blockquote>Send the new Bulk price per key in ₹ (numbers only, e.g. <code>49</code> or <code>59</code>):</blockquote>`,
      { inline_keyboard: [[btnRed("❌ Cancel", "adm:pricing")]] },
    );
    return;
  }

  // ---------- SYSTEM HEALTH ----------
  if (section === "health") {
    const wh = await tgApi<{ url?: string; pending_update_count?: number }>(
      cfg.botToken,
      "getWebhookInfo",
    );
    const whUrl = wh.ok && wh.result?.url ? wh.result.url : "Long-Polling (Active)";
    const pendingCnt = wh.ok ? (wh.result?.pending_update_count ?? 0) : 0;

    await editOrSend(
      cfg.botToken,
      chatId,
      msgId,
      `⚙️ <b>SYSTEM HEALTH &amp; CONFIG</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `<blockquote>` +
        `🗄️ <b>Database:</b> ✅ Neon PostgreSQL (Direct Key Sync)\n` +
        `📡 <b>Webhook:</b> <code>${esc(whUrl)}</code>\n` +
        `📬 <b>Pending Updates:</b> ${pendingCnt}\n` +
        `💳 <b>Gateway:</b> Cashfree (${cfg.cashfreeEnv}) · QR: <code>${cfg.cashfreeQrMode}</code>\n` +
        `🌐 <b>CF Origin:</b> <code>${esc(cfg.cashfreeWhitelistedUrl || "Not Set (Set CASHFREE_WHITELISTED_URL)")}</code>\n` +
        `🔔 <b>CF Webhook:</b> <code>${esc(cfg.publicBaseUrl ? `${cfg.publicBaseUrl}/cashfree-webhook` : "Auto-Poller Only")}</code>\n` +
        `⚡ <b>Single Price:</b> ${fmtInr(cfg.singlePrice)}\n` +
        `💎 <b>Bulk Price:</b> ${fmtInr(cfg.bulkPrice)} (Min ${cfg.bulkMin} · Max ${cfg.bulkMax})\n` +
        `🛡️ <b>Key Validity:</b> ${cfg.keyDays === 0 ? "Lifetime" : `${cfg.keyDays} days`}` +
        `</blockquote>`,
      {
        inline_keyboard: [
          [btnBlue("🔄 Sweep Pending Payments", "adm:sweep"), btnNeutral("🔄 Refresh", "adm:health")],
          [btnRed("❌ Back to Admin", "adm:home")],
        ],
      },
    );
    return;
  }

  if (section === "sweep") {
    const res = await pollPendingBotOrders();
    await editOrSend(
      cfg.botToken,
      chatId,
      msgId,
      `🔄 <b>PAYMENT SWEEP COMPLETE</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `<blockquote>` +
        `🔍 <b>Checked:</b> ${res.checked}\n` +
        `✅ <b>Delivered:</b> ${res.delivered}\n` +
        `⌛ <b>Expired:</b> ${res.expired}` +
        `</blockquote>`,
      {
        inline_keyboard: [[btnRed("❌ Back to System Health", "adm:health")]],
      },
    );
  }
}

// ============================================================================
// Main Telegram Update Router (invoked by POST /api/telegram/webhook)
// ============================================================================
export async function processTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const baseCfg = getBotConfig();
  if (!baseCfg.botToken) return;

  const sql = await ensureNeonSchema();
  const cfg = await getEffectiveBotConfig(sql);

  // ---------------- CALLBACK QUERIES ----------------
  if (update.callback_query) {
    const q = update.callback_query;
    const data = q.data ?? "";
    const user = q.from;
    const chatId = q.message?.chat.id ?? user.id;
    const msgId = q.message?.message_id;

    await upsertBotUser(sql, user);

    if (data.startsWith("adm:")) {
      await handleAdminCallback(sql, cfg, q);
      return;
    }

    await setBotUserState(sql, user.id, null, null);

    if (data.startsWith("menu:")) {
      const action = data.slice(5);
      await answerCb(cfg.botToken, q.id);

      if (action === "home") {
        const supportUrl = await getSupportUrl(sql, cfg);
        await editOrSend(
          cfg.botToken,
          chatId,
          msgId,
          welcomeText(user.first_name, cfg),
          mainMenuKb(user.id, cfg, supportUrl),
        );
        return;
      }

      if (action === "buy") {
        const { text, kb } = buyChoiceUi(cfg);
        await editOrSend(cfg.botToken, chatId, msgId, text, kb);
        return;
      }

      if (action === "guide") {
        const supportUrl = await getSupportUrl(sql, cfg);
        const { text, kb } = guideArticleUi(cfg, supportUrl);
        await editOrSend(cfg.botToken, chatId, msgId, text, kb);
        return;
      }

      if (action === "bulk") {
        const { text, kb } = bulkMenuUi(cfg);
        await editOrSend(cfg.botToken, chatId, msgId, text, kb);
        return;
      }

      if (action === "bulk_custom") {
        await setBotUserState(sql, user.id, "bulk_custom_qty", null);
        await editOrSend(
          cfg.botToken,
          chatId,
          msgId,
          `✏️ <b>ENTER CUSTOM QUANTITY</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `<blockquote>Send the number of keys you want to buy (between <b>${cfg.bulkMin}</b> and <b>${cfg.bulkMax}</b>).\n` +
            `Rate: <b>${fmtInr(cfg.bulkPrice)} per key</b></blockquote>`,
          { inline_keyboard: [[btnRed("❌ Cancel", "menu:bulk")]] },
        );
        return;
      }

      if (action === "orders") {
        const rows = (await sql`
          SELECT * FROM public.bot_orders
          WHERE user_id = ${String(user.id)}::bigint AND status = 'paid'
          ORDER BY paid_at DESC
          LIMIT 8
        `) as BotOrderRow[];

        if (rows.length === 0) {
          await editOrSend(
            cfg.botToken,
            chatId,
            msgId,
            `🔑 <b>MY ORDERS</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
              `<blockquote>You haven't purchased any access keys yet.\n` +
              `Tap <b>Buy Keys</b> below to get your first key instantly!</blockquote>`,
            {
              inline_keyboard: [
                [btnBlue("🛒 Buy Keys", "menu:buy")],
                [btnRed("❌ Back", "menu:home")],
              ],
            },
          );
          return;
        }

        const orderEntries: string[] = [];
        const kbRows: InlineButton[][] = [];
        for (const r of rows) {
          const keys = parseOrderKeys(r);
          if (r.quantity === 1 && keys[0]) {
            orderEntries.push(
              `• <code>${r.order_id}</code> · <b>${fmtInr(Number(r.amount))}</b>\n` +
                `  🔑 <code>${esc(keys[0])}</code>\n` +
                `  <i>${fmtDate(r.paid_at)}</i>`,
            );
          } else {
            orderEntries.push(
              `• <code>${r.order_id}</code> · <b>${r.quantity} Bulk Keys</b> · <b>${fmtInr(Number(r.amount))}</b>\n` +
                `  <i>${fmtDate(r.paid_at)}</i>`,
            );
            kbRows.push([
              btnBlue(
                `📄 Download ${r.quantity} Keys (${r.order_id.slice(-4)})`,
                `dl:${r.order_id}`,
              ),
            ]);
          }
        }
        kbRows.push([btnRed("❌ Back", "menu:home")]);

        const body =
          rows.length > 2
            ? `<blockquote expandable>${orderEntries.join("\n\n")}</blockquote>`
            : `<blockquote>${orderEntries.join("\n\n")}</blockquote>`;

        await editOrSend(
          cfg.botToken,
          chatId,
          msgId,
          `🔑 <b>MY RECENT ORDERS (${rows.length})</b>\n━━━━━━━━━━━━━━━━━━━━\n\n${body}`,
          { inline_keyboard: kbRows },
        );
        return;
      }
      return;
    }

    if (data.startsWith("buy:")) {
      const qty = Math.max(1, Number(data.slice(4)) || 1);
      await answerCb(cfg.botToken, q.id);
      await sendPaymentQr(sql, cfg, user, qty);
      return;
    }

    if (data.startsWith("dl:")) {
      const orderId = data.slice(3);
      const rows = (await sql`
        SELECT * FROM public.bot_orders WHERE order_id = ${orderId} LIMIT 1
      `) as BotOrderRow[];
      const order = rows[0];
      if (!order || order.status !== "paid") {
        await answerCb(cfg.botToken, q.id, "Order not found.", true);
        return;
      }
      if (order.user_id !== String(user.id) && !isAdminUser(user.id, cfg)) {
        await answerCb(cfg.botToken, q.id, "Access denied.", true);
        return;
      }
      const keys = parseOrderKeys(order);
      if (keys.length === 0) {
        await answerCb(cfg.botToken, q.id, "No keys stored for this order.", true);
        return;
      }
      await answerCb(cfg.botToken, q.id, "📄 Sending key file...");
      const txt =
        `${cfg.shopName} — Access Keys\n` +
        `Order ID: ${orderId}\n` +
        `Quantity: ${keys.length}\n` +
        `${"=".repeat(38)}\n\n` +
        keys.join("\n") +
        "\n";
      await sendDocumentText(
        cfg.botToken,
        user.id,
        txt,
        `Keys_${orderId}.txt`,
        `🔑 <b>${keys.length} Access Keys</b> · Order <code>${orderId}</code>`,
      );
      return;
    }

    if (data.startsWith("chk:")) {
      const orderId = data.slice(4);
      const rows = (await sql`
        SELECT * FROM public.bot_orders WHERE order_id = ${orderId} LIMIT 1
      `) as BotOrderRow[];
      const order = rows[0];
      if (!order || order.user_id !== String(user.id)) {
        await answerCb(cfg.botToken, q.id, "Order not found.", true);
        return;
      }
      if (order.status !== "pending") {
        await answerCb(cfg.botToken, q.id, `Order status: ${order.status}`, true);
        return;
      }
      const paid = await checkSingleOrder(sql, cfg, order, "cashfree-user-check");
      if (paid) {
        await answerCb(cfg.botToken, q.id, "✅ Payment verified! Delivering your key...");
      } else {
        await answerCb(
          cfg.botToken,
          q.id,
          "⏳ Payment not detected yet. If you just paid, wait 10–15 seconds and tap again.",
          true,
        );
      }
      return;
    }

    if (data.startsWith("cancel:")) {
      const orderId = data.slice(7);
      const cancelled = (await sql`
        UPDATE public.bot_orders
        SET status = 'cancelled'
        WHERE order_id = ${orderId}
          AND user_id = ${String(user.id)}::bigint
          AND status = 'pending'
        RETURNING order_id
      `) as { order_id: string }[];
      await answerCb(
        cfg.botToken,
        q.id,
        cancelled.length > 0 ? "❌ Order cancelled" : "Order already closed",
      );
      await deleteMsg(cfg.botToken, chatId, msgId ?? null);
      const supportUrl = await getSupportUrl(sql, cfg);
      await sendText(
        cfg.botToken,
        user.id,
        "❌ Your pending order has been cancelled.",
        mainMenuKb(user.id, cfg, supportUrl),
      );
      return;
    }

    await answerCb(cfg.botToken, q.id);
    return;
  }

  // ---------------- MESSAGES ----------------
  const msg = update.message;
  if (!msg || !msg.from || msg.chat.type !== "private") return;

  const user = msg.from;
  const text = (msg.text ?? "").trim();

  if (text.startsWith("/")) {
    const [rawCmd = "", ...args] = text.split(/\s+/);
    const cmd = rawCmd.split("@")[0]!.toLowerCase();

    if (cmd === "/start") {
      const { refCode, intent } = parseStartArg(args[0] ?? "", cfg);
      await upsertBotUser(sql, user, refCode);
      await setBotUserState(sql, user.id, null, null);

      if (intent === "buy_1") {
        await sendPaymentQr(sql, cfg, user, 1);
        return;
      }
      if (intent.startsWith("bulk_")) {
        const qty = Number(intent.slice(5)) || cfg.bulkMin;
        await sendPaymentQr(sql, cfg, user, qty);
        return;
      }

      const supportUrl = await getSupportUrl(sql, cfg);
      await sendText(
        cfg.botToken,
        user.id,
        welcomeText(user.first_name, cfg),
        mainMenuKb(user.id, cfg, supportUrl),
      );
      return;
    }

    await upsertBotUser(sql, user);
    await setBotUserState(sql, user.id, null, null);

    if (cmd === "/admin" && isAdminUser(user.id, cfg)) {
      const { text: admText, kb } = await adminHomeUi(sql);
      await sendText(cfg.botToken, user.id, admText, kb);
      return;
    }

    if (cmd === "/orders" && isAdminUser(user.id, cfg)) {
      const rows = (await sql`
        SELECT * FROM public.bot_orders ORDER BY created_at DESC LIMIT 10
      `) as BotOrderRow[];
      if (rows.length === 0) {
        await sendText(cfg.botToken, user.id, "No orders yet.");
        return;
      }
      const list = rows
        .map(
          (r) =>
            `• <code>${r.order_id}</code> | ${r.status} | ${fmtInr(Number(r.amount))} (${r.quantity}k) | <code>${r.user_id}</code>`,
        )
        .join("\n");
      await sendText(
        cfg.botToken,
        user.id,
        `🧾 <b>Recent Orders:</b>\n\n<blockquote expandable>${list}</blockquote>`,
      );
      return;
    }

    if (cmd === "/approve" && isAdminUser(user.id, cfg)) {
      const orderId = (args[0] ?? "").trim();
      if (!orderId) {
        await sendText(cfg.botToken, user.id, "Usage: <code>/approve ORDER_ID</code>");
        return;
      }
      const rows = (await sql`
        SELECT * FROM public.bot_orders WHERE order_id = ${orderId} LIMIT 1
      `) as BotOrderRow[];
      const order = rows[0];
      if (!order) {
        await sendText(cfg.botToken, user.id, "Order not found.");
        return;
      }
      if (order.status === "paid") {
        await sendText(cfg.botToken, user.id, "Already paid and delivered.");
        return;
      }
      await sql`UPDATE public.bot_orders SET status = 'pending' WHERE order_id = ${orderId}`;
      const refreshed = (await sql`
        SELECT * FROM public.bot_orders WHERE order_id = ${orderId} LIMIT 1
      `) as BotOrderRow[];
      const ok = await deliverOrder(sql, cfg, refreshed[0]!, null, `manual by ${user.id}`);
      await sendText(cfg.botToken, user.id, ok ? "✅ Delivered." : "❌ Key delivery failed.");
      return;
    }

    if (cmd === "/check" && isAdminUser(user.id, cfg)) {
      const orderId = (args[0] ?? "").trim();
      if (!orderId) {
        await sendText(cfg.botToken, user.id, "Usage: <code>/check ORDER_ID</code>");
        return;
      }
      const rows = (await sql`
        SELECT amount FROM public.bot_orders WHERE order_id = ${orderId} LIMIT 1
      `) as { amount: string }[];
      const expected = rows[0] ? Number(rows[0].amount) : cfg.singlePrice;
      const { data, payments, raw } = await fetchCashfreeOrderStatus(toCashfreeConfig(cfg), orderId);
      const { ok, txnId, status } = verifyCashfreePayment(data, payments, orderId, expected);
      const masked = cfg.cashfreeAppId ? raw.split(cfg.cashfreeAppId).join("***APP_ID***") : raw;
      await sendText(
        cfg.botToken,
        user.id,
        `status=${esc(status)} verified=${ok} txn=${esc(txnId ?? "none")}\n\n<blockquote expandable><pre>${esc(masked.slice(0, 3200))}</pre></blockquote>`,
      );
      return;
    }

    return;
  }

  // Interactive non-command input (custom bulk qty, seller link name, broadcast message)
  const uRow = await upsertBotUser(sql, user);
  const state = uRow.pending_state;
  if (!state) return;

  if (state === "bulk_custom_qty") {
    if (!/^\d+$/.test(text)) {
      await sendText(
        cfg.botToken,
        user.id,
        `⚠️ Please enter a valid number between <b>${cfg.bulkMin}</b> and <b>${cfg.bulkMax}</b>.`,
      );
      return;
    }
    const qty = Number(text);
    if (qty < cfg.bulkMin || qty > cfg.bulkMax) {
      await sendText(
        cfg.botToken,
        user.id,
        `⚠️ Quantity must be between <b>${cfg.bulkMin}</b> and <b>${cfg.bulkMax}</b> keys.`,
      );
      return;
    }
    await setBotUserState(sql, user.id, null, null);
    await sendPaymentQr(sql, cfg, user, qty);
    return;
  }

  if (!isAdminUser(user.id, cfg)) {
    await setBotUserState(sql, user.id, null, null);
    return;
  }

  if (state === "admin_price_single" || state === "admin_price_bulk") {
    if (!/^\d+$/.test(text)) {
      await sendText(
        cfg.botToken,
        user.id,
        "⚠️ Please send a valid whole number between <b>1</b> and <b>100000</b> (e.g. <code>99</code>).",
      );
      return;
    }
    const newVal = Math.round(Number(text));
    if (!Number.isFinite(newVal) || newVal < 1 || newVal > 100000) {
      await sendText(cfg.botToken, user.id, "⚠️ Price must be between ₹1 and ₹1,00,000.");
      return;
    }
    await setBotUserState(sql, user.id, null, null);
    const settingKey = state === "admin_price_single" ? "single_price" : "bulk_price";
    await sql`
      INSERT INTO public.app_settings (key, value, updated_at)
      VALUES (${settingKey}, ${String(newVal)}, now())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `;
    const updatedCfg = await getEffectiveBotConfig(sql);
    await logAuditEvent(sql, {
      eventType: "pricing_updated",
      actor: "admin",
      severity: "info",
      summary: `Bot admin updated ${settingKey} to ₹${newVal}`,
    });
    await sendText(
      cfg.botToken,
      user.id,
      `✅ <b>PRICING UPDATED INSTANTLY!</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `<blockquote>` +
        `⚡ <b>Single Key:</b> <b>${fmtInr(updatedCfg.singlePrice)}</b>\n` +
        `💎 <b>Bulk Key:</b> <b>${fmtInr(updatedCfg.bulkPrice)} / key</b> <i>(Save ${savePct(updatedCfg)}%)</i>` +
        `</blockquote>\n\n` +
        `🌐 <i>Updated live on both the Website and Telegram Bot.</i>`,
      {
        inline_keyboard: [
          [
            btnBlue("⚡ Edit Single", "adm:price_single"),
            btnBlue("💎 Edit Bulk", "adm:price_bulk"),
          ],
          [btnRed("❌ Back to Admin", "adm:home")],
        ],
      },
    );
    return;
  }

  if (state === "seller_link_name") {
    const cleanName = text.trim();
    if (cleanName.length < 2 || cleanName.length > 48) {
      await sendText(
        cfg.botToken,
        user.id,
        "⚠️ Please enter a link name between 2 and 48 characters.",
      );
      return;
    }
    await setBotUserState(sql, user.id, null, null);

    let code = "";
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = generateSellerCode();
      try {
        await sql`
          INSERT INTO public.bot_seller_links (code, name, created_by, is_active)
          VALUES (${candidate}, ${cleanName}, ${String(user.id)}::bigint, true)
        `;
        code = candidate;
        break;
      } catch (err) {
        if ((err as { code?: string })?.code === "23505") continue;
        throw err;
      }
    }

    const botUsername = await getBotUsername(cfg.botToken);
    const shareUrl = `https://t.me/${botUsername}?start=ref_${code}`;
    await sendText(
      cfg.botToken,
      user.id,
      `✅ <b>SELLER LINK CREATED!</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🏷️ <b>Name:</b> ${esc(cleanName)}\n` +
        `🔑 <b>Code:</b> <code>${code}</code>\n\n` +
        `🔗 <b>Shareable Seller Link:</b>\n` +
        `<blockquote><code>${esc(shareUrl)}</code></blockquote>\n\n` +
        `<i>All users who join and purchase through this link are tracked automatically under <b>${esc(cleanName)}</b>.</i>`,
      {
        inline_keyboard: [
          [btnCopyBlue("📋 Copy Seller Link", shareUrl)],
          [
            btnBlue("📊 View Link Stats", `adm:link_view:${code}`),
            btnBlue("➕ Create Another", "adm:link_new"),
          ],
          [btnRed("❌ Seller Links Menu", "adm:links")],
        ],
      },
    );
    return;
  }

  if (state === "broadcast_content") {
    await setBotUserState(sql, user.id, "broadcast_confirm", {
      bc_chat_id: msg.chat.id,
      bc_message_id: msg.message_id,
    });
    const cntRows = (await sql`SELECT COUNT(*)::int AS cnt FROM public.bot_users`) as {
      cnt: number;
    }[];
    const total = cntRows[0]?.cnt ?? 0;

    await sendText(
      cfg.botToken,
      user.id,
      `📢 <b>CONFIRM BROADCAST</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `<blockquote>The message above is ready to be sent to <b>${total.toLocaleString("en-IN")} users</b>.</blockquote>\n\n` +
        `Proceed now?`,
      {
        inline_keyboard: [
          [btnBlue(`🚀 Send to ${total.toLocaleString("en-IN")} Users`, "adm:bc_go")],
          [btnRed("❌ Cancel", "adm:home")],
        ],
      },
    );
  }
}

// ============================================================================
// Webhook Registration Helper (called from /zimadmin Settings!)
// ============================================================================
export async function registerTelegramWebhook(origin: string): Promise<{
  ok: boolean;
  webhookUrl: string;
  botUsername: string;
  error?: string;
}> {
  const cfg = getBotConfig();
  if (!cfg.botToken) {
    return {
      ok: false,
      webhookUrl: "",
      botUsername: "",
      error: "BOT_TOKEN is not set in Vercel environment variables.",
    };
  }

  const cleanOrigin = origin.replace(/\/+$/, "");
  if (!cleanOrigin.startsWith("https://")) {
    return {
      ok: false,
      webhookUrl: "",
      botUsername: "",
      error: "Telegram webhooks require an HTTPS URL (deploy on Vercel first).",
    };
  }

  const webhookUrl = `${cleanOrigin}/api/telegram/webhook`;
  const secretToken = await getWebhookSecretToken();

  const res = await tgApi(cfg.botToken, "setWebhook", {
    url: webhookUrl,
    secret_token: secretToken,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });

  if (!res.ok) {
    return {
      ok: false,
      webhookUrl,
      botUsername: "",
      error: res.description || "Telegram setWebhook failed.",
    };
  }

  const botUsername = await getBotUsername(cfg.botToken);
  if (botUsername) {
    try {
      const sql = await ensureNeonSchema();
      const botLink = `https://t.me/${botUsername}`;
      await sql`
        INSERT INTO public.app_settings (key, value, updated_at)
        VALUES ('buy_key_bot_url', ${botLink}, now())
        ON CONFLICT (key)
        DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
      `;
    } catch {
      // Non-fatal
    }
  }

  return { ok: true, webhookUrl, botUsername };
}

export async function getTelegramWebhookStatus(): Promise<{
  configured: boolean;
  cashfreeConfigured: boolean;
  webhookUrl: string;
  botUsername: string;
  pendingUpdates: number;
}> {
  const cfg = getBotConfig();
  const configured = Boolean(cfg.botToken);
  const cashfreeConfigured = isCashfreeConfigured(cfg);
  if (!configured) {
    return { configured, cashfreeConfigured, webhookUrl: "", botUsername: "", pendingUpdates: 0 };
  }

  const [wh, username] = await Promise.all([
    tgApi<{ url?: string; pending_update_count?: number }>(cfg.botToken, "getWebhookInfo"),
    getBotUsername(cfg.botToken),
  ]);

  return {
    configured,
    cashfreeConfigured,
    webhookUrl: wh.ok && wh.result?.url ? wh.result.url : "",
    botUsername: username,
    pendingUpdates: wh.ok ? (wh.result?.pending_update_count ?? 0) : 0,
  };
}


// ============================================================================
// Standalone Long-Polling Helpers (for Railway / Render / VPS)
// ============================================================================
export async function clearTelegramWebhook(dropPendingUpdates = false): Promise<{
  ok: boolean;
  botUsername: string;
  error?: string;
}> {
  const cfg = getBotConfig();
  if (!cfg.botToken) {
    return { ok: false, botUsername: "", error: "BOT_TOKEN is missing." };
  }

  const me = await tgApi<{ username?: string }>(cfg.botToken, "getMe");
  const botUsername = me.ok ? (me.result?.username ?? "") : "";
  if (botUsername) {
    cachedBotUsername = botUsername;
  }

  const delRes = await tgApi<boolean>(cfg.botToken, "deleteWebhook", {
    drop_pending_updates: dropPendingUpdates,
  });

  await tgApi(cfg.botToken, "setMyCommands", {
    commands: [
      { command: "start", description: "Open Store Menu" },
      { command: "buy", description: "Buy Access Keys" },
      { command: "myorders", description: "View Purchased Keys" },
      { command: "help", description: "How to Buy & Activate" },
      { command: "admin", description: "Admin Command Center" },
    ],
  });

  return {
    ok: delRes.ok,
    botUsername,
    error: delRes.ok ? undefined : delRes.description,
  };
}

export async function fetchTelegramUpdates(
  offset: number,
  timeoutSec = 25,
): Promise<(TelegramUpdate & { update_id: number })[]> {
  const cfg = getBotConfig();
  if (!cfg.botToken) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (timeoutSec + 10) * 1000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        offset,
        timeout: timeoutSec,
        allowed_updates: ["message", "callback_query"],
      }),
      signal: controller.signal,
    });
    const json = (await res.json()) as {
      ok?: boolean;
      result?: (TelegramUpdate & { update_id: number })[];
      description?: string;
    };
    if (!json.ok) {
      console.error("[telegram] getUpdates failed:", json.description ?? res.status);
      if (res.status === 409) {
        await delay(4_000);
      }
      return [];
    }
    return Array.isArray(json.result) ? json.result : [];
  } finally {
    clearTimeout(timer);
  }
}
