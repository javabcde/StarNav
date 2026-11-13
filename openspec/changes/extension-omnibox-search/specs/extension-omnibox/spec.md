## ADDED Requirements

### Requirement: 地址栏关键字入口

插件 SHALL 在 manifest 注册 omnibox 关键字 `sn`；地址栏输入 `sn` + 空格（或 Tab）后 SHALL 进入 StarNav 收藏搜索模式。

#### Scenario: 进入搜索模式
- **WHEN** 用户在地址栏输入 `sn` 后按空格
- **THEN** 地址栏进入扩展搜索模式，默认建议提示输入关键词

#### Scenario: 未配置插件
- **WHEN** 用户尚未填写 StarNav 地址或 Token 时进入搜索模式
- **THEN** 默认建议提示先在插件选项中配置 StarNav 地址与 Token

### Requirement: 建议来源与缓存刷新

建议 SHALL 来自本地全量缓存（`browse:cache:v1`），匹配过程 SHALL NOT 发起额外网络请求。缓存缺失时 SHALL 最多等待一次全量拉取 1.5 秒；缓存过期时 SHALL 先使用旧缓存生成建议，并在后台刷新（同一时间最多一个在途拉取，刷新节流 15 秒）。

#### Scenario: 有新鲜缓存
- **WHEN** 用户输入关键词且本地全量缓存未过期
- **THEN** 立即返回匹配建议，不发起网络请求

#### Scenario: 首次使用无缓存
- **WHEN** 用户输入关键词且本地无全量缓存
- **THEN** 等待一次全量拉取（上限 1.5 秒）后返回建议；超时则本次返回空建议

#### Scenario: 缓存过期
- **WHEN** 缓存超过 TTL
- **THEN** 本次建议使用旧缓存，后续输入前缓存已在后台刷新

### Requirement: 匹配与排序

匹配 SHALL 大小写不敏感，关键词按空白拆分为多个词且所有词 SHALL 在标题/URL/分类/标签任一字段命中。候选 SHALL 按「名称精确 > 名称前缀 > 名称包含 > URL > 分类 > 标签」排序，同分按 hits 降序、名称升序；SHALL 最多返回 8 条、同 URL 去重、仅保留 http(s) 书签。

#### Scenario: 多词跨字段
- **WHEN** 用户输入 `git hub`
- **THEN** 仅返回标题/URL/分类/标签中同时命中 `git` 与 `hub` 的书签

#### Scenario: 名称优先
- **WHEN** 多个书签分别命中名称、URL、分类
- **THEN** 名称命中项排在 URL 与分类命中项之前

### Requirement: 回车与打开方式

选中候选 SHALL 打开该书签的原始 URL（不经 `/go`、不计数）。未选中候选直接回车时：完整 http(s) URL SHALL 原样打开；裸域名 SHALL 补全 `https://` 后打开；其余 SHALL 取本地最佳匹配；无匹配 SHALL 打开 StarNav 首页；未配置地址时 SHALL 打开插件选项页。非 http(s) scheme SHALL NOT 被导航。`currentTab` / `newForegroundTab` / `newBackgroundTab` SHALL 分别对应当前标签页、新前台标签页、新后台标签页。

#### Scenario: 选择建议
- **WHEN** 用户上下键选择某条收藏候选并回车
- **THEN** 当前标签页打开该书签的原始 URL

#### Scenario: 无匹配回首页
- **WHEN** 用户输入的关键词没有匹配且按回车
- **THEN** 打开配置的 StarNav 首页

#### Scenario: 直接输入域名
- **WHEN** 用户输入 `github.com` 并回车
- **THEN** 打开 `https://github.com`
