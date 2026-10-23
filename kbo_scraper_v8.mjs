#!/usr/bin/env node
// KBO 공식 기록실(koreabaseball.com)의 선수·팀 기록표를 읽어 웹페이지가 쓰는 JSON(data/kbo.json)으로 저장합니다.
// 사용법: node kbo_ingest.mjs [--seasons 2024,2025,2026] [--min-pa 150] [--min-ip 40] [--out data/kbo.json]
// 필요한 것: Node.js 18 이상 (내장 fetch 사용, 설치할 패키지 없음)
//
// KBO에는 공개 API가 없어서 기록실 웹페이지의 표를 읽습니다. 이 페이지는 시즌이나 쪽을 바꿀 때마다
// 서버에 폼을 다시 보내는 방식(ASP.NET)이라, 폼 값과 이동 버튼을 페이지에서 찾아 그대로 따라 합니다.
// 서버에 부담을 주지 않도록 요청 사이에 간격을 두고, 하루 한 번 정도만 실행하세요.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];

const thisYear = new Date().getFullYear();
const seasons = (args.seasons || [thisYear - 2, thisYear - 1, thisYear].join(','))
  .split(',').map(Number).filter(Boolean).sort((a, b) => a - b);
const MIN_PA = Number(args['min-pa'] ?? 10);  // 전체 선수를 담되, 타석 10 미만은 제외
const MIN_IP = Number(args['min-ip'] ?? 3);   // 이닝 3 미만은 제외
const OUT = args.out || 'data/kbo.json';
const BASE = process.env.KBO_BASE || 'https://www.koreabaseball.com';
const DELAY = Number(process.env.KBO_DELAY_MS ?? 1500);
const RETRY_MS = Number(process.env.KBO_RETRY_MS ?? 3000);
const UA = 'kbo-stats-personal/1.0 (personal, low-volume; contact via GitHub repo)';
const TIMEOUT = Number(process.env.KBO_TIMEOUT_MS ?? 30000);   // 요청 하나가 이 시간(ms) 안에 안 끝나면 중단
const MAX_MS = Number(process.env.KBO_MAX_MS ?? 12 * 60 * 1000); // 전체 실행 시간 상한
const START = Date.now();
let BROWSERISH = false; // 한 번 실패하면 켜집니다: 브라우저가 기본으로 보내는 헤더(origin, accept)를 추가

const PATH = {
  hit1: '/Record/Player/HitterBasic/Basic1.aspx',
  hit2: '/Record/Player/HitterBasic/Basic2.aspx',
  hitOld: '/Record/Player/HitterBasic/BasicOld.aspx', // 세부기록 표가 안 열릴 때 대신 쓰는 옛 기본기록 표(볼넷·사구·삼진·도루 포함)
  run: '/Record/Player/Runner/Basic.aspx',
  pit1: '/Record/Player/PitcherBasic/Basic1.aspx',
  teamHit1: '/Record/Team/Hitter/Basic1.aspx',
  teamHit2: '/Record/Team/Hitter/Basic2.aspx',
  teamPit1: '/Record/Team/Pitcher/Basic1.aspx',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const warn = (m) => console.warn('  ! ' + m);

/* ---------- HTTP (쿠키 유지, 재시도) ---------- */
const jar = new Map();
function storeCookies(res) {
  const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of sc) {
    const kv = c.split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

async function http(url, opts = {}, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      if (Date.now() - START > MAX_MS) throw new Error(`전체 실행 시간 ${Math.round(MAX_MS / 60000)}분을 넘겨 중단합니다`);
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT),
        ...opts,
        headers: {
          'user-agent': UA,
          'accept-language': 'ko,en;q=0.8',
          ...(BROWSERISH ? { origin: BASE, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } : {}),
          ...(jar.size ? { cookie: cookieHeader() } : {}),
          ...(opts.headers || {}),
        },
      });
      storeCookies(res);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const t = await res.text();
      await sleep(DELAY);
      return t;
    } catch (e) {
      const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError' || e.cause?.name === 'TimeoutError';
      const why = e.cause?.code || e.cause?.message || '';
      const msg = timedOut ? `응답 없음(${Math.round(TIMEOUT / 1000)}초 초과)` : (why ? `${e.message} (${why})` : e.message);
      if (i >= tries || /전체 실행 시간/.test(msg)) throw new Error(`${url} → ${msg}`);
      warn(`${url} 다시 시도합니다 (${i}/${tries - 1}): ${msg}`);
      await sleep(1000 * i);
    }
  }
}
const post = (url, fields) =>
  http(url, {
    method: 'POST',
    body: new URLSearchParams(fields).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', referer: url },
  });

