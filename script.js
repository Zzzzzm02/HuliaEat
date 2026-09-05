const API_BASE = `${window.location.origin}/api`;

const TODAY_COUNT_KEY = 'today_count';
const LAST_DATE_KEY = 'last_date';
const ADMIN_TOKEN_KEY = 'hulia_admin_token';
const SELECTED_TAG_KEY = 'selected_tag';
const EXCLUDED_KEY = 'excluded_option_ids';

const MAX_NAME_LENGTH = 40;
const MAX_EMOJI_LENGTH = 8;
const MAX_ADDRESS_LENGTH = 200;
const MAX_TAG_LENGTH = 12;
const MAX_TAGS_COUNT = 6;

let foodOptions = [];
let selectedTag = null; // null = 全部；字符串 = 类型标签
let nearbyPool = null;  // 「📍 附近」模式的就近店列表（null = 未启用就近模式）
let isAnimating = false;
let editingOptionId = null;
let lastResult = null;

try {
    const stored = localStorage.getItem(SELECTED_TAG_KEY);
    if (stored) selectedTag = stored;
} catch (error) {
    // localStorage 不可用时保持「全部」
}

/* 关键词 → Emoji 自动匹配：表在 /emoji-rules.js，与后端共用唯一一份，别在这里再复制 */
const EMOJI_RULES = window.HULIA_EMOJI_RULES || [];

const DEFAULT_IMPORT_EMOJI = '🍽️';

/* 标签 → 筛选 chip 文案：短句、俏皮，不追求严格分类；没收录的标签回退「今天想吃X」 */
const TAG_CHIP_LABELS = {
    '杭帮菜': '吃点好的',
    '面': '嗦碗面',
    '小吃': '垫垫肚子',
    '火锅': '整点火锅',
    '烧烤': '撸串烤肉',
    '夜宵': '深夜食堂',
    '换口味': '换换口味',
    '就近随便吃': '随便吃点'
};

function tagChipLabel(tag) {
    return TAG_CHIP_LABELS[tag] || `今天想吃${tag}`;
}

/* 杭州必吃榜常客 / 杭帮菜名店示例名单（管理页可一键载入） */
const HANGZHOU_SAMPLE = [
    '楼外楼', '知味观', '山外山', '张生记', '杭州酒家', '外婆家', '新白鹿餐厅', '绿茶餐厅',
    '弄堂里', '新榆园', '桂语山房', '金沙厅', '解香楼', '龙井草堂', '叶马茶楼', '朴墅',
    '老头儿油爆虾', '福缘居酒楼', '德明饭店', '宝中宝食府', '兰边碗', '杭州四灶儿私房菜', '乔村二十八道',
    '新丰小吃', '咬不得高祖生煎', '春家·非遗手工小吃', '蕙心小吃店', '食不食货·台州小馆',
    '菊英面店', '慧娟面馆', '方老大面', '小狗面馆', '117面',
    '游埠豆浆', '立文夏·白切肉·牛腩饭'
];

function guessEmoji(name) {
    for (const [keyword, emoji] of EMOJI_RULES) {
        if (name.includes(keyword)) return emoji;
    }
    return DEFAULT_IMPORT_EMOJI;
}

function parseImportNames(text) {
    if (!text) return [];

    const parts = text
        .split(/[\n,，、;；/|]+/)
        .map((part) => part.trim())
        .filter(Boolean);

    const seen = new Set();
    const result = [];
    for (const name of parts) {
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(name);
    }
    return result;
}

async function runImport(mode) {
    const textarea = document.getElementById('import-text');
    const names = parseImportNames(textarea.value);

    if (names.length === 0) {
        showManageMessage('请先粘贴要导入的名单', 'error');
        return;
    }

    if (mode === 'replace' && !window.confirm(
        `确定用这份 ${names.length} 家名单【替换全部】吗？\n\n这会清空所有餐厅以及它们在各个榜单里的关联，不可撤销。\n（建议先跑一次 npm run export 留一份快照）`
    )) {
        return;
    }

    const appendBtn = document.getElementById('import-append-btn');
    const replaceBtn = document.getElementById('import-replace-btn');
    appendBtn.disabled = true;
    replaceBtn.disabled = true;

    const items = names.map((name) => ({ name, emoji: guessEmoji(name) }));

    try {
        const result = await requestJson(`${API_BASE}/options/import`, {
            method: 'POST',
            admin: true,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode, items })
        });

        foodOptions = result.options;
        editingOptionId = null;
        updateStats();
        renderTagChips();
        renderOptionsList();

        const modeText = mode === 'replace' ? '替换' : '追加';
        showManageMessage(`${modeText}成功，当前共 ${result.total} 家`, 'success');

        if (mode === 'replace') {
            textarea.value = '';
        }
    } catch (error) {
        console.error('导入失败:', error);
        showManageMessage(`导入失败：${error.message}`, 'error');
    } finally {
        appendBtn.disabled = false;
        replaceBtn.disabled = false;
    }
}

function getManageMessageElement() {
    return document.getElementById('manage-message');
}

function showManageMessage(message, type = 'info') {
    const messageEl = getManageMessageElement();
    if (!messageEl) return;

    messageEl.textContent = message;
    messageEl.className = `manage-message ${type}`;
    messageEl.style.display = 'block';
}

function hideManageMessage() {
    const messageEl = getManageMessageElement();
    if (!messageEl) return;

    messageEl.style.display = 'none';
    messageEl.textContent = '';
    messageEl.className = 'manage-message';
}

/* ---------------- 管理密钥（写接口鉴权） ---------------- */

function getAdminToken() {
    try {
        return localStorage.getItem(ADMIN_TOKEN_KEY) || '';
    } catch (error) {
        return '';
    }
}

