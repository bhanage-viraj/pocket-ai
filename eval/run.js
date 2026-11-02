#!/usr/bin/env node
// Intent + extraction evaluation harness.
//
// Runs every labelled message in eval/datasets/*.jsonl through the SAME detector the bot uses
// (prefilter + grammar-constrained model call) against a running llama-server, then reports:
//   intent accuracy, per-task precision/recall/F1, field extraction accuracy,
//   latency avg/p50/p95, generation speed, prompt-cache hit rate.
//
// Usage:
//   node eval/run.js                          # all tasks, default LLM_URL
//   node eval/run.js --label q4km-t4          # name this run
//   node eval/run.js --url http://127.0.0.1:8091 --no-prefilter
//   node eval/run.js --tasks save_resource    # subset (chat negatives always included)
//   node eval/run.js --baseline eval/results/baseline.json   # fail if any task got worse
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { config } from '../src/config.js';
import { createLlmClient } from '../src/llm/client.js';
import { loadTasks } from '../src/tasks/index.js';
import { createIntentDetector } from '../src/intent/detect.js';
import { buildMessages } from '../src/intent/prompt.js';
import { mean, percentile, round } from '../src/util/stats.js';
import { normalizeKey } from '../src/util/text.js';
import { matchField } from './matchers.js';

const root = path.dirname(fileURLToPath(import.meta.url));

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: config.llmUrl },
    label: { type: 'string' },
    tasks: { type: 'string' },
    'no-prefilter': { type: 'boolean', default: false },
    limit: { type: 'string' },
    baseline: { type: 'string' },
    tolerance: { type: 'string', default: '3' },
    'no-save': { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
  },
});

function loadDatasets(taskNames) {
  const dir = path.join(root, 'datasets');
  const cases = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter((l) => l.trim());
    lines.forEach((line, i) => {
      const c = JSON.parse(line);
      if (!taskNames.includes(c.intent)) return;
      cases.push({ id: `${file}:${i + 1}`, fields: {}, tags: [], ...c });
    });
  }
  return cases;
}

function hash(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 8);
}

async function main() {
  const only = args.tasks?.split(',').map((s) => s.trim());
  const tasks = await loadTasks({ only });
  const taskNames = tasks.map((t) => t.name);
  let cases = loadDatasets(taskNames);

  // Guard against leakage: eval messages must not be few-shot examples.
  const fewShot = new Set(tasks.flatMap((t) => t.examples.map((e) => normalizeKey(e.text))));
  const leaked = cases.filter((c) => fewShot.has(normalizeKey(c.text)));
  if (leaked.length) {
    console.warn(`⚠️  ${leaked.length} eval case(s) are also few-shot examples — excluded: ${leaked.map((c) => c.id).join(', ')}`);
    cases = cases.filter((c) => !leaked.includes(c));
  }
  if (args.limit) cases = cases.slice(0, Number(args.limit));

  const llm = createLlmClient({ url: args.url, timeoutMs: 120_000 });
  if (!(await llm.health())) {
    console.error(`llama-server is not reachable at ${args.url}. Start it first (scripts/run-llm.sh).`);
    process.exit(2);
  }
  const model = await llm.model();
  const prefilter = !args['no-prefilter'];
  const generations = [];
  const detector = createIntentDetector({
    llm, tasks, prefilter,
    onGeneration: (_kind, r) => generations.push(r),
  });
  const promptVersion = hash(buildMessages(tasks, '').slice(0, -1).concat([detector.schema]));
  const label = args.label || `${model}${prefilter ? '' : '-noprefilter'}`;

  // Warm-up: fills the prompt cache like a running bot would. Not counted.
  await detector.detect('save https://example.com/warmup for my warmup project');
  generations.length = 0;

  console.log(`Running ${cases.length} cases · model ${model} · prefilter ${prefilter ? 'on' : 'off'} · prompt ${promptVersion}`);
  const results = [];
  for (const [i, c] of cases.entries()) {
    const genBefore = generations.length;
    const r = await detector.detect(c.text);
    const fieldChecks = Object.entries(c.fields).map(([field, expected]) => ({
      field, expected, actual: r.fields[field] ?? null,
      ok: r.intent === c.intent && matchField(expected, r.fields[field]),
    }));
    results.push({
      ...c,
      predicted: r.intent,
      predictedFields: r.fields,
      via: r.via,
      ms: r.ms,
      gen: generations[genBefore]?.timings,
      intentOk: r.intent === c.intent,
      fieldChecks,
    });
    if (!args.quiet) process.stdout.write(r.intent === c.intent ? '.' : 'x');
    if (!args.quiet && (i + 1) % 60 === 0) process.stdout.write('\n');
  }
  if (!args.quiet) process.stdout.write('\n\n');

  const report = summarize(results, { label, model, prefilter, promptVersion, taskNames, url: args.url });
  printReport(report);

  if (!args['no-save']) {
    const dir = path.join(root, 'results');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '')}_${label}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`\nSaved ${path.relative(process.cwd(), file)}`);
  }

  if (args.baseline) process.exitCode = compareBaseline(report, args.baseline, Number(args.tolerance));
}