/* ---------- HTML 파싱 (정규식, 의존성 없음) ---------- */
const decode = (s) =>
  s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
const text = (s) => decode(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
const attr = (tag, name) => {
  const m = tag.match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i'));
  return m ? decode(m[1] ?? m[2]) : null;
};

function formFields(html) {
  const f = {};
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const t = m[0];
    const name = attr(t, 'name');
    if (!name) continue;
    const type = (attr(t, 'type') || 'text').toLowerCase();
    if (/\bdisabled\b/i.test(t)) continue;
    if (['submit', 'button', 'image', 'file', 'reset'].includes(type)) continue;
    if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/i.test(t)) continue;
    f[name] = attr(t, 'value') ?? '';
  }
  for (const m of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = attr(m[1], 'name');
    if (!name || /\bdisabled\b/i.test(m[1])) continue;
    let sel = null, first = null, count = 0;
    for (const o of m[2].matchAll(/<option\b([^>]*)>/gi)) {
      const v = attr(o[1], 'value');
      count++;
      if (first === null) first = v;
      if (/\bselected\b/i.test(o[1])) sel = v;
    }
    if (!count) continue; // 항목이 하나도 없는 선택 상자는 브라우저도 보내지 않습니다
    f[name] = sel ?? first ?? '';
  }
  return f;
}

function findSelect(html, nameRe) {
  for (const m of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = attr(m[1], 'name');
    if (!name || !nameRe.test(name)) continue;
    const values = [], options = [];
    let selected = null;
    for (const o of m[2].matchAll(/<option\b([^>]*)>([^<]*)/gi)) {
      const label = text(o[2]);
      const v = attr(o[1], 'value') ?? label;
      values.push(v);
      options.push({ value: v, label });
      if (/\bselected\b/i.test(o[1])) selected = v;
    }
    return { name, values, options, selected: selected ?? values[0] };
  }
  return null;
}

function parseTable(html) {
  for (const tm of html.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const t = tm[0];
    const headers = [...t.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => text(m[1]));
    if (!headers.some((h) => h === '선수명' || h === '팀명')) continue;
    const rows = [];
    for (const rm of t.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const raw = [...rm[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
      if (!raw.length) continue;
      const pid = (raw.join(' ').match(/playerId=(\d+)/i) || [])[1] || null;
      rows.push({ cells: raw.map(text), pid });
    }
    return { headers, rows };
  }
  return null;
}

function pagerLinks(html) {
  const links = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(m[1], 'href') || '';
    const pm = href.match(/__doPostBack\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]\s*\)/);
    if (pm) links.push({ target: pm[1], arg: pm[2], label: text(m[2]) });
  }
  return links;
}

// 표의 한 행을 {머리글: 값} 으로 바꿉니다. '합계' 행은 앞 두 칸(순위, 팀명)이 합쳐져 있습니다.
function toObj(headers, row) {
  let hs = headers, cells = row.cells, total = false;
  if (cells[0] === '합계') {
    total = true;
    hs = headers.filter((h) => h !== '순위' && h !== '팀명');
    cells = cells.slice(1);
  }
  const o = {};
  hs.forEach((h, i) => { o[h] = cells[i]; });
  return { o, total, pid: row.pid };
}

