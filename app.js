// ============================================================
// CONFIGURATIE — vul dit in voordat je de app deelt
// ============================================================

// Stap 1: Maak een Firebase project op https://firebase.google.com
//         Ga naar Projectinstellingen → Voeg een web-app toe → kopieer de config hieronder
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCRnBMTM-sUEfmXm0mL_dA99e1r4M6a0r8",
  authDomain: "wk-poule-2026-97035.firebaseapp.com",
  databaseURL: "https://wk-poule-2026-97035-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "wk-poule-2026-97035",
  storageBucket: "wk-poule-2026-97035.firebasestorage.app",
  messagingSenderId: "58830027219",
  appId: "1:58830027219:web:646eaa06f5c31996985726"
};

// Stap 2: Registreer gratis op https://www.football-data.org/client/register
//         en plak je API token hier
const FOOTBALL_API_TOKEN = "bcd297bb8a1f480ab306363945ca07c1";

// Beheerderswachtwoord — verander dit naar iets wat jij wilt
const ADMIN_PASSWORD = "oranje2026";

// ============================================================
// INSTELLINGEN (hoef je normaal niet aan te passen)
// ============================================================

const SCORING = { exact: 3, outcome: 1, advancement: 2 }; // 2 pts per correct doorgekomt land
const DEADLINE = new Date("2026-06-11T17:00:00Z"); // Eerste wedstrijd WK 2026
const CACHE_KEY = "poule_matches_v1";
const RESULTS_CACHE_MINUTES = 30;

// ============================================================
// FIREBASE SETUP
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase, ref, set, get, update, push, onValue
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ============================================================
// APP STATE
// ============================================================

let db = null;
let currentUser = null;  // { id, name }
let matches = {};        // matchId -> match object
let unsubStandings = null;

// ============================================================
// INIT
// ============================================================

async function init() {
  if (!FIREBASE_CONFIG.apiKey || !FIREBASE_CONFIG.databaseURL) {
    showConfigError();
    return;
  }

  const firebaseApp = initializeApp(FIREBASE_CONFIG);
  db = getDatabase(firebaseApp);

  const saved = localStorage.getItem("poule_user");
  if (saved) {
    try {
      currentUser = JSON.parse(saved);
      setLoggedIn();
      await loadMatches();
      showView("standings");
    } catch {
      localStorage.removeItem("poule_user");
      showView("join");
    }
  } else {
    showView("join");
  }
}

function showConfigError() {
  document.querySelector("main").innerHTML = `
    <div class="card join-card">
      <div class="trophy">⚙️</div>
      <h2>Configuratie nodig</h2>
      <p>Vul je Firebase-gegevens en football-data.org token in in <code>app.js</code> voordat je de app gebruikt.</p>
      <p style="margin-top:1rem">Zie <strong>README.md</strong> voor instructies.</p>
    </div>`;
}

// ============================================================
// AUTH
// ============================================================

async function joinPoule() {
  const nameInput = document.getElementById("name-input");
  const errorEl = document.getElementById("join-error");
  const name = nameInput.value.trim();

  errorEl.classList.add("hidden");
  errorEl.textContent = "";

  if (!name) {
    errorEl.textContent = "Vul je naam in.";
    errorEl.classList.remove("hidden");
    return;
  }

  const btn = document.querySelector(".btn-primary");
  btn.disabled = true;
  btn.textContent = "Bezig...";

  try {
    const snap = await get(ref(db, "participants"));
    if (snap.exists()) {
      const participants = snap.val();
      const existing = Object.entries(participants).find(
        ([, p]) => p.name.toLowerCase() === name.toLowerCase()
      );
      if (existing) {
        currentUser = { id: existing[0], name: existing[1].name };
        localStorage.setItem("poule_user", JSON.stringify(currentUser));
        setLoggedIn();
        await loadMatches();
        showView("predictions");
        return;
      }
    }

    const newRef = push(ref(db, "participants"));
    await set(newRef, { name, joinedAt: Date.now() });
    currentUser = { id: newRef.key, name };
    localStorage.setItem("poule_user", JSON.stringify(currentUser));
    setLoggedIn();
    await loadMatches();
    showView("predictions");
  } catch (e) {
    console.error(e);
    if (e?.code?.startsWith("auth") || e?.message?.includes("permission") || e?.message?.includes("PERMISSION")) {
      errorEl.textContent = "Geen toegang tot de database. Controleer de Firebase-regels (testmodus aan?).";
    } else {
      errorEl.textContent = "Fout bij verbinden. Controleer je Firebase-instellingen.";
    }
    errorEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Meedoen →";
  }
}

