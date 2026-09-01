'use strict';

function parsePercentage(value, fallback = 0) {
  if (value === null || value === undefined || value === '') {
    return { valid: true, value: fallback };
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    return { valid: false, value: null };
  }

  return { valid: true, value: parsed };
}

function parseBoolean(value, fallback) {
  if (value === null || value === undefined || value === '') {
    return { valid: true, value: Boolean(fallback) };
  }

  if (value === true || value === 'true' || value === '1') {
    return { valid: true, value: true };
  }

  if (value === false || value === 'false' || value === '0') {
    return { valid: true, value: false };
  }

  return { valid: false, value: null };
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function applyCommercialPricing(baseCost, options = {}) {
  const base = Number(baseCost);
  const premiumPercentage = Number(options.premiumPercentage || 0);
  const businessMarginPercentage = Number(
    options.businessMarginPercentage || 0
  );
  const vatRate = Number(options.vatRate || 0);
  const vatApplicable = options.vatApplicable !== false;

  if (
    !Number.isFinite(base) ||
    base < 0 ||
    !Number.isFinite(premiumPercentage) ||
    !Number.isFinite(businessMarginPercentage) ||
    !Number.isFinite(vatRate)
  ) {
    return null;
  }

  const premium = base * (premiumPercentage / 100);
  const subtotalAfterPremium = base + premium;
  const businessMargin =
    base * (businessMarginPercentage / 100);
  const taxExclusiveSubtotal = subtotalAfterPremium + businessMargin;
  const vat = vatApplicable ? taxExclusiveSubtotal * vatRate : 0;

  return {
    baseCost: round2(base),
    premiumPercentage,
    premium: round2(premium),
    businessMarginPercentage,
    businessMargin: round2(businessMargin),
    vatApplicable,
    vatRate,
    vat: round2(vat),
    taxExclusiveSubtotal: round2(taxExclusiveSubtotal),
    total: round2(taxExclusiveSubtotal + vat)
  };
}

function toShopifyCatalogPrice(pricing) {
  if (
    !pricing ||
    !Number.isFinite(Number(pricing.taxExclusiveSubtotal)) ||
    typeof pricing.vatApplicable !== 'boolean'
  ) {
    return null;
  }

  return {
    price: round2(pricing.taxExclusiveSubtotal),
    taxable: pricing.vatApplicable
  };
}

module.exports = {
  applyCommercialPricing,
  parseBoolean,
  parsePercentage,
  toShopifyCatalogPrice
};