/* ---------- 표 가져오기: 시즌 선택 + 쪽 넘기기 ---------- */
// 사이트가 돌려준 페이지가 어떤 모습인지 한 줄로 설명합니다(실패 원인 확인용).
function describe(html) {
  const t = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const s = findSelect(html, /ddlSeason/i);
  const plain = text(html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')).slice(0, 160);
  const ser = findSelect(html, /ddlSeries/i);
  const serLabel = ser ? (ser.options.find((o) => o.value === ser.selected) || {}).label : null;
  const tb = parseTable(html);
  return `길이 ${html.length}자 / 제목 "${t ? text(t) : ''}" / 시즌 상자 ${s ? `있음(선택 ${s.selected}, 항목 ${s.values.length}개)` : '없음'} / 시리즈 ${ser ? `선택 "${serLabel}" (항목: ${ser.options.map((o) => o.label).join(', ')})` : '없음'} / 표 ${tb ? `있음(행 ${tb.rows.length}개)` : '없음'} / 본문 앞부분 "${plain}"`;
}

// 폼이 실제로 보내는 주소(action). 정렬 조건이 주소 뒤에 붙어 있으면 그대로 유지하려고 사용합니다.
function formPostUrl(html, url) {
  for (const m of html.matchAll(/<form\b[^>]*>/gi)) {
    const act = attr(m[0], 'action');
    if (act) { try { return new URL(act, url).href; } catch { /* 무시 */ } }
  }
  return url;
}

// 페이지를 열고 원하는 시즌(정규시즌)이 선택된 상태의 HTML을 돌려줍니다. 없는 시즌이면 null.
async function openSeason(pathq, season, { force = false } = {}) {
  const url = BASE + pathq;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt >= 2) BROWSERISH = true;
    jar.clear(); // 표를 열 때마다 새 세션으로 시작
    const html = await http(url);
    const postUrl = formPostUrl(html, url);
    const sel = findSelect(html, /ddlSeason/i);
    if (!sel) throw new Error(`${pathq}: 시즌 선택 상자를 찾지 못했습니다. 받은 페이지: ${describe(html)}`);
    if (!sel.values.includes(String(season))) return null;
    const ser = findSelect(html, /ddlSeries/i);
    const reg = ser && ser.options.find((o) => /정규/.test(o.label));
    const needSeries = !!(reg && ser.selected !== reg.value); // 기본 화면이 포스트시즌 등일 때 정규시즌으로 맞춤
    const needSeason = sel.selected !== String(season);
    if (!needSeason && !needSeries && !force) return { html, postUrl };
    const f = formFields(html);
    f[sel.name] = String(season);
    if (needSeries) f[ser.name] = reg.value;
    f.__EVENTTARGET = needSeason || !needSeries ? sel.name : ser.name;
    f.__EVENTARGUMENT = '';
    const res = await post(postUrl, f);
    const after = findSelect(res, /ddlSeason/i);
    const afterSer = findSelect(res, /ddlSeries/i);
    const okSeason = !!after && after.selected === String(season);
    const okSeries = !needSeries || (!!afterSer && afterSer.selected === reg.value);
    if (okSeason && okSeries) return { html: res, postUrl: formPostUrl(res, postUrl) };
    const names = Object.keys(f).map((k) => k.replace(/^ctl00\$ctl00\$ctl00\$cphContents\$cphContents\$cphContents\$/, '')).join(', ');
    warn(`${pathq}: ${season} 시즌 선택이 안 바뀜 (시도 ${attempt}/3). 받은 페이지: ${describe(res)}${attempt === 1 ? ` / 보낸 필드: ${names}` : ''}`);
    await sleep(RETRY_MS * attempt);
  }
  throw new Error(`${pathq}: ${season} 시즌으로 바뀌지 않았습니다. 위의 '받은 페이지' 설명을 확인하세요.`);
}

