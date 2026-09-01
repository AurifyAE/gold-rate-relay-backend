require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { io: connectUpstream } = require('socket.io-client');
const { createShopifyPriceSync } = require('./shopify-price-sync');
const {
  applyCommercialPricing,
  parseBoolean,
  parsePercentage,
  toShopifyCatalogPrice
} = require('./commercial-pricing');

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '50kb' }));

const port = Number(process.env.PORT || 10000);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const usdToAed = Number(process.env.USD_TO_AED || 3.674);
const vatRate = Number(process.env.VAT_RATE || 0.05);
const diamondRate = Number(process.env.DIAMOND_RATE || 18000);
const adminApiKey = process.env.ADMIN_API_KEY || '';

function envBoolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

const troyOzToGram = 31.1035;

const bullionPurity = {
  '999.9': 0.9999,
  '.9999': 0.9999,
  '999.0': 0.999,
  '0.999': 0.999,
  '995.0': 0.995,
  '0.995': 0.995,
  '916.0': 0.916,
  '0.916': 0.916,
  '750.0': 0.75,
  '0.750': 0.75
};

function parseJsonObject(value, fallback) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (error) {
    console.warn('Invalid JSON configuration. Using fallback rates.');
    return fallback;
  }
}

let djgRetailRates = parseJsonObject(
  process.env.DJG_RETAIL_RATES_JSON,
  {
    '24K': 582.25,
    '22K': 539,
    '21K': 517,
    '18K': 443,
    '14K': 345.5
  }
);

const latestMarket = {
  GOLD: null,
  SILVER: null
};

let lastRatesUpdatedAt = new Date().toISOString();

function getCorsOrigin(origin, callback) {
  // Requests without an Origin header are allowed for health checks.
  if (!origin) {
    callback(null, true);
    return;
  }

  if (allowedOrigins.includes(origin)) {
    callback(null, true);
    return;
  }

  callback(new Error('Origin is not allowed by CORS'));
}

app.use(
  cors({
    origin: getCorsOrigin,
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Admin-Key']
  })
);

const publicSocket = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST']
  },
  pingInterval: 25000,
  pingTimeout: 20000,
  transports: ['websocket', 'polling']
});

