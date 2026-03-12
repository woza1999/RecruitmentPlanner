/* =========================================================
  Recruitment Planner — Supabase-backed (per-user private)
  - Magic link sign-in
  - RLS required on `roles` table
========================================================= */

/* ===========================
  1) SUPABASE CONFIG  ✅ EDIT
=========================== */

// DO NOT commit real keys in public repos.
const SUPABASE_URL = "https://yxlvfockhdevksurayma.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_rT5fXqsS8Fz_spSQRU9epQ_DZ1_p7ZR";

// Supabase UMD global is `supabase`
const { createClient } = window.supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ===========================
  2) UTILITIES / CONSTANTS
=========================== */
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const TODAY = new Date(); TODAY.setHours(0,0,0,0);

function fmtDate(d){ return d.toISOString().slice(0,10); }
function parseD(s){ if(!s) return null; const d=new Date(s+'T00:00:00'); return isNaN(d)?null:d; }
function daysBetween(a,b){ return Math.round((b-a)/86400000); }
function addMonths(d,n){ const r=new Date(d); r.setMonth(r.getMonth()+n); return r; }
function fmtMoney(v){
  if (v === null || v === undefined || v === '') return '—';
  return '£' + Number(v).toLocaleString('en-GB');
}
function fmtDL(d){ return MON[d.getMonth()]+' '+d.getDate()+'\''+String(d.getFullYear()).slice(2); }

// Proper HTML escape (your previous one was double-escaped)
function esc(s){
  return String(s ?? '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// Colour tokens
const PALETTE = ['#2952c4','#1a7a52','#a36618','#4f3fa8','#903f18','#1a6d94','#7030a0','#a83030'];
const getColor = (i) => PALETTE[i % PALETTE.length];

const PRIORITY_CLASS = { critical:'p-critical', high:'p-high', medium:'p-medium', low:'p-low' };
const PRIORITY_ICON  = { critical:'🔴', high:'🟡', medium:'🔵', low:'🟢' };

const STATUS_META = {
  active:    { label:'Active',    cls:'s-active',    icon:'▶' },
  approved:  { label:'Approved',  cls:'s-approved',  icon:'✓' },
  pending:   { label:'Pending',   cls:'s-pending',   icon:'⏳' },
  onhold:    { label:'On Hold',   cls:'s-onhold',    icon:'⏸' },
  filled:    { label:'Filled',    cls:'s-filled',    icon:'★' },
  cancelled: { label:'Cancelled', cls:'s-cancelled', icon:'✕' },
};

const URG_CLASS = { confirmed:'u-confirmed', green:'u-green', amber:'u-amber', red:'u-red', nodate:'u-nodate' };
// Avoid "<" inside text labels to reduce HTML edge cases
const URG_LABEL = { confirmed:'✓ Confirmed', green:'8+ wks', amber:'4–8 wks', red:'Under 4 wks', nodate:'No date' };

let roles = [];
let dragSrc = null;
let editingId = null;
let currentTab = 'pipeline';

// Default form dates (only if elements exist)
const fStartEl = document.getElementById('f-start');
const fEndEl = document.getElementById('f-end');
if (fStartEl) fStartEl.value = fmtDate(TODAY);
if (fEndEl) fEndEl.value   = fmtDate(addMonths(TODAY, 6));

/* ===========================
  3) STATUS INDICATOR
=========================== */
const STATUS_CFG = {
  idle:    { text: '● Connected',              cls: 'si-ok' },
  auth:    { text: '⚠ Sign in required',       cls: 'si-warn' },
  loading: { text: '⟳ Loading…',              cls: 'si-busy' },
  saving:  { text: '⟳ Saving…',               cls: 'si-busy' },
  saved:   { text: '✓ Saved',                 cls: 'si-ok' },
  error:   { text: '✕ Error — check console', cls: 'si-err' },
};

function setStatus(key) {
  const el = document.getElementById('saveIndicator');
  if (!el) return;
  const cfg = STATUS_CFG[key] || STATUS_CFG.idle;
  el.textContent = cfg.text;
  el.className = 'save-indicator show ' + cfg.cls;
  if (key === 'saved') setTimeout(() => setStatus('idle'), 1800);
}

/* ===========================
  4) AUTH (Magic Link)
=========================== */
function showAuthOverlay(show) {
  const ov = document.getElementById('authOverlay');
  if (!ov) return;
  ov.style.display = show ? 'flex' : 'none';
}

async function signInMagicLink() {
  const email = (document.getElementById('authEmail')?.value || '').trim();
  if (!email) return;

  setStatus('auth');
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href.split('#')[0] }
  });

  if (error) {
    console.error(error);
    setStatus('error');
    alert('Sign-in failed: ' + error.message);
    return;
  }
  alert('Magic link sent. Check your email and click the link.');
}