function summarize(results, meta) {
  const perTask = {};
  for (const name of meta.taskNames) {
    const actual = results.filter((r) => r.intent === name);
    const predicted = results.filter((r) => r.predicted === name);
    const tp = actual.filter((r) => r.predicted === name).length;
    const recall = actual.length ? tp / actual.length : 0;
    const precision = predicted.length ? tp / predicted.length : 0;
    const f1 = recall + precision ? (2 * recall * precision) / (recall + precision) : 0;
    const fields = {};
    for (const r of actual) {
      for (const fc of r.fieldChecks) {
        fields[fc.field] ??= { ok: 0, n: 0 };
        fields[fc.field].n++;
        if (fc.ok) fields[fc.field].ok++;
      }
    }
    perTask[name] = {
      n: actual.length,
      recall: round(recall * 100),
      precision: round(precision * 100),
      f1: round(f1 * 100),
      fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, round((v.ok / v.n) * 100)])),
    };
  }

  const byTag = {};
  for (const r of results) for (const tag of r.tags) {
    byTag[tag] ??= { ok: 0, n: 0 };
    byTag[tag].n++;
    if (r.intentOk) byTag[tag].ok++;
  }

  const allChecks = results.flatMap((r) => r.fieldChecks);
  const exact = results.filter((r) => r.intentOk && r.fieldChecks.every((f) => f.ok)).length;
  const modelRuns = results.filter((r) => r.via === 'model');
  const lat = (rs) => {
    const ms = rs.map((r) => r.ms);
    return { avg: Math.round(mean(ms)), p50: Math.round(percentile(ms, 50)), p95: Math.round(percentile(ms, 95)) };
  };
  const gens = results.map((r) => r.gen).filter(Boolean);
  const promptTotal = gens.reduce((a, g) => a + g.promptN + g.cacheN, 0);

  return {
    ...meta,
    date: new Date().toISOString(),
    n: results.length,
    intentAccuracy: round((results.filter((r) => r.intentOk).length / results.length) * 100),
    fieldAccuracy: allChecks.length ? round((allChecks.filter((f) => f.ok).length / allChecks.length) * 100) : null,
    exactMatch: round((exact / results.length) * 100),
    perTask,
    byTag: Object.fromEntries(Object.entries(byTag).map(([k, v]) => [k, { n: v.n, accuracy: round((v.ok / v.n) * 100) }])),
    latencyMs: { all: lat(results), modelCalls: lat(modelRuns) },
    prefilterSkipPct: round(((results.length - modelRuns.length) / results.length) * 100),
    // task messages the keyword prefilter wrongly sent straight to chat
    prefilterMisses: results.filter((r) => r.via === 'prefilter' && r.intent !== 'chat').map((r) => r.id),
    genTokPerSec: round(mean(gens.map((g) => g.tokPerSec))),
    avgOutputTokens: round(mean(gens.map((g) => g.predictedN))),
    avgNewPromptTokens: round(mean(gens.map((g) => g.promptN))),
    cacheHitPct: promptTotal ? round((gens.reduce((a, g) => a + g.cacheN, 0) / promptTotal) * 100) : 0,
    failures: results
      .filter((r) => !r.intentOk || r.fieldChecks.some((f) => !f.ok))
      .map((r) => ({
        id: r.id, text: r.text, expected: r.intent, predicted: r.predicted,
        fields: r.fieldChecks.filter((f) => !f.ok).map((f) => ({ field: f.field, expected: f.expected, actual: f.actual })),
      })),
  };
}

