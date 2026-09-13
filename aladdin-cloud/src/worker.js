// Aladdin-Style Tracker — Cloudflare Worker API
//
// Routes (all under /api/, all require Authorization: Bearer <API_TOKEN>):
//   GET/POST   /api/holdings
//   GET/POST   /api/settings
//   GET/POST   /api/returns?kind=portfolio|benchmark
//   GET/POST   /api/footprints
//   GET/POST/DELETE /api/history
//   GET        /api/prices?tickers=VTI,BND
//   POST       /api/prices/refresh   { tickers: [...] }
//   GET        /api/edgar/blackrock
//
// Scheduled handler refreshes prices for all tickers currently in `holdings`.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function unauthorized() {
  return json({ error: "Unauthorized" }, 401);
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------- Stooq price fetch ----------------
// Stooq needs a market suffix. This assumes US-listed tickers (.us).
// Adjust stooqSymbol() if you track non-US listings.
function stooqSymbol(ticker) {
  return `${ticker.toLowerCase()}.us`;
}

async function fetchStooqPrice(ticker) {
  const sym = stooqSymbol(ticker);
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`;
  const res = await fetch(url, { headers: { "User-Agent": "aladdin-tracker/1.0" } });
  if (!res.ok) throw new Error(`Stooq HTTP ${res.status} for ${ticker}`);
  const csv = (await res.text()).trim();
  const lines = csv.split("\n");
  if (lines.length < 2) throw new Error(`Stooq returned no data for ${ticker}`);
  const cols = lines[1].split(",");
  // header: Symbol,Date,Time,Open,High,Low,Close,Volume
  const date = cols[1];
  const close = parseFloat(cols[6]);
  if (!date || isNaN(close) || date === "N/D") {
    throw new Error(`Stooq: no valid quote for ${ticker} (symbol ${sym} may be wrong)`);
  }
  return { price: close, asOfDate: date };
}

async function refreshPrices(env, tickers) {
  const results = [];
  for (const ticker of tickers) {
    try {
      const { price, asOfDate } = await fetchStooqPrice(ticker);
      await env.DB.prepare(
        `INSERT INTO price_cache (ticker, price, as_of_date, fetched_at, source)
         VALUES (?, ?, ?, ?, 'stooq')
         ON CONFLICT(ticker) DO UPDATE SET price=excluded.price, as_of_date=excluded.as_of_date,
           fetched_at=excluded.fetched_at, source=excluded.source`
      ).bind(ticker, price, asOfDate, nowIso()).run();
      results.push({ ticker, price, asOfDate, ok: true });
    } catch (e) {
      results.push({ ticker, ok: false, error: String(e.message || e) });
    }
    // Be polite to Stooq — small delay between requests.
    await new Promise((r) => setTimeout(r, 200));
  }
  return results;
}

// ---------------- SEC EDGAR (BlackRock, CIK 0001364742) ----------------
const BLACKROCK_CIK = "0001364742";
const EDGAR_CONCEPTS = {
  revenue: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax"],
  netIncome: ["NetIncomeLoss"],
  epsDiluted: ["EarningsPerShareDiluted"],
};

async function fetchLatestConcept(env, conceptNames) {
  const ua = env.EDGAR_USER_AGENT;
  if (!ua) throw new Error("EDGAR_USER_AGENT secret is not set — SEC requires an identifying User-Agent (e.g. 'Your Name your@email.com')");
  for (const concept of conceptNames) {
    const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${BLACKROCK_CIK}/us-gaap/${concept}.json`;
    const res = await fetch(url, { headers: { "User-Agent": ua, "Accept": "application/json" } });
    if (res.status === 404) continue; // this concept tag isn't used, try next
    if (!res.ok) throw new Error(`EDGAR HTTP ${res.status} for ${concept}`);
    const data = await res.json();
    const units = data.units?.USD || data.units?.["USD/shares"] || [];
    const tenQOrK = units.filter((u) => u.form === "10-Q" || u.form === "10-K");
    const pool = tenQOrK.length ? tenQOrK : units;
    if (!pool.length) continue;
    pool.sort((a, b) => new Date(b.end) - new Date(a.end));
    const latest = pool[0];
    return {
      concept,
      value: latest.val,
      fiscalPeriod: `${latest.fy}${latest.fp}`,
      periodEnd: latest.end,
      form: latest.form,
      filed: latest.filed,
    };
  }
  return null;
}

