/* ===== WorkBuddy 个人工作台 · 固定账号版 ===== */
const $ = (s) => document.querySelector(s);

/* 超时工具：给任意 Promise 加 ms 上限，避免冷启动时请求无限挂起 */
function withTimeout(p, ms, label) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error((label || "请求") + " 超时 " + ms + "ms")), ms);
    p.then((v) => { clearTimeout(id); resolve(v); }, (e) => { clearTimeout(id); reject(e); });
  });
}

/* ---------- 后端配置（Supabase REST API 直连，不依赖 supabase-js 库） ----------
   去掉 CDN 加载 supabase-js 的整套逻辑，直接用 fetch 调 PostgREST 接口。
   数据直读直写后端，不再有 localStorage 缓存 / 双写同步 / realtime 订阅。 */
const SUPABASE_URL = "https://dpvngdnbzadshfjudwae.supabase.co";
const API_KEY = "sb_publishable_2fUmpkPt-ah1qjDqBRB1GQ_W8KXUaJn";
const REST_BASE = SUPABASE_URL + "/rest/v1";
const TABLE = "workbench_data";
const API_HEADERS = {
  "apikey": API_KEY,
  "Authorization": "Bearer " + API_KEY,
  "Content-Type": "application/json",
};

/* 预热工作区 Supabase：免费库冷启动首请求会卡 20~30s，
   保存/加载前先轻量 ping 把它唤醒，失败则重试等待，避免数据存不上。 */
async function warmupWorkspaceDB(attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await withTimeout(
        fetch(`${REST_BASE}/${TABLE}?user_id=eq.${userId || "jimilo"}&select=updated_at&limit=1`, { headers: API_HEADERS, cache: "no-store" }),
        12000, "唤醒后端"
      );
      return true; // 已连通
    } catch (e) {
      if (i < attempts) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false; // 尽力了仍不通，交给后续请求的正常错误处理
}

/* 直接从后端读取整条记录 */
async function fetchState() {
  // 每次请求都强制 no-store，从后端取最新，杜绝浏览器缓存导致“不同浏览器不一样”
  const url = `${REST_BASE}/${TABLE}?user_id=eq.${userId}&limit=1`;
  const res = await withTimeout(fetch(url, { headers: API_HEADERS, cache: "no-store" }), 20000, "读取后端");
  if (!res.ok) throw new Error("fetch " + res.status);
  const arr = await res.json();
  return arr && arr[0] ? arr[0] : null;
}

/* 直接写入后端（upsert：有则更新，无则插入） */
let notesHistoryColReady = true; // notes_history 列就绪标志；列未建好时降级跳过，防整行 400
let sharingColReady = true; // sharing 列就绪标志；列未建好时降级跳过，防整行 400

/* 根治·只传变更字段：记录上次成功保存到云端的字段快照，保存时只把"与快照不同"的字段上送，
   未变更的字段不传（merge-duplicates 下不传=不动），从源头杜绝"前端某字段意外为空→整列被覆盖成空"。
   lastSavedState 为 null 时（首次/未知）全传，等价于原行为。 */
let lastSavedState = null;
function _wbClone(v){ try { return JSON.parse(JSON.stringify(v)); } catch(e){ return v; } }
function _wbFieldChanged(stKey, col){
  if (lastSavedState === null) return true;
  const a = lastSavedState[stKey], b = state[stKey];
  if (a === b) return false;
  try { return JSON.stringify(a) !== JSON.stringify(b); } catch(e){ return true; }
}
function _wbSyncSnapshot(){
  lastSavedState = {
    name: state.name, todos: _wbClone(state.todos), links: _wbClone(state.links),
    notes: state.notes, theme: state.theme, stickyNotes: _wbClone(state.stickyNotes),
    calendarMarks: _wbClone(state.calendarMarks), ghArrival: state.ghArrival,
    homeModules: _wbClone(state.homeModules), notesHistory: _wbClone(state.notesHistory),
    sharing: _wbClone(state.sharing),
  };
}

async function saveState() {
  if (!dataConfirmed) {
    // 数据未从后端成功加载，禁止用可能的空状态覆盖云端，避免误清空
    console.warn("[workbench] 数据未从后端确认，跳过本次保存以防误清空");
    setStatus("保存跳过 · 数据未加载", "warn");
    return;
  }
  /* 冷启动兜底：保存前先预热后端，避免免费库休眠时请求超时导致数据没存上 */
  setStatus("保存中… 唤醒后端", "syncing");
  await warmupWorkspaceDB();
  /* 乐观并发锁：写入前先核对云端更新时间。
     若云端已有比本地"载入时刻"更新的数据，说明云端被别的端更新过（或旧实例刚清空过），
     此时放弃本次保存以免用过期/空本地数据覆盖云端，并提示先刷新。这是防误清空的最后一道闸。 */
  try {
    const chk = await withTimeout(fetch(`${REST_BASE}/${TABLE}?user_id=eq.${userId}&select=updated_at&limit=1`, { headers: API_HEADERS, cache: "no-store" }), 15000, "核对云端");
    if (chk.ok) {
      const carr = await chk.json();
      if (carr && carr[0]) {
        const cloudT = new Date(carr[0].updated_at).getTime();
        const localT = new Date(state.updated_at || 0).getTime();
        if (cloudT > localT) {
          console.warn("[workbench] 云端数据较新，放弃保存以免覆盖，请先刷新");
          setStatus("保存跳过 · 云端有更新，请刷新", "warn");
          return;
        }
      }
    }
  } catch (e) { /* 核对失败不阻断，交给下方正式写入的错误处理 */ }
  /* 防误清空·基线保护（前端兜底）：若三个核心字段同时为空——典型是逻辑异常导致 state 被 default 覆盖——
     而载入基线中本来有内容，则回退到基线值，绝不向云端提交空数据。真正的"旧链接清不掉"靠后端触发器。 */
  try {
    const base = window.__loadBase;
    if (base) {
      const nowEmpty = (!state.todos || !state.todos.length) && (!state.stickyNotes || !state.stickyNotes.length) && (!state.notes || !state.notes.trim());
      const baseHas = (base.todos && base.todos.length) || (base.stickyNotes && base.stickyNotes.length) || (base.notes && base.notes.trim());
      if (nowEmpty && baseHas) {
        console.warn("[workbench] 检测到三核心字段同时为空（异常），回退到载入基线，不提交空数据");
        setStatus("保存拦截 · 异常空数据已拦截", "warn");
        state.todos = base.todos || [];
        state.stickyNotes = base.stickyNotes || [];
        state.notes = base.notes || "";
      }
      /* 日历数据防误清空（与三核心同等级保护）：载入基线有日历、但当前内存为空（异常或被旧实例清空过），
         则回退到基线，绝不向云端提交空日历。 */
      const calEmpty = !state.calendarMarks || typeof state.calendarMarks !== "object" || !Object.keys(state.calendarMarks).length;
      const baseCal = base.calendarMarks && typeof base.calendarMarks === "object" && Object.keys(base.calendarMarks).length;
      if (calEmpty && baseCal) {
        console.warn("[workbench] 检测到日历数据异常为空，回退到载入基线，不提交空日历");
        setStatus("保存拦截 · 日历空数据已拦截", "warn");
        state.calendarMarks = base.calendarMarks;
      }
    }
  } catch (e2) {}
  state.updated_at = new Date().toISOString();
  const buildBody = (withHist, withSharing, changedOnly) => {
    // 根治：只把"与上次成功保存快照不同"的字段上送；未变更字段不传，不会被误覆盖。
    const b = { user_id: userId, updated_at: state.updated_at, name: state.name };
    const map = [
      ["todos", "todos"], ["links", "links"], ["notes", "notes"], ["theme", "theme"],
      ["stickyNotes", "sticky_notes"], ["calendarMarks", "calendar_marks"],
      ["ghArrival", "gh_arrival"], ["homeModules", "homeModules"],
    ];
    for (const [stKey, col] of map) {
      if (changedOnly && !_wbFieldChanged(stKey, col)) continue;
      b[col] = state[stKey];
    }
    if (withHist && notesHistoryColReady) b.notes_history = state.notesHistory;
    if (withSharing && sharingColReady) b.sharing = state.sharing;
    return b;
  };
  let res = await withTimeout(fetch(`${REST_BASE}/${TABLE}`, {
    method: "POST",
    headers: Object.assign({}, API_HEADERS, { "Prefer": "resolution=merge-duplicates" }),
    body: JSON.stringify(buildBody(notesHistoryColReady, sharingColReady, true)),
  }), 20000, "写入后端");
  /* notes_history / sharing 列尚未创建（用户还没 Run 加列 SQL）时整行会 400；降级重试不带这些列，
     保证待办/笔记/便利贴等核心数据可正常保存，历史/共享配置暂只存本机 localStorage，加列后自动恢复。 */
  /* notes_history / sharing 列尚未创建（用户还没 Run 加列 SQL）时整行会 400；顺序降级：
     优先只丢弃「最可能缺失」的 sharing，尽量保留已存在的 notes_history；若仍失败再丢 notes_history。
     保证待办/笔记/便利贴等核心数据可正常保存，缺失列的配置暂只存本机，加列后自动恢复。 */
  /* 降级：列缺失导致 400 时，三步顺序试探，精确只丢「确实缺失」的列，尽量保留已存在的列：
     ① 去 history 留 sharing —— 成功说明只缺 history；
     ② 去 sharing 留 history —— 成功说明只缺 sharing（且不会误伤已存在的 history）；
     ③ 两者都去 —— 兜底，说明两列都缺。 */
  if (!res.ok && (notesHistoryColReady || sharingColReady)) {
    if (notesHistoryColReady) {
      res = await withTimeout(fetch(`${REST_BASE}/${TABLE}`, {
        method: "POST",
        headers: Object.assign({}, API_HEADERS, { "Prefer": "resolution=merge-duplicates" }),
        body: JSON.stringify(buildBody(false, sharingColReady, true)),
      }), 20000, "写入后端(降级·去history)");
      if (res.ok) {
        notesHistoryColReady = false;
        console.warn("[workbench] notes_history 列尚不存在，本次及之后保存暂不含历史；加列后将自动恢复");
      }
    }
    if (!res.ok && sharingColReady) {
      res = await withTimeout(fetch(`${REST_BASE}/${TABLE}`, {
        method: "POST",
        headers: Object.assign({}, API_HEADERS, { "Prefer": "resolution=merge-duplicates" }),
        body: JSON.stringify(buildBody(notesHistoryColReady, false, true)),
      }), 20000, "写入后端(降级·去sharing)");
      if (res.ok) {
        sharingColReady = false;
        console.warn("[workbench] sharing 列尚不存在，本次及之后保存暂不含共享配置；加列后将自动恢复");
      }
    }
    if (!res.ok) {
      res = await withTimeout(fetch(`${REST_BASE}/${TABLE}`, {
        method: "POST",
        headers: Object.assign({}, API_HEADERS, { "Prefer": "resolution=merge-duplicates" }),
        body: JSON.stringify(buildBody(false, false, true)),
      }), 20000, "写入后端(降级·去全部)");
      notesHistoryColReady = false; sharingColReady = false;
      console.warn("[workbench] sharing / notes_history 两列均不存在，本次保存暂不含这两部分；加列后将自动恢复");
    }
  }
  if (!res.ok) throw new Error("save " + res.status);
  _wbSyncSnapshot(); // 保存成功后记录快照，下次保存只传变更字段
  return true;
}

/* ---------- DeepSeek 代理（密钥不暴露在前端，走 Supabase Edge Function） ---------- */
const DEEPSEEK_PROXY = SUPABASE_URL + "/functions/v1/deepseek-proxy";
async function callDeepSeek(body) {
  return fetch(DEEPSEEK_PROXY, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + API_KEY,
      "apikey": API_KEY,
    },
    body: JSON.stringify(body),
  });
}

const DEFAULT_LINKS = [
  { emoji: "📧", name: "邮箱", url: "https://mail.qq.com" },
  { emoji: "📊", name: "腾讯文档", url: "https://docs.qq.com" },
  { emoji: "💬", name: "企业微信", url: "https://work.weixin.qq.com" },
  { emoji: "🐙", name: "GitHub", url: "https://github.com" },
  { emoji: "🎯", name: "TAPD", url: "https://www.tapd.cn" },
  { emoji: "🔍", name: "百度", url: "https://www.baidu.com" },
];

/* ---------- 菜单定义（与侧边栏 nav 一一对应，供权限过滤与树形勾选） ---------- */
const MENUS = [
  { id: "home", label: "首页", page: "home" },
  { id: "study", label: "学习", children: [
    { id: "study-english", label: "英语", page: "english" },
    { id: "study-crossborder", label: "跨境", page: "crossborder" },
    { id: "study-vcc", label: "VCC账户", page: "vcc" },
    { id: "study-acquiring", label: "外卡收单", page: "acquiring" },
  ]},
  { id: "ai", label: "AI", children: [
    { id: "ai-doujie", label: "豆姐", page: "doujie" },
  ]},
  { id: "work", label: "工作", children: [
    { id: "work-mobile", label: "手机端", page: "mobile" },
    { id: "work-coffee", label: "咖啡机", page: "coffee" },
    { id: "work-miaoda", label: "妙搭", page: "miaoda" },
    { id: "work-sticky", label: "便利贴", page: "sticky" },
  ]},
  { id: "system", label: "系统管理", children: [
    { id: "system-homemanage", label: "首页管理", page: "homeManage" },
  ]},
];
/* 「操作员管理」入口：仅超管可见，不参与普通用户勾选树 */
const SUPER_MENU_ID = "system-operators";

function defaultState() {
  const defName = userId === "jimilo" ? "吉米" : (userId || "吉米");
  return { name: defName, todos: [], links: DEFAULT_LINKS.slice(), notes: "", theme: "dark", stickyNotes: [], calendarMarks: {}, ghArrival: "", updated_at: "1970-01-01T00:00:00Z", notesHistory: [], homeModules: defaultHomeModules(), sharing: {} };
}

/* 首页模块注册表：新增首页模块只需在此加一项，即自动出现在「首页管理」配置中 */
const MODULE_REGISTRY = [
  { id: "hero",     label: "问候与时钟" },
  { id: "todo",     label: "每日待办" },
  { id: "links",    label: "快捷链接" },
  { id: "water",    label: "喝水提醒" },
  { id: "calendar", label: "日历" },
  { id: "fortune",  label: "每日运势" },
  { id: "focus",    label: "专注计时" },
  { id: "gh",       label: "GH时间" },
  { id: "notes",    label: "随手笔记" },
  { id: "news",     label: "新闻" },
  { id: "pet",      label: "宠物" },
];
function defaultHomeModules() {
  return MODULE_REGISTRY.map((m) => ({ id: m.id, visible: true }));
}
/* 归一化已存配置：保留自定义顺序、丢弃未知模块、补齐新增模块（后续新增可配置） */
function normalizeHomeModules(arr) {
  const saved = (Array.isArray(arr) ? arr : []).filter((m) => m && m.id && MODULE_REGISTRY.some((r) => r.id === m.id));
  const savedIds = new Set(saved.map((m) => m.id));
  const added = MODULE_REGISTRY.filter((m) => !savedIds.has(m.id)).map((m) => ({ id: m.id, visible: true, enabled: true }));
  return saved.concat(added).map((m) => ({ id: m.id, visible: m.visible !== false, enabled: m.enabled !== false, height: (typeof m.height === "number" && m.height > 0) ? Math.round(m.height) : null }));
}

/* 后端列名是下划线（sticky_notes / calendar_marks / gh_arrival），前端 state 用驼峰。
   读取后必须做反向映射，否则便利贴/日历标记/GH到岗读不出来，且一旦触发保存会被空值覆盖清空。 */
