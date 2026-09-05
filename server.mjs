#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════
   PIP Player — локальный мост на ffmpeg

   Принцип: файл, который браузер не умеет играть сам, готовится
   ОДИН РАЗ целиком в обычный MP4 и кладётся в кэш. Дальше браузер
   работает с ним как с любым файлом — перематывает байтовыми
   диапазонами. Никакого посекундного -ss: именно он раньше рвал
   синхронизацию, потому что видео копируется, а звук кодируется
   заново, и на каждой перемотке эти два потока стыковались с нуля.

   Слушает только 127.0.0.1.
   ═══════════════════════════════════════════════════════════ */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8777);
const CACHE = process.env.PIP_CACHE || path.join(os.tmpdir(), 'pip-player-cache');
const CACHE_LIMIT = Number(process.env.PIP_CACHE_GB || 24) * 1024 ** 3;

fs.mkdirSync(CACHE, { recursive: true });

/* каталоги, за пределы которых сервер не выходит */
const ROOTS = [os.homedir(), '/Volumes', '/media', '/mnt']
  .filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
if (process.argv[2]) {
  const r = path.resolve(process.argv[2]);
  if (fs.existsSync(r)) ROOTS.unshift(r);
}

const MEDIA_EXT = /\.(mp4|m4v|webm|ogv|ogm|mov|mkv|avi|ts|m2ts|mts|mpg|mpeg|3gp|flv|wmv|divx|mp3|m4a|m4b|aac|flac|wav|opus|oga)$/i;
const NATIVE_CONTAINER = /\.(mp4|m4v|mov|webm|ogv|mp3|m4a|aac|wav|flac|opus|oga)$/i;
const NATIVE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const NATIVE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le']);
/* текстовые субтитры перегоняются в WebVTT; растровые (PGS, VOBSUB)
   в текст не превращаются — их можно только вжигать в картинку,
   а это полное перекодирование видео */
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'stl']);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.flac': 'audio/flac', '.opus': 'audio/ogg', '.wav': 'audio/wav',
};

/* ── утилиты ─────────────────────────────────────────────── */
const inRoots = p => ROOTS.some(r => p === r || p.startsWith(r + path.sep));
const safePath = raw => { if (!raw) return null; const p = path.resolve(raw); return inRoots(p) ? p : null; };

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

const run = (cmd, args) => new Promise((ok, bad) =>
  execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024 },
    (e, out, err) => e ? bad(new Error(err || e.message)) : ok(out)));

let ffmpegOk = null;
async function checkFfmpeg() {
  if (ffmpegOk !== null) return ffmpegOk;
  try { await run('ffprobe', ['-version']); ffmpegOk = true; } catch { ffmpegOk = false; }
  return ffmpegOk;
}