async function scrapeTable(pathq, season, { paged }) {
  const opened = await openSeason(pathq, season);
  if (opened === null) return null;
  let { html, postUrl } = opened;

  const rows = [];
  const seen = new Set();
  let headers = null;
  const take = (h) => {
    const tb = parseTable(h);
    if (!tb) return 0;
    headers = tb.headers;
    let added = 0;
    for (const r of tb.rows) {
      const key = r.cells[0] === '합계' ? '합계' : r.pid || r.cells.slice(0, 3).join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(r);
      added++;
    }
    return added;
  };
  let first = take(html);
  if (!first) {
    warn(`${pathq}: 기본 화면에 기록 행이 없습니다. 시즌을 직접 선택해 다시 시도합니다. 받은 페이지: ${describe(html)}`);
    const again = await openSeason(pathq, season, { force: true });
    if (again) { html = again.html; postUrl = again.postUrl; first = take(html); }
  }
  if (!first) throw new Error(`${pathq}: 기록표를 찾지 못했습니다. 받은 페이지: ${describe(html)}`);

  if (paged) {
    const visited = new Set([1]);
    for (let guard = 0; guard < 120; guard++) {
      const links = pagerLinks(html);
      const nums = links.filter((l) => /^\d+$/.test(l.label) && !visited.has(+l.label)).sort((a, b) => a.label - b.label);
      let link = nums[0];
      let usedNext = false;
      if (!link) {
        link = links.find((l) => /btnNext/i.test(l.target) || l.label === '다음');
        usedNext = true;
      }
      if (!link) break;
      const f = formFields(html);
      f.__EVENTTARGET = link.target;
      f.__EVENTARGUMENT = link.arg;
      let next;
      try { next = await post(postUrl, f); }
      catch (e) { warn(`${pathq}: 쪽 넘기기 요청이 실패했습니다(${e.message}). 지금까지 읽은 ${rows.length}행만 사용합니다.`); break; }
      if (!parseTable(next)) { warn(`${pathq}: 쪽을 넘기던 중 표가 아닌 페이지를 받았습니다. 지금까지 읽은 ${rows.length}행만 사용합니다. 받은 페이지: ${describe(next)}`); break; }
      html = next;
      postUrl = formPostUrl(html, postUrl);
      const added = take(html);
      if (usedNext) visited.add(Math.max(...visited) + 1);
      else visited.add(+link.label);
      if (!added) break;
    }
  }
  console.log(`  ${pathq} ${season}: ${rows.length}행`);
  return { headers, rows };
}

// 표 머리글(PA, IP 등)의 정렬 링크에서 정렬 값을 찾습니다. 숫자 기록으로 정렬하면 규정 미달 선수도 함께 나오기를 기대합니다.
const sortKeys = new Map();
async function sortKeyFor(path, label) {
  const ck = `${path}|${label}`;
  if (sortKeys.has(ck)) return sortKeys.get(ck);
  let key = null;
  try {
    jar.clear();
    const html = await http(BASE + path);
    outer: for (const th of html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)) {
      for (const a of th[1].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
        if (text(a[2]) !== label) continue;
        const m = (attr(a[1], 'href') || '').match(/[?&]sort=([A-Za-z0-9_]+)/i);
        if (m) { key = m[1]; break outer; }
      }
    }
  } catch (e) { warn(`${path}: 정렬 링크를 찾는 중 오류: ${e.message}`); }
  sortKeys.set(ck, key);
  return key;
}

