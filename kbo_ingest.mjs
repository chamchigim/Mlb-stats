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
const MIN_PA = Number(args['min-pa'] ?? 150);
const MIN_IP = Number(args['min-ip'] ?? 40);
const OUT = args.out || 'data/kbo.json';
const BASE = process.env.KBO_BASE || 'https://www.koreabaseball.com';
const DELAY = Number(process.env.KBO_DELAY_MS ?? 1500);
const RETRY_MS = Number(process.env.KBO_RETRY_MS ?? 3000);
const UA = 'kbo-stats-personal/1.0 (personal, low-volume; contact via GitHub repo)';
const TIMEOUT = Number(process.env.KBO_TIMEOUT_MS ?? 30000);   // 요청 하나가 이 시간(ms) 안에 안 끝나면 중단
const MAX_MS = Number(process.env.KBO_MAX_MS ?? 8 * 60 * 1000); // 전체 실행 시간 상한
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
    if (['submit', 'button', 'image', 'file', 'reset'].includes(type)) continue;
    if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/i.test(t)) continue;
    f[name] = attr(t, 'value') ?? '';
  }
  for (const m of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = attr(m[1], 'name');
    if (!name) continue;
    let sel = null, first = null;
    for (const o of m[2].matchAll(/<option\b([^>]*)>/gi)) {
      const v = attr(o[1], 'value');
      if (first === null) first = v;
      if (/\bselected\b/i.test(o[1])) sel = v;
    }
    f[name] = sel ?? first ?? '';
  }
  return f;
}

function findSelect(html, nameRe) {
  for (const m of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = attr(m[1], 'name');
    if (!name || !nameRe.test(name)) continue;
    const values = [];
    let selected = null;
    for (const o of m[2].matchAll(/<option\b([^>]*)>/gi)) {
      const v = attr(o[1], 'value');
      values.push(v);
      if (/\bselected\b/i.test(o[1])) selected = v;
    }
    return { name, values, selected: selected ?? values[0] };
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
  return `길이 ${html.length}자 / 제목 "${t ? text(t) : ''}" / 시즌 상자 ${s ? `있음(선택 ${s.selected}, 항목 ${s.values.length}개)` : '없음'} / 표 ${parseTable(html) ? '있음' : '없음'} / 본문 앞부분 "${plain}"`;
}

// 페이지를 열고 원하는 시즌이 선택된 상태의 HTML을 돌려줍니다. 없는 시즌이면 null.
async function openSeason(path, season) {
  const url = BASE + path;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt >= 2) BROWSERISH = true;
    jar.clear(); // 표를 열 때마다 새 세션으로 시작
    const html = await http(url);
    const sel = findSelect(html, /ddlSeason/i);
    if (!sel) throw new Error(`${path}: 시즌 선택 상자를 찾지 못했습니다. 받은 페이지: ${describe(html)}`);
    if (!sel.values.includes(String(season))) return null;
    if (sel.selected === String(season)) return html;
    const f = formFields(html);
    f[sel.name] = String(season);
    f.__EVENTTARGET = sel.name;
    f.__EVENTARGUMENT = '';
    const res = await post(url, f);
    const after = findSelect(res, /ddlSeason/i);
    if (after && after.selected === String(season)) return res;
    warn(`${path}: ${season} 시즌으로 안 바뀜 (시도 ${attempt}/3). 받은 페이지: ${describe(res)}`);
    await sleep(RETRY_MS * attempt);
  }
  throw new Error(`${path}: ${season} 시즌으로 바뀌지 않았습니다. 위의 '받은 페이지' 설명을 확인하세요.`);
}

