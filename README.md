# Gold Rate Relay Backend

This service keeps the private upstream Socket.IO connection on the server and immediately broadcasts each market update to Shopify visitors.

## Local setup

```bash
npm install
cp .env.example .env
npm start
```

Update `.env` before starting the service.

## Render setup

Create a Render Web Service using this repository.

```text
Build command: npm install
Start command: npm start
```

Add the variables from `.env.example` in Render. Do not commit `.env`.

The service must be a Web Service because Shopify visitors use a long-lived Socket.IO connection.

## Endpoints

```text
GET /api/health
GET /api/market
GET /api/rates
GET /api/price
PUT /api/admin/rates
```

## Updating jewellery rates

```bash
curl -X PUT https://YOUR_BACKEND_DOMAIN/api/admin/rates \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR_ADMIN_API_KEY" \
  -d '{"djgRetailRates":{"24K":582.25,"22K":539,"21K":517,"18K":443,"14K":345.5}}'
```

## Shopify theme setup

Create `snippets/gold-rate-config.liquid` in the Shopify theme:

```liquid
{% comment %}
  The relay URL is public. Keep the upstream URL and secret on the backend.
{% endcomment %}
<script>
  window.GOLD_RATE_CONFIG = {
    relayUrl: 'https://gold-rate-relay-backend.onrender.com'
  };
</script>
```

Upload this repository's `gold-rate-relay.js` as
`assets/gold-rate-relay.js`, then load both once in `layout/theme.liquid`:

```liquid
{% render 'gold-rate-config' %}
<script src="{{ 'gold-rate-relay.js' | asset_url }}" defer></script>
```

To show live 24K gold and silver spot rates above the header, upload
`shopify-theme/snippets/gold-live-rate-bar.liquid` to the theme as
`snippets/gold-live-rate-bar.liquid`. Render it immediately inside
`.page-wrapper`, before `#header-group`:

```liquid
<div class="page-wrapper">
  {% render 'gold-live-rate-bar' %}

  <div id="header-group">
    {% sections 'header-group' %}
  </div>
```

The theme opens one Socket.IO connection per page and applies each received
market rate to every matching product card locally. Jewellery cards use the
single `/api/rates` response and do not make per-card `/api/price` requests.
Pages without a live-price card or live-rate header bar do not open a market
socket.

### Live cart summary

Upload `shopify-theme/snippets/live-cart-summary-data.liquid` as
`snippets/live-cart-summary-data.liquid`. In the theme's cart-summary snippet,
render it as the first child of `.cart-totals__container`:

```liquid
<div class="cart-totals__container{% if settings.show_installments %} cart-totals__container--has-installments{% endif %}">
  {% render 'live-cart-summary-data' %}

  <span class="cart-totals__item cart-totals__total" role="status">
```

The browser replaces only the original Shopify value of live-priced lines in
the displayed estimated total. Non-live products and Shopify's existing fixed
discount amount remain included.

## Non-Plus checkout price synchronization

Shopify does not allow a non-Plus theme script to override checkout prices.
This service can instead synchronize calculated live prices into Shopify's
variant catalog through the GraphQL Admin API. Checkout then uses the latest
catalog-price snapshot written by this service.

Create and install a Shopify custom app with the `write_products` Admin API
scope. Add its `.myshopify.com` domain and Admin API access token to Render,
using the variables documented in `env.example`.

Start in protected dry-run mode:

```env
SHOPIFY_PRICE_SYNC_ENABLED=true
SHOPIFY_PRICE_SYNC_DRY_RUN=true
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ADMIN_ACCESS_TOKEN=your-admin-api-token
SHOPIFY_PRICE_CURRENCY=AED
```

After deployment, inspect `GET /api/health`. The
`shopifyPriceSync.lastResult` object reports scanned, eligible, unchanged, and
planned variants. You can also request an immediate protected run:

```bash
curl -X POST https://YOUR_BACKEND_DOMAIN/api/admin/shopify/sync \
  -H "X-Admin-Key: YOUR_ADMIN_API_KEY"
```

Only after checking the planned count and sample calculations, enable writes:

```env
SHOPIFY_PRICE_SYNC_DRY_RUN=false
```

The default schedule is every five minutes and updates only variants whose
price differs by at least AED 1. It uses these existing product metafields:

```text
custom.gold_weight
custom.gold_karat
custom.purity
custom.silver_weight
custom.diamond_carat
custom.stone_cost
custom.making_percentage
```

For safety, synchronization stops with an error if the Shopify store currency
does not match `SHOPIFY_PRICE_CURRENCY`.

This is near-live catalog synchronization, not a per-customer price lock. A
price can change between adding an item and entering checkout. Keep the theme's
displayed product-price behavior aligned with the synchronization interval and
show customers when the checkout price snapshot was last updated.

## Security

The upstream socket URL and secret are backend environment variables. The browser only connects to this relay service. Use a custom domain for the relay if you do not want to expose the Render hostname.
