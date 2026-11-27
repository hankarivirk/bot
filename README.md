# Zimbola Telegram Store Bot (Railway · Cashfree Direct Chat QR)

Standalone 24/7 Telegram digital store bot deployed on Railway using **Cashfree Payment Gateway** and **Neon PostgreSQL**.

## Features
- **Direct Signed UPI QR in Chat:** Sends Cashfree's official signed UPI QR PNG directly inside Telegram chat (exact amount and Order ID auto-filled & locked — passes on GPay, PhonePe, Paytm).
- **Auto S2S Upgrade:** `CASHFREE_QR_MODE=auto` automatically upgrades from headless Chromium capture (3-5s) to direct S2S API (0.4s) as soon as Cashfree approves your S2S ticket.
- **Instant Auto-Delivery:** Built-in `/cashfree-webhook` (HMAC-SHA256 verified, 1-2s delivery) + 5-second background Cashfree status poller + inline **Check Payment Status** button under every QR.
- **No Phone Always-On Needed:** Runs 24/7 on Railway and syncs directly with your Neon DB & Vercel website.

## Railway Environment Variables
Required:
- `DATABASE_URL`
- `ACCESS_SESSION_SECRET`
- `BOT_TOKEN`
- `ADMIN_ID`
- `CASHFREE_APP_ID`
- `CASHFREE_SECRET_KEY`

Optional:
- `CASHFREE_ENV` (`PROD` default, or `SANDBOX`)
- `CASHFREE_QR_MODE` (`auto` default, `playwright`, `direct`, or `checkout`)
- `SHOP_NAME`, `PRODUCT_NAME`, `SINGLE_PRICE`, `BULK_PRICE`, `POLL_SECONDS`, `TELEGRAM_SUPPORT_URL`

## Optional Webhook Setup (1-2s Instant Delivery)
In Railway -> Settings -> Networking -> **Generate Domain**. The bot automatically detects `RAILWAY_PUBLIC_DOMAIN` and passes `https://<domain>/cashfree-webhook` as `notify_url` on every order (you can also add the same URL under Cashfree Dashboard -> Developers -> Webhooks, API version `2023-08-01`). Even without a public domain, the 5-second Cashfree poller auto-delivers every paid order.