function logout() {
  localStorage.removeItem("poule_user");
  currentUser = null;
  if (unsubStandings) { unsubStandings(); unsubStandings = null; }
  document.getElementById("main-nav").classList.add("hidden");
  showView("join");
}

function setLoggedIn() {
  document.getElementById("main-nav").classList.remove("hidden");
  document.getElementById("user-name").textContent = currentUser.name;
}

// ============================================================
// VIEWS
// ============================================================

function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  document.getElementById(`view-${name}`).classList.remove("hidden");
  if (name === "predictions") renderPredictions();
  if (name === "standings") renderStandings();
  if (name === "admin") {
    document.getElementById("admin-login").classList.remove("hidden");
    document.getElementById("admin-panel").classList.add("hidden");
    document.getElementById("admin-password-input").value = "";
    document.getElementById("admin-login-error").classList.add("hidden");
  }
}

// ============================================================
// MATCHES — laden en resultaten ophalen
// ============================================================

async function loadMatches() {
  // Wedstrijden en uitslagen worden bijgehouden via GitHub Actions → Firebase.
  // De browser leest alleen uit Firebase, zodat CORS geen probleem is.
  const matchesSnap = await get(ref(db, "matches"));
  if (matchesSnap.exists()) {
    matches = matchesSnap.val();
  }
  // Punten herberekenen als er nieuwe uitslagen zijn
  if (Object.keys(matches).length > 0) {
    recalculateAllStandings().catch(console.error);
  }
}

async function fetchMatchesFromAPI() {
  const res = await fetch(
    "https://api.football-data.org/v4/competitions/WC/matches",
    { headers: { "X-Auth-Token": FOOTBALL_API_TOKEN } }
  );
  if (!res.ok) {
    const msg = await res.text().catch(() => res.status);
    throw new Error(`API ${res.status}: ${msg}`);
  }
  const data = await res.json();

  if (!data.matches || data.matches.length === 0) {
    throw new Error("Geen wedstrijden gevonden in API-response");
  }

  // Houd alleen groepswedstrijden (stage bevat "GROUP")
  const groupMatches = data.matches.filter(m =>
    !m.stage || m.stage.includes("GROUP") || m.stage === "PRELIMINARY_ROUND"
  );

  const toStore = groupMatches.length > 0 ? groupMatches : data.matches;

  matches = {};
  for (const m of toStore) {
    matches[m.id] = {
      homeTeam: m.homeTeam.name,
      awayTeam: m.awayTeam.name,
      utcDate: m.utcDate,
      status: m.status,
      homeScore: m.score?.fullTime?.home ?? null,
      awayScore: m.score?.fullTime?.away ?? null,
      group: m.group ?? m.stage ?? "UNKNOWN"
    };
  }
  await set(ref(db, "matches"), matches);
}

// Uitslagen worden bijgewerkt via GitHub Actions (elke 30 min).
// Deze functie is niet meer nodig maar wordt bewaard als fallback.
async function refreshResults() {
  // no-op: zie .github/workflows/sync-matches.yml
}

// ============================================================
// PUNTEN BEREKENING
// ============================================================

function calcPoints(match, pred) {
  if (match.status !== "FINISHED") return null;
  if (pred?.home === "" || pred?.home === undefined || pred?.home === null) return null;
  const ph = parseInt(pred.home), pa = parseInt(pred.away);
  if (isNaN(ph) || isNaN(pa)) return null;

  if (ph === match.homeScore && pa === match.awayScore) return SCORING.exact;

  const realOutcome = Math.sign(match.homeScore - match.awayScore);
  const predOutcome = Math.sign(ph - pa);
  if (realOutcome === predOutcome) return SCORING.outcome;

  return 0;
}

// ============================================================
// VOORSPELLINGEN RENDEREN
// ============================================================

