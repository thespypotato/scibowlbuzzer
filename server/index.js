import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import { nanoid } from "nanoid";

const app = express();
app.use((req, _res, next) => {
  console.log("REQ", req.method, req.url);
  next();
});

app.use(cors({ origin: true, credentials: true }));
app.get("/", (_, res) => res.send("ok"));
app.get("/health", (_, res) => res.json({ ok: true }));


const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

const DEFAULT_TOSSUP_SECONDS = 5;
const DEFAULT_BONUS_SECONDS = 20;

const rooms = new Map();
const now = () => Date.now();

function genCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function requireRoom(code, socket) {
  const room = rooms.get(code);
  if (!room) socket.emit("error_msg", "Room not found.");
  return room || null;
}

function requireHost(room, socket) {
  if (room.hostSocketId !== socket.id) {
    socket.emit("error_msg", "Host only.");
    return false;
  }
  return true;
}

/* ---------------- Timer helpers ---------------- */
function computeTimerSnapshot(room) {
  const t = room.timer;
  if (!t.running) return { mode: t.mode, running: false, remainingMs: t.remainingMs, endsAtMs: 0 };
  const remaining = Math.max(0, t.endsAtMs - now());
  const running = remaining > 0;
  return { mode: t.mode, running, remainingMs: remaining, endsAtMs: running ? t.endsAtMs : 0 };
}

function setTimer(room, mode, seconds, running) {
  room.timer.mode = mode;
  room.timer.remainingMs = Math.round(seconds * 1000);
  if (running) {
    room.timer.running = true;
    room.timer.endsAtMs = now() + room.timer.remainingMs;
  } else {
    room.timer.running = false;
    room.timer.endsAtMs = 0;
  }
}

function resetTimerFull(room, mode, running) {
  const seconds = mode === "tossup" ? room.settings.tossupSeconds : room.settings.bonusSeconds;
  setTimer(room, mode, seconds, running);
}

function stopTimer(room) {
  if (!room.timer.running) return;
  room.timer.remainingMs = Math.max(0, room.timer.endsAtMs - now());
  room.timer.running = false;
  room.timer.endsAtMs = 0;
}

/* ---------------- Toss-up end timeout ---------------- */
function clearTossupEndTimeout(room) {
  if (room.tossupEndTimeout) {
    clearTimeout(room.tossupEndTimeout);
    room.tossupEndTimeout = null;
  }
}

function scheduleTossupEnd(room) {
  clearTossupEndTimeout(room);
  const ms = room.timer.remainingMs;

  room.tossupEndTimeout = setTimeout(() => {
    const r = rooms.get(room.code);
    if (!r) return;

    const remaining = Math.max(0, r.timer.endsAtMs - now());
    // Only close buzz if still live, timer ended, and no active buzz (buzz pauses clock)
    if (r.phase === "tossup_live" && remaining === 0 && !r.buzz.locked) {
      r.phase = "tossup_closed";
      r.timer.running = false;
      r.timer.remainingMs = 0;
      r.timer.endsAtMs = 0;
      clearBuzz(r);
      broadcast(r);
    }
  }, ms + 15);
}

/* ---------------- Match log (PER TOSS-UP DELTAS) ---------------- */
function ensureMatch(room) {
  if (room.match) return;
  room.match = { tossupNumber: 0, rows: [] };
}

function startNewTossupRow(room) {
  ensureMatch(room);
  room.match.tossupNumber += 1;

  const teams = {};
  for (const [id, t] of room.teams.entries()) {
    teams[id] = { p: 0, tu: 0, b: 0, score: t.score };
  }

  room.match.rows.push({ num: room.match.tossupNumber, teams });
}

function currentRow(room) {
  ensureMatch(room);
  if (!room.match.rows.length) return null;
  return room.match.rows[room.match.rows.length - 1];
}

function addRowDelta(room, teamId, field, points) {
  const row = currentRow(room);
  if (!row) return;
  if (!row.teams[teamId]) return;
  row.teams[teamId][field] += points;
}

