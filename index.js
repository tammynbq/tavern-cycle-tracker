// 生理紀錄小幫手 Cycle Tracker
// 讓 AI 透過隱藏標籤記錄經期、親密、症狀、心情等真實紀錄，並把摘要注入提示詞。
// 資料依角色卡分開保存於 extension_settings。

const MODULE = 'cycleTracker';
const PROMPT_KEY = 'cycle_tracker';
const LOG_PREFIX = '[CycleTracker]';

const BUILTIN_TYPES = {
    period_start: '經期開始',
    period_end: '經期結束',
    sex: '親密',
    symptom: '症狀',
    mood: '心情',
};

const DEFAULT_SETTINGS = {
    enabled: true,
    position: 1, // 0 = 系統提示內, 1 = 聊天記錄中（依深度）
    depth: 2,
    recentCount: 15,
    recentDays: 60,
    defaultCycle: 28,
    customTypes: '',
    data: {},
};

const JOURNAL_LIMIT = 300;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const TAG_RE = /<ct-(log|memo|del)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/ct-\1\s*>|>)/gi;
const ATTR_RE = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/g;

const ctx = () => SillyTavern.getContext();

// ---------- 設定與資料 ----------

function settings() {
    const all = ctx().extensionSettings;
    all[MODULE] ??= {};
    const s = all[MODULE];
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = structuredClone(v);
    }
    return s;
}

function save() {
    ctx().saveSettingsDebounced();
}

function charKey() {
    const c = ctx();
    if (c.groupId) return `group:${c.groupId}`;
    if (c.characterId === undefined || c.characterId === null) return null;
    return c.characters[c.characterId]?.avatar ?? null;
}

function charName() {
    const c = ctx();
    if (c.groupId) return c.groups.find(g => g.id == c.groupId)?.name ?? '群組';
    return c.characters[c.characterId]?.name ?? '';
}

function getState(key = charKey()) {
    if (!key) return null;
    const s = settings();
    s.data[key] ??= { events: [], memos: [], seq: 0, journal: {} };
    const st = s.data[key];
    st.events ??= [];
    st.memos ??= [];
    st.journal ??= {};
    st.seq ??= 0;
    return st;
}

function allTypes() {
    const types = { ...BUILTIN_TYPES };
    for (const line of settings().customTypes.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const [k, ...rest] = t.split('=');
        const key = k.trim();
        if (key) types[key] = rest.join('=').trim() || key;
    }
    return types;
}

function typeLabel(type) {
    return allTypes()[type] ?? type;
}

// ---------- 日期工具（一律使用本地時間） ----------

