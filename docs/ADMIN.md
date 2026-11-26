# Admin area

How sign-in and access work, what each role can do, and how to recover.

## Roles and permissions

Access is denied unless a role is explicitly granted the permission. The list lives in `src/security/permissions.ts`.

| Permission        | Owner | Admin | Editor |
| ----------------- | ----- | ----- | ------ |
| `account.self`    | yes   | yes   | yes    |
| `users.manage`    | yes   | yes   | no     |
| `audit.view`      | yes   | yes   | no     |
| `settings.manage` | yes   | yes   | no     |
| `content.edit`    | yes   | yes   | yes    |

Rules for managing people:

- Nobody can grant a role higher than their own.
- Nobody can change, deactivate or reset themselves from the Users page.
- Owners can manage everyone else, including other owners.
- Admins can create admins and editors and manage editors only. They cannot touch owners or other admins.
- The last active owner can never be deactivated or demoted. The check runs under a database lock, so two owners acting at the same moment cannot remove each other.
- Changing a role, deactivating, or resetting two-step verification ends all of that person's sessions at once.

Sensitive actions (change password, turn off two-step, new recovery codes, every Users action) ask for the current password unless it was entered in the last 5 minutes.

## Sign-in protection

- Passwords: Argon2id, 19 MiB memory, 2 iterations, 1 lane (OWASP minimum). 12 to 128 characters, not on the common list, and no email or name inside.
- Unknown email, wrong password and inactive account give the same message, status and (about) the same time, because every attempt costs one hash comparison.
- Failures are counted per account and address (limit `ADMIN_LOGIN_MAX_FAILURES`, default 5 in 15 minutes), per account (4 times the limit, which catches attacks spread over many addresses) and per address (4 times the limit). At a limit the response is 429 with `Retry-After`, and the password is not checked. The wait ends by itself when the sliding count falls, plus up to 3 extra minutes for people who keep trying. Nobody is locked out for good, and a stranger's failures from another address do not block the owner.
- Counters live in the `rate_limit_hits` table with an atomic update, a scheduled prune and a hard row cap of 50,000.
- Two-step codes are counted the same way. A code is accepted once: the last used 30 second step is stored and older or equal steps are refused.
- All admin pages are sent with `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow, noarchive` and `Referrer-Policy: no-referrer`. A general limit of 120 admin requests per minute per network also applies.

## Sessions and cookies

- The browser holds a random token in an `HttpOnly`, `SameSite=Strict` cookie scoped to the admin path. In production it is named with the `__Secure-` prefix and is `Secure`. There is no expiry date, so it ends with the browser.
- The server stores only a SHA-256 hash of the token, plus expiry times: 30 minutes idle and 12 hours absolute by default.
- A new token is issued on sign-in, after two-step verification, and after a password change. The old one stops working at once.
- The account page lists active sessions and can sign out one or all others.

## Two-step verification

Authenticator secrets are encrypted with AES-256-GCM using a key derived from `ADMIN_SECRET_KEY` (HKDF, one key per purpose). Recovery codes are shown once, stored only as keyed hashes, and each works once. Turn-off is blocked while `ADMIN_REQUIRE_2FA` is on. If someone loses their phone, an owner (or an admin, for editors) uses "Reset two-step" on the Users page.

## Audit log

Sign-ins, failures, throttling (once per episode), sign-outs, password and two-step changes, recovery code use, and every user management action are recorded with who, what, when and the address. Passwords, codes and tokens are never recorded. The table rejects updates, deletes and truncation at the database.

## Recovery

See "If you lose access" in `docs/DEPLOYMENT.md`.

## Known limits

- Rate limiting is only as good as the address the proxy reports: keep `TRUSTED_PROXY_HOPS` correct.
- Someone who controls the host's environment settings can use emergency recovery. That is by design: they already control the system.
- The common password list is small and built in. It catches the obvious ones, not every leaked password.