function refreshRowScores(room) {
  const row = currentRow(room);
  if (!row) return;
  for (const [id, t] of room.teams.entries()) {
    if (row.teams[id]) row.teams[id].score = t.score;
  }
}

/* ---------------- Buzz helpers ---------------- */
function clearBuzz(room) {
  room.buzz = { locked: false };
}

function otherTeamId(room, teamId) {
  return [...room.teams.keys()].find((id) => id !== teamId) || null;
}

/* ---------------- State + broadcast ---------------- */
function publicState(room) {
  const teams = [...room.teams.values()].map((t) => ({ ...t }));
  const players = [...room.players.values()].map((p) => ({
    socketId: p.socketId,
    name: p.name,
    teamId: p.teamId,
    isHost: p.isHost,
    isSpectator: !!p.isSpectator
  }));

  const buzz = room.buzz.locked
    ? {
        locked: true,
        winnerSocketId: room.buzz.winnerSocketId,
        winnerName: room.buzz.winnerName,
        winnerTeamId: room.buzz.winnerTeamId,
        at: room.buzz.at,
        interruptChoice: room.buzz.interruptChoice
      }
    : { locked: false };

  return {
    code: room.code,
    roomName: room.roomName,
    hostSocketId: room.hostSocketId,
    settings: room.settings,
    teams,
    players,
    phase: room.phase,
    activeBonusTeamId: room.activeBonusTeamId,
    buzz,
    timer: computeTimerSnapshot(room),
    tossupLockedTeams: [...room.tossupLockedTeams],
    match: room.match // <-- REQUIRED for scoreboard updates
  };
}

function broadcast(room) {
  io.to(room.code).emit("state", publicState(room));
}

