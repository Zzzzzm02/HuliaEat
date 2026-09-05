/*
 * 地图屏：高德 JSAPI 2.0 动态加载 + emoji 标注点。
 *
 * 数据与筛选直接读 script.js 的全局状态（foodOptions / selectedTag —— 经典脚本
 * 顶层的 let 在全局词法作用域里互通），本文件只读不写。
 * 高德 SDK 按需加载：只有第一次切到地图屏才会拉取，不影响首页打开速度。
 * 未配置 key（GET /api/config 返回 null）时显示配置指引，其余功能不受影响。
 */
(function () {
    const API_BASE = `${window.location.origin}/api`;
    // 杭州市中心（武林广场一带），没有任何标注点时的兜底视野
    const HANGZHOU_CENTER = [120.15507, 30.274085];

    let config = null;
    let configFetched = false;
    let sdkPromise = null;
    let map = null;
    let infoWindow = null;
    let markers = [];

    function el(id) {
        return document.getElementById(id);
    }

    function escapeHtml(value) {
        return String(value)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll('\'', '&#39;');
    }

    function showPlaceholder(html) {
        const placeholder = el('map-placeholder');
        if (!placeholder) return;
        placeholder.innerHTML = html;
        placeholder.hidden = false;
    }

    function hidePlaceholder() {
        const placeholder = el('map-placeholder');
        if (placeholder) placeholder.hidden = true;
    }

    async function fetchConfig() {
        if (configFetched) return config;
        try {
            const response = await fetch(`${API_BASE}/config`);
            const body = await response.json();
            config = body && body.amap ? body.amap : null;
        } catch (error) {
            console.error('读取地图配置失败:', error);
            config = null;
        }
        configFetched = true;
        return config;
    }

    function loadSdk(cfg) {
        if (sdkPromise) return sdkPromise;

        sdkPromise = new Promise((resolve, reject) => {
            if (window.AMap) {
                resolve();
                return;
            }
            if (cfg.securityCode) {
                window._AMapSecurityConfig = { securityJsCode: cfg.securityCode };
            }
            const script = document.createElement('script');
            script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(cfg.key)}`;
            script.onload = () => {
                if (window.AMap) resolve();
                else reject(new Error('脚本已加载但 AMap 不可用'));
            };
            script.onerror = () => {
                sdkPromise = null; // 允许下次进入时重试
                reject(new Error('脚本加载失败，检查网络后重试'));
            };
            document.head.appendChild(script);
        });
        return sdkPromise;
    }

    // 与 getPool 同源但不受「本机排除」影响：地图是看全貌，不是抽签
    function visibleOptions() {
        return selectedTag
            ? foodOptions.filter((option) => (option.tags || []).includes(selectedTag))
            : foodOptions;
    }

    function createPin(option) {
        const pin = document.createElement('div');
        pin.className = 'marker-pin';
        pin.textContent = option.emoji || '🍽️';
        pin.title = option.name;
        return pin;
    }

    function openPopup(option, marker) {
        const tagsHtml = (option.tags || [])
            .map((tag) => `<span class="map-popup-tag">${escapeHtml(tag)}</span>`)
            .join('');
        infoWindow.setContent(`
            <div class="map-popup">
                <div class="map-popup-head">
                    <span class="map-popup-emoji">${escapeHtml(option.emoji || '🍽️')}</span>
                    <strong>${escapeHtml(option.name)}</strong>
                </div>
                ${option.address ? `<div class="map-popup-address">📍 ${escapeHtml(option.address)}</div>` : ''}
                ${tagsHtml ? `<div class="map-popup-tags">${tagsHtml}</div>` : ''}
            </div>
        `);
        infoWindow.open(map, marker.getPosition());
    }

    function clearMarkers() {
        if (markers.length) map.remove(markers);
        markers = [];
    }

    function updateNotes(options) {
        const located = options.filter((option) => option.latitude != null && option.longitude != null);
        const unlocated = options.filter((option) => option.latitude == null || option.longitude == null);

        const countEl = el('map-located-count');
        if (countEl) countEl.textContent = String(located.length);

        const note = el('map-unlocated');
        if (!note) return options;

        if (!unlocated.length) {
            note.hidden = true;
            note.textContent = '';
            return located;
        }

        const preview = unlocated.slice(0, 10).map((option) => option.name).join('、');
        const suffix = unlocated.length > 10 ? ` 等 ${unlocated.length} 家` : '';
        note.textContent = `还没定位 ${unlocated.length} 家（不显示在图上）：${preview}${suffix}。可在管理页编辑里补地址或经纬度。`;
        note.hidden = false;
        return located;
    }

    function drawMarkers() {
        if (!map) return;
        clearMarkers();

        const located = updateNotes(visibleOptions());

        located.forEach((option) => {
            const marker = new window.AMap.Marker({
                position: [option.longitude, option.latitude],
                content: createPin(option),
                anchor: 'bottom-center',
                title: option.name
            });
            marker._optionId = option.id; // 结果页「在地图中查看」按 id 定位标记
            marker.on('click', () => openPopup(option, marker));
            markers.push(marker);
            map.add(marker);
        });

        if (markers.length) {
            map.setFitView(null, false, [60, 60, 60, 60]);
        } else {
            map.setCenter(HANGZHOU_CENTER);
            map.setZoom(12);
        }
    }

    async function render() {
        if (!el('map-container')) return;

        const cfg = await fetchConfig();

        // JSAPI 2.0 的个人 key 没有安全密钥时必然渲染失败，所以两者缺一都显示配置指引
        if (!cfg || !cfg.key || !cfg.securityCode) {
            showPlaceholder(
                '地图还没配置齐全：在服务器的 <code>.env</code> 里填 <code>AMAP_JSAPI_KEY</code>' +
                '（「Web端 (JS API)」key）与配套的 <code>AMAP_SECURITY_CODE</code>（控制台 key 旁的安全密钥），重启服务即可。<br>' +
                '批量查坐标另需一把「Web 服务」key（<code>AMAP_WEB_KEY</code>，跑 <code>npm run geocode</code>）。'
            );
            updateNotes(visibleOptions());
            return;
        }

        try {
            await loadSdk(cfg);
        } catch (error) {
            showPlaceholder(`高德地图加载失败：${error.message}`);
            return;
        }

        hidePlaceholder();

        if (!map) {
            map = new window.AMap.Map('map-container', {
                viewMode: '2D',
                zoom: 12,
                center: HANGZHOU_CENTER
            });
            // JSAPI 2.0 的控件是懒加载的，直接 new AMap.Scale() 会抛 not a constructor，
            // 必须走官方 plugin() 异步加载
            window.AMap.plugin('AMap.Scale', () => {
                map.addControl(new window.AMap.Scale());
            });
            infoWindow = new window.AMap.InfoWindow({ offset: new window.AMap.Pixel(0, -38) });
        }

        drawMarkers();
    }

    // 从结果页跳转过来：切到该店的位置并弹出气泡。
    // 店不在当前筛选里时至少把中心移过去（此时没有标记可弹）
    async function focus(optionId) {
        await render();
        if (!map) return false;

        const option = foodOptions.find((o) => String(o.id) === String(optionId));
        if (!option || option.latitude == null || option.longitude == null) return false;

        map.setZoomAndCenter(16, [option.longitude, option.latitude]);
        const marker = markers.find((m) => String(m._optionId) === String(optionId));
        if (marker) openPopup(option, marker);
        return true;
    }

    window.HuliaMap = {
        render,
        focus,
        // 榜单筛选或数据变化后的重绘；地图还没初始化时静默跳过
        refresh() {
            if (map) drawMarkers();
        }
    };
})();
