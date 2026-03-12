
/* =========================================================
  Recruitment Planner — Supabase-backed (NO AUTH / PUBLIC)
  - No login
  - Uses anon key directly
  - Requires RLS policies that allow anon access
========================================================= */

/* ===========================
  1) SUPABASE CONFIG  ✅ EDIT
=========================== */

const SUPABASE_URL = "https://yxlvfockhdevksurayma.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_rT5fXqsS8Fz_spSQRU9epQ_DZ1_p7ZR"; // <-- paste locally (do NOT commit if repo is public)

// Supabase UMD global is `supabase`
if (!window.supabase) {
  console.error("Supabase library not loaded. Check your index.html <script src=...supabase-js...>");
}

/* ===========================
  11) CRUD ACTIONS
=========================== */
async function copyRole(id, e) {
  if (e) e.stopPropagation();

  const original = roles.find(r => r.id === id);
  if (!original) return;

  // Duplicate data (new DB row)
  const duplicate = {
    name: original.name + ' (Copy)',
    dept: original.dept,
    priority: original.priority,
    status: original.status,
    start: original.start,
    end: original.end,
    confirmed: false,
    salBest: original.salBest,
    salWorst: original.salWorst,
    edited: false
  };

  // Insert into Supabase
  const inserted = await insertRoleToSupabase(duplicate, roles.length);
  if (!inserted) return;

  // Insert in UI directly after original
  const idx = roles.findIndex(r => r.id === id);
  roles.splice(idx + 1, 0, inserted);

  renderAll();
  await persistSortOrder();
}

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
const URG_LABEL = { confirmed:'✓ Confirmed', green:'8+ wks', amber:'4–8 wks', red:'Under 4 wks', nodate:'No date' };

let roles = [];
let clients = [];
let dragSrc = null;
let editingId = null;
let currentTab = 'pipeline';

/* Default form dates */
const fStartEl = document.getElementById('f-start');
const fEndEl = document.getElementById('f-end');
if (fStartEl) fStartEl.value = fmtDate(TODAY);
if (fEndEl) fEndEl.value = fmtDate(addMonths(TODAY, 6));

/* ===========================
  3) STATUS INDICATOR
=========================== */

const STATUS_CFG = {
  idle:    { text: '● Connected',              cls: 'si-ok' },
  loading: { text: '⟳ Loading…',              cls: 'si-busy' },
  saving:  { text: '⟳ Saving…',               cls: 'si-busy' },
  saved:   { text: '✓ Saved',                 cls: 'si-ok' },
  warn:    { text: '⚠ Check setup',           cls: 'si-warn' },
  error:   { text: '✕ Error — check console', cls: 'si-err' },
};

function setStatus(key) {
  const el = document.getElementById('saveIndicator');
  if (!el) return;
  const cfg = STATUS_CFG[key] || STATUS_CFG.idle;
  el.textContent = cfg.text;
  el.className = 'save-indicator show ' + cfg.cls;
  if (key === 'saved') setTimeout(() => setStatus('idle'), 1500);
}

/* ===========================
  4) URGENCY + COLORS
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
  5) SUPABASE DATA MAPPING
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
    sort_order: row.sort_order ?? 0,
    client: row.client || '',
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

/* ===========================
  6) SUPABASE CRUD (PUBLIC)
=========================== */

async function loadRolesFromSupabase() {
  setStatus('loading');

  const { data, error } = await sb
    .from('roles')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });

  if (error) {
    console.error("Load failed:", error);
    setStatus('error');
    return false;
  }

  roles = (data || []).map(mapDbToRole);
  setStatus('idle');
  return true;
}

