import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  collection, addDoc, getDocs, deleteDoc,
  doc, updateDoc, query, orderBy, where, serverTimestamp, writeBatch, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged,
  signInAnonymously
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig, db, auth } from "./firebase-config.js";

// ── STATE ─────────────────────────────────────────────────────
let allStudents     = [];
let allApprovals    = [];
let allSyllabus     = [];
let allConfigs      = [];
let configTab       = "all";
let activeConfigId  = null;
let csvRows         = [];
let fetchedRows     = [];
let syllabusCsvRows = [];
let configCsvRows   = [];
let studentDateFrom = "", studentDateTo   = "";
let syllabusDateFrom = "", syllabusDateTo = "";
let configDateFrom   = "", configDateTo   = "";
let currentPage     = 1;
let syllabusPage    = 1;
const PAGE_SIZE     = 15;
let approvalTab     = "all";
let adTab           = "all";
let adStudentMap    = {};
let adExpandedRows  = new Set();
let deleteCallback  = null;
let currentUserEmail = "";
let currentUserTeam  = "admin";
let isGuest          = false;
let _allNotifs       = [];
let _emailjsConfig   = null;
let _batchSchedules  = {};

// Column order for CSV preview / export — UID, Phase, Batch first
const STUDENT_FIELDS = ["phase", "batch", "week", "uid", "name", "email", "contact_number", "student_id", "assessment_date"];

// ── AUTH ──────────────────────────────────────────────────────
onAuthStateChanged(auth, async user => {
  if (user) {
    // ── Anonymous / guest path — bypasses approval entirely ──
    if (user.isAnonymous) {
      isGuest          = true;
      currentUserEmail = "";
      currentUserTeam  = "Guest";
      document.getElementById("auth-screen").style.display    = "none";
      document.getElementById("pending-screen").style.display = "none";
      document.getElementById("app-screen").style.display     = "flex";
      document.getElementById("admin-email-label").textContent = "Guest View";
      const avatarEl = document.getElementById("topbar-avatar");
      if (avatarEl) { avatarEl.textContent = "G"; avatarEl.style.background = "#64748b"; }
      document.body.classList.add("guest-mode");
      const banner = document.getElementById("guest-banner");
      if (banner) banner.style.display = "flex";
      applyRoleAccess("Guest");
      return;
    }
    // ── Registered user path ──
    isGuest          = false;
    currentUserEmail = user.email;
    document.body.classList.remove("guest-mode");
    const banner = document.getElementById("guest-banner");
    if (banner) banner.style.display = "none";
    const snap = await getDocs(query(collection(db, "team_members"), where("email", "==", user.email)));
    let displayLabel = user.email;
    if (!snap.empty) {
      const m = snap.docs[0].data();
      if (m.status !== "approved") {
        document.getElementById("auth-screen").style.display    = "none";
        document.getElementById("app-screen").style.display     = "none";
        document.getElementById("pending-screen").style.display = "flex";
        document.getElementById("pending-msg").textContent =
          m.status === "pending"  ? `Your account (${user.email}) is pending admin approval. Contact admin.`
          : `Your account access has been rejected. Contact admin.`;
        return;
      }
      currentUserTeam = m.team;
      displayLabel = m.name ? `${m.name} · ${m.team}` : user.email;
    } else {
      currentUserTeam = "admin";
      displayLabel = user.email;
    }
    document.getElementById("auth-screen").style.display    = "none";
    document.getElementById("pending-screen").style.display = "none";
    document.getElementById("app-screen").style.display     = "flex";
    document.getElementById("admin-email-label").textContent = displayLabel;
    const avatarEl = document.getElementById("topbar-avatar");
    if (avatarEl) avatarEl.textContent = (currentUserEmail[0] || "A").toUpperCase();
    applyRoleAccess(currentUserTeam);
    loadNotifCount();
    loadSLAEmailSettings();
    loadBatchSchedules();
  } else {
    isGuest          = false;
    currentUserEmail = "";
    currentUserTeam  = "admin";
    document.body.classList.remove("guest-mode");
    document.getElementById("auth-screen").style.display    = "flex";
    document.getElementById("app-screen").style.display     = "none";
    document.getElementById("pending-screen").style.display = "none";
  }
});

window.handleLogin = async () => {
  const email = document.getElementById("login-email").value.trim();
  const pass  = document.getElementById("login-password").value;
  const btn   = document.getElementById("login-btn");
  const err   = document.getElementById("login-error");
  err.style.display = "none";
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span> Signing in...';
  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (e) {
    err.style.display = "block";
    err.textContent   = friendlyAuthError(e.code);
    btn.disabled    = false;
    btn.textContent = "Sign In";
  }
};

window.handleRegister = async () => {
  const name  = document.getElementById("reg-name").value.trim();
  const email = document.getElementById("reg-email").value.trim();
  const team  = document.getElementById("reg-team").value;
  const pass  = document.getElementById("reg-password").value;
  const pass2 = document.getElementById("reg-password2").value;
  const btn   = document.getElementById("reg-btn");
  const err   = document.getElementById("reg-error");
  err.style.display = "none";
  if (!name)  { err.textContent = "Please enter your full name."; err.style.display = "block"; return; }
  if (!team)  { err.textContent = "Please select your team."; err.style.display = "block"; return; }
  if (pass !== pass2) { err.textContent = "Passwords do not match."; err.style.display = "block"; return; }
  if (pass.length < 6) { err.textContent = "Password must be at least 6 characters."; err.style.display = "block"; return; }
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span> Submitting request...';
  try {
    await createUserWithEmailAndPassword(auth, email, pass);
    await addDoc(collection(db, "team_members"), {
      name, email, team, status: "pending", addedAt: serverTimestamp()
    });
    await addDoc(collection(db, "notifications"), {
      type: "registration", status: "pending",
      title: "New Access Request",
      message: `${name} (${email}) from ${team} has requested access and is awaiting approval.`,
      targetTeams: ["Admin"],
      createdBy: email,
      readBy: [],
      createdAt: serverTimestamp()
    });
  } catch (e) {
    err.style.display = "block";
    err.textContent   = friendlyAuthError(e.code);
    btn.disabled    = false;
    btn.textContent = "Request Access";
  }
};

window.handleLogout = async () => {
  await signOut(auth);
  toast("Signed out", "info");
};

window.switchAuthTab = (tab, btn) => {
  document.getElementById("auth-tab-login").style.display    = tab === "login"    ? "block" : "none";
  document.getElementById("auth-tab-register").style.display = tab === "register" ? "block" : "none";
  document.querySelectorAll("#auth-screen .tab").forEach(t => t.classList.remove("active"));
  if (btn) btn.classList.add("active");
};

function friendlyAuthError(code) {
  const map = {
    "auth/invalid-email":        "Invalid email address.",
    "auth/user-not-found":       "No account found with this email.",
    "auth/wrong-password":       "Incorrect password.",
    "auth/invalid-credential":   "Invalid email or password.",
    "auth/email-already-in-use": "An account with this email already exists.",
    "auth/weak-password":        "Password is too weak (min 6 characters).",
    "auth/too-many-requests":    "Too many attempts. Please try again later."
  };
  return map[code] || "Authentication failed. Check your credentials.";
}

// ── ROLE-BASED ACCESS ─────────────────────────────────────────
window.enterGuestMode = async () => {
  const btn = document.querySelector("button[onclick='enterGuestMode()']");
  if (btn) { btn.textContent = "Loading…"; btn.disabled = true; }
  try {
    await signInAnonymously(auth);
    // onAuthStateChanged handles display — anonymous user check bypasses approval
  } catch (e) {
    if (btn) { btn.textContent = "Continue as Guest"; btn.disabled = false; }
    // Most likely cause: Anonymous sign-in not enabled in Firebase Console
    toast("Guest access setup needed — see console for instructions", "error");
    console.error(
      "%c[Guest Mode] Anonymous Authentication is not enabled.\n" +
      "Fix in 2 steps:\n" +
      "1. Go to: https://console.firebase.google.com → Your project → Authentication → Sign-in method\n" +
      "2. Enable \"Anonymous\" provider and save.",
      "color:#b91c1c;font-weight:bold"
    );
  }
};

window.exitGuestMode = async () => {
  await signOut(auth);
  // onAuthStateChanged fires and resets screens
};

function applyRoleAccess(team) {
  const access = {
    "admin":               ["dashboard","students","syllabus","configs","assessments","assessment-details","assignments","teams"],
    "Admin":               ["dashboard","students","syllabus","configs","assessments","assessment-details","assignments","teams"],
    "On Ground Team":      ["dashboard","students","syllabus","assessment-details","assignments"],
    "Content Team":        ["dashboard","syllabus","configs","assessment-details","assignments"],
    "Assessment Ops Team": ["dashboard","students","assessments","assessment-details","assignments"],
    "Instructor":          ["dashboard","assignments"],
    "Guest":               ["dashboard","students","syllabus","configs","assessments","assessment-details","assignments"],
  };
  const allowed = access[team] || access["admin"];

  ["dashboard","students","syllabus","configs","assignments","assessments","assessment-details","teams"].forEach(p => {
    const el = document.getElementById(`nav-${p}`);
    if (el) el.style.display = allowed.includes(p) ? "flex" : "none";
  });
  // About is always visible for all roles
  const navAbout = document.getElementById("nav-about");
  if (navAbout) navAbout.style.display = "flex";
  [["nav-section-main",       ["dashboard","students"]],
   ["nav-section-content",    ["syllabus","configs","assignments"]],
   ["nav-section-operations", ["assessments","assessment-details"]],
   ["nav-section-teams",      ["teams"]]
  ].forEach(([id, pages]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = pages.some(p => allowed.includes(p)) ? "" : "none";
  });
  // Hide SLA email settings for non-admin roles
  const isAdmin = (team === "admin" || team === "Admin");
  const slaCard = document.getElementById("sla-email-settings-card");
  if (slaCard) slaCard.style.display = isAdmin ? "" : "none";
  const bsCard = document.getElementById("batch-schedule-card");
  if (bsCard) bsCard.style.display = isAdmin ? "" : "none";
  switchPage(allowed[0]);
}

// ── NAVIGATION ────────────────────────────────────────────────
window.switchPage = (page) => {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  document.getElementById(`page-${page}`).classList.add("active");
  const navEl = document.getElementById(`nav-${page}`);
  if (navEl) navEl.classList.add("active");
  const pageMeta = {
    dashboard:           { title: "Dashboard",          icon: "⊞" },
    students:            { title: "Student Data",       icon: "👥" },
    syllabus:            { title: "Syllabus",           icon: "📖" },
    configs:             { title: "Topin Configs",      icon: "🔗" },
    assessments:         { title: "Assessments",        icon: "✓" },
    "assessment-details":{ title: "Assessment Details", icon: "📅" },
    teams:               { title: "Teams",              icon: "🛡" },
    assignments:         { title: "Assignments",         icon: "📄" },
    about:               { title: "About",              icon: "ℹ" },
  };
  const meta = pageMeta[page] || { title: page, icon: "" };
  const titleEl = document.getElementById("topbar-title");
  const iconEl  = document.getElementById("topbar-icon");
  if (titleEl) titleEl.textContent = meta.title;
  if (iconEl)  iconEl.textContent  = meta.icon;
  if (page === "students")           loadStudents();
  if (page === "teams")              loadApprovals();
  if (page === "dashboard")          loadDashboard();
  if (page === "syllabus")           loadSyllabus();
  if (page === "configs")            loadConfigs();
  if (page === "assessments")        loadAssessments();
  if (page === "assessment-details") loadAssessmentDetails();
  if (page === "assignments")        loadAssignments();
};

// ── DASHBOARD ─────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const [studSnap, membSnap, syllSnap, cfgSnap] = await Promise.all([
      getDocs(collection(db, "students")),
      getDocs(collection(db, "team_members")),
      getDocs(collection(db, "syllabus")),
      getDocs(collection(db, "configs"))
    ]);

    const members         = membSnap.docs.map(d => d.data());
    const pendingMembers  = members.filter(m => m.status === "pending").length;
    const configs         = cfgSnap.docs.map(d => d.data());
    const pendingConfigs  = configs.filter(c => c.status === "pending").length;
    const submittedConfigs = configs.filter(c => c.status === "submitted").length;

    document.getElementById("stat-students").textContent        = studSnap.size;
    document.getElementById("stat-syllabus").textContent        = syllSnap.size;
    document.getElementById("stat-configs-pending").textContent = pendingConfigs;
    document.getElementById("stat-configs-submitted").textContent = submittedConfigs;
    document.getElementById("stat-pending").textContent         = pendingMembers;
    document.getElementById("stat-members").textContent         = membSnap.size;

    // Recent student uploads
    const recent = studSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.uploadedAt?.seconds || 0) - (a.uploadedAt?.seconds || 0))
      .slice(0, 5);

    const list = document.getElementById("recent-uploads-list");
    if (!recent.length) {
      list.innerHTML = `<div class="empty-state" style="padding:24px 0"><h3>No students yet</h3><p>Upload student records to see them here.</p></div>`;
    } else {
      list.innerHTML = `
        <div class="table-wrapper" style="max-height:320px;overflow-y:auto">
          <table>
            <thead><tr><th>Name</th><th>Phase / Batch / Week</th><th>Assessment Date</th></tr></thead>
            <tbody>${recent.map(s => `
              <tr>
                <td>${escHtml(s.name || "—")}</td>
                <td>${pbwCell(s.phase, s.batch, s.week)}</td>
                <td>${fmtDate(s.assessment_date)}</td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>
        <div style="margin-top:12px;text-align:right">
          <button class="btn btn-outline btn-sm" onclick="switchPage('students')">View All Students</button>
        </div>`;
    }

    // Pending configs needing action
    const pendingCfgDocs = cfgSnap.docs
      .map(d => ({ _id: d.id, ...d.data() }))
      .filter(c => c.status === "pending")
      .slice(0, 5);

    const cfgCountEl = document.getElementById("dash-pending-configs-count");
    if (cfgCountEl) cfgCountEl.textContent = pendingConfigs ? `(${pendingConfigs} total)` : "";

    const cfgList = document.getElementById("dash-pending-configs-list");
    if (!pendingCfgDocs.length) {
      cfgList.innerHTML = `<div class="empty-state" style="padding:24px 0"><h3>All configs submitted</h3><p>No pending configs at the moment.</p></div>`;
    } else {
      cfgList.innerHTML = `
        <div class="table-wrapper" style="max-height:320px;overflow-y:auto">
          <table>
            <thead><tr><th>Phase / Batch / Week</th><th>Assessment Date</th><th></th></tr></thead>
            <tbody>${pendingCfgDocs.map(c => `
              <tr>
                <td>${pbwCell(c.phase, c.batch, c.week)}</td>
                <td>${fmtDate(c.assessment_date)}</td>
                <td><button class="btn btn-primary btn-sm" onclick="openConfigModal('${c._id}')">Add Link</button></td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>
        <div style="margin-top:12px;text-align:right">
          <button class="btn btn-outline btn-sm" onclick="goDashPendingConfigs()">View All Pending</button>
        </div>`;
    }
  } catch (e) {
    console.error(e);
  }
}

window.goDashPendingConfigs = () => {
  configTab = "pending";
  switchPage("configs");
  activateTabByLabel("#configs-tabs", "Pending");
};

window.goDashSubmittedConfigs = () => {
  configTab = "submitted";
  switchPage("configs");
  activateTabByLabel("#configs-tabs", "Submitted");
};

window.goDashPendingApprovals = () => {
  switchPage("teams");
  approvalTab = "pending";
  activateTabByLabel("#teams-tabs", "Pending");
  renderApprovalsTable();
};

// ── STUDENTS ──────────────────────────────────────────────────
window.loadStudents = async () => {
  setTbody("students-tbody", 10, "Loading...");
  try {
    const snap  = await getDocs(query(collection(db, "students"), orderBy("uploadedAt", "desc")));
    allStudents = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    currentPage = 1;
    populateStudentFilters();
    renderStudentsTable();
  } catch (e) {
    setTbody("students-tbody", 10, "Error: " + e.message);
  }
};

window.filterStudents = () => { currentPage = 1; renderStudentsTable(); };

window.onStudentPhaseChange = () => {
  ["student-batch-filter","student-week-filter"].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = "";
  });
  populateStudentBatchFilter();
  populateStudentWeekFilter();
  currentPage = 1;
  renderStudentsTable();
};

window.onStudentBatchChange = () => {
  const wSel = document.getElementById("student-week-filter");
  if (wSel) wSel.value = "";
  populateStudentWeekFilter();
  currentPage = 1;
  renderStudentsTable();
};

window.clearStudentFilters = () => {
  ["student-search","student-phase-filter","student-batch-filter","student-week-filter"]
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
  studentDateFrom = ""; studentDateTo = "";
  window._fpStudent?.clear();
  currentPage = 1;
  renderStudentsTable();
};

function populateStudentFilters() {
  const phases = [...new Set(allStudents.map(s => s.phase).filter(Boolean))].sort();
  const pSel   = document.getElementById("student-phase-filter");
  const pCur   = pSel ? pSel.value : "";
  if (pSel) pSel.innerHTML = `<option value="">Phases</option>` +
    phases.map(p => `<option value="${escHtml(p)}" ${p === pCur ? "selected" : ""}>${escHtml(p)}</option>`).join("");
  populateStudentBatchFilter();
  populateStudentWeekFilter();
}

function populateStudentBatchFilter() {
  const phase   = document.getElementById("student-phase-filter")?.value || "";
  const batches = [...new Set(allStudents.filter(s => !phase || s.phase === phase).map(s => s.batch).filter(Boolean))].sort();
  const sel     = document.getElementById("student-batch-filter");
  const cur     = sel ? sel.value : "";
  if (sel) sel.innerHTML = `<option value="">Batches</option>` +
    batches.map(b => `<option value="${escHtml(b)}" ${b === cur ? "selected" : ""}>${escHtml(b)}</option>`).join("");
}

function populateStudentWeekFilter() {
  const phase = document.getElementById("student-phase-filter")?.value || "";
  const batch = document.getElementById("student-batch-filter")?.value || "";
  const weeks = [...new Set(
    allStudents
      .filter(s => (!phase || s.phase === phase) && (!batch || s.batch === batch))
      .map(s => s.week).filter(Boolean)
  )].sort((a, b) => {
    const na = parseInt(a.replace(/\D/g, ""), 10), nb = parseInt(b.replace(/\D/g, ""), 10);
    return (isNaN(na) || isNaN(nb)) ? a.localeCompare(b) : na - nb;
  });
  const sel = document.getElementById("student-week-filter");
  const cur = sel ? sel.value : "";
  if (sel) sel.innerHTML = `<option value="">Weeks</option>` +
    weeks.map(w => `<option value="${escHtml(w)}" ${w === cur ? "selected" : ""}>${escHtml(w)}</option>`).join("");
}

function studentMatchesQuery(s, q, phase, batch, week, dateFrom, dateTo) {
  if (phase && s.phase !== phase) return false;
  if (batch && s.batch !== batch) return false;
  if (week  && s.week  !== week)  return false;
  if (dateFrom && (s.assessment_date || "") < dateFrom) return false;
  if (dateTo   && (s.assessment_date || "") > dateTo)   return false;
  if (!q) return true;
  return [s.uid, s.phase, s.batch, s.name, s.email, s.student_id, s.contact_number]
    .some(v => (v || "").toLowerCase().includes(q));
}

