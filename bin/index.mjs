#!/usr/bin/env node
/**
 * The parser and publisher for XAD Control Tower.
 *
 * Runs inside a game repo's CI, over that repo's own working copy. For every
 * `<root>/<id>/subject.yml` it finds, it parses the documents beside it,
 * checks them against the constitution's vocabulary, resolves relationships,
 * computes integrity errors, and POSTs one payload per subject to CT.
 *
 *   discover -> parse -> validate -> resolve -> analyse -> assemble -> publish
 *
 * Two behaviours here are load-bearing and look like optimisations later:
 * the full document set goes every run (never a delta), and each subject is
 * its own POST (never merged). See OPS.md, "What must not change".
 *
 * Exit 0 with integrity errors reported. Exit 1 only where the payload itself
 * would be wrong. See PLAN.md §4.
 *
 * Usage:
 *   node bin/index.mjs --root ct --dry-run --out /tmp/out
 *   node bin/index.mjs --root ct            # publishes, using CT_URL/CT_TOKEN
 */

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const PARSER_VERSION = JSON.parse(
  readFileSync(join(HERE, '..', 'package.json'), 'utf8'),
).version;

/* ---------------------------------------------------------- vocabulary --
 * Article IV.8, transcribed. This is a copy of a table that lives in the
 * constitution, and the constitution is normative: when it is amended, this
 * table follows. Drift shows up as `vocabulary_violation` on documents that
 * are actually correct, which is the cost of the duplication (PLAN.md §7).
 */

/** Core fields, on every document. */
const CORE = {
  id:           { req: true },
  type:         { req: true },
  sim:          { req: true },
  title:        { req: true },
  status:       { req: true },
  updated:      { req: true, date: true },
  body:         { req: false },
  provenance:   { req: false, values: ['decided', 'reconstructed', 'generated'] },
  affects:      { req: false, list: true },
  derived_from: { req: false, list: true },
  audited:      { req: false, date: true },
  tags:         { req: false, list: true },
};

/** Per type: legal statuses, and additional fields — `true` marks required. */
const TYPES = {
  charter:   { status: ['active', 'superseded'], extra: {} },
  system:    { status: ['active', 'superseded'],
               extra: { variables: false, invariants: false } },
  content:   { status: ['active', 'retired'],
               extra: { nodes: false, edges: false, gates: false, schema_version: false } },
  decision:  { status: ['active', 'superseded'],
               extra: { rejected: true, why: true, superseded_by: false } },
  dynamic:   { status: ['intended', 'tolerated', 'to-close', 'closed'],
               extra: { kind: false, guard: true, systems: false },
               enums: { kind: ['strategy', 'loop', 'degenerate'] } },
  conflict:  { status: ['open', 'accepted', 'resolved'],
               extra: { between: true, kind: true, reason: false, resolution: false },
               enums: { kind: ['charter-system', 'system-system', 'rule-instance',
                               'decision-decision', 'practice-constitution'] } },
  bug:       { status: ['open', 'investigating', 'resolved', 'not-a-defect'],
               extra: { severity: false, resolution: false, reported: false },
               enums: { severity: ['low', 'medium', 'high', 'blocker'] } },
  idea:      { status: ['inbox', 'shaping', 'spec', 'merged', 'dropped'],
               extra: { class: false, split_into: false, drop_reason: false } },
  audit:     { status: ['complete'], extra: { scope: true, found: false, method: false } },
  invariant: { status: ['active', 'retired'],
               extra: { check: false, params: false, closes: false } },
};

/** Article II.4. A subject's lifecycle is one of these four. */
const LIFECYCLE = ['intake', 'build', 'live', 'retired'];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------- helpers -- */

/** Exit 1: the payload itself would be wrong. PLAN.md §4. */
function fail(message) {
  console.error(message);
  process.exit(1);
}

const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const isDate = (v) => typeof v === 'string' && ISO_DATE.test(v);

/** YAML dates parse as Date; everything downstream wants the string back. */
function scalar(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v;
}

function plainFrontmatter(fm) {
  const out = {};
  for (const [k, v] of Object.entries(fm)) out[k] = scalar(v);
  return out;
}

