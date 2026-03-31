# 狐狸今天吃什么

一个轻量级、趣味性强的网页应用，帮助用户快速、有趣地决定当日餐食。

## 项目概述

"狐狸今天吃什么"是一个解决选择困难症的网页应用。用户点击按钮后，系统通过抽奖动画随机展示一个餐饮选项，整体设计简约、现代、高级感。

**支持多用户共享数据**：使用Node.js后端，所有用户看到的餐饮选项相同，支持跨浏览器、跨设备访问。

## 核心功能

- 🎯 主界面：简约现代的设计，居中显示主按钮
- 🎭 抽奖动画：转盘式动画效果，持续2-3秒，营造悬念感
- 📊 结果展示：优雅的结果呈现，附带emoji图标
- 🔄 再抽一次：支持重新选择，操作流畅
- 📱 响应式设计：适配桌面、平板及手机屏幕
- 🌐 数据共享：所有用户共享同一份餐饮选项数据
- ✏️ 选项管理：支持添加、删除餐饮选项

## 技术栈

### 前端
- HTML5 + CSS3 + JavaScript (ES6+)
- Google Fonts (Inter)

### 后端
- Node.js + Express
- 内存存储（重启后数据重置）

## 本地运行

### 安装依赖

```bash
npm install
```

### 启动服务器

```bash
npm start
```

服务器将在 `http://localhost:3000` 启动。

### 开发模式

```bash
npm run dev
```

## 项目结构

```
.
├── index.html      # 主页面
├── styles.css      # 样式文件
├── script.js       # 前端JavaScript逻辑
├── server.js       # 后端服务器代码
├── package.json    # 项目配置文件
├── image1/         # 图片资源文件夹
│   └── eateat.jpg  # Logo图片
└── README.md       # 项目说明
```

## API接口

### 获取所有选项
- **GET** `/api/options`
- 返回所有餐饮选项

### 添加选项
- **POST** `/api/options`
- 请求体：`{ "name": "选项名称", "emoji": "🍽️" }`
- 返回新创建的选项

### 更新选项
- **PUT** `/api/options/:id`
- 请求体：`{ "name": "新名称", "emoji": "🍽️" }`
- 返回更新后的选项

### 删除选项
- **DELETE** `/api/options/:id`
- 返回204状态码

## 餐饮选项

应用内置了39种餐饮选项，涵盖：
- 八大菜系（川菜、粤菜、湘菜、鲁菜、苏菜、浙菜、闽菜、徽菜）
- 特色美食（火锅、烧烤、麻辣烫、串串香等）
- 西餐（披萨、汉堡、牛排、意大利面等）
- 日韩料理（寿司、拉面、石锅拌饭等）
- 中式小吃（包子、饺子、面条、粥等）
- 饮品甜品（奶茶、咖啡、甜品等）

## 设计特点

- 🎨 简约现代的UI设计
- 🌈 柔和的渐变背景
- ✨ 流畅的动画效果
- 🎯 响应式布局
- ♿ 无障碍支持
- 🍎 飘落的美食emoji动画

## 浏览器兼容性

- Chrome (最新两个版本)
- Firefox (最新两个版本)
- Safari (最新两个版本)
- Edge (最新两个版本)

## 部署

### 阿里云部署

1. **创建ECS实例**
   - 选择Ubuntu 20.04 LTS
   - 开放80端口

2. **连接服务器**
   ```bash
   ssh root@您的服务器IP
   ```

3. **安装Node.js**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

4. **克隆代码**
   ```bash
   git clone https://github.com/Zzzzzm02/HuliaEat.git
   cd HuliaEat
   npm install
   ```

5. **安装PM2（进程管理器）**
   ```bash
   sudo npm install -g pm2
   pm2 start server.js --name hulia-eat
   pm2 startup
   pm2 save
   ```

6. **安装Nginx**
   ```bash
   sudo apt update
   sudo apt install nginx
   ```

7. **配置Nginx反向代理**
   ```bash
   sudo nano /etc/nginx/sites-available/hulia
   ```
   
   添加以下内容：
   ```nginx
   server {
       listen 80;
       server_name 您的域名或IP;
       
       location / {
           proxy_pass http://localhost:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```

8. **启用配置**
   ```bash
   sudo ln -s /etc/nginx/sites-available/hulia /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl restart nginx
   ```

### 其他部署平台

- **Vercel**: 支持Node.js后端部署
- **Railway**: 支持Node.js应用部署
- **Heroku**: 传统PaaS平台

## 注意事项

⚠️ **数据持久化**：当前使用内存存储，服务器重启后数据会重置。如需持久化存储，建议：
- 使用MongoDB、MySQL等数据库
- 或使用JSON文件存储

## 许可证

MIT License

## 贡献

欢迎提交Issue和Pull Request！

---

Made with ❤️ by Fox
