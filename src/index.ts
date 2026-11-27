import http from "node:http";
import { ensureNeonSchema } from "./db/neon.js";
import {
  closeCashfreeBrowser,
  renderCashfreeCheckoutHtml,
  verifyCashfreeWebhookSignature,
  type CashfreeEnv,
} from "./lib/cashfree.js";
import {
  clearTelegramWebhook,
  fetchTelegramUpdates,
  getBotConfig,
  getOrderCheckoutSession,
  handleCashfreeWebhookOrder,
  pollPendingBotOrders,
  processTelegramUpdate,
} from "./lib/telegram-bot.js";

const PORT = Number(process.env["PORT"] ?? "3000") || 3000;
const POLL_SECONDS = Math.max(3, Math.floor(Number(process.env["POLL_SECONDS"] ?? "5") || 5));

let shuttingDown = false;
let pollBusy = false;
let lastPollSummary = { checked: 0, delivered: 0, expired: 0, at: "" };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function readRawBody(req: http.IncomingMessage, maxBytes = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function extractWebhookOrderId(payload: Record<string, unknown>): string {
  const data =
    payload["data"] && typeof payload["data"] === "object"
      ? (payload["data"] as Record<string, unknown>)
      : null;
  const order =
    data?.["order"] && typeof data["order"] === "object"
      ? (data["order"] as Record<string, unknown>)
      : null;
  const oid = order?.["order_id"] ?? data?.["order_id"] ?? payload["order_id"];
  return typeof oid === "string" ? oid.trim() : "";
}

async function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const parsedUrl = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const pathname = parsedUrl.pathname;

  // 1. Railway Healthcheck
  if ((pathname === "/" || pathname === "/health") && method === "GET") {
    const cfg = getBotConfig();
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "zimbola-telegram-bot",
        mode: "long-polling",
        gateway: "cashfree",
        cashfreeEnv: cfg.cashfreeEnv,
        cashfreeQrMode: cfg.cashfreeQrMode,
        pollSeconds: POLL_SECONDS,
        lastPoll: lastPollSummary,
      }),
    );
    return;
  }

  // 2. Internal loopback-only launcher used by Playwright to render Cashfree's official UPI QR
  if (pathname === "/internal/cf-checkout" && method === "GET") {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }
    const session = (parsedUrl.searchParams.get("session") ?? "").trim();
    const envParam = (parsedUrl.searchParams.get("env") ?? "PROD").trim().toUpperCase();
    const env: CashfreeEnv = envParam === "SANDBOX" ? "SANDBOX" : "PROD";
    if (!session) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Missing session");
      return;
    }
    const html = renderCashfreeCheckoutHtml(session, env);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(html);
    return;
  }

  // 3. Public Cashfree checkout fallback page (/pay/:orderId)
  if (pathname.startsWith("/pay/") && method === "GET") {
    const orderId = decodeURIComponent(pathname.slice(5)).trim();
    const cfg = getBotConfig();
    const info = await getOrderCheckoutSession(orderId);
    if (!info) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end("<h3>Order not found or expired. Please create a new order in Telegram.</h3>");
      return;
    }
    if (info.status === "paid") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<h3>Payment already received! Return to Telegram for your access key.</h3>");
      return;
    }
    const html = renderCashfreeCheckoutHtml(
      info.paymentSessionId,
      cfg.cashfreeEnv,
      orderId,
      info.amount,
    );
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(html);
    return;
  }

  // 4. Cashfree Payment Webhook (1-2s instant key delivery)
  if (pathname === "/cashfree-webhook") {
    if (method === "GET") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, endpoint: "cashfree-webhook" }));
      return;
    }
    if (method === "POST") {
      const cfg = getBotConfig();
      const rawBody = await readRawBody(req);
      const timestamp = String(req.headers["x-webhook-timestamp"] ?? "");
      const signature = String(req.headers["x-webhook-signature"] ?? "");

      if (
        cfg.cashfreeSecretKey &&
        signature &&
        !verifyCashfreeWebhookSignature(cfg.cashfreeSecretKey, rawBody, timestamp, signature)
      ) {
        console.warn("[webhook] Rejected Cashfree webhook with invalid HMAC signature");
        res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "Invalid signature" }));
        return;
      }

      let payload: Record<string, unknown> | null = null;
      try {
        payload = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        payload = null;
      }

      const orderId = payload ? extractWebhookOrderId(payload) : "";
      if (orderId) {
        // Trigger verification & instant delivery asynchronously so Cashfree gets fast 200 OK
        void handleCashfreeWebhookOrder(orderId)
          .then((r) => {
            if (r.delivered) {
              console.log(`[webhook] Delivered order ${orderId} via Cashfree webhook`);
            }
          })
          .catch((err) => {
            console.error(
              "[webhook] Processing error:",
              err instanceof Error ? err.message : String(err),
            );
          });
      }

      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, received: true }));
      return;
    }
  }

  res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, error: "Not Found" }));
}

