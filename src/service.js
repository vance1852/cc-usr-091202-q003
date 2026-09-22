import { readFile, writeFile } from "node:fs/promises";
import { haversineMeters } from "./geo.js";
import { parseCsv } from "./csv.js";
import { DomainError } from "./errors.js";
import {
  DANGER_LEVELS,
  DEFAULT_SLA_HOURS,
  baseDangerFor,
  dangerForPhotoSeverity,
  dangerForWaterDepth,
  dangerRank,
  slaHoursFor,
} from "./policies.js";

/** 上报点与网格中心距离在该范围内才自动绑定承办班组。 */
const GRID_BIND_RADIUS_M = 500;
/** 未匹配到网格时的待派占位班组。 */
const UNASSIGNED_TEAM = "值班待派";
const SNAPSHOT_VERSION = 1;

const clone = (value) => structuredClone(value);

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("INVALID_INPUT", `字段 ${field} 不能为空`);
  }
  return value.trim();
}

function requireLocation(input) {
  const longitude = Number(input.longitude);
  const latitude = Number(input.latitude);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    throw new DomainError("INVALID_INPUT", "经纬度必须是数字");
  }
  return { longitude, latitude };
}

function normalizeScope(scope) {
  if (scope == null || String(scope).trim() === "") return "unknown";
  return String(scope).trim();
}

/**
 * 匿名来电脱敏：只保留回访所需信息（回拨电话），其余身份信息一律丢弃。
 * 非匿名来电原样保留 reporter。
 */
function sanitizeReporter(input) {
  if (!input.anonymous) {
    return { anonymous: false, reporter: input.reporter ?? null, callback: null };
  }
  const src = input.reporter ?? {};
  const phone = input.callbackPhone ?? src.callbackPhone ?? src.phone ?? null;
  return {
    anonymous: true,
    reporter: null,
    callback: phone ? { phone: String(phone) } : null,
  };
}

/**
 * 城市热线协同核心：把热线 CSV 与道路网格 JSON 汇入统一视图，
 * 隐患的合并、升级、转派、回访全部由值班员显式触发并留痕。
 */
export class HazardService {
  constructor(options = {}) {
    this.now = options.now ?? (() => new Date());
    this.slaHours = { ...DEFAULT_SLA_HOURS, ...(options.slaHours ?? {}) };
    /** @type {Array<{gridId:string, road:string, center:{longitude:number,latitude:number}, maintenanceTeam:string}>} */
    this.grids = [];
    /** @type {Map<string, object>} reportId -> report */
    this.reports = new Map();
    /** @type {Map<string, object>} hazardId -> hazard */
    this.hazards = new Map();
    this.counters = { hazard: 0, report: 0 };
  }

  // ---------------------------------------------------------------- 汇入

  /** 汇入道路网格（可重复调用，按 gridId 幂等覆盖）。 */
  ingestGrid(records) {
    for (const record of records) {
      const [longitude, latitude] = record.center;
      const grid = {
        gridId: requireString(record.gridId, "gridId"),
        road: record.road ?? "",
        center: { longitude: Number(longitude), latitude: Number(latitude) },
        maintenanceTeam: record.maintenanceTeam ?? UNASSIGNED_TEAM,
      };
      const index = this.grids.findIndex((g) => g.gridId === grid.gridId);
      if (index >= 0) this.grids[index] = grid;
      else this.grids.push(grid);
    }
    return this.grids.length;
  }

  /** 汇入热线 CSV；重复 report_id 返回已有记录，不重复建单。 */
  ingestHotlineCsv(csvText) {
    const result = { created: [], duplicates: [] };
    for (const row of parseCsv(csvText)) {
      const { deduplicated, report } = this.addReport({
        reportId: row.report_id,
        source: row.source,
        longitude: row.longitude,
        latitude: row.latitude,
        issue: row.issue,
        reportedAt: row.reported_at,
      });
      (deduplicated ? result.duplicates : result.created).push(report.reportId);
    }
    return result;
  }