function renderStudentsTable() {
  const q     = document.getElementById("student-search").value.toLowerCase();
  const phase = document.getElementById("student-phase-filter")?.value || "";
  const batch = document.getElementById("student-batch-filter")?.value || "";
  const week  = document.getElementById("student-week-filter")?.value  || "";
  const filtered = allStudents.filter(s => studentMatchesQuery(s, q, phase, batch, week, studentDateFrom, studentDateTo));
  const total    = filtered.length;
  const pages    = Math.ceil(total / PAGE_SIZE) || 1;
  const slice    = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const tbody = document.getElementById("students-tbody");
  if (!slice.length) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><h3>No students found</h3><p>Try a different search term.</p></div></td></tr>`;
  } else {
    tbody.innerHTML = slice.map((s, i) => `
      <tr>
        <td>${(currentPage - 1) * PAGE_SIZE + i + 1}</td>
        <td>${pbwCell(s.phase, s.batch, s.week)}</td>
        <td><code>${s.uid || "—"}</code></td>
        <td>${s.name || "—"}</td>
        <td>${s.email || "—"}</td>
        <td>${s.student_id || "—"}</td>
        <td>${s.contact_number || "—"}</td>
        <td>${formatDate(s.uploadedAt)}</td>
        <td>
          ${isGuest ? "" : `<button class="btn btn-danger btn-sm" onclick="confirmDeleteStudent('${s._id}','${escHtml(s.name)}')">Delete</button>`}
        </td>
      </tr>`).join("");
  }

  const pag = document.getElementById("students-pagination");
  pag.innerHTML = `
    <span>${total} record${total !== 1 ? "s" : ""}</span>
    <div class="page-btns">
      <button class="page-btn" onclick="goPage(${currentPage - 1})" ${currentPage === 1 ? "disabled" : ""}>&lsaquo;</button>
      ${Array.from({ length: pages }, (_, i) => i + 1)
        .filter(p => Math.abs(p - currentPage) <= 2)
        .map(p => `<button class="page-btn ${p === currentPage ? "active" : ""}" onclick="goPage(${p})">${p}</button>`)
        .join("")}
      <button class="page-btn" onclick="goPage(${currentPage + 1})" ${currentPage === pages ? "disabled" : ""}>&rsaquo;</button>
    </div>`;
}

window.goPage = (p) => {
  const q     = document.getElementById("student-search").value.toLowerCase();
  const phase = document.getElementById("student-phase-filter")?.value || "";
  const batch = document.getElementById("student-batch-filter")?.value || "";
  const week  = document.getElementById("student-week-filter")?.value  || "";
  const pages = Math.ceil(allStudents.filter(s => studentMatchesQuery(s, q, phase, batch, week, studentDateFrom, studentDateTo)).length / PAGE_SIZE) || 1;
  if (p < 1 || p > pages) return;
  currentPage = p;
  renderStudentsTable();
};

window.confirmDeleteStudent = (id, name) => {
  document.getElementById("delete-modal-msg").textContent = `Delete student "${name}"? This action cannot be undone.`;
  deleteCallback = async () => {
    await deleteDoc(doc(db, "students", id));
    allStudents = allStudents.filter(s => s._id !== id);
    renderStudentsTable();
    toast("Student record deleted", "success");
    closeModal("delete-modal");
  };
  document.getElementById("delete-confirm-btn").onclick = deleteCallback;
  document.getElementById("delete-modal").classList.add("open");
};

window.closeModal = (id) => document.getElementById(id).classList.remove("open");

window.exportStudentsCSV = () => {
  const rows = [["UID", "Phase", "Batch", "Name", "Email", "Student ID", "Contact Number", "Assessment Date"]];
  allStudents.forEach(s => rows.push([
    s.uid || "", s.phase || "", s.batch || "",
    s.name || "", s.email || "", s.student_id || "", s.contact_number || "", s.assessment_date || ""
  ]));
  downloadCSV(rows, "students_export.csv");
};

// ── UPLOAD TAB SWITCHER ───────────────────────────────────────
window.switchUploadTab = (tab, btn) => {
  document.getElementById("upload-tab-csv").style.display    = tab === "csv"    ? "block" : "none";
  document.getElementById("upload-tab-manual").style.display = tab === "manual" ? "block" : "none";
  document.getElementById("upload-tab-fetch").style.display  = tab === "fetch"  ? "block" : "none";
  document.querySelectorAll("#upload-tabs .tab").forEach(t => t.classList.remove("active"));
  if (btn) btn.classList.add("active");
};

// ── CSV UPLOAD ────────────────────────────────────────────────
window.handleFileDrop = (e) => {
  e.preventDefault();
  document.getElementById("upload-zone").classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) parseCSVFile(file);
};

window.handleFileSelect = (e) => {
  const file = e.target.files[0];
  if (file) parseCSVFile(file);
};

function parseCSVFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const lines   = e.target.result.trim().split(/\r?\n/);
    if (lines.length < 2) { toast("CSV has no data rows", "error"); return; }
    const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, "").toLowerCase());
    const missing = ["phase","batch","week","uid","name","email","contact_number","student_id","assessment_date"].filter(r => !headers.includes(r));
    if (missing.length) { toast("Missing required columns: " + missing.join(", "), "error"); return; }
    csvRows = lines.slice(1).map(line => {
      const vals = parseCSVLine(line);
      const row  = {};
      headers.forEach((h, i) => row[h] = (vals[i] || "").trim());
      return row;
    }).filter(r => r.uid || r.name || r.email || r.student_id);
    renderCSVPreview(csvRows, headers);
    document.getElementById("csv-preview").style.display = "block";
    document.getElementById("upload-count").textContent  = `${csvRows.length} rows ready to upload`;
  };
  reader.readAsText(file);
}

function parseCSVLine(line) {
  const result = []; let current = ""; let inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === "," && !inQ) { result.push(current); current = ""; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

function renderCSVPreview(rows, headers) {
  const cols  = STUDENT_FIELDS.filter(c => headers.includes(c));
  const preview = rows.slice(0, 5);
  document.getElementById("csv-preview-table").innerHTML = `
    <div class="table-wrapper">
      <table>
        <thead><tr>${cols.map(c => `<th>${c}</th>`).join("")}</tr></thead>
        <tbody>
          ${preview.map(r => `<tr>${cols.map(c => `<td>${r[c] || "—"}</td>`).join("")}</tr>`).join("")}
          ${rows.length > 5 ? `<tr><td colspan="${cols.length}" style="text-align:center;color:var(--muted);padding:10px;font-size:.8rem">and ${rows.length - 5} more rows...</td></tr>` : ""}
        </tbody>
      </table>
    </div>`;
}

window.clearCSVPreview = () => {
  csvRows = [];
  document.getElementById("csv-preview").style.display = "none";
  document.getElementById("csv-file-input").value      = "";
  document.getElementById("upload-count").textContent  = "";
};

window.uploadCSVToFirebase = async () => {
  if (!csvRows.length) { toast("No data to upload", "error"); return; }
  const btn = document.getElementById("upload-btn");
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span> Uploading...';
  try {
    const batch  = writeBatch(db);
    const colRef = collection(db, "students");
    csvRows.forEach(row => {
      const ref = doc(colRef);
      batch.set(ref, {
        uid:             row.uid             || "",
        phase:           row.phase           || "",
        batch:           row.batch           || "",
        week:            row.week            || "",
        name:            row.name            || "",
        email:           row.email           || "",
        student_id:      row.student_id      || "",
        contact_number:  row.contact_number  || "",
        assessment_date: row.assessment_date || "",
        uploadedAt:      serverTimestamp()
      });
    });
    await batch.commit();
    toast(`${csvRows.length} students uploaded successfully`, "success");
    const uPhases  = [...new Set(csvRows.map(r => r.phase).filter(Boolean))];
    const uBatches = [...new Set(csvRows.map(r => r.batch).filter(Boolean))];
    const uDetail  = [uPhases.join(", "), uBatches.join(", ")].filter(Boolean).join(" · ");
    await createNotification("student_data", "added", "Student Data Added",
      `${csvRows.length} student${csvRows.length !== 1 ? "s" : ""} uploaded${uDetail ? " — " + uDetail : ""}`);
    const assessDates = [...new Set(csvRows.map(r => r.assessment_date).filter(Boolean))];
    for (const d of assessDates) {
      await createNotification("assessment", "scheduled", "Assessment Date Set",
        `Assessment on ${fmtDate(d)}${uDetail ? " — " + uDetail : ""}`);
    }
    loadNotifCount();
    clearCSVPreview();
    loadDashboard();
  } catch (e) {
    toast("Upload failed: " + e.message, "error");
  } finally {
    btn.disabled    = false;
    btn.textContent = "Upload to Firebase";
  }
};

window.addStudentManually = async () => {
  const uid    = document.getElementById("m-uid").value.trim();
  const phase  = (document.getElementById("m-phase")?.value  || "").trim();
  const domain = (document.getElementById("m-domain")?.value || "").trim();
  const batchN = (document.getElementById("m-batch")?.value  || "").trim();
  const batch  = batchN ? `B${batchN}` : "";
  const weekN  = (document.getElementById("m-week")?.value   || "").trim();
  const week   = weekN  ? `W${weekN}`  : "";
  const sid    = document.getElementById("m-sid").value.trim();
  const name   = document.getElementById("m-name").value.trim();
  const email  = document.getElementById("m-email").value.trim();
  const phone  = document.getElementById("m-phone").value.trim();
  const adate  = document.getElementById("m-adate").value;
  if (!uid || !name || !email || !sid) {
    toast("UID, Name, Email and Student ID are required", "error");
    return;
  }
  try {
    await addDoc(collection(db, "students"), {
      uid, phase, batch, week, name, email,
      ...(domain ? { domain } : {}),
      student_id: sid, contact_number: phone,
      assessment_date: adate || "",
      uploadedAt: serverTimestamp()
    });
    toast("Student added successfully", "success");
    await createNotification("student_data", "added", "Student Data Added",
      `1 student added manually${phase ? " — " + phase : ""}${batch ? ", " + batch : ""}`);
    if (adate) {
      await createNotification("assessment", "scheduled", "Assessment Date Set",
        `Assessment on ${fmtDate(adate)}${phase ? " — " + phase : ""}${batch ? ", " + batch : ""}`);
    }
    loadNotifCount();
    ["m-uid","m-sid","m-name","m-email","m-phone","m-adate"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    const mPhase = document.getElementById("m-phase");
    const mBatch = document.getElementById("m-batch");
    const mWeek  = document.getElementById("m-week");
    if (mPhase) mPhase.value = "";
    if (mBatch) mBatch.value = "";
    if (mWeek)  mWeek.value  = "";
    const mDomRow = document.getElementById("m-domain-row");
    if (mDomRow) mDomRow.style.display = "none";
  } catch (e) {
    toast("Error: " + e.message, "error");
  }
};

window.downloadTemplate = () => {
  downloadCSV(
    [
      ["uid", "phase", "batch", "name", "email", "student_id", "contact_number", "assessment_date"],
      ["UID001", "Phase 1", "Batch A", "John Doe", "john@college.edu", "STU-2024-001", "9876543210", "2024-03-15"]
    ],
    "student_template.csv"
  );
};

// ── FETCH FROM EXTERNAL API ───────────────────────────────────
window.fetchFromExternalAPI = async () => {
  const url    = document.getElementById("fetch-url").value.trim();
  const apiKey = document.getElementById("fetch-apikey").value.trim();
  const path   = document.getElementById("fetch-path").value.trim();
  if (!url) { toast("Please enter an API URL", "error"); return; }

  const btn = document.getElementById("fetch-btn");
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span> Fetching...';
  document.getElementById("fetch-preview").style.display = "none";

  try {
    const headers = {};
    if (apiKey) headers["Authorization"] = apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    let data = await res.json();

    if (path) {
      for (const key of path.split(".")) {
        if (data == null || typeof data !== "object") throw new Error(`Path "${path}" not found in response`);
        data = data[key];
      }
    }
    if (!Array.isArray(data)) {
      if (data && typeof data === "object") data = [data];
      else throw new Error("Response is not an array. Use the JSON Path field to navigate to the array.");
    }

    const uidF   = document.getElementById("map-uid").value.trim()   || "uid";
    const phaseF = document.getElementById("map-phase").value.trim() || "phase";
    const batchF = document.getElementById("map-batch").value.trim() || "batch";
    const nameF  = document.getElementById("map-name").value.trim()  || "name";
    const emailF = document.getElementById("map-email").value.trim() || "email";
    const sidF   = document.getElementById("map-sid").value.trim()   || "student_id";
    const phoneF = document.getElementById("map-phone").value.trim() || "contact_number";

    fetchedRows = data.map(item => ({
      uid:            String(item[uidF]   || ""),
      phase:          String(item[phaseF] || ""),
      batch:          String(item[batchF] || ""),
      name:           String(item[nameF]  || ""),
      email:          String(item[emailF] || ""),
      student_id:     String(item[sidF]   || ""),
      contact_number: String(item[phoneF] || ""),
    })).filter(r => r.uid || r.name || r.email);

    if (!fetchedRows.length) throw new Error("No valid records found. Check your field mapping.");

    toast(`Fetched ${fetchedRows.length} records`, "success");
    renderFetchPreview(fetchedRows);
    document.getElementById("fetch-preview").style.display = "block";
  } catch (e) {
    toast("Fetch error: " + e.message, "error");
  } finally {
    btn.disabled    = false;
    btn.textContent = "Fetch Data";
  }
};

function renderFetchPreview(rows) {
  const preview = rows.slice(0, 5);
  document.getElementById("fetch-preview-table").innerHTML = `
    <div class="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>UID</th><th>Phase</th><th>Batch</th>
            <th>Name</th><th>Email</th><th>Student ID</th><th>Contact No.</th><th>Assessment Date</th>
          </tr>
        </thead>
        <tbody>
          ${preview.map(r => `
            <tr>
              <td><code>${r.uid || "—"}</code></td>
              <td>${r.phase || "—"}</td>
              <td>${r.batch || "—"}</td>
              <td>${r.name || "—"}</td>
              <td>${r.email || "—"}</td>
              <td>${r.student_id || "—"}</td>
              <td>${r.contact_number || "—"}</td>
              <td>${fmtDate(r.assessment_date)}</td>
            </tr>`).join("")}
          ${rows.length > 5 ? `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:10px;font-size:.8rem">and ${rows.length - 5} more rows...</td></tr>` : ""}
        </tbody>
      </table>
    </div>`;
  document.getElementById("fetch-save-count").textContent = `${rows.length} rows ready to save`;
}

window.saveFetchedToFirebase = async () => {
  if (!fetchedRows.length) { toast("No data to save", "error"); return; }
  const btn = document.getElementById("fetch-save-btn");
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span> Saving...';
  try {
    const batch  = writeBatch(db);
    const colRef = collection(db, "students");
    fetchedRows.forEach(row => {
      const ref = doc(colRef);
      batch.set(ref, { ...row, uploadedAt: serverTimestamp() });
    });
    await batch.commit();
    toast(`${fetchedRows.length} students saved to Firebase`, "success");
    await createNotification("student_data", "added", "Student Data Added",
      `${fetchedRows.length} student${fetchedRows.length !== 1 ? "s" : ""} fetched from external API`);
    loadNotifCount();
    clearFetchPreview();
    loadDashboard();
  } catch (e) {
    toast("Save failed: " + e.message, "error");
  } finally {
    btn.disabled    = false;
    btn.textContent = "Save to Firebase";
  }
};

window.clearFetchPreview = () => {
  fetchedRows = [];
  document.getElementById("fetch-preview").style.display  = "none";
  document.getElementById("fetch-save-count").textContent = "";
};

// ── TEAM APPROVALS ────────────────────────────────────────────
window.loadApprovals = async () => {
  setTbody("approvals-tbody", 6, "Loading...");
  try {
    const snap   = await getDocs(query(collection(db, "team_members"), orderBy("addedAt", "desc")));
    allApprovals = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    renderApprovalsTable();
  } catch (e) {
    setTbody("approvals-tbody", 6, "Error: " + e.message);
  }
};

window.switchTeamTab = (tab, btn) => {
  approvalTab = tab;
  document.querySelectorAll("#teams-tabs .tab").forEach(t => t.classList.remove("active"));
  if (btn) btn.classList.add("active");
  renderApprovalsTable();
};

window.filterApprovals = () => renderApprovalsTable();

function renderApprovalsTable() {
  const q    = (document.getElementById("approval-search")?.value || "").toLowerCase();
  const team = document.getElementById("approval-team-filter")?.value || "";
  const data = allApprovals.filter(m => {
    const effectiveStatus = m.status === "removed" ? "rejected" : m.status;
    const matchTab  = approvalTab === "all" || effectiveStatus === approvalTab;
    const matchTeam = !team || m.team === team;
    const matchQ    = !q || [m.name, m.email, m.team].some(v => (v || "").toLowerCase().includes(q));
    return matchTab && matchTeam && matchQ;
  });
  const tbody = document.getElementById("approvals-tbody");
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><h3>No records found</h3><p>Try adjusting your filters.</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = data.map(m => `
    <tr>
      <td>${m.name || "—"}</td>
      <td>${m.email || "—"}</td>
      <td>${teamBadge(m.team)}</td>
      <td>${formatDate(m.addedAt)}</td>
      <td>${statusBadge(m.status)}</td>
      <td style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        ${m.status !== "approved" ? `<button class="btn btn-success btn-sm" onclick="updateApproval('${m._id}','approved')">Approve</button>` : ""}
        ${m.status === "approved" || m.status === "pending" ? `<button class="btn btn-danger btn-sm" onclick="updateApproval('${m._id}','rejected')">Reject</button>` : ""}
        <button class="btn btn-outline btn-sm" onclick="openEditMember('${m._id}')">Edit</button>
        <button class="btn btn-danger btn-sm" style="background:#7f1d1d" onclick="confirmHardDeleteMember('${m._id}','${escHtml(m.name || m.email)}')">Delete</button>
      </td>
    </tr>`).join("");
}

window.updateApproval = async (id, status) => {
  try {
    await updateDoc(doc(db, "team_members", id), { status, updatedAt: serverTimestamp() });
    const m = allApprovals.find(m => m._id === id);
    if (m) m.status = status;
    renderApprovalsTable();
    loadDashboard();
    toast(`Member ${status}`, "success");
  } catch (e) {
    toast("Error: " + e.message, "error");
  }
};

// ── EDIT MEMBER ───────────────────────────────────────────────
let editingMemberId = null;

window.openEditMember = (id) => {
  const m = allApprovals.find(m => m._id === id);
  if (!m) return;
  editingMemberId = id;
  document.getElementById("edit-member-meta").textContent = m.email || "";
  document.getElementById("edit-member-name").value = m.name || "";
  document.getElementById("edit-member-team").value = m.team || "On Ground Team";
  document.getElementById("edit-member-modal").classList.add("open");
};

window.saveEditMember = async () => {
  if (!editingMemberId) return;
  const name = document.getElementById("edit-member-name").value.trim();
  const team = document.getElementById("edit-member-team").value;
  if (!name) { toast("Name is required", "error"); return; }
  const btn = document.getElementById("edit-member-save-btn");
  btn.disabled = true; btn.textContent = "Saving...";
  try {
    await updateDoc(doc(db, "team_members", editingMemberId), { name, team, updatedAt: serverTimestamp() });
    const m = allApprovals.find(m => m._id === editingMemberId);
    if (m) { m.name = name; m.team = team; }
    renderApprovalsTable();
    closeModal("edit-member-modal");
    toast("Member updated", "success");
  } catch (e) {
    toast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Save Changes";
  }
};

window.confirmHardDeleteMember = (id, label) => {
  document.getElementById("delete-modal-msg").textContent =
    `Permanently delete "${label}" from the portal? This removes their access record. Their Firebase Auth account remains — contact Firebase console to fully revoke login.`;
  deleteCallback = async () => {
    await deleteDoc(doc(db, "team_members", id));
    allApprovals = allApprovals.filter(m => m._id !== id);
    renderApprovalsTable();
    loadDashboard();
    toast("Member deleted", "success");
    closeModal("delete-modal");
  };
  document.getElementById("delete-confirm-btn").onclick = deleteCallback;
  document.getElementById("delete-modal").classList.add("open");
};

window.confirmDeleteMember = (id, name) => {
  document.getElementById("delete-modal-msg").textContent = `Unregister "${name}"? Their account will be blocked. You can re-approve them later.`;
  deleteCallback = async () => {
    await updateDoc(doc(db, "team_members", id), { status: "removed", updatedAt: serverTimestamp() });
    const m = allApprovals.find(m => m._id === id);
    if (m) m.status = "removed";
    renderApprovalsTable();
    toast(`${name} unregistered`, "success");
    closeModal("delete-modal");
    loadDashboard();
  };
  document.getElementById("delete-confirm-btn").onclick = deleteCallback;
  document.getElementById("delete-modal").classList.add("open");
};

window.adminRegisterUser = async () => {
  const name  = document.getElementById("admin-reg-name").value.trim();
  const email = document.getElementById("admin-reg-email").value.trim();
  const team  = document.getElementById("admin-reg-team").value;
  const pass  = document.getElementById("admin-reg-password").value;
  const btn   = document.getElementById("admin-reg-btn");
  if (!name || !email || !team) { toast("Name, Email and Team are required", "error"); return; }
  if (!pass || pass.length < 6) { toast("Password must be at least 6 characters", "error"); return; }
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span> Registering...';
  let tempApp = null;
  try {
    // Use a secondary Firebase app instance so admin session is not disrupted
    tempApp = initializeApp(firebaseConfig, `reg_${Date.now()}`);
    const tempAuth = getAuth(tempApp);
    await createUserWithEmailAndPassword(tempAuth, email, pass);
    await deleteApp(tempApp);
    tempApp = null;
    await addDoc(collection(db, "team_members"), {
      name, email, team, status: "approved", addedAt: serverTimestamp()
    });
    toast(`${name} registered and approved`, "success");
    ["admin-reg-name", "admin-reg-email", "admin-reg-password"].forEach(id => document.getElementById(id).value = "");
    document.getElementById("admin-reg-team").value = "";
    loadApprovals();
    loadDashboard();
  } catch (e) {
    if (tempApp) { try { await deleteApp(tempApp); } catch (_) {} }
    toast("Error: " + e.message, "error");
  } finally {
    btn.disabled    = false;
    btn.textContent = "Register & Approve";
  }
};

// ── SYLLABUS ──────────────────────────────────────────────────
const SYLLABUS_FIELDS = ["phase", "batch", "week", "subjects", "topics", "assessment_date"];

window.loadSyllabus = async () => {
  setTbody("syllabus-tbody", 8, "Loading...");
  try {
    const snap  = await getDocs(query(collection(db, "syllabus"), orderBy("addedAt", "desc")));
    allSyllabus = snap.docs.map(d => {
      const data = d.data();
      // Normalize: old flat format (subject/topics strings) → new subjects array
      if (!data.subjects) {
        data.subjects = data.subject ? [{ name: data.subject, topics: data.topics || "" }] : [];
      }
      return { _id: d.id, ...data };
    });
    syllabusPage = 1;
    populateSyllabusFilters();
    renderSyllabusTable();
  } catch (e) {
    setTbody("syllabus-tbody", 8, "Error: " + e.message);
  }
};

function populateSyllabusFilters() {
  // Phase — always from full list
  const phases = [...new Set(allSyllabus.map(r => r.phase).filter(Boolean))].sort();
  const pSel = document.getElementById("syllabus-phase-filter");
  const pCur = pSel.value;
  pSel.innerHTML = `<option value="">Phases</option>` +
    phases.map(p => `<option value="${escHtml(p)}" ${p === pCur ? "selected" : ""}>${p}</option>`).join("");

  populateBatchFilter();
  populateWeekFilter();
}

function populateBatchFilter() {
  const phase = document.getElementById("syllabus-phase-filter").value;
  const batches = [...new Set(
    allSyllabus.filter(r => !phase || r.phase === phase).map(r => r.batch).filter(Boolean)
  )].sort();
  const sel = document.getElementById("syllabus-batch-filter");
  const cur = sel.value;
  sel.innerHTML = `<option value="">Batches</option>` +
    batches.map(b => `<option value="${escHtml(b)}" ${b === cur ? "selected" : ""}>${b}</option>`).join("");
}

function populateWeekFilter() {
  const phase = document.getElementById("syllabus-phase-filter").value;
  const batch = document.getElementById("syllabus-batch-filter").value;
  const weeks = [...new Set(
    allSyllabus
      .filter(r => (!phase || r.phase === phase) && (!batch || r.batch === batch))
      .map(r => r.week).filter(Boolean)
  )].sort((a, b) => {
    const na = parseInt(a.replace(/\D/g, ""), 10);
    const nb = parseInt(b.replace(/\D/g, ""), 10);
    return (isNaN(na) || isNaN(nb)) ? a.localeCompare(b) : na - nb;
  });
  const sel = document.getElementById("syllabus-week-filter");
  const cur = sel.value;
  sel.innerHTML = `<option value="">Weeks</option>` +
    weeks.map(w => `<option value="${escHtml(w)}" ${w === cur ? "selected" : ""}>${w}</option>`).join("");
}

window.onSyllabusPhaseChange = () => {
  document.getElementById("syllabus-batch-filter").value = "";
  document.getElementById("syllabus-week-filter").value  = "";
  populateBatchFilter();
  populateWeekFilter();
  syllabusPage = 1;
  renderSyllabusTable();
};

window.onSyllabusBatchChange = () => {
  document.getElementById("syllabus-week-filter").value = "";
  populateWeekFilter();
  syllabusPage = 1;
  renderSyllabusTable();
};

window.filterSyllabus = () => { syllabusPage = 1; renderSyllabusTable(); };

window.clearSyllabusFilters = () => {
  ["syllabus-search","syllabus-phase-filter","syllabus-batch-filter","syllabus-week-filter"]
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
  syllabusDateFrom = ""; syllabusDateTo = "";
  window._fpSyllabus?.clear();
  syllabusPage = 1;
  populateSyllabusFilters();
  renderSyllabusTable();
};

function syllabusMatchesQuery(r, q, phase, batch, week, dateFrom, dateTo) {
  if (phase && r.phase !== phase) return false;
  if (batch && r.batch !== batch) return false;
  if (week  && r.week  !== week)  return false;
  if (dateFrom && (r.assessment_date || "") < dateFrom) return false;
  if (dateTo   && (r.assessment_date || "") > dateTo)   return false;
  if (!q) return true;
  const subjectsText = (r.subjects || []).map(s => `${s.name} ${s.topics}`).join(" ");
  return [r.phase, r.batch, r.week, subjectsText].some(v => (v || "").toLowerCase().includes(q));
}

function renderSubjectsCell(subjects, id) {
  if (!subjects || !subjects.length) return "—";
  const preview = subjects.slice(0, 3).map(s => escHtml(s.name || "—")).join(", ")
    + (subjects.length > 3 ? ` +${subjects.length - 3} more` : "");
  return `<div>
    <span class="subjects-names">${preview}</span>
    <button class="subjects-expand-btn" onclick="toggleSyllabusDetail('${id}',this)">▼ View topics</button>
  </div>`;
}

function renderSubjectsDetail(subjects) {
  if (!subjects || !subjects.length) return "";
  return subjects.map(s => {
    const topics = (s.topics || "").split("|").map(t => t.trim()).filter(Boolean);
    return `<div class="syllabus-detail-subject">
      <div class="syllabus-detail-subject-name">${escHtml(s.name || "—")}</div>
      ${topics.length ? `<div class="syllabus-detail-topics">${topics.map(t => `<span class="topic-tag">${escHtml(t)}</span>`).join("")}</div>` : ""}
    </div>`;
  }).join("");
}

window.toggleSyllabusDetail = (id, btn) => {
  const row = document.getElementById(`syllabus-detail-${id}`);
  if (!row) return;
  const open = row.style.display !== "none";
  row.style.display = open ? "none" : "";
  btn.innerHTML = open ? "&#9660; Details" : "&#9650; Details";
};

function renderSyllabusTable() {
  const q     = document.getElementById("syllabus-search").value.toLowerCase();
  const phase = document.getElementById("syllabus-phase-filter").value;
  const batch = document.getElementById("syllabus-batch-filter").value;
  const week  = document.getElementById("syllabus-week-filter").value;
  const filtered = allSyllabus.filter(r => syllabusMatchesQuery(r, q, phase, batch, week, syllabusDateFrom, syllabusDateTo));
  const total    = filtered.length;
  const pages    = Math.ceil(total / PAGE_SIZE) || 1;
  const slice    = filtered.slice((syllabusPage - 1) * PAGE_SIZE, syllabusPage * PAGE_SIZE);

  const tbody = document.getElementById("syllabus-tbody");
  if (!slice.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><h3>No syllabus entries found</h3><p>Add entries manually or upload a CSV.</p></div></td></tr>`;
  } else {
    tbody.innerHTML = slice.map((r, i) => `
      <tr>
        <td>${(syllabusPage - 1) * PAGE_SIZE + i + 1}</td>
        <td>${pbwCell(r.phase, r.batch, r.week)}</td>
        <td style="min-width:280px">${renderSubjectsCell(r.subjects, r._id)}</td>
        <td style="min-width:200px">${fmtMockAssessment(r.mock_assessment, r.assessment_date, r.assessment_start_time, r.assessment_end_time, r.mock_assessment_date, r.mock_assessment_start_time, r.mock_assessment_end_time)}</td>
        <td>${formatDate(r.addedAt)}</td>
        <td>
          ${isGuest ? `<span style="font-size:.75rem;color:var(--muted)">View only</span>` : `<div class="row-actions">
            <button class="btn btn-outline btn-sm" onclick="openEditSyllabus('${r._id}')">Edit</button>
            <button class="icon-btn icon-btn-danger" title="Delete Syllabus"
                onclick="confirmDeleteSyllabus('${r._id}','${escHtml(r.phase)} / ${escHtml(r.week)}')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
            </button>
          </div>`}
        </td>
      </tr>
      <tr id="syllabus-detail-${r._id}" style="display:none;background:var(--bg)">
        <td colspan="6" style="padding:0 16px 16px 48px">
          <div class="syllabus-detail-panel">
            ${renderSubjectsDetail(r.subjects)}
          </div>
        </td>
      </tr>`).join("");
  }

  const pag = document.getElementById("syllabus-pagination");
  pag.innerHTML = `
    <span>${total} entr${total !== 1 ? "ies" : "y"}</span>
    <div class="page-btns">
      <button class="page-btn" onclick="goSyllabusPage(${syllabusPage - 1})" ${syllabusPage === 1 ? "disabled" : ""}>&lsaquo;</button>
      ${Array.from({ length: pages }, (_, i) => i + 1)
        .filter(p => Math.abs(p - syllabusPage) <= 2)
        .map(p => `<button class="page-btn ${p === syllabusPage ? "active" : ""}" onclick="goSyllabusPage(${p})">${p}</button>`)
        .join("")}
      <button class="page-btn" onclick="goSyllabusPage(${syllabusPage + 1})" ${syllabusPage === pages ? "disabled" : ""}>&rsaquo;</button>
    </div>`;
}

window.goSyllabusPage = (p) => {
  const q     = document.getElementById("syllabus-search").value.toLowerCase();
  const phase = document.getElementById("syllabus-phase-filter").value;
  const batch = document.getElementById("syllabus-batch-filter").value;
  const week  = document.getElementById("syllabus-week-filter").value;
  const pages = Math.ceil(allSyllabus.filter(r => syllabusMatchesQuery(r, q, phase, batch, week, syllabusDateFrom, syllabusDateTo)).length / PAGE_SIZE) || 1;
  if (p < 1 || p > pages) return;
  syllabusPage = p;
  renderSyllabusTable();
};

// ── Subject row helpers ────────────────────────────────────────
window.addSubjectRow = () => {
  const list = document.getElementById("sy-subjects-list");
  const idx  = list.children.length + 1;
  const div  = document.createElement("div");
  div.className = "subject-row";
  div.innerHTML = `
    <div class="subject-row-header">
      <span class="subject-row-label">Subject ${idx}</span>
      <button type="button" class="btn btn-danger btn-sm" onclick="removeSubjectRow(this)">Remove</button>
    </div>
    <input type="text" class="sy-subject-name" placeholder="Subject name (e.g. Mathematics)" />
    <textarea class="sy-subject-topics" rows="2" placeholder="Topics covered — comma-separated or one per line (e.g. Arrays, Sorting, Recursion)"></textarea>`;
  list.appendChild(div);
};

window.removeSubjectRow = (btn) => {
  btn.closest(".subject-row").remove();
  renumberSubjectRows();
};

function renumberSubjectRows() {
  document.querySelectorAll("#sy-subjects-list .subject-row").forEach((row, i) => {
    row.querySelector(".subject-row-label").textContent = `Subject ${i + 1}`;
  });
}

function resetSubjectRows() {
  document.getElementById("sy-subjects-list").innerHTML = "";
  window.addSubjectRow();
}

window.addSyllabusManually = async () => {
  const phase  = (document.getElementById("sy-phase")?.value  || "").trim();
  const domain = (document.getElementById("sy-domain")?.value || "").trim();
  const batchN = (document.getElementById("sy-batch")?.value  || "").trim();
  const batch  = batchN ? `B${batchN}` : "";
  const weekN  = (document.getElementById("sy-week")?.value   || "").trim();
  const week   = weekN  ? `W${weekN}`  : "";
  const adate          = document.getElementById("sy-adate").value;
  const startTime      = document.getElementById("sy-start-time").value;
  const endTime        = document.getElementById("sy-end-time").value;
  const mockAssessment = document.getElementById("sy-mock-assessment").value;
  const mockDate       = document.getElementById("sy-mock-adate").value;
  const mockStartTime  = document.getElementById("sy-mock-start-time").value;
  const mockEndTime    = document.getElementById("sy-mock-end-time").value;
  if (!phase || !week) {
    toast("Phase and Week are required", "error");
    return;
  }
  const subjectRows = document.querySelectorAll("#sy-subjects-list .subject-row");
  const subjects = [];
  subjectRows.forEach(row => {
    const name   = row.querySelector(".sy-subject-name").value.trim();
    const topics = row.querySelector(".sy-subject-topics").value.trim();
    if (name) subjects.push({ name, topics });
  });
  if (!subjects.length) { toast("Add at least one subject with a name", "error"); return; }
  try {
    const existing = await getDocs(query(
      collection(db, "syllabus"),
      where("phase", "==", phase),
      where("batch", "==", batch),
      where("week",  "==", week)
    ));
    let isNewEntry = false;
    if (!existing.empty) {
      const existingDoc      = existing.docs[0];
      const existingSubjects = existingDoc.data().subjects || [];
      await updateDoc(doc(db, "syllabus", existingDoc.id), {
        subjects: [...existingSubjects, ...subjects],
        ...(adate     ? { assessment_date:       adate     } : {}),
        ...(startTime ? { assessment_start_time: startTime } : {}),
        ...(endTime   ? { assessment_end_time:   endTime   } : {}),
        mock_assessment:             mockAssessment || "",
        mock_assessment_date:        mockAssessment === "required" ? mockDate      || "" : "",
        mock_assessment_start_time:  mockAssessment === "required" ? mockStartTime || "" : "",
        mock_assessment_end_time:    mockAssessment === "required" ? mockEndTime   || "" : "",
      });
      // Sync to linked config
      await syncTimesToConfig(phase, batch, week, adate, startTime, endTime, mockAssessment, mockDate, mockStartTime, mockEndTime);
      toast(`${subjects.length} subject(s) added to existing ${week} entry`, "success");
    } else {
      await addDoc(collection(db, "syllabus"), {
        phase, batch, week, subjects,
        ...(domain ? { domain } : {}),
        assessment_date:             adate          || "",
        assessment_start_time:       startTime      || "",
        assessment_end_time:         endTime        || "",
        mock_assessment:             mockAssessment || "",
        mock_assessment_date:        mockAssessment === "required" ? mockDate      || "" : "",
        mock_assessment_start_time:  mockAssessment === "required" ? mockStartTime || "" : "",
        mock_assessment_end_time:    mockAssessment === "required" ? mockEndTime   || "" : "",
        addedAt: serverTimestamp()
      });
      isNewEntry = true;
      toast(`${subjects.length} subject(s) saved for ${week}`, "success");
    }
    await createNotification("syllabus", "updated", "Syllabus Updated",
      `${week} updated — ${phase}${batch ? ", " + batch : ""} (${subjects.length} subject${subjects.length !== 1 ? "s" : ""})`);
    await createNotification("student_data", "pending", "Student Data Pending",
      `Student data not yet uploaded for ${phase}${batch ? ", " + batch : ""}`);
    if (adate) {
      await createNotification("assessment", "scheduled", "Assessment Date Set",
        `Assessment on ${fmtDate(adate)} — ${phase}${batch ? ", " + batch : ""} (${week})`);
    }
    if (isNewEntry) {
      await ensureConfigDoc(phase, batch, week, adate, startTime, endTime, mockAssessment, mockDate, mockStartTime, mockEndTime);
      await createNotification("config_request", "pending", "Config Link Needed",
        `Please provide topin config link for ${week} — ${phase}${batch ? ", " + batch : ""}`);
    }
    loadNotifCount();
    const syPhase = document.getElementById("sy-phase"); if (syPhase) syPhase.value = "";
    const syBatch = document.getElementById("sy-batch"); if (syBatch) syBatch.value = "";
    const syWeek  = document.getElementById("sy-week");  if (syWeek)  syWeek.value  = "";
    const syDomRow = document.getElementById("sy-domain-row"); if (syDomRow) syDomRow.style.display = "none";
    document.getElementById("sy-adate").value      = "";
    document.getElementById("sy-start-time").value      = "";
    document.getElementById("sy-end-time").value        = "";
    document.getElementById("sy-mock-assessment").value  = "";
    document.getElementById("sy-mock-adate").value       = "";
    document.getElementById("sy-mock-start-time").value  = "";
    document.getElementById("sy-mock-end-time").value    = "";
    document.getElementById("sy-mock-fields").style.display = "none";
    resetSubjectRows();
    loadSyllabus();
  } catch (e) {
    toast("Error: " + e.message, "error");
  }
};

