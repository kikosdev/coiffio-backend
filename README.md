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
FRONTEND_ORIGIN=http://localhost:5173
DESKTOP_ORIGIN=http://localhost:5174
BACKOFFICE_ORIGIN=http://localhost:5175
MOBILE_ORIGINS=exp://192.168.x.x:8081,coiffio://app
PRIVACY_POLICY_URL=https://coiffio.com/privacy
```

**Production (Render):** `FRONTEND_ORIGIN=https://coiffio-front.vercel.app` and `DESKTOP_ORIGIN=https://coiffio-desktop.vercel.app` (plus `BACKOFFICE_ORIGIN` for the back-office console) — these must be set with NO trailing slash. Native/mobile REST and Socket.io calls with no `Origin` header are allowed; custom dev-client origins can be listed in `MOBILE_ORIGINS`.

---

## API

- **Base URL:** `http://localhost:3000/api`
- **Auth scheme:** HttpOnly cookie (`salon_token`) for web clients; `Authorization: Bearer <token>` for mobile/desktop
- **Multi-tenant:** the active tenant is resolved per-request from the JWT's `memberships[]` (via `X-Tenant-Id` when ambiguous) — see `TenantContextMiddleware`. Public/anonymous routes resolve the tenant from the `:salonSlug` URL param or subdomain instead. The `salonId` field is always stored/queried as a **plain string**, never a BSON ObjectId.

### Modules & routes

| Module | Routes |
|---|---|
| **Auth** | `POST /auth/login` · `POST /auth/register` · `POST /auth/login-pin` (POS) · `PATCH /auth/me/deactivate` · `PATCH /auth/me/push-token` · `POST /auth/logout` |
| **Team** | `GET/POST /team` · `PATCH/DELETE /team/:id` · `GET /team/:id` |
| **POS** | `GET /pos/roster` · `POST /pos/clock-in` (PosScopeGuard) |
| **Schedule** | `GET /team/:id/schedule` · `PATCH /team/:id/schedule` · Leave endpoints |
| **Booking** | `POST /appointments` · `GET /appointments` · `GET /appointments/mine` · `GET /staff/today` · `GET /staff/schedule/week` · `GET /client/home` · `PATCH /appointments/:id/cancel` |
| **Services** | `GET/POST /services` · `PATCH/DELETE /services/:id` |
| **Finance** | Expenses, payments, overview |
| **Stock** | `GET/POST /products` · `GET /stock/moves` |
| **Sales** | `POST /sales` · `GET /sales` |
| **Orders** | Cart + order lifecycle |
| **Clients** | Client CRM |
| **Notifications** | WebSocket + notification store + Expo push delivery to stored user tokens |
| **Overview** | Dashboard aggregates · `GET /owner/hq` mobile aggregate |
| **Settings** | Salon config, roles, business hours |
| **Public** | Unauthenticated storefront data (landing, team, services, testimonials) · `GET /config/public` |

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
- **Check-in codes are stored.** New appointments receive a `BXXX` `checkInCode` that is unique per salon/day using `appointments(salonId,startDay,checkInCode)`.
- **Notifications scope staff separately from users.** Realtime dispatch can target `user:{userId}`, `staff:{staffId}`, `role:{role}`, or `salon:{salonId}`; persisted notifications store `staffId` when the recipient is a staff profile.
- **Expo push delivery is tied to stored user tokens.** Mobile clients register tokens with `/auth/me/push-token`; notification dispatch resolves user/staff/role recipients, sends to Expo, and clears tokens reported as `DeviceNotRegistered`.
- **Owner deactivation is guarded.** `/auth/me/deactivate` blocks the last active owner in a salon so ownership cannot be orphaned.
- **Date strings are timezone-naive.** Business-day strings (`YYYY-MM-DD`) are built and compared without timezone conversion on the backend. The frontend must use `localDateISO()` (never `toISOString()`) to avoid off-by-one-day bugs for UTC+ timezones.
- **`salonId` single-tenant.** All data is scoped to one salon. Multi-salon support is a `// TODO` (some screens show a "Locked" teaser in the design).
- **POS tokens never use cookies.** Desktop/kiosk reads token from `sessionStorage` (swap seam for Tauri secure store) and sends it as Bearer header.

---

## Deployment

- **Platform:** Render (auto-deploys from main branch when configured)
- **URL:** `https://coif-backend.onrender.com`
- Setting env vars on Render does **not** auto-redeploy — trigger a manual deploy after any env var change.