async function signOut() {
  await sb.auth.signOut();
  roles = [];
  renderAll();
  setStatus('auth');
  showAuthOverlay(true);
}

async function getUserId() {
  const { data } = await sb.auth.getSession();
  return data?.session?.user?.id || null;
}

sb.auth.onAuthStateChange(async (_event, session) => {
  if (session?.user) {
    showAuthOverlay(false);
    await loadRolesFromSupabase();
    renderAll();
  } else {
    setStatus('auth');
    showAuthOverlay(true);
  }
});

/* ===========================
  5) URGENCY + COLORS
=========================== */
function getUrgency(r) {
  if (r.confirmed) return 'confirmed';
  const sd = parseD(r.start);
  if (!sd) return 'nodate';
  const days = daysBetween(TODAY, sd);
  if (days <= 28) return 'red';
  if (days <= 56) return 'amber';
  return 'green';
}

function getURGColors() {
  return document.documentElement.dataset.theme === 'dark'
    ? { confirmed:'#259e6f', green:'#259e6f', amber:'#c4861f', red:'#c24040', nodate:'#4e6080' }
    : { confirmed:'#1a7a52', green:'#1a7a52', amber:'#a36618', red:'#a83030', nodate:'#8090b0' };
}

/* ===========================
  6) SUPABASE DATA MAPPING
=========================== */
function mapDbToRole(row) {
  return {
    id: row.id,
    name: row.name,
    dept: row.dept,
    priority: row.priority,
    status: row.status,
    start: row.start_date ? String(row.start_date) : '',
    end: row.end_date ? String(row.end_date) : '',
    confirmed: !!row.confirmed,
    salBest: row.sal_best ?? '',
    salWorst: row.sal_worst ?? '',
    edited: !!row.edited,
  };
}

function mapRoleToDb(r) {
  return {
    name: r.name,
    dept: r.dept,
    priority: r.priority,
    status: r.status,
    start_date: r.start || null,
    end_date: r.end || null,
    confirmed: !!r.confirmed,
    sal_best: (r.salBest === '' || r.salBest === null || r.salBest === undefined) ? null : Number(r.salBest),
    sal_worst:(r.salWorst === '' || r.salWorst === null || r.salWorst === undefined) ? null : Number(r.salWorst),
    edited: !!r.edited
  };
}

async function loadRolesFromSupabase() {
  const uid = await getUserId();
  if (!uid) {
    setStatus('auth');
    showAuthOverlay(true);
    return false;
  }

  setStatus('loading');
  const { data, error } = await sb
    .from('roles')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });

  if (error) {
    console.error(error);
    setStatus('error');
    return false;
  }

  roles = (data || []).map(mapDbToRole);
  setStatus('idle');
  return true;
}

async function insertRoleToSupabase(role, sortOrder) {
  const uid = await getUserId();
  if (!uid) return null;

  setStatus('saving');

  const payload = {
    user_id: uid,
    ...mapRoleToDb(role),
    sort_order: sortOrder
  };

  const { data, error } = await sb
    .from('roles')
    .insert(payload)
    .select('*')
    .single();

  if (error) {
    console.error(error);
    setStatus('error');
    return null;
  }

  setStatus('saved');
  return mapDbToRole(data);
}

async function updateRoleInSupabase(id, patch) {
  setStatus('saving');

  const { error } = await sb
    .from('roles')
    .update(patch)
    .eq('id', id);

  if (error) {
    console.error(error);
    setStatus('error');
    return false;
  }
  setStatus('saved');
  return true;
}

async function deleteRoleFromSupabase(id) {
  setStatus('saving');

  const { error } = await sb
    .from('roles')
    .delete()
    .eq('id', id);

  if (error) {
    console.error(error);
    setStatus('error');
    return false;
  }

  setStatus('saved');
  return true;
}

async function persistSortOrder() {
  setStatus('saving');

  const ops = roles.map((r, idx) =>
    sb.from('roles').update({ sort_order: idx }).eq('id', r.id)
  );

  const results = await Promise.all(ops);
  const anyErr = results.find(x => x.error);

  if (anyErr) {
    console.error(anyErr.error);
    setStatus('error');
    return false;
  }

  setStatus('saved');
  return true;
}

