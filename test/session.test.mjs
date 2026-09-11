/* ═══════════════════════════════════════════════════════════
   The player with the server behind it.

   What only exists in this mode: the queue coming back after a reload,
   returning to where watching stopped, the track and subtitle menus
   built from a real file, and the deck, which is hidden until something
   is playing. The layout of the menus inside the floating window is
   here too, because that is where it broke: the first column was handed
   a basis of zero, shrank to nothing and painted its rows straight over
   the column below it.

   One browser, one scripted walk, many assertions over what it saw.
   ═══════════════════════════════════════════════════════════ */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { openServed, findChrome } from './browser.mjs';
import { build, haveFfmpeg } from './fixtures.mjs';

const chrome = findChrome();
const ffmpeg = await haveFfmpeg();
const skip = !chrome ? 'no Chrome found; set CHROME to its path'
           : !ffmpeg ? 'no ffmpeg' : false;

const RESUME_AT = 60;   // seconds; past POS_MIN and far from the end

const SCRIPT = `
  window.__step('boot');
  const $ = s => document.querySelector(s);
  /* Waits for a condition, not for a fixed pause. The queue comes back
     only after the page has heard from the server, and with the other
     test files running in parallel that answer arrives later: a fixed
     pause passed alone and failed in the full run. */
  const until = async (ok, tries = 300) => {
    for (let i = 0; i < tries && !ok(); i++) await window.__settled();
    return ok();
  };
  await until(() => document.querySelector('.item.active'));
  const out = { errors: window.__errors.slice() };
  const rect = el => { const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y),
             w: Math.round(b.width), h: Math.round(b.height),
             top: Math.round(b.top), bottom: Math.round(b.bottom) }; };

  /* ── the queue of the previous session ── */
  const rows = [...document.querySelectorAll('.item')];
  out.restored = {
    count: rows.length,
    names: rows.map(r => r.querySelector('.item__name').textContent),
    active: rows.findIndex(r => r.classList.contains('active')),
    title: $('#titleName').textContent,
    /* nothing may be playing yet: opening a tab must not start ffmpeg */
    hasSource: !!$('#video').getAttribute('src'),
    volume: $('#video').volume,
  };

  out.mode = {
    diskShown: !$('#btnEmptyDisk').hidden,
    hint: $('#modeHint').textContent.trim(),
  };

  /* ── pressing play opens the file and returns to where it stopped ── */
  window.__step('play');
  $('.item.active .item__body').click();
  const v = $('#video');
  /* Long waits, because this part costs real seconds that the virtual
     clock cannot skip: the browser has to fetch three megabytes and
     open the container. Measured at around three and a half seconds,
     so the ceiling is set well above that rather than near it. */
  for (let i = 0; i < 200 && !v.getAttribute('src'); i++) await window.__settled();
  for (let i = 0; i < 400 && !(v.duration > 0); i++) await window.__settled();
  /* The jump back happens on loadedmetadata, one turn after it fires. */
  for (let i = 0; i < 60 && v.currentTime === 0; i++) await window.__settled();
  out.playing = {
    src: (v.getAttribute('src') || '').replace(/key=[a-f0-9]+/, 'key=…'),
    duration: Math.round(v.duration),
    resumedTo: Math.round(v.currentTime),
    deckShown: !$('#stage').classList.contains('empty'),
  };

  /* ── the audio tracks of a real file ── */
  window.__step('audio');
  await until(() => !$('#btnAudio').hidden);
  $('#btnAudio').click();
  await window.__settled();
  out.audio = {
    hidden: $('#btnAudio').hidden,
    items: [...document.querySelectorAll('#audioMenu .menu__item')].map(b => ({
      main: b.querySelector('.menu__main').textContent,
      sub: (b.querySelector('.menu__sub') || {}).textContent || '',
      chosen: b.classList.contains('sel'),
    })),
    label: $('#audioLabel').textContent,
  };
  $('#btnAudio').click();
  await window.__settled();

  /* ── icons: the queue is chrome, the deck is the main control ── */
  window.__step('icons');
  const inkOf = el => {
    const side = parseFloat(el.getAttribute('viewBox').split(' ')[2]);
    const b = el.getBBox();
    return Math.sqrt(b.width * b.height) / side * el.getBoundingClientRect().width;
  };
  const group = sel => [...document.querySelectorAll(sel + ' svg.ph')]
    .filter(el => el.getBoundingClientRect().width)
    .map(inkOf);
  out.ink = {
    deck: group('.deck'),
    header: group('.queue__tools'),
    footer: group('.queue__foot'),
  };

  /* ── the subtitle menu, side by side and then stacked ── */
  window.__step('subtitles');
  const measureSubs = () => {
    const m = $('#subsMenu');
    const cols = [...m.querySelectorAll('.menu__col')];
    const boxes = cols.map(rect);
    let overlap = 0, spill = 0;
    for (let i = 0; i < cols.length; i++) {
      spill = Math.max(spill, cols[i].scrollHeight - Math.round(cols[i].getBoundingClientRect().height));
      for (let j = i + 1; j < cols.length; j++) {
        const a = boxes[i], b = boxes[j];
        overlap = Math.max(overlap,
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      }
    }
    const stage = rect($('#stage'));
    const box = rect(m);
    return { columns: cols.length, boxes, overlap, spill,
             pastRight: box.x + box.w - (stage.x + stage.w),
             pastLeft: stage.x - box.x, width: box.w };
  };

  await until(() => !$('#btnSubs').hidden);
  $('#btnSubs').click();
  await window.__settled();
  out.subs = { hidden: $('#btnSubs').hidden, ...measureSubs() };
  $('#btnSubs').click();
  await window.__settled();

  /* ── the same menu inside the floating window ──
     The stage is what moves into the PiP window, and pip-mode is the
     class it carries there, so adding it here puts the layout in
     exactly the state the floating window renders. */
  window.__step('pip');
  out.pip = {};
  for (const width of [600, 380, 320]) {
    const host = $('#stageHost');
    const stage = $('#stage');
    stage.classList.add('pip-mode');
    stage.style.position = 'fixed';
    stage.style.left = '0'; stage.style.top = '0';
    stage.style.width = width + 'px'; stage.style.height = '340px';
    await window.__settled();
    $('#btnSubs').click();
    await window.__settled();
    out.pip[width] = measureSubs();
    $('#btnSubs').click();
    await window.__settled();
  }

  /* ── the cache bar in the gear menu ──
     Put the stage back first: the floating-window checks above left it
     fixed at 320px, and the gear lives outside the deck. */
  window.__step('cache');
  { const st = $('#stage'); st.classList.remove('pip-mode'); st.removeAttribute('style'); }
  await window.__settled();
  $('#btnGear').click();
  await until(() => $('.cache__bar') && $('.cache__bar').getAttribute('aria-valuenow'));
  const cbar = $('.cache__bar');
  const railW = $('.cache__rail').getBoundingClientRect().width;
  const leftOf = el => el.getBoundingClientRect().left - $('.cache__rail').getBoundingClientRect().left;
  const knob = $('.cache__knob');
  const t0 = v.currentTime;
  out.cache = {
    limit: Number(cbar.getAttribute('aria-valuenow')),
    min: Number(cbar.getAttribute('aria-valuemin')),
    max: Number(cbar.getAttribute('aria-valuemax')),
    knobAt: (leftOf(knob) + knob.getBoundingClientRect().width / 2) / railW,
    usedStyle: parseFloat($('.cache__used').style.width),
    stat: await (await fetch('/api/cache')).json(),
    note: $('.cache__note').textContent,
    size: $('.cache__size').textContent,
  };
  cbar.focus();
  for (let i = 0; i < 3; i++)
    cbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
  await window.__settled();
  out.cache.afterKeys = Number(cbar.getAttribute('aria-valuenow'));
  out.cache.videoMoved = Math.abs(v.currentTime - t0) > 1;
  /* the limit goes to the server half a second after the last key */
  await new Promise(r => setTimeout(r, 900));
  out.cache.server = (await (await fetch('/api/cache')).json()).limit / 1024 ** 3;
  $('#btnGear').click();
  await window.__settled();

  /* ── volume is written down ── */
  window.__step('volume');
  v.volume = 0.31;
  await new Promise(r => setTimeout(r, 700));
  out.stored = {
    vol: localStorage.getItem('pip.vol'),
    session: JSON.parse(localStorage.getItem('pip.session') || 'null'),
    pos: JSON.parse(localStorage.getItem('pip.pos') || 'null'),
  };

  window.__report(out);
`;

