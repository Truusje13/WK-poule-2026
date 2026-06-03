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

const SCORING = {
  exact: 5,          // exacte uitslag
  outcome: 3,        // juiste winnaar of gelijkspel
  advancement: 2,    // land correct in top 2 groep
  position: 2,       // land ook op juiste positie (1e of 2e)
  third: 2,          // correct voorspeld als nummer 3 in de groep
  thirdAdvance: 2,   // dat land gaat ook echt door als beste nummer 3
  penalty: 3,        // correct voorspelde penalty-winnaar
  round: {           // bonus per correct voorspelde winnaar in knockoutronde
    LAST_32:        3,
    LAST_16:        5,
    QUARTER_FINALS: 10,
    SEMI_FINALS:    20,
    FINAL:          30,
    CHAMPION:       50
  }
};
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

  let pts = 0;

  // Exacte score
  if (ph === match.homeScore && pa === match.awayScore) {
    pts += SCORING.exact;
  } else {
    const realOutcome = Math.sign(match.homeScore - match.awayScore);
    const predOutcome = Math.sign(ph - pa);
    if (realOutcome === predOutcome) pts += SCORING.outcome;
  }

  // Penalty-bonus: alleen in knockoutronden bij een gelijkspel
  const isKnockout = match.stage && match.stage !== "GROUP_STAGE";
  const wentToPenalties = match.penaltyHome !== null && match.penaltyHome !== undefined;
  if (isKnockout && wentToPenalties && pred.penalty && pred.penaltyWinner) {
    const actualWinner = match.penaltyHome > match.penaltyAway ? "home" : "away";
    if (pred.penaltyWinner === actualWinner) pts += SCORING.penalty;
  }

  return pts > 0 ? pts : 0;
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

  const [predSnap, thirdPlaceSnap, thirdAdvSnap2] = await Promise.all([
    get(ref(db, `predictions/${currentUser.id}`)),
    get(ref(db, `thirdplace/${currentUser.id}`)),
    get(ref(db, `thirdadvance/${currentUser.id}`)),
  ]);
  const existing        = predSnap.exists()       ? predSnap.val()       : {};
  const thirdPlaceData  = thirdPlaceSnap.exists()  ? thirdPlaceSnap.val() : {};
  const thirdAdvData    = thirdAdvSnap2.exists()   ? thirdAdvSnap2.val()  : [];

  // Groepeer per ronde, daarbinnen per groep (alleen groepsfase)
  const stages = {};
  for (const [id, m] of Object.entries(matches)) {
    const s = m.stage || "GROUP_STAGE";
    if (!stages[s]) stages[s] = {};
    const key = (s === "GROUP_STAGE") ? (m.group || "UNKNOWN") : s;
    if (!stages[s][key]) stages[s][key] = [];
    stages[s][key].push({ id, ...m });
  }

  // Bereken voorspelde groepsstand voor bracket-opvulling
  const { standings: predictedStandings, teamStats: predictedTeamStats } = calculatePredictedGroupData(existing);
  // Bereken 1-op-1 toewijzing van de 8 geselecteerde nummer-3 landen aan de bracket-slots
  const thirdAssignment = computeThirdAssignment(thirdAdvData, predictedStandings);

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

        // Teamnamen bepalen — eerst API, dan bracket-resolutie uit voorspellingen
        let homeLabel = m.homeTeam ? t(m.homeTeam) : null;
        let awayLabel = m.awayTeam ? t(m.awayTeam) : null;
        let isPreliminary = false;

        if (!homeLabel || !awayLabel) {
          if (LAST_32_BRACKET[m.id]) {
            // Last 32: uit groepsstand + nummer-3 selectie
            const slot = LAST_32_BRACKET[m.id];
            if (!homeLabel) {
              const { team, preliminary } = resolveBracketSlot(slot.home, predictedStandings, predictedTeamStats, m.id, "home", thirdAssignment);
              homeLabel = team ? `<span class="predicted-name">${t(team)}</span>` : "?";
              if (preliminary) isPreliminary = true;
            }
            if (!awayLabel) {
              const { team, preliminary } = resolveBracketSlot(slot.away, predictedStandings, predictedTeamStats, m.id, "away", thirdAssignment);
              awayLabel = team ? `<span class="predicted-name">${t(team)}</span>` : "?";
              if (preliminary) isPreliminary = true;
            }
          } else if (KNOCKOUT_BRACKET[m.id]) {
            // Last 16 en verder: uit winnaar/verliezer van eerdere wedstrijden
            const b = KNOCKOUT_BRACKET[m.id];
            if (!homeLabel) {
              const team = resolveRoundTeam(b.home.source, b.home.winner, existing, thirdAssignment, predictedStandings, predictedTeamStats);
              homeLabel = team ? `<span class="predicted-name">${t(team)}</span>` : "?";
              if (team) isPreliminary = true;
            }
            if (!awayLabel) {
              const team = resolveRoundTeam(b.away.source, b.away.winner, existing, thirdAssignment, predictedStandings, predictedTeamStats);
              awayLabel = team ? `<span class="predicted-name">${t(team)}</span>` : "?";
              if (team) isPreliminary = true;
            }
          }
        }
        homeLabel = homeLabel || "?";
        awayLabel = awayLabel || "?";

        const isKnockout = m.stage && m.stage !== "GROUP_STAGE";
        const hasPenalty = isKnockout && (pred.penalty || m.penaltyHome != null);
        const penaltyWinner = pred.penaltyWinner ?? null;
        const actualPenWinner = (m.penaltyHome != null)
          ? (m.penaltyHome > m.penaltyAway ? "home" : "away") : null;

        let penaltyHtml = "";
        if (isKnockout && !locked) {
          penaltyHtml = `
            <div class="penalty-row" id="pen-row-${m.id}">
              <label class="penalty-toggle">
                <input type="checkbox" data-match="${m.id}" data-type="penalty"
                  ${pred.penalty ? "checked" : ""}
                  onchange="togglePenaltyWinner(this)" />
                🥅 Na penalty's
              </label>
              <div class="penalty-winner ${pred.penalty ? "" : "hidden"}" id="pen-winner-${m.id}">
                <span class="pen-label">Wie wint?</span>
                <button class="pen-btn ${penaltyWinner === "home" ? "selected" : ""}"
                  data-match="${m.id}" data-side="home"
                  onclick="selectPenaltyWinner(this)">${homeLabel?.replace(/<[^>]*>/g,"") || "Thuis"}</button>
                <button class="pen-btn ${penaltyWinner === "away" ? "selected" : ""}"
                  data-match="${m.id}" data-side="away"
                  onclick="selectPenaltyWinner(this)">${awayLabel?.replace(/<[^>]*>/g,"") || "Uit"}</button>
              </div>
            </div>`;
        } else if (isKnockout && locked && hasPenalty) {
          const winnerName = penaltyWinner === "home"
            ? (m.homeTeam ? t(m.homeTeam) : "thuis")
            : penaltyWinner === "away"
              ? (m.awayTeam ? t(m.awayTeam) : "uit")
              : "–";
          const correct = actualPenWinner && penaltyWinner === actualPenWinner;
          const wrong   = actualPenWinner && penaltyWinner && penaltyWinner !== actualPenWinner;
          penaltyHtml = `<div class="penalty-row locked-pen">
            🥅 Penalty-winnaar: <strong>${winnerName}</strong>
            ${correct ? `<span class="adv-badge adv-correct">✅ +${SCORING.penalty}pts</span>` : ""}
            ${wrong   ? `<span class="adv-badge adv-wrong">✗</span>` : ""}
          </div>`;
        }

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
          <div class="match-row${isFinished ? " finished" : ""}${isKnockout ? " knockout-row" : ""}${isPreliminary ? " preliminary" : ""}">
            <div class="teams">
              <span class="team home">${homeLabel}</span>
              <div class="score-input">${scoreHtml}</div>
              <span class="team away">${awayLabel}</span>
            </div>
            <div class="match-meta">
              ${isPreliminary ? `<span class="preliminary-badge">voorlopig</span>` : ""}
              ${metaHtml}
            </div>
            ${penaltyHtml}
          </div>`;
      }

      html += "</div>";

      // Na elke knockoutronde een doorkomst-blok invoegen
      if (stage !== "GROUP_STAGE" && stage !== "FINAL" && stage !== "THIRD_PLACE") {
        const nextIdx = STAGE_ORDER.indexOf(stage) + 1;
        const nextStage = STAGE_ORDER[nextIdx];
        if (nextStage) {
          html += `<div class="predicted-knockout-block">
            <div class="predicted-ko-title">↓ Voorspelde doorkomst naar de ${STAGE_LABEL[nextStage] ?? nextStage}</div>
            <div class="predicted-ko-teams" id="adv-teams-${stage}">
              <span class="predicted-empty">Vul scores in om de doorkomst te zien.</span>
            </div>
          </div>`;
        }
      }
    }

    // Na groep L (einde groepsfase): nummer-3 overzicht en doorkomst
    if (stage === "GROUP_STAGE") {
      const sortedGroupsAll  = Object.keys(getTeamsPerGroup()).sort();
      const actualThirdsAll  = calculateGroupStandings();
      const actualAdvAll     = getActualAdvancingThirds();

      html += `<div class="stage-header">Nummers 3 &amp; doorkomst</div>
      <div class="advancement-intro">
        Op basis van jouw ingevulde groepsscores komen dit de nummers 3.
        Kies welke <strong>8 van de 12</strong> doorgaan.
        <strong>+${SCORING.third} punten</strong> per correct nummer 3 •
        <strong>+${SCORING.thirdAdvance} punten</strong> als dat land ook echt doorkomt.
      </div>`;

      // Toon de 12 nummers 3 (automatisch berekend) als kaartjes
      html += `<div id="third-grid" class="third-grid"></div>`;

      // Doorkomst-selectie (welke 8 gaan door)
      html += `<div class="third-advance-section">
        <div class="third-advance-title">Welke 8 van de 12 nummers 3 gaan door?</div>
        <div class="third-advance-intro">
          Selecteer op basis van de nummers 3 hierboven. Maximaal 8 landen.
        </div>
        <div class="third-advance-grid" id="third-advance-grid">`;

      for (const group of sortedGroupsAll) {
        // Gebruik de berekende 3e uit opgeslagen voorspellingen als startwaarde
        const predicted3rd = predictedStandings[group]?.[2] ?? null;
        if (!predicted3rd) continue;
        const isSelected  = thirdAdvData.includes(predicted3rd);
        const groupLabel  = group.replace("GROUP_", "Groep ");
        const advActual   = actualAdvAll.has(predicted3rd);
        const actualThird = actualThirdsAll[group]?.[2];
        const known       = !!actualThird;

        let badge = "";
        if (known) {
          if (advActual && isSelected) badge = `<span class="adv-badge adv-correct" style="font-size:0.7rem">✅</span>`;
          else if (advActual)          badge = `<span class="adv-badge adv-good" style="font-size:0.7rem">➡️</span>`;
          else if (isSelected)         badge = `<span class="adv-badge adv-wrong" style="font-size:0.7rem">✗</span>`;
        }

        html += locked
          ? `<div class="third-adv-team ${isSelected ? "selected" : ""}">
              <span>${groupLabel}: <em>${t(predicted3rd)}</em></span>${badge}
             </div>`
          : `<label class="third-adv-team ${isSelected ? "selected" : ""}">
              <input type="checkbox" class="third-adv-cb" data-team="${predicted3rd}"
                ${isSelected ? "checked" : ""}
                onchange="updateThirdAdvCount()" />
              <span>${groupLabel}: <em>${t(predicted3rd)}</em></span>${badge}
             </label>`;
      }

      html += `</div>
        <div class="third-adv-count" id="third-adv-count"></div>
      </div>`;
    }
  }

  // Groepsfase doorkomst-overzicht
  html += `
    <div class="stage-header">Jouw voorspelde doorkomst naar de Last 32</div>
    <div class="predicted-advancement-intro">
      Op basis van jouw ingevulde groepsscores komen deze landen door.
      Wordt automatisch bijgewerkt terwijl je scores invult.
    </div>
    <div id="predicted-advancement-grid" class="predicted-grid"></div>`;

  if (!locked) {
    html += `<button class="save-btn" id="save-btn" onclick="savePredictions()">💾 Voorspellingen opslaan</button>`;
  }

  container.innerHTML = html;

  // Initialiseer tellers en overzichten
  updateThirdAdvCount();
  updatePredictedAdvancement();

  let autoSaveTimer = null;
  container.querySelectorAll("input[type=number]").forEach(input => {
    input.addEventListener("input", () => {
      updatePredictedAdvancement();
      updateKnockoutTeamLabels();
      // Auto-opslaan: 2 seconden na de laatste invoer
      clearTimeout(autoSaveTimer);
      showAutoSaveStatus("⏳ Wordt opgeslagen...");
      autoSaveTimer = setTimeout(() => autoSave(), 2000);
    });
  });
}

function showAutoSaveStatus(msg) {
  const btn = document.getElementById("save-btn");
  if (btn) btn.textContent = msg;
}

function collectPredictionData() {
  const data = {};
  // Score-invoer
  document.querySelectorAll("#predictions-container input[type=number]").forEach(input => {
    const matchId = input.dataset.match;
    const side    = input.dataset.side;
    const val     = input.value.trim();
    if (val !== "") {
      if (!data[matchId]) data[matchId] = {};
      data[matchId][side] = parseInt(val);
    }
  });
  // Penalty-invoer
  document.querySelectorAll("#predictions-container input[type=checkbox][data-type='penalty']").forEach(cb => {
    const matchId = cb.dataset.match;
    if (!data[matchId]) data[matchId] = {};
    data[matchId].penalty = cb.checked;
    if (cb.checked) {
      const selectedBtn = document.querySelector(`.pen-btn.selected[data-match="${matchId}"]`);
      data[matchId].penaltyWinner = selectedBtn?.dataset.side ?? null;
    }
  });
  return data;
}

function collectThirdPlaceData() {
  const thirdplace = {};
  document.querySelectorAll(".third-select").forEach(sel => {
    if (sel.value) thirdplace[sel.dataset.group] = sel.value;
  });

  const thirdadvance = [];
  document.querySelectorAll(".third-adv-cb:checked").forEach(cb => {
    thirdadvance.push(cb.dataset.team);
  });

  return { thirdplace, thirdadvance };
}

async function autoSave() {
  const inputs = document.querySelectorAll("#predictions-container input[type=number]");
  if (inputs.length === 0) return;

  const data = collectPredictionData();

  const { thirdplace, thirdadvance } = collectThirdPlaceData();
  try {
    await Promise.all([
      set(ref(db, `predictions/${currentUser.id}`), data),
      set(ref(db, `thirdplace/${currentUser.id}`), thirdplace),
      set(ref(db, `thirdadvance/${currentUser.id}`), thirdadvance),
    ]);
    await recalculateStandings(currentUser.id);
    showAutoSaveStatus("✅ Automatisch opgeslagen");
    setTimeout(() => showAutoSaveStatus("💾 Voorspellingen opslaan"), 3000);
  } catch (e) {
    showAutoSaveStatus("❌ Opslaan mislukt — probeer handmatig");
    console.error(e);
  }
}

function readCurrentPreds() {
  const currentPreds = {};
  document.querySelectorAll("#predictions-container input[type=number]").forEach(input => {
    const matchId = input.dataset.match;
    const side    = input.dataset.side;
    const val     = input.value.trim();
    if (val !== "") {
      if (!currentPreds[matchId]) currentPreds[matchId] = {};
      currentPreds[matchId][side] = parseInt(val);
    }
  });
  return currentPreds;
}

function readCurrentThirdAdvData() {
  const selected = [];
  document.querySelectorAll(".third-adv-cb:checked").forEach(cb => {
    if (cb.dataset.team) selected.push(cb.dataset.team);
  });
  return selected;
}

function updateKnockoutTeamLabels() {
  const currentPreds    = readCurrentPreds();
  const currentThirdAdv = readCurrentThirdAdvData();
  const { standings: predicted, teamStats } = calculatePredictedGroupData(currentPreds);
  const currentThirdAssignment = computeThirdAssignment(currentThirdAdv, predicted);

  // Update alle knockout match-rijen met voorspelde teamnamen
  const resolveCache = {};
  document.querySelectorAll(".match-row").forEach(row => {
    const inputs = row.querySelectorAll("input[data-match]");
    if (inputs.length === 0) return;
    const matchId = inputs[0]?.dataset.match;
    if (!matchId) return;

    const m = matches[matchId];
    if (!m || (m.homeTeam && m.awayTeam)) return; // al ingevuld via API

    const homeEl = row.querySelector(".team.home");
    const awayEl = row.querySelector(".team.away");

    if (LAST_32_BRACKET[matchId]) {
      const slot = LAST_32_BRACKET[matchId];
      if (homeEl) {
        const { team } = resolveBracketSlot(slot.home, predicted, teamStats, matchId, "home", currentThirdAssignment);
        homeEl.innerHTML = team ? `<span class="predicted-name">${t(team)}</span>` : "?";
      }
      if (awayEl) {
        const { team } = resolveBracketSlot(slot.away, predicted, teamStats, matchId, "away", currentThirdAssignment);
        awayEl.innerHTML = team ? `<span class="predicted-name">${t(team)}</span>` : "?";
      }
    } else if (KNOCKOUT_BRACKET[matchId]) {
      const b = KNOCKOUT_BRACKET[matchId];
      const currentPredsFull = readCurrentPreds();
      if (homeEl) {
        const team = resolveRoundTeam(b.home.source, b.home.winner, currentPredsFull, currentThirdAssignment, predicted, teamStats, resolveCache);
        homeEl.innerHTML = team ? `<span class="predicted-name">${t(team)}</span>` : "?";
      }
      if (awayEl) {
        const team = resolveRoundTeam(b.away.source, b.away.winner, currentPredsFull, currentThirdAssignment, predicted, teamStats, resolveCache);
        awayEl.innerHTML = team ? `<span class="predicted-name">${t(team)}</span>` : "?";
      }
    }
  });
}

function updatePredictedAdvancement() {
  const currentPreds  = readCurrentPreds();
  const actual        = getActuallyAdvanced();

  // ── Nummer-3 kaartjes bijwerken ──
  const thirdGrid = document.getElementById("third-grid");
  if (thirdGrid) {
    const sortedG = Object.keys(currentPreds.length !== undefined ? {} : calculatePredictedGroupData(currentPreds).standings).sort();
    const { standings: st3 } = calculatePredictedGroupData(currentPreds);
    const allGroups = Object.keys(getTeamsPerGroup()).sort();
    let thirdHtml = "";
    for (const group of allGroups) {
      const label = group.replace("GROUP_", "Groep ");
      const team  = st3[group]?.[2];
      thirdHtml += `<div class="predicted-group">
        <div class="predicted-group-label">${label}</div>
        <div class="predicted-team">
          <span class="pred-pos">3️⃣</span>
          <span class="pred-name">${team ? `<em>${t(team)}</em>` : "<span style='color:#bbb'>– nog niet bepaald</span>"}</span>
        </div>
      </div>`;
    }
    thirdGrid.innerHTML = thirdHtml;

    // Sync doorkomst-knoppen met actuele nummers 3
    document.querySelectorAll(".third-adv-cb").forEach(cb => {
      const team    = cb.dataset.team;
      const newTeam = Object.values(st3).map(s => s[2]).find(t3 => t3 === team);
      // Alleen zichtbaar als team nog steeds een nummer 3 is
      cb.closest("label")?.classList.toggle("hidden-team", !newTeam);
    });
  }

  // ── Groepsfase: top 2 per groep ──
  const grid = document.getElementById("predicted-advancement-grid");
  if (grid) {
    const predicted    = calculatePredictedGroupStandings(currentPreds);
    const sortedGroups = Object.keys(predicted).sort();

    if (sortedGroups.length === 0) {
      grid.innerHTML = `<p class="predicted-empty">Vul groepsscores in om de doorkomst te zien.</p>`;
    } else {
      let html = "";
      for (const group of sortedGroups) {
        const label = group.replace("GROUP_", "Groep ");
        const top2  = predicted[group].slice(0, 2);
        html += `<div class="predicted-group"><div class="predicted-group-label">${label}</div>`;
        for (let i = 0; i < 2; i++) {
          const team    = top2[i];
          const pos     = i === 0 ? "🥇" : "🥈";
          const correct = actual.size > 0 && team && actual.has(team);
          const wrong   = actual.size > 0 && team && !actual.has(team);
          html += team
            ? `<div class="predicted-team ${correct ? "correct" : wrong ? "wrong" : ""}">
                <span class="pred-pos">${pos}</span>
                <span class="pred-name">${t(team)}</span>
                ${correct ? `<span class="pred-check">✅</span>` : wrong ? `<span class="pred-check">✗</span>` : ""}
               </div>`
            : `<div class="predicted-team empty">– nog niet bepaald</div>`;
        }
        html += `</div>`;
      }
      grid.innerHTML = html;
    }
  }

  // ── Knockoutronden: winnaar per wedstrijd ──
  const knockoutStages = ["LAST_32", "LAST_16", "QUARTER_FINALS", "SEMI_FINALS"];
  for (const stage of knockoutStages) {
    const container = document.getElementById(`adv-teams-${stage}`);
    if (!container) continue;

    // Haal alle wedstrijden van deze ronde op
    const stageMatches = Object.entries(matches)
      .filter(([, m]) => m.stage === stage)
      .sort(([, a], [, b]) => new Date(a.utcDate) - new Date(b.utcDate));

    if (stageMatches.length === 0) { continue; }

    // Check of teams al bekend zijn (niet null)
    const teamsKnown = stageMatches.some(([, m]) => m.homeTeam && m.awayTeam);
    if (!teamsKnown) {
      container.innerHTML = `<span class="predicted-empty">Wordt ingevuld nadat de vorige ronde gespeeld is.</span>`;
      continue;
    }

    const winners = [];
    for (const [matchId, m] of stageMatches) {
      if (!m.homeTeam || !m.awayTeam) continue;
      const pred = currentPreds[matchId];
      if (!pred || pred.home === undefined || pred.away === undefined) {
        winners.push({ team: null, label: `${t(m.homeTeam)} vs ${t(m.awayTeam)}` });
        continue;
      }
      const ph = parseInt(pred.home), pa = parseInt(pred.away);
      if (isNaN(ph) || isNaN(pa) || ph === pa) {
        // Gelijkspel in knockout = geen winnaar bepaald
        winners.push({ team: null, label: `${t(m.homeTeam)} vs ${t(m.awayTeam)} (gelijkspel?)` });
      } else {
        const winner = ph > pa ? m.homeTeam : m.awayTeam;
        // Vergelijk met werkelijke uitslag als die er is
        const correct = m.status === "FINISHED" && m.homeScore !== null
          ? (m.homeScore > m.awayScore ? m.homeTeam : m.awayTeam) === winner
          : null;
        winners.push({ team: winner, correct });
      }
    }

    let html = `<div class="predicted-ko-list">`;
    for (const { team, label, correct } of winners) {
      if (!team) {
        html += `<span class="pred-ko-team empty">${label ?? "– vul score in"}</span>`;
      } else {
        const cls = correct === true ? "correct" : correct === false ? "wrong" : "";
        html += `<span class="pred-ko-team ${cls}">
          ${correct === true ? "✅" : correct === false ? "✗" : "→"} ${t(team)}
        </span>`;
      }
    }
    html += `</div>`;
    container.innerHTML = html;
  }
}

async function savePredictions() {
  const btn = document.getElementById("save-btn");
  btn.disabled = true;
  btn.textContent = "Opslaan...";

  const data = collectPredictionData();

  const { thirdplace, thirdadvance } = collectThirdPlaceData();
  try {
    await Promise.all([
      set(ref(db, `predictions/${currentUser.id}`), data),
      set(ref(db, `thirdplace/${currentUser.id}`), thirdplace),
      set(ref(db, `thirdadvance/${currentUser.id}`), thirdadvance),
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


// ============================================================
// STAND BEREKENEN
// ============================================================

async function recalculateAllStandings() {
  const snap = await get(ref(db, "participants"));
  if (!snap.exists()) return;
  await Promise.all(Object.keys(snap.val()).map(id => recalculateStandings(id)));
}

async function recalculateStandings(participantId) {
  const [predSnap, partSnap, thirdSnap, thirdAdvSnap] = await Promise.all([
    get(ref(db, `predictions/${participantId}`)),
    get(ref(db, `participants/${participantId}`)),
    get(ref(db, `thirdplace/${participantId}`)),
    get(ref(db, `thirdadvance/${participantId}`)),
  ]);
  if (!partSnap.exists()) return;

  const preds       = predSnap.exists()    ? predSnap.val()    : {};
  const thirdPreds  = thirdSnap.exists()   ? thirdSnap.val()   : {};
  const thirdAdvPreds = thirdAdvSnap.exists() ? thirdAdvSnap.val() : [];
  const name        = partSnap.val().name;

  let points = 0, exactCount = 0, outcomeCount = 0, advancementPts = 0, roundBonusPts = 0, thirdPts = 0;

  // ── 1. Wedstrijd-punten + knockout-rondebonus ──
  for (const [matchId, m] of Object.entries(matches)) {
    const pts = calcPoints(m, preds[matchId]);
    if (pts === null) continue;
    points += pts;
    if (pts === SCORING.exact) exactCount++;
    else if (pts === SCORING.outcome) outcomeCount++;

    // Bonus voor correct voorspelde winnaar in knockoutronden
    if (pts > 0 && m.stage && m.stage !== "GROUP_STAGE") {
      const pred = preds[matchId];
      const predH = parseInt(pred?.home), predA = parseInt(pred?.away);
      const predOutcome = Math.sign(predH - predA);
      const realOutcome = Math.sign(m.homeScore - m.awayScore);
      if (predOutcome === realOutcome && realOutcome !== 0) {
        // Correct winnaar voorspeld
        const bonus = SCORING.round[m.stage] ?? 0;
        points      += bonus;
        roundBonusPts += bonus;
        // Extra bonus voor correct voorspelde wereldkampioen (winnaar finale)
        if (m.stage === "FINAL") {
          points        += SCORING.round.CHAMPION;
          roundBonusPts += SCORING.round.CHAMPION;
        }
      }
    }
  }

  // ── 2. Doorkomst groepsfase ──
  // Berekend automatisch uit de voorspelde scores
  const actualAdvanced    = getActuallyAdvanced();
  const actualStandings   = calculateGroupStandings();
  const predictedStandings = calculatePredictedGroupStandings(preds);

  if (actualAdvanced.size > 0) {
    for (const [group, predictedOrder] of Object.entries(predictedStandings)) {
      const actual1 = actualStandings[group]?.[0] ?? null;
      const actual2 = actualStandings[group]?.[1] ?? null;

      // Top 2 uit de voorspelde stand
      const pred1 = predictedOrder[0] ?? null;
      const pred2 = predictedOrder[1] ?? null;

      for (const [idx, predTeam] of [[0, pred1], [1, pred2]]) {
        if (!predTeam || !actualAdvanced.has(predTeam)) continue;
        // Correct doorgekomt
        points         += SCORING.advancement;
        advancementPts += SCORING.advancement;
        // Bonus voor juiste positie (1e of 2e)
        const predPos   = idx === 0 ? 1 : 2;
        const actualPos = predTeam === actual1 ? 1 : predTeam === actual2 ? 2 : null;
        if (actualPos && predPos === actualPos) {
          points         += SCORING.position;
          advancementPts += SCORING.position;
        }
      }
    }
  }

  // ── 3. Nummer-3 punten ──
  // Voorspelde 3e plaatsers komen uit de score-voorspellingen, niet uit aparte dropdown
  const predictedGroupStandings3 = calculatePredictedGroupStandings(preds);
  const actualGroupStand         = calculateGroupStandings();
  const actualAdvThirds          = getActualAdvancingThirds();

  if (Object.keys(actualGroupStand).length > 0) {
    for (const [group, actualOrder] of Object.entries(actualGroupStand)) {
      const actualThird    = actualOrder[2];
      const predictedThird = predictedGroupStandings3[group]?.[2];
      if (!actualThird || !predictedThird) continue;
      if (predictedThird === actualThird) {
        points   += SCORING.third;
        thirdPts += SCORING.third;
        // Extra als dit land ook echt doorkomt én in jouw doorkomst-lijstje staat
        if (actualAdvThirds.has(actualThird) && thirdAdvPreds.includes(predictedThird)) {
          points   += SCORING.thirdAdvance;
          thirdPts += SCORING.thirdAdvance;
        }
      }
    }
  }

  await set(ref(db, `standings/${participantId}`), {
    name, points, exactCount, outcomeCount, advancementPts, roundBonusPts, thirdPts, updatedAt: Date.now()
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
          <th title="Doorkomst & positie">🌍 Door</th>
          <th title="Knockout rondebonus">🏆 Bonus</th>
          <th title="Nummer 3 voorspellingen">3️⃣ Nr3</th>
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
        <td>${s.advancementPts ?? 0}</td>
        <td>${s.roundBonusPts ?? 0}</td>
        <td>${s.thirdPts ?? 0}</td>
      </tr>`;
    });

    html += "</tbody></table>";
    container.innerHTML = html;
  });
}