/* ---------------- Socket.io handlers ---------------- */
io.on("connection", (socket) => {
  socket.on("create_room", ({ hostName, roomName, numTeams }) => {
    const code = genCode();
    const rn = String(roomName || "").trim().slice(0, 40) || `Room ${code}`;

    const n = Number(numTeams);
    const teamCount = Number.isFinite(n) ? Math.min(8, Math.max(2, Math.round(n))) : 2;

    const room = {
      code,
      roomName: rn,
      hostSocketId: socket.id,
      settings: { tossupSeconds: DEFAULT_TOSSUP_SECONDS, bonusSeconds: DEFAULT_BONUS_SECONDS },
      teams: new Map(),
      players: new Map(),
      phase: "lobby", // lobby | tossup_reading | tossup_live | tossup_closed | bonus_reading | bonus_live
      activeBonusTeamId: null,
      tossupLockedTeams: new Set(),
      buzz: { locked: false },
      timer: { mode: "tossup", running: false, remainingMs: DEFAULT_TOSSUP_SECONDS * 1000, endsAtMs: 0 },
      tossupEndTimeout: null,
      match: { tossupNumber: 0, rows: [] }
    };

    for (let i = 0; i < teamCount; i++) {
      const id = nanoid(6);
      room.teams.set(id, { id, name: `Team ${String.fromCharCode(65 + i)}`, score: 0 });
    }

    room.players.set(socket.id, {
      socketId: socket.id,
      name: (hostName?.trim() || "Host").slice(0, 24),
      teamId: null,
      isHost: true,
      isSpectator: false
    });

    rooms.set(code, room);
    socket.join(code);
    socket.emit("room_created", { code });
    broadcast(room);
  });

  socket.on("host_set_room_name", ({ code, roomName }) => {
    code = String(code || "").toUpperCase().trim();
    const room = requireRoom(code, socket);
    if (!room || !requireHost(room, socket)) return;
    const rn = String(roomName || "").trim().slice(0, 40);
    if (!rn) return;
    room.roomName = rn;
    broadcast(room);
  });

  socket.on("host_set_team_name", ({ code, teamId, name }) => {
    code = String(code || "").toUpperCase().trim();
    const room = requireRoom(code, socket);
    if (!room || !requireHost(room, socket)) return;
    const t = room.teams.get(teamId);
    if (!t) return;
    const nm = String(name || "").trim().slice(0, 24);
    if (!nm) return;
    t.name = nm;
    broadcast(room);
  });

  socket.on("join_room", ({ code, name, teamId, spectate }) => {
    code = String(code || "").toUpperCase().trim();
    const room = requireRoom(code, socket);
    if (!room) return;
    socket.join(code);

    const nm = (String(name || "Player").trim() || "Player").slice(0, 24);

    if (spectate) {
      room.players.set(socket.id, {
        socketId: socket.id,
        name: nm,
        teamId: null,
        isHost: false,
        isSpectator: true
      });
      broadcast(room);
      return;
    }

    if (!teamId || !room.teams.has(teamId)) {
      socket.emit("error_msg", "Choose a team before joining.");
      return;
    }

    room.players.set(socket.id, {
      socketId: socket.id,
      name: nm,
      teamId,
      isHost: false,
      isSpectator: false
    });

    broadcast(room);
  });

  // no switching after join
  socket.on("set_team", () => {});

  /* ---- Toss-up controls ---- */
  socket.on("host_start_tossup_reading", ({ code }) => {
    code = String(code || "").toUpperCase().trim();
    const room = requireRoom(code, socket);
    if (!room || !requireHost(room, socket)) return;
    if (room.phase.startsWith("bonus")) return;

    clearTossupEndTimeout(room);

    room.phase = "tossup_reading";
    room.activeBonusTeamId = null;
    room.tossupLockedTeams = new Set();
    clearBuzz(room);
    resetTimerFull(room, "tossup", false);

    // MATCH LOG: new row per toss-up
    startNewTossupRow(room);
    refreshRowScores(room);

    broadcast(room);
  });

  socket.on("host_done_reading_tossup", ({ code }) => {
    code = String(code || "").toUpperCase().trim();
    const room = requireRoom(code, socket);
    if (!room || !requireHost(room, socket)) return;
    if (room.phase.startsWith("bonus")) return;

    room.phase = "tossup_live";
    clearBuzz(room);
    resetTimerFull(room, "tossup", true);

    scheduleTossupEnd(room);
    broadcast(room);
  });

  /* ---- Buzzing ---- */
  socket.on("buzz", ({ code }) => {
    code = String(code || "").toUpperCase().trim();
    const room = requireRoom(code, socket);
    if (!room) return;

    const p = room.players.get(socket.id);
    if (!p || p.isHost || p.isSpectator) return;

    if (room.phase !== "tossup_reading" && room.phase !== "tossup_live") return;
    if (!p.teamId) return;
    if (room.tossupLockedTeams.has(p.teamId)) return;
    if (room.buzz.locked) return;

    // if timer live, stop it and cancel end timeout
    if (room.phase === "tossup_live") {
      stopTimer(room);
      clearTossupEndTimeout(room);
    }

    room.buzz = {
      locked: true,
      winnerSocketId: socket.id,
      winnerName: p.name,
      winnerTeamId: p.teamId,
      at: now(),
      interruptChoice: null
    };

    broadcast(room);
  });

  socket.on("host_clear_buzz", ({ code }) => {
    code = String(code || "").toUpperCase().trim();
    const room = requireRoom(code, socket);
    if (!room || !requireHost(room, socket)) return;

    clearBuzz(room);

    // if tossup live and timer still running, reschedule end
    if (room.phase === "tossup_live" && room.timer.running) scheduleTossupEnd(room);

    broadcast(room);
  });

  socket.on("host_set_interrupt_choice", ({ code, interrupt }) => {
    code = String(code || "").toUpperCase().trim();
    const room = requireRoom(code, socket);
    if (!room || !requireHost(room, socket)) return;
    if (!room.buzz.locked) return;

    room.buzz.interruptChoice = !!interrupt;
    broadcast(room);
  });

  socket.on("host_mark_answer", ({ code, correct }) => {
    code = String(code || "").toUpperCase().trim();
    const room = requireRoom(code, socket);
    if (!room || !requireHost(room, socket)) return;
    if (!room.buzz.locked) return;

    const teamId = room.buzz.winnerTeamId;
    const team = teamId ? room.teams.get(teamId) : null;
    if (!team) return;

    const interrupt = room.buzz.interruptChoice;
    if (interrupt === null) return;

    const lockOutTeam = () => room.tossupLockedTeams.add(teamId);

    if (correct) {
      // TU correct = +4 (per toss-up delta)
      team.score += 4;
      addRowDelta(room, teamId, "tu", 4);
      refreshRowScores(room);

      clearTossupEndTimeout(room);

      room.phase = "bonus_reading";
      room.activeBonusTeamId = teamId;
      clearBuzz(room);
      resetTimerFull(room, "bonus", false);

      broadcast(room);
      return;
    }

    // incorrect
    lockOutTeam();
    clearBuzz(room);

    if (interrupt) {
      // NEG: +4 to other team (counts under P for benefiting team)
      const otherId = otherTeamId(room, teamId);
      if (otherId) {
        const other = room.teams.get(otherId);
        if (other) {
          other.score += 4;
          addRowDelta(room, otherId, "p", 4);
          refreshRowScores(room);
        }
      }

      clearTossupEndTimeout(room);

      room.phase = "tossup_reading";
      resetTimerFull(room, "tossup", false);

      broadcast(room);
      return;
    } else {
      // Not interrupt incorrect: no neg, reset 5s timer and run
      room.phase = "tossup_live";
      resetTimerFull(room, "tossup", true);
      scheduleTossupEnd(room);

      broadcast(room);
      return;
    }
  });

  /* ---- Bonus ---- */
  socket.on("host_done_reading_bonus", ({ code }) => {
    code = String(code || "").toUpperCase().trim();
    const room = requireRoom(code, socket);
    if (!room || !requireHost(room, socket)) return;
    if (room.phase !== "bonus_reading" && room.phase !== "bonus_live") return;

    room.phase = "bonus_live";
    resetTimerFull(room, "bonus", true);
    broadcast(room);
  });

  socket.on("host_award_bonus", ({ code, points }) => {
    code = String(code || "").toUpperCase().trim();
    const room = requireRoom(code, socket);
    if (!room || !requireHost(room, socket)) return;
    if (!room.phase.startsWith("bonus")) return;

    const teamId = room.activeBonusTeamId;
    const team = teamId ? room.teams.get(teamId) : null;
    if (!team) return;

    const p = Number(points);
    if (!Number.isFinite(p) || p < 0 || p > 20) return;

    team.score += p;
    addRowDelta(room, teamId, "b", p);
    refreshRowScores(room);

    room.phase = "lobby";
    room.activeBonusTeamId = null;
    room.tossupLockedTeams = new Set();
    clearBuzz(room);
    resetTimerFull(room, "tossup", false);

    broadcast(room);
  });

  socket.on("host_skip_bonus", ({ code }) => {
    code = String(code || "").toUpperCase().trim();
    const room = requireRoom(code, socket);
    if (!room || !requireHost(room, socket)) return;
    if (!room.phase.startsWith("bonus")) return;

    room.phase = "lobby";
    room.activeBonusTeamId = null;
    room.tossupLockedTeams = new Set();
    clearBuzz(room);
    resetTimerFull(room, "tossup", false);

    broadcast(room);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      if (!room.players.has(socket.id)) continue;

      const wasHost = room.hostSocketId === socket.id;
      room.players.delete(socket.id);

      if (wasHost) {
        io.to(room.code).emit("error_msg", "Host disconnected. Room closed.");
        clearTossupEndTimeout(room);
        rooms.delete(room.code);
      } else {
        broadcast(room);
      }
    }
  });
});

const PORT = process.env.PORT || 8787;
app.use((req, res) => {
  res.status(404).send("Not Found: " + req.path);
});

server.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