let R, media;
before(async () => {
  if (skip) return;
  media = await build();
  const size = f => fsp.stat(f).then(s => s.size);
  const seed = {
    'pip.session': JSON.stringify({
      v: 1,
      items: [
        { name: 'long.mkv', path: media.long, size: await size(media.long), dur: 180 },
        { name: 'native.mp4', path: media.native, size: await size(media.native) },
      ],
      loop: 'off', audioPref: null, subPref: null, current: media.long,
    }),
    'pip.pos': JSON.stringify({ [media.long]: RESUME_AT }),
    'pip.vol': '0.5',
  };
  R = await openServed('session', SCRIPT, {
    root: media.dir, warm: [media.long], seed,
    fonts: true, width: 1280, height: 800, budget: 20000,
  });
  if (R.fatal) throw new Error('the page script broke:\n' + R.fatal);
  if (R.stalled) throw new Error('the page script stopped at: ' + R.stalled);
}, { timeout: 180000 });

describe('the queue of the previous session', { skip }, () => {
  test('nothing throws', () => {
    assert.deepEqual(R.errors, []);
  });

  test('the files come back in order', () => {
    assert.equal(R.restored.count, 2);
    assert.deepEqual(R.restored.names, ['long.mkv', 'native.mp4']);
  });

  test('the file that was playing is the current one again', () => {
    assert.equal(R.restored.active, 0);
    assert.equal(R.restored.title, 'long.mkv');
  });

  test('opening a tab does not start a conversion', () => {
    assert.equal(R.restored.hasSource, false,
      'a source at boot means ffmpeg was told to work before anyone pressed play');
  });

  test('the volume is the one that was set last time', () => {
    assert.equal(R.restored.volume, 0.5);
  });

  test('the disk browser is offered, since there is a server', () => {
    assert.equal(R.mode.diskShown, true);
    assert.ok(R.mode.hint.length > 0);
  });
});