/* ------------------------------------------------------------- args ----- */

function usage() {
  console.log(`xad-ct-index ${PARSER_VERSION}

  --root <dir>       document root to scan          (default: ct)
  --subject <id>     only this subject              (default: all)
  --out <dir>        write each payload to <dir>/<subject>.json
  --dry-run          parse and report, publish nothing
  --ct-url <url>     Control Tower base URL         (default: $CT_URL)
  --ct-token <tok>   ingest token                   (default: $CT_TOKEN)
`);
}

function parseArgs(argv) {
  const opts = {
    root: 'ct',
    subject: null,
    out: null,
    dryRun: false,
    ctUrl: process.env.CT_URL ?? '',
    ctToken: process.env.CT_TOKEN ?? '',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) fail(`option '${arg}' needs a value`);
      return v;
    };
    switch (arg) {
      case '--root': opts.root = value(); break;
      case '--subject': opts.subject = value(); break;
      case '--out': opts.out = value(); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--ct-url': opts.ctUrl = value(); break;
      case '--ct-token': opts.ctToken = value(); break;
      case '-h': case '--help': usage(); process.exit(0); break;
      default: fail(`unknown option '${arg}'`);
    }
  }
  return opts;
}

/* -------------------------------------------------------- 3.1 discover -- */

/**
 * `glob <root>/*​/subject.yml`, exactly one level deep. A folder without one is
 * not a subject and is skipped in silence — that is how tools/ and workflows/
 * coexist under ct/ (Article II.2).
 */
function discover(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    fail(`No '${root}/' directory found`);
  }

  const subjects = [];
  for (const name of readdirSync(root).sort()) {
    if (name.startsWith('.')) continue;
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    const path = join(dir, 'subject.yml');
    if (!existsSync(path)) continue;

    let meta;
    try {
      meta = parseYaml(readFileSync(path, 'utf8')) ?? {};
    } catch (err) {
      fail(`${path}: unparseable subject.yml: ${err.message}`);
    }
    meta = plainFrontmatter(meta);

    /* Article II.3. A hard failure rather than an integrity error: the id is
     * what everything downstream is keyed by, so a wrong one corrupts CT
     * rather than reporting a problem in CT. */
    if (meta.id !== name) {
      fail(`${path}: id '${meta.id ?? ''}' must equal folder name '${name}'`);
    }
    if (meta.lifecycle !== undefined && !LIFECYCLE.includes(meta.lifecycle)) {
      fail(`${path}: unknown lifecycle '${meta.lifecycle}' `
        + `(expected ${LIFECYCLE.join(' / ')})`);
    }

    subjects.push({ id: name, dir, path, meta });
  }

  if (subjects.length === 0) fail(`No subjects found under '${root}/'`);
  return subjects;
}

/* ----------------------------------------------------------- 3.2 parse -- */

/** Everything under a subject folder that the document walk must not open. */
function skipped(name, isDir) {
  if (name.startsWith('.')) return true;
  if (isDir) return name === 'content' || name === 'proposals';
  /* `README.md` is the one .md that is conventionally not a document — the
   * audits folders carry one saying what CT writes there. Skipping it by name
   * keeps `missing_frontmatter` meaning what it says. */
  return name === 'subject.yml' || name === 'README.md';
}

function walk(dir, into = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const isDir = statSync(path).isDirectory();
    if (skipped(name, isDir)) continue;
    if (isDir) walk(path, into);
    else into.push(path);
  }
  return into;
}

/** The block between a leading `---` and the next `\n---`. */
function splitFrontmatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  return { yaml: text.slice(4, end), body: text.slice(end + 4).replace(/^\r?\n/, '') };
}

/**
 * One document per file. A file that cannot be keyed is dropped and reported;
 * a document CT cannot key is worse than a document CT does not have.
 */