async function insertRoleToSupabase(role, sortOrder) {
  setStatus('saving');

  const payload = {
    ...mapRoleToDb(role),
    sort_order: sortOrder
  };

  const { data, error } = await sb
    .from('roles')
    .insert(payload)
    .select('*')
    .single();

  if (error) {
    console.error("Insert failed:", error);
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
    console.error("Update failed:", error);
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
    console.error("Delete failed:", error);
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
    console.error("Sort persist failed:", anyErr.error);
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
  <button class="edit-btn" onclick="openDrawer(${r.id},event)">✏ Edit</button>

  <button class="edit-btn"
          onclick="copyRole(${r.id}, event)">
    📋 Copy
  </button>

  <button class="delete-btn" onclick="deleteRole(${r.id},event)">✕</button>
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
  if (sd && ed) { const m=Math.round(daysBetween(sd,ed)/30.4); dur=m+' month'+(m!==1?'s':''); }

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
function hideTip(){ const t=document.getElementById('tip'); if (t) t.style.display='none'; }

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

const SEED_ROLES = () => ([
  { name:'Senior Backend Engineer', dept:'Engineering', priority:'critical', status:'active',   start:fmtDate(addMonths(TODAY,0)), end:fmtDate(addMonths(TODAY,9)),  confirmed:true,  salBest:'70000', salWorst:'90000', edited:false },
  { name:'Product Manager',        dept:'Product',    priority:'high',     status:'approved', start:fmtDate(addMonths(TODAY,0)), end:fmtDate(addMonths(TODAY,12)), confirmed:false, salBest:'65000', salWorst:'85000', edited:false },
  { name:'UX Designer',            dept:'Design',     priority:'high',     status:'pending',  start:fmtDate(addMonths(TODAY,2)), end:fmtDate(addMonths(TODAY,10)), confirmed:false, salBest:'55000', salWorst:'70000', edited:false },
]);

async function clearSave() {
  if (!confirm('Clear ALL roles in the database and reset to demo roles?')) return;

  setStatus('saving');

  // WARNING: This deletes ALL records (public/shared app)
  const del = await sb.from('roles').delete().neq('id', 0);
  if (del.error) {
    console.error(del.error);
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
  15) THEME TOGGLE + TABS
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
  document.getElementById('tt-light')?.classList.toggle('active', !isDark);
  document.getElementById('tt-dark')?.classList.toggle('active', isDark);
}

function switchTab(tab) {
  currentTab = tab;
  document.getElementById('view-pipeline').style.display = tab === 'pipeline' ? '' : 'none';
  document.getElementById('view-dashboard').style.display = tab === 'dashboard' ? '' : 'none';
  document.getElementById('tab-pipeline')?.classList.toggle('active', tab === 'pipeline');
  document.getElementById('tab-dashboard')?.classList.toggle('active', tab === 'dashboard');
  if (tab === 'dashboard') renderDashboard();
}

/* ===========================
  16) DASHBOARD (full)
=========================== */

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

function renderDashboard() {
  const el = document.getElementById('dash-inner');
  if (!el) return;

  if (!roles.length) {
    el.innerHTML = `<div class="dash-empty"><div style="font-size:36px;opacity:0.18">📊</div><span>Add roles on the Pipeline tab to see analytics</span></div>`;
    return;
  }

  const C = getDashColors();
  const total = roles.length;

  const statusCounts = {};
  const priorityCounts = {critical:0,high:0,medium:0,low:0};
  const deptData = {};
  let totalBest = 0, totalWorst = 0, confirmed = 0, totalDur = 0, durCount = 0;
  const urgCounts = {confirmed:0,green:0,amber:0,red:0,nodate:0};

  roles.forEach(r => {
    statusCounts[r.status] = (statusCounts[r.status]||0) + 1;
    if (priorityCounts[r.priority] !== undefined) priorityCounts[r.priority]++;

    if (r.salBest) totalBest += +r.salBest;
    if (r.salWorst) totalWorst += +r.salWorst;

    const dept = r.dept || 'Other';
    if (!deptData[dept]) deptData[dept] = {best:0,worst:0,count:0};
    deptData[dept].best += +r.salBest||0;
    deptData[dept].worst += +r.salWorst||0;
    deptData[dept].count++;

    if (r.confirmed) confirmed++;

    const sd=parseD(r.start), ed=parseD(r.end);
    if (sd && ed) { totalDur += daysBetween(sd,ed); durCount++; }
    urgCounts[getUrgency(r)]++;
  });

  const avgMonths = durCount ? Math.round(totalDur/durCount/30.4) : null;
  const fillRate = Math.round((statusCounts.filled||0)/total*100);
  const confirmPct = Math.round(confirmed/total*100);

  const kpis = [
    {lbl:'Total Roles', val:total, sub:'in pipeline', acc:'var(--accent)'},
    {lbl:'Active / Approved', val:(statusCounts.active||0)+(statusCounts.approved||0), sub:'ready to hire', acc:`${C.active}`},
    {lbl:'Filled', val:statusCounts.filled||0, sub:`${fillRate}% fill rate`, acc:`${C.filled}`},
    {lbl:'Best-Case Budget', val:fmtMoney(totalBest), sub:'combined annual', acc:`${C.low}`},
    {lbl:'Worst-Case Budget', val:fmtMoney(totalWorst), sub:'combined annual', acc:`${C.critical}`},
  ];

  let html = `<div class="dash-kpi-row">${kpis.map(k=>`
    <div class="dash-kpi" style="--kpi-accent:${k.acc}">
      <div class="dash-kpi-lbl">${k.lbl}</div>
      <div class="dash-kpi-val">${k.val}</div>
      <div class="dash-kpi-sub">${k.sub}</div>
    </div>`).join('')}</div>`;

  const STATUS_ORDER = ['active','approved','pending','onhold','filled','cancelled'];
  const STATUS_LABELS = {active:'Active',approved:'Approved',pending:'Pending',onhold:'On Hold',filled:'Filled',cancelled:'Cancelled'};
  const maxStat = Math.max(1, ...STATUS_ORDER.map(s => statusCounts[s]||0));

  const statusBars = STATUS_ORDER.map(s => {
    const cnt = statusCounts[s]||0;
    const pct = Math.round(cnt/maxStat*100);
    return `<div class="stat-bar-row">
      <div class="stat-bar-label">${STATUS_LABELS[s]}</div>
      <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${pct}%;background:${C[s]};"></div></div>
      <div class="stat-bar-count">${cnt}</div>
    </div>`;
  }).join('');

  const PRI_ORDER = ['critical','high','medium','low'];
  const PRI_LABELS = {critical:'Critical',high:'High',medium:'Medium',low:'Low'};
  let angle = 0, conicParts = '';
  PRI_ORDER.forEach(p => {
    const pct = priorityCounts[p]/total;
    const end = angle + pct*360;
    if (pct>0) conicParts += `${C[p]} ${angle.toFixed(1)}deg ${end.toFixed(1)}deg,`;
    angle = end;
  });
  conicParts = conicParts.slice(0,-1) || `var(--border) 0deg 360deg`;

  const priLegend = PRI_ORDER.map(p=>`<div class="donut-leg-row">
    <div class="donut-leg-swatch" style="background:${C[p]}"></div>
    <div class="donut-leg-lbl">${PRI_LABELS[p]}</div>
    <div class="donut-leg-val">${priorityCounts[p]}</div>
  </div>`).join('');

  html += `<div class="dash-grid-2">
    <div class="dash-panel">
      <div class="dash-panel-hdr">Roles by Status</div>
      <div class="dash-panel-body">${statusBars}</div>
    </div>
    <div class="dash-panel">
      <div class="dash-panel-hdr">Priority Breakdown</div>
      <div class="dash-panel-body">
        <div class="donut-wrap">
          <div class="donut-chart" style="background:conic-gradient(${conicParts})">
            <div class="donut-hole">
              <div class="donut-hole-val">${total}</div>
              <div class="donut-hole-lbl">Roles</div>
            </div>
          </div>
          <div class="donut-legend">${priLegend}</div>
        </div>
      </div>
    </div>
  </div>`;

  el.innerHTML = html;
}
function rebuildClients() {
  clients = [...new Set(
    roles
      .map(r => (r.client || '').trim())
      .filter(Boolean)
  )].sort((a,b) => a.localeCompare(b));
}

function renderClientOptions() {
  const dl = document.getElementById('client-options');
  if (!dl) return;
  dl.innerHTML = clients.map(c => `<option value="${esc(c)}"></option>`).join('');
}
/* ===========================
  17) RENDER ALL + STARTUP
=========================== */

function renderAll() {
  renderList();
  renderSummary();
  renderGantt();
  if (currentTab === 'dashboard') renderDashboard();
  updateThemeToggle();
}

(async () => {
  const ok = await loadRolesFromSupabase();
  if (!ok) setStatus('warn');
  renderAll();
})();

/* ===========================
  18) Expose functions for onclick=""
=========================== */

window.toggleTheme = toggleTheme;
window.switchTab = switchTab;
window.exportCSV = exportCSV;
window.clearSave = clearSave;

window.addRole = addRole;
window.deleteRole = deleteRole;
window.toggleConfirmed = toggleConfirmed;

window.openDrawer = openDrawer;
window.closeDrawer = closeDrawer;
window.saveEdit = saveEdit;

window.filterList = filterList;

window.showTip = showTip;
window.hideTip = hideTip;

window.copyRole = copyRole;