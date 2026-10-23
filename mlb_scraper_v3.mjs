#!/usr/bin/env node
// MLB Stats API에서 시즌 누적 기록을 받아 웹페이지가 읽는 JSON으로 저장합니다.
//
// 사용법:
//   node mlb_scraper_v3.mjs --out data/mlb.json
//        [--seasons 2024,2025,2026] [--min-pa 10] [--min-ip 5]
//        [--history-out data/mlb-history.json --history-from 1871 --history-to 2023 --history-minutes 20]
//
// 최근 시즌은 매번 새로 받고, 과거 시즌(--history-*)은 한 번 받아 두면 다음부터는 건너뜁니다.
// 시간이 모자라 중간에 멈추면 다음 실행에서 이어서 받습니다.
// 필요한 것: Node.js 18 이상 (내장 fetch 사용, 설치할 패키지 없음)

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];
}

const thisYear = new Date().getFullYear();
const seasons = (args.seasons || [thisYear - 2, thisYear - 1, thisYear].join(','))
  .split(',').map(Number).filter(Boolean).sort((a, b) => a - b);
const MIN_PA = Number(args['min-pa'] ?? 10);
const MIN_IP = Number(args['min-ip'] ?? 5);
const OUT = args.out || 'data/mlb.json';
const HOUT = args['history-out'] || '';
const HFROM = Number(args['history-from'] ?? 1871);
const HTO = Number(args['history-to'] ?? Math.min(...seasons) - 1);
const HMIN = Number(args['history-minutes'] ?? 20);
const DELAY = Number(process.env.MLB_DELAY_MS ?? 250);
const BASE = process.env.MLB_STATS_BASE || 'https://statsapi.mlb.com/api/v1/stats';

const n = (v) => Number(v) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (DELAY) await sleep(DELAY);
      return j;
    } catch (e) {
      if (i >= tries) throw new Error(url + ' → ' + e.message);
      await sleep(1500 * i);
    }
  }
}

async function fetchSplits(group, season) {
  const out = [];
  const limit = 2000;
  let offset = 0;
  let firstId = null;
  for (let page = 0; page < 10; page++) {
    const url = `${BASE}?stats=season&group=${group}&season=${season}&sportId=1&playerPool=ALL&limit=${limit}&offset=${offset}`;
    const j = await getJson(url);
    const sp = j.stats?.[0]?.splits ?? [];
    if (!sp.length) break;
    const id = sp[0].player?.id;
    if (page > 0 && id === firstId) break; // offset을 무시하는 경우 같은 페이지가 반복되는 것을 막음
    if (page === 0) firstId = id;
    out.push(...sp);
    if (sp.length < limit) break;
    offset += limit;
  }
  return out;
}

// 한 선수가 여러 행으로 오면(이적 등) 기록이 가장 큰 행을 고릅니다.
function pickPerPlayer(splits, score) {
  const m = new Map();
  let multi = 0;
  for (const s of splits) {
    const id = s.player?.id;
    if (!id) continue;
    const prev = m.get(id);
    if (prev) multi++;
    if (!prev || score(s) > score(prev)) m.set(id, s);
  }
  return { rows: [...m.values()], multi };
}

const outsOf = (ip) => {
  const [w, f = '0'] = String(ip ?? '0').split('.');
  return n(w) * 3 + n(f);
};
const hitRaw = (s) => {
  const t = s.stat || {};
  const AB = n(t.atBats), BB = n(t.baseOnBalls), HBP = n(t.hitByPitch), SF = n(t.sacFlies), SH = n(t.sacBunts);
  let PA = n(t.plateAppearances);
  if (!PA) PA = AB + BB + HBP + SF + SH; // 옛 시즌은 타석 수가 없어 직접 계산
  return {
    PA, AB, H: n(t.hits), D2: n(t.doubles), T3: n(t.triples), HR: n(t.homeRuns), BB, HBP, SF,
    SO: n(t.strikeOuts), SB: n(t.stolenBases), G: n(t.gamesPlayed), T: s.team?.name || '',
  };
};
const pitRaw = (s) => {
  const t = s.stat || {};
  return {
    outs: outsOf(t.inningsPitched), SO: n(t.strikeOuts), BB: n(t.baseOnBalls), HR: n(t.homeRuns),
    HBP: n(t.hitByPitch), ER: n(t.earnedRuns), H: n(t.hits), G: n(t.gamesPitched) || n(t.gamesPlayed), T: s.team?.name || '',
  };
};

