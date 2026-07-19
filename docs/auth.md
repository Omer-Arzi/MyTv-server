# Session auth

## Why this exists

This app has exactly one real user (`DEV_USER_ID`, see `src/common/constants.ts`)
— it was built for personal use, never multi-tenant. `DevUserMiddleware`
attaches that fixed user to every request regardless of this doc; nothing
here changes *who* a request is treated as.

The gap this closes: once the server moved from "only reachable on my Mac's
LAN" to a public Railway URL, anyone who found that URL had full read/write
access to real watch history and could spend the TMDb API quota — with zero
login. Building real multi-user auth (accounts, password hashing, per-user
data isolation) would be a large scope increase for an app that will only
ever have one user. What's actually needed is much narrower: a gate that
stops a random visitor, not a full identity system.

## The design: one shared password, one bearer token

- `POST /auth/login` checks a plaintext body password against `APP_PASSWORD`
  (an env var — not stored anywhere, not hashed, because there's no
  database of users to hash it against). On success it signs a JWT
  (`{ sub: DEV_USER_ID }`, `SESSION_SECRET`, 30-day expiry) and returns it in
  the response body as `{ token }`.
- The client stores that token and sends it back as
  `Authorization: Bearer <token>` on every subsequent request.
  `SessionAuthGuard` (`src/modules/auth/session-auth.guard.ts`), registered
  globally via `APP_GUARD`, requires a valid one on every route except ones
  marked `@Public()` (`POST /auth/login`).
- `GET /auth/status` exists purely so the mobile client has a cheap,
  side-effect-free way to ask "is my session still valid" — a 401 there
  means "show the login screen", a 200 means proceed straight to the app.

**Local dev is unaffected.** Neither `APP_PASSWORD` nor `SESSION_SECRET` is
set in a normal local `.env` — `SessionAuthGuard` treats an unset
`APP_PASSWORD` as "this deployment deliberately disabled the gate" and lets
every request through, exactly like before this existed. `AuthService.
validatePassword` mirrors this: without `APP_PASSWORD` configured, login
always trivially succeeds rather than rejecting every attempt. Only a
deployment that sets both — the Railway instance — actually enforces
sessions.

## Why a bearer token, not a cookie

The first version of this used an httpOnly session cookie instead, which
seemed like the more conventional choice — until it turned out not to work
at all for the one platform this whole PWA effort was built for. Railway
deploys each service on its own `*.up.railway.app` subdomain, and
`*.up.railway.app` is registered on the [Public Suffix
List](https://publicsuffix.org/) specifically so that different Railway
customers' apps can't share cookies with each other. That makes
`mytv-server-production.up.railway.app` and
`client-production-xxxx.up.railway.app` genuinely different *sites* to a
browser's cookie jar, not just different subdomains of one site — which
makes the session cookie a **third-party cookie** from the mobile PWA's
point of view. Safari (and iOS Safari specifically, which is the actual
target platform here — the entire reason this app became a PWA was to
install it on an iPhone home screen without an Apple Developer account)
blocks third-party cookies by default. The cookie-based version worked
fine in an automated Chromium test (Chromium's default context is more
lenient here) and then didn't work at all for the real user on the real
device — caught only by hands-on testing, not by anything a broader
automated check would have flagged.

A bearer token sent via the `Authorization` header isn't a cookie at all,
so none of this applies — it works identically on Safari, Chrome, iOS, or
anywhere else, which is exactly why it's the right mechanism for a
cross-subdomain deployment like this one, independent of which platform's
cookie policy happens to be strictest this year.

## What this is and isn't

This is honestly a speed bump, not real security, and that's a deliberate
trade-off given the actual threat model (a personal TV-tracking app with no
financial or sensitive-PII data, whose realistic risk is opportunistic
scanning/URL-guessing, not a targeted attacker). It stops:

- Search engines and scanners finding the URL and hitting live routes.
- Someone stumbling on the link without deliberately trying to get in.

It does **not** stop someone who deliberately inspects network traffic — the
JWT itself is a bearer token; anyone who has it (e.g. by reading it off a
shared screenshot, or a compromised device) has full access until it
expires or `SESSION_SECRET` is rotated. There's no per-request scoping, no
rate limiting, no distinguishing "the real user" from "whoever holds a
valid token" — there's only one user, so there was never anything to
distinguish.

## CORS

`CORS_ORIGIN` (the deployed mobile app's origin) is still read as an
allowlist in `main.ts`, mostly as reasonable defense-in-depth — unset
locally, it falls back to reflecting any request's origin, the same
permissive behavior `app.enableCors()` had before any of this existed.
Since auth is a header now, not a cookie, `credentials: true` isn't needed
here at all (that flag only ever mattered for cookies).

## Env vars (`.env.example`)

| Var | Local dev | Railway |
|---|---|---|
| `APP_PASSWORD` | unset — gate disabled | the one login password |
| `SESSION_SECRET` | unset | a random signing key (`openssl rand -base64 32`), never reused across environments |
| `CORS_ORIGIN` | unset — reflects any origin | the mobile PWA's deployed origin |