function printReport(r) {
  const t = r.latencyMs;
  console.log(`## ${r.label}  (model ${r.model}, prompt ${r.promptVersion}, ${r.n} cases)\n`);
  console.log('| Metric | Value |\n|---|---|');
  console.log(`| Intent accuracy | **${r.intentAccuracy}%** |`);
  console.log(`| Field accuracy | ${r.fieldAccuracy}% |`);
  console.log(`| Exact match (intent + all fields) | ${r.exactMatch}% |`);
  console.log(`| Latency all msgs avg / p50 / p95 | ${t.all.avg} / ${t.all.p50} / ${t.all.p95} ms |`);
  console.log(`| Latency model calls avg / p95 | ${t.modelCalls.avg} / ${t.modelCalls.p95} ms |`);
  console.log(`| Skipped by prefilter | ${r.prefilterSkipPct}% (wrongly skipped: ${r.prefilterMisses.length}) |`);
  console.log(`| Gen speed | ${r.genTokPerSec} tok/s |`);
  console.log(`| Prompt cache hit | ${r.cacheHitPct}% (avg ${r.avgNewPromptTokens} new prompt tok, ${r.avgOutputTokens} output tok) |`);

  console.log('\n| Task | n | Precision | Recall | F1 | Fields |\n|---|---|---|---|---|---|');
  for (const [name, s] of Object.entries(r.perTask)) {
    const f = Object.entries(s.fields).map(([k, v]) => `${k} ${v}%`).join(', ') || '—';
    console.log(`| ${name} | ${s.n} | ${s.precision}% | ${s.recall}% | ${s.f1}% | ${f} |`);
  }
  console.log(`\nBy tag: ${Object.entries(r.byTag).map(([k, v]) => `${k} ${v.accuracy}% (${v.n})`).join(' · ')}`);

  if (r.failures.length && !args.quiet) {
    console.log(`\n### Failures (${r.failures.length})`);
    for (const f of r.failures) {
      const why = f.expected !== f.predicted
        ? `intent ${f.expected} → ${f.predicted}`
        : f.fields.map((x) => `${x.field}: want ${JSON.stringify(x.expected)} got ${JSON.stringify(x.actual)}`).join('; ');
      const via = r.prefilterMisses.includes(f.id) ? ' (prefilter)' : '';
      console.log(`- [${f.id}] "${f.text.slice(0, 70)}" — ${why}${via}`);
    }
  }
}

/** Regression check: returns exit code 1 if any task's F1 or field accuracy dropped by more than `tol` points. */
function compareBaseline(report, file, tol) {
  const base = JSON.parse(fs.readFileSync(file, 'utf8'));
  const regressions = [];
  console.log(`\n### vs baseline ${path.basename(file)} (${base.label})\n`);
  console.log('| Task | F1 | Δ | Fields Δ |\n|---|---|---|---|');
  for (const [name, s] of Object.entries(report.perTask)) {
    const b = base.perTask[name];
    if (!b) {
      console.log(`| ${name} | ${s.f1}% | new | |`);
      continue;
    }
    const d = round(s.f1 - b.f1);
    const fd = Object.entries(s.fields).map(([k, v]) => {
      const delta = b.fields[k] === undefined ? null : round(v - b.fields[k]);
      if (delta !== null && delta < -tol) regressions.push(`${name}.${k} ${delta}`);
      return delta === null ? `${k} new` : `${k} ${delta >= 0 ? '+' : ''}${delta}`;
    });
    if (d < -tol) regressions.push(`${name} F1 ${d}`);
    console.log(`| ${name} | ${s.f1}% | ${d >= 0 ? '+' : ''}${d} | ${fd.join(', ')} |`);
  }
  if (regressions.length) {
    console.log(`\n❌ Regressions beyond ${tol} points: ${regressions.join(', ')}`);
    return 1;
  }
  console.log(`\n✅ No task regressed more than ${tol} points.`);
  return 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