function fmt(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function today() {
    return fmt(new Date());
}

function toUTC(str) {
    const [y, m, d] = str.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
}

function diffDays(a, b) {
    return Math.round((toUTC(b) - toUTC(a)) / 86400000);
}

function addDays(str, n) {
    const d = new Date(toUTC(str) + n * 86400000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function shortDate(str) {
    return str.slice(0, 4) === today().slice(0, 4) ? str.slice(5) : str;
}

function normalizeDate(raw) {
    const t = today();
    if (!raw) return t;
    const v = String(raw).trim();
    if (['今天', 'today'].includes(v)) return t;
    if (['昨天', 'yesterday'].includes(v)) return addDays(t, -1);
    if (v === '前天') return addDays(t, -2);
    let m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (m) return fmt(new Date(+m[1], +m[2] - 1, +m[3]));
    m = v.match(/^(\d{1,2})[-/.](\d{1,2})$/);
    if (m) return fmt(new Date(+t.slice(0, 4), +m[1] - 1, +m[2]));
    return t;
}

// ---------- 標籤解析與套用 ----------

function parseAttrs(str) {
    const out = {};
    for (const m of str.matchAll(ATTR_RE)) {
        out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
    }
    return out;
}

function parseTags(text) {
    const ops = [];
    const stripped = String(text ?? '').replace(TAG_RE, (_, kind, attrs, body) => {
        ops.push({ kind: kind.toLowerCase(), attrs: parseAttrs(attrs ?? ''), body: (body ?? '').trim() });
        return '';
    });
    return { ops, text: stripped.replace(/\n{3,}/g, '\n\n').trim() };
}

function nextId(state, prefix) {
    state.seq += 1;
    return `${prefix}${state.seq}`;
}

function applyOps(state, ops) {
    const undo = [];
    for (const op of ops) {
        try {
            if (op.kind === 'log') applyLog(state, op, undo);
            else if (op.kind === 'memo') applyMemo(state, op, undo);
            else if (op.kind === 'del') applyDel(state, op, undo);
        } catch (err) {
            console.warn(LOG_PREFIX, 'failed to apply op', op, err);
        }
    }
    return undo;
}

function applyLog(state, op, undo) {
    const id = op.attrs.id;
    const existing = id && state.events.find(e => e.id === id);
    if (existing) {
        undo.push({ k: 'restoreEvent', item: structuredClone(existing) });
        if (op.attrs.type) existing.type = op.attrs.type;
        if (op.attrs.date) existing.date = normalizeDate(op.attrs.date);
        if (op.body) existing.note = op.body;
        return;
    }
    // 重新套用時沿用第一次分配的 id，讓後續訊息的參照保持有效
    const newId = op.assigned && !state.events.some(e => e.id === op.assigned) ? op.assigned : nextId(state, 'e');
    op.assigned = newId;
    state.events.push({
        id: newId,
        type: op.attrs.type || 'note',
        date: normalizeDate(op.attrs.date),
        note: op.body,
        by: 'ai',
    });
    undo.push({ k: 'rmEvent', id: newId });
}

function applyMemo(state, op, undo) {
    const id = op.attrs.id;
    const existing = id && state.memos.find(m => m.id === id);
    if (existing) {
        undo.push({ k: 'restoreMemo', item: structuredClone(existing) });
        if (op.body) existing.text = op.body;
        existing.updated = today();
        return;
    }
    if (!op.body) return;
    const newId = op.assigned && !state.memos.some(m => m.id === op.assigned) ? op.assigned : nextId(state, 'm');
    op.assigned = newId;
    state.memos.push({ id: newId, text: op.body, updated: today() });
    undo.push({ k: 'rmMemo', id: newId });
}

function applyDel(state, op, undo) {
    const id = op.attrs.id;
    if (!id) return;
    const list = id.startsWith('m') ? state.memos : state.events;
    const idx = list.findIndex(x => x.id === id);
    if (idx < 0) return;
    const [item] = list.splice(idx, 1);
    undo.push({ k: id.startsWith('m') ? 'restoreMemo' : 'restoreEvent', item });
}

function rollback(state, src) {
    const undo = state.journal[src];
    if (!undo) return;
    for (const u of [...undo].reverse()) {
        if (u.k === 'rmEvent') state.events = state.events.filter(e => e.id !== u.id);
        else if (u.k === 'rmMemo') state.memos = state.memos.filter(m => m.id !== u.id);
        else if (u.k === 'restoreEvent') upsert(state.events, u.item);
        else if (u.k === 'restoreMemo') upsert(state.memos, u.item);
    }
    delete state.journal[src];
}

function upsert(list, item) {
    const idx = list.findIndex(x => x.id === item.id);
    if (idx >= 0) list[idx] = item;
    else list.push(item);
}

function record(state, src, undo) {
    if (!undo.length) return;
    state.journal[src] = undo;
    const keys = Object.keys(state.journal);
    for (const k of keys.slice(0, Math.max(0, keys.length - JOURNAL_LIMIT))) delete state.journal[k];
}

function srcKey(mesId) {
    return `${ctx().getCurrentChatId()}#${mesId}`;
}

function setMessageOps(mesId, msg, ops) {
    msg.extra ??= {};
    if (ops.length) msg.extra.ctk_ops = ops;
    else delete msg.extra.ctk_ops;
    // 同步到目前 swipe，切換 swipe 時才能還原
    const sw = msg.swipe_info?.[msg.swipe_id];
    if (Array.isArray(msg.swipes) && typeof msg.swipe_id === 'number') {
        msg.swipes[msg.swipe_id] = msg.mes;
        if (sw && typeof sw === 'object') sw.extra = structuredClone(msg.extra);
    }
}

// ---------- 事件處理 ----------

async function processMessage(mesId, { mergeExisting }) {
    const s = settings();
    if (!s.enabled) return;
    const c = ctx();
    const msg = c.chat[mesId];
    if (!msg || msg.is_user || msg.is_system) return;
    const state = getState();
    if (!state) return;

    const { ops: newOps, text } = parseTags(msg.mes);
    if (mergeExisting && !newOps.length) return;

    const src = srcKey(mesId);
    rollback(state, src);
    const ops = [...(mergeExisting ? msg.extra?.ctk_ops ?? [] : []), ...newOps];
    record(state, src, applyOps(state, ops));

    if (newOps.length) {
        msg.mes = text;
        setMessageOps(mesId, msg, ops);
        c.updateMessageBlock(mesId, msg);
        await c.saveChat();
        toastr.info(describeOps(newOps), '生理紀錄已更新', { timeOut: 2500 });
    } else if (msg.extra?.ctk_ops) {
        setMessageOps(mesId, msg, []);
    }
    afterChange();
}

function describeOps(ops) {
    return ops.map(op => {
        if (op.kind === 'log') return `${op.attrs.id ? '修改' : '記錄'} ${typeLabel(op.attrs.type ?? '')} ${op.body}`.trim();
        if (op.kind === 'memo') return `${op.attrs.id ? '修改' : '新增'}備忘：${op.body}`;
        return `刪除 ${op.attrs.id}`;
    }).join('\n');
}

function onSwiped(mesId) {
    if (!settings().enabled) return;
    const msg = ctx().chat[mesId];
    const state = getState();
    if (!msg || !state) return;
    const src = srcKey(mesId);
    rollback(state, src);
    const ops = msg.extra?.ctk_ops;
    if (Array.isArray(ops) && ops.length) record(state, src, applyOps(state, ops));
    afterChange();
}

function onDeleted(newLength) {
    const state = getState();
    if (!state) return;
    const chatId = ctx().getCurrentChatId();
    const stale = Object.keys(state.journal)
        .map(k => [k, k.lastIndexOf('#')])
        .filter(([k, i]) => k.slice(0, i) === chatId && Number(k.slice(i + 1)) >= newLength)
        .sort((a, b) => Number(b[0].slice(b[1] + 1)) - Number(a[0].slice(a[1] + 1)));
    if (!stale.length) return;
    for (const [k] of stale) rollback(state, k);
    afterChange();
}

function afterChange() {
    save();
    updatePrompt();
    renderLists();
}

// ---------- 摘要與提示詞 ----------

function sortedEvents(state) {
    return [...state.events].sort((a, b) => (a.date === b.date ? (a.id > b.id ? 1 : -1) : a.date > b.date ? 1 : -1));
}

const DEFAULT_PERIOD_LEN = 5;

// 統計週期：每次經期的範圍、平均週期與經期天數
function computeCycle(state) {
    const t = today();
    const starts = state.events.filter(e => e.type === 'period_start').map(e => e.date).sort();
    const ends = state.events.filter(e => e.type === 'period_end').map(e => e.date).sort();
    if (!starts.length) return null;

    const cycles = [];
    for (let i = 1; i < starts.length; i++) {
        const d = diffDays(starts[i - 1], starts[i]);
        if (d >= 15 && d <= 60) cycles.push(d);
    }
    const recent = cycles.slice(-6);
    const avg = recent.length ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : null;
    const cycleLen = avg ?? (Number(settings().defaultCycle) || 28);

    const ranges = starts.map((start, i) => {
        const nextStart = starts[i + 1];
        const end = ends.find(e => e >= start && diffDays(start, e) <= 14 && (!nextStart || e < nextStart));
        return { start, end: end ?? null };
    });
    const known = ranges.filter(r => r.end).slice(-6).map(r => diffDays(r.start, r.end) + 1);
    const periodLen = known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : DEFAULT_PERIOD_LEN;
    for (const r of ranges) {
        if (r.end) continue;
        // 沒記錄結束：最近一次且仍在經期內就畫到今天，否則以平均天數估計
        const ongoing = r === ranges[ranges.length - 1] && diffDays(r.start, t) < 10;
        r.estEnd = ongoing ? (diffDays(r.start, t) + 1 > periodLen ? t : addDays(r.start, periodLen - 1)) : addDays(r.start, periodLen - 1);
    }
    return { starts, ends, ranges, recent, avg, cycleLen, periodLen, lastStart: starts[starts.length - 1] };
}

function periodSummary(state) {
    const t = today();
    const cyc = computeCycle(state);
    if (!cyc) return '經期：尚無紀錄';
    const { lastStart, recent, avg, cycleLen } = cyc;

    const lines = [];
    const end = cyc.ranges[cyc.ranges.length - 1].end;
    const day = diffDays(lastStart, t) + 1;
    if (end) {
        lines.push(`最近一次 ${shortDate(lastStart)} 開始、${shortDate(end)} 結束（${diffDays(lastStart, end) + 1} 天）`);
    } else if (day <= 10) {
        lines.push(`經期中，${shortDate(lastStart)} 開始，今天第 ${day} 天`);
    } else {
        lines.push(`最近一次 ${shortDate(lastStart)} 開始（未記錄結束）`);
    }
    lines.push(`目前週期第 ${day} 天`);

    const next = addDays(lastStart, cycleLen);
    const left = diffDays(t, next);
    const basis = avg ? `平均週期 ${avg} 天（${recent.length} 次）` : `資料不足，以 ${cycleLen} 天估計`;
    lines.push(`${basis}，預計下次約 ${shortDate(next)}（${left >= 0 ? `還有 ${left} 天` : `已晚 ${-left} 天`}）`);
    const ovu = addDays(next, -14);
    lines.push(`排卵期估計 ${shortDate(addDays(ovu, -5))}～${shortDate(addDays(ovu, 1))}`);
    return `經期：${lines.join('；')}`;
}

function sexSummary(state) {
    const t = today();
    const month = t.slice(0, 7);
    const list = state.events.filter(e => e.type === 'sex');
    if (!list.length) return null;
    const thisMonth = list.filter(e => e.date.startsWith(month)).length;
    const last30 = list.filter(e => diffDays(e.date, t) >= 0 && diffDays(e.date, t) < 30).length;
    const last = list.map(e => e.date).sort().pop();
    return `親密：本月 ${thisMonth} 次、近30天 ${last30} 次，最近一次 ${shortDate(last)}`;
}

function buildPrompt() {
    const s = settings();
    const state = getState();
    if (!state) return '';
    const c = ctx();
    const user = c.name1 || '使用者';
    const t = today();
    const types = allTypes();

    const out = [];
    out.push(`[生理紀錄｜${user}的真實紀錄]`);
    out.push(`今天：${t}（週${WEEKDAYS[new Date().getDay()]}）`);
    out.push(periodSummary(state));
    const sex = sexSummary(state);
    if (sex) out.push(sex);

    const recent = sortedEvents(state)
        .filter(e => diffDays(e.date, t) <= Number(s.recentDays))
        .slice(-Number(s.recentCount));
    if (recent.length) {
        out.push('最近紀錄：');
        for (const e of recent) out.push(`${e.id} ${shortDate(e.date)} ${typeLabel(e.type)}${e.note ? `：${e.note}` : ''}`);
    }
    if (state.memos.length) {
        out.push('你的備忘：');
        for (const m of state.memos) out.push(`${m.id} ${m.text}`);
    }

    const typeList = Object.entries(types).map(([k, v]) => `${k}(${v})`).join(' ');
    out.push(
        `【記錄方式】${user}提到可記錄的真實事件時，在回覆最後加上標籤（${user}看不到）：`,
        '新增 <ct-log type="類型" date="YYYY-MM-DD">簡短備註</ct-log>',
        `類型：${typeList}`,
        '修改 <ct-log id="e1" date="..">..</ct-log>；刪除 <ct-del id="e1"/>',
        '你想記住的事：<ct-memo>內容</ct-memo>；修改 <ct-memo id="m1">..</ct-memo>；刪除 <ct-del id="m1"/>',
        '只記確定的事，已記過的不要重複。',
    );
    return out.join('\n');
}

function updatePrompt() {
    const s = settings();
    const c = ctx();
    const value = s.enabled && charKey() ? buildPrompt() : '';
    c.setExtensionPrompt(PROMPT_KEY, value, Number(s.position), Number(s.depth), false, 0);
}

// ---------- 介面 ----------

function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const PANEL_HTML = `
<div id="ctk_settings" class="ctk">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>生理紀錄小幫手</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label class="checkbox_label"><input id="ctk_enabled" type="checkbox"> 啟用</label>
      <div class="ctk-char">目前角色：<span id="ctk_char">—</span></div>

      <h4>月曆</h4>
      <div class="ctk-cal-nav">
        <i id="ctk_cal_prev" class="fa-solid fa-chevron-left" title="上個月"></i>
        <span id="ctk_cal_title"></span>
        <i id="ctk_cal_next" class="fa-solid fa-chevron-right" title="下個月"></i>
        <div id="ctk_cal_today" class="menu_button">今天</div>
      </div>
      <div id="ctk_calendar" class="ctk-cal"></div>
      <div class="ctk-legend">
        <span><i class="ctk-sw period"></i>經期</span>
        <span><i class="ctk-sw period-est"></i>經期（推估）</span>
        <span><i class="ctk-sw period-pred"></i>預測經期</span>
        <span><i class="ctk-sw fertile"></i>排卵期</span>
        <span><i class="ctk-sw ovulation"></i>排卵日</span>
      </div>
      <div id="ctk_day_detail" class="ctk-day-detail"></div>

      <h4>新增／修改紀錄</h4>
      <div class="ctk-row">
        <select id="ctk_type" class="text_pole"></select>
        <input id="ctk_date" type="date" class="text_pole">
      </div>
      <input id="ctk_note" class="text_pole" placeholder="備註（可留空）">
      <div class="ctk-row">
        <div id="ctk_save_event" class="menu_button">新增紀錄</div>
        <div id="ctk_cancel_event" class="menu_button ctk-hidden">取消修改</div>
      </div>
      <div id="ctk_events" class="ctk-list"></div>

      <h4>AI 的備忘</h4>
      <textarea id="ctk_memo_text" class="text_pole" rows="2" placeholder="新增備忘"></textarea>
      <div class="ctk-row">
        <div id="ctk_save_memo" class="menu_button">新增備忘</div>
        <div id="ctk_cancel_memo" class="menu_button ctk-hidden">取消修改</div>
      </div>
      <div id="ctk_memos" class="ctk-list"></div>

      <h4>設定</h4>
      <label>注入位置
        <select id="ctk_position" class="text_pole">
          <option value="0">系統提示內</option>
          <option value="1">聊天記錄中（依深度）</option>
        </select>
      </label>
      <div class="ctk-row">
        <label>深度 <input id="ctk_depth" type="number" min="0" max="99" class="text_pole"></label>
        <label>最多列出幾筆 <input id="ctk_recent_count" type="number" min="0" max="100" class="text_pole"></label>
      </div>
      <div class="ctk-row">
        <label>只列出近幾天 <input id="ctk_recent_days" type="number" min="1" max="3650" class="text_pole"></label>
        <label>預設週期天數 <input id="ctk_default_cycle" type="number" min="15" max="60" class="text_pole"></label>
      </div>
      <label>自訂類型（每行一個，格式：代號=名稱，例如 <code>pill=避孕藥</code>）
        <textarea id="ctk_custom_types" class="text_pole" rows="3"></textarea>
      </label>
      <div class="ctk-row">
        <div id="ctk_preview" class="menu_button">預覽注入內容</div>
        <div id="ctk_export" class="menu_button">匯出</div>
        <div id="ctk_import" class="menu_button">匯入</div>
        <input id="ctk_import_file" type="file" accept=".json,application/json" hidden>
      </div>
      <pre id="ctk_preview_box" class="ctk-preview ctk-hidden"></pre>
    </div>
  </div>
</div>`;

let editingEvent = null;
let editingMemo = null;
let calMonth = null; // { y, m }，m 為 0–11
let selectedDay = null;

const TYPE_ICONS = { sex: '❤️', symptom: '🤕', mood: '💭' };

function markRange(map, from, to, key) {
    for (let d = from; d <= to; d = addDays(d, 1)) {
        map[d] ??= {};
        map[d][key] = true;
    }
}

// 算出每一天的經期／預測／排卵期狀態
function buildDayMap(state) {
    const map = {};
    const cyc = computeCycle(state);
    if (cyc) {
        for (const r of cyc.ranges) {
            if (r.end) markRange(map, r.start, r.end, 'period');
            else markRange(map, r.start, r.estEnd, 'periodEst');
        }
        const fertile = ovu => {
            markRange(map, addDays(ovu, -5), addDays(ovu, 1), 'fertile');
            markRange(map, ovu, ovu, 'ovulation');
        };
        for (let i = 1; i < cyc.starts.length; i++) {
            if (diffDays(cyc.starts[i - 1], cyc.starts[i]) >= 15) fertile(addDays(cyc.starts[i], -14));
        }
        for (let k = 1; k <= 3; k++) {
            const start = addDays(cyc.lastStart, k * cyc.cycleLen);
            markRange(map, start, addDays(start, cyc.periodLen - 1), 'pred');
            fertile(addDays(start, -14));
        }
    }
    for (const e of state.events) {
        map[e.date] ??= {};
        (map[e.date].events ??= []).push(e);
    }
    return map;
}

function dayInfoText(info) {
    if (!info) return '';
    const tags = [];
    if (info.period) tags.push('經期');
    else if (info.periodEst) tags.push('經期（推估）');
    else if (info.pred) tags.push('預測經期');
    if (info.ovulation) tags.push('預估排卵日');
    else if (info.fertile) tags.push('排卵期');
    return tags.join('・');
}

function renderCalendar(state) {
    const t = today();
    calMonth ??= { y: +t.slice(0, 4), m: +t.slice(5, 7) - 1 };
    const { y, m } = calMonth;
    $('#ctk_cal_title').text(`${y} 年 ${m + 1} 月`);

    const map = state ? buildDayMap(state) : {};
    const first = new Date(y, m, 1);
    const days = new Date(y, m + 1, 0).getDate();
    const cells = WEEKDAYS.map(w => `<div class="ctk-cal-head">${w}</div>`);
    for (let i = 0; i < first.getDay(); i++) cells.push('<div class="ctk-cal-blank"></div>');
    for (let d = 1; d <= days; d++) {
        const date = fmt(new Date(y, m, d));
        const info = map[date] ?? {};
        const cls = ['ctk-day'];
        if (info.period) cls.push('period');
        else if (info.periodEst) cls.push('period-est');
        else if (info.pred) cls.push('period-pred');
        if (info.fertile && !info.period && !info.periodEst) cls.push('fertile');
        if (info.ovulation) cls.push('ovulation');
        if (date === t) cls.push('today');
        if (date === selectedDay) cls.push('selected');
        const icons = [...new Set((info.events ?? []).map(e => TYPE_ICONS[e.type]).filter(Boolean))];
        const others = (info.events ?? []).filter(e => !TYPE_ICONS[e.type] && !e.type.startsWith('period_')).length;
        const marks = icons.slice(0, 2).join('') + (icons.length > 2 || others ? '•' : '');
        cells.push(`<div class="${cls.join(' ')}" data-date="${date}"><span class="ctk-num">${d}</span><span class="ctk-marks">${marks}</span></div>`);
    }
    $('#ctk_calendar').html(cells.join(''));
    renderDayDetail(state, map);
}

function eventItemHtml(e) {
    return `
      <div class="ctk-item" data-id="${esc(e.id)}">
        <span class="ctk-meta">${esc(e.date)} · ${esc(typeLabel(e.type))}${e.by === 'ai' ? ' · AI' : ''}</span>
        <span class="ctk-text">${esc(e.note)}</span>
        <span class="ctk-actions">
          <i class="fa-solid fa-pen ctk-edit-event" title="修改"></i>
          <i class="fa-solid fa-trash ctk-del-event" title="刪除"></i>
        </span>
      </div>`;
}

function renderDayDetail(state, map) {
    const box = $('#ctk_day_detail');
    if (!selectedDay || !state) return box.empty();
    const info = map[selectedDay];
    const events = (info?.events ?? []).slice().sort((a, b) => (a.id > b.id ? 1 : -1));
    const status = dayInfoText(info);
    box.html(`
      <div class="ctk-day-title">${esc(selectedDay)}（週${WEEKDAYS[new Date(toUTC(selectedDay)).getUTCDay()]}）${status ? ` · ${esc(status)}` : ''}</div>
      ${events.length ? events.map(eventItemHtml).join('') : '<div class="ctk-empty">這天沒有紀錄，可以在下面新增</div>'}`);
}

function renderTypeOptions() {
    const sel = $('#ctk_type');
    const cur = sel.val();
    sel.empty();
    for (const [k, v] of Object.entries(allTypes())) sel.append(`<option value="${esc(k)}">${esc(v)}</option>`);
    if (cur) sel.val(cur);
}

function renderLists() {
    if (!$('#ctk_settings').length) return;
    const key = charKey();
    $('#ctk_char').text(key ? charName() : '（未選擇角色）');
    const state = getState(key);
    const events = state ? sortedEvents(state).reverse() : [];
    const memos = state ? state.memos : [];

    $('#ctk_events').html(events.length ? events.map(eventItemHtml).join('') : '<div class="ctk-empty">還沒有紀錄</div>');
    renderCalendar(state);

    $('#ctk_memos').html(memos.length ? memos.map(m => `
      <div class="ctk-item" data-id="${esc(m.id)}">
        <span class="ctk-meta">${esc(m.id)} · ${esc(m.updated ?? '')}</span>
        <span class="ctk-text">${esc(m.text)}</span>
        <span class="ctk-actions">
          <i class="fa-solid fa-pen ctk-edit-memo" title="修改"></i>
          <i class="fa-solid fa-trash ctk-del-memo" title="刪除"></i>
        </span>
      </div>`).join('') : '<div class="ctk-empty">還沒有備忘</div>');

    if (!$('#ctk_preview_box').hasClass('ctk-hidden')) $('#ctk_preview_box').text(buildPrompt());
}

function resetEventForm() {
    editingEvent = null;
    $('#ctk_date').val(today());
    $('#ctk_note').val('');
    $('#ctk_save_event').text('新增紀錄');
    $('#ctk_cancel_event').addClass('ctk-hidden');
}

function resetMemoForm() {
    editingMemo = null;
    $('#ctk_memo_text').val('');
    $('#ctk_save_memo').text('新增備忘');
    $('#ctk_cancel_memo').addClass('ctk-hidden');
}

async function confirmDelete(text) {
    const c = ctx();
    const res = await c.callGenericPopup(`確定刪除？<br><small>${esc(text)}</small>`, c.POPUP_TYPE.CONFIRM);
    return Boolean(res);
}

function bindPanel() {
    const s = settings();
    $('#ctk_enabled').prop('checked', s.enabled).on('change', function () {
        s.enabled = this.checked;
        afterChange();
    });
    $('#ctk_position').val(String(s.position)).on('change', function () {
        s.position = Number(this.value);
        afterChange();
    });
    const num = (sel, key) => $(sel).val(s[key]).on('input', function () {
        if (this.value === '') return;
        s[key] = Number(this.value);
        afterChange();
    });
    num('#ctk_depth', 'depth');
    num('#ctk_recent_count', 'recentCount');
    num('#ctk_recent_days', 'recentDays');
    num('#ctk_default_cycle', 'defaultCycle');
    $('#ctk_custom_types').val(s.customTypes).on('input', function () {
        s.customTypes = this.value;
        renderTypeOptions();
        afterChange();
    });

    $('#ctk_save_event').on('click', () => {
        const state = getState();
        if (!state) return toastr.warning('請先選擇角色');
        const data = { type: $('#ctk_type').val(), date: normalizeDate($('#ctk_date').val()), note: $('#ctk_note').val().trim() };
        const existing = editingEvent && state.events.find(e => e.id === editingEvent);
        if (existing) Object.assign(existing, data);
        else state.events.push({ id: nextId(state, 'e'), ...data, by: 'user' });
        resetEventForm();
        if (selectedDay) $('#ctk_date').val(selectedDay);
        afterChange();
    });
    $('#ctk_cancel_event').on('click', resetEventForm);

    $('#ctk_settings').on('click', '.ctk-edit-event', function () {
        const id = $(this).closest('.ctk-item').data('id');
        const e = getState()?.events.find(x => x.id === id);
        if (!e) return;
        editingEvent = id;
        if (!$(`#ctk_type option[value="${CSS.escape(e.type)}"]`).length) $('#ctk_type').append(`<option value="${esc(e.type)}">${esc(e.type)}</option>`);
        $('#ctk_type').val(e.type);
        $('#ctk_date').val(e.date);
        $('#ctk_note').val(e.note ?? '');
        $('#ctk_save_event').text(`儲存修改（${id}）`);
        $('#ctk_cancel_event').removeClass('ctk-hidden');
    });
    $('#ctk_settings').on('click', '.ctk-del-event', async function () {
        const id = $(this).closest('.ctk-item').data('id');
        const state = getState();
        const e = state?.events.find(x => x.id === id);
        if (!e || !(await confirmDelete(`${e.date} ${typeLabel(e.type)} ${e.note ?? ''}`))) return;
        state.events = state.events.filter(x => x.id !== id);
        afterChange();
    });

    $('#ctk_calendar').on('click', '.ctk-day', function () {
        const date = $(this).data('date');
        selectedDay = selectedDay === date ? null : date;
        if (selectedDay && !editingEvent) $('#ctk_date').val(selectedDay);
        renderLists();
    });
    const shiftMonth = n => {
        const d = new Date(calMonth.y, calMonth.m + n, 1);
        calMonth = { y: d.getFullYear(), m: d.getMonth() };
        renderLists();
    };
    $('#ctk_cal_prev').on('click', () => shiftMonth(-1));
    $('#ctk_cal_next').on('click', () => shiftMonth(1));
    $('#ctk_cal_today').on('click', () => {
        calMonth = null;
        selectedDay = today();
        if (!editingEvent) $('#ctk_date').val(selectedDay);
        renderLists();
    });

    $('#ctk_save_memo').on('click', () => {
        const state = getState();
        if (!state) return toastr.warning('請先選擇角色');
        const text = $('#ctk_memo_text').val().trim();
        if (!text) return;
        const existing = editingMemo && state.memos.find(m => m.id === editingMemo);
        if (existing) Object.assign(existing, { text, updated: today() });
        else state.memos.push({ id: nextId(state, 'm'), text, updated: today() });
        resetMemoForm();
        afterChange();
    });
    $('#ctk_cancel_memo').on('click', resetMemoForm);

    $('#ctk_memos').on('click', '.ctk-edit-memo', function () {
        const id = $(this).closest('.ctk-item').data('id');
        const m = getState()?.memos.find(x => x.id === id);
        if (!m) return;
        editingMemo = id;
        $('#ctk_memo_text').val(m.text);
        $('#ctk_save_memo').text(`儲存修改（${id}）`);
        $('#ctk_cancel_memo').removeClass('ctk-hidden');
    });
    $('#ctk_memos').on('click', '.ctk-del-memo', async function () {
        const id = $(this).closest('.ctk-item').data('id');
        const state = getState();
        const m = state?.memos.find(x => x.id === id);
        if (!m || !(await confirmDelete(m.text))) return;
        state.memos = state.memos.filter(x => x.id !== id);
        afterChange();
    });

    $('#ctk_preview').on('click', () => {
        const box = $('#ctk_preview_box');
        box.toggleClass('ctk-hidden');
        box.text(buildPrompt() || '（未選擇角色）');
    });

    $('#ctk_export').on('click', () => {
        const state = getState();
        if (!state) return toastr.warning('請先選擇角色');
        const payload = { character: charName(), exported: today(), events: state.events, memos: state.memos, seq: state.seq };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `cycle-tracker-${charName() || 'export'}-${today()}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $('#ctk_import').on('click', () => $('#ctk_import_file').trigger('click'));
    $('#ctk_import_file').on('change', async function () {
        const file = this.files?.[0];
        this.value = '';
        const state = getState();
        if (!file || !state) return;
        try {
            const data = JSON.parse(await file.text());
            if (!Array.isArray(data.events) || !Array.isArray(data.memos)) throw new Error('格式不符');
            const c = ctx();
            const ok = await c.callGenericPopup(`匯入會覆蓋「${esc(charName())}」目前的紀錄（${state.events.length} 筆紀錄、${state.memos.length} 則備忘），確定嗎？`, c.POPUP_TYPE.CONFIRM);
            if (!ok) return;
            state.events = data.events;
            state.memos = data.memos;
            state.seq = Math.max(Number(data.seq) || 0, ...[...data.events, ...data.memos].map(x => Number(String(x.id).slice(1)) || 0));
            state.journal = {};
            afterChange();
            toastr.success('匯入完成');
        } catch (err) {
            toastr.error(`匯入失敗：${err.message}`);
        }
    });
}

// ---------- 初始化 ----------

jQuery(async () => {
    settings();
    $('#extensions_settings2').append(PANEL_HTML);
    renderTypeOptions();
    resetEventForm();
    bindPanel();

    const { eventSource, event_types } = ctx();
    eventSource.on(event_types.MESSAGE_RECEIVED, (id, type) => {
        if (type !== 'first_message') return processMessage(Number(id), { mergeExisting: false });
    });
    eventSource.on(event_types.MESSAGE_EDITED, id => processMessage(Number(id), { mergeExisting: true }));
    eventSource.on(event_types.MESSAGE_SWIPED, id => onSwiped(Number(id)));
    eventSource.on(event_types.MESSAGE_DELETED, len => onDeleted(Number(len)));
    eventSource.on(event_types.CHAT_CHANGED, () => {
        selectedDay = null;
        resetEventForm();
        resetMemoForm();
        updatePrompt();
        renderLists();
    });
    // 每次生成前重算，確保跨日後「今天」是正確的
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, updatePrompt);

    updatePrompt();
    renderLists();
    console.log(LOG_PREFIX, 'loaded');
});