/* ===========================
  7) RENDER LIST
=========================== */
function renderList() {
  const list = document.getElementById('dragList');
  if (!list) return;

  const count = roles.length;
  const rc = document.getElementById('role-count');
  if (rc) rc.textContent = count + ' role' + (count !== 1 ? 's' : '');

  if (!count) {
    list.innerHTML = `
      <div class="empty" style="min-height:200px;">
        <div class="empty-icon">📋</div>
        <span>No roles yet — add one below</span>
      </div>`;
    updateScrollHint();
    return;
  }

  list.innerHTML = '';
  roles.forEach((r, i) => {
    const col = getColor(i);
    const urg = getUrgency(r);
    const sm = STATUS_META[r.status] || STATUS_META.active;
    const sd = parseD(r.start), ed = parseD(r.end);
    const sl = sd ? MON[sd.getMonth()] + ' ' + sd.getFullYear() : '—';
    const el = ed ? MON[ed.getMonth()] + ' ' + ed.getFullYear() : '—';

    let daysChip = '';
    if (!r.confirmed && sd) {
      const dts = daysBetween(TODAY, sd);
      if (dts < 0) daysChip = `<span class="tag" style="color:var(--red);border-color:rgba(194,64,64,0.3);">⚠ Overdue by ${Math.abs(dts)}d</span>`;
      else if (dts === 0) daysChip = `<span class="tag" style="color:${getURGColors()[urg]};border-color:${getURGColors()[urg]}33;">⏱ Starts today</span>`;
      else daysChip = `<span class="tag" style="color:${getURGColors()[urg]};border-color:${getURGColors()[urg]}33;">⏱ ${dts}d to start</span>`;
    }

    const card = document.createElement('div');
    card.className = 'role-card';
    card.draggable = true;
    card.dataset.id = r.id;

    card.innerHTML = `
      <div class="card-accent" style="background:${col}"></div>
      <div class="drag-handle" title="Drag to reorder">⠿</div>

      <div class="card-body">
        <div class="card-rank" style="color:${col}">${i + 1}</div>

        <div class="card-main">
          <div class="card-name">
            ${esc(r.name)}
            ${r.edited ? '<span class="edited-dot" title="Recently edited"></span>' : ''}
          </div>

          <div class="card-pills">
            <span class="pill ${PRIORITY_CLASS[r.priority]}">${PRIORITY_ICON[r.priority]} ${r.priority}</span>
            <span class="pill ${sm.cls}">${sm.icon} ${sm.label}</span>
            <span class="pill ${URG_CLASS[urg]}">${URG_LABEL[urg]}</span>
          </div>

          <div class="card-tags">
            <span class="tag">📁 ${esc(r.dept)}</span>
            <span class="tag">📅 ${sl}</span>
            <span class="tag">→ ${el}</span>
            ${daysChip}
          </div>

          ${(r.salBest || r.salWorst) ? `
            <div class="card-salary">
              <span class="sal-best">▼ Best ${fmtMoney(r.salBest)}</span>
              <span class="sal-div"></span>
              <span class="sal-worst">▲ Worst ${fmtMoney(r.salWorst)}</span>
              ${(Number(r.salBest) && Number(r.salWorst)) ? `
                <span class="sal-div"></span>
                <span style="color:var(--muted);font-size:9px;">Δ ${fmtMoney(Number(r.salWorst) - Number(r.salBest))}</span>
              ` : ''}
            </div>
          ` : ''}
        </div>
      </div>

      <div class="card-footer">
        <label class="check-label" onclick="event.stopPropagation()">
          <input type="checkbox" ${r.confirmed ? 'checked' : ''} onchange="toggleConfirmed(${r.id}, this.checked)" />
          <span class="checkmark"></span>
          <span class="check-text">${r.confirmed ? '✓ Resource confirmed' : 'Mark as confirmed'}</span>
        </label>

        <div class="card-actions">
          <button class="edit-btn" onclick="openDrawer(${r.id}, event)">✏ Edit</button>
          <button class="delete-btn" onclick="deleteRole(${r.id}, event)" title="Remove role">✕</button>
        </div>
      </div>
    `;

    // Drag events
    card.addEventListener('dragstart', (e) => {
      dragSrc = card;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      document.querySelectorAll('.role-card').forEach(c => c.classList.remove('drag-target'));
      card.classList.add('drag-target');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-target'));
    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      card.classList.remove('drag-target');
      if (dragSrc && dragSrc !== card) {
        const si = roles.findIndex(x => x.id === +dragSrc.dataset.id);
        const ti = roles.findIndex(x => x.id === +card.dataset.id);
        const [m] = roles.splice(si, 1);
        roles.splice(ti, 0, m);
        renderAll();
        await persistSortOrder();
      }
    });

    list.appendChild(card);
  });

  requestAnimationFrame(updateScrollHint);
}

const dragListEl = document.getElementById('dragList');
if (dragListEl) dragListEl.addEventListener('dragover', (e) => e.preventDefault());