async function renderPredictions() {
  const container = document.getElementById("predictions-container");
  const locked = new Date() > DEADLINE;

  if (Object.keys(matches).length === 0) {
    container.innerHTML = "<p class='loading'>⏳ Wedstrijden laden...</p>";
    let loadError = null;
    try {
      await loadMatches();
    } catch (e) {
      loadError = e;
      console.warn(e);
    }
    if (Object.keys(matches).length === 0) {
      container.innerHTML = `
        <div class="notice" style="margin-top:1rem">
          ⚠️ De wedstrijden konden niet worden opgehaald.
          ${loadError ? `<br><small style="opacity:0.7">Fout: ${loadError.message}</small>` : ""}
          <ul style="margin-top:0.5rem;padding-left:1.2rem;line-height:1.8">
            <li>De football-data.org API heeft nog geen WK 2026 schema gepubliceerd</li>
            <li>Je API token is ongeldig of verlopen</li>
          </ul>
          <p style="margin-top:0.75rem">
            <button onclick="renderPredictions()" class="btn-secondary">🔄 Opnieuw proberen</button>
          </p>
        </div>`;
      return;
    }
  }

  const predSnap = await get(ref(db, `predictions/${currentUser.id}`));
  const existing = predSnap.exists() ? predSnap.val() : {};

  // Groepeer per ronde, daarbinnen per groep (alleen groepsfase)
  const stages = {};
  for (const [id, m] of Object.entries(matches)) {
    const s = m.stage || "GROUP_STAGE";
    if (!stages[s]) stages[s] = {};
    const key = (s === "GROUP_STAGE") ? (m.group || "UNKNOWN") : s;
    if (!stages[s][key]) stages[s][key] = [];
    stages[s][key].push({ id, ...m });
  }

  let html = "";

  if (locked) {
    html += `<div class="notice">⏰ De deadline is verstreken — voorspellingen zijn gesloten. Hieronder zie je jouw keuzes en de punten die je hebt gescoord.</div>`;
  }

  for (const stage of STAGE_ORDER) {
    if (!stages[stage]) continue;

    // Ronde-kop (alleen voor knockout)
    if (stage !== "GROUP_STAGE") {
      html += `<div class="stage-header">${STAGE_LABEL[stage] ?? stage}</div>`;
    }

    const subKeys = Object.keys(stages[stage]).sort();

    for (const key of subKeys) {
      const sectionMatches = [...stages[stage][key]].sort(
        (a, b) => new Date(a.utcDate) - new Date(b.utcDate)
      );

      let sectionLabel = "";
      if (stage === "GROUP_STAGE") {
        sectionLabel = key.replace("GROUP_", "Groep ");
      } else {
        sectionLabel = STAGE_LABEL[stage] ?? stage;
      }

      html += `<div class="group-section"><h3>${sectionLabel}</h3>`;

      for (const m of sectionMatches) {
        const pred = existing[m.id] ?? { home: "", away: "" };
        const pts = calcPoints(m, pred);
        const isFinished = m.status === "FINISHED";

        const metaHtml = isFinished
          ? `<span class="result">${m.homeScore}–${m.awayScore}</span>${
              pts !== null
                ? `<span class="badge badge-${pts}">${pts} pt${pts !== 1 ? "s" : ""}</span>`
                : ""
            }`
          : `<span class="date">${formatDate(m.utcDate)}</span>`;

        const scoreHtml = locked
          ? `<span class="pred-score ${pred.home === "" ? "empty" : ""}">
              ${pred.home !== "" ? `${pred.home}–${pred.away}` : "–"}
             </span>`
          : `<input type="number" min="0" max="20" value="${pred.home ?? ""}"
               data-match="${m.id}" data-side="home" />
             <span class="score-sep">–</span>
             <input type="number" min="0" max="20" value="${pred.away ?? ""}"
               data-match="${m.id}" data-side="away" />`;

        html += `
          <div class="match-row${isFinished ? " finished" : ""}">
            <div class="teams">
              <span class="team home">${m.homeTeam}</span>
              <div class="score-input">${scoreHtml}</div>
              <span class="team away">${m.awayTeam}</span>
            </div>
            <div class="match-meta">${metaHtml}</div>
          </div>`;
      }

      html += "</div>";
    }
  }

  // ── Doorkomst-sectie ──
  const teamsPerGroup = getTeamsPerGroup();
  const advancedActual = getActuallyAdvanced();
  const advancedSnap = await get(ref(db, `advancement/${currentUser.id}`));
  const savedAdvancement = advancedSnap.exists() ? advancedSnap.val() : {};

  const sortedGroupKeys = Object.keys(teamsPerGroup).sort();

  if (sortedGroupKeys.length > 0) {
    html += `<div class="stage-header">Welke landen komen door uit de groepsfase?</div>
    <div class="advancement-intro">
      Kies per groep de <strong>2 landen</strong> die jij denkt dat doorgaan naar de volgende ronde.
      Je krijgt <strong>${SCORING.advancement} punten</strong> per land dat je goed hebt.
    </div>`;

    for (const group of sortedGroupKeys) {
      const teams = teamsPerGroup[group];
      const groupLabel = group.replace("GROUP_", "Groep ");
      const savedForGroup = savedAdvancement[group] || [];

      html += `<div class="group-section">
        <h3>${groupLabel} — kies 2 landen</h3>
        <div class="advancement-grid" data-group="${group}">`;

      for (const team of teams) {
        const isSelected = savedForGroup.includes(team);
        const isAdvanced = advancedActual.has(team);
        const wasSelected = savedForGroup.includes(team);
        const known = advancedActual.size > 0;

        let badgeHtml = "";
        if (known) {
          if (isAdvanced && wasSelected) badgeHtml = `<span class="adv-badge adv-correct">✅ +${SCORING.advancement}pts</span>`;
          else if (isAdvanced) badgeHtml = `<span class="adv-badge adv-missed">➡️ doorgekomen</span>`;
          else if (wasSelected) badgeHtml = `<span class="adv-badge adv-wrong">✗ niet door</span>`;
        }

        html += `<label class="adv-team ${isSelected ? "selected" : ""} ${locked ? "locked" : ""}">
          <input type="checkbox" data-group="${group}" data-team="${team}"
            ${isSelected ? "checked" : ""} ${locked ? "disabled" : ""}
            onchange="updateAdvancementSelection(this)" />
          <span class="adv-team-name">${team}</span>
          ${badgeHtml}
        </label>`;
      }

      html += `</div></div>`;
    }
  }

  if (!locked) {
    html += `<button class="save-btn" id="save-btn" onclick="savePredictions()">💾 Voorspellingen opslaan</button>`;
  }

  container.innerHTML = html;
}

