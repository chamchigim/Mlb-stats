#!/usr/bin/env node
// MLB 선수의 한글 이름(우리가 보통 쓰는 표기)을 Wikidata에서 받아 JSON으로 저장합니다.
//
// 사용법: node mlb_ko_names.mjs --out data/mlb-ko-names.json
// 필요한 것: Node.js 18 이상 (내장 fetch 사용, 설치할 패키지 없음)
//
// Wikidata(CC0, 누구나 자유롭게 쓸 수 있는 공개 데이터)에는 선수마다 "MLB.com 선수 번호"(P3541)와
// 한국어 이름이 함께 들어 있는 경우가 많습니다. 번호가 MLB 통계의 선수 번호와 같아서 그대로 연결됩니다.
// 한국어 이름이 없는 선수는 비어 있고, 화면에서는 영어 이름만 나옵니다.
// 주의: Wikidata 응답을 제 환경에서 직접 확인하지 못한 채 만든 스크립트입니다. 받은 건수가 로그에 남습니다.

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];

const OUT = args.out || 'data/mlb-ko-names.json';
const ENDPOINT = process.env.WIKIDATA_SPARQL || 'https://query.wikidata.org/sparql';
const UA = 'mlb-stats-personal/1.0 (personal hobby project; GitHub chamchigim/Mlb-stats)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const QUERIES = [
  // 1) 가장 단순한 형태
  'SELECT ?id ?ko WHERE { ?p wdt:P3541 ?id . ?p rdfs:label ?ko . FILTER(LANG(?ko) = "ko") }',
  // 2) 위가 안 되면: 언어 표시가 ko-로 시작하는 경우까지 포함
  'SELECT ?id ?ko WHERE { ?p wdt:P3541 ?id . ?p rdfs:label ?ko . FILTER(LANGMATCHES(LANG(?ko), "ko")) }',
];

async function runQuery(q) {
  const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(q)}`;
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/sparql-results+json', 'user-agent': UA }, signal: AbortSignal.timeout(150000) });
      if (r.status === 429 || r.status === 503) {
        const wait = Number(r.headers.get('retry-after')) || 15 * i;
        throw Object.assign(new Error('HTTP ' + r.status + ' (잠시 후 다시 시도)'), { wait });
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i >= 3) throw new Error(e.message);
      console.warn(`  다시 시도합니다 (${i}/2): ${e.message}`);
      await sleep((e.wait || 10 * i) * 1000);
    }
  }
}

const hangul = /[가-힯]/;

async function main() {
  console.log('MLB 선수 한글 이름 수집 v1 (출처: Wikidata)');
  let rows = [];
  for (const q of QUERIES) {
    try {
      const j = await runQuery(q);
      rows = j.results?.bindings || [];
      console.log(`질문 결과 ${rows.length}건`);
      if (rows.length >= 100) break;
    } catch (e) { console.warn(`질문 실패: ${e.message}`); }
  }
  const names = {};
  for (const b of rows) {
    const id = String(b.id?.value || '').trim();
    const ko = String(b.ko?.value || '').trim();
    if (!/^\d+$/.test(id) || !ko || !hangul.test(ko)) continue;
    if (!names[id]) names[id] = ko;
  }
  const n = Object.keys(names).length;
  if (n < 100) {
    // 너무 적으면 잘못 받은 것으로 보고 기존 파일을 지키기 위해 실패로 끝냅니다.
    throw new Error(`한글 이름이 ${n}개뿐이라 저장하지 않습니다(기존 파일이 있으면 그대로 둡니다).`);
  }
  let prev = null;
  try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* 처음 */ }
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), source: 'Wikidata (CC0)', names }));
  console.log(`저장 완료: ${OUT} (한글 이름 ${n}명${prev?.names ? `, 이전 ${Object.keys(prev.names).length}명` : ''})`);
  const sample = Object.entries(names).slice(0, 5).map(([k, v]) => `${k}=${v}`).join(', ');
  console.log(`예: ${sample}`);
}

main().catch((e) => {
  console.error('실패:', e.message);
  process.exit(1);
});