/* ===========================
  8) SUMMARY
=========================== */
function renderSummary() {
  let best = 0, worst = 0, active = 0, onhold = 0, filled = 0;

  roles.forEach(r => {
    if (r.salBest) best += +r.salBest;
    if (r.salWorst) worst += +r.salWorst;
    if (r.status === 'active' || r.status === 'approved') active++;
    if (r.status === 'onhold') onhold++;
    if (r.status === 'filled') filled++;
  });

  const cards = [
    { lbl:'Total Roles', val:roles.length, sub:'in pipeline', acc:'var(--accent)' },
    { lbl:'Active / Ready', val:active, sub:'hiring in progress', acc:'var(--green)' },
    { lbl:'On Hold', val:onhold, sub:'paused roles', acc:'var(--amber)' },
    { lbl:'Best-Case Budget', val:fmtMoney(best), sub:'combined annual', acc:'var(--green)' },
    { lbl:'Worst-Case Budget', val:fmtMoney(worst), sub:'combined annual', acc:'var(--red)' },
  ];

  const sum = document.getElementById('summary-row');
  if (sum) {
    sum.innerHTML = cards.map(c => `
      <div class="sum-card" style="--card-accent:${c.acc}">
        <div class="sum-lbl">${c.lbl}</div>
        <div class="sum-val">${c.val}</div>
        <div class="sum-sub">${c.sub}</div>
      </div>
    `).join('');
  }

  const hdr = document.getElementById('hdr-stats');
  if (hdr) {
    hdr.innerHTML = `
      <div class="hdr-stat">
        <div class="hdr-stat-val" style="color:var(--green)">${fmtMoney(best)}</div>
        <div class="hdr-stat-lbl">Best Case</div>
      </div>
      <div class="hdr-stat">
        <div class="hdr-stat-val" style="color:var(--red)">${fmtMoney(worst)}</div>
        <div class="hdr-stat-lbl">Worst Case</div>
      </div>
    `;
  }
}

