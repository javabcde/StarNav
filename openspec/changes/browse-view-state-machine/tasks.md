## 1. 状态模块

- [x] 1.1 popup-logic.js 新增浏览视图状态纯函数组：`defaultBrowseView()`、`applyBrowseFilter(view, next)`、`applyBrowsePage(view, page)`、`deserializeView(raw)`（非法输入回退 null）、`toggleCategoryInState(state, name)`（展开/收起/注入抑制）、`collapseChangedFilter(view, collapsedName, flat)`（自 popup.js renderCategories 闭包迁入，语义逐字保留）、`collectCategoryNames(flat, name)`。实现期修正：`serializeView` 未入模块——序列化形状（catelog/keyword/sort + ts）由 DOM 薄壳持有，受 popup-view-persist.test.js 正则锁约束（三字段必须在 popup.js 函数体内）
- [x] 1.2 新增 `tests/browse-view-state.test.js`（9 项行为测试：三规则交互/注入抑制/分页转移/反序列化往返与非法输入/子孙收集）——独立新文件，popup-logic.test.js 零改动（旧测试不动约束）

## 2. popup.js 接线

- [x] 2.1 浏览区状态收敛：筛选/搜索/排序/分页变更全部经 `applyBrowseFilter` / `applyBrowsePage` 纯 transition（`Object.assign` 落回 browseState）；手风琴转移经 `toggleCategoryInState` / `collapseChangedFilter`；本地 collectCategoryNames 拷贝删除
- [x] 2.2 `saveBrowseView` 原样保留（正则锁形态）；`restoreBrowseView` 改薄壳（`BrowseLogic.deserializeView` + localStorage 读，无 setItem）
- [x] 2.3 副作用句柄保留 DOM 层：browseLoadInFlight / browseMoreObserver / browseSearchTimer 未动

## 3. 测试迁移

- [x] 3.1 `popup-view-persist.test.js` 保持不动（薄壳维持正则面，原样通过）；状态模块行为测试在独立新文件（browse-view-state.test.js）
- [x] 3.2 `npm test` 全绿（166/166：新增 9 项状态测试，旧测试零改动）

## 4. 验证与收尾

- [x] 4.1 `npm run quality` 全绿（166/166）
- [x] 4.2 冒烟：CatsXP（独立临时 profile + CDP）注入全量缓存走通全交互——渲染/筛选（27 条）/搜索（7 条）/祖先注入（React 筛选）/收起重定向（27 条）/分页（40 条）/视图恢复，全程零 JS 错误；手风琴单条目语义与「激活按钮随组收起」为存量行为（提取逐字等价）
- [ ] 4.3 中文提交（git）
