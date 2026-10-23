# MLB 스탯 분석 – 데이터 수집 구조

서버를 따로 운영하지 않는 구조입니다.

```
GitHub Actions (매일 1회)
   └─ mlb_ingest.mjs 실행 → MLB Stats API에서 시즌 기록 수집
        └─ data/mlb.json 저장 (변경 시에만 커밋)
             └─ index.html 이 이 JSON을 읽어 화면에 표시
```

## 파일

| 파일 | 역할 |
|---|---|
| `mlb_ingest.mjs` | MLB Stats API → `data/mlb.json` 변환. Node 18 이상, 설치할 패키지 없음 |
| `.github/workflows/update-data.yml` | 매일 자동 실행해서 JSON을 갱신 |
| `index.html` | 화면. 페이지의 “JSON 파일 불러오기”로 데이터를 넣을 수 있음 |
| `data/test-fixture.json` | 가짜 데이터(Test Hitter 1 등). 불러오기 기능을 시험해 볼 때만 사용 |

## 바로 써보기 (내 컴퓨터)

```bash
node mlb_ingest.mjs --seasons 2024,2025,2026 --min-pa 200 --min-ip 50 --out data/mlb.json
```

만들어진 `data/mlb.json`을 페이지 아래쪽 “데이터” 영역에서 불러오면 실제 선수 데이터로 바뀝니다. 불러온 데이터는 그 브라우저에 저장됩니다.

옵션: `--seasons` 받을 시즌, `--min-pa` 타자 최소 타석, `--min-ip` 투수 최소 이닝(가장 최근 시즌 기준), `--out` 저장 경로.

## 자동 갱신 설정

1. 이 폴더를 GitHub 저장소로 올립니다.
2. Settings → Pages에서 저장소 루트를 배포하면 `index.html`이 웹주소로 열립니다.
3. Actions 탭에서 `update-mlb-data`를 한 번 수동 실행해 `data/mlb.json`이 생기는지 확인합니다.
4. 이후 매일 자동으로 갱신됩니다.

## 페이지가 JSON을 자동으로 읽게 하기

claude.ai에 게시된 페이지는 외부 주소에서 데이터를 가져올 수 없어서 파일 불러오기 방식을 씁니다. 위처럼 직접 호스팅한 `index.html`에서는 `// ---------- 시작 ----------` 구역의 `if(!started)applyDataset(sampleDataset());` 바로 앞에 아래 한 줄을 추가하면 자동으로 읽습니다.

```js
if(!started){try{const r=await fetch('data/mlb.json');if(r.ok){applyDataset(await r.json());started=true;}}catch(e){}}
```

이 줄에는 `await`가 들어가므로 시작 구역 전체를 `(async()=>{ ... })()` 로 감싸야 합니다.

## 계산 방식

- **OPS+**: `100 × (출루율 / 리그 출루율 + 장타율 / 리그 장타율 − 1)`. 리그 평균은 수집한 전체 선수 기록에서 시즌별로 계산합니다. 구장 보정은 없어서 공식 OPS+와 몇 포인트 차이가 날 수 있습니다.
- **FIP**: `(13×HR + 3×(BB+HBP) − 2×SO) / IP + 상수`. 상수는 리그 ERA에 맞춰 시즌별로 계산합니다.
- **WAR**: 포함하지 않았습니다. FanGraphs, Baseball-Reference의 값이고 공식 API가 없습니다.

## 처음 실행할 때 확인할 것

- 이 스크립트는 가짜 서버로 동작을 검증했지만, 실제 MLB 서버에는 연결해 보지 못했습니다. 첫 실행 로그에서 아래를 확인하세요.
  - `타자 N명, 투수 N명` 숫자가 현실적인지 (시즌 종료 후라면 타자 1,000명 안팎).
  - `여러 행으로 온 선수` 숫자가 0이 아니면, 시즌 중 이적한 선수가 합계 행이 아니라 팀별 기록 중 가장 큰 행으로 들어갈 수 있습니다. 그 선수의 수치는 시즌 전체보다 작게 나옵니다.
  - 선수 포지션이 비어 있으면 API가 포지션을 주지 않는 것이라 팀만 표시됩니다.
- MLB 데이터의 이용 약관을 확인하세요. 개인 학습과 비상업 용도에는 흔히 쓰이지만, 공개 서비스나 상업 서비스로 내보내기 전에는 MLB의 이용 조건을 읽어야 합니다.