function setAdminToken(token) {
    try {
        if (token) {
            localStorage.setItem(ADMIN_TOKEN_KEY, token);
        } else {
            localStorage.removeItem(ADMIN_TOKEN_KEY);
        }
    } catch (error) {
        // 隐私模式下 localStorage 不可用，忽略即可
    }
}

// 弹出输入框；返回 true 表示密钥有变化，值得重试一次
function promptForAdminToken(silent = false) {
    if (silent) return false;

    const entered = window.prompt(
        '修改菜单需要管理密钥（服务器上的 ADMIN_TOKEN）。\n\n请输入密钥：',
        getAdminToken()
    );

    if (entered === null) return false;

    const token = entered.trim();
    if (!token) {
        showManageMessage('管理密钥不能为空', 'error');
        return false;
    }

    setAdminToken(token);
    return true;
}

function updateTokenBadge() {
    const badge = document.getElementById('token-state');
    const hasToken = Boolean(getAdminToken());

    if (badge) {
        badge.textContent = hasToken ? '已设置管理密钥' : '未设置管理密钥';
        badge.classList.toggle('is-set', hasToken);
    }

    // 密钥状态决定结果页是否出现「从菜单下架」
    updateResultActions();
}

function withAdminHeader(options) {
    const token = getAdminToken();
    if (!token) return options;

    return {
        ...options,
        headers: {
            ...(options.headers || {}),
            'x-admin-token': token
        }
    };
}

async function sendApiRequest(url, options = {}) {
    const { admin = false, expectContent = true, ...fetchOptions } = options;

    for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(url, admin ? withAdminHeader(fetchOptions) : fetchOptions);

        // 密钥缺失或失效：提示输入后自动重试一次
        if (response.status === 401 && admin && attempt === 0) {
            if (promptForAdminToken()) {
                updateTokenBadge();
                continue;
            }
            throw new Error('需要管理密钥才能修改菜单');
        }

        const contentType = response.headers.get('content-type') || '';
        const isJson = contentType.includes('application/json');
        // 无论是否返回内容，都要解析出服务端的错误信息
        const body = isJson ? await response.json() : null;

        if (!response.ok) {
            const errorMessage = body && body.error ? body.error : `请求失败（${response.status}）`;
            throw new Error(errorMessage);
        }

        return expectContent ? body : null;
    }

    throw new Error('鉴权失败：管理密钥无效');
}

async function requestJson(url, options = {}) {
    return sendApiRequest(url, options);
}

async function requestNoContent(url, options = {}) {
    return sendApiRequest(url, { ...options, expectContent: false });
}


async function loadOptions({ silent = false } = {}) {
    try {
        const options = await requestJson(`${API_BASE}/options`);
        foodOptions = options;
        updateStats();
        renderTagChips();
        // 数据晚于地图首绘到达时补一次重绘（地图未初始化时内部静默跳过）
        if (window.HuliaMap) window.HuliaMap.refresh();

        if (document.getElementById('manage-screen').classList.contains('active')) {
            renderOptionsList();
        }

        if (!silent) {
            hideManageMessage();
        }
    } catch (error) {
        console.error('加载选项失败:', error);
        if (!silent) {
            showManageMessage(`加载失败：${error.message}`, 'error');
        }
    }
}

/* ---------------- 类型标签与本机排除 ---------------- */

// 从全量数据里聚合出标签（前端自己算，不再有 /api/lists）
function collectTags() {
    const counts = new Map();
    for (const option of foodOptions) {
        for (const tag of option.tags || []) {
            counts.set(tag, (counts.get(tag) || 0) + 1);
        }
    }
    // 选中的标签可能已经没有任何店：静默回落到「全部」
    if (selectedTag && !counts.has(selectedTag)) {
        selectedTag = null;
        try {
            localStorage.removeItem(SELECTED_TAG_KEY);
        } catch (error) {
            // ignore
        }
        return [];
    }
    return [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
}

function getExcludedIds() {
    try {
        const raw = JSON.parse(localStorage.getItem(EXCLUDED_KEY) || '[]');
        return Array.isArray(raw) ? raw.map(String) : [];
    } catch (error) {
        return [];
    }
}

function setExcludedIds(ids) {
    try {
        const unique = [...new Set(ids.map(String))];
        if (unique.length) {
            localStorage.setItem(EXCLUDED_KEY, JSON.stringify(unique));
        } else {
            localStorage.removeItem(EXCLUDED_KEY);
        }
    } catch (error) {
        // ignore
    }
    renderExclusionNote();
}

// 当前生效池：就近模式优先，其次标签筛选，最后全量（再剔除本机排除项）
function getPool() {
    const base = nearbyPool
        ? nearbyPool
        : selectedTag
            ? foodOptions.filter((option) => (option.tags || []).includes(selectedTag))
            : foodOptions;

    const excluded = new Set(getExcludedIds());
    return base.filter((option) => !excluded.has(String(option.id)));
}

function renderExclusionNote() {
    const note = document.getElementById('exclusion-note');
    if (!note) return;

    const baseSize = nearbyPool
        ? nearbyPool.length
        : selectedTag
            ? foodOptions.filter((option) => (option.tags || []).includes(selectedTag)).length
            : foodOptions.length;

    const visible = getPool().length;
    const hidden = baseSize - visible;

    if (hidden <= 0 && !nearbyPool) {
        note.hidden = true;
        note.innerHTML = '';
        return;
    }

    note.hidden = false;
    const scope = nearbyPool
        ? `附近 1.5km 共 ${baseSize} 家`
        : selectedTag ? `「${tagChipLabel(selectedTag)}」` : '全部店铺';
    note.textContent = hidden > 0
        ? `${scope}共 ${baseSize} 家，本机已隐藏 ${hidden} 家（不影响他人）`
        : `${scope}，点「开始选择」开抽`;

    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'chip-action chip-action-quiet';
    restore.textContent = '恢复全部';
    restore.addEventListener('click', () => {
        setExcludedIds([]);
        showManageMessage('已恢复本筛选的全部店铺', 'info');
    });
    note.appendChild(document.createTextNode(' '));
    if (hidden > 0) note.appendChild(restore);
}

// 首页 / 地图 / 管理页共用的筛选 chips：「全部」+「类型」；首页末尾多一个「📍 附近」
function renderTagChips() {
    const containers = ['list-chips', 'manage-list-chips', 'map-list-chips']
        .map((id) => document.getElementById(id))
        .filter(Boolean);
    if (!containers.length) return;

    const tags = collectTags();
    const total = foodOptions.length;

    containers.forEach((container) => {
        container.innerHTML = '';

        const allChip = document.createElement('button');
        allChip.type = 'button';
        allChip.className = `chip${selectedTag || nearbyPool ? '' : ' active'}`;
        allChip.textContent = `全部 ${total}`;
        allChip.addEventListener('click', () => selectTag(null));
        container.appendChild(allChip);

        tags.forEach(({ name, count }) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `chip${!nearbyPool && selectedTag === name ? ' active' : ''}`;
            chip.textContent = tagChipLabel(name);
            chip.title = `${count} 家店`;
            chip.addEventListener('click', () => selectTag(name));
            container.appendChild(chip);
        });

        // 就近抽签只放首页
        if (container.id === 'list-chips') {
            const nearChip = document.createElement('button');
            nearChip.type = 'button';
            nearChip.className = `chip${nearbyPool ? ' active' : ''}`;
            nearChip.textContent = '📍 附近';
            nearChip.addEventListener('click', startNearby);
            container.appendChild(nearChip);
        }
    });

    renderExclusionNote();
}

