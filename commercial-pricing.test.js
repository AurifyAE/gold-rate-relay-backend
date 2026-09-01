'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyCommercialPricing,
  parseBoolean,
  parsePercentage,
  toShopifyCatalogPrice
} = require('./commercial-pricing');

test('applies premium and business margin independently to base cost', () => {
  assert.deepEqual(
    applyCommercialPricing(100, {
      premiumPercentage: 10,
      businessMarginPercentage: 20,
      vatApplicable: true,
      vatRate: 0.05
    }),
    {
      baseCost: 100,
      premiumPercentage: 10,
      premium: 10,
      businessMarginPercentage: 20,
      businessMargin: 20,
      vatApplicable: true,
      vatRate: 0.05,
      vat: 6.5,
      taxExclusiveSubtotal: 130,
      total: 136.5
    }
  );
});

test('does not add VAT when the product metafield is false', () => {
  const result = applyCommercialPricing(100, {
    premiumPercentage: 10,
    businessMarginPercentage: 20,
    vatApplicable: false,
    vatRate: 0.05
  });

  assert.equal(result.vat, 0);
  assert.equal(result.taxExclusiveSubtotal, 130);
  assert.equal(result.total, 130);
});

test('maps only the tax-exclusive subtotal into Shopify catalog pricing', () => {
  const pricing = applyCommercialPricing(100, {
    premiumPercentage: 10,
    businessMarginPercentage: 20,
    vatApplicable: true,
    vatRate: 0.05
  });

  assert.equal(pricing.total, 136.5);
  assert.deepEqual(toShopifyCatalogPrice(pricing), {
    price: 130,
    taxable: true
  });
});

test('validates Shopify percentage and boolean metafield values', () => {
  assert.deepEqual(parsePercentage(null), { valid: true, value: 0 });
  assert.deepEqual(parsePercentage('12.5'), {
    valid: true,
    value: 12.5
  });
  assert.equal(parsePercentage('101').valid, false);
  assert.equal(parsePercentage('-1').valid, false);
  assert.deepEqual(parseBoolean(null, true), {
    valid: true,
    value: true
  });
  assert.deepEqual(parseBoolean('false', true), {
    valid: true,
    value: false
  });
  assert.equal(parseBoolean('yes', true).valid, false);
});