/* ===========================
  9) GANTT
=========================== */
function renderGantt() {
  const inner = document.getElementById('gantt-inner');
  if (!inner) return;

  if (!roles.length) {
    inner.innerHTML = '<div class="empty"><div class="empty-icon">📊</div><span>Add roles to see the Gantt</span></div>';
    const gr = document.getElementById('gantt-range');
    if (gr) gr.textContent = '—';
    return;
  }

  const MONTH_W = 72, NAME_W = 200, STATUS_W = 110;
  const ganttStart = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1);
  const allEnds = roles.map(r => parseD(r.end)).filter(Boolean);
  let ganttEnd = allEnds.length ? new Date(Math.max(...allEnds)) : addMonths(TODAY,6);
  ganttEnd = new Date(ganttEnd.getFullYear(), ganttEnd.getMonth()+2, 1);

  const months = [];
  let cur = new Date(ganttStart);
  while (cur <= ganttEnd) { months.push(new Date(cur)); cur.setMonth(cur.getMonth()+1); }
  while (months.length < 8) { const l=new Date(months[months.length-1]); l.setMonth(l.getMonth()+1); months.push(l); }

  const timelineW = months.length * MONTH_W;
  const totalDays = daysBetween(ganttStart, months[months.length-1]) + 31;
  const xFor = (d) => Math.round((daysBetween(ganttStart,d)/totalDays)*timelineW);
  const todayX = xFor(TODAY);

  const lastEnd = allEnds.length ? new Date(Math.max(...allEnds)) : addMonths(TODAY,6);
  const gr = document.getElementById('gantt-range');
  if (gr) gr.textContent = fmtDL(TODAY) + ' → ' + fmtDL(lastEnd);

  let html = `<div style="min-width:${NAME_W+STATUS_W+timelineW}px;">`;

  // Header
  html += `<div class="g-header-row">
    <div class="gantt-name-col"><div class="g-name-hdr">Role</div></div>
    <div class="g-status-col" style="display:flex;align-items:center;padding:0 10px;height:44px;">
      <span style="font-family:'IBM Plex Mono',monospace;font-size:9px;color:var(--muted);letter-spacing:1.5px;text-transform:uppercase;">Status</span>
    </div>
    <div style="flex:1;">
      <div class="month-hdr-wrap">`;

  months.forEach((m,i) => {
    const isYr = m.getMonth() === 0 && i > 0;
    html += `<div class="month-hdr-cell ${isYr?'new-yr':''}" style="width:${MONTH_W}px;min-width:${MONTH_W}px;">
      <span>${MON[m.getMonth()]}</span>
      <span style="font-size:7px;opacity:0.45;margin-top:1px">${m.getFullYear()}</span>
    </div>`;
  });

  html += `</div></div></div>`;

  // Rows
  roles.forEach((r, i) => {
    const col = getColor(i);
    const sd = parseD(r.start), ed = parseD(r.end);
    const hasDates = !!(sd && ed);
    const urg = getUrgency(r);
    const barColor = getURGColors()[urg];
    const sm = STATUS_META[r.status] || STATUS_META.active;

    let finalColor = barColor;
    let extraBarClass = '';
    const dark = document.documentElement.dataset.theme === 'dark';
    if (r.status === 'onhold')    { finalColor = dark ? '#c4861f' : '#a36618'; extraBarClass = 'g-bar-onhold'; }
    if (r.status === 'cancelled') { finalColor = dark ? '#4e6080' : '#8090b0'; extraBarClass = 'g-bar-cancelled'; }
    if (r.status === 'filled')    { finalColor = dark ? '#2a8ab8' : '#1a6d94'; extraBarClass = ''; }

    let barL=0, barW=0;
    if (hasDates) {
      barL = Math.max(0, xFor(sd));
      barW = Math.max(6, xFor(ed) - barL);
    }

    const sbv = +r.salBest || 0, swv = +r.salWorst || 0, mx = Math.max(sbv, swv, 1);
    const bestW  = hasDates ? Math.round((sbv/mx)*barW) : 0;
    const worstW = hasDates ? Math.round((swv/mx)*barW) : 0;

    html += `<div class="g-row">
      <div class="g-name-cell" style="border-left:3px solid ${col}">
        <span class="g-rank" style="color:${col}">#${i+1}</span>
        <span class="g-role-name" title="${esc(r.name)}">${esc(r.name)}</span>
      </div>

      <div class="g-status-cell">
        <span class="pill ${sm.cls}" style="font-size:8px;">${sm.icon} ${sm.label}</span>
      </div>

      <div style="flex:1;">
        <div class="g-bar-area" style="width:${timelineW}px;">`;

    months.forEach((_,mi) => { html += `<div class="g-vline" style="left:${mi*MONTH_W}px"></div>`; });
    html += `<div class="g-today" style="left:${todayX}px"><span class="g-today-lbl">TODAY</span></div>`;

    if (hasDates) {
      const urgTxt = { confirmed:'✓ Confirmed', green:'', amber:'', red:'!', nodate:'' }[urg];
      html += `<div class="g-bar ${extraBarClass}"
        style="left:${barL}px;width:${barW}px;background:${finalColor}20;border:1px solid ${finalColor}55;"
        onmouseenter="showTip(event,${i})" onmouseleave="hideTip()">
        <span style="color:${finalColor};font-weight:600;">${urgTxt}</span>
      </div>`;

      if (bestW > 0)  html += `<div class="g-sal-best" style="left:${barL}px;width:${bestW}px"></div>`;
      if (worstW > 0) html += `<div class="g-sal-worst" style="left:${barL}px;width:${worstW}px"></div>`;
    } else {
      html += `<div class="g-no-dates" style="left:${todayX+8}px">No dates set</div>`;
    }

    html += `</div></div></div>`;
  });

  html += `</div>`;
  inner.innerHTML = html;
}

/* ===========================
  10) TOOLTIP
=========================== */
function showTip(_e, i) {
  const r = roles[i]; if(!r) return;
  const sd=parseD(r.start), ed=parseD(r.end);

  let dur='—';
  if (sd && ed) {
    const m=Math.round(daysBetween(sd,ed)/30.4);
    dur=m+' month'+(m!==1?'s':'');
  }

  const urg = getUrgency(r);
  const sm = STATUS_META[r.status] || STATUS_META.active;
  const urgFull = {
    confirmed:'✓ Resource confirmed',
    green:'🟢 8+ weeks to start',
    amber:'🟡 4–8 weeks to start',
    red:'🔴 Under 4 weeks',
    nodate:'⚪ No start date'
  }[urg];

  const tip = document.getElementById('tip');
  if (!tip) return;

  tip.innerHTML = `
    <div class="tt-name">${esc(r.name)}</div>
    <div class="tt-row"><span>📁 ${esc(r.dept)}</span><span>${PRIORITY_ICON[r.priority]} ${r.priority}</span></div>
    <div class="tt-row"><span>${sm.icon} ${sm.label}</span><span>${urgFull}</span></div>
    <div class="tt-row"><span>📅 ${r.start||'—'}</span><span>→ ${r.end||'—'}</span></div>
    <div>⏱ ${dur}</div>
    <div class="tt-row" style="margin-top:4px;padding-top:4px;border-top:1px solid var(--border2)">
      <span class="tt-g">▼ Best: ${fmtMoney(r.salBest)}</span>
      <span class="tt-r">▲ Worst: ${fmtMoney(r.salWorst)}</span>
    </div>
  `;
  tip.style.display = 'block';
}

