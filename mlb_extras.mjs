#!/usr/bin/env node
// MLB 연도별 순위, 포스트시즌 시리즈 결과, 신인 드래프트를 받아서 JSON으로 저장합니다.
//
// 사용법:
//   node mlb_extras.mjs --seasons-out data/mlb-seasons.json --draft-out data/mlb-draft.json
//        [--from 1871] [--post-from 1903] [--draft-from 1965] [--refresh 2] [--minutes 12]
//
// 최근 몇 시즌(--refresh)은 매번 새로 받고, 나머지는 한 번 받아 두면 건너뜁니다.
// 시간이 모자라 멈추면 다음 실행에서 이어서 받습니다.
// 필요한 것: Node.js 18 이상 (내장 fetch 사용, 설치할 패키지 없음)
//
// 주의: MLB 통계 API의 응답 형태를 제 쪽에서 직접 확인하지 못한 채 만든 스크립트입니다.
// 항목 이름이 다르면 그 시즌은 "비어 있음"으로 기록되고 로그에 이유가 남습니다.

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];

const thisYear = new Date().getFullYear();
const SOUT = args['seasons-out'] || 'data/mlb-seasons.json';
const DOUT = args['draft-out'] || 'data/mlb-draft.json';
const FROM = Number(args.from ?? 1871);
const POST_FROM = Number(args['post-from'] ?? 1903);
const DRAFT_FROM = Number(args['draft-from'] ?? 1965);
const REFRESH = Number(args.refresh ?? 2);
const MINUTES = Number(args.minutes ?? 12);
const DELAY = Number(process.env.MLB_DELAY_MS ?? 250);
const API = process.env.MLB_API_BASE || 'https://statsapi.mlb.com/api/v1';

const n = (v) => Number(v) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const timeUp = () => Date.now() - t0 > MINUTES * 60000;

async function getJson(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (r.status === 404 || r.status === 400) return { __status: r.status };
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

const LEAGUE_BY_ID = { 103: 'American League', 104: 'National League' };
const DIV_BY_ID = { 200: 'AL West', 201: 'AL East', 202: 'AL Central', 203: 'NL West', 204: 'NL East', 205: 'NL Central' };

/* ---------- 순위 ---------- */
function parseStandings(j) {
  const out = [];
  for (const rec of j.records || []) {
    const lg = rec.league?.name || LEAGUE_BY_ID[rec.league?.id] || '';
    const dv = rec.division?.name || DIV_BY_ID[rec.division?.id] || '';
    const teams = (rec.teamRecords || []).map((t) => ({
      n: t.team?.name || '',
      w: n(t.wins), l: n(t.losses),
      pct: String(t.winningPercentage ?? ''),
      gb: String(t.gamesBack ?? ''),
      rank: n(t.divisionRank) || n(t.leagueRank) || 0,
      lr: n(t.leagueRank) || 0,
      champ: !!t.divisionChamp,
      wc: t.wildCardRank ? n(t.wildCardRank) : 0,
    })).filter((t) => t.n);
    if (teams.length) out.push({ lg, dv, teams });
  }
  return out;
}
async function loadStandings(y) {
  for (const q of ['&hydrate=league,division,team', '']) {
    const j = await getJson(`${API}/standings?leagueId=103,104&season=${y}&standingsTypes=regularSeason${q}`);
    if (j.__status) continue;
    const s = parseStandings(j);
    if (s.length) return s;
  }
  return null;
}

/* ---------- 포스트시즌 ---------- */
const roundOrder = (d) => (/wild/i.test(d) ? 0 : /division/i.test(d) ? 1 : /championship|league/i.test(d) ? 2 : /world/i.test(d) ? 3 : 1);
function seriesFromGames(desc, games) {
  const wins = new Map();
  const names = new Set();
  let played = 0;
  for (const g of games) {
    const h = g.teams?.home, a = g.teams?.away;
    if (!h?.team?.name || !a?.team?.name) continue;
    names.add(h.team.name); names.add(a.team.name);
    let w = null;
    if (h.isWinner === true) w = h.team.name;
    else if (a.isWinner === true) w = a.team.name;
    else if (h.score != null && a.score != null && h.score !== a.score) w = h.score > a.score ? h.team.name : a.team.name;
    if (w) { wins.set(w, (wins.get(w) || 0) + 1); played++; }
  }
  if (!wins.size) return null;
  const sorted = [...wins].sort((x, y) => y[1] - x[1]);
  const winner = sorted[0][0];
  const loser = [...names].find((x) => x !== winner) || '';
  return { round: desc, ord: roundOrder(desc), w: winner, l: loser, score: `${sorted[0][1]}-${wins.get(loser) || 0}`, games: played };
}
function parsePostseason(j) {
  const out = [];
  if (Array.isArray(j.series)) {
    for (const s of j.series) {
      const info = s.series || {};
      const r = seriesFromGames(info.description || info.name || info.id || '포스트시즌', s.games || []);
      if (r) out.push(r);
    }
  } else if (Array.isArray(j.dates)) {
    const by = new Map();
    for (const d of j.dates) for (const g of d.games || []) {
      const k = g.seriesDescription || g.description || g.gameType || '포스트시즌';
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(g);
    }
    for (const [k, games] of by) { const r = seriesFromGames(k, games); if (r) out.push(r); }
  }
  return out.sort((a, b) => a.ord - b.ord);
}
async function loadPostseason(y) {
  for (const url of [`${API}/schedule/postseason/series?season=${y}&hydrate=team`, `${API}/schedule/postseason?season=${y}&hydrate=team`]) {
    const j = await getJson(url);
    if (j.__status) continue;
    const p = parsePostseason(j);
    if (p.length) return p;
  }
  return null;
}

/* ---------- 드래프트 ---------- */
const money = (v) => { const x = Number(String(v ?? '').replace(/[^0-9.]/g, '')); return x > 0 ? x : null; };
function parseDraft(j) {
  const out = [];
  for (const rd of j.drafts?.rounds || []) {
    for (const p of rd.picks || []) {
      const person = p.person || {};
      out.push({
        r: n(p.pickRound) || n(rd.round) || 0,
        p: n(p.pickNumber) || 0,
        rp: n(p.roundPickNumber) || 0,
        n: person.fullName || '',
        id: String(person.id || p.bisPlayerId || ''),
        pos: person.primaryPosition?.abbreviation || '',
        t: p.team?.name || '',
        s: p.school?.name || '',
        b: money(p.signingBonus),
      });
    }
  }
  return out.filter((x) => x.n);
}
async function loadDraft(y) {
  const j = await getJson(`${API}/draft/${y}`);
  if (j.__status) return null;
  const d = parseDraft(j);
  return d.length ? d : null;
}

/* ---------- 파일 입출력 ---------- */
async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}
async function save(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  const text = JSON.stringify(obj);
  await writeFile(path, text);
  return text.length;
}