// ============================================================
// HELPERS
// ============================================================

// Teams per groep ophalen uit de wedstrijddata
function getTeamsPerGroup() {
  const groups = {};
  for (const m of Object.values(matches)) {
    if (m.stage !== "GROUP_STAGE") continue;
    const g = m.group || "UNKNOWN";
    if (!groups[g]) groups[g] = new Set();
    if (m.homeTeam) groups[g].add(m.homeTeam);
    if (m.awayTeam) groups[g].add(m.awayTeam);
  }
  const result = {};
  for (const [g, teams] of Object.entries(groups)) {
    result[g] = [...teams].sort();
  }
  return result;
}

// Welke teams zijn daadwerkelijk doorgekomen (staan in LAST_32)
function getActuallyAdvanced() {
  const advanced = new Set();
  for (const m of Object.values(matches)) {
    if (m.stage !== "LAST_32") continue;
    if (m.homeTeam) advanced.add(m.homeTeam);
    if (m.awayTeam) advanced.add(m.awayTeam);
  }
  return advanced;
}

// Bereken de VOORSPELDE groepsstand + stats op basis van ingevulde scores
function calculatePredictedGroupData(preds) {
  const groupStats = {};
  for (const [matchId, m] of Object.entries(matches)) {
    if (m.stage !== "GROUP_STAGE") continue;
    const pred = preds[matchId];
    if (!pred || pred.home === "" || pred.home === undefined) continue;
    const predH = parseInt(pred.home), predA = parseInt(pred.away);
    if (isNaN(predH) || isNaN(predA)) continue;
    const g = m.group || "UNKNOWN";
    if (!groupStats[g]) groupStats[g] = {};
    for (const [team, isHome] of [[m.homeTeam, true], [m.awayTeam, false]]) {
      if (!groupStats[g][team]) groupStats[g][team] = { pts: 0, gd: 0, gf: 0 };
      const scored   = isHome ? predH : predA;
      const conceded = isHome ? predA : predH;
      groupStats[g][team].gf += scored;
      groupStats[g][team].gd += scored - conceded;
      if (scored > conceded)        groupStats[g][team].pts += 3;
      else if (scored === conceded) groupStats[g][team].pts += 1;
    }
  }
  const standings = {};
  const teamStats = {}; // team -> { pts, gd, gf }
  for (const [g, teams] of Object.entries(groupStats)) {
    const sorted = Object.entries(teams)
      .sort(([,a],[,b]) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf);
    standings[g] = sorted.map(([team]) => team);
    sorted.forEach(([team, s]) => { teamStats[team] = s; });
  }
  return { standings, teamStats };
}

