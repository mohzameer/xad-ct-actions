# Plan — xad-ct-actions

**v0.1 · the parser and publisher for XAD Control Tower**

What this repo is, exactly how it parses a game repo, and what is deliberately
left out. `README.md` covers setup; `OPS.md` covers running and releasing. This
document is the specification.

---

## 1. Purpose

Game documentation lives in game repos. Control Tower shows it. This repo is the
only thing that connects them.

It runs inside each game repo's CI, reads that repo's `ct/` tree, checks it
against the constitution, and publishes a structured index to CT.

**Design constraints, all inherited:**

- CT never reads a repo. It has no credentials that could. Everything CT knows
  arrives through this parser.
- Git is canonical. This repo produces a derived view and never writes back.
- One parser, one vocabulary. If a second implementation existed, CT and local
  tooling could disagree about what a document means.

## 2. Scope

**In:** discovery, parsing, validation, relationship resolution, content graph
extraction, integrity computation, payload construction, publishing.

**Out:** authoring, modifying, or fixing documents. Reading from CT. Holding
credentials. Rendering. Deciding what documents mean — the constitution does
that, and the vocabulary tables here mirror it.

---

## 3. Pipeline

```
discover → parse → validate → resolve → analyse → assemble → publish
```

Each stage runs per subject. A repo with three subjects runs the whole pipeline
three times and sends three payloads.

### 3.1 Discover

```
glob <root>/*/subject.yml        # root defaults to "ct"
```

- Exactly one level deep. Subjects do not nest (Article II.5).
- A folder without `subject.yml` is not a subject and is skipped silently — this
  is how non-subject folders coexist under `ct/`.
- Folders beginning with `.` are ignored.
- `subject.yml`'s `id` **must equal its folder name** (Article II.3). Mismatch is
  a hard failure, not an integrity error: the id is how everything downstream is
  keyed, so a wrong one corrupts CT rather than merely reporting a problem.

`subject.yml` is read for: `id`, `name`, `lifecycle`, `repo`, `url`,
`constitution_version`, `summary`, `thresholds`. Unknown keys pass through
untouched — the parser is not the gatekeeper of that file's shape.

### 3.2 Parse

Walk the subject folder recursively. Skip:

| Path | Why |
|---|---|
| `subject.yml` | already read as metadata |
| `content/**` | handled by the graph loader, not as documents |
| `proposals/**` | AI staging, never published (Article VII.2) |
| `.*` | dotfiles and dot-directories |
| `README.md` | conventionally not a document — see the note under §8 |

**`.md` files** — frontmatter is the block between a leading `---` and the next
`\n---`. Everything after is the body. A `.md` file with no leading `---` yields
`missing_frontmatter` and is dropped from the payload. That is deliberate: a
document CT cannot key is worse than a document CT does not have.

**`.yml` / `.yaml` files** — the whole file is the frontmatter; the body is empty.
Records like decisions and audits are fields only.

**Any other extension** — ignored, no error. Images, scripts and notes may live
alongside documents.

Each parsed document yields:

```
id, type, status, title, path, frontmatter (whole block),
body, body_hash (sha256), updated, audited, commit
```

Bodies are sent in full. CT's document pages and diff-since-audit need them, and
fetching per view would require CT to hold repo credentials — which it must not.

### 3.3 Validate

Against the Article IV vocabulary, mirrored in `bin/index.mjs`.

| Check | Code | Severity |
|---|---|---|
| `id`, `type`, `title`, `status` present | `vocabulary_violation` | error |
| `id` unique within the subject | `duplicate_id` | error |
| `type` in the known set | `vocabulary_violation` | error |
| `status` legal for that `type` | `vocabulary_violation` | error |
| `provenance` in `decided`/`reconstructed`/`generated` | `vocabulary_violation` | error |
| `sim` matches the subject id | `vocabulary_violation` | error |
| every field in the vocabulary (Article IV.6) | `vocabulary_violation` | error |
| required-per-type fields present | `vocabulary_violation` | error |
| dynamics carry a `guard` | `guard_missing` | error |
| dynamics `to-close` with `guard: none` | `guard_missing` | error |
| conflicts name `between: [id, id]` | `vocabulary_violation` | error |

