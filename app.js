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

async function addRepair(rep) {
  const store = await tx("repairs", "readwrite");
  return new Promise((resolve, reject) => {
    const r = store.add(rep);
    r.onsuccess = () => resolve(r.result);
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

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove("show"), 2200);
}

function csvEscape(v) {
  if (v === null || v === undefined) v = "";
  v = String(v);
  if (/[",\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
  return v;
}

function downloadText(filename, text) {
  const blob = new Blob(["\uFEFF" + text], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = el("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* QR payload -> PC 레코드 매핑 (라벨 생성기와 동일 축약 키) */
function payloadToPC(p) {
  return {
    pc_id: p.id,
    hostname: p.host || "",
    ip: p.ip || "",
    subnet: p.sn || "",
    os: p.os || "",
    os_install_date: p.osdate || "",
    cpu: p.cpu || "",
    memory: p.mem || "",
    storage: p.hdd || "",
    location: "",
    registered_date: p.reg || todayStr(),
    last_check_date: p.chk || todayStr(),
    notes: "",
    updated_at: nowStr(),
  };
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
    payload = JSON.parse(decodedText);
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
  const existing = await getPC(pcId);
  if (!existing) {
    const pc = payloadToPC(payload);
    await putPC(pc);
    toast(`신규 PC 등록됨: ${pcId}`);
    renderScanResult(pc, true);
  } else {
    renderScanResult(existing, false);
  }
}

function fieldRow(label, value) {
  const row = el("div", "field-row");
  row.appendChild(el("span", "field-label", label));
  row.appendChild(el("span", "field-value", value || "-"));
  return row;
}

function renderScanResult(pc, isNew) {
  const box = $("#scanResult");
  box.innerHTML = "";
  box.classList.remove("hidden");
  box.appendChild(el("h3", null, (isNew ? "✅ 신규 등록: " : "📋 조회됨: ") + pc.pc_id));
  const info = el("div", "card");
  info.appendChild(fieldRow("호스트", pc.hostname));
  info.appendChild(fieldRow("IP", pc.ip));
  info.appendChild(fieldRow("OS", pc.os));
  info.appendChild(fieldRow("CPU", pc.cpu));
  info.appendChild(fieldRow("메모리/저장", `${pc.memory} / ${pc.storage}`));
  info.appendChild(fieldRow("최근 점검일", pc.last_check_date));
  box.appendChild(info);

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
function makeClientId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "cid-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

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
    toast("신규 PC(정보 미기재)로 등록됨. 목록에서 상세 수정하세요.");
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
        [p.pc_id, p.hostname, p.ip, p.location].some((v) => (v || "").toLowerCase().includes(q))
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
      <div class="li-title">${pc.pc_id} <span class="muted">${pc.hostname || ""}</span></div>
      <div class="li-sub">${pc.ip || "-"} · ${pc.os || "-"} · 점검일 ${pc.last_check_date || "-"}</div>
    `;
    item.addEventListener("click", () => openDetail(pc.pc_id));
    listEl.appendChild(item);
  });
}
$("#searchBox").addEventListener("input", renderList);

async function openDetail(pcId) {
  const pc = await getPC(pcId);
  const repairs = await getRepairsForPC(pcId);
  const modal = $("#detailModal");
  const body = $("#detailBody");
  body.innerHTML = "";
  body.appendChild(el("h3", null, pc.pc_id));
  const info = el("div", "card");
  [
    ["호스트", pc.hostname], ["IP", pc.ip], ["서브넷", pc.subnet], ["OS", pc.os],
    ["OS 설치일", pc.os_install_date], ["CPU", pc.cpu], ["메모리", pc.memory],
    ["저장장치", pc.storage], ["위치", pc.location], ["등록일", pc.registered_date],
    ["최근 점검일", pc.last_check_date],
  ].forEach(([l, v]) => info.appendChild(fieldRow(l, v)));
  body.appendChild(info);

  const editBtn = el("button", "btn", "정보 수정");
  editBtn.addEventListener("click", () => openEditForm(pc));
  body.appendChild(editBtn);

  body.appendChild(el("h4", null, `점검/수리 이력 (${repairs.length}건)`));
  if (repairs.length === 0) {
    body.appendChild(el("p", "muted", "점검 이력이 없습니다."));
  } else {
    repairs.forEach((r) => {
      const c = el("div", "card small");
      c.innerHTML = `<div class="li-title">${r.repair_date} <span class="muted">(${r.technician || "미상"})</span></div>
        <div class="li-sub">고장: ${r.issue || "-"}</div>
        <div class="li-sub">조치: ${r.action || "-"}</div>`;
      body.appendChild(c);
    });
  }
  modal.classList.remove("hidden");
}

function openEditForm(pc) {
  const body = $("#detailBody");
  body.innerHTML = "";
  body.appendChild(el("h3", null, "PC 정보 수정 — " + pc.pc_id));
  const fields = [
    ["hostname", "호스트"], ["ip", "IP"], ["subnet", "서브넷"], ["os", "OS"],
    ["os_install_date", "OS 설치일 (YYYY-MM-DD)"], ["cpu", "CPU"], ["memory", "메모리"],
    ["storage", "저장장치"], ["location", "위치/부서"], ["notes", "비고"],
  ];
  const form = el("div", "card");
  fields.forEach(([key, label]) => {
    const wrap = el("label");
    wrap.textContent = label + " ";
    const input = el("input");
    input.type = "text";
    input.id = "edit_" + key;
    input.value = pc[key] || "";
    wrap.appendChild(input);
    form.appendChild(wrap);
  });
  const saveBtn = el("button", "btn primary", "저장");
  saveBtn.addEventListener("click", async () => {
    fields.forEach(([key]) => (pc[key] = $("#edit_" + key).value));
    pc.updated_at = nowStr();
    await putPC(pc);
    toast("저장되었습니다");
    openDetail(pc.pc_id);
    renderList();
  });
  form.appendChild(saveBtn);
  body.appendChild(form);
}

$("#detailClose").addEventListener("click", () => $("#detailModal").classList.add("hidden"));

/* ---------------- 내보내기 ---------------- */
const PC_COLS = ["pc_id", "hostname", "ip", "subnet", "os", "os_install_date", "cpu",
  "memory", "storage", "location", "registered_date", "last_check_date", "notes", "updated_at"];
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

/* ---------------- Service worker 등록 ---------------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

/* 초기 렌더 */
renderList();
