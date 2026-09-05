/* ═══════════════════════════════════════════════════════════
   Nocturne — плеер
   Два режима: чистый file:// и локальный мост на ffmpeg.
   ═══════════════════════════════════════════════════════════ */
(() => {
'use strict';

const $ = (s, r = document) => r.querySelector(s);

/* ── dom ─────────────────────────────────────────────────── */
const workspace = $('#workspace'), stageHost = $('#stageHost'), stage = $('#stage');
const video = $('#video'), prober = $('#prober');
const titleName = $('#titleName'), titlePath = $('#titlePath');
const pulseEl = $('#pulse'), pulseIcon = $('#pulseIcon'), flashEl = $('#flash');
const notice = $('#notice'), noticeText = $('#noticeText');
const endCard = $('#endCard'), endMeta = $('#endMeta');
const emptyEl = $('#empty'), modeHint = $('#modeHint');
const prep = $('#prep'), prepName = $('#prepName'), prepTrack = $('#prepTrack');
const prepSteps = $('#prepSteps'), prepCmd = $('#prepCmd');
const deck = $('#deck'), seek = $('#seek'), seekFill = $('#seekFill');
const seekBuffer = $('#seekBuffer'), seekKnob = $('#seekKnob'), seekTip = $('#seekTip');
const tCur = $('#tCur'), tDur = $('#tDur');
const btnPlay = $('#btnPlay'), playIcon = $('#playIcon');
const btnMute = $('#btnMute'), volIcon = $('#volIcon'), volBar = $('#volBar'), volFill = $('#volFill');
const btnRate = $('#btnRate'), btnLoop = $('#btnLoop'), btnList = $('#btnList');
const btnAuto = $('#btnAuto');
const btnPip = $('#btnPip'), btnFull = $('#btnFull');
const btnPipMode = $('#btnPipMode'), pipMenu = $('#pipMenu'), pipSeg = $('#pipSeg');
const rateMenu = $('#rateMenu');
const btnAudio = $('#btnAudio'), audioLabel = $('#audioLabel'), audioMenu = $('#audioMenu');
const btnSubs = $('#btnSubs'), subsMenu = $('#subsMenu');
const queueList = $('#queueList'), queueFiles = $('#queueFiles'), queueTotal = $('#queueTotal');
const ghostName = $('#ghostName');
const filePick = $('#filePick'), dirPick = $('#dirPick');
const dropveil = $('#dropveil'), toastEl = $('#toast');
const browserModal = $('#browserModal'), helpModal = $('#helpModal');
const brPlaces = $('#brPlaces'), brList = $('#brList'), brPath = $('#brPath');
const btnDisk = $('#btnDisk'), btnEmptyDisk = $('#btnEmptyDisk');

/* ── состояние ───────────────────────────────────────────── */
const state = {
  list: [], current: null,
  loop: 'off', queueOpen: true,
  autoplay: localStorage.getItem('pip.autoplay') !== '0',
  audioPref: null,   // какую дорожку выбрали руками — перенесём на следующие файлы
  subPref: null,     // то же для субтитров; null означает «выключены»
  cue: {             // оформление субтитров, всё в пределах того, что умеет ::cue
    size: localStorage.getItem('pip.cue.size') || 'm',
    bg:   localStorage.getItem('pip.cue.bg')   || 'shadow',
    pos:  localStorage.getItem('pip.cue.pos')  || 'auto',
  },
  pipWin: null, errStreak: 0, seq: 0,
  server: null,            // ответ /api/ping либо null
  seekPreview: null,       // показываемая позиция во время перемотки
  browserDir: null,
  pipMode: localStorage.getItem('nocturne.pipMode') || 'document',
};

const MEDIA_EXT = /\.(mp4|m4v|webm|ogv|ogm|mov|mkv|avi|ts|m2ts|mts|mpg|mpeg|3gp|flv|wmv|divx|mp3|m4a|m4b|aac|flac|wav|opus|oga)$/i;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const LANGS = {
  rus:'Русский', ru:'Русский', jpn:'Японский', ja:'Японский', jp:'Японский',
  eng:'Английский', en:'Английский', ukr:'Украинский', uk:'Украинский',
  chi:'Китайский', zho:'Китайский', kor:'Корейский', ger:'Немецкий', deu:'Немецкий',
  fre:'Французский', fra:'Французский', spa:'Испанский', ita:'Итальянский',
  pol:'Польский', por:'Португальский', tur:'Турецкий', ara:'Арабский', und:'',
};
const langName = c => LANGS[c] ?? (c ? c.toUpperCase() : '');
const channelsLabel = (n, layout) => n === 1 ? 'моно' : n === 2 ? 'стерео'
  : n === 6 ? '5.1' : n === 8 ? '7.1' : n ? n + ' кан.' : (layout || '');

/* ── мелочи ──────────────────────────────────────────────── */
function fmt(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  const p = n => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(x)}` : `${m}:${p(x)}`;
}
function fmtLong(s) {
  s = Math.floor(isFinite(s) ? s : 0);
  const p = n => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${p(Math.floor(s % 3600 / 60))}:${p(s % 60)}`;
}
const fmtSize = b => b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' ГБ' : Math.round(b / 1048576) + ' МБ';

let toastT;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl.classList.remove('show'), 3000);
}
const idxOf = it => state.list.indexOf(it);
/* вторая строка под названием: где файл лежит */
function folderOf(it) {
  const p = it.kind === 'server' ? it.path : (it.path || it.name);
  const dir = p.slice(0, p.lastIndexOf('/'));
  return dir || (it.kind === 'server' ? '' : 'выбран в браузере');
}
const cur = () => state.current;
const svg = d => `<svg viewBox="0 0 24 24">${d}</svg>`;

/* ── время ───────────────────────────────────────────────────
   Файл подготовлен целиком и раздаётся с поддержкой Range, поэтому
   позиция и длительность берутся прямо у video. Никаких смещений. */
const position = () => state.seekPreview != null ? state.seekPreview : video.currentTime;
function duration() {
  if (isFinite(video.duration) && video.duration > 0) return video.duration;
  const it = cur();
  return it && it.dur ? it.dur : 0;
}
function seekTo(t) {
  const d = duration();
  if (!d) return;
  state.seekPreview = null;
  video.currentTime = Math.max(0, Math.min(d - 0.3, t));
  paintSeek();
}

/* ── подготовка файла мостом ─────────────────────────────────
   Один проход ffmpeg на файл и дорожку, результат кладётся в кэш.
   Пока идёт — показываем прогресс. */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* полностью останавливаем текущее воспроизведение: не только пауза,
   но и снятие источника — иначе прошлая дорожка слышна за оверлеем */
function stopPlayback() {
  if (!video.getAttribute('src')) return;
  video.pause();
  video.removeAttribute('src');
  video.load();
}

/* Полосы прогресса тут нет намеренно: кодирование даёт проценты, а
   следующая за ним фаза faststart переписывает файл целиком и о своём
   продвижении не сообщает — полоса на ней замирала бы на 100 %.
   Показываем сами шаги и команду, которая исполняется. */
const PREP_STEPS = [
  { id: 'probe',    text: 'ffprobe — читаю дорожки и кодеки' },
  { id: 'convert',  text: 'ffmpeg — видео копирую, выбранную дорожку перекодирую в AAC' },
  { id: 'finalize', text: 'faststart — переношу индекс в начало файла' },
];

function trackLabel(it) {
  const t = (it.tracks || []).find(x => x.index === it.audioIndex);
  if (!t) return '';
  const lang = langName(t.lang), title = (t.title || '').trim();
  const head = lang && title ? `${lang} · ${title}` : lang || title || `дорожка ${t.order + 1}`;
  return [head, t.codec.toUpperCase(), channelsLabel(t.channels, t.layout)].filter(Boolean).join(' · ');
}

function showProgress(it, info) {
  closeMenus();
  prepName.textContent = it.name;
  const lab = trackLabel(it);
  prepTrack.textContent = lab ? 'Звуковая дорожка: ' + lab : '';

  const phase = info.phase || 'convert';
  const order = ['probe', 'convert', 'finalize'];
  const now = order.indexOf(phase);

  prepSteps.replaceChildren();
  PREP_STEPS.forEach((st, i) => {
    const done = i < now, active = i === now;
    const li = document.createElement('li');
    li.className = 'step' + (done ? ' step--done' : active ? ' step--active' : '');
    const mark = done ? '✓' : active ? '' : '';
    li.innerHTML = `<span class="step__mark">${mark}</span><span class="step__text"></span><span class="step__aux"></span>`;
    li.querySelector('.step__text').textContent = st.text;
    /* никаких процентов: faststart о своём продвижении не сообщает,
       и на нём любая цифра залипала бы. Показываем только время работы. */
    if (active && info.elapsed) li.querySelector('.step__aux').textContent = fmt(info.elapsed / 1000);
    prepSteps.append(li);
  });

  prepCmd.textContent = info.cmd || '';
  prep.classList.add('show');
}
const hideProgress = () => prep.classList.remove('show');