  /**
   * 登记一条上报并生成对应隐患（1:1 起步，是否并入其它隐患由值班员决定）。
   * 相同 reportId 再次上报时返回已有记录（deduplicated: true），状态不变。
   */
  addReport(input) {
    const lookupId =
      input.reportId != null && input.reportId !== "" ? String(input.reportId) : null;
    if (lookupId != null && this.reports.has(lookupId)) {
      const report = this.reports.get(lookupId);
      return { report: clone(report), hazard: clone(this.hazards.get(report.hazardId)), deduplicated: true };
    }

    const location = requireLocation(input);
    const issue = requireString(input.issue, "issue");
    const reportedAtRaw = input.reportedAt ?? this.now().toISOString();
    const reportedAtDate = new Date(reportedAtRaw);
    if (Number.isNaN(reportedAtDate.getTime())) {
      throw new DomainError("INVALID_INPUT", `上报时间无法解析: ${reportedAtRaw}`);
    }

    const reportId =
      lookupId ?? `RPT-${String((this.counters.report += 1)).padStart(4, "0")}`;
    const privacy = sanitizeReporter(input);
    const grid = this.#nearestGrid(location);

    const hazardId = `HZ-${String((this.counters.hazard += 1)).padStart(4, "0")}`;
    const report = {
      reportId,
      source: input.source ?? "unknown",
      issue,
      location,
      reportedAt: reportedAtDate.toISOString(),
      impactScope: normalizeScope(input.impactScope),
      anonymous: privacy.anonymous,
      reporter: privacy.reporter,
      callback: privacy.callback,
      hazardId,
    };

    const hazard = {
      hazardId,
      issue,
      location,
      impactScope: report.impactScope,
      status: "open",
      gridId: grid?.gridId ?? null,
      road: grid?.road ?? null,
      originalTeam: grid?.maintenanceTeam ?? UNASSIGNED_TEAM,
      assigneeTeam: grid?.maintenanceTeam ?? UNASSIGNED_TEAM,
      promisedAt: new Date(
        reportedAtDate.getTime() + slaHoursFor(issue, this.slaHours) * 3600_000,
      ).toISOString(),
      dangerLevel: baseDangerFor(issue),
      reportIds: [reportId],
      observations: [],
      escalations: [],
      transfers: [],
      callbacks: [],
      mergedInto: null,
      resolvedAt: null,
      timeline: [],
    };
    this.#appendTimeline(hazard, "report-created", {
      reportId,
      source: report.source,
      issue,
      reportedAt: report.reportedAt,
    });

    this.reports.set(reportId, report);
    this.hazards.set(hazardId, hazard);
    return { report: clone(report), hazard: clone(hazard), deduplicated: false };
  }

  // ---------------------------------------------------------------- 查询

  /** 距离上报点最近的网格（超出绑定半径则视为无网格）。 */
  #nearestGrid(location) {
    let best = null;
    let bestDistance = Infinity;
    for (const grid of this.grids) {
      const distance = haversineMeters(location, grid.center);
      if (distance < bestDistance) {
        best = grid;
        bestDistance = distance;
      }
    }
    return bestDistance <= GRID_BIND_RADIUS_M ? best : null;
  }

  /**
   * 值班员按坐标查附近线索：返回半径内的未合并隐患，
   * 含当前责任班组、承诺时限、危险等级与关联上报，按距离升序。
   */
  findNearby({ longitude, latitude, radiusMeters = 200, includeResolved = false }) {
    const origin = requireLocation({ longitude, latitude });
    const radius = Number(radiusMeters);
    if (!Number.isFinite(radius) || radius <= 0) {
      throw new DomainError("INVALID_INPUT", "radiusMeters 必须是正数");
    }
    const clues = [];
    for (const hazard of this.hazards.values()) {
      if (hazard.status === "merged") continue;
      if (!includeResolved && hazard.status === "resolved") continue;
      const distanceMeters = haversineMeters(origin, hazard.location);
      if (distanceMeters > radius) continue;
      clues.push({
        hazardId: hazard.hazardId,
        distanceMeters: Math.round(distanceMeters * 10) / 10,
        issue: hazard.issue,
        location: clone(hazard.location),
        status: hazard.status,
        dangerLevel: hazard.dangerLevel,
        impactScope: hazard.impactScope,
        assigneeTeam: hazard.assigneeTeam,
        promisedAt: hazard.promisedAt,
        gridId: hazard.gridId,
        road: hazard.road,
        reports: hazard.reportIds.map((id) => {
          const r = this.reports.get(id);
          return { reportId: r.reportId, source: r.source, issue: r.issue, reportedAt: r.reportedAt };
        }),
      });
    }
    return clues.sort((a, b) => a.distanceMeters - b.distanceMeters);
  }

  /** 未结隐患列表，按承诺时限升序（最紧迫的在前），并标注是否已超时。 */
  listOpen() {
    const now = this.now().getTime();
    return [...this.hazards.values()]
      .filter((h) => h.status === "open")
      .sort((a, b) => a.promisedAt.localeCompare(b.promisedAt))
      .map((h) => ({
        ...this.#summary(h),
        overdue: Date.parse(h.promisedAt) < now,
      }));
  }

  #summary(hazard) {
    return {
      hazardId: hazard.hazardId,
      issue: hazard.issue,
      status: hazard.status,
      dangerLevel: hazard.dangerLevel,
      impactScope: hazard.impactScope,
      assigneeTeam: hazard.assigneeTeam,
      promisedAt: hazard.promisedAt,
      reportCount: hazard.reportIds.length,
    };
  }

  /** 单个隐患完整视图（含时间线、转派历史、升级理由、关联上报）。 */
  getHazard(hazardId) {
    const hazard = this.#mustGet(hazardId);
    return {
      ...clone(hazard),
      reports: hazard.reportIds.map((id) => clone(this.reports.get(id))),
    };
  }

  #mustGet(hazardId) {
    const hazard = this.hazards.get(hazardId);
    if (!hazard) throw new DomainError("NOT_FOUND", `隐患不存在: ${hazardId}`);
    return hazard;
  }

  #mustBeOpen(hazard) {
    if (hazard.status === "merged") {
      throw new DomainError("HAZARD_MERGED", `隐患 ${hazard.hazardId} 已并入 ${hazard.mergedInto}`);
    }
    if (hazard.status === "resolved") {
      throw new DomainError("ALREADY_RESOLVED", `隐患 ${hazard.hazardId} 已处置完成`);
    }
  }

  // ---------------------------------------------------------------- 决策

  /**
   * 值班员确认两条隐患属于同一隐患，把 secondary 并入 primary。
   * 系统绝不自动合并；两者影响范围都已评估且不一致时拒绝合并。
   */
  mergeHazards(primaryId, secondaryId, { operator = null, note = null } = {}) {
    if (primaryId === secondaryId) {
      throw new DomainError("INVALID_INPUT", "不能把隐患并入自身");
    }
    const primary = this.#mustGet(primaryId);
    const secondary = this.#mustGet(secondaryId);
    this.#mustBeOpen(primary);
    this.#mustBeOpen(secondary);

    const scopesKnown =
      primary.impactScope !== "unknown" && secondary.impactScope !== "unknown";
    if (scopesKnown && primary.impactScope !== secondary.impactScope) {
      throw new DomainError(
        "IMPACT_SCOPE_MISMATCH",
        `影响范围不同（${primary.impactScope} ≠ ${secondary.impactScope}），不允许合并`,
      );
    }

    if (primary.impactScope === "unknown" && secondary.impactScope !== "unknown") {
      primary.impactScope = secondary.impactScope;
    }
    for (const reportId of secondary.reportIds) {
      primary.reportIds.push(reportId);
      this.reports.get(reportId).hazardId = primary.hazardId;
    }
    if (secondary.promisedAt < primary.promisedAt) {
      primary.promisedAt = secondary.promisedAt;
    }
    if (dangerRank(secondary.dangerLevel) > dangerRank(primary.dangerLevel)) {
      const from = primary.dangerLevel;
      primary.dangerLevel = secondary.dangerLevel;
      const reason = `合并 ${secondary.hazardId}：采纳更高危险等级 ${secondary.dangerLevel}`;
      primary.escalations.push({ from, to: primary.dangerLevel, reason, at: this.#now() });
      this.#appendTimeline(primary, "escalation", { from, to: primary.dangerLevel, reason });
    }

    secondary.status = "merged";
    secondary.mergedInto = primary.hazardId;
    this.#appendTimeline(secondary, "merged-into", { target: primary.hazardId, operator, note });
    this.#appendTimeline(primary, "reports-linked", {
      from: secondary.hazardId,
      reportIds: [...secondary.reportIds],
      operator,
      note,
    });
    return clone(primary);
  }

  /**
   * 登记现场观测。水位（depthCm，厘米）与照片研判（severity）会抬高危险等级；
   * 每次升级都记录理由。观测只升不降，人工下调走 adjustDangerLevel。
   */
  recordObservation(hazardId, observation) {
    const hazard = this.#mustGet(hazardId);
    this.#mustBeOpen(hazard);

    let candidate;
    let reason;
    if (observation.type === "water-level") {
      const depthCm = Number(observation.depthCm);
      if (!Number.isFinite(depthCm) || depthCm < 0) {
        throw new DomainError("INVALID_INPUT", "水位深度 depthCm 必须是非负数字");
      }
      candidate = dangerForWaterDepth(depthCm);
      reason = `水位观测 ${depthCm}cm`;
    } else if (observation.type === "photo") {
      candidate = dangerForPhotoSeverity(observation.severity);
      if (candidate == null) {
        throw new DomainError("INVALID_INPUT", "照片研判 severity 必须是 minor/moderate/severe");
      }
      reason = `现场照片研判 ${observation.severity}${observation.note ? `：${observation.note}` : ""}`;
    } else {
      throw new DomainError("INVALID_INPUT", "观测类型必须是 water-level 或 photo");
    }

    const entry = { ...clone(observation), at: this.#now() };
    hazard.observations.push(entry);
    this.#appendTimeline(hazard, "observation", entry);

    let escalated = false;
    if (dangerRank(candidate) > dangerRank(hazard.dangerLevel)) {
      const from = hazard.dangerLevel;
      hazard.dangerLevel = candidate;
      hazard.escalations.push({ from, to: candidate, reason, at: this.#now() });
      this.#appendTimeline(hazard, "escalation", { from, to: candidate, reason });
      escalated = true;
    }
    return { hazard: clone(hazard), escalated, dangerLevel: hazard.dangerLevel };
  }

  /** 人工调整危险等级（可升可降），必须给出理由；升级会记入升级历史。 */
  adjustDangerLevel(hazardId, to, { reason, operator = null } = {}) {
    const hazard = this.#mustGet(hazardId);
    this.#mustBeOpen(hazard);
    if (!DANGER_LEVELS.includes(to)) {
      throw new DomainError("INVALID_INPUT", `未知危险等级: ${to}`);
    }
    requireString(reason, "reason");
    const from = hazard.dangerLevel;
    if (from === to) return clone(hazard);
    hazard.dangerLevel = to;
    const escalated = dangerRank(to) > dangerRank(from);
    if (escalated) {
      hazard.escalations.push({ from, to, reason, at: this.#now() });
    }
    this.#appendTimeline(hazard, escalated ? "escalation" : "danger-adjusted", {
      from,
      to,
      reason,
      operator,
    });
    return clone(hazard);
  }

  /**
   * 跨部门转派：当前承办班组变更，但最初承办关系（originalTeam）
   * 与每一次转派记录（transfers）全部保留，承诺时限不变。
   */
  transferHazard(hazardId, { toTeam, reason = null, operator = null } = {}) {
    const hazard = this.#mustGet(hazardId);
    this.#mustBeOpen(hazard);
    requireString(toTeam, "toTeam");
    if (toTeam === hazard.assigneeTeam) {
      throw new DomainError("INVALID_INPUT", `隐患已由 ${toTeam} 承办，无需转派`);
    }
    const record = {
      fromTeam: hazard.assigneeTeam,
      toTeam,
      reason,
      operator,
      at: this.#now(),
    };
    hazard.transfers.push(record);
    hazard.assigneeTeam = toTeam;
    this.#appendTimeline(hazard, "transfer", record);
    return clone(hazard);
  }

  /** 班组完成处置。 */
  resolveHazard(hazardId, { operator = null, summary = null } = {}) {
    const hazard = this.#mustGet(hazardId);
    this.#mustBeOpen(hazard);
    hazard.status = "resolved";
    hazard.resolvedAt = this.#now();
    this.#appendTimeline(hazard, "resolved", { operator, summary });
    return clone(hazard);
  }

  /** 回访结论：接在处置完成后的原时间线上。 */
  recordCallback(hazardId, { conclusion, satisfied = null, operator = null } = {}) {
    const hazard = this.#mustGet(hazardId);
    if (hazard.status !== "resolved") {
      throw new DomainError("NOT_RESOLVED", `隐患 ${hazardId} 尚未处置完成，不能登记回访结论`);
    }
    requireString(conclusion, "conclusion");
    const record = { conclusion, satisfied, operator, at: this.#now() };
    hazard.callbacks.push(record);
    this.#appendTimeline(hazard, "callback", record);
    return clone(hazard);
  }

  // ---------------------------------------------------------------- 持久化

  #now() {
    return this.now().toISOString();
  }

  #appendTimeline(hazard, kind, data) {
    hazard.timeline.push({ seq: hazard.timeline.length + 1, at: this.#now(), kind, ...clone(data) });
  }

  /** 序列化为可 JSON 化的快照（新进程可凭它原样恢复）。 */
  toJSON() {
    return {
      version: SNAPSHOT_VERSION,
      savedAt: this.#now(),
      slaHours: this.slaHours,
      counters: { ...this.counters },
      grids: clone(this.grids),
      reports: [...this.reports.values()].map(clone),
      hazards: [...this.hazards.values()].map(clone),
    };
  }

  static fromJSON(data) {
    if (data?.version !== SNAPSHOT_VERSION) {
      throw new DomainError("INVALID_INPUT", `不支持的快照版本: ${data?.version}`);
    }
    const service = new HazardService({ slaHours: data.slaHours });
    service.counters = { ...data.counters };
    service.grids = clone(data.grids);
    service.reports = new Map(data.reports.map((r) => [r.reportId, clone(r)]));
    service.hazards = new Map(data.hazards.map((h) => [h.hazardId, clone(h)]));
    return service;
  }

  async saveToFile(filePath) {
    await writeFile(filePath, JSON.stringify(this.toJSON(), null, 2), "utf8");
  }

  static async loadFromFile(filePath) {
    return HazardService.fromJSON(JSON.parse(await readFile(filePath, "utf8")));
  }
}