// 전체 선수 목록을 먼저 시도하고, 안 되면 기본(규정 위주) 목록으로 대신합니다.
async function scrapeList(path, season, sortLabel) {
  const key = await sortKeyFor(path, sortLabel);
  if (key) {
    try {
      const all = await scrapeTable(`${path}?sort=${key}`, season, { paged: true });
      if (all && all.rows.length) {
        console.log(`  전체 목록 사용: ${sortLabel} 기준 정렬 ${all.rows.length}행`);
        return all;
      }
    } catch (e) { warn(`전체 목록을 못 읽어 기본(규정 위주) 목록으로 대신합니다: ${e.message}`); }
  } else {
    console.log(`  ${path}: '${sortLabel}' 정렬 링크를 찾지 못해 기본(규정 위주) 목록을 사용합니다.`);
  }
  return scrapeTable(path, season, { paged: true });
}

/* ---------- 값 변환 ---------- */
const num = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};
// 이닝 표기: "170 1/3", "170 ⅓", "170.1", "1/3" 모두 아웃 수(이닝×3)로 바꿉니다.
function ipToOuts(s) {
  s = String(s ?? '').trim();
  const fr = { '⅓': 1, '⅔': 2 };
  let m = s.match(/^(\d+)?\s*(⅓|⅔)$/);
  if (m) return num(m[1]) * 3 + fr[m[2]];
  m = s.match(/^(\d+)\s+(\d)\/3$/);
  if (m) return +m[1] * 3 + +m[2];
  m = s.match(/^(\d)\/3$/);
  if (m) return +m[1];
  m = s.match(/^(\d+)\.(\d)$/);
  if (m) return +m[1] * 3 + +m[2];
  m = s.match(/^(\d+)$/);
  if (m) return +m[1] * 3;
  return 0;
}

/* ---------- 시즌별 수집 ---------- */
async function hitters(season) {
  const b1 = await scrapeList(PATH.hit1, season, 'PA');
  if (!b1) return null;

  const map = new Map();
  const idOf = (o, pid) => pid || `${o['선수명']}|${o['팀명']}`;
  for (const r of b1.rows) {
    const { o, total, pid } = toObj(b1.headers, r);
    if (total || !o['선수명']) continue;
    const id = idOf(o, pid);
    map.set(id, { id, name: o['선수명'], team: o['팀명'] || '', PA: num(o.PA), AB: num(o.AB), H: num(o.H), D2: num(o['2B']), T3: num(o['3B']), HR: num(o.HR), SF: num(o.SF), SB: 0, G: num(o.G) });
  }

  const mergeSecond = (tb, isOld) => {
    for (const r of tb.rows) {
      const { o, total, pid } = toObj(tb.headers, r);
      if (total) continue;
      const p = map.get(idOf(o, pid));
      if (!p) continue;
      p.BB = num(o.BB); p.IBB = num(o.IBB); p.HBP = num(o.HBP); p.SO = num(o.SO); p.obpT = Number(o.OBP);
      if (isOld) p.SB = num(o.SB);
    }
  };
  const ready = () => [...map.values()].filter((p) => p.BB !== undefined).length;
  const ratio = () => (map.size ? ready() / map.size : 0);
  const reset = () => { for (const p of map.values()) { p.BB = p.IBB = p.HBP = p.SO = p.obpT = undefined; } };

  let b2 = null, old = null, rn = null;
  try { b2 = await scrapeList(PATH.hit2, season, 'BB'); }
  catch (e) { warn(`세부기록 표를 못 읽었습니다: ${e.message}`); }
  if (b2) mergeSecond(b2, false);
  if (ratio() < 0.5) {
    if (b2) warn(`세부기록 표에서 선수의 ${Math.round(ratio() * 100)}%만 읽혔습니다. 옛 기본기록 표를 시도합니다.`);
    reset();
    try { old = await scrapeTable(PATH.hitOld, season, { paged: true }); }
    catch (e) { warn(`옛 기본기록 표도 못 읽었습니다: ${e.message}`); }
    if (old) { mergeSecond(old, true); console.log('  (옛 기본기록 표 사용: 고의4구와 출루율 대조는 건너뜁니다)'); }
    if (ratio() < 0.5) {
      warn(`${season} 시즌 타자는 볼넷·삼진 기록을 충분히 읽지 못해(읽은 비율 ${Math.round(ratio() * 100)}%) 건너뜁니다. 투수 기록은 계속 받습니다.`);
      return null;
    }
  } else {
    try { rn = await scrapeTable(PATH.run, season, { paged: true }); } catch (e) { warn('도루 기록을 못 읽었습니다(도루는 0으로 둡니다): ' + e.message); }
    if (rn) {
      for (const r of rn.rows) {
        const { o, total, pid } = toObj(rn.headers, r);
        if (total) continue;
        const p = map.get(idOf(o, pid));
        if (p) p.SB = num(o.SB);
      }
    }
  }
  if (ready() < map.size) warn(`타자 ${map.size}명 중 ${ready()}명만 세부 기록이 있어 그 선수들만 사용합니다.`);
  let list = [...map.values()].filter((p) => p.BB !== undefined);

  // 볼넷 칸에 고의4구가 들어 있는지 확인: 표의 출루율과 더 잘 맞는 쪽을 고릅니다.
  const err = (withIbb) => {
    let s = 0, n = 0;
    for (const p of list) {
      if (!(p.obpT > 0) || p.AB <= 0) continue;
      const bb = p.BB + (withIbb ? p.IBB : 0);
      s += Math.abs((p.H + bb + p.HBP) / (p.AB + bb + p.HBP + p.SF) - p.obpT);
      n++;
    }
    return n ? s / n : null;
  };
  const e0 = err(false), e1 = err(true);
  const useIbb = e0 !== null && e1 !== null && e1 + 1e-9 < e0;
  console.log(`  출루율 대조: BB만 ${e0 === null ? '-' : e0.toFixed(4)}, BB+IBB ${e1 === null ? '-' : e1.toFixed(4)} → ${useIbb ? 'BB+IBB' : 'BB'} 사용`);
  if (e0 !== null && Math.min(e0, e1) > 0.005) warn('계산한 출루율이 표의 출루율과 0.005 이상 어긋납니다. 열 이름이 바뀌었는지 확인하세요.');
  list = list.map((p) => ({ id: p.id, name: p.name, team: p.team, raw: { PA: p.PA, AB: p.AB, H: p.H, D2: p.D2, T3: p.T3, HR: p.HR, BB: p.BB + (useIbb ? p.IBB : 0), HBP: p.HBP, SF: p.SF, SO: p.SO, SB: p.SB, G: p.G } }));
  return { list, useIbb };
}

