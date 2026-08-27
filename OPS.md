# Operations — xad-ct-actions

How to run, release and debug the documentation indexer.

Everything here is about *this* repo. What the documents themselves must contain
is the constitution's business, not this one's.

---

## What this repo does

One GitHub composite action, called by every game repo. On each push touching
`ct/**`, the game repo checks itself out and runs this parser against its own
working copy. The parser:

1. finds every `ct/<id>/subject.yml`
2. parses the documents in that folder
3. validates them against the constitution's vocabulary
4. resolves relationships and computes integrity errors
5. POSTs one payload per subject to Control Tower

**No credentials live here.** The action receives `CT_URL` and `CT_TOKEN` as
inputs from the calling repo's secrets and never stores them. This repo holds
code only.

**Control Tower never reads a repo.** Everything CT knows arrives through these
POSTs. If this action stops running, CT goes stale — it does not go wrong.

---

## Releasing

Game repos pin `@v1`. That tag is a moving pointer, so a release is a re-tag:

```bash
git commit -am "parser: <what changed>"
git push
git tag -f v1
git push -f origin v1
```

The next push in any game repo picks it up. There is no per-repo update step.

**This means a bad parser release breaks every repo at once.** Before re-tagging,
run against a real game repo locally (below). The whole rollout is one command,
so the only safety is what you do before it.

### Rolling back

```bash
git tag -f v1 <last-good-sha>
git push -f origin v1
```

Then re-run the workflow in any affected repo, or push an empty commit. CT keeps
showing the last successful index in the meantime, with a stale sync time.

### When to cut v2

Only if a parser change requires repos to change their documents. Then tag `v2`,
leave `v1` where it is, and move repos over one at a time. A change that repos
must adopt is a constitution amendment first — the parser follows it, never leads.

---

## Running locally

Always do this before a release, from inside a game repo:

```bash
node /path/to/xad-ct-actions/bin/index.mjs --root ct --dry-run --out /tmp/out
```

Prints every subject, document count, node count and integrity error. Writes the
exact payloads to `/tmp/out/<subject>.json` without touching CT.

A dry run defaults to `repo: local`, `ref: refs/heads/local`, `commit: local`,
which keeps it out of CT's real keyspace. To produce a payload you intend to
ingest by hand — a first bring-up, or reproducing a run — say so explicitly:

```bash
GITHUB_REPOSITORY=mohzameer/racetoagi GITHUB_REF=refs/heads/main \
GITHUB_SHA=$(git rev-parse HEAD) \
node /path/to/xad-ct-actions/bin/index.mjs --root ct --dry-run --out /tmp/out
```

Without those, the payload lands under a repo the token's scope row does not
cover, and CT answers 403 for what looks like a scoping bug.

To test CT's ingest endpoint separately:

```bash
curl -X POST https://ct.xadlabs.com/api/ingest \
  -H "Authorization: Bearer $CT_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/out/cloudsims.json
```

Debugging ingest with a saved payload is far faster than debugging it through
workflow runs.

---

## Onboarding a game repo

1. Add secrets `CT_URL` and `CT_TOKEN` (minted in CT, scoped to that repo)
2. Copy `CALLER-WORKFLOW.yml` to `.github/workflows/index.yml`
3. Ensure at least one `ct/<id>/subject.yml` exists
4. Push, watch the run, confirm the subject appears in CT

A repo with several games needs no extra setup — one token covers the repo, and
the parser publishes each subject separately.

---

## Exit codes

**Exit 0, errors listed.** Integrity errors do not fail the build. A broken state
must reach CT so CT can show it. A green board because publishing was blocked is
worse than a red one.

**Exit 1.** Structural problems, where the payload would be wrong rather than the
documents being wrong:

| Message | Cause | Fix |
|---|---|---|
| `No 'ct/' directory found` | docs elsewhere, or wrong `root` input | move them, or set `root:` |
| `No subjects found` | no `ct/<id>/subject.yml` | add one |
| `id 'x' must equal folder name 'y'` | Article II.3 violation | rename folder or id — **prefer the folder**, ids are permanent |
| `unknown lifecycle` | typo in `subject.yml` | `intake` / `build` / `live` / `retired` |
| `ingest rejected: 401` | token wrong, missing or revoked | re-mint in CT, update the secret |
| `ingest rejected: 403` | token's repo or subject scope mismatch | fix the token's scope row in CT |
| `ingest rejected: 5xx` | CT down or ingest broken | fix CT; re-run the workflow after |

---

## Common failures

**`action not found`** — the private-repo access setting is off. Settings →
Actions → General → Access → *Accessible from repositories owned by your account*,
on this repo.

**`npm ci` fails** — `package-lock.json` missing from the commit. It must be
committed; `npm ci` will not run without it.

**Workflow never triggers** — the path filter is `ct/**`. Editing a doc outside
that tree does nothing. Use *Run workflow* to force a run.

**Subject appears twice in CT** — two folders with different names carrying the
same `id`, or the same subject published from two repos. Ids are globally unique
(Article II.7); CT is showing the truth.

**Document vanished from CT but exists in the repo** — it failed to parse.
Missing frontmatter on a `.md` is the usual cause; check the run log for
`missing_frontmatter`.

**Everything looks stale** — check `last_used_at` for that repo's token in CT. If
it hasn't moved, the workflow is not running; if it has, ingest is failing after
auth.

---

## What must not change

Two behaviours are load-bearing. Both look like obvious optimisations later.

**Full document set every run — never a delta.** Ingest replaces the whole
`(repo, ref, subject)` slice. This is the only mechanism that handles deletions
and force-pushes. Sending only changed files leaves rows for documents that no
longer exist, and those produce integrity errors pointing at missing files, which
destroys trust in the integrity list.

**One payload per subject.** A repo with three games sends three POSTs. Merging
them collapses three subjects into one key and CT loses the ability to show them
separately.

---

## Boundaries

This repo parses and publishes. It does not:

- author or modify documents in a game repo
- hold credentials, or read anything from CT
- decide what documents mean — the constitution does that, and the vocabulary
  tables in `bin/index.mjs` mirror it

When the constitution changes, amend it first, then update the vocabulary here to
match. Drift between the two shows up as `vocabulary_violation` on documents that
are actually correct.