/* ── ffprobe ─────────────────────────────────────────────── */
const probeCache = new Map();
async function probe(file) {
  const st = await fsp.stat(file);
  const key = `${file}:${st.mtimeMs}:${st.size}`;
  if (probeCache.has(key)) return probeCache.get(key);

  const raw = JSON.parse(await run('ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file]));

  const video = (raw.streams || []).filter(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = (raw.streams || []).filter(s => s.codec_type === 'audio');
  const subs = (raw.streams || []).filter(s => s.codec_type === 'subtitle');

  const info = {
    path: file, name: path.basename(file), size: st.size,
    duration: Number(raw.format?.duration) || 0,
    video: video[0] ? { index: video[0].index, codec: video[0].codec_name,
                        width: video[0].width, height: video[0].height } : null,
    audio: audio.map((s, i) => ({
      index: s.index, order: i, codec: s.codec_name,
      channels: s.channels || 0, layout: s.channel_layout || '',
      lang: (s.tags?.language || '').toLowerCase(), title: s.tags?.title || '',
      bitrate: Number(s.bit_rate) || Number(s.tags?.BPS) || Number(s.tags?.['BPS-eng']) || 0,
      sampleRate: Number(s.sample_rate) || 0,
      default: !!s.disposition?.default, forced: !!s.disposition?.forced,
      comment: !!s.disposition?.comment, native: NATIVE_AUDIO.has(s.codec_name),
    })),
    subs: subs.map((s, i) => ({
      index: s.index, order: i, codec: s.codec_name,
      lang: (s.tags?.language || '').toLowerCase(), title: s.tags?.title || '',
      default: !!s.disposition?.default, forced: !!s.disposition?.forced,
      text: TEXT_SUBS.has(s.codec_name),
    })),
  };
  info.defaultAudio = (info.audio.find(a => a.default) || info.audio[0] || null)?.index ?? null;
  info.defaultSub = (info.subs.find(x => x.text && x.default) || null)?.index ?? null;
  probeCache.set(key, info);
  return info;
}

/* браузер справится сам — тогда ничего готовить не нужно */
function planFor(info, audioIndex) {
  const track = info.audio.find(a => a.index === audioIndex) || null;
  const nativeBox = NATIVE_CONTAINER.test(info.name);
  const nativeVideo = !info.video || NATIVE_VIDEO.has(info.video.codec);
  const nativeAudio = !track || track.native;
  const onlyDefault = !track || track.index === info.defaultAudio || info.audio.length <= 1;
  return {
    direct: nativeBox && nativeVideo && nativeAudio && onlyDefault,
    copyVideo: nativeVideo,
  };
}

/* ── кэш подготовленных файлов ───────────────────────────── */
const keyFor = (file, st, a) => crypto.createHash('sha1')
  .update(`${file}|${st.mtimeMs}|${st.size}|${a}`).digest('hex').slice(0, 20);
const cacheFile = key => path.join(CACHE, key + '.mp4');

async function evict() {
  let items = [];
  for (const n of await fsp.readdir(CACHE)) {
    if (!n.endsWith('.mp4')) continue;
    const f = path.join(CACHE, n);
    try { const s = await fsp.stat(f); items.push({ f, size: s.size, at: s.atimeMs || s.mtimeMs }); } catch {}
  }
  let total = items.reduce((a, b) => a + b.size, 0);
  if (total <= CACHE_LIMIT) return;
  items.sort((a, b) => a.at - b.at);
  for (const it of items) {
    if (total <= CACHE_LIMIT) break;
    try { await fsp.unlink(it.f); total -= it.size; console.log('  кэш: удалил', path.basename(it.f)); } catch {}
  }
}

/* ── подготовка: один проход, обычный seekable MP4 ───────── */
const jobs = new Map();   // key -> { progress, error, proc }

function startJob(key, file, info, audioIndex, plan) {
  const part = path.join(CACHE, key + '.part');
  const out = cacheFile(key);

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', file];
  if (info.video) args.push('-map', `0:${info.video.index}`);
  if (audioIndex != null) args.push('-map', `0:${audioIndex}`);
  args.push('-sn', '-dn', '-map_metadata', '-1');

  if (info.video) {
    if (plan.copyVideo) args.push('-c:v', 'copy');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p');
  }
  if (audioIndex != null) args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000');

  /* один проход без -ss: видео и звук стыкуются ровно один раз,
     на исходной шкале времени — рассинхрону взяться неоткуда */
  args.push('-movflags', '+faststart', '-f', 'mp4', '-progress', 'pipe:1', part);

  /* показываем ту же команду, что реально исполняется, но без длинных путей */
  const short = a => a === file ? path.basename(file) : a === part ? path.basename(part) : a;
  const job = {
    progress: 0, phase: 'convert', error: null, started: Date.now(),
    cmd: 'ffmpeg ' + args.filter(a => a !== '-hide_banner' && a !== '-loglevel'
                                   && a !== 'error' && a !== '-nostdin' && a !== '-y'
                                   && a !== '-progress' && a !== 'pipe:1').map(short).join(' '),
  };
  jobs.set(key, job);

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  job.proc = proc;

  let tail = '';
  proc.stdout.on('data', d => {
    const s = String(d);
    const m = /out_time_(?:us|ms)=(\d+)/g;
    let last = null, x;
    while ((x = m.exec(s))) last = x;
    if (last && info.duration) {
      const div = last[0].includes('_us=') ? 1e6 : 1e3;
      job.progress = Math.max(0, Math.min(1, Number(last[1]) / div / info.duration));
    }
    /* кодирование кончилось, дальше faststart переписывает файл целиком —
       прогресса у этой фазы нет, поэтому честно называем её отдельным шагом */
    if (/progress=end/.test(s)) { job.phase = 'finalize'; job.progress = 1; }
  });
  proc.stderr.on('data', d => { tail = (tail + d).slice(-1500); });

  proc.on('error', e => { job.error = e.message; });
  proc.on('exit', async code => {
    if (code === 0) {
      try { await fsp.rename(part, out); } catch (e) { job.error = String(e.message); }
      jobs.delete(key);
      evict().catch(() => {});
      console.log('  готово:', info.name);
    } else {
      job.error = (tail.replace(/\s+/g, ' ').trim().slice(0, 300)) || `ffmpeg завершился с кодом ${code}`;
      job.progress = 0;
      try { await fsp.unlink(part); } catch {}
      setTimeout(() => jobs.delete(key), 30000);
      console.error('  ошибка подготовки:', info.name, job.error);
    }
  });
  return job;
}

/* ── извлечение субтитров ────────────────────────────────── */
const subJobs = new Map();

function extractSubs(file, idx, out) {
  const part = out + '.part';
  return new Promise((ok, bad) => {
    /* -vn -an: видео и звук не нужны, демуксер пропустит их пакеты */
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', file, '-map', `0:${idx}`, '-vn', '-an', '-c:s', 'webvtt', '-f', 'webvtt', part]);
    let tail = '';
    proc.stderr.on('data', d => { tail = (tail + d).slice(-800); });
    proc.on('error', bad);
    proc.on('exit', async code => {
      if (code !== 0) { try { await fsp.unlink(part); } catch {} return bad(new Error(tail || 'код ' + code)); }
      try { await fsp.rename(part, out); ok(out); } catch (e) { bad(e); }
    });
  });
}

/* ── раздача файла с поддержкой Range ────────────────────── */
function serveFile(req, res, file, size) {
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : size - 1;
    if (!isFinite(start) || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      return res.end();
    }
    end = Math.min(end, size - 1);
    res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes', 'content-length': end - start + 1, 'cache-control': 'no-store' });
    const s = fs.createReadStream(file, { start, end });
    s.pipe(res); res.on('close', () => s.destroy());
    return;
  }
  res.writeHead(200, { 'content-type': type, 'content-length': size,
    'accept-ranges': 'bytes', 'cache-control': 'no-store' });
  const s = fs.createReadStream(file);
  s.pipe(res); res.on('close', () => s.destroy());
}

/* ── обход каталогов ─────────────────────────────────────── */
const cmp = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

async function listDir(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const dirs = [], files = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) dirs.push({ name: e.name, path: full });
    else if (e.isFile() && MEDIA_EXT.test(e.name)) {
      let size = 0;
      try { size = (await fsp.stat(full)).size; } catch {}
      files.push({ name: e.name, path: full, size });
    }
  }
  dirs.sort((a, b) => cmp.compare(a.name, b.name));
  files.sort((a, b) => cmp.compare(a.name, b.name));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent !== dir && inRoots(parent) ? parent : null, dirs, files };
}

