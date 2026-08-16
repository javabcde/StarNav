// 同步视图（sync）：浏览器收藏快照展平 → /api/sync/bookmarks 一键同步（书签同步，术语见 CONTEXT.md）。
// UMD：浏览器经典 script 下挂 globalThis.StarNavSyncView，node 测试走 module.exports。
(function (global) {
  'use strict';

  function createSyncView(ctx) {
    const { els, apiFetch, setStatus, escapeHTML } = ctx;

    // 浏览器书签根文件夹（不进入 folderPath）
    const ROOT_FOLDER_NAMES = new Set([
      '书签栏', '其他书签', '移动设备书签',
      'Bookmarks Bar', 'Other Bookmarks', 'Mobile Bookmarks',
    ]);

    // 递归展平 chrome.bookmarks.getTree() 结果：
    // 跳过文件夹节点（无 url）；根文件夹（getTree 根节点之下第一层）不拼入 folderPath，
    // 其顶层书签 folderPath 为空；自定义文件夹嵌套拼接为「父/子」。
    function flattenBookmarks(nodes, parentPath = '', depth = 0) {
      const items = [];
      for (const node of nodes || []) {
        if (node.url) {
          items.push({
            id: node.id,
            title: node.title || '',
            url: node.url,
            folderPath: parentPath,
          });
          continue;
        }
        const isRootFolder = depth === 1 && ROOT_FOLDER_NAMES.has(node.title);
        const childPath = isRootFolder ? '' : parentPath ? `${parentPath}/${node.title}` : node.title;
        if (node.children && node.children.length) {
          items.push(...flattenBookmarks(node.children, childPath, depth + 1));
        }
      }
      return items;
    }

    // 展示同步结果：统计 + 失败明细（url + reason）
    function renderSyncResult(data) {
      const stats = data.stats || {};
      const failedItems = Array.isArray(data.failedItems) ? data.failedItems : [];
      const count = (n) => n ?? 0;

      let html = `新增 ${count(stats.added)} · 更新 ${count(stats.updated)} · 删除 ${count(stats.deleted)} · 跳过 ${count(stats.skipped)} · 失败 ${count(stats.failed)}`;

      if (failedItems.length) {
        html += '<div style="margin-top: 8px; padding-top: 8px; max-height: 132px; overflow-y: auto; border-top: 1px dashed var(--border);">';
        html += failedItems.map((f) => {
          const url = escapeHTML(f.url || '未知地址');
          const reason = escapeHTML(f.reason || '未知原因');
          return `<div style="padding: 3px 0; font-size: 12px; word-break: break-all;"><span style="color: var(--danger);">${url}</span><span style="color: var(--muted);"> — ${reason}</span></div>`;
        }).join('');
        html += '</div>';
      }

      els.syncResult.innerHTML = html;
      els.syncResult.style.display = 'block';
    }

    async function syncBookmarks() {
      const tree = await chrome.bookmarks.getTree();
      const items = flattenBookmarks(tree);

      if (!items.length) {
        setStatus('未发现可同步的书签', 'warning');
        return false;
      }

      const result = await apiFetch('/api/sync/bookmarks', {
        method: 'POST',
        body: JSON.stringify({ items, source: 'extension' }),
      });

      renderSyncResult(result?.data || {});
      setStatus('同步完成。', 'success');
      // 同步可能增删改书签，后台重拉浏览缓存保持一致
      ctx.onCacheMutated();
      return true;
    }

    /** 挂载同步视图：绑定同步按钮；popup 壳在启动时调用一次（重复调用会重复绑定监听）。 */
    function mount() {
      els.syncBtn.addEventListener('click', async () => {
        els.syncBtn.disabled = true;
        els.syncResult.style.display = 'none';
        setStatus('同步中...');
        try {
          // 展平结果为 0 条时保持禁用（无书签可同步）
          if (await syncBookmarks()) {
            els.syncBtn.disabled = false;
          }
        } catch (error) {
          els.syncBtn.disabled = false;
          if (error.status === 400) {
            // 空快照保护等：展示服务端返回的 message
            setStatus(error.message || '同步未执行。', 'warning');
          } else {
            setStatus(error.message || '同步失败。', 'error');
          }
        }
      });
    }

    function onEnter() {
      // 无进入副作用
    }

    function onLeave() {
      // 无离开清理
    }

    return {
      mount,
      onEnter,
      onLeave,
      _handlers: { flattenBookmarks, syncBookmarks, renderSyncResult },
    };
  }

  const SyncView = { create: createSyncView };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SyncView;
  } else {
    global.StarNavSyncView = SyncView;
  }
})(typeof self !== 'undefined' ? self : globalThis);