function mapRow(row) {
  if (!row || typeof row !== "object") return row;
  const r = Object.assign({}, row);
  if (Array.isArray(row.sticky_notes)) r.stickyNotes = row.sticky_notes;
  else if (Array.isArray(row.stickyNotes)) r.stickyNotes = row.stickyNotes;
  else r.stickyNotes = [];
  if (row.calendar_marks && typeof row.calendar_marks === "object") r.calendarMarks = row.calendar_marks;
  else if (row.calendarMarks && typeof row.calendarMarks === "object") r.calendarMarks = row.calendarMarks;
  else r.calendarMarks = {};
  if (row.sharing && typeof row.sharing === "object") r.sharing = row.sharing; else r.sharing = {};
  if (typeof row.gh_arrival === "string") r.ghArrival = row.gh_arrival;
  else if (typeof row.ghArrival === "string") r.ghArrival = row.ghArrival;
  else r.ghArrival = "";
  if (Array.isArray(row.notes_history)) r.notesHistory = row.notes_history; /* 列存在时后端为准（含空数组） */
  else if (Array.isArray(row.notesHistory)) r.notesHistory = row.notesHistory;
  else r.notesHistory = []; /* 列未建：PostgREST 不返回该键，回退空，由 loadData 合并本机 localStorage */
  /* 首页模块配置：读取后端数组（兼容 home_modules 命名），无则留空交给 applyState 归一 */
  if (Array.isArray(row.homeModules)) r.homeModules = row.homeModules;
  else if (Array.isArray(row.home_modules)) r.homeModules = row.home_modules;
  else r.homeModules = null;
  delete r.sticky_notes; delete r.calendar_marks; delete r.gh_arrival; delete r.notes_history;
  return r;
}

let userId = null;
let state = defaultState();
let saveTimer = null;
let editingLinks = false;
let dataConfirmed = false; // loadData 成功从后端确认过数据后才允许保存，防误清空

/* ---------- 工具 ---------- */
function setStatus(text, cls) {
  const el = $("#syncStatus");
  el.textContent = text;
  el.className = "sync-pill" + (cls ? " " + cls : "");
}
/* 防抖保存：500ms 内连续操作只写一次后端，直读直写无本地缓存 */
function scheduleSave(silent) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!silent) setStatus("保存中…", "syncing");
    try {
      await saveState();
      if (!silent) setStatus("已保存 ✓", "ok");
    } catch (e) {
      if (!silent) setStatus("保存失败 · 请检查网络", "err");
      console.warn("[workbench] 保存失败：", e);
    }
  }, 500);
}

/* 直接从后端读取整条记录，无本地缓存兜底 */
async function loadData() {
  setStatus("加载中…", "syncing");
  try {
    await warmupWorkspaceDB(); // 冷启动兜底：先把休眠的后端唤醒，避免读取超时
    const data = await fetchState();
    const incoming = mapRow(data || {});
    // 智能比对：云端 updated_at 与本地一致则数据未变，仅同步内存、跳过重渲染（不打断正在编辑的笔记/待办）
    if (dataConfirmed && state.updated_at && incoming.updated_at && incoming.updated_at === state.updated_at) {
      /* 云端日历异常为空（[]/{}）但内存中已有日历时，保留内存，避免被空覆盖 */
      if ((!incoming.calendarMarks || !Object.keys(incoming.calendarMarks).length) && state.calendarMarks && Object.keys(state.calendarMarks).length) {
        incoming.calendarMarks = state.calendarMarks;
      }
      state = Object.assign(defaultState(), incoming);
      try { window.__loadBase = { todos: state.todos || [], stickyNotes: state.stickyNotes || [], notes: state.notes || "", calendarMarks: state.calendarMarks }; } catch (e2) {}
      setStatus(data ? "已就绪 ✓" : "首次使用 · 已就绪");
      _wbSyncSnapshot();
      loadSharedSticky();
      return;
    }
    /* 云端日历异常为空（[]/{}）但内存中已有日历时，保留内存，避免被空覆盖 */
    if ((!incoming.calendarMarks || !Object.keys(incoming.calendarMarks).length) && state.calendarMarks && Object.keys(state.calendarMarks).length) {
      incoming.calendarMarks = state.calendarMarks;
    }
    state = Object.assign(defaultState(), incoming);
    dataConfirmed = true; // 读取成功（无论有无记录），后续保存才被允许
    // 记录载入基线：供 saveState 的“防误清空基线保护”使用（前端兜底）
    try { window.__loadBase = { todos: state.todos || [], stickyNotes: state.stickyNotes || [], notes: state.notes || "", calendarMarks: state.calendarMarks }; } catch (e2) {}
    _wbSyncSnapshot();
    applyState();
    /* 迁移/合并：把本机 localStorage 的历史并入内存（以后端为准、按 ts 去重），
       若有本机独占的历史则静默补传上云；列未建时静默失败、不影响使用，本机不丢。 */
    try {
      const lsHist = JSON.parse(localStorage.getItem(NOTES_HISTORY_KEY) || "[]");
      if (Array.isArray(lsHist) && lsHist.length) {
        const bd = Array.isArray(state.notesHistory) ? state.notesHistory : [];
        const seen = new Set(bd.map((x) => x && x.ts));
        const merged = bd.slice();
        for (const it of lsHist) { if (it && it.ts && !seen.has(it.ts)) { merged.push(it); seen.add(it.ts); } }
        merged.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
        while (merged.length > NOTES_MAX_HISTORY) merged.pop();
        state.notesHistory = merged;
        renderNotesHistory();
        if (merged.length > bd.length) scheduleSave(true); // 本机有未上云历史 → 静默补传
      }
    } catch (e2) {}
    setStatus(data ? "已就绪 ✓" : "首次使用 · 已就绪");
    loadSharedSticky();
  } catch (e) {
    setStatus("读取失败 · 请检查网络", "err");
    dataConfirmed = false; // 读取异常：禁止保存，避免用空白覆盖云端
    applyState();
  }
}