const server = http.createServer((req, res) => {
  void handleHttpRequest(req, res).catch((err) => {
    console.error("[http] Request error:", err instanceof Error ? err.message : String(err));
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "Internal Server Error" }));
    }
  });
});

async function runPaymentPollerLoop(): Promise<void> {
  console.log(`[poller] Started automatic Cashfree payment poller (every ${POLL_SECONDS}s)`);
  while (!shuttingDown) {
    if (!pollBusy) {
      pollBusy = true;
      try {
        const res = await pollPendingBotOrders();
        lastPollSummary = { ...res, at: new Date().toISOString() };
        if (res.delivered > 0 || res.expired > 0) {
          console.log(
            `[poller] checked=${res.checked} delivered=${res.delivered} expired=${res.expired}`,
          );
        }
      } catch (err) {
        console.error("[poller] Error:", err instanceof Error ? err.message : String(err));
      } finally {
        pollBusy = false;
      }
    }
    await sleep(POLL_SECONDS * 1000);
  }
}

async function runTelegramUpdateLoop(): Promise<void> {
  let offset = 0;
  console.log("[bot] Listening for Telegram updates via long-polling...");

  while (!shuttingDown) {
    try {
      const updates = await fetchTelegramUpdates(offset, 25);
      for (const update of updates) {
        if (typeof update.update_id === "number" && update.update_id >= offset) {
          offset = update.update_id + 1;
        }
        void processTelegramUpdate(update).catch((err) => {
          console.error(
            "[bot] Update handler error:",
            err instanceof Error ? err.message : String(err),
          );
        });
      }
    } catch (err) {
      if (!shuttingDown) {
        console.error(
          "[bot] Polling loop error (retrying in 3s):",
          err instanceof Error ? err.message : String(err),
        );
        await sleep(3_000);
      }
    }
  }
}

async function main(): Promise<void> {
  const cfg = getBotConfig();
  if (!cfg.botToken) {
    console.error("[fatal] BOT_TOKEN environment variable is missing!");
    process.exit(1);
  }
  if (!process.env["DATABASE_URL"]?.trim()) {
    console.error("[fatal] DATABASE_URL environment variable is missing!");
    process.exit(1);
  }
  if (!process.env["ACCESS_SESSION_SECRET"]?.trim()) {
    console.error(
      "[fatal] ACCESS_SESSION_SECRET environment variable is missing (must match Website env)!",
    );
    process.exit(1);
  }
  if (!cfg.cashfreeAppId || !cfg.cashfreeSecretKey) {
    console.warn(
      "[warn] CASHFREE_APP_ID or CASHFREE_SECRET_KEY is missing. Set them in Railway Variables to enable payments.",
    );
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(
      `[http] Server listening on port ${PORT} (Cashfree ${cfg.cashfreeEnv}, QR mode=${cfg.cashfreeQrMode})`,
    );
    if (cfg.publicBaseUrl) {
      console.log(`[http] Cashfree webhook URL: ${cfg.publicBaseUrl}/cashfree-webhook`);
    }
  });

  await ensureNeonSchema();
  console.log("[db] Neon PostgreSQL schema verified.");

  const hook = await clearTelegramWebhook(false);
  console.log(
    `[bot] Connected as @${hook.botUsername || "unknown"} (old webhook cleared=${hook.ok})`,
  );

  void runPaymentPollerLoop();
  await runTelegramUpdateLoop();
}

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[bot] Received ${signal}, shutting down cleanly...`);
  void closeCashfreeBrowser().finally(() => {
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((err) => {
  console.error("[fatal] Startup failed:", err);
  process.exit(1);
});
