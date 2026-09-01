'use strict';

const PRODUCT_VARIANTS_QUERY = `
  query LivePriceVariants($after: String) {
    shop {
      currencyCode
    }
    productVariants(first: 100, after: $after) {
      nodes {
        id
        title
        price
        taxable
        product {
          id
          title
          goldWeight: metafield(namespace: "custom", key: "gold_weight") {
            value
          }
          goldKarat: metafield(namespace: "custom", key: "gold_karat") {
            value
          }
          goldPurity: metafield(namespace: "custom", key: "purity") {
            value
          }
          silverWeight: metafield(namespace: "custom", key: "silver_weight") {
            value
          }
          diamondCarat: metafield(namespace: "custom", key: "diamond_carat") {
            value
          }
          stoneCost: metafield(namespace: "custom", key: "stone_cost") {
            value
          }
          makingPercentage: metafield(namespace: "custom", key: "making_percentage") {
            value
          }
          premiumPercentage: metafield(namespace: "custom", key: "premium_percentage") {
            value
          }
          businessMarginPercentage: metafield(namespace: "custom", key: "business_margin_percentage") {
            value
          }
          vatApplicable: metafield(namespace: "custom", key: "vat_applicable") {
            value
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const UPDATE_VARIANTS_MUTATION = `
  mutation UpdateLivePrices(
    $productId: ID!
    $variants: [ProductVariantsBulkInput!]!
  ) {
    productVariantsBulkUpdate(
      productId: $productId
      variants: $variants
    ) {
      productVariants {
        id
        price
        taxable
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeShopDomain(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';

  let hostname;

  try {
    hostname = new URL(
      raw.includes('://') ? raw : `https://${raw}`
    ).hostname;
  } catch (error) {
    return '';
  }

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(hostname)) {
    return '';
  }

  return hostname;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function chunk(items, size) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function createShopifyPriceSync(options) {
  const config = options.config || {};
  const logger = options.logger || console;
  const getTargetPrice = options.getTargetPrice;
  const fetchImpl = options.fetchImpl || fetch;
  const enabled = Boolean(config.enabled);
  const dryRun = config.dryRun !== false;
  const storeDomain = normalizeShopDomain(config.storeDomain);
  const accessToken = String(config.accessToken || '').trim();
  const apiVersion = String(config.apiVersion || '2026-07').trim();
  const currencyCode = String(config.currencyCode || 'AED')
    .trim()
    .toUpperCase();
  const intervalMs = Math.max(
    60000,
    positiveNumber(config.intervalMs, 300000)
  );
  const initialDelayMs = Math.max(
    1000,
    positiveNumber(config.initialDelayMs, 15000)
  );
  const minDelta = positiveNumber(config.minDelta, 1);
  const mutationDelayMs = positiveNumber(config.mutationDelayMs, 250);
  const auditSampleSize = Math.max(
    1,
    Math.min(25, positiveNumber(config.auditSampleSize, 10))
  );

  if (typeof getTargetPrice !== 'function') {
    throw new Error('Shopify price sync requires getTargetPrice(product)');
  }

  if (enabled && (!storeDomain || !accessToken)) {
    throw new Error(
      'SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN are required ' +
      'when Shopify price sync is enabled'
    );
  }

  let intervalTimer = null;
  let initialTimer = null;
  let activeSync = null;

  const status = {
    enabled,
    dryRun,
    storeDomain: storeDomain || null,
    currencyCode,
    running: false,
    lastReason: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastError: null,
    lastResult: null
  };

  async function graphql(query, variables) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    try {
      const response = await fetchImpl(
        `https://${storeDomain}/admin/api/${apiVersion}/graphql.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': accessToken
          },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal
        }
      );

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const detail = payload && payload.errors
          ? JSON.stringify(payload.errors)
          : `HTTP ${response.status}`;
        throw new Error(`Shopify Admin API request failed: ${detail}`);
      }

      if (!payload || payload.errors) {
        throw new Error(
          `Shopify Admin GraphQL error: ${JSON.stringify(
            payload && payload.errors ? payload.errors : payload
          )}`
        );
      }

      return payload.data;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function listVariants() {
    const variants = [];
    let shopCurrencyCode = null;
    let after = null;

    do {
      const data = await graphql(PRODUCT_VARIANTS_QUERY, { after });
      const connection = data && data.productVariants;

      if (!connection) {
        throw new Error('Shopify productVariants response was missing');
      }

      shopCurrencyCode = data.shop && data.shop.currencyCode;

      variants.push(...connection.nodes);
      after = connection.pageInfo.hasNextPage
        ? connection.pageInfo.endCursor
        : null;
    } while (after);

    if (shopCurrencyCode !== currencyCode) {
      throw new Error(
        `Shopify store currency ${shopCurrencyCode || 'UNKNOWN'} does not ` +
        `match configured pricing currency ${currencyCode}`
      );
    }

    return variants;
  }

  function buildPlan(variants) {
    const updatesByProduct = new Map();
    const result = {
      scannedVariants: variants.length,
      eligibleVariants: 0,
      unchangedVariants: 0,
      skippedVariants: 0,
      plannedVariants: 0,
      updatedVariants: 0,
      updatedProducts: 0,
      sampleChanges: [],
      sampleSkipped: []
    };

    for (const variant of variants) {
      const target = getTargetPrice(variant.product);

      if (!target || !Number.isFinite(Number(target.price))) {
        result.skippedVariants += 1;

        if (result.sampleSkipped.length < auditSampleSize) {
          result.sampleSkipped.push({
            product: variant.product.title,
            variant: variant.title,
            variantId: variant.id,
            reason: target && target.skipReason
              ? target.skipReason
              : 'No calculable live price'
          });
        }

        continue;
      }

      const targetPrice = Math.round(Number(target.price) * 100) / 100;
      const currentPrice = Number(variant.price);
      const hasTargetTaxable = typeof target.taxable === 'boolean';
      const taxableChanged = hasTargetTaxable &&
        variant.taxable !== target.taxable;

      if (targetPrice <= 0) {
        result.skippedVariants += 1;
        continue;
      }

      result.eligibleVariants += 1;

      if (
        Number.isFinite(currentPrice) &&
        Math.abs(targetPrice - currentPrice) < minDelta &&
        !taxableChanged
      ) {
        result.unchangedVariants += 1;
        continue;
      }

      if (!updatesByProduct.has(variant.product.id)) {
        updatesByProduct.set(variant.product.id, []);
      }

      const variantUpdate = {
        id: variant.id,
        price: targetPrice.toFixed(2)
      };

      if (hasTargetTaxable) {
        variantUpdate.taxable = target.taxable;
      }

      updatesByProduct.get(variant.product.id).push(variantUpdate);
      result.plannedVariants += 1;

      if (result.sampleChanges.length < auditSampleSize) {
        const sampleChange = {
          product: variant.product.title,
          variant: variant.title,
          variantId: variant.id,
          priceType: target.type || 'live',
          currentPrice: Number.isFinite(currentPrice)
            ? currentPrice.toFixed(2)
            : null,
          targetPrice: targetPrice.toFixed(2)
        };

        if (hasTargetTaxable) {
          sampleChange.currentTaxable = typeof variant.taxable === 'boolean'
            ? variant.taxable
            : null;
          sampleChange.targetTaxable = target.taxable;
        }

        if (target.breakdown) {
          sampleChange.breakdown = target.breakdown;
        }

        result.sampleChanges.push(sampleChange);
      }
    }

    return { updatesByProduct, result };
  }

  async function updateProduct(productId, variants) {
    const data = await graphql(UPDATE_VARIANTS_MUTATION, {
      productId,
      variants
    });
    const payload = data && data.productVariantsBulkUpdate;
    const errors = payload && payload.userErrors;

    if (!payload || (errors && errors.length)) {
      throw new Error(
        `Shopify rejected live prices for ${productId}: ${JSON.stringify(
          errors || data
        )}`
      );
    }

    return payload.productVariants || [];
  }

  async function performSync(reason) {
    status.running = true;
    status.lastReason = reason;
    status.lastStartedAt = new Date().toISOString();
    status.lastError = null;

    try {
      const variants = await listVariants();
      const { updatesByProduct, result } = buildPlan(variants);

      if (!dryRun) {
        for (const [productId, updates] of updatesByProduct) {
          const updateChunks = chunk(updates, 100);

          for (const variantChunk of updateChunks) {
            const updated = await updateProduct(productId, variantChunk);
            result.updatedVariants += updated.length;

            if (mutationDelayMs > 0) {
              await delay(mutationDelayMs);
            }
          }

          result.updatedProducts += 1;
        }
      }

      status.lastResult = result;
      status.lastCompletedAt = new Date().toISOString();

      logger.info(
        `[ShopifyPriceSync] ${dryRun ? 'Dry run' : 'Sync'} complete`,
        result
      );

      return result;
    } catch (error) {
      status.lastError = error.message;
      logger.error('[ShopifyPriceSync] Sync failed:', error.message);
      throw error;
    } finally {
      status.running = false;
      activeSync = null;
    }
  }

  function sync(reason = 'manual') {
    if (!enabled) {
      return Promise.resolve({ skipped: true, reason: 'disabled' });
    }

    if (activeSync) return activeSync;

    activeSync = performSync(reason);
    return activeSync;
  }

  function start() {
    if (!enabled || intervalTimer || initialTimer) return;

    initialTimer = setTimeout(() => {
      initialTimer = null;
      sync('startup').catch(() => {});
    }, initialDelayMs);
    initialTimer.unref();

    intervalTimer = setInterval(() => {
      sync('scheduled').catch(() => {});
    }, intervalMs);
    intervalTimer.unref();
  }

  function stop() {
    if (initialTimer) clearTimeout(initialTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    initialTimer = null;
    intervalTimer = null;
  }

  function getStatus() {
    return { ...status };
  }

  return {
    getStatus,
    start,
    stop,
    sync
  };
}

module.exports = {
  createShopifyPriceSync,
  normalizeShopDomain
};
