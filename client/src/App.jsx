import React, { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://127.0.0.1:8787";

function msToSec(ms) {
  return Math.max(0, Math.ceil(ms / 1000));
}

function teamName(teams, id) {
  return teams.find((t) => t.id === id)?.name || "Unknown";
}

function beep() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = 880;
    gain.gain.value = 0.06;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
      ctx.close();
    }, 120);
  } catch {}
}

export default function App() {
  const socketRef = useRef(null);

  // appMode: home | create | join | room
  const [appMode, setAppMode] = useState("home");

  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [state, setState] = useState(null);
  const [error, setError] = useState("");

  const [tick, setTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 200);
    return () => clearInterval(id);
  }, []);
const buzzAudioRef = useRef(null);
const [audioUnlocked, setAudioUnlocked] = useState(false);

function playBuzzSound() {
  const a = buzzAudioRef.current;
  if (!a) return;

  try {
    a.currentTime = 0;
    const p = a.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {}
}
useEffect(() => {
  const a = new Audio("/buzz.mp3");
  a.preload = "auto";
  a.volume = 0.9; // adjust if you want
  buzzAudioRef.current = a;

  // Unlock on first user gesture (desktop + mobile)
  const unlock = async () => {
    try {
      // Some browsers require a successful play() inside a gesture
      a.muted = true;
      await a.play();
      a.pause();
      a.currentTime = 0;
      a.muted = false;
      setAudioUnlocked(true);
    } catch {
      // If blocked, user can try again by clicking/tapping
    }
  };

  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock);

  return () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
}, []);

  // Buzz disabled shake
  const [buzzShake, setBuzzShake] = useState(false);

  // Dark mode
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("sb_dark") === "1");
  useEffect(() => {
    document.body.classList.toggle("dark", darkMode);
    localStorage.setItem("sb_dark", darkMode ? "1" : "0");
  }, [darkMode]);

  // buzz sound on lock
  const prevBuzzLockedRef = useRef(false);
  const prevBuzzAtRef = useRef(null);

  useEffect(() => {
    const s = io(SERVER_URL, { transports: ["polling", "websocket"] });
    socketRef.current = s;

    s.on("room_created", ({ code }) => {
      setCode(code);
      setAppMode("room");
    });

    // IMPORTANT: always set the entire state object from server
    s.on("state", (st) => {
      setState(st);
    });

    s.on("error_msg", (msg) => {
      setError(String(msg || "Error"));
      setTimeout(() => setError(""), 3000);
    });

    return () => {
      s.disconnect();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    const locked = !!state?.buzz?.locked;
    const at = state?.buzz?.at ?? null;

    const prevLocked = prevBuzzLockedRef.current;
    const prevAt = prevBuzzAtRef.current;

    if (!prevLocked && locked) {
      playBuzzSound();
    }

    prevBuzzLockedRef.current = locked;
    prevBuzzAtRef.current = at;
  }, [state?.buzz?.locked, state?.buzz?.at]);

  const emit = (evt, payload) => socketRef.current?.emit(evt, payload);

  const mySocketId = socketRef.current?.id || null;
  const isHost = !!(state && mySocketId && state.hostSocketId === mySocketId);

  const teams = state?.teams || [];
  const players = state?.players || [];
  const phase = state?.phase || "lobby";

  const me = useMemo(() => {
    if (!mySocketId) return null;
    return players.find((p) => p.socketId === mySocketId) || null;
  }, [players, mySocketId]);

  const lockedTeams = new Set(state?.tossupLockedTeams || []);

  // timer
  const timer = state?.timer;
  const remainingSec =
    timer?.running && timer?.endsAtMs
      ? msToSec(timer.endsAtMs - tick)
      : msToSec(timer?.remainingMs || 0);

  // canBuzz
  const canBuzz =
    !!state &&
    !isHost &&
    !me?.isSpectator &&
    (phase === "tossup_reading" || phase === "tossup_live") &&
    !state?.buzz?.locked &&
    !!me?.teamId &&
    !lockedTeams.has(me.teamId);

  // spacebar buzz
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.code !== "Space") return;
      if (!canBuzz) return;
      e.preventDefault();
      emit("buzz", { code: state?.code });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canBuzz, state?.code]);

  // ---------- Create Wizard ----------
  const [createRoomName, setCreateRoomName] = useState("My Match");
  const [createTeams, setCreateTeams] = useState(2);

  const doCreate = () => {
    emit("create_room", {
      hostName: name || "Host",
      roomName: createRoomName,
      numTeams: createTeams
    });
  };

  // ---------- Join Wizard ----------
  const [joinTeamId, setJoinTeamId] = useState("");
  const [joinSpectate, setJoinSpectate] = useState(false);

  const loadTeams = () => {
    // lightweight spectator join to receive team list/state
    emit("join_room", { code, name: name || "Preview", spectate: true });
  };

  const doJoin = () => {
    emit("join_room", {
      code,
      name: name || "Player",
      teamId: joinSpectate ? null : joinTeamId,
      spectate: joinSpectate
    });
    setAppMode("room");
  };

  // ---------- Host Actions ----------
  const startTossup = () => emit("host_start_tossup_reading", { code: state.code });
  const doneReadingTossup = () => emit("host_done_reading_tossup", { code: state.code });

  const resetBuzzer = () => emit("host_clear_buzz", { code: state.code });
  const chooseInterrupt = (interrupt) =>
    emit("host_set_interrupt_choice", { code: state.code, interrupt });
  const markAnswer = (correct) =>
    emit("host_mark_answer", { code: state.code, correct });

  const doneReadingBonus = () => emit("host_done_reading_bonus", { code: state.code });
  const awardBonus = (points) => emit("host_award_bonus", { code: state.code, points });
  const skipBonus = () => emit("host_skip_bonus", { code: state.code });

  // Team rename drafts for host
  const [teamNameDrafts, setTeamNameDrafts] = useState({});
  useEffect(() => {
    if (!isHost) return;
    const d = {};
    for (const t of teams) d[t.id] = t.name;
    setTeamNameDrafts(d);
  }, [isHost, teams]);

  const saveTeamName = (teamId) => {
    const nm = String(teamNameDrafts[teamId] || "").trim();
    if (!nm) return;
    emit("host_set_team_name", { code: state.code, teamId, name: nm });
  };

  // roster by team
  const playersByTeam = useMemo(() => {
    const groups = new Map();
    for (const t of teams) groups.set(t.id, []);
    for (const p of players) {
      if (p.isHost) continue;
      if (!p.teamId) continue;
      groups.get(p.teamId)?.push(p);
    }
    return groups;
  }, [teams, players]);

  const hostPlayer = players.find((p) => p.isHost) || null;

  const buzzLocked = !!state?.buzz?.locked;
  const winnerSocketId = state?.buzz?.winnerSocketId || null;
  const winnerTeamId = state?.buzz?.winnerTeamId || null;
  const interruptChoice = state?.buzz?.interruptChoice;

  const clockStatus = (() => {
    if (phase === "tossup_live") return "Toss-Up Live";
    if (phase === "tossup_reading") return "Toss-Up Reading";
    if (phase === "tossup_closed") return "Toss-Up Closed";
    if (phase === "bonus_live") return "Bonus Live";
    if (phase === "bonus_reading") return "Bonus Reading";
    return "Clock Stopped";
  })();

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar-left">
          <div className="clock-title">{state ? clockStatus : "Science Bowl"}</div>
          <div className="clock-sub">
            Timer: <b>{state ? `${remainingSec}s` : "—"}</b>{" "}
            <span className="muted">({state?.timer?.mode || "stopped"})</span>
          </div>
        </div>

        <div className="topbar-center">
          <div className="roomname-view">{state?.roomName || "—"}</div>
          <div className="roomcode">{state ? <>Code: <b>{state.code}</b></> : null}</div>
        </div>

        <div className="topbar-right">
          <div className="role-pill">
            {state
              ? isHost
                ? "Official"
                : me?.isSpectator
                  ? "Spectator"
                  : "Player"
              : "—"}
          </div>

          {hostPlayer ? <div className="muted small">Host: {hostPlayer.name}</div> : null}

          <button
            className="dark-toggle"
            onClick={() => setDarkMode((v) => !v)}
            title="Toggle dark mode"
          >
            {darkMode ? "☾" : "☀"}
          </button>
        </div>
      </header>

      {error ? <div className="toast">{error}</div> : null}

      {/* HOME */}
      {appMode === "home" && (
        <div className="card auth">
          <h1 className="title">Science Bowl</h1>

          <div className="row">
            <label className="label">Your name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="grid2">
            <div className="panel">
              <h2>Create</h2>
              <button className="btn" onClick={() => setAppMode("create")}>Create Room</button>
            </div>
            <div className="panel">
              <h2>Join</h2>
              <button className="btn" onClick={() => { setAppMode("join"); setState(null); }}>
                Join Room
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CREATE */}
      {appMode === "create" && (
        <div className="card auth">
          <h1 className="title">Create Room</h1>

          <label className="label">Room name</label>
          <input className="input" value={createRoomName} onChange={(e) => setCreateRoomName(e.target.value)} />

          <label className="label" style={{ marginTop: 10 }}>Number of teams (2–8)</label>
          <input
            className="input"
            type="number"
            min={2}
            max={8}
            value={createTeams}
            onChange={(e) => setCreateTeams(e.target.value)}
          />

          <div className="host-actions" style={{ marginTop: 12 }}>
            <button className="btn" onClick={doCreate}>Create</button>
            <button className="btn btn-soft" onClick={() => setAppMode("home")}>Back</button>
          </div>
        </div>
      )}

      {/* JOIN */}
      {appMode === "join" && (
        <div className="card auth">
          <h1 className="title">Join Room</h1>

          <label className="label">Room code</label>
          <input
            className="input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABC123"
          />

          <div className="muted small" style={{ marginTop: 8 }}>
            Click “Load Teams” to preview teams, then choose a team or spectate.
          </div>

          <div className="host-actions" style={{ marginTop: 10 }}>
            <button className="btn btn-soft" onClick={loadTeams} disabled={!code.trim()}>
              Load Teams
            </button>
            <button className="btn btn-soft" onClick={() => { setState(null); setAppMode("home"); }}>
              Back
            </button>
          </div>

          {state?.teams?.length ? (
            <>
              <div style={{ marginTop: 12 }}>
                <label className="label">Join mode</label>
                <div className="host-actions">
                  <button
                    className={`btn ${!joinSpectate ? "" : "btn-soft"}`}
                    onClick={() => setJoinSpectate(false)}
                  >
                    Player
                  </button>
                  <button
                    className={`btn ${joinSpectate ? "" : "btn-soft"}`}
                    onClick={() => setJoinSpectate(true)}
                  >
                    Spectate
                  </button>
                </div>
              </div>

              {!joinSpectate ? (
                <>
                  <label className="label" style={{ marginTop: 10 }}>Choose team</label>
                  <select
                    className="select"
                    value={joinTeamId}
                    onChange={(e) => setJoinTeamId(e.target.value)}
                  >
                    <option value="">Select…</option>
                    {state.teams.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </>
              ) : null}

              <div className="host-actions" style={{ marginTop: 12 }}>
                <button className="btn" onClick={doJoin} disabled={!joinSpectate && !joinTeamId}>
                  Join
                </button>
              </div>
            </>
          ) : null}
        </div>
      )}

      {/* ROOM loading */}
      {appMode === "room" && !state && (
        <div className="card auth" style={{ marginTop: 12 }}>
          <h2>Loading room…</h2>
          <div className="muted small">Waiting for server state.</div>
        </div>
      )}

      {/* ROOM */}
      {appMode === "room" && state && (
        <>
          <main className="main">
            <section
              className="teams"
              style={{
                gridTemplateColumns: teams.length <= 2 ? undefined : "repeat(2, 1fr)"
              }}
            >
              {teams.map((t, idx) => {
                const teamPlayers = playersByTeam.get(t.id) || [];
                const isWinnerTeam = !!winnerTeamId && winnerTeamId === t.id;

                return (
                  <div
                    key={t.id}
                    className={`teamcard ${idx % 2 === 0 ? "teamA" : "teamB"} ${isWinnerTeam ? "team-winner" : ""}`}
                  >
                    <div className="teamcard-header">
                      <div className="team-title">
                        {isHost ? (
                          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <input
                              className="input"
                              style={{ padding: "8px 10px", width: 160 }}
                              value={teamNameDrafts[t.id] ?? t.name}
                              onChange={(e) =>
                                setTeamNameDrafts((prev) => ({ ...prev, [t.id]: e.target.value }))
                              }
                            />
                            <button className="btn btn-soft" onClick={() => saveTeamName(t.id)}>Save</button>
                          </div>
                        ) : (
                          t.name
                        )}
                      </div>
                      <div className="team-score">{t.score}</div>
                    </div>

                    <div className="teamcard-body">
                      <div className="playerlist">
                        {teamPlayers.length === 0 ? (
                          <div className="muted small">No players yet</div>
                        ) : (
                          teamPlayers.map((p) => {
                            const isWinner = winnerSocketId && p.socketId === winnerSocketId;
                            const isYou = p.socketId === mySocketId;
                            return (
                              <div key={p.socketId} className={`playerrow ${isWinner ? "player-winner" : ""}`}>
                                <div className="playername">
                                  {p.name}{isYou ? <span className="muted"> (you)</span> : null}
                                </div>
                                {lockedTeams.has(t.id) ? <div className="locktag">locked</div> : null}
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </section>

            <section className="controls">
              <div className="card">
                <div className="controls-top">
                  <button
                    className={`btn btn-buzz ${buzzShake ? "buzz-shake" : ""}`}
                    onClick={() => {
                      if (!canBuzz) {
                        setBuzzShake(true);
                        setTimeout(() => setBuzzShake(false), 350);
                        return;
                      }
                      emit("buzz", { code: state?.code });
                    }}
                    disabled={!canBuzz}
                  >
                    BUZZ <span className="muted small" style={{ marginLeft: 8 }}>(Space)</span>
                  </button>

                  <div className="muted small">
                    {phase === "tossup_closed"
                      ? "Buzzing off (time expired)"
                      : phase.startsWith("bonus")
                        ? "Buzzing off (bonus)"
                        : canBuzz
                          ? "Buzzing on"
                          : me?.isSpectator
                            ? "Spectating (no buzz)"
                            : "Buzz disabled"}
                  </div>
                </div>

                {isHost ? (
                  <div className="hostbox">
                    <div className="host-actions">
                      <button className="btn" onClick={startTossup} disabled={phase.startsWith("bonus")}>
                        Start Toss-Up
                      </button>
                      <button className="btn btn-soft" onClick={doneReadingTossup} disabled={phase.startsWith("bonus")}>
                        Done Reading Toss-Up
                      </button>
                    </div>

                    {buzzLocked ? (
                      <div className="buzzpanel">
                        <div className="buzzline">
                          Buzzed: <b>{state.buzz.winnerName}</b>{" "}
                          <span className="muted">({teamName(teams, winnerTeamId)})</span>
                        </div>

                        <button className="btn btn-soft" onClick={resetBuzzer}>Reset Buzzer</button>

                        {interruptChoice === null ? (
                          <div className="host-actions">
                            <button className="btn" onClick={() => chooseInterrupt(true)}>Interrupt</button>
                            <button className="btn btn-soft" onClick={() => chooseInterrupt(false)}>Not interrupt</button>
                          </div>
                        ) : (
                          <div className="host-actions">
                            <div className="muted small">
                              Choice: <b>{interruptChoice ? "Interrupt" : "Not interrupt"}</b>
                            </div>
                            <button className="btn" onClick={() => markAnswer(true)}>Correct</button>
                            <button className="btn btn-soft" onClick={() => markAnswer(false)}>Incorrect</button>
                          </div>
                        )}
                      </div>
                    ) : null}

                    {phase.startsWith("bonus") ? (
                      <div className="buzzpanel">
                        <div className="buzzline">
                          BONUS for <b>{teamName(teams, state.activeBonusTeamId)}</b>
                        </div>

                        <div className="host-actions">
                          <button className="btn" onClick={doneReadingBonus}>Done Reading Bonus (start 20s)</button>
                          <button className="btn" onClick={() => awardBonus(10)}>Correct</button>
                          <button className="btn btn-soft" onClick={() => awardBonus(0)}>Incorrect</button>
                          <button className="btn btn-soft" onClick={skipBonus}>Skip</button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </section>
          </main>

          {/* SCOREBOARD (per toss-up deltas; blanks instead of 0) */}
          <section className="scoreboard card">
            <div className="scoreboard-title">Scoreboard</div>

            <div className="scoreboard-scroll">
              <table className="scoreboard-table">
                <thead>
                  <tr>
                    <th className="sticky-col">#</th>
                    {teams.map((t) => (
                      <th key={t.id} colSpan={4} className="team-group">
                        {t.name}
                      </th>
                    ))}
                  </tr>
                  <tr>
                    <th className="sticky-col subhead"></th>
                    {teams.map((t) => (
                      <React.Fragment key={t.id}>
                        <th className="subhead">P</th>
                        <th className="subhead">TU</th>
                        <th className="subhead">B</th>
                        <th className="subhead">Score</th>
                      </React.Fragment>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {(state.match?.rows || []).map((row) => (
                    <tr key={row.num}>
                      <td className="sticky-col rownum">{row.num}</td>

                      {teams.map((t) => {
                        const v = row.teams?.[t.id] || {};
                        return (
                          <React.Fragment key={t.id}>
                            <td>{v.p || ""}</td>
                            <td>{v.tu || ""}</td>
                            <td>{v.b || ""}</td>
                            <td><b>{v.score ?? 0}</b></td>
                          </React.Fragment>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="muted small" style={{ marginTop: 8 }}>
              P/TU/B are per-toss-up point gains; Score is running total after that toss-up.
            </div>
          </section>
        </>
      )}
    </div>
  );
}
