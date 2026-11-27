import { createHmac, timingSafeEqual } from "node:crypto";
import { toBuffer as qrToBuffer } from "qrcode";
import { chromium, type Browser, type Frame, type Page, type Response } from "playwright";

export type CashfreeEnv = "PROD" | "SANDBOX";
export type CashfreeQrMode = "auto" | "direct" | "playwright" | "checkout";

export type CashfreeConfig = {
  appId: string;
  secretKey: string;
  env: CashfreeEnv;
  qrMode: CashfreeQrMode;
  localPort: number;
  publicBaseUrl: string;
  whitelistedOrigin: string;
};

export type CashfreeOrderCreateResult = {
  ok: boolean;
  paymentSessionId: string | null;
  cfOrderId: string | null;
  error?: string;
  raw?: string;
};

export type CashfreeQrCaptureResult = {
  ok: boolean;
  qrPng: Uint8Array | null;
  method: "s2s" | "playwright" | "checkout" | "failed";
  paymentSessionId: string | null;
  cfOrderId: string | null;
  checkoutUrl: string | null;
  error?: string;
};

const CF_API_VERSION = "2023-08-01";
const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// If Cashfree reports S2S not enabled yet, skip direct S2S attempts for 10 mins
// in "auto" mode so every order goes straight to fast Playwright QR capture.
// Once Cashfree approves the S2S ticket, auto mode automatically upgrades within 10 mins.
let s2sBlockedUntilMs = 0;

// Singleton pooled Chromium browser with idle auto-close + concurrency queue
let browserInstance: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;
let browserIdleTimer: ReturnType<typeof setTimeout> | null = null;
let activeCaptures = 0;
const captureWaiters: (() => void)[] = [];
const MAX_CONCURRENT_CAPTURES = 2;
const BROWSER_IDLE_CLOSE_MS = 5 * 60 * 1000;

export function getCashfreeApiBase(env: CashfreeEnv): string {
  return env === "SANDBOX"
    ? "https://sandbox.cashfree.com/pg"
    : "https://api.cashfree.com/pg";
}

function cashfreeHeaders(cf: CashfreeConfig): Record<string, string> {
  return {
    "x-client-id": cf.appId,
    "x-client-secret": cf.secretKey,
    "x-api-version": CF_API_VERSION,
    "content-type": "application/json",
    accept: "application/json",
  };
}