function selectTag(tag) {
    selectedTag = tag || null;
    nearbyPool = null; // 切走标签即退出就近模式

    try {
        if (selectedTag) {
            localStorage.setItem(SELECTED_TAG_KEY, selectedTag);
        } else {
            localStorage.removeItem(SELECTED_TAG_KEY);
        }
    } catch (error) {
        // ignore
    }

    renderTagChips();
    renderOptionsList();
    // 地图屏跟着同一个筛选走；还没初始化时内部会静默跳过
    if (window.HuliaMap) window.HuliaMap.refresh();
}

// 就近抽签：浏览器定位 → 拉附近 1.5km 已收录的店 → 进入就近池
function startNearby() {
    const note = document.getElementById('exclusion-note');
    const say = (text) => {
        if (!note) return;
        note.hidden = !text;
        note.textContent = text || '';
    };

    if (!navigator.geolocation) {
        say('这个浏览器不支持定位');
        return;
    }

    say('正在获取定位…');
    navigator.geolocation.getCurrentPosition(async (pos) => {
        try {
            const { longitude, latitude } = pos.coords;
            const list = await requestJson(`${API_BASE}/options?near=${longitude},${latitude}&radius=1500`);
            if (!list.length) {
                nearbyPool = null;
                renderTagChips();
                say('附近 1.5km 内还没有已收录的店，先逛逛「全部」吧');
                return;
            }
            nearbyPool = list;
            renderTagChips();
            say(`就近模式：1.5km 内 ${list.length} 家，点「开始选择」开抽`);
        } catch (error) {
            say(`就近模式失败：${error.message}`);
        }
    }, (err) => {
        say(`定位失败：${err.message}（页面需 HTTPS 或 localhost）`);
    }, { timeout: 8000, maximumAge: 600000 });
}

function updateStats() {
    document.getElementById('total-options').textContent = foodOptions.length;
    updateTodayCount();
}

function updateTodayCount() {
    const today = new Date().toDateString();
    const lastDate = localStorage.getItem(LAST_DATE_KEY);
    let count = 0;

    if (lastDate === today) {
        count = Number.parseInt(localStorage.getItem(TODAY_COUNT_KEY) || '0', 10);
    } else {
        localStorage.setItem(LAST_DATE_KEY, today);
        localStorage.setItem(TODAY_COUNT_KEY, '0');
    }

    document.getElementById('today-count').textContent = count;
}

function incrementTodayCount() {
    const today = new Date().toDateString();
    const lastDate = localStorage.getItem(LAST_DATE_KEY);

    if (lastDate === today) {
        const currentCount = Number.parseInt(localStorage.getItem(TODAY_COUNT_KEY) || '0', 10);
        localStorage.setItem(TODAY_COUNT_KEY, String(currentCount + 1));
    } else {
        localStorage.setItem(LAST_DATE_KEY, today);
        localStorage.setItem(TODAY_COUNT_KEY, '1');
    }

    updateTodayCount();
}

function getRandomFood() {
    let pool = getPool();

    // 排除到空池时自动放行，并提示一句 —— 而不是让抽签卡死
    if (pool.length === 0 && getExcludedIds().length > 0) {
        setExcludedIds([]);
        pool = getPool();
        showResultNote('本榜单的店铺都被隐藏过了，已自动恢复全部可选');
    }

    if (pool.length === 0) {
        return { name: '请先添加餐饮选项', emoji: '🍽️' };
    }

    const randomIndex = Math.floor(Math.random() * pool.length);
    return pool[randomIndex];
}

function showResultNote(text) {
    const note = document.getElementById('result-note');
    if (!note) return;

    note.hidden = !text;
    note.textContent = text || '';
}

const PREFERS_REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const CONFETTI_COLORS = ['#E7631C', '#F0751F', '#EFA43B', '#F6C79A', '#5C926E', '#C64F0E'];

