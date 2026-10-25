# Multi-tenant Perkeep roadmap

**If you are a fresh session with no other context: read this whole file before doing
anything else.** It is the single source of truth for this effort -- more authoritative than
any conversation summary, and more complete than any ephemeral plan file (plan files live
outside the repo, are tied to one conversation, and are not updated after that conversation
ends; this file is).

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
| 2. Real per-user file isolation | not started | — |
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

Status: not started. **This is the hardest, highest-risk phase.** Do not start implementing
from this section alone -- it needs its own `EnterPlanMode` research pass first (see the open
question at the end) before a file-level plan can be written.

**TL;DR / core deliverable, so this doesn't get lost in the research below:** every new
permanode must get a server-stamped owner attribution at upload time (who uploaded it, written
synchronously by the server itself from the request's identity, not a client-settable claim --
see "The foundational problem" below for why), plus a blobref-level reverse lookup/cache so raw
blob storage (gap #5) can be owner-checked without a full per-call Describe. This is what makes
every other fix in this phase (search filtering, thumbnail/download auth, FUSE, raw blob
storage) actually enforceable -- without it there's no reliable "who owns this" to check
against in the first place.

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

**Open question for Phase 2's own planning pass (not yet researched)**: exactly where in
`pkg/blobserver`'s upload-handling path to hook "a new permanode blob was just received,
synchronously attach an ownership claim using the uploader's identity from this request."
Indexing in Perkeep is typically decoupled from the original upload HTTP request (e.g. a sync
queue processes blobs after the fact), so by the time something is indexing a permanode, the
original caller's identity is long gone -- the hook has to live in the upload HTTP handler
itself (which does still have the caller's bearer token in scope), not in the index's
blob-processing path. Find that handler (likely `pkg/blobserver`'s multipart upload handler,
registered for the `camli/upload` route) and confirm it can synchronously call back into
`pkg/accounts`-style permanode/claim creation before responding to the client -- this is the
first thing to resolve before writing Phase 2's detailed plan.

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