function places() {
  const home = os.homedir();
  const list = [
    { name: 'Домашняя папка', path: home },
    { name: 'Загрузки', path: path.join(home, 'Downloads') },
    { name: 'Видео', path: path.join(home, 'Movies') },
    { name: 'Рабочий стол', path: path.join(home, 'Desktop') },
  ];
  try { for (const v of fs.readdirSync('/Volumes')) if (!v.startsWith('.')) list.push({ name: v, path: path.join('/Volumes', v) }); } catch {}
  return list.filter(p => { try { return fs.statSync(p.path).isDirectory(); } catch { return false; } });
}

/* поиск перетащенного файла на диске */
const SKIP_DIR = new Set(['Library', 'Applications', 'System', 'node_modules', '.git', 'private',
                          'Photos Library.photoslibrary', 'Music', '.Trash']);
async function findByName(name, size) {
  const deadline = Date.now() + 6000;
  const queue = [...ROOTS];
  const exact = [], loose = [];
  let seen = 0;
  while (queue.length && Date.now() < deadline && seen < 15000) {
    const dir = queue.shift(); seen++;
    let entries; try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIR.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { queue.push(full); continue; }
      if (e.name !== name) continue;
      let st; try { st = await fsp.stat(full); } catch { continue; }
      const hit = { name: e.name, path: full, size: st.size, dir };
      if (size && st.size === Number(size)) exact.push(hit); else loose.push(hit);
      if (exact.length >= 5) return exact;
    }
  }
  return exact.length ? exact : loose.slice(0, 5);
}

/* ── статика ─────────────────────────────────────────────── */
const STATIC = new Set(['/index.html', '/styles.css', '/app.js']);
async function serveStatic(res, name) {
  const file = path.join(HERE, name === '/' ? 'index.html' : name);
  try {
    const buf = await fsp.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': buf.length, 'cache-control': 'no-store' });
    res.end(buf);
  } catch { res.writeHead(404).end('not found'); }
}