function prepareQuery(it) {
  const q = new URLSearchParams({ path: it.path });
  if (it.audioIndex != null) q.set('a', String(it.audioIndex));
  return q.toString();
}

async function ensureReady(it) {
  for (;;) {
    let r;
    try { r = await (await fetch('/api/prepare?' + prepareQuery(it))).json(); }
    catch (_) { hideProgress(); toast('Мост не отвечает'); return null; }

    if (r.duration) it.dur = r.duration;
    if (r.state === 'ready' || r.state === 'direct') { hideProgress(); return r; }
    if (r.state === 'error' || r.error) {
      hideProgress();
      it.err = true; render();
      toast('Не удалось подготовить: ' + it.name);
      return null;
    }
    stopPlayback();          // прошлая дорожка не должна доигрывать за оверлеем
    showProgress(it, r);
    await sleep(600);
    if (it !== cur()) { hideProgress(); return null; }
  }
}

/* следующий файл готовится, пока смотрим текущий */
function prefetchNext() {
  const nx = state.list[idxOf(cur()) + 1];
  if (nx && nx.kind === 'server') fetch('/api/prepare?' + prepareQuery(nx)).catch(() => {});
}

async function sourceFor(it) {
  if (it.kind === 'local') return it.url;
  /* дорожку выбираем ДО подготовки: иначе мост потратит целый проход
     на дорожку по умолчанию, а нужна перенесённая с прошлого файла */
  await probeItem(it);
  if (it.carried) {
    it.carried = false;
    const t = (it.tracks || []).find(x => x.index === it.audioIndex);
    if (t) toast('Дорожка как в прошлом файле: ' + (t.title || langName(t.lang)));
  }
  const r = await ensureReady(it);
  if (!r) return null;
  return r.state === 'direct'
    ? '/api/raw?path=' + encodeURIComponent(it.path)
    : '/api/media?key=' + r.key;
}