window.confirmDeleteSyllabus = (id, label) => {
  const r = allSyllabus.find(s => s._id === id);
  const hasConfig = r && allConfigs.some(c => c.phase === r.phase && c.batch === (r.batch || "") && c.week === r.week);
  document.getElementById("delete-modal-msg").textContent =
    `Delete syllabus entry for "${label}"?${hasConfig ? " The linked Topin Config entry will also be deleted." : ""} This cannot be undone.`;
  deleteCallback = async () => {
    await deleteDoc(doc(db, "syllabus", id));
    allSyllabus = allSyllabus.filter(s => s._id !== id);
    if (r) {
      const cfgSnap = await getDocs(query(
        collection(db, "configs"),
        where("phase", "==", r.phase || ""),
        where("batch", "==", r.batch || ""),
        where("week",  "==", r.week  || "")
      ));
      for (const d of cfgSnap.docs) {
        await deleteDoc(doc(db, "configs", d.id));
        allConfigs = allConfigs.filter(c => c._id !== d.id);
      }
    }
    renderSyllabusTable();
    toast("Syllabus entry deleted", "success");
    closeModal("delete-modal");
  };
  document.getElementById("delete-confirm-btn").onclick = deleteCallback;
  document.getElementById("delete-modal").classList.add("open");
};

// ── EDIT SYLLABUS ─────────────────────────────────────────────
let editingSyllabusId = null;

window.openEditSyllabus = (id) => {
  const r = allSyllabus.find(s => s._id === id);
  if (!r) return;
  editingSyllabusId = id;
  document.getElementById("edit-syllabus-meta").textContent =
    `Editing: ${r.phase || ""}${r.batch ? " · " + r.batch : ""} · ${r.week || ""}`;
  const esPhase = document.getElementById("edit-sy-phase");
  if (esPhase) esPhase.value = r.phase || "";
  const esBatch = document.getElementById("edit-sy-batch");
  if (esBatch) esBatch.value = (r.batch || "").replace(/\D/g, "");
  const esWeek = document.getElementById("edit-sy-week");
  if (esWeek) esWeek.value = (r.week || "").replace(/\D/g, "");
  const esDomain = document.getElementById("edit-sy-domain");
  if (esDomain) esDomain.value = r.domain || "python";
  const esDomRow = document.getElementById("edit-sy-domain-row");
  if (esDomRow) {
    const phN = parseInt((r.phase || "").replace(/\D/g, "")) || 0;
    esDomRow.style.display = (phN === 3 || phN === 4) ? "" : "none";
  }
  document.getElementById("edit-sy-adate").value                = r.assessment_date             || "";
  document.getElementById("edit-sy-start-time").value           = r.assessment_start_time       || "";
  document.getElementById("edit-sy-end-time").value             = r.assessment_end_time         || "";
  document.getElementById("edit-sy-mock-assessment").value      = r.mock_assessment              || "";
  document.getElementById("edit-sy-mock-adate").value           = r.mock_assessment_date        || "";
  document.getElementById("edit-sy-mock-start-time").value      = r.mock_assessment_start_time  || "";
  document.getElementById("edit-sy-mock-end-time").value        = r.mock_assessment_end_time    || "";
  document.getElementById("edit-sy-mock-fields").style.display  = r.mock_assessment === "required" ? "block" : "none";

  const list = document.getElementById("edit-sy-subjects-list");
  list.innerHTML = "";
  (r.subjects || [{ name: "", topics: "" }]).forEach((s, i) => {
    list.appendChild(buildEditSubjectRow(i + 1, s.name || "", s.topics || ""));
  });
  document.getElementById("edit-syllabus-modal").classList.add("open");
};

function buildEditSubjectRow(idx, name, topics) {
  const div = document.createElement("div");
  div.className = "subject-row";
  div.style.cssText = "padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg)";
  div.innerHTML = `
    <div class="subject-row-header" style="margin-bottom:6px">
      <span class="subject-row-label" style="font-size:.78rem">Subject ${idx}</span>
      <button type="button" class="btn btn-danger btn-sm" style="padding:2px 8px;font-size:.72rem" onclick="removeEditSubjectRow(this)">Remove</button>
    </div>
    <input type="text" class="sy-subject-name" placeholder="Subject name" value="${escHtml(name)}" style="margin-bottom:6px;padding:5px 10px;font-size:.84rem" />
    <textarea class="sy-subject-topics" rows="2" placeholder="Topics (pipe-separated)" style="padding:5px 10px;font-size:.82rem;resize:vertical">${escHtml(topics)}</textarea>`;
  return div;
}

window.addEditSubjectRow = () => {
  const list = document.getElementById("edit-sy-subjects-list");
  list.appendChild(buildEditSubjectRow(list.children.length + 1, "", ""));
};

window.removeEditSubjectRow = (btn) => {
  btn.closest(".subject-row").remove();
  document.querySelectorAll("#edit-sy-subjects-list .subject-row").forEach((row, i) => {
    row.querySelector(".subject-row-label").textContent = `Subject ${i + 1}`;
  });
};

window.saveEditSyllabus = async () => {
  if (!editingSyllabusId) return;
  const phase  = (document.getElementById("edit-sy-phase")?.value  || "").trim();
  const domain = (document.getElementById("edit-sy-domain")?.value || "").trim();
  const batchN = (document.getElementById("edit-sy-batch")?.value  || "").trim();
  const batch  = batchN ? `B${batchN}` : "";
  const weekN  = (document.getElementById("edit-sy-week")?.value   || "").trim();
  const week   = weekN  ? `W${weekN}`  : "";
  const adate          = document.getElementById("edit-sy-adate").value;
  const startTime      = document.getElementById("edit-sy-start-time").value;
  const endTime        = document.getElementById("edit-sy-end-time").value;
  const mockAssessment = document.getElementById("edit-sy-mock-assessment").value;
  const mockDate       = document.getElementById("edit-sy-mock-adate").value;
  const mockStartTime  = document.getElementById("edit-sy-mock-start-time").value;
  const mockEndTime    = document.getElementById("edit-sy-mock-end-time").value;
  if (!phase || !week) { toast("Phase and Week are required", "error"); return; }

  const subjects = [];
  document.querySelectorAll("#edit-sy-subjects-list .subject-row").forEach(row => {
    const name   = row.querySelector(".sy-subject-name").value.trim();
    const topics = row.querySelector(".sy-subject-topics").value.trim();
    if (name) subjects.push({ name, topics });
  });
  if (!subjects.length) { toast("Add at least one subject", "error"); return; }

  const btn = document.getElementById("edit-syllabus-save-btn");
  btn.disabled = true;
  btn.textContent = "Saving...";
  try {
    const mockADate = mockAssessment === "required" ? mockDate      || "" : "";
    const mockAST   = mockAssessment === "required" ? mockStartTime || "" : "";
    const mockAET   = mockAssessment === "required" ? mockEndTime   || "" : "";
    await updateDoc(doc(db, "syllabus", editingSyllabusId), {
      phase, batch, week, subjects,
      ...(domain ? { domain } : {}),
      assessment_date:             adate          || "",
      assessment_start_time:       startTime      || "",
      assessment_end_time:         endTime        || "",
      mock_assessment:             mockAssessment || "",
      mock_assessment_date:        mockADate,
      mock_assessment_start_time:  mockAST,
      mock_assessment_end_time:    mockAET,
      updatedAt: serverTimestamp()
    });
    const idx = allSyllabus.findIndex(s => s._id === editingSyllabusId);
    if (idx !== -1) Object.assign(allSyllabus[idx], {
      phase, batch, week, subjects,
      assessment_date:             adate          || "",
      assessment_start_time:       startTime      || "",
      assessment_end_time:         endTime        || "",
      mock_assessment:             mockAssessment || "",
      mock_assessment_date:        mockADate,
      mock_assessment_start_time:  mockAST,
      mock_assessment_end_time:    mockAET,
    });
    await syncTimesToConfig(phase, batch, week, adate, startTime, endTime, mockAssessment, mockDate, mockStartTime, mockEndTime);
    await createNotification("syllabus", "updated", "Syllabus Updated",
      `${week} updated — ${phase}${batch ? ", " + batch : ""} (${subjects.length} subject${subjects.length !== 1 ? "s" : ""})`);
    if (adate) {
      await createNotification("assessment", "scheduled", "Assessment Date Updated",
        `Assessment on ${fmtDate(adate)} — ${phase}${batch ? ", " + batch : ""} (${week})`);
    }
    loadNotifCount();
    closeModal("edit-syllabus-modal");
    renderSyllabusTable();
    toast("Syllabus entry updated", "success");
  } catch (e) {
    toast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Changes";
  }
};

window.exportSyllabusCSV = () => {
  const rows = [["Phase", "Batch", "Week", "Subject", "Topics", "Assessment Date", "Start Time", "End Time", "Mock Assessment", "Mock Date", "Mock Start Time", "Mock End Time"]];
  allSyllabus.forEach(r => {
    (r.subjects || []).forEach(s => {
      rows.push([r.phase || "", r.batch || "", r.week || "", s.name || "", s.topics || "",
        r.assessment_date || "", r.assessment_start_time || "", r.assessment_end_time || "",
        r.mock_assessment || "", r.mock_assessment_date || "",
        r.mock_assessment_start_time || "", r.mock_assessment_end_time || ""]);
    });
  });
  if (rows.length === 1) { toast("No syllabus data to export", "error"); return; }
  downloadCSV(rows, "syllabus_export.csv");
};

window.switchSyllabusTab = (tab, btn) => {
  document.getElementById("syllabus-tab-manual").style.display = tab === "manual" ? "block" : "none";
  document.getElementById("syllabus-tab-csv").style.display    = tab === "csv"    ? "block" : "none";
  document.querySelectorAll("#syllabus-upload-tabs .tab").forEach(t => t.classList.remove("active"));
  if (btn) btn.classList.add("active");
};

window.handleSyllabusFileDrop = (e) => {
  e.preventDefault();
  document.getElementById("syllabus-upload-zone").classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) parseSyllabusCSV(file);
};

window.handleSyllabusFileSelect = (e) => {
  const file = e.target.files[0];
  if (file) parseSyllabusCSV(file);
};

function parseSyllabusCSV(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const lines   = e.target.result.trim().split(/\r?\n/);
    if (lines.length < 2) { toast("CSV has no data rows", "error"); return; }
    const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, "").toLowerCase());
    const missing = ["phase","batch","week","subjects","topics","assessment_date"].filter(r => !headers.includes(r));
    if (missing.length) { toast("Missing required columns: " + missing.join(", "), "error"); return; }
    syllabusCsvRows = lines.slice(1).map(line => {
      const vals = parseCSVLine(line);
      const row  = {};
      headers.forEach((h, i) => row[h] = (vals[i] || "").trim());
      return row;
    }).filter(r => r.phase || r.subject || r.week);
    renderSyllabusPreview(syllabusCsvRows, headers);
    document.getElementById("syllabus-csv-preview").style.display = "block";
    document.getElementById("syllabus-upload-count").textContent  = `${syllabusCsvRows.length} rows ready to upload`;
  };
  reader.readAsText(file);
}

function renderSyllabusPreview(rows, headers) {
  const cols    = SYLLABUS_FIELDS.filter(c => headers.includes(c));
  const preview = rows.slice(0, 5);
  document.getElementById("syllabus-preview-table").innerHTML = `
    <div class="table-wrapper">
      <table>
        <thead><tr>${cols.map(c => `<th>${c}</th>`).join("")}</tr></thead>
        <tbody>
          ${preview.map(r => `<tr>${cols.map(c => `<td>${r[c] || "—"}</td>`).join("")}</tr>`).join("")}
          ${rows.length > 5 ? `<tr><td colspan="${cols.length}" style="text-align:center;color:var(--muted);padding:10px;font-size:.8rem">and ${rows.length - 5} more rows...</td></tr>` : ""}
        </tbody>
      </table>
    </div>`;
}

window.clearSyllabusPreview = () => {
  syllabusCsvRows = [];
  document.getElementById("syllabus-csv-preview").style.display = "none";
  document.getElementById("syllabus-csv-input").value           = "";
  document.getElementById("syllabus-upload-count").textContent  = "";
};

window.uploadSyllabusCSV = async () => {
  if (!syllabusCsvRows.length) { toast("No data to upload", "error"); return; }
  const btn = document.getElementById("syllabus-upload-btn");
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span> Uploading...';
  try {
    // Group flat CSV rows by phase + batch + week into single entries
    const groups = {};
    syllabusCsvRows.forEach(row => {
      const key = `${row.phase}||${row.batch}||${row.week}`;
      if (!groups[key]) groups[key] = { phase: row.phase || "", batch: row.batch || "", week: row.week || "", subjects: [], assessment_date: "" };
      if (row.subjects) groups[key].subjects.push({ name: row.subjects, topics: row.topics || "" });
      if (row.assessment_date && !groups[key].assessment_date) groups[key].assessment_date = row.assessment_date;
    });
    const entries = Object.values(groups).filter(e => e.phase && e.week && e.subjects.length);

    let created = 0; let merged = 0;
    const newEntryLabels = [];
    for (const entry of entries) {
      const existing = await getDocs(query(
        collection(db, "syllabus"),
        where("phase", "==", entry.phase),
        where("batch", "==", entry.batch),
        where("week",  "==", entry.week)
      ));
      if (!existing.empty) {
        const existingDoc      = existing.docs[0];
        const existingSubjects = existingDoc.data().subjects || [];
        await updateDoc(doc(db, "syllabus", existingDoc.id), {
          subjects: [...existingSubjects, ...entry.subjects],
          ...(entry.assessment_date ? { assessment_date: entry.assessment_date } : {})
        });
        merged++;
      } else {
        await addDoc(collection(db, "syllabus"), { ...entry, addedAt: serverTimestamp() });
        await ensureConfigDoc(entry.phase, entry.batch, entry.week, entry.assessment_date);
        newEntryLabels.push(`${entry.week} (${entry.phase}${entry.batch ? ", " + entry.batch : ""})`);
        created++;
      }
    }
    const msg = [created && `${created} new entr${created !== 1 ? "ies" : "y"} created`,
                 merged  && `${merged} entr${merged !== 1 ? "ies" : "y"} updated`].filter(Boolean).join(", ");
    toast(msg || "Upload complete", "success");
    const uniqueKeys = [...new Set(syllabusCsvRows.map(r => `${r.phase}|${r.batch}`))];
    for (const key of uniqueKeys) {
      const [p, b] = key.split("|");
      await createNotification("syllabus", "updated", "Syllabus Updated",
        `Syllabus uploaded for ${p}${b ? ", " + b : ""}`);
      await createNotification("student_data", "pending", "Student Data Pending",
        `Student data not yet uploaded for ${p}${b ? ", " + b : ""}`);
    }
    const assessEntries = Object.values(groups).filter(e => e.assessment_date);
    for (const e of assessEntries) {
      await createNotification("assessment", "scheduled", "Assessment Date Set",
        `Assessment on ${fmtDate(e.assessment_date)} — ${e.phase}${e.batch ? ", " + e.batch : ""} (${e.week})`);
    }
    if (newEntryLabels.length) {
      await createNotification("config_request", "pending", "Config Link Needed",
        `Please provide topin config links for: ${newEntryLabels.join("; ")}`);
    }
    loadNotifCount();
    clearSyllabusPreview();
    loadSyllabus();
  } catch (e) {
    toast("Upload failed: " + e.message, "error");
  } finally {
    btn.disabled    = false;
    btn.textContent = "Upload to Firebase";
  }
};

window.downloadSyllabusTemplate = () => {
  downloadCSV(
    [
      ["phase", "batch", "week", "subjects", "topics", "assessment_date"],
      ["Phase 1", "Batch A", "Week 1", "Mathematics", "Number Systems, Algebra, Quadratic Equations", "2024-03-15"],
      ["Phase 1", "Batch A", "Week 1", "Data Structures", "Arrays, Linked Lists, Stacks", "2024-03-15"],
      ["Phase 1", "Batch A", "Week 2", "Physics", "Kinematics, Dynamics", "2024-03-22"]
    ],
    "syllabus_template.csv"
  );
};

// ── TOPIC CONFIGS ─────────────────────────────────────────────
async function ensureConfigDoc(phase, batch, week, adate, startTime = "", endTime = "", mockAssessment = "", mockDate = "", mockStartTime = "", mockEndTime = "") {
  const snap = await getDocs(query(
    collection(db, "configs"),
    where("phase", "==", phase),
    where("batch", "==", batch || ""),
    where("week",  "==", week)
  ));
  if (snap.empty) {
    await addDoc(collection(db, "configs"), {
      phase, batch: batch || "", week,
      assessment_date:             adate          || "",
      assessment_start_time:       startTime      || "",
      assessment_end_time:         endTime        || "",
      mock_assessment:             mockAssessment || "",
      mock_assessment_date:        mockAssessment === "required" ? mockDate      || "" : "",
      mock_assessment_start_time:  mockAssessment === "required" ? mockStartTime || "" : "",
      mock_assessment_end_time:    mockAssessment === "required" ? mockEndTime   || "" : "",
      config_link: "",
      status: "pending",
      syllabus_submitted_at: serverTimestamp(),
      createdAt: serverTimestamp()
    });
    return true;
  }
  return false;
}

async function syncTimesToConfig(phase, batch, week, adate, startTime, endTime, mockAssessment, mockDate, mockStartTime, mockEndTime) {
  const snap = await getDocs(query(
    collection(db, "configs"),
    where("phase", "==", phase),
    where("batch", "==", batch || ""),
    where("week",  "==", week)
  ));
  const updates = {};
  if (adate)     updates.assessment_date       = adate;
  if (startTime) updates.assessment_start_time = startTime;
  if (endTime)   updates.assessment_end_time   = endTime;
  if (mockAssessment !== undefined) {
    updates.mock_assessment            = mockAssessment || "";
    updates.mock_assessment_date       = mockAssessment === "required" ? mockDate      || "" : "";
    updates.mock_assessment_start_time = mockAssessment === "required" ? mockStartTime || "" : "";
    updates.mock_assessment_end_time   = mockAssessment === "required" ? mockEndTime   || "" : "";
  }
  if (!snap.empty && Object.keys(updates).length) {
    await updateDoc(doc(db, "configs", snap.docs[0].id), updates);
    const cfg = allConfigs.find(c => c._id === snap.docs[0].id);
    if (cfg) Object.assign(cfg, updates);
  }
}

window.loadConfigs = async () => {
  setTbody("configs-tbody", 9, "Loading...");
  try {
    const snap = await getDocs(query(collection(db, "configs"), orderBy("createdAt", "desc")));
    allConfigs = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    populateConfigFilters();
    renderConfigsTable();
  } catch (e) {
    setTbody("configs-tbody", 9, "Error: " + e.message);
  }
};

function populateConfigFilters() {
  const phases  = [...new Set(allConfigs.map(c => c.phase).filter(Boolean))].sort();
  const pSel    = document.getElementById("config-phase-filter");
  const pCur    = pSel ? pSel.value : "";
  if (pSel) pSel.innerHTML = `<option value="">Phases</option>` +
    phases.map(p => `<option value="${escHtml(p)}" ${p === pCur ? "selected" : ""}>${escHtml(p)}</option>`).join("");
  populateConfigBatchFilter();
  populateConfigWeekFilter();
}

function populateConfigBatchFilter() {
  const phase   = document.getElementById("config-phase-filter")?.value || "";
  const batches = [...new Set(allConfigs.filter(c => !phase || c.phase === phase).map(c => c.batch).filter(Boolean))].sort();
  const sel     = document.getElementById("config-batch-filter");
  const cur     = sel ? sel.value : "";
  if (sel) sel.innerHTML = `<option value="">Batches</option>` +
    batches.map(b => `<option value="${escHtml(b)}" ${b === cur ? "selected" : ""}>${escHtml(b)}</option>`).join("");
}

function populateConfigWeekFilter() {
  const phase = document.getElementById("config-phase-filter")?.value || "";
  const batch = document.getElementById("config-batch-filter")?.value || "";
  const weeks = [...new Set(
    allConfigs.filter(c => (!phase || c.phase === phase) && (!batch || c.batch === batch)).map(c => c.week).filter(Boolean)
  )].sort((a, b) => {
    const na = parseInt(a.replace(/\D/g, ""), 10), nb = parseInt(b.replace(/\D/g, ""), 10);
    return (isNaN(na) || isNaN(nb)) ? a.localeCompare(b) : na - nb;
  });
  const sel = document.getElementById("config-week-filter");
  const cur = sel ? sel.value : "";
  if (sel) sel.innerHTML = `<option value="">Weeks</option>` +
    weeks.map(w => `<option value="${escHtml(w)}" ${w === cur ? "selected" : ""}>${escHtml(w)}</option>`).join("");
}

window.onConfigPhaseChange = () => {
  const bSel = document.getElementById("config-batch-filter");
  const wSel = document.getElementById("config-week-filter");
  if (bSel) bSel.value = "";
  if (wSel) wSel.value = "";
  populateConfigBatchFilter();
  populateConfigWeekFilter();
  renderConfigsTable();
};

window.onConfigBatchChange = () => {
  const wSel = document.getElementById("config-week-filter");
  if (wSel) wSel.value = "";
  populateConfigWeekFilter();
  renderConfigsTable();
};

window.clearConfigFilters = () => {
  ["config-search","config-phase-filter","config-batch-filter","config-week-filter"]
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
  configDateFrom = ""; configDateTo = "";
  window._fpConfig?.clear();
  populateConfigFilters();
  renderConfigsTable();
};

window.switchConfigTab = (tab, btn) => {
  configTab = tab;
  document.querySelectorAll("#configs-tabs .tab").forEach(t => t.classList.remove("active"));
  if (btn) btn.classList.add("active");
  renderConfigsTable();
};

window.syncConfigsFromSyllabus = async () => {
  const btn = document.getElementById("sync-configs-btn");
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Syncing...';
  try {
    const [syllabusSnap, configsSnap] = await Promise.all([
      getDocs(collection(db, "syllabus")),
      getDocs(collection(db, "configs"))
    ]);

    // Build set of valid syllabus keys
    const syllabusKeys = new Set(
      syllabusSnap.docs.map(d => {
        const r = d.data();
        return `${r.phase || ""}||${r.batch || ""}||${r.week || ""}`;
      })
    );

    // Build map of existing config keys → doc id
    const existingConfigMap = {};
    configsSnap.docs.forEach(d => {
      const c = d.data();
      existingConfigMap[`${c.phase || ""}||${c.batch || ""}||${c.week || ""}`] = d.id;
    });

    // Add missing configs for syllabus entries
    let created = 0;
    for (const s of syllabusSnap.docs) {
      const r = s.data();
      const key = `${r.phase || ""}||${r.batch || ""}||${r.week || ""}`;
      if (!existingConfigMap[key] && r.phase && r.week) {
        await addDoc(collection(db, "configs"), {
          phase: r.phase || "", batch: r.batch || "", week: r.week || "",
          assessment_date:             r.assessment_date             || "",
          assessment_start_time:       r.assessment_start_time       || "",
          assessment_end_time:         r.assessment_end_time         || "",
          mock_assessment:             r.mock_assessment              || "",
          mock_assessment_date:        r.mock_assessment === "required" ? r.mock_assessment_date       || "" : "",
          mock_assessment_start_time:  r.mock_assessment === "required" ? r.mock_assessment_start_time || "" : "",
          mock_assessment_end_time:    r.mock_assessment === "required" ? r.mock_assessment_end_time   || "" : "",
          config_link: "", status: "pending",
          createdAt: serverTimestamp()
        });
        created++;
      }
    }

    // Remove orphaned configs (no matching syllabus entry)
    let removed = 0;
    for (const d of configsSnap.docs) {
      const c = d.data();
      const key = `${c.phase || ""}||${c.batch || ""}||${c.week || ""}`;
      if (!syllabusKeys.has(key)) {
        await deleteDoc(doc(db, "configs", d.id));
        removed++;
      }
    }

    const parts = [];
    if (created) parts.push(`${created} config entr${created !== 1 ? "ies" : "y"} created`);
    if (removed) parts.push(`${removed} orphaned entr${removed !== 1 ? "ies" : "y"} removed`);
    toast(parts.length ? parts.join(", ") : "Configs already in sync with syllabus", parts.length ? "success" : "info");
    await loadConfigs();
  } catch (e) {
    toast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Sync from Syllabus";
  }
};

window.filterConfigs = () => renderConfigsTable();