async function savePredictions() {
  const btn = document.getElementById("save-btn");
  btn.disabled = true;
  btn.textContent = "Opslaan...";

  // Scores opslaan
  const inputs = document.querySelectorAll("#predictions-container input[type=number]");
  const data = {};
  for (const input of inputs) {
    const matchId = input.dataset.match;
    const side = input.dataset.side;
    const val = input.value.trim();
    if (val !== "") {
      if (!data[matchId]) data[matchId] = {};
      data[matchId][side] = parseInt(val);
    }
  }

  // Doorkomst opslaan — max 2 per groep afdwingen
  const advData = {};
  const checkboxes = document.querySelectorAll("#predictions-container input[type=checkbox]");
  for (const cb of checkboxes) {
    const group = cb.dataset.group;
    const team = cb.dataset.team;
    if (cb.checked) {
      if (!advData[group]) advData[group] = [];
      advData[group].push(team);
    }
  }

  try {
    await Promise.all([
      set(ref(db, `predictions/${currentUser.id}`), data),
      set(ref(db, `advancement/${currentUser.id}`), advData)
    ]);
    await recalculateStandings(currentUser.id);
    btn.textContent = "✅ Opgeslagen!";
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = "💾 Voorspellingen opslaan";
    }, 2500);
  } catch (e) {
    btn.textContent = "❌ Fout — probeer opnieuw";
    btn.disabled = false;
    console.error(e);
  }
}

