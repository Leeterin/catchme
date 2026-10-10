(function(){
  'use strict';

  const API_BASE = '/api';
  let authToken = null;
  let refreshTokenValue = null;
  let refreshPromise = null;

  // ---------- 공용 유틸 ----------
  function escapeHtml(str){
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }
  function fmtDate(iso){
    if(!iso) return '';
    const d = new Date(iso);
    return `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  }
  let toastTimer = null;
  function showToast(msg){
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  // 액세스 토큰(15분)이 만료되면 리프레시 토큰으로 새로 받아옴 - 동시에 여러 요청이 401을 받아도 한 번만 갱신
  function refreshAccessToken(){
    if(!refreshTokenValue) return Promise.resolve(false);
    if(!refreshPromise){
      refreshPromise = fetch(API_BASE + '/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refreshTokenValue }),
      }).then(async (res) => {
        if(!res.ok) return false;
        const data = await res.json();
        setAuthToken(data.token, data.refreshToken);
        return true;
      }).catch(() => false).finally(() => { refreshPromise = null; });
    }
    return refreshPromise;
  }

  async function apiRequest(path, options, isRetry){
    options = options || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    if(authToken) headers.Authorization = 'Bearer ' + authToken;
    const res = await fetch(API_BASE + path, Object.assign({ cache: 'no-store' }, options, { headers }));
    let data = null;
    try { data = await res.json(); } catch(e) { data = null; }
    if(res.status === 401 && !isRetry){
      if(await refreshAccessToken()) return apiRequest(path, options, true);
      setAuthToken(null, null);
      showLogin();
    }
    if(!res.ok){
      const err = new Error((data && data.message) || `요청 실패 (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------- 커스텀 모달 (네이티브 confirm/prompt는 일부 웹뷰에서 조용히 막혀서 안 씀) ----------
  function openModal(opts){
    opts = opts || {};
    return new Promise((resolve) => {
      const overlay = document.getElementById('modalOverlay');
      const inputWrap = document.getElementById('modalInputWrap');
      const input = document.getElementById('modalInput');
      const confirmBtn = document.getElementById('modalConfirmBtn');
      const cancelBtn = document.getElementById('modalCancelBtn');

      document.getElementById('modalTitle').textContent = opts.title || '';
      document.getElementById('modalDesc').textContent = opts.desc || '';
      inputWrap.style.display = opts.withInput ? 'block' : 'none';
      input.value = '';
      input.placeholder = opts.placeholder || '';
      confirmBtn.textContent = opts.confirmLabel || '확인';
      confirmBtn.className = 'confirm' + (opts.danger ? ' danger' : '');

      overlay.classList.add('show');
      if(opts.withInput) setTimeout(() => input.focus(), 30);

      function cleanup(result){
        overlay.classList.remove('show');
        confirmBtn.removeEventListener('click', onConfirm);
        cancelBtn.removeEventListener('click', onCancel);
        overlay.removeEventListener('click', onOverlayClick);
        input.removeEventListener('keydown', onKeydown);
        resolve(result);
      }
      function onConfirm(){ cleanup({ confirmed: true, value: input.value.trim() }); }
      function onCancel(){ cleanup({ confirmed: false }); }
      function onOverlayClick(e){ if(e.target === overlay) cleanup({ confirmed: false }); }
      function onKeydown(e){ if(e.key === 'Enter') onConfirm(); }

      confirmBtn.addEventListener('click', onConfirm);
      cancelBtn.addEventListener('click', onCancel);
      overlay.addEventListener('click', onOverlayClick);
      input.addEventListener('keydown', onKeydown);
    });
  }
  function confirmModal(title, desc, opts){
    return openModal(Object.assign({ title, desc, withInput: false, confirmLabel: '확인', danger: true }, opts || {}));
  }
  function promptModal(title, desc, opts){
    return openModal(Object.assign({ title, desc, withInput: true, confirmLabel: '확인', danger: false }, opts || {}));
  }

  // ---------- 상세 모달 (유저 상세 / 신고 상세에서 공용으로 씀) ----------
  function openDetailModal(title){
    document.getElementById('detailModalTitle').textContent = title;
    document.getElementById('detailModalBody').innerHTML = '<div class="empty-state">불러오는 중...</div>';
    document.getElementById('detailModalOverlay').classList.add('show');
  }
  function closeDetailModal(){
    document.getElementById('detailModalOverlay').classList.remove('show');
  }
  document.getElementById('detailModalCloseBtn').addEventListener('click', closeDetailModal);
  document.getElementById('detailModalOverlay').addEventListener('click', (e) => {
    if(e.target.id === 'detailModalOverlay') closeDetailModal();
  });

  // ---------- 로그인 ----------
  // 토큰을 브라우저에 저장해서, 창을 닫았다 열어도 30일 동안(사용할 때마다 연장) 로그인이 유지되게 함
  function setAuthToken(token, refreshToken){
    authToken = token;
    if(refreshToken !== undefined) refreshTokenValue = refreshToken;
    try {
      if(token) localStorage.setItem('catchme_admin_token', token); else localStorage.removeItem('catchme_admin_token');
      if(refreshTokenValue) localStorage.setItem('catchme_admin_refresh', refreshTokenValue); else localStorage.removeItem('catchme_admin_refresh');
    } catch(e){}
  }

  async function tryAutoLogin(){
    let saved = null;
    try {
      saved = localStorage.getItem('catchme_admin_token');
      refreshTokenValue = localStorage.getItem('catchme_admin_refresh');
    } catch(e){}
    if(!saved && !refreshTokenValue) return showLogin();
    authToken = saved;
    try {
      await apiRequest('/admin/overview');
      showApp();
    } catch(e) {
      setAuthToken(null, null);
      showLogin();
    }
  }

  function showLogin(){
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('appScreen').style.display = 'none';
  }
  function showApp(){
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appScreen').style.display = 'block';
    loadDashboard();
  }

  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const emailOrUsername = document.getElementById('loginId').value.trim();
    const password = document.getElementById('loginPw').value;
    const errEl = document.getElementById('loginError');
    const btn = document.getElementById('loginBtn');
    errEl.style.display = 'none';
    btn.disabled = true;
    btn.textContent = '로그인 중...';
    try {
      const res = await fetch(API_BASE + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername, password }),
      });
      const data = await res.json();
      if(!res.ok) throw new Error(data.message || '로그인에 실패했어요.');

      authToken = data.token;
      refreshTokenValue = null; // 관리자 확인 전에는 갱신 시도 안 함
      try {
        await apiRequest('/admin/overview');
      } catch(adminErr){
        authToken = null;
        throw new Error(adminErr.status === 403 ? '관리자 계정이 아니에요.' : '확인 중 오류가 발생했어요.');
      }
      setAuthToken(data.token, data.refreshToken);
      document.getElementById('whoAmI').textContent = data.user ? `${data.user.name} (@${data.user.username})` : '';
      showApp();
    } catch(err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = '로그인';
    }
  });

  document.getElementById('logoutBtn').addEventListener('click', () => {
    if(refreshTokenValue){
      fetch(API_BASE + '/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refreshTokenValue }),
      }).catch(() => {});
    }
    setAuthToken(null, null);
    showLogin();
  });

  // ---------- 탭 전환 ----------
  const TAB_LOADERS = {
    dashboard: loadDashboard,
    users: () => loadUsers(1),
    metrics: () => loadMetrics(),
    reports: () => loadReports(1),
    feed: () => loadFeed(1),
    meetups: () => loadMeetups(1),
    logs: () => loadLogs(1),
  };
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('section-' + btn.dataset.tab).classList.add('active');
      const loader = TAB_LOADERS[btn.dataset.tab];
      if(loader) loader();
    });
  });

  // ---------- 페이지네이션 공용 ----------
  function renderPagination(elId, page, totalPages, loadFn){
    const el = document.getElementById(elId);
    if(totalPages <= 1){ el.innerHTML = ''; return; }
    el.innerHTML = `
      <button ${page <= 1 ? 'disabled' : ''} id="${elId}-prev">이전</button>
      <span style="align-self:center; font-size:12.5px; color:var(--text-dim);">${page} / ${totalPages}</span>
      <button ${page >= totalPages ? 'disabled' : ''} id="${elId}-next">다음</button>
    `;
    const prevBtn = document.getElementById(`${elId}-prev`);
    const nextBtn = document.getElementById(`${elId}-next`);
    if(prevBtn) prevBtn.addEventListener('click', () => loadFn(page - 1));
    if(nextBtn) nextBtn.addEventListener('click', () => loadFn(page + 1));
  }

  // ---------- 대시보드 ----------
  async function loadDashboard(){
    loadStatsChart();
    const grid = document.getElementById('statGrid');
    grid.innerHTML = '<div class="empty-state">불러오는 중...</div>';
    try {
      const data = await apiRequest('/admin/overview');
      grid.innerHTML = `
        <div class="stat-card">
          <div class="label">전체 유저</div>
          <div class="value">${data.users.total.toLocaleString()}</div>
          <div class="sub">이번 주 신규 ${data.users.newThisWeek}명 · 정지 ${data.users.suspended}명</div>
        </div>
        <div class="stat-card">
          <div class="label">소식 게시물</div>
          <div class="value">${data.feedPosts.total.toLocaleString()}</div>
        </div>
        <div class="stat-card">
          <div class="label">모임</div>
          <div class="value">${data.meetups.total.toLocaleString()}</div>
          <div class="sub">진행중 ${data.meetups.active}개</div>
        </div>
        <div class="stat-card">
          <div class="label">전체 메시지</div>
          <div class="value">${data.messages.total.toLocaleString()}</div>
          <div class="sub">오늘 ${data.messages.today.toLocaleString()}건</div>
        </div>
        <div class="stat-card">
          <div class="label">처리 대기중 신고</div>
          <div class="value" style="color:${data.reports.pending > 0 ? '#ef4444' : '#111827'}">${data.reports.pending}</div>
          <div class="sub">누적 신고 ${data.reports.total}건</div>
        </div>
      `;
    } catch(err) {
      grid.innerHTML = `<div class="empty-state">통계를 불러오지 못했어요: ${escapeHtml(err.message)}</div>`;
    }
  }

  // ---------- 지표 (활성화 / 재방문) ----------
  function initMetricsDateInputs(){
    const s = document.getElementById('metricsStartInput');
    const e = document.getElementById('metricsEndInput');
    if(s.value && e.value) return;
    const end = new Date();
    e.value = end.toISOString().slice(0, 10);
    s.value = new Date(end.getTime() - 29 * 86400e3).toISOString().slice(0, 10);
  }
  const pct = (n, of) => (of > 0 ? Math.round(n / of * 100) : 0);
  async function loadMetrics(){
    initMetricsDateInputs();
    const funnel = document.getElementById('metricsFunnel');
    funnel.innerHTML = '<div class="empty-state">불러오는 중...</div>';
    const start = document.getElementById('metricsStartInput').value;
    const end = document.getElementById('metricsEndInput').value;
    try {
      const data = await apiRequest(`/admin/metrics?start=${start}&end=${end}`);
      const c = data.cohort;
      document.getElementById('metricsNotice').innerHTML = data.trackingReady ? ''
        : '<div class="metrics-notice">재방문·캘린더 불러오기 기록 테이블이 아직 DB에 없어요. 마이그레이션(14_add_engagement_analytics)을 적용하면 그때부터 쌓여요.</div>';
      const steps = [
        ['가입', c.signups],
        ['첫날 일정 추가', c.firstEvent1d],
        ['7일 안에 캘린더 불러오기', c.import7d],
        ['7일 안에 예약 가능 시간 열기', c.available7d],
        ['7일 안에 약속 링크 만들기', c.invite7d],
        ['7일 안에 친구 맺기', c.friend7d],
      ];
      funnel.innerHTML = steps.map(([label, n]) => {
        if(n === null) return `<div class="metric-row"><span>${label}</span><div class="bar"></div><span class="num">기록 없음</span></div>`;
        const p = pct(n, c.signups);
        return `<div class="metric-row"><span>${label}</span><div class="bar"><span style="width:${p}%"></span></div><span class="num"><b>${p}%</b> · ${n}명</span></div>`;
      }).join('');
      const ret = [
        ['다음 날 다시 옴 (D1)', c.d1],
        ['7일째 다시 옴 (D7)', c.d7],
        ['7일 안에 한 번이라도 다시 옴', c.w1],
      ];
      document.getElementById('metricsRetention').innerHTML = ret.map(([label, r]) => `
        <div class="stat-card">
          <div class="label">${label}</div>
          <div class="value">${r ? pct(r.n, r.of) + '%' : '-'}</div>
          <div class="sub">${r ? `${r.of}명 중 ${r.n}명` : '기록 테이블 필요'}</div>
        </div>`).join('');
      document.getElementById('metricsDaily').innerHTML = `
        <table class="metric-table">
          <tr><th>날짜</th><th>가입</th><th>활성 사용자</th><th>새 일정</th><th>약속 링크</th><th>링크 응답</th></tr>
          ${data.daily.slice().reverse().map((d) => `<tr><td>${d.day}</td><td>${d.signups}</td><td>${d.active === null ? '-' : d.active}</td><td>${d.events}</td><td>${d.invites}</td><td>${d.responses}</td></tr>`).join('')}
        </table>`;
    } catch(err) {
      funnel.innerHTML = `<div class="empty-state">지표를 불러오지 못했어요: ${escapeHtml(err.message)}</div>`;
    }
  }
  document.getElementById('metricsRefreshBtn').addEventListener('click', loadMetrics);

  // ---------- 대시보드 그래프 (일별 추이) ----------
  // 날짜 입력칸은 처음 한 번만 기본값(최근 30일)을 채워넣고, 그 다음부턴 사용자가 고른 기간을 유지함
  function initStatsDateInputs(){
    const startInput = document.getElementById('statsStartInput');
    const endInput = document.getElementById('statsEndInput');
    if(startInput.value && endInput.value) return;
    const end = new Date();
    const start = new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000);
    endInput.value = end.toISOString().slice(0, 10);
    startInput.value = start.toISOString().slice(0, 10);
  }

  async function loadStatsChart(){
    initStatsDateInputs();
    const wrap = document.getElementById('statsChartWrap');
    wrap.innerHTML = '<div class="empty-state">불러오는 중...</div>';
    const metric = document.getElementById('statsMetricSelect').value;
    const start = document.getElementById('statsStartInput').value;
    const end = document.getElementById('statsEndInput').value;
    try {
      const data = await apiRequest(`/admin/stats/daily?metric=${encodeURIComponent(metric)}&start=${start}&end=${end}`);
      renderStatsChart(data);
    } catch(err) {
      wrap.innerHTML = `<div class="empty-state">그래프를 불러오지 못했어요: ${escapeHtml(err.message)}</div>`;
    }
  }

  const STATS_METRIC_LABEL = { feedPosts: '소식 게시물', users: '신규 가입', meetups: '모임 생성' };

  // 데이터 최댓값을 보기 좋은 반올림 값으로 - 예: 37 -> 40, 420 -> 500, 1250 -> 2000
  function niceCeil(value){
    if(value <= 0) return 1;
    const exp = Math.floor(Math.log10(value));
    const base = Math.pow(10, exp);
    const norm = value / base;
    let niceNorm;
    if(norm <= 1) niceNorm = 1;
    else if(norm <= 2) niceNorm = 2;
    else if(norm <= 5) niceNorm = 5;
    else niceNorm = 10;
    return niceNorm * base;
  }

  // Catmull-Rom -> 3차 베지어 변환으로 부드러운 곡선 경로 생성 (외부 차트 라이브러리 없이 직접 구현)
  function smoothLinePath(points){
    if(points.length < 2) return '';
    const d = [`M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`];
    for(let i = 0; i < points.length - 1; i++){
      const p0 = points[i === 0 ? i : i - 1];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2 < points.length ? i + 2 : i + 1];
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      d.push(`C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`);
    }
    return d.join(' ');
  }

  function renderStatsChart(data){
    const wrap = document.getElementById('statsChartWrap');
    if(!data.days || data.days.length === 0){
      wrap.innerHTML = '<div class="empty-state">데이터가 없어요.</div>';
      return;
    }
    const W = 640, H = 220;
    const padL = 42, padR = 12, padT = 14, padB = 26;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const n = data.days.length;

    const maxCount = Math.max(...data.days.map((d) => d.count));
    const niceMax = niceCeil(maxCount || 1);

    const points = data.days.map((d, i) => ({
      x: padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW),
      y: padT + plotH - (d.count / niceMax) * plotH,
      date: d.date,
      count: d.count,
    }));

    // 가로 그리드선 5개(0%~100%)와 왼쪽 눈금 숫자
    const GRID_STEPS = 4;
    let gridLines = '';
    let gridLabels = '';
    for(let s = 0; s <= GRID_STEPS; s++){
      const ratio = s / GRID_STEPS;
      const y = padT + plotH - ratio * plotH;
      const value = Math.round(niceMax * ratio);
      gridLines += `<line class="chart-axis-line" x1="${padL}" y1="${y.toFixed(2)}" x2="${W - padR}" y2="${y.toFixed(2)}" />`;
      gridLabels += `<text class="chart-grid-label" x="${padL - 6}" y="${(y + 3).toFixed(2)}" text-anchor="end">${value.toLocaleString()}</text>`;
    }

    // 날짜가 많으면 x축 라벨이 다 겹치니, 대략 8개 안팎으로만 보이게 간격을 둠
    const labelEvery = Math.max(1, Math.ceil(n / 8));
    let xLabels = '';
    points.forEach((p, i) => {
      const showLabel = (i % labelEvery === 0) || i === n - 1;
      if(!showLabel) return;
      xLabels += `<text class="chart-x-label" x="${p.x.toFixed(2)}" y="${H - 6}" text-anchor="middle">${escapeHtml(data.days[i].date.slice(5))}</text>`;
    });

    const linePath = smoothLinePath(points);
    const hitCircles = points.map((p) => `
      <circle class="chart-point-hit" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="9">
        <title>${escapeHtml(p.date)} · ${p.count.toLocaleString()}건</title>
      </circle>
    `).join('');

    wrap.innerHTML = `
      <div class="chart-legend">
        <div class="chart-legend-item"><span class="chart-legend-swatch"></span>${escapeHtml(STATS_METRIC_LABEL[data.metric] || data.metric)}</div>
      </div>
      <div class="chart-summary">총 ${data.total.toLocaleString()}건 · ${escapeHtml(data.start)} ~ ${escapeHtml(data.end)}</div>
      <div class="chart-svg-wrap">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
          ${gridLines}
          ${gridLabels}
          <path class="chart-line-path" d="${linePath}" />
          ${hitCircles}
          ${xLabels}
        </svg>
      </div>
    `;
  }

  document.getElementById('statsRefreshBtn').addEventListener('click', loadStatsChart);
  document.getElementById('statsMetricSelect').addEventListener('change', loadStatsChart);

  // ---------- 유저 관리 ----------
  let userPage = 1;
  async function loadUsers(page){
    userPage = page || 1;
    const listEl = document.getElementById('userList');
    listEl.innerHTML = '<div class="empty-state">불러오는 중...</div>';
    const q = document.getElementById('userSearchInput').value.trim();
    const filter = document.getElementById('userFilterSelect').value;
    try {
      const data = await apiRequest(`/admin/users?page=${userPage}&q=${encodeURIComponent(q)}&filter=${filter}`);
      if(data.users.length === 0){
        listEl.innerHTML = '<div class="empty-state">조건에 맞는 유저가 없어요.</div>';
      } else {
        listEl.innerHTML = data.users.map((u) => `
          <div class="row" data-id="${u.id}">
            <div class="row-main">
              <div class="row-title">
                ${escapeHtml(u.name)} <span style="color:var(--text-dim); font-weight:400;">@${escapeHtml(u.username)}</span>
                ${u.isSuspended ? '<span class="badge suspended">정지됨</span>' : ''}
              </div>
              <div class="row-sub">${escapeHtml(u.email)} · 가입 ${fmtDate(u.createdAt)} · 소식 ${u.counts.feedPosts} · 모임 ${u.counts.meetups} · 신고이력 ${u.counts.reportsMade}</div>
              ${u.isSuspended && u.suspendedReason ? `<div class="row-sub" style="color:var(--danger);">정지 사유: ${escapeHtml(u.suspendedReason)}</div>` : ''}
            </div>
            <div class="row-actions">
              <button data-action="detail">상세보기</button>
              ${u.isSuspended
                ? `<button class="ok" data-action="unsuspend">정지 해제</button>`
                : `<button class="danger" data-action="suspend">정지</button>`}
              <button class="danger" data-action="delete">삭제</button>
            </div>
          </div>
        `).join('');
        wireUserRowActions(listEl);
      }
      renderPagination('userPagination', data.page, data.totalPages, loadUsers);
    } catch(err) {
      listEl.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    }
  }

  async function showUserDetail(id){
    openDetailModal('유저 상세');
    const body = document.getElementById('detailModalBody');
    try {
      const data = await apiRequest(`/admin/users/${id}`);
      const u = data.user;
      body.innerHTML = `
        <div class="detail-section">
          <div class="detail-row-title">
            ${escapeHtml(u.name)} <span style="color:var(--text-dim); font-weight:400;">@${escapeHtml(u.username)}</span>
            ${u.isSuspended ? '<span class="badge suspended">정지됨</span>' : ''}
          </div>
          <div class="detail-row-sub">${escapeHtml(u.email)}${u.phone ? ' · ' + escapeHtml(u.phone) : ''} · 가입 ${fmtDate(u.createdAt)}</div>
          ${u.bio ? `<div class="detail-row-sub">${escapeHtml(u.bio)}</div>` : ''}
          ${u.isSuspended ? `<div class="detail-row-sub" style="color:var(--danger);">정지 사유: ${escapeHtml(u.suspendedReason || '-')} (${fmtDate(u.suspendedAt)})</div>` : ''}
        </div>
        <div class="detail-stat-row">
          <div class="detail-stat"><div class="n">${u.counts.feedPosts}</div><div class="l">소식 게시물</div></div>
          <div class="detail-stat"><div class="n">${u.counts.meetupsCreated}</div><div class="l">모임 개설</div></div>
          <div class="detail-stat"><div class="n">${u.counts.meetupsJoined}</div><div class="l">모임 참여</div></div>
          <div class="detail-stat"><div class="n">${u.counts.reportsMade}</div><div class="l">신고함</div></div>
          <div class="detail-stat"><div class="n" style="color:${u.counts.reportsAgainst > 0 ? 'var(--danger)' : 'var(--text)'}">${u.counts.reportsAgainst}</div><div class="l">신고받음</div></div>
        </div>
        <div class="detail-subheading">최근 작성한 소식</div>
        ${data.recentPosts.length ? data.recentPosts.map((p) => `
          <div class="detail-list-item">[${escapeHtml(p.category || '-')}] ${escapeHtml(p.title || p.note || '(내용 없음)')} · ${fmtDate(p.createdAt)}</div>
        `).join('') : '<div class="detail-empty">작성한 소식이 없어요.</div>'}
        <div class="detail-subheading">최근 받은 신고</div>
        ${data.reportsAgainst.length ? data.reportsAgainst.map((r) => `
          <div class="detail-list-item">${escapeHtml(r.reason)} · 신고자 @${escapeHtml(r.reporterUsername)} · ${fmtDate(r.createdAt)} ${r.status === 'PENDING' ? '<span class="badge pending">대기중</span>' : ''}</div>
        `).join('') : '<div class="detail-empty">받은 신고가 없어요.</div>'}
      `;
    } catch(err) {
      body.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    }
  }

  function wireUserRowActions(listEl){
    listEl.querySelectorAll('.row').forEach((row) => {
      const id = row.dataset.id;
      const detailBtn = row.querySelector('[data-action="detail"]');
      const suspendBtn = row.querySelector('[data-action="suspend"]');
      const unsuspendBtn = row.querySelector('[data-action="unsuspend"]');
      const deleteBtn = row.querySelector('[data-action="delete"]');
      if(detailBtn) detailBtn.addEventListener('click', () => showUserDetail(id));
      if(suspendBtn) suspendBtn.addEventListener('click', async () => {
        const result = await promptModal('계정 정지', '정지 사유를 입력해주세요 (선택 사항, 비워도 돼요).', { placeholder: '예: 반복 신고 접수', confirmLabel: '정지시키기', danger: true });
        if(!result.confirmed) return;
        try {
          await apiRequest(`/admin/users/${id}/suspend`, { method: 'POST', body: JSON.stringify({ reason: result.value }) });
          showToast('계정을 정지시켰어요.');
          loadUsers(userPage);
        } catch(err) { showToast(err.message); }
      });
      if(unsuspendBtn) unsuspendBtn.addEventListener('click', async () => {
        const result = await confirmModal('정지 해제', '이 계정의 정지를 해제할까요?', { confirmLabel: '해제하기', danger: false });
        if(!result.confirmed) return;
        try {
          await apiRequest(`/admin/users/${id}/unsuspend`, { method: 'POST' });
          showToast('정지를 해제했어요.');
          loadUsers(userPage);
        } catch(err) { showToast(err.message); }
      });
      if(deleteBtn) deleteBtn.addEventListener('click', async () => {
        const result = await confirmModal('계정 완전 삭제', '정말 이 계정을 완전히 삭제할까요?\n되돌릴 수 없어요.', { confirmLabel: '삭제하기', danger: true });
        if(!result.confirmed) return;
        try {
          await apiRequest(`/admin/users/${id}`, { method: 'DELETE' });
          showToast('계정을 삭제했어요.');
          loadUsers(userPage);
        } catch(err) { showToast(err.message); }
      });
    });
  }

  document.getElementById('userSearchBtn').addEventListener('click', () => loadUsers(1));
  document.getElementById('userSearchInput').addEventListener('keydown', (e) => { if(e.key === 'Enter') loadUsers(1); });
  document.getElementById('userFilterSelect').addEventListener('change', () => loadUsers(1));

  // ---------- 신고 처리 ----------
  let reportPage = 1;
  const TARGET_TYPE_LABEL = { FEED_POST: '소식 게시물', MEETUP: '모임', USER: '유저', BUG: '앱 오류' };
  const REPORT_STATUS_LABEL = { PENDING: '대기중', REVIEWED: '처리됨', DISMISSED: '반려됨' };

  async function loadReports(page){
    reportPage = page || 1;
    const listEl = document.getElementById('reportList');
    listEl.innerHTML = '<div class="empty-state">불러오는 중...</div>';
    const status = document.getElementById('reportStatusSelect').value;
    const sort = document.getElementById('reportSortSelect').value;
    try {
      const data = await apiRequest(`/admin/reports?page=${reportPage}&status=${status}&sort=${sort}`);
      if(data.reports.length === 0){
        listEl.innerHTML = '<div class="empty-state">해당하는 신고가 없어요.</div>';
      } else {
        listEl.innerHTML = data.reports.map((r) => `
          <div class="row" data-id="${r.id}" data-target-type="${r.targetType}">
            <div class="row-main">
              <div class="row-title">
                [${TARGET_TYPE_LABEL[r.targetType] || r.targetType}] ${escapeHtml(r.target.exists ? r.target.title : '(이미 삭제된 콘텐츠)')}
                <span class="badge ${r.status.toLowerCase()}">${REPORT_STATUS_LABEL[r.status] || r.status}</span>
              </div>
              <div class="row-sub">사유: ${escapeHtml(r.reason)}${r.detail ? ` — ${escapeHtml(r.targetType === 'BUG' ? r.detail.split('\n')[0].slice(0, 80) : r.detail)}` : ''}</div>
              <div class="row-sub">
                신고자 @${escapeHtml(r.reporter.username)}
                ${r.target.author ? ` · 대상 @${escapeHtml(r.target.author.username)}` : ''}
                · ${fmtDate(r.createdAt)}
              </div>
            </div>
            <div class="row-actions">
              <button data-action="detail">상세보기</button>
              ${r.status === 'PENDING' ? `
                <button data-action="dismiss">반려</button>
                ${r.targetType === 'BUG'
                  ? `<button data-action="mark-reviewed">확인 완료</button>`
                  : r.targetType === 'USER'
                  ? `<button class="danger" data-action="suspend-user">유저 정지</button>`
                  : `<button class="danger" data-action="delete-content">콘텐츠 삭제</button>`}
              ` : ['PENDING', 'REVIEWED', 'DISMISSED'].filter((s) => s !== r.status).map((s) =>
                `<button data-action="set-status" data-status="${s}">${REPORT_STATUS_LABEL[s]}으로</button>`
              ).join('')}
            </div>
          </div>
        `).join('');
        wireReportRowActions(listEl);
      }
      renderPagination('reportPagination', data.page, data.totalPages, loadReports);
    } catch(err) {
      listEl.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    }
  }

  async function showReportDetail(id){
    openDetailModal('신고 상세');
    const body = document.getElementById('detailModalBody');
    try {
      const data = await apiRequest(`/admin/reports/${id}`);
      const t = data.target;
      let targetHtml = '<div class="detail-empty">이미 삭제된 콘텐츠예요.</div>';
      if(t && t.exists){
        if(t.type === 'FEED_POST'){
          targetHtml = `
            <div class="detail-row-title">[${escapeHtml(t.category || '-')}] ${escapeHtml(t.title || '(제목 없음)')}</div>
            <div class="detail-row-sub">
              작성자 @${escapeHtml(t.author.username)} · ${fmtDate(t.createdAt)}
              ${t.location ? ' · ' + escapeHtml(t.location) : ''}${t.rating ? ` · 별점 ${t.rating}` : ''}
            </div>
            ${t.note ? `<div class="detail-row-sub">${escapeHtml(t.note)}</div>` : ''}
            ${t.photoCount ? `<div class="detail-row-sub">사진 ${t.photoCount}장</div>` : ''}
          `;
        } else if(t.type === 'MEETUP'){
          targetHtml = `
            <div class="detail-row-title">${escapeHtml(t.title)} ${t.cancelled ? '<span class="badge cancelled">취소됨</span>' : ''}</div>
            <div class="detail-row-sub">개설자 @${escapeHtml(t.creator.username)} · 참여 ${t.participantCount}명 · ${fmtDate(t.createdAt)}</div>
            ${t.description ? `<div class="detail-row-sub">${escapeHtml(t.description)}</div>` : ''}
          `;
        } else if(t.type === 'BUG'){
          // 오류 신고는 설명 + 기기 정보 + 최근 오류 로그가 여러 줄로 들어있어서 줄바꿈 그대로 보여줌
          targetHtml = `<div class="detail-row-sub" style="white-space:pre-wrap;word-break:break-all;">${escapeHtml(data.detail || '')}</div>`;
          if(data.images && data.images.length){
            targetHtml += `
              <div class="detail-subheading">첨부 사진 (${data.images.length}장)</div>
              <div class="detail-photo-grid">
                ${data.images.map((src) => `<img src="${src}" loading="lazy" onclick="window.open(this.src, '_blank')" />`).join('')}
              </div>
            `;
          }
        } else if(t.type === 'USER'){
          targetHtml = `
            <div class="detail-row-title">
              ${escapeHtml(t.name)} <span style="color:var(--text-dim); font-weight:400;">@${escapeHtml(t.username)}</span>
              ${t.isSuspended ? '<span class="badge suspended">정지됨</span>' : ''}
            </div>
            ${t.bio ? `<div class="detail-row-sub">${escapeHtml(t.bio)}</div>` : ''}
          `;
        }
      }
      body.innerHTML = `
        <div class="detail-section">
          <div class="detail-row-title">[${escapeHtml(TARGET_TYPE_LABEL[data.targetType] || data.targetType)}] 신고</div>
          <div class="detail-row-sub">
            신고자 @${escapeHtml(data.reporter.username)} · ${fmtDate(data.createdAt)}
            · 상태 ${escapeHtml(REPORT_STATUS_LABEL[data.status] || data.status)}
          </div>
          <div class="detail-row-sub">사유: ${escapeHtml(data.reason)}</div>
          ${data.detail && data.targetType !== 'BUG' ? `<div class="detail-row-sub">상세 설명: ${escapeHtml(data.detail)}</div>` : ''}
        </div>
        <div class="detail-subheading">${data.targetType === 'BUG' ? '오류 내용' : '신고 대상'}</div>
        <div class="detail-section">${targetHtml}</div>
      `;
    } catch(err) {
      body.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    }
  }

  function wireReportRowActions(listEl){
    listEl.querySelectorAll('.row').forEach((row) => {
      const id = row.dataset.id;
      const detailBtn = row.querySelector('[data-action="detail"]');
      const dismissBtn = row.querySelector('[data-action="dismiss"]');
      const suspendBtn = row.querySelector('[data-action="suspend-user"]');
      const deleteBtn = row.querySelector('[data-action="delete-content"]');
      const reviewedBtn = row.querySelector('[data-action="mark-reviewed"]');
      if(reviewedBtn) reviewedBtn.addEventListener('click', async () => {
        try {
          await apiRequest(`/admin/reports/${id}/resolve`, { method: 'POST', body: JSON.stringify({ action: 'MARK_REVIEWED' }) });
          showToast('확인 완료로 처리했어요.');
          loadReports(reportPage);
        } catch(err) { showToast(err.message); }
      });
      row.querySelectorAll('[data-action="set-status"]').forEach((btn) => btn.addEventListener('click', async () => {
        const label = REPORT_STATUS_LABEL[btn.dataset.status];
        const result = await confirmModal('신고 상태 변경', `이 신고를 '${label}'(으)로 바꿀까요?\n이미 한 유저 정지·콘텐츠 삭제는 되돌려지지 않아요.`, { confirmLabel: '바꾸기', danger: false });
        if(!result.confirmed) return;
        try {
          await apiRequest(`/admin/reports/${id}/resolve`, { method: 'POST', body: JSON.stringify({ action: 'SET_STATUS', status: btn.dataset.status }) });
          showToast(`'${label}'(으)로 바꿨어요.`);
          loadReports(reportPage);
        } catch(err) { showToast(err.message); }
      }));
      if(detailBtn) detailBtn.addEventListener('click', () => showReportDetail(id));
      if(dismissBtn) dismissBtn.addEventListener('click', async () => {
        const result = await confirmModal('신고 반려', '이 신고를 반려 처리할까요?', { confirmLabel: '반려하기', danger: false });
        if(!result.confirmed) return;
        try {
          await apiRequest(`/admin/reports/${id}/resolve`, { method: 'POST', body: JSON.stringify({ action: 'DISMISS' }) });
          showToast('신고를 반려했어요.');
          loadReports(reportPage);
        } catch(err) { showToast(err.message); }
      });
      if(suspendBtn) suspendBtn.addEventListener('click', async () => {
        const result = await confirmModal('유저 정지', '신고된 유저 계정을 정지할까요?', { confirmLabel: '정지시키기', danger: true });
        if(!result.confirmed) return;
        try {
          await apiRequest(`/admin/reports/${id}/resolve`, { method: 'POST', body: JSON.stringify({ action: 'SUSPEND_USER' }) });
          showToast('유저를 정지시켰어요.');
          loadReports(reportPage);
        } catch(err) { showToast(err.message); }
      });
      if(deleteBtn) deleteBtn.addEventListener('click', async () => {
        const result = await confirmModal('콘텐츠 삭제', '신고된 콘텐츠를 삭제할까요?\n되돌릴 수 없어요.', { confirmLabel: '삭제하기', danger: true });
        if(!result.confirmed) return;
        try {
          await apiRequest(`/admin/reports/${id}/resolve`, { method: 'POST', body: JSON.stringify({ action: 'DELETE_CONTENT' }) });
          showToast('콘텐츠를 삭제했어요.');
          loadReports(reportPage);
        } catch(err) { showToast(err.message); }
      });
    });
  }

  document.getElementById('reportRefreshBtn').addEventListener('click', () => loadReports(reportPage));
  document.getElementById('reportStatusSelect').addEventListener('change', () => loadReports(1));
  document.getElementById('reportSortSelect').addEventListener('change', () => loadReports(1));

  // ---------- 소식 관리 ----------
  let feedPage = 1;
  async function loadFeed(page){
    feedPage = page || 1;
    const listEl = document.getElementById('feedList');
    listEl.innerHTML = '<div class="empty-state">불러오는 중...</div>';
    const q = document.getElementById('feedSearchInput').value.trim();
    try {
      const data = await apiRequest(`/admin/feed-posts?page=${feedPage}&q=${encodeURIComponent(q)}`);
      if(data.posts.length === 0){
        listEl.innerHTML = '<div class="empty-state">해당하는 게시물이 없어요.</div>';
      } else {
        listEl.innerHTML = data.posts.map((p) => `
          <div class="row" data-id="${p.id}">
            <div class="row-main">
              <div class="row-title">${escapeHtml(p.title || '(제목 없음)')}${typeof p.rating === 'number' ? ` · ⭐${p.rating}` : ''}</div>
              ${p.note ? `<div class="row-sub">${escapeHtml(p.note)}</div>` : ''}
              <div class="row-sub">
                @${escapeHtml(p.author.username)} · ${p.location ? escapeHtml(p.location) + ' · ' : ''}사진 ${p.photoCount}장 · 좋아요 ${p.likeCount} · 댓글 ${p.commentCount} · ${fmtDate(p.createdAt)}
              </div>
            </div>
            <div class="row-actions">
              <button data-action="detail">상세보기</button>
              <button class="danger" data-action="delete">삭제</button>
            </div>
          </div>
        `).join('');
        wireFeedRowActions(listEl);
      }
      renderPagination('feedPagination', data.page, data.totalPages, loadFeed);
    } catch(err) {
      listEl.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    }
  }

  async function showFeedPostDetail(id){
    openDetailModal('소식 게시물 상세');
    const body = document.getElementById('detailModalBody');
    try {
      const data = await apiRequest(`/admin/feed-posts/${id}`);
      const p = data.post;
      body.innerHTML = `
        <div class="detail-section">
          <div class="detail-row-title">[${escapeHtml(p.category || '-')}] ${escapeHtml(p.title || '(제목 없음)')}${typeof p.rating === 'number' ? ` · ⭐${p.rating}` : ''}</div>
          <div class="detail-row-sub">
            작성자 @${escapeHtml(p.author.username)} (${escapeHtml(p.author.email)}) · ${fmtDate(p.createdAt)}
          </div>
          ${p.location || p.address ? `<div class="detail-row-sub">${[p.location, p.address].filter(Boolean).map(escapeHtml).join(' · ')}</div>` : ''}
          ${p.phone ? `<div class="detail-row-sub">전화 ${escapeHtml(p.phone)}</div>` : ''}
          ${p.note ? `<div class="detail-row-sub">${escapeHtml(p.note)}</div>` : ''}
        </div>
        <div class="detail-stat-row">
          <div class="detail-stat"><div class="n">${p.likeCount}</div><div class="l">좋아요</div></div>
          <div class="detail-stat"><div class="n">${p.commentCount}</div><div class="l">댓글</div></div>
          <div class="detail-stat"><div class="n">${p.photos.length}</div><div class="l">사진</div></div>
          <div class="detail-stat"><div class="n" style="color:${p.reportsCount > 0 ? 'var(--danger)' : 'var(--text)'}">${p.reportsCount}</div><div class="l">신고받음</div></div>
        </div>
        ${p.photos.length ? `
          <div class="detail-subheading">사진</div>
          <div class="detail-photo-grid">
            ${p.photos.map((src) => `<img src="${src}" loading="lazy" onclick="window.open(this.src, '_blank')" />`).join('')}
          </div>
        ` : ''}
        <div class="detail-subheading">댓글 (최근 ${data.comments.length}개)</div>
        ${data.comments.length ? data.comments.map((c) => `
          <div class="detail-list-item">@${escapeHtml(c.author.username)}${typeof c.rating === 'number' ? ` · ⭐${c.rating}` : ''} · ${fmtDate(c.createdAt)}<br>${escapeHtml(c.text)}</div>
        `).join('') : '<div class="detail-empty">댓글이 없어요.</div>'}
        <div class="detail-subheading">받은 신고</div>
        ${data.reports.length ? data.reports.map((r) => `
          <div class="detail-list-item">${escapeHtml(r.reason)} · 신고자 @${escapeHtml(r.reporterUsername)} · ${fmtDate(r.createdAt)} ${r.status === 'PENDING' ? '<span class="badge pending">대기중</span>' : ''}</div>
        `).join('') : '<div class="detail-empty">받은 신고가 없어요.</div>'}
      `;
    } catch(err) {
      body.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    }
  }

  function wireFeedRowActions(listEl){
    listEl.querySelectorAll('.row').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('[data-action="detail"]').addEventListener('click', () => showFeedPostDetail(id));
      row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        const result = await confirmModal('게시물 삭제', '이 소식 게시물을 삭제할까요?\n되돌릴 수 없어요.', { confirmLabel: '삭제하기', danger: true });
        if(!result.confirmed) return;
        try {
          await apiRequest(`/admin/feed-posts/${id}`, { method: 'DELETE' });
          showToast('게시물을 삭제했어요.');
          loadFeed(feedPage);
        } catch(err) { showToast(err.message); }
      });
    });
  }
  document.getElementById('feedSearchBtn').addEventListener('click', () => loadFeed(1));
  document.getElementById('feedSearchInput').addEventListener('keydown', (e) => { if(e.key === 'Enter') loadFeed(1); });

  // ---------- 모임 관리 ----------
  let meetupPage = 1;
  async function loadMeetups(page){
    meetupPage = page || 1;
    const listEl = document.getElementById('meetupList');
    listEl.innerHTML = '<div class="empty-state">불러오는 중...</div>';
    const q = document.getElementById('meetupSearchInput').value.trim();
    const filter = document.getElementById('meetupFilterSelect').value;
    try {
      const data = await apiRequest(`/admin/meetups?page=${meetupPage}&q=${encodeURIComponent(q)}&filter=${filter}`);
      if(data.meetups.length === 0){
        listEl.innerHTML = '<div class="empty-state">해당하는 모임이 없어요.</div>';
      } else {
        listEl.innerHTML = data.meetups.map((m) => `
          <div class="row" data-id="${m.id}">
            <div class="row-main">
              <div class="row-title">
                ${escapeHtml(m.title)}
                ${m.cancelled ? '<span class="badge cancelled">취소됨</span>' : ''}
              </div>
              <div class="row-sub">
                @${escapeHtml(m.creator.username)} · ${m.location ? escapeHtml(m.location) + ' · ' : ''}${m.dateLabel || ''} ${m.timeLabel || ''} · 참여 ${m.participantCount}/${m.maxParticipants} · ${fmtDate(m.createdAt)}
              </div>
            </div>
            ${!m.cancelled ? `
              <div class="row-actions">
                <button class="danger" data-action="cancel">강제 취소</button>
              </div>
            ` : ''}
          </div>
        `).join('');
        listEl.querySelectorAll('.row').forEach((row) => {
          const id = row.dataset.id;
          const cancelBtn = row.querySelector('[data-action="cancel"]');
          if(cancelBtn) cancelBtn.addEventListener('click', async () => {
            const result = await confirmModal('모임 강제 취소', '이 모임을 강제로 취소할까요?\n채팅방은 그대로 남아있어요.', { confirmLabel: '취소시키기', danger: true });
            if(!result.confirmed) return;
            try {
              await apiRequest(`/admin/meetups/${id}/cancel`, { method: 'POST' });
              showToast('모임을 취소시켰어요.');
              loadMeetups(meetupPage);
            } catch(err) { showToast(err.message); }
          });
        });
      }
      renderPagination('meetupPagination', data.page, data.totalPages, loadMeetups);
    } catch(err) {
      listEl.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    }
  }
  document.getElementById('meetupSearchBtn').addEventListener('click', () => loadMeetups(1));
  document.getElementById('meetupSearchInput').addEventListener('keydown', (e) => { if(e.key === 'Enter') loadMeetups(1); });
  document.getElementById('meetupFilterSelect').addEventListener('change', () => loadMeetups(1));

  // ---------- 활동 로그 ----------
  let logPage = 1;
  const ACTION_LABEL = {
    SUSPEND_USER: '유저 정지', UNSUSPEND_USER: '정지 해제', DELETE_USER: '유저 삭제',
    DELETE_FEED_POST: '게시물 삭제', CANCEL_MEETUP: '모임 취소', RESOLVE_REPORT: '신고 처리',
  };
  async function loadLogs(page){
    logPage = page || 1;
    const listEl = document.getElementById('logList');
    listEl.innerHTML = '<div class="empty-state">불러오는 중...</div>';
    try {
      const data = await apiRequest(`/admin/logs?page=${logPage}`);
      if(data.logs.length === 0){
        listEl.innerHTML = '<div class="empty-state">아직 기록된 활동이 없어요.</div>';
      } else {
        listEl.innerHTML = data.logs.map((l) => `
          <div class="row">
            <div class="row-main">
              <div class="row-title">
                <span class="badge action">${escapeHtml(ACTION_LABEL[l.action] || l.action)}</span>
                ${l.detail ? escapeHtml(l.detail) : ''}
              </div>
              <div class="row-sub">@${escapeHtml(l.actor.username)} · ${fmtDate(l.createdAt)}</div>
            </div>
          </div>
        `).join('');
      }
      renderPagination('logPagination', data.page, data.totalPages, loadLogs);
    } catch(err) {
      listEl.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    }
  }

  tryAutoLogin();
})();
