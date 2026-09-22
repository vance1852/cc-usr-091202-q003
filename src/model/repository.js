// 事件溯源仓库：每次业务动作都追加一条不可变事件。
// 当前状态由事件回放得到；换进程时重放事件日志即可原样恢复。
// 事件日志是持久化的唯一事实来源，快照仅用于移交与核对。

import { randomUUID } from "node:crypto";

const EVENT_TYPES = new Set([
  "incident.created",
  "incident.reported",
  "incident.evidence",
  "incident.escalated",
  "incident.assigned",
  "incident.transferred",
  "incident.resolved",
  "incident.reopened",
  "incident.revisited",
  "report.received",
  "report.linked",
  "report.separated",
]);

export class EventStore {
  constructor(events = []) {
    this.events = [];
    for (const event of events) this._validateAndPush(event);
  }

  _validateAndPush(event) {
    if (!EVENT_TYPES.has(event.type)) {
      throw new Error(`未知事件类型: ${event.type}`);
    }
    this.events.push(Object.freeze({ ...event }));
  }

  append(type, streamId, data, at = new Date().toISOString()) {
    if (!EVENT_TYPES.has(type)) throw new Error(`未知事件类型: ${type}`);
    const event = Object.freeze({ id: randomUUID(), type, streamId, at, data });
    this.events.push(event);
    return event;
  }

  forStream(streamId) {
    return this.events.filter((e) => e.streamId === streamId);
  }

  all() {
    return [...this.events];
  }
}

function emptyIncident(id) {
  return {
    id,
    status: "open", // open | resolved | closed
    category: "unknown",
    danger: { level: "low", reasons: [] },
    waterLevelCm: null,
    photoTags: [],
    scope: "",
    coords: null,
    address: "",
    currentTeam: null,
    currentTeamAssignedAt: null,
    commitmentDueAt: null,
    resolvedAt: null,
    reports: [],
    evidence: [],
    escalationHistory: [], // 升级理由，逐条保留
    assignments: [],
    transferHistory: [], // 全部转派历史，含原承办关系
    timeline: [],
    revisit: null,
  };
}

function reduceIncident(incident, event) {
  const { type, at, data } = event;
  switch (type) {
    case "incident.created":
      incident.category = data.category;
      incident.coords = data.coords;
      incident.address = data.address ?? "";
      incident.scope = data.scope ?? "";
      incident.danger = data.danger ?? incident.danger;
      incident.timeline.push({ at, type, detail: { category: data.category, scope: incident.scope } });
      break;
    case "incident.reported":
      incident.reports.push({
        reportId: data.reportId,
        source: data.source,
        coords: data.coords,
        issue: data.issue,
        scope: data.scope ?? "",
        reportedAt: data.reportedAt,
        anonymous: data.anonymous,
        // 匿名来电：不保存任何身份与联系方式
        contact: data.anonymous ? null : data.contact,
        callback: data.callback ?? null,
      });
      incident.timeline.push({
        at,
        type,
        detail: { reportId: data.reportId, source: data.source, reportedAt: data.reportedAt },
      });
      break;
    case "incident.evidence":
      incident.evidence.push(data.evidence);
      if (data.evidence.kind === "water" && data.evidence.waterLevelCm != null) {
        incident.waterLevelCm = Math.max(incident.waterLevelCm ?? -Infinity, data.evidence.waterLevelCm);
      }
      if (data.evidence.kind === "photo") {
        for (const tag of data.evidence.photoTags ?? []) {
          if (!incident.photoTags.includes(tag)) incident.photoTags.push(tag);
        }
      }
      incident.danger = data.danger;
      incident.timeline.push({
        at,
        type,
        detail: { evidence: data.evidence, danger: data.danger.level },
      });
      break;
    case "incident.escalated":
      incident.danger = data.danger;
      incident.escalationHistory.push({ from: data.from, to: data.to, reason: data.reason, at });
      incident.timeline.push({
        at,
        type,
        detail: { from: data.from, to: data.to, reason: data.reason },
      });
      break;
    case "incident.assigned":
      incident.currentTeam = data.to;
      incident.currentTeamAssignedAt = at;
      incident.commitmentDueAt = data.dueAt;
      incident.assignments.push({ team: data.to, at, reason: data.reason, dueAt: data.dueAt });
      incident.timeline.push({
        at,
        type,
        detail: { team: data.to, reason: data.reason, dueAt: data.dueAt },
      });
      break;
    case "incident.transferred":
      // 跨部门转派：原承办关系原样保留
      incident.transferHistory.push({
        from: data.from,
        to: data.to,
        at,
        reason: data.reason,
        originRelation: data.originRelation,
      });
      incident.currentTeam = data.to;
      incident.currentTeamAssignedAt = at;
      incident.commitmentDueAt = data.dueAt ?? incident.commitmentDueAt;
      incident.assignments.push({ team: data.to, at, reason: data.reason, dueAt: data.dueAt });
      incident.timeline.push({
        at,
        type,
        detail: { from: data.from, to: data.to, reason: data.reason, origin: data.originRelation },
      });
      break;
    case "incident.resolved":
      incident.status = "resolved";
      incident.resolvedAt = at;
      incident.timeline.push({ at, type, detail: { note: data.note } });
      break;
    case "incident.reopened":
      incident.status = "open";
      incident.resolvedAt = null;
      incident.timeline.push({ at, type, detail: { reason: data.reason } });
      break;
    case "incident.revisited":
      incident.revisit = { outcome: data.outcome, note: data.note ?? "", at };
      if (data.outcome === "closed") incident.status = "closed";
      incident.timeline.push({
        at,
        type,
        detail: { outcome: data.outcome, note: data.note ?? "" },
      });
      break;
  }
  return incident;
}

