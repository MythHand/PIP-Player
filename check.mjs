#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════
   Проверка целостности перед тем, как открывать в браузере.
   Ловит то, на чём я уже дважды обжёгся: всплывающий слой,
   обрезанный overflow:hidden у предка.
   Запуск:  node check.mjs
   ═══════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(HERE, f), 'utf8');
const html = read('index.html'), css = read('styles.css'), js = read('app.js');

const problems = [], notes = [];
const fail = m => problems.push(m);
const note = m => notes.push(m);

/* ── разбор разметки в дерево ─────────────────────────────── */
const VOID = new Set(['area','base','br','col','embed','hr','img','input',
                      'link','meta','param','source','track','wbr']);
function parse(src) {
  const root = { tag: '#root', cls: [], id: null, parent: null, kids: [] };
  let cursor = root;
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m;
  while ((m = re.exec(src))) {
    const [, closing, tag, attrs, selfClose] = m;
    if (closing) { if (cursor.parent) cursor = cursor.parent; continue; }
    const cls = (/class="([^"]*)"/.exec(attrs) || [, ''])[1].split(/\s+/).filter(Boolean);
    const id = (/id="([^"]*)"/.exec(attrs) || [, null])[1];
    const node = { tag, cls, id, parent: cursor, kids: [] };
    cursor.kids.push(node);
    if (!selfClose && !VOID.has(tag.toLowerCase())) cursor = node;
  }
  return root;
}
function walk(node, fn) { fn(node); node.kids.forEach(k => walk(k, fn)); }

/* ── правила CSS по классам ───────────────────────────────── */
const rules = [];
{
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(body))) {
    const sels = m[1].split(',').map(s => s.trim()).filter(Boolean);
    for (const sel of sels) rules.push({ sel, decl: m[2] });
  }
}
const declsForClass = cls => rules.filter(r =>
  new RegExp('\\.' + cls.replace(/[-]/g, '\\-') + '(?![\\w-])').test(r.sel));

/* ── 1. дубли и потерянные id ─────────────────────────────── */
{
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
  if (dup.length) fail(`дубли id: ${[...new Set(dup)].join(', ')}`);

  const used = new Set([...js.matchAll(/\$\('#([\w-]+)'\)/g)].map(m => m[1]));
  const missing = [...used].filter(u => !ids.includes(u));
  if (missing.length) fail(`js обращается к несуществующим id: ${missing.join(', ')}`);
}

/* ── 2. баланс скобок ─────────────────────────────────────── */
{
  const o = (css.match(/\{/g) || []).length, c = (css.match(/\}/g) || []).length;
  if (o !== c) fail(`css: скобок { ${o}, } ${c}`);
}

/* ── 3. классы без стиля и стили без классов ──────────────── */
const liveClasses = new Set();
{
  for (const m of html.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach(c => liveClasses.add(c));
  // классы, которые js добавляет строками или через classList
  for (const m of js.matchAll(/classList\.\w+\(([^)]*)\)/g))
    for (const q of m[1].matchAll(/'([^']+)'/g)) q[1].split(/\s+/).forEach(c => liveClasses.add(c));
  for (const m of js.matchAll(/class(?:Name)?\s*=\s*'([^']*)'/g)) m[1].split(/\s+/).forEach(c => c && liveClasses.add(c));
  for (const m of js.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach(c => liveClasses.add(c));
  for (const m of js.matchAll(/'\s*([a-z][\w-]*(?:__[\w-]+)?(?:--[\w-]+)?)\s*'/g)) liveClasses.add(m[1]);

  const cssClasses = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]));
  const orphanMarkup = [...liveClasses].filter(c => /^[a-z]/.test(c) && !cssClasses.has(c)
    && [...html.matchAll(/class="([^"]+)"/g)].some(m => m[1].split(/\s+/).includes(c)));
  if (orphanMarkup.length) fail(`в разметке есть классы без стиля: ${orphanMarkup.join(', ')}`);

  const dead = [...cssClasses].filter(c => !liveClasses.has(c));
  if (dead.length) note(`css-правила, которые никто не использует: ${dead.join(', ')}`);
}