async function pitchers(season) {
  const b = await scrapeList(PATH.pit1, season, 'IP');
  if (!b) return null;
  const out = [];
  for (const r of b.rows) {
    const { o, total, pid } = toObj(b.headers, r);
    if (total || !o['선수명']) continue;
    out.push({
      id: pid || `${o['선수명']}|${o['팀명']}`, name: o['선수명'], team: o['팀명'] || '',
      raw: { outs: ipToOuts(o.IP), SO: num(o.SO), BB: num(o.BB), HR: num(o.HR), HBP: num(o.HBP), ER: num(o.ER), H: num(o.H), G: num(o.G) },
    });
  }
  return out;
}

/* ---------- 리그 평균 (팀 기록의 합계로 계산, 실패하면 선수 합계로 대신) ---------- */
function totalOrSum(tb, keys, conv = num) {
  const rows = tb.rows.map((r) => toObj(tb.headers, r));
  const tot = rows.find((r) => r.total);
  const src = tot ? [tot.o] : rows.filter((r) => !r.total).map((r) => r.o);
  const a = {};
  for (const o of src) for (const k of keys) a[k] = (a[k] || 0) + conv(o[k], k);
  return a;
}
const sumRaw = (list, keys) => {
  const a = {};
  for (const p of list) for (const k of keys) a[k] = (a[k] || 0) + p.raw[k];
  return a;
};
const obpSlg = (a) => ({
  obp: (a.H + a.BB + a.HBP) / (a.AB + a.BB + a.HBP + a.SF),
  slg: (a.H + a.D2 + 2 * a.T3 + 3 * a.HR) / a.AB,
});
const cfipOf = (a) => {
  const ip = a.outs / 3;
  return (9 * a.ER) / ip - (13 * a.HR + 3 * (a.BB + a.HBP) - 2 * a.SO) / ip;
};