// Wrapper die alleen de standings teruggeeft (bestaande code)
function calculatePredictedGroupStandings(preds) {
  return calculatePredictedGroupData(preds).standings;
}

// Bereken de WERKELIJKE groepsstand op basis van resultaten (voor positiebonus)
function calculateGroupStandings() {
  const groupStats = {};
  for (const m of Object.values(matches)) {
    if (m.stage !== "GROUP_STAGE" || m.status !== "FINISHED") continue;
    if (m.homeScore === null || m.awayScore === null) continue;
    const g = m.group || "UNKNOWN";
    if (!groupStats[g]) groupStats[g] = {};
    for (const [team, isHome] of [[m.homeTeam, true], [m.awayTeam, false]]) {
      if (!groupStats[g][team]) groupStats[g][team] = { pts: 0, gd: 0, gf: 0 };
      const scored    = isHome ? m.homeScore : m.awayScore;
      const conceded  = isHome ? m.awayScore : m.homeScore;
      groupStats[g][team].gf += scored;
      groupStats[g][team].gd += scored - conceded;
      if (scored > conceded)  groupStats[g][team].pts += 3;
      else if (scored === conceded) groupStats[g][team].pts += 1;
    }
  }
  // Sorteer per groep: punten → doelsaldo → doelpunten
  const standings = {};
  for (const [g, teams] of Object.entries(groupStats)) {
    standings[g] = Object.entries(teams)
      .sort(([,a],[,b]) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf)
      .map(([team]) => team);
  }
  return standings;
}