function renderConfigsTable() {
  const q     = (document.getElementById("config-search")?.value || "").toLowerCase();
  const phase = document.getElementById("config-phase-filter")?.value || "";
  const batch = document.getElementById("config-batch-filter")?.value || "";
  const week  = document.getElementById("config-week-filter")?.value  || "";
  const filtered = allConfigs.filter(c => {
    const allLinksComplete = !!c.config_link && (c.mock_assessment !== "required" || !!c.mock_config_link);
    const anyLinkMissing   = !allLinksComplete && c.status !== "published";
    const matchTab = configTab === "all"
      || (configTab === "pending"   && anyLinkMissing)
      || (configTab === "submitted" && allLinksComplete && c.status !== "published");
    const matchQ     = !q     || [c.phase, c.batch, c.week].some(v => (v || "").toLowerCase().includes(q));
    const matchPhase = !phase || c.phase === phase;
    const matchBatch = !batch || c.batch === batch;
    const matchWeek  = !week  || c.week  === week;
    const matchFrom  = !configDateFrom || (c.assessment_date || "") >= configDateFrom;
    const matchTo    = !configDateTo   || (c.assessment_date || "") <= configDateTo;
    return matchTab && matchQ && matchPhase && matchBatch && matchWeek && matchFrom && matchTo;
  });
  const tbody = document.getElementById("configs-tbody");
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><h3>No config entries found</h3><p>Config entries are created automatically when new syllabus weeks are added.</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = filtered.map((c, i) => `
    <tr style="${(!c.config_link || (c.mock_assessment === "required" && !c.mock_config_link)) && c.status !== "published" ? "background:var(--warning-bg, #fffbeb);" : ""}">
      <td>${i + 1}</td>
      <td>${pbwCell(c.phase, c.batch, c.week)}</td>
      <td style="min-width:200px">${fmtMockAssessment(c.mock_assessment, c.assessment_date, c.assessment_start_time, c.assessment_end_time, c.mock_assessment_date, c.mock_assessment_start_time, c.mock_assessment_end_time)}</td>
      <td style="max-width:200px">${configLinkCell(c.config_link)}</td>
      <td style="max-width:200px">${c.mock_assessment === "required" ? configLinkCell(c.mock_config_link) : '<span style="color:var(--muted);font-size:.78rem">—</span>'}</td>
      <td>${configStatusBadge(c)}</td>
      <td>${c.submittedAt ? formatDate(c.submittedAt) : "—"}</td>
      <td>
        <div class="row-actions">
          ${isGuest ? "" : `<button class="icon-btn ${c.status === "pending" ? "icon-btn-primary" : "icon-btn-outline"}"
              title="${c.status === "pending" ? "Add Link" : "Update Link"}"
              onclick="openConfigModal('${c._id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>`}
          <button class="btn btn-outline btn-sm"
              onclick="viewSyllabusFromConfig('${escHtml(c.phase||"")}','${escHtml(c.batch||"")}','${escHtml(c.week||"")}')">
            View Syllabus
          </button>
          ${isGuest ? "" : `<button class="icon-btn icon-btn-danger"
              title="Delete"
              onclick="confirmDeleteConfig('${c._id}','${escHtml(c.phase||"")}','${escHtml(c.week||"")}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>`}
        </div>
      </td>
    </tr>`).join("");
}

window.confirmDeleteConfig = (id, phase, week) => {
  document.getElementById("delete-modal-msg").textContent =
    `Delete config entry for "${phase} / ${week}"? This will not affect the linked syllabus entry.`;
  deleteCallback = async () => {
    await deleteDoc(doc(db, "configs", id));
    allConfigs = allConfigs.filter(c => c._id !== id);
    renderConfigsTable();
    loadDashboard();
    toast("Config entry deleted", "success");
    closeModal("delete-modal");
  };
  document.getElementById("delete-confirm-btn").onclick = deleteCallback;
  document.getElementById("delete-modal").classList.add("open");
};

window.viewSyllabusFromConfig = async (phase, batch, week) => {
  switchPage("syllabus");
  await loadSyllabus();
  const phaseEl = document.getElementById("syllabus-phase-filter");
  const batchEl = document.getElementById("syllabus-batch-filter");
  const weekEl  = document.getElementById("syllabus-week-filter");
  if (phaseEl) phaseEl.value = phase;
  populateBatchFilter();
  if (batchEl) batchEl.value = batch;
  populateWeekFilter();
  if (weekEl)  weekEl.value = week;
  filterSyllabus();
};

window.openConfigModal = (id) => {
  const c = allConfigs.find(c => c._id === id);
  if (!c) return;
  activeConfigId = id;
  window._pendingConfigMeta = null;
  document.getElementById("config-modal-title").textContent =
    c.status === "pending" ? "Add Config Link" : "Update Config Link";
  document.getElementById("config-modal-meta").innerHTML =
    `<strong>${escHtml(c.phase || "")}</strong>${c.batch ? " &middot; " + escHtml(c.batch) : ""} &middot; ${escHtml(c.week || "")}` +
    (c.assessment_date ? `<br>Assessment Date: <strong>${fmtDate(c.assessment_date)}</strong>` : "");
  document.getElementById("config-link-input").value = c.config_link || "";
  const mockWrap = document.getElementById("cm-mock-link-wrap");
  const hasMock = c.mock_assessment === "required";
  mockWrap.style.display = hasMock ? "block" : "none";
  document.getElementById("mock-config-link-input").value = hasMock ? (c.mock_config_link || "") : "";
  document.getElementById("config-modal").classList.add("open");
};

window.openConfigForSyllabusId = async (syllabusId) => {
  const r = allSyllabus.find(s => s._id === syllabusId);
  if (!r) return;
  const snap = await getDocs(query(
    collection(db, "configs"),
    where("phase", "==", r.phase || ""),
    where("batch", "==", r.batch || ""),
    where("week",  "==", r.week  || "")
  ));
  document.getElementById("config-link-input").value = "";
  document.getElementById("config-modal-meta").innerHTML =
    `<strong>${escHtml(r.phase || "")}</strong>${r.batch ? " &middot; " + escHtml(r.batch) : ""} &middot; ${escHtml(r.week || "")}` +
    (r.assessment_date ? `<br>Assessment Date: <strong>${fmtDate(r.assessment_date)}</strong>` : "");
  const hasMock = r.mock_assessment === "required";
  const mockWrap = document.getElementById("cm-mock-link-wrap");
  mockWrap.style.display = hasMock ? "block" : "none";
  if (!snap.empty) {
    const cDoc = snap.docs[0];
    activeConfigId = cDoc.id;
    window._pendingConfigMeta = null;
    const cData = cDoc.data();
    document.getElementById("config-modal-title").textContent =
      cData.status === "pending" ? "Add Config Link" : "Update Config Link";
    document.getElementById("config-link-input").value = cData.config_link || "";
    document.getElementById("mock-config-link-input").value = hasMock ? (cData.mock_config_link || "") : "";
  } else {
    activeConfigId = null;
    window._pendingConfigMeta = {
      phase: r.phase || "",
      batch: r.batch || "",
      week:  r.week  || "",
      adate: r.assessment_date || "",
      mockAssessment: r.mock_assessment || ""
    };
    document.getElementById("config-modal-title").textContent = "Add Config Link";
    document.getElementById("mock-config-link-input").value = "";
  }
  document.getElementById("config-modal").classList.add("open");
};

window.submitConfigLink = async () => {
  const link     = document.getElementById("config-link-input").value.trim();
  const mockLink = (document.getElementById("mock-config-link-input")?.value || "").trim();
  if (!link && !mockLink) { toast("Please enter at least one config link", "error"); return; }
  const btn = document.getElementById("config-submit-btn");
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span> Saving...';
  try {
    let phase = "", batch = "", week = "";
    if (activeConfigId) {
      const c = allConfigs.find(c => c._id === activeConfigId);
      const hasMock = c?.mock_assessment === "required";
      // Only overwrite a field if the user actually typed something — preserve existing value otherwise
      const updates = {
        status:      "submitted",
        submittedBy: currentUserEmail,
        submittedAt: serverTimestamp()
      };
      if (link)              updates.config_link      = link;
      if (hasMock && mockLink) updates.mock_config_link = mockLink;
      if (hasMock && !mockLink && !c?.mock_config_link) updates.mock_config_link = "";
      // Track first-submission timestamps for SLA monitoring
      if (link && !c?.config_link)           updates.config_link_submitted_at      = serverTimestamp();
      if (hasMock && mockLink && !c?.mock_config_link) updates.mock_config_link_submitted_at = serverTimestamp();
      await updateDoc(doc(db, "configs", activeConfigId), updates);
      if (c) { Object.assign(c, updates); phase = c.phase || ""; batch = c.batch || ""; week = c.week || ""; }
    } else {
      const meta = window._pendingConfigMeta || {};
      phase = meta.phase || ""; batch = meta.batch || ""; week = meta.week || "";
      const newRef = await addDoc(collection(db, "configs"), {
        phase, batch, week,
        assessment_date:  meta.adate || "",
        mock_assessment:  meta.mockAssessment || "",
        config_link:      link,
        mock_config_link: meta.mockAssessment === "required" ? mockLink : "",
        status:           "submitted",
        submittedBy:      currentUserEmail,
        submittedAt:      serverTimestamp(),
        createdAt:        serverTimestamp()
      });
      allConfigs.push({ _id: newRef.id, phase, batch, week, assessment_date: meta.adate || "", config_link: link, mock_config_link: mockLink, status: "submitted" });
    }
    renderConfigsTable();
    closeModal("config-modal");
    toast("Config link(s) saved", "success");
    await createNotification("config", "submitted", "Config Updated",
      `Topin config provided for ${week}${phase ? " — " + phase : ""}${batch ? ", " + batch : ""}`);
    loadNotifCount();
  } catch (e) {
    toast("Error: " + e.message, "error");
  } finally {
    btn.disabled    = false;
    btn.textContent = "Save Links";
  }
};

window.exportConfigsCSV = () => {
  const rows = [["Phase", "Batch", "Week", "Assessment Date", "Start Time", "End Time", "Mock Assessment", "Mock Date", "Mock Start Time", "Mock End Time", "Config Link", "Status", "Updated"]];
  allConfigs.forEach(c => rows.push([
    c.phase || "", c.batch || "", c.week || "", c.assessment_date || "",
    c.assessment_start_time || "", c.assessment_end_time || "",
    c.mock_assessment || "", c.mock_assessment_date || "",
    c.mock_assessment_start_time || "", c.mock_assessment_end_time || "",
    c.config_link || "", c.status || "",
    c.submittedAt ? formatDate(c.submittedAt) : ""
  ]));
  if (rows.length === 1) { toast("No config data to export", "error"); return; }
  downloadCSV(rows, "configs_export.csv");
};

function configLinkCell(href) {
  if (!href) return `<span style="color:var(--muted);font-size:.78rem">—</span>`;
  return `<a href="${escHtml(href)}" target="_blank" rel="noopener" title="${escHtml(href)}"
    style="color:var(--primary);text-decoration:underline;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;max-width:190px;font-size:.78rem">${escHtml(href)}</a>`;
}

function configStatusBadge(c) {
  if (c.status === "published") return `<span class="badge badge-published">Live</span>`;
  const hasMain = !!c.config_link;
  const mockRequired = c.mock_assessment === "required";
  const hasMock = !!c.mock_config_link;
  if (!hasMain && !hasMock) return `<span class="badge badge-pending">Pending</span>`;
  if (mockRequired && hasMain && !hasMock) return `<span class="badge badge-mock-pending">Mock Link Missing</span>`;
  if (mockRequired && !hasMain && hasMock) return `<span class="badge badge-mock-pending">Main Link Missing</span>`;
  return `<span class="badge badge-approved">Ready</span>`;
}

// ── ASSESSMENTS ───────────────────────────────────────────────
let assessmentTab = "ready";

window.loadAssessments = async () => {
  setTbody("assessments-tbody", 8, "Loading...");
  try {
    const snap = await getDocs(query(collection(db, "configs"), orderBy("createdAt", "desc")));
    allConfigs = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    populateAssessmentFilters();
    renderAssessmentsTable();
  } catch (e) {
    setTbody("assessments-tbody", 8, "Error: " + e.message);
  }
};

function populateAssessmentFilters() {
  const phases  = [...new Set(allConfigs.map(c => c.phase).filter(Boolean))].sort();
  const batches = [...new Set(allConfigs.map(c => c.batch).filter(Boolean))].sort();
  const pSel = document.getElementById("assessment-phase-filter");
  const bSel = document.getElementById("assessment-batch-filter");
  if (pSel) {
    const cur = pSel.value;
    pSel.innerHTML = `<option value="">All Phases</option>` + phases.map(p => `<option${p===cur?" selected":""}>${escHtml(p)}</option>`).join("");
  }
  if (bSel) {
    const cur = bSel.value;
    bSel.innerHTML = `<option value="">All Batches</option>` + batches.map(b => `<option${b===cur?" selected":""}>${escHtml(b)}</option>`).join("");
  }
}

window.filterAssessments = () => renderAssessmentsTable();

window.switchAssessmentTab = (tab, btn) => {
  assessmentTab = tab;
  document.querySelectorAll("#assessment-tabs .tab").forEach(t => t.classList.remove("active"));
  if (btn) btn.classList.add("active");
  renderAssessmentsTable();
};

function renderAssessmentsTable() {
  const q     = (document.getElementById("assessment-search")?.value || "").toLowerCase();
  const phase = document.getElementById("assessment-phase-filter")?.value || "";
  const batch = document.getElementById("assessment-batch-filter")?.value || "";

  const filtered = allConfigs.filter(c => {
    const matchTab = assessmentTab === "all"
      || (assessmentTab === "ready"           && c.status === "submitted")
      || (assessmentTab === "published"       && c.status === "published")
      || (assessmentTab === "invites-pending" && c.status === "published" && !c.invites_sent)
      || (assessmentTab === "invites-sent"    && c.status === "published" && c.invites_sent);
    const matchQ     = !q     || [c.phase, c.batch, c.week].some(v => (v||"").toLowerCase().includes(q));
    const matchPhase = !phase || c.phase === phase;
    const matchBatch = !batch || c.batch === batch;
    return matchTab && matchQ && matchPhase && matchBatch;
  });

  // Update stats
  const ready          = allConfigs.filter(c => c.status === "submitted").length;
  const published      = allConfigs.filter(c => c.status === "published").length;
  const invitesPending = allConfigs.filter(c => c.status === "published" && !c.invites_sent).length;
  const invitesSent    = allConfigs.filter(c => c.status === "published" && c.invites_sent).length;
  const el = id => document.getElementById(id);
  if (el("asmnt-stat-ready"))           el("asmnt-stat-ready").textContent           = ready;
  if (el("asmnt-stat-published"))       el("asmnt-stat-published").textContent       = published;
  if (el("asmnt-stat-invites-pending")) el("asmnt-stat-invites-pending").textContent = invitesPending;
  if (el("asmnt-stat-invites-sent"))    el("asmnt-stat-invites-sent").textContent    = invitesSent;

  const tbody = document.getElementById("assessments-tbody");
  if (!filtered.length) {
    const msg = assessmentTab === "ready"           ? "No configs ready to publish yet. Content Team needs to submit config links first."
              : assessmentTab === "published"       ? "No assessments have been published yet."
              : assessmentTab === "invites-pending" ? "No published assessments with pending invites. All invites are sent!"
              : assessmentTab === "invites-sent"    ? "No assessments with invites sent yet."
              : "No assessment entries found.";
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><h3>Nothing here</h3><p>${msg}</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((c, i) => {
    const publishedInfo = c.published_at
      ? `<div style="font-size:.69rem;color:var(--muted);margin-bottom:4px">Published ${formatDate(c.published_at)}</div>` : "";
    const inviteChip = c.invites_sent
      ? `<span style="font-size:.7rem;background:#dcfce7;color:#15803d;border:1px solid #bbf7d0;border-radius:10px;padding:2px 8px;font-weight:600;white-space:nowrap">✓ Invites Sent</span>`
      : `<span style="font-size:.7rem;background:#fef3c7;color:#92400e;border:1px solid #fcd34d;border-radius:10px;padding:2px 8px;white-space:nowrap">Invites Pending</span>`;

    const actions = isGuest
      ? (c.status === "published"
          ? `${publishedInfo}${inviteChip}`
          : `<span style="font-size:.75rem;color:var(--muted)">${c.status === "submitted" ? "Ready to publish" : "—"}</span>`)
      : c.status === "submitted"
        ? `<div style="position:relative;display:inline-block">
            <button class="btn btn-primary btn-sm" onclick="togglePubDropdown('${c._id}')" style="display:flex;align-items:center;gap:8px">
              Publish
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div id="pub-dd-${c._id}" style="display:none;position:absolute;top:calc(100% + 6px);left:0;z-index:200;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.1);min-width:140px;overflow:hidden">
              <div style="font-size:.67rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;padding:8px 12px 4px">Type</div>
              <button onclick="publishAssessment('${c._id}','main');togglePubDropdown('${c._id}')" class="pub-dd-item">
                <span>Main</span><span style="font-size:.65rem;font-weight:700;background:#dbeafe;color:#1d4ed8;border-radius:4px;padding:1px 6px">MAIN</span>
              </button>
              ${c.mock_assessment === "required" ? `
              <button onclick="publishAssessment('${c._id}','mock');togglePubDropdown('${c._id}')" class="pub-dd-item">
                <span>Mock</span><span style="font-size:.65rem;font-weight:700;background:#ede9fe;color:#7c3aed;border-radius:4px;padding:1px 6px">MOCK</span>
              </button>
              <div style="height:1px;background:#f1f5f9;margin:2px 0"></div>
              <button onclick="publishAssessment('${c._id}','both');togglePubDropdown('${c._id}')" class="pub-dd-item">
                <span>Both</span><span style="font-size:.65rem;font-weight:700;background:#fef3c7;color:#92400e;border-radius:4px;padding:1px 6px">BOTH</span>
              </button>` : ""}
            </div>
          </div>`
        : c.status === "published"
        ? `<div style="display:flex;flex-direction:column;gap:6px;align-items:flex-start">
            ${publishedInfo}
            ${c.invites_sent
              ? inviteChip
              : `<div style="display:flex;gap:5px;flex-wrap:wrap">
                  <button class="btn btn-primary btn-sm" onclick="inviteStudents('${c._id}')" style="font-size:.72rem;padding:4px 9px">✉ Invite Students</button>
                  <button class="btn btn-outline btn-sm" onclick="markInvitesSent('${c._id}')" style="font-size:.72rem;padding:4px 9px" title="Mark as sent without calling API">Mark Sent</button>
                </div>`}
            <button class="btn btn-outline btn-sm" onclick="unpublishAssessment('${c._id}')" style="font-size:.73rem;padding:4px 10px">Unpublish</button>
          </div>`
        : "—";

    return `<tr>
      <td>${i + 1}</td>
      <td>${pbwCell(c.phase, c.batch, c.week)}</td>
      <td>${fmtMockAssessment(c.mock_assessment, c.assessment_date, c.assessment_start_time, c.assessment_end_time, c.mock_assessment_date, c.mock_assessment_start_time, c.mock_assessment_end_time)}</td>
      <td style="max-width:200px">${configLinkCell(c.config_link)}</td>
      <td style="max-width:200px">${c.mock_assessment === "required" ? configLinkCell(c.mock_config_link) : '<span style="color:var(--muted);font-size:.78rem">—</span>'}</td>
      <td>${configStatusBadge(c)}</td>
      <td style="white-space:nowrap">${actions}</td>
    </tr>`;
  }).join("");
}

window.togglePubDropdown = (id) => {
  const dd = document.getElementById(`pub-dd-${id}`);
  if (!dd) return;
  const isOpen = dd.style.display !== "none";
  // Close all other dropdowns first
  document.querySelectorAll('[id^="pub-dd-"]').forEach(el => el.style.display = "none");
  dd.style.display = isOpen ? "none" : "block";
  if (!isOpen) {
    const close = (e) => { if (!dd.contains(e.target)) { dd.style.display = "none"; document.removeEventListener("click", close); } };
    setTimeout(() => document.addEventListener("click", close), 0);
  }
};

window.publishAssessment = (id, target = "main") => {
  const c = allConfigs.find(x => x._id === id);
  if (!c) return;

  const isMock = target === "mock";
  const isBoth = target === "both";
  const isMain = target === "main";

  const targetLabel = isMock ? "Mock Assessment" : isBoth ? "Mock + Main Assessment" : "Main Assessment";
  const tagPill = `<span style="background:${isMock ? "#ede9fe" : isBoth ? "#fef3c7" : "#dbeafe"};color:${isMock ? "#7c3aed" : isBoth ? "#92400e" : "#1d4ed8"};border-radius:20px;font-size:.72rem;font-weight:700;padding:2px 10px;display:inline-block;margin-left:8px">${targetLabel}</span>`;

  const buildChecks = (mock) => [
    { label: mock ? "Mock Config Link"    : "Main Config Link",   ok: !!(mock ? c.mock_config_link : c.config_link),          value: (mock ? c.mock_config_link : c.config_link) || "—" },
    { label: mock ? "Mock Date"           : "Assessment Date",    ok: !!(mock ? c.mock_assessment_date : c.assessment_date),  value: formatDate((mock ? c.mock_assessment_date : c.assessment_date) || "") || "—" },
    { label: mock ? "Mock Start Time"     : "Start Time",         ok: !!(mock ? c.mock_assessment_start_time : c.assessment_start_time), value: (mock ? c.mock_assessment_start_time : c.assessment_start_time) || "—" },
    { label: mock ? "Mock End Time"       : "End Time",           ok: !!(mock ? c.mock_assessment_end_time   : c.assessment_end_time),   value: (mock ? c.mock_assessment_end_time   : c.assessment_end_time)   || "—" },
  ];

  const renderChecks = (checks) => checks.map(ch => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
      <span style="width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.72rem;font-weight:700;flex-shrink:0;background:${ch.ok ? "#dcfce7" : "#fee2e2"};color:${ch.ok ? "#15803d" : "#dc2626"}">${ch.ok ? "✓" : "✗"}</span>
      <div><div style="font-size:.82rem;font-weight:600;color:var(--text)">${ch.label}</div>
      <div style="font-size:.73rem;color:var(--muted)">${escHtml(String(ch.value))}</div></div>
    </div>`).join("");

  let bodyHTML = `<p style="color:var(--muted);font-size:.84rem;margin-bottom:12px">Marking <strong>${escHtml(c.week)}${c.phase ? " — " + escHtml(c.phase) : ""}${c.batch ? ", " + escHtml(c.batch) : ""}</strong> as published. ${tagPill}</p>`;

  if (isMain || isBoth) {
    const checks = buildChecks(false);
    const allOk  = checks.every(ch => ch.ok);
    bodyHTML += `${isBoth ? `<div style="font-size:.78rem;font-weight:700;color:#1d4ed8;margin:10px 0 4px">Main Assessment</div>` : ""}
      <div style="background:#f8fafc;border-radius:8px;padding:0 12px;margin-bottom:${allOk ? "0" : "10px"}">${renderChecks(checks)}</div>
      ${!allOk ? `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;padding:8px 12px;font-size:.78rem;color:#92400e;margin-bottom:10px">⚠ Some main assessment fields are missing.</div>` : ""}`;
  }
  if (isMock || isBoth) {
    const checks = buildChecks(true);
    const allOk  = checks.every(ch => ch.ok);
    bodyHTML += `<div style="font-size:.78rem;font-weight:700;color:#7c3aed;margin:10px 0 4px">Mock Assessment</div>
      <div style="background:#f8fafc;border-radius:8px;padding:0 12px;margin-bottom:${allOk ? "0" : "10px"}">${renderChecks(checks)}</div>
      ${!allOk ? `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;padding:8px 12px;font-size:.78rem;color:#92400e">⚠ Some mock assessment fields are missing.</div>` : ""}`;
  }

  document.getElementById("publish-modal-body").innerHTML = bodyHTML;
  document.getElementById("publish-confirm-btn").onclick = () => confirmPublishAssessment(id, target);
  document.getElementById("publish-modal").classList.add("open");
};

window.confirmPublishAssessment = async (id, target = "main") => {
  closeModal("publish-modal");
  const c = allConfigs.find(x => x._id === id);
  if (!c) return;

  const isMock = target === "mock";
  const isBoth = target === "both";

  if ((target === "main" || isBoth) && !c.config_link)  { toast("Cannot publish — Main config link is missing", "error"); return; }
  if ((isMock || isBoth) && !c.mock_config_link)         { toast("Cannot publish — Mock config link is missing", "error"); return; }

  // Always publish via Topin automation server
  const serverUrl = localStorage.getItem("topinServerUrl") || "http://localhost:3001";
  try {
    const h = await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (!h.ok) throw new Error("unhealthy");
  } catch {
    toast("Topin automation server is not running. Open server/start.ps1 to start it, then try again.", "error");
    return;
  }

  await publishToTopin(id, target);
};

window.markInvitesSent = async (id) => {
  const c = allConfigs.find(x => x._id === id);
  if (!c) return;
  if (!confirm(`Mark invites as sent for ${c.week}${c.phase ? " — " + c.phase : ""}?\nThis confirms students have been notified on Topin.`)) return;
  try {
    await updateDoc(doc(db, "configs", id), {
      invites_sent: true,
      invites_sent_at: serverTimestamp(),
      invites_sent_by: currentUserEmail
    });
    const idx = allConfigs.findIndex(x => x._id === id);
    if (idx >= 0) Object.assign(allConfigs[idx], { invites_sent: true, invites_sent_at: new Date() });
    renderAssessmentsTable();
    toast("Invites marked as sent ✓", "success");
  } catch (e) { toast("Error: " + e.message, "error"); }
};

window.unpublishAssessment = async (id) => {
  const c = allConfigs.find(x => x._id === id);
  if (!c) return;
  if (!confirm(`Unpublish assessment for ${escHtml(c.week)}${c.phase ? " — " + c.phase : ""}? This will move it back to "Ready to Publish".`)) return;
  try {
    await updateDoc(doc(db, "configs", id), { status: "submitted", published_at: null, published_by: null, invites_sent: false, invites_sent_at: null });
    const idx = allConfigs.findIndex(x => x._id === id);
    if (idx >= 0) Object.assign(allConfigs[idx], { status: "submitted", published_at: null, invites_sent: false });
    renderAssessmentsTable();
    toast("Assessment unpublished", "success");
  } catch (e) { toast("Error: " + e.message, "error"); }
};

// ── CONFIG INPUT TABS ─────────────────────────────────────────
window.switchConfigInputTab = (tab, btn) => {
  document.querySelectorAll("#configs-input-tabs .tab").forEach(t => t.classList.remove("active"));
  if (btn) btn.classList.add("active");
  document.getElementById("config-tab-manual").style.display = tab === "manual" ? "" : "none";
  document.getElementById("config-tab-csv").style.display    = tab === "csv"    ? "" : "none";
};

window.addConfigManually = async () => {
  const phase    = (document.getElementById("cf-phase")?.value  || "").trim();
  const domain   = (document.getElementById("cf-domain")?.value || "").trim();
  const batchN   = (document.getElementById("cf-batch")?.value  || "").trim();
  const batch    = batchN ? `B${batchN}` : "";
  const weekN    = (document.getElementById("cf-week")?.value   || "").trim();
  const week     = weekN  ? `W${weekN}`  : "";
  const adate    = document.getElementById("cf-adate").value;
  const link     = document.getElementById("cf-link").value.trim();
  const mockLink = document.getElementById("cf-mock-link").value.trim();
  if (!phase || !week) { toast("Phase and Week are required", "error"); return; }
  if (!link && !mockLink) { toast("Please enter at least one config link (Main or Mock)", "error"); return; }
  try {
    const snap = await getDocs(query(
      collection(db, "configs"),
      where("phase", "==", phase),
      where("batch", "==", batch),
      where("week",  "==", week)
    ));
    if (!snap.empty) {
      const upd = { status: "submitted", assessment_date: adate || snap.docs[0].data().assessment_date || "", submittedBy: currentUserEmail, submittedAt: serverTimestamp() };
      if (link)     upd.config_link      = link;
      if (mockLink) upd.mock_config_link = mockLink;
      await updateDoc(doc(db, "configs", snap.docs[0].id), upd);
      toast("Config updated", "success");
    } else {
      await addDoc(collection(db, "configs"), {
        phase, batch, week,
        ...(domain ? { domain } : {}),
        assessment_date: adate || "",
        config_link: link, mock_config_link: mockLink,
        status: "submitted",
        submittedBy: currentUserEmail, submittedAt: serverTimestamp(),
        createdAt: serverTimestamp()
      });
      toast("Config saved", "success");
    }
    await createNotification("config", "submitted", "Config Updated",
      `Topin config provided for ${week}${phase ? " — " + phase : ""}${batch ? ", " + batch : ""}`);
    ["cf-phase","cf-batch","cf-week","cf-adate","cf-link","cf-mock-link"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    const cfDomRow = document.getElementById("cf-domain-row");
    if (cfDomRow) cfDomRow.style.display = "none";
    loadConfigs();
  } catch (e) {
    toast("Error: " + e.message, "error");
  }
};

// ── CONFIG CSV ────────────────────────────────────────────────
window.handleConfigFileDrop = (e) => {
  e.preventDefault();
  document.getElementById("config-upload-zone").classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file && file.name.endsWith(".csv")) parseConfigCSV(file);
  else toast("Please drop a .csv file", "error");
};

window.handleConfigFileSelect = (e) => {
  const file = e.target.files[0];
  if (file) parseConfigCSV(file);
  e.target.value = "";
};

function parseConfigCSV(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const lines = e.target.result.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) { toast("Empty CSV file", "error"); return; }
    const headers = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/\s+/g, "_"));
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(",").map(v => v.trim().replace(/^"|"$/g, ""));
      const row = {};
      headers.forEach((h, j) => { row[h] = vals[j] || ""; });
      if (row.phase && row.week && row.config_link) rows.push(row);
    }
    const requiredCols = ["phase","batch","week","config_link","assessment_date"];
    const missingCols = requiredCols.filter(r => !headers.includes(r));
    if (missingCols.length) { toast(`CSV missing columns: ${missingCols.join(", ")}`, "error"); return; }
    if (!rows.length) { toast("No valid rows found. Check required columns: phase, batch, week, config_link, assessment_date", "error"); return; }
    configCsvRows = rows;
    renderConfigCsvPreview();
  };
  reader.readAsText(file);
}

function renderConfigCsvPreview() {
  const preview = document.getElementById("config-csv-preview");
  const tableDiv = document.getElementById("config-preview-table");
  const count = document.getElementById("config-upload-count");
  preview.style.display = "";
  count.textContent = `${configCsvRows.length} row${configCsvRows.length !== 1 ? "s" : ""} ready to upload`;
  const heads = ["phase", "batch", "week", "assessment_date", "config_link"];
  tableDiv.innerHTML = `<div class="table-wrapper" style="max-height:260px;overflow-y:auto"><table>
    <thead><tr>${heads.map(h => `<th>${h}</th>`).join("")}</tr></thead>
    <tbody>${configCsvRows.slice(0, 20).map(r => `<tr>${heads.map(h => `<td>${escHtml(r[h] || "")}</td>`).join("")}</tr>`).join("")}
    ${configCsvRows.length > 20 ? `<tr><td colspan="${heads.length}" style="text-align:center;color:var(--muted);font-size:.82rem">… and ${configCsvRows.length - 20} more rows</td></tr>` : ""}
    </tbody></table></div>`;
}

window.uploadConfigsCSV = async () => {
  if (!configCsvRows.length) { toast("No rows to upload", "error"); return; }
  const btn = document.getElementById("config-upload-btn");
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Uploading...';
  let created = 0, updated = 0;
  const submittedLabels = [];
  try {
    for (const row of configCsvRows) {
      const phase = row.phase || "", batch = row.batch || "", week = row.week || "";
      const snap = await getDocs(query(
        collection(db, "configs"),
        where("phase", "==", phase), where("batch", "==", batch), where("week", "==", week)
      ));
      if (!snap.empty) {
        await updateDoc(doc(db, "configs", snap.docs[0].id), {
          config_link: row.config_link, status: "submitted",
          assessment_date: row.assessment_date || snap.docs[0].data().assessment_date || "",
          submittedBy: currentUserEmail, submittedAt: serverTimestamp()
        });
        updated++;
      } else {
        await addDoc(collection(db, "configs"), {
          phase, batch, week,
          assessment_date: row.assessment_date || "",
          config_link: row.config_link, status: "submitted",
          submittedBy: currentUserEmail, submittedAt: serverTimestamp(),
          createdAt: serverTimestamp()
        });
        created++;
      }
      submittedLabels.push(`${week} (${phase}${batch ? ", " + batch : ""})`);
    }
    if (submittedLabels.length) {
      await createNotification("config", "submitted", "Config Updated",
        `Topin configs provided for: ${submittedLabels.join("; ")}`);
    }
    toast(`Uploaded: ${created} new, ${updated} updated`, "success");
    clearConfigsPreview();
    loadConfigs();
  } catch (e) {
    toast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Upload to Firebase";
  }
};

window.clearConfigsPreview = () => {
  configCsvRows = [];
  document.getElementById("config-csv-preview").style.display = "none";
  document.getElementById("config-preview-table").innerHTML = "";
  document.getElementById("config-upload-count").textContent = "";
};

window.downloadConfigTemplate = () => {
  const rows = [
    ["phase", "batch", "week", "assessment_date", "config_link"],
    ["Phase 1", "Batch A", "Week 1", "2026-06-16", "https://example.com/config"]
  ];
  downloadCSV(rows, "config_template.csv");
};

function pbwVal(prefix, id) {
  const v = (document.getElementById(id)?.value || "").trim();
  return v ? prefix + v : "";
}
function setPbwInput(id, storedVal) {
  const el = document.getElementById(id);
  if (el) el.value = (storedVal || "").replace(/^[A-Za-z]/, "");
}

window.onPhaseSelectChange = (phaseId, domainRowId) => {
  const phase = document.getElementById(phaseId)?.value || "";
  const phN   = parseInt(phase.replace(/\D/g, "")) || 0;
  const row   = document.getElementById(domainRowId);
  if (row) row.style.display = (phN === 3 || phN === 4) ? "" : "none";
};

function pbwCell(phase, batch, week) {
  const label = [phase, batch, week].filter(Boolean).join("-");
  return label ? `<span class="cell-week">${escHtml(label)}</span>` : "<span style='color:var(--muted)'>—</span>";
}

// ── NOTIFICATIONS ─────────────────────────────────────────────
function fmtTimeRange(start, end) {
  if (!start && !end) return "—";
  if (start && end) return `${start} – ${end}`;
  return start || end;
}

window.toggleMockFields = (selectEl, fieldsId) => {
  const fields = document.getElementById(fieldsId);
  const show = selectEl.value === "required";
  fields.style.display = show ? "block" : "none";
  if (!show) fields.querySelectorAll("input").forEach(i => { i.value = ""; });
};

function fmtMockAssessment(val, mainDate, mainStart, mainEnd, mockDate, mockStart, mockEnd) {
  const sd = d => {
    if (!d) return "";
    try { return new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }); }
    catch { return d; }
  };
  const st = (s, e) => s && e ? `${s} – ${e}` : (s || e || "");
  const popupRow = (badgeCls, label, info) =>
    `<div class="assess-popup-row">
      <span class="ap-popup-badge ${badgeCls}">${label}</span>
      <span class="ap-popup-info">${info || "—"}</span>
    </div>`;

  const mainInfo = [sd(mainDate), st(mainStart, mainEnd)].filter(Boolean).join(" · ");
  let pills = `<span class="ap ap-main">Main</span>`;
  let rows  = popupRow("ap-main", "Main", mainInfo);

  if (val === "required") {
    const mockInfo = [sd(mockDate), st(mockStart, mockEnd)].filter(Boolean).join(" · ");
    pills += `<span class="ap ap-mock">Mock ✓</span>`;
    rows  += popupRow("ap-mock", "Mock ✓", mockInfo);
  } else if (val === "not_required") {
    pills += `<span class="ap ap-no-mock">Mock ✗</span>`;
    rows  += popupRow("ap-no-mock", "Mock ✗", "Not required");
  }

  return `<div class="assess-wrap">
    <div class="assess-pills" onclick="toggleAssessPopup(this)">${pills}<span class="ap-caret">&#9662;</span></div>
    <div class="assess-popup">${rows}</div>
  </div>`;
}

window.toggleAssessPopup = pillsEl => {
  const popup = pillsEl.nextElementSibling;
  const isOpen = popup.style.display === "block";
  document.querySelectorAll(".assess-popup").forEach(p => { p.style.display = "none"; });
  document.querySelectorAll(".assess-pills").forEach(p => p.classList.remove("open"));
  if (!isOpen) { popup.style.display = "block"; pillsEl.classList.add("open"); }
};
document.addEventListener("click", e => {
  if (!e.target.closest(".assess-wrap")) {
    document.querySelectorAll(".assess-popup").forEach(p => { p.style.display = "none"; });
    document.querySelectorAll(".assess-pills").forEach(p => p.classList.remove("open"));
  }
});

function fmtDate(str) {
  if (!str) return "—";
  try {
    const d = new Date(str + "T00:00:00");
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return str; }
}

async function createNotification(type, status, title, message) {
  const targetMap = {
    "registration":       ["Admin"],
    "student_data":       ["On Ground Team", "Assessment Ops Team", "Content Team"],
    "syllabus":           ["Content Team", "Assessment Ops Team", "On Ground Team"],
    "assessment":         ["On Ground Team", "Content Team", "Assessment Ops Team"],
    "config_request":     ["Content Team"],
    "config":             ["Assessment Ops Team"],
    "sla":                ["Admin", "On Ground Team", "Content Team", "Assessment Ops Team"],
    "assignment_request": ["Content Team", "Admin"],
    "assignment_links":   ["On Ground Team", "Assessment Ops Team", "Instructor", "Admin"],
  };
  try {
    await addDoc(collection(db, "notifications"), {
      type, status, title, message,
      targetTeams: targetMap[type] || [],
      createdBy: currentUserEmail,
      readBy: [],
      createdAt: serverTimestamp()
    });
  } catch (e) {
    console.error("Notification error:", e);
  }
}

async function loadNotifCount() {
  try {
    const snap = await getDocs(query(collection(db, "notifications"), orderBy("createdAt", "desc")));
    const all  = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    _allNotifs = currentUserTeam === "admin"
      ? all
      : all.filter(n => n.targetTeams && n.targetTeams.includes(currentUserTeam));
    const unread = _allNotifs.filter(n => !(n.readBy || []).includes(currentUserEmail));
    const badge  = document.getElementById("notif-badge");
    if (badge) {
      badge.textContent   = unread.length > 99 ? "99+" : String(unread.length);
      badge.style.display = unread.length > 0 ? "flex" : "none";
    }
  } catch (e) {
    console.error("Notif load error:", e);
  }
}

window.toggleNotifPanel = async () => {
  const panel = document.getElementById("notif-panel");
  if (panel.classList.contains("open")) { closeNotifPanel(); return; }
  await loadNotifCount();
  renderNotifList();
  panel.classList.add("open");
  document.getElementById("notif-overlay").classList.add("open");
};

window.closeNotifPanel = () => {
  document.getElementById("notif-panel").classList.remove("open");
  document.getElementById("notif-overlay").classList.remove("open");
};

function renderNotifList() {
  const list = document.getElementById("notif-list");
  if (!_allNotifs.length) {
    list.innerHTML = `<div class="empty-state" style="padding:40px 20px"><h3>No notifications</h3><p>Activity will appear here as data is updated.</p></div>`;
    return;
  }
  list.innerHTML = _allNotifs.slice(0, 60).map(n => {
    const isUnread = !(n.readBy || []).includes(currentUserEmail);
    const dotCls   = n.type === "registration"   ? "notif-dot-pending"
                   : n.type === "assessment"      ? "notif-dot-assessment"
                   : n.type === "config_request"  ? "notif-dot-config-req"
                   : n.type === "config"          ? "notif-dot-config"
                   : n.status === "pending"       ? "notif-dot-pending"
                   : n.type === "syllabus"        ? "notif-dot-syllabus"
                   : "notif-dot-student";
    const badge    = n.type === "registration"  ? `<span class="badge badge-pending"  style="font-size:.65rem">New Request</span>`
                   : n.status === "added"       ? `<span class="badge badge-approved" style="font-size:.65rem">Added</span>`
                   : n.status === "updated"     ? `<span class="badge badge-approved" style="font-size:.65rem">Updated</span>`
                   : n.status === "pending"     ? `<span class="badge badge-pending"  style="font-size:.65rem">Pending</span>`
                   : n.status === "scheduled"   ? `<span class="badge" style="font-size:.65rem;background:#7c3aed;color:#fff">Scheduled</span>`
                   : n.status === "submitted"   ? `<span class="badge" style="font-size:.65rem;background:#0284c7;color:#fff">Submitted</span>`
                   : "";
    const actionHint = notifActionHint(n.type);
    return `
      <div class="notif-item${isUnread ? " unread" : ""}" style="cursor:pointer" onclick="handleNotifClick('${n._id}','${n.type}')">
        <div class="notif-dot ${dotCls}"></div>
        <div class="notif-item-body">
          <div class="notif-item-title">${escHtml(n.title || "")} ${badge}</div>
          <div class="notif-item-detail">${escHtml(n.message || "")}</div>
          <div class="notif-item-time">${formatDate(n.createdAt)}${actionHint ? ` &nbsp;·&nbsp; <span style="color:var(--primary);font-size:.75rem">${actionHint} →</span>` : ""}</div>
        </div>
      </div>`;
  }).join("");
}

function notifActionHint(type) {
  return type === "registration"   ? "Go to Teams → Pending"
       : type === "sla"            ? "Go to Assessment Details → Breaches"
       : type === "student_data"   ? "Go to Student Data"
       : type === "assessment"     ? "Go to Student Data"
       : type === "syllabus"       ? "Go to Syllabus"
       : type === "config_request" ? "Go to Topin Configs → Pending"
       : type === "config"         ? "Go to Topin Configs"
       : "";
}

window.handleNotifClick = async (id, type) => {
  const n = _allNotifs.find(n => n._id === id);
  if (n && !(n.readBy || []).includes(currentUserEmail)) {
    try {
      await updateDoc(doc(db, "notifications", id), {
        readBy: [...(n.readBy || []), currentUserEmail]
      });
      if (!n.readBy) n.readBy = [];
      n.readBy.push(currentUserEmail);
    } catch (_) {}
  }
  closeNotifPanel();
  await loadNotifCount();

  if (type === "registration") {
    switchPage("teams");
    approvalTab = "pending";
    activateTabByLabel("#teams-tabs", "Pending");
    renderApprovalsTable();
  } else if (type === "student_data" || type === "assessment") {
    switchPage("students");
  } else if (type === "syllabus") {
    switchPage("syllabus");
  } else if (type === "config_request") {
    configTab = "pending";
    switchPage("configs");
    activateTabByLabel("#configs-tabs", "Pending");
  } else if (type === "config") {
    configTab = "submitted";
    switchPage("configs");
    activateTabByLabel("#configs-tabs", "Submitted");
  } else if (type === "sla") {
    switchPage("assessment-details");
    setAdTab("breached");
  }
};

function activateTabByLabel(selector, label) {
  document.querySelectorAll(`${selector} .tab`).forEach(t => {
    t.classList.toggle("active", t.textContent.trim() === label);
  });
}

window.markAllNotifRead = async () => {
  const unread = _allNotifs.filter(n => !(n.readBy || []).includes(currentUserEmail));
  if (!unread.length) { toast("All notifications already read", "info"); return; }
  try {
    const wbatch = writeBatch(db);
    unread.forEach(n => {
      wbatch.update(doc(db, "notifications", n._id), { readBy: [...(n.readBy || []), currentUserEmail] });
    });
    await wbatch.commit();
    unread.forEach(n => { if (!n.readBy) n.readBy = []; n.readBy.push(currentUserEmail); });
    renderNotifList();
    const badge = document.getElementById("notif-badge");
    if (badge) badge.style.display = "none";
    toast("All notifications marked as read", "success");
  } catch (e) {
    toast("Error: " + e.message, "error");
  }
};

// ── HELPERS ───────────────────────────────────────────────────
function setTbody(id, cols, msg) {
  document.getElementById(id).innerHTML =
    `<tr><td colspan="${cols}"><div class="loading-overlay">${msg}</div></td></tr>`;
}

function formatDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts.seconds * 1000);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function statusBadge(s) {
  const map = {
    pending:  `<span class="badge badge-pending">Pending</span>`,
    approved: `<span class="badge badge-approved">Approved</span>`,
    rejected: `<span class="badge badge-rejected">Rejected</span>`,
    removed:  `<span class="badge badge-rejected">Rejected</span>`,
  };
  return map[s] || `<span class="badge">${s || "—"}</span>`;
}

function teamBadge(team) {
  if (!team) return "—";
  const cls = team === "Admin"            ? "team-admin"
            : team.includes("Content")    ? "team-content"
            : team.includes("Ops")        ? "team-ops"
            : "team-ground";
  return `<span class="team-tag ${cls}">${team}</span>`;
}

function escHtml(s) { return (s || "").replace(/'/g, "\\'"); }

function downloadCSV(rows, filename) {
  const csv  = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

function toast(msg, type = "info") {
  const el = Object.assign(document.createElement("div"), {
    className:   `toast toast-${type}`,
    textContent: msg
  });
  document.getElementById("toast-container").appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

document.querySelectorAll(".modal-backdrop").forEach(bd =>
  bd.addEventListener("click", e => { if (e.target === bd) bd.classList.remove("open"); })
);

document.getElementById("login-password").addEventListener("keydown", e => {
  if (e.key === "Enter") window.handleLogin();
});

// Seed one empty subject row so the form is ready to use
window.addSubjectRow();

// ── DATE RANGE PICKERS (Flatpickr) ───────────────────────────
const fpCfg = (onRange) => ({
  mode: "range",
  dateFormat: "d M Y",
  altInput: false,
  showMonths: 1,
  onChange(dates) {
    const fmt = d => d.toISOString().split("T")[0];
    onRange(dates[0] ? fmt(dates[0]) : "", dates[1] ? fmt(dates[1]) : "");
  }
});

window._fpStudent  = flatpickr("#student-date-range",  fpCfg((from, to) => { studentDateFrom  = from; studentDateTo   = to; filterStudents();  }));
window._fpSyllabus = flatpickr("#syllabus-date-range", fpCfg((from, to) => { syllabusDateFrom = from; syllabusDateTo  = to; filterSyllabus();  }));
window._fpConfig   = flatpickr("#config-date-range",   fpCfg((from, to) => { configDateFrom   = from; configDateTo    = to; filterConfigs();   }));

// ══════════════════════════════════════════════════════════════
// ASSESSMENT TITLE & TAG GENERATION
// ══════════════════════════════════════════════════════════════

function generateAssessmentInfo(phase, batch, week, domain) {
  const phN = parseInt((phase || "").replace(/[^0-9]/g, "")) || 1;
  const bN  = (batch || "").replace(/[^0-9]/g, "");
  const wN  = (week  || "").replace(/[^0-9]/g, "");
  const sfx = [bN ? `B${bN}` : "", wN ? `W${wN}` : ""].filter(Boolean).join("_");
  const wLabel = wN || "?";

  if (phN === 2) {
    return {
      mockTitle:   `Benchmarking | Mock Assessment | Week ${wLabel}`,
      mainTitle:   `Benchmarking | Main Assessment | Week ${wLabel}`,
      mockTag:     `IO26BM_INTENSIVE_OFFLINE_MOCK_ASSESSMENT${sfx ? "_"+sfx : ""}`,
      mainTag:     `IO26BM_INTENSIVE_OFFLINE_MAIN_ASSESSMENT${sfx ? "_"+sfx : ""}`,
      mockPrefix:  "IO26BM_INTENSIVE_OFFLINE_MOCK_ASSESSMENT",
      mainPrefix:  "IO26BM_INTENSIVE_OFFLINE_MAIN_ASSESSMENT",
      needsDomain: false,
    };
  }
  if (phN === 3) {
    const dom      = (domain || "Python").trim();
    const domUpper = dom.toUpperCase();
    const domTitle = dom.charAt(0).toUpperCase() + dom.slice(1).toLowerCase();
    return {
      mockTitle:   `${domTitle} Weekly Skill Mock Assessment ${wLabel}`,
      mainTitle:   `${domTitle} Weekly Skill Main Assessment ${wLabel}`,
      mockTag:     `IO26_P3_INTENSIVE_OFFLINE_WEEKLY_MOCK_ASSESSMENT_${domUpper}${sfx ? "_"+sfx : ""}`,
      mainTag:     `IO26_P3_INTENSIVE_OFFLINE_WEEKLY_MAIN_ASSESSMENT_${domUpper}${sfx ? "_"+sfx : ""}`,
      mockPrefix:  `IO26_P3_INTENSIVE_OFFLINE_WEEKLY_MOCK_ASSESSMENT_${domUpper}`,
      mainPrefix:  `IO26_P3_INTENSIVE_OFFLINE_WEEKLY_MAIN_ASSESSMENT_${domUpper}`,
      needsDomain: true,
      domain:      domTitle,
    };
  }
  // Phase 1 (and 4/5/6 default) → weekly format
  return {
    mockTitle:   `Mock Assessment Week-${wLabel}`,
    mainTitle:   `Weekly Skill Assessment-${wLabel}`,
    mockTag:     `IO26_INTENSIVE_OFFLINE_WEEKLY_MOCK_ASSESSMENT${sfx ? "_"+sfx : ""}`,
    mainTag:     `IO26_INTENSIVE_OFFLINE_WEEKLY_MAIN_ASSESSMENT${sfx ? "_"+sfx : ""}`,
    mockPrefix:  "IO26_INTENSIVE_OFFLINE_WEEKLY_MOCK_ASSESSMENT",
    mainPrefix:  "IO26_INTENSIVE_OFFLINE_WEEKLY_MAIN_ASSESSMENT",
    needsDomain: false,
  };
}

function buildADDetailPanelHTML(c) {
  const info   = generateAssessmentInfo(c.phase, c.batch, c.week, c.domain);
  const hasMock = c.mock_assessment === "required";
  const id     = c._id;

  // Safe escape for onclick string args (no HTML entities in titles/tags)
  const esc1 = s => (s || "").replace(/'/g, "\\'");

  const domainRow = info.needsDomain ? `
    <div class="ad-dp-domain">
      <span class="ad-dp-domain-lbl">Domain</span>
      <div class="ad-dp-domain-btns">
        <button class="btn btn-sm ${(c.domain||"Python")==="Python" ? "btn-primary" : "btn-outline"}"
          onclick="saveConfigDomain('${id}','Python')">Python</button>
        <button class="btn btn-sm ${(c.domain||"")==="Java" ? "btn-primary" : "btn-outline"}"
          onclick="saveConfigDomain('${id}','Java')">Java</button>
      </div>
    </div>` : "";

  const phE = escHtml(c.phase || "");
  const baE = escHtml(c.batch || "");
  const wkE = escHtml(c.week  || "");

  function assessBlock(typeLabel, title, tag) {
    return `<div class="ad-dp-block">
      <div class="ad-dp-block-head">${typeLabel}</div>
      <div class="ad-dp-row">
        <span class="ad-dp-label">Title</span>
        <span class="ad-dp-value">${title}</span>
        <button class="btn btn-outline btn-sm" onclick="copyText('${esc1(title)}')">Copy</button>
      </div>
      <div class="ad-dp-row">
        <span class="ad-dp-label">Tag</span>
        <code class="ad-dp-tag">${tag}</code>
        <button class="btn btn-outline btn-sm" onclick="copyText('${esc1(tag)}')">Copy</button>
      </div>
    </div>`;
  }

  const navSection = `<div class="ad-dp-nav">
    <span class="ad-dp-nav-lbl">Navigate to</span>
    <button class="btn btn-outline btn-sm" onclick="goToSyllabusFiltered('${phE}','${baE}','${wkE}')">Syllabus</button>
    <button class="btn btn-outline btn-sm" onclick="goToConfigsFiltered('${phE}','${baE}','${wkE}')">Config</button>
    <button class="btn btn-outline btn-sm" onclick="goToStudentsFiltered('${phE}','${baE}','${wkE}')">Students</button>
  </div>`;

  return `<div class="ad-detail-panel">
    ${domainRow}
    <div class="ad-dp-blocks">
      ${hasMock ? assessBlock("Mock Assessment", info.mockTitle, info.mockTag) : ""}
      ${assessBlock("Main Assessment", info.mainTitle, info.mainTag)}
    </div>
    ${navSection}
  </div>`;
}

window.toggleADRow = (id) => {
  const row = document.getElementById(`ad-detail-${id}`);
  const btn = document.getElementById(`ad-toggle-btn-${id}`);
  if (!row) return;
  if (adExpandedRows.has(id)) {
    adExpandedRows.delete(id);
    row.style.display = "none";
    if (btn) btn.innerHTML = "▼ View Details";
  } else {
    adExpandedRows.add(id);
    row.style.display = "";
    if (btn) btn.innerHTML = "▲ Collapse";
  }
};

window.saveConfigDomain = async (id, domain) => {
  try {
    await updateDoc(doc(db, "configs", id), { domain });
    const c = allConfigs.find(x => x._id === id);
    if (c) c.domain = domain;
    const panelEl = document.getElementById(`ad-panel-${id}`);
    if (panelEl && c) panelEl.innerHTML = buildADDetailPanelHTML(c);
    toast(`Domain set to ${domain}`, "success");
  } catch (e) {
    toast("Error: " + e.message, "error");
  }
};

window.copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied!", "success");
  } catch (_) {
    try {
      const el = Object.assign(document.createElement("textarea"),
        { value: text, style: "position:fixed;top:0;left:0;opacity:0;pointer-events:none" });
      document.body.appendChild(el);
      el.focus(); el.select();
      document.execCommand("copy");
      el.remove();
      toast("Copied!", "success");
    } catch (e2) {
      toast("Copy failed — select and copy manually", "error");
    }
  }
};

// ══════════════════════════════════════════════════════════════
// SLA ENGINE
// ══════════════════════════════════════════════════════════════

function getPhaseType(phase) {
  const n = parseInt((phase || "").replace(/[^0-9]/g, "")) || 0;
  // Odd phase numbers (1,3,5…) → Saturday weekly; even (2,4,6…) → Monday alternate
  return n === 0 || n % 2 === 1 ? "odd" : "even";
}

function computeSLADeadlines(phase, assessmentDateStr) {
  if (!assessmentDateStr) return null;
  const pt = getPhaseType(phase);
  const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
  const setHM   = (d, h, m) => { const r = new Date(d); r.setHours(h, m, 0, 0); return r; };
  const getMon  = d => { const dow = d.getDay(); return addDays(d, dow === 0 ? -6 : 1 - dow); };
  const base    = new Date(assessmentDateStr + "T12:00:00");

  if (pt === "odd") {
    // Phase 1/3/5: Saturday assessment — process starts Monday of same week
    const mon = getMon(base);
    return {
      phaseType: "odd", scheduleLabel: "Sat Weekly",
      syllabus:     setHM(mon,             18, 30),
      mock_config:  setHM(addDays(mon, 1), 18,  0),
      mock_publish: setHM(addDays(mon, 2), 18,  0),
      main_config:  setHM(addDays(mon, 4), 11,  0),
      main_publish: setHM(addDays(mon, 4), 18, 30),
      dayLabels: {
        syllabus:     "Mon 6:30 PM",
        mock_config:  "Tue 6:00 PM",
        mock_publish: "Wed 6:00 PM",
        main_config:  "Fri 11:00 AM",
        main_publish: "Fri 6:30 PM",
      },
    };
  } else {
    // Phase 2/4/6: Monday assessment — process starts PREVIOUS week Monday
    const prevMon = addDays(getMon(base), -7);
    return {
      phaseType: "even", scheduleLabel: "Mon Alternate",
      syllabus:     setHM(addDays(prevMon, 1), 18, 30),
      mock_config:  setHM(addDays(prevMon, 2), 18,  0),
      mock_publish: setHM(addDays(prevMon, 3), 18,  0),
      main_config:  setHM(addDays(prevMon, 4), 18,  0),
      main_publish: setHM(addDays(prevMon, 5), 18,  0),
      dayLabels: {
        syllabus:     "Tue 6:30 PM",
        mock_config:  "Wed 6:00 PM",
        mock_publish: "Thu 6:00 PM",
        main_config:  "Fri 6:00 PM",
        main_publish: "Sat 6:00 PM",
      },
    };
  }
}

function slaStatus(deadline, completedAt) {
  if (!deadline) return { s: "na", label: "N/A", cls: "sla-na" };
  const now = new Date();
  const dl  = deadline instanceof Date ? deadline : new Date(deadline);

  // Resolve Firestore Timestamps, plain Dates, or objects with .seconds
  function toDate(v) {
    if (!v) return null;
    if (v instanceof Date)               return v;
    if (typeof v.toDate === "function")  return v.toDate();
    if (v.seconds !== undefined)         return new Date(v.seconds * 1000);
    return null;
  }

  const cp = toDate(completedAt);
  if (cp) {
    return cp <= dl
      ? { s: "ok",   label: "Done on time", cls: "sla-ok" }
      : { s: "late", label: "Done late",    cls: "sla-late" };
  }
  // Completed but no parseable timestamp → count as done
  if (completedAt) return { s: "ok", label: "Done", cls: "sla-ok" };
  if (now > dl)   return { s: "breach", label: "Breached", cls: "sla-breach" };
  return               { s: "pend",   label: "Pending",  cls: "sla-pend" };
}

function slaNodeHtml(label, timeLabel, st, deadline) {
  const icons = { ok: "✓", late: "!", breach: "✕", pend: "·", na: "–" };
  const deadlineFmt = deadline
    ? deadline.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) + " " + timeLabel
    : "";
  const titleText = deadline
    ? `${label}: ${st.label}\nDeadline: ${deadlineFmt}`
    : `${label}: Not required`;
  return `<div class="sla-node ${st.cls}" title="${titleText}">
    <span class="sla-node-icon">${icons[st.s] || "·"}</span>
    <span class="sla-node-lbl">${label}</span>
    <span class="sla-node-time">${timeLabel || "—"}</span>
  </div>`;
}

function lineClass(a, b) {
  if (a.s === "breach") return "sla-breach";
  if (a.s === "late")   return "sla-late";
  if (a.s === "ok")     return "sla-ok";
  if (b && b.s === "breach") return "sla-breach";
  return "sla-pend";
}

function hasAnySLABreach(c) {
  const sla = computeSLADeadlines(c.phase, c.assessment_date);
  if (!sla || c.status === "published") return false;
  const hasMock  = c.mock_assessment === "required";
  const sylComp  = c.syllabus_submitted_at || c.createdAt;
  const mockComp = c.mock_config_link_submitted_at || null;
  const mainComp = c.config_link_submitted_at || (c.config_link ? c.submittedAt : null);
  const pubComp  = c.published_at || null;
  return (
    slaStatus(sla.syllabus,     sylComp).s  === "breach" ||
    slaStatus(sla.main_config,  mainComp).s === "breach" ||
    slaStatus(sla.main_publish, pubComp).s  === "breach" ||
    (hasMock && slaStatus(sla.mock_config,  mockComp).s === "breach") ||
    (hasMock && slaStatus(sla.mock_publish, pubComp).s  === "breach")
  );
}

// ── ASSESSMENT DETAILS PAGE ────────────────────────────────────

window.loadAssessmentDetails = async () => {
  setTbody("ad-tbody", 8, "Loading...");
  try {
    if (!allConfigs.length) {
      const snap = await getDocs(collection(db, "configs"));
      allConfigs = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    }
    const stuSnap = await getDocs(collection(db, "students"));
    adStudentMap = {};
    stuSnap.forEach(d => {
      const s = d.data();
      const key = `${s.phase || ""}|${s.batch || ""}|${s.week || ""}`;
      adStudentMap[key] = (adStudentMap[key] || 0) + 1;
    });
    await checkAndNotifyBreaches();
    renderADTable();
  } catch (e) {
    setTbody("ad-tbody", 8, "Error: " + e.message);
  }
};

window.setAdTab = (tab) => {
  adTab = tab;
  document.querySelectorAll("#ad-tabs .tab").forEach(t => {
    t.classList.toggle("active", t.dataset.tab === tab);
  });
  renderADTable();
};

function renderADTable() {
  const now   = new Date();
  const tbody = document.getElementById("ad-tbody");
  if (!tbody) return;

  let list = allConfigs.filter(c => c.assessment_date).map(c => {
    const sla       = computeSLADeadlines(c.phase, c.assessment_date);
    const key       = `${c.phase || ""}|${c.batch || ""}|${c.week || ""}`;
    const stuCount  = adStudentMap[key] || 0;
    const assessEnd = new Date(c.assessment_date + "T23:59:59");
    const isUpcoming = assessEnd >= now;
    const isPublished = c.status === "published";
    const hasActivity = !!(c.syllabus_submitted_at || c.createdAt);
    const breach = hasAnySLABreach(c);
    return { ...c, sla, stuCount, isUpcoming, isPublished, hasActivity, breach };
  });

  // Stats
  const totalEl   = document.getElementById("ad-total");
  const upEl      = document.getElementById("ad-upcoming");
  const ipEl      = document.getElementById("ad-inprogress");
  const pubEl     = document.getElementById("ad-published");
  const brEl      = document.getElementById("ad-breaches");
  const brBadge   = document.getElementById("ad-breach-badge");
  const banner    = document.getElementById("sla-breach-banner");
  const brCount   = document.getElementById("sla-breach-count");

  const upcoming   = list.filter(c => c.isUpcoming && !c.isPublished).length;
  const inprogress = list.filter(c => c.isUpcoming && !c.isPublished && c.hasActivity).length;
  const published  = list.filter(c => c.isPublished).length;
  const breaches   = list.filter(c => c.breach).length;
  const unackBreaches = list.filter(c => c.breach && !(c.sla_breach_ack_by || []).includes(currentUserEmail)).length;

  if (totalEl)  totalEl.textContent  = list.length;
  if (upEl)     upEl.textContent     = upcoming;
  if (ipEl)     ipEl.textContent     = inprogress;
  if (pubEl)    pubEl.textContent    = published;
  if (brEl)     brEl.textContent     = breaches;
  if (brBadge)  { brBadge.textContent = unackBreaches; brBadge.style.display = unackBreaches > 0 ? "inline" : "none"; }
  if (banner)   banner.style.display  = breaches > 0 ? "flex" : "none";
  if (brCount)  brCount.textContent   = unackBreaches > 0 ? unackBreaches : breaches;

  // Tab filter
  if (adTab === "upcoming")   list = list.filter(c => c.isUpcoming && !c.isPublished);
  if (adTab === "inprogress") list = list.filter(c => c.isUpcoming && !c.isPublished && c.hasActivity);
  if (adTab === "completed")  list = list.filter(c => c.isPublished || !c.isUpcoming);
  if (adTab === "breached")   list = list.filter(c => c.breach);

  // Sort: upcoming ascending, past descending
  list.sort((a, b) => {
    if (a.isUpcoming !== b.isUpcoming) return a.isUpcoming ? -1 : 1;
    const diff = a.assessment_date > b.assessment_date ? 1 : -1;
    return a.isUpcoming ? diff : -diff;
  });

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><h3>No assessments found</h3><p>No entries match this filter.</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = list.map((c, i) => {
    const { sla, stuCount, isUpcoming, isPublished, breach } = c;
    const hasMock = c.mock_assessment === "required";
    const dl      = sla?.dayLabels || {};

    // Completion timestamps (with fallbacks for older data)
    const sylComp  = c.syllabus_submitted_at || c.createdAt;
    const mockComp = c.mock_config_link_submitted_at || null;
    const mainComp = c.config_link_submitted_at || (c.config_link ? c.submittedAt : null);
    const pubComp  = c.published_at || null;

    const ssSyl      = slaStatus(sla?.syllabus,     sylComp);
    const ssMockCfg  = hasMock ? slaStatus(sla?.mock_config,  mockComp) : { s: "na", label: "N/A", cls: "sla-na" };
    const ssMockPub  = hasMock ? slaStatus(sla?.mock_publish, mockComp ? pubComp || null : null) : { s: "na", label: "N/A", cls: "sla-na" };
    const ssMain     = slaStatus(sla?.main_config,  mainComp);
    const ssMainPub  = slaStatus(sla?.main_publish, pubComp);

    const statusLabel = isPublished ? "Published" : (isUpcoming ? "Upcoming" : "Past");
    const statusCls   = isPublished ? "badge-published" : (isUpcoming ? "badge-upcoming" : "badge-past");

    const phE = escHtml(c.phase || "");
    const baE = escHtml(c.batch || "");
    const wkE = escHtml(c.week  || "");

    const isExpanded     = adExpandedRows.has(c._id);
    const isAcknowledged = breach && (c.sla_breach_ack_by || []).includes(currentUserEmail);
    const rowCls         = breach ? (isAcknowledged ? "row-breach-ack" : "row-breach") : "";

    const slaTrackHtml = sla
      ? `<div class="sla-track">
          ${slaNodeHtml("Syllabus",   dl.syllabus     || "", ssSyl,     sla.syllabus)}
          ${hasMock ? `
          <div class="sla-line ${lineClass(ssSyl, ssMockCfg)}"></div>
          ${slaNodeHtml("Mock Cfg",   dl.mock_config  || "", ssMockCfg, sla.mock_config)}
          <div class="sla-line ${lineClass(ssMockCfg, ssMockPub)}"></div>
          ${slaNodeHtml("Mock Live",  dl.mock_publish || "", ssMockPub, sla.mock_publish)}
          ` : ""}
          <div class="sla-line ${lineClass(hasMock ? ssMockPub : ssSyl, ssMain)}"></div>
          ${slaNodeHtml("Main Cfg",   dl.main_config  || "", ssMain,    sla.main_config)}
          <div class="sla-line ${lineClass(ssMain, ssMainPub)}"></div>
          ${slaNodeHtml("Main Live",  dl.main_publish || "", ssMainPub, sla.main_publish)}
        </div>
        <div class="sla-status-bar">
          <span class="badge ${statusCls}" style="font-size:.67rem">${statusLabel}</span>
          ${breach
            ? isAcknowledged
              ? `<span class="sp-ack">✓ Acknowledged</span>`
              : `<span class="sp-breach-lbl">⚠ Breach</span>`
            : ""}
        </div>`
      : `<span style="color:var(--muted);font-size:.78rem">No date set</span>`;

    return `<tr class="${rowCls}">
      <td>${i + 1}</td>
      <td>${pbwCell(c.phase, c.batch, c.week)}</td>
      <td>
        <div style="font-weight:600;font-size:.83rem">${fmtDate(c.assessment_date)}</div>
        ${sla ? `<div style="font-size:.7rem;color:var(--muted)">${sla.scheduleLabel}</div>` : ""}
      </td>
      <td>
        ${hasMock
          ? `<span class="badge badge-mock-req" style="font-size:.68rem;white-space:nowrap">Mock+Main</span>`
          : `<span class="badge badge-approved" style="font-size:.68rem;white-space:nowrap">Main Only</span>`}
      </td>
      <td style="text-align:center;font-weight:600;font-size:.86rem">${stuCount || "—"}</td>
      <td>${slaTrackHtml}</td>
      <td style="text-align:right">
        <div style="display:flex;flex-direction:column;gap:5px;align-items:flex-end">
          <button class="btn btn-sm btn-primary" id="ad-toggle-btn-${c._id}" onclick="toggleADRow('${c._id}')"
            style="min-width:110px">${isExpanded ? "▲ Collapse" : "▼ View Details"}</button>
          ${breach && !isAcknowledged
            ? `<button class="btn btn-sm" onclick="markBreachRead('${c._id}')"
                style="min-width:110px;background:transparent;border:1.5px solid #fca5a5;color:#c94040;font-size:.73rem">
                ✓ Mark as Read
              </button>`
            : ""}
        </div>
      </td>
    </tr>
    <tr id="ad-detail-${c._id}" class="ad-detail-row" style="${isExpanded ? "" : "display:none"}">
      <td colspan="7" style="padding:0;border-top:none;background:#f8fafc">
        <div id="ad-panel-${c._id}">
          ${buildADDetailPanelHTML(c)}
        </div>
      </td>
    </tr>`;
  }).join("");
}

window.markBreachRead = async (configId) => {
  try {
    await updateDoc(doc(db, "configs", configId), {
      sla_breach_ack_by: arrayUnion(currentUserEmail)
    });
    const c = allConfigs.find(x => x._id === configId);
    if (c) {
      if (!c.sla_breach_ack_by) c.sla_breach_ack_by = [];
      if (!c.sla_breach_ack_by.includes(currentUserEmail)) c.sla_breach_ack_by.push(currentUserEmail);
    }
    renderADTable();
  } catch (e) {
    toast("Error: " + e.message, "error");
  }
};

window.markAllBreachesRead = async () => {
  const unack = allConfigs.filter(c =>
    hasAnySLABreach(c) && !(c.sla_breach_ack_by || []).includes(currentUserEmail)
  );
  if (!unack.length) { toast("No unread breaches", "info"); return; }
  try {
    const wb = writeBatch(db);
    unack.forEach(c => {
      wb.update(doc(db, "configs", c._id), { sla_breach_ack_by: arrayUnion(currentUserEmail) });
      if (!c.sla_breach_ack_by) c.sla_breach_ack_by = [];
      if (!c.sla_breach_ack_by.includes(currentUserEmail)) c.sla_breach_ack_by.push(currentUserEmail);
    });
    await wb.commit();
    renderADTable();
    toast(`${unack.length} breach${unack.length > 1 ? "es" : ""} marked as read`, "success");
  } catch (e) {
    toast("Error: " + e.message, "error");
  }
};

// ── SLA BREACH DETECTION & NOTIFICATION ───────────────────────

async function checkAndNotifyBreaches() {
  const SLA_STEPS = [
    { key: "syllabus",     label: "Syllabus Submission",    team: "On Ground Team",     dlKey: "syllabus",     compFn: c => c.syllabus_submitted_at || c.createdAt },
    { key: "mock_config",  label: "Mock Config Link",       team: "Content Team",        dlKey: "mock_config",  compFn: c => c.mock_config_link_submitted_at, mockOnly: true },
    { key: "mock_publish", label: "Mock Assessment Live",   team: "Assessment Ops Team", dlKey: "mock_publish", compFn: c => c.published_at, mockOnly: true },
    { key: "main_config",  label: "Main Config Link",       team: "Content Team",        dlKey: "main_config",  compFn: c => c.config_link_submitted_at || (c.config_link ? c.submittedAt : null) },
    { key: "main_publish", label: "Main Assessment Live",   team: "Assessment Ops Team", dlKey: "main_publish", compFn: c => c.published_at },
  ];

  const escalateAfterMs = (_emailjsConfig?.escalateAfterHours || 0) * 60 * 60 * 1000;

  for (const c of allConfigs) {
    if (!c.assessment_date || c.status === "published") continue;
    const sla = computeSLADeadlines(c.phase, c.assessment_date);
    if (!sla) continue;

    for (const step of SLA_STEPS) {
      if (step.mockOnly && c.mock_assessment !== "required") continue;
      const deadline  = sla[step.dlKey];
      const completed = step.compFn(c);
      const st = slaStatus(deadline, completed);
      if (st.s !== "breach") continue;

      const notifField  = `sla_breach_notified_${step.key}`;
      const breachAtFld = `sla_breach_at_${step.key}`;
      const escalField  = `sla_escalation_notified_${step.key}`;

      // Tier 1: initial breach notification to task owner
      if (!c[notifField]) {
        await recordAndNotifyBreach(c, step, deadline);
      }

      // Tier 2: escalation to managers if breach is still open after N hours
      if (c[notifField] && !c[escalField] &&
          escalateAfterMs > 0 && _emailjsConfig?.managerEmails?.length) {
        const breachAt = c[breachAtFld];
        if (breachAt) {
          const breachDate  = breachAt.toDate ? breachAt.toDate() : new Date(breachAt);
          const msPassed    = Date.now() - breachDate.getTime();
          if (msPassed >= escalateAfterMs) {
            await recordAndEscalate(c, step, deadline, msPassed / 3_600_000);
          }
        }
      }
    }
  }
}

async function recordAndEscalate(c, step, deadline, hoursPassed) {
  try {
    const escalField = `sla_escalation_notified_${step.key}`;
    await updateDoc(doc(db, "configs", c._id), {
      [escalField]: true,
      [`sla_escalation_at_${step.key}`]: serverTimestamp(),
    });
    Object.assign(c, { [escalField]: true });
    await sendSLAEscalationEmail({ c, step, deadline, hoursPassed });
  } catch (e) {
    console.error("[SLA] Escalation error:", e);
  }
}

async function sendSLAEscalationEmail({ c, step, deadline, hoursPassed }) {
  const deadlineStr = deadline
    ? deadline.toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "long", year: "numeric" })
      + ", " + deadline.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
    : "—";
  const assessment  = `${c.phase || ""}${c.batch ? "-"+c.batch : ""}${c.week ? "-"+c.week : ""} (${fmtDate(c.assessment_date)})`;
  const hoursLabel  = (Math.round(hoursPassed * 10) / 10) + " hours";
  const manEmails   = _emailjsConfig.managerEmails;

  if (window.emailjs && _emailjsConfig?.publicKey && _emailjsConfig?.escalationTemplateId) {
    try {
      await window.emailjs.send(
        _emailjsConfig.serviceId,
        _emailjsConfig.escalationTemplateId,
        {
          to_email:         manEmails.join(","),
          to_name:          "Manager",
          assessment,
          sla_step:         step.label,
          responsible_team: step.team,
          deadline:         deadlineStr,
          hours_overdue:    hoursLabel,
          breach_time:      new Date().toLocaleString("en-IN"),
          portal_url:       window.location.origin,
        },
        _emailjsConfig.publicKey
      );
      return;
    } catch (err) {
      console.warn("[SLA] Escalation email failed:", err);
    }
  }
  console.info(
    `[SLA Escalation] Would email managers: ${manEmails.join(", ")}\n` +
    `Assessment: ${assessment} | Step: ${step.label} | Overdue: ${hoursLabel}`
  );
}

async function recordAndNotifyBreach(c, step, deadline) {
  try {
    const notifField   = `sla_breach_notified_${step.key}`;
    const detectedField = `sla_breach_at_${step.key}`;
    await updateDoc(doc(db, "configs", c._id), {
      [notifField]:    true,
      [detectedField]: serverTimestamp(),
    });
    Object.assign(c, { [notifField]: true });

    // Get team RP emails
    const teamSnap = await getDocs(query(
      collection(db, "team_members"),
      where("team",   "==", step.team),
      where("status", "==", "approved")
    ));
    const rpEmails = teamSnap.docs.map(d => d.data().email).filter(Boolean);

    // In-portal notification
    await createNotification("sla", "breach", "SLA Breach Detected",
      `${step.team} missed SLA: "${step.label}" for ${c.phase || ""}${c.batch ? "-"+c.batch : ""}${c.week ? "-"+c.week : ""} ` +
      `(deadline: ${deadline ? deadline.toLocaleDateString("en-IN", { day:"2-digit", month:"short" }) : ""})`);
    loadNotifCount();

    // Email notification
    if (rpEmails.length) {
      await sendSLABreachEmail({ c, step, deadline, rpEmails });
    }
  } catch (e) {
    console.error("[SLA] Breach notification error:", e);
  }
}

async function sendSLABreachEmail({ c, step, deadline, rpEmails }) {
  const deadlineStr = deadline
    ? deadline.toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "long", year: "numeric" })
      + ", " + deadline.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
    : "—";
  const assessment = `${c.phase || ""}${c.batch ? "-"+c.batch : ""}${c.week ? "-"+c.week : ""} (${fmtDate(c.assessment_date)})`;

  // Try EmailJS if configured
  if (window.emailjs && _emailjsConfig?.publicKey) {
    try {
      await window.emailjs.send(
        _emailjsConfig.serviceId,
        _emailjsConfig.templateId,
        {
          to_email:    rpEmails.join(","),
          to_name:     step.team,
          assessment,
          sla_step:    step.label,
          deadline:    deadlineStr,
          breach_time: new Date().toLocaleString("en-IN"),
          portal_url:  window.location.origin,
        },
        _emailjsConfig.publicKey
      );
      return;
    } catch (emailErr) {
      console.warn("[SLA] EmailJS send failed:", emailErr);
    }
  }

  // Fallback: log (admin can configure EmailJS in portal settings to enable auto-emails)
  console.info(
    `[SLA Breach] Would email: ${rpEmails.join(", ")}\n` +
    `Assessment: ${assessment}\nStep: ${step.label}\nDeadline: ${deadlineStr}`
  );
}

// ── SLA EMAIL SETTINGS ────────────────────────────────────────

async function loadSLAEmailSettings() {
  try {
    const snap = await getDocs(collection(db, "settings"));
    if (!snap.empty) {
      const cfg = snap.docs[0].data();
      const manEmails = (cfg.sla_manager_emails || "").split(",").map(e => e.trim()).filter(Boolean);
      _emailjsConfig = cfg.emailjs_service_id ? {
        serviceId:            cfg.emailjs_service_id,
        templateId:           cfg.emailjs_template_id          || "",
        escalationTemplateId: cfg.emailjs_escalation_template  || "",
        publicKey:            cfg.emailjs_public_key           || "",
        managerEmails:        manEmails,
        escalateAfterHours:   parseFloat(cfg.sla_escalate_after_hours) || 4,
      } : null;
      if (_emailjsConfig?.publicKey && window.emailjs) {
        window.emailjs.init(_emailjsConfig.publicKey);
      }
      // Populate form fields
      const svc  = document.getElementById("sla-emailjs-service");
      const tpl  = document.getElementById("sla-emailjs-template");
      const etpl = document.getElementById("sla-emailjs-escalation-template");
      const pub  = document.getElementById("sla-emailjs-pubkey");
      const mgr  = document.getElementById("sla-manager-emails");
      const hrs  = document.getElementById("sla-escalate-hours");
      if (svc)  svc.value  = cfg.emailjs_service_id             || "";
      if (tpl)  tpl.value  = cfg.emailjs_template_id            || "";
      if (etpl) etpl.value = cfg.emailjs_escalation_template    || "";
      if (pub)  pub.value  = cfg.emailjs_public_key             || "";
      if (mgr)  mgr.value  = cfg.sla_manager_emails             || "";
      if (hrs)  hrs.value  = cfg.sla_escalate_after_hours       || "4";
    }
  } catch (_) {}
}

window.saveSLAEmailSettings = async () => {
  const svcId  = (document.getElementById("sla-emailjs-service")?.value               || "").trim();
  const tplId  = (document.getElementById("sla-emailjs-template")?.value              || "").trim();
  const etplId = (document.getElementById("sla-emailjs-escalation-template")?.value   || "").trim();
  const pubKey = (document.getElementById("sla-emailjs-pubkey")?.value                || "").trim();
  const mgrRaw = (document.getElementById("sla-manager-emails")?.value                || "").trim();
  const hrs    = (document.getElementById("sla-escalate-hours")?.value                || "4").trim();
  const statusEl = document.getElementById("sla-email-status");
  try {
    const snap = await getDocs(collection(db, "settings"));
    const data = {
      emailjs_service_id:          svcId,
      emailjs_template_id:         tplId,
      emailjs_escalation_template: etplId,
      emailjs_public_key:          pubKey,
      sla_manager_emails:          mgrRaw,
      sla_escalate_after_hours:    hrs,
      updatedAt: serverTimestamp(),
    };
    if (snap.empty) {
      await addDoc(collection(db, "settings"), data);
    } else {
      await updateDoc(doc(db, "settings", snap.docs[0].id), data);
    }
    const manEmails = mgrRaw.split(",").map(e => e.trim()).filter(Boolean);
    _emailjsConfig = svcId ? {
      serviceId: svcId, templateId: tplId, escalationTemplateId: etplId,
      publicKey: pubKey, managerEmails: manEmails, escalateAfterHours: parseFloat(hrs) || 4,
    } : null;
    if (_emailjsConfig?.publicKey && window.emailjs) window.emailjs.init(_emailjsConfig.publicKey);
    if (statusEl) statusEl.textContent = "Saved successfully";
    toast("SLA email settings saved", "success");
  } catch (e) {
    toast("Error saving: " + e.message, "error");
  }
};

window.testSLAEmail = async () => {
  if (!_emailjsConfig?.publicKey) { toast("Configure and save EmailJS credentials first", "error"); return; }
  const statusEl = document.getElementById("sla-email-status");
  try {
    await window.emailjs.send(
      _emailjsConfig.serviceId,
      _emailjsConfig.templateId,
      {
        to_email:    currentUserEmail,
        to_name:     "Admin",
        assessment:  "P1-B1-W1 (Test)",
        sla_step:    "Syllabus Submission",
        deadline:    "Monday, 23 Jun 2026, 06:30 PM",
        breach_time: new Date().toLocaleString("en-IN"),
        portal_url:  window.location.origin,
      },
      _emailjsConfig.publicKey
    );
    if (statusEl) statusEl.textContent = `Test email sent to ${currentUserEmail}`;
    toast("Test email sent!", "success");
  } catch (e) {
    toast("Email send failed: " + e.message, "error");
  }
};

window.testSLAEscalationEmail = async () => {
  if (!_emailjsConfig?.publicKey) { toast("Configure and save EmailJS credentials first", "error"); return; }
  if (!_emailjsConfig?.escalationTemplateId) { toast("Set an Escalation Template ID first", "error"); return; }
  const statusEl = document.getElementById("sla-email-status");
  const testRecipient = _emailjsConfig.managerEmails?.[0] || currentUserEmail;
  try {
    await window.emailjs.send(
      _emailjsConfig.serviceId,
      _emailjsConfig.escalationTemplateId,
      {
        to_email:         testRecipient,
        to_name:          "Manager",
        assessment:       "P1-B1-W1 (Test)",
        sla_step:         "Syllabus Submission",
        responsible_team: "On Ground Team",
        deadline:         "Monday, 23 Jun 2026, 06:30 PM",
        hours_overdue:    `${_emailjsConfig.escalateAfterHours} hours`,
        breach_time:      new Date().toLocaleString("en-IN"),
        portal_url:       window.location.origin,
      },
      _emailjsConfig.publicKey
    );
    if (statusEl) statusEl.textContent = `Escalation test sent to ${testRecipient}`;
    toast("Escalation test email sent!", "success");
  } catch (e) {
    toast("Email send failed: " + e.message, "error");
  }
};

// ── CROSS-PAGE NAVIGATION FILTERS ─────────────────────────────

window.goToStudentsFiltered = (phase, batch, week) => {
  switchPage("students");
  setTimeout(() => {
    const ph = document.getElementById("student-phase-filter");
    if (ph) { ph.value = phase; window.onStudentPhaseChange(); }
    setTimeout(() => {
      const ba = document.getElementById("student-batch-filter");
      const wk = document.getElementById("student-week-filter");
      if (ba) ba.value = batch;
      if (wk) wk.value = week;
      window.filterStudents();
    }, 250);
  }, 700);
};

window.goToSyllabusFiltered = (phase, batch, week) => {
  switchPage("syllabus");
  setTimeout(() => {
    const ph = document.getElementById("syllabus-phase-filter");
    const sr = document.getElementById("syllabus-search");
    if (ph) ph.value = phase;
    if (sr) sr.value = [batch, week].filter(Boolean).join(" ");
    window.filterSyllabus();
  }, 700);
};

window.goToConfigsFiltered = (phase, batch, week) => {
  switchPage("configs");
  setTimeout(() => {
    const ph = document.getElementById("config-phase-filter");
    const sr = document.getElementById("config-search");
    if (ph) ph.value = phase;
    if (sr) sr.value = [batch, week].filter(Boolean).join(" ");
    window.filterConfigs();
  }, 700);
};

// ── ASSIGNMENTS ────────────────────────────────────────────────

let allAssignments   = [];
let assignmentTab    = "all";
let editingAssignId  = null;
let _linkRowCounter  = 0;

async function loadAssignments() {
  setTbody("assign-tbody", 7, "Loading...");
  try {
    const snap = await getDocs(query(collection(db, "assignments"), orderBy("requested_at", "desc")));
    allAssignments = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    renderAssignmentsTable();
    // Show/hide "Raise Request" button based on role
    const wrap = document.getElementById("assign-raise-btn-wrap");
    if (wrap) {
      const canRaise = !isGuest && ["On Ground Team","admin","Admin"].includes(currentUserTeam);
      wrap.style.display = canRaise ? "" : "none";
    }
  } catch(e) {
    setTbody("assign-tbody", 8, "Error: " + e.message);
  }
}

function renderAssignSubjectsCell(subjects, id) {
  if (!subjects || !subjects.length) return `<span style="color:var(--muted);font-size:.82rem">—</span>`;
  const names = subjects.map(s => escHtml(s.name)).join(", ");
  return `<div style="font-size:.82rem;font-weight:500;color:#1e293b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px">${names}</div>
    <button class="subjects-expand-btn" onclick="toggleAssignDetail('${id}',this)" style="font-size:.72rem;margin-top:2px">▼ View topics</button>`;
}

function renderAssignSubjectsDetail(subjects) {
  if (!subjects || !subjects.length) return "";
  return subjects.map(s => {
    const topics = (s.topics || "").split(/[|,]/).map(t => t.trim()).filter(Boolean);
    return `<div class="syllabus-detail-subject">
      <div class="syllabus-detail-subject-name">${escHtml(s.name || "—")}</div>
      ${topics.length ? `<div class="syllabus-detail-topics">${topics.map(t => `<span class="topic-tag">${escHtml(t)}</span>`).join("")}</div>` : ""}
    </div>`;
  }).join("");
}

window.toggleAssignDetail = (id, btn) => {
  const row = document.getElementById(`assign-detail-${id}`);
  if (!row) return;
  const open = row.style.display !== "none";
  row.style.display = open ? "none" : "";
  btn.textContent = open ? "▼ View topics" : "▲ Hide topics";
};

function renderAssignmentsTable() {
  const q   = (document.getElementById("assign-search")?.value || "").toLowerCase();
  const phF = document.getElementById("assign-phase-filter")?.value || "";

  const data = allAssignments.filter(a => {
    const matchTab = assignmentTab === "all" || a.status === assignmentTab;
    const matchPh  = !phF || a.phase === phF;
    const subjectsText = (a.subjects || []).map(s => `${s.name} ${s.topics}`).join(" ");
    const matchQ   = !q   || [a.phase, a.batch, a.week, a.domain, subjectsText, a.requested_by]
                               .some(v => (v || "").toLowerCase().includes(q));
    return matchTab && matchPh && matchQ;
  });

  const tbody = document.getElementById("assign-tbody");
  if (!tbody) return;

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><h3>No requests found</h3><p>No assignment requests match your filters.</p></div></td></tr>`;
    return;
  }

  const isAdmin      = currentUserTeam === "admin" || currentUserTeam === "Admin";
  const isContent    = currentUserTeam === "Content Team";
  const isOnGround   = currentUserTeam === "On Ground Team";
  const isInstructor = currentUserTeam === "Instructor";

  tbody.innerHTML = data.map((a, i) => {
    const pbw = [a.phase, a.batch, a.week].filter(Boolean).join(" · ");
    const domainPill = a.domain
      ? `<span style="font-size:.68rem;background:#ede9fe;color:#7c3aed;border-radius:4px;padding:1px 5px;margin-left:5px;vertical-align:middle">${a.domain}</span>`
      : "";
    const mockBadge = a.mock_required
      ? `<span class="badge badge-mock-req" style="font-size:.68rem;white-space:nowrap">Mock</span>`
      : `<span class="badge" style="font-size:.68rem;white-space:nowrap;background:#f1f5f9;color:#64748b;border-color:#e2e8f0">Main Only</span>`;
    const allocCount = (a.allocations || []).length;
    const evalDone   = Object.keys(a.evaluations || {}).length;
    const statusBadge = a.status === "submitted"
      ? `<span class="badge badge-approved" style="font-size:.68rem;white-space:nowrap">Submitted</span>`
      : `<span class="badge badge-pending" style="font-size:.68rem;white-space:nowrap">Pending</span>`;
    const allocLine = allocCount
      ? `<div style="font-size:.7rem;color:#16a34a;margin-top:3px">${allocCount} students allocated</div>`
      : (a.status === "submitted" ? `<div style="font-size:.7rem;color:#d97706;margin-top:3px">No students in batch</div>` : "");
    const linkCount = (a.links || []).length;
    const linksCell = linkCount > 0
      ? `<button class="btn btn-outline btn-sm" onclick="openViewLinksModal('${a._id}')" style="font-size:.75rem;white-space:nowrap;color:#1d4ed8;border-color:#bfdbfe">${linkCount} link${linkCount > 1 ? "s" : ""} ↗</button>`
      : `<span style="color:var(--muted);font-size:.8rem">—</span>`;

    const actions = [];
    if (!isGuest && (isContent || isAdmin)) {
      actions.push(`<button class="btn btn-primary btn-sm" onclick="openSubmitLinksModal('${a._id}')" style="font-size:.75rem;white-space:nowrap">${linkCount > 0 ? "Edit Links" : "Submit Links"}</button>`);
    }
    if ((isOnGround || isAdmin) && allocCount > 0) {
      actions.push(`<button class="btn btn-outline btn-sm" onclick="downloadAllocationCSV('${a._id}')" style="font-size:.75rem;white-space:nowrap" title="Download student-set allocation CSV">↓ CSV</button>`);
    }
    if (allocCount > 0) {
      const evalLabel = evalDone > 0 ? `View Eval (${evalDone}/${allocCount})` : isGuest ? `View Students (${allocCount})` : "Evaluate";
      if (!isGuest) {
        if (isInstructor || isAdmin) actions.push(`<button class="btn btn-outline btn-sm" onclick="openEvalListModal('${a._id}')" style="font-size:.75rem;white-space:nowrap;color:#7c3aed;border-color:#c4b5fd">${evalDone > 0 ? `Evaluate (${evalDone}/${allocCount})` : "Evaluate"}</button>`);
      } else {
        actions.push(`<button class="btn btn-outline btn-sm" onclick="openEvalListModal('${a._id}')" style="font-size:.75rem;white-space:nowrap;color:#7c3aed;border-color:#c4b5fd">${evalLabel}</button>`);
      }
    }
    if (!isGuest && isAdmin) {
      actions.push(`<button class="btn btn-outline btn-sm" onclick="deleteAssignment('${a._id}')" style="font-size:.75rem;color:var(--danger);border-color:var(--danger)">Delete</button>`);
    }

    const reqBy = `<div style="font-size:.75rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px" title="${escHtml(a.requested_by||'')}">${escHtml((a.requested_by||"—").split("@")[0])}</div>
      <div style="font-size:.68rem;color:var(--muted)">${formatDate(a.requested_at)}</div>`;

    return `<tr>
      <td style="color:var(--muted);font-size:.8rem">${i + 1}</td>
      <td style="white-space:nowrap"><span style="font-weight:600;font-size:.85rem">${pbw || "—"}</span>${domainPill}<br><span style="font-size:.7rem;color:var(--muted)">${reqBy}</span></td>
      <td style="text-align:center">${mockBadge}</td>
      <td>${renderAssignSubjectsCell(a.subjects, a._id)}</td>
      <td>${statusBadge}${allocLine}</td>
      <td>${linksCell}</td>
      <td style="text-align:right"><div style="display:flex;gap:5px;justify-content:flex-end">${actions.join("")}</div></td>
    </tr>
    <tr id="assign-detail-${a._id}" style="display:none;background:#f8fafc">
      <td colspan="7" style="padding:0 16px 14px 48px">
        <div class="syllabus-detail-panel">${renderAssignSubjectsDetail(a.subjects)}</div>
      </td>
    </tr>`;
  }).join("");
}

window.setAssignTab = (tab, el) => {
  assignmentTab = tab;
  document.querySelectorAll("#assign-tabs .tab").forEach(t => t.classList.remove("active"));
  if (el) el.classList.add("active");
  renderAssignmentsTable();
};

function buildRRSubjectRow(idx, name, topics) {
  const div = document.createElement("div");
  div.className = "subject-row rr-subject-row";
  div.innerHTML = `
    <div class="subject-row-header">
      <span class="subject-row-label">Subject ${idx}</span>
      <button type="button" class="btn btn-danger btn-sm" style="padding:2px 8px;font-size:.72rem" onclick="removeRRSubjectRow(this)">Remove</button>
    </div>
    <input type="text" class="sy-subject-name" placeholder="Subject name (e.g. Python Basics)" value="${escHtml(name)}" style="margin-bottom:6px;font-size:.84rem" />
    <textarea class="sy-subject-topics" rows="2" placeholder="Topics — comma separated (e.g. Variables, Loops, Functions)" style="font-size:.82rem;resize:vertical;margin-bottom:0">${escHtml(topics)}</textarea>`;
  return div;
}

window.addRRSubjectRow = () => {
  const list = document.getElementById("rr-subjects-list");
  list.appendChild(buildRRSubjectRow(list.children.length + 1, "", ""));
};

window.removeRRSubjectRow = (btn) => {
  btn.closest(".rr-subject-row").remove();
  document.querySelectorAll("#rr-subjects-list .rr-subject-row").forEach((row, i) => {
    row.querySelector(".subject-row-label").textContent = `Subject ${i + 1}`;
  });
};

function resetRRSubjectRows(subjects) {
  const list = document.getElementById("rr-subjects-list");
  list.innerHTML = "";
  const seed = (subjects && subjects.length) ? subjects : [{ name: "", topics: "" }];
  seed.forEach((s, i) => list.appendChild(buildRRSubjectRow(i + 1, s.name || "", s.topics || "")));
}

window.openRaiseRequestModal = () => {
  document.getElementById("rr-phase").value = "";
  document.getElementById("rr-batch").value = "";
  document.getElementById("rr-week").value  = "";
  document.getElementById("rr-mock").value  = "";
  const dr = document.getElementById("rr-domain-row");
  if (dr) dr.style.display = "none";
  resetRRSubjectRows(null);
  document.getElementById("raise-request-modal").classList.add("open");
};

window.saveAssignmentRequest = async () => {
  const btn   = document.getElementById("rr-save-btn");
  const phase = (document.getElementById("rr-phase")?.value || "").trim();
  const batchN = (document.getElementById("rr-batch")?.value || "").trim();
  const weekN  = (document.getElementById("rr-week")?.value  || "").trim();
  const domain = (document.getElementById("rr-domain")?.value || "").trim();
  const mock_required = document.getElementById("rr-mock")?.value === "yes";

  const subjects = [];
  document.querySelectorAll("#rr-subjects-list .rr-subject-row").forEach(row => {
    const name   = (row.querySelector(".sy-subject-name")?.value  || "").trim();
    const topics = (row.querySelector(".sy-subject-topics")?.value || "").trim();
    if (name) subjects.push({ name, topics });
  });

  if (!phase || !batchN || !weekN) { toast("Phase, Batch and Week are required", "error"); return; }
  if (!subjects.length) { toast("Add at least one subject", "error"); return; }
  const batch = `B${batchN}`;
  const week  = `W${weekN}`;

  btn.disabled = true; btn.textContent = "Submitting...";
  try {
    await addDoc(collection(db, "assignments"), {
      phase, batch, week, domain, mock_required, subjects,
      status: "pending",
      links: [],
      requested_by: currentUserEmail,
      requested_at: serverTimestamp(),
    });
    const pbwLabel = [phase, `B${batchN}`, `W${weekN}`].join(" · ");
    const mockLabel = mock_required ? " (Mock required)" : "";
    await createNotification(
      "assignment_request", "pending",
      `New Assignment Request — ${pbwLabel}`,
      `${currentUserEmail} raised an assignment request for ${pbwLabel}${domain ? " — " + domain : ""}${mockLabel}. Please submit the document links.`
    );
    closeModal("raise-request-modal");
    toast("Assignment request raised", "success");
    await loadAssignments();
  } catch(e) {
    toast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Raise Request";
  }
};

window.openSubmitLinksModal = (id) => {
  const a = allAssignments.find(x => x._id === id);
  if (!a) return;
  editingAssignId  = id;
  _linkRowCounter  = 0;
  const pbw = [a.phase, a.batch, a.week].filter(Boolean).join(" · ");
  document.getElementById("sl-title").textContent = `Submit Links — ${pbw}`;
  const existing = (a.links || []).length > 0 ? a.links : [{ label: "", url: "" }];
  const container = document.getElementById("sl-links-container");
  container.innerHTML = "";
  existing.forEach(l => _appendLinkRow(l.label || "", l.url || ""));
  document.getElementById("submit-links-modal").classList.add("open");
};

function _appendLinkRow(label, url) {
  const i = _linkRowCounter++;
  const container = document.getElementById("sl-links-container");
  const div = document.createElement("div");
  div.className = "sl-link-row";
  div.id = `sl-row-${i}`;
  div.style.cssText = "display:flex;gap:8px;align-items:center";
  div.innerHTML = `
    <input type="text"  class="sl-label" placeholder="Label (e.g. Set 1, Week 3 Assignments)" value="${escHtml(label)}" style="flex:1;margin:0;font-size:.84rem;padding:8px 10px" />
    <input type="url"   class="sl-url"   placeholder="https://docs.google.com/..." value="${escHtml(url)}" style="flex:2;margin:0;font-size:.84rem;padding:8px 10px" />
    <button class="btn btn-outline btn-sm" onclick="document.getElementById('sl-row-${i}').remove()" style="flex-shrink:0;color:var(--danger);border-color:var(--danger);padding:6px 10px">✕</button>
  `;
  container.appendChild(div);
}

window.addLinkRow = () => _appendLinkRow("", "");

window.saveAssignmentLinks = async () => {
  const btn       = document.getElementById("sl-save-btn");
  const container = document.getElementById("sl-links-container");
  const rows      = container.querySelectorAll(".sl-link-row");

  const links = [];
  rows.forEach(row => {
    const label = (row.querySelector(".sl-label")?.value || "").trim();
    const url   = (row.querySelector(".sl-url")?.value   || "").trim();
    if (url) links.push({ label, url, submitted_by: currentUserEmail, submitted_at: new Date().toISOString() });
  });

  if (!links.length) { toast("Add at least one valid URL", "error"); return; }

  btn.disabled = true; btn.textContent = "Saving...";
  try {
    await updateDoc(doc(db, "assignments", editingAssignId), {
      links,
      status: "submitted",
      submitted_at: serverTimestamp(),
    });
    const a = allAssignments.find(x => x._id === editingAssignId);
    if (a) { a.links = links; a.status = "submitted"; }
    await autoAllocateSets(editingAssignId, links, a);
    const aPbw = a ? [a.phase, a.batch, a.week].filter(Boolean).join(" · ") : "";
    await createNotification(
      "assignment_links", "info",
      `Assignment Links Submitted — ${aPbw}`,
      `${currentUserEmail} submitted ${links.length} link${links.length > 1 ? "s" : ""} for the assignment request${aPbw ? " (" + aPbw + ")" : ""}. Links are now available for distribution.`
    );
    closeModal("submit-links-modal");
    toast("Links saved successfully", "success");
    renderAssignmentsTable();
  } catch(e) {
    toast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Save Links";
  }
};

// ── AUTO-ALLOCATE SETS ────────────────────────────────────────
async function autoAllocateSets(assignId, links, assignment) {
  if (!links.length || !assignment) return;
  try {
    const snap = await getDocs(query(
      collection(db, "students"),
      where("phase", "==", assignment.phase),
      where("batch", "==", assignment.batch)
    ));
    if (snap.empty) return;
    const students = snap.docs.map(d => d.data())
      .sort((a, b) => (a.uid || a.name || "").localeCompare(b.uid || b.name || ""));
    const allocations = students.map((s, i) => {
      const set = links[i % links.length];
      return { uid: s.uid || "", name: s.name || "", email: s.email || "", student_id: s.student_id || "", setLabel: set.label || `Set ${(i % links.length) + 1}`, setUrl: set.url || "" };
    });
    await updateDoc(doc(db, "assignments", assignId), { allocations });
    if (assignment) assignment.allocations = allocations;
  } catch(e) { console.error("Auto-allocation error:", e); }
}

// ── DOWNLOAD ALLOCATION CSV ───────────────────────────────────
window.downloadAllocationCSV = (id) => {
  const a = allAssignments.find(x => x._id === id);
  if (!a?.allocations?.length) { toast("No allocation data yet", "error"); return; }
  const rows = [["Sr No","Student Name","UID","Student ID","Email","Allocated Set","Assignment Link"]];
  a.allocations.forEach((al, i) => rows.push([i+1, al.name, al.uid, al.student_id, al.email, al.setLabel, al.setUrl]));
  const csv = rows.map(r => r.map(c => `"${String(c||"").replace(/"/g,'""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const lnk  = document.createElement("a");
  lnk.href = url; lnk.download = `allocation_${[a.phase,a.batch,a.week].filter(Boolean).join("_")}.csv`; lnk.click();
  URL.revokeObjectURL(url);
};

// ── EVALUATION STATE ──────────────────────────────────────────
let evalAssignId   = null;
let evalStudentUid = null;

window.openEvalListModal = (id) => {
  const a = allAssignments.find(x => x._id === id);
  if (!a?.allocations?.length) { toast("No students allocated yet", "error"); return; }
  evalAssignId = id;
  const pbw  = [a.phase, a.batch, a.week].filter(Boolean).join(" · ");
  const evals = a.evaluations || {};
  const done  = Object.keys(evals).length;
  document.getElementById("el-title").textContent = `Evaluate — ${pbw}`;
  document.getElementById("el-sub").textContent   = `${a.domain ? a.domain + " · " : ""}${a.allocations.length} students`;
  document.getElementById("el-progress").textContent = `${done} / ${a.allocations.length} evaluated`;
  const tbody = document.getElementById("el-tbody");
  tbody.innerHTML = a.allocations.map((al, i) => {
    const ev  = evals[al.uid || al.email] || null;
    const key = al.uid || al.email;
    const scoreHtml = ev
      ? `<span style="font-weight:700;color:${ev.total >= 17 ? '#16a34a' : ev.total >= 14 ? '#15803d' : ev.total >= 11 ? '#d97706' : '#dc2626'}">${(+ev.total).toFixed(2)}</span>`
      : `<span style="color:var(--muted)">—</span>`;
    const bandHtml  = ev ? `<span style="font-size:.7rem;color:var(--muted)">${ev.performance_band}</span>` : "";
    const hasLinks  = al.deployment_link || al.github_link;
    const linksHtml = hasLinks
      ? `<div style="display:flex;gap:4px">${al.deployment_link ? `<a href="${escHtml(al.deployment_link)}" target="_blank" style="font-size:.7rem;color:#1d4ed8" title="Deployment link">Deploy ↗</a>` : ""}${al.deployment_link && al.github_link ? "<span style='color:var(--muted)'> · </span>" : ""}${al.github_link ? `<a href="${escHtml(al.github_link)}" target="_blank" style="font-size:.7rem;color:#1d4ed8" title="GitHub link">Git ↗</a>` : ""}</div>`
      : `<span style="font-size:.72rem;color:var(--muted)">No links</span>`;
    return `<tr>
      <td style="color:var(--muted);font-size:.8rem">${i+1}</td>
      <td style="font-size:.84rem;font-weight:500">${escHtml(al.name||"—")}</td>
      <td style="font-size:.78rem;color:var(--muted)">${escHtml(al.uid||"—")}</td>
      <td><span style="font-size:.75rem;background:#ede9fe;color:#7c3aed;border-radius:4px;padding:2px 6px">${escHtml(al.setLabel||"—")}</span></td>
      <td>${linksHtml}</td>
      <td>${scoreHtml}</td>
      <td>${bandHtml}</td>
      <td style="text-align:right">${isGuest
        ? (ev ? `<span style="font-size:.72rem;color:var(--muted)">Evaluated</span>` : `<span style="font-size:.72rem;color:var(--muted)">Pending</span>`)
        : `<button class="btn btn-outline btn-sm" onclick="openEvalStudentModal('${id}','${escHtml(key)}')" style="font-size:.74rem">${ev ? "Re-evaluate" : "Evaluate"}</button>`
      }</td>
    </tr>`;
  }).join("");
  document.getElementById("eval-list-modal").classList.add("open");
};

window.openEvalStudentModal = (assignId, uid) => {
  const a  = allAssignments.find(x => x._id === assignId);
  if (!a) return;
  const al = a.allocations.find(x => (x.uid || x.email) === uid);
  if (!al) return;
  evalAssignId   = assignId;
  evalStudentUid = uid;
  document.getElementById("es-title").textContent = al.name || "Student";
  document.getElementById("es-sub").textContent   = [al.uid, al.setLabel, al.email].filter(Boolean).join(" · ");

  // Assignment Details card
  const typeBadge = a.mock_required
    ? `<span style="background:#fef3c7;color:#92400e;border:1px solid #fcd34d;border-radius:12px;padding:2px 10px;font-size:.7rem;font-weight:700">MOCK</span>`
    : `<span style="background:#dcfce7;color:#166534;border:1px solid #86efac;border-radius:12px;padding:2px 10px;font-size:.7rem;font-weight:700">MAIN</span>`;
  const qLink = al.setUrl
    ? `<a href="${escHtml(al.setUrl)}" target="_blank" style="color:#1d4ed8;font-size:.82rem;word-break:break-all">${escHtml(al.setLabel || al.setUrl)}</a>`
    : `<span style="color:var(--muted);font-size:.82rem">—</span>`;
  document.getElementById("es-assign-info").innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <span style="font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#1d4ed8">Assignment Details</span>
      ${typeBadge}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px">
      <div><div style="font-size:.62rem;text-transform:uppercase;color:#64748b;margin-bottom:2px">Batch</div><div style="font-size:.84rem;font-weight:600;color:#1e293b">${escHtml(a.batch||"—")}</div></div>
      <div><div style="font-size:.62rem;text-transform:uppercase;color:#64748b;margin-bottom:2px">Week</div><div style="font-size:.84rem;font-weight:600;color:#1e293b">${escHtml(a.week||"—")}</div></div>
      <div><div style="font-size:.62rem;text-transform:uppercase;color:#64748b;margin-bottom:2px">Set</div><div style="font-size:.84rem;font-weight:600;color:#1e293b">${escHtml(al.setLabel||"—")}</div></div>
    </div>
    <div><div style="font-size:.62rem;text-transform:uppercase;color:#64748b;margin-bottom:3px">Assignment Question Link</div>${qLink}</div>`;

  const ev = (a.evaluations || {})[uid] || {};
  document.getElementById("es-deploy").value = ev.deployment_link || al.deployment_link || "";
  document.getElementById("es-github").value  = ev.github_link    || al.github_link    || "";
  const scoreMap = [
    ["es-layout",ev.layout_visual],["es-styling",ev.component_styling],["es-responsive",ev.responsiveness],
    ["es-core",ev.core_feature],["es-interactive",ev.interactive_behavior],["es-dynamic",ev.dynamic_content],
    ["es-data",ev.data_handling],
    ["es-component",ev.component_structure],["es-readability",ev.readability],["es-submission",ev.submission_quality],
    ["es-bonus",ev.bonus ?? ""]
  ];
  scoreMap.forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.value = (val !== undefined && val !== null) ? String(val) : "";
  });
  syncScorePickers();
  document.getElementById("es-remarks").value = ev.remarks || "";
  updateEvalTotals();
  document.getElementById("eval-student-modal").classList.add("open");
};

// Score picker helpers
const syncScorePickers = () => {
  document.querySelectorAll("#eval-student-modal .sp").forEach(picker => {
    const inputId = picker.dataset.id;
    const color   = picker.dataset.color || "#6366f1";
    const input   = document.getElementById(inputId);
    if (!input) return;
    const val = input.value;
    picker.querySelectorAll(".sp-btn").forEach(btn => {
      const isActive = val !== "" && btn.dataset.val === val;
      btn.classList.toggle("active", isActive);
      if (isActive) { btn.style.background = color; }
      else { btn.style.background = ""; }
    });
  });
};

// Wire score picker clicks via event delegation
document.addEventListener("click", e => {
  const btn = e.target.closest("#eval-student-modal .sp-btn");
  if (!btn) return;
  const picker  = btn.closest(".sp");
  const inputId = picker.dataset.id;
  const color   = picker.dataset.color || "#6366f1";
  const val     = btn.dataset.val;
  const input   = document.getElementById(inputId);
  if (input) input.value = val;
  picker.querySelectorAll(".sp-btn").forEach(b => {
    const active = b === btn;
    b.classList.toggle("active", active);
    b.style.background = active ? color : "";
  });
  updateEvalTotals();
});

window.updateEvalTotals = () => {
  const g = id => { const el = document.getElementById(id); return (el && el.value !== "") ? parseFloat(el.value) : null; };
  const avg = (...vals) => { const v = vals.filter(x => x !== null); return v.length === vals.length ? v.reduce((a,b)=>a+b,0)/v.length : null; };
  const p1 = avg(g("es-layout"), g("es-styling"), g("es-responsive"));
  const p2 = avg(g("es-core"), g("es-interactive"), g("es-dynamic"));
  const p3 = g("es-data");
  const p4 = avg(g("es-component"), g("es-readability"), g("es-submission"));
  const bonus = parseFloat(document.getElementById("es-bonus")?.value || "0") || 0;
  const fmt = v => v !== null ? v.toFixed(2) : "—";
  document.getElementById("es-p1avg").textContent  = fmt(p1);
  document.getElementById("es-p2avg").textContent  = fmt(p2);
  document.getElementById("es-p3score").textContent = fmt(p3);
  document.getElementById("es-p4avg").textContent  = fmt(p4);
  const allReady = [p1,p2,p3,p4].every(v => v !== null);
  const total    = allReady ? p1 + p2 + p3 + p4 + bonus : null;
  const totalEl  = document.getElementById("es-total");
  const bandEl   = document.getElementById("es-band");
  if (totalEl) { totalEl.textContent = total !== null ? total.toFixed(2) + " / 20" : "—"; totalEl.style.color = total === null ? "#94a3b8" : total >= 17 ? "#4ade80" : total >= 14 ? "#86efac" : total >= 11 ? "#fbbf24" : "#f87171"; }
  if (bandEl) {
    bandEl.textContent = total === null ? "—"
      : total >= 17 ? "Exceptional — Strong Hire"
      : total >= 14 ? "Strong — Hire"
      : total >= 11 ? "Competent — Hire with Minor Reservations"
      : total >= 8  ? "Borderline — Conditional Hire"
      : "Significantly Below Expectations — Do Not Hire";
  }
};

window.saveStudentEval = async () => {
  const btn = document.getElementById("es-save-btn");
  const g   = id => { const el = document.getElementById(id); return (el && el.value !== "") ? parseFloat(el.value) : null; };
  const avg = (...vals) => { const v = vals.filter(x => x !== null); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : 0; };
  const lv = g("es-layout"), cs = g("es-styling"), re = g("es-responsive");
  const cf = g("es-core"),   ib = g("es-interactive"), dc = g("es-dynamic");
  const dh = g("es-data");
  const co = g("es-component"), rd = g("es-readability"), sq = g("es-submission");
  const bonus = parseFloat(document.getElementById("es-bonus")?.value || "0") || 0;
  if ([lv,cs,re,cf,ib,dc,dh,co,rd,sq].some(v => v === null)) { toast("Please fill all 10 scoring criteria", "error"); return; }
  const p1 = avg(lv,cs,re), p2 = avg(cf,ib,dc), p4 = avg(co,rd,sq);
  const total = p1 + p2 + dh + p4 + bonus;
  const band  = total >= 17 ? "Exceptional — Strong Hire" : total >= 14 ? "Strong — Hire" : total >= 11 ? "Competent — Hire with Minor Reservations" : total >= 8 ? "Borderline — Conditional Hire" : "Significantly Below Expectations — Do Not Hire";
  const ev = {
    deployment_link: document.getElementById("es-deploy").value.trim(),
    github_link:     document.getElementById("es-github").value.trim(),
    layout_visual: lv, component_styling: cs, responsiveness: re, part1_avg: p1,
    core_feature: cf, interactive_behavior: ib, dynamic_content: dc, part2_avg: p2,
    data_handling: dh, part3_score: dh,
    component_structure: co, readability: rd, submission_quality: sq, part4_avg: p4,
    bonus, total, performance_band: band,
    remarks: document.getElementById("es-remarks").value.trim(),
    evaluated_by: currentUserEmail, evaluated_at: new Date().toISOString(),
  };
  btn.disabled = true; btn.textContent = "Saving...";
  try {
    await updateDoc(doc(db, "assignments", evalAssignId), { [`evaluations.${evalStudentUid}`]: ev });
    const a = allAssignments.find(x => x._id === evalAssignId);
    if (a) { if (!a.evaluations) a.evaluations = {}; a.evaluations[evalStudentUid] = ev; }
    closeModal("eval-student-modal");
    toast("Evaluation saved", "success");
    openEvalListModal(evalAssignId);
  } catch(e) { toast("Error: " + e.message, "error"); }
  finally { btn.disabled = false; btn.textContent = "Save Evaluation"; }
};

// ── ABOUT PAGE DOWNLOADS ──
window.downloadAbout = (mode) => {
  // Show all role guides for full download, hide all for base
  document.querySelectorAll(".role-guide").forEach(el => {
    el.style.display = mode === "all" ? "block" : "none";
  });
  setTimeout(() => {
    window.print();
    setTimeout(() => {
      document.querySelectorAll(".role-guide").forEach(el => el.style.display = "none");
    }, 1500);
  }, 100);
};

window.downloadRoleGuide = () => {
  const role = document.getElementById("role-dl-select")?.value;
  if (!role) { alert("Please select a role from the dropdown first."); return; }
  document.querySelectorAll(".role-guide").forEach(el => {
    el.style.display = el.dataset.role === role ? "block" : "none";
  });
  setTimeout(() => {
    window.print();
    setTimeout(() => {
      document.querySelectorAll(".role-guide").forEach(el => el.style.display = "none");
      const sel = document.getElementById("role-dl-select");
      if (sel) sel.value = "";
    }, 1500);
  }, 100);
};

window.addRemark = (text) => {
  const el = document.getElementById("es-remarks");
  if (!el) return;
  el.value = el.value ? el.value.trimEnd() + ". " + text : text;
  el.focus();
};

// ── IMPORT SUBMISSIONS CSV ────────────────────────────────────
// Upload Google Form responses CSV → auto-fill Deployment + GitHub links per student UID
window.importSubmissionsCSV = () => {
  document.getElementById("submissions-csv-input").click();
};

window.handleSubmissionsCSV = async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) { toast("CSV has no data rows", "error"); return; }

    const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
    // Find column indices by header name (flexible matching)
    const find = (...terms) => headers.findIndex(h => terms.some(t => h.includes(t)));
    const uidIdx    = find("candidate uid", "uid");
    const deployIdx = find("deployment link", "deployment", "deploy link");
    const githubIdx = find("github link", "github", "git link");

    if (uidIdx < 0) { toast("CSV must have a 'Candidate UID' column header", "error"); return; }

    const submissions = {};
    lines.slice(1).forEach(line => {
      const cols = parseCSVLine(line);
      const uid  = cols[uidIdx] || "";
      if (uid) submissions[uid] = {
        deployment_link: deployIdx >= 0 ? (cols[deployIdx] || "") : "",
        github_link:     githubIdx >= 0 ? (cols[githubIdx] || "") : "",
      };
    });

    const a = allAssignments.find(x => x._id === evalAssignId);
    if (!a?.allocations?.length) { toast("No allocations to match against", "error"); return; }

    let matched = 0;
    const updatedAllocations = a.allocations.map(al => {
      const sub = submissions[al.uid] || submissions[al.email];
      if (sub) { matched++; return { ...al, ...sub }; }
      return al;
    });

    await updateDoc(doc(db, "assignments", evalAssignId), { allocations: updatedAllocations });
    a.allocations = updatedAllocations;
    toast(`${matched} / ${a.allocations.length} students matched — links imported`, "success");
    openEvalListModal(evalAssignId);
  } catch(e) { toast("Import error: " + e.message, "error"); }
  finally { event.target.value = ""; }
};