// 팀 기록표의 출루율과 대조해서, 볼넷 칸에 고의4구를 더해야 하는지 판단합니다(판단 불가면 null).
function teamIbbChoice(t1, t2) {
  const m1 = new Map(t1.rows.map((r) => toObj(t1.headers, r)).filter((r) => !r.total).map((r) => [r.o['팀명'], r.o]));
  let e0 = 0, e1 = 0, n = 0;
  for (const r of t2.rows.map((x) => toObj(t2.headers, x)).filter((x) => !x.total)) {
    const o2 = r.o, o1 = m1.get(o2['팀명']);
    const obpT = Number(o2.OBP);
    if (!o1 || !(obpT > 0)) continue;
    const AB = num(o1.AB), H = num(o1.H), SF = num(o1.SF), BB = num(o2.BB), IBB = num(o2.IBB), HBP = num(o2.HBP);
    e0 += Math.abs((H + BB + HBP) / (AB + BB + HBP + SF) - obpT);
    e1 += Math.abs((H + BB + IBB + HBP) / (AB + BB + IBB + HBP + SF) - obpT);
    n++;
  }
  return n ? e1 + 1e-9 < e0 : null;
}

function checkTeamTable(tb, label) {
  const teams = tb.rows.filter((r) => r.cells[0] !== '합계');
  console.log(`  ${label} 행: ${tb.rows.map((r) => r.cells.slice(0, 2).join(':')).join(', ').slice(0, 220)}`);
  if (teams.length < 8) throw new Error(`${label}에 팀이 ${teams.length}개뿐입니다(10개여야 함). 표를 믿을 수 없습니다.`);
}

async function leagueConstants(season, hit, pit, useIbbHint) {
  const res = {};
  try {
    const t1 = await scrapeTable(PATH.teamHit1, season, { paged: false });
    const t2 = await scrapeTable(PATH.teamHit2, season, { paged: false });
    if (!t1 || !t2) throw new Error('팀 타자 표 없음');
    checkTeamTable(t1, '팀 타자 표1'); checkTeamTable(t2, '팀 타자 표2');
    const a1 = totalOrSum(t1, ['AB', 'H', '2B', '3B', 'HR', 'SF']);
    const a2 = totalOrSum(t2, ['BB', 'IBB', 'HBP']);
    const choice = teamIbbChoice(t1, t2);
    const useIbbL = choice === null ? useIbbHint : choice;
    console.log(`  팀 출루율 대조: ${choice === null ? '판단 불가(선수 표 기준 사용)' : useIbbL ? 'BB+IBB 사용' : 'BB 사용'}`);
    const a = { AB: a1.AB, H: a1.H, D2: a1['2B'], T3: a1['3B'], HR: a1.HR, SF: a1.SF, BB: a2.BB + (useIbbL ? a2.IBB : 0), HBP: a2.HBP };
    Object.assign(res, obpSlg(a));
  } catch (e) {
    warn(`리그 타격 평균을 팀 기록에서 못 읽어 선수 합계로 대신합니다: ${e.message}`);
    if (hit.length) Object.assign(res, obpSlg(sumRaw(hit, ['AB', 'H', 'D2', 'T3', 'HR', 'BB', 'HBP', 'SF'])));
  }
  try {
    const tp = await scrapeTable(PATH.teamPit1, season, { paged: false });
    if (!tp) throw new Error('팀 투수 표 없음');
    checkTeamTable(tp, '팀 투수 표');
    const a = totalOrSum(tp, ['ER', 'HR', 'BB', 'HBP', 'SO']);
    const ipTot = totalOrSum(tp, ['IP'], (v) => ipToOuts(v));
    res.cfip = cfipOf({ ...a, outs: ipTot.IP });
  } catch (e) {
    warn(`리그 투구 평균을 팀 기록에서 못 읽어 선수 합계로 대신합니다: ${e.message}`);
    if (pit.length) res.cfip = cfipOf(sumRaw(pit, ['outs', 'ER', 'HR', 'BB', 'HBP', 'SO']));
  }
  for (const k of Object.keys(res)) if (!Number.isFinite(res[k])) delete res[k];
  return res;
}