// ============================================================
// LANDNAMEN VERTALING (Engels → Nederlands)
// ============================================================
const TEAM_NL = {
  // Europa
  "Netherlands":        "Nederland",
  "Germany":            "Duitsland",
  "France":             "Frankrijk",
  "Spain":              "Spanje",
  "Italy":              "Italië",
  "England":            "Engeland",
  "Belgium":            "België",
  "Portugal":           "Portugal",
  "Austria":            "Oostenrijk",
  "Switzerland":        "Zwitserland",
  "Poland":             "Polen",
  "Denmark":            "Denemarken",
  "Sweden":             "Zweden",
  "Norway":             "Noorwegen",
  "Serbia":             "Servië",
  "Croatia":            "Kroatië",
  "Romania":            "Roemenië",
  "Turkey":             "Turkije",
  "Türkiye":            "Turkije",
  "Czech Republic":     "Tsjechië",
  "Czechia":            "Tsjechië",
  "Slovakia":           "Slowakije",
  "Hungary":            "Hongarije",
  "Ukraine":            "Oekraïne",
  "Greece":             "Griekenland",
  "Scotland":           "Schotland",
  "Wales":              "Wales",
  "Republic of Ireland":"Ierland",
  "Ireland":            "Ierland",
  "Albania":            "Albanië",
  "Slovenia":           "Slovenië",
  "Georgia":            "Georgië",
  "Kosovo":             "Kosovo",
  "North Macedonia":    "Noord-Macedonië",
  "Finland":            "Finland",
  "Iceland":            "IJsland",
  "Bosnia and Herzegovina": "Bosnië-Herzegovina",
  "Bosnia-Herzegovina":     "Bosnië-Herzegovina",
  "Montenegro":         "Montenegro",
  "Bulgaria":           "Bulgarije",
  "Northern Ireland":   "Noord-Ierland",
  "Luxembourg":         "Luxemburg",
  "Belarus":            "Wit-Rusland",
  "Estonia":            "Estland",
  "Latvia":             "Letland",
  "Lithuania":          "Litouwen",

  // Zuid-Amerika
  "Brazil":             "Brazilië",
  "Argentina":          "Argentinië",
  "Uruguay":            "Uruguay",
  "Colombia":           "Colombia",
  "Ecuador":            "Ecuador",
  "Chile":              "Chili",
  "Peru":               "Peru",
  "Venezuela":          "Venezuela",
  "Paraguay":           "Paraguay",
  "Bolivia":            "Bolivia",

  // Noord- en Midden-Amerika & Caraïben
  "United States":      "Verenigde Staten",
  "USA":                "Verenigde Staten",
  "Canada":             "Canada",
  "Mexico":             "Mexico",
  "Costa Rica":         "Costa Rica",
  "Panama":             "Panama",
  "Honduras":           "Honduras",
  "El Salvador":        "El Salvador",
  "Jamaica":            "Jamaica",
  "Cuba":               "Cuba",
  "Trinidad and Tobago":"Trinidad en Tobago",
  "Curaçao":            "Curaçao",
  "Curacao":            "Curaçao",
  "Guatemala":          "Guatemala",
  "Haiti":              "Haïti",

  // Afrika
  "Morocco":            "Marokko",
  "Senegal":            "Senegal",
  "Nigeria":            "Nigeria",
  "Ivory Coast":        "Ivoorkust",
  "Côte d'Ivoire":      "Ivoorkust",
  "Ghana":              "Ghana",
  "Cameroon":           "Kameroen",
  "Egypt":              "Egypte",
  "Algeria":            "Algerije",
  "Tunisia":            "Tunesië",
  "South Africa":       "Zuid-Afrika",
  "Mali":               "Mali",
  "Burkina Faso":       "Burkina Faso",
  "DR Congo":           "DR Congo",
  "Zambia":             "Zambia",
  "Tanzania":           "Tanzania",
  "Angola":             "Angola",
  "Mozambique":         "Mozambique",
  "Uganda":             "Oeganda",
  "Benin":              "Benin",
  "Congo":              "Congo",
  "Gabon":              "Gabon",
  "Guinea":             "Guinee",
  "Cape Verde":         "Kaapverdië",
  "Cape Verde Islands": "Kaapverdië",
  "Equatorial Guinea":  "Equatoriaal-Guinea",
  "Comoros":            "Comoren",
  "Libya":              "Libië",
  "Sudan":              "Soedan",
  "Kenya":              "Kenia",
  "Ethiopia":           "Ethiopië",
  "Rwanda":             "Rwanda",
  "Zimbabwe":           "Zimbabwe",
  "Namibia":            "Namibië",
  "Mauritania":         "Mauritanië",

  // Azië & Oceanië
  "Japan":              "Japan",
  "South Korea":        "Zuid-Korea",
  "Korea Republic":     "Zuid-Korea",
  "Australia":          "Australië",
  "Saudi Arabia":       "Saoedi-Arabië",
  "Iran":               "Iran",
  "Qatar":              "Qatar",
  "Iraq":               "Irak",
  "Jordan":             "Jordanië",
  "Oman":               "Oman",
  "Uzbekistan":         "Oezbekistan",
  "China":              "China",
  "China PR":           "China",
  "Indonesia":          "Indonesië",
  "New Zealand":        "Nieuw-Zeeland",
  "United Arab Emirates": "Verenigde Arabische Emiraten",
  "UAE":                "VAE",
  "Bahrain":            "Bahrein",
  "Kuwait":             "Koeweit",
  "Palestine":          "Palestina",
  "Syria":              "Syrië",
  "Thailand":           "Thailand",
  "Vietnam":            "Vietnam",
  "India":              "India",
  "Philippines":        "Filipijnen",
  "Malaysia":           "Maleisië",
  "Myanmar":            "Myanmar",
  "Tajikistan":         "Tadzjikistan",
  "Kyrgyzstan":         "Kirgizië",
  "North Korea":        "Noord-Korea",
  "Fiji":               "Fiji",
  "Papua New Guinea":   "Papoea-Nieuw-Guinea",
  "Solomon Islands":    "Salomonseilanden",
  "New Caledonia":      "Nieuw-Caledonië",

  // Midden-Oosten
  "Lebanon":            "Libanon",
  "Israel":             "Israël",
  "Turkey":             "Turkije",
};

