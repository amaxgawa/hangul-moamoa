/*
 * 한글 모아모아 화면 인식 모듈
 * - 입력: ImageData 형태 { width, height, data(RGBA) }
 * - 게임판(10x16) 격자를 찾고, 칸 상태 / 아이템 / 보유 조각 3개 / 능력 버튼 상태를 읽는다.
 * - 브라우저와 Node(테스트) 양쪽에서 동작하도록 외부 의존성 없이 작성.
 */
(function (root) {
  'use strict';

  const COLS = 10, ROWS = 16;

  // 픽셀 분류 코드
  const EMPTY = 0, YELLOW = 1, PINK = 2, GREEN = 3, BLUE = 4;
  const K_PURPLE = 5, K_ICON = 6, K_WHITE = 7, K_OTHER = 8;

  // 보유 조각 패널 위치 (게임판 칸 크기 P 기준 비율, 샘플 스크린샷에서 측정)
  const LAYOUT = {
    slotY0: 2.25,      // 첫 번째 조각 미리보기 중심 y (게임판 위쪽 테두리 기준, 칸 단위)
    slotDY: 2.88,      // 조각 슬롯 간격
    slotX0: 0.8,       // 미리보기 영역 x 시작 (게임판 오른쪽 테두리 기준)
    slotX1: 2.8,       // 미리보기 영역 x 끝 (오른쪽 회전/반전 버튼 제외)
    slotHalfH: 1.15,   // 미리보기 영역 세로 반폭
    miniRatio: 0.308,  // 미리보기 한 칸 크기 / 게임판 한 칸 크기
    dotBtnY: 14.3,     // [점 찍기] 버튼 중심 y
    swapBtnY: 15.65,   // [바꿔 뽑기] 버튼 중심 y
    btnX0: 0.9,        // 버튼 아이콘+글자 영역 (오른쪽 개수 배지는 제외)
    btnX1: 3.9,
  };

  function classify(r, g, b) {
    if (r >= 55 && r <= 118 && g >= 140 && g <= 224 && b >= 170 && b <= 234 && b - r >= 75 && g - r >= 40) return EMPTY;
    if (r > 225 && g > 225 && b > 225) return K_WHITE;
    if (r > 200 && g > 165 && b < 150) return YELLOW;
    if (r > 190 && g < 180 && b > 150 && r >= b - 15) return PINK;
    if (g > 150 && b < 110 && r > 80 && r < 225 && g > r) return GREEN;
    if (b >= 236 && r < 150 && g > 140 && g < 232) return BLUE;
    if (b > r + 15 && r > g + 50 && b > 130) return K_PURPLE;
    if (r < 50 && b > 110 && b >= g - 5) return K_ICON;   // 점 찍기 아이콘의 남색/형광청록 (드래그 미리보기 초록 제외)
    return K_OTHER;
  }

  // ---------------------------------------------------------------------------
  // 격자선 검출: 청록색 배경 위의 얇고 어두운 선
  // ---------------------------------------------------------------------------
  function lineProfiles(img, x0, y0, x1, y1, step) {
    const W = img.width, Hh = img.height, d = img.data;
    const V = new Float32Array(W), H = new Float32Array(Hh);
    const T = 16, T2 = 24, o = W * 8;
    step = step || 1;
    x0 = Math.max(2, x0 | 0); y0 = Math.max(2, y0 | 0);
    x1 = Math.min(W - 2, x1 | 0); y1 = Math.min(Hh - 2, y1 | 0);
    // 큰 화면에서는 속도를 위해 세로선은 y를, 가로선은 x를 건너뛰며 센다 (선 자체는 1px이라 놓치면 안 됨)
    for (let y = y0; y < y1; y++) {
      const doV = step === 1 || (y % step) === 0;
      let i = (y * W + x0) * 4;
      for (let x = x0; x < x1; x++, i += 4) {
        const doH = step === 1 || (x % step) === 0;
        if (!doV && !doH) continue;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (b < 140 || b - r < 60 || g - r < 40) continue;
        const s = r + g + b;
        if (doV) {
          const sl = d[i - 8] + d[i - 7] + d[i - 6], sr = d[i + 8] + d[i + 9] + d[i + 10];
          if (s <= sl - T && s <= sr - T && Math.abs(sl - sr) <= T2) V[x] += step;
        }
        if (doH) {
          const su = d[i - o] + d[i - o + 1] + d[i - o + 2], sd = d[i + o] + d[i + o + 1] + d[i + o + 2];
          if (s <= su - T && s <= sd - T && Math.abs(su - sd) <= T2) H[y] += step;
        }
      }
    }
    return { V, H };
  }

  // 테두리선 근거: pos 위치(±0.12칸)에 '바깥쪽(밝은 프레임)보다 어두운 청록 띠'가 보이는 비율 (0~1).
  // 안쪽은 어두운 블럭이 붙을 수 있어 비교하지 않는다. 띠 두께는 배율에 따라 달라서 비교 거리를 칸 크기에 맞춤.
  // outer: 바깥쪽 방향 (-1 = 왼쪽/위, +1 = 오른쪽/아래)
  function borderFrac(img, vertical, pos, P, spanStart, spanLen, outer) {
    const W = img.width, Hh = img.height, d = img.data;
    const D = Math.max(2, Math.round(P * 0.2)), w = Math.max(2, Math.round(P * 0.12)), T = 16;
    const sum = (x, y) => { const i = (y * W + x) * 4; return d[i] + d[i + 1] + d[i + 2]; };
    const at = (u, v) => (vertical ? [u, v] : [v, u]); // u: 테두리에 수직인 축, v: 테두리를 따라가는 축
    let hit = 0, n = 0;
    const stepV = Math.max(1, Math.round(P / 6));
    for (let v = Math.round(spanStart + P * 0.3); v < spanStart + spanLen - P * 0.3; v += stepV) {
      n++;
      for (let u = Math.round(pos - w); u <= pos + w; u++) {
        const [x, y] = at(u, v), [xo, yo] = at(u + outer * D, v);
        if (xo < 0 || yo < 0 || xo >= W || yo >= Hh || x < 0 || y < 0 || x >= W || y >= Hh) continue;
        const i = (y * W + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
        if (b < 140 || b - r < 60 || g - r < 40) continue;
        if (r + g + b <= sum(xo, yo) - T) { hit++; break; }
      }
    }
    return n ? hit / n : 0;
  }

  // 판이 거의 꽉 차면 안쪽 격자선이 드물어 한 칸 밀린 위치로 맞춰질 수 있다.
  // 바깥 테두리선은 블럭에 가려지지 않으므로, ±2칸 옮긴 후보 중 양쪽 테두리 근거가 뚜렷하게 더 좋은 곳으로 보정한다.
  function alignByBorder(img, vertical, n, start, P, lo, hi, spanStart, spanLen) {
    const bf = (s) => borderFrac(img, vertical, s, P, spanStart, spanLen, -1) + borderFrac(img, vertical, s + n * P, P, spanStart, spanLen, +1);
    let best = start, bestBf = bf(start);
    const base = bestBf;
    for (const k of [-2, -1, 1, 2]) {
      const s = start + k * P;
      if (s < lo - 1 || s + n * P > hi + 1) continue;
      const v = bf(s);
      if (v > bestBf) { bestBf = v; best = s; }
    }
    return bestBf >= base + 0.4 ? best : start;
  }

  // n칸 격자의 선 위치 s + k*P (k=0..n) 를 프로파일에 맞춘다. 내부선(k=1..n-1)으로 점수 계산.
  // 점수 상위 K개 후보(서로 위치가 다른)를 돌려준다. 가려진 부분이 있으면 1등이 틀릴 수 있어서.
  function fitLinesTop(prof, n, lo, hi, Pmin, Pmax, Pstep, K, sLo, sHi) {
    const len = prof.length;
    const p2 = new Float32Array(len);
    for (let x = 0; x < len; x++) {
      const m = Math.max(prof[x], x > 0 ? prof[x - 1] : 0, x < len - 1 ? prof[x + 1] : 0);
      p2[x] = Math.sqrt(m);
    }
    const top = [];
    for (let P = Pmin; P <= Pmax + 1e-9; P += Pstep) {
      const span = n * P;
      const a = Math.max(lo, sLo == null ? lo : sLo), b = Math.min(hi - span, sHi == null ? hi : sHi);
      for (let s = a; s <= b; s += 0.5) {
        let sc = 0;
        for (let k = 1; k < n; k++) sc += p2[Math.round(s + k * P)];
        if (sc <= 0) continue;
        if (top.length === K && sc <= top[K - 1].score) continue;
        const near = top.findIndex((t) => Math.abs(t.start - s) < t.P * 0.5 && Math.abs(t.P - P) < t.P * 0.06);
        if (near >= 0) {
          if (sc > top[near].score) top[near] = { score: sc, start: s, P };
          else continue;
        } else {
          top.push({ score: sc, start: s, P });
        }
        top.sort((u, v) => v.score - u.score);
        if (top.length > K) top.length = K;
      }
    }
    // 내부선 중 근거가 있는 선 비율
    for (const t of top) {
      let mx = 0, hit = 0;
      for (let k = 1; k < n; k++) mx = Math.max(mx, p2[Math.round(t.start + k * t.P)]);
      for (let k = 1; k < n; k++) if (p2[Math.round(t.start + k * t.P)] >= Math.max(1.5, mx * 0.12)) hit++;
      t.hitRatio = hit / (n - 1);
    }
    return top;
  }
  function fitLines(prof, n, lo, hi, Pmin, Pmax, Pstep, sLo, sHi) {
    return fitLinesTop(prof, n, lo, hi, Pmin, Pmax, Pstep, 1, sLo, sHi)[0] || { score: 0, start: 0, P: 0, hitRatio: 0 };
  }

  // 대략 맞춘 결과를 이웃 허용 없이(원본 프로파일) 미세 조정
  function refineLines(prof, n, coarse) {
    let best = { score: -1, start: coarse.start, P: coarse.P };
    const len = prof.length;
    for (let P = coarse.P - 0.6; P <= coarse.P + 0.6; P += 0.02) {
      for (let s = coarse.start - 2; s <= coarse.start + 2; s += 0.25) {
        let sc = 0;
        for (let k = 1; k < n; k++) {
          const x = Math.round(s + k * P);
          if (x >= 0 && x < len) sc += Math.sqrt(prof[x]);
        }
        // 동점이면 기존 값에 가까운 쪽
        if (sc > best.score + 1e-6) best = { score: sc, start: s, P };
      }
    }
    return { start: best.start, P: best.P, score: coarse.score, hitRatio: coarse.hitRatio };
  }

  function fitGrid(img, area, Pguess) {
    const W = img.width, Hh = img.height;
    area = area || { x0: 0, y0: 0, x1: W, y1: Hh };
    const big = (area.x1 - area.x0) * (area.y1 - area.y0) > 1.5e6;
    const step = big ? 2 : 1;
    let pr = lineProfiles(img, area.x0, area.y0, area.x1, area.y1, step);
    const Pmin = Pguess ? Pguess * 0.9 : 10, Pmax = Pguess ? Pguess * 1.1 : 80;
    // 1) 세로 방향(행) 후보들
    const ys = fitLinesTop(pr.H, ROWS, area.y0, area.y1, Pmin, Pmax, 0.25, 6);
    let best = null;
    for (const cand of ys) {
      const g = fitFromRows(img, area, cand);
      if (!g) continue;
      // 칸 판독이 말이 되는지(빈칸/블럭으로 읽히는 비율)로 후보 검증
      const b = readBoard(img, g);
      g.unknownRatio = b.unknown / (ROWS * COLS);
      g.frameScore = frameScore(img, g);
      g.quality = (1 - g.unknownRatio) + 0.5 * g.lineConf + 0.6 * g.frameScore;
      if (!best || g.quality > best.quality) best = g;
    }
    return best;
  }

  // 게임판 위/아래 바로 바깥은 밝은 하늘색 테두리여야 한다 (제목 나뭇잎/나무판과 구분)
  function frameScore(img, g) {
    const W = img.width, d = img.data;
    const x0 = g.x0, x1 = g.x0 + COLS * g.Px;
    const strips = [
      [g.y0 - 0.45 * g.Py, g.y0 - 0.12 * g.Py],
      [g.y0 + ROWS * g.Py + 0.12 * g.Py, g.y0 + ROWS * g.Py + 0.45 * g.Py],
    ];
    let hit = 0, n = 0;
    for (const [ya, yb] of strips) {
      for (let y = Math.round(ya); y <= yb; y++) {
        if (y < 0 || y >= img.height) { n += 10; continue; }
        for (let x = Math.round(x0); x < x1; x += 2) {
          const i = (y * W + x) * 4;
          const r = d[i], gg = d[i + 1], b = d[i + 2];
          n++;
          if (b >= 170 && b - r >= 40 && gg - r >= 30) hit++;
        }
      }
    }
    return n ? hit / n : 0;
  }

  function fitFromRows(img, area, fy) {
    // 2) 그 행 범위 안에서 가로 방향(열) 맞춤
    let pr = lineProfiles(img, area.x0, fy.start, area.x1, fy.start + ROWS * fy.P, 1);
    let fx = fitLines(pr.V, COLS, area.x0, area.x1, fy.P * 0.92, fy.P * 1.08, 0.1);
    if (fx.score <= 0) return null;
    // 3) 열 범위로 좁혀 행을 다시 맞춤 (정밀)
    pr = lineProfiles(img, fx.start, area.y0, fx.start + COLS * fx.P, area.y1, 1);
    // 후보 위치에서 크게 벗어나지 않게 (한 칸 밀린 위치는 별도 후보로 평가됨)
    fy = fitLines(pr.H, ROWS, area.y0, area.y1, fx.P * 0.96, fx.P * 1.04, 0.05,
      fy.start - fy.P * 0.3, fy.start + fy.P * 0.3);
    if (fy.score <= 0) return null;
    fy = refineLines(pr.H, ROWS, fy);
    pr = lineProfiles(img, area.x0, fy.start, area.x1, fy.start + ROWS * fy.P, 1);
    fx = fitLines(pr.V, COLS, area.x0, area.x1, fy.P * 0.97, fy.P * 1.03, 0.05,
      fx.start - fx.P, fx.start + fx.P);
    if (fx.score <= 0) return null;
    fx = refineLines(pr.V, COLS, fx);
    // 4) 바깥 테두리선으로 한 칸 밀림 보정 (꽉 찬 판 대비): 열 → 행
    fx.start = alignByBorder(img, true, COLS, fx.start, fx.P, area.x0, area.x1, fy.start, ROWS * fy.P);
    fy.start = alignByBorder(img, false, ROWS, fy.start, fy.P, area.y0, area.y1, fx.start, COLS * fx.P);
    return {
      x0: fx.start, y0: fy.start, Px: fx.P, Py: fy.P,
      lineConf: (fx.hitRatio * (COLS - 1) + fy.hitRatio * (ROWS - 1)) / (COLS + ROWS - 2),
    };
  }

  // ---------------------------------------------------------------------------
  // 칸 읽기
  // ---------------------------------------------------------------------------
  function regionCounts(img, x0, y0, x1, y1, step) {
    const W = img.width, d = img.data;
    const c = new Int32Array(9);
    let n = 0;
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(img.height, y1); y += step) {
      for (let x = Math.max(0, Math.round(x0)); x < Math.min(W, x1); x += step) {
        const i = (y * W + x) * 4;
        c[classify(d[i], d[i + 1], d[i + 2])]++; n++;
      }
    }
    return { c, n };
  }

  function ringCounts(img, x0, y0, P, Q, a, b, step) {
    // 칸 안쪽 테두리 띠 (a~b 비율)
    const c = new Int32Array(9); let n = 0;
    const W = img.width, d = img.data;
    for (let fy = a; fy < 1 - a; fy += step / Q) {
      for (let fx = a; fx < 1 - a; fx += step / P) {
        const inBand = fx < b || fx > 1 - b || fy < b || fy > 1 - b;
        if (!inBand) continue;
        const x = Math.round(x0 + fx * P), y = Math.round(y0 + fy * Q);
        if (x < 0 || y < 0 || x >= W || y >= img.height) continue;
        const i = (y * W + x) * 4;
        c[classify(d[i], d[i + 1], d[i + 2])]++; n++;
      }
    }
    return { c, n };
  }

  // 칸 가운데에서 채도 낮은 회색(비활성 아이템 아이콘) 픽셀 비율
  function greyIconShare(img, x0, y0, P, Q, step) {
    const W = img.width, d = img.data;
    let hit = 0, n = 0;
    for (let y = Math.round(y0 + Q * 0.3); y < y0 + Q * 0.7; y += step) {
      for (let x = Math.round(x0 + P * 0.3); x < x0 + P * 0.7; x += step) {
        if (x < 0 || y < 0 || x >= W || y >= img.height) continue;
        const i = (y * W + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        n++;
        if (mx - mn <= 45 && mx >= 50) hit++;
      }
    }
    return n ? hit / n : 0;
  }

  function pickBase(c, n) {
    let best = -1, bc = 0;
    for (let k = 0; k <= 4; k++) if (c[k] > bc) { bc = c[k]; best = k; }
    // 실제 칸은 순도 90% 이상 (빈칸 97~100%, 젤리 블럭 91~95%). 커서·나뭇잎 등은 낮게 나옴
    if (n === 0 || bc / n < 0.75) return -1;
    return best;
  }

  function readBoard(img, grid) {
    const { x0, y0, Px, Py } = grid;
    const step = Math.max(1, Math.floor(Math.min(Px, Py) / 18));
    const cells = [], items = [];
    let unknown = 0, emptyCount = 0;
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) {
        const cx = x0 + c * Px, cy = y0 + r * Py;
        const inner = regionCounts(img, cx + Px * 0.14, cy + Py * 0.14, cx + Px * 0.86, cy + Py * 0.86, step);
        const fr = (k) => inner.c[k] / inner.n;
        let item = null;
        if (fr(K_PURPLE) >= 0.05) item = 'swap';
        else if (fr(K_ICON) >= 0.04 && fr(K_WHITE) >= 0.03) item = 'dot';
        let base = item ? -1 : pickBase(inner.c, inner.n);
        if (base < 0) {
          // 가운데가 섞인 칸(아이템 아이콘, 커서 등): 아이콘이 닿지 않는 가장자리 띠의 색으로 빈칸/블럭 판단.
          // 아이템이 블럭 위에 겹쳐 있으면 그 칸에는 조각을 놓을 수 없으므로 블럭으로 읽어야 한다.
          const ring = ringCounts(img, cx, cy, Px, Py, 0.05, 0.22, step);
          const sh = [0, 1, 2, 3, 4].map((k) => (ring.n ? ring.c[k] / ring.n : 0));
          if (item === 'dot') sh[BLUE] = Math.max(0, sh[BLUE] - 0.08); // 점 찍기 아이콘의 파란 테두리 몫
          let best = 0;
          for (let k = 1; k <= 4; k++) if (sh[k] > sh[best]) best = k;
          // 능력이 가득 차면(7/7) 아이콘이 회색으로 바뀐다(⇄·과녁 모두) → 지워도 능력을 못 얻는 '비활성' 아이템.
          // 과녁 아이콘은 빛번짐이 가장자리까지 덮으므로 바탕 판단 전에 먼저 확인한다.
          if (!item && greyIconShare(img, cx, cy, Px, Py, step) >= 0.6) item = 'inactive';
          if (item) {
            // 활성 아이콘은 빛번짐이 가장자리까지 덮는다. 아이템은 빈칸에만 생기므로
            // 블럭 색이 뚜렷하게 보일 때만 블럭(그 위에 조각을 놓은 경우), 아니면 빈칸.
            base = best > 0 && sh[best] >= 0.12 ? best : 0;
          } else {
            base = sh[best] >= 0.5 ? best : -1;
          }
        }
        if (item) items.push({ r, c, type: item });
        if (base < 0) unknown++;
        if (base === 0) emptyCount++;
        row.push(base);
      }
      cells.push(row);
    }
    // 판 위 능력 아이콘은 최대 3개(공식 규칙). 회색 칸이 그보다 많으면 아이콘이 아니라
    // 드래그 중 빛나는 줄 같은 화면 효과이므로 그 칸들은 '알 수 없음'으로 되돌린다.
    if (items.length > 3) {
      for (const it of items) {
        if (it.type !== 'inactive') continue;
        if (cells[it.r][it.c] === 0) emptyCount--;
        cells[it.r][it.c] = -1; unknown++;
      }
      for (let i = items.length - 1; i >= 0; i--) if (items[i].type === 'inactive') items.splice(i, 1);
    }
    // 가득 찬 줄은 존재할 수 없음(즉시 제거) → 있으면 애니메이션/드래그 중인 프레임
    let fullRows = 0;
    for (let r = 0; r < ROWS; r++) if (cells[r].every((v) => v > 0)) fullRows++;
    return { cells, items, unknown, emptyCount, fullRows };
  }

  // ---------------------------------------------------------------------------
  // 보유 조각 읽기
  // ---------------------------------------------------------------------------
  function isPiecePx(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn < 60 || mx < 120) return false;
    if (r > 235 && g > 215 && b > 120) return false; // 선택 강조(연노랑) 배경
    return true;
  }
  function isLightBg(r, g, b) {
    return (r >= 238 && g >= 238 && b >= 238) || (r > 240 && g > 225 && b > 120 && b < 235);
  }

  function readPieceAt(img, rx0, ry0, rx1, ry1, P) {
    const W = img.width, d = img.data;
    rx0 = Math.max(0, Math.round(rx0)); ry0 = Math.max(0, Math.round(ry0));
    rx1 = Math.min(W, Math.round(rx1)); ry1 = Math.min(img.height, Math.round(ry1));
    const w = rx1 - rx0, h = ry1 - ry0;
    if (w <= 4 || h <= 4) return { status: 'none' };
    const mask = new Uint8Array(w * h);
    let light = 0, cnt = 0, dark = 0, bx0 = w, by0 = h, bx1 = -1, by1 = -1;
    const colorSum = [0, 0, 0];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = ((ry0 + y) * W + rx0 + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (r < 70 && g < 70 && b < 70) dark++;   // 카드 영역엔 원래 검은색이 없다 → 게임 마우스 커서의 외곽선
        if (isLightBg(r, g, b)) light++;
        else if (isPiecePx(r, g, b)) {
          mask[y * w + x] = 1; cnt++;
          colorSum[0] += r; colorSum[1] += g; colorSum[2] += b;
          if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
          if (y < by0) by0 = y; if (y > by1) by1 = y;
        }
      }
    }
    // 마우스 커서가 미리보기를 가리면 모양이 깎여 다른 조각으로 읽힌다 → 이번 프레임은 판단 보류
    if (dark >= Math.max(4, P * 0.25)) return { status: 'occluded' };
    const lightFrac = light / (w * h);
    if (lightFrac < 0.25) return { status: 'used' };         // 흰 미리보기 박스가 없음 → 사용 완료
    // 영역 경계에 닿은 덩어리(카드 테두리, 체크 표시 등)와 작은 잡음 제거
    {
      const lab = new Int32Array(w * h).fill(-1);
      const stack = [];
      const minPx = Math.max(4, (P * LAYOUT.miniRatio) ** 2 * 0.25);
      for (let s0 = 0; s0 < w * h; s0++) {
        if (!mask[s0] || lab[s0] >= 0) continue;
        const comp = []; let touches = false;
        lab[s0] = s0; stack.push(s0);
        while (stack.length) {
          const q = stack.pop(); comp.push(q);
          const qx = q % w, qy = (q / w) | 0;
          if (qx === 0 || qy === 0 || qx === w - 1 || qy === h - 1) touches = true;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = qx + dx, ny = qy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const nq = ny * w + nx;
            if (mask[nq] && lab[nq] < 0) { lab[nq] = s0; stack.push(nq); }
          }
        }
        if (touches || comp.length < minPx) for (const q of comp) mask[q] = 0;
      }
      cnt = 0; bx0 = w; by0 = h; bx1 = -1; by1 = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        cnt++;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
        if (y < by0) by0 = y; if (y > by1) by1 = y;
      }
    }
    if (cnt < Math.max(6, P * P * 0.03)) return { status: 'used' };

    // 한 칸 크기 추정: 가장 짧은 연속 구간(가로/세로) 길이
    const prior = P * LAYOUT.miniRatio;
    const gapTol = Math.max(2, Math.round(prior * 0.3)); // 칸 안의 반짝이 픽셀 때문에 끊긴 구간은 이어 붙임
    const runs = [];
    function scan(len, at) {
      let start = -1, last = -1;
      for (let t = 0; t <= len; t++) {
        const on = t < len && at(t);
        if (on) {
          if (start < 0) start = t;
          else if (t - last - 1 > gapTol) { pushRun(last - start + 1); start = t; }
          last = t;
        }
      }
      if (start >= 0) pushRun(last - start + 1);
    }
    function pushRun(n) { if (n >= prior * 0.5) runs.push(n); }
    for (let y = by0; y <= by1; y++) scan(bx1 - bx0 + 1, (t) => mask[y * w + bx0 + t]);
    for (let x = bx0; x <= bx1; x++) scan(by1 - by0 + 1, (t) => mask[(by0 + t) * w + x]);
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    // 미리보기 한 칸 = 게임판 칸 × 0.308 (배율이 다른 이미지 3종에서 일정). 이 값으로 칸 수가 정수에 가깝게
    // 떨어지면 그대로 쓴다. 연속 구간 길이는 칸 안 반짝이 때문에 짧게 끊길 수 있어서(1칸 조각을 2x2로 오인) 보조로만 쓴다.
    const fitErr = (q) => Math.max(Math.abs(bw / q - Math.round(bw / q)), Math.abs(bh / q - Math.round(bh / q)));
    let p = prior;
    if (fitErr(prior) > 0.38) {
      let best = fitErr(prior);
      for (const m of runs) {
        if (m < prior * 0.75 || m > prior * 1.33) continue;
        const e = fitErr(m);
        if (e < best - 0.05) { best = e; p = m; }
      }
    }
    const cols = Math.max(1, Math.round(bw / p)), rows = Math.max(1, Math.round(bh / p));
    if (cols > 6 || rows > 6) return { status: 'unknown' };
    const pw = bw / cols, ph = bh / rows;
    const cells = [];
    for (let rr = 0; rr < rows; rr++) {
      for (let cc = 0; cc < cols; cc++) {
        let on = 0, n = 0;
        for (let y = Math.floor(by0 + (rr + 0.25) * ph); y < by0 + (rr + 0.75) * ph; y++) {
          for (let x = Math.floor(bx0 + (cc + 0.25) * pw); x < bx0 + (cc + 0.75) * pw; x++) {
            on += mask[y * w + x]; n++;
          }
        }
        if (n && on / n >= 0.5) cells.push([rr, cc]);
      }
    }
    if (!cells.length) return { status: 'unknown' };
    const col = colorSum.map((v) => Math.round(v / cnt));
    return { status: 'ok', cells, w: cols, h: rows, color: col };
  }

  function readPieces(img, grid) {
    const P = grid.Px, Q = grid.Py;
    const xr = grid.x0 + COLS * P;
    const out = [];
    for (let k = 0; k < 3; k++) {
      const cy = grid.y0 + (LAYOUT.slotY0 + k * LAYOUT.slotDY) * Q;
      out.push(readPieceAt(img,
        xr + LAYOUT.slotX0 * P, cy - LAYOUT.slotHalfH * Q,
        xr + LAYOUT.slotX1 * P, cy + LAYOUT.slotHalfH * Q, P));
    }
    return out;
  }

  // 능력 버튼 활성 여부: 버튼 바탕색(파랑/보라)은 같고, 보유 0개면 글자가 흰색 대신 연한 색으로 바뀐다.
  function readAbilities(img, grid) {
    const P = grid.Px, Q = grid.Py;
    const xr = grid.x0 + COLS * P;
    const W = img.width, d = img.data;
    function probe(cyRel, baseTest) {
      const cy = grid.y0 + cyRel * Q;
      let base = 0, white = 0, n = 0;
      for (let y = Math.round(cy - Q * 0.35); y < cy + Q * 0.35; y++) {
        for (let x = Math.round(xr + LAYOUT.btnX0 * P); x < xr + LAYOUT.btnX1 * P; x++) {
          if (x < 0 || y < 0 || x >= W || y >= img.height) continue;
          const i = (y * W + x) * 4;
          const r = d[i], g = d[i + 1], b = d[i + 2];
          n++;
          if (baseTest(r, g, b)) base++;
          // 흰 글자: 화면 공유 영상의 색 번짐(YUV 4:2:0)에도 버티도록 밝기로 판단. 비활성 글자는 밝기 ~165
          else if (0.2126 * r + 0.7152 * g + 0.0722 * b >= 210) white++;
        }
      }
      return { base: n ? base / n : 0, white: n ? white / n : 0 };
    }
    const dot = probe(LAYOUT.dotBtnY, (r, g, b) => b > 200 && r < 110 && b - r > 120);
    const swap = probe(LAYOUT.swapBtnY, (r, g, b) => b > 180 && r > 100 && g < 140 && b - g > 90);
    const seen = (p) => p.base > 0.3;
    return {
      visible: seen(dot) && seen(swap),
      dot: seen(dot) && dot.white > 0.03,
      swap: seen(swap) && swap.white > 0.03,
      dotWhite: +dot.white.toFixed(3), swapWhite: +swap.white.toFixed(3),
    };
  }

  // ---------------------------------------------------------------------------
  // 통합 분석
  // ---------------------------------------------------------------------------
  // 도우미 페이지의 실시간 화면(게임 화면 복사본)에는 게임판 둘레에 표식색 테두리가 그려진다.
  // 전체 화면을 공유하면 그 복사본이 다시 찍히므로, 표식이 보이는 게임판은 건너뛴다.
  const SELF_MARK = 'rgb(0,255,136)';
  function isMarkPx(r, g, b) { return r < 90 && g > 200 && b > 90 && b < 190 && g - b > 50; }
  function isSelfView(img, g) {
    const W = img.width, d = img.data;
    const band = Math.max(2, Math.round(g.Px * 0.12));
    const x0 = g.x0, y0 = g.y0, x1 = g.x0 + COLS * g.Px, y1 = g.y0 + ROWS * g.Py;
    let hit = 0, n = 0;
    for (let k = 0; k < 24; k++) {
      const t = (k + 0.5) / 24;
      const pts = [[x0, y0 + t * (y1 - y0), 1, 0], [x1, y0 + t * (y1 - y0), 1, 0], [x0 + t * (x1 - x0), y0, 0, 1], [x0 + t * (x1 - x0), y1, 0, 1]];
      for (const [px, py, dx, dy] of pts) {
        n++;
        for (let s = -band; s <= band; s++) {
          const x = Math.round(px + dx * s), y = Math.round(py + dy * s);
          if (x < 0 || y < 0 || x >= W || y >= img.height) continue;
          const i = (y * W + x) * 4;
          if (isMarkPx(d[i], d[i + 1], d[i + 2])) { hit++; break; }
        }
      }
    }
    return hit / n > 0.4;
  }
  function maskRegion(img, g) {
    const data = new Uint8ClampedArray(img.data);
    const x0 = Math.max(0, Math.floor(g.x0 - 2 * g.Px)), y0 = Math.max(0, Math.floor(g.y0 - 3 * g.Py));
    const x1 = Math.min(img.width, Math.ceil(g.x0 + 18 * g.Px)), y1 = Math.min(img.height, Math.ceil(g.y0 + 20 * g.Py));
    for (let y = y0; y < y1; y++) data.fill(0, (y * img.width + x0) * 4, (y * img.width + x1) * 4);
    return { width: img.width, height: img.height, data };
  }

  function isNear(a, b) {
    return Math.abs(a.x0 - b.x0) < 0.4 * b.Px && Math.abs(a.y0 - b.y0) < 0.4 * b.Py && Math.abs(a.Px / b.Px - 1) < 0.03;
  }

  function analyze(img, prevGrid) {
    let grid = null;
    if (prevGrid) {
      const m = Math.max(prevGrid.Px, prevGrid.Py) * 1.5;
      const area = {
        x0: Math.max(0, prevGrid.x0 - m), y0: Math.max(0, prevGrid.y0 - m),
        x1: Math.min(img.width, prevGrid.x0 + COLS * prevGrid.Px + m),
        y1: Math.min(img.height, prevGrid.y0 + ROWS * prevGrid.Py + m),
      };
      grid = fitGrid(img, area, prevGrid.Py);
      if (grid && (grid.lineConf < 0.5 || isSelfView(img, grid))) grid = null;
    }
    if (!grid) grid = fitGrid(img);
    let selfSkipped = 0;
    while (grid && isSelfView(img, grid) && selfSkipped < 3) {
      img = maskRegion(img, grid);
      selfSkipped++;
      grid = fitGrid(img);
    }
    if (grid && isSelfView(img, grid)) grid = null;
    if (!grid) return { found: false, reason: selfSkipped ? '도우미 화면만 보입니다 (게임 창이 안 보임)' : '격자를 찾지 못했습니다', selfSkipped };
    const board = readBoard(img, grid);
    const emptyRatio = board.emptyCount / (ROWS * COLS);
    const unknownRatio = board.unknown / (ROWS * COLS);
    const fs = grid.frameScore != null ? grid.frameScore : frameScore(img, grid);
    // 커서가 칸 1~3개를 가리는 정도(2%)는 허용, 그 이상이면 잘못 잡았거나 가려진 것
    const found = grid.lineConf >= 0.45 && unknownRatio <= 0.12 && emptyRatio > 0.05 && fs >= 0.4;
    if (!found) {
      // 직전에 잡은 게임판과 같은 자리라면 잠깐 가려진 것(조각 드래그 중 줄 제거 미리보기, 커서 등) → 위치 고정 유지
      const tracking = !!prevGrid && isNear(grid, prevGrid) && grid.lineConf >= 0.45 && unknownRatio <= 0.5;
      return {
        found: false, tracking, grid, lineConf: grid.lineConf, unknownRatio,
        reason: tracking ? '조각을 놓는 중 · 화면이 안정되면 다시 읽습니다' : '한글 모아모아 게임판이 보이지 않습니다',
      };
    }
    const pieces = readPieces(img, grid);
    const abilities = readAbilities(img, grid);
    const clean = board.unknown === 0 && board.fullRows === 0 && pieces.every((p) => p.status !== 'unknown');
    return { found: true, grid, board, pieces, abilities, clean, lineConf: grid.lineConf, selfSkipped };
  }

  const api = {
    COLS, ROWS, LAYOUT, SELF_MARK, classify, fitGrid, readBoard, readPieces, readAbilities, isSelfView, analyze,
    COLOR_NAMES: ['빈칸', '노랑', '분홍', '초록', '파랑'],
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MoaVision = api;
})(typeof self !== 'undefined' ? self : this);
