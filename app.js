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

// ============================================================
// INSTELLINGEN (hoef je normaal niet aan te passen)
// ============================================================

const SCORING = { exact: 3, outcome: 1 };
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
}

// ============================================================
// MATCHES — laden en resultaten ophalen
// ============================================================

async function loadMatches() {
  const matchesSnap = await get(ref(db, "matches"));
  if (matchesSnap.exists()) {
    matches = matchesSnap.val();
  } else if (FOOTBALL_API_TOKEN) {
    try {
      await fetchMatchesFromAPI();
    } catch (e) {
      console.warn("Wedstrijden ophalen mislukt:", e);
    }
  }
  // Resultaten op de achtergrond bijwerken
  refreshResults().catch(console.error);
}

async function fetchMatchesFromAPI() {
  const res = await fetch(
    "https://api.football-data.org/v4/competitions/WC/matches?stage=GROUP_STAGE",
    { headers: { "X-Auth-Token": FOOTBALL_API_TOKEN } }
  );
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();

  matches = {};
  for (const m of data.matches) {
    matches[m.id] = {
      homeTeam: m.homeTeam.name,
      awayTeam: m.awayTeam.name,
      utcDate: m.utcDate,
      status: m.status,
      homeScore: m.score?.fullTime?.home ?? null,
      awayScore: m.score?.fullTime?.away ?? null,
      group: m.group ?? "UNKNOWN"
    };
  }
  await set(ref(db, "matches"), matches);
}

async function refreshResults() {
  if (!FOOTBALL_API_TOKEN) return;

  // Throttle: maximaal eens per X minuten echte API-call
  const lastFetch = parseInt(localStorage.getItem("poule_last_fetch") || "0");
  if (Date.now() - lastFetch < RESULTS_CACHE_MINUTES * 60 * 1000) return;

  try {
    const res = await fetch(
      "https://api.football-data.org/v4/competitions/WC/matches?status=FINISHED&stage=GROUP_STAGE",
      { headers: { "X-Auth-Token": FOOTBALL_API_TOKEN } }
    );
    if (!res.ok) return;
    const data = await res.json();

    const updates = {};
    let changed = false;

    for (const m of data.matches) {
      const h = m.score?.fullTime?.home;
      const a = m.score?.fullTime?.away;
      if (h === null || h === undefined) continue;

      const stored = matches[m.id];
      if (!stored || stored.homeScore !== h || stored.awayScore !== a) {
        updates[`matches/${m.id}/status`] = "FINISHED";
        updates[`matches/${m.id}/homeScore`] = h;
        updates[`matches/${m.id}/awayScore`] = a;
        if (matches[m.id]) {
          matches[m.id].status = "FINISHED";
          matches[m.id].homeScore = h;
          matches[m.id].awayScore = a;
        }
        changed = true;
      }
    }

    if (changed) {
      await update(ref(db), updates);
      await recalculateAllStandings();
    }

    localStorage.setItem("poule_last_fetch", String(Date.now()));
  } catch (e) {
    console.warn("Resultaten ophalen mislukt:", e);
  }
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
    return;
  }

  const predSnap = await get(ref(db, `predictions/${currentUser.id}`));
  const existing = predSnap.exists() ? predSnap.val() : {};

  // Groepeer per groep
  const groups = {};
  for (const [id, m] of Object.entries(matches)) {
    const g = m.group || "UNKNOWN";
    if (!groups[g]) groups[g] = [];
    groups[g].push({ id, ...m });
  }

  let html = "";

  if (locked) {
    html += `<div class="notice">⏰ De deadline is verstreken — voorspellingen zijn gesloten. Hieronder zie je jouw keuzes en de punten die je hebt gescoord.</div>`;
  }

  const sortedGroups = Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));

  for (const [group, groupMatches] of sortedGroups) {
    const label = group.replace("GROUP_", "Groep ");
    html += `<div class="group-section"><h3>${label}</h3>`;

    const sorted = [...groupMatches].sort(
      (a, b) => new Date(a.utcDate) - new Date(b.utcDate)
    );

    for (const m of sorted) {
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

  if (!locked) {
    html += `<button class="save-btn" id="save-btn" onclick="savePredictions()">💾 Voorspellingen opslaan</button>`;
  }

  container.innerHTML = html;
}

async function savePredictions() {
  const btn = document.getElementById("save-btn");
  btn.disabled = true;
  btn.textContent = "Opslaan...";

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

  try {
    await set(ref(db, `predictions/${currentUser.id}`), data);
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

// ============================================================
// STAND BEREKENEN
// ============================================================

async function recalculateAllStandings() {
  const snap = await get(ref(db, "participants"));
  if (!snap.exists()) return;
  await Promise.all(Object.keys(snap.val()).map(id => recalculateStandings(id)));
}

async function recalculateStandings(participantId) {
  const [predSnap, partSnap] = await Promise.all([
    get(ref(db, `predictions/${participantId}`)),
    get(ref(db, `participants/${participantId}`))
  ]);
  if (!partSnap.exists()) return;

  const preds = predSnap.exists() ? predSnap.val() : {};
  const name = partSnap.val().name;
  let points = 0, exactCount = 0, outcomeCount = 0;

  for (const [matchId, m] of Object.entries(matches)) {
    const pts = calcPoints(m, preds[matchId]);
    if (pts === null) continue;
    points += pts;
    if (pts === SCORING.exact) exactCount++;
    else if (pts === SCORING.outcome) outcomeCount++;
  }

  await set(ref(db, `standings/${participantId}`), {
    name, points, exactCount, outcomeCount, updatedAt: Date.now()
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
      </tr>`;
    });

    html += "</tbody></table>";
    container.innerHTML = html;
  });
}

// ============================================================
// HELPERS
// ============================================================

function formatDate(utcDate) {
  return new Date(utcDate).toLocaleString("nl-NL", {
    day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit",
    timeZone: "Europe/Amsterdam"
  });
}

// ============================================================
// GLOBALS (aangeroepen vanuit HTML onclick)
// ============================================================

window.showView = showView;
window.joinPoule = joinPoule;
window.logout = logout;
window.savePredictions = savePredictions;

init();