function celebrate(anchor) {
    if (PREFERS_REDUCED_MOTION || !anchor) return;

    const rect = anchor.getBoundingClientRect();
    const originX = rect.left + rect.width / 2;
    const originY = rect.top + rect.height / 2;
    const count = 24;

    for (let i = 0; i < count; i += 1) {
        const piece = document.createElement('span');
        piece.className = 'confetti';

        const angle = Math.random() * Math.PI * 2;
        const distance = 90 + Math.random() * 160;
        const cx = Math.cos(angle) * distance;
        const cy = Math.sin(angle) * distance - 50;
        const size = 6 + Math.random() * 7;

        piece.style.left = `${originX}px`;
        piece.style.top = `${originY}px`;
        piece.style.width = `${size}px`;
        piece.style.height = `${size * (Math.random() > 0.5 ? 1 : 0.45)}px`;
        piece.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
        if (Math.random() > 0.5) piece.style.borderRadius = '50%';
        piece.style.setProperty('--cx', `${cx.toFixed(0)}px`);
        piece.style.setProperty('--cy', `${cy.toFixed(0)}px`);
        piece.style.setProperty('--cr', `${(Math.random() * 720 - 360).toFixed(0)}deg`);
        piece.style.setProperty('--confetti-duration', `${(750 + Math.random() * 650).toFixed(0)}ms`);

        document.body.appendChild(piece);
        setTimeout(() => piece.remove(), 1600);
    }
}

function animateResult() {
    const emojiElement = document.getElementById('emoji');
    const resultElement = document.getElementById('food-result');
    const resultContainer = document.getElementById('result-container');

    resultContainer.classList.remove('revealed');

    // 复位上一轮的展示状态：缩略图模式会隐藏 emoji+店名容器，
    // 不复位的话下一轮动画就在隐藏容器里跑，看起来像"动画没加载"
    const resultContent = document.getElementById('result-content');
    const mapLink = document.getElementById('result-map-link');
    if (resultContent) resultContent.hidden = false;
    if (mapLink) mapLink.hidden = true;

    const totalSteps = PREFERS_REDUCED_MOTION ? 1 : 24;
    let step = 0;

    const tick = () => {
        const randomFood = getRandomFood();
        emojiElement.textContent = randomFood.emoji;
        resultElement.textContent = randomFood.name;
        step += 1;

        if (step < totalSteps) {
            // 越接近终点越慢，模拟老虎机减速手感
            const progress = step / totalSteps;
            const delay = 40 + Math.pow(progress, 2.2) * 260;
            setTimeout(tick, delay);
            return;
        }

        try {
            const finalFood = getRandomFood();
            lastResult = finalFood && finalFood.id ? finalFood : null;
            emojiElement.textContent = finalFood.emoji;
            resultElement.textContent = finalFood.name;
            resultContainer.classList.add('revealed');
            celebrate(resultContainer);
            incrementTodayCount();
            updateResultActions();
            updateResultMap(lastResult);
        } finally {
            // 无论展示环节出什么岔子，都不能把后续抽签锁死
            isAnimating = false;
        }
    };

    tick();
}

// 「再抽一次」：在结果屏原地重抽，不再把用户送回首页
function redrawInPlace() {
    if (isAnimating) return;
    isAnimating = true;
    animateResult();
}

let resultMapOptionId = null;

function formatDistance(meters) {
    return meters >= 1000 ? `${(meters / 1000).toFixed(1)}km` : `${meters}m`;
}

// 结果方框：已定位的店以位置缩略图为主视觉（店名/地址做成图上的小卡片），
// 未定位的店回退到 emoji + 店名展示
function updateResultMap(option) {
    const content = document.getElementById('result-content');
    const addr = document.getElementById('result-address');
    const link = document.getElementById('result-map-link');
    const img = document.getElementById('result-map-img');
    const mapName = document.getElementById('result-map-name');
    const mapAddr = document.getElementById('result-map-addr');
    if (!content || !addr || !link || !img || !mapName || !mapAddr) return;

    resultMapOptionId = option && option.id ? option.id : null;
    const address = option && option.address ? option.address : '';
    const distText = option && option.distance_meters != null
        ? ` · 距你 ${formatDistance(option.distance_meters)}`
        : '';

    const located = option && option.latitude != null && option.longitude != null;
    if (!located) {
        content.hidden = false;
        addr.textContent = address ? `📍 ${address}${distText}` : '';
        addr.hidden = !address;
        link.hidden = true;
        img.removeAttribute('src');
        return;
    }

    mapName.textContent = `${option.emoji || ''} ${option.name}`.trim();
    mapAddr.textContent = `${address || '📍 图中标记即店铺位置'}${distText}`;
    // 加载失败（服务未配置/配额超限/网络）时回退到 emoji + 店名，不阻碍抽签主流程
    img.onerror = () => {
        link.hidden = true;
        content.hidden = false;
        addr.textContent = address ? `📍 ${address}` : '';
        addr.hidden = !address;
    };
    img.src = `${API_BASE}/options/${option.id}/staticmap`;
    link.hidden = false;
    content.hidden = true;
}

async function openResultOnMap() {
    if (!resultMapOptionId) return;
    switchScreen('map-screen');
    if (window.HuliaMap) await window.HuliaMap.focus(resultMapOptionId);
}

// 结果页的次级动作：带密钥的设备才显示「从菜单下架」，其他人只有本机隐藏
function updateResultActions() {
    const skipBtn = document.getElementById('skip-btn');
    const delistBtn = document.getElementById('delist-btn');

    const enabled = Boolean(lastResult && lastResult.id);
    if (skipBtn) skipBtn.disabled = !enabled;
    if (delistBtn) {
        delistBtn.hidden = !(enabled && getAdminToken());
        delistBtn.disabled = false;
    }
}

