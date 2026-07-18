# PasarAI web

Next.js dashboard for the merchant-facing PasarAI experience.

## Local preview

```powershell
Copy-Item apps/web/.env.example apps/web/.env.local
pnpm dev
```

Run that command from the repository root. It starts both the API and the
Next.js dashboard, and the API loads `services/api/.env` when that file is
present.

Development uses the visibly marked synthetic preview unless
`PASARAI_SYNTHETIC_PREVIEW=0`. Production builds reject synthetic preview mode.
Synthetic preview remains directly accessible without a merchant session.

## Required live configuration

- `PASARAI_API_BASE_URL`
- `PASARAI_API_BEARER_TOKEN`
- `PASARAI_MERCHANT_ID`
- `PASARAI_MERCHANT_NAME`
- `PASARAI_MERCHANT_LOCATION`
- `PASARAI_PRODUCT_ID`
- `PASARAI_PRODUCT_NAME`

The dashboard defaults to the July 16, 2026 demo snapshot.
`PASARAI_DASHBOARD_DATE` can override that date for another rehearsal.
Browser mutations use same-origin Next.js route handlers so the API bearer
credential remains server-side.

Authentication is required by default. Set `PASARAI_WEB_AUTH_REQUIRED=0` only
for a trusted demo that should open directly with the configured deployment
merchant. When authentication is enabled, configure
`PASARAI_WEB_SESSION_SECRET` with at least 32 characters of deployment-only
randomness and set `PASARAI_WEB_ACCESS_CODE`; `/login` then creates an
`HttpOnly`, `SameSite=Lax` signed session.

When authentication is enabled, PasarAI BFF routes reject unauthenticated
requests. In both modes they reject cross-origin mutations and replace request
merchant context with the configured deployment merchant before calling the
upstream API.