// Zorg dat er maximaal 2 landen per groep geselecteerd kunnen worden
function updateAdvancementSelection(checkbox) {
  const group = checkbox.dataset.group;
  const allInGroup = document.querySelectorAll(`input[type=checkbox][data-group="${group}"]`);
  const checked = [...allInGroup].filter(c => c.checked);
  if (checked.length > 2) {
    checkbox.checked = false;
    return;
  }
  // Update visuele staat
  allInGroup.forEach(cb => {
    cb.closest(".adv-team").classList.toggle("selected", cb.checked);
  });
}

// ============================================================
// STAND BEREKENEN
// ============================================================

async function recalculateAllStandings() {
  const snap = await get(ref(db, "participants"));
  if (!snap.exists()) return;
  await Promise.all(Object.keys(snap.val()).map(id => recalculateStandings(id)));
}

async function recalculateStandings(participantId) {
  const [predSnap, partSnap, advSnap] = await Promise.all([
    get(ref(db, `predictions/${participantId}`)),
    get(ref(db, `participants/${participantId}`)),
    get(ref(db, `advancement/${participantId}`))
  ]);
  if (!partSnap.exists()) return;

  const preds = predSnap.exists() ? predSnap.val() : {};
  const adv   = advSnap.exists()  ? advSnap.val()  : {};
  const name  = partSnap.val().name;

  let points = 0, exactCount = 0, outcomeCount = 0, advancementCount = 0;

  // Wedstrijd-punten
  for (const [matchId, m] of Object.entries(matches)) {
    const pts = calcPoints(m, preds[matchId]);
    if (pts === null) continue;
    points += pts;
    if (pts === SCORING.exact) exactCount++;
    else if (pts === SCORING.outcome) outcomeCount++;
  }

  // Doorkomst-punten (alleen als LAST_32 bekend is)
  const actualAdvanced = getActuallyAdvanced();
  if (actualAdvanced.size > 0) {
    for (const teams of Object.values(adv)) {
      for (const team of (teams || [])) {
        if (actualAdvanced.has(team)) {
          points += SCORING.advancement;
          advancementCount++;
        }
      }
    }
  }

  await set(ref(db, `standings/${participantId}`), {
    name, points, exactCount, outcomeCount, advancementCount, updatedAt: Date.now()
  });
}

// ============================================================
// STAND RENDEREN
// ============================================================

