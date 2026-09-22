# 城市道路报修协同服务

暴雨值班场景下，把 **12345 热线 CSV**、**城管网格 JSON**、养护巡查与现场证据汇入统一视图，
解决“同一处隐患被派给三个班组、真正危险的积水点无人接手”的问题。

运行 `npm start` 启动 HTTP 服务（默认 `http://localhost:8080`，`PORT` 可改）；`npm test` 执行全部测试。
仅使用 Node.js 内置能力，零依赖；样例数据均已脱敏。

## 业务规则

| 需求 | 实现 |
| --- | --- |
| CSV + JSON 汇入统一视图 | `src/ingest.js` 解析热线记录与道路网格，接单时就近关联网格 |
| 按坐标查附近线索/责任班组/承诺时限 | `GET /nearby?lng=&lat=&radius=`，按距离升序返回隐患与待判定上报 |
| 相近上报是否同一隐患，由值班员判定 | 系统只给 50m 同类**候选**（`awaitingDecision`），不自行合并 |
| 影响范围不同不得合并 | 判定 `same` 但 `scope` 不一致时返回 `409 SCOPE_CONFLICT`，须 `separate` 另立 |
| 水位观测、现场照片改变危险等级 | 证据驱动重算 `low→medium→high→urgent`，每次升级在 `escalationHistory` 留理由 |
| 跨部门转派保留原承办关系 | `transferHistory` 逐条记录 from/to/理由，并固化首派网格与班组 `originRelation` |
| 匿名来电最小化 | 身份与联系方式不落库；确需回访仅存脱敏号（如 `138****5678`） |
| 重复上报返回已有记录 | 按 `reportId` 幂等，返回 `duplicate:true` 与原隐患，不另建单 |
| 回访接在原时间线 | 回访结论追加到原隐患 `timeline`；`outcome=reopen` 重开，`closed` 结案 |
| 换进程原样恢复 | 全部状态由 `data/events.jsonl` 事件日志投影；重放即恢复未结隐患、升级理由、转派历史 |

## HTTP 接口

| 方法与路径 | 说明 |
| --- | --- |
| `POST /reports` | 接收上报；无相近隐患自动开单，有候选则待判定 |
| `POST /reports/:id/decision` | 值班员判定 `{decision:"same"\|"separate", operator, reason, incidentId?}` |
| `GET /nearby` | 坐标近线查询（隐患、待判定上报、最近网格） |
| `GET /incidents` / `GET /incidents/:id` | 隐患列表/统一视图详情（含时间线、转派史、升级史） |
| `POST /incidents/:id/evidence` | 补证据 `{evidence:{kind:"water",waterLevelCm}|{kind:"photo",photoTags:[...]}}` |
| `POST /incidents/:id/escalate` | 人工升级（必须给理由，只能升高） |
| `POST /incidents/:id/transfer` | 跨部门转派 `{to, reason, renewSLA?}` |
| `POST /incidents/:id/resolve` | 班组完成处置 |
| `POST /incidents/:id/revisit` | 回访 `{outcome:"closed"|"reopen", note}` |
| `GET /reports` / `GET /reports/:id` | 上报记录与判定状态 |
| `GET /snapshot` | 移交快照（事件日志 + 全部投影） |

## 命令

```bash
npm start                 # 启动服务（启动时幂等补导 fixtures/hotline.csv）
node src/index.js ingest  # 只导入热线样例后退出（重复导入不新增）
node src/index.js snapshot# 导出 data/snapshot.json 供移交核对
```

数据目录由 `DATA_DIR` 控制（默认 `./data`，已在 `.gitignore`）。

## 代码结构

```
src/
  index.js            进程入口：重放事件日志 → 恢复视图 → HTTP 服务
  service.js          协同领域服务（接单、判定、证据、转派、回访、近线查询）
  http.js             JSON HTTP 入口与结构化错误
  ingest.js           CSV 热线 / JSON 网格载入与导入
  persistence.js      JSONL 事件日志与快照读写
  lib/geo.js          haversine 距离与包围盒
  lib/csv.js          CSV 解析
  model/danger.js     危险等级证据规则
  model/repository.js 事件溯源仓库（事件 → 隐患/上报投影）
  model/errors.js     业务错误码
test/                 13 个测试：领域规则 11 + HTTP 全链路 2
```