window.downloadEvalCSV = () => {
  const a = allAssignments.find(x => x._id === evalAssignId);
  if (!a) return;
  const SCORE_LABELS = {
    "0":"0 : Not implemented / broken","1":"1 : Very weak","2":"2 : Partially correct",
    "3":"3 : Meets minimum expectations","4":"4 : Strong implementation","5":"5 : Excellent / production-ready"
  };
  const sl = v => (v !== undefined && v !== null) ? (SCORE_LABELS[String(v)] || String(v)) : "";
  const f  = v => (v !== undefined && v !== null) ? (+v).toFixed(2) : "";
  const headers = [
    "Assessment Type","Batch","Week","Candidate UID","Candidate Name",
    "Assignment Question Link","Deployment Link","Github Link",
    "Layout & visual consistency","Component styling & consistency","Responsiveness (all screen sizes)","Part 1 Avg",
    "Core feature completion","Interactive behavior (navigation, forms, controls, scroll, etc.)","Dynamic content handling (search/filter/pagination where applicable)","Part 2 Avg",
    "Data Handling & State Management","Part 3 Score",
    "Component structure & maintainability","Readability & best practices","Submission quality (working build, repo, README, no errors)","Part 4 Avg",
    "BONUS FEATURES","Total (/20)","Performance Band","Remarks"
  ];
  const rows = [headers];
  (a.allocations || []).forEach(al => {
    const ev = (a.evaluations || {})[al.uid || al.email] || {};
    rows.push([
      a.mock_required ? "Mock" : "Main", a.batch, a.week,
      al.uid||"", al.name||"", al.setUrl||"", ev.deployment_link||"", ev.github_link||"",
      sl(ev.layout_visual), sl(ev.component_styling), sl(ev.responsiveness), f(ev.part1_avg),
      sl(ev.core_feature), sl(ev.interactive_behavior), sl(ev.dynamic_content), f(ev.part2_avg),
      sl(ev.data_handling), f(ev.part3_score),
      sl(ev.component_structure), sl(ev.readability), sl(ev.submission_quality), f(ev.part4_avg),
      ev.bonus !== undefined ? String(ev.bonus) : "", f(ev.total), ev.performance_band||"", ev.remarks||""
    ]);
  });
  const csv  = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type:"text/csv" });
  const url  = URL.createObjectURL(blob);
  const lnk  = document.createElement("a");
  lnk.href = url; lnk.download = `evaluation_${[a.batch,a.week].filter(Boolean).join("_")}.csv`; lnk.click();
  URL.revokeObjectURL(url);
};

