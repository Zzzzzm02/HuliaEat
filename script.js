const API_BASE = `${window.location.origin}/api`;

const TODAY_COUNT_KEY = 'today_count';
const LAST_DATE_KEY = 'last_date';
const ADMIN_TOKEN_KEY = 'hulia_admin_token';
const SELECTED_LIST_KEY = 'selected_list_id';
const EXCLUDED_KEY = 'excluded_option_ids';

const MAX_NAME_LENGTH = 40;
const MAX_EMOJI_LENGTH = 8;

const ALL_LISTS_ID = 0;

let foodOptions = [];
let lists = [];
let selectedListId = ALL_LISTS_ID;
let isAnimating = false;
let editingOptionId = null;
let lastResult = null;

try {
    const stored = Number.parseInt(localStorage.getItem(SELECTED_LIST_KEY), 10);
    if (Number.isInteger(stored) && stored > 0) selectedListId = stored;
} catch (error) {
    // localStorage 不可用时保持「全部」
}

/* 关键词 → Emoji 自动匹配：表在 /emoji-rules.js，与后端共用唯一一份，别在这里再复制 */
const EMOJI_RULES = window.HULIA_EMOJI_RULES || [];

const DEFAULT_IMPORT_EMOJI = '🍽️';

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
            body: JSON.stringify(
                selectedListId === ALL_LISTS_ID
                    ? { mode, items }
                    : { mode, items, listId: Number(selectedListId) }
            )
        });

        foodOptions = result.options;
        editingOptionId = null;
        await loadLists();
        updateStats();
        renderOptionsList();

        const modeText = mode === 'replace' ? '替换' : '追加';
        const target = selectedListId === ALL_LISTS_ID ? '' : `（归入「${currentList().name}」）`;
        showManageMessage(`${modeText}成功，当前共 ${result.total} 家${target}`, 'success');

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
        renderListChips(); // /lists 常比 /options 先返回，chips 上的「全部」计数需要这里补一次
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

/* ---------------- 榜单与本机排除 ---------------- */

async function loadLists({ silent = true } = {}) {
    try {
        lists = await requestJson(`${API_BASE}/lists`);

        // 选中的榜单可能已被删除：回落到「全部」
        if (selectedListId !== ALL_LISTS_ID && !lists.some((list) => String(list.id) === String(selectedListId))) {
            selectedListId = ALL_LISTS_ID;
            try {
                localStorage.removeItem(SELECTED_LIST_KEY);
            } catch (error) {
                // ignore
            }
        }

        renderListChips();
        renderListsAdmin();
        renderOptionsList();
        updateStats();
    } catch (error) {
        console.error('加载榜单失败:', error);
        if (!silent) {
            showManageMessage(`榜单加载失败：${error.message}`, 'error');
        }
    }
}

function currentList() {
    if (selectedListId === ALL_LISTS_ID) return null;
    return lists.find((list) => String(list.id) === String(selectedListId)) || null;
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

// 当前榜单下的可选池（已剔除本机排除项）
function getPool() {
    const base = selectedListId === ALL_LISTS_ID
        ? foodOptions
        : foodOptions.filter((option) => (option.lists || []).some((list) => String(list.id) === String(selectedListId)));

    const excluded = new Set(getExcludedIds());
    return base.filter((option) => !excluded.has(String(option.id)));
}

function renderExclusionNote() {
    const note = document.getElementById('exclusion-note');
    if (!note) return;

    const baseSize = (selectedListId === ALL_LISTS_ID
        ? foodOptions
        : foodOptions.filter((option) => (option.lists || []).some((list) => String(list.id) === String(selectedListId)))).length;

    const visible = getPool().length;
    const hidden = baseSize - visible;

    if (hidden <= 0) {
        note.hidden = true;
        note.innerHTML = '';
        return;
    }

    note.hidden = false;
    note.textContent = `本榜单 ${baseSize} 家，本机已隐藏 ${hidden} 家（不影响他人）`;

    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'chip-action chip-action-quiet';
    restore.textContent = '恢复全部';
    restore.addEventListener('click', () => {
        setExcludedIds([]);
        showManageMessage('已恢复本榜单的全部店铺', 'info');
    });
    note.appendChild(document.createTextNode(' '));
    note.appendChild(restore);
}

function renderListChips() {
    const containers = ['list-chips', 'manage-list-chips', 'map-list-chips']
        .map((id) => document.getElementById(id))
        .filter(Boolean);
    if (!containers.length) return;

    const total = foodOptions.length;

    containers.forEach((container) => {
        container.innerHTML = '';

        const allChip = document.createElement('button');
        allChip.type = 'button';
        allChip.className = `chip${selectedListId === ALL_LISTS_ID ? ' active' : ''}`;
        allChip.textContent = `全部 ${total}`;
        allChip.addEventListener('click', () => selectList(ALL_LISTS_ID));
        container.appendChild(allChip);

        lists.forEach((list) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `chip${String(list.id) === String(selectedListId) ? ' active' : ''}`;
            chip.textContent = `${list.name} ${list.count}`;
            chip.addEventListener('click', () => selectList(list.id));
            container.appendChild(chip);
        });
    });

    renderExclusionNote();
}