function parseDocuments(subject, run, report) {
  const documents = [];

  for (const path of walk(subject.dir)) {
    const ext = extname(path).toLowerCase();
    if (ext !== '.md' && ext !== '.yml' && ext !== '.yaml') continue;

    const text = readFileSync(path, 'utf8');
    let yaml;
    let body;

    if (ext === '.md') {
      const split = splitFrontmatter(text);
      if (!split) {
        report('missing_frontmatter', 'error', { path });
        continue;
      }
      ({ yaml, body } = split);
    } else {
      yaml = text;
      body = null;                     // taken from `body:` once parsed
    }

    let fm;
    try {
      fm = parseYaml(yaml) ?? {};
    } catch (err) {
      report('parse_error', 'error', { path, message: err.message });
      continue;
    }
    if (typeof fm !== 'object' || Array.isArray(fm)) {
      report('parse_error', 'error', { path, message: 'frontmatter is not a mapping' });
      continue;
    }
    fm = plainFrontmatter(fm);
    if (body === null) body = typeof fm.body === 'string' ? fm.body : '';

    documents.push({
      id: fm.id ?? null,
      type: fm.type ?? null,
      status: fm.status ?? null,
      title: fm.title ?? null,
      path,
      frontmatter: fm,
      body,
      body_hash: sha256(body),
      updated: fm.updated ?? null,
      audited: fm.audited ?? null,
      commit: run.commit,
    });
  }

  return documents;
}

/* -------------------------------------------------------- 3.3 validate -- */

function validate(subject, documents, report) {
  const seen = new Map();

  for (const doc of documents) {
    const fm = doc.frontmatter;
    const at = { path: doc.path, id: doc.id };
    const violation = (detail) => report('vocabulary_violation', 'error', { ...at, ...detail });

    for (const [field, rule] of Object.entries(CORE)) {
      const value = fm[field];
      if (rule.req && (value === undefined || value === null || value === '')) {
        violation({ field, reason: 'required field missing' });
      }
      if (value !== undefined && rule.date && !isDate(value)) {
        violation({ field, value, reason: 'expected YYYY-MM-DD' });
      }
      if (value !== undefined && rule.values && !rule.values.includes(value)) {
        violation({ field, value, allowed: rule.values.join(' ') });
      }
    }

    if (doc.id) {
      const first = seen.get(doc.id);
      if (first) report('duplicate_id', 'error', { ...at, also: first });
      else seen.set(doc.id, doc.path);
    }

    /* Article IV.3. The subject a document declares is the folder it is in. */
    if (fm.sim !== undefined && fm.sim !== subject.id) {
      violation({ field: 'sim', value: fm.sim, expected: subject.id });
    }

    const spec = TYPES[doc.type];
    if (doc.type !== null && !spec) {
      violation({ field: 'type', value: doc.type, allowed: Object.keys(TYPES).join(' ') });
      continue;                        // nothing per-type left to say
    }
    if (!spec) continue;

    if (doc.status !== null && !spec.status.includes(doc.status)) {
      violation({ field: 'status', value: doc.status, type: doc.type,
                  allowed: spec.status.join(' ') });
    }

    for (const [field, required] of Object.entries(spec.extra)) {
      if (required && fm[field] === undefined) {
        violation({ field, type: doc.type, reason: 'required for this type' });
      }
      const allowed = spec.enums?.[field];
      if (fm[field] !== undefined && allowed && !allowed.includes(fm[field])) {
        violation({ field, value: fm[field], allowed: allowed.join(' ') });
      }
    }

    /* Article IV.6: the vocabulary is the whole list. An unknown field is an
     * error, not a warning — there is no other constraint on this data. */
    const legal = new Set([...Object.keys(CORE), ...Object.keys(spec.extra)]);
    for (const field of Object.keys(fm)) {
      if (!legal.has(field)) violation({ field, type: doc.type, reason: 'not in the vocabulary' });
    }

    /* Article IX.3. A dynamic without a guard is an observation, not a
     * dynamic; one on its way out with `guard: none` never leaves. */
    if (doc.type === 'dynamic') {
      if (fm.guard === undefined || fm.guard === null || fm.guard === '') {
        report('guard_missing', 'error', at);
      } else if (doc.status === 'to-close' && String(fm.guard) === 'none') {
        report('guard_missing', 'error', { ...at, status: 'to-close', guard: 'none' });
      }
    }

    /* Article X.3. A conflict is between exactly two things. */
    if (doc.type === 'conflict' && list(fm.between).length !== 2) {
      violation({ field: 'between', count: list(fm.between).length,
                  reason: 'expected exactly two ids' });
    }
  }
}