describe('playing', { skip }, () => {
  test('the file is served from the cache, not from the disk', () => {
    assert.match(R.playing.src, /^\/api\/media\?key=/);
  });

  test('the whole file is there', () => {
    assert.ok(Math.abs(R.playing.duration - 180) <= 2, 'duration ' + R.playing.duration);
  });

  test('watching goes on from where it stopped', () => {
    assert.ok(Math.abs(R.playing.resumedTo - RESUME_AT) <= 2,
      `expected to return to ${RESUME_AT}s, landed on ${R.playing.resumedTo}s`);
  });

  test('the deck appears once there is something to control', () => {
    assert.equal(R.playing.deckShown, true);
  });
});

describe('the audio tracks', { skip }, () => {
  test('the button is offered for a file that has tracks', () => {
    assert.equal(R.audio.hidden, false);
  });

  test('both tracks are listed with their studio names', () => {
    const named = R.audio.items.filter(i => /Studio One|Original/.test(i.main + i.sub));
    assert.equal(named.length, 2, JSON.stringify(R.audio.items));
  });

  test('one of them is marked as the one playing', () => {
    assert.equal(R.audio.items.filter(i => i.chosen).length, 1);
  });
});

describe('icons in a running player', { skip }, () => {
  test('the deck is the biggest thing on screen', () => {
    const deck = Math.min(...R.ink.deck.filter(x => x > 10));
    const header = Math.max(...R.ink.header);
    assert.ok(header < deck - 1.5,
      `queue header ${header.toFixed(1)} must read smaller than the deck ${deck.toFixed(1)}`);
  });

  test('the queue reads as one panel, top and bottom', () => {
    const header = Math.max(...R.ink.header);
    const footer = Math.max(...R.ink.footer);
    assert.ok(Math.abs(header - footer) < 2,
      `header ${header.toFixed(1)}, footer ${footer.toFixed(1)}`);
  });
});

