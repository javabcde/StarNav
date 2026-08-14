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

浏览视图 SHALL 以**全量缓存 + 客户端过滤**工作：缓存保存当前 token 可见的全部书签与分类树；搜索（输入防抖 300ms）、分类筛选（含子孙分类）、排序切换（默认站点序 / 热门 / 最近访问 / 名称）、「加载更多」分页（pageSize 30）SHALL 全部在客户端对缓存过滤，不发起网络请求。打开弹窗 SHALL：有新鲜缓存（TTL 内）时直接渲染缓存且零请求；无缓存时显示初始化态（骨架 + 「正在初始化书签…」文案）并拉取全量后渲染；缓存过期时先渲染旧数据并后台拉取全量替换。提供手动刷新按钮（强制跳过缓存）。分类胶囊 SHALL 含「全部」+ 各分类（含私人书签，token 有效时）。

#### Scenario: 默认加载全量并本地渲染
- **WHEN** 打开浏览视图且本地有新鲜全量缓存
- **THEN** 直接渲染缓存书签与分类胶囊，不发任何 `/api/config` 请求

#### Scenario: 无缓存首次打开
- **WHEN** 打开浏览视图且本地无缓存
- **THEN** 显示初始化态（骨架 + 文案），全量数据到位后渲染列表

#### Scenario: 分类筛选
- **WHEN** 用户点击某个分类胶囊（父分类含其全部子孙分类的书签）
- **THEN** 列表立即切换为该分类书签，无网络请求

#### Scenario: 搜索
- **WHEN** 用户输入关键词并停顿 300ms
- **THEN** 列表按关键词客户端过滤（名称/URL/分类子串，大小写不敏感），与当前分类组合

#### Scenario: 排序切换
- **WHEN** 用户切换排序为「热门」
- **THEN** 列表按 hits 降序立即重排，无网络请求

#### Scenario: 加载更多
- **WHEN** 当前已渲染条数未到缓存 total，用户点击「加载更多」
- **THEN** 追加下一批（30 条）书签到列表末尾，无网络请求

#### Scenario: 缓存过期
- **WHEN** 缓存超过 TTL
- **THEN** 先渲染旧缓存数据，后台拉取全量替换并更新缓存

#### Scenario: 手动刷新
- **WHEN** 用户点击刷新按钮
- **THEN** 强制拉取全量并替换缓存

#### Scenario: 图标缺失占位
- **WHEN** 书签无 logo 或 logo 加载失败
- **THEN** 列表项显示星标占位（✦ + 首字母，星云色板），不发外部请求

### Requirement: 全量数据接口

`GET /api/config?all=1` SHALL 返回当前鉴权可见的全部书签（忽略 page/pageSize 分页），按 sort 参数或默认排序（创建时间倒序）排列，可见性过滤与现有分页模式完全一致；响应含 `total` 全量条数。

#### Scenario: 全量拉取
- **WHEN** 插件携带有效 Bearer Token 请求 `GET /api/config?all=1`
- **THEN** 返回全部可见书签（含 token 可见的私人书签），`total` 为全量条数

### Requirement: 缓存失效与重拉

收藏保存（含强制保存）与一键同步成功 SHALL 触发全量缓存重拉（等待任何在途加载完成后执行，保证新缓存包含刚写入的数据）；重拉失败 SHALL 静默保留旧缓存。

#### Scenario: 收藏后缓存更新
- **WHEN** 用户在收藏视图保存新书签成功
- **THEN** 后台重拉全量缓存，之后浏览视图可见新书签

#### Scenario: 同步后缓存更新
- **WHEN** 用户执行一键同步且成功
- **THEN** 后台重拉全量缓存，浏览视图反映同步结果

### Requirement: 旧格式缓存失效重建

旧格式缓存（无 `kind: 'full'`，含视图签名与单页数据的旧版本格式）SHALL 被视为无效：打开浏览视图时直接进入初始化态并拉取全量重建，不渲染旧数据、不提供兼容路径。

#### Scenario: 升级后首次打开
- **WHEN** 插件升级后打开，本地仍是旧格式缓存
- **THEN** 不渲染旧缓存，显示初始化态并拉取全量后渲染新格式缓存

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