function t(name) {
  if (!name) return name;
  return TEAM_NL[name] ?? name;
}

// Bepaal welke 3e-plaatsers daadwerkelijk doorgaan (staan in Last 32 op een "third"-slot)
function getActualAdvancingThirds() {
  const thirds = new Set();
  for (const [matchId, slot] of Object.entries(LAST_32_BRACKET)) {
    const m = matches[matchId];
    if (!m) continue;
    if (slot.home.type === "third" && m.homeTeam) thirds.add(m.homeTeam);
    if (slot.away.type === "third" && m.awayTeam) thirds.add(m.awayTeam);
  }
  return thirds;
}

// WK 2026 Last 32 bracket: welke groepspositie speelt in welke wedstrijd
// Gebaseerd op het officiële FIFA-schema (matchnummers 73–88)
const LAST_32_BRACKET = {
  "537417": { home: {type:"runner-up", group:"GROUP_A"}, away: {type:"runner-up", group:"GROUP_B"} },
  "537423": { home: {type:"winner",    group:"GROUP_C"}, away: {type:"runner-up", group:"GROUP_F"} },
  "537415": { home: {type:"winner",    group:"GROUP_E"}, away: {type:"third", groups:["A","B","C","D","F"]} },
  "537418": { home: {type:"winner",    group:"GROUP_F"}, away: {type:"runner-up", group:"GROUP_C"} },
  "537424": { home: {type:"runner-up", group:"GROUP_E"}, away: {type:"runner-up", group:"GROUP_I"} },
  "537416": { home: {type:"winner",    group:"GROUP_I"}, away: {type:"third", groups:["C","D","F","G","H"]} },
  "537425": { home: {type:"winner",    group:"GROUP_A"}, away: {type:"third", groups:["C","E","F","H","I"]} },
  "537426": { home: {type:"winner",    group:"GROUP_L"}, away: {type:"third", groups:["E","H","I","J","K"]} },
  "537422": { home: {type:"winner",    group:"GROUP_G"}, away: {type:"third", groups:["A","E","H","I","J"]} },
  "537421": { home: {type:"winner",    group:"GROUP_D"}, away: {type:"third", groups:["B","E","F","I","J"]} },
  "537420": { home: {type:"winner",    group:"GROUP_H"}, away: {type:"runner-up", group:"GROUP_J"} },
  "537419": { home: {type:"runner-up", group:"GROUP_K"}, away: {type:"runner-up", group:"GROUP_L"} },
  "537429": { home: {type:"winner",    group:"GROUP_B"}, away: {type:"third", groups:["E","F","G","I","J"]} },
  "537428": { home: {type:"runner-up", group:"GROUP_D"}, away: {type:"runner-up", group:"GROUP_G"} },
  "537427": { home: {type:"winner",    group:"GROUP_J"}, away: {type:"runner-up", group:"GROUP_H"} },
  "537430": { home: {type:"winner",    group:"GROUP_K"}, away: {type:"third", groups:["D","E","I","J","L"]} },
};