document.addEventListener('mousemove', (e) => {
  const t=document.getElementById('tip');
  if (t && t.style.display === 'block') {
    t.style.left = (e.clientX + 16) + 'px';
    t.style.top  = (e.clientY - 10) + 'px';
  }
});

function hideTip(){
  const t = document.getElementById('tip');
  if (t) t.style.display='none';
}

/* ===========================
  11) CRUD ACTIONS
=========================== */
async function addRole() {
  const nameEl = document.getElementById('f-name');
  if (!nameEl) return;

  const name = nameEl.value.trim();
  if (!name) { nameEl.focus(); return; }

  const start = document.getElementById('f-start')?.value || '';
  const end   = document.getElementById('f-end')?.value || '';
  if (start && end && parseD(start) >= parseD(end)) {
    alert('Completion date must be after start date.');
    return;
  }

  const role = {
    name,
    dept: document.getElementById('f-dept')?.value || 'Other',
    priority: document.getElementById('f-priority')?.value || 'medium',
    status: document.getElementById('f-status')?.value || 'active',
    start, end,
    confirmed: !!document.getElementById('f-confirmed')?.checked,
    salBest: document.getElementById('f-sal-best')?.value || '',
    salWorst: document.getElementById('f-sal-worst')?.value || '',
    edited: false
  };

  const inserted = await insertRoleToSupabase(role, roles.length);
  if (!inserted) return;

  roles.push(inserted);

  // reset form
  nameEl.value='';
  const sbEl = document.getElementById('f-sal-best'); if (sbEl) sbEl.value='';
  const swEl = document.getElementById('f-sal-worst'); if (swEl) swEl.value='';
  const fcEl = document.getElementById('f-confirmed'); if (fcEl) fcEl.checked=false;
  if (fStartEl) fStartEl.value=fmtDate(TODAY);
  if (fEndEl) fEndEl.value=fmtDate(addMonths(TODAY,6));

  renderAll();
}

async function deleteRole(id, e) {
  if (e) e.stopPropagation();
  const ok = await deleteRoleFromSupabase(id);
  if (!ok) return;
  roles = roles.filter(r => r.id !== id);
  renderAll();
  await persistSortOrder();
}

async function toggleConfirmed(id, val) {
  const r = roles.find(x => x.id === id);
  if (!r) return;

  r.confirmed = val;
  const ok = await updateRoleInSupabase(id, { confirmed: val });
  if (!ok) return;

  renderSummary();
  renderGantt();

  const card = document.querySelector(`.role-card[data-id="${id}"]`);
  if (card) {
    const urg = getUrgency(r);
    const urgPill = card.querySelectorAll('.pill')[2];
    if (urgPill) { urgPill.className = `pill ${URG_CLASS[urg]}`; urgPill.textContent = URG_LABEL[urg]; }
    const txt = card.querySelector('.check-text');
    if (txt) txt.textContent = val ? '✓ Resource confirmed' : 'Mark as confirmed';
  }
}

/* ===========================
  12) EDIT DRAWER
=========================== */
function openDrawer(id, e) {
  if (e) e.stopPropagation();
  const r = roles.find(x => x.id === id);
  if (!r) return;

  editingId = id;

  document.getElementById('drawer-title').textContent = r.name;
  document.getElementById('e-name').value = r.name;
  document.getElementById('e-dept').value = r.dept;
  document.getElementById('e-priority').value = r.priority;
  document.getElementById('e-status').value = r.status || 'active';
  document.getElementById('e-start').value = r.start || '';
  document.getElementById('e-end').value = r.end || '';
  document.getElementById('e-confirmed').checked = !!r.confirmed;
  document.getElementById('e-sal-best').value = r.salBest || '';
  document.getElementById('e-sal-worst').value = r.salWorst || '';

  document.getElementById('editDrawer').classList.add('open');
  document.getElementById('drawerOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('e-name').focus(), 280);
}

function closeDrawer() {
  document.getElementById('editDrawer').classList.remove('open');
  document.getElementById('drawerOverlay').classList.remove('open');
  document.body.style.overflow = '';
  editingId = null;
}

async function saveEdit() {
  const r = roles.find(x => x.id === editingId);
  if (!r) return;

  const name = document.getElementById('e-name').value.trim();
  if (!name) { document.getElementById('e-name').focus(); return; }

  const start = document.getElementById('e-start').value;
  const end   = document.getElementById('e-end').value;
  if (start && end && parseD(start) >= parseD(end)) {
    alert('Completion date must be after start date.');
    return;
  }

  r.name = name;
  r.dept = document.getElementById('e-dept').value;
  r.priority = document.getElementById('e-priority').value;
  r.status = document.getElementById('e-status').value;
  r.start = start;
  r.end = end;
  r.confirmed = document.getElementById('e-confirmed').checked;
  r.salBest = document.getElementById('e-sal-best').value;
  r.salWorst = document.getElementById('e-sal-worst').value;
  r.edited = true;

  const ok = await updateRoleInSupabase(r.id, mapRoleToDb(r));
  if (!ok) return;

  closeDrawer();
  renderAll();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && editingId) closeDrawer();
});