/* ---------- 실행 ---------- */
async function main() {
  console.log('스크립트 버전: v8 (전체 선수 목록, 경기 수 포함)');
  const hit = new Map(), pit = new Map(), league = {}, used = [];
  for (const season of seasons) {
    console.log(`[${season}] 받는 중… (표마다 여러 쪽을 넘기므로 1~2분 걸립니다)`);
    let hr = null, p = null;
    try { hr = await hitters(season); } catch (e) { warn(`${season} 시즌 타자 기록을 건너뜁니다: ${e.message}`); }
    try { p = await pitchers(season); } catch (e) { warn(`${season} 시즌 투수 기록을 건너뜁니다: ${e.message}`); }
    const h = hr ? hr.list : [];
    const pl = p || [];
    if (!h.length && !pl.length) { console.log(`[${season}] 읽은 기록이 없거나 시즌 선택에 없습니다. 건너뜁니다.`); continue; }
    console.log(`[${season}] 타자 ${h.length}명, 투수 ${pl.length}명`);
    league[season] = await leagueConstants(season, h, pl, hr ? hr.useIbb : false);
    const gmax = Math.max(0, ...h.map((x) => x.raw.G || 0), ...pl.map((x) => x.raw.G || 0));
    if (gmax > 0) league[season].games = gmax; // 규정 타석·이닝 계산에 쓰는 팀 경기 수(선수 최대 출장 경기)
    used.push(season);
    for (const x of h) {
      const e = hit.get(x.id) || { id: x.id, raw: {} };
      e.name = x.name; e.team = x.team || e.team || ''; e.pos = '';
      e.raw[season] = x.raw; hit.set(x.id, e);
    }
    for (const x of pl) {
      const e = pit.get(x.id) || { id: x.id, raw: {} };
      e.name = x.name; e.team = x.team || e.team || ''; e.pos = '';
      e.raw[season] = x.raw; pit.set(x.id, e);
    }
    const L = league[season];
    const f3 = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '-');
    console.log(`[${season}] 리그 평균: 출루율 ${f3(L.obp, 3)}, 장타율 ${f3(L.slg, 3)}, FIP 상수 ${f3(L.cfip, 2)}`);
  }
  if (!used.length) throw new Error('받은 데이터가 없습니다. 시즌 값이나 사이트 접속을 확인하세요.');
  const latest = (e) => Math.max(...Object.keys(e.raw).map(Number));
  const hitters_ = [...hit.values()].filter((e) => e.raw[latest(e)].PA >= MIN_PA);
  const pitchers_ = [...pit.values()].filter((e) => e.raw[latest(e)].outs / 3 >= MIN_IP);
  if (!hitters_.length && !pitchers_.length) throw new Error('기준을 넘는 선수가 없습니다. --min-pa, --min-ip 값을 낮춰 보세요.');
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ source: 'KBO 기록실(koreabaseball.com)', generatedAt: new Date().toISOString(), seasons: used, league, hitters: hitters_, pitchers: pitchers_ }));
  console.log(`저장 완료: ${OUT} (타자 ${hitters_.length}명, 투수 ${pitchers_.length}명, 시즌 ${used.join(', ')})`);
}

main().catch((e) => {
  console.error('실패:', e.message);
  process.exit(1);
});
