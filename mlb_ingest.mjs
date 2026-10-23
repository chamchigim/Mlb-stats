#!/usr/bin/env node
// MLB Stats API에서 시즌 누적 기록을 받아 웹페이지가 읽는 JSON으로 저장합니다.
// 사용법: node mlb_ingest.mjs [--seasons 2024,2025,2026] [--min-pa 200] [--min-ip 50] [--out data/mlb.json]
// 필요한 것: Node.js 18 이상 (내장 fetch 사용, 설치할 패키지 없음)

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];
}

const thisYear = new Date().getFullYear();
const seasons = (args.seasons || [thisYear - 2, thisYear - 1, thisYear].join(','))
  .split(',').map(Number).filter(Boolean).sort((a, b) => a - b);
const MIN_PA = Number(args['min-pa'] ?? 200);
const MIN_IP = Number(args['min-ip'] ?? 50);
const OUT = args.out || 'data/mlb.json';
const BASE = process.env.MLB_STATS_BASE || 'https://statsapi.mlb.com/api/v1/stats';

const n = (v) => Number(v) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i >= tries) throw new Error(url + ' → ' + e.message);
      await sleep(1000 * i);
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
// 시즌 합계 행이 있으면 그것이 가장 크므로 합계가 선택됩니다.
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
  return {
    PA: n(t.plateAppearances), AB: n(t.atBats), H: n(t.hits), D2: n(t.doubles), T3: n(t.triples),
    HR: n(t.homeRuns), BB: n(t.baseOnBalls), HBP: n(t.hitByPitch), SF: n(t.sacFlies),
    SO: n(t.strikeOuts), SB: n(t.stolenBases),
  };
};
const pitRaw = (s) => {
  const t = s.stat || {};
  return {
    outs: outsOf(t.inningsPitched), SO: n(t.strikeOuts), BB: n(t.baseOnBalls), HR: n(t.homeRuns),
    HBP: n(t.hitByPitch), ER: n(t.earnedRuns), H: n(t.hits),
  };
};

function sum(rows, keys) {
  const a = {};
  for (const r of rows) for (const k of keys) a[k] = (a[k] || 0) + r[k];
  return a;
}
function leagueHit(raws) {
  const a = sum(raws, ['AB', 'H', 'D2', 'T3', 'HR', 'BB', 'HBP', 'SF']);
  return {
    obp: (a.H + a.BB + a.HBP) / (a.AB + a.BB + a.HBP + a.SF),
    slg: (a.H + a.D2 + 2 * a.T3 + 3 * a.HR) / a.AB,
  };
}
function leaguePit(raws) {
  const a = sum(raws, ['outs', 'ER', 'HR', 'BB', 'HBP', 'SO']);
  const ip = a.outs / 3;
  const era = (9 * a.ER) / ip;
  return { cfip: era - (13 * a.HR + 3 * (a.BB + a.HBP) - 2 * a.SO) / ip };
}

const POS_KO = {
  P: '투수', C: '포수', '1B': '1루수', '2B': '2루수', '3B': '3루수', SS: '유격수',
  LF: '좌익수', CF: '중견수', RF: '우익수', DH: '지명타자', OF: '외야수', IF: '내야수',
};

async function main() {
  const league = {};
  const hit = new Map();
  const pit = new Map();
  const usedSeasons = [];

  for (const season of seasons) {
    console.log(`[${season}] 받는 중…`);
    const hs = await fetchSplits('hitting', season);
    const ps = await fetchSplits('pitching', season);
    const h = pickPerPlayer(hs, (s) => n(s.stat?.plateAppearances));
    const p = pickPerPlayer(ps, (s) => outsOf(s.stat?.inningsPitched));
    if (!h.rows.length && !p.rows.length) {
      console.log(`[${season}] 데이터 없음, 건너뜁니다.`);
      continue;
    }
    usedSeasons.push(season);
    console.log(`[${season}] 타자 ${h.rows.length}명, 투수 ${p.rows.length}명 (여러 행으로 온 선수: 타자 ${h.multi}, 투수 ${p.multi})`);

    const hraws = h.rows.map(hitRaw).filter((r) => r.AB > 0);
    const praws = p.rows.map(pitRaw).filter((r) => r.outs > 0);
    league[season] = { ...leagueHit(hraws), ...leaguePit(praws) };

    for (const s of h.rows) {
      const r = hitRaw(s);
      if (r.AB <= 0) continue;
      const id = String(s.player.id);
      const e = hit.get(id) || { id, raw: {} };
      e.name = s.player.fullName || e.name;
      e.team = s.team?.name || e.team || '';
      const ab = s.position?.abbreviation;
      e.pos = ab ? POS_KO[ab] || ab : e.pos || '';
      e.raw[season] = r;
      hit.set(id, e);
    }
    for (const s of p.rows) {
      const r = pitRaw(s);
      if (r.outs <= 0) continue;
      const id = String(s.player.id);
      const e = pit.get(id) || { id, raw: {} };
      e.name = s.player.fullName || e.name;
      e.team = s.team?.name || e.team || '';
      const gs = n(s.stat?.gamesStarted), g = n(s.stat?.gamesPitched) || n(s.stat?.gamesPlayed);
      e.pos = g && gs >= g / 2 ? '선발' : '구원';
      e.raw[season] = r;
      pit.set(id, e);
    }
  }

  if (!usedSeasons.length) throw new Error('받은 데이터가 없습니다. 시즌 값이나 네트워크를 확인하세요.');
  const last = usedSeasons[usedSeasons.length - 1];

  // 가장 최근 시즌에 기준 이상 뛴 선수만 남깁니다.
  const hitters = [...hit.values()].filter((e) => e.raw[last] && e.raw[last].PA >= MIN_PA);
  const pitchers = [...pit.values()].filter((e) => e.raw[last] && e.raw[last].outs / 3 >= MIN_IP);
  if (!hitters.length && !pitchers.length) throw new Error('기준을 넘는 선수가 없습니다. --min-pa, --min-ip 값을 낮춰 보세요.');

  const result = {
    source: 'MLB Stats API',
    generatedAt: new Date().toISOString(),
    seasons: usedSeasons,
    league,
    hitters,
    pitchers,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(result));
  console.log(`저장 완료: ${OUT} (타자 ${hitters.length}명, 투수 ${pitchers.length}명, 시즌 ${usedSeasons.join(', ')})`);
}

main().catch((e) => {
  console.error('실패:', e.message);
  process.exit(1);
});