/* ═══════════════ добавление файлов ═══════════════ */
function addLocalFiles(files) {
  const ok = [];
  for (const f of files) {
    if (!f) continue;
    if (/^(video|audio)\//.test(f.type) || MEDIA_EXT.test(f.name)) ok.push(f);
  }
  if (!ok.length) { toast('Медиафайлов не найдено'); return; }
  ok.sort((a, b) => collator.compare(a.webkitRelativePath || a.name, b.webkitRelativePath || b.name));

  const wasEmpty = !state.list.length;
  for (const f of ok) {
    state.list.push({
      id: ++state.seq, kind: 'local', file: f, name: f.name,
      path: f.webkitRelativePath || f.name, url: URL.createObjectURL(f),
      size: f.size, dur: null, err: false, tracks: null, audioIndex: null,
    });
  }
  const added = state.list.slice(-ok.length);
  render(); probeLocal();
  toast(`Добавлено: ${ok.length}`);
  if (wasEmpty) playItem(state.list[0]);
  resolveOnDisk(added);            // в серверном режиме сразу отдаём мосту
}

function addServerFiles(entries) {
  if (!entries.length) { toast('В папке нет медиафайлов'); return; }
  const wasEmpty = !state.list.length;
  for (const e of entries) {
    state.list.push({
      id: ++state.seq, kind: 'server', name: e.name, path: e.path,
      size: e.size || 0, dur: null, err: false, tracks: null, audioIndex: null,
      subs: null, subIndex: undefined, probed: false,
    });
  }
  render(); probeServer();
  toast(`Добавлено: ${entries.length}`);
  if (wasEmpty) playItem(state.list[0]);
}

async function walkEntry(entry, out) {
  if (!entry) return;
  if (entry.isFile) await new Promise(r => entry.file(f => { out.push(f); r(); }, r));
  else if (entry.isDirectory) {
    const rd = entry.createReader();
    for (;;) {
      const batch = await new Promise(r => rd.readEntries(r, () => r([])));
      if (!batch.length) break;
      for (const e of batch) await walkEntry(e, out);
    }
  }
}

/* ── длительности локальных файлов ───────────────────────── */
let probingLocal = false;
function probeLocal() {
  if (probingLocal) return;
  const it = state.list.find(i => i.kind === 'local' && i.dur === null && !i.err);
  if (!it) return;
  probingLocal = true;
  const fin = () => { probingLocal = false; paintMeta(); probeLocal(); };
  prober.addEventListener('loadedmetadata', () => { it.dur = isFinite(prober.duration) ? prober.duration : 0; fin(); }, { once: true });
  prober.addEventListener('error', () => { it.dur = 0; fin(); }, { once: true });
  prober.src = it.url;
}

/* ── выбор дорожки переносится на следующие файлы ─────────────
   Сначала пробуем полное совпадение набора дорожек — у серий одного
   релиза он одинаков, тогда достаточно взять ту же по счёту. Дальше
   по языку с названием студии, потом просто по языку. */
const trackSig = ts => ts.map(t => `${t.lang}|${(t.title || '').trim()}|${t.codec}|${t.channels}`).join('/');
const same = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();

function rememberTrack(it, index) {
  const t = (it.tracks || []).find(x => x.index === index);
  if (!t) return;
  state.audioPref = { sig: trackSig(it.tracks), order: t.order, lang: t.lang, title: t.title };
}

function preferredTrack(it) {
  const p = state.audioPref;
  if (!p || !it.tracks || !it.tracks.length) return null;
  if (p.sig === trackSig(it.tracks) && it.tracks[p.order]) return it.tracks[p.order].index;
  const byBoth = it.tracks.find(t => same(t.lang, p.lang) && same(t.title, p.title));
  if (byBoth) return byBoth.index;
  const byLang = it.tracks.find(t => same(t.lang, p.lang));
  return byLang ? byLang.index : null;
}

/* ── ffprobe для серверных файлов ────────────────────────── */
async function probeItem(it) {
  if (it.probed) return;
  try {
    const r = await fetch('/api/probe?path=' + encodeURIComponent(it.path));
    if (r.ok) {
      const info = await r.json();
      it.dur = info.duration;
      it.tracks = info.audio;
      it.defaultAudio = info.defaultAudio;
      it.videoCodec = info.video ? info.video.codec : null;
      it.subs = info.subs || [];
      if (it.subIndex === undefined) it.subIndex = preferredSub(it);
      if (it.audioIndex == null) {
        const want = preferredTrack(it);
        it.audioIndex = want != null ? want : info.defaultAudio;
        it.carried = want != null && want !== info.defaultAudio;
      }
    }
  } catch (_) { /* сервер мог уйти — не страшно */ }
  it.probed = true;
}

let probingServer = false;
async function probeServer() {
  if (probingServer) return;
  const it = state.list.find(i => i.kind === 'server' && !i.probed);
  if (!it) return;
  probingServer = true;
  await probeItem(it);
  probingServer = false;
  paintMeta();
  if (it === cur()) { syncAudioButton(); syncSubsButton(); }
  probeServer();
}

function setSrc(it, src) {
  const playing = !video.paused;
  it.loadedSrc = src;
  video.src = src;
  video.load();
  if (playing) video.play().catch(() => {});
}

/* ═══════════════ передача локальных файлов мосту ═══════════════
   Браузер не даёт абсолютный путь перетащенного файла. Просим сервер
   найти его по имени и размеру, а остальные файлы пачки подбираем из
   того же каталога — так хватает одного-двух запросов на всю папку. */
async function resolveOnDisk(items, { loud } = {}) {
  if (!state.server || !state.server.ffmpeg) return 0;
  const pending = items.filter(i => i.kind === 'local');
  if (!pending.length) return 0;

  if (loud) toast('Ищу файлы на диске…');
  let found = 0;

  try {
    const probe = pending[0];
    const r = await fetch(`/api/find?name=${encodeURIComponent(probe.name)}&size=${probe.size || ''}`);
    const hit = r.ok ? (await r.json()).matches[0] : null;
    if (!hit) { if (loud) toast('Не нашёл этот файл в доступных каталогах'); return 0; }

    upgradeItem(probe, hit);
    found++;

    if (pending.length > 1) {
      const ls = await fetch('/api/ls?path=' + encodeURIComponent(hit.dir));
      const dir = ls.ok ? await ls.json() : null;
      if (dir && dir.files) {
        const byName = new Map(dir.files.map(f => [f.name, f]));
        for (const it of pending.slice(1)) {
          const m = byName.get(it.name);
          if (m) { upgradeItem(it, m); found++; }
        }
      }
    }
  } catch (_) { if (loud) toast('Мост не ответил'); return found; }

  if (found) {
    render();
    const c = cur();
    if (c && c.kind === 'server') switchTrack(c);   // тот же момент, но уже через мост
    probeServer();
    hideNotice();
    toast(found === 1 ? 'Файл передан мосту — звук перекодируется'
                      : `Мосту передано файлов: ${found}`);
  } else if (loud) toast('Совпадений на диске нет');
  return found;
}

function upgradeItem(it, hit) {
  if (it.url) { URL.revokeObjectURL(it.url); it.url = null; }
  it.kind = 'server';
  it.path = hit.path;
  it.size = hit.size || it.size;
  it.probed = false;
  it.audioIndex = null;
  it.err = false;
  it.file = null;
  it.loadedSrc = null;
}

/* ═══════════════ воспроизведение ═══════════════ */
let playToken = 0;

async function playItem(it, autoplay = true) {
  if (!it) return;
  state.current = it;
  state.seekPreview = null;
  hideNotice();
  endCard.classList.remove('show');
  emptyEl.classList.add('hide');
  stage.classList.remove('empty');

  titleName.textContent = it.name;
  titlePath.textContent = folderOf(it);
  ghostName.textContent = it.name;
  if (state.pipWin) state.pipWin.document.title = it.name;
  render(); syncAudioButton(); syncStatus(); mediaMeta(it); poke();

  const token = ++playToken;
  const src = await sourceFor(it);
  if (token !== playToken || it !== cur() || !src) return;

  it.loadedSrc = src;
  video.src = src;
  video.load();
  if (autoplay) video.play().catch(() => toast('Нажмите play — браузер ждёт действия'));
  syncAudioButton(); syncSubsButton(); applySubs(it);
  armAudioCheck(); prefetchNext();
}

/* смена дорожки: другой подготовленный файл, но то же место просмотра */
async function switchTrack(it) {
  const at = video.currentTime, playing = !video.paused;
  const token = ++playToken;
  const src = await sourceFor(it);
  if (token !== playToken || it !== cur() || !src) return;
  it.loadedSrc = src;
  video.src = src;
  video.load();
  video.addEventListener('loadedmetadata', () => { video.currentTime = at; }, { once: true });
  if (playing) video.play().catch(() => {});
  syncAudioButton(); syncSubsButton(); applySubs(it);
}

function next(auto = false) {
  const i = idxOf(cur());
  if (i < 0) { if (state.list.length) playItem(state.list[0]); return; }
  /* повтор одного файла срабатывает только сам по себе:
     кнопкой «дальше» пользователь всё равно уходит на следующий */
  if (auto && state.loop === 'one') { video.currentTime = 0; video.play().catch(() => {}); return; }
  if (i + 1 < state.list.length) return playItem(state.list[i + 1]);
  if (state.loop === 'queue' && state.list.length) return playItem(state.list[0]);
  if (auto) endOfQueue(); else toast('Это последний файл');
}
function prev() {
  const i = idxOf(cur());
  if (position() > 3) return seekTo(0);
  if (i > 0) playItem(state.list[i - 1]);
  else if (state.loop === 'queue' && state.list.length) playItem(state.list[state.list.length - 1]);
  else seekTo(0);
}
function endOfQueue() {
  video.pause();
  const total = state.list.reduce((a, b) => a + (b.dur || 0), 0);
  endMeta.textContent = `${state.list.length} ${plural(state.list.length, 'файл', 'файла', 'файлов')} · ${fmtLong(total)}`;
  endCard.classList.add('show');
  stage.classList.remove('idle');
}
function plural(n, a, b, c) {
  const m = n % 100, k = n % 10;
  if (m > 10 && m < 20) return c;
  if (k === 1) return a;
  if (k >= 2 && k <= 4) return b;
  return c;
}
function togglePlay() {
  if (!cur()) { if (state.list.length) playItem(state.list[0]); return; }
  if (endCard.classList.contains('show')) return playItem(state.list[0]);
  if (video.paused) video.play().catch(() => {}); else video.pause();
}
function nudge(sec) {
  if (!duration()) return;
  seekTo(position() + sec);
  flash((sec > 0 ? '+' : '−') + Math.abs(sec) + ' с');
}

let flashT;
function flash(t) {
  flashEl.textContent = t;
  flashEl.classList.add('go');
  clearTimeout(flashT);
  flashT = setTimeout(() => flashEl.classList.remove('go'), 520);
}
function pulse(playing) {
  pulseIcon.innerHTML = playing ? '<path d="M8 5.5v13l10-6.5z"/>' : '<path d="M8 5h3.2v14H8zM12.8 5H16v14h-3.2z"/>';
  pulseEl.classList.remove('go'); void pulseEl.offsetWidth; pulseEl.classList.add('go');
}

/* ── автоскрытие панели ──────────────────────────────────── */
let hideT, overDeck = false;
function poke() {
  stage.classList.remove('idle', 'cursor-hidden');
  clearTimeout(hideT);
  hideT = setTimeout(() => {
    if (video.paused || overDeck || endCard.classList.contains('show')) return;
    if (anyMenuOpen()) return;
    stage.classList.add('idle', 'cursor-hidden');
  }, 2600);
}
stage.addEventListener('pointermove', poke);
deck.addEventListener('pointerenter', () => { overDeck = true; });
deck.addEventListener('pointerleave', () => { overDeck = false; poke(); });

let clickT = null, justClosedQueue = 0;
video.addEventListener('click', e => {
  e.preventDefault();
  /* открытая очередь закрывается первым же кликом по кадру — сразу,
     без ожидания двойного, и не трогая воспроизведение */
  if (state.queueOpen && !state.pipWin) {
    clearTimeout(clickT); clickT = null;
    justClosedQueue = Date.now();
    toggleQueue(false);
    return;
  }
  if (state.pipWin) return togglePlay();
  if (clickT) return;
  clickT = setTimeout(() => { clickT = null; togglePlay(); }, 200);
});
video.addEventListener('dblclick', e => {
  e.preventDefault(); clearTimeout(clickT); clickT = null;
  if (Date.now() - justClosedQueue < 400) return;   // второй клик закрытия — не полный экран
  if (!state.pipWin) toggleFull();
});

/* ── слайдеры ────────────────────────────────────────────── */
function bindSlider(el, { onInput, onCommit, onHover }) {
  let dragging = false;
  const ratio = e => {
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1)));
  };
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    dragging = true; el.classList.add('dragging');
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    onInput(ratio(e)); e.preventDefault();
  });
  el.addEventListener('pointermove', e => {
    if (onHover) onHover(ratio(e));
    if (dragging) onInput(ratio(e));
  });
  const up = e => {
    if (!dragging) return;
    dragging = false; el.classList.remove('dragging');
    try { el.releasePointerCapture(e.pointerId); } catch (_) {}
    if (onCommit) onCommit(ratio(e));
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

bindSlider(seek, {
  onInput: r => { state.seekPreview = r * duration(); paintSeek(); },
  onCommit: r => seekTo(r * duration()),
  onHover: r => { seekTip.textContent = fmt(r * duration()); seekTip.style.left = r * 100 + '%'; },
});
seek.addEventListener('keydown', e => {
  const step = { ArrowLeft: -5, ArrowRight: 5, PageDown: -60, PageUp: 60 }[e.key];
  if (step != null) { e.preventDefault(); e.stopPropagation(); nudge(e.shiftKey ? step / 5 : step); }
  if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); seekTo(0); }
  if (e.key === 'End') { e.preventDefault(); e.stopPropagation(); seekTo(duration() - 2); }
});

bindSlider(volBar, {
  onInput: r => { video.volume = r; video.muted = r === 0; },
});
volBar.addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); video.volume = Math.max(0, video.volume - .05); }
  if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); video.volume = Math.min(1, video.volume + .05); }
});