function selectList(listId) {
    selectedListId = listId === ALL_LISTS_ID ? ALL_LISTS_ID : Number(listId) || ALL_LISTS_ID;

    try {
        if (selectedListId === ALL_LISTS_ID) {
            localStorage.removeItem(SELECTED_LIST_KEY);
        } else {
            localStorage.setItem(SELECTED_LIST_KEY, String(selectedListId));
        }
    } catch (error) {
        // ignore
    }

    renderListChips();
    renderOptionsList();
    renderListsAdmin();
    // 地图屏跟着同一个筛选走；还没初始化时内部会静默跳过
    if (window.HuliaMap) window.HuliaMap.refresh();
}

function renderListsAdmin() {
    const container = document.getElementById('lists-container');
    if (!container) return;

    container.innerHTML = '';

    if (!lists.length) {
        const empty = document.createElement('p');
        empty.className = 'options-empty';
        empty.textContent = '还没有榜单';
        container.appendChild(empty);
        return;
    }

    lists.forEach((list) => {
        const row = document.createElement('div');
        row.className = 'list-row';

        const name = document.createElement('span');
        name.className = 'list-row-name';
        name.textContent = list.name;

        const count = document.createElement('span');
        count.className = 'list-row-count';
        count.textContent = `${list.count} 家`;

        row.appendChild(name);
        row.appendChild(count);

        const actions = document.createElement('div');
        actions.className = 'list-row-actions';

        actions.appendChild(createButton('改名', 'option-btn edit', async () => {
            const input = window.prompt('榜单名称：', list.name);
            if (input === null) return;

            const nextName = input.trim();
            if (!nextName || nextName === list.name) return;

            try {
                await requestJson(`${API_BASE}/lists/${list.id}`, {
                    method: 'PATCH',
                    admin: true,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: nextName })
                });
                await loadLists();
                showManageMessage('榜单已改名', 'success');
            } catch (error) {
                showManageMessage(`改名失败：${error.message}`, 'error');
            }
        }));

        actions.appendChild(createButton('删除', 'option-btn delete', async () => {
            const ok = window.confirm(`删除榜单「${list.name}」？\n\n只会解除关联，${list.count} 家店铺本身会保留。`);
            if (!ok) return;

            try {
                await requestNoContent(`${API_BASE}/lists/${list.id}`, { method: 'DELETE', admin: true });
                if (String(selectedListId) === String(list.id)) selectList(ALL_LISTS_ID);
                await Promise.all([loadLists(), loadOptions({ silent: true })]);
                showManageMessage('榜单已删除，店铺仍保留在「全部」里', 'success');
            } catch (error) {
                showManageMessage(`删除失败：${error.message}`, 'error');
            }
        }));

        row.appendChild(actions);
        container.appendChild(row);
    });

    renderMembershipPicker();
}

// 「把已有店铺加入当前榜单」的下拉：只列出尚未属于当前榜单的店
function renderMembershipPicker() {
    const row = document.getElementById('membership-row');
    const select = document.getElementById('membership-select');
    if (!row || !select) return;

    const list = currentList();
    if (!list) {
        row.hidden = true;
        select.innerHTML = '';
        return;
    }

    const candidates = foodOptions.filter((option) =>
        !(option.lists || []).some((item) => String(item.id) === String(list.id))
    );

    if (!candidates.length) {
        row.hidden = true;
        select.innerHTML = '';
        return;
    }

    select.innerHTML = '';
    candidates.forEach((option) => {
        const element = document.createElement('option');
        element.value = option.id;
        element.textContent = `${option.emoji} ${option.name}`;
        select.appendChild(element);
    });

    row.hidden = false;
}

async function createList() {
    const input = document.getElementById('new-list-name');
    const name = input.value.trim();

    if (!name) {
        showManageMessage('请输入榜单名称', 'error');
        return;
    }

    try {
        await requestJson(`${API_BASE}/lists`, {
            method: 'POST',
            admin: true,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });

        input.value = '';
        await loadLists();
        showManageMessage(`榜单「${name}」已创建`, 'success');
    } catch (error) {
        showManageMessage(`创建失败：${error.message}`, 'error');
    }
}

async function addOptionToCurrentList() {
    const list = currentList();
    const select = document.getElementById('membership-select');
    if (!list || !select || !select.value) return;

    try {
        await requestJson(`${API_BASE}/lists/${list.id}/membership`, {
            method: 'POST',
            admin: true,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'add', optionIds: [Number(select.value)] })
        });

        await Promise.all([loadLists(), loadOptions({ silent: true })]);
        renderListChips();
        showManageMessage('已加入当前榜单', 'success');
    } catch (error) {
        showManageMessage(`加入失败：${error.message}`, 'error');
    }
}

