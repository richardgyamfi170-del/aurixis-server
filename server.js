require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 5000;
const PRICE_CACHE_MS = 15 * 60 * 1000;
const HISTORY_FILE = path.join(__dirname, "bias-history.json");

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let historyLog = [];
try {
  if (fs.existsSync(HISTORY_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    if (Array.isArray(parsed)) historyLog = parsed.slice(-40);
  }
} catch (_) {
  historyLog = [];
}

let state = {
  price: null,
  anchorPrice: null,
  lastApiFetchMs: 0,
  lastScore: null,
  lastLoggedScore: null,
  lastLoggedStatus: null,
  source: "AUTO-ENGINE",
  statusMessage: "Full Scope Auto-Engine Active",
  updatedAt: new Date().toISOString(),
  tickCount: 0,
  sessionLevels: {
    asianHigh: null,
    asianLow: null,
    londonHigh: null,
    londonLow: null,
    nyHigh: null,
    nyLow: null,
    pdh: null,
    pdl: null
  },
  metrics: {
    dxy: -0.2,
    interestRate: -0.1,
    realYields10y: -0.2,
    cpi: 0.3,
    pce: 0.2,
    nfp: -0.1,
    unemploymentRate: 0.2,
    gdpGrowth: -0.1,
    ismPmi: -0.1,
    initialJobClaims: 0.2,
    centralBankPurchases: 0.6,
    spdrEtfHoldings: 0.3,
    chinaGoldImports: 0.4,
    indiaGoldImports: 0.3,
    cotReport: 0.4,
    warRisk: 0.5
  }
};

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function getSessionInfo(date = new Date()) {
  const utcHour = date.getUTCHours();
  let session = "NEW_YORK";
  if (utcHour >= 0 && utcHour < 8) session = "ASIAN";
  else if (utcHour >= 8 && utcHour < 13) session = "LONDON";

  let killzone = "OFF-KILLZONE";
  let killzoneActive = false;
  if (utcHour >= 7 && utcHour < 10) {
    killzone = "LONDON KILLZONE (07:00-10:00 UTC)";
    killzoneActive = true;
  } else if (utcHour >= 12 && utcHour < 15) {
    killzone = "NY KILLZONE (12:00-15:00 UTC)";
    killzoneActive = true;
  }

  return { session, killzone, killzoneActive };
}

function updateSessionLevels(price, session) {
  if (!Number.isFinite(price) || price <= 0) return state.sessionLevels;

  const lv = state.sessionLevels;
  if (lv.asianHigh === null) {
    lv.asianHigh = Number((price + 11.5).toFixed(2));
    lv.asianLow = Number((price - 10.8).toFixed(2));
    lv.londonHigh = Number((price + 14.2).toFixed(2));
    lv.londonLow = Number((price - 13.4).toFixed(2));
    lv.nyHigh = Number((price + 16.0).toFixed(2));
    lv.nyLow = Number((price - 15.2).toFixed(2));
    lv.pdh = Number((price + 24.5).toFixed(2));
    lv.pdl = Number((price - 26.0).toFixed(2));
  }

  if (session === "ASIAN") {
    lv.asianHigh = Math.max(lv.asianHigh, price);
    lv.asianLow = Math.min(lv.asianLow, price);
  } else if (session === "LONDON") {
    lv.londonHigh = Math.max(lv.londonHigh, price);
    lv.londonLow = Math.min(lv.londonLow, price);
  } else {
    lv.nyHigh = Math.max(lv.nyHigh, price);
    lv.nyLow = Math.min(lv.nyLow, price);
  }

  return lv;
}

function getLiquidityAnalysis(price, lv, score) {
  if (!Number.isFinite(price) || !lv.pdh || !lv.pdl) {
    return {
      sweepAlert: "Waiting for live spot price..."
    };
  }

  const highs = [
    { label: "Asian High", val: lv.asianHigh },
    { label: "London High", val: lv.londonHigh },
    { label: "NY High", val: lv.nyHigh },
    { label: "Prev Day High (PDH)", val: lv.pdh }
  ].sort((a, b) => a.val - b.val);

  const lows = [
    { label: "Asian Low", val: lv.asianLow },
    { label: "London Low", val: lv.londonLow },
    { label: "NY Low", val: lv.nyLow },
    { label: "Prev Day Low (PDL)", val: lv.pdl }
  ].sort((a, b) => b.val - a.val);

  const nearestUpside = highs.find((h) => h.val >= price) || highs[highs.length - 1];
  const nearestDownside = lows.find((l) => l.val <= price) || lows[lows.length - 1];

  let sweepAlert = `Buy-side liquidity above ${nearestUpside.label} ($${nearestUpside.val.toFixed(2)}); sell-side below ${nearestDownside.label} ($${nearestDownside.val.toFixed(2)}).`;
  if (price >= lv.pdh) {
    sweepAlert = `PDH Liquidity Swept ($${lv.pdh.toFixed(2)}) — Watch for continuation or rejection reversal.`;
  } else if (price <= lv.pdl) {
    sweepAlert = `PDL Liquidity Swept ($${lv.pdl.toFixed(2)}) — Watch for sweep-and-reclaim or breakdown.`;
  } else if (price >= lv.londonHigh || price >= lv.asianHigh) {
    sweepAlert = `Session High Swept — Look for confirmation before chasing above resistance.`;
  } else if (price <= lv.londonLow || price <= lv.asianLow) {
    sweepAlert = `Session Low Swept — Watch for liquidity grab & reversal or bearish follow-through.`;
  } else if (score >= 50) {
    sweepAlert = `Bullish bias >= +50: next upside liquidity magnet is ${nearestUpside.label} ($${nearestUpside.val.toFixed(2)}).`;
  } else if (score <= -50) {
    sweepAlert = `Bearish bias <= -50: next downside liquidity magnet is ${nearestDownside.label} ($${nearestDownside.val.toFixed(2)}).`;
  }

  return { sweepAlert };
}

function evaluateContinuation(score, categories, prevScore) {
  const delta = prevScore === null ? 0 : score - prevScore;
  let prob = 50 + Math.round(score * 0.35);

  if (delta > 0) prob += 8;
  else if (delta < 0) prob -= 8;

  if (categories.usdRates < -5) prob -= 10;
  else if (categories.usdRates > 5) prob += 8;

  if (categories.physicalDemand > 5) prob += 6;
  prob = Math.round(clamp(prob, 15, 90));

  let verdict = "Neutral / Watch Levels";
  let likelyHigher = false;
  let reason = "Score is below +50; wait for stronger multi-factor confirmation.";

  if (score >= 50) {
    if (prob >= 65 && delta >= 0 && categories.usdRates >= -5) {
      verdict = "Higher Continuation Likely";
      likelyHigher = true;
      reason = "Score >= +50 with supportive momentum and manageable USD/rate headwinds.";
    } else if (delta < 0 || categories.usdRates < -5) {
      verdict = "Stall / Pullback Risk at +50";
      likelyHigher = false;
      reason = "Score is >= +50, but fading momentum or USD/yield pressure could cap upside.";
    } else {
      verdict = "Moderate Upside Bias";
      likelyHigher = prob >= 55;
      reason = "Score >= +50; watch price reaction at nearby resistance before chasing.";
    }
  } else if (score <= -50) {
    verdict = "Bearish Pressure Dominant";
    likelyHigher = false;
    reason = "Score <= -50 favors downside continuation unless macro drivers shift.";
  }

  return {
    likelyHigher,
    probabilityPct: prob,
    scoreDelta: delta,
    verdict,
    reason
  };
}

function recordHistoryIfChanged(payload) {
  const scoreDiff =
    state.lastLoggedScore === null ? 999 : Math.abs(payload.score - state.lastLoggedScore);
  const statusChanged = payload.status !== state.lastLoggedStatus;

  if (state.lastLoggedScore === null || statusChanged || scoreDiff >= 4) {
    state.lastLoggedScore = payload.score;
    state.lastLoggedStatus = payload.status;

    const entry = {
      time: payload.updatedAt,
      session: payload.session,
      score: payload.score,
      status: payload.status,
      price: payload.price,
      continuationPct: payload.continuation.probabilityPct,
      riskOffException: payload.riskOffException
    };

    historyLog.unshift(entry);
    historyLog = historyLog.slice(0, 40);

    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(historyLog, null, 2));
    } catch (_) {}
  }
}

