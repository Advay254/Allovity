# Architecture

One deployable Node service. Presentation, routing, business logic and data access live in separate folders, and the Express app is built by a function so tests can use it without opening a port.

## Folder layout

```text
src/
  server.ts          Process entry: config, migrations, listen, graceful shutdown
  app.ts             createApp(deps): builds the Express app, never listens
  config/            env.ts (schema and validation), site.ts (brand copy), nav.ts (navigation)
  http/              Middleware: request context, security headers, rate limit, rendering, errors
  routes/            Thin route modules: public, health, seo, and admin/ (one file per admin area)
  admin/             Admin services: sign-in, sessions, users, limits, audit, middleware
  services/          Business logic (health today; later features go here)
  db/                pool.ts (connection and TLS) and migrate.ts (runner)
  security/          Rate limit stores (memory and Postgres), crypto, passwords, TOTP, permissions
  lib/               Small helpers: logger, client IP, icons, asset manifest, paths
  client/            Static browser scripts (no build step)
  styles/            Tailwind entry files and shared component CSS
views/               EJS layout, partials, pages and admin views
migrations/          Numbered SQL files
brand/               Placeholder brand sources (SVG)
deploy/              Optional example configuration for specific hosts
scripts/             Asset build and icon generation
tests/               Vitest suites; tests/browser holds the Chromium checks
docs/                This documentation
```

Dependencies point one way: routes call services, services call db, views receive plain data. Routes contain no SQL.

## Main decisions

- **Migrations at startup.** Operators should not have to run SQL by hand, and the app should work on any host. A runner applies numbered files, each in its own transaction, and records them in `schema_migrations` with a checksum. An advisory lock makes concurrent starts safe. Editing an applied file stops startup with a clear message, because migrations must only move forward.
- **Security does not depend on the host.** The content security policy, headers, rate limiting and error handling are all set by the app. Platform settings are an extra layer.
- **No inline scripts or styles.** The content security policy has no `unsafe-inline`. A small external script in the head adds the `js` class before first paint, for the no-JavaScript navigation fallback.
- **Hashed static files.** `scripts/build-assets.mjs` writes content-hashed files and a manifest, so static files can be cached for a year while HTML stays on a 60 second cache.
- **Raster assets are built, not committed.** The favicon, app icons and social image are rendered from the SVG files in `brand/` during the build. Replacing a placeholder means replacing an SVG.
- **Two CSS bundles, one token file.** `tailwind.theme.cjs` defines the palette once and generates the CSS variables. The site is light only, so there is one palette and no theme switching. Colours are RGB triplets so opacity utilities work.
- **Rate limit storage behind an interface.** `RateLimitStore` can be replaced by a shared store later without touching the middleware. The in-memory store is bounded by a key cap and scheduled pruning.
- **The admin path is an extra layer only.** It is hidden from robots.txt, logs and search engines, but nothing relies on its secrecy for protection.
- **Host-neutral.** Nothing in the application or the Dockerfile depends on a particular hosting platform. Host-specific files live in `deploy/` and are optional.

## Dependencies

Runtime:

| Package         | Why                                                               |
| --------------- | ----------------------------------------------------------------- |
| express         | HTTP server and routing (version 4 as specified)                  |
| ejs             | Server-rendered views                                             |
| pg              | PostgreSQL driver and connection pool                             |
| zod             | Schema validation of environment variables                        |
| helmet          | Security headers, including the content security policy           |
| compression     | Response compression                                              |
| @node-rs/argon2 | Argon2id password hashing (prebuilt binaries, no compiler needed) |
| otpauth         | Time-based one-time codes (RFC 6238)                              |
| qrcode          | Draws the authenticator QR code as inline SVG on the server       |

Development and build:

| Package                                                   | Why                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| typescript, tsx                                           | Strict compilation, and running TypeScript in development                         |
| tailwindcss                                               | CSS compiler (3.4)                                                                |
| sharp                                                     | Renders PNG icons and the social image from the brand SVG files at build time     |
| @fontsource-variable/space-grotesk, inter, jetbrains-mono | Font files that the build copies so fonts are self-hosted                         |
| lucide-static                                             | Source of the inline SVG icons (copied into code by `scripts/generate-icons.mjs`) |
| vitest, supertest                                         | Test runner and HTTP assertions                                                   |
| playwright-core                                           | Browser checks, driven against an installed Chrome or Chromium                    |
| eslint, typescript-eslint, @eslint/js, prettier           | Linting and formatting                                                            |
| @types/*                                                  | Type definitions                                                                  |

## Admin area (1.1.0)

- `src/admin/` holds the services: `auth.ts` (sign-in, two-step, enrolment, password change), `sessions.ts`, `users.ts`, `user-admin.ts` (role and status changes with the last-owner lock), `limits.ts` (failure counting and waits), `csrf.ts`, `middleware.ts`, `bootstrap.ts`, `audit.ts` and `nav.ts`.
- `src/routes/admin/` holds the routes, one file per area. Every route sits behind the same chain: no-store headers, a general request limit, session loading, then `requireSignedIn` and `requirePermission` where needed.
- `src/security/` holds the building blocks: key derivation and AES-GCM (`crypto.ts`), Argon2id and the password rules (`password.ts`), TOTP (`totp.ts`), roles and permissions (`permissions.ts`) and the shared Postgres rate limit store.
- To add an admin section later: add one entry to `ADMIN_NAV`, add a route file that uses `requireSignedIn` and `requirePermission('<permission>')`, and add its permission to `permissions.ts`.

## Running the tests

`npm test` needs a Postgres server it can create databases on. It reads `TEST_DATABASE_ADMIN_URL` (default `postgres://postgres:postgres@127.0.0.1:5432/postgres`) and creates and drops one uniquely named database per suite. `npm run test:browser` needs Chrome or Chromium: set `CHROMIUM_PATH` to its binary.

## Spacing and shape rules

Corner radii are 6, 10, 16 and 24 px. A child inside a parent uses the next size down (for example 6 px options inside a 10 px control). The container is 1200 px wide with a 24 px gutter, 16 px below 400 px. Fast transitions are 150 ms, normal ones 250 ms, entrances use ease-out.