// Volledige knockout bracket: welke match levert de home/away voor de volgende ronde
const KNOCKOUT_BRACKET = {
  // Last 16 (match 89–96)
  "537376": { home: { source: "537415", winner: true  }, away: { source: "537416", winner: true  } }, // M89: W74 vs W77
  "537375": { home: { source: "537417", winner: true  }, away: { source: "537418", winner: true  } }, // M90: W73 vs W75
  "537377": { home: { source: "537423", winner: true  }, away: { source: "537424", winner: true  } }, // M91: W76 vs W78
  "537378": { home: { source: "537425", winner: true  }, away: { source: "537426", winner: true  } }, // M92: W79 vs W80
  "537379": { home: { source: "537419", winner: true  }, away: { source: "537420", winner: true  } }, // M93: W83 vs W84
  "537380": { home: { source: "537421", winner: true  }, away: { source: "537422", winner: true  } }, // M94: W81 vs W82
  "537381": { home: { source: "537427", winner: true  }, away: { source: "537428", winner: true  } }, // M95: W86 vs W88
  "537382": { home: { source: "537429", winner: true  }, away: { source: "537430", winner: true  } }, // M96: W85 vs W87
  // Kwartfinales (match 97–100)
  "537383": { home: { source: "537376", winner: true  }, away: { source: "537375", winner: true  } }, // M97: W89 vs W90
  "537384": { home: { source: "537379", winner: true  }, away: { source: "537380", winner: true  } }, // M98: W93 vs W94
  "537385": { home: { source: "537377", winner: true  }, away: { source: "537378", winner: true  } }, // M99: W91 vs W92
  "537386": { home: { source: "537381", winner: true  }, away: { source: "537382", winner: true  } }, // M100: W95 vs W96
  // Halve finales (match 101–102)
  "537387": { home: { source: "537383", winner: true  }, away: { source: "537384", winner: true  } }, // M101: W97 vs W98
  "537388": { home: { source: "537385", winner: true  }, away: { source: "537386", winner: true  } }, // M102: W99 vs W100
  // Troostfinale (match 103)
  "537389": { home: { source: "537387", winner: false }, away: { source: "537388", winner: false } }, // M103: L101 vs L102
  // Finale (match 104)
  "537390": { home: { source: "537387", winner: true  }, away: { source: "537388", winner: true  } }, // M104: W101 vs W102
};

