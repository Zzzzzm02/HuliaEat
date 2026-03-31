const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

let foodOptions = [
    { id: 1, name: '川菜', emoji: '🌶️' },
    { id: 2, name: '粤菜', emoji: '🍤' },
    { id: 3, name: '湘菜', emoji: '🥘' },
    { id: 4, name: '鲁菜', emoji: '🐟' },
    { id: 5, name: '苏菜', emoji: '🦐' },
    { id: 6, name: '浙菜', emoji: '🍜' },
    { id: 7, name: '闽菜', emoji: '🦪' },
    { id: 8, name: '徽菜', emoji: '🥩' },
    { id: 9, name: '火锅', emoji: '🍲' },
    { id: 10, name: '烧烤', emoji: '🍢' },
    { id: 11, name: '麻辣烫', emoji: '🌶️' },
    { id: 12, name: '串串香', emoji: '🍡' },
    { id: 13, name: '寿司', emoji: '🍣' },
    { id: 14, name: '拉面', emoji: '🍜' },
    { id: 15, name: '披萨', emoji: '🍕' },
    { id: 16, name: '汉堡', emoji: '🍔' },
    { id: 17, name: '炸鸡', emoji: '🍗' },
    { id: 18, name: '牛排', emoji: '🥩' },
    { id: 19, name: '意大利面', emoji: '🍝' },
    { id: 20, name: '生鱼片', emoji: '🐟' },
    { id: 21, name: '天妇罗', emoji: '🍤' },
    { id: 22, name: '咖喱饭', emoji: '🍛' },
    { id: 23, name: '石锅拌饭', emoji: '🍚' },
    { id: 24, name: '冷面', emoji: '🍜' },
    { id: 25, name: '烤肉', emoji: '🥩' },
    { id: 26, name: '烤鸭', emoji: '🦆' },
    { id: 27, name: '包子', emoji: '🥟' },
    { id: 28, name: '饺子', emoji: '🥟' },
    { id: 29, name: '馄饨', emoji: '🥟' },
    { id: 30, name: '面条', emoji: '🍜' },
    { id: 31, name: '米饭', emoji: '🍚' },
    { id: 32, name: '粥', emoji: '🍲' },
    { id: 33, name: '肠粉', emoji: '🍤' },
    { id: 34, name: '烧腊', emoji: '🥩' },
    { id: 35, name: '卤味', emoji: '🍗' },
    { id: 36, name: '凉拌菜', emoji: '🥗' },
    { id: 37, name: '甜品', emoji: '🍰' },
    { id: 38, name: '奶茶', emoji: '🥤' },
    { id: 39, name: '咖啡', emoji: '☕' }
];

let nextId = 40;

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/options', (req, res) => {
    res.json(foodOptions);
});

app.post('/api/options', (req, res) => {
    const { name, emoji } = req.body;
    
    if (!name || !emoji) {
        return res.status(400).json({ error: '名称和emoji不能为空' });
    }
    
    const newOption = {
        id: nextId++,
        name,
        emoji
    };
    
    foodOptions.push(newOption);
    res.status(201).json(newOption);
});

app.put('/api/options/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const { name, emoji } = req.body;
    
    const optionIndex = foodOptions.findIndex(opt => opt.id === id);
    
    if (optionIndex === -1) {
        return res.status(404).json({ error: '选项不存在' });
    }
    
    if (name) foodOptions[optionIndex].name = name;
    if (emoji) foodOptions[optionIndex].emoji = emoji;
    
    res.json(foodOptions[optionIndex]);
});

app.delete('/api/options/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const optionIndex = foodOptions.findIndex(opt => opt.id === id);
    
    if (optionIndex === -1) {
        return res.status(404).json({ error: '选项不存在' });
    }
    
    foodOptions.splice(optionIndex, 1);
    res.status(204).send();
});

app.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
    console.log('狐狸今天吃什么应用已启动！');
});
