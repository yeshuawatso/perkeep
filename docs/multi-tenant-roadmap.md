# Multi-tenant Perkeep roadmap

**If you are a fresh session with no other context: read this whole file before doing
anything else.** It is the single source of truth for this effort -- more authoritative than
any conversation summary, and more complete than any ephemeral plan file (plan files live
outside the repo, are tied to one conversation, and are not updated after that conversation
ends; this file is).

## 🚨 OPEN, UNRESOLVED SECURITY BUG -- read before trusting Phase 2's "done" status

Reported 2026-10-26 by the user, hands-on in the real browser UI (not a scripted check): **a
non-admin user, logging into the web UI normally, sees every set and file at the root
("Browse") view -- names and SHA/blobref digests both -- not just their own.** This directly
contradicts Phase 2's entire premise and must be root-caused and fixed before Phase 2 can be
considered actually done, regardless of what the status table below says.

**What's already ruled out** (verified live, this session, right before running out of time):
sending the *exact* `ROOT_BROWSE_CONSTRAINT` the UI's `SearchPage.jsx` default view sends
(`server/perkeepd/ui-src/src/api/client.js`) via the raw `/camli/search/query` API, as two
brand-new non-admin test users (one creates a canary permanode, the other queries) -- **the
canary did NOT leak**. So the core `Query`-layer owner-filter (Phase 2 step 5) does correctly
handle this specific constraint shape for freshly-created data. Script kept at
`verify-root-browse-leak.mjs` in scratch (recreate if scratch is gone -- it's short, see its
source for the exact constraint JSON).