/* --------------------------------------------------------- 3.4 resolve -- */

/**
 * `affects` is declared one side only (Article V.2). The reverse edge is CT's,
 * computed by querying the table backwards — never stored twice.
 *
 * Resolution is within-subject, so a cross-subject `affects` always reports as
 * dangling here. That is a known gap, not a rule (PLAN.md §7).
 */
function resolveLinks(documents, contentIds, report) {
  /* Content files are not shipped as documents — the graph loader owns them —
   * but their ids are real document ids, and `affects: <a content file>` is
   * how a system document points at the instances it governs (Article III.4).
   * Resolving against documents alone would dangle on every correct repo. */
  const known = new Set([
    ...documents.map((d) => d.id).filter(Boolean),
    ...contentIds,
  ]);
  const links = [];

  for (const doc of documents) {
    for (const target of list(doc.frontmatter.affects)) {
      const resolved = known.has(target);
      links.push({ source_id: doc.id, target_id: target, resolved });
      if (!resolved) {
        report('dangling_affects', 'error', { path: doc.path, id: doc.id, target });
      }
    }
  }

  return links;
}

/* --------------------------------------------------------- 3.5 analyse -- */

/**
 * One graph per subject, merged across every file under `content/`. The wiring
 * file names nodes the parts file declares, so the merge has to happen before
 * any edge can be checked.
 */
function loadContent(subject, report) {
  const dir = join(subject.dir, 'content');
  const nodes = [];
  const edges = [];
  const ids = [];
  if (!existsSync(dir)) return { nodes, edges, ids };

  for (const path of walk(dir, [])) {
    const ext = extname(path).toLowerCase();
    if (ext !== '.yml' && ext !== '.yaml') continue;

    let fm;
    try {
      fm = parseYaml(readFileSync(path, 'utf8')) ?? {};
    } catch (err) {
      report('parse_error', 'error', { path, message: err.message });
      continue;
    }
    if (fm.id) ids.push(fm.id);
    for (const node of list(fm.nodes)) nodes.push({ ...node, source: path });
    for (const edge of list(fm.edges)) edges.push({ ...edge, source: path });
  }

  return { nodes, edges, ids };
}

function analyseContent(graph, report) {
  const ids = new Set(graph.nodes.map((n) => n.id).filter(Boolean));
  const inbound = new Set();
  const outbound = new Set();

  for (const edge of graph.edges) {
    for (const [end, id] of [['from', edge.from], ['to', edge.to]]) {
      if (!ids.has(id)) {
        report('dangling_edge', 'error', { path: edge.source, end, node: id ?? null,
                                           from: edge.from ?? null, to: edge.to ?? null });
      }
    }
    if (edge.from !== undefined) outbound.add(edge.from);
    if (edge.to !== undefined) inbound.add(edge.to);
  }

  /* `root` and `terminal` are explicit opt-outs. Without them every tree
   * reports its own start and its own leaves as problems. */
  for (const node of graph.nodes) {
    if (!node.id) continue;
    /* A node on no edge at all is not a broken graph, it is a catalogue entry
     * — the features and problems files enumerate instances (Article III.4)
     * and declare no edges. Reporting those floods the integrity list, which
     * is the one thing that must stay trustworthy. */
    if (!inbound.has(node.id) && !outbound.has(node.id)) continue;
    if (!inbound.has(node.id) && !node.root) {
      report('orphan_node', 'error', { path: node.source, node: node.id });
    }
    if (!outbound.has(node.id) && !node.terminal) {
      report('dead_end', 'warning', { path: node.source, node: node.id });
    }
  }
}

/* -------------------------------------------------------- 3.6 assemble -- */

