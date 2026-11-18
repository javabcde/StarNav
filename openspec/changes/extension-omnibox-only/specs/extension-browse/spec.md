## ADDED Requirements

### Requirement: 弹窗搜索直开

插件弹窗 SHALL 在打开后聚焦站内浏览搜索框并全选已有内容，使用户无需鼠标即可输入。搜索框内按 Enter 时，插件 SHALL 先同步应用当前关键词（不受 300ms 防抖影响），再打开当前列表第一条匹配书签（沿用条目点击路径：新标签页打开并关闭弹窗）。空输入或列表无匹配时 SHALL NOT 跳转。

#### Scenario: 快捷键打开后直接搜索
- **WHEN** 用户按 `Ctrl+Shift+F` 打开弹窗并输入 `git` 后立即按 Enter
- **THEN** 列表先按 `git` 过滤，再打开第一条匹配书签，弹窗关闭

#### Scenario: 空输入回车
- **WHEN** 搜索框为空（或仅空白）时用户按 Enter
- **THEN** 不拦截默认行为，也不打开任何书签

#### Scenario: 无匹配回车
- **WHEN** 关键词无匹配时用户按 Enter
- **THEN** 停留在弹窗并显示空结果提示，不跳转