async function removeOptionFromList(option, listId) {
    try {
        await requestJson(`${API_BASE}/lists/${listId}/membership`, {
            method: 'POST',
            admin: true,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'remove', optionIds: [Number(option.id)] })
        });

        await Promise.all([loadLists(), loadOptions({ silent: true })]);
        renderListChips();
        showManageMessage('已从该榜单移出（店铺本身保留）', 'success');
    } catch (error) {
        showManageMessage(`移出失败：${error.message}`, 'error');
    }
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

        const finalFood = getRandomFood();
        lastResult = finalFood && finalFood.id ? finalFood : null;
        emojiElement.textContent = finalFood.emoji;
        resultElement.textContent = finalFood.name;
        resultContainer.classList.add('revealed');
        celebrate(resultContainer);
        incrementTodayCount();
        updateResultActions();
        isAnimating = false;
    };

    tick();
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

        await Promise.all([loadOptions({ silent: true }), loadLists()]);
        switchScreen('start-screen');
        showManageMessage('该店铺已从菜单下架', 'success');
    } catch (error) {
        showResultNote('');
        showManageMessage(`下架失败：${error.message}`, 'error');
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

function resetApp() {
    if (isAnimating) return;

    const startScreen = document.getElementById('start-screen');
    const resultScreen = document.getElementById('result-screen');

    resultScreen.classList.remove('active');

    setTimeout(() => {
        startScreen.classList.add('active');
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
        loadLists();
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

const MAX_ADDRESS_LENGTH = 200;

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

async function addFoodOption() {
    const nameInput = document.getElementById('food-name');
    const emojiInput = document.getElementById('food-emoji');
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

    addBtn.disabled = true;

    try {
        const payload = { name, emoji, ...geo.fields };
        const newOption = await requestJson(`${API_BASE}/options`, {
            method: 'POST',
            admin: true,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(
                selectedListId === ALL_LISTS_ID
                    ? payload
                    : { ...payload, listIds: [Number(selectedListId)] }
            )
        });

        foodOptions.push(newOption);
        updateStats();
        renderOptionsList();

        nameInput.value = '';
        emojiInput.value = '';
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

    try {
        const updatedOption = await requestJson(`${API_BASE}/options/${id}`, {
            method: 'PATCH',
            admin: true,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name, emoji, ...geo.fields })
        });

        foodOptions = foodOptions.map((option) => (option.id === id ? updatedOption : option));
        editingOptionId = null;
        updateStats();
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

    // 所属榜单标签
    const tags = document.createElement('span');
    tags.className = 'option-tags';
    (option.lists || []).forEach((list) => {
        const tag = document.createElement('span');
        tag.className = 'option-tag';
        tag.textContent = list.name;
        tags.appendChild(tag);
    });

    // 已定位的店给一个 📍 标，方便知道哪些会上地图
    if (option.latitude != null && option.longitude != null) {
        const geoTag = document.createElement('span');
        geoTag.className = 'option-tag option-tag-geo';
        geoTag.title = option.address || `${option.latitude}, ${option.longitude}`;
        geoTag.textContent = '📍';
        tags.appendChild(geoTag);
    }

    if (getExcludedIds().includes(String(option.id))) {
        const hiddenTag = document.createElement('span');
        hiddenTag.className = 'option-tag option-tag-hidden';
        hiddenTag.textContent = '本机已隐藏';
        tags.appendChild(hiddenTag);
    }

    content.appendChild(tags);

    const actions = document.createElement('div');
    actions.className = 'option-actions';

    const activeList = currentList();

    if (activeList && (option.lists || []).some((list) => String(list.id) === String(activeList.id))) {
        actions.appendChild(createButton('移出本榜', 'option-btn quiet', () => removeOptionFromList(option, activeList.id)));
    }

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
    editForm.appendChild(geoRow);

    optionItem.appendChild(editForm);
    optionItem.appendChild(actions);

    return optionItem;
}

function renderOptionsList() {
    const container = document.getElementById('options-container');
    if (!container) return;

    container.innerHTML = '';

    const visible = selectedListId === ALL_LISTS_ID
        ? foodOptions
        : foodOptions.filter((option) => (option.lists || []).some((list) => String(list.id) === String(selectedListId)));

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
        emptyState.textContent = `「${(currentList() || {}).name || '该榜单'}」里还没有店铺，可在「榜单管理」里加入`;
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
    loadLists();
    createFloatingEmojis();

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
    retryBtn.addEventListener('click', resetApp);
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
    const createListBtn = document.getElementById('create-list-btn');
    const membershipAddBtn = document.getElementById('membership-add-btn');

    if (skipBtn) skipBtn.addEventListener('click', skipCurrentResult);
    if (delistBtn) delistBtn.addEventListener('click', delistCurrentResult);
    if (createListBtn) createListBtn.addEventListener('click', createList);
    if (membershipAddBtn) membershipAddBtn.addEventListener('click', addOptionToCurrentList);

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
            resetApp();
        }
    });
});