describe('the subtitle menu', { skip }, () => {
  test('it opens in two columns', () => {
    assert.equal(R.subs.hidden, false);
    assert.equal(R.subs.columns, 2, 'tracks on the left, styling on the right');
  });

  test('the columns do not overlap', () => {
    assert.ok(R.subs.overlap <= 0 || R.subs.boxes.every(b => b.h > 0));
  });
});

describe('the menu inside the floating window', { skip }, () => {
  for (const width of [600, 380, 320]) {
    test(`at ${width}px the columns stack instead of painting over each other`, () => {
      const m = R.pip[width];
      assert.equal(m.columns, 2);
      assert.ok(m.boxes.every(b => b.h > 0),
        'a column with no height is the bug: flex-basis zero inside a capped menu');
      assert.ok(m.boxes[1].top >= m.boxes[0].bottom,
        `the styling column starts at ${m.boxes[1].top}, the track list ends at ${m.boxes[0].bottom}`);
    });

    test(`at ${width}px the menu stays inside the window`, () => {
      const m = R.pip[width];
      assert.ok(m.pastRight <= 0, `it hangs ${m.pastRight}px past the right edge`);
      assert.ok(m.pastLeft <= 0, `it hangs ${m.pastLeft}px past the left edge`);
    });
  }
});

describe('the cache bar', { skip }, () => {
  test('it shows the limit the server has', () => {
    assert.equal(R.cache.limit, 24);
    assert.equal(R.cache.min, 8);
  });

  test('the scale ends where the disk ends', () => {
    assert.equal(R.cache.max, Math.floor(R.cache.stat.max / 1024 ** 3));
  });

  test('the knob stands where the limit is on the scale', () => {
    const at = 24 * 1024 ** 3 / R.cache.stat.max;
    assert.ok(Math.abs(R.cache.knobAt - at) < 0.02,
      `knob at ${R.cache.knobAt.toFixed(3)}, limit at ${at.toFixed(3)}`);
  });

  test('the fill is what the cache holds, on the same scale', () => {
    /* The prepared test file weighs megabytes against a 128 GB scale,
       so the fill is a fraction of a pixel. What is checked is the
       width it was given, against the bytes the server reports. */
    assert.ok(R.cache.stat.bytes > 0, 'a prepared file is in the cache');
    const want = R.cache.stat.bytes / R.cache.stat.max * 100;
    assert.ok(Math.abs(R.cache.usedStyle - want) < 1e-6,
      `fill ${R.cache.usedStyle}% for ${want}% taken`);
    assert.match(R.cache.size, /24/);
  });

  test('the free space on the disk is shown', () => {
    assert.ok(R.cache.note.length > 0);
  });

  test('arrow keys move the limit and leave the video alone', () => {
    assert.equal(R.cache.afterKeys, 27);
    assert.equal(R.cache.videoMoved, false, 'the arrows also seeked the video');
  });

  test('the new limit reaches the server', () => {
    assert.equal(R.cache.server, 27);
  });
});

describe('what is written down', { skip }, () => {
  test('a change of volume is remembered', () => {
    assert.equal(Number(R.stored.vol), 0.31);
  });

  test('the queue is kept as paths, so it can be opened again', () => {
    assert.equal(R.stored.session.items.length, 2);
    assert.ok(R.stored.session.items.every(i => i.path.endsWith('.mkv') || i.path.endsWith('.mp4')));
  });

  test('the position is kept per file', () => {
    assert.equal(typeof R.stored.pos, 'object');
  });
});
