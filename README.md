# salon-backend

NestJS REST API powering the Coiffio / Maison Haire platform.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | NestJS 10 |
| Database | MongoDB Atlas (Mongoose 8.7) |
| Auth | Passport-JWT, bcryptjs |
| Validation | class-validator + class-transformer |
| Rate limiting | @nestjs/throttler v5 |
| Real-time | Socket.io (WebSockets module) |
| Runtime | Node.js, TypeScript |

---

## Running locally

```bash
cd salon-backend
npm install
npm run start:dev          # watch mode on port 3000
```

### Environment variables (`.env`)

```
MONGO_URI=<mongodb atlas connection string>
JWT_SECRET=<secret>
JWT_EXPIRES=7d
PORT=3000
DEFAULT_SALON_ID=<24-char ObjectId>
FRONTEND_ORIGIN=http://localhost:5173
DESKTOP_ORIGIN=http://localhost:5174
```

**Production (Render):** `FRONTEND_ORIGIN=https://coiffio-front.vercel.app` and `DESKTOP_ORIGIN=https://coiffio-desktop.vercel.app` — these must be set with NO trailing slash or CORS will block all POST requests.

---

## API

- **Base URL:** `http://localhost:3000/api`
- **Auth scheme:** HttpOnly cookie (`salon_token`) for web clients; `Authorization: Bearer <token>` for mobile/desktop
- **Single salon:** `DEFAULT_SALON_ID` env var — all scoped queries use this. The `salonId` field is always stored/queried as a **plain string**, never a BSON ObjectId.

### Modules & routes

| Module | Routes |
|---|---|
| **Auth** | `POST /auth/login` · `POST /auth/register` · `POST /auth/login-pin` (POS) · `POST /auth/logout` |
| **Team** | `GET/POST /team` · `PATCH/DELETE /team/:id` · `GET /team/:id` |
| **POS** | `GET /pos/roster` · `POST /pos/clock-in` (PosScopeGuard) |
| **Schedule** | `GET /team/:id/schedule` · `PATCH /team/:id/schedule` · Leave endpoints |
| **Booking** | `POST /appointments` · `GET /appointments` · `PATCH /appointments/:id` etc. |
| **Services** | `GET/POST /services` · `PATCH/DELETE /services/:id` |
| **Finance** | Expenses, payments, overview |
| **Stock** | `GET/POST /products` · `GET /stock/moves` |
| **Sales** | `POST /sales` · `GET /sales` |
| **Orders** | Cart + order lifecycle |
| **Clients** | Client CRM |
| **Notifications** | WebSocket + notification store |
| **Overview** | Dashboard aggregates |
| **Settings** | Salon config, roles, business hours |
| **Public** | Unauthenticated storefront data (landing, team, services, testimonials) |

### Auth flow

- `POST /auth/login` checks **Staff** collection first, then **User** (client). JWT payload carries `{ sub, role, accountType: 'staff'|'client', salonId }`.
- `POST /auth/login-pin` — POS-only, issues `{ staffId, salonId, scope: 'pos' }` token (12 h). Staff must have `posEnabled: true` and a `pinHash` set. 5 wrong attempts → 30 s lockout stored on the Staff document.
- Staff self-register is **blocked**. Only an owner can create staff via `POST /team`.

---

## MongoDB schemas

| Collection | Description |
|---|---|
| `staffs` | Owner / manager / stylist / colorist. Has `pinHash` (select:false), `posEnabled`, `lastClockIn`, `pinAttempts` (select:false), `pinLockedUntil` (select:false), embedded `week` schedule, `publicProfile` |
| `staffprofiles` | HR metadata (level, capabilities, baseRate, commissionPct). `userId` refs `staffs._id` |
| `users` | Client accounts only (role = 'client') |
| `clients` | Booking clients (CRM, not auth accounts) |
| `appointments` | `stylistId` refs `staffs`, `clientId` refs `clients` |
| `services` | Bookable services |
| `products` | Retail inventory |
| `stockmoves` | Inventory adjustments |
| `sales` | POS retail sales |
| `payments` | Financial ledger |
| `expenses` | Expense tracking |
| `leaverequests` | Staff leave/absence |
| `notifications` | WebSocket-delivered notifications |
| `salons` | Salon config (one doc per salon) |
| `salonroles` | Role definitions |
| `schedules` | Per-stylist date overrides (weekly shifts live in `Staff.week`) |
| `testimonials` | Public testimonials |
| `orders` / `carts` | Storefront e-commerce |

### Known `salonId` invariant

`salonId` is always stored and queried as a **plain string**. Never wrap it in `new Types.ObjectId(...)` before a write or query — the field instance is `Mixed` in Mongoose and BSON string ≠ BSON ObjectId, so mismatches silently return empty results with no error.

---

## Seeding & scripts

No dummy data is used. All data is real MongoDB documents.

| Script | Purpose |
|---|---|
| `npm run seed` | Seeds initial salon, staff, and services |
| `npx ts-node src/scripts/seed-pos-pins.ts` | Sets `pinHash` + `posEnabled:true` on staff. Requires `SEED_PIN=XXXX` env var (4 digits, not `1234`). Optionally `STAFF_EMAIL=...` to target one person |
| `npx ts-node src/scripts/migrate-identity.ts` | Identity migration utility |
| `npx ts-node src/scripts/reset-password.ts` | One-off password reset |

**POS kiosk will show an empty staff grid until `seed-pos-pins.ts` runs.**

---

## Key design decisions

- **Stylist + colorist are both bookable.** The booking domain treats `role: { $in: ['stylist','colorist'] }` everywhere. `owner`/`manager` are administrative only.
- **Date strings are timezone-naive.** Business-day strings (`YYYY-MM-DD`) are built and compared without timezone conversion on the backend. The frontend must use `localDateISO()` (never `toISOString()`) to avoid off-by-one-day bugs for UTC+ timezones.
- **`salonId` single-tenant.** All data is scoped to one salon. Multi-salon support is a `// TODO` (some screens show a "Locked" teaser in the design).
- **POS tokens never use cookies.** Desktop/kiosk reads token from `sessionStorage` (swap seam for Tauri secure store) and sends it as Bearer header.

---

## Deployment

- **Platform:** Render (auto-deploys from main branch when configured)
- **URL:** `https://coif-backend.onrender.com`
- Setting env vars on Render does **not** auto-redeploy — trigger a manual deploy after any env var change.