/* ── 4. ГЛАВНОЕ: всплывающие слои не должны обрезаться ────── */
{
  const POPUPS = ['menu', 'seek__tip'];
  // где overflow:hidden осмыслен и слой обязан просто помещаться внутрь
  const ALLOWED = new Set(['stage', 'stage-host', 'queue', 'queue__list', 'modal__card', 'browser__list']);
  const tree = parse(html);

  walk(tree, node => {
    if (!node.cls.some(c => POPUPS.includes(c))) return;
    const who = node.id ? '#' + node.id : '.' + node.cls.join('.');
    for (let p = node.parent; p; p = p.parent) {
      for (const cls of p.cls) {
        const clips = declsForClass(cls).some(r =>
          /overflow(-x|-y)?\s*:\s*hidden/.test(r.decl) &&
          !/^\S+\s/.test(r.sel.replace(/^\./, '')) === false ? false : /overflow(-x|-y)?\s*:\s*hidden/.test(r.decl));
        if (!clips) continue;
        if (ALLOWED.has(cls)) { continue; }
        fail(`слой ${who} обрезается предком .${cls} — у него overflow:hidden`);
      }
    }
  });
}

/* ── 5. свойства, отданные на волю порядка в файле ──────────
   Если у элемента два класса и оба одиночными селекторами задают одно
   и то же свойство раскладки, победит просто тот, что ниже. Так
   .menuwrap перебил .gear и выкинул кнопку в обычный поток. */
{
  const KEY = ['position', 'display', 'overflow', 'z-index',
               'top', 'right', 'bottom', 'left'];
  const single = new Map();   // класс -> { свойство: [значение, порядок] }
  rules.forEach((r, i) => {
    const m = /^\.([\w-]+)$/.exec(r.sel.trim());
    if (!m) return;
    const bag = single.get(m[1]) || {};
    for (const prop of KEY) {
      const d = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;}]+)').exec(r.decl);
      if (d) bag[prop] = [d[1].trim(), i];
    }
    single.set(m[1], bag);
  });

  const seen = new Set();
  walk(parse(html), node => {
    if (node.cls.length < 2) return;
    for (const prop of KEY) {
      const decls = node.cls
        .map(c => [c, (single.get(c) || {})[prop]])
        .filter(([, v]) => v);
      if (decls.length < 2) continue;
      /* .block и .block--mod — намеренная пара, но только если модификатор
         объявлен НИЖЕ базы. Выше — база его перебьёт, и это ошибка.
         Независимые классы (.gear и .menuwrap) опасны в любом порядке. */
      const isMod = (a, b) => a.startsWith(b + '--') || a.startsWith(b + '__');
      const okPair = ([a, av], [b, bv]) =>
        (isMod(a, b) && av[1] > bv[1]) || (isMod(b, a) && bv[1] > av[1]);
      if (decls.every(x => decls.every(y => x[0] === y[0] || okPair(x, y)))) continue;
      const vals = new Set(decls.map(([, v]) => v[0]));
      if (vals.size < 2) continue;
      const win = decls.reduce((a, b) => (a[1][1] > b[1][1] ? a : b));
      const key = node.cls.join('.') + prop;
      if (seen.has(key)) continue;
      seen.add(key);
      fail(`у .${node.cls.join('.')} свойство ${prop} задают ` +
           decls.map(([c, v]) => `.${c}:${v[0]}`).join(' и ') +
           ` — побеждает .${win[0]} только из-за порядка в файле`);
    }
  });
}

/* ── 6. один селектор объявлен дважды с конфликтом display ── */
{
  const seen = new Map();
  for (const r of rules) {
    const d = /display\s*:\s*([\w-]+)/.exec(r.decl);
    if (!d) continue;
    const prev = seen.get(r.sel);
    if (prev && prev !== d[1]) note(`селектор ${r.sel} задаёт display дважды: ${prev} и ${d[1]}`);
    seen.set(r.sel, d[1]);
  }
}

/* ── итог ─────────────────────────────────────────────────── */
for (const n of notes) console.log('  ~ ' + n);
if (!problems.length) {
  console.log('\n  Проверка пройдена: ' + (notes.length ? 'замечаний ' + notes.length + ', ошибок нет' : 'чисто') + '\n');
  process.exit(0);
}
console.log('');
for (const p of problems) console.log('  ✗ ' + p);
console.log('\n  Ошибок: ' + problems.length + '\n');
process.exit(1);