Legal statuses per type:

| type | statuses |
|---|---|
| `charter` `system` `decision` | `active` `superseded` |
| `content` `invariant` | `active` `retired` |
| `dynamic` | `intended` `tolerated` `to-close` `closed` |
| `conflict` | `open` `accepted` `resolved` |
| `bug` | `open` `investigating` `resolved` `not-a-defect` |
| `idea` | `inbox` `shaping` `spec` `merged` `dropped` |
| `audit` | `complete` |

**Uniqueness is checked within a subject only.** The constitution requires ids to
be globally unique (Article II.7), but a parser that only sees one repo cannot
verify that. **Cross-repo duplicate detection is CT's job** — CT sees every
subject and must flag collisions on ingest. This is a real gap in the parser and
must not be mistaken for coverage.

### 3.4 Resolve relationships

For each document, each entry in `affects` becomes a link:

```
{ source_id, target_id, resolved: boolean }
```

- Declared one direction only. Reverse edges are computed by CT querying the
  table backwards, never stored twice (Article V.2).
- Unresolvable target → `dangling_affects`, an error.
- **Resolution is within-subject.** A cross-subject `affects` will always appear
  dangling here. Either CT resolves links across subjects after ingest, or
  cross-subject `affects` is disallowed. **Unresolved — see §7.**
- Content files are not shipped as documents, but their ids resolve: a system
  document pointing at the instances it governs (Article III.4) is the ordinary
  case, not a dangling link.

### 3.5 Analyse content

`content/**.yml` files contribute to one graph per subject:

```yaml
nodes:
  - { id: n-start, label: Start, root: true }
  - { id: n-vpc, label: VPC, cost: 100, terminal: true }
edges:
  - { from: n-start, to: n-vpc, condition: { ... } }
```

Checks:

| Condition | Code | Severity |
|---|---|---|
| edge endpoint not a known node | `dangling_edge` | error |
| node with no inbound edge and not `root` | `orphan_node` | error |
| node with no outbound edge and not `terminal` | `dead_end` | warning |

`root` and `terminal` are explicit opt-outs. Without them every tree reports its
own start and leaves as problems. A node on no edge at all is neither — it is a
catalogue entry, and reports nothing (§8).

**Not yet implemented:** the min/max resource walk that detects unaffordable
gates — the check that would have caught the Race to AGI money gate. It is the
highest-value analysis in the whole system and it is absent. See §6.

### 3.6 Assemble

```json
{
  "subject": { "...contents of subject.yml" },
  "repo": "mohzameer/cloudsims",
  "ref": "refs/heads/main",
  "commit": "9f3c1ab",
  "parser_version": "0.1.0",
  "generated_at": "2026-08-27T09:14:02Z",
  "documents": [ { "id": "...", "frontmatter": {}, "body": "...", "body_hash": "..." } ],
  "links": [ { "source_id": "...", "target_id": "...", "resolved": true } ],
  "content": { "nodes": [], "edges": [] },
  "integrity": [ { "code": "...", "subject_id": "...", "severity": "error", "detail": {} } ]
}
```

`ref` and `commit` come from `GITHUB_REF` and `GITHUB_SHA`. Locally they default
to `refs/heads/local` and `local`, which keeps dry runs out of CT's real keyspace
even if someone publishes one by accident.

### 3.7 Publish

```
POST {CT_URL}/api/ingest
Authorization: Bearer {CT_TOKEN}
```

- One request per subject (Article XII.4).
- The full document set every time, never a delta (Article XII.2).
- Non-2xx → the run fails, and nothing partial is left behind: CT replaces a
  slice in a transaction or not at all.