function paintSeek() {
  const d = duration(), p = d ? position() / d * 100 : 0;
  seekFill.style.width = p + '%';
  seekKnob.style.left = p + '%';
  seek.setAttribute('aria-valuenow', Math.round(p));
  seek.setAttribute('aria-valuetext', fmt(position()) + ' из ' + fmt(d));
  tCur.textContent = fmt(position());
  tDur.textContent = fmt(d);
  try {
    if (video.buffered.length && d) {
      seekBuffer.style.width = Math.min(100, video.buffered.end(video.buffered.length - 1) / d * 100) + '%';
    }
  } catch (_) {}
}
function paintVolume() {
  const v = video.muted ? 0 : video.volume;
  volFill.style.width = v * 100 + '%';
  volIcon.innerHTML = v === 0
    ? '<path d="M4 9h3.5L12 5.5v13L7.5 15H4z"/><path d="M16 10l4 4M20 10l-4 4"/>'
    : v < .5
      ? '<path d="M4 9h3.5L12 5.5v13L7.5 15H4z"/><path d="M15.5 9.5a4 4 0 010 5"/>'
      : '<path d="M4 9h3.5L12 5.5v13L7.5 15H4z"/><path d="M15.5 9.5a4 4 0 010 5M18.5 6.5a8 8 0 010 11"/>';
}

/* ═══════════════ звуковые дорожки ═══════════════ */
function audioOptions() {
  const it = cur();
  if (!it) return [];
  if (it.kind === 'server' && it.tracks && it.tracks.length) {
    return it.tracks.map(t => {
      const lang = langName(t.lang);
      const title = (t.title || '').trim();
      /* Названия студий и есть то, чем отличаются несколько русских
         озвучек, поэтому они идут в первую строку рядом с языком. */
      const main = lang && title ? `${lang} · ${title}`
                 : lang || title || `Дорожка ${t.order + 1}`;
      const sub = [
        `#${t.order + 1}`,
        t.codec.toUpperCase(),
        channelsLabel(t.channels, t.layout),
        t.bitrate ? Math.round(t.bitrate / 1000) + ' кбит/с' : '',
        t.sampleRate ? +(t.sampleRate / 1000).toFixed(1) + ' кГц' : '',
        t.default ? 'по умолчанию' : '',
        t.forced ? 'форсированная' : '',
        t.comment ? 'комментарии' : '',
      ].filter(Boolean).join(' · ');
      return { id: t.index, main, sub, short: title || lang || `#${t.order + 1}`, sel: t.index === it.audioIndex };
    });
  }
  const nat = video.audioTracks;
  if (nat && nat.length) {
    const out = [];
    for (let i = 0; i < nat.length; i++) {
      out.push({
        id: i, native: true,
        main: langName(nat[i].language) || nat[i].label || `Дорожка ${i + 1}`,
        sub: nat[i].label || '',
        sel: nat[i].enabled,
      });
    }
    return out;
  }
  return [];
}

function syncAudioButton() {
  const opts = audioOptions();
  btnAudio.hidden = opts.length < 2;
  const sel = opts.find(o => o.sel);
  audioLabel.textContent = sel ? (sel.short || sel.main) : 'Дорожка';
  btnAudio.title = sel ? 'Дорожка: ' + sel.main : 'Звуковая дорожка';
  if (opts.length < 2) audioMenu.classList.remove('open');
}

function buildAudioMenu() {
  const opts = audioOptions();
  audioMenu.replaceChildren();
  const head = document.createElement('div');
  head.className = 'menu__title';
  head.textContent = 'Звуковая дорожка';
  audioMenu.append(head);

  if (!opts.length) {
    const e = document.createElement('div');
    e.className = 'menu__empty';
    e.textContent = state.server
      ? 'В этом файле одна дорожка.'
      : 'Список дорожек доступен только в серверном режиме.';
    audioMenu.append(e);
    return;
  }

  for (const o of opts) {
    const b = document.createElement('button');
    b.className = 'menu__item' + (o.sel ? ' sel' : '');
    b.innerHTML = `<span class="menu__tick">${svg('<path d="M5 12.5l4.5 4.5L19 7"/>')}</span>
      <span class="menu__body"><span class="menu__main"></span>${o.sub ? '<span class="menu__sub"></span>' : ''}</span>`;
    b.querySelector('.menu__main').textContent = o.main;
    if (o.sub) b.querySelector('.menu__sub').textContent = o.sub;
    b.onclick = () => { pickAudio(o); audioMenu.classList.remove('open'); };
    audioMenu.append(b);
  }
}

function pickAudio(opt) {
  const it = cur();
  if (!it) return;
  if (opt.native) {
    const nat = video.audioTracks;
    for (let i = 0; i < nat.length; i++) nat[i].enabled = i === opt.id;
    syncAudioButton();
    toast('Дорожка: ' + opt.main);
    return;
  }
  if (it.audioIndex === opt.id) return;
  it.audioIndex = opt.id;
  rememberTrack(it, opt.id);
  hideNotice();
  toast('Дорожка: ' + opt.main);
  switchTrack(it);
}

/* ═══════════════ субтитры ═══════════════
   Дорожки субтитров живут в файле отдельно от звуковых и с ними никак
   не связаны: язык озвучки и язык субтитров выбираются независимо.
   Браузер понимает только WebVTT, поэтому мост перегоняет текстовую
   дорожку в него. Растровые (PGS, VOBSUB) в текст не превращаются. */
function subOptions() {
  const it = cur();
  if (!it || it.kind !== 'server' || !it.subs) return [];
  return it.subs.map(t => {
    const lang = langName(t.lang);
    const title = (t.title || '').trim();
    const main = lang && title ? `${lang} · ${title}`
               : lang || title || `Дорожка ${t.order + 1}`;
    const bits = [`#${t.order + 1}`, t.codec.toUpperCase()];
    if (t.forced) bits.push('форсированные');
    if (t.default) bits.push('по умолчанию');
    if (!t.text) bits.push('растровые — браузер не покажет');
    return { id: t.index, main, sub: bits.join(' · '), text: t.text, sel: t.index === it.subIndex };
  });
}

function syncSubsButton() {
  const opts = subOptions();
  btnSubs.hidden = !opts.length;
  const on = cur() && cur().subIndex != null;
  btnSubs.classList.toggle('on', !!on);
  const sel = opts.find(o => o.sel);
  btnSubs.title = sel ? 'Субтитры: ' + sel.main : 'Субтитры выключены';
  if (!opts.length) subsMenu.classList.remove('open');
}

function buildSubsMenu() {
  const opts = subOptions();
  subsMenu.replaceChildren();
  const head = document.createElement('div');
  head.className = 'menu__title';
  head.textContent = 'Субтитры';
  subsMenu.append(head);

  if (!opts.length) {
    const e = document.createElement('div');
    e.className = 'menu__empty';
    e.textContent = state.server ? 'В этом файле нет субтитров.'
                                 : 'Субтитры доступны только в серверном режиме.';
    subsMenu.append(e);
    return;
  }

  const row = (main, sub, sel, off, disabled) => {
    const b = document.createElement('button');
    b.className = 'menu__item' + (sel ? ' sel' : '');
    b.disabled = !!disabled;
    b.innerHTML = `<span class="menu__tick">${svg('<path d="M5 12.5l4.5 4.5L19 7"/>')}</span>
      <span class="menu__body"><span class="menu__main"></span>${sub ? '<span class="menu__sub"></span>' : ''}</span>`;
    b.querySelector('.menu__main').textContent = main;
    if (sub) b.querySelector('.menu__sub').textContent = sub;
    b.onclick = () => { if (!disabled) { pickSub(off); subsMenu.classList.remove('open'); } };
    subsMenu.append(b);
  };

  row('Выключены', '', cur().subIndex == null, null, false);
  for (const o of opts) row(o.main, o.sub, o.sel, o, !o.text);
  if (opts.some(o => o.text)) appendCueControls();
}

function pickSub(opt) {
  const it = cur();
  if (!it) return;
  it.subIndex = opt ? opt.id : null;
  state.subPref = opt ? { sig: subSig(it.subs), order: (it.subs.find(x => x.index === opt.id) || {}).order,
                          lang: (it.subs.find(x => x.index === opt.id) || {}).lang,
                          title: (it.subs.find(x => x.index === opt.id) || {}).title }
                      : null;
  applySubs(it);
  syncSubsButton();
  toast(opt ? 'Субтитры: ' + opt.main : 'Субтитры выключены');
}

const subSig = ts => (ts || []).map(t => `${t.lang}|${(t.title || '').trim()}|${t.codec}`).join('/');