/* ===========================
  13) FILTER + SCROLL HINT
=========================== */
function filterList() {
  const q = (document.getElementById('list-search')?.value || '').toLowerCase();
  const status = document.getElementById('list-filter-status')?.value || '';

  document.querySelectorAll('.role-card').forEach(card => {
    const id = +card.dataset.id;
    const r = roles.find(x => x.id === id);
    if (!r) return;
    const matchQ = !q || r.name.toLowerCase().includes(q) || r.dept.toLowerCase().includes(q);
    const matchS = !status || r.status === status;
    card.style.display = (matchQ && matchS) ? '' : 'none';
  });

  updateScrollHint();
}

function updateScrollHint() {
  const list = document.getElementById('dragList');
  const fade = document.getElementById('listFade');
  const hint = document.getElementById('scrollHint');
  if (!list || !fade || !hint) return;

  const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 8;
  const hasScroll = list.scrollHeight > list.clientHeight + 8;
  const show = hasScroll && !atBottom;

  fade.classList.toggle('hidden', !show);
  hint.classList.toggle('hidden', !show);

  if (show) {
    const visibleBottom = list.scrollTop + list.clientHeight;
    const remaining = [...list.querySelectorAll('.role-card')]
      .filter(c => c.style.display !== 'none' && c.offsetTop > visibleBottom).length;
    hint.textContent = remaining > 0 ? `↓ ${remaining} more role${remaining !== 1 ? 's' : ''}` : '↓ scroll for more';
  }
}

if (dragListEl) dragListEl.addEventListener('scroll', updateScrollHint);

/* ===========================
  14) EXPORT + RESET
=========================== */
function exportCSV() {
  const headers = ['Rank','Role','Department','Priority','Status','Start Date','End Date','Confirmed','Best Case (£)','Worst Case (£)','Urgency'];
  const rows = roles.map((r, i) => {
    const urg = URG_LABEL[getUrgency(r)];
    return [
      i+1, `"${String(r.name).replace(/"/g,'""')}"`, r.dept, r.priority, r.status,
      r.start||'', r.end||'',
      r.confirmed ? 'Yes' : 'No',
      r.salBest||'', r.salWorst||'',
      urg
    ].join(',');
  });
  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type:'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'recruitment-planner.csv';
  a.click(); URL.revokeObjectURL(url);
}

async function clearSave() {
  if (!confirm('Clear all your saved roles and reset to demo roles?')) return;

  const uid = await getUserId();
  if (!uid) return;

  setStatus('saving');

  // Delete all rows for this user (RLS permits)
  const { error } = await sb.from('roles').delete().neq('id', 0);
  if (error) {
    console.error(error);
    setStatus('error');
    return;
  }

  roles = [];
  setStatus('saved');

  // Reseed demo roles
  const seed = SEED_ROLES();
  for (let i = 0; i < seed.length; i++) {
    const inserted = await insertRoleToSupabase(seed[i], i);
    if (inserted) roles.push(inserted);
  }

  renderAll();
}

/* ===========================
  15) THEME TOGGLE
=========================== */
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('rp-theme', next);
  updateThemeToggle();
  renderAll();
}

function updateThemeToggle() {
  const isDark = document.documentElement.dataset.theme === 'dark';
  const l = document.getElementById('tt-light');
  const d = document.getElementById('tt-dark');
  if (l) l.classList.toggle('active', !isDark);
  if (d) d.classList.toggle('active', isDark);
}

/* ===========================
  16) TAB NAV + DASHBOARD
=========================== */
function switchTab(tab) {
  currentTab = tab;
  const vp = document.getElementById('view-pipeline');
  const vd = document.getElementById('view-dashboard');
  if (vp) vp.style.display = tab === 'pipeline' ? '' : 'none';
  if (vd) vd.style.display = tab === 'dashboard' ? '' : 'none';

  document.getElementById('tab-pipeline')?.classList.toggle('active', tab === 'pipeline');
  document.getElementById('tab-dashboard')?.classList.toggle('active', tab === 'dashboard');

  if (tab === 'dashboard') renderDashboard();
}