// Bepaal de winnaar (of verliezer) van een wedstrijd op basis van de voorspelling
function resolveRoundTeam(sourceMatchId, isWinner, preds, thirdAssignment, predStandings, tStats, cache = {}) {
  const key = `${sourceMatchId}-${isWinner ? "W" : "L"}`;
  if (cache[key] !== undefined) return cache[key];

  const m = matches[sourceMatchId];
  if (!m) return (cache[key] = null);

  // Teams bepalen
  let home, away;
  if (m.homeTeam && m.awayTeam) {
    home = m.homeTeam;
    away = m.awayTeam;
  } else if (LAST_32_BRACKET[sourceMatchId]) {
    const slot = LAST_32_BRACKET[sourceMatchId];
    home = resolveBracketSlot(slot.home, predStandings, tStats, sourceMatchId, "home", thirdAssignment).team;
    away = resolveBracketSlot(slot.away, predStandings, tStats, sourceMatchId, "away", thirdAssignment).team;
  } else if (KNOCKOUT_BRACKET[sourceMatchId]) {
    const b = KNOCKOUT_BRACKET[sourceMatchId];
    home = resolveRoundTeam(b.home.source, b.home.winner, preds, thirdAssignment, predStandings, tStats, cache);
    away = resolveRoundTeam(b.away.source, b.away.winner, preds, thirdAssignment, predStandings, tStats, cache);
  }
  if (!home || !away) return (cache[key] = null);

  // Winnaar bepalen uit voorspelling
  const pred = preds[sourceMatchId];
  if (!pred || pred.home === undefined || pred.home === "") return (cache[key] = null);
  const ph = parseInt(pred.home), pa = parseInt(pred.away);
  if (isNaN(ph) || isNaN(pa)) return (cache[key] = null);

  let winner, loser;
  if (ph !== pa) {
    winner = ph > pa ? home : away;
    loser  = ph > pa ? away : home;
  } else if (pred.penalty && pred.penaltyWinner) {
    winner = pred.penaltyWinner === "home" ? home : away;
    loser  = pred.penaltyWinner === "home" ? away : home;
  } else {
    return (cache[key] = null); // gelijkspel zonder penalty-keuze
  }

  cache[key] = isWinner ? winner : loser;
  return cache[key];
}