const sumOf = (rows, keys) => {
  const a = {};
  for (const r of rows) for (const k of keys) a[k] = (a[k] || 0) + (r[k] || 0);
  return a;
};
function leagueOf(hraws, praws) {
  const out = {};
  const a = sumOf(hraws, ['AB', 'H', 'D2', 'T3', 'HR', 'BB', 'HBP', 'SF']);
  if (a.AB > 0) {
    out.obp = (a.H + a.BB + a.HBP) / (a.AB + a.BB + a.HBP + a.SF);
    out.slg = (a.H + a.D2 + 2 * a.T3 + 3 * a.HR) / a.AB;
  }
  const b = sumOf(praws, ['outs', 'ER', 'HR', 'BB', 'HBP', 'SO']);
  if (b.outs > 0 && b.ER > 0 && b.SO > 0) { // 자책점·삼진이 기록되지 않은 시즌은 FIP 상수를 계산하지 않음
    const ip = b.outs / 3;
    out.cfip = (9 * b.ER) / ip - (13 * b.HR + 3 * (b.BB + b.HBP) - 2 * b.SO) / ip;
  }
  out.games = Math.max(0, ...hraws.map((r) => r.G), ...praws.map((r) => r.G));
  for (const k of Object.keys(out)) if (!Number.isFinite(out[k])) delete out[k];
  return out;
}

const POS_KO = {
  P: '투수', C: '포수', '1B': '1루수', '2B': '2루수', '3B': '3루수', SS: '유격수',
  LF: '좌익수', CF: '중견수', RF: '우익수', DH: '지명타자', OF: '외야수', IF: '내야수',
};

// 한 시즌을 받아서 {hit: [...], pit: [...], lg} 로 돌려줍니다. 기록이 없으면 null.
async function loadSeason(season) {
  const hs = await fetchSplits('hitting', season);
  const ps = await fetchSplits('pitching', season);
  const h = pickPerPlayer(hs, (s) => n(s.stat?.plateAppearances) || n(s.stat?.atBats));
  const p = pickPerPlayer(ps, (s) => outsOf(s.stat?.inningsPitched));
  if (!h.rows.length && !p.rows.length) return null;

  const hitPairs = h.rows.map((s) => [s, hitRaw(s)]).filter(([, r]) => r.AB > 0);
  const pitPairs = p.rows.map((s) => [s, pitRaw(s)]).filter(([, r]) => r.outs > 0);
  const lg = leagueOf(hitPairs.map((x) => x[1]), pitPairs.map((x) => x[1]));

  // 그 시즌에 아예 기록되지 않은 항목은 '없음(null)'으로 표시합니다(0으로 두면 잘못된 정보가 됩니다).
  const missing = [];
  const none = (pairs, key) => pairs.length > 0 && pairs.every(([, r]) => !r[key]);
  if (none(hitPairs, 'SO')) { hitPairs.forEach(([, r]) => { r.SO = null; }); missing.push('타자 삼진'); }
  if (none(hitPairs, 'SB')) { hitPairs.forEach(([, r]) => { r.SB = null; }); missing.push('도루'); }
  if (none(pitPairs, 'SO')) { pitPairs.forEach(([, r]) => { r.SO = null; }); missing.push('투수 삼진'); }
  if (none(pitPairs, 'ER')) { pitPairs.forEach(([, r]) => { r.ER = null; }); missing.push('자책점'); }

  const hit = hitPairs.filter(([, r]) => r.PA >= MIN_PA).map(([s, r]) => ({
    id: String(s.player.id), name: s.player.fullName || '', team: s.team?.name || '',
    pos: s.position?.abbreviation ? POS_KO[s.position.abbreviation] || s.position.abbreviation : '', raw: r,
  }));
  const pit = pitPairs.filter(([, r]) => r.outs / 3 >= MIN_IP).map(([s, r]) => {
    const gs = n(s.stat?.gamesStarted), g = n(s.stat?.gamesPitched) || n(s.stat?.gamesPlayed);
    return { id: String(s.player.id), name: s.player.fullName || '', team: s.team?.name || '', pos: g && gs >= g / 2 ? '선발' : '구원', raw: r };
  });
  return { hit, pit, lg, multi: [h.multi, p.multi], missing };
}

// 시즌별 결과를 선수 단위로 합칩니다.
function addSeason(ds, season, r) {
  ds.league[season] = r.lg;
  if (!ds.seasons.includes(season)) ds.seasons.push(season);
  const put = (map, rows) => {
    for (const x of rows) {
      const e = map.get(x.id) || { id: x.id, name: x.name, team: x.team, pos: x.pos, raw: {} };
      // 가장 최근 시즌의 이름·팀·포지션을 대표값으로 씁니다.
      const latest = Math.max(...Object.keys(e.raw).map(Number), -1);
      if (season >= latest) { e.name = x.name || e.name; e.team = x.team || e.team; e.pos = x.pos || e.pos; }
      e.raw[season] = x.raw;
      map.set(x.id, e);
    }
  };
  put(ds._h, r.hit);
  put(ds._p, r.pit);
}

