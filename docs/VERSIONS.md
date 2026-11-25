# Version log

## 1.0.0: Foundation

- Single Node application: TypeScript, Express 4, EJS, Tailwind 3.4 with separate public and admin bundles built from one token file.
- Configuration validated at startup, structured JSON logging with request identifiers, graceful shutdown.
- Postgres schema that creates itself through numbered migrations (site settings and audit log).
- Security baseline: strict content security policy with no inline allowances, security headers, rate limiter, safe client IP handling.
- Design system, shared layout, header with mobile drawer, footer, theme control (system, light, dark).
- Public pages: home, custom 404 and 500, liveness and readiness endpoints, robots.txt and a minimal sitemap.xml.
- Admin entrance placeholder at a secret path (4 to 20 characters, set by the owner).
- Dockerfile, host-neutral deployment guide, optional example Render blueprint, environment reference, placeholder brand assets.
