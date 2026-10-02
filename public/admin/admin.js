(function(){
  'use strict';

  const API_BASE = '/api';
  let authToken = null;

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

  async function apiRequest(path, options){
    options = options || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    if(authToken) headers.Authorization = 'Bearer ' + authToken;
    const res = await fetch(API_BASE + path, Object.assign({ cache: 'no-store' }, options, { headers }));
    let data = null;
    try { data = await res.json(); } catch(e) { data = null; }
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

  // ---------- 로그인 ----------
  function setAuthToken(token){
    authToken = token;
    try { if(token) localStorage.setItem('catchme_admin_token', token); else localStorage.removeItem('catchme_admin_token'); } catch(e){}
  }

  async function tryAutoLogin(){
    let saved = null;
    try { saved = localStorage.getItem('catchme_admin_token'); } catch(e){}
    if(!saved) return showLogin();
    authToken = saved;
    try {
      await apiRequest('/admin/overview');
      showApp();
    } catch(e) {
      setAuthToken(null);
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
      try {
        await apiRequest('/admin/overview');
      } catch(adminErr){
        authToken = null;
        throw new Error(adminErr.status === 403 ? '관리자 계정이 아니에요.' : '확인 중 오류가 발생했어요.');
      }
      setAuthToken(data.token);
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
    setAuthToken(null);
    showLogin();
  });

  // ---------- 탭 전환 ----------
  const TAB_LOADERS = {
    dashboard: loadDashboard,
    users: () => loadUsers(1),
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

  function renderStatsChart(data){
    const wrap = document.getElementById('statsChartWrap');
    if(!data.days || data.days.length === 0){
      wrap.innerHTML = '<div class="empty-state">데이터가 없어요.</div>';
      return;
    }
    const max = Math.max(1, ...data.days.map((d) => d.count));
    const n = data.days.length;
    // 날짜가 많으면 라벨이 다 겹쳐서 보이니, 대략 10개 안팎으로만 보이게 간격을 둠
    const labelEvery = Math.max(1, Math.ceil(n / 10));
    const bars = data.days.map((d, i) => {
      const heightPct = Math.round((d.count / max) * 100);
      const showLabel = (i % labelEvery === 0) || i === n - 1;
      const label = d.date.slice(5); // "MM-DD"만 표시
      return `
        <div class="chart-bar-col" title="${escapeHtml(d.date)} · ${d.count.toLocaleString()}건">
          <div class="chart-bar" style="height:${Math.max(heightPct, d.count > 0 ? 2 : 0)}%"></div>
          <div class="chart-bar-label">${showLabel ? escapeHtml(label) : ''}</div>
        </div>
      `;
    }).join('');
    wrap.innerHTML = `
      <div class="chart-summary">총 ${data.total.toLocaleString()}건 · ${escapeHtml(data.start)} ~ ${escapeHtml(data.end)}</div>
      <div class="chart-bars">${bars}</div>
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

  function wireUserRowActions(listEl){
    listEl.querySelectorAll('.row').forEach((row) => {
      const id = row.dataset.id;
      const suspendBtn = row.querySelector('[data-action="suspend"]');
      const unsuspendBtn = row.querySelector('[data-action="unsuspend"]');
      const deleteBtn = row.querySelector('[data-action="delete"]');
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
  const TARGET_TYPE_LABEL = { FEED_POST: '소식 게시물', MEETUP: '모임', USER: '유저' };

  async function loadReports(page){
    reportPage = page || 1;
    const listEl = document.getElementById('reportList');
    listEl.innerHTML = '<div class="empty-state">불러오는 중...</div>';
    const status = document.getElementById('reportStatusSelect').value;
    try {
      const data = await apiRequest(`/admin/reports?page=${reportPage}&status=${status}`);
      if(data.reports.length === 0){
        listEl.innerHTML = '<div class="empty-state">해당하는 신고가 없어요.</div>';
      } else {
        listEl.innerHTML = data.reports.map((r) => `
          <div class="row" data-id="${r.id}" data-target-type="${r.targetType}">
            <div class="row-main">
              <div class="row-title">
                [${TARGET_TYPE_LABEL[r.targetType] || r.targetType}] ${escapeHtml(r.target.exists ? r.target.title : '(이미 삭제된 콘텐츠)')}
                ${r.status === 'PENDING' ? '<span class="badge pending">대기중</span>' : ''}
              </div>
              <div class="row-sub">사유: ${escapeHtml(r.reason)}${r.detail ? ` — ${escapeHtml(r.detail)}` : ''}</div>
              <div class="row-sub">
                신고자 @${escapeHtml(r.reporter.username)}
                ${r.target.author ? ` · 대상 @${escapeHtml(r.target.author.username)}` : ''}
                · ${fmtDate(r.createdAt)}
              </div>
            </div>
            ${r.status === 'PENDING' ? `
              <div class="row-actions">
                <button data-action="dismiss">반려</button>
                ${r.targetType === 'USER'
                  ? `<button class="danger" data-action="suspend-user">유저 정지</button>`
                  : `<button class="danger" data-action="delete-content">콘텐츠 삭제</button>`}
              </div>
            ` : ''}
          </div>
        `).join('');
        wireReportRowActions(listEl);
      }
      renderPagination('reportPagination', data.page, data.totalPages, loadReports);
    } catch(err) {
      listEl.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    }
  }

  function wireReportRowActions(listEl){
    listEl.querySelectorAll('.row').forEach((row) => {
      const id = row.dataset.id;
      const dismissBtn = row.querySelector('[data-action="dismiss"]');
      const suspendBtn = row.querySelector('[data-action="suspend-user"]');
      const deleteBtn = row.querySelector('[data-action="delete-content"]');
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
              <button class="danger" data-action="delete">삭제</button>
            </div>
          </div>
        `).join('');
        listEl.querySelectorAll('.row').forEach((row) => {
          const id = row.dataset.id;
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
      renderPagination('feedPagination', data.page, data.totalPages, loadFeed);
    } catch(err) {
      listEl.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    }
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