async function scrapeTable(path, season, { paged }) {
  const url = BASE + path;
  let html = await openSeason(path, season);
  if (html === null) return null;

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
  if (!take(html)) throw new Error(`${path}: 기록표를 찾지 못했습니다.`);

  if (paged) {
    const visited = new Set([1]);
    for (let guard = 0; guard < 80; guard++) {
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
      html = await post(url, f);
      if (!parseTable(html)) throw new Error(`${path}: 쪽을 넘기던 중 표가 아닌 페이지를 받았습니다(읽은 행 ${rows.length}개). 받은 페이지: ${describe(html)}`);
      const added = take(html);
      if (usedNext) visited.add(Math.max(...visited) + 1);
      else visited.add(+link.label);
      if (!added) break;
    }
  }
  console.log(`  ${path} ${season}: ${rows.length}행`);
  return { headers, rows };
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
  const b1 = await scrapeTable(PATH.hit1, season, { paged: true });
  if (!b1) return null;

  const map = new Map();
  const idOf = (o, pid) => pid || `${o['선수명']}|${o['팀명']}`;
  for (const r of b1.rows) {
    const { o, total, pid } = toObj(b1.headers, r);
    if (total || !o['선수명']) continue;
    const id = idOf(o, pid);
    map.set(id, { id, name: o['선수명'], team: o['팀명'] || '', PA: num(o.PA), AB: num(o.AB), H: num(o.H), D2: num(o['2B']), T3: num(o['3B']), HR: num(o.HR), SF: num(o.SF), SB: 0 });
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
  const coverage = () => (map.size ? [...map.values()].filter((p) => p.BB !== undefined).length / map.size : 0);

  let b2 = null, old = null, rn = null;
  try { b2 = await scrapeTable(PATH.hit2, season, { paged: true }); }
  catch (e) { warn(`세부기록 표를 못 읽어 옛 기본기록 표로 대신합니다: ${e.message}`); }
  if (b2) mergeSecond(b2, false);
  if (!b2 || coverage() < 0.8) {
    if (b2) warn(`세부기록 표에서 선수의 ${Math.round(coverage() * 100)}%만 읽혀 옛 기본기록 표로 대신합니다.`);
    for (const p of map.values()) { p.BB = p.IBB = p.HBP = p.SO = p.obpT = undefined; }
    old = await scrapeTable(PATH.hitOld, season, { paged: true });
    if (!old) throw new Error(`${PATH.hit2}, ${PATH.hitOld}: ${season} 시즌 표가 없습니다.`);
    console.log('  (옛 기본기록 표 사용: 고의4구와 출루율 대조는 건너뜁니다)');
    mergeSecond(old, true);
    if (coverage() < 0.8) throw new Error(`옛 기본기록 표에서도 선수의 ${Math.round(coverage() * 100)}%만 읽혔습니다. 기록을 믿을 수 없어 중단합니다.`);
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
  list = list.map((p) => ({ id: p.id, name: p.name, team: p.team, raw: { PA: p.PA, AB: p.AB, H: p.H, D2: p.D2, T3: p.T3, HR: p.HR, BB: p.BB + (useIbb ? p.IBB : 0), HBP: p.HBP, SF: p.SF, SO: p.SO, SB: p.SB } }));
  return { list, useIbb };
}

async function pitchers(season) {
  const b = await scrapeTable(PATH.pit1, season, { paged: true });
  if (!b) return null;
  const out = [];
  for (const r of b.rows) {
    const { o, total, pid } = toObj(b.headers, r);
    if (total || !o['선수명']) continue;
    out.push({
      id: pid || `${o['선수명']}|${o['팀명']}`, name: o['선수명'], team: o['팀명'] || '',
      raw: { outs: ipToOuts(o.IP), SO: num(o.SO), BB: num(o.BB), HR: num(o.HR), HBP: num(o.HBP), ER: num(o.ER), H: num(o.H) },
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

async function leagueConstants(season, hit, pit, useIbbHint) {
  const res = {};
  try {
    const t1 = await scrapeTable(PATH.teamHit1, season, { paged: false });
    const t2 = await scrapeTable(PATH.teamHit2, season, { paged: false });
    if (!t1 || !t2) throw new Error('팀 타자 표 없음');
    const a1 = totalOrSum(t1, ['AB', 'H', '2B', '3B', 'HR', 'SF']);
    const a2 = totalOrSum(t2, ['BB', 'IBB', 'HBP']);
    const choice = teamIbbChoice(t1, t2);
    const useIbbL = choice === null ? useIbbHint : choice;
    console.log(`  팀 출루율 대조: ${choice === null ? '판단 불가(선수 표 기준 사용)' : useIbbL ? 'BB+IBB 사용' : 'BB 사용'}`);
    const a = { AB: a1.AB, H: a1.H, D2: a1['2B'], T3: a1['3B'], HR: a1.HR, SF: a1.SF, BB: a2.BB + (useIbbL ? a2.IBB : 0), HBP: a2.HBP };
    Object.assign(res, obpSlg(a));
  } catch (e) {
    warn(`리그 타격 평균을 팀 기록에서 못 읽어 선수 합계로 대신합니다: ${e.message}`);
    Object.assign(res, obpSlg(sumRaw(hit, ['AB', 'H', 'D2', 'T3', 'HR', 'BB', 'HBP', 'SF'])));
  }
  try {
    const tp = await scrapeTable(PATH.teamPit1, season, { paged: false });
    if (!tp) throw new Error('팀 투수 표 없음');
    const a = totalOrSum(tp, ['ER', 'HR', 'BB', 'HBP', 'SO']);
    const ipTot = totalOrSum(tp, ['IP'], (v) => ipToOuts(v));
    res.cfip = cfipOf({ ...a, outs: ipTot.IP });
  } catch (e) {
    warn(`리그 투구 평균을 팀 기록에서 못 읽어 선수 합계로 대신합니다: ${e.message}`);
    res.cfip = cfipOf(sumRaw(pit, ['outs', 'ER', 'HR', 'BB', 'HBP', 'SO']));
  }
  return res;
}

/* ---------- 실행 ---------- */
async function main() {
  const hit = new Map(), pit = new Map(), league = {}, used = [];
  for (const season of seasons) {
    console.log(`[${season}] 받는 중… (표마다 여러 쪽을 넘기므로 1~2분 걸립니다)`);
    const hr = await hitters(season);
    const p = hr ? await pitchers(season) : null;
    if (!hr || !p) { console.log(`[${season}] 기록이 없거나 시즌 선택에 없습니다. 건너뜁니다.`); continue; }
    const h = hr.list;
    console.log(`[${season}] 타자 ${h.length}명, 투수 ${p.length}명`);
    if (!h.length || !p.length) { warn('한쪽 표가 비어 있어 이 시즌은 건너뜁니다.'); continue; }
    league[season] = await leagueConstants(season, h, p, hr.useIbb);
    used.push(season);
    for (const x of h) {
      const e = hit.get(x.id) || { id: x.id, raw: {} };
      e.name = x.name; e.team = x.team || e.team || ''; e.pos = '';
      e.raw[season] = x.raw; hit.set(x.id, e);
    }
    for (const x of p) {
      const e = pit.get(x.id) || { id: x.id, raw: {} };
      e.name = x.name; e.team = x.team || e.team || ''; e.pos = '';
      e.raw[season] = x.raw; pit.set(x.id, e);
    }
    const L = league[season];
    console.log(`[${season}] 리그 평균: 출루율 ${L.obp.toFixed(3)}, 장타율 ${L.slg.toFixed(3)}, FIP 상수 ${L.cfip.toFixed(2)}`);
  }
  if (!used.length) throw new Error('받은 데이터가 없습니다. 시즌 값이나 사이트 접속을 확인하세요.');
  const last = used[used.length - 1];
  const hitters_ = [...hit.values()].filter((e) => e.raw[last] && e.raw[last].PA >= MIN_PA);
  const pitchers_ = [...pit.values()].filter((e) => e.raw[last] && e.raw[last].outs / 3 >= MIN_IP);
  if (!hitters_.length && !pitchers_.length) throw new Error('기준을 넘는 선수가 없습니다. --min-pa, --min-ip 값을 낮춰 보세요.');
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ source: 'KBO 기록실(koreabaseball.com)', generatedAt: new Date().toISOString(), seasons: used, league, hitters: hitters_, pitchers: pitchers_ }));
  console.log(`저장 완료: ${OUT} (타자 ${hitters_.length}명, 투수 ${pitchers_.length}명, 시즌 ${used.join(', ')})`);
}

main().catch((e) => {
  console.error('실패:', e.message);
  process.exit(1);
});