function preferredSub(it) {
  const p = state.subPref;
  if (!p || !it.subs || !it.subs.length) return null;
  const text = it.subs.filter(t => t.text);
  if (!text.length) return null;
  if (p.sig === subSig(it.subs) && it.subs[p.order] && it.subs[p.order].text) return it.subs[p.order].index;
  const byBoth = text.find(t => same(t.lang, p.lang) && same(t.title, p.title));
  if (byBoth) return byBoth.index;
  const byLang = text.find(t => same(t.lang, p.lang));
  return byLang ? byLang.index : null;
}

/* дорожка подключается к video отдельным элементом track */
async function applySubs(it) {
  video.querySelectorAll('track').forEach(t => t.remove());
  if (!it || it.subIndex == null || it.kind !== 'server') return;

  const url = `/api/subs?path=${encodeURIComponent(it.path)}&s=${it.subIndex}`;
  try {
    /* тянем заранее, чтобы поймать ошибку и показать её, а не молчать */
    const r = await fetch(url);
    if (!r.ok) { toast('Не удалось извлечь субтитры'); it.subIndex = null; syncSubsButton(); return; }
  } catch (_) { return; }
  if (it !== cur() || it.subIndex == null) return;

  const t = document.createElement('track');
  t.kind = 'subtitles';
  t.src = url;
  t.default = true;
  video.append(t);
  /* включаем после того, как браузер разберёт файл */
  t.addEventListener('load', () => {
    if (t.track) t.track.mode = 'showing';
    applyCueLine();
  }, { once: true });
  setTimeout(() => { if (t.track) { t.track.mode = 'showing'; applyCueLine(); } }, 200);
}

/* Что реально поддаётся управлению у WebVTT: размер, подложка и высота
   строки. Всё остальное (шрифт реплики, позиция по горизонтали, стили
   ASS) задаётся самим файлом и браузером не отдаётся. */
const CUE_SIZE = { s: '80%',  m: '100%', l: '128%', xl: '160%' };
const CUE_BG = {
  none:   { bg: 'transparent', sh: 'none' },
  shadow: { bg: 'transparent', sh: '0 1px 3px #000, 0 0 6px rgba(0,0,0,.95), 0 0 1px #000' },
  plate:  { bg: 'rgba(0,0,0,.72)', sh: 'none' },
};
const CUE_POS = { low: -1, auto: 'auto', high: -4 };

const CUE_UI = [
  { key: 'size', label: 'Размер',    opts: [['s','S'], ['m','M'], ['l','L'], ['xl','XL']] },
  { key: 'bg',   label: 'Подложка',  opts: [['none','Нет'], ['shadow','Тень'], ['plate','Плашка']] },
  { key: 'pos',  label: 'Положение', opts: [['low','Ниже'], ['auto','Обычно'], ['high','Выше']] },
];

function applyCueStyle() {
  const c = state.cue, b = CUE_BG[c.bg] || CUE_BG.shadow;
  /* переменные ставим на сам video: он переезжает в окно PiP вместе
     со сценой, а переменные документа туда бы не попали */
  video.style.setProperty('--cue-size', CUE_SIZE[c.size] || '100%');
  video.style.setProperty('--cue-bg', b.bg);
  video.style.setProperty('--cue-shadow', b.sh);
  applyCueLine();
}

function applyCueLine() {
  const v = CUE_POS[state.cue.pos];
  for (const tr of video.textTracks || []) {
    if (!tr.cues) continue;
    for (const cue of tr.cues) { try { cue.line = v; } catch (_) {} }
  }
}

function setCue(key, val) {
  state.cue[key] = val;
  localStorage.setItem('pip.cue.' + key, val);
  applyCueStyle();
  buildSubsMenu();
}

function appendCueControls() {
  const sep = document.createElement('div');
  sep.className = 'menu__sep';
  subsMenu.append(sep);

  const head = document.createElement('div');
  head.className = 'menu__title';
  head.textContent = 'Оформление';
  subsMenu.append(head);

  for (const row of CUE_UI) {
    const line = document.createElement('div');
    line.className = 'menu__row';
    const lab = document.createElement('span');
    lab.textContent = row.label;
    const group = document.createElement('div');
    group.className = 'seg2';
    for (const [val, text] of row.opts) {
      const b = document.createElement('button');
      b.textContent = text;
      b.className = state.cue[row.key] === val ? 'sel' : '';
      b.onclick = ev => { ev.stopPropagation(); setCue(row.key, val); };
      group.append(b);
    }
    line.append(lab, group);
    subsMenu.append(line);
  }
}

btnSubs.onclick = e => {
  e.stopPropagation();
  buildSubsMenu();
  closeMenus(subsMenu);
  subsMenu.classList.toggle('open');
};

function closeMenus(except) {
  for (const m of [audioMenu, pipMenu, rateMenu, subsMenu]) if (m && m !== except) m.classList.remove('open');
}
function anyMenuOpen() {
  return [audioMenu, pipMenu, rateMenu, subsMenu].some(m => m && m.classList.contains('open'));
}
btnAudio.onclick = e => {
  e.stopPropagation();
  buildAudioMenu();
  closeMenus(audioMenu);
  audioMenu.classList.toggle('open');
};
document.addEventListener('click', e => { if (!e.target.closest('.menuwrap')) closeMenus(); });

/* ── диагностика «нет звука» ─────────────────────────────── */
let audioCheckT;
function armAudioCheck() {
  clearTimeout(audioCheckT);
  audioCheckT = setTimeout(() => {
    const it = cur();
    if (!it || video.paused) return;
    const decoded = video.webkitAudioDecodedByteCount;
    if (decoded === undefined || decoded > 0) return;
    if (it.kind === 'server') return;   // мост уже перекодировал звук
    showNotice(
      state.server && state.server.ffmpeg && it.kind === 'local'
        ? 'Файл играется напрямую, минуя мост, — звук AC-3 браузер не осилит.'
        : state.server
          ? 'Браузер не смог декодировать звук. Попробуйте выбрать другую дорожку.'
          : 'Звук не декодируется — обычно это AC-3 или DTS внутри MKV.');
  }, 3500);
}
function showNotice(text) {
  noticeText.textContent = text;
  const canBridge = state.server && state.server.ffmpeg && cur() && cur().kind === 'local';
  $('#noticeAction').textContent = canBridge ? 'Обработать через сервер' : 'Как починить';
  notice.classList.add('show');
}
function hideNotice() { notice.classList.remove('show'); clearTimeout(audioCheckT); }
$('#noticeClose').onclick = hideNotice;
$('#noticeAction').onclick = () => {
  const it = cur();
  if (state.server && state.server.ffmpeg && it && it.kind === 'local') resolveOnDisk([it], { loud: true });
  else helpModal.classList.add('open');
};