function newDs() {
  return { source: 'MLB Stats API', generatedAt: '', seasons: [], empty: [], league: {}, hitters: [], pitchers: [], _h: new Map(), _p: new Map() };
}
function fromJson(j) {
  const ds = newDs();
  ds.seasons = (j.seasons || []).map(Number);
  ds.empty = (j.empty || []).map(Number);
  ds.league = j.league || {};
  for (const e of j.hitters || []) ds._h.set(String(e.id), e);
  for (const e of j.pitchers || []) ds._p.set(String(e.id), e);
  return ds;
}
function toJson(ds) {
  return {
    source: ds.source, generatedAt: new Date().toISOString(),
    seasons: [...ds.seasons].sort((a, b) => a - b), empty: [...ds.empty].sort((a, b) => a - b),
    league: ds.league, hitters: [...ds._h.values()], pitchers: [...ds._p.values()],
  };
}

async function save(path, ds) {
  await mkdir(dirname(path), { recursive: true });
  const text = JSON.stringify(toJson(ds));
  await writeFile(path, text);
  return text.length;
}

async function main() {
  console.log('MLB 수집 스크립트 v3 (최근 시즌 + 과거 전체, 시즌별 소속팀)');

  // 1) 최근 시즌: 매번 새로 받습니다.
  const recent = newDs();
  for (const season of seasons) {
    console.log(`[${season}] 받는 중…`);
    const r = await loadSeason(season);
    if (!r) { console.log(`[${season}] 데이터 없음, 건너뜁니다.`); continue; }
    addSeason(recent, season, r);
    console.log(`[${season}] 타자 ${r.hit.length}명, 투수 ${r.pit.length}명 (여러 행으로 온 선수: 타자 ${r.multi[0]}, 투수 ${r.multi[1]})`);
  }
  if (!recent.seasons.length) throw new Error('받은 데이터가 없습니다. 시즌 값이나 네트워크를 확인하세요.');
  if (!recent._h.size && !recent._p.size) throw new Error('기준을 넘는 선수가 없습니다. --min-pa, --min-ip 값을 낮춰 보세요.');
  const bytes = await save(OUT, recent);
  console.log(`저장 완료: ${OUT} (타자 ${recent._h.size}명, 투수 ${recent._p.size}명, 시즌 ${recent.seasons.join(', ')}, ${(bytes / 1e6).toFixed(1)}MB)`);

  // 2) 과거 시즌: 한 번 받아 두면 다음부터는 건너뛰고, 중간에 멈추면 이어서 받습니다.
  if (!HOUT) return;
  let hist = newDs();
  try { hist = fromJson(JSON.parse(await readFile(HOUT, 'utf8'))); console.log(`과거 기록 파일 확인: 이미 ${hist.seasons.length}개 시즌`); }
  catch { console.log('과거 기록 파일이 아직 없습니다. 처음부터 받습니다.'); }
  const done = new Set([...hist.seasons, ...hist.empty]);
  const todo = [];
  for (let y = HTO; y >= HFROM; y--) if (!done.has(y)) todo.push(y); // 최근 시즌부터 거슬러 올라갑니다
  if (!todo.length) { console.log(`과거 기록(${HFROM}~${HTO})은 이미 모두 받았습니다. 건너뜁니다.`); return; }
  console.log(`과거 기록: ${todo.length}개 시즌을 받아야 합니다(${todo[0]} → ${todo[todo.length - 1]}), 제한 시간 ${HMIN}분`);

  const t0 = Date.now();
  let got = 0;
  for (const y of todo) {
    if (Date.now() - t0 > HMIN * 60000) { console.log(`제한 시간(${HMIN}분)이 되어 여기서 멈춥니다. 남은 시즌은 다음 실행에서 이어서 받습니다.`); break; }
    try {
      const r = await loadSeason(y);
      if (!r) { hist.empty.push(y); console.log(`[${y}] 데이터 없음`); continue; }
      addSeason(hist, y, r);
      got++;
      console.log(`[${y}] 타자 ${r.hit.length}명, 투수 ${r.pit.length}명${r.missing.length ? ` (기록 없는 항목: ${r.missing.join(', ')})` : ''}`);
    } catch (e) {
      console.warn(`[${y}] 실패, 건너뜁니다: ${e.message}`);
    }
  }
  const hb = await save(HOUT, hist);
  console.log(`과거 기록 저장 완료: ${HOUT} (시즌 ${hist.seasons.length}개, 이번에 ${got}개 추가, 타자 ${hist._h.size}명, 투수 ${hist._p.size}명, ${(hb / 1e6).toFixed(1)}MB)`);
}

main().catch((e) => {
  console.error('실패:', e.message);
  process.exit(1);
});
