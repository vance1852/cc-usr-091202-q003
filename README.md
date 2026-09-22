# 城市道路报修 Node.js 工作区

这里保存道路报修的交换样例和 Node.js 协同服务。`fixtures/context.json` 提供道路网格，`fixtures/hotline.csv` 保留脱敏热线记录，两者汇入同一个统一视图（`HazardService`），供值班员按坐标研判、派单与跟踪。

运行 `npm start` 可检查程序入口，运行 `npm test` 可执行当前测试目录。项目代码使用 Node.js 内置能力，数据文件不包含真实个人信息。

## 业务规则

- **统一视图**：热线 CSV 与道路网格 JSON 汇入后，每条上报生成一条隐患，并绑定最近网格（500 米内）的养护班组与承诺时限（积水 2 小时、路面塌陷 4 小时、其它 24 小时）。
- **合并由人决定**：系统绝不自动合并；值班员确认后调用合并入口。两条隐患的影响范围都已评估且不一致时，合并会被拒绝。
- **危险等级**：水位观测（厘米）与现场照片研判会抬高危险等级，每次升级都记录理由；等级只升不降，人工下调必须说明理由。
- **跨部门转派**：当前承办班组可变，最初承办关系与每一次转派记录全部保留，承诺时限不变。
- **匿名来电**：只保留回访所需信息（回拨电话），姓名、证件号等一律不落库。
- **重复上报**：相同 `report_id` 再次上报时返回已有记录，不重复建单。
- **回访**：班组办结后，回访结论接在同一隐患的原时间线上。
- **持久化**：快照交给新进程后，未结隐患、升级理由与全部转派历史原样恢复。

## 命令

```bash
npm start                          # 载入 fixtures 统一视图并打印未结隐患
npm test                           # 运行测试
node src/index.js --serve          # 启动 HTTP 服务（--port 指定端口，默认 3000）
node src/index.js --data 快照.json  # 从持久化快照恢复（可配合 --serve）
node src/index.js --save 快照.json  # 配合 --serve，SIGINT 退出时写入快照
```

## HTTP 入口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/view` | 统一视图概览（未结隐患按承诺时限排序） |
| POST | `/reports` | 登记上报（重复 `reportId` 返回已有记录） |
| GET | `/nearby?lng=&lat=&radius=` | 按坐标查附近线索、责任班组与承诺时限 |
| GET | `/hazards/:id` | 隐患完整视图（时间线、转派历史、升级理由） |
| POST | `/hazards/:id/merge` | 值班员确认并入另一隐患（影响范围不同则 409） |
| POST | `/hazards/:id/observations` | 登记水位/照片观测，可能触发升级 |
| POST | `/hazards/:id/adjust-danger` | 人工调整危险等级（需理由） |
| POST | `/hazards/:id/transfer` | 跨部门转派（保留原承办关系） |
| POST | `/hazards/:id/resolve` | 班组办结 |
| POST | `/hazards/:id/callback` | 登记回访结论（追加到原时间线） |
| POST | `/snapshot` | 把当前状态写入快照文件 |
