// 协同服务：把热线 CSV、道路网格、巡查/照片/水位线索汇入统一视图。
// 关键约束：
//  - 系统只给“候选相似”，是否同一隐患由值班员判定；影响范围不同不得合并；
//  - 重复上报幂等返回已有记录；
//  - 危险等级只随证据（水位/照片）重算或经人工理由升级；
//  - 转派不切断原承办关系，全部历史留痕；
//  - 匿名来电只留回访必需信息；
//  - 回访结论追加到原隐患时间线；
//  - 状态全部由事件日志投影，换进程重放即可原样恢复。

import { EventStore, IncidentRepository } from "./model/repository.js";
import { haversineM, boundingBox } from "./lib/geo.js";
import { computeDanger, categoryOf, normalizeScope, LEVEL_RANK } from "./model/danger.js";
import { notFound, badRequest, conflict } from "./model/errors.js";

export const SLA_MINUTES = Object.freeze({ urgent: 30, high: 60, medium: 120, low: 240 });

function issueKeywords(category) {
  return { collapse: "路面塌陷", flooding: "积水" }[category] ?? "";
}

function maskPhone(phone) {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length < 7) return null;
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

export function createCoordinationService(options = {}) {
  const grid = options.grid ?? [];
  const matchRadiusM = options.matchRadiusM ?? 50;
  const clock = options.now ?? (() => new Date().toISOString());
  const repo = new IncidentRepository(options.eventStore ?? new EventStore());

  const listeners = [];
  const onEvent = (fn) => listeners.push(fn);
  const emit = (event) => {
    for (const fn of listeners) {
      try { fn(event); } catch { /* 监听器失败不影响主流程 */ }
    }
  };

  const append = (type, streamId, data, at) => {
    const event = repo.append(type, streamId, data, at ?? clock());
    emit(event);
    return event;
  };

  function nearestGrid(coords) {
    if (!coords || grid.length === 0) return null;
    let best = null;
    for (const cell of grid) {
      const distanceM = haversineM(coords, cell.center);
      if (!best || distanceM < best.distanceM) best = { cell, distanceM };
    }
    return best;
  }

  function recomputeDanger(incident) {
    const joinedIssue = incident.reports.map((r) => r.issue).join(" ") || issueKeywords(incident.category);
    return computeDanger({
      issue: joinedIssue,
      waterLevelCm: incident.waterLevelCm,
      photoTags: incident.photoTags,
    });
  }

  function dueAt(fromIso, level) {
    const minutes = SLA_MINUTES[level] ?? SLA_MINUTES.low;
    return new Date(new Date(fromIso).getTime() + minutes * 60_000).toISOString();
  }

  function nextIncidentId() {
    const n = repo.listIncidents().length + 1;
    return `INC-${String(n).padStart(4, "0")}`;
  }

  function candidateIncidents(coords, category) {
    const box = boundingBox(coords[0], coords[1], matchRadiusM);
    return repo
      .listIncidents()
      .filter((inc) => inc.status !== "closed")
      .filter((inc) => inc.category === category)
      .filter((inc) => inc.coords &&
        inc.coords[0] >= box.minLng && inc.coords[0] <= box.maxLng &&
        inc.coords[1] >= box.minLat && inc.coords[1] <= box.maxLat)
      .map((inc) => ({
        incidentId: inc.id,
        distanceM: Math.round(haversineM(coords, inc.coords)),
        scope: inc.scope,
        danger: inc.danger.level,
        currentTeam: inc.currentTeam,
        status: inc.status,
      }))
      .filter((c) => c.distanceM <= matchRadiusM)
      .sort((a, b) => a.distanceM - b.distanceM);
  }

  function view(incident) {
    const cell = nearestGrid(incident.coords);
    return {
      id: incident.id,
      status: incident.status,
      category: incident.category,
      coords: incident.coords,
      address: incident.address,
      scope: incident.scope,
      danger: incident.danger,
      grid: cell ? {
        gridId: cell.cell.gridId,
        road: cell.cell.road,
        distanceM: Math.round(cell.distanceM),
      } : null,
      currentTeam: incident.currentTeam,
      currentTeamAssignedAt: incident.currentTeamAssignedAt,
      commitmentDueAt: incident.commitmentDueAt,
      reports: incident.reports,
      evidence: incident.evidence,
      escalationHistory: incident.escalationHistory,
      transferHistory: incident.transferHistory,
      resolvedAt: incident.resolvedAt,
      revisit: incident.revisit,
      timeline: incident.timeline,
    };
  }

  // 新建隐患（首条上报）：就近关联网格，初始派给网格责任班组并给出承诺时限。
  // linkReport=false 时只建隐患骨架，由调用方自行挂接上报事件。
  function openIncident(input, { linkReport = true } = {}) {
    let incidentId = nextIncidentId();
    while (repo.exists(incidentId)) incidentId = `INC-${String(Number(incidentId.slice(4)) + 1).padStart(4, "0")}`;

    const category = categoryOf(input.issue);
    const hit = nearestGrid(input.coords);
    const initialDanger = computeDanger({ issue: input.issue });
    const scope = normalizeScope(input.scope);
    const reportedAt = input.reportedAt ?? clock();

    append("incident.created", incidentId, {
      category,
      coords: input.coords,
      address: input.address ?? (hit ? hit.cell.road : ""),
      scope,
      danger: initialDanger,
      grid: hit ? { gridId: hit.cell.gridId, road: hit.cell.road } : null,
    }, reportedAt);

    append("incident.assigned", incidentId, {
      to: hit ? hit.cell.maintenanceTeam : null,
      reason: "网格责任班组初始派单",
      dueAt: hit ? dueAt(reportedAt, initialDanger.level) : null,
    }, reportedAt);

    if (linkReport) linkReportToIncident(incidentId, input, reportedAt);
    return repo.getIncident(incidentId);
  }

  function linkReportToIncident(incidentId, input, linkedAt) {
    const anonymous = Boolean(input.anonymous);
    let callback;
    if (input.callback !== undefined) {
      // 接单/待判阶段已做匿名最小化，判定并入时原样沿用。
      callback = input.callback;
    } else if (anonymous) {
      // 匿名来电：身份信息一律不留；确需回访时只留最小化的回访号码。
      callback = input.callbackNeeded
        ? { needed: true, handle: maskPhone(input.contact) ?? input.callbackRef ?? null }
        : null;
    } else {
      callback = { needed: Boolean(input.callbackNeeded), handle: input.contact ?? input.callbackRef ?? null };
    }
    append("incident.reported", incidentId, {
      reportId: input.reportId,
      source: input.source,
      coords: input.coords,
      issue: input.issue,
      scope: normalizeScope(input.scope),
      reportedAt: input.reportedAt ?? linkedAt,
      anonymous,
      contact: anonymous ? undefined : (input.contact ?? null),
      callback,
      operator: input.operator ?? null,
    }, linkedAt);
  }

  // 接收一条上报。重复上报（同一 reportId）直接返回已有记录，不另建单。
  // 相近上报只返回候选，不自动合并；无候选时自动开单。
  function receiveReport(input) {
    if (!input?.reportId) throw badRequest("INVALID_REPORT", "缺少 reportId");
    if (!Array.isArray(input.coords) || input.coords.length !== 2) {
      throw badRequest("INVALID_REPORT", "缺少有效坐标 coords=[lng,lat]");
    }
    if (!input.issue) throw badRequest("INVALID_REPORT", "缺少 issue");

    const existing = repo.getReport(input.reportId);
    if (existing) {
      const incident = existing.incidentId ? repo.getIncident(existing.incidentId) : null;
      return { duplicate: true, report: existing, incident: incident ? view(incident) : null };
    }

    const at = input.reportedAt ?? clock();
    const category = categoryOf(input.issue);
    const candidates = candidateIncidents(input.coords, category);
    const anonymous = Boolean(input.anonymous);
    const callback = anonymous
      ? (input.callbackNeeded ? { needed: true, handle: maskPhone(input.contact) ?? input.callbackRef ?? null } : null)
      : { needed: Boolean(input.callbackNeeded), handle: input.contact ?? input.callbackRef ?? null };

    // 上报本身先落事件，保证重复上报检测始终有效。
    append("report.received", input.reportId, {
      source: input.source,
      coords: input.coords,
      issue: input.issue,
      scope: normalizeScope(input.scope),
      reportedAt: at,
      anonymous,
      contact: anonymous ? undefined : (input.contact ?? null),
      callback,
      candidates,
    }, at);

    if (candidates.length === 0) {
      const incident = openIncident(input);
      append("report.linked", input.reportId, {
        incidentId: incident.id,
        decision: { reason: "附近无相近隐患，系统自动开单", operator: input.operator ?? "system" },
      }, at);
      return { duplicate: false, autoOpened: true, report: repo.getReport(input.reportId), incident: view(repo.getIncident(incident.id)) };
    }

    // 有相近隐患：挂起，等值班员判定，系统不自行合并。
    return {
      duplicate: false,
      awaitingDecision: true,
      report: repo.getReport(input.reportId),
      candidates,
    };
  }

  // 值班员判定：same=并入同一隐患；separate=影响范围不同，另立隐患。
  function decideReport(reportId, decision, params = {}) {
    const report = repo.getReport(reportId);
    if (!report) throw notFound(`上报记录 ${reportId}`);
    if (report.status !== "pending") {
      throw conflict("REPORT_DECIDED", `上报记录已判定为${report.status}`, { current: report.decision });
    }
    if (!["same", "separate"].includes(decision)) {
      throw badRequest("INVALID_DECISION", "decision 必须是 same 或 separate");
    }
    if (!params.operator) throw badRequest("INVALID_DECISION", "缺少判定值班员 operator");

    const at = params.at ?? clock();

    if (decision === "same") {
      const incidentId = params.incidentId ?? report.candidates[0]?.incidentId;
      const incident = repo.getIncident(incidentId);
      if (!incident) throw notFound(`隐患 ${incidentId}`);
      if (!report.candidates.some((c) => c.incidentId === incidentId)) {
        throw badRequest("NOT_CANDIDATE", "只能并入系统给出的相近候选隐患");
      }
      const reportScope = normalizeScope(report.scope);
      if (reportScope && incident.scope && reportScope !== incident.scope) {
        // 影响范围不同：系统不得合并，必须另立。
        throw conflict("SCOPE_CONFLICT", "影响范围不同，禁止并入同一隐患", {
          incidentScope: incident.scope,
          reportScope,
        });
      }
      append("report.linked", reportId, {
        incidentId,
        decision: { reason: params.reason ?? "值班员判定为同一隐患", operator: params.operator },
      }, at);
      linkReportToIncident(incidentId, report, at);
      const updated = repo.getIncident(incidentId);
      const danger = recomputeDanger(updated);
      if (LEVEL_RANK[danger.level] > LEVEL_RANK[updated.danger.level]) {
        append("incident.escalated", incidentId, {
          from: updated.danger.level,
          to: danger.level,
          reason: "并入上报提供新线索，证据重算升级",
          danger,
        }, at);
      } else {
        append("incident.evidence", incidentId, {
          evidence: { kind: "recalc", at, trigger: `link:${reportId}` },
          danger,
        }, at);
      }
      return { report: repo.getReport(reportId), incident: view(repo.getIncident(incidentId)) };
    }

    // separate：另立新隐患，并把原候选与判定理由记入时间线。
    const incident = openIncident({ ...report, reportedAt: report.reportedAt });
    append("report.separated", reportId, {
      incidentId: incident.id,
      decision: {
        reason: params.reason ?? "值班员判定影响范围不同，另立隐患",
        operator: params.operator,
        distinctFrom: report.candidates.map((c) => c.incidentId),
      },
    }, at);
    return { report: repo.getReport(reportId), incident: view(repo.getIncident(incident.id)) };
  }

  // 补证据：水位观测或现场照片会重算危险等级，升级必留理由。
  function addEvidence(incidentId, evidence, params = {}) {
    const incident = repo.getIncident(incidentId);
    if (!incident) throw notFound(`隐患 ${incidentId}`);
    if (!evidence?.kind || !["water", "photo"].includes(evidence.kind)) {
      throw badRequest("INVALID_EVIDENCE", "证据 kind 必须是 water 或 photo");
    }
    const at = params.at ?? evidence.at ?? clock();
    const record = evidence.kind === "water"
      ? { kind: "water", waterLevelCm: Number(evidence.waterLevelCm), at, source: evidence.source ?? null }
      : { kind: "photo", photoId: evidence.photoId ?? null, photoTags: evidence.photoTags ?? [], at, source: evidence.source ?? null };
    if (record.kind === "water" && !Number.isFinite(record.waterLevelCm)) {
      throw badRequest("INVALID_EVIDENCE", "水位读数必须是数字（厘米）");
    }
    if (record.kind === "photo" && record.photoTags.length === 0) {
      throw badRequest("INVALID_EVIDENCE", "照片证据至少携带一个 photoTags 标签");
    }

    const newDanger = dangerAfterHypothetical(incident, record);
    append("incident.evidence", incidentId, { evidence: record, danger: newDanger }, at);

    if (LEVEL_RANK[newDanger.level] > LEVEL_RANK[incident.danger.level]) {
      append("incident.escalated", incidentId, {
        from: incident.danger.level,
        to: newDanger.level,
        reason: newDanger.reasons.join("；"),
        danger: newDanger,
      }, at);
    }
    return view(repo.getIncident(incidentId));
  }

  // 先把待加入证据并入内存副本计算等级，保证事件中的 danger 与投影一致。
  function dangerAfterHypothetical(incident, record) {
    const copy = {
      ...incident,
      reports: [...incident.reports],
      waterLevelCm: incident.waterLevelCm,
      photoTags: [...incident.photoTags],
    };
    if (record.kind === "water" && record.waterLevelCm != null) {
      copy.waterLevelCm = Math.max(copy.waterLevelCm ?? -Infinity, record.waterLevelCm);
    }
    if (record.kind === "photo") copy.photoTags.push(...record.photoTags);
    return recomputeDanger(copy);
  }

  // 人工升级（如值班员研判），必须给理由。
  function escalate(incidentId, to, reason, params = {}) {
    const incident = repo.getIncident(incidentId);
    if (!incident) throw notFound(`隐患 ${incidentId}`);
    if (!(to in LEVEL_RANK)) throw badRequest("INVALID_LEVEL", `未知等级 ${to}`);
    if (!reason || !reason.trim()) throw badRequest("INVALID_LEVEL", "人工升级必须填写理由");
    if (LEVEL_RANK[to] <= LEVEL_RANK[incident.danger.level]) {
      throw badRequest("INVALID_LEVEL", `只能升到更高等级（当前 ${incident.danger.level}）`);
    }
    const danger = { level: to, reasons: [...incident.danger.reasons, `人工升级：${reason}`] };
    append("incident.escalated", incidentId, { from: incident.danger.level, to, reason, danger }, params.at ?? clock());
    return view(repo.getIncident(incidentId));
  }

  // 跨部门转派：原承办关系（首派班组/网格）随全部转派历史保留。
  function transfer(incidentId, params = {}) {
    const incident = repo.getIncident(incidentId);
    if (!incident) throw notFound(`隐患 ${incidentId}`);
    if (!params.to) throw badRequest("INVALID_TRANSFER", "缺少接收班组 to");
    if (params.to === incident.currentTeam) {
      throw conflict("SAME_TEAM", "接收班组与当前责任班组相同");
    }
    if (!params.reason) throw badRequest("INVALID_TRANSFER", "转派必须填写理由");

    const at = params.at ?? clock();
    const first = incident.assignments[0] ?? null;
    const due = params.renewSLA === false
      ? incident.commitmentDueAt
      : dueAt(at, incident.danger.level);

    append("incident.transferred", incidentId, {
      from: incident.currentTeam,
      to: params.to,
      reason: params.reason,
      dueAt: due,
      originRelation: first
        ? { grid: nearestGrid(incident.coords)?.cell.gridId ?? null, firstTeam: first.team, firstAssignedAt: first.at }
        : null,
    }, at);
    return view(repo.getIncident(incidentId));
  }

  function resolve(incidentId, params = {}) {
    const incident = repo.getIncident(incidentId);
    if (!incident) throw notFound(`隐患 ${incidentId}`);
    if (incident.status === "closed") throw conflict("ALREADY_CLOSED", "隐患已结案，不能再处置");
    append("incident.resolved", incidentId, { note: params.note ?? "班组完成处置", by: params.by ?? null }, params.at ?? clock());
    return view(repo.getIncident(incidentId));
  }

  // 回访结论：接在原隐患时间线上；问题仍在则重新打开。
  function revisit(incidentId, params = {}) {
    const incident = repo.getIncident(incidentId);
    if (!incident) throw notFound(`隐患 ${incidentId}`);
    const outcome = params.outcome;
    if (!["closed", "reopen"].includes(outcome)) {
      throw badRequest("INVALID_REVISIT", "outcome 必须是 closed 或 reopen");
    }
    const at = params.at ?? clock();
    append("incident.revisited", incidentId, {
      outcome,
      note: params.note ?? "",
      by: params.by ?? null,
    }, at);
    if (outcome === "reopen") {
      append("incident.reopened", incidentId, { reason: params.note ?? "回访发现问题仍在" }, at);
    }
    return view(repo.getIncident(incidentId));
  }

  // 按坐标查附近线索、当前责任班组与承诺时限。
  function nearby(lng, lat, radiusM = matchRadiusM) {
    const coords = [Number(lng), Number(lat)];
    if (!coords.every(Number.isFinite)) throw badRequest("INVALID_COORDS", "坐标无效");
    const box = boundingBox(coords[0], coords[1], radiusM);
    const incidents = repo
      .listIncidents()
      .map((inc) => ({ incident: inc, distanceM: Math.round(haversineM(coords, inc.coords)) }))
      .filter(({ incident, distanceM }) =>
        distanceM <= radiusM &&
        incident.coords[0] >= box.minLng && incident.coords[0] <= box.maxLng &&
        incident.coords[1] >= box.minLat && incident.coords[1] <= box.maxLat)
      .sort((a, b) => a.distanceM - b.distanceM)
      .map(({ incident, distanceM }) => ({ distanceM, ...view(incident) }));

    const pendingReports = repo
      .listReports()
      .filter((r) => r.status === "pending")
      .map((r) => ({ ...r, distanceM: Math.round(haversineM(coords, r.coords)) }))
      .filter((r) => r.distanceM <= radiusM)
      .sort((a, b) => a.distanceM - b.distanceM);

    return {
      query: { coords, radiusM },
      nearestGrid: (() => {
        const hit = nearestGrid(coords);
        return hit ? { ...hit.cell, distanceM: Math.round(hit.distanceM) } : null;
      })(),
      incidents,
      pendingReports,
    };
  }

  return {
    // 测试/恢复用
    _repo: repo,
    onEvent,
    eventLog: () => repo.store.all(),
    snapshot: () => repo.snapshot(),
    restoreFromSnapshot: (snapshot) => createCoordinationService({
      ...options,
      grid,
      eventStore: new EventStore(structuredClone(snapshot.events)),
    }),
    // 业务入口
    receiveReport,
    decideReport,
    addEvidence,
    escalate,
    transfer,
    resolve,
    revisit,
    nearby,
    getIncident: (id) => {
      const inc = repo.getIncident(id);
      return inc ? view(inc) : null;
    },
    getReport: (id) => repo.getReport(id),
    listIncidents: () => repo.listIncidents().map(view),
    listReports: () => repo.listReports(),
    nearestGrid,
  };
}