function emptyReport(reportId) {
  return {
    reportId,
    status: "pending", // pending | linked | separate
    incidentId: null,
    candidates: [],
    decision: null,
  };
}

function reduceReport(report, event) {
  const { type, at, data } = event;
  switch (type) {
    case "report.received":
      Object.assign(report, {
        source: data.source,
        coords: data.coords,
        issue: data.issue,
        scope: data.scope ?? "",
        reportedAt: data.reportedAt,
        anonymous: data.anonymous,
        contact: data.anonymous ? null : data.contact,
        callback: data.callback ?? null,
        status: "pending",
        candidates: data.candidates ?? [],
      });
      break;
    case "report.linked":
      report.status = "linked";
      report.incidentId = data.incidentId;
      report.candidates = [];
      report.decision = { kind: "same", incidentId: data.incidentId, ...data.decision, at };
      break;
    case "report.separated":
      report.status = "separate";
      report.incidentId = data.incidentId;
      report.candidates = [];
      report.decision = { kind: "separate", incidentId: data.incidentId, ...data.decision, at };
      break;
  }
  return report;
}

export class IncidentRepository {
  constructor(eventStore = new EventStore()) {
    this.store = eventStore;
  }

  append(type, streamId, data, at) {
    return this.store.append(type, streamId, data, at);
  }

  exists(streamId) {
    return this.store.forStream(streamId).length > 0;
  }

  getIncident(id) {
    const events = this.store.forStream(id).filter((e) => e.type.startsWith("incident."));
    if (events.length === 0) return null;
    return events.reduce((incident, event) => reduceIncident(incident, event), emptyIncident(id));
  }

  getReport(id) {
    const events = this.store.forStream(id).filter((e) => e.type.startsWith("report."));
    if (events.length === 0) return null;
    return events.reduce((report, event) => reduceReport(report, event), emptyReport(id));
  }

  listIncidents() {
    const map = new Map();
    for (const event of this.store.all()) {
      if (!event.type.startsWith("incident.")) continue;
      if (!map.has(event.streamId)) map.set(event.streamId, emptyIncident(event.streamId));
      reduceIncident(map.get(event.streamId), event);
    }
    return [...map.values()];
  }

  listReports() {
    const map = new Map();
    for (const event of this.store.all()) {
      if (!event.type.startsWith("report.")) continue;
      if (!map.has(event.streamId)) map.set(event.streamId, emptyReport(event.streamId));
      reduceReport(map.get(event.streamId), event);
    }
    return [...map.values()];
  }

  // 移交快照：未结隐患、升级理由与全部转派历史随事件日志原样恢复。
  snapshot() {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      events: this.store.all(),
      incidents: this.listIncidents(),
      reports: this.listReports(),
    };
  }
}