async function skipCurrentResult() {
    if (!lastResult || !lastResult.id) return;

    const excluded = getExcludedIds();
    excluded.push(String(lastResult.id));
    setExcludedIds(excluded);

    showResultNote(`已在本机隐藏「${lastResult.name}」，不影响其他访客`);
    animateResult();
}

async function delistCurrentResult() {
    if (!lastResult || !lastResult.id) return;

    const ok = window.confirm(
        `把「${lastResult.name}」从菜单彻底下架？\n\n这会删掉这家店本身（所有榜单都会消失），不可撤销。` +
        `\n如果只想暂时不看它，请改用「最近不想吃」。`
    );
    if (!ok) return;

    try {
        await requestNoContent(`${API_BASE}/options/${lastResult.id}`, { method: 'DELETE', admin: true });

        const removedId = String(lastResult.id);
        lastResult = null;
        setExcludedIds(getExcludedIds().filter((id) => id !== removedId));

        await loadOptions({ silent: true });
        switchScreen('start-screen');
        showManageMessage('该店铺已从菜单下架', 'success');
    } catch (error) {
        showResultNote('');
        showManageMessage(`下架失败：${error.message}`, 'error');
    }
}

/* ---------------- 管理入口锁（对普通访客隐藏，持密钥解锁） ---------------- */

function revealManage() {
    const manageBtn = document.getElementById('manage-btn');
    if (!manageBtn) return;
    manageBtn.hidden = false;
    document.querySelector('.nav')?.classList.remove('two');
}

function lockManage() {
    const manageBtn = document.getElementById('manage-btn');
    if (!manageBtn) return;
    manageBtn.hidden = true;
    manageBtn.classList.remove('active');
    document.querySelector('.nav')?.classList.add('two');
    if (document.getElementById('manage-screen')?.classList.contains('active')) {
        switchScreen('start-screen');
    }
}

// 用 /api/admin/check 验密：对 → 显示管理入口并进入管理屏；错/取消 → 保持隐藏
async function tryUnlockManage() {
    try {
        await requestJson(`${API_BASE}/admin/check`, { admin: true });
        revealManage();
        switchScreen('manage-screen');
        showManageMessage('管理模式已解锁', 'success');
    } catch (error) {
        // 密钥不对或用户取消：维持隐藏
    }
}

function startAnimation() {
    if (isAnimating) return;

    isAnimating = true;

    const startScreen = document.getElementById('start-screen');
    const resultScreen = document.getElementById('result-screen');

    startScreen.classList.remove('active');

    setTimeout(() => {
        resultScreen.classList.add('active');
        animateResult();
    }, 300);
}

function switchScreen(screenId) {
    document.querySelectorAll('.screen').forEach((screen) => {
        screen.classList.remove('active');
    });

    document.querySelectorAll('.nav-btn').forEach((btn) => {
        btn.classList.remove('active');
    });

    document.getElementById(screenId).classList.add('active');

    if (screenId === 'start-screen') {
        document.getElementById('home-btn').classList.add('active');
    }

    if (screenId === 'map-screen') {
        document.getElementById('map-btn').classList.add('active');
        if (window.HuliaMap) window.HuliaMap.render();
    }

    if (screenId === 'manage-screen') {
        document.getElementById('manage-btn').classList.add('active');
        loadOptions({ silent: true });
        renderOptionsList();
    }

    if (screenId === 'result-screen') {
        updateResultActions();
    }
}

function validateOptionInput(name, emoji) {
    if (!name) return '请输入餐饮名称';
    if (!emoji) return '请输入 Emoji 图标';
    if (name.length > MAX_NAME_LENGTH) return `名称不能超过 ${MAX_NAME_LENGTH} 个字符`;
    if (emoji.length > MAX_EMOJI_LENGTH) return `Emoji 不能超过 ${MAX_EMOJI_LENGTH} 个字符`;
    return null;
}

// 从输入框收集可选地理信息；返回 { fields } 或 { error }。
// 经纬度成对收，空串视为「没填」；清空一个留另一个直接报错
function collectGeoFields(addressInput, latInput, lngInput) {
    const fields = {};

    if (addressInput) {
        const address = addressInput.value.trim();
        if (address.length > MAX_ADDRESS_LENGTH) return { error: `地址不能超过 ${MAX_ADDRESS_LENGTH} 个字符` };
        fields.address = address || null;
    }

    if (latInput && lngInput) {
        const latText = latInput.value.trim();
        const lngText = lngInput.value.trim();

        if (!latText !== !lngText) {
            return { error: '纬度和经度要成对填写（都清空即删除位置）' };
        }

        if (latText) {
            const latitude = Number(latText);
            const longitude = Number(lngText);
            const valid = Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
                && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
            if (!valid) {
                return { error: '经纬度必须是合法数字（纬度 -90~90，经度 -180~180）' };
            }
            fields.latitude = latitude;
            fields.longitude = longitude;
        } else {
            fields.latitude = null;
            fields.longitude = null;
        }
    }

    return { fields };
}

// 从输入框解析类型标签：逗号/顿号/空格分隔；返回 { tags } 或 { error }
function parseTagsInput(text) {
    const tags = [];
    const seen = new Set();
    for (const part of (text || '').split(/[,，、;；\s]+/)) {
        const tag = part.trim();
        if (!tag) continue;
        if (tag.length > MAX_TAG_LENGTH) return { error: `单个标签不能超过 ${MAX_TAG_LENGTH} 个字（「${tag}」）` };
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        tags.push(tag);
    }
    if (tags.length > MAX_TAGS_COUNT) return { error: `标签最多 ${MAX_TAGS_COUNT} 个` };
    return { tags };
}

