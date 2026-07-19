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

## The design: one shared password, one session cookie

- `POST /auth/login` checks a plaintext body password against `APP_PASSWORD`
  (an env var — not stored anywhere, not hashed, because there's no
  database of users to hash it against). On success it signs a JWT
  (`{ sub: DEV_USER_ID }`, `SESSION_SECRET`, 30-day expiry) and sets it as an
  httpOnly session cookie (`mytv_session`).
- `SessionAuthGuard` (`src/modules/auth/session-auth.guard.ts`), registered
  globally via `APP_GUARD`, requires a valid cookie on every route except
  ones marked `@Public()` (`POST /auth/login`, `POST /auth/logout`).
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
valid cookie" — there's only one user, so there was never anything to
distinguish.

## CORS: why credentials + an explicit origin, not `*`

The mobile PWA and this API are deployed on different Railway subdomains,
so the session cookie is cross-site by construction — that requires
`SameSite=None; Secure` (see `sessionCookieOptions()` in `auth.controller.
ts`), and cookies only travel on a cross-origin request if the response's
CORS headers include `Access-Control-Allow-Credentials: true` *and* a
specific `Access-Control-Allow-Origin` (browsers reject the credentialed
combination with a wildcard origin). `main.ts` reads `CORS_ORIGIN` (the
deployed mobile app's origin) for this; unset locally, it falls back to
reflecting any request's origin — the same permissive behavior
`app.enableCors()` had before this existed.

## Env vars (`.env.example`)

| Var | Local dev | Railway |
|---|---|---|
| `APP_PASSWORD` | unset — gate disabled | the one login password |
| `SESSION_SECRET` | unset | a random signing key (`openssl rand -base64 32`), never reused across environments |
| `CORS_ORIGIN` | unset — reflects any origin | the mobile PWA's deployed origin |
