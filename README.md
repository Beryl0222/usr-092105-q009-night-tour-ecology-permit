# 夜游生态扰动许可平台

同一个夜游季里，萤火虫观察要控制光谱、古城演出关心扩音结束时间、露营区受客流与垃圾容量限制。本平台把许可办理与整改跟踪落到可执行、可核验、可公开追溯的事件流上：场地敏感区、物种季节窗口、活动版次、预计人数、灯光音响设备、交通垃圾方案、许可条件、基线与实时采样、居民反馈、暂停及恢复，全部按发生时间（`occurred_at`）组织。

## 核心原则

- **规则只提示，人来决定**：规则引擎对灯光、噪声、客流三个维度分别判定越界并给出局部调整建议；签发许可、确认违规、批准恢复必须由登记在册的有权人员（许可签发官 / 执法确认官）完成。
- **局部足够，不动整场**：仅单一维度越界时，充分处置范围就是该维度的局部调整，平台拒绝整场取消；多维度同时越界才允许提请场次级处置。
- **匿名投诉须证据互证**：匿名反馈不能单独定性，必须与同时段越界采样或同一时间窗内多人独立反映共同研判。
- **可执行条件先于售票**：主办方在售票前拿到的是逐场次、可采样核对的条件（波长下限、照度上限、熄灯时刻、噪声上限、扩音停止时刻、人数与垃圾容量上限），而不是笼统的“原则同意”；条件未签发前不得售票。
- **暂停公开、恢复留痕**：暂停页公开触发采样与整改进度；恢复公告完整列出触发采样、整改动作、签署人与重新开放门槛。
- **离线补报走同一契约**：监测设备离线后按 `monitoring_sample` 聚合补报，携带原 `sample_id` 与真实 `occurred_at`，重复补报幂等跳过。

## 目录

- `contracts/domain.schema.json`：事件信封与本领域允许的聚合、事件类型。
- `src/constants.js`：事件/聚合类型、扰动维度、岗位与权限。
- `src/store.js`：append-only 事件存储，`version` 按 `aggregate_id` 递增，`event_id` 幂等。
- `src/rules.js`：三维度越界判定与“充分处置范围”提示。
- `src/service.js`：申请、条件签发、采样与补报、反馈研判、违规确认、暂停、整改、恢复。
- `src/server.js` / `src/index.js`：HTTP API、公开暂停/恢复页、种子数据启动。
- `data/sample.json`：一条可用于本地联调的中文样例。
- `tests/`：契约、规则、全流程、补报与 API 测试。

事件由 `event_id` 唯一标识，`aggregate_id` 指向业务对象，`version` 从 1 开始递增，`occurred_at` 保留真实发生时间。来源系统重试时必须沿用原事件标识。

## 运行

```bash
node src/index.js        # 启动平台（默认 :8080，首次启动写入演示申请）
node --test              # 本地检查
```

## API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/applications` | 登记申请（含场次、设备、交通垃圾方案） |
| POST | `/applications/:id/conditions` | 许可签发官签发逐场次条件（需 `x-officer-id`） |
| GET | `/applications/:id/ticket-conditions` | 售票前的可执行场次条件 |
| GET | `/applications/:id/timeline` | 申请相关全部事件，按发生时间排序 |
| POST | `/editions/:id/samples` | 实时/基线采样，立即返回越界判定 |
| POST | `/editions/:id/samples/backfill` | 设备离线补报（需离线原因，幂等） |
| GET | `/editions/:id/alerts` | 越界提示与充分处置范围 |
| POST | `/editions/:id/feedback` | 居民反馈（可匿名） |
| POST | `/feedback/:id/assess` | 执法确认官研判反馈证据（需 `x-officer-id`） |
| POST | `/editions/:id/breaches` | 按维度确认违规（需 `x-officer-id`） |
| POST | `/suspensions` | 下达暂停（范围受限，局部足够时拒绝整场） |
| POST | `/suspensions/:id/rectifications/:actionId` | 登记整改完成 |
| POST | `/suspensions/:id/resume` | 批准恢复（需整改完成、签署人、重开门槛） |
| GET | `/public/suspensions/:id` | 公开暂停处置进度页（HTML） |
| GET | `/public/suspensions/:id.json` | 同上（JSON） |
