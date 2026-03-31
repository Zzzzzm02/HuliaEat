const DEFAULT_FOOD_OPTIONS = [
    { name: '川菜', emoji: '🌶️' },
    { name: '粤菜', emoji: '🍤' },
    { name: '湘菜', emoji: '🥘' },
    { name: '鲁菜', emoji: '🐟' },
    { name: '苏菜', emoji: '🦐' },
    { name: '浙菜', emoji: '🍜' },
    { name: '闽菜', emoji: '🦪' },
    { name: '徽菜', emoji: '🥩' },
    { name: '火锅', emoji: '🍲' },
    { name: '烧烤', emoji: '🍢' },
    { name: '麻辣烫', emoji: '🌶️' },
    { name: '串串香', emoji: '🍡' },
    { name: '寿司', emoji: '🍣' },
    { name: '拉面', emoji: '🍜' },
    { name: '披萨', emoji: '🍕' },
    { name: '汉堡', emoji: '🍔' },
    { name: '炸鸡', emoji: '🍗' },
    { name: '牛排', emoji: '🥩' },
    { name: '意大利面', emoji: '🍝' },
    { name: '生鱼片', emoji: '🐟' },
    { name: '天妇罗', emoji: '🍤' },
    { name: '咖喱饭', emoji: '🍛' },
    { name: '石锅拌饭', emoji: '🍚' },
    { name: '冷面', emoji: '🍜' },
    { name: '烤肉', emoji: '🥩' },
    { name: '烤鸭', emoji: '🦆' },
    { name: '包子', emoji: '🥟' },
    { name: '饺子', emoji: '🥟' },
    { name: '馄饨', emoji: '🥟' },
    { name: '面条', emoji: '🍜' },
    { name: '米饭', emoji: '🍚' },
    { name: '粥', emoji: '🍲' },
    { name: '肠粉', emoji: '🍤' },
    { name: '烧腊', emoji: '🥩' },
    { name: '卤味', emoji: '🍗' },
    { name: '凉拌菜', emoji: '🥗' },
    { name: '甜品', emoji: '🍰' },
    { name: '奶茶', emoji: '🥤' },
    { name: '咖啡', emoji: '☕' }
];

const STORAGE_KEY = 'food_options';
const TODAY_COUNT_KEY = 'today_count';
const LAST_DATE_KEY = 'last_date';

let foodOptions = [];
let isAnimating = false;

function loadOptions() {
    const savedOptions = localStorage.getItem(STORAGE_KEY);
    if (savedOptions) {
        try {
            foodOptions = JSON.parse(savedOptions);
        } catch (e) {
            console.error('Failed to parse saved options:', e);
            foodOptions = [...DEFAULT_FOOD_OPTIONS];
        }
    } else {
        foodOptions = [...DEFAULT_FOOD_OPTIONS];
        saveOptions();
    }
    updateStats();
}

function saveOptions() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(foodOptions));
    updateStats();
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
        count = parseInt(localStorage.getItem(TODAY_COUNT_KEY) || '0');
    } else {
        count = 0;
        localStorage.setItem(LAST_DATE_KEY, today);
        localStorage.setItem(TODAY_COUNT_KEY, '0');
    }
    
    document.getElementById('today-count').textContent = count;
}

function incrementTodayCount() {
    const today = new Date().toDateString();
    const lastDate = localStorage.getItem(LAST_DATE_KEY);
    
    if (lastDate === today) {
        const currentCount = parseInt(localStorage.getItem(TODAY_COUNT_KEY) || '0');
        localStorage.setItem(TODAY_COUNT_KEY, (currentCount + 1).toString());
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

function animateResult() {
    const emojiElement = document.getElementById('emoji');
    const resultElement = document.getElementById('food-result');
    
    let counter = 0;
    const maxIterations = 30;
    const delay = 50;
    
    const animationInterval = setInterval(() => {
        const randomFood = getRandomFood();
        emojiElement.textContent = randomFood.emoji;
        resultElement.textContent = randomFood.name;
        
        counter++;
        if (counter >= maxIterations) {
            clearInterval(animationInterval);
            const finalFood = getRandomFood();
            emojiElement.textContent = finalFood.emoji;
            resultElement.textContent = finalFood.name;
            incrementTodayCount();
            isAnimating = false;
        }
    }, delay);
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
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
    });
    
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    document.getElementById(screenId).classList.add('active');
    
    if (screenId === 'start-screen') {
        document.getElementById('home-btn').classList.add('active');
    } else if (screenId === 'manage-screen') {
        document.getElementById('manage-btn').classList.add('active');
        renderOptionsList();
    }
}

function addFoodOption() {
    const nameInput = document.getElementById('food-name');
    const emojiInput = document.getElementById('food-emoji');
    
    const name = nameInput.value.trim();
    const emoji = emojiInput.value.trim();
    
    if (!name) {
        alert('请输入餐饮名称');
        return;
    }
    
    if (!emoji) {
        alert('请输入Emoji图标');
        return;
    }
    
    foodOptions.push({ name, emoji });
    saveOptions();
    renderOptionsList();
    
    nameInput.value = '';
    emojiInput.value = '';
}

function deleteFoodOption(index) {
    if (confirm('确定要删除这个选项吗？')) {
        foodOptions.splice(index, 1);
        saveOptions();
        renderOptionsList();
    }
}

function renderOptionsList() {
    const container = document.getElementById('options-container');
    container.innerHTML = '';
    
    if (foodOptions.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: #718096; padding: 2rem;">暂无选项，请添加</p>';
        return;
    }
    
    foodOptions.forEach((option, index) => {
        const optionElement = document.createElement('div');
        optionElement.className = 'option-item';
        optionElement.innerHTML = `
            <span class="option-emoji">${option.emoji}</span>
            <span class="option-name">${option.name}</span>
            <button class="delete-btn" onclick="deleteFoodOption(${index})">×</button>
        `;
        container.appendChild(optionElement);
    });
}

const FOOD_EMOJIS = ['🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌽', '🥕', '🧄', '🧅', '🥔', '🍠', '🥐', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🌭', '🍔', '🍟', '🍕', '🥪', '🥙', '🧆', '🌮', '🌯', '🥗', '🥘', '🥫', '🍝', '🍜', '🍲', '🍛', '🍣', '🍱', '🥟', '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠', '🥮', '🍢', '🍡', '🍧', '🍨', '🍦', '🍩', '🍪', '🎂', '🍰', '🍮', '🍭', '🍬', '🍫', '🍿', '🍩', '🍪', '🍮', '🍯', '🍼', '🥛', '🍵', '☕', '🍶', '🍺', '🍻', '🍷', '🍸', '🍹', '🍾', '🍿'];

function createFloatingEmojis() {
    setInterval(() => {
        const emoji = FOOD_EMOJIS[Math.floor(Math.random() * FOOD_EMOJIS.length)];
        const floatingEmoji = document.createElement('div');
        floatingEmoji.className = 'floating-emoji';
        floatingEmoji.textContent = emoji;
        
        const left = Math.random() * 100;
        const duration = 5 + Math.random() * 5;
        const size = 1.5 + Math.random() * 1.5;
        
        floatingEmoji.style.left = `${left}%`;
        floatingEmoji.style.animationDuration = `${duration}s`;
        floatingEmoji.style.fontSize = `${size}rem`;
        
        document.body.appendChild(floatingEmoji);
        
        setTimeout(() => {
            floatingEmoji.remove();
        }, duration * 1000);
    }, 200);
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