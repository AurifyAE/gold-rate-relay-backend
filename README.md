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

## Security

The upstream socket URL and secret are backend environment variables. The browser only connects to this relay service. Use a custom domain for the relay if you do not want to expose the Render hostname.
