/* =========================================================
  Recruitment Planner — Supabase-backed (NO AUTH / PUBLIC)
  - No login
  - Uses publishable/anon key directly
========================================================= */

(function () {
  // ✅ If app.js is accidentally included twice, do NOT redeclare anything
  if (window.__RP_APP__) {
    // Re-expose functions in case this load happens after DOM (harmless)
    Object.assign(window, window.__RP_APP__);
    console.warn("Recruitment Planner already loaded — skipping duplicate init");
    return;
  }

  /* ===========================
    1) SUPABASE CONFIG ✅ EDIT
  =========================== */

  const SUPABASE_URL = "https://yxlvfockhdevksurayma.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_rT5fXqsS8Fz_spSQRU9epQ_DZ1_p7ZR";

  if (!window.supabase || !window.supabase.createClient) {
    console.error("Supabase library not loaded. Check index.html includes the supabase-js <script> BEFORE app.js.");
  }

  // ✅ Create Supabase client once. Disable session storage to avoid Tracking Prevention issues.
  const supabase =
    window.__RP_SUPABASE__ ||
    (window.__RP_SUPABASE__ = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    }));

  /* ===========================
    2) UI HELPERS (TOAST/LOADING)
  =========================== */

  const UI = {
    loadingCount: 0,

    setGlobalLoading(isLoading) {
      const el = document.getElementById("globalLoading");
      if (!el) return;

      if (isLoading) {
        UI.loadingCount++;
        el.classList.remove("hidden");
      } else {
        UI.loadingCount = Math.max(0, UI.loadingCount - 1);
        if (UI.loadingCount === 0) el.classList.add("hidden");
      }
    },

    toast(type, title, message, ms = 3200) {
      const container = document.getElementById("toastContainer");
      if (!container) return;

      const toast = document.createElement("div");
      toast.className = `toast toast--${type}`;

      toast.innerHTML = `
        <div>
          <p class="toast__title">${escapeHtml(title)}</p>
          ${message ? `<p class="toast__msg">${escapeHtml(message)}</p>` : ""}
        </div>
        <button class="toast__close" aria-label="Close">×</button>
      `;

      toast.querySelector(".toast__close").onclick = () => toast.remove();
      container.appendChild(toast);

      if (ms > 0) setTimeout(() => toast.remove(), ms);
    },

    success(title, message) { UI.toast("success", title, message); },
    error(title, message) { UI.toast("error", title, message, 5500); },
    info(title, message) { UI.toast("info", title, message); },
  };

  function escapeHtml(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
  const esc = escapeHtml;

  /* ===========================
    2.5) GLOBAL ERROR HANDLERS
  =========================== */
  window.addEventListener("unhandledrejection", (event) => {
    UI.error("Unexpected error", event.reason?.message || String(event.reason));
  });
  window.addEventListener("error", (event) => {
    UI.error("Unexpected error", event.message || "Something went wrong");
  });

  /* ===========================
    3) SUPABASE WRAPPER
  =========================== */

  async function sbCall(actionName, fn, { showSuccess = false, successMsg = "Done" } = {}) {
    UI.setGlobalLoading(true);
    try {
      const result = await fn();
      if (result?.error) {
        const msg = result.error.message || "Unknown error";
        UI.error(`${actionName} failed`, msg);
        throw result.error;
      }
      if (showSuccess) UI.success(actionName, successMsg);
      return result?.data ?? result;
    } catch (err) {
      const msg = err?.message || String(err);
      UI.error(`${actionName} failed`, msg);
      throw err;
    } finally {
      UI.setGlobalLoading(false);
    }
  }

  /* ===========================
    4) UTILITIES / CONSTANTS
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

  /* ===========================
    5) GLOBAL STATE
  =========================== */

  let roles = [];
  let clients = [];
  let dragSrc = null;
  let editingId = null;
  let currentTab = 'pipeline';
  let activeClientFilter = '';

  /* ===========================
    6) STATUS INDICATOR
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
    7) FILTERING (CLIENT CHIP)
  =========================== */

  function setClientFilter(client) {
    activeClientFilter = client || '';
    renderAll();
  }

  function getFilteredRoles() {
    return activeClientFilter
      ? roles.filter(r => (r.client || '') === activeClientFilter)
      : roles;
  }

  function renderClientChip() {
    const chip = document.getElementById('client-filter-chip');
    if (!chip) return;

    if (!activeClientFilter) {
      chip.classList.add('hidden');
      chip.innerHTML = '';
      return;
    }

    chip.classList.remove('hidden');
    chip.innerHTML = `Client: ${esc(activeClientFilter)} <span onclick="setClientFilter('')">✕</span>`;
  }

  /* ===========================
    8) URGENCY + COLORS
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
    9) SUPABASE DATA MAPPING
  =========================== */

  function mapDbToRole(row) {
    return {
      id: row.id,
      name: row.name,
      dept: row.dept,
      client: row.client || '',
      priority: row.priority,
      status: row.status,
      start: row.start_date ? String(row.start_date) : '',
      end: row.end_date ? String(row.end_date) : '',
      confirmed: !!row.confirmed,
      salBest: row.sal_best ?? '',
      salWorst: row.sal_worst ?? '',
      edited: !!row.edited,
      sort_order: row.sort_order ?? 0
    };
  }

  function mapRoleToDb(r) {
    return {
      name: r.name,
      dept: r.dept,
      client: r.client || null,
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
    10) SUPABASE CRUD
  =========================== */

  async function loadRolesFromSupabase() {
    setStatus('loading');
    try {
      const data = await sbCall("Load roles", () =>
        supabase
          .from('roles')
          .select('*')
          .order('sort_order', { ascending: true })
          .order('id', { ascending: true })
      );

      roles = (data || []).map(mapDbToRole);
      setStatus('idle');
      return true;
    } catch (err) {
      console.error("Load failed:", err);
      setStatus('error');
      return false;
    }
  }

  async function insertRoleToSupabase(role, sortOrder) {
    setStatus('saving');

    const payload = { ...mapRoleToDb(role), sort_order: sortOrder };

    try {
      const data = await sbCall("Create role", () =>
        supabase
          .from('roles')
          .insert(payload)
          .select('*')
          .single(),
        { showSuccess: true, successMsg: "Role created" }
      );

      setStatus('saved');
      return mapDbToRole(data);
    } catch (err) {
      console.error("Insert failed:", err);
      setStatus('error');
      return null;
    }
  }

  async function updateRoleInSupabase(id, patch) {
    setStatus('saving');
    try {
      await sbCall("Update role", () =>
        supabase
          .from('roles')
          .update(patch)
          .eq('id', id),
        { showSuccess: true, successMsg: "Saved" }
      );

      setStatus('saved');
      return true;
    } catch (err) {
      console.error("Update failed:", err);
      setStatus('error');
      return false;
    }
  }

  async function deleteRoleFromSupabase(id) {
    setStatus('saving');
    try {
      await sbCall("Delete role", () =>
        supabase
          .from('roles')
          .delete()
          .eq('id', id),
        { showSuccess: true, successMsg: "Deleted" }
      );

      setStatus('saved');
      return true;
    } catch (err) {
      console.error("Delete failed:", err);
      setStatus('error');
      return false;
    }
  }

  async function persistSortOrder() {
    setStatus('saving');
    try {
      await Promise.all(
        roles.map((r, idx) =>
          sbCall("Update sort order", () =>
            supabase.from('roles').update({ sort_order: idx }).eq('id', r.id)
          )
        )
      );

      setStatus('saved');
      return true;
    } catch (err) {
      console.error("Sort persist failed:", err);
      setStatus('error');
      return false;
    }
  }

  /* ===========================
    11) CLIENT LIST (DATALIST)
  =========================== */

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
    12) COPY ROLE
  =========================== */

  async function copyRole(id, e) {
    if (e) e.stopPropagation();
    const original = roles.find(r => r.id === id);
    if (!original) return;

    const duplicate = {
      name: original.name + ' (Copy)',
      dept: original.dept,
      client: original.client || '',
      priority: original.priority,
      status: original.status,
      start: original.start,
      end: original.end,
      confirmed: false,
      salBest: original.salBest,
      salWorst: original.salWorst,
      edited: false
    };

    const inserted = await insertRoleToSupabase(duplicate, roles.length);
    if (!inserted) return;

    const idx = roles.findIndex(r => r.id === id);
    roles.splice(idx + 1, 0, inserted);

    renderAll();
    await persistSortOrder();
  }

  /* ===========================
    13) RENDER LIST (minimal stub)
    NOTE: Keep your existing renderList/renderSummary/renderGantt if you already have them.
    If you DON'T, the app will load but show nothing.
  =========================== */

  // ✅ If your current file already has renderList/renderSummary/renderGantt, keep them.
  // If you want me to include the full render code too, say so and paste your current render sections.

  function renderList(){ /* keep your existing */ }
  function renderSummary(){ /* keep your existing */ }
  function renderGantt(){ /* keep your existing */ }
  function renderDashboard(){ /* keep your existing */ }
  function updateThemeToggle(){ /* keep your existing */ }

  /* ===========================
    20) RENDER ALL + STARTUP
  =========================== */

  function renderAll() {
    rebuildClients();
    renderClientOptions();
    renderClientChip();

    renderList();
    renderSummary();
    renderGantt();
    if (currentTab === 'dashboard') renderDashboard();
    updateThemeToggle();
  }

  (async () => {
    const fStartEl = document.getElementById('f-start');
    const fEndEl = document.getElementById('f-end');
    if (fStartEl) fStartEl.value = fmtDate(TODAY);
    if (fEndEl) fEndEl.value = fmtDate(addMonths(TODAY, 6));

    const ok = await loadRolesFromSupabase();
    if (!ok) setStatus('warn');
    renderAll();
  })();

  /* ===========================
    24) EXPOSE FUNCTIONS FOR onclick=""
  =========================== */

  function toggleTheme(){ /* keep your existing */ }
  function switchTab(tab){ currentTab = tab; renderAll(); }
  function exportCSV(){ /* keep your existing */ }
  async function clearSave(){ /* keep your existing */ }

  async function addRole(){ /* keep your existing */ }
  async function deleteRole(id, e){ /* keep your existing */ }
  async function toggleConfirmed(id, val){ /* keep your existing */ }

  function openDrawer(id, e){ /* keep your existing */ }
  function closeDrawer(){ /* keep your existing */ }
  async function saveEdit(){ /* keep your existing */ }
  function filterList(){ /* keep your existing */ }
  function showTip(e, i){ /* keep your existing */ }
  function hideTip(){ /* keep your existing */ }

  // Build export object for globals
  window.__RP_APP__ = {
    toggleTheme,
    switchTab,
    exportCSV,
    clearSave,
    addRole,
    deleteRole,
    toggleConfirmed,
    openDrawer,
    closeDrawer,
    saveEdit,
    filterList,
    showTip,
    hideTip,
    copyRole,
    setClientFilter,
  };

  Object.assign(window, window.__RP_APP__);
})();