window.openViewLinksModal = (id) => {
  const a = allAssignments.find(x => x._id === id);
  if (!a) return;
  const pbw = [a.phase, a.batch, a.week].filter(Boolean).join(" · ");
  document.getElementById("vl-title").textContent = `Assignment Links — ${pbw}`;

  const subjects = a.subjects || [];
  const subjectHtml = subjects.length
    ? `<div style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin-bottom:16px">
        <div style="padding:8px 14px;background:#f8fafc;font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#64748b;border-bottom:1px solid #e2e8f0">Subjects &amp; Topics</div>
        ${subjects.map((s, si) => {
          const topics = (s.topics || "").split(/[|,]/).map(t => t.trim()).filter(Boolean);
          const sid = `vl-subj-${si}`;
          return `<div style="border-bottom:1px solid #f1f5f9">
            <button onclick="toggleVLSubject('${sid}')" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#fff;border:none;cursor:pointer;text-align:left;gap:8px">
              <span style="font-size:.85rem;font-weight:600;color:#1e293b">${escHtml(s.name)}</span>
              <span id="${sid}-arrow" style="font-size:.7rem;color:var(--muted);flex-shrink:0">▼</span>
            </button>
            <div id="${sid}" style="display:none;padding:8px 14px 12px 20px;background:#fafafa;border-top:1px solid #f1f5f9">
              ${topics.length
                ? `<div style="display:flex;flex-wrap:wrap;gap:4px">${topics.map(t => `<span class="topic-tag">${escHtml(t)}</span>`).join("")}</div>`
                : `<span style="font-size:.78rem;color:var(--muted)">No topics listed</span>`}
            </div>
          </div>`;
        }).join("")}
      </div>`
    : "";

  const links = a.links || [];
  const linksHtml = links.length
    ? links.map((l, idx) => {
        const label = l.label || `Link ${idx + 1}`;
        const shortUrl = (() => { try { const u = new URL(l.url); return u.hostname + (u.pathname.length > 30 ? u.pathname.slice(0,30) + "…" : u.pathname); } catch { return l.url.slice(0, 50) + (l.url.length > 50 ? "…" : ""); } })();
        return `<div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;margin-bottom:10px">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
            <div style="flex:1;min-width:0">
              <div style="font-size:.875rem;font-weight:700;color:#1e293b;margin-bottom:3px">${escHtml(label)}</div>
              <div style="font-size:.75rem;color:#1d4ed8;margin-bottom:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escHtml(l.url)}">${escHtml(shortUrl)}</div>
              <div style="font-size:.68rem;color:var(--muted)">Submitted by ${escHtml(l.submitted_by || "—")}</div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0;align-items:center">
              <button class="btn btn-outline btn-sm" onclick="copyAssignLink('${escHtml(l.url)}')" style="font-size:.74rem;padding:5px 10px" title="Copy link">Copy</button>
              <a href="${escHtml(l.url)}" target="_blank" rel="noopener" class="btn btn-primary btn-sm" style="font-size:.74rem;padding:5px 12px;text-decoration:none">Open ↗</a>
            </div>
          </div>
        </div>`;
      }).join("")
    : `<p style="color:var(--muted);font-size:.85rem;padding:16px 0;text-align:center">No links submitted yet.</p>`;

  document.getElementById("vl-links-list").innerHTML = subjectHtml + linksHtml;
  document.getElementById("view-links-modal").classList.add("open");
};

