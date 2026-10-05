# 夜游生态扰动许可平台

同一个夜游季里，萤火虫观察要控制光谱，古城演出关心扩音结束时间，露营区受客流与垃圾容量限制。本平台把许可办理、监测采样、执法处置与公开披露落到同一套按发生时间组织的事实记录上：规则负责提示越界，签发许可、确认违规、批准恢复仍由有权人员完成。

## 运行

```bash
npm test          # 全部测试（node --test）
npm run demo      # 端到端演示：申请→签发→采样→投诉→确认→局部暂停→整改→恢复
npm start         # HTTP 服务，默认 :8080，事件落盘 data/events.jsonl
npm run typecheck # domain.ts 类型检查
```

## 业务流水

1. **申请**：结构化登记场地、活动类型（不能只写“商业活动”）、活动版次（场次）、各场次预计人数、灯光音响设备、交通方案、垃圾方案。提交即返回规则提示：物种季节窗口（如萤火虫繁殖期的光谱与熄灯建议）、敏感区建议容量、垃圾容量缺口、毗邻居民区的扩音建议。提示不拦截办理。
2. **签发**：`permit_issuer` 签发许可后，逐场次签发**可执行条件**（灯光：照度/光谱/熄灯时刻；噪声：声级/扩音截止；客流：上限）。主办方售票前通过 `GET /applications/:id/clearance` 拿到的就是这组数值条件，而非笼统“原则同意”。条件可局部调整（`CONDITION_ADJUSTED`），只动需要动的维度。
3. **监测**：基线与实时采样都记入 `monitoring_sample` 序列。实时采样越界时，规则引擎按**灯光、噪声、客流分别判断**并生成 `RULE_VIOLATION_FLAGGED` 提示，不自动处置。
4. **反馈**：居民反馈（可匿名）登记到申请上并指向具体场次，“太吵”由此对应到场次与维度。
5. **确认违规**：`breach_confirmer` 操作，须附可核验证据；**仅有匿名投诉不能定案**，须与监测采样或带附件的反馈共同研判。
6. **暂停**：默认只停涉案场次的涉案维度（`case` 范围）；扩大到整场次或整活动须书面说明为何局部处置不足，防止粗暴取消整场。
7. **整改与恢复**：主办方登记整改动作；`resumption_approver` 批准恢复时，事件完整列出**触发采样、整改动作、签署人（含批准人与主办方代表）、重新开放门槛**。
8. **公开暂停页**：`GET /public/applications/:id/suspensions` 公布到达“确认违规”及以后的案件进度；仅规则提示而未确认的案件不作为违规公开。

## 离线补报

监测设备离线后恢复上报时，沿用现有契约：`SAMPLE_RECORDED` / `monitoring_sample`，`occurred_at` 保留真实采样时间，平台登记时间写入 `recorded_at`，并须附 `backfill_reason`。时间线按 `occurred_at` 归位，补报条目会标注。来源系统重试必须沿用原 `event_id`，重复投递幂等返回首次登记的事件。

## 事件契约

`contracts/domain.schema.json` 是跨模块交换的公共信封：`event_id`、`event_type`、`aggregate_type`、`aggregate_id`、`occurred_at`、`version`、`summary` 为必填，业务明细在 `payload`。

- 聚合（四类，保持稳定）：`permit_application`（申请号）、`operating_condition`（申请号#场次号）、`monitoring_sample`（申请号#场次号#维度）、`enforcement_decision`（case#申请号#场次号#维度）。
- 事件类型：`APPLICATION_SUBMITTED`、`PERMIT_ISSUED`、`FEEDBACK_RECEIVED`、`CONDITION_ISSUED`、`CONDITION_ADJUSTED`、`SAMPLE_RECORDED`、`RULE_VIOLATION_FLAGGED`、`BREACH_CONFIRMED`、`ACTIVITY_SUSPENDED`、`RECTIFICATION_RECORDED`、`ACTIVITY_RESUMED`。
- `version` 按聚合从 1 递增；`actor.kind` 区分 officer / organizer / resident / device / system。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/applications` | 提交申请，返回规则提示 |
| POST | `/applications/:id/issue` | 签发许可（permit_issuer） |
| POST | `/applications/:id/conditions` | 签发场次条件（permit_issuer） |
| POST | `/applications/:id/conditions/:edition/adjust` | 局部调整场次条件 |
| POST | `/applications/:id/feedback` | 居民反馈（可匿名） |
| POST | `/samples` | 采样登记（实时/基线/离线补报） |
| POST | `/cases/:caseId/confirm` | 确认违规（breach_confirmer） |
| POST | `/cases/:caseId/suspend` | 暂停（默认局部，扩大须理由） |
| POST | `/cases/:caseId/rectifications` | 登记整改动作 |
| POST | `/cases/:caseId/resume` | 批准恢复（resumption_approver） |
| GET | `/applications/:id/clearance` | 售票前可执行场次条件 |
| GET | `/applications/:id/timeline` | 按发生时间组织的全过程时间线 |
| GET | `/applications/:id/cases` | 处置案件列表 |
| GET | `/public/applications/:id/suspensions` | 公开暂停页（进度与恢复披露） |

POST 请求体携带 `actor`（`{actor_id, name, roles}`）；无权操作返回 403，业务校验失败返回 400，错误信息为中文。

## 目录

- `contracts/domain.schema.json`：事件信封契约
- `data/sites.json`：场地敏感区、物种季节窗口、常驻限值
- `src/eventStore.js`：追加式事件存储（版本递增、幂等重试、JSONL 持久化）
- `src/catalog.js` / `src/rules.js`：场地目录与规则提示引擎（只提示，不决定）
- `src/service.js`：许可、监测、反馈、执法、恢复的业务服务与权限校验
- `src/projections.js`：售票条件、时间线、公开暂停页等读模型
- `src/server.js`：HTTP 接口；`scripts/demo.js`：端到端演示
- `tests/`：契约与平台行为测试