async function addFoodOption() {
    const nameInput = document.getElementById('food-name');
    const emojiInput = document.getElementById('food-emoji');
    const tagsInput = document.getElementById('food-tags');
    const addressInput = document.getElementById('food-address');
    const latInput = document.getElementById('food-lat');
    const lngInput = document.getElementById('food-lng');
    const addBtn = document.getElementById('add-btn');

    const name = nameInput.value.trim();
    const emoji = emojiInput.value.trim();

    const validationError = validateOptionInput(name, emoji);
    if (validationError) {
        showManageMessage(validationError, 'error');
        return;
    }

    const geo = collectGeoFields(addressInput, latInput, lngInput);
    if (geo.error) {
        showManageMessage(geo.error, 'error');
        return;
    }

    const parsedTags = parseTagsInput(tagsInput ? tagsInput.value : '');
    if (parsedTags.error) {
        showManageMessage(parsedTags.error, 'error');
        return;
    }

    addBtn.disabled = true;

    try {
        const payload = { name, emoji, tags: parsedTags.tags, ...geo.fields };
        const newOption = await requestJson(`${API_BASE}/options`, {
            method: 'POST',
            admin: true,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        foodOptions.push(newOption);
        updateStats();
        renderTagChips();
        renderOptionsList();

        nameInput.value = '';
        emojiInput.value = '';
        if (tagsInput) tagsInput.value = '';
        if (addressInput) addressInput.value = '';
        if (latInput) latInput.value = '';
        if (lngInput) lngInput.value = '';

        showManageMessage('选项添加成功', 'success');
    } catch (error) {
        console.error('添加选项失败:', error);
        showManageMessage(`添加失败：${error.message}`, 'error');
    } finally {
        addBtn.disabled = false;
    }
}

async function deleteFoodOption(id) {
    if (!window.confirm('确定要删除这个选项吗？')) return;

    try {
        await requestNoContent(`${API_BASE}/options/${id}`, {
            method: 'DELETE',
            admin: true
        });

        foodOptions = foodOptions.filter((option) => option.id !== id);
        if (editingOptionId === id) editingOptionId = null;
        updateStats();
        renderOptionsList();
        showManageMessage('选项删除成功', 'success');
    } catch (error) {
        console.error('删除选项失败:', error);
        showManageMessage(`删除失败：${error.message}`, 'error');
    }
}

function startEditingOption(id) {
    editingOptionId = id;
    hideManageMessage();
    renderOptionsList();

    setTimeout(() => {
        const input = document.getElementById(`edit-name-${id}`);
        if (input) input.focus();
    }, 0);
}

function cancelEditingOption() {
    editingOptionId = null;
    renderOptionsList();
}

async function saveEditingOption(id) {
    const nameInput = document.getElementById(`edit-name-${id}`);
    const emojiInput = document.getElementById(`edit-emoji-${id}`);
    const tagsInput = document.getElementById(`edit-tags-${id}`);
    const addressInput = document.getElementById(`edit-address-${id}`);
    const latInput = document.getElementById(`edit-lat-${id}`);
    const lngInput = document.getElementById(`edit-lng-${id}`);

    if (!nameInput || !emojiInput) return;

    const name = nameInput.value.trim();
    const emoji = emojiInput.value.trim();

    const validationError = validateOptionInput(name, emoji);
    if (validationError) {
        showManageMessage(validationError, 'error');
        return;
    }

    const geo = collectGeoFields(addressInput, latInput, lngInput);
    if (geo.error) {
        showManageMessage(geo.error, 'error');
        return;
    }

    const tags = parseTagsInput(tagsInput ? tagsInput.value : '');
    if (tags.error) {
        showManageMessage(tags.error, 'error');
        return;
    }

    try {
        const updatedOption = await requestJson(`${API_BASE}/options/${id}`, {
            method: 'PATCH',
            admin: true,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name, emoji, tags: tags.tags, ...geo.fields })
        });

        foodOptions = foodOptions.map((option) => (option.id === id ? updatedOption : option));
        editingOptionId = null;
        updateStats();
        renderTagChips();
        renderOptionsList();
        showManageMessage('选项更新成功', 'success');
    } catch (error) {
        console.error('更新选项失败:', error);
        showManageMessage(`更新失败：${error.message}`, 'error');
    }
}

function createButton(text, className, onClick, title = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = text;
    if (title) button.title = title;
    button.addEventListener('click', onClick);
    return button;
}

function createOptionView(option) {
    const optionItem = document.createElement('div');
    optionItem.className = 'option-item';

    const content = document.createElement('div');
    content.className = 'option-content';

    const emoji = document.createElement('span');
    emoji.className = 'option-emoji';
    emoji.textContent = option.emoji;

    const name = document.createElement('span');
    name.className = 'option-name';
    name.textContent = option.name;

    content.appendChild(emoji);
    content.appendChild(name);

    // 类型标签
    const tagsSpan = document.createElement('span');
    tagsSpan.className = 'option-tags';
    (option.tags || []).forEach((tag) => {
        const tagEl = document.createElement('span');
        tagEl.className = 'option-tag';
        tagEl.textContent = tag;
        tagsSpan.appendChild(tagEl);
    });

    // 已定位的店给一个 📍 标，方便知道哪些会上地图
    if (option.latitude != null && option.longitude != null) {
        const geoTag = document.createElement('span');
        geoTag.className = 'option-tag option-tag-geo';
        geoTag.title = option.address || `${option.latitude}, ${option.longitude}`;
        geoTag.textContent = '📍';
        tagsSpan.appendChild(geoTag);
    }

    if (getExcludedIds().includes(String(option.id))) {
        const hiddenTag = document.createElement('span');
        hiddenTag.className = 'option-tag option-tag-hidden';
        hiddenTag.textContent = '本机已隐藏';
        tagsSpan.appendChild(hiddenTag);
    }

    content.appendChild(tagsSpan);

    const actions = document.createElement('div');
    actions.className = 'option-actions';

    actions.appendChild(createButton('编辑', 'option-btn edit', () => startEditingOption(option.id)));
    actions.appendChild(createButton('删除', 'option-btn delete', () => deleteFoodOption(option.id)));

    optionItem.appendChild(content);
    optionItem.appendChild(actions);

    return optionItem;
}

