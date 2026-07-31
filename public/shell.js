"use strict";
/*
 * shell.js — shared "arcade shell" chrome for Agent Arcade game pages.
 *
 * Zero dependencies, classic (non-module) script — include it with a plain
 * <script src="../shell.js"></script> (paired with <link rel="stylesheet"
 * href="../shell.css">), before your own game's inline <script>.
 *
 * Exposes exactly one global: `window.Shell` (also assignable as top-level
 * `Shell`). Public API:
 *
 *   Shell.beep(freq = 660, dur = 0.14, type = "square", when = 0)
 *       Fire-and-forget WebAudio blip. Games call this directly for their own
 *       sound cues (e.g. an "ate food" / "scored" beep). Same signature and
 *       semantics as the beep() helper the original single-file Snake
 *       prototype had inline. Safe to call even if WebAudio throws/is
 *       unavailable (no-ops via try/catch).
 *
 *   Shell.alertChime()
 *       Three-note "pay attention" chime. Shell plays this itself when the
 *       agent starts waiting on you, and (by default) when the game is lost —
 *       exposed in case a game wants the same cue for something of its own.
 *
 *   Shell.doneChime()
 *       Two-note "soft success" chime. Shell plays this itself when the agent
 *       finishes a turn, and (by default) when the game is won — exposed for
 *       reuse.
 *
 *   Shell.watch({ onPoll, onTransition, onOffline })
 *       The page-agnostic half of the driver, usable on pages that have no
 *       game/HUD at all (e.g. the dashboard picker). Starts polling
 *       `/state?watch=1` every 200ms and, for as long as the page lives,
 *       owns: tab-title flashing + Notification permission/dispatch on
 *       entering waiting/done, the WebAudio-unlock-on-click listener, the
 *       alert/done chime on entering waiting/done (deduped so re-entering the
 *       same state doesn't replay it), and the `pagehide` -> POST
 *       /event/closed beacon. `Shell.boot()` is built on top of this.
 *       Callbacks:
 *         onPoll(state)              called after every successful poll.
 *         onTransition(state, prevAgent)  called only when the polled agent
 *                                     or seq actually changed since the last
 *                                     poll — `state.agent` is the new value.
 *         onOffline()                called when the /state fetch fails.
 *       All three are optional. Returns nothing; there's no way to stop a
 *       watcher once started (pages calling this run it for their lifetime).
 *
 *   Shell.overlayController({ overlay, title, body, pill })
 *       Factory sharing the class/textContent mechanics for driving an
 *       `.overlay` element (see shell.css), given its four DOM refs. Returns
 *       `{ set(kind, title, body, pill), hide() }`. `boot()` uses this for
 *       the game-page overlay; the dashboard picker (public/index.html)
 *       builds its own instance from its own refs since it has no Game/HUD
 *       to hang a `boot()` call off of. Copy strings are supplied by each
 *       caller — only the class-toggling mechanics are shared.
 *
 *   Shell.isRunning()
 *       Callable getter. Returns true iff the game should currently be
 *       simulating / accepting input, i.e. not paused by the player and the
 *       agent isn't waiting/done/idle. Shell already gates Game.step/draw/
 *       input on this itself; it's exposed in case a game wants to check it
 *       too (e.g. to skip its own incidental animation while paused).
 *
 *   Shell.boot(Game)
 *       Call this exactly once, at the END of a game page's inline <script>,
 *       after Game is fully defined and after the required DOM has been
 *       parsed (the HUD/stage/overlay/controls markup — copy the ids from
 *       public/index.html or any game page: #dot #status #streak #tools
 *       #score #overlay #ovpill #ovtitle #ovbody #btnResume #btnRestart).
 *       Set your page's <title> BEFORE calling boot() — boot() reads
 *       document.title at call time and uses it as the "base title" that
 *       tab-title-flashing restores when the agent stops needing attention.
 *
 *       boot() wires up: the HUD, Shell.watch()'s /state poll loop and its
 *       reaction to agent transitions (working/waiting/done/idle —
 *       waiting/done/idle auto-pause, never auto-start), the pause/waiting/
 *       done/crashed overlay, chimes + tab-title flashing + Notification
 *       permission request on transitions into waiting/done, the pagehide ->
 *       POST /event/closed beacon, the #btnResume/#btnRestart click
 *       handlers, a single document-level keydown listener, and the
 *       requestAnimationFrame game loop. It also calls Game.reset() once,
 *       immediately, so the game auto-starts on load (matching today's
 *       Snake-auto-plays-on-open behavior).
 *
 * ---- The Game contract ---------------------------------------------------
 * shell.js's own code (see the `loop` function near the bottom) is the
 * ground truth for how these are called; documented here for convenience:
 *
 *   Game.reset()   required. (Re)initialize a fresh round. Called once by
 *                  boot() on load, again on every Restart click, and on
 *                  Resume whenever the round is over (!Game.alive) — i.e.
 *                  reviving a crashed/won game always starts a fresh round.
 *
 *   Game.step(ts)  optional. Called once per animation frame, with the rAF
 *                  timestamp, but ONLY while Shell.isRunning() is true AND
 *                  Game.alive is true. Do your own internal tick-rate
 *                  throttling here (stash and compare against `ts` yourself)
 *                  if you don't want full-framerate logic updates.
 *
 *   Game.draw()    required. Called every animation frame right after
 *                  step(), under the same (running && alive) gate. Render
 *                  current state to your own canvas/DOM. Not called while
 *                  paused or after the round ends — the last drawn frame
 *                  stays frozen on screen under the overlay, by design.
 *
 *   Game.input(e)  required if you take keyboard input. Called from a
 *                  single document-level "keydown" listener, but ONLY while
 *                  Shell.isRunning() is true. Receives the raw KeyboardEvent;
 *                  decide which keys matter yourself and call
 *                  e.preventDefault() yourself when you handle one.
 *
 *   Game.alive     required, boolean property. Read every frame. The instant
 *                  this is false, Shell freezes the loop and shows the
 *                  crash/win overlay (Restart, or Resume, calls Game.reset()
 *                  to bring it back to true).
 *
 *   Game.score     required, number property. Read every frame and mirrored
 *                  into the #score HUD element.
 *
 *   Game.won       optional, boolean property. If true at the moment
 *                  Game.alive goes false, Shell shows the *win* flavor of
 *                  the overlay + chime instead of the crash flavor.
 *
 *   Game.overTitle  optional, string properties. Override Shell's default
 *   Game.overBody   overlay title/body text ("💥 Crashed" / "Resume or
 *                  Restart to play again." — or the win-flavored defaults)
 *                  when the game wants to say something more specific about
 *                  how the round ended. (The overlay's pill text and color
 *                  scheme are always Shell's crashed/won default — only the
 *                  title/body are overridable.)
 * ---------------------------------------------------------------------
 */