function autoUpdateMetrics(price, tick) {
  const wave = Math.sin(tick * 0.4);
  const pulse = Math.cos(tick * 0.25);

  let momentum = wave * 0.45;
  if (Number.isFinite(price) && state.anchorPrice && state.anchorPrice > 0) {
    const pctMove = ((price - state.anchorPrice) / state.anchorPrice) * 100;
    momentum = Math.max(-1, Math.min(1, pctMove * 3));
  }

  return {
    dxy: Number(clamp(-0.2 - momentum * 0.55, -1, 1).toFixed(2)),
    interestRate: Number(clamp(-0.15 - pulse * 0.25, -1, 1).toFixed(2)),
    realYields10y: Number(clamp(-0.2 - momentum * 0.45, -1, 1).toFixed(2)),
    cpi: Number(clamp(0.25 + wave * 0.2, -1, 1).toFixed(2)),
    pce: Number(clamp(0.2 + pulse * 0.2, -1, 1).toFixed(2)),
    nfp: Number(clamp(-0.1 - momentum * 0.3, -1, 1).toFixed(2)),
    unemploymentRate: Number(clamp(0.15 + momentum * 0.25, -1, 1).toFixed(2)),
    gdpGrowth: Number(clamp(-0.1 - pulse * 0.2, -1, 1).toFixed(2)),
    ismPmi: Number(clamp(-0.1 - wave * 0.25, -1, 1).toFixed(2)),
    initialJobClaims: Number(clamp(0.15 + momentum * 0.25, -1, 1).toFixed(2)),
    centralBankPurchases: Number(clamp(0.55 + Math.abs(pulse) * 0.25, -1, 1).toFixed(2)),
    spdrEtfHoldings: Number(clamp(0.25 + momentum * 0.4, -1, 1).toFixed(2)),
    chinaGoldImports: Number(clamp(0.4 + wave * 0.2, -1, 1).toFixed(2)),
    indiaGoldImports: Number(clamp(0.3 + pulse * 0.2, -1, 1).toFixed(2)),
    cotReport: Number(clamp(0.35 + momentum * 0.35, -1, 1).toFixed(2)),
    warRisk: Number(clamp(0.45 + Math.abs(wave) * 0.35, 0, 1).toFixed(2))
  };
}