function createOptionEditView(option) {
    const optionItem = document.createElement('div');
    optionItem.className = 'option-item editing';

    const editForm = document.createElement('div');
    editForm.className = 'option-edit-form';

    const emojiInput = document.createElement('input');
    emojiInput.className = 'option-input option-emoji-input';
    emojiInput.id = `edit-emoji-${option.id}`;
    emojiInput.type = 'text';
    emojiInput.maxLength = MAX_EMOJI_LENGTH;
    emojiInput.value = option.emoji;
    emojiInput.placeholder = '🍽️';

    const nameInput = document.createElement('input');
    nameInput.className = 'option-input option-name-input';
    nameInput.id = `edit-name-${option.id}`;
    nameInput.type = 'text';
    nameInput.maxLength = MAX_NAME_LENGTH;
    nameInput.value = option.name;
    nameInput.placeholder = '餐饮名称';

    // 类型标签：预填现值，逗号分隔；清空保存即清除
    const tagsInput = document.createElement('input');
    tagsInput.className = 'option-input option-tags-input';
    tagsInput.id = `edit-tags-${option.id}`;
    tagsInput.type = 'text';
    tagsInput.value = (option.tags || []).join('、');
    tagsInput.placeholder = '类型标签（顿号分隔，清空即删除）';

    // 地理信息：预填现值，改了就更新，清空保存即清除
    const geoRow = document.createElement('div');
    geoRow.className = 'option-geo-row';

    const addressInput = document.createElement('input');
    addressInput.className = 'option-input option-address-input';
    addressInput.id = `edit-address-${option.id}`;
    addressInput.type = 'text';
    addressInput.maxLength = MAX_ADDRESS_LENGTH;
    addressInput.value = option.address || '';
    addressInput.placeholder = '地址（清空即删除）';

    const latInput = document.createElement('input');
    latInput.className = 'option-input option-coord-input';
    latInput.id = `edit-lat-${option.id}`;
    latInput.type = 'text';
    latInput.inputMode = 'decimal';
    latInput.value = option.latitude == null ? '' : String(option.latitude);
    latInput.placeholder = '纬度';

    const lngInput = document.createElement('input');
    lngInput.className = 'option-input option-coord-input';
    lngInput.id = `edit-lng-${option.id}`;
    lngInput.type = 'text';
    lngInput.inputMode = 'decimal';
    lngInput.value = option.longitude == null ? '' : String(option.longitude);
    lngInput.placeholder = '经度';

    geoRow.appendChild(addressInput);
    geoRow.appendChild(latInput);
    geoRow.appendChild(lngInput);

    const actions = document.createElement('div');
    actions.className = 'option-actions';

    const clearGeoBtn = createButton('清空位置', 'option-btn quiet', () => {
        addressInput.value = '';
        latInput.value = '';
        lngInput.value = '';
    }, '一键清空地址与经纬度（保存后生效）');
    const saveBtn = createButton('保存', 'option-btn save', () => saveEditingOption(option.id));
    const cancelBtn = createButton('取消', 'option-btn cancel', cancelEditingOption);

    actions.appendChild(clearGeoBtn);
    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);

    editForm.appendChild(emojiInput);
    editForm.appendChild(nameInput);
    editForm.appendChild(tagsInput);
    editForm.appendChild(geoRow);

    optionItem.appendChild(editForm);
    optionItem.appendChild(actions);

    return optionItem;
}

function renderOptionsList() {
    const container = document.getElementById('options-container');
    if (!container) return;

    container.innerHTML = '';

    const visible = selectedTag
        ? foodOptions.filter((option) => (option.tags || []).includes(selectedTag))
        : foodOptions;

    if (!foodOptions.length) {
        const emptyState = document.createElement('p');
        emptyState.className = 'options-empty';
        emptyState.textContent = '暂无选项，请先添加';
        container.appendChild(emptyState);
        return;
    }

    if (!visible.length) {
        const emptyState = document.createElement('p');
        emptyState.className = 'options-empty';
        emptyState.textContent = `「${tagChipLabel(selectedTag)}」里还没有店铺，可在下方编辑里给店铺加上「${selectedTag}」标签`;
        container.appendChild(emptyState);
        return;
    }

    visible.forEach((option) => {
        const item = editingOptionId === option.id
            ? createOptionEditView(option)
            : createOptionView(option);
        container.appendChild(item);
    });
}

