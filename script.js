const API_BASE = `${window.location.origin}/api`;

const TODAY_COUNT_KEY = 'today_count';
const LAST_DATE_KEY = 'last_date';

const MAX_NAME_LENGTH = 40;
const MAX_EMOJI_LENGTH = 8;

let foodOptions = [];
let isAnimating = false;
let editingOptionId = null;

/* 关键词 → Emoji 自动匹配（自上而下，先匹配先生效） */
const EMOJI_RULES = [
    ['火锅', '🍲'], ['串串', '🍢'], ['烧烤', '🍢'],
    ['虾', '🦐'], ['蟹', '🦀'], ['海鲜', '🦐'], ['鱼', '🐟'],
    ['鸭', '🦆'], ['鸡', '🍗'],
    ['牛', '🥩'], ['羊', '🥩'], ['肉', '🥩'], ['排', '🥩'], ['烤', '🍢'],
    ['面', '🍜'], ['粉', '🍜'],
    ['生煎', '🥟'], ['饺', '🥟'], ['馄饨', '🥟'], ['包子', '🥟'], ['点心', '🥟'], ['小吃', '🥢'],
    ['粥', '🥣'], ['饭', '🍚'],
    ['寿司', '🍣'], ['日料', '🍣'], ['刺身', '🍣'],
    ['披萨', '🍕'], ['汉堡', '🍔'], ['咖喱', '🍛'],
    ['甜品', '🍰'], ['蛋糕', '🍰'], ['糖', '🍬'],
    ['奶茶', '🧋'], ['豆浆', '🥛'], ['咖啡', '☕'], ['茶', '🍵'],
    ['沙拉', '🥗'], ['凉拌', '🥗'], ['素', '🥗']
];

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

    if (mode === 'replace' && !window.confirm(`确定用这份 ${names.length} 家名单替换当前全部选项吗？`)) {
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode, items })
        });

        foodOptions = result.options;
        editingOptionId = null;
        updateStats();
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

async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    const contentType = response.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');
    const body = isJson ? await response.json() : null;

    if (!response.ok) {
        const errorMessage = body && body.error ? body.error : `请求失败（${response.status}）`;
        throw new Error(errorMessage);
    }

    return body;
}

async function requestNoContent(url, options = {}) {
    const response = await fetch(url, options);
    if (!response.ok) {
        let errorMessage = `请求失败（${response.status}）`;
        try {
            const body = await response.json();
            if (body && body.error) errorMessage = body.error;
        } catch (e) {
            // ignore json parse error
        }
        throw new Error(errorMessage);
    }
}

async function loadOptions({ silent = false } = {}) {
    try {
        const options = await requestJson(`${API_BASE}/options`);
        foodOptions = options;
        updateStats();

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
    if (foodOptions.length === 0) {
        return { name: '请先添加餐饮选项', emoji: '🍽️' };
    }

    const randomIndex = Math.floor(Math.random() * foodOptions.length);
    return foodOptions[randomIndex];
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
        emojiElement.textContent = finalFood.emoji;
        resultElement.textContent = finalFood.name;
        resultContainer.classList.add('revealed');
        celebrate(resultContainer);
        incrementTodayCount();
        isAnimating = false;
    };

    tick();
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

    if (screenId === 'manage-screen') {
        document.getElementById('manage-btn').classList.add('active');
        loadOptions({ silent: true });
        renderOptionsList();
    }
}

function validateOptionInput(name, emoji) {
    if (!name) return '请输入餐饮名称';
    if (!emoji) return '请输入 Emoji 图标';
    if (name.length > MAX_NAME_LENGTH) return `名称不能超过 ${MAX_NAME_LENGTH} 个字符`;
    if (emoji.length > MAX_EMOJI_LENGTH) return `Emoji 不能超过 ${MAX_EMOJI_LENGTH} 个字符`;
    return null;
}

async function addFoodOption() {
    const nameInput = document.getElementById('food-name');
    const emojiInput = document.getElementById('food-emoji');
    const addBtn = document.getElementById('add-btn');

    const name = nameInput.value.trim();
    const emoji = emojiInput.value.trim();

    const validationError = validateOptionInput(name, emoji);
    if (validationError) {
        showManageMessage(validationError, 'error');
        return;
    }

    addBtn.disabled = true;

    try {
        const newOption = await requestJson(`${API_BASE}/options`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name, emoji })
        });

        foodOptions.push(newOption);
        updateStats();
        renderOptionsList();

        nameInput.value = '';
        emojiInput.value = '';

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
            method: 'DELETE'
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

    if (!nameInput || !emojiInput) return;

    const name = nameInput.value.trim();
    const emoji = emojiInput.value.trim();

    const validationError = validateOptionInput(name, emoji);
    if (validationError) {
        showManageMessage(validationError, 'error');
        return;
    }

    try {
        const updatedOption = await requestJson(`${API_BASE}/options/${id}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name, emoji })
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

    const actions = document.createElement('div');
    actions.className = 'option-actions';

    const editBtn = createButton('编辑', 'option-btn edit', () => startEditingOption(option.id));
    const deleteBtn = createButton('删除', 'option-btn delete', () => deleteFoodOption(option.id));

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);

    content.appendChild(emoji);
    content.appendChild(name);

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

    const actions = document.createElement('div');
    actions.className = 'option-actions';

    const saveBtn = createButton('保存', 'option-btn save', () => saveEditingOption(option.id));
    const cancelBtn = createButton('取消', 'option-btn cancel', cancelEditingOption);

    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);

    editForm.appendChild(emojiInput);
    editForm.appendChild(nameInput);

    optionItem.appendChild(editForm);
    optionItem.appendChild(actions);

    return optionItem;
}

function renderOptionsList() {
    const container = document.getElementById('options-container');
    container.innerHTML = '';

    if (foodOptions.length === 0) {
        const emptyState = document.createElement('p');
        emptyState.className = 'options-empty';
        emptyState.textContent = '暂无选项，请先添加';
        container.appendChild(emptyState);
        return;
    }

    foodOptions.forEach((option) => {
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

    const startBtn = document.getElementById('start-btn');
    const retryBtn = document.getElementById('retry-btn');
    const backHomeBtn = document.getElementById('back-home-btn');
    const homeBtn = document.getElementById('home-btn');
    const manageBtn = document.getElementById('manage-btn');
    const addBtn = document.getElementById('add-btn');

    startBtn.addEventListener('click', startAnimation);
    retryBtn.addEventListener('click', resetApp);
    backHomeBtn.addEventListener('click', () => switchScreen('start-screen'));
    homeBtn.addEventListener('click', () => switchScreen('start-screen'));
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