window.toggleVLSubject = (id) => {
  const el = document.getElementById(id);
  const arrow = document.getElementById(id + "-arrow");
  if (!el) return;
  const open = el.style.display !== "none";
  el.style.display = open ? "none" : "block";
  if (arrow) arrow.textContent = open ? "▼" : "▲";
};

window.copyAssignLink = (url) => {
  navigator.clipboard.writeText(url).then(() => toast("Link copied to clipboard", "success")).catch(() => {
    const ta = document.createElement("textarea");
    ta.value = url; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
    toast("Link copied", "success");
  });
};

window.deleteAssignment = async (id) => {
  document.getElementById("delete-modal-msg").textContent = "Permanently delete this assignment request and all submitted links?";
  deleteCallback = async () => {
    try {
      await deleteDoc(doc(db, "assignments", id));
      allAssignments = allAssignments.filter(a => a._id !== id);
      renderAssignmentsTable();
      toast("Assignment deleted", "success");
      closeModal("delete-modal");
    } catch(e) {
      toast("Error: " + e.message, "error");
    }
  };
  document.getElementById("delete-confirm-btn").onclick = deleteCallback;
  document.getElementById("delete-modal").classList.add("open");
};

// ── CREDENTIALS & AUTOMATION ──────────────────────────────────
let automationCreds = {};
let sseSource = null;

