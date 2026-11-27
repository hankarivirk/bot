import { webcrypto } from "node:crypto";
import type { NeonQueryFunction } from "@neondatabase/serverless";

const LICENSE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars (exact divisor of 256 -> unbiased)
const AUDIT_FLOOD_MAX_PER_WINDOW = 30;
const AUDIT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
let lastAuditCleanupAt = 0;

export async function sha256Hex(value: string): Promise<string> {
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Generates a cryptographically strong random license key with 12 random characters
 * grouped as ZIM-XXXX-XXXX-XXXX using webcrypto.getRandomValues (60 bits of entropy).
 */
export function generateRandomLicenseKey(): string {
  const bytes = webcrypto.getRandomValues(new Uint8Array(12));
  let chars = "";
  for (let i = 0; i < bytes.length; i += 1) {
    chars += LICENSE_ALPHABET[(bytes[i] ?? 0) & 31];
  }
  return `ZIM-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

function getRawSessionSecret(): string {
  const raw = process.env["ACCESS_SESSION_SECRET"]?.trim();
  if (!raw || raw.length < 8) {
    throw new Error("ACCESS_SESSION_SECRET is not configured (must match your Website env!).");
  }
  return raw;
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function getEncryptionKey(): Promise<webcrypto.CryptoKey> {
  const material = await webcrypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`zimbola:aes-key:v1:${getRawSessionSecret()}`),
  );
  return webcrypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptKeyForStorage(plainKey: string): Promise<string> {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await getEncryptionKey();
  const cipherBuf = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    new TextEncoder().encode(plainKey),
  );
  return `v1:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(cipherBuf))}`;
}

export async function logAuditEvent(
  sql: NeonQueryFunction<false, false>,
  params: {
    eventType: string;
    actor: "user" | "admin" | "bot" | "system";
    severity?: "info" | "warn" | "danger";
    keyId?: string | null;
    summary: string;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<void> {
  try {
    const normalizedIp = params.ip ?? null;

    const recentRows = (await sql`
      SELECT COUNT(*)::int AS cnt
      FROM public.audit_logs
      WHERE event_type = ${params.eventType}
        AND ip IS NOT DISTINCT FROM ${normalizedIp}
        AND created_at > now() - interval '10 minutes'
    `) as { cnt: number }[];

    if (Number(recentRows[0]?.cnt ?? 0) >= AUDIT_FLOOD_MAX_PER_WINDOW) {
      return;
    }

    await sql`
      INSERT INTO public.audit_logs (event_type, actor, severity, key_id, summary, ip, user_agent)
      VALUES (
        ${params.eventType},
        ${params.actor},
        ${params.severity ?? "info"},
        ${params.keyId ?? null}::uuid,
        ${params.summary.slice(0, 300)},
        ${normalizedIp},
        ${params.userAgent ? params.userAgent.slice(0, 300) : null}
      )
    `;

    const now = Date.now();
    if (now - lastAuditCleanupAt >= AUDIT_CLEANUP_INTERVAL_MS) {
      lastAuditCleanupAt = now;
      await sql`
        DELETE FROM public.audit_logs
        WHERE created_at < now() - interval '90 days'
      `;
    }
  } catch {
    // Non-fatal
  }
}
