'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createShopifyPriceSync,
  normalizeShopDomain
} = require('./shopify-price-sync');

test('normalizes a Shopify store domain without accepting other hosts', () => {
  assert.equal(
    normalizeShopDomain('https://Example-Store.myshopify.com/admin'),
    'example-store.myshopify.com'
  );
  assert.equal(normalizeShopDomain('example.com'), '');
});

test('stays disabled without making Shopify requests', async () => {
  let fetchCalls = 0;
  const sync = createShopifyPriceSync({
    config: { enabled: false },
    getTargetPrice: () => ({ price: 100 }),
    fetchImpl: async () => {
      fetchCalls += 1;
    }
  });

  const result = await sync.sync();

  assert.deepEqual(result, { skipped: true, reason: 'disabled' });
  assert.equal(fetchCalls, 0);
});

test('dry run plans only variants above the configured price delta', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      json: async () => ({
        data: {
          shop: { currencyCode: 'AED' },
          productVariants: {
            nodes: [
              {
                id: 'gid://shopify/ProductVariant/1',
                price: '99.50',
                product: { id: 'gid://shopify/Product/1' }
              },
              {
                id: 'gid://shopify/ProductVariant/2',
                price: '90.00',
                product: { id: 'gid://shopify/Product/1' }
              }
            ],
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        }
      })
    };
  };
  const sync = createShopifyPriceSync({
    config: {
      enabled: true,
      dryRun: true,
      storeDomain: 'example-store.myshopify.com',
      accessToken: 'test-token',
      minDelta: 1
    },
    getTargetPrice: () => ({ price: 100 }),
    fetchImpl,
    logger: { info() {}, error() {} }
  });

  const result = await sync.sync('test');

  assert.equal(result.scannedVariants, 2);
  assert.equal(result.unchangedVariants, 1);
  assert.equal(result.plannedVariants, 1);
  assert.equal(result.updatedVariants, 0);
  assert.equal(requests.length, 1);
});

test('groups a real price update by product', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);

    if (requests.length === 1) {
      return {
        ok: true,
        json: async () => ({
          data: {
            shop: { currencyCode: 'AED' },
            productVariants: {
              nodes: [
                {
                  id: 'gid://shopify/ProductVariant/9',
                  price: '75.00',
                  product: { id: 'gid://shopify/Product/3' }
                }
              ],
              pageInfo: { hasNextPage: false, endCursor: null }
            }
          }
        })
      };
    }

    return {
      ok: true,
      json: async () => ({
        data: {
          productVariantsBulkUpdate: {
            productVariants: [
              { id: 'gid://shopify/ProductVariant/9', price: '125.25' }
            ],
            userErrors: []
          }
        }
      })
    };
  };
  const sync = createShopifyPriceSync({
    config: {
      enabled: true,
      dryRun: false,
      storeDomain: 'example-store.myshopify.com',
      accessToken: 'test-token',
      minDelta: 1,
      mutationDelayMs: 0
    },
    getTargetPrice: () => ({ price: 125.25 }),
    fetchImpl,
    logger: { info() {}, error() {} }
  });

  const result = await sync.sync('test');

  assert.equal(result.updatedProducts, 1);
  assert.equal(result.updatedVariants, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].variables, {
    productId: 'gid://shopify/Product/3',
    variants: [
      { id: 'gid://shopify/ProductVariant/9', price: '125.25' }
    ]
  });
});

test('refuses to plan AED prices for a non-AED Shopify store', async () => {
  const sync = createShopifyPriceSync({
    config: {
      enabled: true,
      dryRun: true,
      storeDomain: 'example-store.myshopify.com',
      accessToken: 'test-token',
      currencyCode: 'AED'
    },
    getTargetPrice: () => ({ price: 100 }),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        data: {
          shop: { currencyCode: 'USD' },
          productVariants: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        }
      })
    }),
    logger: { info() {}, error() {} }
  });

  await assert.rejects(
    () => sync.sync('test'),
    /currency USD does not match configured pricing currency AED/
  );
});
