# Extension Browse

插件内站内书签浏览：Token 授予私人书签读取，popup 三 tab 布局，浏览视图（搜索/分类/排序/分页/点击打开）。

## Requirements

### Requirement: Token 授予私人书签读取

读接口 SHALL 将有效 Bearer Token 计入私人书签访问：`/search`、`/ai/chat`、站点列表 GET 的私人书签可见性 SHALL 为「管理员会话 **或** 有效 Bearer Token **或** 私人书签密码 Cookie」。匿名访问 SHALL 仍不可见私人书签。token scope 不足 SHALL 仍返回 403（既有语义不变）。

#### Scenario: 插件 token 可见私人书签
- **WHEN** 插件携带有效 Bearer Token 请求 `GET /api/config?catalog=私人书签`
- **THEN** 返回私人书签列表，不返回 401

#### Scenario: 匿名仍不可见私人书签
- **WHEN** 匿名请求 `GET /api/config?catalog=私人书签`
- **THEN** 返回 401

#### Scenario: 搜索含私人书签
- **WHEN** 插件携带有效 Bearer Token 请求 `GET /api/search?q=关键词`
- **THEN** 结果包含私人书签分类中的匹配项

### Requirement: 插件 Tab 布局

插件弹窗 SHALL 提供三个视图 tab：浏览（默认）、收藏、同步。现有「收藏当前页」表单与「一键同步」区 SHALL 平移为对应 tab 内容，功能不变；tab 切换 SHALL 有激活态。

#### Scenario: 打开弹窗默认浏览视图
- **WHEN** 用户点击插件图标
- **THEN** 弹窗默认显示「浏览」视图，收藏/同步视图隐藏

#### Scenario: 切换收藏视图
- **WHEN** 用户点击「收藏」tab
- **THEN** 显示收藏当前页表单，原有保存流程可用

### Requirement: 浏览视图

浏览视图 SHALL 提供：搜索框（输入防抖 300ms，走 `GET /api/config?keyword=`）、分类胶囊横滚（「全部」+ 各分类，含私人书签）、排序切换（默认站点序 / 热门 / 最近访问 / 名称）、书签列表（logo 图标或首字母占位 + 标题 + 域名）、「加载更多」分页（pageSize 30，按响应 total 判终止）。打开弹窗 SHALL 并行拉取首页列表与分类列表；提供手动刷新按钮。

#### Scenario: 默认加载首页书签
- **WHEN** 打开浏览视图且未输入任何筛选
- **THEN** 展示第一页书签（站点序）与分类胶囊

#### Scenario: 分类筛选
- **WHEN** 用户点击某个分类胶囊
- **THEN** 列表切换为该分类第一页（`catalog` 参数），私人书签分类在 token 有效时可见

#### Scenario: 搜索
- **WHEN** 用户输入关键词并停顿 300ms
- **THEN** 列表按关键词过滤（与当前分类组合）

#### Scenario: 排序切换
- **WHEN** 用户切换排序为「热门」
- **THEN** 列表按 hits 降序重新请求

#### Scenario: 加载更多
- **WHEN** 当前页未到 total 上限，用户点击「加载更多」
- **THEN** 追加下一页书签到列表末尾

#### Scenario: 图标缺失占位
- **WHEN** 书签无 logo 字段
- **THEN** 列表项显示标题首字母占位，不发外部请求

### Requirement: 点击打开

点击书签 SHALL 直接打开原始 URL：`chrome.tabs.create({url, active: true})` 并关闭弹窗，不走站内 `/go` 跳转、不计数。

#### Scenario: 点击书签打开新标签
- **WHEN** 用户点击列表项
- **THEN** 新标签打开该书签原始 URL（前台激活），弹窗关闭

### Requirement: 状态与错误处理

浏览视图 SHALL 处理：加载中骨架、空态（无书签/搜索无结果）、错误态。401 错误 SHALL 提示 token 失效并引导重新配置；其他错误 SHALL 透出服务端 message。

#### Scenario: token 失效提示
- **WHEN** Bearer Token 无效或已吊销，浏览视图请求返回 401
- **THEN** 展示「Token 无效，请到设置页重新填写」类提示

#### Scenario: 空态
- **WHEN** 当前分类/搜索无书签
- **THEN** 展示空态文案（如「未找到书签」）