async function main() {
  console.log('MLB 순위·포스트시즌·드래프트 수집 v1');
  const recentFrom = thisYear - REFRESH + 1;

  // 1) 시즌별 순위 + 포스트시즌
  const sf = await readJson(SOUT, { seasons: {}, empty: [] });
  sf.seasons ||= {}; sf.empty ||= [];
  const doneS = new Set([...Object.keys(sf.seasons).map(Number), ...sf.empty]);
  const todoS = [];
  for (let y = thisYear; y >= FROM; y--) if (y >= recentFrom || !doneS.has(y)) todoS.push(y);
  console.log(`순위·포스트시즌: ${todoS.length}개 시즌 처리(${todoS[0]} → ${todoS[todoS.length - 1]}), 이미 받은 시즌 ${doneS.size}개`);
  let gotS = 0, nStand = 0, nPost = 0;
  for (const y of todoS) {
    if (timeUp()) { console.log(`제한 시간(${MINUTES}분)이 되어 순위 수집을 여기서 멈춥니다. 다음 실행에서 이어서 받습니다.`); break; }
    try {
      const standings = await loadStandings(y);
      const post = y >= POST_FROM ? await loadPostseason(y) : null;
      if (!standings && !post) { if (!sf.empty.includes(y) && y < recentFrom) sf.empty.push(y); console.log(`[${y}] 순위·포스트시즌 기록 없음`); continue; }
      sf.seasons[y] = { standings: standings || [], post: post || [] };
      sf.empty = sf.empty.filter((e) => e !== y);
      gotS++; if (standings) nStand++; if (post) nPost++;
      console.log(`[${y}] 순위 ${standings ? standings.reduce((a, d) => a + d.teams.length, 0) + '개 팀' : '없음'}, 포스트시즌 ${post ? post.length + '개 시리즈' : '없음'}`);
    } catch (e) { console.warn(`[${y}] 실패, 건너뜁니다: ${e.message}`); }
  }
  sf.generatedAt = new Date().toISOString();
  const sb = await save(SOUT, sf);
  console.log(`순위 저장 완료: ${SOUT} (시즌 ${Object.keys(sf.seasons).length}개, 이번에 ${gotS}개 처리: 순위 ${nStand}, 포스트시즌 ${nPost}, ${(sb / 1e6).toFixed(2)}MB)`);

  // 2) 드래프트
  const df = await readJson(DOUT, { drafts: {}, empty: [] });
  df.drafts ||= {}; df.empty ||= [];
  const doneD = new Set([...Object.keys(df.drafts).map(Number), ...df.empty]);
  const todoD = [];
  for (let y = thisYear; y >= DRAFT_FROM; y--) if (y >= recentFrom || !doneD.has(y)) todoD.push(y);
  console.log(`드래프트: ${todoD.length}개 연도 처리(${todoD[0]} → ${todoD[todoD.length - 1]})`);
  let gotD = 0;
  for (const y of todoD) {
    if (timeUp()) { console.log(`제한 시간(${MINUTES}분)이 되어 드래프트 수집을 여기서 멈춥니다. 다음 실행에서 이어서 받습니다.`); break; }
    try {
      const d = await loadDraft(y);
      if (!d) { if (y < recentFrom && !df.empty.includes(y)) df.empty.push(y); console.log(`[${y}] 드래프트 기록 없음`); continue; }
      df.drafts[y] = d;
      df.empty = df.empty.filter((e) => e !== y);
      gotD++;
      console.log(`[${y}] 드래프트 ${d.length}명`);
    } catch (e) { console.warn(`[${y}] 실패, 건너뜁니다: ${e.message}`); }
  }
  df.generatedAt = new Date().toISOString();
  const db = await save(DOUT, df);
  console.log(`드래프트 저장 완료: ${DOUT} (연도 ${Object.keys(df.drafts).length}개, 이번에 ${gotD}개 처리, ${(db / 1e6).toFixed(2)}MB)`);
}

main().catch((e) => {
  console.error('실패:', e.message);
  process.exit(1);
});
