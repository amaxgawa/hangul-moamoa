/*
 * 한글 모아모아 배치 추천 엔진
 * - createSolver() 는 외부 변수를 참조하지 않는 자기완결 함수다.
 *   (file:// 에서도 Web Worker 로 돌리기 위해 함수 소스를 Blob 으로 만들어 실행한다)
 * - 게임 규칙 (공식 가이드 기준)
 *   · 게임판 가로 10 x 세로 16, 가로줄이 가득 차면 그 줄만 비워짐 (위 블럭이 내려오지 않음)
 *   · 배치 점수 = 조각 칸 수, 동시 제거 1~5줄 = 300·n² (300/1200/2700/4800/7500)
 *   · 능력 아이콘이 있는 줄을 제거하면 능력 획득 (+50점)
 */
function createSolver() {
  'use strict';
  const COLS = 10, ROWS = 16, FULL = (1 << COLS) - 1;
  const LINE_SCORE = [0, 300, 1200, 2700, 4800, 7500, 10800, 14700];
  const ABILITY_SCORE = 50;

  // 블럭 종류 19종 (제공 이미지 기준). 게임 속 'ㅋ 6칸'은 ㅠ를 회전/반전한 것과 같은 모양이다.
  const LIBRARY_DEF = [
    ['ㆍ', ['#']],
    ['ㅅ', ['#.#', '.#.']],
    ['ㅡ', ['###']],
    ['ㄱ', ['##', '.#']],
    ['ㄴ', ['###', '#..']],
    ['ㅗ', ['###', '.#.']],
    ['ㅇ', ['.#.', '#.#', '.#.']],
    ['ㄷ', ['##', '#.', '##']],
    ['ㅣ', ['#####']],
    ['ㅈ', ['###', '.#.', '#.#']],
    ['ㅠ·ㅋ', ['####', '.#.#']],
    ['ㅕ', ['.#', '##', '.#', '##', '.#']],
    ['ㅊ', ['#.#', '.#.', '###', '.#.']],
    ['ㅁ', ['###', '#.#', '###']],
    ['ㄹ', ['##', '.#', '##', '#.', '##']],
    ['ㅌ', ['##', '.#', '##', '.#', '##']],
    ['ㅎ', ['..#..', '#####', '.#.#.', '..#..']],
    ['ㅂ', ['####', '#.#.', '####']],
    ['ㅍ', ['#.#', '###', '###', '#.#']],
  ];

  const PC = new Uint8Array(1 << 12);
  for (let i = 1; i < PC.length; i++) PC[i] = PC[i >> 1] + (i & 1);

  // ---------------------------------------------------------------- 모양 유틸
  function normalize(cells) {
    let mr = Infinity, mc = Infinity;
    for (const [r, c] of cells) { if (r < mr) mr = r; if (c < mc) mc = c; }
    return cells.map(([r, c]) => [r - mr, c - mc]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }
  function keyOf(cells) { return normalize(cells).map((p) => p[0] + ',' + p[1]).join(';'); }
  function dims(cells) {
    let h = 0, w = 0;
    for (const [r, c] of cells) { if (r + 1 > h) h = r + 1; if (c + 1 > w) w = c + 1; }
    return { w, h };
  }
  // 시계 방향 90도 회전
  function rotateCW(cells) {
    const n = normalize(cells), { h } = dims(n);
    return normalize(n.map(([r, c]) => [c, h - 1 - r]));
  }
  function rotateCCW(cells) {
    const n = normalize(cells), { w } = dims(n);
    return normalize(n.map(([r, c]) => [w - 1 - c, r]));
  }
  // 좌우 반전
  function flipH(cells) {
    const n = normalize(cells), { w } = dims(n);
    return normalize(n.map(([r, c]) => [r, w - 1 - c]));
  }
  function allOrientCells(cells) {
    const out = [], seen = new Set();
    let cur = normalize(cells);
    for (let f = 0; f < 2; f++) {
      for (let k = 0; k < 4; k++) {
        const key = keyOf(cur);
        if (!seen.has(key)) { seen.add(key); out.push(cur); }
        cur = rotateCW(cur);
      }
      cur = flipH(cur);
    }
    return out;
  }
  function canonicalKey(cells) {
    let best = null;
    for (const o of allOrientCells(cells)) { const k = keyOf(o); if (best === null || k < best) best = k; }
    return best;
  }
  function makeOrient(cells) {
    const n = normalize(cells), { w, h } = dims(n);
    const rows = new Array(h).fill(0);
    for (const [r, c] of n) rows[r] |= 1 << c;
    const sh = [];
    for (let c = 0; c + w <= COLS; c++) sh.push(rows.map((m) => m << c));
    return { cells: n, w, h, rows, sh, n: n.length, key: keyOf(n) };
  }
  function parseRows(rows) {
    const cells = [];
    rows.forEach((line, r) => { for (let c = 0; c < line.length; c++) if (line[c] === '#') cells.push([r, c]); });
    return cells;
  }

  const LIBRARY = LIBRARY_DEF.map(([name, rows]) => {
    const cells = parseRows(rows);
    return {
      name, cells, n: cells.length, key: canonicalKey(cells),
      orients: allOrientCells(cells).map(makeOrient),
    };
  });
  const LIB_BY_KEY = new Map(LIBRARY.map((l) => [l.key, l]));
  function identify(cells) { return LIB_BY_KEY.get(canonicalKey(cells)) || null; }

  // 현재 보이는 방향 → 목표 방향까지 최소 클릭 (R=회전, F=반전)
  function clickPath(fromCells, toCells, rotateDir) {
    const target = keyOf(toCells);
    const rot = rotateDir === 'ccw' ? rotateCCW : rotateCW;
    const start = normalize(fromCells);
    const q = [[start, '']], seen = new Set([keyOf(start)]);
    while (q.length) {
      const [cur, path] = q.shift();
      if (keyOf(cur) === target) return path;
      for (const [op, fn] of [['R', rot], ['F', flipH]]) {
        const nx = fn(cur), k = keyOf(nx);
        if (!seen.has(k)) { seen.add(k); q.push([nx, path + op]); }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- 평가 함수
  // 가중치는 무작위 조각 자가 대전 시뮬레이션으로 튜닝 (평균 점수 최대).
  // 튜닝에 쓰지 않은 시드 48판 검증: 평균 82,572점 / 생존 118턴 (초기값 35,738점 / 59턴).
  // '안전'(생존 가중↑)·'공격'(다중 제거 가중↑) 변형은 검증에서 평균·생존 모두 낮아 넣지 않았다.
  const STYLES = {
    balanced: { rowFill: 3, filled: 16, rowT: 48, colT: 8, iso: 120, sq3: 25, rect34: 25, line5: 25, mob: 100, pot: 0.8, noPlace: 1000, fewPlace: 350 },
  };

  // a행 x b열 빈 직사각형이 들어갈 수 있는 위치 수
  function countRect(rows, a, b) {
    let n = 0;
    for (let r = 0; r + a <= ROWS; r++) {
      let m = FULL;
      for (let i = 0; i < a; i++) m &= ~rows[r + i];
      m &= FULL;
      for (let k = 1; k < b; k++) m &= m >> 1;
      n += PC[m];
    }
    return n;
  }
  const ITEM_VALUE = { dot: 180, swap: 140 }; // 아이템은 보너스 개념의 가치 (실제 점수 +50 은 별도)
  const DOT_COST = 260;                      // 점 찍기 1회 사용의 기회비용

  function evalCheap(rows, W) {
    let filled = 0, rowT = 0, colT = 0, iso = 0, rowFill = 0;
    let prev = FULL;
    for (let r = 0; r < ROWS; r++) {
      const x = rows[r];
      const k = PC[x];
      filled += k;
      rowFill += k * k;
      const xw = (x << 1) | 1 | (1 << (COLS + 1));
      rowT += PC[(xw ^ (xw >> 1)) & 0x7FF];
      colT += PC[x ^ prev];
      prev = x;
      const e = ~x & FULL;
      if (e) {
        const up = r > 0 ? (~rows[r - 1] & FULL) : 0;
        const dn = r < ROWS - 1 ? (~rows[r + 1] & FULL) : 0;
        const nb = ((e << 1) | (e >> 1) | up | dn) & FULL;
        iso += PC[e & ~nb];
      }
    }
    colT += PC[prev ^ FULL];
    // 큰 조각용 빈 공간 (많을수록 좋지만 체감 → 제곱근)
    const sq3 = Math.sqrt(countRect(rows, 3, 3));
    const rect34 = Math.sqrt(countRect(rows, 3, 4) + countRect(rows, 4, 3));
    const line5 = Math.sqrt(countRect(rows, 1, 5) + countRect(rows, 5, 1));
    return W.rowFill * rowFill - W.filled * filled - W.rowT * rowT - W.colT * colT - W.iso * iso
      + W.sq3 * sq3 + W.rect34 * rect34 + W.line5 * line5;
  }

  // 다음에 나올 조각 기준 정밀 평가: 놓을 자리 유무(생존) + 한 번에 지울 수 있는 최대 줄 수(잠재력)
  function evalDeep(rows, W) {
    let surv = 0, pot = 0, mob = 0;
    const detail = [];
    for (const L of LIBRARY) {
      let count = 0, best = 0;
      for (const o of L.orients) {
        const h = o.h;
        for (let r = 0; r + h <= ROWS; r++) {
          for (let c = 0; c < o.sh.length; c++) {
            const m = o.sh[c];
            let ok = true;
            for (let i = 0; i < h; i++) if (rows[r + i] & m[i]) { ok = false; break; }
            if (!ok) continue;
            count++;
            let lines = 0;
            for (let i = 0; i < h; i++) if ((rows[r + i] | m[i]) === FULL) lines++;
            if (lines > best) best = lines;
          }
        }
      }
      if (count === 0) surv += W.noPlace;
      else if (count < 3) surv += W.fewPlace;
      mob += Math.log2(1 + count);
      pot += LINE_SCORE[best];
      detail.push({ name: L.name, count, best });
    }
    pot /= LIBRARY.length;
    mob /= LIBRARY.length;
    return { value: W.pot * pot - surv + W.mob * mob, surv, pot, mob, detail };
  }

  // ---------------------------------------------------------------- 탐색
  // 상위 K개 보관용 최소 힙
  class TopK {
    constructor(k) { this.k = k; this.v = []; this.d = []; }
    min() { return this.v.length < this.k ? -Infinity : this.v[0]; }
    push(val, data) {
      const v = this.v, d = this.d;
      if (v.length < this.k) {
        v.push(val); d.push(data);
        let i = v.length - 1;
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (v[p] <= v[i]) break;
          [v[p], v[i]] = [v[i], v[p]]; [d[p], d[i]] = [d[i], d[p]]; i = p;
        }
      } else if (val > v[0]) {
        v[0] = val; d[0] = data;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < v.length && v[l] < v[m]) m = l;
          if (r < v.length && v[r] < v[m]) m = r;
          if (m === i) break;
          [v[m], v[i]] = [v[i], v[m]]; [d[m], d[i]] = [d[i], d[m]]; i = m;
        }
      }
    }
    items() { return this.d.map((d, i) => ({ val: this.v[i], d })).sort((a, b) => b.val - a.val); }
  }

  // 조각 1개를 (r,c)에 놓은 결과 계산 (scratch 배열에 기록)
  function applyMove(rows, items, o, ci, r, out) {
    for (let i = 0; i < ROWS; i++) out[i] = rows[i];
    const m = o.sh[ci];
    for (let i = 0; i < o.h; i++) out[r + i] |= m[i];
    let lines = 0, cleared = 0, gotDot = 0, gotSwap = 0;
    for (let i = 0; i < o.h; i++) {
      if (out[r + i] === FULL) { lines++; cleared |= 1 << (r + i); }
    }
    if (lines) {
      for (let i = 0; i < o.h; i++) if (cleared & (1 << (r + i))) out[r + i] = 0;
      for (const it of items) {
        if (!it.got && (cleared & (1 << it.r))) { if (it.type === 'dot') gotDot++; else if (it.type === 'swap') gotSwap++; }
      }
    }
    return { lines, cleared, gotDot, gotSwap };
  }

  function search(rows0, items0, slots, dots, W, beamWidth) {
    const nS = slots.length;
    const DOT_ORIENT = makeOrient([[0, 0]]);
    const start = { rows: Int32Array.from(rows0), items: items0.map((it) => ({ ...it, got: false })), rem: (1 << nS) - 1,
      dotsLeft: dots, gain: 0, bonus: 0, moves: [], value: 0, placed: 0 };
    let beam = [start];
    const complete = [];
    let bestPartial = { placed: 0, value: -Infinity, st: start };
    const scratch = new Int32Array(ROWS);
    let nodes = 0;
    const maxDepth = nS + dots;
    for (let depth = 0; depth < maxDepth && beam.length; depth++) {
      const heap = new TopK(beamWidth * 3);
      for (let bi = 0; bi < beam.length; bi++) {
        const st = beam[bi];
        const seen = new Set();
        const choices = [];
        for (let s = 0; s < nS; s++) {
          if (!(st.rem & (1 << s)) || seen.has(slots[s].key)) continue;
          seen.add(slots[s].key);
          choices.push(s);
        }
        if (st.dotsLeft > 0) choices.push(-1);
        for (const s of choices) {
          const orients = s >= 0 ? slots[s].orients : [DOT_ORIENT];
          for (let oi = 0; oi < orients.length; oi++) {
            const o = orients[oi];
            for (let r = 0; r + o.h <= ROWS; r++) {
              for (let ci = 0; ci < o.sh.length; ci++) {
                const m = o.sh[ci];
                let ok = true;
                for (let i = 0; i < o.h; i++) if (st.rows[r + i] & m[i]) { ok = false; break; }
                if (!ok) continue;
                nodes++;
                const res = applyMove(st.rows, st.items, o, ci, r, scratch);
                // 점 찍기는 줄을 완성할 때만 의미가 있다 (빈 곳 메우기는 다음 조각으로 충분)
                if (s < 0 && res.lines === 0) continue;
                const gain = o.n * (s >= 0 ? 1 : 0) + LINE_SCORE[res.lines] + (res.gotDot + res.gotSwap) * ABILITY_SCORE;
                const bonus = res.gotDot * ITEM_VALUE.dot + res.gotSwap * ITEM_VALUE.swap - (s < 0 ? DOT_COST : 0);
                const val = st.gain + st.bonus + gain + bonus + evalCheap(scratch, W);
                if (val <= heap.min()) continue;
                heap.push(val, { bi, s, oi, r, ci, gain, bonus });
              }
            }
          }
        }
      }
      // 실체화 + 중복 제거
      const next = [], keys = new Set();
      for (const { val, d } of heap.items()) {
        if (next.length >= beamWidth) break;
        const st = beam[d.bi];
        const o = d.s >= 0 ? slots[d.s].orients[d.oi] : DOT_ORIENT;
        const rows = new Int32Array(ROWS);
        const res = applyMove(st.rows, st.items, o, d.ci, d.r, rows);
        const rem = d.s >= 0 ? st.rem & ~(1 << d.s) : st.rem;
        const dotsLeft = d.s >= 0 ? st.dotsLeft : st.dotsLeft - 1;
        const key = rows.join(',') + '|' + rem + '|' + dotsLeft;
        if (keys.has(key)) continue;
        keys.add(key);
        const items = res.lines ? st.items.map((it) => (!it.got && (res.cleared & (1 << it.r))) ? { ...it, got: true } : it) : st.items;
        const cells = o.cells.map(([rr, cc]) => [rr + d.r, cc + d.ci]);
        const clearedRows = [];
        for (let i = 0; i < ROWS; i++) if (res.cleared & (1 << i)) clearedRows.push(i);
        const move = {
          slot: d.s, orient: o.cells, w: o.w, h: o.h, r: d.r, c: d.ci, cells,
          lines: res.lines, clearedRows, gain: d.gain, gotDot: res.gotDot, gotSwap: res.gotSwap,
        };
        const ns = {
          rows, items, rem, dotsLeft, gain: st.gain + d.gain, bonus: st.bonus + d.bonus,
          moves: st.moves.concat([move]), value: val, placed: st.placed + (d.s >= 0 ? 1 : 0),
        };
        next.push(ns);
        if (rem === 0) complete.push(ns);
        if (ns.placed > bestPartial.placed || (ns.placed === bestPartial.placed && val > bestPartial.value)) {
          bestPartial = { placed: ns.placed, value: val, st: ns };
        }
      }
      beam = next.filter((s) => s.rem !== 0);
    }
    return { complete, bestPartial, nodes };
  }

  function finalize(states, W, topK) {
    states.sort((a, b) => b.value - a.value);
    const seen = new Set();
    let best = null;
    let n = 0;
    for (const st of states) {
      const key = st.rows.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      if (n++ >= topK) break;
      const deep = evalDeep(st.rows, W);
      const total = st.value + deep.value;
      if (!best || total > best.total) best = { st, total, deep };
    }
    return best;
  }

  function boardToRows(board) {
    const rows = new Int32Array(ROWS);
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (board[r][c] > 0) rows[r] |= 1 << c;
    return rows;
  }

  // ---------------------------------------------------------------- 사람이 놓기 쉬운 순서
  // 정해진 배치를 주어진 순서로 다시 놓아보며 줄 제거·점수를 계산한다. 놓을 수 없는 순서면 null.
  // contact = 놓기 직전에 그 조각이 기존 블럭(1점)·벽(0.5점)과 맞닿는 변의 수
  function replay(rows0, items, moves) {
    const rows = Int32Array.from(rows0);
    const got = new Set();
    const out = [], contacts = [];
    let total = 0;
    for (const m of moves) {
      for (const [r, c] of m.cells) if (rows[r] & (1 << c)) return null;
      const own = new Set(m.cells.map(([r, c]) => r * 16 + c));
      let contact = 0;
      for (const [r, c] of m.cells) {
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS) { contact += 0.5; continue; }
          if (!own.has(rr * 16 + cc) && (rows[rr] & (1 << cc))) contact += 1;
        }
      }
      for (const [r, c] of m.cells) rows[r] |= 1 << c;
      // 이 조각이 놓인 줄만 제거 대상 (본 탐색 applyMove 와 같은 기준)
      const clearedRows = [];
      const touched = new Set(m.cells.map(([r]) => r));
      for (const r of touched) if (rows[r] === FULL) clearedRows.push(r);
      clearedRows.sort((a, b) => a - b);
      for (const r of clearedRows) rows[r] = 0;
      let gotDot = 0, gotSwap = 0;
      items.forEach((it, i) => {
        if (!got.has(i) && clearedRows.includes(it.r)) { got.add(i); if (it.type === 'dot') gotDot++; else if (it.type === 'swap') gotSwap++; }
      });
      const lines = clearedRows.length;
      const gain = (m.slot >= 0 ? m.cells.length : 0) + LINE_SCORE[lines] + (gotDot + gotSwap) * ABILITY_SCORE;
      total += gain;
      out.push({ ...m, lines, clearedRows, gain, gotDot, gotSwap });
      contacts.push(contact);
    }
    return { moves: out, total, key: rows.join(','), contacts };
  }
  function permutations(n) {
    if (n <= 1) return [[0].slice(0, n)];
    const res = [];
    for (const p of permutations(n - 1)) for (let i = 0; i <= p.length; i++) res.push([...p.slice(0, i), n - 1, ...p.slice(i)]);
    return res;
  }
  // 순서를 바꿔도 최종 판과 점수가 같으면, 기존 블럭에 맞닿는 위치에 놓는 조각을 먼저 안내한다
  // (허공에 뜬 위치는 다른 조각이 놓인 뒤로 미룸 → 위치 착각이 줄어듦)
  function humanOrder(rows0, items, moves) {
    if (moves.length < 2) return moves;
    const base = replay(rows0, items, moves);
    if (!base) return moves;
    let best = base;
    for (const perm of permutations(moves.length)) {
      const r = replay(rows0, items, perm.map((i) => moves[i]));
      if (!r || r.key !== base.key || r.total < base.total) continue;
      for (let k = 0; k < r.contacts.length; k++) {
        if (r.contacts[k] > best.contacts[k] + 1e-9) { best = r; break; }
        if (r.contacts[k] < best.contacts[k] - 1e-9) break;
      }
    }
    return best.moves;
  }

  function planOut(best, slots, nodes, rows0, items) {
    const st = best.st;
    const ordered = rows0 ? humanOrder(rows0, items || [], st.moves) : st.moves;
    return {
      moves: ordered.map((m) => ({ ...m, slot: m.slot >= 0 ? slots[m.slot].slot : -1 })),
      gain: ordered.reduce((a, m) => a + m.gain, 0), total: best.total,
      linesTotal: ordered.reduce((a, m) => a + m.lines, 0),
      dotsUsed: st.moves.filter((m) => m.slot < 0).length,
      finalRows: Array.from(st.rows),
      risk: best.deep ? best.deep.detail.filter((d) => d.count === 0).map((d) => d.name) : [],
      nodes,
    };
  }

  /**
   * input: {
   *   board: 16x10 (0=빈칸, >0=블럭),
   *   items: [{r,c,type:'dot'|'swap'}],
   *   pieces: [ {cells:[[r,c],...]} | null ] (슬롯 0~2, null=사용 완료),
   *   dots: 보유 점 찍기 수, swaps: 보유 바꿔 뽑기 수,
   *   style: 'safe'|'balanced'|'aggressive', beam: 빔 폭
   * }
   */
  function solve(input) {
    const t0 = Date.now();
    const W = STYLES[input.style] || STYLES.balanced;
    const beamWidth = input.beam || 160;
    const rows = boardToRows(input.board);
    // 입력에 가득 찬 줄은 있을 수 없다(인식 오류). 남겨두면 조각과 무관하게 '제거'로 계산될 수 있어 막아둔다
    for (let r = 0; r < ROWS; r++) if (rows[r] === FULL) return { ok: false, reason: 'full-row-in-input', ms: Date.now() - t0 };
    // 블럭 아래 깔린 아이템도 줄 제거 시 획득. 회색(비활성) 아이템은 능력이 가득 차서 얻을 수 없으므로 제외
    const items = (input.items || []).filter((it) => it.type === 'dot' || it.type === 'swap');
    const slots = [];
    (input.pieces || []).forEach((p, i) => {
      if (!p || !p.cells || !p.cells.length) return;
      const cells = normalize(p.cells);
      slots.push({ slot: i, key: canonicalKey(cells), orients: allOrientCells(cells).map(makeOrient), cells });
    });
    if (!slots.length) return { ok: false, reason: 'no-pieces', ms: Date.now() - t0 };

    const main = search(rows, items, slots, 0, W, beamWidth);
    const out = { ok: true, ms: 0, slots: slots.map((s) => s.slot) };
    let bestMain = main.complete.length ? finalize(main.complete, W, 300) : null;
    if (bestMain) {
      out.plan = planOut(bestMain, slots, main.nodes, rows, items);
      out.complete = true;
    } else {
      // 3개를 모두 놓을 수 없음 → 가능한 만큼 놓는 최선안
      const bp = main.bestPartial;
      out.complete = false;
      out.plan = planOut({ st: bp.st, total: bp.value, deep: null }, slots, main.nodes, rows, items);
      const placedSlots = new Set(bp.st.moves.map((m) => m.slot));
      out.stuckSlots = slots.filter((s, i) => !placedSlots.has(i)).map((s) => s.slot);
    }

    // 점 찍기를 쓰면 더 좋아지는지 (보너스 판단)
    const dots = Math.min(2, input.dots | 0);
    if (dots > 0) {
      const withDot = search(rows, items, slots, dots, W, Math.max(60, beamWidth >> 1));
      const bestDot = withDot.complete.length ? finalize(withDot.complete, W, 200) : null;
      if (bestDot && bestDot.st.moves.some((m) => m.slot < 0)) {
        const improve = bestMain ? bestDot.total - bestMain.total : Infinity;
        if (!bestMain || improve > 400) {
          out.dotPlan = planOut(bestDot, slots, withDot.nodes, rows, items);
          out.dotPlan.improve = improve;
        }
      }
    }
    // 바꿔 뽑기 조언: 놓을 수 없는 조각이 있을 때
    if (!out.complete && (input.swaps | 0) > 0 && !out.dotPlan) {
      out.swapAdvice = { slots: out.stuckSlots };
    }
    out.ms = Date.now() - t0;
    return out;
  }

  return {
    COLS, ROWS, FULL, LINE_SCORE, LIBRARY, STYLES,
    normalize, keyOf, dims, rotateCW, rotateCCW, flipH, allOrientCells, canonicalKey, identify, clickPath,
    boardToRows, evalCheap, evalDeep, humanOrder, solve,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createSolver };
