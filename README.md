# xad-ct-actions

The parser and publisher for [XAD Control Tower](https://ct.xadlabs.com).

One GitHub composite action, called by every game repo. It reads that repo's
`ct/` tree, checks it against the constitution's vocabulary, and POSTs one index
per subject to CT.

- **`PLAN.md`** — the specification: every stage, every check, what is missing.
- **`OPS.md`** — running, releasing, rolling back, and reading a failure.

Control Tower never reads a repo, and this repo holds no credentials. Everything
CT knows arrives through these POSTs.

## Using it from a game repo

1. Add repository secrets `CT_URL` and `CT_TOKEN`, both minted in CT and scoped
   to that repo.
2. Copy [`CALLER-WORKFLOW.yml`](CALLER-WORKFLOW.yml) to
   `.github/workflows/index.yml`.
3. Make sure at least one `ct/<id>/subject.yml` exists.

```yaml
- uses: actions/checkout@v4
- uses: mohzameer/xad-ct-actions@v1
  with:
    ct-url: ${{ secrets.CT_URL }}
    ct-token: ${{ secrets.CT_TOKEN }}
```

A repo with several games needs nothing extra. Every `ct/<id>/subject.yml` is
discovered, and each subject is published as its own payload.

### Inputs

| Input | Default | Meaning |
|---|---|---|
| `ct-url` | — | Control Tower base URL. Required. |
| `ct-token` | — | Ingest token. Required. |
| `root` | `ct` | Document root to scan. |
| `subject` | *all* | Index only this subject id. |
| `dry-run` | `false` | Parse and report, publish nothing. |
| `out` | — | Also write each payload to `<out>/<subject>.json`. |
| `node-version` | `20` | Node version for the parser. |

## Running it locally

From inside a game repo, before every release:

```bash
node /path/to/xad-ct-actions/bin/index.mjs --root ct --dry-run --out /tmp/out
```

It prints each subject with its document count, node and edge counts, and every
integrity finding, then writes the exact payloads it would have sent.

```
Found 2 subject(s) in ct/
  local refs/heads/local local
  hum — 42 docs, 50 nodes, 16 error(s), 7 warning(s)
  ERROR  orphan_node  path=ct/hum/content/hum-content-wiring.yml node=hum-client-web
  dry run: not published
  spool — 28 docs, 35 nodes, 11 error(s), 8 warning(s)
  dry run: not published
Done. 27 integrity error(s) across 2 subject(s).
```

Integrity errors exit 0 — a broken state must reach CT so CT can show it. Only a
structurally wrong payload exits 1; see OPS.md, "Exit codes".

## Layout

```
action.yml            the composite action
bin/index.mjs         the parser — discovery through publish, and the vocabulary
CALLER-WORKFLOW.yml   template for a game repo's .github/workflows/index.yml
PLAN.md               the specification
OPS.md                running and releasing
```

The vocabulary tables in `bin/index.mjs` mirror Article IV.8 of the constitution,
which is normative. When it is amended, amend it there first and follow here.