/* ═══════════════ очередь ═══════════════ */
function render() {
  queueFiles.textContent = `${state.list.length} ${plural(state.list.length, 'файл', 'файла', 'файлов')}`;

  if (!state.list.length) {
    queueList.innerHTML = '<li class="queue__empty">Очередь пуста.<br>Перетащите файлы или папку.</li>';
    queueTotal.textContent = '0:00:00';
    stage.classList.add('empty');
    emptyEl.classList.remove('hide');
    syncStatus();
    return;
  }
  stage.classList.remove('empty');

  const frag = document.createDocumentFragment();
  state.list.forEach(it => {
    const li = document.createElement('li');
    li.className = 'item' + (it === cur() ? ' active' : '') + (it.err ? ' bad' : '');
    if (it === cur() && !video.paused) li.classList.add('playing');
    li.draggable = true;
    li.dataset.id = it.id;
    li.innerHTML =
      `<span class="item__grip">${svg('<path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" stroke-width="2.4"/>')}</span>` +
      `<span class="item__eq"><i></i><i></i><i></i></span>` +
      `<span class="item__body"><span class="item__name"></span><span class="item__meta"></span></span>` +
      `<span class="item__x" title="Убрать">${svg('<path d="M7 7l10 10M17 7L7 17"/>')}</span>`;
    li.querySelector('.item__name').textContent = it.name;
    frag.append(li);
  });
  queueList.replaceChildren(frag);
  paintMeta();
  const active = queueList.querySelector('.item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function paintMeta() {
  queueTotal.textContent = fmtLong(state.list.reduce((a, b) => a + (b.dur || 0), 0));
  for (const li of queueList.children) {
    const it = state.list.find(x => String(x.id) === li.dataset.id);
    const box = it && li.querySelector('.item__meta');
    if (!box) continue;
    /* первые два столбца фиксированной ширины, чтобы строки выстраивались */
    const fixed =
      `<span class="item__m item__m--dur">${it.dur ? fmt(it.dur) : '—'}</span>` +
      `<span class="item__m item__m--size">${it.size ? fmtSize(it.size) : '—'}</span>`;

    const rest = [];
    if (it.err) rest.push('<b>формат не поддержан</b>');
    if (it.kind === 'server' && it.tracks) {
      rest.push(it.tracks.length > 1
        ? `${it.tracks.length} ${plural(it.tracks.length, 'дорожка', 'дорожки', 'дорожек')}`
        : (it.tracks[0] ? it.tracks[0].codec.toUpperCase() : ''));
    }
    if (state.server && state.server.ffmpeg) {
      rest.push(it.kind === 'server'
        ? '<b class="route">через мост</b>'
        : '<span class="route route--off">напрямую</span>');
    }
    box.innerHTML = fixed + rest.filter(Boolean).map(b => `<span>${b}</span>`).join('');
  }
}

queueList.addEventListener('click', e => {
  const li = e.target.closest('.item');
  if (!li) return;
  const it = state.list.find(x => String(x.id) === li.dataset.id);
  if (!it) return;
  if (e.target.closest('.item__x')) return removeItem(it);
  playItem(it);
});

function removeItem(it) {
  const i = idxOf(it), wasCurrent = it === cur();
  if (it.url) URL.revokeObjectURL(it.url);
  state.list.splice(i, 1);
  if (wasCurrent) {
    const nx = state.list[i] || state.list[i - 1] || null;
    if (nx) playItem(nx);
    else { state.current = null; playToken++; hideProgress();
           video.pause(); video.removeAttribute('src'); video.load(); }
  }
  render();
}

/* ═══════════════ перетаскивание внутри списка ═══════════════
   Позиция вставки считается геометрически, по координате курсора
   относительно середин строк. Через e.target это работало рвано:
   под курсором мог оказаться вложенный span или зазор списка, и тогда
   метка пропадала, а при отпускании файл улетал в конец.

   Перетаскиваемая строка сразу переезжает в вычисленное место и служит
   слотом, а соседи доезжают анимацией FLIP: замеряем положение до
   перестановки, после неё компенсируем сдвиг трансформом и снимаем его. */
let dragEl = null;

function flipMove(mutate) {
  const kids = [...queueList.children];
  const before = new Map(kids.map(k => [k, k.getBoundingClientRect().top]));
  mutate();
  for (const k of queueList.children) {
    const was = before.get(k);
    if (was == null) continue;
    const delta = was - k.getBoundingClientRect().top;
    if (!delta) continue;
    k.style.transition = 'none';
    k.style.transform = `translateY(${delta}px)`;
  }
  requestAnimationFrame(() => {
    for (const k of queueList.children) {
      if (!k.style.transform) continue;
      k.style.transition = 'transform 240ms cubic-bezier(.22,.8,.24,1)';
      k.style.transform = '';
    }
  });
}

/* строка, ПЕРЕД которой встанет перетаскиваемая; null — в самый конец */
function insertionRef(y) {
  for (const li of queueList.querySelectorAll('.item:not(.dragging)')) {
    const r = li.getBoundingClientRect();
    if (y < r.top + r.height / 2) return li;
  }
  return null;
}

queueList.addEventListener('dragstart', e => {
  const li = e.target.closest('.item');
  if (!li) return;
  dragEl = li;
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', li.dataset.id); } catch (_) {}
  /* класс вешаем следующим кадром: иначе браузер снимет с изменённой
     строки картинку перетаскивания и она будет полупрозрачной */
  requestAnimationFrame(() => li.classList.add('dragging'));
});

queueList.addEventListener('dragover', e => {
  if (!dragEl) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const ref = insertionRef(e.clientY);
  if (ref === dragEl || ref === dragEl.nextElementSibling) return;   // уже на месте
  flipMove(() => queueList.insertBefore(dragEl, ref));
});

function commitDrag() {
  if (!dragEl) return;
  dragEl.classList.remove('dragging');
  dragEl = null;
  for (const k of queueList.children) { k.style.transition = ''; k.style.transform = ''; }

  /* порядок берём из разметки — она уже переставлена */
  const at = new Map([...queueList.children].map((li, i) => [li.dataset.id, i]));
  state.list.sort((x, y) => at.get(String(x.id)) - at.get(String(y.id)));
  paintMeta();   // без render(), иначе анимация оборвётся пересборкой строк
}

queueList.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); commitDrag(); });
queueList.addEventListener('dragend', commitDrag);

$('#btnSort').onclick = () => { state.list.sort((a, b) => collator.compare(a.path, b.path)); render(); toast('Отсортировано по имени'); };
$('#btnReverse').onclick = () => { state.list.reverse(); render(); toast('Порядок обращён'); };
$('#btnShuffle').onclick = () => {
  for (let i = state.list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [state.list[i], state.list[j]] = [state.list[j], state.list[i]];
  }
  render(); toast('Перемешано');
};
$('#btnClear').onclick = () => {
  state.list.forEach(i => i.url && URL.revokeObjectURL(i.url));
  state.list = []; state.current = null;
  video.pause(); video.removeAttribute('src'); video.load();
  endCard.classList.remove('show'); hideNotice(); hideProgress(); render();
};

function toggleQueue(force) {
  state.queueOpen = force === undefined ? !state.queueOpen : force;
  workspace.classList.toggle('queue-open', state.queueOpen);
  btnList.classList.toggle('on', state.queueOpen);
}
btnList.onclick = () => toggleQueue();
$('#btnQueueClose').onclick = () => toggleQueue(false);
toggleQueue(true);

/* ═══════════════ полный экран ═══════════════ */
const isFull = () => !!document.fullscreenElement;
async function toggleFull() {
  if (state.pipWin) return toast('Сначала закройте окно PiP');
  try {
    if (isFull()) await document.exitFullscreen();
    else await workspace.requestFullscreen({ navigationUI: 'hide' });
  } catch (_) { toast('Полный экран недоступен'); }
}
btnFull.onclick = toggleFull;
document.addEventListener('fullscreenchange', () => { btnFull.classList.toggle('on', isFull()); poke(); });

/* ═══════════════ picture-in-picture ═══════════════ */
const hasDocPip = 'documentPictureInPicture' in window;

async function nativePip() {
  if (!document.pictureInPictureEnabled || video.disablePictureInPicture) {
    toast('Браузер не поддерживает PiP'); return;
  }
  try { await video.requestPictureInPicture(); }
  catch (_) { toast('Браузер отклонил PiP'); }
}

async function togglePip() {
  if (state.pipWin) return state.pipWin.close();
  if (document.pictureInPictureElement) { try { await document.exitPictureInPicture(); } catch (_) {} return; }
  if (!cur()) return toast('Сначала выберите файл');

  /* Компактный режим — окно без полосы с адресом, но с контролами браузера.
     Полосу в расширенном режиме скрыть нельзя: это интерфейс самого Chrome. */
  if (state.pipMode === 'native') return nativePip();

  if (hasDocPip) { try { return await openDocPip(); } catch (err) { console.warn(err); } }
  return nativePip();
}

const PIP_MODES = [
  { id: 'document', main: 'Расширенный', sub: 'Свои контролы, но сверху полоса с адресом сайта' },
  { id: 'native',   main: 'Браузерный',  sub: 'Без полосы с адресом, контролы браузера' },
];

function buildPipMenu() {
  pipMenu.replaceChildren();
  const head = document.createElement('div');
  head.className = 'menu__title';
  head.textContent = 'Режим «картинка в картинке»';
  pipMenu.append(head);

  for (const m of PIP_MODES) {
    const disabled = m.id === 'document' && !hasDocPip;
    const b = document.createElement('button');
    b.className = 'menu__item' + (state.pipMode === m.id ? ' sel' : '');
    b.disabled = disabled;
    b.innerHTML = `<span class="menu__tick">${svg('<path d="M5 12.5l4.5 4.5L19 7"/>')}</span>
      <span class="menu__body"><span class="menu__main"></span><span class="menu__sub"></span></span>`;
    b.querySelector('.menu__main').textContent = m.main;
    b.querySelector('.menu__sub').textContent = disabled ? 'Нужен Chrome или Edge 116+' : m.sub;
    b.onclick = () => {
      if (disabled) return;
      state.pipMode = m.id;
      localStorage.setItem('nocturne.pipMode', m.id);
      pipMenu.classList.remove('open');
      toast('Режим PiP: ' + m.main.toLowerCase());
      if (state.pipWin) state.pipWin.close();
      else if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    };
    pipMenu.append(b);
  }
}

btnPipMode.onclick = e => {
  e.stopPropagation();
  buildPipMenu();
  closeMenus(pipMenu);
  pipMenu.classList.toggle('open');
};