**What this means**: the leak the user saw with their own eyes is real, but either (a) scoped
to **pre-existing / legacy / backfilled data** specifically (the 12 real content permanodes +
"New set" collection that predate `camliAccountRef` and got assigned to the bootstrap account
via step 3's `backfillOwnership` -- untested against a *second* non-admin viewer, only tested
"does the owner still see it correctly" and "does a brand-new unrelated user NOT see brand-new
data"), (b) a different code path than `SearchPage.jsx`'s default view that the user's actual
browser session hit (check what the browser *actually* requested -- dev tools Network tab, or
server access logs -- before assuming it's the same `search()` call), (c) stale client-side
cache/service-worker data from an earlier (e.g. admin) login session in the same browser profile
not cleared before switching accounts, or (d) something in `ResultsGrid`/`useSearchSession`
(`server/perkeepd/ui-src/src/hooks/useSearchSession.js`) beyond the single `search()` call
already checked. **Did not have time to narrow further.**

**First steps for the next session**:
1. Ask the user exactly which account they logged in as, whether it was a hard-refreshed/fresh
   browser session or an existing tab, and whether the visible content was `chaos`'s real
   pre-existing files specifically or something else.
2. Reproduce with the browser's Network tab open (or server-side request logging) to capture
   the *actual* request(s) the page sent -- don't assume it's `ROOT_BROWSE_CONSTRAINT` again
   without checking, since that's exactly the one lead already ruled out.
3. If it is pre-existing/backfilled data specifically: write a live repro using a *second*,
   brand-new non-admin test user against the real existing content (`FILE_REF =
   "sha224-1b809050bc3eb30480590961fe6ec8921083ac197d2fbbe2220f7ec7"`, owned by `chaos`, used
   throughout this session's other verification scripts) through the exact `ROOT_BROWSE_CONSTRAINT`
   query -- this session only ever tested that file through *other* routes (download/thumbnail/
   raw blob), never through this specific root-browse query.
4. Do not mark Phase 2 "done" again until this is root-caused, fixed, and re-verified with a
   fresh non-admin browser login (not just a scripted API check) against real pre-existing data.

**How to resume:** check the status table immediately below. Find the first phase marked
`not started`. Read that phase's section in full -- it has everything discovered so far that's
relevant to it. Then run a fresh `EnterPlanMode` pass to turn that section into a detailed,
file-level implementation plan (the roadmap sections below are deliberately high-level for
every phase except the one currently in progress -- don't start writing code straight from
the roadmap bullets). Update this file's status table and the relevant phase section as part
of the commit(s) that finish the phase, before moving to the next one.

## Status

| Phase | Status | Commits |
|---|---|---|
| 0. This document | done | a60a10fd4 |
| 1. Admin roles & user management | done | 44480e3a3, ab2b44ae4, 78b4055d9, 4bb940484, a37028295, 298e3b1bf, b2acfbb5b, 079a8a79b |
| 2. Real per-user file isolation | 🚨 **REOPENED -- not actually done.** 10 steps shipped and scripted-verified, but the user hands-on found a live root-browse leak (non-admin sees all sets/files, names+hashes) that scripted checks didn't catch. See the 🚨 section at the top of this doc. | cc8d0709e, a341f9e93, b78b71a92, 429a24861, 442b45f0a, 47efa17c9, b82f97200, 8d6bc5a9b, 563072e84, efdeab040, 5bd328fe4, a8ff849f6, ec7287936, d5bc49efd |
| 3. Messaging bus + SMTP + Notifications tab | not started | — |
| 4. Self-signup + email verification + forgot-password | not started | — |
| 5. Share with Others (local/registered/external) | not started | — |
| 6. User profile Importers tab | not started (deferred) | — |

Context already shipped *before* this roadmap existed, assumed done by every phase below:
single-user JWT login (`pkg/accounts`, `pkg/auth/jwtauth.go`), replacing HTTP Basic auth; a
bootstrap account created from `"auth": "jwt:user:pass"` in server-config.json; per-user API
tokens (create/revoke) for curl/scripting; an Account page (change username/password, API
tokens). See `git log` on this branch (`react-bootstrap-ui`) around the `feat(auth):` commit
for that work if you need its detail -- it's not re-described here since it's finished and
stable, not part of this roadmap's remaining work.

## User's original request (verbatim intent, for when a summary might lose nuance)

The person driving this wants to turn bare-bones single-user Perkeep into a multi-user
platform:

- Add new users and isolate their files from each other.
- A "Share with Others" option with three target modes: **local users** (searchable picker,
  other accounts on this instance), **registered users** (same accounts, but addressed by
  exact email/username/content-hash handle instead of browsing -- confirmed in planning to be
  the *same account pool* as "local," not cross-instance federation), **external users**
  (plain email address, or a time-limited link, no account needed).
- User registration: the first user created is the default admin. Simple binary role: admin
  or not. Admins can create users, delete users, and impersonate registered users. Admins can
  delegate (grant) authority to others and can revoke their *own* admin authority, but can
  **never** grant admin to themselves (stated for both admins and non-admins -- granting
  always requires a different target than the caller). There must always be at least one
  admin. In "Registered Users" mode, self-signup is enabled from the login screen; self-signup
  can never grant admin to the new account.
- A messaging bus abstraction (email via SMTP first; Slack/Telegram/Bark as later subclasses
  of the same interface), with SSL/TLS support, a connection test, and templates for
  registration, forgotten passwords, and sharing notices.
- An admin page with tabs: Users, Notifications (SMTP setup lives here).
- Upgrade the user profile (Account) page to tabs: Basic (today's page) stays the default,
  plus a new Importers tab for per-user importer setup (OAuth-based importers are explicitly
  deferred -- "cross that bridge later").
- Usernames must become unique (confirmed in planning: case-insensitively).

## Decisions already made (confirmed with the user during planning -- don't re-ask these)

1. **File isolation must be real server-side enforcement**, not a UI-level convention. A user
   must not be able to fetch another user's private blobref even by guessing/knowing it.
2. **"Local users" and "registered users" are the same account pool** (this instance's own
   users), just two different target-picker UIs. No cross-instance/federated identity needed.
3. **Usernames are unique case-insensitively.** "Alice" and "alice" cannot both exist. Display
   casing is preserved; uniqueness/lookup is on the lowercased form.
4. **Self-signup requires email verification** before the account can log in (depends on
   Phase 3's SMTP working).

## Phase 1: admin roles & user management

Status: **done**, verified end to end (curl + a real browser session) on the disposable test
host. Shipped as designed below, plus one fix discovered during verification: the "first user
is the default admin" grant originally only fired inside the "account doesn't exist yet,
create it" branch. The test host's bootstrap account predated admin roles entirely (created by
an earlier session before this feature existed), so it never passed through that branch and
came up permanently non-admin -- locked out of every `/auth/admin/*` route with no other admin
able to grant it back. Fixed in `InitHandler` by granting admin to the bootstrap account
whenever the server currently has **zero** admins, not only on fresh creation (see
`pkg/accounts/store.go`). **Lesson for later phases, especially Phase 2**: any one-time
"first run" setup logic in this codebase needs an explicit self-healing check like this one
(and like the `usernameLower` backfill below) for installs upgrading from an earlier version of
this feature set, not just fresh installs -- don't assume `InitHandler`'s "create" branch is
the only place state like this ever needs to be set.

### Data model (extends `pkg/accounts`)

- New account attribute `admin` ("1" or absent). The bootstrap account created in
  `Store.InitHandler` is always granted `admin: "1"` -- "the first user is the default admin."
- **Case-insensitive username uniqueness**: add a second attribute `usernameLower` (always
  `strings.ToLower(username)`), set alongside `username` on `CreateAccount`/`ChangeUsername`.
  All lookups (`findAccount`, the uniqueness check) query `usernameLower`; `username` stays
  purely for display. `InitHandler` needs a one-time self-healing backfill: on startup, scan
  `camliNodeType:account` permanodes missing `usernameLower` and set it from their existing
  `username` (so the already-deployed bootstrap account picks it up with no manual step).
- Admin-grant invariant, enforced in `pkg/accounts` itself (not the HTTP handler layer, so it
  can't be bypassed by some future route): **granting** admin always requires
  `target != caller` -- nobody can grant themselves admin, ever, admin or not. **Revoking**
  admin may target self or another admin, but is rejected if it would bring the server's admin
  count to zero (count admins excluding the one being revoked; reject if that count is 0).
  `DeleteUser` applies the same zero-admin check when the target being deleted is an admin.
- `Impersonate(ctx, callerUsername, targetUsername)`: admin-only; mints a session JWT for the
  target directly (no password check -- it's an explicit admin action), but the claims record
  `impersonatedBy: callerUsername` so it's never indistinguishable from a real login. `GET
  /auth/account` surfaces `impersonatedBy` when present so the UI can show a persistent
  "Viewing as X (impersonated by Y)" banner. Returning to your own account is just logging out
  and back in as yourself -- no dual-session juggling needed.

### New Go pieces

- `pkg/accounts/admin.go` (new file): `IsAdmin`, `ListUsers`, `CreateUser` (admin-only, *not*
  self-signup -- that's Phase 4, which needs email verification plumbing first), `DeleteUser`,
  `GrantAdmin`, `RevokeAdmin`, `Impersonate`, plus the `usernameLower` backfill helper called
  from `store.go`'s `InitHandler`.
- `pkg/accounts/handler.go`: new routes, each resolving the caller via the existing `withUser`
  helper and then checking `IsAdmin` (a new `withAdmin` wrapper around `withUser`):
  - `GET /auth/admin/users`
  - `POST /auth/admin/users` (create: `{username, password}`)
  - `DELETE /auth/admin/users/{username}`
  - `POST /auth/admin/users/{username}/grant-admin`
  - `POST /auth/admin/users/{username}/revoke-admin`
  - `POST /auth/admin/users/{username}/impersonate` -> returns a new session token
- `account.go`'s `AccountView` gets an `isAdmin bool` field so `GET /auth/account` tells the
  frontend whether to show the Admin menu item/route at all.

### Frontend (`server/perkeepd/ui-src/src`)

- `api/client.js`: `getUsers`, `createUser`, `deleteUser`, `grantAdmin`, `revokeAdmin`,
  `impersonate` calls against the new routes, all through the existing `apiFetch` wrapper.
- `hooks/useAuth.js`: expose `isAdmin` (from the account fetch) and an `impersonate(username)`
  helper that calls the new endpoint and swaps the stored session the same way `login()` does.
- New `pages/AdminPage.jsx` + route `/admin`, guarded like everything else via `RequireAuth`
  plus an `isAdmin` check (redirect home if not admin -- the real boundary is server-side; this
  is just UX). Built with `react-bootstrap` `Tabs`, but **only a "Users" tab is implemented
  now** (table of users with admin badges, create-user form, per-row Grant/Revoke
  Admin/Impersonate/Delete). Using `Tabs` now means Phase 3's "Notifications" tab is a one-line
  addition later, not a redesign -- but nothing is pre-built for it, since a visible stub tab
  for an unimplemented feature would be confusing.
- `components/layout/AppNavbar.jsx`: add an "Admin" menu item, shown only when
  `useAuth().isAdmin` is true, placed with Account/Logout at the bottom of the menu (matching
  the existing menu-order fix).
- Impersonation banner: a small persistent bar (e.g. in `AppLayout.jsx`, alongside the existing
  drag-overlay) shown whenever `GET /auth/account`'s `impersonatedBy` is set, with a "Log out"
  shortcut.

### Files touched

- Go: `pkg/accounts/admin.go` (new), `pkg/accounts/account.go`, `pkg/accounts/handler.go`,
  `pkg/accounts/store.go` (backfill call).
- React: `src/api/client.js`, `src/hooks/useAuth.js`, new `src/pages/AdminPage.jsx`,
  `src/components/layout/AppNavbar.jsx`, `src/components/layout/AppLayout.jsx`.
- `server/perkeepd/ui/dist/` rebuilt as usual.
- Test host: no config changes needed -- same `jwt:` auth mode already deployed.

### Verification

Build, push, remote-rebuild via the `/tmp/rebuild.sh` SSM path on the disposable test host
(`52.206.74.146:3179`, SSM profile `chaos`, instance `i-0ba87967c50d2a2ea`), then: confirm the
existing bootstrap account shows as admin; create a second user via the Admin page and log in
as them (no admin menu item); as the second user, confirm granting yourself admin is
impossible (button simply isn't there, and hitting the route directly 403s); as the bootstrap
admin, grant the second user admin, then revoke the *bootstrap* account's own admin status and
confirm it succeeds (two admins exist); attempt to revoke the second user's admin status down
to zero admins and confirm the server rejects it; impersonate the second user and confirm the
banner appears and `GET /auth/account` reflects their identity; delete a non-admin user and
confirm their login now fails.

### Post-ship additions

Three follow-ups landed after initial verification, all within this same phase (not new
phases of their own):

- **298e3b1bf -- focus-loss bug fix.** `AdminPage.jsx`'s "Users" tab was a nested function
  component (`function UsersTab() {...}` defined inside `AdminPage`'s body, rendered as
  `<UsersTab />`). Every keystroke in the create-user form re-rendered `AdminPage`, which
  created a *new* `UsersTab` function identity each time -- React saw a different component
  type and remounted the whole subtree (inputs included) on every character, dropping focus
  after one keystroke. Fixed by inlining it as a plain function called directly in JSX
  (`{renderUsersTab()}`), not a separate component. **Lesson for any future tab/section inside
  a page that holds its own form state: never define it as `function Foo() {...}` inside the
  parent's render body and render `<Foo />` -- call it as a plain function instead, or hoist it
  out of the parent entirely.**

- **b2acfbb5b -- optional password-policy + admin password reset.**
  - `pkg/accounts/account.go`: new `passwordPolicy` type (a compiled regex + a required
    plain-language description -- required because there's no way to turn an arbitrary regex
    back into English automatically), `Store.PasswordPolicy()`/`validatePassword()`,
    `ErrWeakPassword`. Checked by `ChangePassword`, `CreateUser`, and the new `ResetPassword`
    -- deliberately **not** by `CreateAccount`/the bootstrap path, so tightening the policy
    later can never fail server startup over an already-configured bootstrap password.
  - `pkg/accounts/admin.go`: new `ResetPassword(ctx, caller, target, newPassword)` --
    admin-only, no current-password check at all (the whole point: recovering a forgotten
    password right after account creation). Never allowed on your own account
    (`ErrSelfReset`): self-service `ChangePassword`'s current-password check exists
    specifically so a stolen bearer token alone can't take over an account by resetting its
    own password, and allowing self-target here would undo exactly that protection. The Admin
    page hides the "Reset password" button for your own row for the same reason.
  - New route `GET /auth/password-policy`, deliberately unauthenticated (like `/auth/login`)
    since a future self-signup page (Phase 4) will need it pre-session.
  - Frontend: `hooks/usePasswordPolicy.js` (fetches once, best-effort constructs a JS
    `RegExp` from the Go/RE2 pattern for live client-side preview -- falls back to showing
    just the description when a pattern uses an RE2-only construct JS can't parse, e.g.
    inline flags) and `components/PasswordRequirementHint.jsx`, both shared by
    `AccountPage.jsx`'s change-password form and `AdminPage.jsx`'s create-user form and new
    reset-password modal.

- **079a8a79b -- wired the policy into the high-level config.** The first pass added the
  policy to `pkg/accounts`' config object but missed that server-config.json's
  `"auth": "jwt:user:pass"` shorthand is expanded into that low-level config by
  `pkg/serverinit/genconfig.go`'s `addAccountsConfig` -- there was no way to actually set it.
  Added `PasswordPolicy *PasswordPolicy` to the high-level `pkg/types/serverconfig.Config`
  struct (`json:"passwordPolicy,omitempty"`, `{pattern, description}`), threaded through to
  the low-level `passwordPolicyPattern`/`passwordPolicyDescription` keys only when `auth`
  selects `jwt` mode. Documented in `doc/server-config.md` (also corrected that doc's stale
  claim that "additional accounts aren't supported by the UI" -- Phase 1 shipped exactly
  that). **Lesson: when pkg/accounts gains a new config knob, check whether
  `pkg/serverinit/genconfig.go`'s `addAccountsConfig` and `pkg/types/serverconfig.Config` also
  need updating -- the low-level `jsonconfig.Obj` the handler reads is not the same object
  server-config.json's simple-mode fields populate; there's a translation layer in between
  that has to know about every key, not just the handler.**
  - Verified on the test host with a temporary `"passwordPolicy": {"pattern": "^.{10,}$",
    "description": "At least 10 characters."}` added to server-config.json: policy rejected
    from `CreateUser`, `ResetPassword`, and self-service `ChangePassword` alike (all three
    surfaced the plain-language description), a compliant password succeeded through all
    three, the pre-existing bootstrap account's old password kept working unaffected, and the
    Admin page's create-user form showed the live red/green hint and disabled Create
    accordingly. Test host's config was then reverted to no policy (the shipped default)
    after verification.

## Phase 2: real per-user file isolation

Status: **done** (the originally-planned 9 steps, plus a 10th that landed while answering
closing questions before marking this phase done; see the status table at the top of this doc
for the full commit list). This was, as expected, the hardest, highest-risk phase -- it also
caught **five** real security bugs via its own live verification (not just the planned-for
checks): a forged-claim ownership bypass in the one-hop reverse lookup (step 6), a context-leak
bug where Phase 2's own filtering recursively narrowed its internal "who really owns this"
lookups (step 6), a complete owner-filtering bypass in `GetRecentPermanodes`/
`GetPermanodesWithAttr` that would have let any authenticated FUSE user list every
recently-modified permanode on the server (step 9), a one-hop `OwnerOf` gap that made any
multi-chunk file unreadable by its own non-admin owner through FUSE/`pk-get`/raw GET (step 10,
bug A), and -- the most serious of the five -- attribute-claim writes never being gated by
ownership at all, so any authenticated user could silently tamper with (not just view) any other
user's permanode just by knowing its blobref (step 10, bug B). All five are detailed in their
respective steps below -- read those before assuming any single piece of this phase is simple to
extend, since the pattern ("this new query/describe/write path doesn't go through the
already-fixed choke point") recurred more than once, on both the read side and the write side.
One more gap was found and deliberately **not** fixed here -- share-claim creation was never
ownership-gated either, and still isn't; see the note on native sharing below, flagged for Phase
5.

**TL;DR / core deliverable** (kept for historical context -- this framing drove the whole
phase): every new permanode gets a server-stamped owner attribution at upload time (who
uploaded it, written synchronously by the server itself from the request's identity, not a
client-settable claim -- see "The foundational problem" below for why), plus a blobref-level
reverse lookup/cache so raw blob storage (gap #5) can be owner-checked without a full per-call
Describe. This is what makes every other fix in this phase (search filtering, thumbnail/download
auth, FUSE, raw blob storage) actually enforceable -- without it there's no reliable "who owns
this" to check against in the first place.

### Why this is hard (research findings, preserved in full -- do not re-derive these)

Two research passes (October 2026, this planning round) confirmed real isolation requires
changes at **five independent layers**, plus one foundational mechanism that doesn't exist yet
at all:

**1. `pkg/search` `Query` -- the easy, low-risk one.** In `pkg/search/query.go:696`
`Handler.Query`, both a raw `Constraint` and a parsed `Expression` string converge at
`query.go:715` (`q := searchQueryPlannedQuery(rawq, exprResult)`), and the only place a
constraint becomes an actual predicate is `query.go:742`
(`blobMatches := constraintMatcher(q.Constraint)`). Inserting
`q.Constraint = &Constraint{Logical: &LogicalConstraint{Op:"and", A: q.Constraint, B:
ownerConstraint}}` right after line 715 (before `optimizePlan`, which runs inside
`searchQueryPlannedQuery`) is the single clean AND-point regardless of input shape. If
`ownerConstraint` is `&PermanodeConstraint{Attr:"owner", Value: accountRef}`,
`constraintBlobCandidates` -> `permanodeConstraintPermanodeCandidates` (query.go:298-327)
resolves it via `corpus.ForeachClaimBack`, an **indexed** reverse-claim lookup -- efficient,
not a full scan. `searchQueryPickCandidateSource` (query.go:1131, "and" branch at
query.go:254-289) automatically picks the smaller side of the AND, so this doesn't become the
bottleneck.

*Naming warning*: `pkg/server/ui.go`'s `discovery()` method calls `ui.search.Owner()`
(`pkg/search/handler.go:195`, returning `h.owner.BlobRef()`) -- but that `Owner()` means "the
single GPG signing identity for this whole installation" (`index.Owner`,
`pkg/index/index.go:144-197`, a process-wide singleton built once at startup from the
server's one GPG key, `pkg/search/handler.go:179` `newOwner`). It has nothing to do with
per-user ownership and predates any multi-user concept. Use a different attribute name for the
new per-permanode concept (the existing shipped code already uses `owner` loosely in planning
prose -- rename to something unambiguous, e.g. `camliAccountRef` or `perkeepOwner`, before
writing any code, to avoid every future grep for "owner" hitting the unrelated
single-tenant-identity concept).

**2. `Describe`'s rule-expansion -- a separate, currently-unprotected path.** `Handler.Query`
only runs `DescribeLocked` on its *own* matched blobs (query.go:900-920) -- which *would* be
protected by fix #1. But `searchtypes.Describe` -> `expandRules`
(`internal/searchtypes/describe.go:695-722`) follows `DescribeRule`s (e.g. a permanode's
`camliContent` reference) one hop further via `dr.StartDescribe` -> `doDescribe`
(describe.go:735), which calls `dr.sh.index.GetBlobMeta`/`GetFileInfo`
**directly against the index, with no constraint evaluation of any kind**. This means: if a
user can get *any* permanode of theirs described, and a rule expands into a referenced blob
that happens to not be theirs, it's described and returned anyway. This is a second,
independent fix, not covered by #1 -- likely a check inside `doDescribe` or `newMatches`
(describe.go:637) that only expands into/returns blobs owned by (or shared with) the caller.

**3. `pkg/server/ui.go`'s `serveThumbnail`/`serveDownload`/`serveFileTree` -- zero
authorization today, by design.** All three (ui.go:421, 445, 486) `blob.Parse` a blobref
straight from the URL path (ui.go:461, ui.go:499) and hand it to
`ImageHandler`/`DownloadHandler`/`FileTreeHandler` with `Fetcher: ui.root.Storage` -- raw blob
storage, no describe-based gate at all. `Search` is passed into `ImageHandler`/`DownloadHandler`
(image.go:64, download.go:66) but used only for pack-optimization lookups
(`fileInfoPacked`, image.go:238 / download.go:166) and thumbnail-metadata caching, **never**
for an authorization decision. Fixing `Query`/`Describe` does **not** protect these three
routes -- anyone who knows or guesses a blobref still gets its thumbnail/file/tree
unconditionally. Minimal fix per site: resolve the blob's owning permanode and `Describe` it,
check the owner attribute, 403 otherwise -- one extra `Describe(ctx, &DescribeRequest{BlobRef:
file, Depth: 1})` call (the pattern already exists for pack-optimization at image.go:364).
Cost: with the corpus in memory (the common case), a depth-1 describe is an in-memory
map/RLock lookup, sub-millisecond -- cheap versus actual image decode/resize, but still a new
`h.index.RLock()` per call, so batch/cache the check (e.g. alongside the UI's existing
grid-listing describe batch) rather than re-describing per individual thumbnail request under
load.

**4. FUSE (`pkg/fs`) -- directory traversal is covered by fix #1; raw file reads are not.**
`pkg/fs/roots.go:139,227,257` call `n.fs.client.Describe(...)`/`GetPermanodesWithAttr(...)` via
`fs.client`, an `*client.Client` hitting the server's `/my-search/` HTTP endpoints -- i.e. the
exact same `Handler.Query`/`Describe` fixed in #1/#2. So directory/root listing *is* covered
once those land. But actual file *content* reads go through `n.fs.fetcher`
(`pkg/fs/fs.go:50,349`, `ro.go:345`, `mut.go:670`) -- a `blob.Fetcher` hitting raw blob storage
directly, the same gap as #3.

**5. Raw blob storage (`enumerate-blobs`/`get`/`stat`) -- no ownership concept, no existing
mechanism to build one on, and the most dangerous gap if left unfixed.**
`pkg/serverinit/serverinit.go:138-178` (`camliHandlerUsingStorage`) maps
`enumerate-blobs`/`get`/`stat`/`upload` to `auth.Op{Get,Stat,Upload,All}`, wrapped at
`serverinit.go:245` by `auth.RequireAuth(handler, op)` -- "authorized" here only means "valid
credentials for *some* account," nothing permanode-aware. **`enumerate-blobs` in particular
would let any authenticated user list every digest on the server**, then fetch any of them
directly via `get` -- a complete bypass of fixes #1-#4, since digests are content hashes
(unguessable) but *enumerable* once you can list them all. The existing precedent for
blob-level access without normal per-account auth is `pkg/server/share.go`'s unauthenticated
share handler (see Phase 5's section for its full mechanism) -- it validates a cryptographic
capability chain (signed, non-expired, non-deleted share claim) instead of per-account
identity. The analogous design for per-owner blob access would be a new check wrapping
`CreateGetHandler`/`CreateStatHandler`/`CreateEnumerateHandler`, asking "does a permanode owned
by this account claim this blobref (directly or via camliContent/member)?" -- but this needs
either an index-level reverse lookup from blobref -> owning-permanode (not something
`index.Interface` exposes today beyond `ForeachClaimBack`, which goes the other direction), or
a blobref -> owner cache maintained at write time. A full per-call Describe-equivalent (as in
fix #3) would be far too expensive for `enumerate-blobs`, which can return hundreds of digests
in one call.

**The foundational problem underlying all five**: ownership can't be a normal client-settable
attribute. Claims are just signed JSON blobs that any authenticated caller can upload via
`camli/upload` -- there is no server-side claim-validation layer today, and no per-user
cryptographic signing identity (every claim is signed by the *server's own single* GPG
identity regardless of which logged-in user issued it, so a claim's signature can't prove
*which user* issued it). This means an "owner" attribute set via the normal
`setAttribute`/upload pipeline could be forged by anyone -- a malicious or buggy client could
claim someone else's permanode as their own, or strip ownership entirely. Ownership must
instead be **stamped server-side, synchronously, at the moment a new permanode is first
uploaded**, using the uploader's identity from that same HTTP request -- and the generic
upload handler must **reject** any client-submitted claim whose attribute is the reserved
ownership name, full stop, no exceptions via HTTP.

**Open question, resolved (October 2026, this planning round)**: there are actually **three**
upload paths needing the hook, not one -- `handleMultiPartUpload`, `vivify()`, and
`CreatePutUploadHandler`, all in `pkg/blobserver/handlers/upload.go`. None of them currently
have the caller's verified identity available (`pkg/auth/jwtauth.go`'s `jwtAuth.AllowedAccess`
verifies the bearer token but discards the username) -- new plumbing is needed, but it's small:
re-verify the bearer token a second time at the hook point via the now-added
`accounts.Store.ResolveRequest`. Permanode detection is cheap and in-memory
(`schema.BlobFromReader(ref, r).Type() == schema.TypePermanode`, no extra I/O, using bytes
already read into the handler). The write path already exists
(`pkg/accounts/permanode.go`'s `upload`/`setAttr`). See "Implementation plan" below for the
full resolved, ordered, file-level plan -- this is no longer open.

## Implementation plan (resolved, step-by-step)

**Decisions**: ownership attribute is `camliAccountRef` (avoids the `Owner()` naming collision
above; value is the owning account's permanode ref, not username, since usernames can be
renamed). One shared `pkg/accounts.Store.ResolveRequest(req) (Caller, bool)` primitive (added
step 1) is what every enforcement layer calls to resolve identity + admin status identically --
the five layers stay independently enforced, only the identity *decision* is centralized.
Admins keep "see everything" at every layer (`if caller.IsAdmin { allow } else { check
ownership } `). No new server-config.json knob -- enforcement is unconditional whenever an
`"accounts"` handler exists, a complete no-op (nil closures) when it doesn't. Fail closed, not
open, on ambiguity (unresolvable ownership = not yours); 404 everywhere on denial, never 403
(don't distinguish "exists but isn't yours" from "doesn't exist").

Ships as 9 independently-committable, independently-verifiable steps (not one giant change, per
this phase's own risk level):

1. **Shared caller-resolution primitive** (`pkg/accounts`). `Caller{Username, AccountRef,
   IsAdmin}` + `Store.ResolveRequest(req)`, built from already-exported `Identify`/
   `findAccount`/`IsAdmin`. Also de-duplicated bearer-token extraction
   (`accounts.BearerFromRequest`, now shared with `pkg/auth/jwtauth.go`). Pure infrastructure,
   zero behavior change. **Done** -- `cc8d0709e`.
2. **Ownership stamping + reserved-attribute guard, all three upload paths.** New
   `Store.StampOwnership(ctx, pn, username)` and `AccountRefAttr` constant
   (`"camliAccountRef"`, exported from `pkg/accounts`); `upload.go`'s three entry points
   (`handleMultiPartUpload`, `vivify`, `CreatePutUploadHandler`) take nil-able
   identify/stamp/`isReservedAttr` closures, supplied by `pkg/serverinit`'s new `ownershipHooks()`
   from `accounts.Default()`. Classify via `schema.BlobFromReader(...).Type()` +
   `Claim.AttributeClaims()` (covers multi-claims too) *before* a blob is ever added to a group
   or passed to `blobserver.Receive` -- a forged claim on the reserved attribute is rejected
   outright, never stored at all, not just rejected after the fact. New permanodes are stamped
   right after they're durably received; a stamp failure removes the blob from that response's
   `received`/`accepted` list and logs loudly, rather than returning success for a silently-
   unowned permanode. Accepted risk (documented in code): session-based uploads stamp right
   after `session.Add` returns, before the session's own async commit resolves; a failed late
   commit leaves a harmless orphan claim, since the permanode it names never lands in the
   corpus. **Done** -- `a341f9e93`. Verified live on the test host: multipart batch path and PUT
   path both confirmed (new permanode gets `camliAccountRef` pointing at the uploader's own
   account; a forged claim setting it directly is rejected and never stored, confirmed via a
   follow-up GET 404). `vivify()` (the pk-put fast-path/CLI vivify route) got the same code
   change and was code-reviewed but **not independently live-tested** -- it shares the exact
   same `stamp(ctx, permanodeRef, username)` call pattern as the other two, just triggered
   differently (`X-Camlistore-Vivify: 1`), so risk is low, but flag this gap if anything looks
   off with CLI-vivified uploads later. Also not independently verified: a legacy
   no-`"accounts"`-handler config seeing zero behavior change (no second test host spun up for
   this; guaranteed by code review of the nil-closure path, not live-tested).
3. **Pre-existing-data backfill.** `InitHandler`, modeled on the existing
   `backfillUsernameLower`: assign permanodes lacking `camliAccountRef` to the
   bootstrap/first-admin account. Mechanical; the human call is confirming *which* account is
   right for the test host's actual existing data before running it. **Done** -- `b78b71a92`.
   Queries the index for permanodes with zero values for the attribute (cheap after the first
   run) rather than describing every permanode; account/apitoken permanodes are explicitly
   skipped. Verified live: enumerated the test host's pre-existing data first (13 non-account/
   apitoken permanodes -- 1 collection + 12 file permanodes, all from Phase 1's own manual
   testing), confirmed the backfill log line reported exactly 13, confirmed one representative
   permanode's `camliAccountRef` now points at the `chaos` bootstrap account's own permanode,
   and confirmed re-querying for zero-value permanodes afterward returns exactly the 6
   account/apitoken permanodes that are supposed to stay unstamped (2 accounts + 4 apitokens),
   nothing else. **Flagged, not resolved**: some of that pre-existing data may have actually
   been uploaded by the "second" test user rather than "chaos" during Phase 1's own manual
   testing (the user's own account-creation/upload testing happened before ownership stamping
   existed, so there's no way to recover true per-file attribution) -- this backfill
   mechanically assigns all of it to the bootstrap account, which may misattribute some of it.
   Low-stakes on a disposable test host; would need the operator's own judgment call on a real
   install with real pre-existing data.
4. **Blobref → owner cache** (`pkg/accounts.OwnerOf`). In-memory cache, populated
   opportunistically at stamp time; on miss, checks the ref as a permanode directly, then
   one-hop via `camliContent`/`camliMember`. Documented limitation: doesn't walk into a large
   file's `bytesRef` chunk list -- fails closed (not-found) for those until/unless testing shows
   it's actually hit. **Done** -- `429a24861`. Pure infrastructure so far: nothing calls
   `OwnerOf` yet (no standalone test written either -- its first real exercise is steps 7/8's
   live HTTP tests, consistent with how every other step here is verified).
5. **Layer #1 -- `Query` filtering.** AND in a `camliAccountRef` constraint right before
   `optimizePlan` runs, only when a non-admin `Caller` is present in request context (set by a
   new `pkg/search` caller-resolution hook mirroring `pkg/accounts`' own `FindHandlerByType`
   pattern in the opposite direction). **Done** -- `442b45f0a`. New `pkg/search/caller.go`
   defines `Caller`/`callerResolver` locally (can't import `pkg/accounts` -- cycle) and the
   `"camliAccountRef"` literal is duplicated there too, cross-referenced to
   `accounts.AccountRefAttr` as the source of truth. Verified live: two non-admin test users
   each created a permanode and searched for both by a shared title substring -- each saw only
   their own, admin saw both. `pkg/accounts`' own internal lookups (login, admin user list)
   confirmed unaffected, since they run with `context.Background()` (no caller in context -->
   unfiltered, by design).
6. **Layer #2 -- `Describe`'s rule-expansion leak.** Separate unprotected path
   (`expandRules`/`doDescribe` follows references like `camliContent` one hop further with no
   constraint check) -- fixed in `DescribeLocked`, the one choke point every describe path
   funnels through, by filtering the result's `Meta` map post-hoc for non-admin callers. **Done**
   -- `47efa17c9`, plus two follow-up fixes (`b82f97200`, `8d6bc5a9b`) for bugs this step's own
   verification caught live.

   **Widened beyond the original research**: `serveDescribe` was passing `context.TODO()` to
   `Describe`, silently discarding the `Caller` `ServeHTTP` had just stashed in context -- fixed
   to use `req.Context()`, or none of this would've worked for the HTTP describe endpoint at
   all. `serveClaims`/`serveEdgesTo` (both actually called by `BlobAspect.jsx`, confirmed via
   grep) build their own internal `context.TODO()` too and so never see this filtering either --
   added a `callerOwns` check at the HTTP layer for both, before calling through.
   `getRecent`/`getPermanodesWithAttr`/`signerAttrValue`/`signerPaths` have the identical gap but
   aren't called from any current UI component -- **flagged, not fixed**; revisit if a future UI
   feature starts calling them.

   **Two real bugs this step's verification caught, both fixed**: (1) a forged-claim test
   against `serveEdgesTo` initially passed with 200 (should've been denied), because the
   one-hop `camliContent`/`camliMember` reverse lookup (`pkg/accounts.OwnerOf` and
   `pkg/search`'s local `resolveBlobOwner`) picked the wrong claimant under exactly the attack
   it exists to resist -- `OwnerOf` reused `findPermanodeByAttr`'s `Sort: CreatedDesc`, so a
   *newer forged* claim won over the real original one; `resolveBlobOwner` took whichever claim
   `ForeachClaimBack`'s explicitly-undefined iteration order yielded first. Fixed by always
   preferring the earliest claim by date in both (new `Store.earliestPermanodeByAttr`, `Sort:
   CreatedAsc`; an explicit `cl.Date.Before` comparison in `resolveBlobOwner`). (2) That alone
   wasn't sufficient: `pkg/accounts`'s internal `s.search.Query`/`Describe` calls were passing
   through whatever `ctx` their caller handed them, and when `OwnerOf` is reached via
   `pkg/search`'s own HTTP-layer checks (`callerOwns`, via `req.Context()`), that context
   already carries the asking caller's identity -- step 5's own filtering then silently
   re-applied itself to this *internal* "who actually owns this" lookup, narrowing it to only
   the asker's own permanodes. Exactly backwards for ground-truth lookups. Fixed with a new
   `unfilteredCtx` helper dropping to `context.Background()` before every one of
   `pkg/accounts`'s own search calls.

   **New principle for steps 7/8 and beyond**: any `pkg/accounts` method resolving ground truth
   (who owns X, is Y an admin) must never trust an inherited context for its own internal
   search/describe calls -- Phase 2's own context-based filtering can silently and recursively
   narrow that lookup to whatever the original caller is allowed to see, self-defeating for an
   authorization check.

   Verified live (after both fixes): crafted a permanode for user A whose `camliContent` points
   at user B's actual uploaded file; describing A's permanode no longer surfaces B's file in
   `meta`; admin bypass still works; A can't directly describe B's file as a root either;
   `serveClaims` denies A access to B's permanode's claims (404) while returning A's own fine;
   `serveEdgesTo` denies A access to edges into B's file (404, after the fix -- was incorrectly
   200 before it). Re-ran step 5's isolation test afterward, no regression.
7. **Layer #3 -- `pkg/server/ui.go` thumbnail/download/filetree.** Zero authorization today.
   Shared `authorizeBlob` helper using step 4's `OwnerOf`; 404 on denial. **Done** --
   `563072e84`. New nil-able `AuthorizeBlob func(r, ref) bool` field (not a constructor
   parameter, unlike step 2's upload-handler changes -- nil-safe and additive, so other
   construction sites, `pkg/server/share.go`'s intentionally-unauthenticated share handler,
   `app/publisher`, `app/scanningcabinet`, `pkg/server/immich`, don't need touching) on
   `DownloadHandler`, `ImageHandler`, `FileTreeHandler`, checked before anything is
   fetched/resized/read. Also caught and fixed `serveDownload`'s multi-file "download selected
   as zip" POST path (confirmed live-UI-reachable via `SelectionActions.jsx`'s
   `openDownloadForm`) -- checked on the top-level requested refs.

   Verified live against real pre-existing content owned by `chaos`: owner downloads/thumbnails
   (a real image, confirmed 200 with actual image data, not just "didn't 404") successfully;
   non-owner denied all of download, thumbnail, filetree, and zip-download (404 each); owner's
   zip-download of the same ref still succeeds (200).
8. **Layer #5 -- raw blob storage** (`enumerate-blobs`/`get`/`stat`). No ownership concept at
   all today; `enumerate-blobs` would otherwise bypass every other fix. New nil-able
   `ownerCheck` parameter on `CreateStatHandler`/`CreateEnumerateHandler`; GET gated inline in
   `serverinit.go` since the blobref is already the route's `action` string there. **Done** --
   `efdeab040`. `enumerate-blobs` keeps its pagination cursor/count advancing over the full
   underlying set regardless of visibility (only the emitted JSON entry is skipped for denied
   blobs), or a caller who can see only some of the server's blobs would never page past a run
   of denied ones. `CreateGetHandler` itself (a different package, `gethandler`, used nowhere
   else with a per-request authorization concept) got no signature change -- gated inline in
   `serverinit.go`'s GET-default case instead, swapping in `http.NotFoundHandler()` when denied.
   All three wired from one new `rawBlobOwnerCheck()` closure built from `accounts.Default()` +
   steps 1/4's `ResolveRequest`/`OwnerOf`.

   Verified live (this is the layer the roadmap flagged as most dangerous if left unfixed): a
   non-admin user uploaded a raw content blob directly; the uploader could GET/stat/enumerate
   it; a second non-admin user with no relation to it was denied on all three (GET 404, stat
   returns it absent, enumerate-blobs omits it entirely from a full listing); admin bypassed all
   three successfully.
9. **Layer #4 -- FUSE.** Planned as pure verification, no new server code expected -- turned out
   to need two real fixes. **Done** -- `5bd328fe4`, `a8ff849f6`.

   **Infrastructure note**: live `pk-mount` testing needed a throwaway EC2 instance (FUSE
   requires `/dev/fuse` + `fusermount3`, not available in the main test host's unprivileged
   container) -- spun up, used, and fully torn down this session (instance, its own isolated
   security group, test users/tokens all deleted; nothing persists). If a fresh session needs to
   re-verify FUSE, repeat that setup rather than assuming infrastructure is still there.

   **Fix 1, unrelated to Phase 2 directly but blocking all FUSE/CLI-tool testing**:
   `jwtAuth.AddAuthHeader` (`pkg/auth/jwtauth.go`) was a no-op despite its own comment claiming
   "curl/scripts attach their own per-user API token" -- no code path actually attached one for
   a `pkg/client`-based tool (`pk-mount`, `pk-put`). Fixed: `newJWTAuth` now captures its config-
   string argument; `AddAuthHeader` sends it as a bearer token when set
   (`CAMLI_AUTH=jwt:<api-token>`). This was necessary just to get any CLI/FUSE client working
   against this fork's jwt-mode server at all -- worth knowing if Phase 4 or any future CLI work
   assumed this already worked.

   **Fix 2, a real Phase 2 gap this session's own research had wrongly ruled out**: the first
   live `pk-mount` test (a non-admin user with zero content) showed every other user's files
   under `recent/` -- not a caching artifact (confirmed via a fresh mountpoint and process
   check). Root cause: `GetRecentPermanodes` and `GetPermanodesWithAttr`
   (`pkg/search/handler.go`) build their own describe pipeline
   (`NewDescribeRequest`/`StartDescribe`/`DescribeRequestMetaMap`) instead of going through
   `Describe`/`DescribeLocked`, so step 6's `filterDescribeForCaller` never ran against them --
   and the recent-permanode listing itself was also entirely unfiltered. Step 6's own note that
   these "aren't called from any current UI component" was checked only against the React UI's
   `client.js`; `pkg/fs/recent.go`'s "recent" root (FUSE's default top-level listing) calls
   `GetRecentPermanodes` directly, and `pkg/fs/roots.go`'s `camliRoot`/`camliImportRoot` lookups
   call `GetPermanodesWithAttr`. **Any authenticated FUSE user could list every recently-modified
   permanode on the server** until this was fixed -- re-audited pkg/fs's complete list of search-
   API calls afterward (`Describe`, `GetClaims`, `GetPermanodesWithAttr`, `GetRecentPermanodes`,
   `UploadAndSignBlob`, `UploadNewPermanode`) to confirm nothing else was missed;
   `signerAttrValue`/`signerPaths`/`edgesto` (edgesto already fixed in step 6 anyway) confirmed
   genuinely unused by FUSE or any CLI tool.

   **Verified live end-to-end after both fixes**: non-admin FUSE user's `recent/` → empty (was
   showing all 12 of `chaos`'s real files before the fix); admin/owner's `recent/` → all 12 files
   with correct names/sizes; a direct blobref-resolver path (`sha224-xxxx.../`) to one of
   `chaos`'s real files → denied for the non-owner (`No such file or directory`, i.e. a 404 from
   step 8's already-verified GET route, surfaced correctly through FUSE); the owner reading that
   same file through the mount → correct byte count and valid JPEG content. Confirms both
   directory listing (now, correctly, via the fixed describe pipeline) and raw content reads (via
   step 8's GET route) are protected through FUSE, not just through direct HTTP. The one-hop
   `OwnerOf` limitation (documented in step 4) wasn't specifically exercised with a real
   multi-chunk file in this pass -- flag for a closer look if a large file misbehaves in FUSE
   later.

10. **Two more real bugs, found answering closing questions before marking Phase 2 done** --
    neither caught by step 9's own live FUSE verification, for two different reasons. **Done**
    -- `ec7287936`, `d5bc49efd`.

    **Bug A: the one-hop `OwnerOf` limitation step 4/9 flagged as "not specifically exercised"
    actually bites, hard.** `OwnerOf`'s reverse lookup resolves a permanode's directly-referenced
    content (`camliContent`/`camliMember`, one hop) but a file's actual byte-bearing chunks sit a
    *second* hop out: permanode -[camliContent]-> file-schema blob -[parts]-> chunk blob. Live
    repro (`verify-chunked-file-authz.mjs`, kept in scratch): a non-admin owner uploads a file
    schema with two raw chunks, then GETs one chunk directly -- 404, even for the legitimate
    owner. Step 9's FUSE test never caught this because it ran as the **admin** account (`chaos`),
    which bypasses `rawBlobOwnerCheck` entirely before `OwnerOf` is ever consulted -- the test's
    "owner reads succeed" result was actually exercising the admin-bypass path, not ownership
    resolution. Any file split into multiple blobs (anything over schema's 1MB `maxBlobSize` --
    i.e. almost any real photo/video) would have been **unreadable by its own non-admin owner**
    through any raw-blob-backed client: `pk-mount`, `pk-get`, any `pkg/client` tool. The UI's own
    download/thumbnail/filetree routes (step 7) were never affected -- they authorize once
    against the top-level requested ref, then read bytes through a direct storage-level
    `blob.Fetcher`, never re-entering per-chunk raw-GET enforcement.

    Fix (`pkg/accounts/ownercache.go`): when `OwnerOf` resolves a "file" or "bytes" schema
    blob's owner via the one-hop reverse lookup, it now also fetches and parses that blob's own
    `parts` list and pre-populates the cache for every chunk it reaches -- recursing into nested
    `bytesRef` indirection (real files on the test host showed up to 2 levels of this). Costs one
    extra blob fetch/parse per file per process lifetime (only on first resolution, never per
    chunk), timed to land before the chunk requests that inevitably follow it in practice (every
    real reader -- `schema.FileReader` -- fetches the file schema blob before any of its parts).

    Verified live: re-ran the repro after the fix -- owner's GET of the same chunk now 200s; all
    6 of the session's existing regression scripts still pass with no change in behavior
    (resolution via the cache is transparent to every other check).

    **Bug B: attribute-claim writes were never gated by ownership at all -- only the one
    reserved attribute was.** Step 2's upload-time guard (`classifyUpload`) only ever checked
    whether a claim tried to set `camliAccountRef` directly. Every *other* attribute --
    `title`, `camliContent`, `camliMember`, tags, anything -- was still open to any authenticated
    user, on any permanode, regardless of who owns it. Live repro
    (`verify-claim-write-gap.mjs`): non-admin, non-owner user B submits a `set-attribute` claim
    changing non-owner user A's permanode's `title` -- accepted (200), and A's own `Describe`
    confirmed the title really did change. B couldn't *see* A's permanode (`Describe` correctly
    returned nothing for B, per step 6) but could still **silently tamper with it** just by
    knowing its blobref. This was a pure write-side hole: every read-side layer built earlier in
    Phase 2 (search, describe, UI routes, raw blob storage) was never going to catch it, because
    none of them sit on the claim-upload path.

    Fix: new `ClaimTargetFunc` (`pkg/blobserver/handlers/upload.go`), checked in
    `classifyUpload` for every attribute claim found (in addition to, not instead of, the
    existing reserved-attribute check) -- true when the target permanode doesn't exist yet
    (being created in this same upload, alongside its own initial claims -- the normal create
    flow, which must keep working), the caller owns it, or the caller is admin; false otherwise,
    including when the permanode exists but isn't owned by anyone (accounts infrastructure --
    account/apitoken permanodes, deliberately never stamped -- or legacy content that predates
    `backfillOwnership`). Needed a new `accounts.Store.PermanodeOwnership`
    (`pkg/accounts/ownercache.go`) that, unlike `OwnerOf`'s single `found` bool, distinguishes
    "doesn't exist yet" from "exists but unowned" -- the first must fail open (allow) for the
    normal create flow to keep working, the second must fail closed (deny) for everyone but
    admin. `ownerOfPermanode` now just wraps it. Wired into both `CreateBatchUploadHandler` and
    `CreatePutUploadHandler` via a new `mayClaim` closure in `serverinit.go`'s `ownershipHooks`;
    nil (complete no-op) when no `"accounts"` handler is configured.

    Verified live: re-ran the repro after the fix -- B's claim on A's permanode now rejected
    (not accepted, title unchanged); confirmed the normal "add this permanode to my own
    collection" flow (a `camliMember` claim on a permanode the caller legitimately owns) still
    works (`verify-camlimember-own-set.mjs`); all 6 existing regression scripts still pass.

    **Accepted, documented limitation** (same risk class as step 2's existing accepted
    session-upload race): the claim-target check resolves via `Describe`, which depends on
    indexing having caught up. In the brief window between a brand-new permanode becoming
    durable and the index reflecting it, `PermanodeOwnership` reports "doesn't exist yet" and the
    check fails open rather than closed for *any* claim targeting it, not just the owner's own.
    Exploiting this needs both server-side race timing and already knowing a specific,
    unguessable blobref within that window -- not fixed in this phase.

    **What this means for "is Phase 2 actually done now"**: read-side isolation (who can see
    what) was solid after step 9. Write-side isolation (who can mutate what) had a real,
    unscoped hole until this step. Both are now covered. No other write path was found to have
    the same gap -- `vivify()` always creates its own new permanode (never targets an existing
    one), and share-link creation/consumption (`pkg/server/share.go`) is a deliberately separate,
    caller-agnostic mechanism that was never gated by ownership in the first place and isn't
    affected by (or a substitute for) any of this -- see the note on sharing below.

Full file-level detail (exact function signatures, line citations, verification commands per
step) is in the planning session's plan file, not duplicated here -- if that's been lost to a
new session, re-derive step 2 onward from the decisions above plus a fresh read of
`pkg/blobserver/handlers/upload.go`, `pkg/search/query.go`, `pkg/search/describe.go`,
`pkg/server/ui.go`, and `pkg/blobserver/handlers/{stat,enumerate}.go` -- the decisions section
above should make that re-derivation fast, not from-scratch.

### Native sharing (`pkg/server/share.go`) is untouched by Phase 2, by design

Perkeep's existing public-share-link mechanism (a signed "share" claim targeting a blobref,
consumed via an unguessable URL with no auth at all) predates Phase 2 and was deliberately left
alone: `shareHandler` fetches directly from its own `blob.Fetcher` (raw storage), never through
`camliHandlerUsingStorage`'s GET route, `accounts.Default()`, or any caller-identity concept --
possession of the link plus a valid signed claim *is* the authorization, by design, for exactly
the "anyone with this link" use case sharing is for. None of Phase 2's three caller categories
(admin / owner / non-owner) are even meaningful to an unauthenticated share-link visitor.

Creating a share claim, however, goes through the normal claim-upload path -- and before step
10's Bug-B fix, nothing stopped a non-admin, non-owner user from creating a *valid* share claim
targeting a permanode they don't own, since a share claim isn't an attribute claim on a
permanode (it has no `permaNode`/`attribute` fields `classifyUpload` was checking) and so was
never touched by Bug A or B's fix either. **This is a real, separate gap, not yet fixed**: right
now, any authenticated user who learns another user's permanode blobref can create a working
public share link for it, completely bypassing every isolation layer built in this phase.
Mitigated in practice only by blobrefs being unguessable content hashes (not a real isolation
guarantee) -- flag this explicitly for Phase 5 ("Share with Others"), which should either
require the claim's target to resolve to the caller's own account (mirroring step 10's `mayClaim`
check, extended to cover `AsShare()` targets too) or treat deliberate, authorized sharing as its
own first-class mechanism distinct from this accidental gap.

## Phase 3: messaging bus + SMTP + admin Notifications tab

Status: not started. Not yet researched in detail (no blocking unknowns surfaced during Phase
1/2 planning, but the exact Go package layout hasn't been scoped). Needed before Phase 4
(self-signup verification emails) can work.

- An interface, e.g. `type Sender interface { Send(ctx context.Context, msg Message) error }`
  in a new `pkg/messaging` package, with `Message` holding recipient/subject/body/template-ish
  fields generically enough that email, Slack, Telegram, Bark can all implement `Sender` later
  without changing the interface. Only an SMTP `Sender` ships now.
- SMTP config: host/port, username/password, SSL vs TLS vs none, stored... where? Given
  Phase 1's precedent (durable, non-index state goes in local files, e.g. the JWT secret;
  index-backed state goes in permanodes for reindex survival), SMTP settings are server
  *configuration*, not user data -- probably belongs in server-config.json (a new top-level key)
  or a small local file next to the JWT secret, not a permanode. Decide this explicitly in that
  phase's own plan.
- A test-send method (admin page button: "send a test email to <address>").
- Templates: registration (new self-signup verification link), forgotten-password (reset
  link), sharing notices (Phase 5's external-share emails) -- likely Go `html/template` or
  `text/template` files, with a small admin UI to view/edit them later if needed (not specified
  by the user beyond "basic templates needed").
- Admin page gets a "Notifications" tab (Phase 1 already structures `AdminPage.jsx` with
  `react-bootstrap` `Tabs` for exactly this reason).

## Phase 4: self-signup + email verification + forgot-password

Status: not started. Depends on Phase 3.

- Gated on a server mode ("Registered Users" mode, per the user's original request) --
  probably a new server-config.json flag or a value on the `jwt:` auth string, decided in that
  phase's own plan.
- Self-signup page, linked from `/login`, enabled only in that mode.
- New account starts unverified; `pkg/accounts` needs a `verified bool`-equivalent attribute
  and a verification-token mechanism (likely reusing the hand-rolled JWT signing from the
  account/API-token work, with its own `kind`, e.g. `"verify-email"`).
- Self-signup can never set `admin` on the new account (Phase 1's `GrantAdmin` already
  enforces `target != caller` for all grants, including by the newly-created account itself,
  as long as self-signup's account-creation path doesn't call something that bypasses that
  rule -- confirm it goes through the same `CreateUser`/admin-invariant logic, not a separate
  unguarded path).
- Forgot-password: a reset-token email (via Phase 3's SMTP), same token-kind pattern as email
  verification.

## Phase 5: Share with Others (local/registered/external)

Status: not started. Mostly a UI build -- backend plumbing already exists. Research findings
(October 2026, this planning round), preserved in full:

**1. Share claim schema already supports expiration.** `pkg/schema/schema.go:814` defines
`ShareClaim ClaimType = "share"`, built by `NewShareRef(authType string, transitive bool)`
(schema.go:880-886). The claim struct (schema.go:284-295) has `Search`, `Target`,
`Transitive`, `AuthType`, and **`Expires types.Time3339`** (schema.go:295, "or zero for no
expiration"). `(*Builder).SetShareExpiration(t time.Time)` (`pkg/schema/blob.go:378-388`)
sets/clears it; `Share.IsExpired()` (blob.go:294-297) checks
`!t.IsZero() && clockNow().After(t)`. **A share is not valid forever by default once an
expiration is set** -- the full lifecycle already exists; only the UI/client never exercises
it yet.

**2. Only `authType:"haveref"` (secret-URL) exists today** -- no password-protected auth type.
`pkg/client/client.go:470-472` errors `"unknown share authType"` for anything else;
`AsShare()` (blob.go:132-144) hard-requires `AuthType == ShareHaveRef`
(`pkg/schema/schema.go:926-930`); `doc/schema/share.md:10-12` confirms "Currently only haveref
is supported." This matches "external users" (plain secret link) directly.

**3. Server-side entitlement walk**: `pkg/server/share.go`, handler type `"share"`
(registered `share.go:120-122`; config keys `shareHandler`/`shareHandlerPath`,
`doc/server-config.md:77-82`; exposed to clients as `discovery.ShareRoot`). The actual check,
`handleGetViaSharing` (share.go:166-278): builds a `fetchChain` from `via=` params plus the
target blobref; for the first blob (the share claim itself) checks
`h.idx.IsDeleted(br)` (share.go:203-210 -- this is how **revocation** works, see #4), parses it
as a `Share` via `AsShare()` (share.go:219-226), rejects if `share.IsExpired()`
(share.go:227-229 -- expiration enforcement, already live), validates
`fetchChain[1] == share.Target()` (share.go:230-234), tracks `isTransitive` and rejects deeper
hops if not transitive (share.go:236-238). Further hops are validated at the **blob level** by
`bytesHaveSchemaLink` (share.go:317-351, walking file `BytesPart`s / directory `Entries` /
`static-set` `Members`) -- a manual Merkle-DAG walk, not an index query. This handler is
**unauthenticated by design** and confirmed *not* wrapped by `auth.Handler`: `"share"` is
absent from `handlerTypeWantsAuth`'s list in `pkg/serverinit/serverinit.go:469-477`.

**4. Revocation is already just a normal delete claim.** `deletePermanode(target)` in
`client.js:232-235` (existing, shipped code) uploads `{camliType:"claim", claimType:"delete",
claimDate, target}` against any blobref, including a share claim's own blobref -- and
`share.go:203-210` already checks `idx.IsDeleted` on exactly that blob. Revoking a share is
"issue a delete claim targeting the share claim blob," nothing new.

**5. Link *production* already has partial precedent.** `SelectionActions.jsx:112-127`'s
`share()` action calls `createShareClaim(target, { transitive: true })`
(`client.js:237-247`, building `{camliType:"claim", claimType:"share", authType:"haveref",
transitive, target}`) and constructs the URL as
`` `${disco.shareRoot}${target}?via=${claimRef}&assemble=1` `` (file case) or
`` `${disco.shareRoot}${claimRef}` `` (permanode/set case), shown via a `MessageModal`. There is
no expiration UI, and `createShareClaim` doesn't yet accept/pass an expiration parameter to
`(*Builder).SetShareExpiration` -- that's the one small `client.js` addition needed.
`ImportShareModal.jsx` (the *consumption* side -- pasting someone else's share URL in) is
entirely separate and unaffected.

**6. Not index/Describe-based at all.** The whole entitlement walk uses only `blob.Fetcher`
and raw byte/schema parsing; the only index dependency is the single `idx.IsDeleted` check.
Building "local users"/"registered users" targets on top of this means: when sharing with a
specific account (not producing an anonymous secret link), either (a) still use a share claim
but somehow scope it to a specific account rather than "anyone with the link" (needs design --
the current `haveref` model has no recipient-identity check at all, it's purely
possession-of-the-link-based), or (b) use the Phase 2 ownership/ACL model instead (grant a
specific other account read access via an ACL-style claim, once that model exists) -- **this
choice should be made explicitly in Phase 5's own planning pass**, ideally after Phase 2 lands,
since (b) reuses Phase 2's machinery instead of inventing a second, parallel access-control
system.

## Phase 6: user profile Importers tab

Status: not started (deferred -- user explicitly said "cross that bridge later" regarding
OAuth-based importers). No research done. When picked up: Perkeep's importers
(`pkg/importer/*`) are OAuth-based and currently global/single-identity, not per-user -- making
them per-user is its own research question, not scoped here.