/* ---------- 登录（固定授权账号） ---------- */
const SESSION_KEY = "wb_logged_in";
// SHA-256 十六进制：优先 Web Crypto；无 crypto.subtle 的环境（非 HTTPS / 内嵌 WebView）自动降级纯 JS 实现
function _jsSha256Hex(ascii) {
  function rotr(v, n) { return (v >>> n) | (v << (32 - n)); }
  var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
           0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
           0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
           0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
           0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
           0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
           0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
           0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  var l = ascii.length;
  var msg = [];
  for (var i = 0; i < l; i++) msg.push(ascii.charCodeAt(i) & 0xff);
  var bitLen = l * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  var hi = Math.floor(bitLen / 0x100000000) >>> 0, lo = bitLen >>> 0;
  msg.push((hi>>>24)&0xff,(hi>>>16)&0xff,(hi>>>8)&0xff,hi&0xff);
  msg.push((lo>>>24)&0xff,(lo>>>16)&0xff,(lo>>>8)&0xff,lo&0xff);
  for (var off = 0; off < msg.length; off += 64) {
    var w = new Array(64);
    for (var j = 0; j < 16; j++) w[j] = (msg[off+4*j]<<24)|(msg[off+4*j+1]<<16)|(msg[off+4*j+2]<<8)|(msg[off+4*j+3]);
    for (var j = 16; j < 64; j++) {
      var s0 = rotr(w[j-15],7) ^ rotr(w[j-15],18) ^ (w[j-15]>>>3);
      var s1 = rotr(w[j-2],17) ^ rotr(w[j-2],19) ^ (w[j-2]>>>10);
      w[j] = (w[j-16] + s0 + w[j-7] + s1) | 0;
    }
    var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
    for (var j = 0; j < 64; j++) {
      var S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
      var ch = (e & f) ^ (~e & g);
      var t1 = (h + S1 + ch + K[j] + w[j]) | 0;
      var S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) | 0;
      h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
    }
    H[0]=(H[0]+a)|0; H[1]=(H[1]+b)|0; H[2]=(H[2]+c)|0; H[3]=(H[3]+d)|0;
    H[4]=(H[4]+e)|0; H[5]=(H[5]+f)|0; H[6]=(H[6]+g)|0; H[7]=(H[7]+h)|0;
  }
  var out = "";
  for (var i = 0; i < 8; i++) out += ("00000000" + (H[i]>>>0).toString(16)).slice(-8);
  return out;
}
async function sha256Hex(str) {
  if (window.crypto && window.crypto.subtle) {
    const buf = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return _jsSha256Hex(str);
}
function setMsg(t) { $("#setupMsg").textContent = t; }

/* ---------- 登录（users 表查库验证） ---------- */
let _homePollId = null;
function startHomePolling() {
  stopHomePolling();
  _homePollId = setInterval(() => { if (userId) loadData(); }, 30000); // 每30秒兜底拉取，数据未变则跳过重渲染
}
function stopHomePolling() {
  if (_homePollId) { clearInterval(_homePollId); _homePollId = null; }
}

/* 按用户名查 users 表 */
async function fetchUserByUsername(username) {
  const url = `${REST_BASE}/users?username=eq.${encodeURIComponent(username)}&limit=1`;
  const res = await withTimeout(fetch(url, { headers: API_HEADERS, cache: "no-store" }), 20000, "读取账号");
  if (!res.ok) throw new Error("fetch user " + res.status);
  const arr = await res.json();
  return arr && arr[0] ? arr[0] : null;
}

/* 登录成功：异步记录登录时间/IP（不阻塞进入） */
async function recordLogin(user) {
  let ip = "unknown";
  try {
    const r = await withTimeout(fetch("https://api.ipify.org?format=json", { cache: "no-store" }), 8000, "获取IP");
    const d = await r.json();
    if (d && d.ip) ip = d.ip;
  } catch (e) {}
  try {
    await withTimeout(fetch(`${REST_BASE}/users?username=eq.${encodeURIComponent(user.username)}`, {
      method: "PATCH",
      headers: Object.assign({}, API_HEADERS, { "Prefer": "return=minimal" }),
      body: JSON.stringify({ last_login_time: new Date().toISOString(), last_login_ip: ip, last_active_time: new Date().toISOString() }),
    }), 10000, "记录登录");
  } catch (e) {}
}

/* ---------- 心跳：定期上报活跃时间，支撑超管页在线/离线判定（5 分钟超时） ---------- */
let heartbeatId = null;
function startHeartbeat() {
  stopHeartbeat();
  reportHeartbeat();
  heartbeatId = setInterval(reportHeartbeat, 90 * 1000); // 1.5 分钟上报一次
}
function stopHeartbeat() {
  if (heartbeatId) { clearInterval(heartbeatId); heartbeatId = null; }
}
async function reportHeartbeat() {
  if (!userId) return;
  try {
    await withTimeout(fetch(`${REST_BASE}/users?username=eq.${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: Object.assign({}, API_HEADERS, { "Prefer": "return=minimal" }),
      body: JSON.stringify({ last_active_time: new Date().toISOString() }),
    }), 10000, "心跳");
  } catch (e) { /* 心跳失败静默，不打断使用 */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopHeartbeat();
  else { if (userId) { reportHeartbeat(); startHeartbeat(); } }
});

/* ---------- 菜单权限：is_super=全量；未配置=全量；已配置按 user_menu 过滤 ---------- */
let currentUser = null;   // users 表当前登录用户行
let myMenuIds = null;     // null=未配置/超管（全量）；数组=已配置的可见 menu_id 列表

async function refreshMenuPermission() {
  myMenuIds = null;
  if (!currentUser || currentUser.is_super) return;
  try {
    const url = `${REST_BASE}/user_menu?user_id=eq.${encodeURIComponent(userId)}&select=menu_id`;
    const res = await withTimeout(fetch(url, { headers: API_HEADERS, cache: "no-store" }), 20000, "读取菜单权限");
    if (!res.ok) return;
    const arr = await res.json();
    if (Array.isArray(arr)) myMenuIds = arr.map((r) => r.menu_id);
    /* 空数组（配置过但全不选）≠ null（从未配置）：空数组照常过滤 → 全部隐藏 */
  } catch (e) { myMenuIds = null; } /* 权限拉取失败按全量处理，不阻塞使用 */
}
function hasMenu(id) {
  if (!currentUser || currentUser.is_super) return true;
  if (!myMenuIds) return true; // 未配置 = 全量可见
  return myMenuIds.indexOf(id) !== -1;
}
/* 按权限渲染侧边栏：隐藏无权限叶子；无可见子项的分组整体隐藏；当前页被隐藏则跳回首页 */
function applyMenuPermission() {
  document.querySelectorAll(".nav-item[data-menu-id]").forEach((el) => {
    el.style.display = hasMenu(el.dataset.menuId) ? "" : "none";
  });
  document.querySelectorAll(".nav-parent[data-menu-id]").forEach((btn) => {
    const sub = document.getElementById("sub" + btn.dataset.toggle);
    let visible = hasMenu(btn.dataset.menuId);
    if (sub) {
      const kids = Array.from(sub.querySelectorAll(".nav-child"));
      visible = kids.some((c) => c.style.display !== "none");
    }
    btn.style.display = visible ? "" : "none";
  });
  /* 超管专属入口：仅 is_super 显示 */
  const opBtn = document.querySelector('[data-menu-id="system-operators"]');
  if (opBtn) opBtn.style.display = (currentUser && currentUser.is_super) ? "" : "none";
  const mpBtn = document.querySelector('[data-menu-id="system-moduleperm"]');
  if (mpBtn) mpBtn.style.display = (currentUser && currentUser.is_super) ? "" : "none";
  /* 当前激活页被隐藏 → 切回首页 */
  const active = document.querySelector(".nav-item.active");
  if (active && active.style.display === "none") switchPage("home");
}

async function enterWorkbench(user) {
  userId = user.username;
  currentUser = user;
  window.__wbIsSuper = !!(user && user.is_super);
  localStorage.setItem(SESSION_KEY, user.username);
  $("#setupModal").classList.add("hidden");
  setMsg("");
  recordLogin(user);               // 异步记录登录时间/IP
  await refreshMenuPermission();   // 拉取菜单权限
  applyMenuPermission();
  loadData();
  loadPet();
  startHomePolling();
  startHeartbeat();
}

async function handleLogin() {
  const acc = $("#setupAccount").value.trim();
  const pass = $("#setupPass").value;
  if (!acc || !pass) { setMsg("请输入账号和密码"); return; }
  let passHash;
  try { passHash = await sha256Hex(pass); }
  catch (e) { setMsg("校验失败，请重试"); return; }
  let user;
  try { user = await fetchUserByUsername(acc); }
  catch (e) { setMsg("无法连接后端，请稍后重试"); return; }
  if (!user || user.password_hash !== passHash) { setMsg("账号或密码错误"); return; }
  if (user.status && user.status !== "active") { setMsg("账号已停用，请联系管理员"); return; }
  await enterWorkbench(user);
}

function exitSpace() {
  userId = null; currentUser = null; myMenuIds = null;
  window.__wbIsSuper = false;
  state = defaultState();
  stopHomePolling();
  stopHeartbeat();
  localStorage.removeItem(SESSION_KEY);
  $("#setupModal").classList.remove("hidden");
  $("#setupAccount").value = ""; $("#setupPass").value = "";
  setMsg(""); setStatus("未登录", "");
}

/* ---------- 应用状态到界面 ---------- */
function applyState() {
  document.documentElement.setAttribute("data-theme", state.theme || "dark");
  _pnSyncTheme();
  $("#notes").value = state.notes || "";
  lastArchivedNotes = (state.notes || "").toString();
  renderNotesHistory();
  renderTodos();
  renderLinks();
  renderStickyBoard();
  marksData = state.calendarMarks || {};
  renderCalendar();
  if (state.ghArrival) { const g = $("#ghArrival"); if (g) { g.value = state.ghArrival; computeGH(); } }
  updateGreeting();
  // 首页模块显隐 + 顺序（可配置）
  state.homeModules = normalizeHomeModules(state.homeModules);
  applyHomeLayout();
  ensurePaynewsMounted(); // 新闻模块：原生嵌入 paynews 应用（非 iframe）
  renderHomeManage();
}
function updateGreeting() {
  const now = new Date();
  const h = now.getHours();
  const greet = h < 6 ? "凌晨好" : h < 11 ? "早上好" : h < 13 ? "中午好" : h < 18 ? "下午好" : "晚上好";
  const who = state.name && state.name !== "吉米" ? state.name : (state.name || "朋友");
  $("#greeting").textContent = `${greet}，${who} 👋`;
}

/* ---------- 统一心跳（合并所有每秒定时器，切到后台自动暂停省内存/省电） ---------- */
const tickHandlers = [];
let tickerId = null, tickCount = 0;
function onTick(fn, everySec) { tickHandlers.push({ fn, every: everySec || 1 }); }
function runTick() {
  tickCount++;
  for (const h of tickHandlers) {
    if (tickCount % h.every === 0) { try { h.fn(); } catch (e) {} }
  }
}
function startTicker() { if (!tickerId) tickerId = setInterval(runTick, 1000); }
function stopTicker() { if (tickerId) { clearInterval(tickerId); tickerId = null; } }
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopTicker();
  else { runTick(); startTicker(); }   // 回到前台立刻补一次，界面不会停在旧时间
});

/* ---------- 时钟 + 日期 ---------- */
const WEEK = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
function tick() {
  const now = new Date();
  $("#clock").innerHTML =
    `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:<span class="sec">${String(now.getSeconds()).padStart(2, "0")}</span>`;
  $("#heroDate").textContent = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${WEEK[now.getDay()]}`;
  if (state.name) updateGreeting();
}
tick();
onTick(tick);
startTicker();

/* ---------- 天气 ---------- */
const WMO = {
  0: "☀️", 1: "🌤️", 2: "⛅", 3: "☁️",
  45: "🌫️", 48: "🌫️", 51: "🌦️", 53: "🌦️",
  55: "🌧️", 61: "🌧️", 63: "🌧️", 65: "⛈️",
  71: "🌨️", 73: "🌨️", 75: "❄️", 80: "🌦️",
  81: "🌧️", 82: "⛈️", 95: "⛈️", 96: "⛈️", 99: "⛈️",
};
const WMO_TXT = {
  0: "晴", 1: "晴间多云", 2: "多云", 3: "阴",
  45: "雾", 48: "雾凇", 51: "毛毛雨", 53: "小雨",
  55: "中雨", 61: "小雨", 63: "中雨", 65: "大雨",
  71: "小雪", 73: "中雪", 75: "大雪", 80: "阵雨",
  81: "阵雨", 82: "强阵雨", 95: "雷阵雨", 96: "雷阵雨", 99: "雷阵雨",
};
let weatherData = null;
function loadWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&current=temperature_2m,weather_code`
    + `&hourly=temperature_2m,weather_code`
    + `&daily=weather_code,temperature_2m_max,temperature_2m_min`
    + `&timezone=auto&forecast_days=7`;
  fetch(url).then((r) => r.json()).then((d) => {
    weatherData = d;
    const t = Math.round(d.current.temperature_2m);
    const code = d.current.weather_code;
    $("#weather").innerHTML =
      `${WMO[code] || "🌡️"} ${t}°C <span class="weather-hint">▾</span>`;
    $("#weather").title = `${WMO_TXT[code] || "天气"} ${t}°C · 悬浮查看详情`;
  }).catch(() => { $("#weather").textContent = "🌤️ 天气暂不可用"; });
}

/* 悬浮弹出：今日逐小时 + 未来 7 天 */
const WK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
function buildWeatherPop() {
  if (!weatherData) return;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const curHour = now.getHours();

  const hT = weatherData.hourly.time, hTmp = weatherData.hourly.temperature_2m, hCode = weatherData.hourly.weather_code;
  const hourly = [];
  for (let i = 0; i < hT.length; i++) {
    if (!hT[i].startsWith(todayKey)) continue;
    const hr = Number(hT[i].slice(11, 13));
    if (hr < curHour) continue;
    hourly.push(`<div class="wx-hour"><span class="wx-h">${hr}:00</span><span class="wx-ico">${WMO[hCode[i]] || "🌡️"}</span><span class="wx-t">${Math.round(hTmp[i])}°</span></div>`);
  }
  const dT = weatherData.daily.time, dCode = weatherData.daily.weather_code,
    dMax = weatherData.daily.temperature_2m_max, dMin = weatherData.daily.temperature_2m_min;
  const daily = [];
  for (let i = 0; i < dT.length; i++) {
    const dt = new Date(dT[i] + "T00:00");
    const label = i === 0 ? "今天" : i === 1 ? "明天" : WK[dt.getDay()];
    daily.push(`<div class="wx-day"><span class="wx-d">${label}</span><span class="wx-ico">${WMO[dCode[i]] || "🌡️"}</span><span class="wx-range"><span class="wx-lo">${Math.round(dMin[i])}°</span> ~ <span class="wx-hi">${Math.round(dMax[i])}°</span></span></div>`);
  }
  $("#weatherPop").innerHTML =
    `<div class="wx-sec-title">今日逐小时</div><div class="wx-hourly">${hourly.join("")}</div>` +
    `<div class="wx-sec-title">未来 7 天</div><div class="wx-daily">${daily.join("")}</div>`;
}
let wxPinned = false;
function showWx() { if (!weatherData) return; buildWeatherPop(); $("#weatherPop").classList.add("show"); }
function hideWx() { if (!wxPinned) $("#weatherPop").classList.remove("show"); }
const wxWrap = $(".weather-wrap");
wxWrap.addEventListener("mouseenter", showWx);
wxWrap.addEventListener("mouseleave", hideWx);
wxWrap.addEventListener("click", (e) => {
  e.stopPropagation();
  wxPinned = !wxPinned;
  if (wxPinned) showWx(); else $("#weatherPop").classList.remove("show");
});
document.addEventListener("click", () => { if (wxPinned) { wxPinned = false; $("#weatherPop").classList.remove("show"); } });
if (navigator.geolocation) {
  navigator.geolocation.getCurrentPosition(
    (p) => loadWeather(p.coords.latitude, p.coords.longitude),
    () => loadWeather(39.9042, 116.4074), { timeout: 5000 });
} else loadWeather(39.9042, 116.4074);

/* ---------- 待办 ---------- */
const todoForm = $("#todoForm"), todoInput = $("#todoInput"), todoList = $("#todoList");
function renderTodos() {
  todoList.innerHTML = "";
  let left = 0;
  (state.todos || []).forEach((t, i) => {
    if (!t.done) left++;
    const li = document.createElement("li");
    li.className = "todo-item" + (t.done ? " done" : "");
    li.innerHTML = `<input type="checkbox" ${t.done ? "checked" : ""} data-i="${i}" />
      <span>${t.text.replace(/[<>&]/g, "")}</span>
      <button class="todo-del" data-i="${i}" title="删除">✕</button>`;
    todoList.appendChild(li);
  });
  $("#todoCount").textContent = `${state.todos.length ? left : 0}/${state.todos.length}`;
}
todoForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const v = todoInput.value.trim();
  if (!v) return;
  state.todos.push({ text: v, done: false });
  todoInput.value = ""; renderTodos(); scheduleSave();
});
todoList.addEventListener("click", (e) => {
  const i = e.target.dataset.i;
  if (i === undefined) return;
  if (e.target.classList.contains("todo-del")) state.todos.splice(i, 1);
  else if (e.target.type === "checkbox") state.todos[i].done = e.target.checked;
  renderTodos(); scheduleSave();
});

/* ---------- 快捷链接 ---------- */
const linksGrid = $("#linksGrid");
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function renderLinks() {
  linksGrid.innerHTML = "";
  (state.links || []).forEach((l, i) => {
    const a = document.createElement("a");
    a.className = "link-item" + (editingLinks ? " editing" : "");
    if (editingLinks) {
      a.href = "javascript:void(0)";
      a.innerHTML = `<span class="emoji">${l.emoji}</span>
        <span class="link-edit-fields">
          <input class="link-edit-input" data-f="name" data-i="${i}" value="${esc(l.name)}" placeholder="名称" />
          <input class="link-edit-input link-edit-url" data-f="url" data-i="${i}" value="${esc(l.url)}" placeholder="地址 https://" />
        </span>
        <button class="link-del-edit" data-del="${i}" title="删除">✕</button>`;
    } else {
      a.href = l.url; a.target = "_blank"; a.rel = "noopener";
      a.innerHTML = `<span class="emoji">${l.emoji}</span><span>${esc(l.name)}</span>`;
    }
    linksGrid.appendChild(a);
  });
}
linksGrid.addEventListener("input", (e) => {
  const i = e.target.dataset.i, f = e.target.dataset.f;
  if (i === undefined || !f) return;
  state.links[i][f] = e.target.value; scheduleSave();
});
linksGrid.addEventListener("click", (e) => {
  const del = e.target.dataset.del;
  if (del === undefined) return;
  state.links.splice(Number(del), 1); renderLinks(); scheduleSave();
});
$("#editLinks").addEventListener("click", () => {
  editingLinks = !editingLinks;
  $("#editLinks").textContent = editingLinks ? "完成" : "编辑";
  $("#addLink").hidden = !editingLinks;
  renderLinks();
});
$("#addLink").addEventListener("click", () => {
  state.links.push({ emoji: "🔗", name: "新链接", url: "https://" });
  renderLinks(); scheduleSave();
});

/* ---------- 喝水提醒（仅本机存储，不写后端） ---------- */
const WATER_KEY = "wb_water_v1";
const WATER_TOTAL = 8;
const waterCupsEl = $("#waterCups");
const waterCountEl = $("#waterCount");
function todayKey() { const d = new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
function loadWater() {
  try {
    const raw = localStorage.getItem(WATER_KEY);
    if (raw) { const o = JSON.parse(raw); if (o && o.date === todayKey() && Array.isArray(o.cups)) return o; }
  } catch (e) {}
  return { date: todayKey(), cups: new Array(WATER_TOTAL).fill(false) };
}
let waterState = loadWater();
function saveWater() { try { localStorage.setItem(WATER_KEY, JSON.stringify(waterState)); } catch (e) {} }
function renderWater() {
  if (!waterCupsEl) return;
  waterCupsEl.innerHTML = "";
  waterState.cups.forEach((filled, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cup" + (filled ? " filled" : "");
    b.setAttribute("aria-label", "第" + (i + 1) + "杯水");
    b.innerHTML = '<span class="cup-water"></span>';
    b.addEventListener("click", () => {
      waterState.cups[i] = !waterState.cups[i];
      saveWater(); renderWater();
    });
    waterCupsEl.appendChild(b);
  });
  if (waterCountEl) waterCountEl.textContent = waterState.cups.filter(Boolean).length + "/" + WATER_TOTAL;
}
function initWater() {
  if (waterState.date !== todayKey()) waterState = loadWater(); // 打开时已跨天则重置
  renderWater();
  onTick(() => { if (waterState.date !== todayKey()) { waterState = loadWater(); renderWater(); } }); // 每天0点自动重置
}

/* ---------- 每日运势（基于八字，调 DeepSeek） ---------- */
const BAZI = "癸酉 乙卯 丙申 丙申";
const FORTUNE_CACHE_KEY = "wb_fortune_v1";
const FORTUNE_HISTORY_KEY = "wb_fortune_history";
const FORTUNE_MAX_HISTORY = 30;

function fortuneNow() {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  const weekStr = WEEK[now.getDay()];
  const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return { now, dateStr, weekStr, timeStr };
}
function loadFortuneHistory() {
  try { return JSON.parse(localStorage.getItem(FORTUNE_HISTORY_KEY) || "[]") || []; } catch (e) { return []; }
}
function pushFortuneHistory(item) {
  const list = loadFortuneHistory();
  list.unshift(item);
  while (list.length > FORTUNE_MAX_HISTORY) list.pop();
  try { localStorage.setItem(FORTUNE_HISTORY_KEY, JSON.stringify(list)); } catch (e) {}
  renderFortuneHistory();
}
function renderFortuneHistory() {
  const box = $("#fortuneList");
  if (!box) return;
  const list = loadFortuneHistory();
  if (!list.length) { box.innerHTML = '<p class="fh-empty">暂无记录</p>'; return; }
  box.innerHTML = list.map((it) =>
    `<details class="fh-item">` +
      `<summary><span class="fh-time">${it.dateStr} ${it.weekStr} ${it.timeStr}</span></summary>` +
      `<p class="fh-text">${esc(it.text)}</p>` +
    `</details>`
  ).join("");
}
async function fetchFortune(opts) {
  opts = opts || {};
  const manual = !!opts.manual;
  const { now, dateStr, weekStr } = fortuneNow();
  if (!manual) {
    // 自动加载：同日本地缓存优先，避免重复消耗额度
    try {
      const cached = JSON.parse(localStorage.getItem(FORTUNE_CACHE_KEY) || "null");
      if (cached && cached.date === dateStr) { $("#quoteText").textContent = cached.text; return; }
    } catch (e) {}
  }
  const btn = $("#fortuneBtn");
  if (btn) { btn.disabled = true; btn.textContent = "推算中…"; }
  $("#quoteText").textContent = "正在为你推算今日运势…";
  const prompt =
    `你是一位专业且温和的命理师。用户的八字为「${BAZI}」。今天是 ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${weekStr}。\n` +
    `请基于该八字，用简体中文给出今天的每日运势，涵盖：整体、事业、财运、感情、健康五个方面；语气积极、有建设性、不说教。\n` +
    `不要使用任何 Markdown 标题或加粗，用换行分段，总字数控制在 200 字以内。`;
  try {
    const res = await callDeepSeek({ model: "deepseek-chat", messages: [{ role: "user", content: prompt }], stream: false });
    if (!res.ok) { $("#quoteText").textContent = "今日运势获取失败，请稍后重试。"; return; }
    const data = await res.json();
    const text = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "今日运势暂不可用。").trim();
    const { timeStr } = fortuneNow();
    const full = `【推算时间：${dateStr} ${weekStr} ${timeStr}】\n\n${text}`;
    $("#quoteText").textContent = full;
    try { localStorage.setItem(FORTUNE_CACHE_KEY, JSON.stringify({ date: dateStr, text: full })); } catch (e) {}
    pushFortuneHistory({ dateStr, weekStr, timeStr, text: full });
  } catch (e) {
    $("#quoteText").textContent = "网络异常，今日运势获取失败。";
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "手动推算"; }
  }
}
const fortuneBtn = $("#fortuneBtn");
if (fortuneBtn) fortuneBtn.addEventListener("click", () => fetchFortune({ manual: true }));
const fortuneClear = $("#fortuneClear");
if (fortuneClear) fortuneClear.addEventListener("click", () => {
  try { localStorage.removeItem(FORTUNE_HISTORY_KEY); } catch (e) {}
  renderFortuneHistory();
});
renderFortuneHistory();
fetchFortune();

/* ---------- 专注计时 ---------- */
const WORK = 25 * 60, BREAK = 5 * 60;
let timerLeft = WORK, timerId = null, isWork = true;
const timerDisplay = $("#timerDisplay");
function fmt(s) { return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }
function renderTimer() { timerDisplay.textContent = fmt(timerLeft); }
function timerStep() {
  timerLeft--;
  if (timerLeft < 0) {
    isWork = !isWork; timerLeft = isWork ? WORK : BREAK;
    $("#timerMode").textContent = isWork ? "工作 · 25 分钟" : "休息 · 5 分钟";
  }
  renderTimer();
}
$("#timerStart").addEventListener("click", (e) => {
  if (timerId) { clearInterval(timerId); timerId = null; e.target.textContent = "继续"; timerDisplay.classList.remove("run"); }
  else { timerId = setInterval(timerStep, 1000); e.target.textContent = "暂停"; timerDisplay.classList.add("run"); }
});
$("#timerReset").addEventListener("click", () => {
  clearInterval(timerId); timerId = null; isWork = true; timerLeft = WORK;
  $("#timerMode").textContent = "工作 · 25 分钟";
  $("#timerStart").textContent = "开始"; timerDisplay.classList.remove("run"); renderTimer();
});
renderTimer();

/* ---------- GH时间（到岗 / GH 计算） ---------- */
const GH_START = "09:00";          // 标准到岗
const GH_WORK_MINS = 8 * 60 + 30; // 工作时长 8h30m = 510 分钟（9:00 → 17:30）
function ghToMin(t) { const [h, m] = (t || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); }
function ghFmt(min) {
  min = ((min % 1440) + 1440) % 1440;
  return String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");
}
function computeGH() {
  const el = $("#ghArrival");
  if (!el) return;
  const arrival = el.value || GH_START;
  const am = ghToMin(arrival);
  const base = ghToMin(GH_START);          // 540
  const baseOff = base + GH_WORK_MINS;     // 1050 → 17:30
  let off, late = 0;
  if (am <= base) { off = baseOff; late = 0; }
  else { off = am + GH_WORK_MINS; late = am - base; }
  $("#ghOff").textContent = ghFmt(off);
  $("#ghNote").textContent = late > 0
    ? `比 ${GH_START} 晚到 ${late} 分钟，GH 顺延至 ${ghFmt(off)}`
    : `准时到岗，今日 ${ghFmt(off)} GH`;
  if (state.ghArrival !== arrival) { state.ghArrival = arrival; scheduleSave(); }
  updateGHCountdown();
}
/* 实时倒计时：距离 GH 还有多久 */
function updateGHCountdown() {
  const offEl = $("#ghOff"), cdEl = $("#ghCountdown");
  if (!offEl || !cdEl) return;
  const offStr = (offEl.textContent || "17:30").trim();
  const parts = offStr.split(":");
  if (parts.length < 2) return;
  const oh = Number(parts[0]), om = Number(parts[1]);
  if (isNaN(oh) || isNaN(om)) return;
  const now = new Date();
  const offDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), oh, om, 0, 0);
  let diff = Math.floor((offDate - now) / 1000); // 秒
  if (diff <= 0) {
    cdEl.textContent = "已到 GH 时间 ✓";
    cdEl.classList.add("gh-cd-reached");
    return;
  }
  cdEl.classList.remove("gh-cd-reached");
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  const seg = [];
  if (h) seg.push(h + " 小时");
  if (m) seg.push(m + " 分钟");
  seg.push(s + " 秒");
  cdEl.textContent = "距离 GH 还有 " + seg.join(" ");
}
(function initGH() {
  if (state.ghArrival) { const el = $("#ghArrival"); if (el) el.value = state.ghArrival; }
  computeGH();
  onTick(updateGHCountdown);
  const el = $("#ghArrival");
  if (el) { el.addEventListener("input", computeGH); el.addEventListener("change", computeGH); }
})();

/* ---------- 日历（可翻年月 + 点击标记） ---------- */
let marksData = state.calendarMarks || {};
const todayDate = new Date();
let calY = todayDate.getFullYear();
let calM = todayDate.getMonth();

function renderCalendar() {
  $("#calHead").textContent = `${calY}年 ${calM + 1}月`;
  const first = new Date(calY, calM, 1).getDay();
  const days = new Date(calY, calM + 1, 0).getDate();
  const grid = $("#calGrid");
  grid.innerHTML = "";
  ["日", "一", "二", "三", "四", "五", "六"].forEach((w) => {
    const c = document.createElement("div"); c.className = "cal-cell weekday"; c.textContent = w; grid.appendChild(c);
  });
  for (let i = 0; i < first; i++) {
    const c = document.createElement("div"); c.className = "cal-cell muted"; grid.appendChild(c);
  }
  for (let d = 1; d <= days; d++) {
    const key = calY + "-" + (calM + 1) + "-" + d;
    const isToday = (calY === todayDate.getFullYear() && calM === todayDate.getMonth() && d === todayDate.getDate());
    const c = document.createElement("div");
    let cls = "cal-cell";
    if (isToday) cls += " today";
    const dv = normalizeDayValue(marksData[key]);
    const hasContent = (dv.marks && dv.marks.length) || (dv.life && Object.keys(dv.life).length);
    if (hasContent) cls += " marked";
    c.className = cls;
    const txt = dv.marks && dv.marks.length ? dv.marks.join("、") : "";
    /* 运动健身时长小标记：勾选且有分钟数时，格子右上角显示（如 30m / 1h20） */
    let exBadge = "";
    const exMinRaw = (dv.life && typeof dv.life.exerciseMin === "number") ? dv.life.exerciseMin
      : (dv.life && typeof dv.life.fitness === "number") ? dv.life.fitness : 0;
    if (exMinRaw > 0) {
      const eh = Math.floor(exMinRaw / 60), em = exMinRaw % 60;
      const exLabel = eh > 0 ? (em > 0 ? eh + "h" + em : eh + "h") : em + "m";
      exBadge = '<span class="cal-exmin" title="运动健身 ' + exMinRaw + ' 分钟">' + exLabel + '</span>';
    }
    c.innerHTML = '<span class="cal-num">' + d + '</span>' + exBadge + (hasContent ? '<span class="cal-dot" title="' + txt + '"></span>' : '');
    c.addEventListener("click", () => openMarkModal(key, calY, calM + 1, d));
    grid.appendChild(c);
  }
  renderMonthOverview("drMonthOverview", calY, calM + 1);
}
function stepMonth(n) {
  calM += n;
  if (calM < 0) { calM = 11; calY--; }
  if (calM > 11) { calM = 0; calY++; }
  renderCalendar();
}
$("#calPrev").addEventListener("click", () => stepMonth(-1));
$("#calNext").addEventListener("click", () => stepMonth(1));
$("#calPrevYear").addEventListener("click", () => { calY--; renderCalendar(); });
$("#calNextYear").addEventListener("click", () => { calY++; renderCalendar(); });

let markCurrentKey = null;
let markTagsArr = [];
/* 兼容历史数据：旧格式是字符串/数组（纯事件），新格式是 {marks:[], life:{}} */
function normalizeDayValue(v) {
  if (!v) return { marks: [], life: {} };
  if (typeof v === "string") return { marks: v ? [v] : [], life: {} };
  if (Array.isArray(v)) return { marks: v, life: {} };
  return { marks: Array.isArray(v.marks) ? v.marks : [], life: (v.life && typeof v.life === "object") ? v.life : {} };
}
function renderMarkTags() {
  const box = $("#markTags"); if (!box) return;
  box.innerHTML = "";
  markTagsArr.forEach((t, i) => {
    const s = document.createElement("span"); s.className = "mark-tag"; s.textContent = t + " ";
    const x = document.createElement("span"); x.className = "mark-tag-x"; x.textContent = "×";
    x.addEventListener("click", () => { markTagsArr.splice(i, 1); renderMarkTags(); });
    s.appendChild(x); box.appendChild(s);
  });
}
function openMarkModal(key, y, m, d) {
  markCurrentKey = key;
  const dv = normalizeDayValue(state.calendarMarks ? state.calendarMarks[key] : null);
  markTagsArr = dv.marks.slice();
  renderMarkTags();
  const L = dv.life || {};
  $("#lfExercise").checked = !!(L.exercise || L.fitness);
  const exMinInit = (typeof L.exerciseMin === "number") ? L.exerciseMin : (typeof L.fitness === "number" ? L.fitness : "");
  $("#lfExerciseMin").value = (exMinInit !== "" && !isNaN(exMinInit)) ? exMinInit : "";
  $("#lfExerciseMin").disabled = !$("#lfExercise").checked;
  $("#lfExerciseNote").value = L.exerciseNote || L.fitnessNote || "";
  $("#lfDietBreakfast").value = L.dietBreakfast || (typeof L.diet === "string" ? L.diet : "");
  $("#lfDietLunch").value = L.dietLunch || "";
  $("#lfDietDinner").value = L.dietDinner || "";
  $("#lfSleepBed").value = L.sleepBed || "";
  $("#lfSleepWake").value = L.sleepWake || "";
  $("#lfStudy").checked = !!L.study;
  $("#lfStudyNote").value = L.studyNote || "";
  $("#lfMood").value = L.mood || "";
  $("#lfMoodNote").value = L.moodNote || "";
  updateSleepDur();
  $("#markDateLabel").textContent = y + "年" + m + "月" + d + "日";
  const has = dv.marks.length || Object.keys(L).length;
  $("#markDelete").style.display = has ? "inline-block" : "none";
  renderMonthOverview("drOverview", calY, calM + 1);
  $("#markModal").hidden = false;
  setTimeout(() => { const t = $("#markTagInput"); if (t) t.focus(); }, 50);
}
function updateSleepDur() {
  const b = $("#lfSleepBed").value, w = $("#lfSleepWake").value;
  const el = $("#lfSleepDur"); if (!el) return;
  if (b && w) {
    let bh = parseInt(b.split(":")[0], 10), bm = parseInt(b.split(":")[1], 10);
    let wh = parseInt(w.split(":")[0], 10), wm = parseInt(w.split(":")[1], 10);
    let mins = (wh * 60 + wm) - (bh * 60 + bm); if (mins < 0) mins += 1440;
    el.textContent = "（" + Math.floor(mins / 60) + "h" + (mins % 60) + "m）";
  } else el.textContent = "";
}
function renderMonthOverview(targetId, y, m) {
  const box = $("#" + targetId); if (!box) return;
  const data = state.calendarMarks || {};
  const prefix = y + "-" + (m < 10 ? "0" + m : m) + "-";
  let ex = 0, exMinSum = 0, exMinN = 0, st = 0, ss = 0, sn = 0; const moods = {};
  Object.keys(data).forEach((k) => {
    if (k.indexOf(prefix) !== 0) return;
    const L = normalizeDayValue(data[k]).life || {};
    if (L.exercise || L.fitness) {
      ex++;
      const m = (typeof L.exerciseMin === "number") ? L.exerciseMin : (typeof L.fitness === "number" ? L.fitness : 0);
      if (m > 0) { exMinSum += m; exMinN++; }
    }
    if (L.study) st++;
    if (L.sleepBed && L.sleepWake) {
      let bh = parseInt(L.sleepBed.split(":")[0], 10), bm = parseInt(L.sleepBed.split(":")[1], 10);
      let wh = parseInt(L.sleepWake.split(":")[0], 10), wm = parseInt(L.sleepWake.split(":")[1], 10);
      let mins = (wh * 60 + wm) - (bh * 60 + bm); if (mins < 0) mins += 1440;
      ss += mins; sn++;
    }
    if (L.mood) moods[L.mood] = (moods[L.mood] || 0) + 1;
  });
  const avg = sn ? (ss / sn / 60).toFixed(1) + "h" : "—";
  const avgMin = exMinN ? Math.round(exMinSum / exMinN) + "m" : "—";
  const moodStr = Object.keys(moods).length ? Object.entries(moods).map((e) => e[0] + e[1]).join(" ") : "—";
  box.innerHTML = "<b>本月概览</b>　运动健身 " + ex + " 天（均 " + avgMin + "）· 学习 " + st + " 天 · 平均睡眠 " + avg + " · 心情 " + moodStr;
}
function closeMarkModal() { $("#markModal").hidden = true; markCurrentKey = null; }
$("#markClose").addEventListener("click", closeMarkModal);
$("#markModal").addEventListener("click", (e) => { if (e.target === $("#markModal")) closeMarkModal(); });
$("#markTagInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const v = e.target.value.trim();
    if (v && markTagsArr.indexOf(v) === -1) { markTagsArr.push(v); renderMarkTags(); }
    e.target.value = "";
  }
});
$("#lfSleepBed").addEventListener("change", updateSleepDur);
$("#lfSleepWake").addEventListener("change", updateSleepDur);
$("#lfExercise").addEventListener("change", () => { const m = $("#lfExerciseMin"); if (m) m.disabled = !$("#lfExercise").checked; });
function saveMarkDay() {
  if (!markCurrentKey) return;
  const exMinRaw = parseInt($("#lfExerciseMin").value, 10);
  const life = {
    exercise: $("#lfExercise").checked,
    exerciseMin: ($("#lfExercise").checked && !isNaN(exMinRaw) && exMinRaw > 0) ? exMinRaw : 0,
    exerciseNote: $("#lfExerciseNote").value.trim(),
    dietBreakfast: $("#lfDietBreakfast").value.trim(),
    dietLunch: $("#lfDietLunch").value.trim(),
    dietDinner: $("#lfDietDinner").value.trim(),
    sleepBed: $("#lfSleepBed").value, sleepWake: $("#lfSleepWake").value,
    study: $("#lfStudy").checked, studyNote: $("#lfStudyNote").value.trim(),
    mood: $("#lfMood").value, moodNote: $("#lfMoodNote").value.trim(),
  };
  const hasLife = Object.keys(life).some((k) => { const v = life[k]; return v !== false && v !== "" && v !== 0; });
  if (!state.calendarMarks) state.calendarMarks = {};
  if (markTagsArr.length || hasLife) state.calendarMarks[markCurrentKey] = { marks: markTagsArr.slice(), life };
  else delete state.calendarMarks[markCurrentKey];
  marksData = state.calendarMarks;
  scheduleSave();
  renderCalendar(); renderMonthOverview("drOverview", calY, calM + 1); renderMonthOverview("drMonthOverview", calY, calM + 1);
  closeMarkModal();
}
$("#markSave").addEventListener("click", saveMarkDay);
$("#markDelete").addEventListener("click", () => {
  if (markCurrentKey) {
    if (!state.calendarMarks) state.calendarMarks = {};
    delete state.calendarMarks[markCurrentKey];
    marksData = state.calendarMarks;
    scheduleSave();
    renderCalendar(); renderMonthOverview("drOverview", calY, calM + 1); renderMonthOverview("drMonthOverview", calY, calM + 1);
    closeMarkModal();
  }
});
renderCalendar();

/* ---------- 笔记 ---------- */
const notes = $("#notes");
notes.addEventListener("input", () => { state.notes = notes.value; scheduleSave(); scheduleNotesArchive(); });

/* ---------- 随手笔记 · 历史存档（每次修改自动留痕，类似每日运势历史） ---------- */
const NOTES_HISTORY_KEY = "wb_notes_history";
const NOTES_MAX_HISTORY = 50;
let lastArchivedNotes = (state.notes || "").toString();
let notesArchiveTimer = null;
function pushNotesHistory(text) {
  text = (text || "").toString();
  const list = state.notesHistory || (state.notesHistory = []);
  if (list.length && list[0].text === text) return; /* 与最近一条完全相同则跳过，避免连续重复存档 */
  const now = new Date();
  const item = {
    ts: now.toISOString(),
    dateStr: `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`,
    weekStr: WEEK[now.getDay()],
    timeStr: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
    text: text,
  };
  list.unshift(item);
  while (list.length > NOTES_MAX_HISTORY) list.pop();
  lastArchivedNotes = text;
  /* 本机先存一份兜底，保证即使后端列未建好也不丢；后端列就绪后 scheduleSave 会一并同步 */
  try { localStorage.setItem(NOTES_HISTORY_KEY, JSON.stringify(list)); } catch (e) {}
  renderNotesHistory();
  scheduleSave(); /* 触发（防抖）保存，把历史一并写入后端，跨设备可回看 */
}
function renderNotesHistory() {
  const box = $("#notesHistoryList");
  if (!box) return;
  const list = state.notesHistory || [];
  if (!list.length) { box.innerHTML = '<p class="fh-empty">暂无记录</p>'; return; }
  box.innerHTML = list.map((it) =>
    `<details class="fh-item">` +
      `<summary><span class="fh-time">${it.dateStr} ${it.weekStr} ${it.timeStr}</span></summary>` +
      `<p class="fh-text">${esc(it.text)}</p>` +
    `</details>`
  ).join("");
}
function scheduleNotesArchive() {
  clearTimeout(notesArchiveTimer);
  if ((state.notes || "").toString() === lastArchivedNotes) return; /* 内容没变就不排程 */
  notesArchiveTimer = setTimeout(() => {
    if ((state.notes || "").toString() !== lastArchivedNotes) pushNotesHistory(state.notes);
  }, 1500);
}
const notesHistoryClear = $("#notesHistoryClear");
if (notesHistoryClear) notesHistoryClear.addEventListener("click", () => {
  state.notesHistory = [];
  try { localStorage.removeItem(NOTES_HISTORY_KEY); } catch (e) {}
  lastArchivedNotes = (state.notes || "").toString();
  renderNotesHistory();
  scheduleSave();
});

/* ---------- 主题 ---------- */
$("#themeToggle").addEventListener("click", () => {
  state.theme = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", state.theme);
  _pnSyncTheme();
  scheduleSave();
});

/* ---------- 刷新 / 退出 ---------- */
$("#syncNow").addEventListener("click", async () => {
  if (!userId) return;
  setStatus("刷新中…", "syncing");
  try {
    const data = await fetchState();
    if (data) { state = Object.assign(defaultState(), mapRow(data)); applyState(); }
    setStatus("已刷新 ✓", "ok");
  } catch (e) { setStatus("刷新失败", "err"); }
});
$("#exitSpace").addEventListener("click", exitSpace);

/* ---------- 登录层交互 ---------- */
$("#setupEnter").addEventListener("click", handleLogin);
$("#setupPass").addEventListener("keydown", (e) => { if (e.key === "Enter") handleLogin(); });
$("#setupAccount").addEventListener("keydown", (e) => { if (e.key === "Enter") handleLogin(); });

/* ---------- 启动：恢复登录态 ---------- */
(async function boot() {
  initWater();
  const saved = localStorage.getItem(SESSION_KEY);
  if (saved) {
    const u = saved === "1" ? "jimilo" : saved; // 兼容旧登录格式
    try {
      const user = await fetchUserByUsername(u);
      if (user && user.status !== "disabled") await enterWorkbench(user);
      else { localStorage.removeItem(SESSION_KEY); setStatus("未登录", ""); }
    } catch (e) {
      /* 后端暂不可用（如冷启动中）：按用户名降级进入，功能操作时自会提示；权限按全量 */
      currentUser = { username: u, is_super: u === "jimilo", status: "active" };
      window.__wbIsSuper = !!(currentUser && currentUser.is_super);
      await enterWorkbench(currentUser);
    }
  } else {
    setStatus("未登录", "");
  }
})();

/* ---------- 侧边栏折叠 + 页面切换 ---------- */
const sidebar = $("#sidebar");
const sidebarToggle = $("#sidebarToggle");
const sidebarOverlay = $("#sidebarOverlay");
const appEl = document.querySelector(".app");
const isMobile = () => window.innerWidth < 860;

function updateToggleIcon() {
  // 移动端抽屉用 ✕ 表示“收起”，桌面端用 « / »
  sidebarToggle.textContent = isMobile()
    ? "✕"
    : (sidebar.classList.contains("collapsed") ? "»" : "«");
}
function syncSidebarUI() {
  const collapsed = sidebar.classList.contains("collapsed");
  // 移动端且展开时显示遮罩，点击遮罩即可收起
  if (isMobile() && !collapsed) sidebarOverlay.classList.add("show");
  else sidebarOverlay.classList.remove("show");
  updateToggleIcon();
}
if (localStorage.getItem("wb_sb_collapsed") === "1" || isMobile()) {
  sidebar.classList.add("collapsed");
  appEl.classList.add("nav-collapsed");
}
syncSidebarUI();
sidebarToggle.addEventListener("click", () => {
  const c = sidebar.classList.toggle("collapsed");
  appEl.classList.toggle("nav-collapsed", c);
  localStorage.setItem("wb_sb_collapsed", c ? "1" : "0");
  syncSidebarUI();
});
const menuFab = $("#menuFab");
menuFab.addEventListener("click", () => {
  sidebar.classList.remove("collapsed");
  appEl.classList.remove("nav-collapsed");
  localStorage.setItem("wb_sb_collapsed", "0");
  syncSidebarUI();
});
// 移动端：点击遮罩收起抽屉
sidebarOverlay.addEventListener("click", () => {
  sidebar.classList.add("collapsed");
  appEl.classList.add("nav-collapsed");
  localStorage.setItem("wb_sb_collapsed", "1");
  syncSidebarUI();
});
// 跨断点（旋转屏幕 / 缩放窗口）时刷新图标与遮罩
window.addEventListener("resize", syncSidebarUI);
/* ---------- 侧边栏：一级菜单折叠 + 页面切换 ---------- */
// 一级菜单（如 AI）点击展开/收起其子项
document.querySelectorAll(".nav-parent").forEach((btn) => {
  btn.addEventListener("click", () => {
    const sub = document.getElementById("sub" + btn.dataset.toggle);
    const open = sub.classList.toggle("open");
    btn.classList.toggle("open", open);
  });
});
/* ---------- 内嵌页面按需加载 / 后台自动释放（省内存核心） ----------
   所有外部站点 iframe 在 HTML 里写成 data-src，不随首屏加载。
   只有真正切到该页面时才挂载；离开超过 IDLE 分钟后自动卸载（about:blank）释放内存，
   下次再进入自动重新加载，用户无感。 */
const FRAME_IDLE_MS = 3 * 60 * 1000; // 离开 3 分钟后释放后台页面
const releaseTimers = new Map();
function frameList(root) { return root ? root.querySelectorAll("iframe[data-src]") : []; }
function mountFrames(root) {
  frameList(root).forEach((f) => {
    const want = f.dataset.src;
    if (want && f.getAttribute("src") !== want) f.setAttribute("src", want);
  });
  updateMemPill();
}
function releaseFrames(root) {
  let freed = 0;
  frameList(root).forEach((f) => {
    const cur = f.getAttribute("src");
    if (cur && cur !== "about:blank") { f.setAttribute("src", "about:blank"); freed++; }
  });
  if (freed) updateMemPill();
  return freed;
}
function loadedFrameCount() {
  let n = 0;
  document.querySelectorAll("iframe[data-src]").forEach((f) => {
    const s = f.getAttribute("src");
    if (s && s !== "about:blank") n++;
  });
  return n;
}
function updateMemPill() {
  const el = $("#memPill");
  if (!el) return;
  const n = loadedFrameCount();
  el.textContent = "🧠 " + n;
  el.classList.toggle("mem-hot", n >= 3);
  el.title = n ? `已加载 ${n} 个内嵌页面 · 点击立即释放后台页面` : "无内嵌页面占用内存";
}
function scheduleRelease(pageEl) {
  if (!pageEl || !frameList(pageEl).length) return;
  clearTimeout(releaseTimers.get(pageEl.id));
  releaseTimers.set(pageEl.id, setTimeout(() => releaseFrames(pageEl), FRAME_IDLE_MS));
}
/* 手动一键释放：卸载所有非当前页面的内嵌页 */
function releaseBackground() {
  let freed = 0;
  document.querySelectorAll(".page").forEach((p) => {
    if (p.classList.contains("hidden")) freed += releaseFrames(p);
  });
  const news = $("#newsPanel");
  if (news && news.classList.contains("hidden")) freed += releaseFrames(news);
  return freed;
}

// 页面切换（首页/英语/豆姐/DP 等带 data-page 的项）
const allPages = document.querySelectorAll(".page");
function switchPage(page) {
  const targetId = "page" + page.charAt(0).toUpperCase() + page.slice(1);
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  allPages.forEach((p) => {
    const isTarget = p.id === targetId;
    p.classList.toggle("hidden", !isTarget);
    if (isTarget) {
      clearTimeout(releaseTimers.get(p.id));
      mountFrames(p);           // 进入才加载
      if (targetId === "pageHome") { loadData(); loadPet(); } // 切回首页即拉取最新（数据未变则跳过重渲染）
      else if (targetId === "pageOperators") loadOperators(); // 进入操作员管理即拉取列表
      else if (targetId === "pageModulePerm") loadModulePerm(); // 进入模块权限即拉取列表
    } else {
      scheduleRelease(p);       // 离开延时释放
    }
  });
}
document.querySelectorAll(".nav-item[data-page]").forEach((btn) => {
  btn.addEventListener("click", () => switchPage(btn.dataset.page));
});
/* ---------- 首页模块显隐 + 顺序（注册表驱动，可配置） ---------- */
function applyHomeLayout() {
  const grid = document.querySelector("#pageHome .grid");
  if (!grid) return;
  const order = Array.isArray(state.homeModules) ? state.homeModules : defaultHomeModules();
  const vis = {};
  order.forEach((m) => { if (m && m.id) vis[m.id] = (m.visible !== false) && (m.enabled !== false); });
  const cards = {};
  grid.querySelectorAll(":scope > [data-module]").forEach((el) => { cards[el.dataset.module] = el; });
  // 按配置顺序重排（appendChild 自动移到末尾），并应用显隐
  order.forEach((m) => {
    const el = cards[m.id];
    if (!el) return;
    el.style.display = vis[m.id] ? "" : "none";
    el.style.height = (m.height && m.height > 0) ? m.height + "px" : "";
    grid.appendChild(el);
  });
  initCardResize();
  // 兜底：配置里没有的卡片（理论上不会）默认显示并追加到末尾
  grid.querySelectorAll(":scope > [data-module]").forEach((el) => {
    if (!order.find((m) => m.id === el.dataset.module)) el.style.display = "";
  });
}

/* ---------- 首页模块卡片高度拖拽（通用，按用户独立保存） ---------- */
const CARD_MIN_H = 120, CARD_MAX_H = 800;
function initCardResize() {
  const grid = document.querySelector("#pageHome .grid");
  if (!grid) return;
  grid.querySelectorAll(":scope > .card[data-module]").forEach((card) => {
    if (card.dataset.resizeInited) return;
    card.dataset.resizeInited = "1";
    const handle = document.createElement("div");
    handle.className = "card-resize-handle";
    handle.title = "拖拽调整高度";
    card.appendChild(handle);
    let startY = 0, startH = 0, dragging = false;
    handle.addEventListener("pointerdown", (e) => {
      dragging = true; startY = e.clientY; startH = card.getBoundingClientRect().height;
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      document.body.style.userSelect = "none";
      e.preventDefault();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      let h = startH + (e.clientY - startY);
      h = Math.max(CARD_MIN_H, Math.min(CARD_MAX_H, h));
      card.style.height = h + "px";
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      document.body.style.userSelect = "";
      saveCardHeight(card.dataset.module, card.getBoundingClientRect().height);
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });
}
function saveCardHeight(id, h) {
  if (!Array.isArray(state.homeModules)) state.homeModules = defaultHomeModules();
  const item = state.homeModules.find((m) => m.id === id);
  const hh = Math.round(Math.max(CARD_MIN_H, Math.min(CARD_MAX_H, h)));
  if (item) item.height = hh;
  scheduleSave();
}

/* 首页管理页：可拖拽模块列表（含显隐 + 数据共享开关） */
const NO_SHARE_MODULES = new Set(["hero", "fortune"]); // 无个人数据的模块不显示「共享」开关
function renderHomeManage() {
  const list = $("#moduleList");
  if (!list) return;
  const cfg = Array.isArray(state.homeModules) ? state.homeModules : defaultHomeModules();
  if (!state.sharing || typeof state.sharing !== "object") state.sharing = {};
  list.innerHTML = "";
  cfg.forEach((m) => {
    const meta = MODULE_REGISTRY.find((r) => r.id === m.id) || { label: m.id };
    const li = document.createElement("li");
    li.className = "module-item";
    li.draggable = true;
    li.dataset.id = m.id;
    let shareHtml = "";
    if (!NO_SHARE_MODULES.has(m.id)) {
      const shared = state.sharing[m.id] === true;
      shareHtml = '<label class="mi-share" title="开启后，其他成员可在其首页看到你该模块的数据"><span>共享</span><input type="checkbox" class="mi-share-toggle"' + (shared ? " checked" : "") + ' /></label>';
    }
    li.innerHTML =
      '<span class="mi-handle" title="拖拽排序">⠿</span>' +
      '<span class="mi-label">' + meta.label + '</span>' +
      '<label class="mi-switch" title="在首页显示/隐藏"><input type="checkbox" class="mi-toggle"' + (m.visible !== false ? " checked" : "") + ' /><span class="mi-slider"></span></label>' +
      shareHtml;
    list.appendChild(li);
  });
}
// 显隐开关 / 共享开关写入 state
$("#moduleList").addEventListener("change", (e) => {
  if (e.target.classList.contains("mi-share-toggle")) {
    const li = e.target.closest(".module-item");
    const id = li && li.dataset.id;
    if (!id) return;
    if (!state.sharing || typeof state.sharing !== "object") state.sharing = {};
    state.sharing[id] = e.target.checked;
    scheduleSave(); // 共享开关即时保存，无需点「保存」
    return;
  }
  if (!e.target.classList.contains("mi-toggle")) return;
  const li = e.target.closest(".module-item");
  const id = li && li.dataset.id;
  const item = (state.homeModules || []).find((m) => m.id === id);
  if (item) item.visible = e.target.checked;
});
// 拖拽排序（原生 HTML5 DnD，无第三方依赖）
(function initHomeManageDnD() {
  const list = $("#moduleList");
  if (!list) return;
  let dragEl = null;
  list.addEventListener("dragstart", (e) => {
    const li = e.target.closest(".module-item");
    if (!li) return;
    dragEl = li; li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  list.addEventListener("dragover", (e) => {
    e.preventDefault();
    const li = e.target.closest(".module-item");
    if (!li || li === dragEl) return;
    const rect = li.getBoundingClientRect();
    const after = (e.clientY - rect.top) / rect.height > 0.5;
    if (dragEl) list.insertBefore(dragEl, after ? li.nextSibling : li);
  });
  list.addEventListener("dragend", () => {
    if (dragEl) dragEl.classList.remove("dragging");
    dragEl = null;
  });
})();
// 保存：按列表当前顺序 + 开关写入 state 并持久化，首页立即生效
function saveHomeManage() {
  const list = $("#moduleList");
  if (!list) return;
  const next = [];
  const prevH = state.homeModules || [];
  list.querySelectorAll(".module-item").forEach((li) => {
    const id = li.dataset.id;
    const old = prevH.find((p) => p.id === id);
    const h = (old && typeof old.height === "number" && old.height > 0) ? old.height : null;
    // 保留超管配置的模块权限 enabled（首页管理只管顺序/显隐，不能把被关掉的模块权限覆盖掉）
    const en = (old && old.enabled !== false);
    next.push({ id: id, visible: li.querySelector(".mi-toggle").checked, height: h, enabled: en });
  });
  state.homeModules = next;
  applyHomeLayout();
  scheduleSave();
  setStatus("布局已保存 ✓", "ok");
}
const hmSave = $("#hmSave"); if (hmSave) hmSave.addEventListener("click", saveHomeManage);
const hmReset = $("#hmReset"); if (hmReset) hmReset.addEventListener("click", () => {
  // 恢复默认布局（顺序/显隐），但保留超管配置的模块权限 enabled，避免用户重置即绕过权限
  state.homeModules = defaultHomeModules().map((d) => {
    const cur = (state.homeModules || []).find((x) => x.id === d.id);
    return Object.assign({}, d, { enabled: cur ? (cur.enabled !== false) : true });
  });
  renderHomeManage(); applyHomeLayout(); scheduleSave();
  setStatus("已恢复默认 ✓", "ok");
});

/* 整个标签页切走超过 5 分钟：释放所有后台内嵌页，回来时当前页自动重新加载 */
let hiddenReleaseTimer = null;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(hiddenReleaseTimer);
    hiddenReleaseTimer = setTimeout(releaseBackground, 5 * 60 * 1000);
  } else {
    clearTimeout(hiddenReleaseTimer);
    const cur = document.querySelector(".page:not(.hidden)");
    if (cur) mountFrames(cur);   // 回到前台，当前页若被释放则自动补回
    updateMemPill();
  }
});

$("#memPill") && $("#memPill").addEventListener("click", () => {
  const n = releaseBackground();
  const el = $("#memPill");
  if (el) {
    const old = el.textContent;
    el.textContent = n ? "已释放 " + n + " 个" : "无可释放";
    setTimeout(() => updateMemPill(), 1400);
  }
});
updateMemPill();

/* ---------- 笔记 / 新闻 已拆分为两个独立首页模块（data-module=notes / news） ---------- */


/* ---------- 便利贴（可拖动 / 增删改） ---------- */
const STICKY_COLORS = ["#ffe9a8", "#c9e7ff", "#d6f5d6", "#ffd6e7", "#e3d6ff"];
let stickyColorIdx = 0;
// 共享便利贴（独立于个人 stickyNotes，存 shared_sticky 表；所有人可读可编辑、不可删除）
let sharedSticky = null;
let sharedStickySaveTimer = null;
const stickyBoard = $("#stickyBoard");
function findSticky(id) { return (state.stickyNotes || []).find((x) => x.id === id); }
function renderStickyBoard() {
  if (!stickyBoard) return;
  stickyBoard.innerHTML = "";
  (state.stickyNotes || []).forEach((n) => {
    const el = document.createElement("div");
    el.className = "sticky";
    el.dataset.id = n.id;
    el.style.left = (typeof n.x === "number" ? n.x : 20) + "px";
    el.style.top = (typeof n.y === "number" ? n.y : 20) + "px";
    el.style.background = n.color || STICKY_COLORS[0];
    el.innerHTML =
      '<div class="sticky-head">' +
        '<span class="sticky-grip" title="按住拖动">⠿</span>' +
        '<input class="sticky-title" value="' + esc(n.title || "") + '" placeholder="标题" />' +
        '<button class="sticky-copy" title="一键复制内容">📋</button>' +
        '<button class="sticky-del" title="删除">×</button>' +
      '</div>' +
      '<textarea class="sticky-body" placeholder="写点什么…">' + esc(n.body || "") + '</textarea>';
    el.querySelector(".sticky-title").addEventListener("input", (e) => {
      const item = findSticky(n.id); if (item) { item.title = e.target.value; scheduleSave(); }
    });
    el.querySelector(".sticky-body").addEventListener("input", (e) => {
      const item = findSticky(n.id); if (item) { item.body = e.target.value; scheduleSave(); }
    });
    el.querySelector(".sticky-copy").addEventListener("click", () => copySticky(n.id, el.querySelector(".sticky-copy")));
    el.querySelector(".sticky-del").addEventListener("click", () => {
      state.stickyNotes = (state.stickyNotes || []).filter((x) => x.id !== n.id);
      renderStickyBoard(); scheduleSave();
    });
    enableStickyDrag(el, n);
    stickyBoard.appendChild(el);
  });
  // 共享便利贴：常驻最后（DOM 末尾），所有人可读可编辑同一张，不可删除。
  // 外观与普便利贴完全一致（含删除按钮但点击拦截），以满足「不要被人看出来」。
  if (sharedSticky) {
    const s = sharedSticky;
    const el = document.createElement("div");
    el.className = "sticky";
    el.dataset.id = s.id;
    el.dataset.shared = "1";
    el.style.left = (typeof s.x === "number" ? s.x : 24) + "px";
    el.style.top = (typeof s.y === "number" ? s.y : 24) + "px";
    el.style.background = s.color || "#ffd6e7";
    el.innerHTML =
      '<div class="sticky-head">' +
        '<span class="sticky-grip" title="按住拖动">⠿</span>' +
        '<input class="sticky-title" value="' + esc(s.title || "") + '" placeholder="标题" />' +
        '<button class="sticky-copy" title="一键复制内容">📋</button>' +
        '<button class="sticky-del" title="删除">×</button>' +
      '</div>' +
      '<textarea class="sticky-body" placeholder="写点什么…">' + esc(s.body || "") + '</textarea>';
    el.querySelector(".sticky-title").addEventListener("input", (e) => {
      sharedSticky.title = e.target.value; saveSharedSticky();
    });
    el.querySelector(".sticky-body").addEventListener("input", (e) => {
      sharedSticky.body = e.target.value; saveSharedSticky();
    });
    el.querySelector(".sticky-copy").addEventListener("click", (ev) => {
      const btn = ev.currentTarget;
      const text = [sharedSticky.title, sharedSticky.body].map((x) => String(x || "")).join("\n").replace(/\n{2,}/g, "\n").trim();
      const flash = (ok, msg) => {
        const o = btn.innerHTML, t = btn.getAttribute("title");
        if (ok) { btn.classList.add("copied"); btn.innerHTML = "✓"; btn.setAttribute("title", msg || "已复制"); }
        else { btn.innerHTML = "✕"; btn.setAttribute("title", msg || "复制失败"); }
        setTimeout(() => { btn.classList.remove("copied"); btn.innerHTML = o; btn.setAttribute("title", t); }, 1300);
      };
      if (!text) { flash(false, "没有内容可复制"); return; }
      const done = () => flash(true, "已复制"), fail = () => flash(false, "复制失败");
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(() => legacyCopy(text, done, fail));
      else legacyCopy(text, done, fail);
    });
    el.querySelector(".sticky-del").addEventListener("click", () => {
      // 不可删除：静默拦截（不弹特殊提示，保持隐蔽）
    });
    enableStickyDrag(el, sharedSticky, saveSharedSticky);
    stickyBoard.appendChild(el);
  }
}
function copySticky(id, btn) {
  const item = findSticky(id);
  if (!item) return;
  const text = [item.title, item.body].map((s) => String(s || "")).join("\n").replace(/\n{2,}/g, "\n").trim();
  const flash = (ok, msg) => {
    if (!btn) return;
    const oldTitle = btn.getAttribute("title");
    const oldHtml = btn.innerHTML;
    if (ok) { btn.classList.add("copied"); btn.innerHTML = "✓"; btn.setAttribute("title", msg || "已复制"); }
    else { btn.innerHTML = "✕"; btn.setAttribute("title", msg || "复制失败"); }
    setTimeout(() => { btn.classList.remove("copied"); btn.innerHTML = oldHtml; btn.setAttribute("title", oldTitle); }, 1300);
  };
  if (!text) { flash(false, "没有内容可复制"); return; }
  const done = () => flash(true, "已复制");
  const fail = () => flash(false, "复制失败");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => legacyCopy(text, done, fail));
  } else {
    legacyCopy(text, done, fail);
  }
}
function legacyCopy(text, done, fail) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; ta.style.top = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    ok ? done() : fail();
  } catch (e) { fail(); }
}
let stickyZ = 10;
function enableStickyDrag(el, n, onCommit) {
  let startX = 0, startY = 0, origX = 0, origY = 0, dragging = false, pid = null, moved = false;
  const onDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    const t = e.target;
    // 手柄始终可拖；输入框 / 文本域 / 按钮内不触发拖动（保证正常编辑与删除）
    if (!(t.classList && t.classList.contains("sticky-grip")) &&
        t.closest && t.closest("input, textarea, button")) return;
    dragging = true; moved = false; pid = e.pointerId;
    el.classList.add("dragging");
    el.style.zIndex = ++stickyZ;
    startX = e.clientX; startY = e.clientY;
    origX = el.offsetLeft; origY = el.offsetTop;   // 以真实渲染位置为基准，避免 state 缺 x/y 时跳位
    try { el.setPointerCapture(pid); } catch (err) {}
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging || e.pointerId !== pid) return;
    let nx = origX + (e.clientX - startX);
    let ny = origY + (e.clientY - startY);
    if (Math.abs(nx - origX) > 2 || Math.abs(ny - origY) > 2) moved = true;
    const board = stickyBoard;
    if (board && board.clientWidth) {
      const maxX = Math.max(0, board.clientWidth - el.offsetWidth - 4);
      const maxY = Math.max(0, Math.max(board.clientHeight, board.scrollHeight) - el.offsetHeight - 4);
      nx = Math.min(Math.max(0, nx), maxX);
      ny = Math.min(Math.max(0, ny), maxY);
    } else {
      nx = Math.max(0, nx); ny = Math.max(0, ny);
    }
    el.style.left = nx + "px"; el.style.top = ny + "px";
    n.x = nx; n.y = ny;   // 直接写对象引用（个人/共享通用），提交时由 onCommit 或 scheduleSave 落库
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false; el.classList.remove("dragging");
    try { el.releasePointerCapture(pid); } catch (err) {}
    pid = null;
    if (moved) { if (onCommit) onCommit(n.x, n.y); else scheduleSave(); }
  };
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
  el.addEventListener("lostpointercapture", onUp);
}
// ---------- 共享便利贴（shared_sticky 表，单行 id='global'，所有人可读可编辑、不可删除） ----------
function loadSharedSticky() {
  return (async () => {
    try {
      const res = await withTimeout(fetch(REST_BASE + "/shared_sticky?limit=1", { headers: API_HEADERS, cache: "no-store" }), 15000, "读取共享便利贴");
      if (res.ok) {
        const arr = await res.json();
        if (Array.isArray(arr) && arr.length) sharedSticky = arr[0];
        else sharedSticky = null;
      }
    } catch (e) {
      console.warn("[sharedSticky] 读取失败（不影响个人便利贴）：", e);
    }
    renderStickyBoard(); // 读取完成后补渲染（含共享便利贴）
  })();
}
function saveSharedSticky() {
  if (!sharedSticky) return;
  clearTimeout(sharedStickySaveTimer);
  sharedStickySaveTimer = setTimeout(async () => {
    try {
      const head = Object.assign({}, API_HEADERS, { "Prefer": "return=minimal" });
      const res = await withTimeout(fetch(REST_BASE + "/shared_sticky?id=eq.global", {
        method: "PATCH",
        headers: head,
        body: JSON.stringify({
          title: sharedSticky.title,
          body: sharedSticky.body,
          x: typeof sharedSticky.x === "number" ? sharedSticky.x : 24,
          y: typeof sharedSticky.y === "number" ? sharedSticky.y : 24,
          color: sharedSticky.color || "#ffd6e7",
          updated_by: userId || "jimilo",
          updated_at: new Date().toISOString(),
        }),
      }), 15000, "保存共享便利贴");
      if (!res.ok) console.warn("[sharedSticky] 保存失败", res.status);
    } catch (e) {
      console.warn("[sharedSticky] 保存异常", e);
    }
  }, 400);
}
function addSticky() {
  state.stickyNotes = state.stickyNotes || [];
  const color = STICKY_COLORS[stickyColorIdx % STICKY_COLORS.length];
  stickyColorIdx++;
  const offset = state.stickyNotes.length * 26;
  state.stickyNotes.push({
    id: "s_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
    title: "新便利贴", body: "", x: 24 + (offset % 320), y: 24 + (offset % 220), color,
  });
  renderStickyBoard(); scheduleSave();
}
function initSticky() {
  const btn = $("#addSticky");
  if (btn) btn.addEventListener("click", addSticky);
}
initSticky();

/* ---------- 数据导出 / 导入（防丢 + 自助恢复） ---------- */
function downloadJSON(filename, text) {
  const blob = new Blob([text], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function currentSnapshot() {
  return {
    user_id: userId || "jimilo",
    name: state.name,
    todos: state.todos,
    links: state.links,
    notes: state.notes,
    theme: state.theme,
    stickyNotes: state.stickyNotes,
    calendarMarks: state.calendarMarks,
    ghArrival: state.ghArrival,
  };
}
const exBtn = $("#exportData");
if (exBtn) exBtn.addEventListener("click", async () => {
  const json = JSON.stringify(currentSnapshot(), null, 2);
  let copied = false;
  try { await navigator.clipboard.writeText(json); copied = true; } catch (e) {}
  downloadJSON("workbench-backup.json", json);
  setStatus(copied ? "已导出并复制到剪贴板 ✓" : "已导出为文件 ✓", "ok");
  setTimeout(() => { if ($("#syncStatus").textContent.indexOf("导出") >= 0) setStatus("已保存 ✓", "ok"); }, 2500);
});
const imBtn = $("#importData");
if (imBtn) imBtn.addEventListener("click", () => { const m = $("#importModal"); if (m) m.hidden = false; });
function closeImport() { const m = $("#importModal"); if (m) m.hidden = true; }
const icBtn = $("#importClose"); if (icBtn) icBtn.addEventListener("click", closeImport);
const icaBtn = $("#importCancel"); if (icaBtn) icaBtn.addEventListener("click", closeImport);
const ifBtn = $("#importConfirm");
if (ifBtn) ifBtn.addEventListener("click", async () => {
  const raw = $("#importInput").value.trim();
  const stEl = $("#importStatus");
  if (!raw) { stEl.textContent = "请先粘贴 JSON"; stEl.className = "import-status err"; return; }
  const j = (v, d) => { if (v == null) return d; try { return JSON.parse(v); } catch (e) { return v || d; } };
  let parsed;
  try {
    const o = JSON.parse(raw);
    parsed = {
      name: state.name,
      todos: o.todos || j(o.wb_todos, []) || [],
      links: o.links || j(o.wb_links, []) || [],
      notes: o.notes != null ? o.notes : (o.wb_notes || ""),
      theme: o.theme || o.wb_theme || state.theme,
      stickyNotes: o.stickyNotes || j(o.wb_sticky, []) || [],
      calendarMarks: o.calendarMarks || j(o.wb_marks, {}) || {},
      ghArrival: o.ghArrival || o.wb_gh || "",
    };
  } catch (e) {
    stEl.textContent = "JSON 解析失败：" + e.message; stEl.className = "import-status err"; return;
  }
  if (!Array.isArray(parsed.todos)) parsed.todos = [];
  if (!Array.isArray(parsed.links)) parsed.links = [];
  if (!Array.isArray(parsed.stickyNotes)) parsed.stickyNotes = [];
  if (!parsed.calendarMarks || typeof parsed.calendarMarks !== "object") parsed.calendarMarks = {};
  if (typeof parsed.notes !== "string") parsed.notes = String(parsed.notes || "");
  Object.assign(state, parsed);
  await saveState();   // 立即写入后端
  applyState();
  stEl.textContent = "✅ 已导入并写入后端"; stEl.className = "import-status ok";
  setTimeout(closeImport, 1000);
});

/* =====================================================================
   PayNews 资讯模块（原生迁移 · 替换 paynews 内嵌模拟）
   - 新闻：直连 RSS 聚合，无 MOCK 种子，结果存后端、可跨设备
   - 论坛：发帖板（文字/图片，存后端）
   ===================================================================== */

/* ---------- PayNews 应用：原生嵌入首页模块（Shadow DOM，非 iframe） ---------- */
const PAYNEWS_VER = "20260904a";
let _paynewsMounted = false;

function _pnLoadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("load fail: " + src));
    document.head.appendChild(s);
  });
}

// 把 shadowRoot 包装成 paynews 脚本可用的受限 document（屏蔽 location 跳转 / service worker）
function _pnShadowDoc(sr) {
  const real = document;
  const fwd = ["getElementById","querySelector","querySelectorAll","getElementsByClassName","getElementsByTagName","getElementsByTagNameNS","addEventListener","removeEventListener","dispatchEvent"];
  const crt = ["createElement","createElementNS","createTextNode","importNode","createComment"];
  return new Proxy(sr, {
    get(t, p) {
      if (fwd.includes(p)) return t[p] ? t[p].bind(t) : undefined;
      if (crt.includes(p)) return real[p].bind(real);
      if (p === "body") return t;
      if (p === "head") return real.head;
      if (p === "documentElement") return real.documentElement;
      if (p === "title") return real.title;
      if (p in t) return t[p];
      if (p in real) return real[p];
      return undefined;
    },
    set(t, p, v) {
      if (p === "title" || p === "cookie") return true; // 忽略，避免改 tab 标题 / 写 cookie
      t[p] = v; return true;
    }
  });
}

// 安全 location 桩：屏蔽 reload / 跳转（否则会冲走整个工作台）
function _pnLocShim() {
  const real = window.location;
  const base = {
    reload(){}, assign(){}, replace(){},
    href: real.href, search: "", hash: "", origin: real.origin,
    pathname: real.pathname, host: real.host, hostname: real.hostname,
    protocol: real.protocol, port: real.port
  };
  return new Proxy(base, { get(t, p){ return (p in t) ? t[p] : (() => {}); }, set(){ return true; } });
}

// 安全 navigator 桩：屏蔽 service worker 注册（否则会劫持工作台作用域）
function _pnNavShim() {
  const real = navigator;
  const sw = {
    register(){ return Promise.resolve({ unregister(){}, update(){}, installing:null, waiting:null, active:null, addEventListener(){}, removeEventListener(){}, getRegistration(){ return Promise.resolve(undefined); }, ready: Promise.resolve({}) }); },
    addEventListener(){}, removeEventListener(){}, controller: null,
    getRegistrations(){ return Promise.resolve([]); }
  };
  return new Proxy(real, { get(t, p){ if (p === "serviceWorker") return sw; if (p in t) return t[p]; return undefined; } });
}

async function mountPaynews(host) {
  try {
    const sr = host.attachShadow({ mode: "open" });
    // 先放加载占位，避免空白等待
    sr.innerHTML = '<div style="padding:22px;text-align:center;color:#8b8b9e;font-size:14px">📰 新闻加载中…</div>';
    // 4 个资源并行下载：css/html/js（优先走缓存）+ supabase 脚本，避免串行拖慢首屏
    const [css, html, js] = await Promise.all([
      fetch("paynews-app.css?v=" + PAYNEWS_VER, { cache: "force-cache" }).then((r) => r.text()),
      fetch("paynews-app.html?v=" + PAYNEWS_VER, { cache: "force-cache" }).then((r) => r.text()),
      fetch("paynews-app.js?v=" + PAYNEWS_VER, { cache: "force-cache" }).then((r) => r.text()),
      window.supabase ? Promise.resolve() : _pnLoadScript("supabase-umd.js?v=" + PAYNEWS_VER),
    ]);
    sr.innerHTML = "<style>" + css + "</style>" + html;
    const runner = new Function("document", "navigator", "location", js);
    runner(_pnShadowDoc(sr), _pnNavShim(), _pnLocShim());
    try { sr.dispatchEvent(new Event("DOMContentLoaded")); } catch (e) { console.warn("[paynews-embed] DCL:", e); }
  } catch (e) {
    console.error("[paynews-embed] 挂载失败:", e);
    try { host.innerHTML = '<div style="padding:16px;color:#f87171">PayNews 模块加载失败，请刷新重试。</div>'; } catch (e2) {}
  }
}

// 同步嵌入的 paynews 主题到工作台当前主题
function _pnSyncTheme() {
  const host = document.getElementById("paynewsHost");
  if (!host) return;
  host.setAttribute("data-paynews-theme", state.theme === "light" ? "light" : "dark");
}

function ensurePaynewsMounted() {
  const host = document.getElementById("paynewsHost");
  if (!host || _paynewsMounted) return;
  if (host.shadowRoot) { _paynewsMounted = true; return; }
  _paynewsMounted = true;
  mountPaynews(host);
}





/* ---------- 新闻模块：折叠 + 全屏切换 ---------- */
(function initPnHeaderActions() {
  const card = document.querySelector('.news-card[data-module="news"]');
  const enterBtn = document.getElementById("pnFsEnter");
  const exitBtn = document.getElementById("pnFsExit");
  const collapseBtn = document.getElementById("pnCollapse");
  if (!card || !enterBtn) return;

  function pnSetFs(on) {
    card.classList.toggle("pn-fullscreen", on);
    document.documentElement.classList.toggle("pn-fs", on);
    enterBtn.style.display = on ? "none" : "";
    if (exitBtn) exitBtn.style.display = on ? "" : "none";
    if (collapseBtn) collapseBtn.style.display = on ? "none" : "";
  }
  enterBtn.addEventListener("click", () => pnSetFs(true));
  if (exitBtn) exitBtn.addEventListener("click", () => pnSetFs(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") pnSetFs(false); });

  if (collapseBtn) {
    collapseBtn.addEventListener("click", () => {
      const collapsed = card.classList.toggle("collapsed");
      collapseBtn.textContent = collapsed ? "＋ 展开" : "− 收起";
      collapseBtn.title = collapsed ? "展开新闻模块" : "收起新闻模块";
    });
  }
})();

/* =====================================================================
   宠物模块（共享：所有登录用户可操作/可见，数据全局共享）
   - 图片存 Supabase Storage：pet bucket，status/、mood/ 两个路径前缀当文件夹
   - 当前状态/心情 + 切换时间存 pet_state 表（全局单行 id=1）
   - 中文文件名（去扩展名）即枚举值；重名覆盖；支持批量多选
   ===================================================================== */
const STORAGE_BASE = SUPABASE_URL + "/storage/v1";
const PET_BUCKET = "pet";

let petState = { current_status: null, current_status_time: null, current_mood: null, current_mood_time: null, history: [] };
let petStatusImgs = [];   // status/ 下文件名数组（含扩展名）
let petMoodImgs = [];     // mood/ 下文件名数组（含扩展名）

/* 文件名去扩展名作为枚举显示名（如 睡觉.png → 睡觉） */
function petNameLabel(filename) {
  if (!filename) return "";
  return String(filename).replace(/\.[^.]+$/, "");
}
/* 公开访问 URL（bucket 公开，中文路径需逐段编码） */
function petPublicUrl(folder, filename) {
  return STORAGE_BASE + "/object/public/" + PET_BUCKET + "/" +
    encodeURIComponent(folder) + "/" + encodeURIComponent(filename);
}
function fmtPetTime(t) {
  if (!t) return "";
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/* ---------- Storage 操作（文件名全程 ASCII：UUID 存储名 + 中文显示名映射表） ---------- */
async function petStorageUpload(folder, file) {
  const ext = (file.name.lastIndexOf(".") >= 0) ? file.name.slice(file.name.lastIndexOf(".")) : "";
  // Supabase Storage 的 object key 不允许非 ASCII 字符，故 Storage 内只存 UUID 英文名（扩展名保留）
  const storageName = (crypto.randomUUID ? crypto.randomUUID() : ("id" + Date.now() + Math.random().toString(16).slice(2))) + ext;
  const res = await withTimeout(fetch(
    STORAGE_BASE + "/object/" + PET_BUCKET + "/" + encodeURIComponent(folder) + "/" + encodeURIComponent(storageName),
    {
      method: "POST",
      headers: Object.assign({}, API_HEADERS, {
        "Content-Type": file.type || "application/octet-stream",
        "x-upsert": "true", // 重名覆盖
      }),
      body: file,
    }
  ), 30000, "上传宠物图");
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error("上传失败 " + res.status + " " + txt);
  }
  return storageName;
}
function petFileNameOf(list, label) {
  if (!label) return null;
  const it = (list || []).find((x) => x.label === label);
  return it ? it.storage_name : null;
}
function petPublicUrl(folder, storageName) {
  return STORAGE_BASE + "/object/public/" + PET_BUCKET + "/" +
    encodeURIComponent(folder) + "/" + encodeURIComponent(storageName);
}

/* ---------- pet_images 映射表读写（中文显示名 label ⇄ Storage UUID 名 storage_name） ---------- */
async function petImagesList(folder) {
  const res = await withTimeout(fetch(
    REST_BASE + "/pet_images?folder=eq." + encodeURIComponent(folder) + "&select=label,storage_name&order=created_at.asc",
    { headers: API_HEADERS, cache: "no-store" }
  ), 20000, "读取宠物图列表");
  if (!res.ok) throw new Error("列表失败 " + res.status);
  const arr = await res.json();
  return Array.isArray(arr) ? arr : [];
}
async function petImagesUpsert(folder, label, storageName) {
  /* 修复：PATCH 即使 0 行受影响也返回 200 OK，必须以 return=representation 数行数判断是否真命中。
     0 行 = (folder,label) 还不存在 → INSERT；POST 撞 409（唯一索引并发）→ 再 PATCH 兜底一次。 */
  const headRep = Object.assign({}, API_HEADERS, { "Prefer": "return=representation" });
  const chk = await withTimeout(fetch(
    REST_BASE + "/pet_images?folder=eq." + encodeURIComponent(folder) + "&label=eq." + encodeURIComponent(label),
    { method: "PATCH", headers: headRep, body: JSON.stringify({ storage_name: storageName }) }
  ), 15000, "更新图片映射(PATCH)");
  if (chk.ok) {
    let arr = [];
    try { arr = await chk.json(); } catch (e) {}
    if (Array.isArray(arr) && arr.length > 0) return; // 真命中
  }
  // 没命中 → INSERT
  const headMin = Object.assign({}, API_HEADERS, { "Prefer": "return=minimal" });
  const ins = await withTimeout(fetch(REST_BASE + "/pet_images",
    { method: "POST", headers: headMin, body: JSON.stringify([{ folder, label, storage_name: storageName }]) }
  ), 15000, "新增图片映射(POST)");
  if (ins.ok) return;
  // 409 唯一冲突 = 别人刚写入 → 再 PATCH 一次兜底
  if (ins.status === 409) {
    const rep = await withTimeout(fetch(
      REST_BASE + "/pet_images?folder=eq." + encodeURIComponent(folder) + "&label=eq." + encodeURIComponent(label),
      { method: "PATCH", headers: headRep, body: JSON.stringify({ storage_name: storageName }) }
    ), 15000, "并发兜底 PATCH");
    if (rep.ok) return;
  }
  const t = await ins.text().catch(() => "");
  throw new Error("映射失败 " + ins.status + " " + t);
}
async function petImagesDelete(folder, label) {
  const list = await petImagesList(folder).catch(() => []);
  const storageName = petFileNameOf(list, label);
  if (storageName) {
    await withTimeout(fetch(
      STORAGE_BASE + "/object/" + PET_BUCKET + "/" + encodeURIComponent(folder) + "/" + encodeURIComponent(storageName),
      { method: "DELETE", headers: API_HEADERS }
    ), 20000, "删除宠物图文件").catch(() => {});
  }
  await withTimeout(fetch(
    REST_BASE + "/pet_images?folder=eq." + encodeURIComponent(folder) + "&label=eq." + encodeURIComponent(label),
    { method: "DELETE", headers: API_HEADERS }
  ), 15000, "删除图片映射").catch(() => {});
}

/* 仅改 pet_images.label 显示名；Storage 文件名/URL 完全不动（底图不变）。
   若 oldLabel 恰好是当前选中状态/心情，则同步 pet_state.label（切换时间保留）。 */
async function renamePetImage(type, oldLabel, newLabel) {
  newLabel = (newLabel || "").trim();
  if (!newLabel) throw new Error("名称不能为空");
  if (newLabel === oldLabel) return;
  const headRep = Object.assign({}, API_HEADERS, { "Prefer": "return=representation" });
  const res = await withTimeout(fetch(
    REST_BASE + "/pet_images?folder=eq." + encodeURIComponent(type) + "&label=eq." + encodeURIComponent(oldLabel),
    { method: "PATCH", headers: headRep, body: JSON.stringify({ label: newLabel }) }
  ), 15000, "重命名宠物图");
  if (res.ok) {
    let arr = [];
    try { arr = await res.json(); } catch (e) {}
    if (Array.isArray(arr) && arr.length > 0) {
      // 命中：同步 pet_state 当前选中（保留切换时间）
      if (type === "status" && petState.current_status === oldLabel) {
        petState.current_status = newLabel; await savePetState();
      }
      if (type === "mood" && petState.current_mood === oldLabel) {
        petState.current_mood = newLabel; await savePetState();
      }
      if (type === "status") petStatusImgs = await petImagesList("status");
      else petMoodImgs = await petImagesList("mood");
      renderPet();
      return;
    }
  }
  if (res.status === 409) throw new Error("名称「" + newLabel + "」已被占用，换一个");
  const txt = await res.text().catch(() => "");
  throw new Error("重命名失败 " + res.status + " " + txt);
}

/* ---------- pet_state 读写 ---------- */
async function savePetState() {
  const body = {
    id: 1,
    current_status: petState.current_status || null,
    current_status_time: petState.current_status_time || null,
    current_mood: petState.current_mood || null,
    current_mood_time: petState.current_mood_time || null,
    history: petState.history || null,
    updated_at: new Date().toISOString(),
  };
  await withTimeout(fetch(REST_BASE + "/pet_state", {
    method: "POST",
    headers: Object.assign({}, API_HEADERS, { "Prefer": "resolution=merge-duplicates" }),
    body: JSON.stringify(body),
  }), 15000, "保存宠物状态");
}

/* 记录一次状态/心情变化（最近 5 条，新的在前）。只存 类型/名称/时间，不记操作人。 */
function pushPetHistory(kind, label) {
  if (!label) return;
  const entry = { kind: kind, label: label, time: new Date().toISOString() };
  const arr = Array.isArray(petState.history) ? petState.history : [];
  petState.history = [entry].concat(arr).slice(0, 5);
}

/* ---------- 加载 + 渲染 ---------- */
async function loadPet() {
  if (!userId) return;
  let statusOk = true, moodOk = true;
  try { petStatusImgs = await petImagesList("status"); } catch (e) { console.error("[pet] 读状态列表失败", e); petStatusImgs = []; statusOk = false; }
  try { petMoodImgs = await petImagesList("mood"); } catch (e) { console.error("[pet] 读心情列表失败", e); petMoodImgs = []; moodOk = false; }
  try {
    const res = await withTimeout(fetch(REST_BASE + "/pet_state?limit=1", { headers: API_HEADERS, cache: "no-store" }), 15000, "读取宠物状态");
    if (res.ok) { const arr = await res.json(); if (arr && arr[0]) { petState = arr[0]; if (!Array.isArray(petState.history)) petState.history = []; } }
  } catch (e) {}
  /* 自愈：仅当图片列表"成功加载"（statusOk/moodOk）且 pet_state 里的 label 确实不在库中时才清理。
     若列表加载失败（瞬断/网络抖动/CDN 冷启动），绝不清空已选状态——避免误清用户数据、
     把"下拉短暂空白"误当成"枚举被删除"写回库。 */
  let needFix = false;
  if (statusOk && petState.current_status && !petFileNameOf(petStatusImgs, petState.current_status)) {
    petState.current_status = null; petState.current_status_time = null; needFix = true;
  }
  if (moodOk && petState.current_mood && !petFileNameOf(petMoodImgs, petState.current_mood)) {
    petState.current_mood = null; petState.current_mood_time = null; needFix = true;
  }
  if (needFix) {
    try { await savePetState(); console.info("[pet] 自愈：已清理 pet_state 残留 label"); }
    catch (e) { console.error("[pet] 自愈保存失败", e); }
  }
  renderPet();
}

function renderPet() {
  const ss = $("#petStatusSelect"), ms = $("#petMoodSelect");
  if (!ss || !ms) return;
  ss.innerHTML = '<option value="">（未选择）</option>' +
    petStatusImgs.map((x) => '<option value="' + esc(x.label) + '">' + esc(x.label) + "</option>").join("");
  ms.innerHTML = '<option value="">（未选择）</option>' +
    petMoodImgs.map((x) => '<option value="' + esc(x.label) + '">' + esc(x.label) + "</option>").join("");
  ss.value = petState.current_status || "";
  ms.value = petState.current_mood || "";

  const img = $("#petStatusImg"), mood = $("#petMoodImg");
  if (img) {
    const sn = petFileNameOf(petStatusImgs, petState.current_status);
    img.src = sn ? petPublicUrl("status", sn) : "";
  }
  if (mood) {
    const sn = petFileNameOf(petMoodImgs, petState.current_mood);
    mood.src = sn ? petPublicUrl("mood", sn) : "";
  }

  const sm = $("#petStatusMeta"), mm = $("#petMoodMeta");
  if (sm) sm.textContent = "状态：" + (petState.current_status ? petState.current_status : "—") +
    (petState.current_status_time ? " · " + fmtPetTime(petState.current_status_time) : "");
  if (mm) mm.textContent = "心情：" + (petState.current_mood ? petState.current_mood : "—") +
    (petState.current_mood_time ? " · " + fmtPetTime(petState.current_mood_time) : "");

  // 最近变化（最多 5 条，新的在前）
  const hl = $("#petHistoryList");
  if (hl) {
    const hist = Array.isArray(petState.history) ? petState.history : [];
    if (!hist.length) {
      hl.innerHTML = '<li class="pet-history-empty">暂无变化记录</li>';
    } else {
      hl.innerHTML = hist.map((h) => {
        const kind = h.kind === "mood" ? "心情" : "状态";
        return '<li class="pet-hist-item"><span class="pet-hist-kind">' + esc(kind) + '</span>' +
          '<span class="pet-hist-label">' + esc(h.label || "—") + '</span>' +
          '<span class="pet-hist-time">' + (h.time ? fmtPetTime(h.time) : "") + '</span></li>';
      }).join("");
    }
  }
}

/* ---------- 上传 / 切换 / 删除 ---------- */
async function uploadPetImages(type, files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  setStatus("上传中…", "syncing");
  let successCount = 0, failCount = 0, lastErrCode = null, lastErrMsg = null, lastLabel = null;
  for (const f of list) {
    const label = petNameLabel(f.name); // 去扩展名的中文显示名
    try {
      const storageName = await petStorageUpload(type, f);
      await petImagesUpsert(type, label, storageName);
      successCount++;
      lastLabel = label;
    } catch (e) {
      failCount++;
      const m = (e.message || "").match(/^上传失败\s+(\d+)/);
      if (m) lastErrCode = m[1];
      lastErrMsg = e.message || String(e);
      console.error("[pet] 上传失败", f.name, e);
    }
  }
  try {
    if (type === "status") petStatusImgs = await petImagesList("status");
    else petMoodImgs = await petImagesList("mood");
  } catch (e) { console.error("[pet] 刷新列表失败", e); }
  // 当前未选时，自动选中最后上传成功的一张（并记录切换时间 + 历史）
  if (lastLabel) {
    if (type === "status" && !petState.current_status) {
      petState.current_status = lastLabel; petState.current_status_time = new Date().toISOString(); pushPetHistory("status", lastLabel); await savePetState();
    }
    if (type === "mood" && !petState.current_mood) {
      petState.current_mood = lastLabel; petState.current_mood_time = new Date().toISOString(); pushPetHistory("mood", lastLabel); await savePetState();
    }
  }
  renderPet();
  /* 显式报告：成功 / 失败 数字分别说，不再一键"全部成功 ✓"骗人 */
  if (list.length === 1) {
    if (failCount === 0) setStatus("已上传 1 张宠物图：" + (lastLabel || "✓"), "ok");
    else setStatus("上传失败 " + (lastErrCode ? "HTTP " + lastErrCode : "") + " · " + (lastErrMsg || "未知错误"), "err");
  } else {
    if (failCount === 0) setStatus("已上传 " + successCount + " 张宠物图 ✓", "ok");
    else setStatus("成功 " + successCount + " / 失败 " + failCount + " 张 · " + (lastErrCode ? "HTTP " + lastErrCode + " · " : "") + "按 F12 看 Console", "err");
  }
}

async function switchPetStatus(filename) {
  if (filename) { petState.current_status = filename; petState.current_status_time = new Date().toISOString(); pushPetHistory("status", filename); }
  else { petState.current_status = null; petState.current_status_time = null; }
  try {
    await savePetState();
    renderPet();
    setStatus("已切换状态：" + (filename || "（清空）"), "ok");
  } catch (e) {
    console.error("[pet] 切换状态失败", e);
    setStatus("切换状态失败：" + (e && e.message ? e.message : e) + " · 按 F12 看 Console", "err");
    renderPet();
  }
}
async function switchPetMood(filename) {
  if (filename) { petState.current_mood = filename; petState.current_mood_time = new Date().toISOString(); pushPetHistory("mood", filename); }
  else { petState.current_mood = null; petState.current_mood_time = null; }
  try {
    await savePetState();
    renderPet();
    setStatus("已切换心情：" + (filename || "（清空）"), "ok");
  } catch (e) {
    console.error("[pet] 切换心情失败", e);
    setStatus("切换心情失败：" + (e && e.message ? e.message : e) + " · 按 F12 看 Console", "err");
    renderPet();
  }
}
async function deletePetImage(type, filename) {
  if (!filename) return;
  if (!confirm("确定删除「" + filename + "」？该图片将从共享库中移除（当前选中会自动清空）。")) return;
  await petImagesDelete(type, filename);
  if (type === "status" && petState.current_status === filename) {
    petState.current_status = null; petState.current_status_time = null; await savePetState();
  }
  if (type === "mood" && petState.current_mood === filename) {
    petState.current_mood = null; petState.current_mood_time = null; await savePetState();
  }
  if (type === "status") petStatusImgs = await petImagesList("status");
  else petMoodImgs = await petImagesList("mood");
  renderPet();
}

/* 事件绑定 */
(function initPet() {
  const us = $("#petUploadStatusBtn"), um = $("#petUploadMoodBtn");
  const fs = $("#petStatusFile"), fm = $("#petMoodFile");
  if (us && fs) us.addEventListener("click", () => fs.click());
  if (um && fm) um.addEventListener("click", () => fm.click());
  if (fs) fs.addEventListener("change", (e) => { uploadPetImages("status", e.target.files); e.target.value = ""; });
  if (fm) fm.addEventListener("change", (e) => { uploadPetImages("mood", e.target.files); e.target.value = ""; });
  const rf = $("#petRefreshBtn");
  if (rf) rf.addEventListener("click", async () => {
    if (rf.disabled) return;
    const oldLabel = rf.textContent;
    rf.disabled = true; rf.textContent = "⟳ 刷新中…";
    try { await loadPet(); setStatus("宠物已刷新 ✓", "ok"); }
    catch (e) { console.error("[pet] 手动刷新失败", e); setStatus("刷新失败：" + (e && e.message ? e.message : e), "err"); }
    finally { rf.disabled = false; rf.textContent = oldLabel; }
  });
  const ss = $("#petStatusSelect"); if (ss) ss.addEventListener("change", () => switchPetStatus(ss.value || null));
  const ms = $("#petMoodSelect"); if (ms) ms.addEventListener("change", () => switchPetMood(ms.value || null));
  const ds = $("#petDelStatusBtn"); if (ds) ds.addEventListener("click", () => deletePetImage("status", petState.current_status));
  const dm = $("#petDelMoodBtn"); if (dm) dm.addEventListener("click", () => deletePetImage("mood", petState.current_mood));
  const rs = $("#petRenameStatusBtn");
  if (rs) rs.addEventListener("click", () => {
    const old = petState.current_status;
    if (!old) { setStatus("请先在「状态」下拉选中一项再重命名", "err"); return; }
    const nv = window.prompt("重命名状态「" + old + "」为：", old);
    if (nv === null) return;
    const trimmed = nv.trim();
    if (!trimmed) { setStatus("名称不能为空", "err"); return; }
    if (trimmed === old) { setStatus("名称未变化", "syncing"); return; }
    renamePetImage("status", old, trimmed)
      .then(() => setStatus("已重命名「" + old + "」→「" + trimmed + "」✓", "ok"))
      .catch((e) => setStatus("重命名失败：" + (e.message || e), "err"));
  });
  const rm = $("#petRenameMoodBtn");
  if (rm) rm.addEventListener("click", () => {
    const old = petState.current_mood;
    if (!old) { setStatus("请先在「心情」下拉选中一项再重命名", "err"); return; }
    const nv = window.prompt("重命名心情「" + old + "」为：", old);
    if (nv === null) return;
    const trimmed = nv.trim();
    if (!trimmed) { setStatus("名称不能为空", "err"); return; }
    if (trimmed === old) { setStatus("名称未变化", "syncing"); return; }
    renamePetImage("mood", old, trimmed)
      .then(() => setStatus("已重命名「" + old + "」→「" + trimmed + "」✓", "ok"))
      .catch((e) => setStatus("重命名失败：" + (e.message || e), "err"));
  });
})();

/* =====================================================================
   操作员管理（仅超管 · 系统管理 → 操作员管理）
   列表：用户名/姓名/登录状态/最后登录时间/IP；树形勾选配置可见菜单
   ===================================================================== */
const OP_OFFLINE_MS = 5 * 60 * 1000; // 5 分钟无活跃上报判离线

function isOnline(t) {
  if (!t) return false;
  return (Date.now() - new Date(t).getTime()) < OP_OFFLINE_MS;
}

async function loadOperators() {
  const tbody = $("#opList");
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" class="op-empty">加载中…</td></tr>';
  try {
    const url = `${REST_BASE}/users?is_super=eq.false&order=username`;
    const res = await withTimeout(fetch(url, { headers: API_HEADERS, cache: "no-store" }), 20000, "读取操作员");
    if (!res.ok) throw new Error("fetch " + res.status);
    const arr = await res.json();
    if (!Array.isArray(arr) || !arr.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="op-empty">暂无普通操作员</td></tr>';
      return;
    }
    tbody.innerHTML = arr.map((u) => {
      const online = isOnline(u.last_active_time);
      const lastLogin = u.last_login_time ? new Date(u.last_login_time).toLocaleString("zh-CN", { hour12: false }) : "—";
      return `<tr data-user="${esc(u.username)}">` +
        `<td><strong>${esc(u.username)}</strong></td>` +
        `<td>${esc(u.name || "—")}</td>` +
        `<td><span class="op-status ${online ? "online" : "offline"}"></span>${online ? "在线" : "离线"}</td>` +
        `<td class="op-mono">${lastLogin}</td>` +
        `<td class="op-mono">${esc(u.last_login_ip || "—")}</td>` +
        `<td><button type="button" class="text-btn op-edit-btn" data-user="${esc(u.username)}">编辑菜单</button></td>` +
        `</tr>`;
    }).join("");
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="6" class="op-empty">加载失败，请检查网络</td></tr>';
  }
}

/* ---------- 模块权限管理（仅超管） ---------- */
let mpData = null;
async function loadModulePerm() {
  const box = $("#mpTable");
  if (!box) return;
  box.innerHTML = "加载中…";
  try {
    const url = `${REST_BASE}/${TABLE}?select=user_id,name,home_modules&order=user_id`;
    const res = await withTimeout(fetch(url, { headers: API_HEADERS, cache: "no-store" }), 20000, "读取模块权限");
    if (!res.ok) throw new Error("fetch " + res.status);
    const arr = await res.json();
    if (!Array.isArray(arr) || !arr.length) { box.innerHTML = "暂无用户数据"; return; }
    mpData = arr;
    renderModulePermTable(arr);
  } catch (e) {
    box.innerHTML = "加载失败，请检查网络";
  }
}
function renderModulePermTable(arr) {
  const box = $("#mpTable"); if (!box) return;
  const mods = MODULE_REGISTRY;
  let html = '<table class="mp-grid"><thead><tr><th>用户</th><th>姓名</th>';
  mods.forEach((m) => { html += `<th class="mp-mod">${m.label}</th>`; });
  html += '</tr></thead><tbody>';
  arr.forEach((u) => {
    const hm = normalizeHomeModules(u.home_modules);
    html += `<tr data-uid="${esc(u.user_id)}"><td><strong>${esc(u.user_id)}</strong></td><td>${esc(u.name || "—")}</td>`;
    mods.forEach((m) => {
      const item = hm.find((x) => x.id === m.id) || {};
      const on = item.enabled !== false;
      html += `<td class="mp-cell"><input type="checkbox" class="mp-chk" data-uid="${esc(u.user_id)}" data-mod="${m.id}" ${on ? "checked" : ""} /></td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  box.innerHTML = html;
}
async function saveModulePerm() {
  if (!mpData) { setStatus("请先加载列表", "warn"); return; }
  setStatus("保存权限中…", "syncing");
  try {
    const checks = document.querySelectorAll("#mpTable .mp-chk");
    const byUser = {};
    mpData.forEach((u) => { byUser[u.user_id] = normalizeHomeModules(u.home_modules); });
    checks.forEach((cb) => {
      const uid = cb.dataset.uid, mod = cb.dataset.mod;
      const hm = byUser[uid];
      const item = hm.find((x) => x.id === mod);
      if (item) item.enabled = cb.checked;
    });
    for (const uid in byUser) {
      await withTimeout(fetch(`${REST_BASE}/${TABLE}?user_id=eq.${encodeURIComponent(uid)}`, {
        method: "PATCH",
        headers: Object.assign({}, API_HEADERS, { "Prefer": "return=minimal" }),
        body: JSON.stringify({ home_modules: byUser[uid] }),
      }), 15000, "保存" + uid);
    }
    setStatus("模块权限已保存 ✓", "ok");
  } catch (e) {
    setStatus("保存失败 · 请检查网络", "err");
  }
}
const mpRefreshEl = document.getElementById("mpRefresh");
if (mpRefreshEl) mpRefreshEl.addEventListener("click", loadModulePerm);
const mpSaveEl = document.getElementById("mpSave");
if (mpSaveEl) mpSaveEl.addEventListener("click", saveModulePerm);

/* ---------- 树形勾选配置菜单权限 ---------- */
let opEditUser = null;       // 正在编辑的操作员用户名
let opEditUserMenus = null;  // 该用户当前可见菜单（null=未配置）

async function openOpMenuModal(username) {
  opEditUser = username;
  opEditUserMenus = null;
  try {
    const url = `${REST_BASE}/user_menu?user_id=eq.${encodeURIComponent(username)}&select=menu_id`;
    const res = await withTimeout(fetch(url, { headers: API_HEADERS, cache: "no-store" }), 15000, "读取权限");
    if (res.ok) {
      const arr = await res.json();
      /* 查询成功即视为已配置（含空数组=全不选），与「从未配置(null)」区分 */
      if (Array.isArray(arr)) opEditUserMenus = arr.map((r) => r.menu_id);
    }
  } catch (e) {}
  $("#opModalTitle").textContent = "配置菜单权限 · " + username;
  buildOpTree();
  $("#opMenuModal").hidden = false;
}

function buildOpTree() {
  const box = $("#opTree");
  if (!box) return;
  const configured = opEditUserMenus !== null; // 未配置(null)=默认全选；已配置按记录勾选（空数组=全不选）
  const html = MENUS.map((m) => {
    if (m.children) {
      const kidsHtml = m.children.map((c) => {
        const on = configured ? opEditUserMenus.indexOf(c.id) !== -1 : true;
        return `<label class="tree-leaf"><input type="checkbox" value="${c.id}" ${on ? "checked" : ""} /><span>${c.label}</span></label>`;
      }).join("");
      return `<div class="tree-group" data-group="${m.id}">` +
        `<label class="tree-parent"><input type="checkbox" class="group-check" /><span>${m.label}</span></label>` +
        `<div class="tree-children">${kidsHtml}</div></div>`;
    }
    const on = configured ? opEditUserMenus.indexOf(m.id) !== -1 : true;
    return `<label class="tree-leaf tree-root"><input type="checkbox" value="${m.id}" ${on ? "checked" : ""} /><span>${m.label}</span></label>`;
  }).join("");
  box.innerHTML = html;
  box.querySelectorAll(".tree-group").forEach((g) => syncGroupState(g));
}

function syncGroupState(g) {
  const cbs = g.querySelectorAll(".tree-children input[type=checkbox]");
  const parent = g.querySelector(".group-check");
  const total = cbs.length;
  const on = Array.prototype.filter.call(cbs, (c) => c.checked).length;
  parent.checked = on > 0;
  parent.indeterminate = on > 0 && on < total;
}

const opTreeEl = document.getElementById("opTree");
if (opTreeEl) opTreeEl.addEventListener("change", (e) => {
  const cb = e.target;
  const g = cb.closest(".tree-group");
  if (cb.classList.contains("group-check") && g) {
    g.querySelectorAll(".tree-children input[type=checkbox]").forEach((c) => { c.checked = cb.checked; });
  } else if (g) {
    syncGroupState(g);
  }
});

async function saveOpMenus() {
  if (!opEditUser) return;
  const checked = [];
  document.querySelectorAll("#opTree input[type=checkbox]:checked").forEach((cb) => { if (cb.value) checked.push(cb.value); });
  setStatus("保存权限中…", "syncing");
  try {
    /* 1. 清空旧记录 */
    await withTimeout(fetch(`${REST_BASE}/user_menu?user_id=eq.${encodeURIComponent(opEditUser)}`, {
      method: "DELETE",
      headers: Object.assign({}, API_HEADERS, { "Prefer": "return=minimal" }),
    }), 15000, "清除旧权限");
    /* 2. 写入新记录（勾选的叶子 menu_id） */
    if (checked.length) {
      const rows = checked.map((menu_id) => ({ user_id: opEditUser, menu_id }));
      await withTimeout(fetch(`${REST_BASE}/user_menu`, {
        method: "POST",
        headers: Object.assign({}, API_HEADERS, { "Prefer": "resolution=merge-duplicates" }),
        body: JSON.stringify(rows),
      }), 15000, "写入权限");
    }
    /* 3. 标记已配置（区分「配置过但全不选」与「从未配置=全量」） */
    await withTimeout(fetch(`${REST_BASE}/users?username=eq.${encodeURIComponent(opEditUser)}`, {
      method: "PATCH",
      headers: Object.assign({}, API_HEADERS, { "Prefer": "return=minimal" }),
      body: JSON.stringify({ menu_configured: true }),
    }), 15000, "标记已配置");
    closeOpMenuModal();
    setStatus("菜单权限已保存 ✓", "ok");
  } catch (e) {
    setStatus("保存失败 · 请检查网络", "err");
  }
}

function closeOpMenuModal() {
  const m = $("#opMenuModal");
  if (m) m.hidden = true;
  opEditUser = null; opEditUserMenus = null;
}

/* 事件绑定：编辑按钮（事件委托，列表刷新后仍有效） */
const opListEl = document.getElementById("opList");
if (opListEl) opListEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".op-edit-btn");
  if (btn && btn.dataset.user) openOpMenuModal(btn.dataset.user);
});
const opModalEl = document.getElementById("opMenuModal");
if (opModalEl) {
  opModalEl.addEventListener("click", (e) => { if (e.target === opModalEl) closeOpMenuModal(); });
  const oc = document.getElementById("opMenuClose"); if (oc) oc.addEventListener("click", closeOpMenuModal);
  const occ = document.getElementById("opMenuCancel"); if (occ) occ.addEventListener("click", closeOpMenuModal);
  const os = document.getElementById("opMenuSave"); if (os) os.addEventListener("click", saveOpMenus);
}
const opRefreshEl = document.getElementById("opRefresh");
if (opRefreshEl) opRefreshEl.addEventListener("click", loadOperators);