(function () {
  "use strict";

  // ---------- audio: short beeps + two named chimes, no asset needed ----------
  let actx;
  function beep(freq = 660, dur = 0.14, type = "square", when = 0) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type; o.frequency.value = freq; o.connect(g); g.connect(actx.destination);
      const t = actx.currentTime + when;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.start(t); o.stop(t + dur);
    } catch (e) {}
  }
  function alertChime() { beep(880, 0.12, "square", 0); beep(1175, 0.12, "square", 0.13); beep(1568, 0.18, "square", 0.27); }
  function doneChime() { beep(523, 0.12, "sine", 0); beep(784, 0.16, "sine", 0.12); }

  // Default overlay copy when the game doesn't supply Game.overTitle/overBody.
  const DEFAULT_CRASH_TITLE = "💥 Crashed";
  const DEFAULT_CRASH_BODY = "Resume or Restart to play again.";
  const DEFAULT_WIN_TITLE = "🏆 You win!";
  const DEFAULT_WIN_BODY = "Resume or Restart to play again.";

  // ---------- shared "is the game live" flag ----------
  // The game runs only while `running` (and Game.alive). It starts true so the
  // game auto-plays the moment the window opens; agent waiting/done/idle
  // auto-pause it, and the player toggles it with the Pause/Resume button
  // (Restart always starts a fresh round). Always change it via setRunning()
  // so the toggle button label/active-state stays in sync.
  let running = true;
  function isRunning() { return running; }

  // ---------- shared overlay-driving mechanics (no HUD/Game dependency) ----------
  function overlayController(els) {
    function set(kind, title, body, pill) {
      els.overlay.className = "overlay show " + kind;
      els.title.textContent = title;
      els.body.textContent = body;
      els.pill.textContent = pill;
    }
    function hide() { els.overlay.className = "overlay"; }
    return { set, hide };
  }

  // ---------- page-agnostic half: poll /state, chime + flash + notify ----------
  // No dependency on any game/HUD DOM — usable standalone (e.g. the dashboard
  // picker) as well as from boot() below.
  function watch(handlers) {
    handlers = handlers || {};

    // Captured at call time so each page's own <title> is what gets restored
    // once the agent stops needing attention.
    const baseTitle = document.title;
    let titleTimer = null;
    function flashTitle(msg) {
      clearInterval(titleTimer); let on = true;
      titleTimer = setInterval(() => { document.title = on ? msg : baseTitle; on = !on; }, 700);
      if (document.hidden) tryNotify(msg);
    }
    function clearFlash() { clearInterval(titleTimer); document.title = baseTitle; }
    function tryNotify(msg) {
      if (!("Notification" in window)) return;
      if (Notification.permission === "granted") new Notification(msg);
      else if (Notification.permission !== "denied") Notification.requestPermission();
    }
    addEventListener("focus", clearFlash);
    addEventListener("click", () => {
      if (!actx) beep(0, 0.001);
      if (window.Notification && Notification.permission === "default") Notification.requestPermission();
    });

    let agent = "idle", lastSeq = -1;
    // Identifies this page's poll loop to the server, so it tracks each open
    // tab's watched status independently — closing one tab (e.g. the picker)
    // shouldn't clear another tab's (e.g. a running game's) watched status.
    const tabId = Math.random().toString(36).slice(2);

    async function poll() {
      let s;
      try {
        const r = await fetch("/state?watch=1&tab=" + tabId, { cache: "no-store" });
        s = await r.json();
      } catch (e) {
        if (handlers.onOffline) handlers.onOffline();
        return;
      }
      const transitioned = s.seq !== lastSeq || s.agent !== agent;
      lastSeq = s.seq;
      const prevAgent = agent;
      agent = s.agent;
      if (transitioned) {
        if (agent === "waiting" && prevAgent !== "waiting") { alertChime(); flashTitle("🔔 AGENT NEEDS YOU"); }
        else if (agent === "done" && prevAgent !== "done") { doneChime(); flashTitle("✓ AGENT DONE"); }
        if (handlers.onTransition) handlers.onTransition(s, prevAgent);
      }
      if (handlers.onPoll) handlers.onPoll(s);
    }
    setInterval(poll, 200); poll();

    // Tell the server the moment this tab goes away, so the next prompt reopens it.
    addEventListener("pagehide", () => navigator.sendBeacon("/event/closed?tab=" + tabId));
  }

  function boot(Game) {
    if (!Game) throw new Error("Shell.boot(Game): a Game object is required");

    // ---------- DOM refs (queried now, not at script-load time, since a game
    // page may load shell.js before its own body markup exists) ----------
    const dot = document.getElementById("dot");
    const status = document.getElementById("status");
    const streakEl = document.getElementById("streak");
    const toolsEl = document.getElementById("tools");
    const scoreEl = document.getElementById("score");
    const overlay = document.getElementById("overlay");
    const ovpill = document.getElementById("ovpill");
    const ovtitle = document.getElementById("ovtitle");
    const ovbody = document.getElementById("ovbody");
    const btnResume = document.getElementById("btnResume");
    const btnRestart = document.getElementById("btnRestart");

    const ov = overlayController({ overlay, title: ovtitle, body: ovbody, pill: ovpill });

    // ---------- pause / resume / restart controls ----------
    // Single source of truth for `running`: keeps the toggle button (Pause⇄Resume) in sync.
    function setRunning(v) {
      running = v;
      btnResume.textContent = v ? "⏸ Pause" : "▶ Resume";
      btnResume.classList.toggle("active", v); // accent while the game is live
    }
    function showPaused() {
      ov.set("idle", "⏸  Paused", "Game paused. Resume to keep playing, or Restart for a new round.", "paused");
    }
    function pause() { setRunning(false); showPaused(); }
    function play(restart) {
      if (restart || !Game.alive) Game.reset(); // Restart, or reviving a finished round → fresh round
      setRunning(true);
      ov.hide();
      if (actx && actx.state === "suspended") actx.resume(); // a click is a user gesture
    }
    btnResume.addEventListener("click", () => { running ? pause() : play(false); btnResume.blur(); });
    btnRestart.addEventListener("click", () => { play(true); btnRestart.blur(); });

    // ---------- state machine driven by the server ----------
    watch({
      onPoll(s) {
        streakEl.textContent = (s.agent === "working" ? s.elapsed : 0).toFixed(1) + "s";
        toolsEl.textContent = s.tools;
        dot.className = "dot " + s.agent;
      },
      onOffline() {
        status.textContent = "server offline";
      },
      // Agent transitions never auto-start the game; waiting/done/idle
      // auto-PAUSE it to pull attention. Only the player's Resume/Restart
      // click sets `running` back to true. (The alert/done chime + tab-title
      // flash for entering waiting/done is handled by watch() itself.)
      onTransition(s) {
        if (s.agent === "working") {
          status.textContent = running ? "working — play" : "working — paused";
          if (!running) showPaused();
          // if running, the loop keeps drawing and hides the overlay
        } else if (s.agent === "waiting") {
          setRunning(false);
          status.textContent = "NEEDS YOU";
          ov.set("alert", "⚠  Agent needs you", (s.reason || "Permission or input required.") + "  ·  Resume or Restart when you're ready.", "needs you");
        } else if (s.agent === "done") {
          setRunning(false);
          status.textContent = "done";
          ov.set("done", "✓  Agent finished", "Turn complete. Streak: " + s.elapsed.toFixed(1) + "s · " + s.tools + " tools.  ·  Resume or Restart to keep playing.", "finished");
        } else { // idle
          setRunning(false);
          status.textContent = "idle";
          ov.set("idle", "Waiting for the agent", "Send a prompt in Claude Code — or Resume / Restart to play now.", "idle");
        }
      },
    });

    // ---------- input: one listener, forwarded to the game while running ----------
    addEventListener("keydown", (e) => {
      if (!running) return;
      if (actx && actx.state === "suspended") actx.resume(); // a keypress is a user gesture too
      if (Game.input) Game.input(e);
    });

    // ---------- requestAnimationFrame loop ----------
    // Tracks whether the crash/win overlay+chime for the *current* game-over has
    // already fired, so it doesn't replay every frame while the overlay sits up.
    let overEventHandled = false;
    function loop(ts) {
      requestAnimationFrame(loop);
      if (!running) return; // paused/waiting/done/idle — last drawn frame stays frozen
      if (!Game.alive) {
        if (running) setRunning(false);
        if (!overEventHandled) {
          overEventHandled = true;
          if (Game.won) {
            doneChime();
            ov.set("done", Game.overTitle || DEFAULT_WIN_TITLE, Game.overBody || DEFAULT_WIN_BODY, "won");
          } else {
            alertChime();
            ov.set("alert", Game.overTitle || DEFAULT_CRASH_TITLE, Game.overBody || DEFAULT_CRASH_BODY, "crashed");
          }
        }
        scoreEl.textContent = Game.score;
        return;
      }
      overEventHandled = false;
      ov.hide();
      if (Game.step) Game.step(ts);
      Game.draw();
      scoreEl.textContent = Game.score;
    }

    Game.reset();
    setRunning(true);
    requestAnimationFrame(loop);
  }

  window.Shell = { beep, alertChime, doneChime, isRunning, watch, overlayController, boot };
})();