async function openDocPip() {
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const w = 520, h = Math.max(200, Math.round(w * vh / vw));
  const win = await window.documentPictureInPicture.requestWindow({ width: w, height: h });
  state.pipWin = win;

  const boot = win.document.createElement('style');
  boot.textContent = 'html,body{margin:0;background:#000;overflow:hidden}';
  win.document.head.append(boot);
  document.querySelectorAll('link[rel="stylesheet"]').forEach(l => {
    const c = win.document.createElement('link');
    c.rel = 'stylesheet'; c.href = l.href;
    win.document.head.append(c);
  });

  win.document.title = cur() ? cur().name : 'PIP Player';
  win.document.body.classList.add('pip-body');
  stage.classList.add('pip-mode');
  stage.classList.remove('idle');
  win.document.body.append(stage);
  stageHost.classList.add('is-pip');
  pipSeg.classList.add('on');
  win.document.addEventListener('keydown', onKey);
  win.document.addEventListener('click', e => { if (!e.target.closest('.menuwrap')) closeMenus(); });
  win.addEventListener('pagehide', closeDocPip, { once: true });
  syncStatus(); poke();
}
function closeDocPip() {
  stage.classList.remove('pip-mode', 'cursor-hidden');
  stageHost.insertBefore(stage, stageHost.firstChild);
  stageHost.classList.remove('is-pip');
  pipSeg.classList.remove('on');
  state.pipWin = null;
  syncStatus(); poke();
}
btnPip.onclick = togglePip;
$('#btnPipBack').onclick = () => state.pipWin && state.pipWin.close();
video.addEventListener('enterpictureinpicture', () => { pipSeg.classList.add('on'); syncStatus(); });
video.addEventListener('leavepictureinpicture', () => { pipSeg.classList.remove('on'); syncStatus(); });

/* ── media session ───────────────────────────────────────── */
function mediaMeta(it) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: it.name, artist: 'PIP Player',
      album: `${idxOf(it) + 1} / ${state.list.length}`,
    });
  } catch (_) {}
}
if ('mediaSession' in navigator) {
  const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (_) {} };
  set('play', () => video.play().catch(() => {}));
  set('pause', () => video.pause());
  set('previoustrack', prev);
  set('nexttrack', () => next());
  set('seekbackward', d => nudge(-((d && d.seekOffset) || 10)));
  set('seekforward', d => nudge((d && d.seekOffset) || 10));
  set('seekto', d => { if (d && d.seekTime != null) seekTo(d.seekTime); });
}

/* Нативное окно PiP рисует шкалу по этим значениям. Для перекодируемого
   потока video.duration — лишь остаток, поэтому сообщаем свои цифры. */
let posStateT = 0;
function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const now = performance.now();
  if (now - posStateT < 900) return;
  posStateT = now;
  const d = duration();
  if (!d) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: d,
      playbackRate: video.playbackRate || 1,
      position: Math.min(d, Math.max(0, position())),
    });
  } catch (_) {}
}

/* ═══════════════ события видео ═══════════════ */
video.addEventListener('play', () => {
  playIcon.innerHTML = '<path d="M8 5h3.2v14H8zM12.8 5H16v14h-3.2z"/>';
  btnPlay.title = 'Пауза · Пробел';
  pulse(true); syncStatus(); markPlaying(true); poke(); armAudioCheck();
});
video.addEventListener('pause', () => {
  playIcon.innerHTML = '<path d="M8 5.5v13l10-6.5z"/>';
  btnPlay.title = 'Смотреть · Пробел';
  pulse(false); syncStatus(); markPlaying(false);
  stage.classList.remove('idle', 'cursor-hidden');
});
video.addEventListener('timeupdate', () => { paintSeek(); updatePositionState(); });
video.addEventListener('progress', paintSeek);
video.addEventListener('seeked', () => { state.seekPreview = null; paintSeek(); });
video.addEventListener('loadedmetadata', () => {
  state.seekPreview = null;
  const it = cur();
  if (it && isFinite(video.duration) && video.duration) it.dur = video.duration;
  paintSeek(); paintMeta(); syncAudioButton(); syncSubsButton();
});
video.addEventListener('volumechange', paintVolume);
video.addEventListener('ratechange', () => {
  btnRate.textContent = (video.playbackRate % 1 ? video.playbackRate : video.playbackRate.toFixed(0)) + '×';
});
video.addEventListener('playing', () => { state.errStreak = 0; state.seekPreview = null; syncStatus(); });
video.addEventListener('ended', () => {
  /* повтор одного файла работает и при выключенном автопереходе:
     это явно заданный режим, а не автоматика */
  if (state.loop !== 'one' && !state.autoplay) { toast('Автопереход выключен'); return; }
  next(true);
});

video.addEventListener('error', () => {
  const it = cur();
  if (!it || !video.getAttribute('src')) return;
  it.err = true;
  render();
  toast('Не воспроизводится: ' + it.name);
  state.errStreak++;
  if (state.errStreak < state.list.length) setTimeout(() => next(true), 1000);
  else state.errStreak = 0;
});

function markPlaying(on) {
  const li = queueList.querySelector('.item.active');
  if (li) li.classList.toggle('playing', on);
}
function syncStatus() {
  const it = cur();
  document.title = it ? `${video.paused ? '⏸ ' : ''}${it.name} · PIP Player` : 'PIP Player';
}

/* ── кнопки ──────────────────────────────────────────────── */
btnPlay.onclick = togglePlay;
$('#btnNext').onclick = () => next();
$('#btnPrev').onclick = prev;
btnMute.onclick = () => { video.muted = !video.muted; };
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

function buildRateMenu() {
  rateMenu.replaceChildren();
  const head = document.createElement('div');
  head.className = 'menu__title';
  head.textContent = 'Скорость воспроизведения';
  rateMenu.append(head);

  for (const r of RATES) {
    const b = document.createElement('button');
    b.className = 'menu__item' + (Math.abs(video.playbackRate - r) < 0.001 ? ' sel' : '');
    b.innerHTML = `<span class="menu__tick">${svg('<path d="M5 12.5l4.5 4.5L19 7"/>')}</span>
      <span class="menu__body"><span class="menu__main"></span></span>`;
    b.querySelector('.menu__main').textContent = (r === 1 ? 'Обычная' : r + '×');
    b.onclick = () => { video.playbackRate = r; rateMenu.classList.remove('open'); };
    rateMenu.append(b);
  }
}
btnRate.onclick = e => {
  e.stopPropagation();
  buildRateMenu();
  closeMenus(rateMenu);
  rateMenu.classList.toggle('open');
};
const LOOP_MODES = ['off', 'queue', 'one'];
const LOOP_ICON = {
  off:   '<path d="M4 10a4 4 0 014-4h12M20 14a4 4 0 01-4 4H4"/><path d="M17 3l3 3-3 3M7 15l-3 3 3 3"/>',
  queue: '<path d="M4 10a4 4 0 014-4h12M20 14a4 4 0 01-4 4H4"/><path d="M17 3l3 3-3 3M7 15l-3 3 3 3"/>',
  one:   '<path d="M4 10a4 4 0 014-4h12M20 14a4 4 0 01-4 4H4"/><path d="M17 3l3 3-3 3M7 15l-3 3 3 3"/>'
       + '<path d="M11.1 10.9l1.5-1v4.6"/>',
};
const LOOP_TITLE = {
  off: 'Без повтора', queue: 'Повторять очередь', one: 'Повторять один файл',
};

function paintLoop() {
  btnLoop.innerHTML = svg(LOOP_ICON[state.loop]);
  btnLoop.title = LOOP_TITLE[state.loop];
  btnLoop.classList.toggle('on', state.loop !== 'off');
}
btnLoop.onclick = () => {
  state.loop = LOOP_MODES[(LOOP_MODES.indexOf(state.loop) + 1) % LOOP_MODES.length];
  paintLoop();
  toast(LOOP_TITLE[state.loop]);
};
function paintAuto() {
  btnAuto.classList.toggle('on', state.autoplay);
  btnAuto.title = state.autoplay ? 'Автопереход включён' : 'Автопереход выключен';
}
btnAuto.onclick = () => {
  state.autoplay = !state.autoplay;
  localStorage.setItem('pip.autoplay', state.autoplay ? '1' : '0');
  paintAuto();
  toast(state.autoplay ? 'Автопереход к следующему включён' : 'Автопереход выключен');
};