async function fetchBlackRockFootprint(env) {
  const [revenue, netIncome, epsDiluted] = await Promise.all([
    fetchLatestConcept(env, EDGAR_CONCEPTS.revenue),
    fetchLatestConcept(env, EDGAR_CONCEPTS.netIncome),
    fetchLatestConcept(env, EDGAR_CONCEPTS.epsDiluted),
  ]);
  return {
    source: "SEC EDGAR XBRL companyconcept API (data.sec.gov), CIK " + BLACKROCK_CIK,
    fetchedAt: nowIso(),
    revenue,
    netIncome,
    epsDiluted,
    note: "AUM, net inflows, and retention/stickiness commentary are not in XBRL financial-statement tags and must still be entered manually from the earnings release or 10-Q/10-K narrative.",
  };
}

// ---------------- Route handlers ----------------
async function handleHoldings(req, env) {
  if (req.method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM holdings ORDER BY id").all();
    return json({ holdings: results });
  }
  if (req.method === "POST") {
    const body = await req.json();
    const rows = Array.isArray(body.holdings) ? body.holdings : [];
    await env.DB.prepare("DELETE FROM holdings").run();
    const stmt = env.DB.prepare(
      "INSERT INTO holdings (ticker, shares, price, weight, asset_class, updated_at) VALUES (?,?,?,?,?,?)"
    );
    const batch = rows.map((h) =>
      stmt.bind(h.ticker, h.shares || 0, h.price || 0, h.weight || 0, h.assetClass || "Equity", nowIso())
    );
    if (batch.length) await env.DB.batch(batch);
    return json({ ok: true, count: rows.length });
  }
  return json({ error: "Method not allowed" }, 405);
}

async function handleSettings(req, env) {
  if (req.method === "GET") {
    const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
    const out = {};
    for (const r of results) out[r.key] = JSON.parse(r.value);
    return json({ settings: out });
  }
  if (req.method === "POST") {
    const body = await req.json();
    const entries = Object.entries(body || {});
    const stmt = env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
    );
    const batch = entries.map(([k, v]) => stmt.bind(k, JSON.stringify(v), nowIso()));
    if (batch.length) await env.DB.batch(batch);
    return json({ ok: true });
  }
  return json({ error: "Method not allowed" }, 405);
}

async function handleReturns(req, env, url) {
  const kind = url.searchParams.get("kind") || "portfolio";
  if (!["portfolio", "benchmark"].includes(kind)) return json({ error: "kind must be portfolio or benchmark" }, 400);
  if (req.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT period_index, return_pct FROM returns_series WHERE kind=? ORDER BY period_index"
    ).bind(kind).all();
    return json({ kind, series: results.map((r) => r.return_pct) });
  }
  if (req.method === "POST") {
    const body = await req.json();
    const series = Array.isArray(body.series) ? body.series : [];
    await env.DB.prepare("DELETE FROM returns_series WHERE kind=?").bind(kind).run();
    const stmt = env.DB.prepare("INSERT INTO returns_series (kind, period_index, return_pct) VALUES (?,?,?)");
    const batch = series.map((v, i) => stmt.bind(kind, i, v));
    if (batch.length) await env.DB.batch(batch);
    return json({ ok: true, kind, count: series.length });
  }
  return json({ error: "Method not allowed" }, 405);
}

