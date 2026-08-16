import test from 'node:test';
import assert from 'node:assert/strict';

import { renderHomePage } from '../src/pages/home.js';
import { homeClientScript } from '../src/pages/home/clientScript.js';
import { adminJs } from '../src/pages/admin/scripts/index.js';
import { ACCENTS, accentVarsCss } from '../src/pages/home/accents.js';
import { CARD_CONTRACT } from '../src/pages/home/cardContract.js';

function createMemoryKv() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
    async delete(key) {
      store.delete(key);
    },
    async list(options = {}) {
      const prefix = options.prefix || '';
      return {
        keys: Array.from(store.keys())
          .filter((name) => name.startsWith(prefix))
          .sort()
          .map((name) => ({ name })),
      };
    },
  };
}

// 匿名首页渲染所需的最小 D1 面：settings 读取（缺省走代码默认）、
// 站点/分类/标签查询全空。
function createMockEnv() {
  return {
    NAV_AUTH: createMemoryKv(),
    NAV_DB: {
      prepare(sql) {
        return {
          bind() {
            return this;
          },
          async first() {
            return null;
          },
          async all() {
            if (sql.includes('FROM site_tags st') || sql.includes('JOIN tags t')) return { results: [] };
            if (sql.includes('FROM categories c')) return { results: [] };
            if (sql.includes('FROM sites s')) return { results: [] };
            return { results: [] };
          },
          async run() {
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
      async batch() {
        return [];
      },
    },
  };
}

test('renderHomePage：迁移后的 clientScript 模块完整输出（PWA/状态恢复/主题脚本在页面中）', async () => {
  const response = await renderHomePage(new Request('https://nav.example.com/'), createMockEnv(), {});
  const html = await response.text();

  assert.equal(response.status, 200);
  // 原内联客户端脚本（已迁入 pages/home/clientScript.js）仍随页面输出
  assert.ok(html.includes("serviceWorker.register('/sw.js')"), 'PWA 注册脚本应保留');
  assert.ok(html.includes('nav:pwa-state'), 'PWA 状态保存/恢复脚本应保留');
  assert.ok(html.includes('themeDefaults'), '主题默认值脚本应保留');
  // 服务端插值面仍生效（脚本函数参数透传；accent 默认值进头部主题脚本）
  assert.ok(html.includes("defaultAccent='blue'"), '默认 accent 插值应输出');
  // 主页面壳完整
  assert.ok(html.includes('<!DOCTYPE html>'), '页面壳应完整输出');
  // 字节级回归锁（String.raw 迁移）：输出必须与旧 cooked 模板等价——
  // 反斜杠不得双写、\uXXXX 转义必须已字形化（旧模板 cooked 后即字形）。
  assert.ok(html.includes('/\\*\\*([^*]+)\\*\\*/g'), '正则星号转义应为单反斜杠');
  assert.ok(!html.includes('/\\\\*\\\\*([^*]+)\\\\*\\\\*/g'), '正则星号转义不得双写');
  assert.ok(!html.includes('/\\\\*/g'), '正则星号转义不得双写');
  assert.ok(html.includes('本站已收录该网址：\\n#'), 'alert 换行应为单反斜杠转义');
  assert.ok(!html.includes('本站已收录该网址：\\\\n#'), 'alert 换行不得双写');
  assert.ok(html.includes('/^https?:\\/\\//i'), 'URL 正则应为单反斜杠');
  assert.ok(!html.includes('/^https?:\\\\/\\\\//i'), 'URL 正则不得双写');
  assert.ok(html.includes('\\\\$&'), 'highlightText 替换串应保留双反斜杠（合法唯一处）');
  assert.ok(html.includes('⏳') && !html.includes('\\u23f3'), 'u23f3 应字形化输出');
  assert.ok(html.includes('· '), 'u00b7 应字形化输出');
  assert.ok(html.includes('⚠️'), 'u26a0+ufe0f 应字形化输出');
});

test('renderHomePage：强调色单一来源（head 内联 accent 变量块、按钮色板、theme-color）', async () => {
  const response = await renderHomePage(new Request('https://nav.example.com/'), createMockEnv(), {});
  const html = await response.text();

  // accent 变量块由 accents.js 生成并内联 <head>（原 home-custom.css 块迁出）
  assert.ok(html.includes(`<style>${accentVarsCss()}</style>`), 'accent 变量块应由 accents.js 生成并内联到 head');
  for (const name of ['green', 'purple', 'rose', 'amber']) {
    assert.ok(html.includes(`html[data-accent="${name}"]`), `非默认档 ${name} 的变量块应出现`);
  }
  // theme-choice 按钮色值全部来自色板表（源码不再手写 hex）
  for (const [name, tone] of Object.entries(ACCENTS)) {
    assert.ok(
      html.includes(`class="theme-choice h-7 rounded-full ${tone.swatch} ring-offset-2" data-theme-key="accent" data-theme-value="${name}"`),
      `强调色按钮 ${name} 应使用色板 swatch 类`,
    );
  }
  // 默认蓝的 theme-color meta 取自色板
  assert.ok(html.includes(`<meta name="theme-color" content="${ACCENTS.blue.primary}">`), 'theme-color 应取色板 blue.primary');
});

test('homeClientScript：搜索结果卡与服务端卡片共用契约（data-catalog/data-tags、健康徽章）', () => {
  const script = homeClientScript({ defaultAccent: 'blue', pageBackgroundImage: false, defaultLayout: 'grid', i18n: undefined, myUsageScript: () => '', frontAdminScript: () => '', dragScript: () => '', adminAuthed: false, canDragSort: false });

  // 客户端搜索结果卡补齐 data-catalog/data-tags（与服务端 renderSiteCard 的 data 属性语义一致）
  const [, , , attrCatalog, attrTags] = CARD_CONTRACT.dataAttrs;
  assert.ok(script.includes(`${attrCatalog}="'+escapeText(cat)+'"`), '搜索结果卡应输出 data-catalog（契约属性名）');
  assert.ok(script.includes(`${attrTags}="'+escapeText(tags.join(' '))+'"`), '搜索结果卡应输出 data-tags（空格连接）');
  // 健康徽章 class 与文案来自契约常量
  assert.ok(script.includes(`class="${CARD_CONTRACT.healthBadgeClass}"`), '客户端健康徽章 class 应来自契约');
  assert.ok(script.includes(`>${CARD_CONTRACT.healthBadgeLabel}</span>`), '客户端健康徽章文案应来自契约');
  // themeColors 由色板生成，与迁移前字面量一致
  assert.ok(script.includes("const themeColors={blue:'#254267',green:'#265c44',purple:'#5b3b8c',rose:'#9f3758',amber:'#8a5a16'};"), 'themeColors 应由 accents.js 生成且值不变');
});

test('homeClientScript：顶部内联 esbuild 助手垫片（wrangler keepNames 打包后 toString 产出 __name 引用）', () => {
  const script = homeClientScript({ defaultAccent: 'blue', pageBackgroundImage: false, defaultLayout: 'grid', i18n: undefined, myUsageScript: () => '', frontAdminScript: () => '', dragScript: () => '', adminAuthed: false, canDragSort: false });
  const shim = 'var __defProp=Object.defineProperty;var __name=(t,v)=>__defProp(t,"name",{value:v,configurable:true});';
  assert.ok(script.includes(shim), 'homeClientScript 缺少 __name/__defProp 垫片——wrangler 部署后浏览器端 ReferenceError');
  assert.ok(script.indexOf(shim) < script.indexOf('const escapeText ='), '垫片须位于全部 toString 内联函数之前');
});

test('homeClientScript：themeDefaults 定义在位（623caf0 曾删定义留引用致 ReferenceError）', () => {
  const script = homeClientScript({ defaultAccent: 'blue', pageBackgroundImage: false, defaultLayout: 'grid', i18n: undefined, myUsageScript: () => '', frontAdminScript: () => '', dragScript: () => '', adminAuthed: false, canDragSort: false });
  assert.ok(script.includes("const themeDefaults={accent:'blue',density:'comfortable',bg:'soft',view:'detail',layout:'grid'};"), 'themeDefaults 定义缺失——主题初始化/重置/预设全链路 ReferenceError');
});

test('模板脚本引用完整性：所有调用点标识符均有定义（themeDefaults/IS_* 同类事故回归锁）', () => {
  const home = homeClientScript({ defaultAccent: 'blue', pageBackgroundImage: false, defaultLayout: 'grid', i18n: undefined, myUsageScript: () => '', frontAdminScript: () => '', dragScript: () => '', adminAuthed: false, canDragSort: false });
  const GLOBALS = new Set(('window document localStorage sessionStorage navigator fetch setTimeout clearTimeout setInterval clearInterval Date JSON Math String Number Boolean Array Object RegExp URL URLSearchParams DOMParser FileReader AbortController encodeURIComponent decodeURIComponent encodeURI decodeURI requestIdleCallback console alert confirm prompt location history Event CustomEvent Blob FormData Promise Intl performance requestAnimationFrame cancelAnimationFrame TextDecoder TextEncoder globalThis undefined NaN Infinity structuredClone getComputedStyle Element HTMLElement Node HTMLDocument self addEventListener removeEventListener dispatchEvent queueMicrotask XMLHttpRequest MutationObserver Error TypeError SyntaxError RangeError Map Set WeakMap WeakSet').split(' '));
  const KEYWORDS = new Set(('if function var let const for while return catch then finally async await new typeof instanceof delete void this super class extends import export default switch case break continue do else in of try throw yield debugger').split(' '));
  const check = (name, script, allowlist) => {
    const defined = new Set();
    let m;
    const defRe = /(?:function|class)\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
    while ((m = defRe.exec(script))) { if (m[1]) defined.add(m[1]); if (m[2]) defined.add(m[2]); }
    const missing = new Set();
    const callRe = /(?<![.\w)\]'"\x60:\/])([a-zA-Z_$][\w$]*)\s*\(/g;
    while ((m = callRe.exec(script))) {
      const id = m[1];
      if (defined.has(id) || GLOBALS.has(id) || KEYWORDS.has(id) || allowlist.includes(id)) continue;
      missing.add(id);
    }
    assert.deepEqual([...missing], [], `${name} 引用了未定义的标识符——模板/收编漏定义（themeDefaults/IS_DEAD_SITE 同类事故）`);
  };
  check('homeClientScript', home, ['toString']); // 仅注释/成员调用误报（.toString() 被 . 排除，裸调用不存在）
  check('adminJs', adminJs, ['toString', 'Logo', 'resolve', 'onSuccess', 'gradient']); // 注释/HTML 字符串/Promise 参数误报，非模板符号
});