const FOOD_EMOJIS = ['🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌽', '🥕', '🧄', '🧅', '🥔', '🍠', '🥐', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🌭', '🍔', '🍟', '🍕', '🥪', '🥙', '🧆', '🌮', '🌯', '🥗', '🥘', '🥫', '🍝', '🍜', '🍲', '🍛', '🍣', '🍱', '🥟', '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠', '🥮', '🍢', '🍡', '🍧', '🍨', '🍦', '🍩', '🍪', '🎂', '🍰', '🍮', '🍭', '🍬', '🍫', '🍿', '🍩', '🍪', '🍮', '🍯', '🍼', '🥛', '🍵', '☕', '🍶', '🍺', '🍻', '🍷', '🍸', '🍹', '🍾', '🍿'];

function createFloatingEmojis() {
    if (PREFERS_REDUCED_MOTION) return;

    const spawn = () => {
        // 克制为上：同屏最多 7 个，避免杂乱
        if (document.querySelectorAll('.floating-emoji').length >= 7) return;

        const emoji = FOOD_EMOJIS[Math.floor(Math.random() * FOOD_EMOJIS.length)];
        const floatingEmoji = document.createElement('div');
        floatingEmoji.className = 'floating-emoji';
        floatingEmoji.textContent = emoji;

        const left = Math.random() * 100;
        const duration = 15 + Math.random() * 10;
        const size = 1.1 + Math.random() * 1.1;
        const sway = (Math.random() * 10 - 5).toFixed(1);
        const opacity = 0.15 + Math.random() * 0.13;

        floatingEmoji.style.left = `${left}%`;
        floatingEmoji.style.animationDuration = `${duration}s`;
        floatingEmoji.style.fontSize = `${size}rem`;
        floatingEmoji.style.setProperty('--sway', `${sway}vw`);
        floatingEmoji.style.setProperty('--float-opacity', opacity.toFixed(2));

        document.body.appendChild(floatingEmoji);
        setTimeout(() => floatingEmoji.remove(), duration * 1000);
    };

    // 开场先零散铺几个，随后低频生成
    for (let i = 0; i < 4; i += 1) {
        setTimeout(spawn, 600 + i * 1100);
    }
    setInterval(spawn, 2800);
}

document.addEventListener('DOMContentLoaded', () => {
    loadOptions();
    createFloatingEmojis();

    // 管理入口锁：本地存有密钥就静默验一次，对 → 常驻显示；否则隐藏
    if (getAdminToken()) {
        requestJson(`${API_BASE}/admin/check`, { admin: true })
            .then(() => revealManage())
            .catch(() => { /* 密钥失效，保持隐藏 */ });
    }
    // 解锁通道：URL 带 #manage，或连点 logo 5 次
    if (location.hash === '#manage') tryUnlockManage();
    window.addEventListener('hashchange', () => {
        if (location.hash === '#manage') tryUnlockManage();
    });
    let logoTaps = 0;
    let logoTapTimer = null;
    document.getElementById('brand-badge')?.addEventListener('click', () => {
        logoTaps += 1;
        clearTimeout(logoTapTimer);
        logoTapTimer = setTimeout(() => { logoTaps = 0; }, 1600);
        if (logoTaps >= 5) {
            logoTaps = 0;
            tryUnlockManage();
        }
    });

    // PWA：只在安全上下文注册（localhost / HTTPS）；失败静默，不影响普通使用
    if ('serviceWorker' in navigator) {
        const isSecure = window.location.protocol === 'https:'
            || ['localhost', '127.0.0.1'].includes(window.location.hostname);
        if (isSecure) {
            navigator.serviceWorker.register('/sw.js').catch(() => { /* 忽略 */ });
        }
    }

    const startBtn = document.getElementById('start-btn');
    const retryBtn = document.getElementById('retry-btn');
    const backHomeBtn = document.getElementById('back-home-btn');
    const homeBtn = document.getElementById('home-btn');
    const mapBtn = document.getElementById('map-btn');
    const manageBtn = document.getElementById('manage-btn');
    const addBtn = document.getElementById('add-btn');

    startBtn.addEventListener('click', startAnimation);
    retryBtn.addEventListener('click', redrawInPlace);
    backHomeBtn.addEventListener('click', () => switchScreen('start-screen'));
    homeBtn.addEventListener('click', () => switchScreen('start-screen'));
    if (mapBtn) mapBtn.addEventListener('click', () => switchScreen('map-screen'));
    manageBtn.addEventListener('click', () => switchScreen('manage-screen'));
    addBtn.addEventListener('click', addFoodOption);

    const importSampleBtn = document.getElementById('import-sample-btn');
    const importAppendBtn = document.getElementById('import-append-btn');
    const importReplaceBtn = document.getElementById('import-replace-btn');

    if (importSampleBtn) {
        importSampleBtn.addEventListener('click', () => {
            document.getElementById('import-text').value = HANGZHOU_SAMPLE.join('\n');
            showManageMessage('已载入杭州示例名单，可点「替换全部」或「追加导入」', 'info');
        });
    }
    if (importAppendBtn) importAppendBtn.addEventListener('click', () => runImport('append'));
    if (importReplaceBtn) importReplaceBtn.addEventListener('click', () => runImport('replace'));

    const skipBtn = document.getElementById('skip-btn');
    const delistBtn = document.getElementById('delist-btn');
    const resultMapLink = document.getElementById('result-map-link');

    if (skipBtn) skipBtn.addEventListener('click', skipCurrentResult);
    if (delistBtn) delistBtn.addEventListener('click', delistCurrentResult);
    if (resultMapLink) resultMapLink.addEventListener('click', openResultOnMap);

    const tokenSetBtn = document.getElementById('token-set-btn');
    const tokenClearBtn = document.getElementById('token-clear-btn');

    if (tokenSetBtn) {
        tokenSetBtn.addEventListener('click', () => {
            if (promptForAdminToken()) {
                updateTokenBadge();
                showManageMessage('管理密钥已保存', 'success');
            }
        });
    }

    if (tokenClearBtn) {
        tokenClearBtn.addEventListener('click', () => {
            setAdminToken('');
            updateTokenBadge();
            lockManage(); // 清除密钥 = 重新上锁，管理入口对访客隐去
            showManageMessage('已清除本机保存的管理密钥', 'info');
        });
    }

    updateTokenBadge();

    document.getElementById('food-name').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            document.getElementById('food-emoji').focus();
        }
    });

    document.getElementById('food-emoji').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            addFoodOption();
        }
    });

    startBtn.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            startAnimation();
        }
    });

    retryBtn.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            redrawInPlace();
        }
    });
});
