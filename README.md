# Real-Time Inventory ETL + CDC System (Unleashed + Postgres)

A production-ready data pipeline that fetches inventory data from the [Unleashed](https://www.unleashedsoftware.com/) API, transforms it into a clean schema, and stores it in a Neon Postgres database. The UI reads directly from the database for instant performance, and incremental updates are driven by Change Data Capture (CDC) using Unleashed's `modifiedSince` filter.

---

## Overview

- Fetches stock-on-hand data from the Unleashed API across multiple warehouses
- Transforms raw API responses into a clean, structured schema
- Stores data in Postgres (Neon) with upsert semantics
- Uses CDC with a `modifiedSince` cursor for fast incremental syncs (runs every minute)
- Runs a full refresh daily to compensate for Unleashed's date-only cursor granularity
- A real-time dashboard reads from the database — no Unleashed API calls at page load

---

## Architecture

```
Unleashed API
  → Extraction  (parallel pagination across warehouses)
  → Transformation  (clean schema, date parsing, product group resolution)
  → Load  (Postgres upsert via Prisma — insert new, update changed)
  → CDC cursor  (MAX(lastModified) stored in DB, used on next run)
  → UI dashboard  (reads from DB, 30s auto-refresh, search, pagination)
```

---

## Features

- **Parallel API pagination** — fetches multiple pages per warehouse concurrently
- **Incremental sync (CDC)** — only fetches records modified since the last run
- **Daily full sync** — scheduled 04:00 UTC to catch any missed changes
- **Concurrent run protection** — Postgres advisory lock + `EtlLock` table prevents overlapping runs
- **Partial failure detection** — a run with any failed page is marked `FAILED`, not silently succeeded
- **Real-time dashboard** — search, pagination, live "last synced" timestamp
- **Schema inspector** — view the `StockSnapshot` table columns directly from the UI
- **ETL observability** — every run is logged in the `EtlRun` table with timings, inserted/updated counts, and error messages

---

## Setup (Plug & Play)

### 1. Clone the repository

```bash
git clone https://github.com/your-username/etl-unleashed-postgres.git
cd etl-unleashed-postgres
```

### 2. Create your environment file

Copy the example and fill in your credentials:

```bash
cp .env.example .env.local
```

Edit `.env.local`:

```env
UNLEASHED_API_ID=your_api_id
UNLEASHED_API_KEY=your_api_key
DATABASE_URL=your_neon_connection_string
CRON_SECRET=your_secret
```

- **`UNLEASHED_API_ID` / `UNLEASHED_API_KEY`** — from your Unleashed account under Settings → Integrations → API Access
- **`DATABASE_URL`** — your Neon Postgres connection string (e.g. `postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require`)
- **`CRON_SECRET`** — any strong random string; used to protect the ETL trigger endpoints

### 3. Install dependencies

```bash
npm install
```

### 4. Push the database schema

```bash
npm run db:push
```

This creates three tables in your Postgres database: `StockSnapshot`, `EtlRun`, and `EtlLock`.

### 5. Configure your warehouses

Edit [`lib/config/stock-extraction.ts`](lib/config/stock-extraction.ts) to set the warehouse codes you want to sync:

```ts
export const TARGET_WAREHOUSE_CODES = ["U10", "U3"];
```

Replace these with your Unleashed warehouse codes (visible in Unleashed under Settings → Warehouses).

### 6. Run the app

```bash
npm run dev
```

This starts both the Next.js server and the local ETL poller (which triggers the pipeline every 30 seconds while running locally).

### 7. Open in your browser

Navigate to [http://localhost:3000](http://localhost:3000) — you will be redirected to the inventory dashboard.

Click **"Fetch Data"** to trigger your first ETL run. The pipeline will:

1. Connect to the Unleashed API using your credentials
2. Fetch stock-on-hand data for your configured warehouses
3. Transform and store the data in your Postgres database
4. Display your company's real-time inventory in the dashboard

---

## How Other Companies Can Use This

This system is designed to be plug-and-play for any company using Unleashed:

1. **Replace the Unleashed credentials** — set your `UNLEASHED_API_ID` and `UNLEASHED_API_KEY` in `.env.local`
2. **Set your warehouse codes** — update `TARGET_WAREHOUSE_CODES` in `lib/config/stock-extraction.ts`
3. **Point to your database** — set `DATABASE_URL` to your Neon (or any Postgres) connection string
4. **Run the app** — the system will fetch your company's stock data, store it, and display it

The database becomes your inventory layer. The dashboard displays your real-time inventory. The ETL runs automatically every minute via cron (Vercel) or every 30 seconds locally.

---

## Deploying to Vercel

1. Push the repository to GitHub
2. Import it in [Vercel](https://vercel.com)
3. Add all four environment variables in Vercel's project settings
4. Deploy — Vercel will automatically run the ETL cron jobs defined in `vercel.json`:
   - Every minute: incremental CDC sync (`/api/cron/run-etl`)
   - Daily at 04:00 UTC: full refresh (`/api/cron/full-sync`)

---

## API Endpoints

| Endpoint | Auth | Description |
|---|---|---|
| `POST /api/run-etl` | Bearer `CRON_SECRET` | Trigger an ETL run manually |
| `GET /api/cron/run-etl` | Bearer `CRON_SECRET` | Vercel cron — incremental CDC |
| `GET /api/cron/full-sync` | Bearer `CRON_SECRET` | Vercel cron — daily full refresh |
| `GET /api/stock-snapshots` | Public | Paginated inventory data for the UI |
| `GET /api/etl-status` | Public | Current run status and last sync time |
| `GET /api/db/schema` | Public | StockSnapshot column schema |
| `GET /api/extract-stock` | Bearer `CRON_SECRET` | Raw extract diagnostic (admin only) |
| `POST /api/backfill-product-groups` | Bearer `CRON_SECRET` | One-shot product group backfill |

---

## Important Notes

- **CDC cursor granularity** — the Unleashed `StockOnHand` endpoint only accepts a `YYYY-MM-DD` date, not a full datetime. The CDC cursor uses a 30-second overlap buffer, but this only affects behaviour near midnight UTC. The daily full sync compensates for this limitation.
- **This is not a perfect replication system** — CDC depends on Unleashed's `LastModified` field being updated correctly. Records that are modified without updating `LastModified` may be missed until the next daily full sync.
- **Concurrent run protection** — the system uses both a Postgres advisory lock and an `EtlLock` table row to prevent overlapping runs. If a run is in progress, subsequent triggers return `SKIPPED_LOCKED` rather than starting a second run.
- **Partial failures** — if any page fetch fails during extraction, the entire run is marked `FAILED`. Rows that were successfully fetched are still written to the database. The next CDC run will retry from the cursor.

---

## Tech Stack

| Component | Technology |
|---|---|
| Framework | [Next.js 14](https://nextjs.org/) (App Router) |
| ORM | [Prisma](https://www.prisma.io/) |
| Database | [Neon Postgres](https://neon.tech/) |
| Data source | [Unleashed Software API](https://apidocs.unleashedsoftware.com/) |
| Hosting | [Vercel](https://vercel.com/) |

---

## Local Development Variables (Optional)

Add these to `.env.local` to tune the local poller:

```env
LOCAL_ETL_INTERVAL_MS=30000      # How often to trigger ETL locally (ms, min 5000)
LOCAL_ETL_STARTUP_DELAY_MS=10000 # Delay before first trigger after npm run dev
LOCAL_ETL_URL=http://localhost:3000/api/run-etl
LOCAL_ETL_METHOD=POST
```