$('#btnRestart').onclick = () => { endCard.classList.remove('show'); if (state.list.length) playItem(state.list[0]); };
$('#btnEndClose').onclick = () => endCard.classList.remove('show');
$('#helpClose').onclick = () => helpModal.classList.remove('open');
helpModal.onclick = e => { if (e.target === helpModal) helpModal.classList.remove('open'); };

/* ── выбор файлов ────────────────────────────────────────── */
const pickFiles = () => filePick.click();
const pickFolder = () => dirPick.click();
$('#btnAddFiles').onclick = pickFiles;
$('#btnEmptyFiles').onclick = pickFiles;
$('#btnAddFolder').onclick = pickFolder;
$('#btnEmptyFolder').onclick = pickFolder;
filePick.onchange = e => { addLocalFiles(e.target.files); e.target.value = ''; };
dirPick.onchange = e => { addLocalFiles(e.target.files); e.target.value = ''; };

/* ── перетаскивание извне ────────────────────────────────── */
let dragDepth = 0;
window.addEventListener('dragenter', e => {
  if (dragEl || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  dragDepth++; dropveil.classList.add('show');
});
window.addEventListener('dragover', e => { if (!dragEl) e.preventDefault(); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropveil.classList.remove('show'); } });
window.addEventListener('drop', async e => {
  if (dragEl) return;
  e.preventDefault();
  dragDepth = 0; dropveil.classList.remove('show');
  const dt = e.dataTransfer;
  if (!dt) return;
  const entries = [...(dt.items || [])].map(i => i.webkitGetAsEntry ? i.webkitGetAsEntry() : null).filter(Boolean);
  if (entries.length) {
    const out = [];
    for (const en of entries) await walkEntry(en, out);
    addLocalFiles(out);
  } else addLocalFiles(dt.files);
});

/* ═══════════════ обзор диска (серверный режим) ═══════════════ */
function openBrowser() {
  browserModal.classList.add('open');
  loadDir(state.browserDir || (state.server.places[0] && state.server.places[0].path));
}
btnDisk.onclick = openBrowser;
btnEmptyDisk.onclick = openBrowser;
$('#brClose').onclick = () => browserModal.classList.remove('open');
browserModal.onclick = e => { if (e.target === browserModal) browserModal.classList.remove('open'); };
$('#brUp').onclick = () => { if (state.browserData && state.browserData.parent) loadDir(state.browserData.parent); };
$('#brAddAll').onclick = () => {
  const d = state.browserData;
  if (!d) return;
  addServerFiles(d.files);
  browserModal.classList.remove('open');
};

async function loadDir(path) {
  if (!path) return;
  try {
    const r = await fetch('/api/ls?path=' + encodeURIComponent(path));
    const data = await r.json();
    if (data.error) return toast(data.error);
    state.browserDir = data.path;
    state.browserData = data;
    brPath.textContent = data.path;
    renderPlaces();
    renderBrowser(data);
  } catch (_) { toast('Не удалось прочитать каталог'); }
}

function renderPlaces() {
  brPlaces.replaceChildren();
  for (const p of state.server.places) {
    const b = document.createElement('button');
    b.className = 'brow' + (p.path === state.browserDir ? ' sel' : '');
    b.innerHTML = svg('<path d="M3 9.5h5l1.5 2h11.5v8h-18z"/>') + '<span class="brow__name"></span>';
    b.querySelector('.brow__name').textContent = p.name;
    b.onclick = () => loadDir(p.path);
    brPlaces.append(b);
  }
}

function renderBrowser(d) {
  brList.replaceChildren();
  if (!d.dirs.length && !d.files.length) {
    const e = document.createElement('li');
    e.className = 'browser__empty';
    e.textContent = 'Здесь нет ни папок, ни медиафайлов.';
    brList.append(e);
    return;
  }
  for (const dir of d.dirs) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'brow';
    b.innerHTML = svg('<path d="M3 9.5h5l1.5 2h11.5v8h-18z"/>') + '<span class="brow__name"></span>' + svg('<path d="M10 7l5 5-5 5"/>');
    b.querySelector('.brow__name').textContent = dir.name;
    b.onclick = () => loadDir(dir.path);
    li.append(b); brList.append(li);
  }
  for (const f of d.files) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'brow';
    b.innerHTML = svg('<path d="M4 5.5h16v13H4z"/><path d="M10 9.5l5 3-5 3z"/>') +
      '<span class="brow__name"></span><span class="brow__size"></span>';
    b.querySelector('.brow__name').textContent = f.name;
    b.querySelector('.brow__size').textContent = fmtSize(f.size);
    b.onclick = () => { addServerFiles([f]); browserModal.classList.remove('open'); };
    li.append(b); brList.append(li);
  }
}

/* ═══════════════ клавиатура ═══════════════ */
function onKey(e) {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (t === seek || t === volBar) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (browserModal.classList.contains('open') || helpModal.classList.contains('open')) {
    if (e.key === 'Escape') { browserModal.classList.remove('open'); helpModal.classList.remove('open'); }
    return;
  }

  switch (e.key) {
    case ' ': case 'Spacebar': case 'k': case 'K': case 'л': case 'Л':
      e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft':  e.preventDefault(); nudge(e.shiftKey ? -1 : -5); break;
    case 'ArrowRight': e.preventDefault(); nudge(e.shiftKey ? 1 : 5); break;
    case 'j': case 'J': case 'о': case 'О': e.preventDefault(); nudge(-10); break;
    case 'l': case 'L': case 'д': case 'Д': e.preventDefault(); nudge(10); break;
    case 'ArrowUp':   e.preventDefault(); video.muted = false; video.volume = Math.min(1, video.volume + .05); flash(Math.round(video.volume * 100) + '%'); break;
    case 'ArrowDown': e.preventDefault(); video.volume = Math.max(0, video.volume - .05); flash(Math.round(video.volume * 100) + '%'); break;
    case 'm': case 'M': case 'ь': case 'Ь': video.muted = !video.muted; break;
    case 'n': case 'N': case 'т': case 'Т': next(); break;
    case 'b': case 'B': case 'и': case 'И': prev(); break;
    case 'f': case 'F': case 'а': case 'А': toggleFull(); break;
    case 'p': case 'P': case 'з': case 'З': togglePip(); break;
    case 'q': case 'Q': case 'й': case 'Й': toggleQueue(); break;
    case 'Home': e.preventDefault(); seekTo(0); break;
    case 'End':  e.preventDefault(); seekTo(duration() - 2); break;
    case 'Escape':
      if (state.pipWin) state.pipWin.close();
      else if (state.queueOpen) toggleQueue(false);
      break;
    default:
      if (/^[0-9]$/.test(e.key) && duration()) {
        e.preventDefault();
        seekTo(duration() * Number(e.key) / 10);
        flash(Number(e.key) * 10 + '%');
      }
  }
  poke();
}
document.addEventListener('keydown', onKey);
document.addEventListener('keyup', e => {
  if (e.key === ' ' && e.target && e.target.tagName === 'BUTTON') e.target.blur();
});

/* ═══════════════ старт ═══════════════ */
async function detectServer() {
  if (!location.protocol.startsWith('http')) return null;
  try {
    const r = await fetch('/api/ping');
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

(async function boot() {
  video.volume = 1;
  paintVolume(); paintSeek(); paintLoop(); paintAuto(); applyCueStyle(); render();
  btnAudio.hidden = true;
  btnSubs.hidden = true;

  state.server = await detectServer();

  if (state.server && state.server.ffmpeg) {
    btnDisk.hidden = false;
    btnEmptyDisk.hidden = false;
    btnEmptyDisk.classList.add('btn--solid');
    $('#btnEmptyFiles').classList.remove('btn--solid');
    $('#btnEmptyFolder').before(btnEmptyDisk);
    modeHint.innerHTML = 'Мост с ffmpeg активен. Файлы, добавленные перетаскиванием, ' +
      'он найдёт на диске сам — иначе берите их через «Обзор диска».';
  } else if (state.server) {
    btnDisk.hidden = false;
    btnEmptyDisk.hidden = false;
    modeHint.innerHTML = 'ffmpeg не найден в PATH — дорожки MKV разобрать не выйдет.';
  } else {
    modeHint.innerHTML = hasDocPip
      ? 'Нет звука в MKV? Запустите мост: <code>node server.mjs</code>'
      : 'Document PiP есть только в Chrome и Edge. Нет звука в MKV? Запустите <code>node server.mjs</code>';
  }
})();

window.addEventListener('beforeunload', () => {
  if (state.pipWin) state.pipWin.close();
  state.list.forEach(i => i.url && URL.revokeObjectURL(i.url));
});

})();
