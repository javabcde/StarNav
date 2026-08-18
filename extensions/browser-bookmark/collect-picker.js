// 右键收藏分类选择小窗（collect-picker-dialog 变更）：
// background 暂存候选（lastCollectCandidate）→ 本页读取 → 拉分类树
// （失败回退 options 缓存）→ 缩进树选分类 → 查重/仍然保存 →
// POST /api/sites → 记忆分类（lastCollectCategory）+ 清候选 + 关窗，
// 结果经 collect-result 消息由 background 统一系统通知。
// 纯逻辑（回退/默认选中/过滤）在 collect-picker-logic.js，可 node:test。
(function () {
  'use strict';

  const els = {
    title: document.getElementById('title'),
    closeBtn: document.getElementById('closeBtn'),
    candidateName: document.getElementById('candidateName'),
    candidateUrl: document.getElementById('candidateUrl'),
    categoryList: document.getElementById('categoryList'),
    categoryStatus: document.getElementById('categoryStatus'),
    duplicateBox: document.getElementById('duplicateBox'),
    saveBtn: document.getElementById('saveBtn'),
    forceSaveBtn: document.getElementById('forceSaveBtn'),
    status: document.getElementById('status'),
  };

  let config = { baseUrl: '', token: '', defaultCategory: '', siteName: 'StarNav' };
  let candidate = null;
  let fallbackCategories = [];
  let rememberedCategory = '';
  let flatCategories = []; // [{name, level}]（已过滤直属书签虚拟节点）
  let selectedCategory = '';
  let duplicate = null;
  let expanded = new Set(); // 展开的父分类名集合（初始全展开）
  let saving = false;

  function setStatus(text) {
    els.status.textContent = text || '';
  }

  // ── 装配：读配置 + 候选 + 记忆 + 回退缓存 ─────────────────────────
  async function loadConfig() {
    const sync = await chrome.storage.sync.get(Contract.CONFIG_KEYS.sync);
    const local = await chrome.storage.local.get([
      Contract.STORAGE_KEYS.LAST_COLLECT_CANDIDATE,
      Contract.STORAGE_KEYS.LAST_COLLECT_CATEGORY,
      ...Contract.CONFIG_KEYS.local,
    ]);
    config = {
      baseUrl: Contract.normalizeBaseUrl(sync.baseUrl),
      token: sync.token || '',
      defaultCategory: sync.defaultCategory || '',
      siteName: sync.siteName || 'StarNav',
    };
    candidate = local[Contract.STORAGE_KEYS.LAST_COLLECT_CANDIDATE] || null;
    rememberedCategory = local[Contract.STORAGE_KEYS.LAST_COLLECT_CATEGORY] || '';
    fallbackCategories = local.categories || [];
    els.title.textContent = `收藏到 ${config.siteName}`;
  }

  function renderCandidate() {
    els.candidateName.textContent = candidate.name;
    els.candidateUrl.textContent = candidate.url;
  }

  // ── 分类树：拉最新 → 回退本地缓存 → 未分类兜底 ────────────────────
  async function loadCategories() {
    try {
      const res = await Contract.apiFetch('/api/categories/tree', { baseUrl: config.baseUrl, token: config.token, timeoutMs: 10000 });
      const tree = Array.isArray(res && res.data) ? res.data : [];
      flatCategories = PickerLogic.pickRelevantCategories(BrowseLogic.flattenCategoryTree(tree));
    } catch {
      // 拉取失败（网络/token 无效）：回退 options 刷新缓存的那份（平铺 level 0）
      flatCategories = PickerLogic.pickRelevantCategories(PickerLogic.normalizeFallbackCategories(fallbackCategories));
    }
    if (!flatCategories.length) {
      flatCategories = [{ name: PickerLogic.UNCATEGORIZED, level: 0 }];
    }
    // 默认选中：上次记忆 → options 默认分类 → 未分类（记忆/配置失效自动回退）
    selectedCategory = PickerLogic.resolveDefaultCategory({
      remembered: rememberedCategory,
      configured: config.defaultCategory,
      available: flatCategories.map((n) => n.name),
    });
  }

  // ── 缩进树渲染：level 0 父行（有子带 ▾/▸ 切换）+ 子级缩进行 ──────
  // 父分类归属按 DFS 展平序推断（栈顶最近 level 0 祖先），支持任意深度缩进
  function groupByRoot(flat) {
    const roots = [];
    const childrenMap = new Map();
    const stack = [];
    for (const node of flat) {
      while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
      const root = stack.find((s) => s.level === 0) || null;
      if (node.level === 0) {
        roots.push(node);
      } else if (root) {
        if (!childrenMap.has(root.name)) childrenMap.set(root.name, []);
        childrenMap.get(root.name).push(node);
      }
      stack.push(node);
    }
    return { roots, childrenMap };
  }

  function renderCategoryTree() {
    const { roots, childrenMap } = groupByRoot(flatCategories);
    const rows = [];
    for (const root of roots) {
      const children = childrenMap.get(root.name) || [];
      const isActive = selectedCategory === root.name;
      rows.push(
        `<button type="button" class="cat-row level0${isActive ? ' active' : ''}" data-cat="${Contract.escapeHTML(root.name)}">` +
          `<span class="cat-arrow">${children.length ? (expanded.has(root.name) ? '▾' : '▸') : ''}</span>` +
          `${Contract.escapeHTML(root.name)}</button>`
      );
      if (children.length && expanded.has(root.name)) {
        rows.push(
          `<div class="cat-children">${children
            .map((c) => {
              const pad = 20 + (c.level - 1) * 16;
              return `<button type="button" class="cat-row level1${selectedCategory === c.name ? ' active' : ''}" style="padding-left:${pad}px" data-cat="${Contract.escapeHTML(c.name)}">${Contract.escapeHTML(c.name)}</button>`;
            })
            .join('')}</div>`
        );
      }
    }
    els.categoryList.innerHTML = rows.join('');
  }

  // 事件委托：点击行 = 选中；level 0 行同时切换子级展开
  function bindCategoryList() {
    els.categoryList.addEventListener('click', (event) => {
      const btn = event.target.closest('button.cat-row');
      if (!btn) return;
      const name = btn.dataset.cat;
      if (!name) return;
      selectedCategory = name;
      const isLevel0 = btn.classList.contains('level0');
      if (isLevel0) {
        if (expanded.has(name)) expanded.delete(name);
        else expanded.add(name);
      }
      renderCategoryTree();
    });
  }

  // ── 查重：打开时查一次；重复 → 提示 + 仍然保存（force=true）──────
  function showDuplicate(dup) {
    duplicate = dup || null;
    if (!duplicate) {
      els.duplicateBox.style.display = 'none';
      els.duplicateBox.textContent = '';
      els.forceSaveBtn.classList.add('hidden');
      els.saveBtn.classList.remove('hidden');
      return;
    }
    els.duplicateBox.style.display = 'block';
    els.duplicateBox.textContent = `检测到可能重复：${duplicate.name}\n${duplicate.url}`;
    els.forceSaveBtn.classList.remove('hidden');
    els.saveBtn.classList.add('hidden');
  }

  async function checkDuplicate() {
    try {
      const res = await Contract.apiFetch(`/api/sites/check-duplicate?url=${encodeURIComponent(candidate.url)}`, {
        baseUrl: config.baseUrl,
        token: config.token,
        timeoutMs: 10000,
      });
      const dup = res && res.data;
      if (dup && (dup.name || dup.url)) showDuplicate(dup);
    } catch {
      // 查重失败静默：保存时的 409 竞态仍会兜底提示
    }
  }

  // ── 保存：POST /api/sites（force=true 走仍然保存）──────────────────
  async function save({ force = false } = {}) {
    if (saving) return;
    if (!selectedCategory) {
      setStatus('请先选择分类');
      return;
    }
    saving = true;
    els.saveBtn.disabled = true;
    els.forceSaveBtn.disabled = true;
    setStatus('保存中...');
    try {
      const logo = `${config.baseUrl}/api/favicon?url=${encodeURIComponent(candidate.url)}`;
      const payload = Contract.buildCollectPayload({
        name: candidate.name,
        url: candidate.url,
        catelog: selectedCategory,
        desc: '通过浏览器插件一键收藏',
        visibility: 'public',
        logo,
      });
      await Contract.apiFetch(`/api/sites${force ? '?force=true' : ''}`, {
        baseUrl: config.baseUrl,
        token: config.token,
        method: 'POST',
        body: JSON.stringify(payload),
        timeoutMs: 15000,
      });
      // 记忆所选分类，下次打开默认选中；清除候选防残留重复弹窗
      await chrome.storage.local.set({ [Contract.STORAGE_KEYS.LAST_COLLECT_CATEGORY]: selectedCategory });
      await chrome.storage.local.remove(Contract.STORAGE_KEYS.LAST_COLLECT_CANDIDATE);
      chrome.runtime.sendMessage({
        type: Contract.MESSAGE_TYPES.COLLECT_RESULT,
        ok: true,
        category: selectedCategory,
      }).catch(() => {});
      window.close();
    } catch (err) {
      saving = false;
      els.saveBtn.disabled = false;
      els.forceSaveBtn.disabled = false;
      const statusCode = err.status || (err.data && err.data.code);
      if (statusCode === 409) {
        const dup = err.data && err.data.duplicate;
        if (dup && (dup.name || dup.url)) showDuplicate(dup);
        chrome.runtime.sendMessage({
          type: Contract.MESSAGE_TYPES.COLLECT_RESULT,
          ok: false,
          kind: 'duplicate',
          message: err.message,
        }).catch(() => {});
      } else if (err.status) {
        chrome.runtime.sendMessage({
          type: Contract.MESSAGE_TYPES.COLLECT_RESULT,
          ok: false,
          kind: 'server',
          message: err.message,
        }).catch(() => {});
      } else {
        chrome.runtime.sendMessage({
          type: Contract.MESSAGE_TYPES.COLLECT_RESULT,
          ok: false,
          kind: 'network',
          message: err.message,
        }).catch(() => {});
      }
      // 失败不关窗：用户可换分类/仍然保存/关闭重试
      setStatus('保存失败，请重试或关闭窗口');
    }
  }

  // ── 启动 ──────────────────────────────────────────────────────────
  async function init() {
    els.closeBtn.addEventListener('click', () => window.close());
    bindCategoryList();
    els.saveBtn.addEventListener('click', () => save());
    els.forceSaveBtn.addEventListener('click', () => save({ force: true }));

    await loadConfig();
    if (!PickerLogic.isCollectCandidate(candidate)) {
      // 候选缺失/形状不符（小窗被直接打开、候选已被清除）：只给关闭出口
      els.candidateName.textContent = '未找到待收藏内容';
      els.candidateUrl.textContent = '';
      els.categoryList.innerHTML = '<div class="cat-empty">请回到网页重新右键「收藏当前网页」。</div>';
      els.saveBtn.disabled = true;
      els.forceSaveBtn.classList.add('hidden');
      return;
    }

    renderCandidate();
    els.saveBtn.disabled = true; // 分类就绪后启用
    await loadCategories();
    els.saveBtn.disabled = false;
    // 初始全展开：所有有子级的 level 0 分类展开（记忆分类可能在子级里）
    expanded = new Set(flatCategories.filter((n) => n.level === 0).map((n) => n.name));
    renderCategoryTree();
    checkDuplicate();
  }

  init();
})();