async function handleFootprints(req, env) {
  if (req.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT * FROM footprint_log ORDER BY as_of_date DESC, id DESC LIMIT 100"
    ).all();
    return json({ footprints: results });
  }
  if (req.method === "POST") {
    const f = await req.json();
    if (!f.source || !f.asOfDate) return json({ error: "source and asOfDate are required" }, 400);
    await env.DB.prepare(
      `INSERT INTO footprint_log
        (as_of_date, source, aum, inflows, tech_rev, net_income, eps_diluted, retention, stress_period, drawdown_note, notes, auto_fetched, saved_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      f.asOfDate, f.source, f.aum ?? null, f.inflows ?? null, f.techRev ?? null,
      f.netIncome ?? null, f.epsDiluted ?? null, f.retention ?? null,
      f.stressPeriod ?? null, f.drawdownNote ?? null, f.notes ?? null,
      f.autoFetched ? 1 : 0, nowIso()
    ).run();
    return json({ ok: true });
  }
  return json({ error: "Method not allowed" }, 405);
}

async function handleHistory(req, env) {
  if (req.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, report, created_at FROM review_history ORDER BY id DESC LIMIT 50"
    ).all();
    return json({ history: results });
  }
  if (req.method === "POST") {
    const body = await req.json();
    await env.DB.prepare("INSERT INTO review_history (report, created_at) VALUES (?,?)")
      .bind(body.report || "", nowIso()).run();
    return json({ ok: true });
  }
  if (req.method === "DELETE") {
    await env.DB.prepare("DELETE FROM review_history").run();
    return json({ ok: true });
  }
  return json({ error: "Method not allowed" }, 405);
}

async function handlePricesGet(req, env, url) {
  const tickersParam = url.searchParams.get("tickers") || "";
  const tickers = tickersParam.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
  if (!tickers.length) {
    const { results } = await env.DB.prepare("SELECT * FROM price_cache").all();
    return json({ prices: results });
  }
  const placeholders = tickers.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT * FROM price_cache WHERE ticker IN (${placeholders})`
  ).bind(...tickers).all();
  return json({ prices: results });
}

async function handlePricesRefresh(req, env) {
  const body = await req.json().catch(() => ({}));
  let tickers = Array.isArray(body.tickers) ? body.tickers.map((t) => t.toUpperCase()) : [];
  if (!tickers.length) {
    const { results } = await env.DB.prepare("SELECT DISTINCT ticker FROM holdings").all();
    tickers = results.map((r) => r.ticker);
  }
  if (!tickers.length) return json({ ok: true, results: [], note: "No tickers to refresh." });
  const results = await refreshPrices(env, tickers);
  return json({ ok: true, results });
}

async function handleEdgar(req, env) {
  try {
    const data = await fetchBlackRockFootprint(env);
    return json(data);
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }
}

// ---------------- Auth + routing ----------------
function isAuthorized(req, env) {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  return env.API_TOKEN && token === env.API_TOKEN;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname.startsWith("/api/")) {
      if (!isAuthorized(req, env)) return unauthorized();

      try {
        if (url.pathname === "/api/holdings") return await handleHoldings(req, env);
        if (url.pathname === "/api/settings") return await handleSettings(req, env);
        if (url.pathname === "/api/returns") return await handleReturns(req, env, url);
        if (url.pathname === "/api/footprints") return await handleFootprints(req, env);
        if (url.pathname === "/api/history") return await handleHistory(req, env);
        if (url.pathname === "/api/prices" && req.method === "GET") return await handlePricesGet(req, env, url);
        if (url.pathname === "/api/prices/refresh" && req.method === "POST") return await handlePricesRefresh(req, env);
        if (url.pathname === "/api/edgar/blackrock" && req.method === "GET") return await handleEdgar(req, env);
        return json({ error: "Not found" }, 404);
      } catch (e) {
        return json({ error: String(e.message || e) }, 500);
      }
    }

    // Static assets (the frontend) for everything else.
    return env.ASSETS.fetch(req);
  },

  async scheduled(event, env, ctx) {
    const { results } = await env.DB.prepare("SELECT DISTINCT ticker FROM holdings").all();
    const tickers = results.map((r) => r.ticker);
    if (tickers.length) ctx.waitUntil(refreshPrices(env, tickers));
  },
};