function decodeBase64DataUrlToPng(dataUrl: string): Uint8Array | null {
  const m = dataUrl.match(/^data:image\/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m || !m[1]) return null;
  try {
    const buf = Buffer.from(m[1].replace(/\s+/g, ""), "base64");
    if (buf.length < 250) return null;
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch {
    return null;
  }
}

export async function renderUpiUriToPng(upiUri: string): Promise<Uint8Array> {
  const buf = await qrToBuffer(upiUri, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 3,
    width: 480,
    color: { dark: "#111111", light: "#FFFFFF" },
  });
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function extractQrCandidateFromUnknown(
  node: unknown,
  depth = 0,
): { dataUrl?: string; upiUri?: string } | null {
  if (depth > 8 || node === null || node === undefined) return null;

  if (typeof node === "string") {
    const s = node.trim();
    if (/^data:image\/png;base64,[A-Za-z0-9+/=\s]{300,}$/i.test(s)) {
      return { dataUrl: s };
    }
    if (/^upi:\/\/pay\?/i.test(s) && s.includes("pa=")) {
      return { upiUri: s };
    }
    return null;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = extractQrCandidateFromUnknown(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node === "object") {
    const rec = node as Record<string, unknown>;
    const priorityKeys = [
      "qrcode",
      "qr_code",
      "qrCode",
      "qrImage",
      "qr_image",
      "default",
      "upi_uri",
      "upiUri",
      "bhim",
      "payload",
      "data",
    ];
    for (const k of priorityKeys) {
      if (k in rec) {
        const found = extractQrCandidateFromUnknown(rec[k], depth + 1);
        if (found) return found;
      }
    }
    for (const [k, v] of Object.entries(rec)) {
      if (priorityKeys.includes(k)) continue;
      const found = extractQrCandidateFromUnknown(v, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

// ============================================================================
// 1. Create Cashfree Order (POST /pg/orders)
// ============================================================================
export async function createCashfreeOrder(
  cf: CashfreeConfig,
  params: {
    orderId: string;
    amount: number;
    customerId: string;
    customerName: string;
    orderNote?: string;
  },
): Promise<CashfreeOrderCreateResult> {
  const base = getCashfreeApiBase(cf.env);
  const cleanedName = params.customerName
    .normalize("NFKD")
    .replace(/[^A-Za-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50);
  const safeName = /^[A-Za-z][A-Za-z ]{1,49}$/.test(cleanedName)
    ? cleanedName
    : "Store Customer";
  const safeCustId =
    params.customerId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 45) || "tg_user";
  const safeEmailLocal = safeCustId.toLowerCase().replace(/[^a-z0-9]/g, "") || "customer";
  const safeNote =
    (params.orderNote ?? "Digital Store Order")
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9 .,-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180) || "Digital Store Order";

  const basePayload: Record<string, unknown> = {
    order_id: params.orderId,
    order_amount: Number(params.amount.toFixed(2)),
    order_currency: "INR",
    order_note: safeNote,
    customer_details: {
      customer_id: safeCustId,
      customer_name: safeName,
      customer_email: `${safeEmailLocal}@example.com`,
      customer_phone: "9999999999",
    },
  };

  const orderMeta: Record<string, string> = {
    payment_methods: "upi",
  };
  if (cf.publicBaseUrl && cf.publicBaseUrl.startsWith("https://")) {
    orderMeta["notify_url"] = `${cf.publicBaseUrl}/cashfree-webhook`;
  }

  const attempts: Record<string, unknown>[] = [
    { ...basePayload, order_meta: orderMeta },
    basePayload,
  ];

  let lastErr = "Order creation failed";
  let lastRaw = "";

  for (const payload of attempts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(`${base}/orders`, {
        method: "POST",
        headers: cashfreeHeaders(cf),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const txt = await res.text();
      lastRaw = `${res.status} ${txt.slice(0, 500)}`;
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(txt) as Record<string, unknown>;
      } catch {
        json = null;
      }

      if (res.ok && json && typeof json["payment_session_id"] === "string") {
        return {
          ok: true,
          paymentSessionId: json["payment_session_id"],
          cfOrderId: json["cf_order_id"] ? String(json["cf_order_id"]) : null,
          raw: lastRaw,
        };
      }

      lastErr =
        (json && typeof json["message"] === "string" ? json["message"] : null) ??
        `HTTP ${res.status}`;

      if (res.status >= 400 && res.status < 500 && payload["order_meta"]) {
        continue;
      }
      break;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      break;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false,
    paymentSessionId: null,
    cfOrderId: null,
    error: lastErr,
    raw: lastRaw,
  };
}

// ============================================================================
// 2. Direct Cashfree S2S UPI QR (POST /pg/orders/sessions)
// ============================================================================
async function tryDirectS2sQr(
  cf: CashfreeConfig,
  paymentSessionId: string,
  respectCooldown: boolean,
): Promise<{ png: Uint8Array | null; blocked: boolean; error?: string }> {
  if (respectCooldown && Date.now() < s2sBlockedUntilMs) {
    return { png: null, blocked: true };
  }

  const base = getCashfreeApiBase(cf.env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  try {
    const res = await fetch(`${base}/orders/sessions`, {
      method: "POST",
      headers: {
        "x-api-version": CF_API_VERSION,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        payment_session_id: paymentSessionId,
        payment_method: {
          upi: { channel: "qrcode" },
        },
      }),
      signal: controller.signal,
    });
    const txt = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(txt) as Record<string, unknown>;
    } catch {
      json = null;
    }

    if (res.ok && json) {
      const candidate = extractQrCandidateFromUnknown(json);
      if (candidate?.dataUrl) {
        const png = decodeBase64DataUrlToPng(candidate.dataUrl);
        if (png) {
          s2sBlockedUntilMs = 0;
          return { png, blocked: false };
        }
      }
      if (candidate?.upiUri) {
        const png = await renderUpiUriToPng(candidate.upiUri);
        s2sBlockedUntilMs = 0;
        return { png, blocked: false };
      }
    }

    const code = json && typeof json["code"] === "string" ? json["code"] : "";
    const type = json && typeof json["type"] === "string" ? json["type"] : "";
    if (
      code.includes("s2s_enabled_not_approved") ||
      code.includes("not_approved") ||
      type === "feature_not_enabled"
    ) {
      s2sBlockedUntilMs = Date.now() + 10 * 60 * 1000;
      return { png: null, blocked: true, error: code || type };
    }

    return {
      png: null,
      blocked: false,
      error: json && typeof json["message"] === "string" ? json["message"] : `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      png: null,
      blocked: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// 3. Headless Chromium QR Capture (Playwright Pooled Instance)
// ============================================================================
function resetBrowserIdleTimer(): void {
  if (browserIdleTimer) {
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
  }
  if (activeCaptures === 0 && browserInstance) {
    browserIdleTimer = setTimeout(() => {
      if (activeCaptures === 0) {
        void closeCashfreeBrowser();
      }
    }, BROWSER_IDLE_CLOSE_MS);
    browserIdleTimer.unref();
  }
}

async function getSharedBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }
  if (!browserLaunchPromise) {
    browserLaunchPromise = chromium
      .launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-extensions",
          "--disable-background-networking",
          "--no-first-run",
        ],
      })
      .then((b) => {
        browserInstance = b;
        b.on("disconnected", () => {
          if (browserInstance === b) browserInstance = null;
        });
        return b;
      })
      .finally(() => {
        browserLaunchPromise = null;
      });
  }
  return browserLaunchPromise;
}

export async function closeCashfreeBrowser(): Promise<void> {
  if (browserIdleTimer) {
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
  }
  const b = browserInstance;
  browserInstance = null;
  if (b) {
    try {
      await b.close();
    } catch {
      // ignore close errors
    }
  }
}

async function acquireCaptureSlot(): Promise<void> {
  if (activeCaptures < MAX_CONCURRENT_CAPTURES) {
    activeCaptures += 1;
    if (browserIdleTimer) {
      clearTimeout(browserIdleTimer);
      browserIdleTimer = null;
    }
    return;
  }
  await new Promise<void>((resolve) => {
    captureWaiters.push(resolve);
  });
  activeCaptures += 1;
  if (browserIdleTimer) {
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
  }
}

function releaseCaptureSlot(): void {
  activeCaptures = Math.max(0, activeCaptures - 1);
  const next = captureWaiters.shift();
  if (next) {
    next();
  } else {
    resetBrowserIdleTimer();
  }
}

async function verifyPngIsRealQr(page: Page, pngBytes: Uint8Array): Promise<boolean> {
  try {
    const b64 = Buffer.from(
      pngBytes.buffer,
      pngBytes.byteOffset,
      pngBytes.byteLength,
    ).toString("base64");
    const dataUrl = `data:image/png;base64,${b64}`;
    return await page.evaluate(async (url: string) => {
      return await new Promise<boolean>((resolve) => {
        const img = new Image();
        img.onload = () => {
          try {
            const size = 120;
            const c = document.createElement("canvas");
            c.width = size;
            c.height = size;
            const ctx = c.getContext("2d");
            if (!ctx) {
              resolve(false);
              return;
            }
            ctx.fillStyle = "#FFFFFF";
            ctx.fillRect(0, 0, size, size);
            ctx.drawImage(img, 0, 0, size, size);
            const data = ctx.getImageData(0, 0, size, size).data;
            let dark = 0;
            let light = 0;
            let colored = 0;
            const total = size * size;
            for (let i = 0; i < data.length; i += 4) {
              const r = data[i] ?? 255;
              const g = data[i + 1] ?? 255;
              const b = data[i + 2] ?? 255;
              if (r < 95 && g < 95 && b < 95) dark += 1;
              if (r > 195 && g > 195 && b > 195) light += 1;
              if (Math.max(r, g, b) - Math.min(r, g, b) > 50) colored += 1;
            }
            const darkRatio = dark / total;
            const lightRatio = light / total;
            const coloredRatio = colored / total;
            resolve(darkRatio >= 0.08 && lightRatio >= 0.22 && coloredRatio <= 0.14);
          } catch {
            resolve(false);
          }
        };
        img.onerror = () => resolve(false);
        img.src = url;
      });
    }, dataUrl);
  } catch {
    return false;
  }
}

async function extractQrDataUrlFromFrame(frame: Frame): Promise<string | null> {
  try {
    return await frame.evaluate(() => {
      const isQrSize = (w: number, h: number): boolean =>
        w >= 105 && w <= 560 && h >= 105 && h <= 560 && Math.abs(w - h) <= 32;

      const isPlaceholderHint = (hint: string): boolean =>
        /(placeholder|blur|dummy|mask|preview|sample|click|skeleton|shimmer|banner|overlay)/i.test(hint);

      const isRealQrPixels = (source: HTMLImageElement | HTMLCanvasElement): boolean => {
        try {
          const size = 120;
          const c = document.createElement("canvas");
          c.width = size;
          c.height = size;
          const ctx = c.getContext("2d");
          if (!ctx) return false;
          ctx.fillStyle = "#FFFFFF";
          ctx.fillRect(0, 0, size, size);
          ctx.drawImage(source, 0, 0, size, size);
          const data = ctx.getImageData(0, 0, size, size).data;
          let dark = 0;
          let light = 0;
          let colored = 0;
          const total = size * size;
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i] ?? 255;
            const g = data[i + 1] ?? 255;
            const b = data[i + 2] ?? 255;
            if (r < 95 && g < 95 && b < 95) dark += 1;
            if (r > 195 && g > 195 && b > 195) light += 1;
            if (Math.max(r, g, b) - Math.min(r, g, b) > 50) colored += 1;
          }
          const darkRatio = dark / total;
          const lightRatio = light / total;
          const coloredRatio = colored / total;
          return darkRatio >= 0.08 && lightRatio >= 0.22 && coloredRatio <= 0.14;
        } catch {
          return false;
        }
      };

      const renderPaddedPng = (source: HTMLImageElement | HTMLCanvasElement, baseW: number, baseH: number): string | null => {
        try {
          const targetW = Math.max(360, baseW);
          const targetH = Math.max(360, baseH);
          const pad = 28;
          const c = document.createElement("canvas");
          c.width = targetW + pad * 2;
          c.height = targetH + pad * 2;
          const ctx = c.getContext("2d");
          if (!ctx) return null;
          ctx.fillStyle = "#FFFFFF";
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(source, pad, pad, targetW, targetH);
          const out = c.toDataURL("image/png");
          return out.length > 1500 ? out : null;
        } catch {
          return null;
        }
      };

      const imgs = Array.from(document.querySelectorAll("img"));
      for (const img of imgs) {
        const rect = img.getBoundingClientRect();
        if (!isQrSize(rect.width, rect.height)) continue;
        if (!img.complete || img.naturalWidth < 100) continue;
        const src = (img.getAttribute("src") || "").trim();
        const hint = `${img.alt || ""} ${img.className || ""} ${img.id || ""} ${src}`.toLowerCase();
        if (isPlaceholderHint(hint)) continue;

        // Only accept real high-contrast QR images (rejects blurred grey/purple "Click to see QR" placeholders)
        if (!isRealQrPixels(img)) continue;
        const padded = renderPaddedPng(img, img.naturalWidth, img.naturalHeight);
        if (padded) return padded;
        if (/^data:image\/png;base64,[A-Za-z0-9+/=\s]{300,}$/i.test(src)) {
          return src;
        }
      }

      const canvases = Array.from(document.querySelectorAll("canvas"));
      for (const canvas of canvases) {
        const rect = canvas.getBoundingClientRect();
        if (!isQrSize(rect.width, rect.height)) continue;
        if (canvas.width < 100 || canvas.height < 100) continue;
        if (!isRealQrPixels(canvas)) continue;
        const padded = renderPaddedPng(canvas, canvas.width, canvas.height);
        if (padded) return padded;
      }

      return null;
    });
  } catch {
    return null;
  }
}

async function screenshotQrElementFromFrame(frame: Frame): Promise<Uint8Array | null> {
  try {
    const selector = await frame.evaluate(() => {
      const isQrSize = (w: number, h: number): boolean =>
        w >= 110 && w <= 560 && h >= 110 && h <= 560 && Math.abs(w - h) <= 32;

      const isPlaceholderHint = (hint: string): boolean =>
        /(placeholder|blur|dummy|mask|preview|sample|click|skeleton|shimmer|banner|overlay)/i.test(hint);

      // Clear any previous target marker
      document.querySelectorAll("[data-zimbola-qr-target]").forEach((el) => {
        el.removeAttribute("data-zimbola-qr-target");
      });

      const svgs = Array.from(document.querySelectorAll("svg"));
      for (let i = 0; i < svgs.length; i += 1) {
        const svg = svgs[i];
        if (!svg) continue;
        const rect = svg.getBoundingClientRect();
        if (!isQrSize(rect.width, rect.height)) continue;
        const primitives = svg.querySelectorAll("path, rect").length;
        const pathDataLen = Array.from(svg.querySelectorAll("path")).reduce(
          (sum, p) => sum + (p.getAttribute("d")?.length ?? 0),
          0,
        );
        if (primitives >= 24 || pathDataLen >= 600) {
          svg.setAttribute("data-zimbola-qr-target", "1");
          return 'svg[data-zimbola-qr-target="1"]';
        }
      }

      const imgs = Array.from(document.querySelectorAll("img"));
      for (const img of imgs) {
        const rect = img.getBoundingClientRect();
        if (!isQrSize(rect.width, rect.height)) continue;
        const src = (img.getAttribute("src") || "").trim();
        const hint = `${img.alt || ""} ${img.className || ""} ${img.id || ""} ${src}`.toLowerCase();
        if (isPlaceholderHint(hint)) continue;
        if (src.startsWith("data:image/") || src.startsWith("blob:") || hint.includes("qr")) {
          img.setAttribute("data-zimbola-qr-target", "1");
          return 'img[data-zimbola-qr-target="1"]';
        }
      }

      return null;
    });

    if (!selector) return null;
    const loc = frame.locator(selector).first();
    const buf = await loc.screenshot({ type: "png", timeout: 4_000 });
    if (buf.length > 500) {
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
  } catch {
    // ignore transient DOM detach
  }
  return null;
}

async function tryClickQrTriggerInFrame(
  frame: Frame,
  clickHistory: Map<string, { count: number; lastAt: number }>,
  allowBroadUpi: boolean,
): Promise<boolean> {
  try {
    const now = Date.now();
    const blockedKeys: string[] = [];
    for (const [k, info] of clickHistory.entries()) {
      // Allow retrying reveal/placeholder clicks up to 3 times (spaced >= 1.5s) in case React was still hydrating
      const isReveal = k.includes("see qr") || k.includes("show qr") || k.includes("placeholder");
      if (isReveal) {
        if (info.count >= 3 || now - info.lastAt < 1_500) blockedKeys.push(k);
      } else if (info.count >= 1) {
        blockedKeys.push(k);
      }
    }

    const foundKey = await frame.evaluate(
      ({ blocked, broad }: { blocked: string[]; broad: boolean }) => {
        const blockedSet = new Set(blocked);
        document.querySelectorAll("[data-zimbola-click]").forEach((el) => {
          el.removeAttribute("data-zimbola-click");
        });

        const revealRe =
          /(click\s*to\s*see\s*qr|tap\s*to\s*see\s*qr|see\s*qr|show\s*qr|generate\s*qr|view\s*qr|reveal\s*qr|load\s*qr)/i;
        const secondaryRe =
          /(upi\s*qr|scan\s*(?:&|and)?\s*pay|pay\s*(?:by|via|with)\s*qr|qr\s*code)/i;
        const broadRe = /^(upi|upi\s*\/\s*qr|upi\s*id\s*\/\s*qr|pay\s*(?:via|with)\s*upi)$/i;

        const candidates = Array.from(
          document.querySelectorAll("button, a, [role='button'], [role='tab'], div, span, label, p"),
        );

        const markTextMatch = (re: RegExp): string | null => {
          for (const el of candidates) {
            const htmlEl = el as HTMLElement;
            const text = (htmlEl.innerText || htmlEl.textContent || "").replace(/\s+/g, " ").trim();
            if (!text || text.length > 48) continue;
            if (!re.test(text)) continue;
            const key = `txt:${text.toLowerCase()}`;
            if (blockedSet.has(key)) continue;
            const rect = htmlEl.getBoundingClientRect();
            if (rect.width < 20 || rect.height < 14 || rect.width > 650 || rect.height > 180) continue;
            const childMatch = Array.from(htmlEl.children).some((ch) => {
              const ct = ((ch as HTMLElement).innerText || ch.textContent || "").replace(/\s+/g, " ").trim();
              return ct.length > 0 && ct.length <= 48 && re.test(ct);
            });
            if (childMatch) continue;
            htmlEl.setAttribute("data-zimbola-click", "1");
            return key;
          }
          return null;
        };

        // 1. Highest priority: explicit "Click to see QR" / "Show QR" text buttons
        const r1 = markTextMatch(revealRe);
        if (r1) return r1;

        // 2. Placeholder QR <img> (e.g. baked-in "Click to see QR" graphic with no HTML text)
        const imgs = Array.from(document.querySelectorAll("img"));
        for (let i = 0; i < imgs.length; i += 1) {
          const img = imgs[i];
          if (!img) continue;
          const rect = img.getBoundingClientRect();
          if (rect.width < 85 || rect.height < 85 || rect.width > 560 || rect.height > 560) continue;
          const src = (img.getAttribute("src") || "").trim();
          const hint = `${img.alt || ""} ${img.className || ""} ${img.id || ""} ${src}`.toLowerCase();
          const looksLikeQrImg =
            hint.includes("qr") ||
            hint.includes("placeholder") ||
            hint.includes("blur") ||
            hint.includes("click");
          if (!looksLikeQrImg) continue;

          // Check if it looks like a placeholder (non-black/colored or remote static asset)
          let isRealBlackWhite = false;
          try {
            if (img.complete && img.naturalWidth >= 100) {
              const c = document.createElement("canvas");
              c.width = 90;
              c.height = 90;
              const ctx = c.getContext("2d");
              if (ctx) {
                ctx.fillStyle = "#FFFFFF";
                ctx.fillRect(0, 0, 90, 90);
                ctx.drawImage(img, 0, 0, 90, 90);
                const d = ctx.getImageData(0, 0, 90, 90).data;
                let dark = 0;
                let colored = 0;
                const total = 90 * 90;
                for (let p = 0; p < d.length; p += 4) {
                  const r = d[p] ?? 255;
                  const g = d[p + 1] ?? 255;
                  const b = d[p + 2] ?? 255;
                  if (r < 95 && g < 95 && b < 95) dark += 1;
                  if (Math.max(r, g, b) - Math.min(r, g, b) > 50) colored += 1;
                }
                isRealBlackWhite = dark / total >= 0.08 && colored / total <= 0.14;
              }
            }
          } catch {
            // Cross-origin static PNG asset -> very likely the "Click to see QR" placeholder image!
            isRealBlackWhite = false;
          }

          if (!isRealBlackWhite) {
            const key = `img:placeholder_${i}`;
            if (blockedSet.has(key)) continue;
            img.setAttribute("data-zimbola-click", "1");
            return key;
          }
        }

        // 3. Secondary QR triggers ("UPI QR", "Scan & Pay", etc.)
        const r2 = markTextMatch(secondaryRe);
        if (r2) return r2;

        // 4. Broad UPI tab fallback
        if (broad) {
          return markTextMatch(broadRe);
        }
        return null;
      },
      { blocked: blockedKeys, broad: allowBroadUpi },
    );

    if (!foundKey) return false;

    const prev = clickHistory.get(foundKey) ?? { count: 0, lastAt: 0 };
    clickHistory.set(foundKey, { count: prev.count + 1, lastAt: Date.now() });

    // Perform a real Playwright pointer click so React/Cashfree event listeners fire reliably
    try {
      await frame.locator('[data-zimbola-click="1"]').first().click({ force: true, timeout: 2_500 });
    } catch {
      // Fallback to DOM .click() if locator moved
      await frame
        .evaluate(() => {
          const el = document.querySelector('[data-zimbola-click="1"]') as HTMLElement | null;
          el?.click();
        })
        .catch(() => {});
    }

    console.log(`[cashfree-qr] Clicked trigger: ${foundKey}`);
    return true;
  } catch {
    // frame navigated or cross-origin error
  }
  return false;
}

async function captureCashfreeQrViaPlaywright(
  cf: CashfreeConfig,
  paymentSessionId: string,
): Promise<Uint8Array | null> {
  await acquireCaptureSlot();
  let page: Page | null = null;
  let context: Awaited<ReturnType<Browser["newContext"]>> | null = null;

  try {
    const browser = await getSharedBrowser();
    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: DESKTOP_CHROME_UA,
      locale: "en-IN",
      timezoneId: "Asia/Kolkata",
    });

    page = await context.newPage();

    let sniffedPng: Uint8Array | null = null;
    let sniffedUpiUri: string | null = null;

    const onResponse = async (res: Response): Promise<void> => {
      if (sniffedUpiUri) return;
      const url = res.url();
      if (!url.includes("cashfree.com") && !url.includes("cashfree.net")) return;
      const status = res.status();
      if (status < 200 || status >= 300) return;

      // Never sniff static asset files (like Cashfree's "Click to see QR" placeholder PNG)
      const lowerUrl = url.toLowerCase();
      if (/\.(?:png|jpe?g|webp|gif|svg|css|js|woff2?|ico)(?:\?|$)/i.test(lowerUrl)) {
        return;
      }

      const method = res.request().method().toUpperCase();
      const ct = (res.headers()["content-type"] ?? "").toLowerCase();
      if (!ct.includes("application/json") && !ct.includes("text/plain")) {
        return;
      }
      const looksLikePaymentApi =
        method === "POST" ||
        lowerUrl.includes("/order") ||
        lowerUrl.includes("/session") ||
        lowerUrl.includes("/pay") ||
        lowerUrl.includes("/upi") ||
        lowerUrl.includes("/qr");
      if (!looksLikePaymentApi) return;

      try {
        const text = await res.text();
        if (
          !text.includes("qrcode") &&
          !text.includes("qr_code") &&
          !text.includes("qrCode") &&
          !text.includes("upi://pay") &&
          !text.includes("data:image/png")
        ) {
          return;
        }
        try {
          const parsed = JSON.parse(text) as unknown;
          const candidate = extractQrCandidateFromUnknown(parsed);
          if (candidate?.upiUri) {
            sniffedUpiUri = candidate.upiUri;
            console.log(`[cashfree-qr] Captured signed UPI URI from API: ${url.split("?")[0]}`);
          } else if (candidate?.dataUrl && !sniffedPng) {
            const png = decodeBase64DataUrlToPng(candidate.dataUrl);
            if (png) {
              sniffedPng = png;
              console.log(`[cashfree-qr] Captured QR PNG from API: ${url.split("?")[0]}`);
            }
          }
        } catch {
          const m = text.match(/upi:\/\/pay\?[^"'\s\\]+/i);
          if (m && m[0] && m[0].includes("pa=")) {
            sniffedUpiUri = m[0];
            console.log(`[cashfree-qr] Captured UPI URI (regex) from API: ${url.split("?")[0]}`);
          }
        }
      } catch {
        // ignore preflight/redirect body errors
      }
    };

    page.on("response", (res) => {
      void onResponse(res);
    });

    // Launch Cashfree Checkout SDK from the merchant's ALREADY-WHITELISTED origin
    // (intercepted locally via page.route so no external server change is needed).
    // Falls back to local loopback launcher if CASHFREE_WHITELISTED_URL is not set.
    let launchUrl = `http://127.0.0.1:${cf.localPort}/internal/cf-checkout?session=${encodeURIComponent(paymentSessionId)}&env=${encodeURIComponent(cf.env)}`;
    if (cf.whitelistedOrigin) {
      try {
        const origin = new URL(cf.whitelistedOrigin).origin;
        launchUrl = `${origin}/__cf_checkout_launch`;
        const html = renderCashfreeCheckoutHtml(paymentSessionId, cf.env);
        await page.route(launchUrl, async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "text/html; charset=utf-8",
            body: html,
          });
        });
      } catch (err) {
        console.warn(
          "[cashfree-qr] Invalid CASHFREE_WHITELISTED_URL, using local launcher:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    await page.goto(launchUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });

    const deadline = Date.now() + 22_000;
    const startMs = Date.now();
    const clickHistory = new Map<string, { count: number; lastAt: number }>();
    let domainBlockedLogged = false;

    while (Date.now() < deadline) {
      // 1. Best source: signed upi://pay?... URI directly from Cashfree's payment API
      if (sniffedUpiUri) {
        return await renderUpiUriToPng(sniffedUpiUri);
      }

      // 2. Second best: base64 QR PNG from Cashfree's payment API (validated as real black-and-white QR)
      if (sniffedPng) {
        const valid = await verifyPngIsRealQr(page, sniffedPng);
        if (valid) return sniffedPng;
        console.warn("[cashfree-qr] Rejected non-QR PNG from API response (placeholder)");
        sniffedPng = null;
      }

      const frames = page.frames();

      // Bail out fast with a clear Railway log if Cashfree rejects the domain
      if (!domainBlockedLogged && Date.now() - startMs > 2_000) {
        try {
          const bodyText = await page.evaluate(() => (document.body?.innerText ?? "").slice(0, 400));
          if (/whitelist|not enabled or approved|broken link/i.test(bodyText)) {
            domainBlockedLogged = true;
            console.error(
              "[cashfree-qr] Cashfree rejected origin! Set CASHFREE_WHITELISTED_URL to your approved Cashfree domain. Page text:",
              bodyText.replace(/\s+/g, " ").trim(),
            );
            return null;
          }
        } catch {
          // ignore transient navigation
        }
      }

      // 3. Click "Click to see QR" / placeholder / UPI trigger FIRST before DOM scraping
      const elapsed = Date.now() - startMs;
      let clickedSomething = false;
      for (const frame of frames) {
        const didClick = await tryClickQrTriggerInFrame(frame, clickHistory, elapsed > 2_000);
        if (didClick) {
          clickedSomething = true;
          break;
        }
      }

      if (clickedSomething) {
        // Give Cashfree's backend API a moment to return the real QR after clicking
        await page.waitForTimeout(850);
        continue;
      }

      // 4. Check DOM <img>/<canvas> — strictly verified as a real high-contrast black & white QR
      for (const frame of frames) {
        const dataUrl = await extractQrDataUrlFromFrame(frame);
        if (dataUrl) {
          const png = decodeBase64DataUrlToPng(dataUrl);
          if (png && (await verifyPngIsRealQr(page, png))) {
            console.log("[cashfree-qr] Captured verified real QR from DOM");
            return png;
          }
        }
      }

      // 5. Fallback element screenshot for SVG/cross-origin QR — ALSO verified as real black & white QR
      if (elapsed > 2_500) {
        for (const frame of frames) {
          const shot = await screenshotQrElementFromFrame(frame);
          if (shot && (await verifyPngIsRealQr(page, shot))) {
            console.log("[cashfree-qr] Captured verified real QR via element screenshot");
            return shot;
          }
        }
      }

      await page.waitForTimeout(450);
    }

    if (sniffedUpiUri) return await renderUpiUriToPng(sniffedUpiUri);
    if (sniffedPng && (await verifyPngIsRealQr(page, sniffedPng))) return sniffedPng;

    try {
      const finalUrl = page.url();
      const snippet = await page.evaluate(() =>
        (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
      );
      console.warn(`[cashfree-qr] Timeout without real QR. url=${finalUrl} text=${snippet}`);
    } catch {
      // ignore
    }
    return null;
  } catch (err) {
    console.error(
      "[cashfree-qr] Playwright capture error:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // ignore
      }
    }
    if (context) {
      try {
        await context.close();
      } catch {
        // ignore
      }
    }
    releaseCaptureSlot();
  }
}

// ============================================================================
// 4. Unified Order + QR Flow (S2S -> Playwright -> Hosted Checkout Fallback)
// ============================================================================
export async function createCashfreeOrderAndQr(
  cf: CashfreeConfig,
  params: {
    orderId: string;
    amount: number;
    customerId: string;
    customerName: string;
    orderNote?: string;
  },
): Promise<CashfreeQrCaptureResult> {
  const created = await createCashfreeOrder(cf, params);
  if (!created.ok || !created.paymentSessionId) {
    return {
      ok: false,
      qrPng: null,
      method: "failed",
      paymentSessionId: null,
      cfOrderId: null,
      checkoutUrl: null,
      error: created.error ?? "Cashfree order creation failed",
    };
  }

  const paymentSessionId = created.paymentSessionId;
  const cfOrderId = created.cfOrderId;
  const checkoutUrl = cf.publicBaseUrl
    ? `${cf.publicBaseUrl}/pay/${encodeURIComponent(params.orderId)}`
    : null;

  if (cf.qrMode === "checkout") {
    return {
      ok: true,
      qrPng: null,
      method: "checkout",
      paymentSessionId,
      cfOrderId,
      checkoutUrl,
    };
  }

  if (cf.qrMode === "direct" || cf.qrMode === "auto") {
    const s2s = await tryDirectS2sQr(cf, paymentSessionId, cf.qrMode === "auto");
    if (s2s.png) {
      return {
        ok: true,
        qrPng: s2s.png,
        method: "s2s",
        paymentSessionId,
        cfOrderId,
        checkoutUrl,
      };
    }
    if (cf.qrMode === "direct") {
      return {
        ok: true,
        qrPng: null,
        method: "checkout",
        paymentSessionId,
        cfOrderId,
        checkoutUrl,
        error: s2s.error,
      };
    }
  }

  if (cf.qrMode === "playwright" || cf.qrMode === "auto") {
    const pwPng = await captureCashfreeQrViaPlaywright(cf, paymentSessionId);
    if (pwPng) {
      return {
        ok: true,
        qrPng: pwPng,
        method: "playwright",
        paymentSessionId,
        cfOrderId,
        checkoutUrl,
      };
    }
  }

  return {
    ok: true,
    qrPng: null,
    method: "checkout",
    paymentSessionId,
    cfOrderId,
    checkoutUrl,
    error: "QR image capture timed out",
  };
}

// ============================================================================
// 5. Cashfree Order Status & Payment Verification (GET /pg/orders/:id)
// ============================================================================
export async function fetchCashfreeOrderStatus(
  cf: CashfreeConfig,
  orderId: string,
): Promise<{
  data: Record<string, unknown> | null;
  payments: Record<string, unknown>[];
  raw: string;
}> {
  const base = getCashfreeApiBase(cf.env);
  const raws: string[] = [];
  let orderData: Record<string, unknown> | null = null;
  let payments: Record<string, unknown>[] = [];

  const c1 = new AbortController();
  const t1 = setTimeout(() => c1.abort(), 12_000);
  try {
    const res = await fetch(`${base}/orders/${encodeURIComponent(orderId)}`, {
      method: "GET",
      headers: cashfreeHeaders(cf),
      signal: c1.signal,
    });
    const txt = await res.text();
    raws.push(`[ORDER] ${res.status} ${txt.slice(0, 600)}`);
    try {
      const parsed = JSON.parse(txt) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") {
        orderData = parsed;
      }
    } catch {
      // ignore non-json
    }
  } catch (err) {
    raws.push(`[ORDER] error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(t1);
  }

  const statusStr = String(orderData?.["order_status"] ?? "").toUpperCase();
  if (statusStr === "PAID") {
    const c2 = new AbortController();
    const t2 = setTimeout(() => c2.abort(), 8_000);
    try {
      const res = await fetch(`${base}/orders/${encodeURIComponent(orderId)}/payments`, {
        method: "GET",
        headers: cashfreeHeaders(cf),
        signal: c2.signal,
      });
      const txt = await res.text();
      raws.push(`[PAYMENTS] ${res.status} ${txt.slice(0, 600)}`);
      try {
        const parsed = JSON.parse(txt) as unknown;
        if (Array.isArray(parsed)) {
          payments = parsed.filter(
            (x): x is Record<string, unknown> => Boolean(x && typeof x === "object"),
          );
        }
      } catch {
        // ignore
      }
    } catch (err) {
      raws.push(`[PAYMENTS] error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(t2);
    }
  }

  return { data: orderData, payments, raw: raws.join("\n") };
}

export function verifyCashfreePayment(
  data: Record<string, unknown> | null,
  payments: Record<string, unknown>[],
  orderId: string,
  expectedAmount: number,
): { ok: boolean; txnId: string | null; status: string } {
  if (!data || typeof data !== "object") {
    return { ok: false, txnId: null, status: "UNKNOWN" };
  }

  const status = String(data["order_status"] ?? "").toUpperCase() || "UNKNOWN";
  const oid = data["order_id"] ? String(data["order_id"]) : "";
  const paidNum = Number(data["order_amount"]);

  const amtOk = Number.isFinite(paidNum) && Math.abs(paidNum - expectedAmount) < 0.01;
  const oidOk = oid === String(orderId);
  const ok = status === "PAID" && amtOk && oidOk;

  let txnId: string | null = null;
  if (payments.length > 0) {
    const successPay =
      payments.find((p) => String(p["payment_status"] ?? "").toUpperCase() === "SUCCESS") ??
      payments[0];
    if (successPay) {
      const ref = successPay["bank_reference"] ?? successPay["cf_payment_id"];
      if (ref) txnId = String(ref);
    }
  }
  if (!txnId && data["cf_order_id"]) {
    txnId = `CF_${String(data["cf_order_id"])}`;
  }

  return { ok, txnId, status };
}

// ============================================================================
// 6. Cashfree Webhook HMAC-SHA256 Verification
// ============================================================================
export function verifyCashfreeWebhookSignature(
  secretKey: string,
  rawBody: string,
  timestamp: string,
  signature: string,
): boolean {
  if (!secretKey || !timestamp || !signature) return false;
  try {
    const expected = createHmac("sha256", secretKey)
      .update(timestamp + rawBody)
      .digest("base64");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature.trim(), "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ============================================================================
// 7. Hosted Cashfree Checkout HTML (Used by Playwright & /pay/:orderId)
// ============================================================================
function escapeHtmlAttr(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderCashfreeCheckoutHtml(
  paymentSessionId: string,
  env: CashfreeEnv,
  orderId?: string,
  amount?: number,
): string {
  const mode = env === "SANDBOX" ? "sandbox" : "production";
  const safeSession = JSON.stringify(paymentSessionId);
  const safeMode = JSON.stringify(mode);
  const titleOrder = orderId ? `Order ${escapeHtmlAttr(orderId)}` : "Secure UPI Checkout";
  const amountLine =
    typeof amount === "number" && Number.isFinite(amount)
      ? `<p style="margin:6px 0 0;color:#94a3b8;font-size:14px;">Amount: ₹${amount.toFixed(2)}</p>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${titleOrder}</title>
  <script src="https://sdk.cashfree.com/js/v3/cashfree.js"></script>
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1120;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="text-align:center;padding:28px 24px;max-width:360px;">
    <div style="font-size:18px;font-weight:700;">Opening Cashfree UPI QR...</div>
    ${amountLine}
    <p id="status" style="margin:12px 0 20px;color:#cbd5e1;font-size:13px;">Please wait a moment.</p>
    <button id="payBtn" type="button" style="display:none;background:#2563eb;color:#fff;border:0;border-radius:10px;padding:12px 22px;font-size:15px;font-weight:600;cursor:pointer;">
      Open Payment Page
    </button>
  </div>
  <script>
    (function () {
      var sessionId = ${safeSession};
      var mode = ${safeMode};
      function launch() {
        try {
          var cf = Cashfree({ mode: mode });
          cf.checkout({
            paymentSessionId: sessionId,
            redirectTarget: "_self"
          });
        } catch (err) {
          var st = document.getElementById("status");
          var btn = document.getElementById("payBtn");
          if (st) st.textContent = "Tap below to continue to Cashfree checkout.";
          if (btn) {
            btn.style.display = "inline-block";
            btn.onclick = launch;
          }
        }
      }
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", launch);
      } else {
        launch();
      }
    })();
  </script>
</body>
</html>`;
}
