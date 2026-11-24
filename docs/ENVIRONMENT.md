# Environment variables

Every variable the app reads. Required values stop startup with a message that names the variable and never prints its value. Optional values that are wrong produce a warning in the logs and fall back to the default, so a configuration detail cannot take the live site down.

`.env.example` holds the same list with placeholder values. Keep both files updated in every version.

## Required

| Name              | Purpose                                                                                                          | Default | Example                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------- |
| `DATABASE_URL`    | Postgres connection string.                                                                                      | none    | `postgresql://USER:PASSWORD@HOST:5432/DBNAME` |
| `PUBLIC_SITE_URL` | Public address of the site. Used for canonical links, the social image and the sitemap. Only the origin is used. | none    | `https://www.example.com`                     |
| `ADMIN_PATH_SLUG` | Secret path of the admin entrance. At least 16 characters: letters, digits, underscore and hyphen. Never logged. | none    | `k3x9Qm7vT2pLw8Zr4NbY`                        |

## Optional

| Name                        | Purpose                                                                                                                                            | Default       | Example      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------ |
| `NODE_ENV`                  | `production` turns on strict transport security and view caching.                                                                                  | `development` | `production` |
| `PORT`                      | Port to listen on. Render sets this itself.                                                                                                        | `3000`        | `10000`      |
| `LOG_LEVEL`                 | `debug`, `info`, `warn` or `error`.                                                                                                                | `info`        | `info`       |
| `TRUSTED_PROXY_HOPS`        | Number of proxies in front of the app. Controls which address counts as the visitor's IP. Use 1 on Render. With 0, forwarding headers are ignored. | `0`           | `1`          |
| `RUN_MIGRATIONS`            | Apply pending migrations at startup.                                                                                                               | `true`        | `true`       |
| `DATABASE_SSL`              | `auto` uses TLS for any non-local host. `require` forces it. `disable` turns it off.                                                               | `auto`        | `auto`       |
| `DATABASE_SSL_STRICT`       | Verify the database server certificate. Leave off unless your host provides a certificate chain that Node trusts.                                  | `false`       | `false`      |
| `DB_POOL_MAX`               | Maximum database connections in the pool.                                                                                                          | `10`          | `10`         |
| `DB_STATEMENT_TIMEOUT_MS`   | Query timeout in milliseconds.                                                                                                                     | `15000`       | `15000`      |
| `RATE_LIMIT_MAX`            | Requests allowed per visitor in each window.                                                                                                       | `300`         | `300`        |
| `RATE_LIMIT_WINDOW_SECONDS` | Length of the rate limit window.                                                                                                                   | `60`          | `60`         |
| `RATE_LIMIT_MAX_KEYS`       | Cap on tracked visitors, which bounds memory.                                                                                                      | `10000`       | `10000`      |
| `SHUTDOWN_TIMEOUT_MS`       | How long in-flight requests get to finish on shutdown.                                                                                             | `10000`       | `10000`      |

Boolean values accept `true`, `false`, `1`, `0`, `yes` and `no`.

## Warnings you may see in the logs

- `TRUSTED_PROXY_HOPS is 0 in production`: set it to the number of proxies in front of the app, otherwise every visitor shares one IP address for rate limiting.
- `PUBLIC_SITE_URL uses http in production`: canonical links should use https.
- `DATABASE_SSL is disable in production`: database traffic is not encrypted.