function nowIso() {
  return new Date().toISOString();
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function booleanParam(value) {
  return value === true || value === 'true' || value === '1';
}

function getKaratRate(karat) {
  const requested = String(karat || '22K').toUpperCase();

  if (Number.isFinite(Number(djgRetailRates[requested]))) {
    return Number(djgRetailRates[requested]);
  }

  const numericKarat = Number.parseFloat(requested);
  const rate24k = Number(djgRetailRates['24K'] || 0);

  if (numericKarat > 0 && rate24k > 0) {
    return rate24k * (numericKarat / 24);
  }

  return 0;
}

function calculateJewellery(params) {
  const grams = numberOrZero(params.grams);
  const karatRate = getKaratRate(params.karat);
  const diamondCt = numberOrZero(params.diamond);
  const stoneCost = numberOrZero(params.stone);
  const makingPct = numberOrZero(params.making || 12);
  const vatApplicable = params.vatApplicable === undefined
    ? !booleanParam(params.vatExempt)
    : booleanParam(params.vatApplicable);
  const makingOnTotal = booleanParam(params.makingOnTotal);
  const vatOnAll = booleanParam(params.vatOnAll);
  const premiumPercentage = numberOrZero(params.premiumPercentage);
  const businessMarginPercentage = numberOrZero(
    params.businessMarginPercentage
  );

  const goldCost = grams * karatRate;
  const diamondCost = diamondCt * diamondRate;

  const makingBase = makingOnTotal
    ? goldCost + diamondCost + stoneCost
    : goldCost;

  const making = makingBase * (makingPct / 100);
  const subtotal = goldCost + diamondCost + stoneCost + making;
  const commercial = applyCommercialPricing(subtotal, {
    premiumPercentage,
    businessMarginPercentage,
    vatApplicable: false,
    vatRate
  });

  let vatBase = vatOnAll ? subtotal : goldCost + making;
  vatBase += commercial.premium + commercial.businessMargin;
  if (!vatApplicable) vatBase = 0;

  const vat = vatBase * vatRate;
  const taxExclusiveSubtotal = commercial.taxExclusiveSubtotal;
  const total = taxExclusiveSubtotal + vat;

  return {
    total: Math.round(total),
    taxExclusiveSubtotal: round2(taxExclusiveSubtotal),
    baseCost: round2(subtotal),
    goldCost: Math.round(goldCost),
    diamCost: Math.round(diamondCost),
    stoneCost: Math.round(stoneCost),
    making: Math.round(making),
    premiumPercentage,
    premium: round2(commercial.premium),
    businessMarginPercentage,
    businessMargin: round2(commercial.businessMargin),
    vatApplicable,
    vat: Math.round(vat),
    rateKarat: round2(karatRate),
    updatedAt: lastRatesUpdatedAt
  };
}

function calculateBullion(offerUsd, grams, purity, pricing = {}) {
  const offer = numberOrZero(offerUsd);
  const weight = numberOrZero(grams);
  const fineness = bullionPurity[String(purity || '999.9')];

  if (!offer || !weight || !fineness) {
    return null;
  }

  const rate24kAed = (offer / troyOzToGram) * usdToAed;
  const ratePerGram = rate24kAed * fineness;
  const goldCost = weight * ratePerGram;
  const commercial = applyCommercialPricing(goldCost, {
    premiumPercentage: pricing.premiumPercentage,
    businessMarginPercentage: pricing.businessMarginPercentage,
    vatApplicable: pricing.vatApplicable,
    vatRate
  });

  return {
    total: commercial.total,
    taxExclusiveSubtotal: commercial.taxExclusiveSubtotal,
    baseCost: round2(goldCost),
    goldCost: round2(goldCost),
    premiumPercentage: commercial.premiumPercentage,
    premium: commercial.premium,
    businessMarginPercentage: commercial.businessMarginPercentage,
    businessMargin: commercial.businessMargin,
    vatApplicable: commercial.vatApplicable,
    vat: commercial.vat,
    ratePerGram: round2(ratePerGram),
    rate24kAed: round2(rate24kAed),
    fineness,
    rawUsdOz: round2(offer)
  };
}

function calculateSilver(offerUsd, grams, pricing = {}) {
  const offer = numberOrZero(offerUsd);
  const weight = numberOrZero(grams);

  if (!offer || !weight) {
    return null;
  }

  const ratePerGram = (offer / troyOzToGram) * usdToAed;
  const silverCost = weight * ratePerGram;
  const commercial = applyCommercialPricing(silverCost, {
    premiumPercentage: pricing.premiumPercentage,
    businessMarginPercentage: pricing.businessMarginPercentage,
    vatApplicable: pricing.vatApplicable,
    vatRate
  });

  return {
    total: commercial.total,
    taxExclusiveSubtotal: commercial.taxExclusiveSubtotal,
    baseCost: round2(silverCost),
    silverCost: round2(silverCost),
    premiumPercentage: commercial.premiumPercentage,
    premium: commercial.premium,
    businessMarginPercentage: commercial.businessMarginPercentage,
    businessMargin: commercial.businessMargin,
    vatApplicable: commercial.vatApplicable,
    vat: commercial.vat,
    ratePerGram: round2(ratePerGram),
    rawUsdOz: round2(offer)
  };
}

function requireAdmin(req, res, next) {
  if (!adminApiKey || req.get('X-Admin-Key') !== adminApiKey) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}

function metafieldValue(product, field) {
  return product && product[field] ? product[field].value : null;
}

function commercialPricingFromProduct(product) {
  const premium = parsePercentage(
    metafieldValue(product, 'premiumPercentage')
  );
  const margin = parsePercentage(
    metafieldValue(product, 'businessMarginPercentage')
  );
  const vat = parseBoolean(
    metafieldValue(product, 'vatApplicable'),
    true
  );

  if (!premium.valid) {
    return {
      error: 'custom.premium_percentage must be between 0 and 100'
    };
  }

  if (!margin.valid) {
    return {
      error: 'custom.business_margin_percentage must be between 0 and 100'
    };
  }

  if (!vat.valid) {
    return {
      error: 'custom.vat_applicable must be true or false'
    };
  }

  return {
    premiumPercentage: premium.value,
    businessMarginPercentage: margin.value,
    vatApplicable: vat.value
  };
}

function targetWithBreakdown(result, type) {
  const shopifyCatalog = toShopifyCatalogPrice(result);

  return {
    price: shopifyCatalog.price,
    taxable: shopifyCatalog.taxable,
    type,
    breakdown: {
      baseCost: result.baseCost,
      premiumPercentage: result.premiumPercentage,
      premium: result.premium,
      businessMarginPercentage: result.businessMarginPercentage,
      businessMargin: result.businessMargin,
      vatApplicable: result.vatApplicable,
      vatRate,
      vat: result.vat,
      taxExclusiveSubtotal: result.taxExclusiveSubtotal,
      storefrontPreviewTotal: result.total
    }
  };
}

function usableMarketOffer(symbol) {
  const market = latestMarket[symbol];

  if (!market || market.marketStatus === 'DISCONNECTED') return null;

  const offer = Number(market.offer);
  return Number.isFinite(offer) && offer > 0 ? offer : null;
}

function calculateShopifyTargetPrice(product) {
  const goldWeight = numberOrZero(metafieldValue(product, 'goldWeight'));
  const silverWeight = numberOrZero(
    metafieldValue(product, 'silverWeight')
  );
  const purity = metafieldValue(product, 'goldPurity');
  const commercialPricing = commercialPricingFromProduct(product);

  if (commercialPricing.error) {
    return { skipReason: commercialPricing.error };
  }

  if (silverWeight > 0) {
    const result = calculateSilver(
      usableMarketOffer('SILVER'),
      silverWeight,
      commercialPricing
    );
    return result ? targetWithBreakdown(result, 'silver') : null;
  }

  if (goldWeight > 0 && purity) {
    const result = calculateBullion(
      usableMarketOffer('GOLD'),
      goldWeight,
      purity,
      commercialPricing
    );
    return result ? targetWithBreakdown(result, 'bullion') : null;
  }

  if (goldWeight > 0) {
    const result = calculateJewellery({
      grams: goldWeight,
      karat: metafieldValue(product, 'goldKarat') || '22K',
      diamond: metafieldValue(product, 'diamondCarat') || 0,
      stone: metafieldValue(product, 'stoneCost') || 0,
      making: metafieldValue(product, 'makingPercentage') || 12,
      premiumPercentage: commercialPricing.premiumPercentage,
      businessMarginPercentage:
        commercialPricing.businessMarginPercentage,
      vatApplicable: commercialPricing.vatApplicable,
      makingOnTotal: false,
      vatOnAll: false
    });
    return result ? targetWithBreakdown(result, 'jewellery') : null;
  }

  return null;
}

const shopifyPriceSync = createShopifyPriceSync({
  config: {
    enabled: envBoolean(process.env.SHOPIFY_PRICE_SYNC_ENABLED, false),
    dryRun: envBoolean(process.env.SHOPIFY_PRICE_SYNC_DRY_RUN, true),
    storeDomain: process.env.SHOPIFY_STORE_DOMAIN,
    accessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
    apiVersion: process.env.SHOPIFY_API_VERSION || '2026-07',
    currencyCode: process.env.SHOPIFY_PRICE_CURRENCY || 'AED',
    intervalMs: process.env.SHOPIFY_PRICE_SYNC_INTERVAL_MS,
    initialDelayMs: process.env.SHOPIFY_PRICE_SYNC_INITIAL_DELAY_MS,
    minDelta: process.env.SHOPIFY_PRICE_MIN_DELTA_AED,
    mutationDelayMs: process.env.SHOPIFY_PRICE_MUTATION_DELAY_MS,
    auditSampleSize: process.env.SHOPIFY_PRICE_AUDIT_SAMPLE_SIZE
  },
  getTargetPrice: calculateShopifyTargetPrice,
  logger: console
});

app.get('/api/health', function (req, res) {
  res.json({
    status: 'ok',
    upstreamConnected: Boolean(upstreamSocket && upstreamSocket.connected),
    goldAvailable: Boolean(latestMarket.GOLD),
    silverAvailable: Boolean(latestMarket.SILVER),
    connectedClients: publicSocket.engine.clientsCount,
    shopifyPriceSync: shopifyPriceSync.getStatus(),
    timestamp: nowIso()
  });
});

app.get('/api/market', function (req, res) {
  res.set('Cache-Control', 'no-store');

  res.json({
    gold: latestMarket.GOLD,
    silver: latestMarket.SILVER,
    updatedAt: nowIso()
  });
});

app.get('/api/rates', function (req, res) {
  res.set('Cache-Control', 'no-store');

  res.json({
    djgRetailRates,
    updatedAt: lastRatesUpdatedAt
  });
});

app.put('/api/admin/rates', requireAdmin, function (req, res) {
  const incomingRates = req.body && req.body.djgRetailRates;

  if (!incomingRates || typeof incomingRates !== 'object') {
    res.status(400).json({
      error: 'djgRetailRates object is required'
    });
    return;
  }

  djgRetailRates = incomingRates;
  lastRatesUpdatedAt = nowIso();

  shopifyPriceSync.sync('retail-rates-updated').catch(() => {});

  res.json({
    djgRetailRates,
    updatedAt: lastRatesUpdatedAt
  });
});

app.post('/api/admin/shopify/sync', requireAdmin, async function (req, res) {
  const status = shopifyPriceSync.getStatus();

  if (!status.enabled) {
    res.status(409).json({
      error: 'Shopify price sync is disabled',
      shopifyPriceSync: status
    });
    return;
  }

  try {
    const result = await shopifyPriceSync.sync('admin-request');
    res.json({ result, shopifyPriceSync: shopifyPriceSync.getStatus() });
  } catch (error) {
    res.status(502).json({
      error: error.message,
      shopifyPriceSync: shopifyPriceSync.getStatus()
    });
  }
});

app.get('/api/price', function (req, res) {
  const result = calculateJewellery(req.query);
  res.set('Cache-Control', 'no-store');
  res.json(result);
});

publicSocket.on('connection', function (client) {
  console.log('Shopify relay client connected:', client.id);

  if (latestMarket.GOLD) {
    client.emit('market-data', latestMarket.GOLD);
  }

  if (latestMarket.SILVER) {
    client.emit('market-data', latestMarket.SILVER);
  }

  client.on('disconnect', function (reason) {
    console.log('Shopify relay client disconnected:', reason);
  });
});

const upstreamSocket = connectUpstream(
  process.env.UPSTREAM_SOCKET_URL,
  {
    query: {
      secret: process.env.UPSTREAM_SOCKET_SECRET
    },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    reconnectionAttempts: Infinity
  }
);

upstreamSocket.on('connect', function () {
  console.log('Connected to upstream market socket');
  upstreamSocket.emit('request-data', ['GOLD', 'SILVER']);
});

upstreamSocket.on('market-data', function (data) {
  if (!data || !data.symbol) return;

  const symbol = String(data.symbol).toUpperCase();

  if (symbol !== 'GOLD' && symbol !== 'SILVER') return;

  latestMarket[symbol] = {
    ...data,
    symbol,
    receivedAt: nowIso()
  };

  // This forwards every upstream tick immediately.
  publicSocket.emit('market-data', latestMarket[symbol]);
});

upstreamSocket.on('disconnect', function (reason) {
  console.warn('Upstream market socket disconnected:', reason);

  const disconnectedAt = nowIso();

  ['GOLD', 'SILVER'].forEach(function (symbol) {
    if (latestMarket[symbol]) {
      latestMarket[symbol] = {
        ...latestMarket[symbol],
        marketStatus: 'DISCONNECTED',
        receivedAt: disconnectedAt
      };
    }
  });

  publicSocket.emit('market-status', {
    status: 'DISCONNECTED',
    timestamp: disconnectedAt
  });
});

upstreamSocket.on('connect_error', function (error) {
  console.error('Upstream market socket error:', error.message);
});

server.listen(port, '0.0.0.0', function () {
  console.log(`Gold-rate relay listening on port ${port}`);
  shopifyPriceSync.start();
});
