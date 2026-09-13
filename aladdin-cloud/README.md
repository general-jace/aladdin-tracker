# Aladdin-Style Tracker — Cloudflare deployment

Single Worker serves both the static frontend (`/public`) and the `/api/*`
backend, backed by D1 (SQLite) and a daily Cron price refresh from Stooq.

## What's automated vs. manual (read this first)

| Data | How | Reliability note |
|---|---|---|
| Your holdings' prices | Stooq EOD quotes, refreshed daily by Cron + on-demand button | Free, no key, but end-of-day only and mainly reliable for **US-listed** tickers (`.us` suffix assumed) |
| Your Sharpe/Sortino/vol/drawdown/beta | Computed client-side from the return series you maintain | Exact math; only as good as the return series you feed it |
| BlackRock Revenue / Net Income / Diluted EPS | SEC EDGAR XBRL `companyconcept` API | Free, official, structured — the most trustworthy automated feed available |
| BlackRock AUM, net inflows, retention commentary | Manual entry, source + date required | No API (free or paid at reasonable cost) publishes this as structured data — it lives in prose/PDF exhibits |
| Pension funding ratios, P&I commentary | Manual entry, source + date required | Same reason as above |

## One-time setup

```bash
npm install -g wrangler   # if you don't have it
wrangler login

cd aladdin-cloud

# 1. Create the D1 database
wrangler d1 create aladdin-tracker-db
# Copy the "database_id" from the output into wrangler.toml

# 2. Create the KV namespace
wrangler kv namespace create PRICE_KV
# Copy the "id" from the output into wrangler.toml

# 3. Apply the schema
wrangler d1 execute aladdin-tracker-db --file=./schema.sql --remote

# 4. Set secrets
wrangler secret put API_TOKEN
# ^ pick any long random string yourself, e.g.: openssl rand -hex 32
wrangler secret put EDGAR_USER_AGENT
# ^ SEC requires an identifying User-Agent on API requests, e.g.:
#   "Jane Doe jane@example.com"
#   Requests without a real contact string get rate-limited/blocked by SEC.

# 5. Deploy
wrangler deploy
```

Wrangler will print your live URL, e.g. `https://aladdin-tracker.<your-subdomain>.workers.dev`.

On first visit, the page will prompt you for the API token — paste the same
value you set in step 4. It's stored in your browser's `localStorage` (fine
here, since this is your own real deployed site, not a sandboxed preview).

## Using it day to day

- **Setup & Holdings** → "Refresh Live Prices" pulls current EOD closes from Stooq for whatever tickers are in the table.
- **Footprints** → "Auto-fill Revenue/Net Income/EPS from SEC EDGAR" fills those three fields from BlackRock's latest 10-Q/10-K XBRL data; AUM/inflows/retention still need to be typed in from the earnings release, with a source and date.
- **History & Export** → "Save Session" / "Load Saved Session" persist your holdings, targets, rules, and return series to D1 so you don't retype them next visit.
- The Cron trigger refreshes all tracked tickers' prices automatically once a day (default: 22:00 UTC weekdays, edit `[triggers]` in `wrangler.toml` to change).

## Known limitations to keep in mind

- Stooq's `.us` suffix assumption in `stooqSymbol()` (src/worker.js) covers most US-listed ETFs/stocks but not foreign listings, OTC tickers, or some fund share classes — check `/api/prices/refresh` results for failures and adjust the symbol mapping if you hold non-US-listed securities.
- Free-tier Stooq has no official SLA; if it goes down or blocks the Worker's IP range, prices simply won't refresh until it's back — there's no automatic failover to a second provider in this version.
- SEC EDGAR only has BlackRock's own consolidated financials in XBRL — it does not have Aladdin-specific segment revenue broken out, since BlackRock doesn't report that as a separate XBRL tag. "Tech / Aladdin Revenue" is really "total BlackRock revenue" unless BlackRock's segment disclosures happen to isolate it, which they generally don't in machine-readable form.
- This was built and syntax-checked in a sandboxed environment with no network access, so it has **not** been tested against the live Stooq or SEC endpoints. Test `/api/prices/refresh` and `/api/edgar/blackrock` right after your first deploy and watch the Worker logs (`wrangler tail`) if anything comes back malformed.