function assemble(subject, run, documents, links, graph, integrity) {
  return {
    subject: subject.meta,
    repo: run.repo,
    ref: run.ref,
    commit: run.commit,
    parser_version: PARSER_VERSION,
    generated_at: run.generated_at,
    documents: documents.map(({ frontmatter, ...rest }) => ({ ...rest, frontmatter })),
    links,
    content: { nodes: graph.nodes, edges: graph.edges },
    integrity,
  };
}

/* --------------------------------------------------------- 3.7 publish -- */

async function publish(payload, opts) {
  const url = `${opts.ctUrl.replace(/\/+$/, '')}/api/ingest`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.ctToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    fail(`ingest failed: ${url}: ${err.message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    fail(`ingest rejected: ${res.status} ${text.slice(0, 500)}`.trimEnd());
  }
  return res.status;
}

/* ------------------------------------------------------------- reporting - */

function summarise(subject, documents, graph, integrity) {
  const byType = {};
  for (const doc of documents) byType[doc.type ?? 'untyped'] = (byType[doc.type ?? 'untyped'] ?? 0) + 1;
  const errors = integrity.filter((f) => f.severity === 'error').length;
  const warnings = integrity.length - errors;

  console.log(
    `${subject.id}  ${documents.length} documents `
    + `[${Object.entries(byType).map(([t, n]) => `${t} ${n}`).join(', ') || 'none'}]  `
    + `${graph.nodes.length} nodes, ${graph.edges.length} edges  `
    + `lifecycle:${subject.meta.lifecycle ?? '?'}  `
    + `${errors} error(s), ${warnings} warning(s)`,
  );

  for (const finding of integrity) {
    const { code, severity, detail } = finding;
    const rest = Object.entries(detail)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${k}=${String(v).replace(/\s+/g, ' ').trim()}`)
      .join(' ');
    console.log(`  ${severity === 'error' ? 'ERROR' : 'warn '}  ${code}  ${rest}`);
  }
}

/* ------------------------------------------------------------------ main - */

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  /* Locally these default out of CT's real keyspace, so a dry run that gets
   * published by accident cannot land on top of a branch that exists. */
  const run = {
    repo: process.env.GITHUB_REPOSITORY ?? 'local',
    ref: process.env.GITHUB_REF ?? 'refs/heads/local',
    commit: process.env.GITHUB_SHA ?? 'local',
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };

  if (!opts.dryRun) {
    if (!opts.ctUrl) fail('CT_URL is not set (or pass --ct-url); use --dry-run to parse only');
    if (!opts.ctToken) fail('CT_TOKEN is not set (or pass --ct-token); use --dry-run to parse only');
  }
  if (opts.out) mkdirSync(opts.out, { recursive: true });

  let subjects = discover(opts.root);
  if (opts.subject) {
    subjects = subjects.filter((s) => s.id === opts.subject);
    if (subjects.length === 0) fail(`No subjects found matching '${opts.subject}'`);
  }

  console.log(
    `${subjects.length} subject(s) under ${resolve(opts.root)}  `
    + `${run.repo} ${run.ref} ${run.commit.slice(0, 7)}`,
  );

  /* One pipeline per subject, and one payload per subject. Merging them
   * collapses several subjects onto one key in CT. */
  for (const subject of subjects) {
    const integrity = [];
    const report = (code, severity, detail) =>
      integrity.push({ code, subject_id: subject.id, severity, detail });

    const documents = parseDocuments(subject, run, report);
    validate(subject, documents, report);
    const graph = loadContent(subject, report);
    const links = resolveLinks(documents, graph.ids, report);
    analyseContent(graph, report);

    const payload = assemble(subject, run, documents, links, graph, integrity);
    summarise(subject, documents, graph, integrity);

    if (opts.out) {
      const file = join(opts.out, `${subject.id}.json`);
      writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
      console.log(`  wrote ${file}`);
    }

    if (opts.dryRun) {
      console.log('  dry run: not published');
    } else {
      const status = await publish(payload, opts);
      console.log(`  published: ${status}`);
    }
  }

  /* Integrity errors do not fail the build. A broken state must reach CT so
   * CT can show it; a green board because publishing was blocked is worse
   * than a red one. */
  process.exit(0);
}

main();