window.openCredentialsModal = async () => {
  try {
    const snap = await getDocs(query(collection(db, "settings"), where("key", "==", "automation_creds")));
    if (!snap.empty) {
      automationCreds = snap.docs[0].data().value || {};
      document.getElementById("creds-invite-endpoint").value = automationCreds.inviteEndpoint || "";
      document.getElementById("creds-invite-key").value      = automationCreds.inviteKey      || "";
    }
  } catch {}
  document.getElementById("creds-server-url").value = localStorage.getItem("topinServerUrl") || "http://localhost:3001";
  document.getElementById("creds-modal").classList.add("open");
};

window.switchCredsTab = (tab, btn) => {
  document.querySelectorAll("#creds-tabs .tab").forEach(t => t.classList.remove("active"));
  if (btn) btn.classList.add("active");
  document.getElementById("creds-tab-invite").style.display = tab === "invite" ? "" : "none";
  document.getElementById("creds-tab-topin").style.display  = tab === "topin"  ? "" : "none";
};

window.saveCredentials = async () => {
  const inviteEndpoint = document.getElementById("creds-invite-endpoint").value.trim();
  const inviteKey      = document.getElementById("creds-invite-key").value.trim();
  const serverUrl      = document.getElementById("creds-server-url").value.trim();
  try {
    const snap = await getDocs(query(collection(db, "settings"), where("key", "==", "automation_creds")));
    const val  = { inviteEndpoint, inviteKey };
    if (!snap.empty) {
      await updateDoc(doc(db, "settings", snap.docs[0].id), { value: val, updatedAt: serverTimestamp(), updatedBy: currentUserEmail });
    } else {
      await addDoc(collection(db, "settings"), { key: "automation_creds", value: val, updatedAt: serverTimestamp(), updatedBy: currentUserEmail });
    }
    automationCreds = val;
  } catch (e) { toast("Error saving credentials: " + e.message, "error"); return; }
  if (serverUrl) localStorage.setItem("topinServerUrl", serverUrl);
  closeModal("creds-modal");
  toast("Credentials saved", "success");
};

window.checkServerHealth = async () => {
  const url = document.getElementById("creds-server-url").value.trim() || localStorage.getItem("topinServerUrl") || "http://localhost:3001";
  const dot = document.getElementById("server-status-dot");
  const txt = document.getElementById("server-status-txt");
  dot.style.background = "#f59e0b"; txt.textContent = "Checking...";
  try {
    const resp = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(4000) });
    if (resp.ok) { dot.style.background = "#22c55e"; txt.textContent = "Connected ✓"; }
    else          { dot.style.background = "#ef4444"; txt.textContent = "Server returned error"; }
  } catch {
    dot.style.background = "#ef4444"; txt.textContent = "Not reachable — is the server running?";
  }
};

// ── SSE progress helpers ──────────────────────────────────────
function openProgressModal(title, { showTargetPicker = false, targetOptions = [], onTarget } = {}) {
  document.getElementById("progress-modal-title").textContent  = title;
  document.getElementById("progress-log").innerHTML            = "";
  document.getElementById("progress-log").style.display        = showTargetPicker ? "none" : "";
  document.getElementById("progress-result").style.display     = "none";
  document.getElementById("progress-cancel-btn").style.display = "";
  document.getElementById("progress-close-btn").style.display  = "none";

  const picker = document.getElementById("progress-target-picker");
  const btns   = document.getElementById("progress-target-btns");
  if (showTargetPicker && targetOptions.length) {
    picker.style.display = "";
    btns.innerHTML = targetOptions.map(opt => `
      <button class="btn btn-outline" style="justify-content:flex-start;gap:10px;padding:10px 14px;text-align:left"
              onclick="selectPublishTarget('${opt.value}')">
        <strong style="font-size:.9rem">${opt.label}</strong>
        <span style="font-size:.76rem;color:var(--muted);display:block;margin-top:2px">${opt.desc}</span>
      </button>`).join("");
    window._onPublishTargetSelected = onTarget;
  } else {
    picker.style.display = "none";
  }

  document.getElementById("progress-modal").classList.add("open");
}

window.selectPublishTarget = (value) => {
  document.getElementById("progress-target-picker").style.display = "none";
  document.getElementById("progress-log").style.display           = "";
  if (window._onPublishTargetSelected) window._onPublishTargetSelected(value);
};

function logProgress(type, message) {
  const log   = document.getElementById("progress-log");
  const color = type === "error" ? "#f87171" : type === "success" || type === "done" ? "#4ade80" : "#93c5fd";
  const line  = document.createElement("div");
  line.style.cssText = `color:${color};margin-bottom:4px`;
  line.textContent   = `[${new Date().toLocaleTimeString()}] ${message}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function finishProgress(success, message, extra = {}) {
  const res = document.getElementById("progress-result");
  res.style.display    = "block";
  res.style.background = success ? "#dcfce7" : "#fee2e2";
  res.style.color      = success ? "#15803d" : "#dc2626";
  res.style.border     = `1px solid ${success ? "#bbf7d0" : "#fca5a5"}`;
  res.style.borderRadius = "6px"; res.style.padding = "10px 14px"; res.style.fontSize = ".83rem";
  res.textContent = message;
  if (extra.assessmentLink) {
    const a = document.createElement("a");
    a.href = extra.assessmentLink; a.target = "_blank";
    a.style.cssText = "display:block;font-size:.78rem;margin-top:6px;color:#1d4ed8;word-break:break-all";
    a.textContent = extra.assessmentLink;
    res.appendChild(a);
  }
  document.getElementById("progress-cancel-btn").style.display = "none";
  document.getElementById("progress-close-btn").style.display  = "";
}

function connectSSE(serverUrl, onDone = null) {
  if (sseSource) { sseSource.close(); sseSource = null; }
  sseSource = new EventSource(`${serverUrl}/api/publish/progress`);
  sseSource.onmessage = e => {
    try {
      const data = JSON.parse(e.data);
      logProgress(data.type, data.message);
      if (data.type === "done")  { finishProgress(true,  "Published on Topin ✓", data); if (onDone) onDone(data); }
      if (data.type === "error") { finishProgress(false, `Error: ${data.message}`); }
    } catch {}
  };
  sseSource.onerror = () => logProgress("error", "SSE connection lost");
}

window.cancelAutomation = async () => {
  const url = localStorage.getItem("topinServerUrl") || "http://localhost:3001";
  try { await fetch(`${url}/api/publish/cancel`, { method: "POST" }); } catch {}
  if (sseSource) { sseSource.close(); sseSource = null; }
  closeModal("progress-modal");
};

// ── Publish to Topin via local automation server ──────────────
window.publishToTopin = async (configId, preselectedTarget = null) => {
  const c = allConfigs.find(x => x._id === configId);
  if (!c) return;
  const serverUrl = localStorage.getItem("topinServerUrl") || "http://localhost:3001";
  try {
    await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
  } catch {
    toast("Local automation server not reachable. Start it via server/start.ps1 and set the URL in Credentials.", "error");
    return;
  }

  const hasMock = c.mock_assessment === "required";

  // Build target options based on config
  const targetOptions = [];
  if (hasMock) {
    targetOptions.push({ value: "mock",  label: "Mock Assessment only",  desc: `Date: ${c.mock_assessment_date || "not set"} · ${c.mock_assessment_start_time || "?"} – ${c.mock_assessment_end_time || "?"}` });
    targetOptions.push({ value: "main",  label: "Main Assessment only",  desc: `Date: ${c.assessment_date || "not set"} · ${c.assessment_start_time || "?"} – ${c.assessment_end_time || "?"}` });
    targetOptions.push({ value: "both",  label: "Both (Mock first, then Main)", desc: "Publishes mock assessment, then immediately publishes main assessment" });
  } else {
    targetOptions.push({ value: "main",  label: "Main Assessment",       desc: `Date: ${c.assessment_date || "not set"} · ${c.assessment_start_time || "?"} – ${c.assessment_end_time || "?"}` });
  }

  const startAutomation = async (target) => {
    connectSSE(serverUrl, async (doneData) => {
      // On SSE done: update Firestore
      try {
        const updates = { status: "published", published_at: serverTimestamp(), published_by: currentUserEmail, publish_target: target, invites_sent: false };
        if (doneData.assessmentLink) updates.topin_assessment_link = doneData.assessmentLink;
        if (doneData.assessmentId)   updates.topin_assessment_id   = doneData.assessmentId;
        await updateDoc(doc(db, "configs", configId), updates);
        const idx = allConfigs.findIndex(x => x._id === configId);
        if (idx >= 0) Object.assign(allConfigs[idx], { ...updates, published_at: new Date() });
        renderAssessmentsTable();
      } catch (e) { logProgress("error", "Firestore update failed: " + e.message); }
    });
    const mobile = prompt("Enter your Topin mobile number (10 digits):");
    if (!mobile) { closeModal("progress-modal"); return; }
    try {
      const startResp = await fetch(`${serverUrl}/api/publish/start`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobile })
      });
      const startData = await startResp.json();
      const proceed = async () => {
        if (target === "mock" || target === "both") await runTopinPublish(serverUrl, c, configId, "mock");
        if (target === "main" || target === "both") { if (target === "both") await new Promise(r => setTimeout(r, 1500)); await runTopinPublish(serverUrl, c, configId, "main"); }
      };
      if (startData.status === "already_authenticated") { await proceed(); }
      else if (startData.status === "otp_sent") {
        document.getElementById("otp-input").value = "";
        document.getElementById("otp-modal").classList.add("open");
        document.getElementById("otp-submit-btn").onclick = async () => { closeModal("otp-modal"); await proceed(); };
      } else { logProgress("error", startData.error || "Failed to start login"); finishProgress(false, "Login failed"); }
    } catch (e) { logProgress("error", e.message); finishProgress(false, "Connection error"); }
  };

  if (preselectedTarget) {
    openProgressModal("Publishing to Topin");
    await startAutomation(preselectedTarget);
  } else {
    openProgressModal("Publish to Topin", {
      showTargetPicker: true,
      targetOptions,
      onTarget: async (target) => startAutomation(target)
    });
  }
};

window.submitOTP = async () => {
  const otp = document.getElementById("otp-input").value.trim();
  const serverUrl = localStorage.getItem("topinServerUrl") || "http://localhost:3001";
  if (otp.length !== 6) { toast("Enter a valid 6-digit OTP", "error"); return; }
  const btn = document.getElementById("otp-submit-btn");
  btn.textContent = "Verifying..."; btn.disabled = true;
  try {
    const resp = await fetch(`${serverUrl}/api/publish/verify-otp`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ otp })
    });
    const data = await resp.json();
    if (data.status === "authenticated") closeModal("otp-modal");
    else toast("OTP verification failed: " + (data.error || "unknown"), "error");
  } catch (e) { toast("Error: " + e.message, "error"); }
  finally { btn.textContent = "Verify & Login"; btn.disabled = false; }
};

async function runTopinPublish(serverUrl, c, configId, target = "main") {
  const isMock = target === "mock";
  const label  = isMock ? "Mock Assessment" : "Main Assessment";
  logProgress("info", `Starting publish: ${label}...`);
  try {
    const resp = await fetch(`${serverUrl}/api/publish/run`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assessmentName: `${isMock ? "[MOCK] " : ""}${c.week}${c.phase ? " — " + c.phase : ""}${c.batch ? " " + c.batch : ""}`,
        assessmentDate: isMock ? (c.mock_assessment_date        || "") : (c.assessment_date        || ""),
        startTime:      isMock ? (c.mock_assessment_start_time  || "") : (c.assessment_start_time  || ""),
        endTime:        isMock ? (c.mock_assessment_end_time     || "") : (c.assessment_end_time     || ""),
        uniqueExamId:   `${configId}${isMock ? "_mock" : ""}`,
        accessType:     "Public"
      })
    });
    const data = await resp.json();
    if (data.status !== "started") { logProgress("error", data.error || "Start failed"); finishProgress(false, `${label} publish failed to start`); }
  } catch (e) { logProgress("error", e.message); finishProgress(false, "Connection error"); }
}

// ── Invite Students via /api/invite Vercel function ───────────
window.inviteStudents = async (configId) => {
  const c = allConfigs.find(x => x._id === configId);
  if (!c) return;
  if (!automationCreds.inviteEndpoint) {
    try {
      const snap = await getDocs(query(collection(db, "settings"), where("key", "==", "automation_creds")));
      if (!snap.empty) automationCreds = snap.docs[0].data().value || {};
    } catch {}
  }
  if (!automationCreds.inviteEndpoint || !automationCreds.inviteKey) {
    toast("Invite API credentials not configured. Open Credentials & Automation and fill in Invite API details.", "error");
    return;
  }

  openProgressModal("Inviting Students");
  logProgress("info", `Loading students for ${[c.phase, c.batch, c.week].filter(Boolean).join(" / ")}...`);

  let candidates = [];
  try {
    const snap = await getDocs(query(collection(db, "students"),
      where("phase", "==", c.phase || ""), where("batch", "==", c.batch || "")));
    candidates = snap.docs.map(d => d.data().uid).filter(Boolean);
  } catch (e) { logProgress("error", "Failed to load students: " + e.message); finishProgress(false, "Could not load student list"); return; }

  if (!candidates.length) { logProgress("error", "No students found for this phase/batch"); finishProgress(false, "No students to invite"); return; }
  logProgress("info", `Found ${candidates.length} students. Sending invites...`);

  const uuidMatch  = (c.config_link || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  const assessmentId = uuidMatch ? uuidMatch[0] : c.config_link;

  try {
    const resp = await fetch("/api/invite", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiEndpoint: automationCreds.inviteEndpoint, apiToken: automationCreds.inviteKey, candidates, assessmentId })
    });
    if (!resp.ok) { const err = await resp.json().catch(() => ({})); logProgress("error", err.error || resp.status); finishProgress(false, "Invite API error"); return; }
    const result = await resp.json();
    logProgress("info",    `Total: ${result.total}`);
    logProgress("success", `Sent:  ${result.sent} invites`);
    if (result.failed) logProgress("error", `Failed: ${result.failed}`);
    result.errors?.forEach(e => logProgress("error", e));
    if (result.sent > 0) {
      await updateDoc(doc(db, "configs", configId), { invites_sent: true, invites_sent_at: serverTimestamp(), invites_sent_by: currentUserEmail, invites_count: result.sent });
      const idx = allConfigs.findIndex(x => x._id === configId);
      if (idx >= 0) Object.assign(allConfigs[idx], { invites_sent: true, invites_sent_at: new Date() });
      renderAssessmentsTable();
      finishProgress(true, `✓ ${result.sent} invites sent successfully!`);
    } else {
      finishProgress(false, "No invites were sent. Check credentials and try again.");
    }
  } catch (e) { logProgress("error", e.message); finishProgress(false, "Network error"); }
};