// Bereken de correcte 1-op-1 toewijzing van de 8 geselecteerde nummer-3 landen
// aan de 8 bracket-slots via greedy bipartite matching (meest beperkte slot eerst).
function computeThirdAssignment(selected8, predictedStandings) {
  // Bouw team → groep (letter) mapping
  const teamToGroup = {};
  for (const [group, order] of Object.entries(predictedStandings)) {
    const third = order[2];
    if (third) teamToGroup[third] = group.replace("GROUP_", "");
  }

  // Verzamel alle "third" slots uit het bracket
  const thirdSlots = [];
  for (const [matchId, slot] of Object.entries(LAST_32_BRACKET)) {
    if (slot.home.type === "third") thirdSlots.push({ matchId, side: "home", groups: slot.home.groups });
    if (slot.away.type === "third") thirdSlots.push({ matchId, side: "away", groups: slot.away.groups });
  }

  // Sorteer op minste kandidaten (most-constrained first)
  const slotsWithCandidates = thirdSlots.map(s => ({
    ...s,
    candidates: selected8.filter(team => {
      const g = teamToGroup[team];
      return g && s.groups.includes(g);
    })
  })).sort((a, b) => a.candidates.length - b.candidates.length);

  // Greedy toewijzing
  const assignment = {}; // `${matchId}-${side}` -> team
  const assigned = new Set();
  for (const slot of slotsWithCandidates) {
    const available = slot.candidates.filter(t => !assigned.has(t));
    if (available.length > 0) {
      assignment[`${slot.matchId}-${slot.side}`] = available[0];
      assigned.add(available[0]);
    }
  }
  return assignment;
}

// Bepaal de voorspelde teamnaam voor een bracket-slot.
// assignment = output van computeThirdAssignment (optioneel, voor third-slots)
function resolveBracketSlot(slot, predictedStandings, teamStats, matchId, side, thirdAssignment) {
  if (slot.type === "winner")    return { team: predictedStandings[slot.group]?.[0] ?? null, preliminary: false };
  if (slot.type === "runner-up") return { team: predictedStandings[slot.group]?.[1] ?? null, preliminary: false };
  if (slot.type === "third") {
    const team = thirdAssignment?.[`${matchId}-${side}`] ?? null;
    return { team, preliminary: true };
  }
  return { team: null, preliminary: false };
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

window.updateThirdAdvCount = function() {
  const checked = document.querySelectorAll(".third-adv-cb:checked").length;
  const all     = document.querySelectorAll(".third-adv-cb");
  const counter = document.getElementById("third-adv-count");
  if (counter) {
    counter.textContent = `${checked} / 8 geselecteerd`;
    counter.className = `third-adv-count ${checked > 8 ? "over" : checked === 8 ? "done" : ""}`;
  }
  // Max 8: blokkeer extra selecties
  all.forEach(cb => {
    if (!cb.checked) cb.disabled = checked >= 8;
  });
  // Update visuele staat
  document.querySelectorAll("label.third-adv-team").forEach(label => {
    const cb = label.querySelector("input");
    if (cb) label.classList.toggle("selected", cb.checked);
  });
  // Update de bracket in de Last 32
  updateKnockoutTeamLabels();
  // Auto-opslaan na wijziging
  showAutoSaveStatus("⏳ Wordt opgeslagen...");
  clearTimeout(window._thirdAdvSaveTimer);
  window._thirdAdvSaveTimer = setTimeout(() => autoSave(), 2000);
};

window.togglePenaltyWinner = function(checkbox) {
  const matchId   = checkbox.dataset.match;
  const winnerDiv = document.getElementById(`pen-winner-${matchId}`);
  if (winnerDiv) winnerDiv.classList.toggle("hidden", !checkbox.checked);
};

window.selectPenaltyWinner = function(btn) {
  const matchId = btn.dataset.match;
  document.querySelectorAll(`.pen-btn[data-match="${matchId}"]`).forEach(b => b.classList.remove("selected"));
  btn.classList.add("selected");
};

window.showView = showView;
window.renderPredictions = renderPredictions;
window.joinPoule = joinPoule;
window.logout = logout;
window.savePredictions = savePredictions;
window.adminLogin = adminLogin;
window.deleteParticipant = deleteParticipant;

init();