CT is responsible for validating that the payload's `repo` and `subject.id` fall
within the token's scope. The parser cannot enforce this — it is holding the
token, not checking it.

---

## 4. Exit model

**Exit 0 with errors reported.** Integrity errors never fail the build. A broken
state must reach CT so CT can display it. A green board because publishing was
blocked is a worse outcome than a red one.

**Exit 1** only where the payload itself would be wrong: no `ct/` directory, no
subjects, id/folder mismatch, unknown lifecycle, unparseable `subject.yml`,
ingest rejection.

A per-file parse error is reported as an integrity issue and the file is dropped;
it does not stop the run. One malformed YAML record should not make an entire
subject invisible.

---

## 5. Performance

Everything is synchronous and in-memory. At the expected scale — tens of subjects,
hundreds of documents, thousands of nodes — this is not worth optimising.

The first thing that will hurt is body size, since every body ships on every run.
The fix, when it is actually needed, is to send `body_hash` always and bodies only
when the hash changes, with CT keeping the last known body. **Do not do this
pre-emptively** — it introduces a cache-coherence problem in exchange for
bandwidth nobody is short of.

---

## 6. Roadmap

**v0.1 — now.** Discovery, parsing, vocabulary validation, `affects` resolution,
basic graph checks, publishing.

**v0.2 — invariants.** The parameterised checks the constitution assumes exist
(Article IX.2): reachability, min/max resource at every gate, dominated-option
detection. Loaded from each subject's `invariants/`. **This is the piece that
turns integrity from structural to semantic**, and it is the reason content is
data rather than prose.

**v0.3 — constitution drift.** Compare `constitution_version` against the current
version and emit `constitution_drift`. Requires the parser to know the canonical
version, which means either pinning it here or fetching it — undecided.

**v0.4 — variable coverage.** Check that every state variable referenced in
content is declared in some system document, and every declared variable is used.
Requires system docs to declare variables in frontmatter rather than prose.

**Not planned:** rendering, writing, migrations, a plugin system.

---

## 7. Open questions

**Cross-subject `affects`.** Today any such link reports as dangling. Options:
resolve globally in CT after ingest, or forbid cross-subject links in the
constitution. The first is more useful — a shared engine change genuinely affects
several games — and needs CT to hold link resolution rather than the parser.

**Global id uniqueness.** The parser sees one repo. CT must detect collisions
across all of them and currently is not specified to.

**Where the vocabulary lives.** It is duplicated: normative in the constitution,
executable in `bin/index.mjs`. They drift. Generating the parser tables from the
constitution would fix it but requires the constitution to carry machine-readable
tables, which makes it less readable as a document. Living with the duplication
for now, with drift showing up as `vocabulary_violation` on correct documents.

**PR behaviour.** PRs currently parse with `--dry-run` and publish nothing, so
branch state never reaches CT. But CT's index is keyed by `ref` specifically to
hold branch state. Either publish branches from PRs and use that key, or drop
`ref` from the key. **The current design pays for a capability it does not use.**

---

## 8. Deviations from this spec, and why

Three, all found by running v0.1 against `awssims` and `racetoagi`. Each one
existed to stop a correct repo reporting errors — the integrity list is only
worth reading if everything on it is real.

**`README.md` is skipped, not reported as `missing_frontmatter`.** The audits
folders carry one by convention, saying what CT writes there. Reporting them made
`missing_frontmatter` mean "a README exists" in every repo.

**Content ids resolve `affects` targets** (§3.4). Content files are excluded from
`documents` but their ids are real document ids. Without this, every
`hum-sys-parts → hum-content-parts` link dangled.

**A node on no edge at all reports nothing** (§3.5). The features and problems
files enumerate instances and declare no edges; as written, each such node was an
`orphan_node` error. `orphan_node` now means a node with outbound edges that
nothing points at, which is the fault the check was for.
