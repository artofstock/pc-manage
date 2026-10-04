"use strict";

/* ---------------- IndexedDB ---------------- */
const DB_NAME = "pc_management";
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("pcs")) {
        db.createObjectStore("pcs", { keyPath: "pc_id" });
      }
      if (!db.objectStoreNames.contains("repairs")) {
        const store = db.createObjectStore("repairs", { keyPath: "repair_id", autoIncrement: true });
        store.createIndex("pc_id", "pc_id", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(storeName, mode) {
  const db = await openDB();
  return db.transaction(storeName, mode).objectStore(storeName);
}

/* 여러 저장소를 한 트랜잭션으로 묶어 실행 (중간에 실패하면 전부 취소됨) */
function runTx(stores, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(stores, "readwrite");
        try {
          fn(t);
        } catch (e) {
          try { t.abort(); } catch (_) {}
          reject(e);
          return;
        }
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error("transaction aborted"));
      })
  );
}

async function getPC(pcId) {
  const store = await tx("pcs", "readonly");
  return new Promise((resolve, reject) => {
    const r = store.get(pcId);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

async function putPC(pc) {
  const store = await tx("pcs", "readwrite");
  return new Promise((resolve, reject) => {
    const r = store.put(pc);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

async function getAllPCs() {
  const store = await tx("pcs", "readonly");
  return new Promise((resolve, reject) => {
    const r = store.getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}

/* PC 삭제: 해당 PC의 점검이력도 함께 삭제 */
function deletePC(pcId) {
  return runTx(["pcs", "repairs"], (t) => {
    t.objectStore("pcs").delete(pcId);
    const req = t.objectStore("repairs").index("pc_id").openCursor(IDBKeyRange.only(pcId));
    req.onsuccess = (e) => {
      const c = e.target.result;
      if (c) { c.delete(); c.continue(); }
    };
  });
}

/* PC 저장 + 자산번호가 바뀌면 이전 기록 삭제, 점검이력은 새 자산번호로 이동
   (새 자산번호가 이미 있으면 그 기록을 덮어쓰므로 '병합'으로도 쓰인다) */
function replacePC(oldId, rec) {
  return runTx(["pcs", "repairs"], (t) => {
    const ps = t.objectStore("pcs");
    ps.put(rec);
    if (oldId && oldId !== rec.pc_id) {
      ps.delete(oldId);
      const req = t.objectStore("repairs").index("pc_id").openCursor(IDBKeyRange.only(oldId));
      req.onsuccess = (e) => {
        const c = e.target.result;
        if (c) {
          const v = c.value;
          v.pc_id = rec.pc_id;
          c.update(v);
          c.continue();
        }
      };
    }
  });
}

async function addRepair(rep) {
  const store = await tx("repairs", "readwrite");
  return new Promise((resolve, reject) => {
    const r = store.add(rep);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function putRepair(rep) {
  const store = await tx("repairs", "readwrite");
  return new Promise((resolve, reject) => {
    const r = store.put(rep);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

async function deleteRepair(repairId) {
  const store = await tx("repairs", "readwrite");
  return new Promise((resolve, reject) => {
    const r = store.delete(repairId);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

async function getRepairsForPC(pcId) {
  const store = await tx("repairs", "readonly");
  return new Promise((resolve, reject) => {
    const idx = store.index("pc_id");
    const r = idx.getAll(pcId);
    r.onsuccess = () => resolve((r.result || []).sort((a, b) => (a.repair_date < b.repair_date ? 1 : -1)));
    r.onerror = () => reject(r.error);
  });
}

async function getAllRepairs() {
  const store = await tx("repairs", "readonly");
  return new Promise((resolve, reject) => {
    const r = store.getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}

/* ---------------- 유틸 ---------------- */
const todayStr = () => new Date().toISOString().slice(0, 10);
const nowStr = () => new Date().toISOString();
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const esc = (s) =>
  String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function makeClientId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "cid-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove("show"), 2600);
}

function csvEscape(v) {
  if (v === null || v === undefined) v = "";
  v = String(v);
  if (/[",\r\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
  return v;
}

function downloadText(filename, text) {
  const blob = new Blob(["﻿" + text], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = el("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* CSV 해석 (따옴표·줄바꿈·BOM·CRLF 처리) */
function parseCSV(text) {
  text = String(text || "").replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ",") {
      row.push(cur); cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((v) => v !== "")) rows.push(row);
  return rows;
}

function csvToObjects(text) {
  const rows = parseCSV(text);
  if (rows.length < 1) return { headers: [], items: [] };
  const headers = rows[0].map((h) => h.trim());
  const items = rows.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => (o[h] = (r[i] || "").trim()));
    return o;
  });
  return { headers, items };
}

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(fr.error);
    fr.readAsText(file, "utf-8");
  });
}

/* QR 해석: 신형 'PCM2|값|값|...' 과 구형 JSON 라벨을 모두 지원 */
const QR_FIELDS = ["id", "host", "ip", "sn", "gw", "dns", "ipm", "mac", "os", "bld",
  "osdate", "cpu", "mem", "hdd", "dom", "reg", "chk"];

function parseQr(text) {
  text = (text || "").trim();
  if (text.startsWith("PCM2|")) {
    const parts = text.split("|").slice(1);
    const p = {};
    QR_FIELDS.forEach((k, i) => (p[k] = parts[i] || ""));
    return p;
  }
  return JSON.parse(text); // 구형 라벨(JSON)
}

function decodeIpMode(v) {
  if (v === "D") return "DHCP(자동)";
  if (v === "S") return "고정 IP";
  return v || "";
}
function decodeDomain(v) {
  if (!v) return "";
  if (v.startsWith("D:")) return "도메인: " + v.slice(2);
  if (v.startsWith("W:")) return "작업그룹: " + v.slice(2);
  return v;
}

/* QR payload -> PC 레코드 매핑 */
function payloadToPC(p) {
  return {
    pc_id: p.id,
    hostname: p.host || "",
    ip: p.ip || "",
    subnet: p.sn || "",
    gateway: p.gw || "",
    dns: (p.dns || "").replace(/,/g, ", "),
    ip_mode: decodeIpMode(p.ipm),
    mac: p.mac || "",
    os: p.os || "",
    os_build: p.bld || "",
    os_install_date: p.osdate || "",
    cpu: p.cpu || "",
    memory: p.mem || "",
    storage: p.hdd || "",
    domain: decodeDomain(p.dom),
    location: "",
    registered_date: p.reg || todayStr(),
    last_check_date: p.chk || todayStr(),
    notes: "",
    updated_at: nowStr(),
  };
}

/* 라벨(QR)에 들어 있는 항목 — 스캔 시 기존 값과 비교하는 대상 */
const LABEL_FIELDS = [
  ["hostname", "호스트"], ["ip", "IP"], ["ip_mode", "IP 할당"], ["subnet", "서브넷"],
  ["gateway", "게이트웨이"], ["dns", "DNS"], ["mac", "MAC"], ["domain", "도메인/작업그룹"],
  ["os", "OS"], ["os_build", "OS 빌드"], ["os_install_date", "OS 설치일"], ["cpu", "CPU"],
  ["memory", "메모리"], ["storage", "저장장치"],
];

function normVal(key, v) {
  v = String(v || "").trim().replace(/\s+/g, " ");
  if (key === "mac") return v.toUpperCase().replace(/-/g, ":");
  return v.toLowerCase();
}

async function findByMac(mac, exceptId) {
  const m = normVal("mac", mac);
  if (!m) return null;
  const all = await getAllPCs();
  return all.find((p) => p.pc_id !== exceptId && normVal("mac", p.mac) === m) || null;
}

/* ---------------- 탭 전환 ---------------- */
function showTab(name) {
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  if (name === "list") renderList();
  if (name !== "scan") stopScanner();
}
document.querySelectorAll(".tabbar button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

/* ---------------- 스캔 ---------------- */
let html5QrCode = null;
let scanning = false;

async function startScanner() {
  if (scanning) return;
  const region = $("#reader");
  region.innerHTML = "";
  html5QrCode = new Html5Qrcode("reader");
  scanning = true;
  $("#scanStartBtn").classList.add("hidden");
  $("#scanStopBtn").classList.remove("hidden");
  try {
    await html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 240, height: 240 } },
      onScanSuccess,
      () => {}
    );
  } catch (err) {
    toast("카메라를 시작할 수 없습니다: " + err);
    scanning = false;
    $("#scanStartBtn").classList.remove("hidden");
    $("#scanStopBtn").classList.add("hidden");
  }
}

async function stopScanner() {
  if (!scanning || !html5QrCode) return;
  try {
    await html5QrCode.stop();
    html5QrCode.clear();
  } catch (e) {}
  scanning = false;
  $("#scanStartBtn").classList.remove("hidden");
  $("#scanStopBtn").classList.add("hidden");
}

async function onScanSuccess(decodedText) {
  await stopScanner();
  let payload;
  try {
    payload = parseQr(decodedText);
  } catch (e) {
    toast("QR 내용을 해석할 수 없습니다");
    return;
  }
  if (!payload.id) {
    toast("PC 식별자가 없는 QR입니다");
    return;
  }
  await handleScannedPC(payload.id, payload);
}

async function handleScannedPC(pcId, payload) {
  const fresh = payloadToPC(payload);
  const existing = await getPC(pcId);

  if (!existing) {
    // 자산번호는 새것이지만 MAC이 이미 등록된 PC와 같다면 → 같은 PC의 라벨이 바뀐 것일 수 있음
    const twin = await findByMac(fresh.mac, pcId);
    if (twin) {
      renderTwinChoice(twin, fresh);
      return;
    }
    await putPC(fresh);
    toast(`신규 PC 등록됨: ${pcId}`);
    renderScanResult(fresh, true);
    return;
  }

  // 1) 비어 있던 항목은 라벨 값으로 자동 보충
  let filled = false;
  LABEL_FIELDS.forEach(([k]) => {
    if (!existing[k] && fresh[k]) { existing[k] = fresh[k]; filled = true; }
  });
  if (filled) {
    existing.updated_at = nowStr();
    await putPC(existing);
    toast("비어 있던 항목을 라벨 정보로 보충했습니다");
  }

  // 2) 값이 서로 다른 항목은 사용자가 고르게 한다
  const conflicts = LABEL_FIELDS.filter(
    ([k]) => existing[k] && fresh[k] && normVal(k, existing[k]) !== normVal(k, fresh[k])
  );
  renderScanResult(existing, false);
  if (conflicts.length) renderConflictCard(existing, fresh, conflicts);
}

function fieldRow(label, value) {
  const row = el("div", "field-row");
  row.appendChild(el("span", "field-label", label));
  row.appendChild(el("span", "field-value", value || "-"));
  return row;
}

/* 기존 PC와 라벨 값이 다를 때: 항목별로 라벨 값 반영 여부 선택 */
function renderConflictCard(pc, fresh, conflicts) {
  const box = $("#scanResult");
  const card = el("div", "card warn");
  card.appendChild(el("h4", null, `⚠️ 라벨 내용이 저장된 정보와 다릅니다 (${conflicts.length}개 항목)`));
  card.appendChild(el("p", "muted", "라벨 값으로 바꿀 항목에 체크하세요. 체크를 끄면 기존 값을 유지합니다."));
  const checks = [];
  conflicts.forEach(([k, label]) => {
    const row = el("label", "diff-row");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = true;
    checks.push([k, cb]);
    row.appendChild(cb);
    const txt = el("div", "diff-text");
    txt.appendChild(el("div", "diff-name", label));
    txt.appendChild(el("div", "diff-old", "기존: " + pc[k]));
    txt.appendChild(el("div", "diff-new", "라벨: " + fresh[k]));
    row.appendChild(txt);
    card.appendChild(row);
  });
  const apply = el("button", "btn primary", "선택한 항목을 라벨 값으로 갱신");
  apply.addEventListener("click", async () => {
    let n = 0;
    checks.forEach(([k, cb]) => { if (cb.checked) { pc[k] = fresh[k]; n++; } });
    if (n === 0) { card.remove(); return; }
    pc.updated_at = nowStr();
    await putPC(pc);
    toast(`${n}개 항목을 갱신했습니다`);
    renderScanResult(pc, false);
  });
  const keep = el("button", "btn secondary", "기존 값 그대로 두기");
  keep.addEventListener("click", () => card.remove());
  card.appendChild(apply);
  card.appendChild(keep);
  const h = box.children[0];
  box.insertBefore(card, h ? h.nextSibling : null);
}

/* 새 자산번호인데 MAC이 같은 PC가 이미 있을 때 */
function renderTwinChoice(twin, fresh) {
  const box = $("#scanResult");
  box.innerHTML = "";
  box.classList.remove("hidden");
  box.appendChild(el("h3", null, "🔁 같은 PC로 보입니다"));
  const card = el("div", "card warn");
  card.appendChild(el("p", null, "스캔한 라벨의 MAC 주소가 이미 등록된 PC와 같습니다. 어떻게 정리할까요?"));
  card.appendChild(fieldRow("저장된 자산번호", twin.pc_id));
  card.appendChild(fieldRow("라벨의 자산번호", fresh.pc_id));
  card.appendChild(fieldRow("MAC", fresh.mac));
  card.appendChild(fieldRow("저장된 호스트", twin.hostname));
  card.appendChild(fieldRow("라벨의 호스트", fresh.hostname));

  const merge = el("button", "btn primary", `기존 기록을 "${fresh.pc_id}"로 변경 (점검이력 유지)`);
  merge.addEventListener("click", async () => {
    const rec = Object.assign({}, twin);
    LABEL_FIELDS.forEach(([k]) => { if (fresh[k]) rec[k] = fresh[k]; });
    rec.pc_id = fresh.pc_id;
    rec.updated_at = nowStr();
    await replacePC(twin.pc_id, rec);
    toast(`"${twin.pc_id}" → "${fresh.pc_id}" 로 변경했습니다`);
    renderScanResult(rec, false);
  });
  const separate = el("button", "btn", "별개의 새 PC로 등록");
  separate.addEventListener("click", async () => {
    await putPC(fresh);
    toast(`신규 PC 등록됨: ${fresh.pc_id}`);
    renderScanResult(fresh, true);
  });
  const cancel = el("button", "btn secondary", "취소 (저장하지 않음)");
  cancel.addEventListener("click", () => { box.classList.add("hidden"); box.innerHTML = ""; });
  card.appendChild(merge);
  card.appendChild(separate);
  card.appendChild(cancel);
  box.appendChild(card);
}

function renderScanResult(pc, isNew) {
  const box = $("#scanResult");
  box.innerHTML = "";
  box.classList.remove("hidden");
  box.appendChild(el("h3", null, (isNew ? "✅ 신규 등록: " : "📋 조회됨: ") + pc.pc_id));
  const info = el("div", "card");
  info.appendChild(fieldRow("호스트", pc.hostname));
  info.appendChild(fieldRow("IP", (pc.ip || "") + (pc.ip_mode ? ` (${pc.ip_mode})` : "")));
  info.appendChild(fieldRow("MAC", pc.mac));
  info.appendChild(fieldRow("OS", (pc.os || "") + (pc.os_build ? ` ${pc.os_build}` : "")));
  info.appendChild(fieldRow("CPU", pc.cpu));
  info.appendChild(fieldRow("메모리/저장", `${pc.memory || ""} / ${pc.storage || ""}`));
  info.appendChild(fieldRow("최근 점검일", pc.last_check_date));
  box.appendChild(info);

  const actions = el("div", "btn-row");
  const editBtn = el("button", "btn small", "✏️ 정보 수정");
  editBtn.addEventListener("click", () => openEditForm(pc));
  const delBtn = el("button", "btn small danger", "🗑️ 삭제");
  delBtn.addEventListener("click", () => confirmDeletePC(pc.pc_id));
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);
  box.appendChild(actions);

  const form = el("div", "card");
  form.innerHTML = `
    <h4>점검/수리 등록</h4>
    <label>점검일 <input type="date" id="rep_date" value="${todayStr()}"></label>
    <label>고장/점검 내용 <textarea id="rep_issue" rows="2" placeholder="예: 부팅 불가, 정기점검 등"></textarea></label>
    <label>조치 내용 <textarea id="rep_action" rows="2" placeholder="예: SSD 교체, 먼지 청소 등"></textarea></label>
    <label>담당자 <input type="text" id="rep_tech" placeholder="담당자명"></label>
    <button class="btn primary" id="rep_save">점검 기록 저장</button>
  `;
  box.appendChild(form);

  $("#rep_save").addEventListener("click", async () => {
    const rep = {
      pc_id: pc.pc_id,
      repair_date: $("#rep_date").value || todayStr(),
      issue: $("#rep_issue").value,
      action: $("#rep_action").value,
      technician: $("#rep_tech").value,
      source: "phone",
      client_id: makeClientId(),
    };
    await addRepair(rep);
    pc.last_check_date = rep.repair_date;
    pc.updated_at = nowStr();
    await putPC(pc);
    toast("점검 기록이 저장되었습니다");
    box.classList.add("hidden");
  });
}

$("#scanStartBtn").addEventListener("click", startScanner);
$("#scanStopBtn").addEventListener("click", stopScanner);

/* 수동 입력(QR 인식 불가 시) */
$("#manualBtn").addEventListener("click", async () => {
  const id = prompt("PC 자산번호(예: PC-2026-001)를 입력하세요");
  if (!id) return;
  const existing = await getPC(id.trim());
  if (existing) {
    renderScanResult(existing, false);
  } else {
    const pc = {
      pc_id: id.trim(), hostname: "", ip: "", subnet: "", os: "",
      os_install_date: "", cpu: "", memory: "", storage: "",
      location: "", registered_date: todayStr(), last_check_date: todayStr(),
      notes: "", updated_at: nowStr(),
    };
    await putPC(pc);
    toast("신규 PC(정보 미기재)로 등록됨. 정보 수정에서 내용을 채우세요.");
    renderScanResult(pc, true);
  }
});

/* ---------------- 목록 ---------------- */
async function renderList() {
  const listEl = $("#pcList");
  listEl.innerHTML = "";
  const q = ($("#searchBox").value || "").trim().toLowerCase();
  const pcs = (await getAllPCs()).sort((a, b) => (a.pc_id > b.pc_id ? 1 : -1));
  const filtered = q
    ? pcs.filter((p) =>
        [p.pc_id, p.hostname, p.ip, p.location, p.mac].some((v) => (v || "").toLowerCase().includes(q))
      )
    : pcs;
  $("#pcCount").textContent = `총 ${pcs.length}대 (표시 ${filtered.length}대)`;
  if (filtered.length === 0) {
    listEl.appendChild(el("p", "muted", "등록된 PC가 없습니다. 스캔 탭에서 라벨을 스캔해 보세요."));
    return;
  }
  filtered.forEach((pc) => {
    const item = el("div", "list-item");
    item.innerHTML = `
      <div class="li-title">${esc(pc.pc_id)} <span class="muted">${esc(pc.hostname)}</span></div>
      <div class="li-sub">${esc(pc.ip) || "-"} · ${esc(pc.os) || "-"} · 점검일 ${esc(pc.last_check_date) || "-"}</div>
    `;
    item.addEventListener("click", () => openDetail(pc.pc_id));
    listEl.appendChild(item);
  });
}
$("#searchBox").addEventListener("input", renderList);

async function confirmDeletePC(pcId) {
  const reps = await getRepairsForPC(pcId);
  const msg =
    `"${pcId}" 을(를) 삭제할까요?` +
    (reps.length ? `\n점검/수리 이력 ${reps.length}건도 함께 삭제됩니다.` : "") +
    "\n삭제한 데이터는 복구할 수 없습니다.";
  if (!confirm(msg)) return false;
  await deletePC(pcId);
  toast("삭제되었습니다");
  $("#detailModal").classList.add("hidden");
  const sr = $("#scanResult");
  sr.classList.add("hidden");
  sr.innerHTML = "";
  renderList();
  return true;
}

async function openDetail(pcId) {
  const pc = await getPC(pcId);
  if (!pc) { toast("해당 PC가 없습니다"); return; }
  const repairs = await getRepairsForPC(pcId);
  const modal = $("#detailModal");
  const body = $("#detailBody");
  body.innerHTML = "";
  body.appendChild(el("h3", null, pc.pc_id));
  const info = el("div", "card");
  [
    ["호스트", pc.hostname], ["IP", pc.ip], ["IP 할당", pc.ip_mode], ["서브넷", pc.subnet],
    ["게이트웨이", pc.gateway], ["DNS", pc.dns], ["MAC", pc.mac], ["도메인/작업그룹", pc.domain],
    ["OS", pc.os], ["OS 빌드", pc.os_build],
    ["OS 설치일", pc.os_install_date], ["CPU", pc.cpu], ["메모리", pc.memory],
    ["저장장치", pc.storage], ["위치", pc.location], ["등록일", pc.registered_date],
    ["최근 점검일", pc.last_check_date], ["비고", pc.notes],
  ].forEach(([l, v]) => info.appendChild(fieldRow(l, v)));
  body.appendChild(info);

  const actions = el("div", "btn-row");
  const editBtn = el("button", "btn", "✏️ 정보 수정");
  editBtn.addEventListener("click", () => openEditForm(pc));
  const delBtn = el("button", "btn danger", "🗑️ PC 삭제");
  delBtn.addEventListener("click", () => confirmDeletePC(pc.pc_id));
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);
  body.appendChild(actions);

  body.appendChild(el("h4", null, `점검/수리 이력 (${repairs.length}건)`));
  if (repairs.length === 0) {
    body.appendChild(el("p", "muted", "점검 이력이 없습니다."));
  } else {
    repairs.forEach((r) => {
      const c = el("div", "card small");
      const title = el("div", "li-title", r.repair_date || "-");
      title.appendChild(el("span", "muted", ` (${r.technician || "미상"})`));
      c.appendChild(title);
      c.appendChild(el("div", "li-sub", "고장: " + (r.issue || "-")));
      c.appendChild(el("div", "li-sub", "조치: " + (r.action || "-")));
      const row = el("div", "btn-row");
      const e = el("button", "btn small", "수정");
      e.addEventListener("click", () => openRepairEdit(pc.pc_id, r));
      const d = el("button", "btn small danger", "삭제");
      d.addEventListener("click", async () => {
        if (!confirm(`${r.repair_date || ""} 점검 기록을 삭제할까요?`)) return;
        await deleteRepair(r.repair_id);
        toast("점검 기록을 삭제했습니다");
        openDetail(pc.pc_id);
      });
      row.appendChild(e);
      row.appendChild(d);
      c.appendChild(row);
      body.appendChild(c);
    });
  }
  modal.classList.remove("hidden");
}

/* [키, 라벨, 종류] — 종류가 'date'면 YYYY-MM-DD 검사, 배열이면 선택 목록 */
const EDIT_FIELDS = [
  ["pc_id", "자산번호 *"], ["hostname", "호스트"], ["ip", "IP"],
  ["ip_mode", "IP 할당 방식", ["", "DHCP(자동)", "고정 IP"]],
  ["subnet", "서브넷"], ["gateway", "게이트웨이"], ["dns", "DNS"], ["mac", "MAC"],
  ["domain", "도메인/작업그룹"], ["os", "OS"], ["os_build", "OS 빌드"],
  ["os_install_date", "OS 설치일 (YYYY-MM-DD)", "date"], ["cpu", "CPU"], ["memory", "메모리"],
  ["storage", "저장장치"], ["location", "위치/부서"],
  ["registered_date", "등록일 (YYYY-MM-DD)", "date"],
  ["last_check_date", "최근 점검일 (YYYY-MM-DD)", "date"], ["notes", "비고"],
];

function openEditForm(pc) {
  const body = $("#detailBody");
  body.innerHTML = "";
  body.appendChild(el("h3", null, "PC 정보 수정 — " + pc.pc_id));
  const form = el("div", "card");
  EDIT_FIELDS.forEach(([key, label, kind]) => {
    const wrap = el("label");
    wrap.textContent = label + " ";
    let input;
    if (Array.isArray(kind)) {
      input = el("select");
      const opts = kind.slice();
      if (pc[key] && !opts.includes(pc[key])) opts.push(pc[key]);
      opts.forEach((o) => {
        const op = el("option", null, o || "(미지정)");
        op.value = o;
        input.appendChild(op);
      });
    } else {
      input = el("input");
      input.type = "text";
    }
    input.id = "edit_" + key;
    input.value = pc[key] || "";
    wrap.appendChild(input);
    form.appendChild(wrap);
  });

  const saveBtn = el("button", "btn primary", "저장");
  saveBtn.addEventListener("click", async () => {
    const vals = {};
    EDIT_FIELDS.forEach(([k]) => (vals[k] = $("#edit_" + k).value.trim()));
    if (!vals.pc_id) { toast("자산번호를 입력하세요"); return; }
    for (const [k, label, kind] of EDIT_FIELDS) {
      if (kind === "date" && vals[k] && !/^\d{4}-\d{2}-\d{2}$/.test(vals[k])) {
        toast(`${label} 형식이 올바르지 않습니다`);
        return;
      }
    }
    const oldId = pc.pc_id;
    const rec = Object.assign({}, pc, vals, { updated_at: nowStr() });
    if (vals.pc_id !== oldId) {
      const clash = await getPC(vals.pc_id);
      if (clash) {
        const ok = confirm(
          `"${vals.pc_id}" 은(는) 이미 등록된 자산번호입니다.\n\n두 기록을 하나로 합칠까요?\n` +
          `· 지금 입력한 값이 우선 적용되고, 비어 있는 칸은 기존 "${vals.pc_id}" 값으로 채워집니다.\n` +
          `· "${oldId}" 의 점검이력은 "${vals.pc_id}" 로 이동합니다.`
        );
        if (!ok) return;
        Object.keys(clash).forEach((k) => {
          if ((rec[k] === undefined || rec[k] === "") && clash[k]) rec[k] = clash[k];
        });
      }
    }
    await replacePC(oldId, rec);
    toast("저장되었습니다");
    openDetail(rec.pc_id);
    renderList();
  });
  const cancelBtn = el("button", "btn secondary", "취소");
  cancelBtn.addEventListener("click", () => openDetail(pc.pc_id));
  form.appendChild(saveBtn);
  form.appendChild(cancelBtn);
  body.appendChild(form);
  $("#detailModal").classList.remove("hidden");
}

function openRepairEdit(pcId, rep) {
  const body = $("#detailBody");
  body.innerHTML = "";
  body.appendChild(el("h3", null, "점검 기록 수정 — " + pcId));
  const form = el("div", "card");
  [
    ["repair_date", "점검일 (YYYY-MM-DD)", "input"],
    ["issue", "고장/점검 내용", "textarea"],
    ["action", "조치 내용", "textarea"],
    ["technician", "담당자", "input"],
  ].forEach(([key, label, kind]) => {
    const wrap = el("label");
    wrap.textContent = label + " ";
    const input = el(kind);
    if (kind === "textarea") input.rows = 3;
    else input.type = "text";
    input.id = "rep_edit_" + key;
    input.value = rep[key] || "";
    wrap.appendChild(input);
    form.appendChild(wrap);
  });
  const saveBtn = el("button", "btn primary", "저장");
  saveBtn.addEventListener("click", async () => {
    const date = $("#rep_edit_repair_date").value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast("점검일 형식은 YYYY-MM-DD 입니다"); return; }
    const updated = Object.assign({}, rep, {
      repair_date: date,
      issue: $("#rep_edit_issue").value,
      action: $("#rep_edit_action").value,
      technician: $("#rep_edit_technician").value,
    });
    await putRepair(updated);
    toast("점검 기록을 수정했습니다");
    openDetail(pcId);
  });
  const cancelBtn = el("button", "btn secondary", "취소");
  cancelBtn.addEventListener("click", () => openDetail(pcId));
  form.appendChild(saveBtn);
  form.appendChild(cancelBtn);
  body.appendChild(form);
}

$("#detailClose").addEventListener("click", () => $("#detailModal").classList.add("hidden"));

/* ---------------- 내보내기 ---------------- */
const PC_COLS = ["pc_id", "hostname", "ip", "subnet", "gateway", "dns", "ip_mode", "mac",
  "os", "os_build", "os_install_date", "cpu", "memory", "storage", "domain",
  "location", "registered_date", "last_check_date", "notes", "updated_at"];
const REPAIR_COLS = ["pc_id", "repair_date", "issue", "action", "technician", "source", "client_id"];

$("#exportPcsBtn").addEventListener("click", async () => {
  const pcs = await getAllPCs();
  const lines = [PC_COLS.join(",")];
  pcs.forEach((pc) => lines.push(PC_COLS.map((c) => csvEscape(pc[c])).join(",")));
  downloadText(`pcs_export_${todayStr()}.csv`, lines.join("\n"));
  toast(`PC 목록 CSV 내보내기 완료 (${pcs.length}건)`);
});

$("#exportRepairsBtn").addEventListener("click", async () => {
  const reps = await getAllRepairs();
  const lines = [REPAIR_COLS.join(",")];
  reps.forEach((r) => lines.push(REPAIR_COLS.map((c) => csvEscape(r[c])).join(",")));
  downloadText(`repairs_export_${todayStr()}.csv`, lines.join("\n"));
  toast(`점검이력 CSV 내보내기 완료 (${reps.length}건)`);
});

$("#exportAllBtn").addEventListener("click", async () => {
  $("#exportPcsBtn").click();
  setTimeout(() => $("#exportRepairsBtn").click(), 400);
});

/* ---------------- 불러오기 (CSV) ---------------- */
let importState = null; // { pcs: [], repairs: [], skipped: [], policy: "latest", plan }

/* 불러올 내용을 현재 데이터와 비교해 '무엇이 어떻게 바뀔지' 계산 (저장은 하지 않음)
   policy: latest = 더 최근에 수정된 쪽 우선(비어 있는 칸은 항상 채움)
           overwrite = 불러온 값 우선 / newonly = 새 PC만 추가 */
function planImport(state, policy, existingPcs, existingRepairs) {
  const exMap = new Map(existingPcs.map((p) => [p.pc_id, p]));
  const inMap = new Map();
  state.pcs.forEach((r) => inMap.set(r.pc_id, r)); // 같은 자산번호가 여러 줄이면 마지막 줄 사용
  const plan = { add: [], update: [], same: 0, skip: 0, repairs: [], dupRepairs: 0 };

  inMap.forEach((row, id) => {
    const imp = {};
    PC_COLS.forEach((c) => (imp[c] = (row[c] || "").trim()));
    imp.pc_id = id;
    const ex = exMap.get(id);
    if (!ex) {
      if (!imp.registered_date) imp.registered_date = todayStr();
      if (!imp.updated_at) imp.updated_at = nowStr();
      plan.add.push(imp);
      return;
    }
    if (policy === "newonly") { plan.skip++; return; }
    const importedNewer = (imp.updated_at || "") > (ex.updated_at || "");
    const useImported = policy === "overwrite" || importedNewer;
    const merged = Object.assign({}, ex);
    const changedKeys = [];
    PC_COLS.forEach((c) => {
      if (c === "pc_id" || c === "updated_at") return;
      const iv = imp[c];
      const ev = ex[c] || "";
      if (!iv || iv === ev) return;
      if (!ev || useImported) { merged[c] = iv; changedKeys.push(c); }
    });
    if (changedKeys.length) {
      merged.updated_at = nowStr();
      plan.update.push({ id, before: ex, after: merged, keys: changedKeys });
    } else plan.same++;
  });

  const key = (r) => [r.pc_id, r.repair_date, r.issue, r.action].join("\u0001");
  const cidSet = new Set();
  const compSet = new Set();
  existingRepairs.forEach((r) => {
    if (r.client_id) cidSet.add(r.client_id);
    compSet.add(key(r));
  });
  state.repairs.forEach((r) => {
    const rec = {};
    REPAIR_COLS.forEach((c) => (rec[c] = (r[c] || "").trim()));
    if ((rec.client_id && cidSet.has(rec.client_id)) || compSet.has(key(rec))) { plan.dupRepairs++; return; }
    if (rec.client_id) cidSet.add(rec.client_id);
    compSet.add(key(rec));
    if (!rec.client_id) rec.client_id = makeClientId();
    if (!rec.source) rec.source = "import";
    if (!rec.repair_date) rec.repair_date = todayStr();
    plan.repairs.push(rec);
  });
  return plan;
}

async function renderImportPreview() {
  const box = $("#importPreview");
  box.innerHTML = "";
  box.classList.remove("hidden");
  const st = importState;
  if (!st.pcs.length && !st.repairs.length) {
    box.appendChild(el("p", "muted", "불러올 수 있는 PC 목록/점검이력 CSV가 아닙니다. (이 앱 또는 PC 관리 프로그램에서 내보낸 CSV를 선택하세요)"));
    if (st.skipped.length) box.appendChild(el("p", "muted", "인식하지 못한 파일: " + st.skipped.join(", ")));
    return;
  }
  const [exPcs, exReps] = await Promise.all([getAllPCs(), getAllRepairs()]);
  st.plan = planImport(st, st.policy, exPcs, exReps);
  const plan = st.plan;

  const card = el("div", "card");
  card.appendChild(el("h4", null, "불러오기 미리보기"));
  card.appendChild(fieldRow("파일 내 PC", `${new Set(st.pcs.map((r) => r.pc_id)).size}대`));
  card.appendChild(fieldRow("파일 내 점검이력", `${st.repairs.length}건`));
  card.appendChild(fieldRow("→ 새로 추가될 PC", `${plan.add.length}대`));
  card.appendChild(fieldRow("→ 내용이 바뀔 PC", `${plan.update.length}대`));
  card.appendChild(fieldRow("→ 변경 없음", `${plan.same + plan.skip}대`));
  card.appendChild(fieldRow("→ 새로 추가될 점검이력", `${plan.repairs.length}건`));
  card.appendChild(fieldRow("→ 중복이라 건너뜀", `${plan.dupRepairs}건`));
  box.appendChild(card);

  const pol = el("div", "card");
  pol.appendChild(el("h4", null, "이미 있는 PC와 값이 다를 때"));
  [
    ["latest", "더 최근에 수정된 쪽 우선 (권장)"],
    ["overwrite", "불러온 파일의 값으로 덮어쓰기"],
    ["newonly", "기존 PC는 그대로 두고 새 PC만 추가"],
  ].forEach(([val, text]) => {
    const row = el("label", "opt-row");
    const rb = el("input");
    rb.type = "radio";
    rb.name = "importPolicy";
    rb.value = val;
    rb.checked = st.policy === val;
    rb.addEventListener("change", () => { st.policy = val; renderImportPreview(); });
    row.appendChild(rb);
    row.appendChild(el("span", null, text));
    pol.appendChild(row);
  });
  pol.appendChild(el("p", "muted", "어느 쪽이든 기존에 비어 있던 칸은 불러온 값으로 채워집니다."));
  box.appendChild(pol);

  if (plan.update.length) {
    const ch = el("div", "card");
    ch.appendChild(el("h4", null, "바뀌는 PC (최대 8대 표시)"));
    plan.update.slice(0, 8).forEach((u) => {
      const names = u.keys.map((k) => (EDIT_FIELDS.find((f) => f[0] === k) || [k, k])[1].replace(/ \(.*\)| \*/g, ""));
      ch.appendChild(fieldRow(u.id, names.join(", ")));
    });
    box.appendChild(ch);
  }
  if (st.skipped.length) box.appendChild(el("p", "muted", "인식하지 못한 파일: " + st.skipped.join(", ")));

  const total = plan.add.length + plan.update.length + plan.repairs.length;
  const go = el("button", "btn primary", total ? `불러오기 실행 (${total}건 반영)` : "반영할 내용이 없습니다");
  go.disabled = total === 0;
  go.addEventListener("click", applyImport);
  const cancel = el("button", "btn secondary", "취소");
  cancel.addEventListener("click", () => { importState = null; box.classList.add("hidden"); box.innerHTML = ""; });
  box.appendChild(go);
  box.appendChild(cancel);
}

async function applyImport() {
  if (!importState || !importState.plan) return;
  const plan = importState.plan;
  try {
    await runTx(["pcs", "repairs"], (t) => {
      const ps = t.objectStore("pcs");
      const rs = t.objectStore("repairs");
      plan.add.forEach((p) => ps.put(p));
      plan.update.forEach((u) => ps.put(u.after));
      plan.repairs.forEach((r) => rs.add(r));
    });
  } catch (e) {
    toast("불러오기에 실패했습니다: " + (e && e.message ? e.message : e));
    return;
  }
  toast(`불러오기 완료 — PC ${plan.add.length}대 추가, ${plan.update.length}대 갱신, 점검이력 ${plan.repairs.length}건 추가`);
  importState = null;
  const box = $("#importPreview");
  box.classList.add("hidden");
  box.innerHTML = "";
  renderList();
}

$("#importBtn").addEventListener("click", () => $("#importFile").click());
$("#importFile").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = "";
  if (!files.length) return;
  const st = { pcs: [], repairs: [], skipped: [], policy: "latest", plan: null };
  for (const f of files) {
    try {
      const { headers, items } = csvToObjects(await readFileText(f));
      if (headers.includes("pc_id") && headers.includes("repair_date")) st.repairs.push(...items.filter((r) => r.pc_id));
      else if (headers.includes("pc_id")) st.pcs.push(...items.filter((r) => r.pc_id));
      else st.skipped.push(f.name);
    } catch (err) {
      st.skipped.push(f.name);
    }
  }
  importState = st;
  await renderImportPreview();
});

/* ---------------- 버전 표시 ---------------- */
const APP_VERSION = "v3 · 수정/삭제/불러오기";
{
  const v = $("#appVer");
  if (v) v.textContent = APP_VERSION;
}

/* ---------------- Service worker 등록 ---------------- */
if ("serviceWorker" in navigator) {
  // 새 버전의 서비스워커가 넘겨받으면 한 번만 자동으로 새로고침해서 새 화면을 바로 보여 준다
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js", { updateViaCache: "none" })
      .then((reg) => reg.update())
      .catch(() => {});
  });
}

/* 초기 렌더 */
renderList();
