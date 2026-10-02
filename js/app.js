/*
 * 한글 모아모아 도우미 - 화면 공유/이미지 입력 → 인식 → 추천 표시
 * 게임 프로그램에는 아무것도 보내지 않는다. 브라우저 화면 공유(getDisplayMedia) 영상만 읽는다.
 */
(function () {
  'use strict';
  const V = window.MoaVision;
  const S = createSolver();            // 모양 유틸용 (무거운 탐색은 Worker 에서)
  const ROWS = 16, COLS = 10;
  const $ = (id) => document.getElementById(id);
  // 실시간 화면은 작은 창(다른 문서)으로 옮겨질 수 있어서 참조를 미리 잡아둔다
  const LIVE = { box: $('liveBox'), canvas: $('live'), empty: $('liveEmpty') };

  // ------------------------------------------------------------------ 설정 (브라우저에만 저장)
  const DEFAULTS = { style: 'balanced', rotateDir: 'cw', interval: 450, dots: 1, swaps: 1, beam: 200 };
  const settings = Object.assign({}, DEFAULTS, loadSettings());
  settings.style = 'balanced'; // 검증 결과 단일 전략만 사용
  function loadSettings() {
    try { return JSON.parse(localStorage.getItem('moa-settings') || '{}'); } catch (e) { return {}; }
  }
  function saveSettings() {
    try { localStorage.setItem('moa-settings', JSON.stringify(settings)); } catch (e) { /* 저장 불가 환경 */ }
  }

  // ------------------------------------------------------------------ 계산 Worker (file:// 에서도 동작하도록 Blob 사용)
  let worker = null, solveSeq = 0;
  const pendingSolves = new Map();
  try {
    const src = createSolver.toString() +
      '\nconst S = createSolver();\nself.onmessage = function (e) { var out; try { out = S.solve(e.data.input); } catch (err) { out = { ok: false, reason: String(err) }; } self.postMessage({ id: e.data.id, out: out }); };';
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = (e) => {
      const cb = pendingSolves.get(e.data.id);
      pendingSolves.delete(e.data.id);
      if (cb) cb(e.data.out);
    };
  } catch (e) {
    worker = null; // Worker 불가 → 메인 스레드에서 계산
  }
  function runSolve(input) {
    if (!worker) return Promise.resolve(S.solve(input));
    const id = ++solveSeq;
    return new Promise((res) => { pendingSolves.set(id, res); worker.postMessage({ id, input }); });
  }

  // ------------------------------------------------------------------ 상태
  const app = {
    source: null,          // 'capture' | 'image' | 'manual'
    stream: null,
    grid: null,            // 최근 잠긴 게임판 격자 (프레임 좌표)
    frameCanvas: document.createElement('canvas'),
    lastFrame: null,       // 실시간 미리보기용 {canvas, crop}
    candidate: null, candidateCount: 0,
    stable: null,          // 확정된 관측 상태
    plan: null,            // { input, out, boards[], step, key }
    viewStep: null,        // 사용자가 클릭해서 보는 단계
    solving: false, solveKey: null,
    lastOrientKey: [null, null, null],
    editMode: false,
    timer: null,
  };
  const frameCtx = app.frameCanvas.getContext('2d', { willReadFrequently: true });

  // ------------------------------------------------------------------ 상태 표시
  function setStatus(text, kind) {
    const el = $('status');
    el.textContent = text;
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  // ------------------------------------------------------------------ 화면 공유
  async function startCapture() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      alert('이 브라우저는 화면 공유를 지원하지 않습니다. 최신 크롬/엣지에서 열어주세요.\n(파일을 더블클릭해 연 경우에도 크롬/엣지는 지원합니다)');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 5, max: 10 }, cursor: 'never' },
        audio: false,
      });
      stopCapture();
      app.stream = stream;
      app.source = 'capture';
      app.grid = null;
      app.lastFoundAt = Date.now();
      const video = $('video');
      video.srcObject = stream;
      await video.play().catch(() => {});
      stream.getVideoTracks()[0].addEventListener('ended', () => { stopCapture(); setStatus('화면 공유 종료됨'); });
      $('btnShare').textContent = '공유 중지';
      $('btnShare').classList.remove('primary');
      $('btnShare').classList.add('danger');
      setStatus('한글 모아모아 창을 찾는 중…', 'wait');
      scheduleTick(50);
    } catch (e) {
      if (e && e.name !== 'NotAllowedError') alert('화면 공유를 시작하지 못했습니다: ' + e.message);
    }
  }
  function stopCapture() {
    if (app.stream) app.stream.getTracks().forEach((t) => t.stop());
    app.stream = null;
    $('video').srcObject = null;
    clearTimeout(app.timer);
    $('btnShare').textContent = '화면 공유 시작';
    $('btnShare').classList.add('primary');
    $('btnShare').classList.remove('danger');
  }
  function scheduleTick(ms) {
    clearTimeout(app.timer);
    app.timer = setTimeout(tick, ms);
  }
  const AUTO_STOP_MS = 5 * 60 * 1000;
  function pipOpen() { return !!app.pip || !!document.pictureInPictureElement; }
  function tick() {
    if (!app.stream || app.editMode) return;
    // 페이지가 안 보이고(최소화·다른 탭) 작은 창도 없으면 분석을 쉬어 CPU를 아낀다. 돌아오면 바로 다시 맞춘다.
    if (document.hidden && !pipOpen()) { scheduleTick(2000); return; }
    const video = $('video');
    let found = false;
    if (video.readyState >= 2 && video.videoWidth) {
      try {
        analyzeSource(video, video.videoWidth, video.videoHeight, false);
        found = !!(app.lastFrame && (app.lastFrame.res.found || app.lastFrame.res.tracking));
      } catch (e) { console.error(e); }
    }
    if (!found) {
      app.missCount = (app.missCount || 0) + 1;
      if (app.missCount >= 4 && !app.plan) {
        $('boardCaption').textContent = '게임판을 못 찾고 있어요: 한글 모아모아 창이 열려 있는지, 다른 창에 가려지지 않았는지 확인하세요. ' +
          '화면이 검게 나오면 게임을 창 모드로 바꾸거나 [전체 화면]을 공유해 보세요.';
      }
    } else { app.missCount = 0; app.lastFoundAt = Date.now(); }
    // 공유를 끄는 걸 잊은 경우: 게임판이 오래 안 보이면 화면 공유를 스스로 끈다
    if (!found && Date.now() - (app.lastFoundAt || Date.now()) > AUTO_STOP_MS) {
      stopCapture();
      setStatus('5분 동안 게임판이 보이지 않아 화면 공유를 자동으로 껐습니다', 'wait');
      return;
    }
    // 전체 화면 탐색은 무거우므로 못 찾는 동안은 천천히
    scheduleTick(found ? settings.interval : Math.max(settings.interval, 2000));
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && app.stream) scheduleTick(50); });
  // 페이지를 닫거나 떠날 때 화면 공유·작은 창·계산 작업을 확실히 정리 (공유 중지 없이 브라우저를 닫는 경우 대비)
  window.addEventListener('pagehide', (e) => {
    try { stopCapture(); } catch (err) { /* 무시 */ }
    try { if (app.pip) app.pip.close(); } catch (err) { /* 무시 */ }
    try { stopPipVideo(); } catch (err) { /* 무시 */ }
    try { if (!e.persisted && worker) worker.terminate(); } catch (err) { /* 무시 */ }
  });

  // ------------------------------------------------------------------ 프레임 분석
  function analyzeSource(src, W, H, isStill) {
    // 격자를 이미 알면 주변만 잘라서 분석 (빠름)
    let crop = { x: 0, y: 0, w: W, h: H };
    if (app.grid && !isStill) {
      const g = app.grid;
      const x0 = Math.max(0, Math.floor(g.x0 - 1.5 * g.Px));
      const y0 = Math.max(0, Math.floor(g.y0 - 2.5 * g.Py));
      const x1 = Math.min(W, Math.ceil(g.x0 + 16.5 * g.Px));
      const y1 = Math.min(H, Math.ceil(g.y0 + 18 * g.Py));
      crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    app.frameCanvas.width = crop.w;
    app.frameCanvas.height = crop.h;
    frameCtx.drawImage(src, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
    const img = frameCtx.getImageData(0, 0, crop.w, crop.h);
    const prev = app.grid ? { ...app.grid, x0: app.grid.x0 - crop.x, y0: app.grid.y0 - crop.y } : null;
    let res = V.analyze(img, prev);
    if (!res.found && res.tracking && !isStill) {
      // 같은 자리에 게임판이 있는데 잠깐 가려짐(드래그 중 줄 제거 미리보기 등) → 확대·추천 표시 유지하고 대기
      app.grid = { ...res.grid, x0: res.grid.x0 + crop.x, y0: res.grid.y0 + crop.y };
      app.lastFrame = { canvas: app.frameCanvas, crop, res };
      app.candidate = null; app.candidateCount = 0;
      setStatus(res.reason, 'wait');
      renderLive();
      return;
    }
    if (!res.found && (crop.w !== W || crop.h !== H)) {
      // 창이 움직였을 수 있음 → 전체 프레임 재탐색
      app.grid = null; app.unknownAge = null;
      return analyzeSource(src, W, H, isStill);
    }
    app.lastFrame = { canvas: app.frameCanvas, crop, res };
    if (!res.found) {
      app.grid = null; app.unknownAge = null;
      setStatus(res.reason || '한글 모아모아 창을 찾지 못했습니다', 'wait');
      renderLive();
      return;
    }
    app.grid = { ...res.grid, x0: res.grid.x0 + crop.x, y0: res.grid.y0 + crop.y };
    const obs = toObservation(res, isStill);
    renderLive();
    if (!obs) { setStatus('인식됨 · 화면이 가려져 대기 중', 'wait'); return; }
    acceptObservation(obs, isStill);
  }

  // 인식 결과 → 관측 상태.
  // 알 수 없는 칸: 잠깐(커서·드래그)이면 직전 값으로 메우고, 한두 칸이 오래 안 읽히면 '막힌 칸'(6)으로 간주해
  // 그 칸에 조각을 놓으라고 추천하지 않는다 (직전 값이 계속 이어지면서 실제 블럭을 빈칸으로 착각하는 것 방지).
  const STUCK_FRAMES = 8;
  function toObservation(res, isStill) {
    const prev = app.stable;
    const board = res.board.cells.map((row) => row.slice());
    const age = app.unknownAge || (app.unknownAge = Array.from({ length: ROWS }, () => new Array(COLS).fill(0)));
    let holes = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      if (board[r][c] < 0) { holes++; age[r][c]++; } else age[r][c] = 0;
    }
    if (holes > 6) return null;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      if (board[r][c] >= 0) continue;
      if (isStill || (age[r][c] >= STUCK_FRAMES && holes <= 2)) board[r][c] = 6;
      else if (prev) board[r][c] = prev.board[r][c];
      else return null;
    }
    if (res.board.fullRows > 0) return null; // 줄 제거 애니메이션 중
    // 메운 결과 10칸이 다 찬 줄은 게임에 존재할 수 없다(즉시 제거됨) → 메운 칸은 사실 빈칸
    for (let r = 0; r < ROWS; r++) {
      if (!board[r].every((v) => v > 0)) continue;
      for (let c = 0; c < COLS; c++) if (res.board.cells[r][c] < 0) board[r][c] = 0;
    }
    const pieces = res.pieces.map((p, i) => {
      if (p.status === 'ok') {
        const cells = S.normalize(p.cells);
        const lib = S.identify(cells);
        return { cells, key: S.canonicalKey(cells), okey: S.keyOf(cells), n: cells.length, name: lib ? lib.name : '?', color: p.color };
      }
      if (p.status === 'used') return null;
      return prev ? prev.pieces[i] : undefined; // unknown
    });
    if (pieces.some((p) => p === undefined)) return null;
    return {
      board, items: res.board.items, pieces,
      abilities: res.abilities,
      occKey: board.map((row) => row.map((v) => (v > 0 ? 1 : 0)).join('')).join('/'),
    };
  }

  function obsKey(o) {
    return o.occKey + '|' + o.pieces.map((p) => (p ? p.okey : '-')).join(',') + '|' +
      o.items.map((it) => it.r + ',' + it.c + it.type).join(';');
  }

  function acceptObservation(obs, isStill) {
    const k = obsKey(obs);
    if (!isStill) {
      if (app.candidate && obsKey(app.candidate) === k) app.candidateCount++;
      else { app.candidate = obs; app.candidateCount = 1; }
      if (app.candidateCount < 2) return;   // 연속 2회 같아야 확정 (드래그 중 프레임 무시)
    }
    learnRotation(obs);
    app.stable = obs;
    setStatus('인식됨', 'ok');
    renderSlots();
    onStableState();
  }

  // 사용자가 [회전]을 눌렀을 때 방향을 보고 회전 방향을 자동으로 학습
  function learnRotation(obs) {
    obs.pieces.forEach((p, i) => {
      const prev = app.lastOrientKey[i];
      app.lastOrientKey[i] = p ? { key: p.key, cells: p.cells, okey: p.okey } : null;
      if (!p || !prev || prev.key !== p.key || prev.okey === p.okey) return;
      const cw = S.keyOf(S.rotateCW(prev.cells)) === p.okey;
      const ccw = S.keyOf(S.rotateCCW(prev.cells)) === p.okey;
      if (cw !== ccw) {
        const dir = cw ? 'cw' : 'ccw';
        if (settings.rotateDir !== dir) { settings.rotateDir = dir; saveSettings(); syncSettingsUI(); }
      }
    });
  }

  // ------------------------------------------------------------------ 추천 계산
  function abilityCounts(obs) {
    let dots = settings.dots, swaps = settings.swaps;
    if (obs.abilities && obs.abilities.visible) {
      if (!obs.abilities.dot) dots = 0; else dots = Math.max(1, dots);
      if (!obs.abilities.swap) swaps = 0; else swaps = Math.max(1, swaps);
    }
    return { dots, swaps };
  }

  function solveKeyOf(obs) {
    const ab = abilityCounts(obs);
    return obs.occKey + '|' + obs.pieces.map((p) => (p ? p.key : '-')).join(',') + '|' +
      obs.items.filter((it) => it.type !== 'inactive').map((it) => it.r + ',' + it.c + it.type).join(';') + '|' + ab.dots + ab.swaps + '|' + settings.style;
  }

  function onStableState() {
    const obs = app.stable;
    if (!obs) return;
    // 진행 중인 계획의 k번째 단계 결과와 같으면 계획 유지 (다음 단계 안내)
    const plan = app.plan;
    if (plan && plan.sel) {
      const remaining = obs.pieces.map((p) => (p ? p.key : null));
      for (let k = 0; k <= plan.boards.length - 1; k++) {
        if (plan.occ[k] !== obs.occKey) continue;
        const rem = plan.remaining[k];
        if (rem.every((key, i) => key === remaining[i]) && plan.style === settings.style) {
          if (plan.step !== k) { plan.step = k; app.viewStep = null; }
          renderPlan();
          return;
        }
      }
    }
    if (!obs.pieces.some(Boolean)) { renderPlan(); return; }
    const key = solveKeyOf(obs);
    if (app.solveKey === key && plan) { renderPlan(); return; }
    app.solveKey = key;
    const ab = abilityCounts(obs);
    const input = {
      board: obs.board, items: obs.items,
      pieces: obs.pieces.map((p) => (p ? { cells: p.cells } : null)),
      dots: ab.dots, swaps: ab.swaps, style: settings.style, beam: settings.beam,
    };
    setStatus('인식됨 · 계산 중…', 'ok');
    const myKey = key;
    runSolve(input).then((out) => {
      if (app.solveKey !== myKey) return; // 그 사이 상태가 바뀜
      app.plan = buildPlan(input, out, obs);
      app.viewStep = null;
      setStatus(app.source === 'capture' ? '인식됨' : '분석 완료', 'ok');
      renderPlan();
    });
  }

  // 단계별 예상 보드/남은 조각을 미리 계산해 둔다. useDot 이면 점 찍기 사용안을 표시.
  function buildPlan(input, out, obs, useDot) {
    const sel = !out.ok ? null : (useDot && out.dotPlan ? out.dotPlan : out.plan) || null;
    const plan = { input, out, sel, step: 0, boards: [], occ: [], remaining: [], style: input.style, usingDot: !!(useDot && out.dotPlan) };
    const moves = sel ? sel.moves : [];
    let board = obs.board.map((r) => r.slice());
    let rem = obs.pieces.map((p) => (p ? p.key : null));
    const push = () => {
      plan.boards.push(board.map((r) => r.slice()));
      plan.occ.push(board.map((row) => row.map((v) => (v > 0 ? 1 : 0)).join('')).join('/'));
      plan.remaining.push(rem.slice());
    };
    push();
    for (const m of moves) {
      const color = m.slot >= 0 && obs.pieces[m.slot] ? colorIndex(obs.pieces[m.slot].color) : 5;
      for (const [r, c] of m.cells) board[r][c] = color;
      for (const r of m.clearedRows) board[r] = new Array(COLS).fill(0);
      if (m.slot >= 0) rem[m.slot] = null;
      push();
    }
    return plan;
  }
  function colorIndex(rgb) {
    if (!rgb) return 5;
    const [r, g, b] = rgb;
    if (r > 190 && g > 150 && b < 130) return 1;
    if (r > 180 && b > 150 && g < 170) return 2;
    if (g > 150 && b < 110) return 3;
    if (b > 200) return 4;
    return 5;
  }

  // ------------------------------------------------------------------ 그리기
  const CSS = getComputedStyle(document.documentElement);
  const COLOR = {
    // 격자선을 칸보다 밝게: 전체 화면 공유 시 이 그림이 게임판(어두운 격자선)으로 인식되지 않게
    empty: '#4f9fca', line: '#74bce3',
    1: CSS.getPropertyValue('--c1').trim() || '#fed73b', 2: CSS.getPropertyValue('--c2').trim() || '#f483de',
    3: CSS.getPropertyValue('--c3').trim() || '#9bd015', 4: CSS.getPropertyValue('--c4').trim() || '#5ec6fe', 5: '#b9c4d6', 6: '#5d6b80',
  };
  const STEP_COLORS = ['#ff5d8f', '#ffb000', '#00d1ff', '#ffffff', '#ffffff'];

  function drawBlock(ctx, x, y, s, fill) {
    const p = Math.max(1, s * 0.06);
    ctx.fillStyle = fill;
    roundRect(ctx, x + p, y + p, s - 2 * p, s - 2 * p, s * 0.18);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    roundRect(ctx, x + s * 0.18, y + s * 0.14, s * 0.3, s * 0.16, s * 0.08);
    ctx.fill();
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function drawItem(ctx, x, y, s, type) {
    const cx = x + s / 2, cy = y + s / 2;
    if (type === 'dot') {
      ctx.strokeStyle = '#0b3d7a'; ctx.lineWidth = Math.max(1.5, s * 0.08);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(cx, cy, s * 0.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#16c8ea';
      ctx.beginPath(); ctx.arc(cx, cy, s * 0.13, 0, Math.PI * 2); ctx.fill();
    } else {
      // 바꿔 뽑기(보라) / 비활성(회색: 능력이 가득 차 얻을 수 없음)
      ctx.fillStyle = type === 'inactive' ? 'rgba(150,160,170,.85)' : '#a24bff';
      ctx.beginPath(); ctx.arc(cx, cy, s * 0.3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `800 ${Math.round(s * 0.38)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(type === 'inactive' ? '·' : '⇄', cx, cy + 1);
    }
  }

  function renderBoard() {
    const cv = $('board');
    const ctx = cv.getContext('2d');
    const pad = 22, s = Math.floor((cv.width - pad - 4) / COLS);
    cv.height = pad + s * ROWS + 4;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const obs = app.stable;
    const plan = app.plan;
    const step = currentViewStep();
    let board = obs ? obs.board : null;
    if (plan && plan.boards[step]) board = plan.boards[step];
    // 좌표 라벨
    ctx.fillStyle = '#6f82a3';
    ctx.font = `600 ${Math.round(s * 0.36)}px Pretendard, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let c = 0; c < COLS; c++) ctx.fillText(String(c + 1), pad + c * s + s / 2, pad / 2);
    for (let r = 0; r < ROWS; r++) ctx.fillText(String(r + 1), pad / 2, pad + r * s + s / 2);
    // 판 바탕
    ctx.fillStyle = COLOR.empty;
    roundRect(ctx, pad - 2, pad - 2, s * COLS + 4, s * ROWS + 4, 6); ctx.fill();
    ctx.strokeStyle = COLOR.line; ctx.lineWidth = 1;
    for (let c = 1; c < COLS; c++) { ctx.beginPath(); ctx.moveTo(pad + c * s + 0.5, pad); ctx.lineTo(pad + c * s + 0.5, pad + ROWS * s); ctx.stroke(); }
    for (let r = 1; r < ROWS; r++) { ctx.beginPath(); ctx.moveTo(pad, pad + r * s + 0.5); ctx.lineTo(pad + COLS * s, pad + r * s + 0.5); ctx.stroke(); }
    if (!board) return;
    const mv = plan && plan.sel ? plan.sel.moves[step] : null;
    // 이번 단계에 지워질 줄: 블럭 뒤에 밝게 깔기
    if (mv) {
      ctx.fillStyle = 'rgba(160,255,200,.45)';
      for (const r of mv.clearedRows) ctx.fillRect(pad, pad + r * s, COLS * s, s);
    }
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const v = board[r][c];
      if (v > 0) drawBlock(ctx, pad + c * s, pad + r * s, s, COLOR[v] || COLOR[5]);
      if (v === 6) { // 읽지 못해 막힌 칸으로 간주한 칸
        ctx.fillStyle = '#fff'; ctx.font = `800 ${Math.round(s * 0.5)}px Pretendard, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('?', pad + c * s + s / 2, pad + r * s + s / 2 + 1);
      }
    }
    // 아이템 (아직 남아있는 것만)
    if (obs) {
      for (const it of obs.items) {
        if (plan && step > 0 && itemTakenBefore(plan, it, step)) continue;
        drawItem(ctx, pad + it.c * s, pad + it.r * s, s, it.type);
      }
    }
    // 이번 단계 이동
    if (mv) {
      const col = mv.slot < 0 ? STEP_COLORS[3] : STEP_COLORS[step % 3];
      ctx.strokeStyle = '#3ddc97'; ctx.lineWidth = 3;
      for (const r of mv.clearedRows) { roundRect(ctx, pad + 1, pad + r * s + 1, COLS * s - 2, s - 2, 5); ctx.stroke(); }
      for (const [r, c] of mv.cells) {
        const x = pad + c * s, y = pad + r * s;
        ctx.fillStyle = col + 'cc';
        roundRect(ctx, x + 2, y + 2, s - 4, s - 4, s * 0.18); ctx.fill();
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5;
        roundRect(ctx, x + 2, y + 2, s - 4, s - 4, s * 0.18); ctx.stroke();
      }
      // 번호
      const [r0, c0] = mv.cells[0];
      ctx.fillStyle = '#111';
      ctx.font = `800 ${Math.round(s * 0.55)}px Pretendard, sans-serif`;
      ctx.fillText(String(step + 1), pad + c0 * s + s / 2, pad + r0 * s + s / 2 + 1);
      // 이후 단계는 점선 윤곽으로
      const moves = plan.sel.moves;
      for (let k = step + 1; k < moves.length; k++) {
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = (moves[k].slot < 0 ? STEP_COLORS[3] : STEP_COLORS[k % 3]) + 'aa';
        ctx.lineWidth = 2;
        for (const [r, c] of moves[k].cells) { roundRect(ctx, pad + c * s + 4, pad + r * s + 4, s - 8, s - 8, 4); ctx.stroke(); }
        ctx.setLineDash([]);
      }
    }
  }
  function itemTakenBefore(plan, it, step) {
    const moves = plan.sel ? plan.sel.moves : [];
    for (let k = 0; k < step && k < moves.length; k++) if (moves[k].clearedRows.includes(it.r)) return true;
    return false;
  }
  function currentViewStep() {
    const plan = app.plan;
    if (!plan) return 0;
    const n = plan.sel ? plan.sel.moves.length : 0;
    const st = app.viewStep != null ? app.viewStep : plan.step;
    return Math.max(0, Math.min(st, Math.max(0, n - 1), plan.boards.length - 1));
  }

  function drawMini(cv, cells, fill, opts) {
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    if (!cells || !cells.length) return;
    const { w, h } = S.dims(cells);
    const s = Math.floor(Math.min((W - 8) / Math.max(w, 3), (H - 8) / Math.max(h, 3)));
    const ox = Math.floor((W - s * w) / 2), oy = Math.floor((H - s * h) / 2);
    for (const [r, c] of cells) drawBlock(ctx, ox + c * s, oy + r * s, s, fill);
    if (opts && opts.outline) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      for (const [r, c] of cells) { roundRect(ctx, ox + c * s + 1, oy + r * s + 1, s - 2, s - 2, s * 0.18); ctx.stroke(); }
    }
  }

  function renderSlots() {
    const box = $('slots');
    box.innerHTML = '';
    const obs = app.stable;
    for (let i = 0; i < 3; i++) {
      const p = obs ? obs.pieces[i] : null;
      const d = document.createElement('div');
      d.className = 'slot' + (p ? '' : ' used');
      const cv = document.createElement('canvas');
      cv.width = 144; cv.height = 144;
      d.appendChild(cv);
      const lb = document.createElement('div');
      lb.className = 'label';
      lb.textContent = p ? `${p.name} ${p.n}칸` : (obs ? '사용 완료' : '-');
      d.appendChild(lb);
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = `${i + 1}번째 조각` + (app.editMode ? ' · 눌러서 변경' : '');
      d.appendChild(sub);
      if (p) drawMini(cv, p.cells, COLOR[colorIndex(p.color)] || COLOR[5]);
      if (app.editMode) { d.style.cursor = 'pointer'; d.onclick = () => openPicker(i); }
      box.appendChild(d);
    }
  }

  function clickInstruction(slot, targetCells) {
    const obs = app.stable;
    const p = obs && obs.pieces[slot];
    if (!p) return null;
    const path = S.clickPath(p.cells, targetCells, settings.rotateDir);
    if (path == null) return null;
    const rot = (path.match(/R/g) || []).length, flip = path.includes('F');
    return { path, rot, flip };
  }

  function renderPlan() {
    renderBoard();
    renderLive();
    const steps = $('steps'), advice = $('advice');
    steps.innerHTML = ''; advice.innerHTML = '';
    const plan = app.plan;
    const out = plan && plan.out;
    const sel = plan && plan.sel;
    if (!out || !sel) {
      $('sumGain').textContent = '-'; $('sumLines').textContent = '-'; $('sumMs').textContent = '-';
      $('boardCaption').textContent = app.stable ? '놓을 조각이 없습니다 (새 조각을 기다리는 중)' : '화면 공유를 시작하거나 스크린샷을 붙여넣으세요 (Ctrl+V)';
      $('stepNav').textContent = '';
      return;
    }
    const moves = sel.moves;
    const doneUpTo = plan.step;
    $('sumGain').textContent = '+' + sel.gain.toLocaleString();
    const multi = moves.filter((m) => m.lines >= 2).map((m) => m.lines + '줄 동시');
    $('sumLines').textContent = sel.linesTotal + '줄' + (multi.length ? ' ★' : '');
    $('sumMs').textContent = out.ms + 'ms';
    const vs = currentViewStep();
    $('stepNav').textContent = moves.length ? `${vs + 1} / ${moves.length} 단계` : '';
    moves.forEach((m, k) => {
      const el = document.createElement('div');
      el.className = 'step' + (k === vs ? ' current' : '') + (k < doneUpTo ? ' done' : '');
      const num = document.createElement('div');
      num.className = 'num';
      num.style.background = m.slot < 0 ? STEP_COLORS[3] : STEP_COLORS[k % 3];
      num.textContent = String(k + 1);
      const cv = document.createElement('canvas');
      cv.width = 128; cv.height = 128;
      const info = document.createElement('div');
      const gain = document.createElement('div');
      gain.className = 'gain';
      gain.innerHTML = `+${m.gain.toLocaleString()}` + (m.lines ? `<small>${m.lines}줄 제거${m.lines >= 2 ? '!' : ''}</small>` : '');
      const pos = `${m.r + 1}행 ${m.c + 1}열`;
      if (m.slot < 0) {
        drawMini(cv, m.orient, '#ffffff');
        info.innerHTML = `<div class="title">점 찍기 사용</div><div class="desc">${m.cells[0][0] + 1}행 ${m.cells[0][1] + 1}열 한 칸을 채웁니다</div>`;
      } else {
        const p = app.stable && app.stable.pieces[m.slot];
        const lib = S.identify(m.orient);
        drawMini(cv, m.orient, COLOR[colorIndex(p ? p.color : null)] || COLOR[5], { outline: true });
        const name = lib ? lib.name : (p ? p.name : '?');
        const ins = k >= doneUpTo ? clickInstruction(m.slot, m.orient) : null;
        let chips = '';
        if (ins) {
          if (!ins.rot && !ins.flip) chips = '<span class="chip ok">✓ 방향 그대로</span>';
          else {
            const parts = [];
            // 실제 누를 순서대로 표시
            let i = 0;
            while (i < ins.path.length) {
              const ch = ins.path[i]; let n = 0;
              while (ins.path[i] === ch) { n++; i++; }
              parts.push(ch === 'R' ? `<span class="chip">회전 ${n}번</span>` : `<span class="chip flip">반전${n > 1 ? ' ' + n + '번' : ''}</span>`);
            }
            chips = parts.join('<span class="desc">→</span>');
          }
        }
        info.innerHTML = `<div class="title">${m.slot + 1}번째 조각 · ${name} ${m.cells.length}칸</div>` +
          `<div class="desc">왼쪽 위 기준 ${pos}</div><div class="click">${chips}</div>`;
      }
      el.append(num, cv, info, gain);
      el.onclick = () => { app.viewStep = k; renderPlan(); };
      steps.appendChild(el);
    });
    $('boardCaption').innerHTML = moves[vs]
      ? `<b>${vs + 1}단계</b>: 색칠된 칸에 놓으세요` + (moves[vs].lines ? ` · 초록 줄 ${moves[vs].lines}개 제거` : '') +
        (moves.length > vs + 1 ? ' · 점선은 다음 단계' : '')
      : '';

    // 조언
    if (!out.complete && !plan.usingDot) {
      const names = (out.stuckSlots || []).map((s) => `${s + 1}번째`).join(', ');
      advice.appendChild(note('danger', `조각 3개를 모두 놓을 자리가 없습니다. 위 순서대로 최대한 놓고, ${names} 조각은 ` +
        (out.swapAdvice ? '<b>바꿔 뽑기</b>로 바꾸는 것을 추천합니다.' : (out.dotPlan ? '아래 점 찍기 사용안을 보세요.' : '놓을 곳이 없어 게임이 끝날 수 있습니다.'))));
    }
    if (out.dotPlan) {
      const dp = out.dotPlan;
      const n = document.createElement('div');
      n.className = 'note good';
      n.innerHTML = plan.usingDot
        ? `지금 <b>점 찍기 ${dp.dotsUsed}개 사용안</b>을 보고 있습니다. 흰색 단계에서 [점 찍기]를 누르고 표시된 칸을 클릭하세요.`
        : `<b>점 찍기 ${dp.dotsUsed}개</b>를 쓰면 이번 턴 예상 <b>+${dp.gain.toLocaleString()}점</b> (` +
          (Number.isFinite(dp.improve) ? `종합 평가 +${Math.round(dp.improve).toLocaleString()}` : '3개 모두 배치 가능') + ')';
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = plan.usingDot ? '기본 추천으로 돌아가기' : '점 찍기 사용안 보기';
      b.onclick = () => toggleDotPlan();
      n.appendChild(document.createElement('br'));
      n.appendChild(b);
      advice.appendChild(n);
    }
    if (sel.risk && sel.risk.length && out.complete) {
      advice.appendChild(note('warn', `이번 턴 후 놓을 자리가 없어지는 조각: <b>${sel.risk.join(', ')}</b> — 다음에 나오면 바꿔 뽑기를 고려하세요.`));
    }
    const stuck = app.stable ? app.stable.board.reduce((a, row) => a + row.filter((v) => v === 6).length, 0) : 0;
    if (stuck) advice.appendChild(note('warn', `화면에서 읽지 못한 칸 ${stuck}개(배치도의 회색 ?)는 <b>막힌 칸으로 보고</b> 계산했습니다. 실제로 비어 있다면 [직접 수정]으로 고쳐주세요.`));
    const items = moves.reduce((a, m) => a + (m.gotDot || 0) + (m.gotSwap || 0), 0);
    if (items) advice.appendChild(note('good', `이 배치로 능력 아이템 ${items}개를 얻습니다 (+${items * 50}점).`));
  }
  function note(kind, html) {
    const d = document.createElement('div');
    d.className = 'note ' + kind;
    d.innerHTML = html;
    return d;
  }
  function toggleDotPlan() {
    const plan = app.plan;
    if (!plan || !plan.out.dotPlan || !app.stable) return;
    app.plan = buildPlan(plan.input, plan.out, app.stable, !plan.usingDot);
    app.viewStep = null;
    renderPlan();
  }

  // 실시간 미리보기: 게임판 주변을 잘라 보여주고 다음 수를 겹쳐 그림
  function renderLive() {
    const lf = app.lastFrame;
    const cv = LIVE.canvas;
    if (!lf) { cv.classList.add('hidden'); LIVE.empty.classList.remove('hidden'); return; }
    cv.classList.remove('hidden'); LIVE.empty.classList.add('hidden');
    const res = lf.res, src = lf.canvas;
    let sx = 0, sy = 0, sw = src.width, sh = src.height;
    const locked = res.found || res.tracking;   // 잠깐 가려진 동안에도 확대 화면 유지
    if (locked) {
      const g = res.grid;
      sx = Math.max(0, g.x0 - 1.2 * g.Px); sy = Math.max(0, g.y0 - 2.2 * g.Py);
      sw = Math.min(src.width - sx, 17.2 * g.Px); sh = Math.min(src.height - sy, 19.6 * g.Py);
    }
    // 화면에 보이는 크기(작은 창 포함)에 맞춰 선명하게
    const dpr = (cv.ownerDocument.defaultView || window).devicePixelRatio || 1;
    const shown = cv.clientWidth || 480;
    const scale = Math.max(360, Math.min(1000, shown * dpr)) / sw;
    const nw = Math.round(sw * scale), nh = Math.round(sh * scale);
    if (cv.width !== nw || cv.height !== nh) { cv.width = nw; cv.height = nh; } // 크기 같으면 재할당하지 않음
    const ctx = cv.getContext('2d');
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
    if (!locked) {
      $('liveInfo').textContent = '게임판 미발견';
      return;
    }
    const g = res.grid;
    const X = (x) => (x - sx) * scale, Y = (y) => (y - sy) * scale;
    const s = g.Px * scale, sy2 = g.Py * scale;
    const cellRect = (r, c, inset) => [X(g.x0 + c * g.Px) + inset, Y(g.y0 + r * g.Py) + inset, s - 2 * inset, sy2 - 2 * inset];
    // 게임판 테두리 (전체 화면 공유 시 이 화면을 게임으로 착각하지 않게 하는 표식 색)
    ctx.strokeStyle = V.SELF_MARK; ctx.lineWidth = Math.max(3, s * 0.12);
    ctx.strokeRect(X(g.x0), Y(g.y0), s * COLS, sy2 * ROWS);
    $('liveInfo').textContent = `칸 크기 ${g.Px.toFixed(1)}px`;

    const plan = app.plan;
    const step = currentViewStep();
    const moves = plan && plan.sel ? plan.sel.moves : [];
    const mv = moves[step];
    const synced = mv && plan.step === step && app.stable && plan.occ[step] === app.stable.occKey;
    let banner = null;
    if (synced) {
      const col = mv.slot < 0 ? STEP_COLORS[3] : STEP_COLORS[step % 3];
      // 지워질 줄 (게임판 표식 초록과 구분되게 밝은 띠 + 흰 테두리)
      ctx.lineWidth = Math.max(2, s * 0.1);
      for (const r of mv.clearedRows) {
        ctx.fillStyle = 'rgba(255,255,255,.22)';
        ctx.fillRect(X(g.x0), Y(g.y0 + r * g.Py), s * COLS, sy2);
        ctx.strokeStyle = '#ffffff';
        ctx.strokeRect(X(g.x0) + 2, Y(g.y0 + r * g.Py) + 2, s * COLS - 4, sy2 - 4);
      }
      // 다음 단계 (점선)
      ctx.setLineDash([Math.max(3, s * 0.18), Math.max(2, s * 0.12)]);
      ctx.lineWidth = Math.max(1.5, s * 0.07);
      for (let k = step + 1; k < moves.length; k++) {
        ctx.strokeStyle = (moves[k].slot < 0 ? STEP_COLORS[3] : STEP_COLORS[k % 3]) + 'cc';
        for (const [r, c] of moves[k].cells) { const [x, y, w, h] = cellRect(r, c, s * 0.16); ctx.strokeRect(x, y, w, h); }
      }
      ctx.setLineDash([]);
      // 이번 단계 위치
      ctx.lineWidth = Math.max(2, s * 0.09);
      for (const [r, c] of mv.cells) {
        const [x, y, w, h] = cellRect(r, c, Math.max(1, s * 0.06));
        ctx.fillStyle = col + '99'; ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = '#fff'; ctx.strokeRect(x, y, w, h);
      }
      const [r0, c0] = mv.cells[0];
      const [nx, ny, nw, nh] = cellRect(r0, c0, 0);
      ctx.fillStyle = '#111'; ctx.font = `800 ${Math.round(s * 0.6)}px Pretendard, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(step + 1), nx + nw / 2, ny + nh / 2 + 1);
      // 써야 할 조각 슬롯(또는 점 찍기 버튼) 강조
      const L = V.LAYOUT, xr = g.x0 + COLS * g.Px;
      const cy = mv.slot < 0 ? g.y0 + L.dotBtnY * g.Py : g.y0 + (L.slotY0 + mv.slot * L.slotDY) * g.Py;
      const half = mv.slot < 0 ? 0.62 : 1.38;
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(3, s * 0.14);
      roundRect(ctx, X(xr + 0.5 * g.Px), Y(cy - half * g.Py), 4.8 * s, 2 * half * sy2, s * 0.25); ctx.stroke();
      banner = { col, title: stepTitle(step, mv), sub: stepSub(mv) };
    } else if (plan && plan.sel && app.stable && plan.step >= moves.length) {
      banner = { col: '#3ddc97', title: '이번 턴 완료', sub: '새 조각을 기다리는 중' };
    } else if (plan && plan.sel && app.viewStep != null) {
      banner = { col: '#8fa0bb', title: `${step + 1}단계 미리보기 중`, sub: '현재 단계로 돌아가려면 목록에서 현재 단계를 누르세요' };
    }
    if (banner) {
      const bh = Math.max(Y(g.y0) - 6, s * 1.3);
      ctx.fillStyle = 'rgba(10,16,28,.88)';
      ctx.fillRect(0, 0, cv.width, bh);
      ctx.fillStyle = banner.col; ctx.fillRect(0, bh - 4, cv.width, 4);
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff'; ctx.font = `800 ${Math.round(Math.min(bh * 0.36, s * 0.75))}px Pretendard, sans-serif`;
      ctx.fillText(banner.title, s * 0.5, bh * 0.36);
      ctx.fillStyle = '#c9d6ea'; ctx.font = `600 ${Math.round(Math.min(bh * 0.24, s * 0.5))}px Pretendard, sans-serif`;
      ctx.fillText(banner.sub, s * 0.5, bh * 0.74);
    }
  }
  function clickText(slot, orient) {
    const ins = clickInstruction(slot, orient);
    if (!ins) return '';
    if (!ins.path) return '방향 그대로';
    const parts = [];
    let i = 0;
    while (i < ins.path.length) {
      const ch = ins.path[i]; let n = 0;
      while (ins.path[i] === ch) { n++; i++; }
      parts.push(ch === 'R' ? `회전 ${n}번` : (n > 1 ? `반전 ${n}번` : '반전'));
    }
    return parts.join(' → ');
  }
  function stepTitle(step, mv) {
    if (mv.slot < 0) return `${step + 1}단계 · 점 찍기 → ${mv.cells[0][0] + 1}행 ${mv.cells[0][1] + 1}열`;
    return `${step + 1}단계 · ${mv.slot + 1}번째 조각 · ${clickText(mv.slot, mv.orient)}`;
  }
  function stepSub(mv) {
    const p = `+${mv.gain.toLocaleString()}점`;
    return mv.lines ? `${p} · ${mv.lines}줄 제거${mv.lines >= 2 ? '!' : ''}` : `${p} · 색칠된 칸에 놓기`;
  }

  // ------------------------------------------------------------------ 작은 창(항상 위) 띄우기
  // 네이버 웨일은 문서형 PIP API가 있다고 응답하지만 실제 창에는 "웹페이지를 열 수 없어요" 오류가 뜬다 → 영상형 PIP 사용
  const IS_WHALE = /Whale\//i.test(navigator.userAgent) ||
    !!(navigator.userAgentData && navigator.userAgentData.brands && navigator.userAgentData.brands.some((b) => /whale/i.test(b.brand)));
  function stopPipVideo() {
    const v = app.pipVideo;
    if (v && v.srcObject) { v.srcObject.getTracks().forEach((t) => t.stop()); v.srcObject = null; }
  }
  async function togglePip() {
    if (app.pip) { app.pip.close(); return; }
    if (document.pictureInPictureElement) { await document.exitPictureInPicture().catch(() => {}); return; }
    if (!app.lastFrame) { alert('먼저 화면 공유를 시작하거나 스크린샷을 넣어 주세요.'); return; }
    const box = LIVE.box;
    if ('documentPictureInPicture' in window && !IS_WHALE) {
      try {
        const pip = await window.documentPictureInPicture.requestWindow({ width: 420, height: 560 });
        for (const ss of Array.from(document.styleSheets)) {
          try {
            const st = pip.document.createElement('style');
            st.textContent = Array.from(ss.cssRules).map((r) => r.cssText).join('\n');
            pip.document.head.appendChild(st);
          } catch (e) {
            if (ss.href) { const ln = pip.document.createElement('link'); ln.rel = 'stylesheet'; ln.href = ss.href; pip.document.head.appendChild(ln); }
          }
        }
        pip.document.title = '한글 모아모아 도우미';
        pip.document.body.classList.add('pip');
        const ph = document.createElement('div');
        ph.className = 'live-empty'; ph.id = 'livePlaceholder';
        ph.textContent = '작은 창에 표시 중입니다';
        box.parentNode.insertBefore(ph, box);
        pip.document.body.appendChild(box);
        app.pip = pip;
        $('btnPip').textContent = '작은 창 닫기';
        pip.addEventListener('pagehide', () => {
          ph.replaceWith(box);
          app.pip = null;
          $('btnPip').textContent = '작은 창으로 띄우기';
          renderLive();
        });
        renderLive();
        return;
      } catch (e) { console.warn(e); }
    }
    // 영상형 PIP: 실시간 화면 캔버스를 영상으로 띄움 (안내 글자도 캔버스에 그려져 있어 그대로 보임)
    try {
      let v = app.pipVideo;
      if (!v) {
        v = app.pipVideo = document.createElement('video');
        v.muted = true; v.playsInline = true;
        v.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0;pointer-events:none';
        document.body.appendChild(v);
        v.addEventListener('leavepictureinpicture', () => { stopPipVideo(); $('btnPip').textContent = '작은 창으로 띄우기'; });
      }
      if (!v.srcObject) v.srcObject = LIVE.canvas.captureStream(8);
      renderLive(); // 첫 프레임 공급
      await v.play();
      if (v.readyState < 1) await new Promise((res) => { v.addEventListener('loadedmetadata', res, { once: true }); setTimeout(res, 1500); });
      await v.requestPictureInPicture();
      $('btnPip').textContent = '작은 창 닫기';
    } catch (e) {
      stopPipVideo();
      alert('이 브라우저에서는 작은 창 띄우기를 쓸 수 없습니다. 최신 크롬/엣지/웨일을 사용해 주세요.');
    }
  }

  // ------------------------------------------------------------------ 이미지 입력 (파일/붙여넣기/끌어놓기)
  function loadImageFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      stopCapture();
      app.source = 'image';
      app.grid = null; app.unknownAge = null; app.candidate = null; app.stable = null; app.plan = null; app.solveKey = null;
      app.lastOrientKey = [null, null, null];
      analyzeSource(im, im.naturalWidth, im.naturalHeight, true);
      if (!app.lastFrame || !app.lastFrame.res.found) {
        setStatus('이미지에서 게임판을 찾지 못했습니다', 'err');
        renderPlan();
      }
      URL.revokeObjectURL(url);
    };
    im.src = url;
  }
  window.addEventListener('paste', (e) => {
    const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
    const it = items.find((x) => x.type.startsWith('image/'));
    if (it) { e.preventDefault(); loadImageFile(it.getAsFile()); }
  });
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropHint').classList.add('on'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropHint').classList.remove('on'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; $('dropHint').classList.remove('on');
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) loadImageFile(f);
  });

  // ------------------------------------------------------------------ 직접 수정 모드
  function toggleEdit() {
    app.editMode = !app.editMode;
    $('btnEdit').setAttribute('aria-pressed', String(app.editMode));
    if (app.editMode) {
      if (!app.stable) {
        app.stable = { board: Array.from({ length: ROWS }, () => new Array(COLS).fill(0)), items: [], pieces: [null, null, null], abilities: null, occKey: '' };
        refreshOcc(app.stable);
      }
      app.source = 'manual';
      app.plan = null; app.solveKey = null;
      setStatus('직접 수정 중 · 칸을 눌러 블럭을 넣거나 빼세요', 'wait');
    } else {
      setStatus(app.stream ? '인식 재개' : '수정 완료', 'ok');
      if (app.stream) scheduleTick(50);
      else onStableState();
    }
    renderSlots(); renderPlan();
  }
  function refreshOcc(o) {
    o.occKey = o.board.map((row) => row.map((v) => (v > 0 ? 1 : 0)).join('')).join('/');
  }
  $('board').addEventListener('click', (e) => {
    if (!app.editMode || !app.stable) return;
    const cv = $('board');
    const rect = cv.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (cv.width / rect.width), y = (e.clientY - rect.top) * (cv.height / rect.height);
    const pad = 22, s = Math.floor((cv.width - pad - 4) / COLS);
    const c = Math.floor((x - pad) / s), r = Math.floor((y - pad) / s);
    if (r < 0 || c < 0 || r >= ROWS || c >= COLS) return;
    const o = app.stable;
    o.board[r][c] = o.board[r][c] > 0 ? 0 : 5;
    if (o.board[r].every((v) => v > 0)) o.board[r] = new Array(COLS).fill(0); // 가득 차면 게임처럼 제거
    refreshOcc(o);
    app.plan = null; app.solveKey = null;
    renderPlan();
    clearTimeout(app.editTimer);
    app.editTimer = setTimeout(onStableState, 350);
  });

  let pickerSlot = 0;
  function openPicker(slot) {
    pickerSlot = slot;
    $('pickerTitle').textContent = `${slot + 1}번째 조각 선택`;
    const grid = $('pickerGrid');
    grid.innerHTML = '';
    S.LIBRARY.forEach((L) => {
      const b = document.createElement('button');
      const cv = document.createElement('canvas'); cv.width = 128; cv.height = 128;
      drawMini(cv, L.cells, '#9bd015');
      const t = document.createElement('div'); t.textContent = `${L.name} ${L.n}칸`; t.style.fontSize = '12px';
      b.append(cv, t);
      b.onclick = () => setPiece(L.cells, L.name);
      grid.appendChild(b);
    });
    $('picker').classList.add('open');
  }
  function setPiece(cells, name) {
    const o = app.stable;
    if (cells) {
      const n = S.normalize(cells);
      o.pieces[pickerSlot] = { cells: n, key: S.canonicalKey(n), okey: S.keyOf(n), n: n.length, name, color: [155, 208, 21] };
    } else o.pieces[pickerSlot] = null;
    $('picker').classList.remove('open');
    app.plan = null; app.solveKey = null;
    renderSlots(); renderPlan();
    onStableState();
  }
  $('pickerClose').onclick = () => $('picker').classList.remove('open');
  $('pickerClear').onclick = () => setPiece(null);
  $('picker').addEventListener('click', (e) => { if (e.target === $('picker')) $('picker').classList.remove('open'); });

  // ------------------------------------------------------------------ 설정 UI
  function bindSeg(id, key, conv) {
    const seg = $(id);
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      settings[key] = conv ? conv(b.dataset.v) : b.dataset.v;
      saveSettings(); syncSettingsUI();
      if (key === 'rotateDir') renderPlan();
    });
  }
  function syncSettingsUI() {
    const mark = (id, v) => $(id).querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(v))));
    mark('segRot', settings.rotateDir);
    mark('segInterval', settings.interval);
    $('inDots').value = settings.dots;
    $('inSwaps').value = settings.swaps;
  }
  bindSeg('segRot', 'rotateDir');
  bindSeg('segInterval', 'interval', Number);
  for (const [id, key] of [['inDots', 'dots'], ['inSwaps', 'swaps']]) {
    $(id).addEventListener('change', () => {
      settings[key] = Math.max(0, Math.min(7, parseInt($(id).value, 10) || 0));
      saveSettings(); syncSettingsUI();
      app.solveKey = null; onStableState();
    });
  }
  syncSettingsUI();

  // ------------------------------------------------------------------ 버튼
  $('btnShare').onclick = () => (app.stream ? (stopCapture(), setStatus('화면 공유 중지됨')) : startCapture());
  $('btnImage').onclick = () => $('fileInput').click();
  $('fileInput').onchange = (e) => { loadImageFile(e.target.files[0]); e.target.value = ''; };
  $('btnEdit').onclick = toggleEdit;
  $('btnPip').onclick = togglePip;
  window.addEventListener('keydown', (e) => {
    if (!app.plan || e.target.tagName === 'INPUT') return;
    const n = app.plan.sel ? app.plan.sel.moves.length : 0;
    if (e.key === 'ArrowRight' && n) { app.viewStep = Math.min(n - 1, currentViewStep() + 1); renderPlan(); }
    if (e.key === 'ArrowLeft' && n) { app.viewStep = Math.max(0, currentViewStep() - 1); renderPlan(); }
  });

  renderSlots();
  renderPlan();
  if (!window.isSecureContext) setStatus('보안 컨텍스트가 아니라 화면 공유가 막힐 수 있습니다', 'err');

  // 테스트용 진입점 (개발자 도구에서 사용)
  window.__moa = { app, S, V, analyzeSource, loadImageFile };
})();