function renderStandings() {
  const container = document.getElementById("standings-container");

  if (unsubStandings) { unsubStandings(); }

  unsubStandings = onValue(ref(db, "standings"), (snap) => {
    if (!snap.exists()) {
      container.innerHTML = `<p class="loading">Nog geen standen — vul eerst je voorspellingen in.</p>`;
      return;
    }

    const rows = Object.values(snap.val())
      .sort((a, b) => b.points - a.points || b.exactCount - a.exactCount || b.outcomeCount - a.outcomeCount);

    const updatedAt = Math.max(...Object.values(snap.val()).map(r => r.updatedAt || 0));
    const lastUpdate = updatedAt ? `Bijgewerkt: ${formatDate(new Date(updatedAt).toISOString())}` : "";

    let html = `<div class="standings-meta">${lastUpdate}</div>
    <table class="standings-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Naam</th>
          <th title="Totaal punten">Punten</th>
          <th title="Exacte scores">✅ Exact</th>
          <th title="Juiste uitslag">✓ Uitslag</th>
          <th title="Landen doorkomst">🌍 Door</th>
        </tr>
      </thead>
      <tbody>`;

    rows.forEach((s, i) => {
      const isMe = s.name === currentUser?.name;
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}`;
      html += `<tr class="${isMe ? "me" : ""}">
        <td class="rank">${medal}</td>
        <td>${s.name}${isMe ? " 👈" : ""}</td>
        <td class="pts-cell">${s.points}</td>
        <td>${s.exactCount}</td>
        <td>${s.outcomeCount}</td>
        <td>${s.advancementCount ?? 0}</td>
      </tr>`;
    });

    html += "</tbody></table>";
    container.innerHTML = html;
  });
}

// ============================================================
// HELPERS
// ============================================================

// Haal alle teams per groep op uit de wedstrijddata
function getTeamsPerGroup() {
  const groups = {};
  for (const m of Object.values(matches)) {
    if (m.stage !== "GROUP_STAGE") continue;
    const g = m.group || "UNKNOWN";
    if (!groups[g]) groups[g] = new Set();
    if (m.homeTeam) groups[g].add(m.homeTeam);
    if (m.awayTeam) groups[g].add(m.awayTeam);
  }
  // Zet Sets om naar gesorteerde arrays
  const result = {};
  for (const [g, teams] of Object.entries(groups)) {
    result[g] = [...teams].sort();
  }
  return result;
}

// Haal op welke teams daadwerkelijk zijn doorgekomen (staan in LAST_32)
function getActuallyAdvanced() {
  const advanced = new Set();
  for (const m of Object.values(matches)) {
    if (m.stage !== "LAST_32") continue;
    if (m.homeTeam) advanced.add(m.homeTeam);
    if (m.awayTeam) advanced.add(m.awayTeam);
  }
  return advanced;
}

const STAGE_LABEL = {
  GROUP_STAGE:    "Groepsfase",
  LAST_32:        "Ronde van 32",
  LAST_16:        "Ronde van 16",
  QUARTER_FINALS: "Kwartfinales",
  SEMI_FINALS:    "Halve finales",
  THIRD_PLACE:    "Troostfinale",
  FINAL:          "Finale"
};

const STAGE_ORDER = [
  "GROUP_STAGE", "LAST_32", "LAST_16",
  "QUARTER_FINALS", "SEMI_FINALS", "THIRD_PLACE", "FINAL"
];

function formatDate(utcDate) {
  return new Date(utcDate).toLocaleString("nl-NL", {
    day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit",
    timeZone: "Europe/Amsterdam"
  });
}

// ============================================================
// BEHEER
// ============================================================

function adminLogin() {
  const input = document.getElementById("admin-password-input");
  const error = document.getElementById("admin-login-error");
  if (input.value === ADMIN_PASSWORD) {
    document.getElementById("admin-login").classList.add("hidden");
    document.getElementById("admin-panel").classList.remove("hidden");
    renderAdminPanel();
  } else {
    error.classList.remove("hidden");
    input.value = "";
  }
}

async function renderAdminPanel() {
  const container = document.getElementById("admin-participants-list");
  container.innerHTML = "<p class='loading'>Laden...</p>";

  const snap = await get(ref(db, "participants"));
  if (!snap.exists()) {
    container.innerHTML = "<p class='loading'>Geen deelnemers gevonden.</p>";
    return;
  }

  const participants = snap.val();
  let html = `<div class="admin-list">`;

  for (const [id, p] of Object.entries(participants).sort(([,a],[,b]) => a.name.localeCompare(b.name))) {
    html += `
      <div class="admin-row" id="admin-row-${id}">
        <span class="admin-name">${p.name}</span>
        <button class="btn-delete" onclick="deleteParticipant('${id}', '${p.name}')">🗑 Verwijderen</button>
      </div>`;
  }

  html += `</div>`;
  container.innerHTML = html;
}

async function deleteParticipant(id, name) {
  if (!confirm(`Weet je zeker dat je "${name}" wilt verwijderen? Dit verwijdert ook alle voorspellingen en punten van deze deelnemer.`)) return;

  try {
    // Verwijder uit participants, predictions en standings tegelijk
    const updates = {};
    updates[`participants/${id}`] = null;
    updates[`predictions/${id}`] = null;
    updates[`standings/${id}`] = null;
    await update(ref(db), updates);

    // Verwijder de rij uit de lijst
    document.getElementById(`admin-row-${id}`)?.remove();

    const container = document.getElementById("admin-participants-list");
    const rows = container.querySelectorAll(".admin-row");
    if (rows.length === 0) {
      container.innerHTML = "<p class='loading'>Geen deelnemers meer.</p>";
    }
  } catch (e) {
    alert("Fout bij verwijderen: " + e.message);
    console.error(e);
  }
}

// ============================================================
// GLOBALS (aangeroepen vanuit HTML onclick)
// ============================================================

window.showView = showView;
window.renderPredictions = renderPredictions;
window.joinPoule = joinPoule;
window.logout = logout;
window.savePredictions = savePredictions;
window.adminLogin = adminLogin;
window.deleteParticipant = deleteParticipant;
window.updateAdvancementSelection = updateAdvancementSelection;

init();