function getDashColors() {
  const d = document.documentElement.dataset.theme === 'dark';
  return {
    critical: d ? '#c24040':'#a83030', high: d ? '#c4861f':'#a36618',
    medium: d ? '#3a65d4':'#2952c4', low: d ? '#259e6f':'#1a7a52',
    active: d ? '#259e6f':'#1a7a52', approved: d ? '#3a65d4':'#2952c4',
    pending: d ? '#6b5cc4':'#4f3fa8', onhold: d ? '#c4861f':'#a36618',
    filled: d ? '#2a8ab8':'#1a6d94', cancelled: d ? '#4e6080':'#8090b0',
    confirmed: d ? '#259e6f':'#1a7a52', green: d ? '#259e6f':'#1a7a52',
    amber: d ? '#c4861f':'#a36618', red: d ? '#c24040':'#a83030',
    nodate: d ? '#4e6080':'#8090b0'
  };
}

// Your existing dashboard renderer was fine; leave it as-is if you already have it.
// If you need me to re-drop the full dashboard code too, say "include dashboard".
function renderDashboard() {
  // Minimal placeholder to avoid crashes if you haven't pasted the full dashboard block yet.
  const el = document.getElementById('dash-inner');
  if (!el) return;
  if (!roles.length) {
    el.innerHTML = `<div class="dash-empty"><div style="font-size:36px;opacity:0.18">📊</div><span>Add roles on the Pipeline tab to see analytics</span></div>`;
    return;
  }
  el.innerHTML = `<div class="dash-empty"><span>Dashboard renderer not pasted. Say: "include dashboard"</span></div>`;
}

/* ===========================
  17) RENDER ALL
=========================== */
function renderAll() {
  renderList();
  renderSummary();
  renderGantt();
  if (currentTab === 'dashboard') renderDashboard();
  updateThemeToggle();
}

/* ===========================
  18) SEED ROLES + STARTUP
=========================== */
const SEED_ROLES = () => ([
  { name:'Senior Backend Engineer', dept:'Engineering', priority:'critical', status:'active',   start:fmtDate(addMonths(TODAY,0)), end:fmtDate(addMonths(TODAY,9)),  confirmed:true,  salBest:'70000', salWorst:'90000', edited:false },
  { name:'Product Manager',        dept:'Product',    priority:'high',     status:'approved', start:fmtDate(addMonths(TODAY,0)), end:fmtDate(addMonths(TODAY,12)), confirmed:false, salBest:'65000', salWorst:'85000', edited:false },
  { name:'UX Designer',            dept:'Design',     priority:'high',     status:'pending',  start:fmtDate(addMonths(TODAY,2)), end:fmtDate(addMonths(TODAY,10)), confirmed:false, salBest:'55000', salWorst:'70000', edited:false },
  { name:'Sales Lead',             dept:'Sales',      priority:'medium',   status:'onhold',   start:fmtDate(addMonths(TODAY,3)), end:fmtDate(addMonths(TODAY,11)), confirmed:false, salBest:'60000', salWorst:'80000', edited:false },
  { name:'Data Analyst',           dept:'Data',       priority:'low',      status:'approved', start:fmtDate(addMonths(TODAY,1)), end:fmtDate(addMonths(TODAY,8)),  confirmed:false, salBest:'45000', salWorst:'60000', edited:false },
  { name:'DevOps Engineer',        dept:'Engineering',priority:'high',     status:'pending',  start:fmtDate(addMonths(TODAY,1)), end:fmtDate(addMonths(TODAY,7)),  confirmed:false, salBest:'65000', salWorst:'80000', edited:false },
  { name:'Marketing Manager',      dept:'Marketing',  priority:'medium',   status:'approved', start:fmtDate(addMonths(TODAY,4)), end:fmtDate(addMonths(TODAY,13)), confirmed:false, salBest:'55000', salWorst:'70000', edited:false },
]);

(async () => {
  // Check session
  const { data } = await sb.auth.getSession();
  const signedIn = !!data?.session?.user;

  if (!signedIn) {
    setStatus('auth');
    showAuthOverlay(true);
    updateThemeToggle();
    renderAll();
    return;
  }

  showAuthOverlay(false);
  const loaded = await loadRolesFromSupabase();

  // If empty, seed once (for this user)
  if (loaded && roles.length === 0) {
    const seed = SEED_ROLES();
    for (let i = 0; i < seed.length; i++) {
      const inserted = await insertRoleToSupabase(seed[i], i);
      if (inserted) roles.push(inserted);
    }
  }

  renderAll();
})();