/* ── маршруты ────────────────────────────────────────────── */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (p.startsWith('/api/') && p !== '/api/prepare') {
    const q = url.searchParams.get('path');
    console.log('  ->', p.replace('/api/', ''), q ? path.basename(q) : '');
  }

  try {
    if (p === '/' || STATIC.has(p)) return serveStatic(res, p);

    if (p === '/api/ping') {
      return json(res, 200, { ok: true, ffmpeg: await checkFfmpeg(), roots: ROOTS, places: places(), cache: CACHE });
    }

    if (p === '/api/ls') {
      const dir = safePath(url.searchParams.get('path') || os.homedir());
      if (!dir) return json(res, 403, { error: 'путь вне разрешённых каталогов' });
      const st = await fsp.stat(dir).catch(() => null);
      if (!st?.isDirectory()) return json(res, 404, { error: 'каталог не найден' });
      return json(res, 200, await listDir(dir));
    }

    if (p === '/api/find') {
      const name = url.searchParams.get('name');
      if (!name) return json(res, 400, { error: 'нужно имя файла' });
      return json(res, 200, { matches: await findByName(name, url.searchParams.get('size')) });
    }

    if (p === '/api/probe') {
      if (!await checkFfmpeg()) return json(res, 503, { error: 'ffprobe не найден в PATH' });
      const file = safePath(url.searchParams.get('path'));
      if (!file) return json(res, 403, { error: 'путь вне разрешённых каталогов' });
      const info = await probe(file);
      return json(res, 200, { ...info, plan: planFor(info, info.defaultAudio) });
    }

    /* Готовность файла к воспроизведению. Клиент дёргает это, пока
       не получит state:'ready' либо 'direct'. */
    if (p === '/api/prepare') {
      const file = safePath(url.searchParams.get('path'));
      if (!file) return json(res, 403, { error: 'путь вне разрешённых каталогов' });
      const st = await fsp.stat(file).catch(() => null);
      if (!st?.isFile()) return json(res, 404, { error: 'файл не найден' });
      if (!await checkFfmpeg()) return json(res, 200, { state: 'direct' });

      const info = await probe(file);
      const raw = url.searchParams.get('a');
      const a = raw != null && raw !== '' ? Number(raw) : info.defaultAudio;
      const plan = planFor(info, a);
      if (plan.direct) return json(res, 200, { state: 'direct', duration: info.duration });

      const key = keyFor(file, st, a);
      const out = cacheFile(key);
      const ready = await fsp.stat(out).catch(() => null);
      if (ready) {
        fsp.utimes(out, new Date(), new Date()).catch(() => {});
        return json(res, 200, { state: 'ready', key, duration: info.duration, size: ready.size });
      }

      let job = jobs.get(key);
      if (!job) { console.log('  готовлю:', info.name, '· дорожка', a); job = startJob(key, file, info, a, plan); }
      if (job.error) return json(res, 200, { state: 'error', error: job.error });
      return json(res, 200, { state: 'working', key, progress: job.progress,
        phase: job.phase, cmd: job.cmd, elapsed: Date.now() - job.started, duration: info.duration });
    }

    /* Субтитры отдельным файлом WebVTT: браузер понимает только его,
       а SRT и ASS внутри MKV — нет. Результат кэшируется. */
    if (p === '/api/subs') {
      if (!await checkFfmpeg()) return res.writeHead(503).end('нет ffmpeg');
      const file = safePath(url.searchParams.get('path'));
      if (!file) return res.writeHead(403).end('forbidden');
      const st = await fsp.stat(file).catch(() => null);
      if (!st?.isFile()) return res.writeHead(404).end('not found');

      const idx = Number(url.searchParams.get('s'));
      if (!isFinite(idx)) return res.writeHead(400).end('bad stream');

      const out = path.join(CACHE, keyFor(file, st, 'sub' + idx) + '.vtt');
      if (!fs.existsSync(out)) {
        const pending = subJobs.get(out);
        if (pending) await pending;
        else {
          const job = extractSubs(file, idx, out);
          subJobs.set(out, job);
          try { await job; } catch (e) {
            subJobs.delete(out);
            console.error('  субтитры:', String(e.message).slice(0, 200));
            return res.writeHead(500).end('не удалось извлечь субтитры');
          }
          subJobs.delete(out);
        }
      }
      const vst = await fsp.stat(out).catch(() => null);
      if (!vst) return res.writeHead(500).end('пусто');
      res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8',
        'content-length': vst.size, 'cache-control': 'no-store' });
      return fs.createReadStream(out).pipe(res);
    }

    /* подготовленный файл */
    if (p === '/api/media') {
      const key = (url.searchParams.get('key') || '').replace(/[^a-f0-9]/g, '');
      if (!key) return res.writeHead(400).end('bad key');
      const f = cacheFile(key);
      const st = await fsp.stat(f).catch(() => null);
      if (!st) return res.writeHead(404).end('not ready');
      return serveFile(req, res, f, st.size);
    }

    /* файл, который браузер играет сам — отдаём как есть */
    if (p === '/api/raw') {
      const file = safePath(url.searchParams.get('path'));
      if (!file) return res.writeHead(403).end('forbidden');
      const st = await fsp.stat(file).catch(() => null);
      if (!st?.isFile()) return res.writeHead(404).end('not found');
      return serveFile(req, res, file, st.size);
    }

    res.writeHead(404).end('not found');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: String(err.message || err) });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log('');
  console.log('  PIP Player  ·  http://127.0.0.1:' + PORT);
  console.log('  ffmpeg      ·  ' + (await checkFfmpeg() ? 'найден' : 'НЕ НАЙДЕН'));
  console.log('  кэш         ·  ' + CACHE + '  (лимит ' + (CACHE_LIMIT / 1024 ** 3).toFixed(0) + ' ГБ)');
  console.log('  каталоги    ·  ' + ROOTS.join('  '));
  console.log('');
});