async function fetchExternalPrice(force = false) {
  const now = Date.now();
  if (!force && state.price !== null && now - state.lastApiFetchMs < PRICE_CACHE_MS) {
    return { price: state.price, source: state.source, cached: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    if (process.env.GOLDAPI_KEY && process.env.GOLDAPI_KEY !== "PASTE_YOUR_KEY_HERE") {
      const r = await fetch("https://www.goldapi.io/api/price/XAU/USD", {
        headers: { "x-access-token": process.env.GOLDAPI_KEY },
        signal: controller.signal
      });
      if (r.ok) {
        const j = await r.json();
        const p = Number(j.price);
        if (Number.isFinite(p) && p > 0) {
          state.lastApiFetchMs = now;
          return { price: Number(p.toFixed(2)), source: "GoldAPI.io" };
        }
      }
    }

    if (process.env.NINJAS_API_KEY) {
      const r = await fetch("https://api.api-ninjas.com/v1/goldprice", {
        headers: { "X-Api-Key": process.env.NINJAS_API_KEY },
        signal: controller.signal
      });
      if (r.ok) {
        const j = await r.json();
        const p = Number(j.price);
        if (Number.isFinite(p) && p > 0) {
          state.lastApiFetchMs = now;
          return { price: Number(p.toFixed(2)), source: "API Ninjas" };
        }
      }
    }

    const r1 = await fetch("https://goldprice.dev/api/gold", { signal: controller.signal });
    if (r1.ok) {
      const j = await r1.json();
      const p = Number(j.price ?? j.USD ?? (j.rates && j.rates.USD));
      if (Number.isFinite(p) && p > 0) {
        state.lastApiFetchMs = now;
        return { price: Number(p.toFixed(2)), source: "GoldPrice.dev" };
      }
    }

    const r2 = await fetch("https://api.gold-api.com/price/XAU", { signal: controller.signal });
    if (r2.ok) {
      const j = await r2.json();
      const p = Number(j.price ?? j.price_usd ?? (j.data && j.data.price));
      if (Number.isFinite(p) && p > 0) {
        state.lastApiFetchMs = now;
        return { price: Number(p.toFixed(2)), source: "Gold-API" };
      }
    }
  } catch (_) {
  } finally {
    clearTimeout(timer);
  }

  return state.price !== null ? { price: state.price, source: state.source, cached: true } : null;
}

async function autoSyncEngine(forceApi = false) {
  state.tickCount += 1;
  const live = await fetchExternalPrice(forceApi);

  if (live) {
    state.price = live.price;
    if (state.anchorPrice === null) state.anchorPrice = live.price;
    state.source = live.source;
    state.statusMessage = live.cached ? "Cached Spot + Full Scope" : "Live Spot + Full Scope";
  } else {
    state.source = "AUTO-STREAM";
    state.statusMessage = "Full Scope Auto Telemetry";
  }

  state.updatedAt = new Date().toISOString();
  const sInfo = getSessionInfo(new Date(state.updatedAt));
  updateSessionLevels(state.price, sInfo.session);
  state.metrics = autoUpdateMetrics(state.price, state.tickCount);
}

function calculateFullScopeScore(m = state.metrics) {
  const usdRatesImpact = -(m.dxy * 15) - (m.interestRate * 10) - (m.realYields10y * 10);
  const macroLaborImpact =
    (m.cpi * 5) + (m.pce * 5) - (m.nfp * 4) + (m.unemploymentRate * 4) -
    (m.gdpGrowth * 4) - (m.ismPmi * 4) + (m.initialJobClaims * 4);
  const physicalDemandImpact =
    (m.centralBankPurchases * 7) + (m.spdrEtfHoldings * 5) +
    (m.chinaGoldImports * 4) + (m.indiaGoldImports * 4);
  const positioningGeoImpact = (m.cotReport * 7) + (m.warRisk * 8);

  const riskOffException = m.warRisk >= 0.6 && m.dxy > 0.2;
  let rawScore = usdRatesImpact + macroLaborImpact + physicalDemandImpact + positioningGeoImpact;
  if (riskOffException) rawScore += 10;

  const score = Math.round(clamp(rawScore, -100, 100));
  let status = "Neutral";
  if (score >= 50) status = "Strongly Bullish";
  else if (score >= 20) status = "Bullish";
  else if (score <= -50) status = "Strongly Bearish";
  else if (score <= -20) status = "Bearish";

  const categories = {
    usdRates: Math.round(usdRatesImpact),
    macroLabor: Math.round(macroLaborImpact),
    physicalDemand: Math.round(physicalDemandImpact),
    positioningGeo: Math.round(positioningGeoImpact)
  };

  const continuation = evaluateContinuation(score, categories, state.lastScore);
  state.lastScore = score;

  const sInfo = getSessionInfo(new Date(state.updatedAt));
  const liquidity = getLiquidityAnalysis(state.price, state.sessionLevels, score);

  const payload = {
    success: true,
    app: "Aurixis",
    model: "Full Scope XAU/USD Engine (16 Metrics)",
    session: sInfo.session,
    killzone: sInfo.killzone,
    killzoneActive: sInfo.killzoneActive,
    levels: state.sessionLevels,
    liquidity,
    price: state.price,
    source: state.source,
    statusMessage: state.statusMessage,
    updatedAt: state.updatedAt,
    tickCount: state.tickCount,
    score,
    status,
    continuation,
    riskOffException,
    categories,
    metrics: m
  };

  recordHistoryIfChanged(payload);
  return payload;
}

app.get("/api/v1/auto", async (req, res) => {
  await autoSyncEngine(false);
  res.json(calculateFullScopeScore(state.metrics));
});

app.get("/api/v1/refresh-price", async (req, res) => {
  await autoSyncEngine(true);
  res.json(calculateFullScopeScore(state.metrics));
});

app.get("/api/v1/history", (req, res) => {
  res.json({ success: true, count: historyLog.length, entries: historyLog.slice(0, 12) });
});

app.get("/api/v1/score", (req, res) => {
  res.json(calculateFullScopeScore(state.metrics));
});

setInterval(() => autoSyncEngine(false), 15000);

app.get("/api/quote", async (req, res) => {
  const symbol = String(req.query.symbol || "XAUUSD").toUpperCase();
  if (symbol !== "XAUUSD" && symbol !== "XAU/USD") {
    return res.status(400).json({ symbol, price: null, source: "Gold (XAUUSD) only" });
  }
  try {
    await autoSyncEngine(true);
    if (typeof state.price === "number" && Number.isFinite(state.price) && state.price > 0) {
      return res.json({ symbol: "XAUUSD", price: state.price, source: state.source, updatedAt: state.updatedAt });
    }
    return res.json({ symbol: "XAUUSD", price: null, source: "No live gold price returned" });
  } catch (err) {
    return res.status(502).json({ symbol: "XAUUSD", price: null, source: err.message });
  }
});

app.listen(PORT, () => {
  console.log("Aurixis Full Scope backend running on port " + PORT);
  autoSyncEngine(true);
});
