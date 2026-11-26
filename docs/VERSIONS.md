# Version log

## 1.1.0: Admin sign-in and security

- Admin accounts in the database with Argon2id passwords, three roles (owner, admin, editor) and a single permission list that denies by default.
- Sign-in with identical responses for unknown email, wrong password and inactive account; failure limits per account and address, per account, and per network, stored in Postgres so they hold across restarts and instances; throttled attempts never check the password.
- Two-step verification (authenticator app, 30 second codes, replay refused), ten single-use recovery codes, mandatory in production by default.
- Server-side sessions: random token, only its hash stored, rotated on sign-in, after two-step, after a password change; idle and absolute expiry; sign out and revoke from the account page.
- Forgery protection on every state-changing admin request (per-session token plus a same-site check using fetch metadata or Origin).
- Account page (password, two-step, recovery codes, sessions), Users page (create, change role, deactivate, reactivate, reset two-step) and Audit log page.
- First owner from environment variables, and an emergency recovery switch. Admin switches itself off (503) if its secret is missing, without affecting the public site.
- Migration `0002_admin_auth.sql` adds the admin tables and the rate limit table, and blocks `TRUNCATE` on the audit log.
- Fix found while testing: the admin pages send `Referrer-Policy: no-referrer`, which makes browsers send `Origin: null` on form posts. The same-site check now relies on fetch metadata first, so sign-in works in real browsers.

## 1.0.1: Light theme only

- Removed the dark palette, the theme control and all theme scripts. The site has one light design.
- Browsers are told the site is light only (`color-scheme: only light`, plus a meta tag on both layouts), so a visitor with a dark phone setting still sees the light design.
- One `theme-color` value (the light background) on both layouts.
- `theme-init.js` became `page-init.js`; it only adds the `js` class used by the no-JavaScript navigation fallback.
- Social sharing image redrawn on the light background; app icon is now the brand blue square with a white symbol. Dark wordmark file removed.
- Nothing about theme is stored in the browser.

## 1.0.0: Foundation

- Single Node application: TypeScript, Express 4, EJS, Tailwind 3.4 with separate public and admin bundles built from one token file.
- Configuration validated at startup, structured JSON logging with request identifiers, graceful shutdown.
- Postgres schema that creates itself through numbered migrations (site settings and audit log).
- Security baseline: strict content security policy with no inline allowances, security headers, rate limiter, safe client IP handling.
- Design system, shared layout, header with mobile drawer, footer, theme control (system, light, dark). The theme control was removed in 1.0.1.
- Public pages: home, custom 404 and 500, liveness and readiness endpoints, robots.txt and a minimal sitemap.xml.
- Admin entrance placeholder at a secret path (4 to 20 characters, set by the owner).
- Dockerfile, host-neutral deployment guide, optional example Render blueprint, environment reference, placeholder brand assets.
