import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import {
  applyGameStartSignalToNetwork,
  applyBrowserControlMessage,
  armClosureCaptureWindow,
  advanceGameStartSignalGeneration,
  buildQuickPlayRuntimeReport,
  buildSnapshotSignature,
  buildSnapshotToken,
  captureTetrioGame,
  cheapGameSignalExpression,
  clearSnapshotFile,
  completeNextGameReacquire,
  collectQuickPlayClosureDiagnosticFromPausedScopes,
  consumeGameStartSignal,
  createBrowserControlState,
  createBootstrapState,
  createClosureCaptureState,
  createEndedGameCandidateState,
  createGameStartSignalState,
  createInteractionTrackerInstallState,
  createNextGameReacquireState,
  createPostGameInteractionWatchState,
  createQuickPlayDiagnosticState,
  createSnapshotTracking,
  carryPendingPostGameInteractionIntoReacquire,
  cancelPostGameInteractionWatch,
  deriveGameplayPhase,
  disarmClosureCaptureWindow,
  determineChromiumOwnership,
  ensureNextGameInteractionTrackerInstalled,
  expireClosureCaptureWindow,
  activatePendingClosureCaptureArm,
  clearPendingClosureCaptureArm,
  exposeTetrioGameFromPausedCallFrames,
  ensureZenithBootstrapCheckScheduled,
  getBootstrapReadinessStatus,
  hasUnconsumedGameStartSignal,
  hasPendingClosureCaptureArm,
  isBootstrapReadyForClosureCapture,
  isClosureCaptureArmed,
  isGameplayExpectedForClosureCapture,
  isZenithGameplayOptions,
  isTransientRuntimeError,
  isVsWsSimEnvEnabled,
  isTetrioGameEndedState,
  nextGameInteractionTrackerExpression,
  pausedFrameExposureExpression,
  quickPlayClosureCandidateScanExpression,
  quickPlaySessionCandidateSurveyExpression,
  maybeRunQuickPlayDiagnosticCapture,
  maybeRunZenithBootstrapCheck,
  mergeQuickPlaySessionSurvey,
  noteGameStartSignal,
  primeNextGameInteractionBaseline,
  pollQuickPlayPassiveSnapshotNow,
  retainQuickPlayPassiveCandidateHandle,
  primePostGameInteractionWatchBaseline,
  readTetrioState,
  readNextGameInteractionState,
  registerNextGameInteractionTrackerForFutureDocuments,
  requestClosureCaptureArm,
  reactivateClosureCaptureArmAfterBootstrap,
  recordQuickPlayClosureCandidates,
  recordQuickPlayDiagnosticEnvelope,
  reconcileQuickPlayPassiveBinding,
  releaseQuickPlayPassiveState,
  resetGameStartSignalState,
  resetPostGameInteractionWatch,
  resetPausedScopeScanProgress,
  resetZenithBootstrapCheckState,
  resetClosureCaptureLocatorHint,
  resetBootstrapState,
  resetTetrioNetworkState,
  releaseEndedGameCandidateHandle,
  resolvePollMs,
  resolveUseSeedSimulationFallback,
  resetSnapshotTracking,
  safeRuntimeEvaluate,
  scheduleClosureCaptureContinuation,
  scheduleNextClosureCaptureAttempt,
  shouldAttemptClosureCapture,
  shouldLogClosureCaptureSkipped,
  shouldLogStateReason,
  shouldAdvanceGameEpoch,
  shouldHandleEndedGame,
  scanQuickPlayClosureCandidates,
  setNextGameInteractionBaseline,
  startQuickPlayDiagnosticCapture,
  stopQuickPlayDiagnosticCapture,
  createZenithBootstrapCheckState,
  startPostGameInteractionWatch,
  startNextGameReacquire,
  tetrioStateExpression,
  updateQuickPlayPendingIdentity,
  updateBootstrapDocumentState
} from "./tetrio-cdp-source.mjs";

test("connect-only snapshot helper never claims Chromium ownership", () => {
  assert.equal(
    determineChromiumOwnership({ connectOnly: true, alreadyOpen: false }),
    false
  );
  assert.equal(
    determineChromiumOwnership({ connectOnly: true, alreadyOpen: true }),
    false
  );
});

test("snapshot helper owns Chromium only when it launched the browser", () => {
  assert.equal(
    determineChromiumOwnership({ connectOnly: false, alreadyOpen: false }),
    true
  );
  assert.equal(
    determineChromiumOwnership({ connectOnly: false, alreadyOpen: true }),
    false
  );
});

function createBoard() {
  return Array.from({ length: 40 }, () => Array.from({ length: 10 }, () => 0));
}

function createGame({
  destroyed = false,
  started = true,
  playing = true,
  current = "t",
  hold = "i",
  queue = ["o", "s", "z"],
  pieceCounter = 0,
  linesCleared = undefined,
  board = createBoard()
} = {}) {
  return {
    ejectState() {
      return {
        game: {
          board,
          falling: { type: current, x: 4, y: 19, rotation: 0 },
          hold,
          queue,
          stats: {
            piecesplaced: pieceCounter,
            lines: linesCleared,
            combo: 0,
            b2b: 0,
            impendingdamage: 0
          },
          destroyed,
          dead: destroyed,
          gameover: destroyed,
          started
        }
      };
    },
    ejectBoardState() {
      return { b: board };
    },
    isPlaying() {
      return playing;
    },
    isStarted() {
      return started;
    }
  };
}

function evaluateInWindow(expression, windowOverrides = {}, extraContext = {}) {
  const window = {
    ...windowOverrides
  };
  window.window = window;
  const context = {
    window,
    location: { href: "https://tetr.io/" },
    Date,
    Math,
    Object,
    Array,
    Boolean,
    Number,
    Promise,
    String,
    ...extraContext
  };
  return {
    result: vm.runInNewContext(expression, context),
    window
  };
}

function executeObjectFunction(functionDeclaration, target, args = []) {
  return vm.runInNewContext(
    `(${functionDeclaration}).apply(__target, __args)`,
    {
      __target: target,
      __args: Array.isArray(args) ? args : [],
      Date,
      Math,
      Object,
      Array,
      Boolean,
      Number,
      String,
      Set,
      Map
    }
  );
}

async function withPatchedDateNow(getNow, callback) {
  const originalDateNow = Date.now;
  Date.now = getNow;
  try {
    return await callback();
  } finally {
    Date.now = originalDateNow;
  }
}

function createReadStateCdp(values) {
  const queue = [...values];
  return {
    runtimeCalls: [],
    async send(method, params = {}) {
      if (method !== "Runtime.evaluate") {
        throw new Error(`Unhandled method ${method}`);
      }
      this.runtimeCalls.push(params);
      if (String(params.expression).includes("document.readyState")) {
        return {
          result: {
            value: {
              readyState: "complete",
              href: "https://tetr.io/"
            }
          }
        };
      }
      return {
        result: {
          value: queue.shift() ?? {
            ok: false,
            ready: false,
            reason: "mock state missing"
          }
        }
      };
    }
  };
}

function readyBootstrapState(now = 20_000, { transportReadyAt = 18_500 } = {}) {
  const bootstrapState = createBootstrapState(0);
  updateBootstrapDocumentState(
    bootstrapState,
    { readyState: "complete", href: "https://tetr.io/" },
    1
  );
  bootstrapState.transportReadyAt = transportReadyAt;
  bootstrapState.readyLogged = false;
  bootstrapState.waitingLogged = false;
  return bootstrapState;
}

function armedClosureCaptureState(
  now = 20_000,
  { reason = "ribbon_seed", windowMs = 8000 } = {}
) {
  const closureCaptureState = createClosureCaptureState();
  armClosureCaptureWindow(closureCaptureState, {
    reason,
    now,
    windowMs,
    log: () => {}
  });
  return closureCaptureState;
}

function makeQuickPlayDiagnosticTempPaths() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "quick-play-diagnostic-"));
  return {
    dir,
    reportPath: path.join(dir, "quick-play-runtime-report.json"),
    rawWsPath: path.join(dir, "quick-play-ws-raw.jsonl"),
    closurePath: path.join(dir, "quick-play-closure-candidates.jsonl"),
    callframePath: path.join(dir, "quick-play-callframes.jsonl"),
    passiveSnapshotPath: path.join(dir, "quick-play-passive-snapshot.json"),
    fingerprintPath: path.join(dir, "solo-closure-fingerprint.json")
  };
}

function cleanupQuickPlayDiagnosticTempPaths(paths) {
  rmSync(paths.dir, { recursive: true, force: true });
}

function makeQuickPlayState(paths) {
  const state = createQuickPlayDiagnosticState();
  state.reportPath = paths.reportPath;
  state.rawWsPath = paths.rawWsPath;
  state.closurePath = paths.closurePath;
  state.callframePath = paths.callframePath;
  state.passiveSnapshotPath = paths.passiveSnapshotPath;
  state.soloClosureFingerprintPath = paths.fingerprintPath;
  return state;
}

function makeBoundQuickPlayCandidate(overrides = {}) {
  return {
    generation: 1,
    targetId: "https://tetr.io/",
    candidateId: "cand-default",
    rootObjectId: "retained-default",
    retainedRootKind: "state",
    retainedRootPath: [],
    rootPath: [],
    functionName: "_tick",
    callFrameIndex: 5,
    scopeIndex: 4,
    scopeType: "closure",
    bindingName: "Ra",
    boardPath: ["board"],
    currentPath: ["current"],
    holdPath: ["hold"],
    queuePath: ["queue"],
    capturedAt: 1_000,
    userid: null,
    gameid: null,
    wsPlayerId: "",
    identityBound: false,
    ...overrides
  };
}

function makeQuickPlayPassiveRetainedRoot({
  pause = null,
  paused = undefined,
  board = Array.from({ length: 40 }, () => Array.from({ length: 10 }, () => 0)),
  current = { type: "j", x: 4, y: 19, rotation: 1 },
  hold = "i",
  queue = ["o", "s", "z"],
  playing = true,
  started = true,
  destroyed = false,
  pieceCounter = 12
} = {}) {
  const state = {
    board: board.map((row) => row.slice()),
    current: { ...current },
    hold,
    queue: queue.slice(),
    playing,
    started,
    pause,
    destroyed,
    successful: null,
    gameoverreason: null,
    pieceCounter
  };
  if (paused !== undefined) {
    state.paused = paused;
  }
  return state;
}

function createPassiveSnapshotEvalCdp(retainedRoot) {
  return {
    async send(method, params = {}) {
      if (method === "Runtime.callFunctionOn") {
        const call = vm.runInThisContext(`(${params.functionDeclaration})`);
        const args = Array.isArray(params.arguments)
          ? params.arguments.map((entry) => entry?.value)
          : [];
        return {
          result: {
            value: call.call(retainedRoot, ...args)
          }
        };
      }
      if (method === "Runtime.releaseObject" || method === "Runtime.releaseObjectGroup") {
        return {};
      }
      throw new Error(`unexpected method ${method}`);
    }
  };
}

async function pollPassiveSnapshotForRetainedRoot(retainedRoot) {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const state = makeQuickPlayState(paths);
  state.active = true;
  state.boundLocalClosureCandidate = makeBoundQuickPlayCandidate({
    identityBound: true,
    userid: "user-passive",
    gameid: "game-passive"
  });
  const logs = [];
  try {
    const result = await pollQuickPlayPassiveSnapshotNow(
      createPassiveSnapshotEvalCdp(retainedRoot),
      state,
      {
        now: 9_001,
        log: (line) => logs.push(line)
      }
    );
    const written = JSON.parse(readFileSync(paths.passiveSnapshotPath, "utf8"));
    return { result, written, logs };
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
}

test("raw pause null produces paused=false", async () => {
  const { result, written } = await pollPassiveSnapshotForRetainedRoot(
    makeQuickPlayPassiveRetainedRoot({ pause: null })
  );

  assert.equal(result.status, "ready");
  assert.equal(written.status, "ready");
  assert.equal(written.capture_status, "running");
  assert.equal(written.snapshot.paused, false);
});

test("raw pause active representation produces paused=true", async () => {
  const { written } = await pollPassiveSnapshotForRetainedRoot(
    makeQuickPlayPassiveRetainedRoot({
      pause: {
        reason: "manual_pause",
        startedAt: 123
      }
    })
  );

  assert.equal(written.snapshot.paused, true);
});

test("paused output is always boolean", async () => {
  const normal = await pollPassiveSnapshotForRetainedRoot(
    makeQuickPlayPassiveRetainedRoot({ pause: null })
  );
  const paused = await pollPassiveSnapshotForRetainedRoot(
    makeQuickPlayPassiveRetainedRoot({ pause: { reason: "manual_pause" } })
  );

  assert.equal(typeof normal.written.snapshot.paused, "boolean");
  assert.equal(typeof paused.written.snapshot.paused, "boolean");
});

test("passive snapshot canonicalizes current hold and queue piece casing", async () => {
  const { result, written } = await pollPassiveSnapshotForRetainedRoot(
    makeQuickPlayPassiveRetainedRoot({
      current: { type: "i", x: 4, y: 19, rotation: 1 },
      hold: "j",
      queue: ["t", "S", "z"]
    })
  );

  assert.equal(result.status, "ready");
  assert.equal(written.snapshot.current.type, "I");
  assert.equal(written.snapshot.current.x, 4);
  assert.equal(written.snapshot.current.y, 19);
  assert.equal(written.snapshot.current.rotation, 1);
  assert.equal(written.snapshot.hold, "J");
  assert.deepEqual(written.snapshot.queue, ["T", "S", "Z"]);
});

test("passive snapshot preserves null hold", async () => {
  const { result, written } = await pollPassiveSnapshotForRetainedRoot(
    makeQuickPlayPassiveRetainedRoot({ hold: null })
  );

  assert.equal(result.status, "ready");
  assert.equal(written.snapshot.hold, null);
});

test("passive snapshot rejects unknown queue piece semantically", async () => {
  const { result, written } = await pollPassiveSnapshotForRetainedRoot(
    makeQuickPlayPassiveRetainedRoot({ queue: ["t", "garbage", "z"] })
  );

  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "invalid_queue_piece");
  assert.equal(written.status, "unavailable");
});

test("raw pause normalization keeps board current hold and queue unchanged", async () => {
  const board = Array.from({ length: 40 }, (_, rowIndex) =>
    Array.from({ length: 10 }, (_, colIndex) => (rowIndex === 0 && colIndex === 0 ? 1 : 0))
  );
  const current = { type: "t", x: 3, y: 18, rotation: 2 };
  const hold = "l";
  const queue = ["j", "o", "s"];
  const normal = await pollPassiveSnapshotForRetainedRoot(
    makeQuickPlayPassiveRetainedRoot({
      pause: null,
      board,
      current,
      hold,
      queue
    })
  );
  const paused = await pollPassiveSnapshotForRetainedRoot(
    makeQuickPlayPassiveRetainedRoot({
      pause: { reason: "manual_pause" },
      board,
      current,
      hold,
      queue
    })
  );

  assert.deepEqual(paused.written.snapshot.board, normal.written.snapshot.board);
  assert.deepEqual(paused.written.snapshot.current, normal.written.snapshot.current);
  assert.equal(paused.written.snapshot.hold, normal.written.snapshot.hold);
  assert.deepEqual(paused.written.snapshot.queue, normal.written.snapshot.queue);
  assert.deepEqual(paused.written.snapshot.queue, ["J", "O", "S"]);
});

function createStorageMock(entries = {}) {
  const map = new Map(Object.entries(entries));
  const keys = [...map.keys()];
  return {
    get length() {
      return keys.length;
    },
    key(index) {
      return keys[index] ?? null;
    },
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    }
  };
}

function createIndexedDbMock(databases = []) {
  const catalog = databases.map((database) => ({
    name: database.name,
    objectStores: [...(database.objectStores ?? [])]
  }));
  return {
    async databases() {
      return catalog.map((database) => ({ name: database.name }));
    },
    open(name) {
      const match = catalog.find((database) => database.name === name);
      const request = {
        result: {
          objectStoreNames: match?.objectStores ?? [],
          close() {}
        },
        onerror: null,
        onsuccess: null,
        onupgradeneeded: null
      };
      Promise.resolve().then(() => {
        request.onsuccess?.({ target: request });
      });
      return request;
    }
  };
}

test("diagnostic capture works only in Zenith mode and does not change bot state", () => {
  const controlState = createBrowserControlState();
  const paths = makeQuickPlayDiagnosticTempPaths();
  const diagnosticState = makeQuickPlayState(paths);
  try {
    assert.equal(
      startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
        now: 1_000,
        log: () => {}
      }).started,
      false
    );

    controlState.selectedMode = "friendly_vs";
    assert.equal(
      startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
        now: 1_000,
        log: () => {}
      }).started,
      false
    );

    controlState.selectedMode = "zenith";
    controlState.botEnabled = true;
    assert.equal(
      startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
        now: 1_000,
        log: () => {}
      }).started,
      false
    );

    controlState.botEnabled = false;
    const applied = applyBrowserControlMessage({
      message: { type: "quick_play_diagnostic", enabled: true },
      controlState,
      quickPlayDiagnosticState: diagnosticState,
      closureCaptureState: createClosureCaptureState(),
      nextGameReacquireState: createNextGameReacquireState(),
      now: 1_000,
      log: () => {}
    });

    assert.equal(applied, true);
    assert.equal(controlState.botEnabled, false);
    assert.equal(controlState.selectedMode, "zenith");
    assert.equal(diagnosticState.active, true);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("zenith passive owner starts while bot is enabled and avoids manual artifacts", () => {
  const controlState = createBrowserControlState();
  const paths = makeQuickPlayDiagnosticTempPaths();
  const diagnosticState = makeQuickPlayState(paths);
  const logs = [];
  try {
    controlState.selectedMode = "zenith";
    controlState.botEnabled = true;

    const applied = applyBrowserControlMessage({
      message: {
        type: "quick_play_passive_provider",
        owner: "zenith_dry_run",
        enabled: true
      },
      controlState,
      quickPlayDiagnosticState: diagnosticState,
      closureCaptureState: createClosureCaptureState(),
      nextGameReacquireState: createNextGameReacquireState(),
      now: 2_000,
      log: (line) => logs.push(line)
    });

    assert.equal(applied, true);
    assert.equal(diagnosticState.active, true);
    assert.equal(diagnosticState.ownerRequests.zenith_dry_run, true);
    assert.equal(diagnosticState.ownerRequests.manual_diagnostic, false);
    assert.ok(
      logs.includes(
        "[zenith-dry-run] passive provider active mode=zenith packet_limit=unlimited duration=owner_lifecycle"
      )
    );
    assert.equal(existsSync(paths.reportPath), false);
    assert.equal(existsSync(paths.rawWsPath), false);
    assert.equal(existsSync(paths.closurePath), false);
    assert.equal(existsSync(paths.callframePath), false);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("zenith passive owner stores shared local username hint", () => {
  const controlState = createBrowserControlState();
  const paths = makeQuickPlayDiagnosticTempPaths();
  const diagnosticState = makeQuickPlayState(paths);
  try {
    controlState.selectedMode = "zenith";
    controlState.botEnabled = true;

    const applied = applyBrowserControlMessage({
      message: {
        type: "quick_play_passive_provider",
        owner: "zenith_dry_run",
        enabled: true,
        username_hint: "ExactLocal"
      },
      controlState,
      quickPlayDiagnosticState: diagnosticState,
      closureCaptureState: createClosureCaptureState(),
      nextGameReacquireState: createNextGameReacquireState(),
      now: 2_050,
      log: () => {}
    });

    assert.equal(applied, true);
    assert.equal(diagnosticState.diagnosticUsernameHint, "ExactLocal");
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("active zenith passive owner refreshes shared local username hint", () => {
  const controlState = createBrowserControlState();
  const paths = makeQuickPlayDiagnosticTempPaths();
  const diagnosticState = makeQuickPlayState(paths);
  try {
    controlState.selectedMode = "zenith";
    controlState.botEnabled = true;

    applyBrowserControlMessage({
      message: {
        type: "quick_play_passive_provider",
        owner: "zenith_dry_run",
        enabled: true,
        username_hint: "FirstLocal"
      },
      controlState,
      quickPlayDiagnosticState: diagnosticState,
      closureCaptureState: createClosureCaptureState(),
      nextGameReacquireState: createNextGameReacquireState(),
      now: 2_050,
      log: () => {}
    });

    const applied = applyBrowserControlMessage({
      message: {
        type: "quick_play_passive_provider",
        owner: "zenith_dry_run",
        enabled: true,
        username_hint: "UpdatedLocal"
      },
      controlState,
      quickPlayDiagnosticState: diagnosticState,
      closureCaptureState: createClosureCaptureState(),
      nextGameReacquireState: createNextGameReacquireState(),
      now: 2_075,
      log: () => {}
    });

    assert.equal(applied, true);
    assert.equal(diagnosticState.active, true);
    assert.equal(diagnosticState.diagnosticUsernameHint, "UpdatedLocal");
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("wrong mode still rejects zenith passive owner with actual mode in logs", () => {
  const controlState = createBrowserControlState();
  const paths = makeQuickPlayDiagnosticTempPaths();
  const diagnosticState = makeQuickPlayState(paths);
  const logs = [];
  try {
    controlState.selectedMode = "friendly_vs";
    controlState.botEnabled = true;

    const applied = applyBrowserControlMessage({
      message: {
        type: "quick_play_passive_provider",
        owner: "zenith_dry_run",
        enabled: true
      },
      controlState,
      quickPlayDiagnosticState: diagnosticState,
      closureCaptureState: createClosureCaptureState(),
      nextGameReacquireState: createNextGameReacquireState(),
      now: 2_200,
      log: (line) => logs.push(line)
    });

    assert.equal(applied, false);
    assert.equal(diagnosticState.active, false);
    assert.ok(
      logs.includes(
        "[quick-play] passive provider rejected owner=zenith_dry_run reason=mode_not_zenith actual_mode=friendly_vs"
      )
    );
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("selected_mode control message delivers zenith mode before automatic owner start", () => {
  const controlState = createBrowserControlState();
  const paths = makeQuickPlayDiagnosticTempPaths();
  const diagnosticState = makeQuickPlayState(paths);
  try {
    const modeApplied = applyBrowserControlMessage({
      message: { type: "selected_mode", mode: "zenith", generation: 44 },
      controlState,
      closureCaptureState: createClosureCaptureState(),
      nextGameReacquireState: createNextGameReacquireState(),
      quickPlayDiagnosticState: diagnosticState,
      now: 2_250,
      log: () => {}
    });
    assert.equal(modeApplied, true);
    assert.equal(controlState.selectedMode, "zenith");
    assert.equal(controlState.modeGeneration, 44);

    controlState.botEnabled = true;
    const started = applyBrowserControlMessage({
      message: {
        type: "quick_play_passive_provider",
        owner: "zenith_dry_run",
        enabled: true
      },
      controlState,
      quickPlayDiagnosticState: diagnosticState,
      closureCaptureState: createClosureCaptureState(),
      nextGameReacquireState: createNextGameReacquireState(),
      now: 2_251,
      log: () => {}
    });

    assert.equal(started, true);
    assert.equal(diagnosticState.active, true);
    assert.equal(diagnosticState.captureGeneration, 44);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("manual owner can join and leave zenith passive provider without stopping capture", () => {
  const controlState = createBrowserControlState();
  const paths = makeQuickPlayDiagnosticTempPaths();
  const diagnosticState = makeQuickPlayState(paths);
  try {
    controlState.selectedMode = "zenith";
    controlState.botEnabled = true;

    applyBrowserControlMessage({
      message: {
        type: "quick_play_passive_provider",
        owner: "zenith_dry_run",
        enabled: true
      },
      controlState,
      quickPlayDiagnosticState: diagnosticState,
      closureCaptureState: createClosureCaptureState(),
      nextGameReacquireState: createNextGameReacquireState(),
      now: 3_000,
      log: () => {}
    });

    applyBrowserControlMessage({
      message: {
        type: "quick_play_passive_provider",
        owner: "manual_diagnostic",
        enabled: true
      },
      controlState,
      quickPlayDiagnosticState: diagnosticState,
      closureCaptureState: createClosureCaptureState(),
      nextGameReacquireState: createNextGameReacquireState(),
      now: 3_100,
      log: () => {}
    });

    assert.equal(diagnosticState.active, true);
    assert.equal(diagnosticState.ownerRequests.zenith_dry_run, true);
    assert.equal(diagnosticState.ownerRequests.manual_diagnostic, true);
    assert.equal(existsSync(paths.closurePath), true);
    assert.equal(existsSync(paths.callframePath), true);

    applyBrowserControlMessage({
      message: {
        type: "quick_play_passive_provider",
        owner: "manual_diagnostic",
        enabled: false
      },
      controlState,
      quickPlayDiagnosticState: diagnosticState,
      closureCaptureState: createClosureCaptureState(),
      nextGameReacquireState: createNextGameReacquireState(),
      now: 3_200,
      log: () => {}
    });

    assert.equal(diagnosticState.active, true);
    assert.equal(diagnosticState.ownerRequests.zenith_dry_run, true);
    assert.equal(diagnosticState.ownerRequests.manual_diagnostic, false);

    applyBrowserControlMessage({
      message: {
        type: "quick_play_passive_provider",
        owner: "zenith_dry_run",
        enabled: false
      },
      controlState,
      quickPlayDiagnosticState: diagnosticState,
      closureCaptureState: createClosureCaptureState(),
      nextGameReacquireState: createNextGameReacquireState(),
      now: 3_300,
      log: () => {}
    });

    assert.equal(diagnosticState.active, false);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("session candidate and participant candidate remain distinct", async () => {
  const sessionUser = { _id: "local-id", username: "VISIBLE_ROOT" };
  const rosterPlayer = {
    userid: "player-a",
    username: "VISIBLE_ROOT",
    gameid: 7001,
    naturalorder: 1
  };
  const document = {
    querySelector() {
      return {
        textContent: "VISIBLE_ROOT",
        getAttribute(name) {
          return name === "data-username" ? "VISIBLE_ROOT" : null;
        },
        dataset: { username: "VISIBLE_ROOT" }
      };
    }
  };
  const { result } = evaluateInWindow(
    quickPlaySessionCandidateSurveyExpression(),
    {
      document,
      localStorage: createStorageMock(),
      sessionStorage: createStorageMock(),
      __NUXT__: {
        state: {
          session: {
            user: sessionUser
          },
          room: {
            players: [rosterPlayer]
          }
        }
      }
    },
    { document }
  );
  const survey = await result;

  assert.equal(survey.status, "ready");
  assert.equal(survey.screenUsername, null);
  assert.deepEqual(JSON.parse(JSON.stringify(survey.legacyPath)), {
    __NUXT__: true,
    state: true,
    session: true,
    user: true
  });
  const sessionCandidate = survey.candidates.find(
    (candidate) => candidate.path === "window.__NUXT__.state.session.user"
  );
  const participantCandidate = survey.candidates.find((candidate) =>
    String(candidate.path).includes(".players[0]")
  );
  assert.equal(sessionCandidate?.candidateKind, "session_user");
  assert.equal(sessionCandidate?.screenUsernameMatches ?? null, null);
  assert.equal(participantCandidate?.candidateKind, "participant_candidate");
  assert.ok(
    survey.screenIdentityEvidence.some((entry) => entry.text === "VISIBLE_ROOT")
  );
});

test("generic [data-username] cannot resolve self and incorrect DOM username remains unresolved", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const diagnosticState = makeQuickPlayState(paths);
  const document = {
    querySelector(selector) {
      if (selector === "[data-username]") {
        return {
          textContent: "osk",
          getAttribute(name) {
            return name === "data-username" ? "osk" : null;
          },
          dataset: { username: "osk" }
        };
      }
      return null;
    }
  };
  try {
    const { result } = evaluateInWindow(
      quickPlaySessionCandidateSurveyExpression(),
      {
        document,
        localStorage: createStorageMock(),
        sessionStorage: createStorageMock()
      },
      { document }
    );
    mergeQuickPlaySessionSurvey(diagnosticState, await result, 100);
    diagnosticState.wsPlayers.set("ws-1", {
      userid: "player-1",
      username: "actual-player",
      gameid: 5001,
      seed: 7001,
      firstSeen: 1,
      lastSeen: 2
    });

    const report = buildQuickPlayRuntimeReport(diagnosticState);
    assert.equal(report.screen_username, null);
    assert.equal(report.ws_self_evidence.status, "unresolved");
    assert.equal(report.local_resolution, null);
    assert.ok(
      report.diagnostics.session_scan.screen_identity_evidence.some(
        (entry) => entry.selector === "[data-username]" && entry.text === "osk"
      )
    );
    assert.ok(
      report.ws_self_evidence.rejected_strategies.includes(
        "no_verified_storage_identity_candidate"
      )
    );
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("storage identity probe records only whitelisted fields and IndexedDB names", async () => {
  const document = { querySelector() { return null; } };
  const { result } = evaluateInWindow(
    quickPlaySessionCandidateSurveyExpression(),
    {
      document,
      localStorage: createStorageMock({
        userConfig: JSON.stringify({
          _id: "user-1",
          username: "alpha",
          token: "secret-token",
          session: { id: "secret-session" }
        }),
        debugIdentity: JSON.stringify({
          token: "debug-token",
          password: "debug-password"
        })
      }),
      sessionStorage: createStorageMock({
        auth: JSON.stringify({
          authorization: "Bearer hidden",
          username: "shadow"
        })
      }),
      indexedDB: createIndexedDbMock([
        {
          name: "tetrio",
          objectStores: ["profiles", "sessions"]
        }
      ])
    },
    { document }
  );
  const survey = await result;
  const serialized = JSON.stringify(survey);
  const userConfigRecord = survey.storageIdentityRecords.find(
    (entry) => entry.path === "localStorage.userConfig"
  );

  assert.equal(survey.status, "ready");
  assert.deepEqual(JSON.parse(JSON.stringify(userConfigRecord)), {
    path: "localStorage.userConfig",
    parsed: true,
    safeFields: {
      userid: "user-1",
      username: "alpha"
    },
    sensitiveFieldsRedacted: true
  });
  assert.ok(
    survey.candidates.some(
      (candidate) =>
        candidate.path === "localStorage.userConfig" &&
        candidate.candidateKind === "storage_identity"
    )
  );
  assert.ok(
    !survey.candidates.some((candidate) => candidate.path === "localStorage.debugIdentity")
  );
  assert.deepEqual(JSON.parse(JSON.stringify(survey.indexedDbCatalog)), [
    {
      database: "tetrio",
      objectStores: ["profiles", "sessions"]
    }
  ]);
  assert.ok(!serialized.includes("secret-token"));
  assert.ok(!serialized.includes("secret-session"));
  assert.ok(!serialized.includes("debug-password"));
  assert.ok(!serialized.includes("Bearer hidden"));
});

test("diagnostic username exact profile match returns userid", () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const diagnosticState = makeQuickPlayState(paths);
  try {
    diagnosticState.diagnosticUsernameHint = "ExactLocal";
    diagnosticState.wsPlayers.set("player", {
      userid: "user-7",
      username: "ExactLocal",
      gameid: 7007,
      seed: 9007,
      firstSeen: 1,
      lastSeen: 2
    });

    const report = buildQuickPlayRuntimeReport(diagnosticState);
    assert.equal(report.ws_self_evidence.status, "resolved");
    assert.equal(report.ws_self_evidence.userid, "user-7");
    assert.equal(report.ws_self_evidence.gameid, 7007);
    assert.equal(report.ws_self_evidence.evidence[0]?.kind, "diagnostic_username_hint");
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("userid must uniquely map to gameid and ambiguous profile remains unresolved", () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  try {
    const ambiguousProfile = makeQuickPlayState(paths);
    ambiguousProfile.diagnosticUsernameHint = "shared";
    ambiguousProfile.wsPlayers.set("one", {
      userid: "user-1",
      username: "shared",
      gameid: 11,
      seed: 21,
      firstSeen: 1,
      lastSeen: 2
    });
    ambiguousProfile.wsPlayers.set("two", {
      userid: "user-2",
      username: "shared",
      gameid: 12,
      seed: 22,
      firstSeen: 1,
      lastSeen: 2
    });
    let report = buildQuickPlayRuntimeReport(ambiguousProfile);
    assert.equal(report.ws_self_evidence.status, "unresolved");
    assert.ok(
      report.ws_self_evidence.rejected_strategies.includes(
        "diagnostic_username_not_unique_to_userid"
      )
    );

    const ambiguousGame = makeQuickPlayState(paths);
    ambiguousGame.diagnosticUsernameHint = "unique";
    ambiguousGame.wsPlayers.set("one", {
      userid: "user-9",
      username: "unique",
      gameid: 91,
      seed: 101,
      firstSeen: 1,
      lastSeen: 2
    });
    ambiguousGame.wsPlayers.set("two", {
      userid: "user-9",
      username: "unique",
      gameid: 92,
      seed: 102,
      firstSeen: 1,
      lastSeen: 2
    });
    report = buildQuickPlayRuntimeReport(ambiguousGame);
    assert.equal(report.ws_self_evidence.status, "unresolved");
    assert.ok(
      report.ws_self_evidence.rejected_strategies.includes(
        "diagnostic_userid_not_unique_to_gameid"
      )
    );
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("closure candidates receive stable diagnostic ids", () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const diagnosticState = makeQuickPlayState(paths);
  try {
    const now = 5_000;
    recordQuickPlayClosureCandidates(
      diagnosticState,
      {
        candidates: [
          {
            candidateId: "window.app.game",
            locator: "window.app.game",
            pieceCounter: 1,
            current: "t",
            hold: "i",
            queue: ["o", "s"],
            boardWidth: 10,
            boardHeight: 20,
            boardHash: "abcd1234",
            rowOccupancy: [0, 0, 1],
            playing: true,
            ended: false
          }
        ]
      },
      now
    );
    recordQuickPlayClosureCandidates(
      diagnosticState,
      {
        candidates: [
          {
            candidateId: "window.app.game",
            locator: "window.app.game",
            pieceCounter: 2,
            current: "o",
            hold: "i",
            queue: ["s", "z"],
            boardWidth: 10,
            boardHeight: 20,
            boardHash: "abcd5678",
            rowOccupancy: [0, 1, 1],
            playing: true,
            ended: false
          }
        ]
      },
      now + 250
    );

    const candidate = diagnosticState.closureCandidates.get("window.app.game");
    assert.equal(diagnosticState.closureCandidates.size, 1);
    assert.equal(candidate?.candidate_id, "window.app.game");
    assert.equal(candidate?.pieceCounter, 2);
    assert.equal(candidate?.firstSeen, now);
    assert.equal(candidate?.lastSeen, now + 250);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("no forced match without common evidence and high-confidence match requires stable shared identifiers", () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const unresolvedState = makeQuickPlayState(paths);
  try {
    unresolvedState.wsPlayers.set("a", {
      userid: "ws-a",
      username: "alpha",
      gameid: 1001,
      seed: 2001,
      firstSeen: 1,
      lastSeen: 2
    });
    unresolvedState.closureCandidates.set("closure-a", {
      candidate_id: "closure-a",
      userid: "closure-b",
      gameid: 9999,
      seed: 8888,
      firstSeen: 1,
      lastSeen: 2
    });
    let report = buildQuickPlayRuntimeReport(unresolvedState);
    assert.deepEqual(report.matches, []);

    const matchedState = makeQuickPlayState(paths);
    matchedState.wsPlayers.set("b", {
      userid: "local-id",
      username: "visible_root",
      gameid: 4321,
      seed: 9876,
      firstSeen: 10,
      lastSeen: 20
    });
    matchedState.closureCandidates.set("closure-b", {
      candidate_id: "closure-b",
      userid: null,
      gameid: 4321,
      seed: 9876,
      firstSeen: 12,
      lastSeen: 18
    });
    report = buildQuickPlayRuntimeReport(matchedState);
    assert.equal(report.matches.length, 1);
    assert.equal(report.matches[0].confidence, "high");
    assert.deepEqual(report.matches[0].matched_by, ["gameid", "seed", "timing_overlap"]);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("capture stops after bounded time and packet count", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  const diagnosticState = makeQuickPlayState(paths);
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 1_000,
      log: () => {}
    });
    diagnosticState.stopAt = 1_050;
    const result = await maybeRunQuickPlayDiagnosticCapture({
      cdp: {
        async send() {
          throw new Error("should not run after timeout");
        }
      },
      quickPlayDiagnosticState: diagnosticState,
      browserControlState: controlState,
      transientState: { lastRuntimeError: "" },
      now: 1_051,
      log: () => {}
    });
    assert.equal(result.stopped, true);
    assert.equal(diagnosticState.active, false);
    assert.ok(existsSync(paths.reportPath));

    const packetPaths = makeQuickPlayDiagnosticTempPaths();
    const packetState = makeQuickPlayState(packetPaths);
    packetState.maxWsPackets = 1;
    startQuickPlayDiagnosticCapture(packetState, controlState, {
      now: 2_000,
      log: () => {}
    });
    assert.equal(
      recordQuickPlayDiagnosticEnvelope(packetState, {
        timestamp: 2_000,
        players: [],
        candidates: []
      }),
      true
    );
    assert.equal(
      recordQuickPlayDiagnosticEnvelope(packetState, {
        timestamp: 2_001,
        players: [],
        candidates: []
      }),
      false
    );
    assert.equal(packetState.stopReason, "packet_limit_reached");
    cleanupQuickPlayDiagnosticTempPaths(packetPaths);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("diagnostic start schedules session scan and creates empty closure and callframe files", () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 11;
  const diagnosticState = makeQuickPlayState(paths);
  try {
    const started = startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 5_000,
      log: () => {}
    });

    assert.equal(started.started, true);
    assert.equal(diagnosticState.diagnostics.session_scan.scheduled, 1);
    assert.equal(diagnosticState.diagnostics.closure_scan.scheduled, 0);
    assert.equal(diagnosticState.captureGeneration, 11);
    assert.ok(existsSync(paths.closurePath));
    assert.equal(readFileSync(paths.closurePath, "utf8"), "");
    assert.ok(existsSync(paths.callframePath));
    assert.equal(readFileSync(paths.callframePath, "utf8"), "");
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("automatic zenith provider does not stop at manual packet limit", () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.botEnabled = true;
  const diagnosticState = makeQuickPlayState(paths);
  diagnosticState.maxWsPackets = 1;
  try {
    const started = applyBrowserControlMessage({
      message: {
        type: "quick_play_passive_provider",
        owner: "zenith_dry_run",
        enabled: true
      },
      controlState,
      quickPlayDiagnosticState: diagnosticState,
      closureCaptureState: createClosureCaptureState(),
      nextGameReacquireState: createNextGameReacquireState(),
      now: 2_500,
      log: () => {}
    });

    assert.equal(started, true);
    assert.equal(
      recordQuickPlayDiagnosticEnvelope(diagnosticState, {
        timestamp: 2_500,
        players: [],
        candidates: []
      }),
      true
    );
    assert.equal(
      recordQuickPlayDiagnosticEnvelope(diagnosticState, {
        timestamp: 2_501,
        players: [],
        candidates: []
      }),
      true
    );
    assert.equal(diagnosticState.stopReason, "");
    assert.equal(diagnosticState.roundCompleted, false);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("first Zenith options rearms closure acquisition", () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.botEnabled = true;
  const diagnosticState = makeQuickPlayState(paths);
  try {
    applyBrowserControlMessage({
      message: {
        type: "quick_play_passive_provider",
        owner: "zenith_dry_run",
        enabled: true
      },
      controlState,
      quickPlayDiagnosticState: diagnosticState,
      closureCaptureState: createClosureCaptureState(),
      nextGameReacquireState: createNextGameReacquireState(),
      now: 1_000,
      log: () => {}
    });
    diagnosticState.nextClosureSurveyAt = 0;
    diagnosticState.closureScanState.zenithRetryScheduled = false;

    recordQuickPlayDiagnosticEnvelope(diagnosticState, {
      timestamp: 1_200,
      players: [],
      candidates: [
        {
          path: "root.player",
          bagtype: "zenith"
        }
      ]
    });

    assert.equal(diagnosticState.closureScanState.zenithRetryScheduled, true);
    assert.equal(diagnosticState.closureScanState.pendingReason, "first_zenith_options");
    assert.equal(diagnosticState.nextClosureSurveyAt, 1_200);
    assert.equal(diagnosticState.diagnostics.closure_scan.scheduled, 1);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("diagnostic_start in lobby does not consume productive scan budget", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  const diagnosticState = makeQuickPlayState(paths);
  let sessionRuns = 0;
  let closureRuns = 0;
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 2_000,
      log: () => {}
    });

    const result = await maybeRunQuickPlayDiagnosticCapture({
      cdp: {
        async send() {
          throw new Error("unexpected cdp send");
        }
      },
      quickPlayDiagnosticState: diagnosticState,
      browserControlState: controlState,
      transientState: { lastRuntimeError: "" },
      now: 2_000,
      surveySessionFn: async () => {
        sessionRuns += 1;
        return {
          status: "ready",
          screenUsername: null,
          runtimePathsChecked: [],
          candidates: []
        };
      },
      scanClosureFn: async () => {
        closureRuns += 1;
        return {
          status: "ready",
          resultType: "completed_not_found",
          exception: false,
          rawCandidates: [],
          acceptedCandidates: []
        };
      },
      log: () => {}
    });

    assert.equal(result.stopped, false);
    assert.equal(sessionRuns, 1);
    assert.equal(closureRuns, 0);
    assert.equal(diagnosticState.diagnostics.session_scan.attempts, 1);
    assert.equal(diagnosticState.diagnostics.session_scan.completed, 1);
    assert.equal(diagnosticState.diagnostics.closure_scan.attempts, 0);
    assert.equal(diagnosticState.diagnostics.closure_scan.productive_attempts, 0);
    assert.equal(diagnosticState.diagnostics.closure_scan.completed, 0);
    assert.equal(diagnosticState.diagnostics.closure_scan.raw_candidate_count, 0);
    assert.equal(diagnosticState.diagnostics.closure_scan.accepted_candidate_count, 0);
    assert.ok(existsSync(paths.closurePath));
    assert.ok(existsSync(paths.callframePath));
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("duplicate retry and first-options schedules coalesce", () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.botEnabled = true;
  const diagnosticState = makeQuickPlayState(paths);
  try {
    applyBrowserControlMessage({
      message: {
        type: "quick_play_passive_provider",
        owner: "zenith_dry_run",
        enabled: true
      },
      controlState,
      quickPlayDiagnosticState: diagnosticState,
      closureCaptureState: createClosureCaptureState(),
      nextGameReacquireState: createNextGameReacquireState(),
      now: 1_000,
      log: () => {}
    });
    diagnosticState.nextClosureSurveyAt = 2_000;
    diagnosticState.closureScanState.pendingReason = "retry";
    diagnosticState.closureScanState.zenithRetryScheduled = false;
    diagnosticState.diagnostics.closure_scan.scheduled = 1;

    recordQuickPlayDiagnosticEnvelope(diagnosticState, {
      timestamp: 1_500,
      players: [],
      candidates: [
        {
          path: "root.player",
          bagtype: "zenith"
        }
      ]
    });

    assert.equal(diagnosticState.nextClosureSurveyAt, 1_500);
    assert.equal(diagnosticState.closureScanState.pendingReason, "first_zenith_options");
    assert.equal(diagnosticState.diagnostics.closure_scan.scheduled, 1);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("pause request failure is recorded with explicit reason", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  const diagnosticState = makeQuickPlayState(paths);
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 3_000,
      log: () => {}
    });
    recordQuickPlayDiagnosticEnvelope(diagnosticState, {
      timestamp: 3_050,
      players: [],
      candidates: [{ path: "root.player", bagtype: "zenith" }]
    });

    await maybeRunQuickPlayDiagnosticCapture({
      cdp: {
        async send(method) {
          if (method === "Debugger.enable") {
            return {};
          }
          if (method === "Debugger.pause") {
            throw new Error("pause denied");
          }
          if (
            method === "Debugger.disable" ||
            method === "Runtime.releaseObjectGroup"
          ) {
            return {};
          }
          throw new Error(`unexpected method ${method}`);
        },
        async waitForEvent() {
          throw new Error("should not wait");
        }
      },
      quickPlayDiagnosticState: diagnosticState,
      browserControlState: controlState,
      transientState: { lastRuntimeError: "" },
      now: 3_200,
      surveySessionFn: async () => ({
        status: "ready",
        runtimePathsChecked: [],
        candidates: []
      }),
      log: () => {}
    });

    assert.equal(diagnosticState.diagnostics.closure_scan.attempts, 1);
    assert.equal(diagnosticState.diagnostics.closure_scan.productive_attempts, 0);
    assert.equal(diagnosticState.diagnostics.closure_scan.skipped, 1);
    assert.equal(
      diagnosticState.diagnostics.closure_scan.skip_reasons.pause_request_failed,
      1
    );
    assert.deepEqual(diagnosticState.diagnostics.closure_scan.errors, ["pause denied"]);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("missing paused event is not reported as a successful empty scan", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  const diagnosticState = makeQuickPlayState(paths);
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 4_000,
      log: () => {}
    });
    recordQuickPlayDiagnosticEnvelope(diagnosticState, {
      timestamp: 4_020,
      players: [],
      candidates: [{ path: "root.player", bagtype: "zenith" }]
    });

    await maybeRunQuickPlayDiagnosticCapture({
      cdp: {
        async send(method) {
          if (
            method === "Debugger.enable" ||
            method === "Debugger.pause" ||
            method === "Debugger.disable" ||
            method === "Runtime.releaseObjectGroup"
          ) {
            return {};
          }
          throw new Error(`unexpected method ${method}`);
        },
        async waitForEvent() {
          return null;
        }
      },
      quickPlayDiagnosticState: diagnosticState,
      browserControlState: controlState,
      transientState: { lastRuntimeError: "" },
      now: 4_200,
      surveySessionFn: async () => ({
        status: "ready",
        runtimePathsChecked: [],
        candidates: []
      }),
      log: () => {}
    });

    assert.equal(diagnosticState.diagnostics.closure_scan.completed, 1);
    assert.equal(diagnosticState.diagnostics.closure_scan.raw_candidate_count, 0);
    assert.equal(
      diagnosticState.diagnostics.closure_scan.skip_reasons.paused_event_not_received,
      1
    );
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("callframes_empty is recorded without consuming productive scan budget", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  const diagnosticState = makeQuickPlayState(paths);
  const methods = [];
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 4_500,
      log: () => {}
    });
    recordQuickPlayDiagnosticEnvelope(diagnosticState, {
      timestamp: 4_520,
      players: [],
      candidates: [{ path: "root.player", bagtype: "zenith" }]
    });

    await maybeRunQuickPlayDiagnosticCapture({
      cdp: {
        async send(method) {
          methods.push(method);
          if (
            method === "Debugger.enable" ||
            method === "Debugger.pause" ||
            method === "Debugger.resume" ||
            method === "Debugger.disable" ||
            method === "Runtime.releaseObjectGroup"
          ) {
            return {};
          }
          throw new Error(`unexpected method ${method}`);
        },
        async waitForEvent() {
          return { callFrames: [] };
        }
      },
      quickPlayDiagnosticState: diagnosticState,
      browserControlState: controlState,
      transientState: { lastRuntimeError: "" },
      now: 4_700,
      surveySessionFn: async () => ({
        status: "ready",
        runtimePathsChecked: [],
        candidates: []
      }),
      log: () => {}
    });

    assert.equal(diagnosticState.diagnostics.closure_scan.attempts, 1);
    assert.equal(diagnosticState.diagnostics.closure_scan.productive_attempts, 0);
    assert.equal(diagnosticState.diagnostics.closure_scan.callframes_seen, 0);
    assert.equal(diagnosticState.diagnostics.closure_scan.inventory_rows_written, 0);
    assert.equal(diagnosticState.diagnostics.closure_scan.skip_reasons.callframes_empty, 1);
    assert.equal(readFileSync(paths.callframePath, "utf8"), "");
    assert.ok(methods.includes("Debugger.resume"));
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("acquired frames are written even without a matching _tick frame", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const diagnosticState = makeQuickPlayState(paths);
  writeFileSync(paths.fingerprintPath, JSON.stringify({
    frame_function_name: "_tick",
    call_frame_index: 1,
    scope_index: 4,
    scope_type: "closure"
  }));
  try {
    const result = await collectQuickPlayClosureDiagnosticFromPausedScopes(
      {
        async send(method) {
          if (method === "Runtime.getProperties") {
            return {
              result: [
                {
                  name: "console",
                  value: { type: "object", objectId: "console-1", className: "Console" }
                }
              ]
            };
          }
          throw new Error(`unexpected method ${method}`);
        }
      },
      {
        callFrames: [
          {
            callFrameId: "vendor-frame",
            functionName: "vendorTick",
            url: "https://cdn.vendor.example/vendor.js",
            location: { scriptId: "11", lineNumber: 3, columnNumber: 2 },
            scopeChain: [{ type: "local", object: { objectId: "scope-vendor" } }]
          }
        ]
      },
      {
        quickPlayDiagnosticState: diagnosticState,
        attempt: 1
      }
    );

    assert.equal(result.resultType, "matching_frame_missing");
    assert.equal(result.inventoryRowsWritten, 1);
    const rows = readFileSync(paths.callframePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].function_name, "vendorTick");
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("stale generation cannot write inventory", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  const diagnosticState = makeQuickPlayState(paths);
  const methods = [];
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 5_000,
      log: () => {}
    });
    recordQuickPlayDiagnosticEnvelope(diagnosticState, {
      timestamp: 5_050,
      players: [],
      candidates: [{ path: "root.player", bagtype: "zenith" }]
    });

    await maybeRunQuickPlayDiagnosticCapture({
      cdp: {
        async send(method) {
          methods.push(method);
          if (
            method === "Debugger.enable" ||
            method === "Debugger.pause" ||
            method === "Debugger.resume" ||
            method === "Debugger.disable" ||
            method === "Runtime.releaseObjectGroup"
          ) {
            return {};
          }
          throw new Error(`unexpected method ${method}`);
        },
        async waitForEvent() {
          diagnosticState.captureGeneration += 1;
          return {
            callFrames: [
              {
                callFrameId: "frame-1",
                functionName: "_tick",
                scopeChain: [{ type: "closure", object: { objectId: "scope-1" } }]
              }
            ]
          };
        }
      },
      quickPlayDiagnosticState: diagnosticState,
      browserControlState: controlState,
      transientState: { lastRuntimeError: "" },
      now: 5_300,
      surveySessionFn: async () => ({
        status: "ready",
        runtimePathsChecked: [],
        candidates: []
      }),
      log: () => {}
    });

    assert.equal(diagnosticState.diagnostics.closure_scan.skip_reasons.stale_generation, 1);
    assert.equal(readFileSync(paths.callframePath, "utf8"), "");
    assert.ok(methods.includes("Debugger.resume"));
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("Debugger.resume runs on successful closure acquisition", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  const diagnosticState = makeQuickPlayState(paths);
  const methods = [];
  const objectMap = {
    "binding-at": {
      ejectState: {
        game: {
          board: createBoard(),
          current: "t",
          hold: "i",
          queue: ["o", "s", "z"],
          gameid: 9,
          seed: 10,
          userid: "user-1",
          stats: { piecesplaced: 3 }
        }
      }
    }
  };
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 5_500,
      log: () => {}
    });
    recordQuickPlayDiagnosticEnvelope(diagnosticState, {
      timestamp: 5_520,
      players: [],
      candidates: [{ path: "root.player", bagtype: "zenith" }]
    });

    await maybeRunQuickPlayDiagnosticCapture({
      cdp: {
        async send(method, params = {}) {
          methods.push(method);
          if (
            method === "Debugger.enable" ||
            method === "Debugger.pause" ||
            method === "Debugger.resume" ||
            method === "Debugger.disable" ||
            method === "Runtime.releaseObjectGroup"
          ) {
            return {};
          }
          if (method === "Runtime.getProperties") {
            return {
              result: [
                {
                  name: "at",
                  value: { type: "object", objectId: "binding-at", className: "Object" }
                }
              ]
            };
          }
          if (method === "Runtime.callFunctionOn") {
            return {
              result: {
                value: executeObjectFunction(
                  params.functionDeclaration,
                  objectMap[params.objectId]
                )
              }
            };
          }
          throw new Error(`unexpected method ${method}`);
        },
        async waitForEvent() {
          return {
            callFrames: [
              {
                callFrameId: "frame-1",
                functionName: "_tick",
                url: "https://tetr.io/assets/game-main.js",
                location: { scriptId: "1", lineNumber: 1, columnNumber: 1 },
                scopeChain: [
                  { type: "local", object: { objectId: "scope-0" } },
                  { type: "closure", object: { objectId: "scope-1" } },
                  { type: "closure", object: { objectId: "scope-2" } },
                  { type: "closure", object: { objectId: "scope-3" } },
                  { type: "closure", object: { objectId: "scope-4" } }
                ]
              }
            ]
          };
        }
      },
      quickPlayDiagnosticState: diagnosticState,
      browserControlState: controlState,
      transientState: { lastRuntimeError: "" },
      now: 5_700,
      surveySessionFn: async () => ({
        status: "ready",
        runtimePathsChecked: [],
        candidates: []
      }),
      log: () => {}
    });

    assert.equal(diagnosticState.diagnostics.closure_scan.productive_attempts, 1);
    assert.ok(methods.includes("Debugger.resume"));
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("Debugger.resume runs when paused callframe inspection throws", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  const diagnosticState = makeQuickPlayState(paths);
  const methods = [];
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 5_800,
      log: () => {}
    });
    recordQuickPlayDiagnosticEnvelope(diagnosticState, {
      timestamp: 5_820,
      players: [],
      candidates: [{ path: "root.player", bagtype: "zenith" }]
    });

    await maybeRunQuickPlayDiagnosticCapture({
      cdp: {
        async send(method) {
          methods.push(method);
          if (
            method === "Debugger.enable" ||
            method === "Debugger.pause" ||
            method === "Debugger.resume" ||
            method === "Debugger.disable" ||
            method === "Runtime.releaseObjectGroup"
          ) {
            return {};
          }
          throw new Error(`unexpected method ${method}`);
        },
        async waitForEvent() {
          return Object.defineProperty({}, "callFrames", {
            get() {
              throw new Error("callframes exploded");
            }
          });
        }
      },
      quickPlayDiagnosticState: diagnosticState,
      browserControlState: controlState,
      transientState: { lastRuntimeError: "" },
      now: 6_000,
      surveySessionFn: async () => ({
        status: "ready",
        runtimePathsChecked: [],
        candidates: []
      }),
      log: () => {}
    });

    assert.deepEqual(diagnosticState.diagnostics.closure_scan.errors, ["callframes exploded"]);
    assert.ok(methods.includes("Debugger.resume"));
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("Runtime.evaluate exception is recorded for closure diagnostics", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  const diagnosticState = makeQuickPlayState(paths);
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 3_000,
      log: () => {}
    });
    recordQuickPlayDiagnosticEnvelope(diagnosticState, {
      timestamp: 3_050,
      players: [],
      candidates: [{ path: "root.player", bagtype: "zenith" }]
    });

    await maybeRunQuickPlayDiagnosticCapture({
      cdp: {
        async send() {
          throw new Error("unexpected cdp send");
        }
      },
      quickPlayDiagnosticState: diagnosticState,
      browserControlState: controlState,
      transientState: { lastRuntimeError: "" },
      now: 3_200,
      surveySessionFn: async () => ({
        status: "ready",
        screenUsername: null,
        runtimePathsChecked: [],
        candidates: []
      }),
      scanClosureFn: async () => ({
        status: "error",
        resultType: "exception",
        exception: true,
        error: "boom",
        rawCandidates: [],
        acceptedCandidates: []
      }),
      log: () => {}
    });

    assert.deepEqual(diagnosticState.diagnostics.closure_scan.errors, ["boom"]);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("raw candidates retain rejection reasons and strict filter is applied after raw candidate recording", () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const diagnosticState = makeQuickPlayState(paths);
  try {
    writeFileSync(paths.closurePath, "");
    recordQuickPlayClosureCandidates(
      diagnosticState,
      {
        attempt: 1,
        resultType: "accepted_candidates_found",
        rawCandidates: [
          {
            candidateId: "raw-1",
            locator: "Ai",
            objectKeys: ["ejectState"],
            typeof: "object",
            hasBoardLike: true,
            hasCurrentLike: false,
            hasQueueLike: true,
            hasHoldLike: false,
            hasGameId: false,
            hasSeed: false,
            hasUserId: false,
            rejectedReason: ["current_missing"]
          },
          {
            candidateId: "raw-2",
            locator: "Game",
            objectKeys: ["ejectState", "ejectBoardState"],
            typeof: "object",
            hasBoardLike: true,
            hasCurrentLike: true,
            hasQueueLike: true,
            hasHoldLike: true,
            hasGameId: true,
            hasSeed: true,
            hasUserId: true,
            rejectedReason: []
          }
        ],
        acceptedCandidates: [
          {
            candidateId: "raw-2",
            locator: "Game",
            pieceCounter: 2,
            current: "t",
            hold: "i",
            queue: ["o", "s"],
            boardWidth: 10,
            boardHeight: 20,
            boardHash: "abcd1234",
            rowOccupancy: [0, 1],
            playing: true,
            ended: false
          }
        ]
      },
      4_000
    );

    const lines = readFileSync(paths.closurePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0].rejected_reason, ["current_missing"]);
    assert.equal(diagnosticState.closureCandidates.size, 1);
    assert.equal(diagnosticState.diagnostics.closure_scan.raw_candidate_count, 2);
    assert.equal(diagnosticState.diagnostics.closure_scan.accepted_candidate_count, 1);
    assert.equal(
      diagnosticState.diagnostics.closure_scan.rejection_counts.current_missing,
      1
    );
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("successful Solo capture emits a read-only fingerprint", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const closureCaptureState = createClosureCaptureState();
  closureCaptureState.soloClosureFingerprintPath = paths.fingerprintPath;
  closureCaptureState.windowSequence = 9;
  const cdp = {
    async send(method, params = {}) {
      if (method === "Runtime.getProperties") {
        return {
          result: [
            {
              name: "Ai",
              value: { objectId: "candidate-1" }
            }
          ]
        };
      }
      if (method === "Runtime.callFunctionOn") {
        if (String(params.functionDeclaration).includes("rootObjectKeys")) {
          return {
            result: {
              value: {
                rootObjectKeys: ["ejectState", "ejectBoardState", "meta"],
                ejectKeys: ["game", "stats"],
                stateKeys: ["board", "queue", "hold"],
                boardStateKeys: ["b", "w"]
              }
            }
          };
        }
        return {
          result: {
            value: {
              ok: true,
              source: "closure:Ai",
              locator: "Ai"
            }
          }
        };
      }
      throw new Error(`unexpected method ${method}`);
    }
  };

  try {
    const result = await exposeTetrioGameFromPausedCallFrames(
      cdp,
      {
        callFrames: [{
          callFrameId: "frame-1",
          functionName: "tickGame",
          url: "https://tetr.io/assets/game-main.a1b2c3d4.js",
          location: { scriptId: "101" },
          scopeChain: [{ type: "local", object: { objectId: "scope-1" } }]
        }]
      },
      {
        closureCaptureState,
        log: () => {}
      }
    );

    assert.equal(result.ok, true);
    assert.equal(result.locator, "Ai");
    assert.equal(closureCaptureState.lastSuccessfulLocator, "");
    assert.ok(existsSync(paths.fingerprintPath));

    const fingerprint = JSON.parse(readFileSync(paths.fingerprintPath, "utf8"));
    assert.equal(fingerprint.target_generation, 9);
    assert.equal(fingerprint.script_url_basename, "game-main.a1b2c3d4.js");
    assert.equal(fingerprint.frame_function_name, "tickGame");
    assert.equal(fingerprint.local_binding_name, "Ai");
    assert.equal(fingerprint.successful_locator, "Ai");
    assert.deepEqual(fingerprint.property_chain, ["Ai", "ejectState", "game", "board"]);
    assert.deepEqual(fingerprint.root_object_keys, ["ejectState", "ejectBoardState", "meta"]);
    assert.equal("board" in fingerprint, false);
    assert.equal("queue" in fingerprint, false);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("fingerprint frame matching does not require binding name Ai and minified bindings are inspected", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const diagnosticState = makeQuickPlayState(paths);
  writeFileSync(paths.fingerprintPath, JSON.stringify({
    script_url_basename: "game-main.deadbeef.js",
    frame_function_name: "_tick",
    call_frame_index: 1,
    scope_index: 4,
    scope_type: "closure",
    local_binding_name: "Ai",
    successful_locator: "Ai",
    property_chain: ["Ai", "ejectState", "game", "board"]
  }));
  const getPropertiesCalls = [];
  const inspectedObjectIds = [];
  const objectMap = {
    "binding-at": {
      ejectState: {
        game: {
          board: createBoard(),
          current: "t",
          hold: "i",
          queue: ["o", "s", "z"],
          gameid: 7001,
          seed: 8001,
          userid: "user-1",
          stats: { piecesplaced: 4 }
        }
      }
    },
    "binding-bs": {
      state: {
        board: createBoard(),
        seed: 8101,
        stats: { piecesplaced: 2 }
      }
    },
    "binding-bc": {
      foo: { bar: 1 }
    }
  };
  const descriptorsByScope = {
    "scope-vendor": [
      { name: "console", value: { type: "object", objectId: "vendor-console", className: "Console" } },
      { name: "window", value: { type: "object", objectId: "vendor-window", className: "Window" } },
      { name: "counter", value: { type: "number", value: 1 } },
      { name: "fn", value: { type: "function" } }
    ],
    "scope-game-3": [
      { name: "older", value: { type: "object", objectId: "older-binding", className: "Object" } }
    ],
    "scope-game-4": [
      { name: "at", value: { type: "object", objectId: "binding-at", className: "Object" } },
      { name: "bc", value: { type: "object", objectId: "binding-bc", className: "Object" } },
      { name: "bs", value: { type: "object", objectId: "binding-bs", className: "Object" } },
      { name: "Jl", value: { type: "function" } },
      { name: "Qi", value: { type: "number", value: 7 } }
    ]
  };
  const cdp = {
    async send(method, params = {}) {
      if (method === "Runtime.getProperties") {
        getPropertiesCalls.push(params.objectId);
        return {
          result: descriptorsByScope[params.objectId] ?? []
        };
      }
      if (method === "Runtime.callFunctionOn") {
        inspectedObjectIds.push(params.objectId);
        const target = objectMap[params.objectId];
        if (!target) {
          throw new Error(`unexpected inspection ${params.objectId}`);
        }
        return {
          result: {
            value: executeObjectFunction(params.functionDeclaration, target)
          }
        };
      }
      throw new Error(`unexpected method ${method}`);
    }
  };

  try {
    const result = await collectQuickPlayClosureDiagnosticFromPausedScopes(
      cdp,
      {
        callFrames: [
          {
            callFrameId: "frame-vendor",
            functionName: "track",
            url: "https://cdn.vendor.example/tracker.12345678.js",
            location: { scriptId: "201", lineNumber: 1, columnNumber: 1 },
            scopeChain: [{ type: "local", object: { objectId: "scope-vendor" } }]
          },
          ...Array.from({ length: 12 }, (_, index) => ({
            callFrameId: `frame-noise-${index}`,
            functionName: index === 3 ? "sentryWrapped" : "noise",
            url: `https://cdn.vendor.example/noise-${index}.js`,
            location: { scriptId: `${300 + index}`, lineNumber: 1, columnNumber: 1 },
            scopeChain: [{ type: "local", object: { objectId: `scope-noise-${index}` } }]
          })),
          {
            callFrameId: "frame-game",
            functionName: "_tick",
            url: "https://tetr.io/assets/game-main.00112233.js",
            location: { scriptId: "101", lineNumber: 4, columnNumber: 2 },
            scopeChain: [
              { type: "local", object: { objectId: "scope-game-0" } },
              { type: "local", object: { objectId: "scope-game-1" } },
              { type: "local", object: { objectId: "scope-game-2" } },
              { type: "closure", object: { objectId: "scope-game-3" } },
              { type: "closure", object: { objectId: "scope-game-4" } }
            ]
          }
        ]
      },
      {
        quickPlayDiagnosticState: diagnosticState,
        attempt: 1,
        perScanBudgetMs: 500
      }
    );

    const inventoryLines = readFileSync(paths.callframePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(inventoryLines.length, 14);
    assert.deepEqual(
      inventoryLines[0].scopes[0].binding_names,
      ["console", "window", "counter", "fn"]
    );
    assert.equal(result.framesScanned, 1);
    assert.equal(result.scopesScanned, 1);
    assert.equal(result.tickFramesSeen, 1);
    assert.equal(result.selectedTickFrames, 1);
    assert.equal(result.candidateClosureScopesSeen, 2);
    assert.equal(result.selectedPrimaryScopes, 1);
    assert.equal(result.selectedSecondaryScopes, 1);
    assert.deepEqual(inspectedObjectIds, ["binding-at", "binding-bc", "binding-bs"]);
    assert.ok(!inspectedObjectIds.includes("vendor-console"));
    assert.ok(!inspectedObjectIds.includes("vendor-window"));
    assert.deepEqual(result.targetedBindingInspection, {
      attempt: 1,
      selected_function_name: "_tick",
      selected_call_frame_index: 13,
      selected_scope_index: 4,
      selected_scope_type: "closure",
      inventory_binding_count: 5,
      properties_binding_count: 5,
      inspected_object_bindings: ["at", "bc", "bs"],
      skipped_primitive_bindings: ["Qi"],
      skipped_function_bindings: ["Jl"],
      result: "accepted_candidates_found"
    });
    assert.equal(result.acceptedCandidates.length, 1);
    assert.ok(
      result.acceptedCandidates.some(
        (candidate) =>
          candidate.bindingName === "at" &&
          candidate.fullPath === "frame[13].scope[4].at.ejectState.game.board" &&
          candidate.matchedShape === "ejectState.game.board"
      )
    );
    assert.ok(
      result.rawCandidates.some(
        (candidate) =>
          candidate.bindingName === "bs" &&
          candidate.fullPath === "frame[13].scope[4].bs.state.board" &&
          candidate.matchedShape === "state.board" &&
          candidate.hasBoardLike === true &&
          candidate.rejectedReason?.includes("queue_missing")
      )
    );
    assert.ok(getPropertiesCalls.includes("scope-game-4"));
    assert.ok(getPropertiesCalls.includes("scope-vendor"));
    assert.ok(!inspectedObjectIds.includes("Qi"));
    assert.ok(!inspectedObjectIds.includes("Jl"));
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("targeted scope handoff mismatch is reported when inventory bindings disappear at inspection time", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const diagnosticState = makeQuickPlayState(paths);
  writeFileSync(paths.fingerprintPath, JSON.stringify({
    script_url_basename: "game-main.deadbeef.js",
    frame_function_name: "_tick",
    call_frame_index: 1,
    scope_index: 4,
    scope_type: "closure"
  }));
  let scopeGame4Reads = 0;
  const cdp = {
    async send(method, params = {}) {
      if (method === "Runtime.getProperties") {
        if (params.objectId === "scope-vendor") {
          return {
            result: [{ name: "console", value: { type: "object", objectId: "vendor-console" } }]
          };
        }
        if (params.objectId === "scope-game-4") {
          scopeGame4Reads += 1;
          return scopeGame4Reads === 1
            ? {
                result: [
                  { name: "at", value: { type: "object", objectId: "binding-at", className: "Object" } },
                  { name: "bc", value: { type: "object", objectId: "binding-bc", className: "Object" } },
                  { name: "bs", value: { type: "object", objectId: "binding-bs", className: "Object" } },
                  { name: "Jl", value: { type: "function" } },
                  { name: "Qi", value: { type: "number", value: 7 } }
                ]
              }
            : { result: [] };
        }
      }
      throw new Error(`unexpected method ${method}`);
    }
  };

  try {
    const result = await collectQuickPlayClosureDiagnosticFromPausedScopes(
      cdp,
      {
        callFrames: [
          {
            callFrameId: "frame-vendor",
            functionName: "track",
            url: "https://cdn.vendor.example/tracker.12345678.js",
            location: { scriptId: "201", lineNumber: 1, columnNumber: 1 },
            scopeChain: [{ type: "local", object: { objectId: "scope-vendor" } }]
          },
          ...Array.from({ length: 12 }, (_, index) => ({
            callFrameId: `frame-noise-${index}`,
            functionName: "noise",
            url: `https://cdn.vendor.example/noise-${index}.js`,
            location: { scriptId: `${300 + index}`, lineNumber: 1, columnNumber: 1 },
            scopeChain: [{ type: "local", object: { objectId: `scope-noise-${index}` } }]
          })),
          {
            callFrameId: "frame-game",
            functionName: "_tick",
            url: "https://tetr.io/assets/game-main.00112233.js",
            location: { scriptId: "101", lineNumber: 4, columnNumber: 2 },
            scopeChain: [
              { type: "local", object: { objectId: "scope-game-0" } },
              { type: "local", object: { objectId: "scope-game-1" } },
              { type: "local", object: { objectId: "scope-game-2" } },
              { type: "closure", object: { objectId: "scope-game-3" } },
              { type: "closure", object: { objectId: "scope-game-4" } }
            ]
          }
        ]
      },
      {
        quickPlayDiagnosticState: diagnosticState,
        attempt: 1,
        perScanBudgetMs: 500,
        log: () => {}
      }
    );

    assert.equal(result.resultType, "target_handoff_mismatch");
    assert.deepEqual(result.targetedBindingInspection, {
      attempt: 1,
      selected_function_name: "_tick",
      selected_call_frame_index: 13,
      selected_scope_index: 4,
      selected_scope_type: "closure",
      inventory_binding_count: 5,
      properties_binding_count: 0,
      inspected_object_bindings: [],
      skipped_primitive_bindings: [],
      skipped_function_bindings: [],
      result: "target_handoff_mismatch"
    });
    assert.equal(result.rawCandidates.length, 0);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("_tick scope4 primary falls back to scope3 in the same frame when scope4 has no accepted candidates", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const diagnosticState = makeQuickPlayState(paths);
  writeFileSync(paths.fingerprintPath, JSON.stringify({
    script_url_basename: "game-main.deadbeef.js",
    frame_function_name: "_tick",
    call_frame_index: 1,
    scope_index: 4,
    scope_type: "closure"
  }));
  const inspectedObjectIds = [];
  const descriptorsByScope = {
    "scope-game-3": [
      { name: "lr", value: { type: "object", objectId: "binding-lr", className: "Object" } }
    ],
    "scope-game-4": [
      { name: "noise", value: { type: "object", objectId: "binding-noise", className: "Object" } }
    ]
  };
  const objectMap = {
    "binding-noise": { foo: { bar: 1 } },
    "binding-lr": {
      ejectState: {
        game: {
          board: createBoard(),
          current: "t",
          hold: "i",
          queue: ["o", "s", "z"],
          gameid: 7002,
          seed: 8002,
          userid: "user-2",
          stats: { piecesplaced: 7 }
        }
      }
    }
  };
  const cdp = {
    async send(method, params = {}) {
      if (method === "Runtime.getProperties") {
        return { result: descriptorsByScope[params.objectId] ?? [] };
      }
      if (method === "Runtime.callFunctionOn") {
        inspectedObjectIds.push(params.objectId);
        return {
          result: {
            value: executeObjectFunction(params.functionDeclaration, objectMap[params.objectId])
          }
        };
      }
      throw new Error(`unexpected method ${method}`);
    }
  };

  try {
    const result = await collectQuickPlayClosureDiagnosticFromPausedScopes(
      cdp,
      {
        callFrames: [
          ...Array.from({ length: 13 }, (_, index) => ({
            callFrameId: `frame-${index}`,
            functionName: index === 12 ? "_tick" : "noise",
            url: index === 12 ? "https://tetr.io/assets/game-main.00112233.js" : `https://cdn.vendor.example/${index}.js`,
            location: { scriptId: `${100 + index}`, lineNumber: 1, columnNumber: 1 },
            scopeChain: index === 12
              ? [
                  { type: "local", object: { objectId: "scope-game-0" } },
                  { type: "closure", object: { objectId: "scope-game-1" } },
                  { type: "closure", object: { objectId: "scope-game-2" } },
                  { type: "closure", object: { objectId: "scope-game-3" } },
                  { type: "closure", object: { objectId: "scope-game-4" } }
                ]
              : [{ type: "local", object: { objectId: `scope-noise-${index}` } }]
          }))
        ]
      },
      {
        quickPlayDiagnosticState: diagnosticState,
        attempt: 1,
        perScanBudgetMs: 500,
        log: () => {}
      }
    );

    assert.equal(result.resultType, "accepted_candidates_found");
    assert.equal(result.scopesScanned, 2);
    assert.deepEqual(inspectedObjectIds, ["binding-noise", "binding-lr"]);
    assert.ok(
      result.acceptedCandidates.some(
        (candidate) => candidate.fullPath === "frame[12].scope[3].lr.ejectState.game.board"
      )
    );
    assert.deepEqual(result.targetedBindingInspection, {
      attempt: 1,
      selected_function_name: "_tick",
      selected_call_frame_index: 12,
      selected_scope_index: 3,
      selected_scope_type: "closure",
      inventory_binding_count: 1,
      properties_binding_count: 1,
      inspected_object_bindings: ["lr"],
      skipped_primitive_bindings: [],
      skipped_function_bindings: [],
      result: "accepted_candidates_found"
    });
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("self remains unresolved without explicit evidence and known userid is never hardcoded", () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const diagnosticState = makeQuickPlayState(paths);
  try {
    diagnosticState.wsPlayers.set("localish", {
      userid: "6a5042ff2dfdb4928a8950fe",
      username: null,
      gameid: 2722,
      seed: 1147220906,
      firstSeen: 1,
      lastSeen: 2
    });
    diagnosticState.sessionCandidates.set("window.app.room.root.user", {
      path: "window.app.room.root.user",
      userid: "6a5042ff2dfdb4928a8950fe",
      username: "not-self",
      userid_present: true,
      username_present: true,
      screen_username_matches: false,
      candidate_kind: "participant_candidate",
      evidence: ["contains_roster_or_game_fields"],
      firstSeen: 1,
      lastSeen: 2
    });

    const report = buildQuickPlayRuntimeReport(diagnosticState);
    assert.equal(report.ws_self_evidence.status, "unresolved");
    assert.equal(report.local_resolution, null);
    assert.ok(
      report.ws_self_evidence.rejected_strategies.includes(
        "no_verified_storage_identity_candidate"
      )
    );
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("resolved self requires non-empty userid and gameid even when evidence count is high", () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const diagnosticState = makeQuickPlayState(paths);
  try {
    diagnosticState.wsEnvelopes = Array.from({ length: 59 }, (_, index) => ({
      direction: "inbound",
      request_id: `req-${index}`,
      root_keys: ["self"],
      payload_keys: ["player"],
      candidate_paths: ["root.self"],
      players: [
        {
          userid: null,
          username: `player-${index}`,
          gameid: null
        }
      ]
    }));

    const report = buildQuickPlayRuntimeReport(diagnosticState);
    assert.equal(report.ws_self_evidence.status, "unresolved");
    assert.equal(report.ws_self_evidence.userid, null);
    assert.equal(report.ws_self_evidence.gameid, null);
    assert.equal(report.ws_self_evidence.evidence.length, 59);
    assert.ok(
      report.ws_self_evidence.rejected_strategies.includes(
        "resolved_identity_invariant_failed"
      )
    );
    assert.equal(report.local_resolution, null);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("resolved self without closure match reports identity resolved but closure unresolved", () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const diagnosticState = makeQuickPlayState(paths);
  try {
    diagnosticState.sessionCandidates.set("localStorage.userConfig", {
      path: "localStorage.userConfig",
      userid: "user-7",
      username: "ExactLocal",
      userid_present: true,
      username_present: true,
      screen_username_matches: true,
      candidate_kind: "storage_identity",
      evidence: ["storage_identity"],
      firstSeen: 1,
      lastSeen: 2
    });
    diagnosticState.wsPlayers.set("player", {
      userid: "user-7",
      username: "ExactLocal",
      gameid: 7007,
      seed: 9007,
      firstSeen: 1,
      lastSeen: 2
    });

    const report = buildQuickPlayRuntimeReport(diagnosticState);
    assert.equal(report.ws_self_evidence.status, "resolved");
    assert.deepEqual(report.local_resolution, {
      status: "identity_resolved_closure_unresolved",
      userid: "user-7",
      gameid: 7007,
      session_candidate_path: "localStorage.userConfig",
      ws_player_id: "user-7|7007|ExactLocal",
      closure_candidate_id: null,
      matched_by: ["storage_identity_userid"],
      confidence: "medium"
    });
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("unique accepted _tick closure binds resolved self identity and writes passive snapshot", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 13;
  const diagnosticState = makeQuickPlayState(paths);
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 1_000,
      log: () => {}
    });
    diagnosticState.roundObserved = true;
    diagnosticState.nextClosureSurveyAt = 1_000;
    diagnosticState.closureScanState.pendingReason = "retry";
    diagnosticState.wsEnvelopes.push({
      direction: "inbound",
      root_keys: ["self"],
      payload_keys: ["player"],
      players: [{ userid: "user-7", username: "ExactLocal", gameid: 7007 }]
    });
    diagnosticState.wsPlayers.set("player", {
      userid: "user-7",
      username: "ExactLocal",
      gameid: 7007,
      seed: 9007,
      firstSeen: 1,
      lastSeen: 2
    });

    await maybeRunQuickPlayDiagnosticCapture({
      cdp: {
        async send(method, params = {}) {
          if (method === "Runtime.callFunctionOn") {
            if (params.returnByValue === false) {
              return { result: { objectId: "retained-1" } };
            }
            if (
              params.objectId === "candidate-1" &&
              String(params.functionDeclaration).includes("retained_object_stage")
            ) {
              return {
                result: {
                  value: {
                    requested_path: ["state"],
                    resolved_segments: ["state"],
                    failed_segment: null,
                    path_resolved: true,
                    accessor_exception: false,
                    value_type: "object",
                    retained_object_stage: "state",
                    root_diagnostics: {
                      raw_type: "object",
                      constructor: "Object",
                      own_keys: ["board", "current", "hold", "queue"],
                      has_board: true,
                      has_falling: false,
                      has_hold: true,
                      has_bag: false,
                      has_game: false,
                      has_state: false
                    }
                  }
                }
              };
            }
            return {
              result: {
                value: {
                  status: "ready",
                  board: Array.from({ length: 40 }, () => Array.from({ length: 10 }, () => 0)),
                  current: "T",
                  hold: "I",
                  queue: ["O", "S", "Z"],
                  playing: true,
                  started: true,
                  countdown_started: false,
                  paused: false,
                  destroyed: false,
                  successful: null,
                  gameoverreason: null,
                  piece_counter: 4,
                  board_width: 10,
                  board_height: 40,
                  current_path: ["state", "current"],
                  hold_path: ["state", "hold"],
                  queue_path: ["state", "queue"],
                  board_normalized: true,
                  current_normalized: true,
                  hold_normalized: true,
                  queue_normalized: true
                }
              }
            };
          }
          if (method === "Runtime.releaseObject" || method === "Runtime.releaseObjectGroup") {
            return {};
          }
          throw new Error(`unexpected method ${method}`);
        }
      },
      quickPlayDiagnosticState: diagnosticState,
      browserControlState: controlState,
      transientState: { lastRuntimeError: "" },
      targetUrl: "https://tetr.io/",
      now: 1_000,
      surveySessionFn: async () => ({
        status: "ready",
        runtimePathsChecked: [],
        candidates: []
      }),
      scanClosureFn: async () => ({
        status: "ready",
        productive: true,
        resultType: "accepted_candidates_found",
        callframesSeen: 20,
        tickFramesSeen: 1,
        selectedTickFrames: 1,
        matchingFramesSeen: 1,
        matchingScopesSeen: 1,
        candidateClosureScopesSeen: 2,
        selectedPrimaryScopes: 1,
        selectedSecondaryScopes: 1,
        targetedInspections: 1,
        targetHandoffMismatches: 0,
        inventoryRowsWritten: 20,
        rawCandidates: [{
          candidateId: "cand-1",
          locator: "ra",
          functionName: "_tick",
          callFrameIndex: 13,
          scopeIndex: 4,
          scopeType: "closure",
          bindingName: "ra",
          fullPath: "frame[13].scope[4].ra.state.board",
          matchedShape: "state.board",
          hasBoardLike: true,
          hasCurrentLike: true,
          hasQueueLike: true,
          hasHoldLike: true,
          rootObjectId: "candidate-1",
          current: "t",
          hold: "i",
          queue: ["o", "s", "z"],
          pieceCounter: 4,
          boardWidth: 10,
          boardHeight: 40,
          boardHash: "abcd1234",
          rowOccupancy: [0, 0, 1],
          playing: true,
          ended: false,
          accepted: true,
          rejectedReason: []
        }],
        acceptedCandidates: [{
          candidateId: "cand-1",
          locator: "ra",
          functionName: "_tick",
          callFrameIndex: 13,
          scopeIndex: 4,
          scopeType: "closure",
          bindingName: "ra",
          fullPath: "frame[13].scope[4].ra.state.board",
          matchedShape: "state.board",
          rootObjectId: "candidate-1",
          current: "t",
          hold: "i",
          queue: ["o", "s", "z"],
          pieceCounter: 4,
          boardWidth: 10,
          boardHeight: 40,
          boardHash: "abcd1234",
          rowOccupancy: [0, 0, 1],
          playing: true,
          ended: false,
          objectKeys: []
        }]
      }),
      log: () => {}
    });

    const report = buildQuickPlayRuntimeReport(diagnosticState);
    assert.deepEqual(report.local_resolution, {
      status: "resolved",
      userid: "user-7",
      gameid: 7007,
      session_candidate_path: null,
      ws_player_id: "user-7|7007|ExactLocal",
      closure_candidate_id: "cand-1",
      matched_by: ["explicit_ws_marker", "unique_local_tick_closure"],
      confidence: "high"
    });
    assert.equal(report.diagnostics.passive_snapshot.candidate_bound, true);
    assert.equal(report.diagnostics.passive_snapshot.identity_bound, true);
    assert.equal(report.diagnostics.passive_snapshot.reads_succeeded, 1);
    const snapshot = JSON.parse(readFileSync(paths.passiveSnapshotPath, "utf8"));
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.snapshot.source, "quick_play_closure");
    assert.equal(snapshot.snapshot.userid, "user-7");
    assert.equal(snapshot.snapshot.gameid, 7007);
    assert.equal(snapshot.snapshot.current?.type, "T");
    assert.deepEqual(snapshot.snapshot.queue, ["O", "S", "Z"]);
    assert.equal(JSON.stringify(snapshot).includes("retained-1"), false);
    assert.equal(JSON.stringify(report).includes("retained-1"), false);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

function makeQuickPlayAcceptedCandidateFixture({
  candidateId,
  rootObjectId,
  bindingName,
  matchedShape,
  retainedRootKind,
  retainedRootPath,
  boardPath,
  currentPath,
  holdPath,
  queuePath,
  current = "t",
  hold = "i",
  queue = ["o", "s", "z"],
  playing = true,
  ended = false
} = {}) {
  return {
    candidateId,
    rootObjectId,
    functionName: "_tick",
    callFrameIndex: 0,
    scopeIndex: 4,
    scopeType: "closure",
    bindingName,
    locator: bindingName,
    fullPath: `frame[0].scope[4].${bindingName}.${boardPath.join(".")}`,
    matchedShape,
    retainedRootKind,
    retainedRootPath,
    boardPath,
    currentPath,
    holdPath,
    queuePath,
    discoveredPaths: {
      board: boardPath,
      current: currentPath,
      hold: holdPath,
      queue: queuePath
    },
    objectKeys:
      retainedRootPath.length > 0 ? [retainedRootPath[retainedRootPath.length - 1]] : [],
    typeof: "object",
    hasBoardLike: true,
    hasCurrentLike: true,
    hasQueueLike: true,
    hasHoldLike: true,
    hasGameId: false,
    hasSeed: false,
    hasUserId: false,
    rejectedReason: [],
    current,
    hold,
    queue,
    pieceCounter: 4,
    boardWidth: 10,
    boardHeight: 40,
    boardHash: "abcd1234",
    rowOccupancy: [0, 0, 0],
    playing,
    ended,
    accepted: true
  };
}

function makeQuickPlaySemanticProbeFixtureValue({
  status = "ready",
  reason = null,
  retainedObjectStage = "state",
  boardWidth = 10,
  boardHeight = 40,
  boardNormalized = true,
  currentNormalized = true,
  holdNormalized = true,
  queueNormalized = true,
  board = Array.from({ length: 40 }, () => Array.from({ length: 10 }, () => 0)),
  current = { type: "T", x: 4, y: 19, rotation: 1 },
  hold = "I",
  queue = ["O", "S", "Z"],
  playing = true,
  started = true,
  countdownStarted = false,
  destroyed = false,
  currentPath = ["state", "current"],
  holdPath = ["state", "hold"],
  queuePath = ["state", "queue"],
  boardRequestedPath = ["board"],
  boardPathResolved = true
} = {}) {
  return {
    status,
    reason,
    board,
    current,
    hold,
    queue,
    playing,
    started,
    countdown_started: countdownStarted,
    paused: false,
    destroyed,
    successful: null,
    gameoverreason: null,
    piece_counter: 4,
    board_width: boardWidth,
    board_height: boardHeight,
    current_path: currentPath,
    hold_path: holdPath,
    queue_path: queuePath,
    board_normalized: boardNormalized,
    current_normalized: currentNormalized,
    hold_normalized: holdNormalized,
    queue_normalized: queueNormalized,
    field_diagnostics: {
      root: { retained_object_stage: retainedObjectStage },
      board: {
        requested_path: boardRequestedPath,
        path_resolved: boardPathResolved
      },
      current: {},
      hold: {},
      queue: {}
    }
  };
}

function makeQuickPlayRootProbeFixtureValue({
  requestedPath = ["state"],
  retainedObjectStage = "state",
  ownKeys = ["board", "current", "hold", "queue"],
  hasBoard = true,
  hasState = false,
  hasGame = false
} = {}) {
  return {
    requested_path: requestedPath,
    resolved_segments: requestedPath,
    failed_segment: null,
    path_resolved: true,
    accessor_exception: false,
    value_type: "object",
    retained_object_stage: retainedObjectStage,
    root_diagnostics: {
      raw_type: "object",
      constructor: "Object",
      own_keys: ownKeys,
      has_board: hasBoard,
      has_falling: false,
      has_hold: ownKeys.includes("hold"),
      has_bag: false,
      has_game: hasGame,
      has_state: hasState
    }
  };
}

function createQuickPlayMultiAcceptedPausedFixture(
  candidateSpecs,
  {
    pollValueByRetainedObjectId = {},
    pollTargetByRetainedObjectId = {}
  } = {}
) {
  const calls = [];
  let pausedHandlesLive = false;
  let resumeCount = 0;
  let semanticProbeCalls = 0;
  let canonicalStateHandleCalls = 0;
  let canonicalIdentityCompareCalls = 0;
  let retainRootProbeCalls = 0;
  let retainCloneCalls = 0;
  let pollCalls = 0;
  let postResumeCandidateHandleCalls = 0;
  let canonicalHandleSequence = 0;
  const candidatesByRootObjectId = new Map(
    candidateSpecs.map((spec) => [spec.candidate.rootObjectId, spec])
  );
  const retainedByObjectId = new Map(
    candidateSpecs
      .filter((spec) => String(spec.retainedObjectId ?? "").trim() !== "")
      .map((spec) => [spec.retainedObjectId, spec])
  );
  const canonicalHandleTargets = new Map();
  const cdp = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (
        method === "Debugger.enable" ||
        method === "Debugger.pause" ||
        method === "Debugger.disable"
      ) {
        return {};
      }
      if (method === "Debugger.resume") {
        pausedHandlesLive = false;
        resumeCount += 1;
        return {};
      }
      if (method === "Runtime.getProperties" && params.objectId === "scope-4") {
        return {
          result: candidateSpecs.map((spec) => ({
            name: spec.candidate.bindingName,
            value: {
              type: "object",
              objectId: spec.candidate.rootObjectId
            }
          }))
        };
      }
      if (method === "Runtime.callFunctionOn") {
        const argumentCount = Array.isArray(params.arguments) ? params.arguments.length : 0;
        if (canonicalHandleTargets.has(params.objectId)) {
          if (!pausedHandlesLive) {
            postResumeCandidateHandleCalls += 1;
            return {
              error: {
                message: "Invalid remote object id"
              }
            };
          }
          if (
            params.returnByValue === true &&
            argumentCount === 1 &&
            String(params.arguments?.[0]?.objectId ?? "").trim() !== ""
          ) {
            canonicalIdentityCompareCalls += 1;
            return {
              result: {
                value: executeObjectFunction(
                  params.functionDeclaration,
                  canonicalHandleTargets.get(params.objectId),
                  [canonicalHandleTargets.get(String(params.arguments[0].objectId ?? "").trim())]
                )
              }
            };
          }
        }
        if (candidatesByRootObjectId.has(params.objectId)) {
          const spec = candidatesByRootObjectId.get(params.objectId);
          if (!pausedHandlesLive) {
            postResumeCandidateHandleCalls += 1;
            return {
              error: {
                message: "Invalid remote object id"
              }
            };
          }
          if (params.returnByValue === true && argumentCount === 6) {
            semanticProbeCalls += 1;
            if (spec.semanticProbeError) {
              return {
                error: {
                  message: spec.semanticProbeError
                }
              };
            }
            return {
              result: {
                value:
                  spec.semanticProbeTarget !== undefined
                    ? executeObjectFunction(
                        params.functionDeclaration,
                        spec.semanticProbeTarget,
                        (params.arguments ?? []).map((entry) => entry?.value)
                      )
                    : spec.semanticProbeValue
              }
            };
          }
          if (params.returnByValue === true && argumentCount === 1) {
            retainRootProbeCalls += 1;
            if (spec.rootProbeError) {
              return {
                error: {
                  message: spec.rootProbeError
                }
              };
            }
            return {
              result: {
                value: spec.rootProbeValue
              }
            };
          }
          if (params.returnByValue === false && argumentCount === 7) {
            canonicalStateHandleCalls += 1;
            const target =
              spec.canonicalStateTarget !== undefined
                ? spec.canonicalStateTarget
                : executeObjectFunction(
                    params.functionDeclaration,
                    spec.semanticProbeTarget,
                    (params.arguments ?? []).map((entry) => entry?.value)
                  );
            if (!target || (typeof target !== "object" && typeof target !== "function")) {
              return {
                result: {}
              };
            }
            const handleId = `canonical-handle-${++canonicalHandleSequence}`;
            canonicalHandleTargets.set(handleId, target);
            return {
              result: {
                objectId: handleId
              }
            };
          }
          if (params.returnByValue === false) {
            retainCloneCalls += 1;
            if (spec.retainCloneError) {
              return {
                error: {
                  message: spec.retainCloneError
                }
              };
            }
            return {
              result: {
                objectId: spec.retainedObjectId
              }
            };
          }
          return {
            result: {
              value: spec.candidate
            }
          };
        }
        if (retainedByObjectId.has(params.objectId)) {
          const spec = retainedByObjectId.get(params.objectId);
          if (params.returnByValue === true && argumentCount === 6) {
            pollCalls += 1;
            return {
              result: {
                value:
                  pollTargetByRetainedObjectId[params.objectId] !== undefined
                    ? executeObjectFunction(
                        params.functionDeclaration,
                        pollTargetByRetainedObjectId[params.objectId],
                        (params.arguments ?? []).map((entry) => entry?.value)
                      )
                    : pollValueByRetainedObjectId[params.objectId] ??
                      spec.semanticProbeValue
              }
            };
          }
        }
      }
      if (method === "Runtime.releaseObject" || method === "Runtime.releaseObjectGroup") {
        return {};
      }
      throw new Error(`unexpected method ${method}`);
    },
    async waitForEvent(method) {
      assert.equal(method, "Debugger.paused");
      pausedHandlesLive = true;
      return {
        callFrames: [
          {
            callFrameId: "frame-1",
            functionName: "_tick",
            location: {
              scriptId: "1",
              lineNumber: 14,
              columnNumber: 0
            },
            scopeChain: [null, null, null, null, {
              type: "closure",
              object: { objectId: "scope-4" }
            }]
          }
        ]
      };
    }
  };
  return {
    cdp,
    calls,
    counts() {
      return {
        resumeCount,
        semanticProbeCalls,
        canonicalStateHandleCalls,
        canonicalIdentityCompareCalls,
        retainRootProbeCalls,
        retainCloneCalls,
        pollCalls,
        postResumeCandidateHandleCalls
      };
    }
  };
}

test("multiple accepted candidates remain unresolved and passive snapshot stays unavailable", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  const diagnosticState = makeQuickPlayState(paths);
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 2_000,
      log: () => {}
    });
    diagnosticState.roundObserved = true;
    diagnosticState.nextClosureSurveyAt = 2_000;
    diagnosticState.closureScanState.pendingReason = "retry";
    diagnosticState.wsEnvelopes.push({
      direction: "inbound",
      root_keys: ["self"],
      payload_keys: ["player"],
      players: [{ userid: "user-8", username: "Local", gameid: 8008 }]
    });
    diagnosticState.wsPlayers.set("player", {
      userid: "user-8",
      username: "Local",
      gameid: 8008,
      seed: 9108,
      firstSeen: 1,
      lastSeen: 2
    });

    await maybeRunQuickPlayDiagnosticCapture({
      cdp: {
        async send(method) {
          if (method === "Runtime.releaseObject" || method === "Runtime.releaseObjectGroup") {
            return {};
          }
          throw new Error(`unexpected method ${method}`);
        }
      },
      quickPlayDiagnosticState: diagnosticState,
      browserControlState: controlState,
      transientState: { lastRuntimeError: "" },
      targetUrl: "https://tetr.io/",
      now: 2_000,
      surveySessionFn: async () => ({
        status: "ready",
        runtimePathsChecked: [],
        candidates: []
      }),
      scanClosureFn: async () => ({
        status: "ready",
        productive: true,
        resultType: "no_authoritative_candidate",
        rawCandidates: [],
        acceptedCandidates: []
      }),
      log: () => {}
    });

    const report = buildQuickPlayRuntimeReport(diagnosticState);
    assert.equal(report.local_resolution.status, "identity_resolved_closure_unresolved");
    const snapshot = JSON.parse(readFileSync(paths.passiveSnapshotPath, "utf8"));
    assert.deepEqual(snapshot, {
      status: "unavailable",
      reason: "no_authoritative_candidate"
    });
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("multiple accepted candidates retain exactly one authoritative semantic candidate", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 28;
  const diagnosticState = makeQuickPlayState(paths);
  const logs = [];
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 2_100,
      log: () => {}
    });
    diagnosticState.currentTargetUrl = "https://tetr.io/";
    diagnosticState.nextClosureSurveyAt = 2_100;
    diagnosticState.closureScanState.pendingReason = "first_zenith_options";
    diagnosticState.pendingIdentity = {
      generation: 28,
      userid: "user-28",
      gameid: 8028,
      wsPlayerId: "user-28|8028|Local",
      resolvedAt: 2_100
    };
    diagnosticState.wsPlayers.set("local", {
      userid: "user-28",
      gameid: 8028,
      username: "Local",
      firstSeen: 2_100,
      lastSeen: 2_100
    });
    const harness = createQuickPlayMultiAcceptedPausedFixture(
      [
        {
          candidate: makeQuickPlayAcceptedCandidateFixture({
            candidateId: "cand-a",
            rootObjectId: "obj-a",
            bindingName: "bindingA",
            matchedShape: "game.state.board",
            retainedRootKind: "state",
            retainedRootPath: ["game", "state"],
            boardPath: ["board"],
            currentPath: ["falling"],
            holdPath: ["hold"],
            queuePath: ["bag"]
          }),
          semanticProbeTarget: {
            game: {
              state: {
                board: Array.from({ length: 40 }, () => Array.from({ length: 10 }, () => 0)),
                falling: { type: "T", x: 4, y: 19, rotation: 1 },
                hold: "I",
                bag: ["O", "S", "Z"],
                playing: true,
                started: true,
                destroyed: false,
                stats: { piecesPlaced: 4 }
              }
            }
          },
          rootProbeValue: makeQuickPlayRootProbeFixtureValue({
            requestedPath: ["game", "state"],
            retainedObjectStage: "state"
          }),
          retainedObjectId: "retained-a"
        },
        {
          candidate: makeQuickPlayAcceptedCandidateFixture({
            candidateId: "cand-b",
            rootObjectId: "obj-b",
            bindingName: "bindingB",
            matchedShape: "_presentation.primary.board",
            retainedRootKind: "binding",
            retainedRootPath: ["_presentation", "primary"],
            boardPath: ["state", "board"],
            currentPath: ["state", "falling"],
            holdPath: ["state", "hold"],
            queuePath: ["state", "bag"]
          }),
          semanticProbeTarget: {
            _presentation: {
              primary: {
                state: {
                  board: Array.from({ length: 40 }, () => Array.from({ length: 10 }, () => 0)),
                  falling: { type: "L", x: 5, y: 18, rotation: 0 },
                  hold: "J",
                  bag: ["I", "O", "T"],
                  playing: false,
                  started: true,
                  destroyed: true,
                  stats: { piecesPlaced: 9 }
                }
              }
            }
          },
          rootProbeValue: makeQuickPlayRootProbeFixtureValue({
            requestedPath: ["_presentation", "primary"],
            retainedObjectStage: "game",
            ownKeys: ["state"],
            hasBoard: false,
            hasState: true
          }),
          retainedObjectId: "retained-b"
        }
      ],
      {
        pollTargetByRetainedObjectId: {
          "retained-a": {
            board: Array.from({ length: 40 }, () => Array.from({ length: 10 }, () => 0)),
            falling: { type: "T", x: 4, y: 19, rotation: 1 },
            hold: "I",
            bag: ["O", "S", "Z"],
            playing: true,
            started: true,
            destroyed: false,
            stats: { piecesPlaced: 4 }
          }
        }
      }
    );

    await maybeRunQuickPlayDiagnosticCapture({
      cdp: harness.cdp,
      quickPlayDiagnosticState: diagnosticState,
      browserControlState: controlState,
      transientState: { lastRuntimeError: "" },
      targetUrl: "https://tetr.io/",
      now: 2_100,
      surveySessionFn: async () => ({
        status: "ready",
        runtimePathsChecked: [],
        candidates: []
      }),
      log: (line) => logs.push(line)
    });

    const counts = harness.counts();
    assert.equal(counts.semanticProbeCalls, 2);
    assert.equal(counts.canonicalStateHandleCalls, 1);
    assert.equal(counts.canonicalIdentityCompareCalls, 0);
    assert.equal(counts.retainRootProbeCalls, 1);
    assert.equal(counts.retainCloneCalls, 1);
    assert.equal(counts.pollCalls, 1);
    assert.equal(counts.resumeCount, 1);
    assert.equal(counts.postResumeCandidateHandleCalls, 0);
    assert.equal(diagnosticState.boundLocalClosureCandidate.candidateId, "cand-a");
    assert.equal(diagnosticState.diagnostics.passive_snapshot.polling_started, true);
    const snapshot = JSON.parse(readFileSync(paths.passiveSnapshotPath, "utf8"));
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.snapshot.candidate_id, "cand-a");
    assert.ok(
      logs.some((line) =>
        line.includes("[quick-play] accepted candidate metadata index=1/2") &&
        line.includes("candidate=cand-a") &&
        line.includes("root_path=game.state")
      )
    );
    assert.ok(
      logs.some((line) =>
        line.includes("[quick-play] accepted candidate probe index=2/2") &&
        line.includes("candidate=cand-b") &&
        line.includes("root_path=_presentation.primary") &&
        line.includes("resolved_root=true") &&
        line.includes("board_path_resolved=true") &&
        line.includes("current_path_resolved=true") &&
        line.includes("hold_path_resolved=true") &&
        line.includes("queue_path_resolved=true") &&
        line.includes("status=ready") &&
        line.includes("authoritative=false")
      )
    );
    assert.ok(
      logs.some((line) =>
        line.includes("[quick-play] accepted authoritative candidates=1")
      )
    );
    assert.ok(
      logs.some((line) =>
        line.includes("[quick-play] canonical semantic groups=1")
      )
    );
    assert.ok(
      logs.some((line) =>
        line.includes("[quick-play] selected semantic group=1/1") &&
        line.includes("retain=success")
      )
    );
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("multiple authoritative semantic aliases collapse to one canonical gameplay state", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 281;
  const diagnosticState = makeQuickPlayState(paths);
  const logs = [];
  const sharedState = {
    board: Array.from({ length: 40 }, () => Array.from({ length: 10 }, () => 0)),
    falling: { type: "T", x: 4, y: 19, rotation: 1 },
    hold: "I",
    bag: ["O", "S", "Z"],
    playing: true,
    started: true,
    destroyed: false,
    stats: { piecesPlaced: 14 }
  };
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 2_101,
      log: () => {}
    });
    diagnosticState.currentTargetUrl = "https://tetr.io/";
    diagnosticState.nextClosureSurveyAt = 2_101;
    diagnosticState.closureScanState.pendingReason = "first_zenith_options";
    diagnosticState.pendingIdentity = {
      generation: 281,
      userid: "user-281",
      gameid: 8281,
      wsPlayerId: "user-281|8281|Local",
      resolvedAt: 2_101
    };
    diagnosticState.wsPlayers.set("local", {
      userid: "user-281",
      gameid: 8281,
      username: "Local",
      firstSeen: 2_101,
      lastSeen: 2_101
    });
    const harness = createQuickPlayMultiAcceptedPausedFixture(
      [
        {
          candidate: makeQuickPlayAcceptedCandidateFixture({
            candidateId: "cand-alias-a",
            rootObjectId: "obj-alias-a",
            bindingName: "bindingAliasA",
            matchedShape: "game.state.board",
            retainedRootKind: "state",
            retainedRootPath: ["game", "state"],
            boardPath: ["board"],
            currentPath: ["falling"],
            holdPath: ["hold"],
            queuePath: ["bag"]
          }),
          semanticProbeTarget: {
            game: {
              state: sharedState
            }
          },
          rootProbeValue: makeQuickPlayRootProbeFixtureValue({
            requestedPath: ["game", "state"],
            retainedObjectStage: "state"
          }),
          retainedObjectId: "retained-alias-a"
        },
        {
          candidate: makeQuickPlayAcceptedCandidateFixture({
            candidateId: "cand-alias-b",
            rootObjectId: "obj-alias-b",
            bindingName: "bindingAliasB",
            matchedShape: "_presentation.primary.board",
            retainedRootKind: "binding",
            retainedRootPath: ["_presentation", "primary"],
            boardPath: ["state", "board"],
            currentPath: ["state", "falling"],
            holdPath: ["state", "hold"],
            queuePath: ["state", "bag"]
          }),
          semanticProbeTarget: {
            _presentation: {
              primary: {
                state: sharedState
              }
            }
          },
          rootProbeValue: makeQuickPlayRootProbeFixtureValue({
            requestedPath: ["_presentation", "primary"],
            retainedObjectStage: "game",
            ownKeys: ["state"],
            hasBoard: false,
            hasState: true
          }),
          retainedObjectId: "retained-alias-b"
        }
      ],
      {
        pollTargetByRetainedObjectId: {
          "retained-alias-a": sharedState
        }
      }
    );

    await maybeRunQuickPlayDiagnosticCapture({
      cdp: harness.cdp,
      quickPlayDiagnosticState: diagnosticState,
      browserControlState: controlState,
      transientState: { lastRuntimeError: "" },
      targetUrl: "https://tetr.io/",
      now: 2_101,
      surveySessionFn: async () => ({
        status: "ready",
        runtimePathsChecked: [],
        candidates: []
      }),
      log: (line) => logs.push(line)
    });

    const counts = harness.counts();
    assert.equal(counts.semanticProbeCalls, 2);
    assert.equal(counts.canonicalStateHandleCalls, 2);
    assert.equal(counts.canonicalIdentityCompareCalls, 1);
    assert.equal(counts.retainCloneCalls, 1);
    assert.equal(counts.pollCalls, 1);
    assert.equal(counts.resumeCount, 1);
    assert.equal(diagnosticState.boundLocalClosureCandidate.candidateId, "cand-alias-a");
    const snapshot = JSON.parse(readFileSync(paths.passiveSnapshotPath, "utf8"));
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.snapshot.candidate_id, "cand-alias-a");
    assert.ok(logs.some((line) => line.includes("[quick-play] accepted authoritative candidates=2")));
    assert.ok(logs.some((line) => line.includes("[quick-play] canonical semantic groups=1")));
    assert.ok(logs.some((line) => line.includes("[quick-play] alias group size=2 group=1/1")));
    assert.ok(logs.some((line) => line.includes("[quick-play] selected semantic group=1/1")));
    assert.ok(logs.some((line) => line.includes("retain=success")));
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("three authoritative semantic aliases still retain exactly one canonical gameplay state", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 282;
  const diagnosticState = makeQuickPlayState(paths);
  const logs = [];
  const sharedState = {
    board: Array.from({ length: 40 }, () => Array.from({ length: 10 }, () => 0)),
    falling: { type: "L", x: 5, y: 18, rotation: 0 },
    hold: "J",
    bag: ["I", "O", "T"],
    playing: true,
    started: true,
    destroyed: false,
    stats: { piecesPlaced: 21 }
  };
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 2_102,
      log: () => {}
    });
    diagnosticState.currentTargetUrl = "https://tetr.io/";
    diagnosticState.nextClosureSurveyAt = 2_102;
    diagnosticState.closureScanState.pendingReason = "first_zenith_options";
    diagnosticState.pendingIdentity = {
      generation: 282,
      userid: "user-282",
      gameid: 8282,
      wsPlayerId: "user-282|8282|Local",
      resolvedAt: 2_102
    };
    diagnosticState.wsPlayers.set("local", {
      userid: "user-282",
      gameid: 8282,
      username: "Local",
      firstSeen: 2_102,
      lastSeen: 2_102
    });
    const harness = createQuickPlayMultiAcceptedPausedFixture(
      [
        {
          candidate: makeQuickPlayAcceptedCandidateFixture({
            candidateId: "cand-alias-1",
            rootObjectId: "obj-alias-1",
            bindingName: "bindingAlias1",
            matchedShape: "game.state.board",
            retainedRootKind: "state",
            retainedRootPath: ["game", "state"],
            boardPath: ["board"],
            currentPath: ["falling"],
            holdPath: ["hold"],
            queuePath: ["bag"]
          }),
          semanticProbeTarget: {
            game: {
              state: sharedState
            }
          },
          rootProbeValue: makeQuickPlayRootProbeFixtureValue({
            requestedPath: ["game", "state"],
            retainedObjectStage: "state"
          }),
          retainedObjectId: "retained-alias-1"
        },
        {
          candidate: makeQuickPlayAcceptedCandidateFixture({
            candidateId: "cand-alias-2",
            rootObjectId: "obj-alias-2",
            bindingName: "bindingAlias2",
            matchedShape: "_presentation.primary.board",
            retainedRootKind: "binding",
            retainedRootPath: ["_presentation", "primary"],
            boardPath: ["state", "board"],
            currentPath: ["state", "falling"],
            holdPath: ["state", "hold"],
            queuePath: ["state", "bag"]
          }),
          semanticProbeTarget: {
            _presentation: {
              primary: {
                state: sharedState
              }
            }
          },
          rootProbeValue: makeQuickPlayRootProbeFixtureValue({
            requestedPath: ["_presentation", "primary"],
            retainedObjectStage: "game",
            ownKeys: ["state"],
            hasBoard: false,
            hasState: true
          }),
          retainedObjectId: "retained-alias-2"
        },
        {
          candidate: makeQuickPlayAcceptedCandidateFixture({
            candidateId: "cand-alias-3",
            rootObjectId: "obj-alias-3",
            bindingName: "bindingAlias3",
            matchedShape: "viewer.match.board",
            retainedRootKind: "binding",
            retainedRootPath: ["viewer", "match"],
            boardPath: ["state", "board"],
            currentPath: ["state", "falling"],
            holdPath: ["state", "hold"],
            queuePath: ["state", "bag"]
          }),
          semanticProbeTarget: {
            viewer: {
              match: {
                state: sharedState
              }
            }
          },
          rootProbeValue: makeQuickPlayRootProbeFixtureValue({
            requestedPath: ["viewer", "match"],
            retainedObjectStage: "game",
            ownKeys: ["state"],
            hasBoard: false,
            hasState: true
          }),
          retainedObjectId: "retained-alias-3"
        }
      ],
      {
        pollTargetByRetainedObjectId: {
          "retained-alias-1": sharedState
        }
      }
    );

    await maybeRunQuickPlayDiagnosticCapture({
      cdp: harness.cdp,
      quickPlayDiagnosticState: diagnosticState,
      browserControlState: controlState,
      transientState: { lastRuntimeError: "" },
      targetUrl: "https://tetr.io/",
      now: 2_102,
      surveySessionFn: async () => ({
        status: "ready",
        runtimePathsChecked: [],
        candidates: []
      }),
      log: (line) => logs.push(line)
    });

    const counts = harness.counts();
    assert.equal(counts.semanticProbeCalls, 3);
    assert.equal(counts.canonicalStateHandleCalls, 3);
    assert.equal(counts.canonicalIdentityCompareCalls, 2);
    assert.equal(counts.retainCloneCalls, 1);
    assert.equal(counts.pollCalls, 1);
    assert.equal(counts.resumeCount, 1);
    assert.equal(counts.postResumeCandidateHandleCalls, 0);
    assert.equal(diagnosticState.boundLocalClosureCandidate.candidateId, "cand-alias-1");
    const snapshot = JSON.parse(readFileSync(paths.passiveSnapshotPath, "utf8"));
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.snapshot.candidate_id, "cand-alias-1");
    assert.ok(logs.some((line) => line.includes("[quick-play] accepted authoritative candidates=3")));
    assert.ok(logs.some((line) => line.includes("[quick-play] canonical semantic groups=1")));
    assert.ok(logs.some((line) => line.includes("[quick-play] alias group size=3 group=1/1")));
    assert.ok(logs.some((line) => line.includes("[quick-play] selected semantic group=1/1")));
    assert.ok(logs.some((line) => line.includes("retain=success")));
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("multiple authoritative accepted candidates fail closed before retain", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 29;
  const diagnosticState = makeQuickPlayState(paths);
  let retainCloneCalls = 0;
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 2_200,
      log: () => {}
    });
    diagnosticState.currentTargetUrl = "https://tetr.io/";
    diagnosticState.nextClosureSurveyAt = 2_200;
    diagnosticState.closureScanState.pendingReason = "first_zenith_options";
    diagnosticState.pendingIdentity = {
      generation: 29,
      userid: "user-29",
      gameid: 8029,
      wsPlayerId: "user-29|8029|Local",
      resolvedAt: 2_200
    };
    diagnosticState.wsPlayers.set("local", {
      userid: "user-29",
      gameid: 8029,
      username: "Local",
      firstSeen: 2_200,
      lastSeen: 2_200
    });

    const acceptedA = {
      candidateId: "cand-aa",
      rootObjectId: "obj-aa",
      functionName: "_tick",
      callFrameIndex: 13,
      scopeIndex: 4,
      scopeType: "closure",
      bindingName: "bindingAA",
      matchedShape: "game.state.board",
      retainedRootKind: "state",
      retainedRootPath: ["state"],
      boardPath: ["state", "board"],
      currentPath: ["state", "current"],
      holdPath: ["state", "hold"],
      queuePath: ["state", "queue"],
      discoveredPaths: {
        board: ["state", "board"],
        current: ["state", "current"],
        hold: ["state", "hold"],
        queue: ["state", "queue"]
      },
      current: "t",
      hold: "i",
      queue: ["o", "s", "z"],
      playing: true,
      ended: false
    };
    const acceptedB = {
      ...acceptedA,
      candidateId: "cand-bb",
      rootObjectId: "obj-bb",
      bindingName: "bindingBB"
    };

    await maybeRunQuickPlayDiagnosticCapture({
      cdp: {
        async send(method, params = {}) {
          if (method === "Runtime.callFunctionOn" && params.returnByValue === true) {
            return {
              result: {
                value: {
                  status: "ready",
                  reason: null,
                  board: Array.from({ length: 40 }, () => Array.from({ length: 10 }, () => 0)),
                  current: { type: "T", x: 4, y: 19, rotation: 1 },
                  hold: "I",
                  queue: ["O", "S", "Z"],
                  playing: true,
                  started: true,
                  countdown_started: false,
                  paused: false,
                  destroyed: false,
                  successful: null,
                  gameoverreason: null,
                  piece_counter: 4,
                  board_width: 10,
                  board_height: 40,
                  current_path: ["state", "current"],
                  hold_path: ["state", "hold"],
                  queue_path: ["state", "queue"],
                  board_normalized: true,
                  current_normalized: true,
                  hold_normalized: true,
                  queue_normalized: true,
                  field_diagnostics: {
                    root: { retained_object_stage: "state" },
                    board: { requested_path: ["board"], path_resolved: true },
                    current: {},
                    hold: {},
                    queue: {}
                  }
                }
              }
            };
          }
          if (method === "Runtime.callFunctionOn" && params.returnByValue === false) {
            retainCloneCalls += 1;
            return {
              result: {
                objectId: "should-not-retain"
              }
            };
          }
          if (method === "Runtime.releaseObject" || method === "Runtime.releaseObjectGroup") {
            return {};
          }
          throw new Error(`unexpected method ${method}`);
        }
      },
      quickPlayDiagnosticState: diagnosticState,
      browserControlState: controlState,
      transientState: { lastRuntimeError: "" },
      targetUrl: "https://tetr.io/",
      now: 2_200,
      surveySessionFn: async () => ({
        status: "ready",
        runtimePathsChecked: [],
        candidates: []
      }),
      scanClosureFn: async () => ({
        status: "ready",
        productive: true,
        resultType: "ambiguous_authoritative_candidates",
        rawCandidates: [acceptedA, acceptedB],
        acceptedCandidates: []
      }),
      log: () => {}
    });

    assert.equal(retainCloneCalls, 0);
    assert.equal(String(diagnosticState.boundLocalClosureCandidate.rootObjectId ?? ""), "");
    const snapshot = JSON.parse(readFileSync(paths.passiveSnapshotPath, "utf8"));
    assert.deepEqual(snapshot, {
      status: "unavailable",
      reason: "ambiguous_authoritative_candidates"
    });
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("timeout path releases retained passive candidate handle", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  const diagnosticState = makeQuickPlayState(paths);
  const methods = [];
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 3_000,
      log: () => {}
    });
    diagnosticState.boundLocalClosureCandidate.rootObjectId = "retained-2";
    diagnosticState.boundLocalClosureCandidate.candidateId = "cand-timeout";
    diagnosticState.stopAt = 3_001;

    await maybeRunQuickPlayDiagnosticCapture({
      cdp: {
        async send(method) {
          methods.push(method);
          return {};
        }
      },
      quickPlayDiagnosticState: diagnosticState,
      browserControlState: controlState,
      transientState: { lastRuntimeError: "" },
      targetUrl: "https://tetr.io/",
      now: 3_002,
      log: () => {}
    });

    assert.ok(methods.includes("Runtime.releaseObject"));
    assert.ok(methods.includes("Runtime.releaseObjectGroup"));
    const snapshot = JSON.parse(readFileSync(paths.passiveSnapshotPath, "utf8"));
    assert.deepEqual(snapshot, {
      status: "unavailable",
      reason: "duration_elapsed"
    });
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("candidate first and identity later binds successfully once", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 21;
  const diagnosticState = makeQuickPlayState(paths);
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 4_000,
      log: () => {}
    });
    diagnosticState.currentTargetUrl = "https://tetr.io/";
    diagnosticState.boundLocalClosureCandidate = makeBoundQuickPlayCandidate({
      generation: 21,
      candidateId: "cand-late-identity",
      rootObjectId: "retained-late-identity",
      capturedAt: 4_000
    });
    diagnosticState.closureCandidates.set("cand-late-identity", {
      candidate_id: "cand-late-identity",
      function_name: "_tick",
      scope_type: "closure",
      current: "t",
      hold: "i",
      queue: ["o", "s", "z"],
      playing: true,
      ended: false,
      firstSeen: 4_000,
      lastSeen: 4_000
    });

    const deferred = await reconcileQuickPlayPassiveBinding(diagnosticState, {
      reason: "accepted_candidate",
      browserControlState: controlState,
      now: 4_000,
      log: () => {}
    });
    assert.equal(deferred.result, "deferred");
    assert.equal(deferred.deferredReason, "identity_not_ready");
    assert.equal(diagnosticState.boundLocalClosureCandidate.rootObjectId, "retained-late-identity");

    const identityUpdate = updateQuickPlayPendingIdentity(
      diagnosticState,
      { status: "resolved", userid: "user-late", gameid: 4021 },
      4_010
    );
    assert.equal(identityUpdate.changed, true);
    const bound = await reconcileQuickPlayPassiveBinding(diagnosticState, {
      reason: identityUpdate.reason,
      browserControlState: controlState,
      now: 4_010,
      log: () => {}
    });
    assert.equal(bound.result, "bound");
    assert.equal(bound.shouldStartPolling, true);
    assert.equal(diagnosticState.diagnostics.passive_snapshot.bind_succeeded, 1);
    assert.equal(
      diagnosticState.diagnostics.passive_snapshot.bind_deferred_reasons.identity_not_ready,
      1
    );
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("accepted candidate is retained before Debugger.resume and diagnostic cleanup", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 29;
  const diagnosticState = makeQuickPlayState(paths);
  const calls = [];
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 3_900,
      log: () => {}
    });
    diagnosticState.currentTargetUrl = "https://tetr.io/";
    diagnosticState.roundObserved = true;

    const pausedEvent = {
      callFrames: [
        {
          callFrameId: "frame-1",
          functionName: "_tick",
          location: {
            scriptId: "1",
            lineNumber: 14,
            columnNumber: 0
          },
          scopeChain: [null, null, null, null, {
            type: "closure",
            object: { objectId: "scope-4" }
          }]
        }
      ]
    };
    const cdp = {
      async send(method, params = {}) {
        calls.push({ method, params });
        if (
          method === "Debugger.enable" ||
          method === "Debugger.pause" ||
          method === "Debugger.resume" ||
          method === "Debugger.disable"
        ) {
          return {};
        }
        if (method === "Runtime.getProperties" && params.objectId === "scope-4") {
          return {
            result: [
              {
                name: "Ai",
                value: {
                  type: "object",
                  objectId: "candidate-root"
                }
              }
            ]
          };
        }
      if (
        method === "Runtime.callFunctionOn" &&
        params.objectId === "candidate-root"
      ) {
        if (params.returnByValue === false) {
          return {
            result: {
              objectId: "retained-root"
            }
          };
        }
        return {
          result: {
            value: {
              ...executeObjectFunction(
                params.functionDeclaration,
                {
                  state: {
                    board: Array.from({ length: 40 }, () => Array.from({ length: 10 }, () => 0)),
                    current: "t",
                    hold: "i",
                    queue: ["o", "s", "z"],
                    destroyed: false
                  }
                },
                (params.arguments ?? []).map((entry) => entry?.value)
              ),
              candidateId: "paused:0:4:0:Ai",
              locator: "Ai",
              bindingName: "Ai",
              fullPath: "frame[0].scope[4].Ai.state.board",
              matchedShape: "state.board",
              objectKeys: ["state"],
              typeof: "object",
              hasBoardLike: true,
              hasCurrentLike: true,
              hasQueueLike: true,
              hasHoldLike: true,
              hasGameId: false,
              hasSeed: false,
              hasUserId: false,
              rejectedReason: [],
              current: "t",
              hold: "i",
              queue: ["o", "s", "z"],
              pieceCounter: 1,
              boardWidth: 10,
              boardHeight: 40,
              boardHash: "abcd1234",
              rowOccupancy: [0, 0, 0],
              playing: true,
              ended: false,
              accepted: true
            }
          }
        };
        }
        if (
          method === "Runtime.releaseObjectGroup" &&
          params.objectGroup === "fusion-quick-play-diagnostic"
        ) {
          return {};
        }
        throw new Error(`unexpected method ${method}`);
      },
      async waitForEvent(method) {
        assert.equal(method, "Debugger.paused");
        return pausedEvent;
      }
    };

    const scan = await scanQuickPlayClosureCandidates(
      cdp,
      { lastRuntimeError: "" },
      () => {},
      diagnosticState,
      4
    );

    assert.equal(scan.retainResult?.ok, true);
    assert.equal(diagnosticState.boundLocalClosureCandidate.rootObjectId, "retained-root");
    assert.deepEqual(Array.from(diagnosticState.boundLocalClosureCandidate.rootPath), []);
    assert.deepEqual(Array.from(diagnosticState.boundLocalClosureCandidate.boardPath), ["board"]);
    assert.deepEqual(Array.from(diagnosticState.boundLocalClosureCandidate.currentPath), ["current"]);
    const retainCallIndex = calls.findIndex(
      (entry) =>
        entry.method === "Runtime.callFunctionOn" &&
        entry.params.returnByValue === false &&
        Array.isArray(entry.params.arguments) &&
        entry.params.arguments[0]?.value?.[0] === "state"
    );
    const resumeIndex = calls.findIndex((entry) => entry.method === "Debugger.resume");
    const releaseGroupIndex = calls.findIndex(
      (entry) =>
        entry.method === "Runtime.releaseObjectGroup" &&
        entry.params.objectGroup === "fusion-quick-play-diagnostic"
    );
    assert.ok(retainCallIndex >= 0);
    assert.ok(resumeIndex > retainCallIndex);
    assert.ok(releaseGroupIndex > resumeIndex);
    assert.ok(
      !calls.some(
        (entry) =>
          entry.method === "Runtime.releaseObjectGroup" &&
          entry.params.objectGroup === "fusion-quick-play-passive"
      )
    );
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("multi-candidate semantic disambiguation with no authoritative result resumes exactly once", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 30;
  const diagnosticState = makeQuickPlayState(paths);
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 4_100,
      log: () => {}
    });
    diagnosticState.currentTargetUrl = "https://tetr.io/";
    const harness = createQuickPlayMultiAcceptedPausedFixture([
      {
        candidate: makeQuickPlayAcceptedCandidateFixture({
          candidateId: "cand-a",
          rootObjectId: "obj-a",
          bindingName: "bindingA",
          matchedShape: "game.state.board",
          retainedRootKind: "state",
          retainedRootPath: ["state"],
          boardPath: ["state", "board"],
          currentPath: ["state", "current"],
          holdPath: ["state", "hold"],
          queuePath: ["state", "queue"]
        }),
        semanticProbeValue: makeQuickPlaySemanticProbeFixtureValue({
          status: "semantic_failed",
          reason: "accessor_path_unresolved",
          retainedObjectStage: "state",
          boardWidth: 0,
          boardHeight: 0,
          boardNormalized: false,
          currentNormalized: false,
          holdNormalized: false,
          queueNormalized: false,
          board: null,
          current: null,
          hold: null,
          queue: [],
          playing: null,
          started: null,
          currentPath: [],
          holdPath: [],
          queuePath: [],
          boardPathResolved: false
        }),
        rootProbeValue: makeQuickPlayRootProbeFixtureValue(),
        retainedObjectId: "retained-a"
      },
      {
        candidate: makeQuickPlayAcceptedCandidateFixture({
          candidateId: "cand-b",
          rootObjectId: "obj-b",
          bindingName: "bindingB",
          matchedShape: "_presentation.primary.board",
          retainedRootKind: "binding",
          retainedRootPath: ["_presentation", "primary"],
          boardPath: ["_presentation", "primary", "board"],
          currentPath: ["_presentation", "primary", "current"],
          holdPath: ["_presentation", "primary", "hold"],
          queuePath: ["_presentation", "primary", "queue"]
        }),
        semanticProbeValue: makeQuickPlaySemanticProbeFixtureValue({
          status: "semantic_failed",
          reason: "accessor_path_unresolved",
          retainedObjectStage: "binding",
          boardWidth: 0,
          boardHeight: 0,
          boardNormalized: false,
          currentNormalized: false,
          holdNormalized: false,
          queueNormalized: false,
          board: null,
          current: null,
          hold: null,
          queue: [],
          playing: null,
          started: null,
          currentPath: [],
          holdPath: [],
          queuePath: [],
          boardRequestedPath: ["_presentation", "primary", "board"],
          boardPathResolved: false
        }),
        rootProbeValue: makeQuickPlayRootProbeFixtureValue({
          requestedPath: ["_presentation", "primary"],
          retainedObjectStage: "binding"
        }),
        retainedObjectId: "retained-b"
      }
    ]);

    const scan = await scanQuickPlayClosureCandidates(
      harness.cdp,
      { lastRuntimeError: "" },
      () => {},
      diagnosticState,
      1
    );

    const counts = harness.counts();
    assert.equal(scan.resultType, "no_authoritative_candidate");
    assert.deepEqual(scan.acceptedCandidates, []);
    assert.equal(scan.retainResult, null);
    assert.equal(counts.semanticProbeCalls, 2);
    assert.equal(counts.retainCloneCalls, 0);
    assert.equal(counts.resumeCount, 1);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("multi-candidate semantic disambiguation with ambiguous authoritative result resumes exactly once", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 31;
  const diagnosticState = makeQuickPlayState(paths);
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 4_200,
      log: () => {}
    });
    diagnosticState.currentTargetUrl = "https://tetr.io/";
    const canonicalStateA = { token: "state-a" };
    const canonicalStateB = { token: "state-b" };
    const authoritativeValue = makeQuickPlaySemanticProbeFixtureValue({
      retainedObjectStage: "state",
      currentPath: ["state", "current"],
      holdPath: ["state", "hold"],
      queuePath: ["state", "queue"]
    });
    const harness = createQuickPlayMultiAcceptedPausedFixture([
      {
        candidate: makeQuickPlayAcceptedCandidateFixture({
          candidateId: "cand-a",
          rootObjectId: "obj-a",
          bindingName: "bindingA",
          matchedShape: "game.state.board",
          retainedRootKind: "state",
          retainedRootPath: ["state"],
          boardPath: ["state", "board"],
          currentPath: ["state", "current"],
          holdPath: ["state", "hold"],
          queuePath: ["state", "queue"]
        }),
        semanticProbeValue: authoritativeValue,
        canonicalStateTarget: canonicalStateA,
        rootProbeValue: makeQuickPlayRootProbeFixtureValue(),
        retainedObjectId: "retained-a"
      },
      {
        candidate: makeQuickPlayAcceptedCandidateFixture({
          candidateId: "cand-b",
          rootObjectId: "obj-b",
          bindingName: "bindingB",
          matchedShape: "another.state.board",
          retainedRootKind: "state",
          retainedRootPath: ["state"],
          boardPath: ["state", "board"],
          currentPath: ["state", "current"],
          holdPath: ["state", "hold"],
          queuePath: ["state", "queue"]
        }),
        semanticProbeValue: authoritativeValue,
        canonicalStateTarget: canonicalStateB,
        rootProbeValue: makeQuickPlayRootProbeFixtureValue(),
        retainedObjectId: "retained-b"
      }
    ]);

    const scan = await scanQuickPlayClosureCandidates(
      harness.cdp,
      { lastRuntimeError: "" },
      () => {},
      diagnosticState,
      1
    );

    const counts = harness.counts();
    assert.equal(scan.resultType, "ambiguous_authoritative_candidates");
    assert.deepEqual(scan.acceptedCandidates, []);
    assert.equal(scan.retainResult, null);
    assert.equal(counts.semanticProbeCalls, 2);
    assert.equal(counts.canonicalStateHandleCalls, 2);
    assert.equal(counts.canonicalIdentityCompareCalls, 1);
    assert.equal(counts.retainCloneCalls, 0);
    assert.equal(counts.resumeCount, 1);
    assert.equal(counts.postResumeCandidateHandleCalls, 0);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("multi-candidate semantic probe transport failure fails closed and resumes exactly once", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 32;
  const diagnosticState = makeQuickPlayState(paths);
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 4_300,
      log: () => {}
    });
    diagnosticState.currentTargetUrl = "https://tetr.io/";
    const harness = createQuickPlayMultiAcceptedPausedFixture([
      {
        candidate: makeQuickPlayAcceptedCandidateFixture({
          candidateId: "cand-a",
          rootObjectId: "obj-a",
          bindingName: "bindingA",
          matchedShape: "game.state.board",
          retainedRootKind: "state",
          retainedRootPath: ["state"],
          boardPath: ["state", "board"],
          currentPath: ["state", "current"],
          holdPath: ["state", "hold"],
          queuePath: ["state", "queue"]
        }),
        semanticProbeValue: makeQuickPlaySemanticProbeFixtureValue(),
        semanticProbeError: "Invalid remote object id",
        rootProbeValue: makeQuickPlayRootProbeFixtureValue(),
        retainedObjectId: "retained-a"
      },
      {
        candidate: makeQuickPlayAcceptedCandidateFixture({
          candidateId: "cand-b",
          rootObjectId: "obj-b",
          bindingName: "bindingB",
          matchedShape: "_presentation.primary.board",
          retainedRootKind: "binding",
          retainedRootPath: ["_presentation", "primary"],
          boardPath: ["_presentation", "primary", "board"],
          currentPath: ["_presentation", "primary", "current"],
          holdPath: ["_presentation", "primary", "hold"],
          queuePath: ["_presentation", "primary", "queue"]
        }),
        semanticProbeValue: makeQuickPlaySemanticProbeFixtureValue(),
        semanticProbeError: "Invalid remote object id",
        rootProbeValue: makeQuickPlayRootProbeFixtureValue({
          requestedPath: ["_presentation", "primary"],
          retainedObjectStage: "binding"
        }),
        retainedObjectId: "retained-b"
      }
    ]);

    const scan = await scanQuickPlayClosureCandidates(
      harness.cdp,
      { lastRuntimeError: "" },
      () => {},
      diagnosticState,
      1
    );

    const counts = harness.counts();
    assert.equal(scan.resultType, "no_authoritative_candidate");
    assert.deepEqual(scan.acceptedCandidates, []);
    assert.equal(scan.retainResult, null);
    assert.equal(counts.semanticProbeCalls, 2);
    assert.equal(counts.retainCloneCalls, 0);
    assert.equal(counts.resumeCount, 1);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("multi-candidate retain failure fails closed and resumes exactly once", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 33;
  const diagnosticState = makeQuickPlayState(paths);
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 4_400,
      log: () => {}
    });
    diagnosticState.currentTargetUrl = "https://tetr.io/";
    const harness = createQuickPlayMultiAcceptedPausedFixture([
      {
        candidate: makeQuickPlayAcceptedCandidateFixture({
          candidateId: "cand-a",
          rootObjectId: "obj-a",
          bindingName: "bindingA",
          matchedShape: "game.state.board",
          retainedRootKind: "state",
          retainedRootPath: ["state"],
          boardPath: ["state", "board"],
          currentPath: ["state", "current"],
          holdPath: ["state", "hold"],
          queuePath: ["state", "queue"]
        }),
        semanticProbeValue: makeQuickPlaySemanticProbeFixtureValue({
          retainedObjectStage: "state",
          currentPath: ["state", "current"],
          holdPath: ["state", "hold"],
          queuePath: ["state", "queue"]
        }),
        canonicalStateTarget: { token: "retain-failure-state-a" },
        rootProbeValue: makeQuickPlayRootProbeFixtureValue(),
        retainedObjectId: "retained-a",
        retainCloneError: "Clone failed"
      },
      {
        candidate: makeQuickPlayAcceptedCandidateFixture({
          candidateId: "cand-b",
          rootObjectId: "obj-b",
          bindingName: "bindingB",
          matchedShape: "_presentation.primary.board",
          retainedRootKind: "binding",
          retainedRootPath: ["_presentation", "primary"],
          boardPath: ["_presentation", "primary", "board"],
          currentPath: ["_presentation", "primary", "current"],
          holdPath: ["_presentation", "primary", "hold"],
          queuePath: ["_presentation", "primary", "queue"]
        }),
        semanticProbeValue: makeQuickPlaySemanticProbeFixtureValue({
          status: "semantic_failed",
          reason: "accessor_path_unresolved",
          retainedObjectStage: "binding",
          boardWidth: 0,
          boardHeight: 0,
          boardNormalized: false,
          currentNormalized: false,
          holdNormalized: false,
          queueNormalized: false,
          board: null,
          current: null,
          hold: null,
          queue: [],
          playing: null,
          started: null,
          currentPath: [],
          holdPath: [],
          queuePath: [],
          boardRequestedPath: ["_presentation", "primary", "board"],
          boardPathResolved: false
        }),
        rootProbeValue: makeQuickPlayRootProbeFixtureValue({
          requestedPath: ["_presentation", "primary"],
          retainedObjectStage: "binding"
        }),
        retainedObjectId: "retained-b"
      }
    ]);

    const scan = await scanQuickPlayClosureCandidates(
      harness.cdp,
      { lastRuntimeError: "" },
      () => {},
      diagnosticState,
      1
    );

    const counts = harness.counts();
    assert.equal(scan.resultType, "handle_clone_failed");
    assert.deepEqual(scan.acceptedCandidates, []);
    assert.equal(scan.retainResult?.ok, false);
    assert.equal(scan.retainResult?.reason, "handle_clone_failed");
    assert.equal(counts.semanticProbeCalls, 2);
    assert.equal(counts.canonicalStateHandleCalls, 1);
    assert.equal(counts.canonicalIdentityCompareCalls, 0);
    assert.equal(counts.retainCloneCalls, 1);
    assert.equal(counts.resumeCount, 1);
    assert.equal(counts.postResumeCandidateHandleCalls, 0);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("missing runtime handle records candidate_retain_failed diagnostics", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 30;
  const diagnosticState = makeQuickPlayState(paths);
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 4_500,
      log: () => {}
    });
    diagnosticState.currentTargetUrl = "https://tetr.io/";

    const result = await retainQuickPlayPassiveCandidateHandle(
      {
        async send() {
          throw new Error("send should not be called");
        }
      },
      diagnosticState,
      {
        candidateId: "cand-missing-handle",
        matchedShape: "state.board",
        functionName: "_tick",
        scopeIndex: 4,
        scopeType: "closure",
        bindingName: "Ai"
      },
      {
        generation: 30,
        targetId: "https://tetr.io/",
        capturedAt: 4_500,
        log: () => {}
      }
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing_runtime_object_handle");
    assert.equal(diagnosticState.diagnostics.passive_snapshot.candidate_retain_attempts, 1);
    assert.equal(diagnosticState.diagnostics.passive_snapshot.candidate_retain_failed, 1);
    assert.equal(
      diagnosticState.diagnostics.passive_snapshot.last_candidate_retain_failure,
      "missing_runtime_object_handle"
    );
    assert.equal(
      diagnosticState.diagnostics.passive_snapshot.last_failure_reason,
      "candidate_retain_failed"
    );
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("report sanitization keeps internal retained handle private", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 31;
  const diagnosticState = makeQuickPlayState(paths);
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 4_800,
      log: () => {}
    });
    diagnosticState.currentTargetUrl = "https://tetr.io/";

    const acceptedCandidate = {
      candidateId: "cand-report",
      rootObjectId: "raw-root",
      functionName: "_tick",
      callFrameIndex: 14,
      scopeIndex: 4,
      scopeType: "closure",
      bindingName: "Ai",
      matchedShape: "state.board",
      current: "t",
      hold: "i",
      queue: ["o", "s", "z"],
      playing: true,
      ended: false
    };
    recordQuickPlayClosureCandidates(
      diagnosticState,
      {
        acceptedCandidates: [acceptedCandidate],
        rawCandidates: [acceptedCandidate]
      },
      4_800
    );

    const retain = await retainQuickPlayPassiveCandidateHandle(
      {
        async send(method, params = {}) {
          if (method === "Runtime.callFunctionOn") {
            return params.returnByValue === false
              ? {
                  result: {
                    objectId: "retained-report"
                  }
                }
              : {
                  result: {
                    value: {
                      requested_path: ["state"],
                      resolved_segments: ["state"],
                      failed_segment: null,
                      path_resolved: true,
                      accessor_exception: false,
                      value_type: "object",
                      retained_object_stage: "state",
                      root_diagnostics: {
                        raw_type: "object",
                        constructor: "Object",
                        own_keys: ["board", "current", "hold", "queue"],
                        has_board: true,
                        has_falling: false,
                        has_hold: true,
                        has_bag: false,
                        has_game: false,
                        has_state: false
                      }
                    }
                  }
                };
          }
          if (method === "Runtime.releaseObject") {
            return {};
          }
          throw new Error(`unexpected method ${method}`);
        }
      },
      diagnosticState,
      acceptedCandidate,
      {
        generation: 31,
        targetId: "https://tetr.io/",
        capturedAt: 4_800,
        log: () => {}
      }
    );
    const report = buildQuickPlayRuntimeReport(diagnosticState);
    const serialized = JSON.stringify(report);

    assert.equal(retain.ok, true);
    assert.equal(diagnosticState.boundLocalClosureCandidate.rootObjectId, "retained-report");
    assert.equal(
      Object.prototype.hasOwnProperty.call(report.closure_candidates[0], "rootObjectId"),
      false
    );
    assert.ok(!serialized.includes("raw-root"));
    assert.ok(!serialized.includes("retained-report"));
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("retained passive candidate traverses root path before cloning", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 32;
  const diagnosticState = makeQuickPlayState(paths);
  const bindingRoot = {
    state: {
      board: Array.from({ length: 40 }, () => Array.from({ length: 10 }, () => 0)),
      current: "t",
      hold: "i",
      queue: ["o", "s", "z"]
    }
  };
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 5_100,
      log: () => {}
    });
    diagnosticState.currentTargetUrl = "https://tetr.io/";

    const retain = await retainQuickPlayPassiveCandidateHandle(
      {
        async send(method, params = {}) {
          if (method === "Runtime.callFunctionOn" && params.returnByValue === true) {
            return {
              result: {
                value: executeObjectFunction(
                  params.functionDeclaration,
                  bindingRoot,
                  (params.arguments ?? []).map((entry) => entry?.value)
                )
              }
            };
          }
          if (method === "Runtime.callFunctionOn" && params.returnByValue === false) {
            assert.ok(String(params.functionDeclaration).trim().startsWith("function("));
            assert.deepEqual((params.arguments ?? []).map((entry) => entry?.value), [["state"]]);
            return {
              result: {
                objectId: "retained-state"
              }
            };
          }
          if (method === "Runtime.releaseObject") {
            return {};
          }
          throw new Error(`unexpected method ${method}`);
        }
      },
      diagnosticState,
      {
        candidateId: "cand-retain-state",
        rootObjectId: "binding-root",
        functionName: "_tick",
        scopeIndex: 4,
        scopeType: "closure",
        bindingName: "Ai",
        matchedShape: "state.board",
        current: "t",
        hold: "i",
        queue: ["o", "s", "z"]
      },
      {
        generation: 32,
        targetId: "https://tetr.io/",
        capturedAt: 5_100,
        log: () => {}
      }
    );

    assert.equal(retain.ok, true);
    assert.equal(diagnosticState.boundLocalClosureCandidate.rootObjectId, "retained-state");
    assert.deepEqual(Array.from(diagnosticState.boundLocalClosureCandidate.rootPath), []);
    assert.deepEqual(Array.from(diagnosticState.boundLocalClosureCandidate.boardPath), ["board"]);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("root path invariant mismatch rejects board handle retained as state", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 33;
  const diagnosticState = makeQuickPlayState(paths);
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 5_200,
      log: () => {}
    });
    diagnosticState.currentTargetUrl = "https://tetr.io/";

    const retain = await retainQuickPlayPassiveCandidateHandle(
      {
        async send(method, params = {}) {
          if (method === "Runtime.callFunctionOn" && params.returnByValue === true) {
            return {
              result: {
                value: {
                  requested_path: ["state"],
                  resolved_segments: [],
                  failed_segment: "state",
                  path_resolved: false,
                  accessor_exception: false,
                  value_type: "undefined",
                  retained_object_stage: "board",
                  root_diagnostics: null
                }
              }
            };
          }
          throw new Error(`unexpected method ${method}`);
        }
      },
      diagnosticState,
      {
        candidateId: "cand-board-mismatch",
        rootObjectId: "board-root",
        functionName: "_tick",
        scopeIndex: 4,
        scopeType: "closure",
        bindingName: "Ai",
        matchedShape: "state.board",
        current: "t",
        hold: "i",
        queue: ["o", "s", "z"]
      },
      {
        generation: 33,
        targetId: "https://tetr.io/",
        capturedAt: 5_200,
        log: () => {}
      }
    );

    assert.equal(retain.ok, false);
    assert.equal(retain.reason, "root_path_invariant_failed");
    assert.equal(
      diagnosticState.diagnostics.passive_snapshot.last_candidate_retain_failure,
      "root_path_invariant_failed"
    );
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("undefined final board value is unresolved and root probe logs only once", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 34;
  const diagnosticState = makeQuickPlayState(paths);
  const logs = [];
  const retainedRoot = {
    current: "t",
    hold: "i",
    queue: ["o", "s", "z"],
    started: true,
    playing: true
  };
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 5_300,
      log: () => {}
    });
    diagnosticState.currentTargetUrl = "https://tetr.io/";
    diagnosticState.boundLocalClosureCandidate = makeBoundQuickPlayCandidate({
      generation: 34,
      candidateId: "cand-root-probe",
      rootObjectId: "retained-state",
      rootPath: [],
      retainedRootPath: [],
      retainedRootKind: "state",
      boardPath: ["board"],
      currentPath: ["current"],
      holdPath: ["hold"],
      queuePath: ["queue"],
      userid: "user-root",
      gameid: 5034,
      identityBound: true
    });

    const cdp = {
      async send(method, params = {}) {
        if (method === "Runtime.callFunctionOn") {
          return {
            result: {
              value: executeObjectFunction(
                params.functionDeclaration,
                retainedRoot,
                (params.arguments ?? []).map((entry) => entry?.value)
              )
            }
          };
        }
        throw new Error(`unexpected method ${method}`);
      }
    };

    const first = await pollQuickPlayPassiveSnapshotNow(cdp, diagnosticState, {
      now: 5_301,
      log: (line) => logs.push(line)
    });
    const second = await pollQuickPlayPassiveSnapshotNow(cdp, diagnosticState, {
      now: 5_302,
      log: (line) => logs.push(line)
    });

    assert.equal(first.status, "unavailable");
    assert.equal(first.reason, "accessor_path_unresolved");
    assert.equal(second.status, "unavailable");
    assert.equal(second.reason, "accessor_path_unresolved");
    assert.equal(
      diagnosticState.diagnostics.passive_snapshot.field_diagnostics?.board?.path_resolved,
      false
    );
    assert.deepEqual(
      Array.from(
        diagnosticState.diagnostics.passive_snapshot.field_diagnostics?.board?.resolved_segments ??
          []
      ),
      []
    );
    assert.equal(
      diagnosticState.diagnostics.passive_snapshot.field_diagnostics?.board?.failed_segment,
      "board"
    );
    assert.equal(
      diagnosticState.diagnostics.passive_snapshot.field_diagnostics?.board?.raw_type,
      "undefined"
    );
    assert.equal(
      diagnosticState.diagnostics.passive_snapshot.field_diagnostics?.root?.raw_type,
      "object"
    );
    assert.equal(
      logs.filter((line) => line.startsWith("[quick-play] passive root probe")).length,
      1
    );
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("identity first and candidate later binds successfully", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 22;
  const diagnosticState = makeQuickPlayState(paths);
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 5_000,
      log: () => {}
    });
    diagnosticState.currentTargetUrl = "https://tetr.io/";

    const identityUpdate = updateQuickPlayPendingIdentity(
      diagnosticState,
      { status: "resolved", userid: "user-first", gameid: 5022 },
      5_000
    );
    assert.equal(identityUpdate.changed, true);
    const deferred = await reconcileQuickPlayPassiveBinding(diagnosticState, {
      reason: identityUpdate.reason,
      browserControlState: controlState,
      now: 5_000,
      log: () => {}
    });
    assert.equal(deferred.result, "deferred");
    assert.equal(deferred.deferredReason, "candidate_not_ready");

    diagnosticState.boundLocalClosureCandidate = makeBoundQuickPlayCandidate({
      generation: 22,
      candidateId: "cand-late-candidate",
      rootObjectId: "retained-late-candidate",
      callFrameIndex: 6,
      bindingName: "Rb",
      capturedAt: 5_010
    });
    diagnosticState.closureCandidates.set("cand-late-candidate", {
      candidate_id: "cand-late-candidate",
      function_name: "_tick",
      scope_type: "closure",
      current: "t",
      hold: "i",
      queue: ["o", "s", "z"],
      playing: true,
      ended: false,
      firstSeen: 5_010,
      lastSeen: 5_010
    });

    const bound = await reconcileQuickPlayPassiveBinding(diagnosticState, {
      reason: "accepted_candidate",
      browserControlState: controlState,
      now: 5_010,
      log: () => {}
    });
    assert.equal(bound.result, "bound");
    assert.equal(bound.shouldStartPolling, true);
    assert.equal(diagnosticState.boundLocalClosureCandidate.userid, "user-first");
    assert.equal(
      diagnosticState.diagnostics.passive_snapshot.bind_deferred_reasons.candidate_not_ready,
      1
    );
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("zenith automatic owner binds successfully while bot is enabled", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 122;
  controlState.botEnabled = true;
  const diagnosticState = makeQuickPlayState(paths);
  try {
    const started = applyBrowserControlMessage({
      message: {
        type: "quick_play_passive_provider",
        owner: "zenith_dry_run",
        enabled: true
      },
      controlState,
      quickPlayDiagnosticState: diagnosticState,
      closureCaptureState: createClosureCaptureState(),
      nextGameReacquireState: createNextGameReacquireState(),
      now: 5_500,
      log: () => {}
    });
    assert.equal(started, true);
    diagnosticState.currentTargetUrl = "https://tetr.io/";

    const identityUpdate = updateQuickPlayPendingIdentity(
      diagnosticState,
      { status: "resolved", userid: "user-auto", gameid: 5122 },
      5_500
    );
    assert.equal(identityUpdate.changed, true);

    diagnosticState.boundLocalClosureCandidate = makeBoundQuickPlayCandidate({
      generation: 122,
      candidateId: "cand-auto-zenith",
      rootObjectId: "retained-auto-zenith",
      callFrameIndex: 6,
      bindingName: "Ra",
      capturedAt: 5_510
    });
    diagnosticState.closureCandidates.set("cand-auto-zenith", {
      candidate_id: "cand-auto-zenith",
      function_name: "_tick",
      scope_type: "closure",
      current: "t",
      hold: "i",
      queue: ["o", "s", "z"],
      playing: true,
      ended: false,
      firstSeen: 5_510,
      lastSeen: 5_510
    });

    const bound = await reconcileQuickPlayPassiveBinding(diagnosticState, {
      reason: "accepted_candidate",
      browserControlState: controlState,
      now: 5_510,
      log: () => {}
    });
    assert.equal(bound.result, "bound");
    assert.equal(bound.deferredReason, "");
    assert.equal(bound.shouldStartPolling, true);
    assert.equal(diagnosticState.boundLocalClosureCandidate.userid, "user-auto");
    assert.equal(diagnosticState.boundLocalClosureCandidate.gameid, 5122);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("duplicate reconciliation binds exactly once and first poll starts immediately", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 23;
  const diagnosticState = makeQuickPlayState(paths);
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 6_000,
      log: () => {}
    });
    diagnosticState.currentTargetUrl = "https://tetr.io/";
    diagnosticState.boundLocalClosureCandidate = makeBoundQuickPlayCandidate({
      generation: 23,
      candidateId: "cand-dup",
      rootObjectId: "retained-dup",
      callFrameIndex: 7,
      bindingName: "Rc",
      capturedAt: 6_000
    });
    diagnosticState.closureCandidates.set("cand-dup", {
      candidate_id: "cand-dup",
      function_name: "_tick",
      scope_type: "closure",
      current: "t",
      hold: "i",
      queue: ["o", "s", "z"],
      playing: true,
      ended: false,
      firstSeen: 6_000,
      lastSeen: 6_000
    });
    updateQuickPlayPendingIdentity(
      diagnosticState,
      { status: "resolved", userid: "user-dup", gameid: 6023 },
      6_001
    );

    const first = await reconcileQuickPlayPassiveBinding(diagnosticState, {
      reason: "simultaneous",
      browserControlState: controlState,
      now: 6_001,
      log: () => {}
    });
    const second = await reconcileQuickPlayPassiveBinding(diagnosticState, {
      reason: "simultaneous",
      browserControlState: controlState,
      now: 6_002,
      log: () => {}
    });
    assert.equal(first.result, "bound");
    assert.equal(first.shouldStartPolling, true);
    assert.equal(second.result, "bound");
    assert.equal(second.shouldStartPolling, false);
    assert.equal(diagnosticState.diagnostics.passive_snapshot.bind_succeeded, 1);

    await pollQuickPlayPassiveSnapshotNow(
      {
        async send(method) {
          if (method === "Runtime.callFunctionOn") {
            return {
              result: {
                value: {
                  status: "ready",
                  board: Array.from({ length: 40 }, () => Array.from({ length: 10 }, () => 0)),
                  current: "t",
                  hold: "i",
                  queue: ["o", "s", "z"],
                  playing: true,
                  started: true,
                  countdown_started: false,
                  paused: false,
                  destroyed: false,
                  successful: null,
                  gameoverreason: null,
                  piece_counter: 2,
                  board_width: 10,
                  board_height: 40,
                  current_path: ["game", "state", "current"],
                  hold_path: ["game", "state", "hold"],
                  queue_path: ["game", "state", "queue"],
                  board_normalized: true,
                  current_normalized: true,
                  hold_normalized: true,
                  queue_normalized: true
                }
              }
            };
          }
          throw new Error(`unexpected method ${method}`);
        }
      },
      diagnosticState,
      {
        now: 6_003,
        log: () => {}
      }
    );
    assert.equal(diagnosticState.diagnostics.passive_snapshot.polling_started, true);
    assert.equal(diagnosticState.diagnostics.passive_snapshot.reads_attempted, 1);
    assert.equal(diagnosticState.diagnostics.passive_snapshot.reads_succeeded, 1);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("generation mismatch and inactive capture cannot bind", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 24;
  const diagnosticState = makeQuickPlayState(paths);
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 7_000,
      log: () => {}
    });
    diagnosticState.currentTargetUrl = "https://tetr.io/";
    diagnosticState.boundLocalClosureCandidate = makeBoundQuickPlayCandidate({
      generation: 23,
      candidateId: "cand-stale",
      rootObjectId: "retained-stale",
      callFrameIndex: 8,
      bindingName: "Rd",
      capturedAt: 7_000
    });
    diagnosticState.closureCandidates.set("cand-stale", {
      candidate_id: "cand-stale",
      function_name: "_tick",
      scope_type: "closure",
      current: "t",
      hold: "i",
      queue: ["o", "s", "z"],
      playing: true,
      ended: false,
      firstSeen: 7_000,
      lastSeen: 7_000
    });
    updateQuickPlayPendingIdentity(
      diagnosticState,
      { status: "resolved", userid: "user-stale", gameid: 7024 },
      7_001
    );
    let result = await reconcileQuickPlayPassiveBinding(diagnosticState, {
      reason: "identity_resolved",
      browserControlState: controlState,
      now: 7_001,
      log: () => {}
    });
    assert.equal(result.result, "rejected");
    assert.equal(result.deferredReason, "generation_mismatch");

    stopQuickPlayDiagnosticCapture(diagnosticState, {
      now: 7_010,
      reason: "duration_elapsed",
      log: () => {}
    });
    result = await reconcileQuickPlayPassiveBinding(diagnosticState, {
      reason: "identity_updated",
      browserControlState: controlState,
      now: 7_011,
      log: () => {}
    });
    assert.equal(result.result, "rejected");
    assert.equal(result.deferredReason, "capture_inactive");
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("cleanup preserves cumulative diagnostics and final duration reason is not overwritten", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 25;
  const diagnosticState = makeQuickPlayState(paths);
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 8_000,
      log: () => {}
    });
    diagnosticState.currentTargetUrl = "https://tetr.io/";
    diagnosticState.boundLocalClosureCandidate = makeBoundQuickPlayCandidate({
      generation: 25,
      candidateId: "cand-final",
      rootObjectId: "retained-final",
      callFrameIndex: 9,
      bindingName: "Re",
      capturedAt: 8_000,
      userid: "user-final",
      gameid: 8025,
      wsPlayerId: "user-final|8025|Final",
      identityBound: true
    });
    diagnosticState.diagnostics.passive_snapshot.bind_succeeded = 1;
    diagnosticState.diagnostics.passive_snapshot.reads_attempted = 1;
    diagnosticState.diagnostics.passive_snapshot.reads_succeeded = 1;
    diagnosticState.diagnostics.passive_snapshot.ever_candidate_bound = true;
    diagnosticState.diagnostics.passive_snapshot.ever_identity_bound = true;

    stopQuickPlayDiagnosticCapture(diagnosticState, {
      now: 8_010,
      reason: "duration_elapsed",
      log: () => {}
    });
    await releaseQuickPlayPassiveState(
      {
        async send() {
          return {};
        }
      },
      diagnosticState,
      {
        reason: "execution_context_reset",
        writeSnapshotStatus: false,
        preserveDiagnostics: true,
        log: () => {}
      }
    );

    const snapshot = JSON.parse(readFileSync(paths.passiveSnapshotPath, "utf8"));
    const report = JSON.parse(readFileSync(paths.reportPath, "utf8"));
    assert.equal(snapshot.reason, "duration_elapsed");
    assert.equal(report.stop_reason, "duration_elapsed");
    assert.equal(report.diagnostics.passive_snapshot.bind_succeeded, 1);
    assert.equal(report.diagnostics.passive_snapshot.reads_attempted, 1);
    assert.equal(report.diagnostics.passive_snapshot.ever_candidate_bound, true);
    assert.equal(report.diagnostics.passive_snapshot.ever_identity_bound, true);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("matching_frame_missing schedules bounded timing-miss retry", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 26;
  const diagnosticState = makeQuickPlayState(paths);
  diagnosticState.closureRetryJitterMsFn = () => 0;
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 9_000,
      log: () => {}
    });
    diagnosticState.roundObserved = true;
    diagnosticState.pendingIdentity = {
      generation: 26,
      userid: "user-retry",
      gameid: 9026,
      wsPlayerId: "user-retry|9026|Retry",
      resolvedAt: 9_000
    };
    diagnosticState.nextClosureSurveyAt = 9_000;
    diagnosticState.closureScanState.pendingReason = "gameplay_signal";

    await maybeRunQuickPlayDiagnosticCapture({
      cdp: {
        async send() {
          return {};
        }
      },
      quickPlayDiagnosticState: diagnosticState,
      browserControlState: controlState,
      transientState: { lastRuntimeError: "" },
      targetUrl: "https://tetr.io/",
      now: 9_000,
      surveySessionFn: async () => ({
        status: "ready",
        runtimePathsChecked: [],
        candidates: []
      }),
      scanClosureFn: async () => ({
        status: "ready",
        productive: false,
        resultType: "matching_frame_missing",
        callframesSeen: 6,
        noTickAttempt: {
          attempt: 1,
          callframes_seen: 6,
          top_functions: ["render", "updateStyle", "sentryWrapped"],
          render_like_count: 1,
          update_like_count: 1,
          tick_like_count: 0
        },
        rawCandidates: [],
        acceptedCandidates: []
      }),
      log: () => {}
    });

    assert.equal(diagnosticState.closureScanState.pendingReason, "timing_miss");
    assert.equal(diagnosticState.nextClosureSurveyAt, 9_160);
    assert.equal(diagnosticState.diagnostics.closure_scan.timing_miss_count, 1);
    assert.equal(
      diagnosticState.diagnostics.closure_scan.timing_miss_reasons.matching_frame_missing,
      1
    );
    assert.equal(diagnosticState.diagnostics.closure_scan.last_no_tick_callframes, 6);
    assert.deepEqual(
      diagnosticState.diagnostics.closure_scan.no_tick_attempts[0]?.top_functions,
      ["render", "updateStyle", "sentryWrapped"]
    );
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("Zenith startup burst uses short retries before falling back to long backoff", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.botEnabled = true;
  controlState.modeGeneration = 126;
  const diagnosticState = makeQuickPlayState(paths);
  diagnosticState.closureRetryJitterMsFn = () => 0;
  try {
    applyBrowserControlMessage({
      message: {
        type: "quick_play_passive_provider",
        owner: "zenith_dry_run",
        enabled: true
      },
      controlState,
      quickPlayDiagnosticState: diagnosticState,
      closureCaptureState: createClosureCaptureState(),
      nextGameReacquireState: createNextGameReacquireState(),
      now: 9_000,
      log: () => {}
    });
    diagnosticState.roundObserved = true;
    diagnosticState.pendingIdentity = {
      generation: 126,
      userid: "user-burst",
      gameid: 9126,
      wsPlayerId: "user-burst|9126|Burst",
      resolvedAt: 9_000
    };
    recordQuickPlayDiagnosticEnvelope(diagnosticState, {
      timestamp: 9_000,
      direction: "inbound",
      root_keys: ["state", "players"],
      payload_keys: ["countdown", "playing"],
      players: [{ userid: "user-burst", gameid: 9126, username: "Burst" }]
    });

    const runAt = async (now) => maybeRunQuickPlayDiagnosticCapture({
      cdp: {
        async send() {
          return {};
        }
      },
      quickPlayDiagnosticState: diagnosticState,
      browserControlState: controlState,
      transientState: { lastRuntimeError: "" },
      targetUrl: "https://tetr.io/",
      now,
      surveySessionFn: async () => ({
        status: "ready",
        runtimePathsChecked: [],
        candidates: []
      }),
      scanClosureFn: async () => ({
        status: "ready",
        productive: false,
        resultType: "matching_frame_missing",
        callframesSeen: 6,
        noTickAttempt: {
          callframes_seen: 6,
          top_functions: ["render"]
        },
        rawCandidates: [],
        acceptedCandidates: []
      }),
      log: () => {}
    });

    await runAt(9_000);
    assert.equal(diagnosticState.nextClosureSurveyAt, 9_050);
    await runAt(9_050);
    assert.equal(diagnosticState.nextClosureSurveyAt, 9_125);
    await runAt(9_125);
    assert.equal(diagnosticState.nextClosureSurveyAt, 9_225);
    await runAt(9_225);
    assert.equal(diagnosticState.nextClosureSurveyAt, 9_350);
    await runAt(9_350);
    assert.equal(diagnosticState.nextClosureSurveyAt, 9_500);
    await runAt(9_500);
    assert.equal(diagnosticState.nextClosureSurveyAt, 9_700);
    await runAt(9_700);
    assert.equal(diagnosticState.nextClosureSurveyAt, 9_860);
    assert.equal(diagnosticState.zenithStartupTrace.burstRetryCount, 6);
    assert.equal(diagnosticState.zenithStartupTrace.fallbackRetryCount, 1);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("gameplay packet for local gameid rearms scan and unrelated packet does not", () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 27;
  const diagnosticState = makeQuickPlayState(paths);
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 10_000,
      log: () => {}
    });
    diagnosticState.pendingIdentity = {
      generation: 27,
      userid: "user-local",
      gameid: 10027,
      wsPlayerId: "user-local|10027|Local",
      resolvedAt: 10_000
    };
    diagnosticState.roundObserved = true;

    recordQuickPlayDiagnosticEnvelope(diagnosticState, {
      timestamp: 10_010,
      direction: "inbound",
      root_keys: ["state", "players"],
      payload_keys: ["countdown", "playing"],
      players: [{ userid: "other-user", gameid: 99999, username: "Other" }]
    });
    assert.equal(diagnosticState.nextClosureSurveyAt, 0);

    recordQuickPlayDiagnosticEnvelope(diagnosticState, {
      timestamp: 10_020,
      direction: "inbound",
      root_keys: ["state", "players"],
      payload_keys: ["countdown", "playing"],
      players: [{ userid: "user-local", gameid: 10027, username: "Local" }]
    });
    assert.equal(diagnosticState.nextClosureSurveyAt, 10_020);
    assert.equal(diagnosticState.closureScanState.pendingReason, "gameplay_signal");
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("gameplay signal coalesces a pending long retry into an immediate scan", () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.botEnabled = true;
  controlState.modeGeneration = 127;
  const diagnosticState = makeQuickPlayState(paths);
  try {
    applyBrowserControlMessage({
      message: {
        type: "quick_play_passive_provider",
        owner: "zenith_dry_run",
        enabled: true
      },
      controlState,
      quickPlayDiagnosticState: diagnosticState,
      closureCaptureState: createClosureCaptureState(),
      nextGameReacquireState: createNextGameReacquireState(),
      now: 10_000,
      log: () => {}
    });
    diagnosticState.roundObserved = true;
    diagnosticState.pendingIdentity = {
      generation: 127,
      userid: "user-coalesce",
      gameid: 10127,
      wsPlayerId: "user-coalesce|10127|Coalesce",
      resolvedAt: 10_000
    };
    diagnosticState.nextClosureSurveyAt = 10_700;
    diagnosticState.closureScanState.pendingReason = "timing_miss";

    recordQuickPlayDiagnosticEnvelope(diagnosticState, {
      timestamp: 10_020,
      direction: "inbound",
      root_keys: ["state", "players"],
      payload_keys: ["countdown", "playing"],
      players: [{ userid: "user-coalesce", gameid: 10127, username: "Coalesce" }]
    });

    assert.equal(diagnosticState.nextClosureSurveyAt, 10_020);
    assert.equal(diagnosticState.closureScanState.pendingReason, "gameplay_signal");
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("bootstrap ready coalesces a pending long retry into an immediate scan", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.botEnabled = true;
  controlState.modeGeneration = 128;
  const diagnosticState = makeQuickPlayState(paths);
  const zenithBootstrapCheckState = createZenithBootstrapCheckState();
  const bootstrapState = createBootstrapState(0);
  try {
    applyBrowserControlMessage({
      message: {
        type: "quick_play_passive_provider",
        owner: "zenith_dry_run",
        enabled: true
      },
      controlState,
      quickPlayDiagnosticState: diagnosticState,
      closureCaptureState: createClosureCaptureState(),
      nextGameReacquireState: createNextGameReacquireState(),
      now: 11_000,
      log: () => {}
    });
    diagnosticState.roundObserved = true;
    diagnosticState.pendingIdentity = {
      generation: 128,
      userid: "user-bootstrap",
      gameid: 11128,
      wsPlayerId: "user-bootstrap|11128|Bootstrap",
      resolvedAt: 11_000
    };
    diagnosticState.nextClosureSurveyAt = 11_700;
    diagnosticState.closureScanState.pendingReason = "timing_miss";
    zenithBootstrapCheckState.generation = 128;
    zenithBootstrapCheckState.scheduled = true;
    zenithBootstrapCheckState.nextCheckAt = 11_050;

    const result = await maybeRunZenithBootstrapCheck({
      cdp: {
        async send() {
          return {};
        }
      },
      zenithBootstrapCheckState,
      browserControlState: controlState,
      bootstrapState,
      quickPlayDiagnosticState: diagnosticState,
      now: 11_050,
      nowFn: () => 11_050,
      readBootstrapPageStateFn: async () => ({ readyState: "complete", href: "https://tetr.io/" }),
      getBootstrapReadinessStatusFn: () => ({ ready: true, reason: "ready" }),
      log: () => {}
    });

    assert.equal(result.ready, true);
    assert.equal(diagnosticState.nextClosureSurveyAt, 11_050);
    assert.equal(diagnosticState.closureScanState.pendingReason, "bootstrap_ready");
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("retained candidate stops gameplay-triggered retry scheduling", () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  const diagnosticState = makeQuickPlayState(paths);
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 11_000,
      log: () => {}
    });
    diagnosticState.pendingIdentity = {
      generation: 0,
      userid: "user-bound",
      gameid: 11028,
      wsPlayerId: "user-bound|11028|Bound",
      resolvedAt: 11_000
    };
    diagnosticState.roundObserved = true;
    diagnosticState.boundLocalClosureCandidate.rootObjectId = "retained-present";

    recordQuickPlayDiagnosticEnvelope(diagnosticState, {
      timestamp: 11_020,
      direction: "inbound",
      root_keys: ["player", "state"],
      payload_keys: ["piece", "playing"],
      players: [{ userid: "user-bound", gameid: 11028, username: "Bound" }]
    });
    assert.equal(diagnosticState.nextClosureSurveyAt, 0);
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("retry exhaustion records specific timing-miss stop reason", async () => {
  const paths = makeQuickPlayDiagnosticTempPaths();
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 28;
  const diagnosticState = makeQuickPlayState(paths);
  diagnosticState.closureRetryJitterMsFn = () => 0;
  try {
    startQuickPlayDiagnosticCapture(diagnosticState, controlState, {
      now: 12_000,
      log: () => {}
    });
    diagnosticState.roundObserved = true;
    diagnosticState.pendingIdentity = {
      generation: 28,
      userid: "user-exhaust",
      gameid: 12028,
      wsPlayerId: "user-exhaust|12028|Exhaust",
      resolvedAt: 12_000
    };
    diagnosticState.closureScanState.nonproductiveAttempts =
      diagnosticState.closureScanState.maxNonproductiveAttempts - 1;
    diagnosticState.nextClosureSurveyAt = 12_000;
    diagnosticState.closureScanState.pendingReason = "timing_miss";

    await maybeRunQuickPlayDiagnosticCapture({
      cdp: {
        async send() {
          return {};
        }
      },
      quickPlayDiagnosticState: diagnosticState,
      browserControlState: controlState,
      transientState: { lastRuntimeError: "" },
      targetUrl: "https://tetr.io/",
      now: 12_000,
      surveySessionFn: async () => ({
        status: "ready",
        runtimePathsChecked: [],
        candidates: []
      }),
      scanClosureFn: async () => ({
        status: "ready",
        productive: false,
        resultType: "pause_timeout",
        callframesSeen: 0,
        rawCandidates: [],
        acceptedCandidates: []
      }),
      log: () => {}
    });

    assert.equal(diagnosticState.closureScanState.retryExhausted, true);
    assert.equal(diagnosticState.diagnostics.closure_scan.retry_exhausted, true);
    assert.equal(diagnosticState.stopReason, "pause_timeout_exhausted");
  } finally {
    cleanupQuickPlayDiagnosticTempPaths(paths);
  }
});

test("Zenith Bot Off never performs bootstrap check", async () => {
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.modeGeneration = 1;
  const zenithBootstrapCheckState = createZenithBootstrapCheckState();
  let reads = 0;

  assert.equal(
    ensureZenithBootstrapCheckScheduled(zenithBootstrapCheckState, controlState, {
      now: 10_000,
      log: () => {}
    }),
    false
  );

  const result = await maybeRunZenithBootstrapCheck({
    zenithBootstrapCheckState,
    browserControlState: controlState,
    bootstrapState: createBootstrapState(0),
    now: 10_000,
    readBootstrapPageStateFn: async () => {
      reads += 1;
      return { readyState: "complete", href: "https://tetr.io/" };
    },
    log: () => {}
  });

  assert.equal(result.ran, false);
  assert.equal(reads, 0);
});

test("Zenith Bot On performs one bounded bootstrap check loop", async () => {
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.botEnabled = true;
  controlState.modeGeneration = 7;
  const zenithBootstrapCheckState = createZenithBootstrapCheckState();
  const bootstrapState = createBootstrapState(0);
  const logs = [];
  let reads = 0;
  let readyNotifications = 0;

  assert.equal(
    ensureZenithBootstrapCheckScheduled(zenithBootstrapCheckState, controlState, {
      now: 100,
      log: (line) => logs.push(line)
    }),
    true
  );

  let result = await maybeRunZenithBootstrapCheck({
    zenithBootstrapCheckState,
    browserControlState: controlState,
    bootstrapState,
    now: 100,
    nowFn: () => 100,
    readBootstrapPageStateFn: async () => {
      reads += 1;
      updateBootstrapDocumentState(
        bootstrapState,
        { readyState: "loading", href: "https://tetr.io/" },
        100
      );
      return { readyState: "loading", href: "https://tetr.io/" };
    },
    onBootstrapReady: () => {
      readyNotifications += 1;
    },
    log: (line) => logs.push(line)
  });

  assert.equal(result.ran, true);
  assert.equal(result.ready, false);
  assert.equal(zenithBootstrapCheckState.scheduled, true);
  assert.equal(zenithBootstrapCheckState.nextCheckAt, 350);

  result = await maybeRunZenithBootstrapCheck({
    zenithBootstrapCheckState,
    browserControlState: controlState,
    bootstrapState,
    now: 350,
    nowFn: () => 1_800,
    readBootstrapPageStateFn: async () => {
      reads += 1;
      updateBootstrapDocumentState(
        bootstrapState,
        { readyState: "complete", href: "https://tetr.io/" },
        350
      );
      bootstrapState.transportReadyAt = 250;
      return { readyState: "complete", href: "https://tetr.io/" };
    },
    onBootstrapReady: () => {
      readyNotifications += 1;
    },
    log: (line) => logs.push(line)
  });

  assert.equal(result.ran, true);
  assert.equal(result.ready, true);
  assert.equal(reads, 2);
  assert.equal(readyNotifications, 1);
  assert.ok(logs.some((line) => line.startsWith("[zenith] bootstrap check scheduled")));
  assert.ok(logs.some((line) => line.startsWith("[zenith] bootstrap ready generation=7")));
});

test("non-Solo gating does not prevent Zenith bootstrap notification", async () => {
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.botEnabled = true;
  controlState.modeGeneration = 3;
  const zenithBootstrapCheckState = createZenithBootstrapCheckState();
  const bootstrapState = readyBootstrapState(20_000);
  let notified = 0;

  ensureZenithBootstrapCheckScheduled(zenithBootstrapCheckState, controlState, {
    now: 20_000,
    log: () => {}
  });

  const result = await maybeRunZenithBootstrapCheck({
    zenithBootstrapCheckState,
    browserControlState: controlState,
    bootstrapState,
    now: 20_000,
    nowFn: () => 20_000,
    readBootstrapPageStateFn: async () => ({
      readyState: "complete",
      href: "https://tetr.io/"
    }),
    onBootstrapReady: () => {
      notified += 1;
    },
    log: () => {}
  });

  assert.equal(result.ready, true);
  assert.equal(notified, 1);
});

test("stale mode generation cannot complete bootstrap probe", async () => {
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.botEnabled = true;
  controlState.modeGeneration = 11;
  const zenithBootstrapCheckState = createZenithBootstrapCheckState();
  const bootstrapState = readyBootstrapState(20_000);
  let notified = 0;

  ensureZenithBootstrapCheckScheduled(zenithBootstrapCheckState, controlState, {
    now: 20_000,
    log: () => {}
  });

  const result = await maybeRunZenithBootstrapCheck({
    zenithBootstrapCheckState,
    browserControlState: controlState,
    bootstrapState,
    now: 20_000,
    readBootstrapPageStateFn: async () => {
      controlState.modeGeneration = 12;
      return { readyState: "complete", href: "https://tetr.io/" };
    },
    onBootstrapReady: () => {
      notified += 1;
    },
    log: () => {}
  });

  assert.equal(result.reason, "stale_generation");
  assert.equal(notified, 0);
});

test("Bot Off and mode switching cancel Zenith bootstrap retry", async () => {
  const controlState = createBrowserControlState();
  controlState.selectedMode = "zenith";
  controlState.botEnabled = true;
  controlState.modeGeneration = 9;
  const zenithBootstrapCheckState = createZenithBootstrapCheckState();
  const bootstrapState = createBootstrapState(0);

  ensureZenithBootstrapCheckScheduled(zenithBootstrapCheckState, controlState, {
    now: 50,
    log: () => {}
  });
  await maybeRunZenithBootstrapCheck({
    zenithBootstrapCheckState,
    browserControlState: controlState,
    bootstrapState,
    now: 50,
    nowFn: () => 50,
    readBootstrapPageStateFn: async () => {
      updateBootstrapDocumentState(
        bootstrapState,
        { readyState: "loading", href: "https://tetr.io/" },
        50
      );
      return { readyState: "loading", href: "https://tetr.io/" };
    },
    log: () => {}
  });

  assert.equal(zenithBootstrapCheckState.scheduled, true);
  controlState.botEnabled = false;
  resetZenithBootstrapCheckState(zenithBootstrapCheckState);
  let result = await maybeRunZenithBootstrapCheck({
    zenithBootstrapCheckState,
    browserControlState: controlState,
    bootstrapState,
    now: 300,
    readBootstrapPageStateFn: async () => {
      throw new Error("should not run");
    },
    log: () => {}
  });
  assert.equal(result.ran, false);

  controlState.botEnabled = true;
  controlState.selectedMode = "zenith";
  ensureZenithBootstrapCheckScheduled(zenithBootstrapCheckState, controlState, {
    now: 400,
    log: () => {}
  });
  controlState.selectedMode = "solo";
  resetZenithBootstrapCheckState(zenithBootstrapCheckState);
  result = await maybeRunZenithBootstrapCheck({
    zenithBootstrapCheckState,
    browserControlState: controlState,
    bootstrapState,
    now: 650,
    readBootstrapPageStateFn: async () => {
      throw new Error("should not run");
    },
    log: () => {}
  });
  assert.equal(result.ran, false);
});

test("Solo mode does not run Zenith bootstrap checks", async () => {
  const controlState = createBrowserControlState();
  controlState.selectedMode = "solo";
  controlState.botEnabled = true;
  controlState.modeGeneration = 1;
  const zenithBootstrapCheckState = createZenithBootstrapCheckState();
  let reads = 0;

  assert.equal(
    ensureZenithBootstrapCheckScheduled(zenithBootstrapCheckState, controlState, {
      now: 10_000,
      log: () => {}
    }),
    false
  );

  const result = await maybeRunZenithBootstrapCheck({
    zenithBootstrapCheckState,
    browserControlState: controlState,
    bootstrapState: readyBootstrapState(10_000),
    now: 10_000,
    readBootstrapPageStateFn: async () => {
      reads += 1;
      return { readyState: "complete", href: "https://tetr.io/" };
    },
    log: () => {}
  });

  assert.equal(result.ran, false);
  assert.equal(reads, 0);
});

test("game ended handling is triggered only once per ended session", () => {
  const endedState = {
    ok: true,
    ready: false,
    reason: "TETR.IO game ended"
  };
  assert.equal(isTetrioGameEndedState(endedState), true);
  assert.equal(shouldHandleEndedGame(endedState, false), true);
  assert.equal(shouldHandleEndedGame(endedState, true), false);
});

test("resetSnapshotTracking clears stable signature state", () => {
  const tracking = createSnapshotTracking();
  tracking.stableSignature = "sig";
  tracking.stableCount = 2;
  tracking.lastWrittenSignature = "written";
  tracking.lastLoggedToken = "browser-1-0";
  tracking.pendingPieceKey = "1:0";
  tracking.pendingPieceDetectedAt = 123;
  tracking.lastPerfLoggedPieceKey = "1:0";

  resetSnapshotTracking(tracking);

  assert.deepEqual(tracking, {
    stableSignature: "",
    stableCount: 0,
    lastWrittenSignature: "",
    lastLoggedToken: "",
    pendingPieceKey: "",
    pendingPieceDetectedAt: 0,
    lastPerfLoggedPieceKey: ""
  });
});

test("snapshot helper defaults browser poll to 8ms", () => {
  assert.equal(resolvePollMs({}), 8);
  assert.equal(resolvePollMs({ pollMs: "12" }), 12);
});

test("VS WebSocket simulation disables browser seed fallback only when enabled", () => {
  assert.equal(resolveUseSeedSimulationFallback(true, {}), true);
  assert.equal(
    resolveUseSeedSimulationFallback(true, { FUSION_VS_WS_SIM: "0" }),
    true
  );
  assert.equal(
    resolveUseSeedSimulationFallback(true, { FUSION_VS_WS_SIM: "1" }),
    false
  );
  assert.equal(
    resolveUseSeedSimulationFallback(false, { FUSION_VS_WS_SIM: "1" }),
    false
  );
});

test("VS sim env detection only enables suppression for env value 1", () => {
  assert.equal(isVsWsSimEnvEnabled({}), false);
  assert.equal(isVsWsSimEnvEnabled({ FUSION_VS_WS_SIM: "0" }), false);
  assert.equal(isVsWsSimEnvEnabled({ FUSION_VS_WS_SIM: "1" }), true);
});

test("zenith options are not treated as Solo activation signals", () => {
  assert.equal(
    isZenithGameplayOptions({ bagtype: "zenith", seed: 1, nextcount: 5 }),
    true
  );
  assert.equal(
    isZenithGameplayOptions({ bagtype: "7-bag", seed: 1, nextcount: 5 }),
    false
  );
});

test("closure capture probe is skipped when gameplay is not expected", () => {
  assert.equal(
    shouldAttemptClosureCapture({
      probePageState: true,
      suppressClosureCapture: false,
      stateOk: false,
      gameplayExpected: false,
      lastCaptureAt: 0,
      lastPageProbeAt: 0,
      now: 10_000
    }),
    false
  );
});

test("closure capture probe is attempted when gameplay is expected and cooldown elapsed", () => {
  assert.equal(
    shouldAttemptClosureCapture({
      probePageState: true,
      suppressClosureCapture: false,
      stateOk: false,
      gameplayExpected: true,
      lastCaptureAt: 0,
      lastPageProbeAt: 0,
      now: 10_000
    }),
    true
  );
});

test("closure capture probe is suppressed while VS round is active", () => {
  assert.equal(
    shouldAttemptClosureCapture({
      probePageState: true,
      suppressClosureCapture: true,
      stateOk: false,
      gameplayExpected: true,
      lastCaptureAt: 0,
      lastPageProbeAt: 0,
      now: 10_000
    }),
    false
  );
});

test("closure capture probe is not attempted after state is already ok", () => {
  assert.equal(
    shouldAttemptClosureCapture({
      probePageState: true,
      suppressClosureCapture: false,
      stateOk: true,
      gameplayExpected: true,
      lastCaptureAt: 0,
      lastPageProbeAt: 0,
      now: 10_000
    }),
    false
  );
});

test("closure capture probe is not attempted before cooldown elapses", () => {
  assert.equal(
    shouldAttemptClosureCapture({
      probePageState: true,
      suppressClosureCapture: false,
      stateOk: false,
      gameplayExpected: true,
      lastCaptureAt: 9_500,
      lastPageProbeAt: 9_500,
      now: 10_000
    }),
    false
  );
});

test("game start signal arms a bounded closure capture window", () => {
  const closureCaptureState = createClosureCaptureState();
  armClosureCaptureWindow(closureCaptureState, {
    reason: "ribbon_seed",
    now: 1_000,
    windowMs: 8_000,
    log: () => {}
  });

  assert.equal(isClosureCaptureArmed(closureCaptureState, 1_001), true);
  assert.equal(
    isGameplayExpectedForClosureCapture({
      state: { ok: false, playing: false, countdown: false },
      closureCaptureState,
      now: 1_001
    }),
    true
  );
  assert.equal(isClosureCaptureArmed(closureCaptureState, 9_100), false);
});

test("closure capture window disarms immediately on lobby or game end transition", () => {
  const closureCaptureState = armedClosureCaptureState(1_000);
  disarmClosureCaptureWindow(closureCaptureState, {
    reason: "game_ended",
    log: () => {}
  });

  assert.equal(isClosureCaptureArmed(closureCaptureState, 1_001), false);
  assert.equal(
    shouldAttemptClosureCapture({
      probePageState: true,
      suppressClosureCapture: false,
      stateOk: false,
      gameplayExpected: isGameplayExpectedForClosureCapture({
        state: { ok: false, playing: false, countdown: false },
        closureCaptureState,
        now: 1_001
      }),
      lastCaptureAt: 0,
      lastPageProbeAt: 0,
      now: 10_000
    }),
    false
  );
});

test("closure capture skipped logging is throttled while gameplay is not expected", () => {
  assert.equal(
    shouldLogClosureCaptureSkipped({
      gameplayExpected: false,
      lastSkippedLogAt: 0,
      now: 10_000
    }),
    false
  );
  assert.equal(
    shouldLogClosureCaptureSkipped({
      gameplayExpected: false,
      lastSkippedLogAt: 0,
      now: 70_000
    }),
    true
  );
});

test("Bot Off -> On control message opens a bounded arming window", () => {
  const controlState = createBrowserControlState();
  const closureCaptureState = createClosureCaptureState();

  assert.equal(
    applyBrowserControlMessage({
      message: { type: "bot_enabled", enabled: true },
      controlState,
      closureCaptureState,
      now: 2_000,
      log: () => {}
    }),
    true
  );
  assert.equal(controlState.botEnabled, true);
  assert.equal(isClosureCaptureArmed(closureCaptureState, 2_001), true);
});

test("bootstrap not ready stores a pending bot_on arm instead of consuming the live window", () => {
  const controlState = createBrowserControlState();
  const closureCaptureState = createClosureCaptureState();
  const logs = [];

  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: true },
    controlState,
    closureCaptureState,
    bootstrapReady: false,
    now: 2_000,
    log: (line) => logs.push(line)
  });

  assert.equal(controlState.botEnabled, true);
  assert.equal(hasPendingClosureCaptureArm(closureCaptureState), true);
  assert.equal(isClosureCaptureArmed(closureCaptureState, 2_001), false);
  assert.equal(closureCaptureState.pendingCaptureArm?.reason, "bot_on");
  assert.ok(
    logs.includes("[browser] closure capture pending reason=bot_on bootstrap_not_ready")
  );
});

test("repeated Bot On control messages do not extend the arming window", () => {
  const controlState = createBrowserControlState();
  const closureCaptureState = createClosureCaptureState();

  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: true },
    controlState,
    closureCaptureState,
    now: 2_000,
    log: () => {}
  });
  const firstArmedUntil = closureCaptureState.armedUntil;

  assert.equal(
    applyBrowserControlMessage({
      message: { type: "bot_enabled", enabled: true },
      controlState,
      closureCaptureState,
      now: 6_000,
      log: () => {}
    }),
    false
  );
  assert.equal(closureCaptureState.armedUntil, firstArmedUntil);
});

test("arming window expires without reopening until a fresh signal arrives", () => {
  const closureCaptureState = armedClosureCaptureState(2_000);
  expireClosureCaptureWindow(closureCaptureState, 10_001);

  assert.equal(isClosureCaptureArmed(closureCaptureState, 10_001), false);
  assert.equal(closureCaptureState.armedUntil, 0);
});

test("Bot Off control message disarms the arming window immediately", () => {
  const controlState = createBrowserControlState();
  const closureCaptureState = createClosureCaptureState();

  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: true },
    controlState,
    closureCaptureState,
    now: 2_000,
    log: () => {}
  });
  assert.equal(
    applyBrowserControlMessage({
      message: { type: "bot_enabled", enabled: false },
      controlState,
      closureCaptureState,
      now: 3_000,
      log: () => {}
    }),
    true
  );
  assert.equal(controlState.botEnabled, false);
  assert.equal(isClosureCaptureArmed(closureCaptureState, 3_001), false);
});

test("Bot Off clears a pending bootstrap arm immediately", () => {
  const controlState = createBrowserControlState();
  const closureCaptureState = createClosureCaptureState();

  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: true },
    controlState,
    closureCaptureState,
    bootstrapReady: false,
    now: 2_000,
    log: () => {}
  });
  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: false },
    controlState,
    closureCaptureState,
    now: 2_500,
    log: () => {}
  });

  assert.equal(hasPendingClosureCaptureArm(closureCaptureState), false);
  assert.equal(controlState.botEnabled, false);
});

test("bootstrap ready activates a pending arm without charging the waiting time to the 8s window", () => {
  const closureCaptureState = createClosureCaptureState();
  requestClosureCaptureArm(closureCaptureState, {
    reason: "bot_on",
    bootstrapReady: false,
    now: 2_000,
    log: () => {}
  });

  activatePendingClosureCaptureArm(closureCaptureState, {
    now: 12_000,
    log: () => {}
  });

  assert.equal(hasPendingClosureCaptureArm(closureCaptureState), false);
  assert.equal(isClosureCaptureArmed(closureCaptureState, 12_001), true);
  assert.equal(closureCaptureState.armedReason, "bot_on_after_bootstrap");
  assert.equal(closureCaptureState.armedUntil, 20_000);
  assert.equal(closureCaptureState.nextAttemptAt, 12_000);
});

test("bootstrap ready can restart an existing arm once without repeated extension", () => {
  const closureCaptureState = armedClosureCaptureState(2_000, {
    reason: "game_start_transition"
  });

  reactivateClosureCaptureArmAfterBootstrap(closureCaptureState, {
    now: 5_000,
    log: () => {}
  });
  const firstArmedUntil = closureCaptureState.armedUntil;
  const firstReason = closureCaptureState.armedReason;

  assert.equal(firstReason, "game_start_transition_after_bootstrap");
  assert.equal(firstArmedUntil, 13_000);

  reactivateClosureCaptureArmAfterBootstrap(closureCaptureState, {
    now: 5_000,
    log: () => {}
  });

  assert.equal(closureCaptureState.armedReason, "game_start_transition_after_bootstrap");
  assert.equal(closureCaptureState.armedUntil, 13_000);
});

test("bootstrap readiness uses document and transport signals without game object state", () => {
  const bootstrapState = createBootstrapState(0);
  updateBootstrapDocumentState(
    bootstrapState,
    { readyState: "interactive", href: "https://tetr.io/" },
    100
  );
  bootstrapState.transportReadyAt = 1_000;

  const waiting = getBootstrapReadinessStatus(bootstrapState, 2_000);
  const ready = getBootstrapReadinessStatus(bootstrapState, 2_600);

  assert.equal(waiting.ready, false);
  assert.match(waiting.reason, /transport_settling_/);
  assert.equal(ready.ready, true);
  assert.equal(isBootstrapReadyForClosureCapture(bootstrapState, 2_600), true);
});

test("clearing a pending arm is idempotent", () => {
  const closureCaptureState = createClosureCaptureState();
  assert.equal(clearPendingClosureCaptureArm(closureCaptureState), false);
  requestClosureCaptureArm(closureCaptureState, {
    reason: "bot_on",
    bootstrapReady: false,
    now: 1_000,
    log: () => {}
  });
  assert.equal(clearPendingClosureCaptureArm(closureCaptureState), true);
  assert.equal(hasPendingClosureCaptureArm(closureCaptureState), false);
});

test("game-start signal arm allows an immediate first capture attempt without waiting for cooldown", async () => {
  let captureCalls = 0;
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  requestClosureCaptureArm(closureCaptureState, {
    reason: "game_start_signal",
    bootstrapReady: true,
    now: 50_000,
    log: (line) => logs.push(line)
  });
  const cdp = createReadStateCdp([
    {
      ok: false,
      ready: false,
      playing: true,
      countdown: false,
      reason: "TETR.IO game instance not captured yet"
    }
  ]);

  await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 50_000, seed: null },
    probeState: { lastCaptureAt: 50_000, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(50_000),
    browserControlState,
    closureCaptureState,
    now: 50_000,
    log: (line) => logs.push(line),
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: false, reason: "still hidden" };
    }
  });

  assert.equal(captureCalls, 1);
  assert.equal(closureCaptureState.retryCount, 1);
  assert.equal(closureCaptureState.nextAttemptAt, 50_750);
  assert.equal(deriveGameplayPhase({ playing: true, countdown: false }), "playing");
  assert.ok(
    logs.includes("[browser] closure capture armed reason=game_start_signal")
  );
});

test("pending bot_on arm performs zero heavy capture attempts while bootstrap remains blocked", async () => {
  let captureCalls = 0;
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const browserControlState = createBrowserControlState();
  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: true },
    controlState: browserControlState,
    closureCaptureState,
    bootstrapReady: false,
    now: 1_000,
    log: (line) => logs.push(line)
  });
  const cdp = {
    async send(method, params = {}) {
      assert.equal(method, "Runtime.evaluate");
      if (String(params.expression).includes("document.readyState")) {
        return {
          result: {
            value: {
              readyState: "loading",
              href: "https://tetr.io/"
            }
          }
        };
      }
      return {
        result: {
          value: {
            ok: false,
            ready: false,
            reason: "TETR.IO game instance not captured yet"
          }
        }
      };
    }
  };

  await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: createBootstrapState(0),
    browserControlState,
    closureCaptureState,
    now: 2_000,
    log: (line) => logs.push(line),
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: false, reason: "should not run" };
    }
  });

  assert.equal(captureCalls, 0);
  assert.equal(hasPendingClosureCaptureArm(closureCaptureState), true);
  assert.ok(logs.includes("[browser] closure capture blocked reason=bootstrap_not_ready"));
});

test("pending bot_on arm activates on bootstrap ready transition and captures immediately", async () => {
  let captureCalls = 0;
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const browserControlState = createBrowserControlState();
  const bootstrapState = createBootstrapState(0);
  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: true },
    controlState: browserControlState,
    closureCaptureState,
    bootstrapReady: false,
    now: 1_000,
    log: (line) => logs.push(line)
  });

  const cdp = createReadStateCdp([
    {
      ok: false,
      ready: false,
      playing: true,
      countdown: false,
      reason: "TETR.IO game instance not captured yet"
    }
  ]);
  updateBootstrapDocumentState(
    bootstrapState,
    { readyState: "interactive", href: "https://tetr.io/" },
    100
  );
  bootstrapState.transportReadyAt = 500;

  await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 60_000, seed: null },
    probeState: { lastCaptureAt: 60_000, lastGameplayPhase: "inactive" },
    bootstrapState,
    browserControlState,
    closureCaptureState,
    now: 2_100,
    log: (line) => logs.push(line),
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: false, reason: "still hidden" };
    }
  });

  assert.equal(captureCalls, 1);
  assert.equal(closureCaptureState.armedReason, "bot_on_after_bootstrap");
  assert.equal(closureCaptureState.nextAttemptAt, 2_850);
  assert.ok(logs.includes("[browser] bootstrap ready; activating pending arm reason=bot_on"));
  assert.ok(logs.includes("[browser] closure capture first attempt reason=bot_on_after_bootstrap"));
});

test("bootstrap ready transition only reactivates once and does not extend the window on later polls", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const browserControlState = createBrowserControlState();
  const bootstrapState = createBootstrapState(0);
  browserControlState.botEnabled = true;
  requestClosureCaptureArm(closureCaptureState, {
    reason: "bot_on",
    bootstrapReady: false,
    now: 1_000,
    log: () => {}
  });
  updateBootstrapDocumentState(
    bootstrapState,
    { readyState: "interactive", href: "https://tetr.io/" },
    100
  );
  bootstrapState.transportReadyAt = 500;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, playing: true, countdown: false, reason: "hidden" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState,
    browserControlState,
    closureCaptureState,
    now: 2_100,
    log: (line) => logs.push(line),
    captureGameFn: async () => ({ ok: false, reason: "still hidden" })
  });
  const firstArmedUntil = closureCaptureState.armedUntil;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, playing: true, countdown: false, reason: "hidden" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "playing" },
    bootstrapState,
    browserControlState,
    closureCaptureState,
    now: 2_200,
    log: (line) => logs.push(line),
    captureGameFn: async () => ({ ok: false, reason: "still hidden" })
  });

  assert.equal(closureCaptureState.armedUntil, firstArmedUntil);
  assert.equal(
    logs.filter((line) => line === "[browser] bootstrap ready; activating pending arm reason=bot_on").length,
    1
  );
});

test("independent game-start signal state tracks unconsumed signals without game object state", () => {
  const signalState = createGameStartSignalState();

  assert.equal(
    noteGameStartSignal(signalState, {
      key: "ddd:seed-a",
      source: "ddd_game_options",
      now: 60_000,
      details: { seed: "a" }
    }),
    true
  );
  assert.equal(hasUnconsumedGameStartSignal(signalState), true);
  assert.equal(signalState.latestSource, "ddd_game_options");
  assert.deepEqual(signalState.latestDetails, { seed: "a" });
  assert.deepEqual(consumeGameStartSignal(signalState), {
    key: "0:ddd_game_options:ddd:seed-a",
    source: "ddd_game_options",
    seenAt: 60_000,
    details: { seed: "a" }
  });
  assert.equal(hasUnconsumedGameStartSignal(signalState), false);
});

test("repeated game-start signal keys do not create duplicate transitions", () => {
  const signalState = createGameStartSignalState();
  noteGameStartSignal(signalState, {
    key: "ddd:seed-a",
    source: "ddd_game_options",
    now: 60_000
  });

  assert.equal(
    noteGameStartSignal(signalState, {
      key: "ddd:seed-a",
      source: "ddd_game_options",
      now: 61_000
    }),
    false
  );
  assert.equal(hasUnconsumedGameStartSignal(signalState), true);
});

test("next generation accepts the same game-start signal key again", () => {
  const signalState = createGameStartSignalState();
  noteGameStartSignal(signalState, {
    key: "ddd:seed-a",
    source: "ddd_game_options",
    now: 60_000
  });

  advanceGameStartSignalGeneration(signalState, { preserveSince: 70_000 });

  assert.equal(
    noteGameStartSignal(signalState, {
      key: "ddd:seed-a",
      source: "ddd_game_options",
      now: 71_000
    }),
    true
  );
  assert.deepEqual(consumeGameStartSignal(signalState), {
    key: "1:ddd_game_options:ddd:seed-a",
    source: "ddd_game_options",
    seenAt: 71_000,
    details: null
  });
});

test("game-start signal cutoff preserves recent next-game signals while ignoring stale prior-game ones", () => {
  const signalState = createGameStartSignalState();
  noteGameStartSignal(signalState, {
    key: "ddd:game-1",
    source: "ddd_game_options",
    now: 1_000
  });
  noteGameStartSignal(signalState, {
    key: "ribbon:game-2",
    source: "ribbon_seed",
    now: 59_500,
    details: { seed: "next-seed" }
  });

  assert.equal(hasUnconsumedGameStartSignal(signalState, { since: 50_000 }), true);
  assert.deepEqual(
    consumeGameStartSignal(signalState, { since: 50_000 }),
    {
      key: "0:ribbon_seed:ribbon:game-2",
      source: "ribbon_seed",
      seenAt: 59_500,
      details: { seed: "next-seed" }
    }
  );
  assert.equal(hasUnconsumedGameStartSignal(signalState, { since: 50_000 }), false);
});

test("game-start signal can rehydrate network fallback state after ended cleanup", () => {
  const network = {
    seed: null,
    nextCount: 6,
    readyAt: 0,
    ribbonSeen: false,
    lastPageProbeAt: 0
  };

  assert.equal(
    applyGameStartSignalToNetwork(network, {
      key: "ribbon:game-2",
      source: "ribbon_seed",
      seenAt: 60_000,
      details: {
        seed: "456",
        nextCount: 8,
        readyAt: 64_500
      }
    }),
    true
  );
  assert.deepEqual(network, {
    seed: "456",
    nextCount: 8,
    readyAt: 64_500,
    ribbonSeen: false,
    lastPageProbeAt: 0
  });
});

test("game-start signal state can be reset on navigation or browser restart", () => {
  const signalState = createGameStartSignalState();
  noteGameStartSignal(signalState, {
    key: "ddd:seed-a",
    source: "ddd_game_options",
    now: 60_000
  });

  assert.equal(resetGameStartSignalState(signalState), true);
  assert.equal(hasUnconsumedGameStartSignal(signalState), false);
  assert.equal(signalState.latestKey, "");
});

test("network state reset clears stale ribbon timing and seed state", () => {
  const network = {
    seed: "123",
    nextCount: 8,
    readyAt: 999,
    ribbonSeen: true,
    lastPageProbeAt: 555
  };

  assert.equal(resetTetrioNetworkState(network), true);
  assert.deepEqual(network, {
    seed: null,
    nextCount: 6,
    readyAt: 0,
    ribbonSeen: false,
    lastPageProbeAt: 0
  });
});

test("locator hint reset clears the cached fast-path name", () => {
  const closureCaptureState = createClosureCaptureState();
  closureCaptureState.lastSuccessfulLocator = "Ai";
  closureCaptureState.lastSuccessfulPausedLocation = {
    frameIndex: 1,
    scopeIndex: 4,
    candidateIndex: 77,
    locator: "Ai",
    propertyKey: "Ai"
  };

  assert.equal(resetClosureCaptureLocatorHint(closureCaptureState), true);
  assert.equal(closureCaptureState.lastSuccessfulLocator, "");
  assert.equal(closureCaptureState.lastSuccessfulPausedLocation, null);
});

test("next-game reacquire starts after game end and completes on next epoch", () => {
  const logs = [];
  const nextGameReacquireState = createNextGameReacquireState();

  assert.equal(
    startNextGameReacquire(nextGameReacquireState, {
      now: 10_000,
      epoch: 1,
      locator: "closure:Ai",
      log: (line) => logs.push(line)
    }),
    true
  );
  assert.equal(nextGameReacquireState.active, true);
  assert.equal(nextGameReacquireState.startedAt, 10_000);
  assert.equal(
    completeNextGameReacquire(nextGameReacquireState, {
      epoch: 2,
      log: (line) => logs.push(line)
    }),
    true
  );
  assert.equal(nextGameReacquireState.active, false);
  assert.ok(logs.includes("[browser] next-game reacquire started epoch=1 locator=closure:Ai"));
  assert.ok(logs.includes("[browser] next-game reacquire completed epoch=2"));
});

test("ended game candidate handle is not released until an explicit lifecycle event", async () => {
  const candidate = createEndedGameCandidateState();
  candidate.objectId = "ended-object-1";
  candidate.locator = "Ai";
  candidate.epoch = 1;
  const methods = [];

  assert.equal(candidate.objectId, "ended-object-1");

  await releaseEndedGameCandidateHandle({
    async send(method, params) {
      methods.push({ method, params });
      return {};
    }
  }, candidate, {
    reason: "bot_off",
    log: () => {}
  });

  assert.equal(candidate.objectId, "");
  assert.deepEqual(
    methods.map((entry) => entry.method),
    ["Runtime.releaseObject", "Runtime.releaseObjectGroup"]
  );
});

test("resetPausedScopeScanProgress clears continuation cursor and budget", () => {
  const closureCaptureState = createClosureCaptureState();
  closureCaptureState.cumulativePausedScanBudgetUsedMs = 320;
  closureCaptureState.pausedScopeScanCursor = {
    frameIndex: 1,
    scopeIndex: 2,
    propertyIndex: 3,
    completedScopeKeys: ["0:0:scope-1"],
    seenCandidateKeys: ["0:0:scope-1:Ai:candidate-1"]
  };
  closureCaptureState.scanBudgetExhausted = true;

  assert.equal(resetPausedScopeScanProgress(closureCaptureState), true);
  assert.equal(closureCaptureState.cumulativePausedScanBudgetUsedMs, 0);
  assert.equal(closureCaptureState.pausedScopeScanCursor, null);
  assert.equal(closureCaptureState.scanBudgetExhausted, false);
});

test("new arm resets stale paused scan budget attempt cursor and fast-path state", () => {
  const closureCaptureState = createClosureCaptureState();
  closureCaptureState.fullScanAttemptsInWindow = 2;
  closureCaptureState.cumulativePausedScanBudgetUsedMs = 700;
  closureCaptureState.pausedScopeScanCursor = {
    frameIndex: 4,
    scopeIndex: 3,
    propertyIndex: 9,
    completedScopeKeys: ["1:1:scope-1"],
    seenCandidateKeys: ["1:1:scope-1:Ai:candidate-1"]
  };
  closureCaptureState.scanBudgetExhausted = true;
  closureCaptureState.fastLocatorAttempted = true;
  closureCaptureState.nextAttemptAt = 999_999;

  armClosureCaptureWindow(closureCaptureState, {
    reason: "bot_on",
    now: 20_000,
    log: () => {}
  });

  assert.equal(closureCaptureState.fullScanAttemptsInWindow, 0);
  assert.equal(closureCaptureState.cumulativePausedScanBudgetUsedMs, 0);
  assert.equal(closureCaptureState.scanBudgetExhausted, false);
  assert.equal(closureCaptureState.fastLocatorAttempted, false);
  assert.equal(closureCaptureState.nextAttemptAt, 20_000);
  assert.deepEqual(closureCaptureState.pausedScopeScanCursor, {
    frameIndex: 0,
    scopeIndex: 0,
    propertyIndex: 0,
    completedScopeKeys: [],
    seenCandidateKeys: []
  });
});

test("fresh arm prevents first full scan from exhausting before attempt logging", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  closureCaptureState.fullScanAttemptsInWindow = 2;
  closureCaptureState.cumulativePausedScanBudgetUsedMs = 700;
  closureCaptureState.pausedScopeScanCursor = {
    frameIndex: 9,
    scopeIndex: 9,
    propertyIndex: 9,
    completedScopeKeys: ["9:9:scope-stale"],
    seenCandidateKeys: ["9:9:scope-stale:Ai:candidate-stale"]
  };
  closureCaptureState.scanBudgetExhausted = true;

  armClosureCaptureWindow(closureCaptureState, {
    reason: "bot_on",
    now: 30_000,
    log: () => {}
  });

  const result = await exposeTetrioGameFromPausedCallFrames({
    async send(method) {
      if (method === "Runtime.getProperties") {
        return {
          result: [{ name: "Ai", value: { objectId: "candidate-1" } }]
        };
      }
      if (method === "Runtime.callFunctionOn") {
        return {
          result: {
            value: { ok: false }
          }
        };
      }
      throw new Error(`unexpected method ${method}`);
    }
  }, {
    callFrames: [{
      callFrameId: "frame-1",
      scopeChain: [{ object: { objectId: "scope-1" } }]
    }]
  }, {
    closureCaptureState,
    log: (line) => logs.push(line)
  });

  assert.equal(result.reason, "TETR.IO active game variable was not in paused scopes");
  assert.ok(
    logs.some((line) => line.startsWith("[browser] full closure scan attempt=1/2"))
  );
  assert.equal(
    logs.some((line) => line.includes("cumulative budget exhausted")),
    false
  );
});

test("retry scheduling does not consume paused scan budget", () => {
  const closureCaptureState = createClosureCaptureState();
  closureCaptureState.cumulativePausedScanBudgetUsedMs = 280;

  assert.equal(scheduleClosureCaptureContinuation(closureCaptureState, 10_000, 100), 100);
  assert.equal(closureCaptureState.nextAttemptAt, 10_100);
  assert.equal(closureCaptureState.cumulativePausedScanBudgetUsedMs, 280);

  assert.equal(scheduleNextClosureCaptureAttempt(closureCaptureState, 11_000, [750]), 750);
  assert.equal(closureCaptureState.nextAttemptAt, 11_750);
  assert.equal(closureCaptureState.cumulativePausedScanBudgetUsedMs, 280);
});

test("fast closure locator hint succeeds before the paused scope scan", async () => {
  const logs = [];
  const methods = [];
  const cdp = {
    async send(method, params = {}) {
      methods.push({ method, params });
      if (method === "Debugger.evaluateOnCallFrame") {
        return {
          result: {
            value: {
              ok: true,
              source: "closure:Ai",
              locator: "Ai"
            }
          }
        };
      }
      throw new Error(`unexpected method ${method}`);
    }
  };

  const result = await exposeTetrioGameFromPausedCallFrames(cdp, {
    callFrames: [{ callFrameId: "frame-1", scopeChain: [] }]
  }, {
    closureCaptureState: { lastSuccessfulLocator: "Ai" },
    log: (line) => logs.push(line)
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    methods.map((entry) => entry.method),
    ["Debugger.evaluateOnCallFrame"]
  );
  assert.ok(logs.includes("[browser] fast closure locator succeeded locator=Ai"));
});

test("locator hint failure falls back to the paused scope scan", async () => {
  const logs = [];
  const methods = [];
  const cdp = {
    async send(method, params = {}) {
      methods.push({ method, params });
      if (method === "Debugger.evaluateOnCallFrame") {
        return {
          result: {
            value: { ok: false }
          }
        };
      }
      if (method === "Runtime.getProperties") {
        assert.equal(params.objectId, "scope-1");
        return {
          result: [
            {
              name: "Ai",
              value: { objectId: "candidate-1" }
            }
          ]
        };
      }
      if (method === "Runtime.callFunctionOn") {
        assert.equal(params.objectId, "candidate-1");
        if (String(params.functionDeclaration).includes("rootObjectKeys")) {
          return {
            result: {
              value: {
                rootObjectKeys: ["ejectState", "ejectBoardState"],
                ejectKeys: ["game"],
                stateKeys: ["board"],
                boardStateKeys: ["b"]
              }
            }
          };
        }
        return {
          result: {
            value: {
              ok: true,
              source: "closure:Ai",
              locator: "Ai"
            }
          }
        };
      }
      throw new Error(`unexpected method ${method}`);
    }
  };

  const result = await exposeTetrioGameFromPausedCallFrames(cdp, {
    callFrames: [{
      callFrameId: "frame-1",
      scopeChain: [{ object: { objectId: "scope-1" } }]
    }]
  }, {
    closureCaptureState: { lastSuccessfulLocator: "Ai" },
    log: (line) => logs.push(line)
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    methods.map((entry) => entry.method).slice(0, 3),
    [
      "Debugger.evaluateOnCallFrame",
      "Runtime.getProperties",
      "Runtime.callFunctionOn"
    ]
  );
  assert.ok(
    logs.includes(
      "[browser] fast closure locator miss; retaining locator cache and falling back to scan"
    )
  );
});

test("actual Solo game-start signals remain unchanged", () => {
  const signalState = createGameStartSignalState();
  assert.equal(
    noteGameStartSignal(signalState, {
      key: "ddd:solo-seed",
      source: "ddd_game_options",
      now: 10_000,
      details: { bagtype: "7-bag" }
    }),
    true
  );
  assert.deepEqual(consumeGameStartSignal(signalState), {
    key: "0:ddd_game_options:ddd:solo-seed",
    source: "ddd_game_options",
    seenAt: 10_000,
    details: { bagtype: "7-bag" }
  });
});

test("cached locator is invalidated only after an actual property lookup failure", async () => {
  const closureCaptureState = createClosureCaptureState();
  closureCaptureState.lastSuccessfulLocator = "Ai";
  const cdp = {
    async send(method) {
      if (method === "Debugger.evaluateOnCallFrame") {
        return {
          result: {
            value: { ok: false, reason: "cached_locator_property_lookup_failed" }
          }
        };
      }
      throw new Error(`unexpected method ${method}`);
    }
  };

  const result = await exposeTetrioGameFromPausedCallFrames(cdp, {
    callFrames: [{ callFrameId: "frame-1", scopeChain: [] }]
  }, {
    closureCaptureState,
    allowBroadScan: false,
    log: () => {}
  });

  assert.equal(result.outcome, "targeted_only_miss");
  assert.equal(closureCaptureState.lastSuccessfulLocator, "");
});

test("targeted paused-location hint hits before the broad full scan", async () => {
  const logs = [];
  const methods = [];
  const cdp = {
    async send(method, params = {}) {
      methods.push({ method, params });
      if (method === "Runtime.getProperties") {
        return {
          result: [
            {
              name: "Ai",
              value: { objectId: "candidate-77" }
            }
          ]
        };
      }
      if (method === "Runtime.callFunctionOn") {
        assert.equal(params.objectId, "candidate-77");
        if (String(params.functionDeclaration).includes("rootObjectKeys")) {
          return {
            result: {
              value: {
                rootObjectKeys: ["ejectState", "ejectBoardState"],
                ejectKeys: ["game"],
                stateKeys: ["board"],
                boardStateKeys: ["b"]
              }
            }
          };
        }
        return {
          result: {
            value: {
              ok: true,
              source: "closure:Ai",
              locator: "Ai"
            }
          }
        };
      }
      throw new Error(`unexpected method ${method}`);
    }
  };

  const result = await exposeTetrioGameFromPausedCallFrames(cdp, {
    callFrames: [null, {
      callFrameId: "frame-1",
      scopeChain: [null, null, null, null, { object: { objectId: "scope-4" } }]
    }]
  }, {
    closureCaptureState: {
      lastSuccessfulLocator: "",
      lastSuccessfulPausedLocation: {
        frameIndex: 1,
        scopeIndex: 4,
        candidateIndex: 0,
        locator: "Ai",
        propertyKey: "Ai"
      },
      fullScanAttemptsInWindow: 0
    },
    log: (line) => logs.push(line)
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    methods.map((entry) => entry.method).slice(0, 2),
    ["Runtime.getProperties", "Runtime.callFunctionOn"]
  );
  assert.ok(
    logs.includes("[browser] targeted paused locator hit frame=1 scope=4 candidate=0")
  );
  assert.equal(
    logs.some((line) => line.startsWith("[browser] full closure scan attempt=")),
    false
  );
});

test("targeted paused-location hint miss falls back to the broad full scan", async () => {
  const logs = [];
  let callFunctionOnCount = 0;
  const cdp = {
    async send(method, params = {}) {
      if (method === "Runtime.getProperties") {
        return {
          result: [
            {
              name: "Ai",
              value: { objectId: callFunctionOnCount === 0 ? "candidate-ended" : "candidate-fresh" }
            }
          ]
        };
      }
      if (method === "Runtime.callFunctionOn") {
        if (String(params.functionDeclaration).includes("rootObjectKeys")) {
          return {
            result: {
              value: {
                rootObjectKeys: ["ejectState", "ejectBoardState"],
                ejectKeys: ["game"],
                stateKeys: ["board"],
                boardStateKeys: ["b"]
              }
            }
          };
        }
        callFunctionOnCount += 1;
        return {
          result: {
            value:
              callFunctionOnCount === 1
                ? { ok: false }
                : { ok: true, source: "closure:Ai", locator: "Ai" }
          }
        };
      }
      throw new Error(`unexpected method ${method}`);
    }
  };

  const closureCaptureState = createClosureCaptureState();
  closureCaptureState.lastSuccessfulPausedLocation = {
    frameIndex: 0,
    scopeIndex: 0,
    candidateIndex: 0,
    locator: "Ai",
    propertyKey: "Ai"
  };

  const result = await exposeTetrioGameFromPausedCallFrames(cdp, {
    callFrames: [{
      callFrameId: "frame-0",
      scopeChain: [{ object: { objectId: "scope-0" } }]
    }]
  }, {
    closureCaptureState,
    log: (line) => logs.push(line)
  });

  assert.equal(result.ok, true);
  assert.equal(callFunctionOnCount, 2);
  assert.ok(
    logs.includes("[browser] targeted paused locator miss frame=0 scope=0 candidate=0")
  );
  assert.ok(logs.includes("[browser] full closure scan attempt=1/2"));
});

test("first full scan prioritizes the main/default TETR.IO context", async () => {
  const visitedScopes = [];
  const closureCaptureState = createClosureCaptureState();
  const cdp = {
    async send(method, params = {}) {
      if (method === "Runtime.getProperties") {
        visitedScopes.push(params.objectId);
        return {
          result: params.objectId === "scope-main"
            ? [{ name: "Ai", value: { objectId: "candidate-main" } }]
            : [{ name: "noise", value: { objectId: "candidate-child" } }]
        };
      }
      if (method === "Runtime.callFunctionOn") {
        return {
          result: {
            value: params.objectId === "candidate-main"
              ? { ok: true, source: "closure:Ai", locator: "Ai" }
              : { ok: false }
          }
        };
      }
      throw new Error(`unexpected method ${method}`);
    }
  };

  const result = await exposeTetrioGameFromPausedCallFrames(cdp, {
    callFrames: [
      {
        callFrameId: "child-frame",
        frameId: "child",
        url: "https://example.test/child.js",
        scopeChain: [{ object: { objectId: "scope-child" } }]
      },
      {
        callFrameId: "main-frame",
        frameId: "main",
        url: "https://tetr.io/res/game.js",
        auxData: { isDefault: true },
        scopeChain: [{ object: { objectId: "scope-main" } }]
      }
    ]
  }, {
    closureCaptureState,
    targetUrl: "https://tetr.io/",
    mainFrameId: "main",
    log: () => {}
  });

  assert.equal(result.ok, true);
  assert.equal(result.progress.frameIndex, 1);
  assert.deepEqual(visitedScopes, ["scope-main"]);
});

test("cold start does not postpone a likely gameplay frame until scan attempt two", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const cdp = {
    async send(method, params = {}) {
      if (method === "Runtime.getProperties") {
        return {
          result: params.objectId === "scope-gameplay"
            ? [{ name: "Ai", value: { objectId: "candidate-gameplay" } }]
            : Array.from({ length: 80 }, (_, index) => ({
                name: `noise${index}`,
                value: { objectId: `candidate-noise-${index}` }
              }))
        };
      }
      if (method === "Runtime.callFunctionOn") {
        return {
          result: {
            value: params.objectId === "candidate-gameplay"
              ? { ok: true, source: "closure:Ai", locator: "Ai" }
              : { ok: false }
          }
        };
      }
      throw new Error(`unexpected method ${method}`);
    }
  };

  const result = await exposeTetrioGameFromPausedCallFrames(cdp, {
    callFrames: [
      {
        callFrameId: "timer-frame",
        functionName: "setTimeout",
        url: "https://example.test/timer.js",
        scopeChain: [{ object: { objectId: "scope-timer" } }]
      },
      {
        callFrameId: "game-frame",
        functionName: "gameLoop",
        url: "https://tetr.io/res/game.js",
        scopeChain: Array.from({ length: 5 }, (_, index) => ({
          type: index === 4 ? "script" : "closure",
          object: { objectId: index === 4 ? "scope-gameplay" : `scope-${index}` }
        }))
      }
    ]
  }, {
    closureCaptureState,
    targetUrl: "https://tetr.io/",
    log: (line) => logs.push(line)
  });

  assert.equal(result.ok, true);
  assert.equal(result.progress.frameIndex, 1);
  assert.equal(closureCaptureState.fullScanAttemptsInWindow, 1);
  assert.equal(logs.some((line) => line.includes("attempt=2/2")), false);
});

test("trace disabled performs no candidate trace serialization", async () => {
  const logs = [];
  const cdp = {
    async send(method) {
      if (method === "Runtime.getProperties") {
        return { result: [{ name: "Ai", value: { objectId: "candidate-1" } }] };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: { ok: false } } };
      }
      throw new Error(`unexpected method ${method}`);
    }
  };

  await exposeTetrioGameFromPausedCallFrames(cdp, {
    callFrames: [{
      callFrameId: "frame-1",
      scopeChain: [{ object: { objectId: "scope-1" } }]
    }]
  }, {
    closureCaptureState: createClosureCaptureState(),
    candidateTraceEnabled: false,
    log: (line) => logs.push(line)
  });

  assert.equal(logs.some((line) => line.includes("closure candidate trace")), false);
});

test("successful locator survives Bot Off and is reused on the next Bot On", () => {
  const closureCaptureState = createClosureCaptureState();
  const controlState = createBrowserControlState();
  closureCaptureState.lastSuccessfulLocator = "Ai";
  controlState.botEnabled = true;

  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: false },
    controlState,
    closureCaptureState,
    now: 10_000,
    log: () => {}
  });
  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: true },
    controlState,
    closureCaptureState,
    now: 10_100,
    log: () => {}
  });

  assert.equal(closureCaptureState.lastSuccessfulLocator, "Ai");
});

test("closure exhaustion cannot schedule a third full scan", async () => {
  let captureCalls = 0;
  const closureCaptureState = createClosureCaptureState();
  const controlState = createBrowserControlState();
  controlState.botEnabled = true;
  armClosureCaptureWindow(closureCaptureState, {
    reason: "bot_on",
    now: 30_000,
    log: () => {}
  });
  const captureGameFn = async (_cdp, { closureCaptureState: state }) => {
    captureCalls += 1;
    state.fullScanAttemptsInWindow = captureCalls;
    return {
      ok: false,
      reason: "TETR.IO active game variable was not in paused scopes",
      outcome: "completed_not_found",
      windowBudgetExhausted: false
    };
  };
  const options = {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(30_000),
    browserControlState: controlState,
    closureCaptureState,
    now: 30_000,
    log: () => {},
    captureGameFn
  };

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, playing: true, countdown: false, reason: "not captured" }
  ]), options);
  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, playing: true, countdown: false, reason: "not captured" }
  ]), { ...options, now: 30_150 });
  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, playing: true, countdown: false, reason: "not captured" }
  ]), { ...options, now: 30_300 });

  assert.equal(captureCalls, 2);
  assert.equal(closureCaptureState.fullScanAttemptsInWindow, 0);
  assert.equal(isClosureCaptureArmed(closureCaptureState, 30_301), false);
});

test("first solo full scan resumes from the saved cursor without rechecking candidates", async () => {
  const logs = [];
  const visitedCandidates = [];
  const closureCaptureState = createClosureCaptureState();
  let fakeNow = 1_000;
  const descriptors = [1, 2, 3].map((index) => ({
    name: `Ai${index}`,
    value: { objectId: `candidate-${index}` }
  }));
  const cdp = {
    async send(method, params = {}) {
      if (method === "Runtime.getProperties") {
        return { result: descriptors };
      }
      if (method === "Runtime.callFunctionOn") {
        if (String(params.functionDeclaration).includes("rootObjectKeys")) {
          return {
            result: {
              value: {
                rootObjectKeys: ["ejectState", "ejectBoardState"],
                ejectKeys: ["game"],
                stateKeys: ["board"],
                boardStateKeys: ["b"]
              }
            }
          };
        }
        visitedCandidates.push(params.objectId);
        fakeNow += 180;
        return {
          result: {
            value:
              params.objectId === "candidate-3"
                ? { ok: true, source: "closure:Ai3", locator: "Ai3" }
                : { ok: false }
          }
        };
      }
      throw new Error(`unexpected method ${method}`);
    }
  };

  await withPatchedDateNow(() => fakeNow, async () => {
    const first = await exposeTetrioGameFromPausedCallFrames(cdp, {
      callFrames: [{
        callFrameId: "frame-1",
        scopeChain: [{ object: { objectId: "scope-1" } }]
      }]
    }, {
      closureCaptureState,
      log: (line) => logs.push(line)
    });
    assert.equal(first.ok, false);
    assert.equal(first.outcome, "continuation_required");
    assert.equal(first.continuationReason, "paused_budget_reached");
    assert.equal(closureCaptureState.fullScanAttemptsInWindow, 1);
    assert.deepEqual(visitedCandidates, ["candidate-1", "candidate-2"]);

    const second = await exposeTetrioGameFromPausedCallFrames(cdp, {
      callFrames: [{
        callFrameId: "frame-2",
        scopeChain: [{ object: { objectId: "scope-1" } }]
      }]
    }, {
      closureCaptureState,
      log: (line) => logs.push(line)
    });
    assert.equal(second.ok, true);
    assert.equal(second.locator, "Ai3");
  });

  assert.deepEqual(visitedCandidates, ["candidate-1", "candidate-2", "candidate-3"]);
  assert.equal(closureCaptureState.pausedScopeScanCursor, null);
  assert.ok(logs.includes("[browser] full closure scan attempt=1/2"));
  assert.ok(logs.includes("[browser] full closure scan attempt=2/2 resume_from=0:0:2"));
  assert.ok(
    logs.some((line) =>
      line.startsWith("[browser] full closure scan progress attempt=1/2 frame=0 scope=0 candidate=2")
    )
  );
  assert.ok(
    logs.includes("[browser] full closure scan continuation from frame=0 scope=0 candidate=2")
  );
});

test("paused scan continuation preserves cursor and remaining cumulative budget", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const visitedCandidates = [];
  let fakeNow = 1_000;
  const descriptors = Array.from({ length: 4 }, (_, index) => ({
    name: `Ai${index + 1}`,
    value: { objectId: `candidate-${index + 1}` }
  }));
  const cdp = {
    async send(method, params = {}) {
      if (method === "Runtime.getProperties") {
        return { result: descriptors };
      }
      if (method === "Runtime.callFunctionOn") {
        if (String(params.functionDeclaration).includes("rootObjectKeys")) {
          return {
            result: {
              value: {
                rootObjectKeys: ["ejectState", "ejectBoardState"],
                ejectKeys: ["game"],
                stateKeys: ["board"],
                boardStateKeys: ["b"]
              }
            }
          };
        }
        visitedCandidates.push(params.objectId);
        fakeNow += 175;
        return {
          result: {
            value:
              params.objectId === "candidate-4"
                ? { ok: true, source: "closure:Ai4", locator: "Ai4" }
                : { ok: false }
          }
        };
      }
      throw new Error(`unexpected method ${method}`);
    }
  };

  await withPatchedDateNow(() => fakeNow, async () => {
    const first = await exposeTetrioGameFromPausedCallFrames(cdp, {
      callFrames: [{
        callFrameId: "frame-1",
        scopeChain: [{ object: { objectId: "scope-1" } }]
      }]
    }, {
      closureCaptureState,
      log: (line) => logs.push(line)
    });
    assert.equal(first.ok, false);
    assert.equal(first.reason, "TETR.IO paused scope scan pause budget reached");
    assert.equal(first.outcome, "continuation_required");
    assert.equal(first.continuationReason, "paused_budget_reached");
    assert.equal(first.progress?.pausedMs, 350);
    assert.equal(closureCaptureState.cumulativePausedScanBudgetUsedMs, 350);
    assert.deepEqual(closureCaptureState.pausedScopeScanCursor, {
      frameIndex: 0,
      scopeIndex: 0,
      propertyIndex: 2,
      completedScopeKeys: [],
      seenCandidateKeys: [
        "0:0:scope-1:Ai1:candidate-1",
        "0:0:scope-1:Ai2:candidate-2"
      ]
    });

    const second = await exposeTetrioGameFromPausedCallFrames(cdp, {
      callFrames: [{
        callFrameId: "frame-2",
        scopeChain: [{ object: { objectId: "scope-1" } }]
      }]
    }, {
      closureCaptureState,
      log: (line) => logs.push(line)
    });
    assert.equal(second.ok, true);
    assert.equal(second.locator, "Ai4");
  });

  assert.equal(closureCaptureState.cumulativePausedScanBudgetUsedMs, 700);
  assert.ok(closureCaptureState.cumulativePausedScanBudgetUsedMs <= 700);
  assert.equal(closureCaptureState.pausedScopeScanCursor, null);
  assert.equal(visitedCandidates.length, 4);
  assert.equal(visitedCandidates[0], "candidate-1");
  assert.equal(visitedCandidates.at(-1), "candidate-4");
  assert.ok(
    logs.includes("[browser] full closure scan continuation from frame=0 scope=0 candidate=2")
  );
  assert.ok(logs.includes("[browser] full closure scan attempt=2/2 resume_from=0:0:2"));
});

test("preflight retries do not prevent the first full scan attempt", async () => {
  const logs = [];
  let pausedEvents = 0;
  const closureCaptureState = createClosureCaptureState();
  armClosureCaptureWindow(closureCaptureState, {
    reason: "bot_on",
    now: 1_000,
    log: () => {}
  });
  closureCaptureState.lastSuccessfulLocator = "Ai";
  const cdp = {
    async send(method, params = {}) {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            objectId: "fn-1"
          }
        };
      }
      if (method === "Debugger.enable" || method === "Debugger.disable") {
        return {};
      }
      if (method === "Debugger.setBreakpointOnFunctionCall") {
        return { breakpointId: `bp-${Math.random()}` };
      }
      if (method === "Debugger.removeBreakpoint") {
        return {};
      }
      if (method === "Runtime.releaseObjectGroup") {
        return {};
      }
      if (method === "Debugger.resume") {
        return {};
      }
      if (method === "Debugger.evaluateOnCallFrame") {
        return {
          result: {
            value: { ok: false }
          }
        };
      }
      if (method === "Runtime.getProperties") {
        return {
          result: [
            {
              name: "Ai",
              value: { objectId: "candidate-1" }
            }
          ]
        };
      }
      if (method === "Runtime.callFunctionOn") {
        return {
          result: {
            value: { ok: false }
          }
        };
      }
      throw new Error(`unexpected method ${method} ${JSON.stringify(params)}`);
    },
    async waitForEvent() {
      pausedEvents += 1;
      if (pausedEvents < 3) {
        throw new Error("timeout");
      }
      return {
        callFrames: [{
          callFrameId: `frame-${pausedEvents}`,
          scopeChain: [{ object: { objectId: `scope-${pausedEvents}` } }]
        }]
      };
    }
  };

  const first = await captureTetrioGame(cdp, {
    closureCaptureState,
    log: (line) => logs.push(line)
  });
  const second = await captureTetrioGame(cdp, {
    closureCaptureState,
    log: (line) => logs.push(line)
  });
  const third = await captureTetrioGame(cdp, {
    closureCaptureState,
    log: (line) => logs.push(line)
  });

  assert.equal(first.ok, false);
  assert.equal(first.outcome, "preflight_not_visible");
  assert.equal(second.ok, false);
  assert.equal(second.outcome, "preflight_not_visible");
  assert.equal(third.ok, false);
  assert.equal(third.outcome, "completed_not_found");
  assert.equal(closureCaptureState.captureAttemptsInWindow, 3);
  assert.equal(closureCaptureState.fullScanAttemptsInWindow, 1);
  assert.equal(
    logs.filter((line) =>
      line ===
        "[browser] fast closure locator miss; retaining locator cache and falling back to scan"
    ).length,
    1
  );
  assert.equal(
    logs.filter((line) => line.startsWith("[browser] full closure scan attempt=")).length,
    1
  );
  assert.equal(pausedEvents, 3);
});

test("partial full scan keeps the window armed and bot enabled until the second failure", async () => {
  const logs = [];
  let attempt = 0;
  const controlState = createBrowserControlState();
  const closureCaptureState = createClosureCaptureState();
  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: true },
    controlState,
    closureCaptureState,
    now: 20_000,
    log: () => {}
  });

  const captureGameFn = async () => {
    attempt += 1;
    closureCaptureState.fullScanAttemptsInWindow = attempt;
    if (attempt === 1) {
      return {
        ok: false,
        reason: "TETR.IO paused scope scan pause budget reached",
        outcome: "continuation_required",
        continuationReason: "paused_budget_reached",
        resumeCursor: { frameIndex: 0, scopeIndex: 0, candidateIndex: 2 }
      };
    }
    return {
      ok: false,
      reason: "TETR.IO active game variable was not in paused scopes",
      outcome: "completed_not_found"
    };
  };

  const first = await readTetrioState(createReadStateCdp([
    {
      ok: false,
      ready: false,
      playing: true,
      countdown: false,
      reason: "TETR.IO game instance not captured yet"
    }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(20_000),
    browserControlState: controlState,
    closureCaptureState,
    now: 20_000,
    log: (line) => logs.push(line),
    captureGameFn
  });

  assert.equal(first.ok, false);
  assert.equal(controlState.botEnabled, true);
  assert.equal(closureCaptureState.fullScanAttemptsInWindow, 1);
  assert.equal(isClosureCaptureArmed(closureCaptureState, 20_001), true);
  assert.equal(closureCaptureState.nextAttemptAt, 20_100);
  assert.equal(closureCaptureState.retryCount, 0);
  assert.ok(
    logs.includes("[browser] full closure scan paused budget reached; scheduling continuation")
  );
  assert.equal(
    logs.includes("[browser] closure capture disarmed reason=scan_budget_exhausted"),
    false
  );

  const second = await readTetrioState(createReadStateCdp([
    {
      ok: false,
      ready: false,
      playing: true,
      countdown: false,
      reason: "TETR.IO game instance not captured yet"
    }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 20_000, seed: null },
    probeState: { lastCaptureAt: 20_000, lastGameplayPhase: "playing" },
    bootstrapState: readyBootstrapState(20_100),
    browserControlState: controlState,
    closureCaptureState,
    now: 20_100,
    log: (line) => logs.push(line),
    captureGameFn
  });

  assert.equal(second.ok, false);
  assert.equal(controlState.botEnabled, true);
  assert.equal(closureCaptureState.fullScanAttemptsInWindow, 0);
  assert.equal(isClosureCaptureArmed(closureCaptureState, 20_101), false);
  assert.ok(logs.includes("[browser] closure capture disarmed reason=scan_budget_exhausted"));
});

test("suppressed VS reason is not periodically re-logged", () => {
  assert.equal(
    shouldLogStateReason({
      reason: "VS WebSocket simulation owns live state",
      lastReason: "VS WebSocket simulation owns live state",
      lastReasonAt: 1_000,
      now: 20_000,
      suppressRepeatedReason: true
    }),
    false
  );
});

test("VS queue reference for seed 220638408 matches the Rust validation fixture", () => {
  const source = readFileSync(
    new URL("./tetrio-cdp-source.mjs", import.meta.url),
    "utf8"
  );
  const createPrngSource = source.match(
    /function createPrng\(seed\) \{[\s\S]*?\n\}/
  )?.[0];
  const generateQueueSource = source.match(
    /function generate7BagQueue\(seed, count\) \{[\s\S]*?\n\}/
  )?.[0];
  assert.ok(createPrngSource);
  assert.ok(generateQueueSource);

  const queue = Array.from(vm.runInNewContext(
    `${createPrngSource}\n${generateQueueSource}\ngenerate7BagQueue("220638408", 28)`,
    { Math, Number }
  ));

  assert.deepEqual(queue, [
    "i", "o", "z", "s", "t", "l", "j",
    "t", "z", "s", "i", "j", "o", "l",
    "i", "j", "s", "l", "t", "o", "z",
    "z", "l", "o", "i", "s", "t", "j"
  ]);
});

test("snapshot tokens and signatures include the game epoch", () => {
  const state = {
    pieceCounter: 0,
    current: "t",
    hold: "i",
    queue: ["o", "s"],
    activeX: 4,
    activeY: 19,
    activeRotation: "north"
  };

  assert.equal(buildSnapshotToken(1, 0), "browser-1-0");
  assert.equal(buildSnapshotToken(2, 0), "browser-2-0");
  assert.notEqual(buildSnapshotToken(1, 0), buildSnapshotToken(2, 0));
  assert.notEqual(buildSnapshotSignature(1, state), buildSnapshotSignature(2, state));
});

test("new game detection only advances epoch after waiting for the next game", () => {
  const activeState = {
    ok: true,
    ready: true,
    playing: true,
    countdown: false
  };
  assert.equal(shouldAdvanceGameEpoch(activeState, true), true);
  assert.equal(shouldAdvanceGameEpoch(activeState, false), false);
});

test("clearSnapshotFile removes stale snapshot output", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "tetrio-cdp-source-"));
  const snapshotPath = path.join(tempDir, "live-snapshot.json");
  writeFileSync(snapshotPath, "{}");
  assert.equal(existsSync(snapshotPath), true);

  clearSnapshotFile(snapshotPath);

  assert.equal(existsSync(snapshotPath), false);
});

test("tetrioStateExpression keeps existing field and piece extraction behavior", () => {
  const board = createBoard();
  board[39][0] = 1;
  const game = createGame({
    current: "l",
    hold: "j",
    queue: ["s", "z", "i"],
    pieceCounter: 3,
    board
  });

  const { result, window } = evaluateInWindow(tetrioStateExpression(), {
    __fusionTetrioGame: game
  });

  assert.equal(result.ok, true);
  assert.equal(result.current, "l");
  assert.equal(result.hold, "j");
  assert.deepEqual(result.queue, ["s", "z", "i"]);
  assert.equal(result.pieceCounter, 3);
  assert.equal(result.linesCleared, undefined);
  assert.equal(result.field[0][0], true);
  assert.equal(window.__fusionTetrioGame, game);
});

test("tetrioStateExpression extracts optional lines cleared stats", () => {
  const game = createGame({
    current: "i",
    linesCleared: 24
  });

  const { result } = evaluateInWindow(tetrioStateExpression(), {
    __fusionTetrioGame: game
  });

  assert.equal(result.ok, true);
  assert.equal(result.linesCleared, 24);
});

test("cheap game signal treats visible result over canvas as inactive result", () => {
  const nodes = {
    result: {
      isConnected: true,
      parentElement: null,
      getBoundingClientRect: () => ({ width: 100, height: 40 })
    },
    canvas: {
      isConnected: true,
      parentElement: null,
      getBoundingClientRect: () => ({ width: 640, height: 360 })
    }
  };
  const { result } = evaluateInWindow(cheapGameSignalExpression(), {
    getComputedStyle() {
      return { display: "block", visibility: "visible", opacity: "1" };
    }
  }, {
    document: {
      body: { innerText: "40 LINES finished retry continue" },
      querySelectorAll(selector) {
        if (selector.includes("result")) return [nodes.result];
        if (selector === "canvas") return [nodes.canvas];
        return [];
      }
    },
    location: { pathname: "/solo/results", hash: "" }
  });

  assert.equal(result.label, "result");
  assert.equal(result.active, false);
});

test("cheap game signal does not treat 40 LINES body text alone as a result screen", () => {
  const { result } = evaluateInWindow(cheapGameSignalExpression(), {
    getComputedStyle() {
      return { display: "block", visibility: "visible", opacity: "1" };
    }
  }, {
    document: {
      body: { innerText: "40 LINES" },
      querySelectorAll() {
        return [];
      }
    },
    location: { pathname: "/solo/play", hash: "" }
  });

  assert.equal(result.label, "inactive");
  assert.equal(result.active, false);
});

test("cheap game signal ignores hidden stale result elements", () => {
  const hiddenResult = {
    isConnected: true,
    parentElement: null,
    getBoundingClientRect: () => ({ width: 100, height: 40 })
  };
  const gameplay = {
    isConnected: true,
    parentElement: null,
    getBoundingClientRect: () => ({ width: 300, height: 600 })
  };
  const { result } = evaluateInWindow(cheapGameSignalExpression(), {
    getComputedStyle(node) {
      if (node === hiddenResult) {
        return { display: "none", visibility: "visible", opacity: "1" };
      }
      return { display: "block", visibility: "visible", opacity: "1" };
    }
  }, {
    document: {
      body: { innerText: "" },
      querySelectorAll(selector) {
        if (selector.includes("result")) return [hiddenResult];
        if (selector.includes("board") || selector.includes("playfield") || selector.includes("hud")) {
          return [gameplay];
        }
        return [];
      }
    },
    location: { pathname: "/solo/play", hash: "" }
  });

  assert.equal(result.label, "playing");
  assert.equal(result.active, true);
});

test("cheap game signal treats visible countdown as active", () => {
  const countdown = {
    isConnected: true,
    parentElement: null,
    getBoundingClientRect: () => ({ width: 120, height: 60 })
  };
  const { result } = evaluateInWindow(cheapGameSignalExpression(), {
    getComputedStyle() {
      return { display: "block", visibility: "visible", opacity: "1" };
    }
  }, {
    document: {
      body: { innerText: "ready" },
      querySelectorAll(selector) {
        if (selector.includes("countdown") || selector.includes("ready")) return [countdown];
        return [];
      }
    },
    location: { pathname: "/solo/play", hash: "" }
  });

  assert.equal(result.label, "countdown");
  assert.equal(result.active, true);
});

test("next-game interaction tracker dedupes pointerup and click into one generation", () => {
  const listeners = new Map();
  let now = 1_000;
  const document = {
    addEventListener(type, handler) {
      listeners.set(type, handler);
    }
  };
  const { result, window } = evaluateInWindow(
    nextGameInteractionTrackerExpression(),
    {},
    {
      document,
      Date: { now: () => now }
    }
  );

  assert.equal(result.ok, true);
  listeners.get("pointerup")?.({
    type: "pointerup",
    target: { tagName: "BUTTON", id: "retry", className: "cta" }
  });
  now += 50;
  listeners.get("click")?.({
    type: "click",
    target: { tagName: "BUTTON", id: "retry", className: "cta" }
  });

  assert.equal(window.__fusionNextGameInteraction.generation, 1);
  assert.equal(window.__fusionNextGameInteraction.type, "pointerup");
});

test("next-game interaction tracker dedupes pointerdown pointerup and click into one generation", () => {
  const listeners = new Map();
  let now = 1_500;
  const document = {
    addEventListener(type, handler) {
      listeners.set(type, handler);
    }
  };
  const { window } = evaluateInWindow(
    nextGameInteractionTrackerExpression(),
    {},
    {
      document,
      Date: { now: () => now }
    }
  );

  listeners.get("pointerdown")?.({
    type: "pointerdown",
    target: { tagName: "BUTTON", id: "retry", className: "cta" }
  });
  now += 60;
  listeners.get("pointerup")?.({
    type: "pointerup",
    target: { tagName: "BUTTON", id: "retry", className: "cta" }
  });
  now += 60;
  listeners.get("click")?.({
    type: "click",
    target: { tagName: "BUTTON", id: "retry", className: "cta" }
  });

  assert.equal(window.__fusionNextGameInteraction.generation, 1);
  assert.equal(window.__fusionNextGameInteraction.type, "pointerdown");
});

test("next-game interaction tracker accepts Enter and ignores unrelated keys", () => {
  const listeners = new Map();
  let now = 2_000;
  const document = {
    addEventListener(type, handler) {
      listeners.set(type, handler);
    }
  };
  const { window } = evaluateInWindow(
    nextGameInteractionTrackerExpression(),
    {},
    {
      document,
      Date: { now: () => now }
    }
  );

  listeners.get("keydown")?.({
    type: "keydown",
    key: "ArrowLeft",
    target: { tagName: "BODY", id: "", className: "" }
  });
  assert.equal(window.__fusionNextGameInteraction.generation, 0);
  listeners.get("keydown")?.({
    type: "keydown",
    key: "Enter",
    target: { tagName: "BODY", id: "", className: "" }
  });
  assert.equal(window.__fusionNextGameInteraction.generation, 1);
});

test("next-game interaction tracker ignores repeated keydown events", () => {
  const listeners = new Map();
  let now = 2_500;
  const document = {
    addEventListener(type, handler) {
      listeners.set(type, handler);
    }
  };
  const { window } = evaluateInWindow(
    nextGameInteractionTrackerExpression(),
    {},
    {
      document,
      Date: { now: () => now }
    }
  );

  listeners.get("keydown")?.({
    type: "keydown",
    key: "Enter",
    repeat: true,
    target: { tagName: "BODY", id: "", className: "" }
  });
  assert.equal(window.__fusionNextGameInteraction.generation, 0);
  now += 10;
  listeners.get("keydown")?.({
    type: "keydown",
    key: "r",
    repeat: false,
    target: { tagName: "BODY", id: "", className: "" }
  });
  assert.equal(window.__fusionNextGameInteraction.generation, 1);
});

test("reacquire baseline is seeded from the current page interaction generation", async () => {
  const nextGameReacquireState = createNextGameReacquireState();
  startNextGameReacquire(nextGameReacquireState, {
    now: 3_000,
    epoch: 1,
    log: () => {}
  });

  const baseline = await primeNextGameInteractionBaseline(null, nextGameReacquireState, {
    log: () => {},
    readNextGameInteractionStateFn: async () => ({
      generation: 5,
      timestamp: 3_010
    })
  });

  assert.equal(baseline, 5);
  assert.equal(nextGameReacquireState.interactionBaselineGeneration, 5);
  assert.equal(nextGameReacquireState.lastInteractionGenerationSeen, 5);
  assert.equal(nextGameReacquireState.lastInteractionGenerationHandled, 5);
});

test("post-game interaction watch starts on first not-playing transition baseline", async () => {
  const watch = createPostGameInteractionWatchState();

  const baseline = await primePostGameInteractionWatchBaseline(null, watch, {
    now: 3_500,
    log: () => {},
    readNextGameInteractionStateFn: async () => ({
      generation: 64,
      timestamp: 3_505
    })
  });

  assert.equal(baseline, 64);
  assert.equal(watch.active, true);
  assert.equal(watch.firstNotPlayingAt, 3_500);
  assert.equal(watch.interactionBaselineGeneration, 64);
  assert.equal(watch.lastInteractionGenerationSeen, 64);
});

test("baseline-matching generation is ignored during reacquire", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  startNextGameReacquire(nextGameReacquireState, {
    now: 26_000,
    epoch: 1,
    interactionBaselineGeneration: 88,
    log: () => {}
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(26_200),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: createPostGameInteractionWatchState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 26_200,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 88,
      timestamp: 26_150,
      type: "keydown",
      targetTag: "BODY",
      targetId: "",
      targetClass: ""
    })
  });

  assert.equal(closureCaptureState.armedReason, "");
  assert.equal(
    logs.some((line) => line.includes("generation=88 type=keydown")),
    false
  );
});

test("baseline capture absorbs the race before the initial interaction read", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const endedGameCandidate = createEndedGameCandidateState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  startNextGameReacquire(nextGameReacquireState, {
    now: 4_000,
    epoch: 1,
    log: () => {}
  });
  await primeNextGameInteractionBaseline(null, nextGameReacquireState, {
    log: () => {},
    readNextGameInteractionStateFn: async () => ({
      generation: 6,
      timestamp: 4_010,
      type: "click",
      targetTag: "BUTTON",
      targetId: "retry",
      targetClass: "cta"
    })
  });
  let captureCalls = 0;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(4_100),
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate,
    waitingForNextGame: true,
    now: 4_100,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 6,
      timestamp: 4_010,
      type: "click",
      targetTag: "BUTTON",
      targetId: "retry",
      targetClass: "cta"
    }),
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: false, reason: "should not run" };
    }
  });

  assert.equal(captureCalls, 0);
  assert.equal(closureCaptureState.armedReason, "");
  assert.equal(
    logs.some((line) => line.includes("closure capture armed reason=next_game_user_interaction")),
    false
  );
});

test("end confirmation watch captures AGAIN pointerdown before reacquire starts", async () => {
  const logs = [];
  let captureCalls = 0;
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const postGameInteractionWatchState = createPostGameInteractionWatchState();
  const endedGameCandidate = createEndedGameCandidateState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  startPostGameInteractionWatch(postGameInteractionWatchState, {
    now: 24_500,
    baselineGeneration: 64,
    log: () => {}
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(24_800),
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState,
    endedGameCandidate,
    waitingForNextGame: false,
    now: 24_800,
    log: (line) => logs.push(line),
    readNextGameInteractionStateFn: async () => ({
      generation: 65,
      timestamp: 24_700,
      type: "pointerdown",
      targetTag: "BUTTON",
      targetId: "retry",
      targetClass: "cta"
    }),
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: false, reason: "should not run" };
    }
  });

  assert.equal(postGameInteractionWatchState.pendingGeneration, 65);
  assert.equal(postGameInteractionWatchState.pendingType, "pointerdown");
  assert.equal(captureCalls, 0);
  assert.ok(
    logs.includes("[browser] post-game interaction captured before end confirmation generation=65 type=pointerdown")
  );
});

test("normal gameplay interactions before first not-playing are not stored as pending", async () => {
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const postGameInteractionWatchState = createPostGameInteractionWatchState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;

  await readTetrioState(createReadStateCdp([
    {
      ok: true,
      ready: true,
      playing: true,
      countdown: false,
      pieceCounter: 10,
      current: "t",
      hold: null,
      queue: ["i", "o"]
    }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "playing" },
    bootstrapState: readyBootstrapState(4_900),
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 4_900,
    readNextGameInteractionStateFn: async () => ({
      generation: 11,
      timestamp: 4_850,
      type: "keydown",
      targetTag: "BODY",
      targetId: "",
      targetClass: ""
    })
  });

  assert.equal(postGameInteractionWatchState.pendingGeneration, 0);
});

test("pending post-game interaction carries into reacquire without being erased by a later baseline", () => {
  const logs = [];
  const watch = createPostGameInteractionWatchState();
  const nextGameReacquireState = createNextGameReacquireState();
  startPostGameInteractionWatch(watch, {
    now: 5_000,
    baselineGeneration: 64,
    log: () => {}
  });
  watch.pendingGeneration = 65;
  watch.pendingTimestamp = 5_100;
  watch.pendingType = "pointerdown";
  watch.pendingTargetTag = "BUTTON";
  watch.pendingTargetId = "retry";
  watch.pendingTargetClass = "cta";
  startNextGameReacquire(nextGameReacquireState, {
    now: 5_200,
    epoch: 1,
    interactionBaselineGeneration: watch.interactionBaselineGeneration,
    log: () => {}
  });

  const carried = carryPendingPostGameInteractionIntoReacquire(
    watch,
    nextGameReacquireState,
    {
      log: (line) => logs.push(line)
    }
  );

  assert.equal(carried, true);
  assert.equal(nextGameReacquireState.interactionBaselineGeneration, 64);
  assert.equal(nextGameReacquireState.lastInteractionGenerationSeen, 65);
  assert.equal(nextGameReacquireState.lastInteractionGenerationHandled, 64);
  assert.equal(nextGameReacquireState.pendingInteractionGeneration, 65);
  assert.ok(
    logs.includes("[browser] pending post-game interaction carried into reacquire generation=65")
  );
});

test("carried pending interaction arms exactly once after game end confirmation", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  closureCaptureState.captureAttemptsInWindow = 2;
  closureCaptureState.fullScanAttemptsInWindow = 2;
  closureCaptureState.cumulativePausedScanBudgetUsedMs = 562;
  closureCaptureState.pausedScopeScanCursor = {
    frameIndex: 4,
    scopeIndex: 2,
    propertyIndex: 7,
    completedScopeKeys: ["1:0:scope-1"],
    seenCandidateKeys: ["1:0:scope-1:Ai:candidate-1"]
  };
  closureCaptureState.lastSuccessfulLocator = "Ai";
  closureCaptureState.armedUntil = 27_500;
  closureCaptureState.armedReason = "next_game_user_interaction";
  closureCaptureState.nextAttemptAt = 27_150;
  const nextGameReacquireState = createNextGameReacquireState();
  startNextGameReacquire(nextGameReacquireState, {
    now: 27_000,
    epoch: 1,
    interactionBaselineGeneration: 88,
    log: () => {}
  });
  nextGameReacquireState.pendingInteractionGeneration = 90;
  nextGameReacquireState.pendingInteractionTimestamp = 27_050;
  nextGameReacquireState.pendingInteractionSource = "post_game";

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(27_100),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: createPostGameInteractionWatchState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 27_100,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 90,
      timestamp: 27_050,
      type: "pointerdown",
      targetTag: "DIV",
      targetId: "start_results",
      targetClass: ""
    })
  });

  assert.equal(nextGameReacquireState.lastInteractionGenerationHandled, 90);
  assert.equal(nextGameReacquireState.pendingInteractionGeneration, 0);
  assert.equal(nextGameReacquireState.interactionPhase, "capture_armed");
  assert.equal(closureCaptureState.captureAttemptsInWindow, 0);
  assert.equal(closureCaptureState.fullScanAttemptsInWindow, 0);
  assert.equal(closureCaptureState.cumulativePausedScanBudgetUsedMs, 0);
  assert.equal(closureCaptureState.scanBudgetExhausted, false);
  assert.equal(closureCaptureState.lastSuccessfulLocator, "Ai");
  assert.equal(closureCaptureState.nextAttemptAt, 27_400);
  assert.equal(
    logs.filter((line) => line === "[browser] carried interaction armed generation=90").length,
    1
  );
  assert.ok(
    logs.includes(
      "[browser] resetting closure window for carried interaction previous_capture_attempts=2 previous_full_scan_attempts=2 previous_paused_used_ms=562"
    )
  );
  assert.ok(
    logs.includes("[browser] closure capture armed reason=next_game_carried_interaction generation=90")
  );
  assert.ok(
    logs.includes(
      "[browser] closure window initialized reason=next_game_carried_interaction capture_attempts=0 full_scan_attempts=0 paused_used_ms=0 cursor=0:0:0 exhausted=false remaining_paused_ms=700"
    )
  );
});

test("carried interaction exhaustion consumes the generation and blocks repeated capture attempts", async () => {
  const logs = [];
  let captureCalls = 0;
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  startNextGameReacquire(nextGameReacquireState, {
    now: 41_000,
    epoch: 2,
    interactionBaselineGeneration: 160,
    log: () => {}
  });
  closureCaptureState.armedUntil = 49_000;
  closureCaptureState.armedReason = "next_game_carried_interaction";
  closureCaptureState.nextAttemptAt = 41_000;
  nextGameReacquireState.interactionPhase = "capture_armed";
  nextGameReacquireState.interactionWindowGeneration = 163;
  nextGameReacquireState.pendingInteractionGeneration = 163;
  nextGameReacquireState.pendingInteractionTimestamp = 41_050;
  nextGameReacquireState.pendingInteractionSource = "post_game";

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(41_000),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: createPostGameInteractionWatchState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 41_000,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    captureGameFn: async () => {
      captureCalls += 1;
      return {
        ok: false,
        reason: "TETR.IO full closure scan cumulative budget exhausted",
        outcome: "continuation_required",
        continuationReason: "paused_budget_reached",
        windowBudgetExhausted: true
      };
    }
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 41_000, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(41_500),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: createPostGameInteractionWatchState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 41_500,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: false, reason: "should not run again" };
    }
  });

  assert.equal(captureCalls, 1);
  assert.equal(nextGameReacquireState.lastInteractionGenerationHandled, 163);
  assert.equal(nextGameReacquireState.pendingInteractionGeneration, 0);
  assert.equal(nextGameReacquireState.interactionWindowGeneration, 0);
  assert.equal(nextGameReacquireState.interactionPhase, "reacquiring");
  assert.equal(isClosureCaptureArmed(closureCaptureState, 41_500), false);
  assert.ok(logs.includes("[browser] carried interaction capture exhausted generation=163"));
  assert.ok(logs.includes("[browser] closure capture disarmed reason=scan_budget_exhausted"));
  assert.ok(logs.includes("[browser] waiting for fresh next-game interaction after capture exhaustion"));
});

test("not-playing R key is stored as pending post-game interaction", async () => {
  const watch = createPostGameInteractionWatchState();
  startPostGameInteractionWatch(watch, {
    now: 25_500,
    baselineGeneration: 64,
    log: () => {}
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(25_700),
    browserControlState: { botEnabled: true },
    closureCaptureState: createClosureCaptureState(),
    nextGameReacquireState: createNextGameReacquireState(),
    postGameInteractionWatchState: watch,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 25_700,
    log: () => {},
    readNextGameInteractionStateFn: async () => ({
      generation: 65,
      timestamp: 25_650,
      type: "keydown",
      targetTag: "BODY",
      targetId: "",
      targetClass: ""
    })
  });

  assert.equal(watch.pendingGeneration, 65);
  assert.equal(watch.pendingType, "keydown");
});

test("trusted result-screen pointerdown provisionally arms next-game capture before end confirmation", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const watch = createPostGameInteractionWatchState();
  startPostGameInteractionWatch(watch, {
    now: 30_000,
    baselineGeneration: 76,
    log: () => {}
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(30_100),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: watch,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 30_100,
    log: (line) => logs.push(line),
    readNextGameInteractionStateFn: async () => ({
      generation: 77,
      key: null,
      timestamp: 30_080,
      type: "pointerdown",
      targetTag: "DIV",
      targetId: "start_results",
      targetClass: ""
    })
  });

  assert.equal(
    closureCaptureState.armedReason.startsWith("next_game_provisional_interaction"),
    true
  );
  assert.equal(closureCaptureState.nextAttemptAt, 30_550);
  assert.equal(nextGameReacquireState.provisionalInteractionGeneration, 77);
  assert.ok(logs.includes("[browser] trusted next-game interaction provisional arm generation=77"));
});

test("provisional arm passes requireActiveGame to exclude the ended object", async () => {
  let captureOptions = null;
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  startNextGameReacquire(nextGameReacquireState, {
    now: 31_000,
    epoch: 1,
    interactionBaselineGeneration: 80,
    log: () => {}
  });
  armClosureCaptureWindow(closureCaptureState, {
    reason: "next_game_provisional_interaction",
    now: 31_000,
    log: () => {}
  });
  closureCaptureState.nextAttemptAt = 31_950;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(31_950),
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: createPostGameInteractionWatchState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 31_950,
    log: () => {},
    captureGameFn: async (_cdp, options) => {
      captureOptions = options;
      return { ok: false, reason: "not ready yet" };
    }
  });

  assert.equal(captureOptions?.requireActiveGame, true);
});

test("AGAIN provisional first attempt uses only the non-heavy capture path", async () => {
  let captureOptions = null;
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const watch = createPostGameInteractionWatchState();
  startPostGameInteractionWatch(watch, {
    now: 31_000,
    baselineGeneration: 80,
    log: () => {}
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(31_100),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: watch,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 31_100,
    log: () => {},
    readNextGameInteractionStateFn: async () => ({
      generation: 81,
      key: null,
      timestamp: 31_010,
      type: "pointerdown",
      targetTag: "DIV",
      targetId: "start_results",
      targetClass: ""
    })
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(31_550),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: watch,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 31_550,
    log: () => {},
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: [
        { source: "result_dom", value: true, state: "result" },
        { source: "countdown_dom", value: false, state: "inactive" },
        { source: "gameplay_dom", value: false, state: "inactive" },
        { source: "route_game", value: false, state: "inactive" }
      ]
    }),
    captureGameFn: async (_cdp, options) => {
      captureOptions = options;
      return { ok: false, reason: "still hidden", outcome: "targeted_only_miss" };
    }
  });

  assert.equal(captureOptions?.allowBroadScan, false);
  assert.equal(captureOptions?.pauseTimeoutMs, 100);
});

test("AGAIN provisional targeted miss suppresses broad scan until transition readiness", async () => {
  const logs = [];
  let captureCalls = 0;
  const broadFlags = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const watch = createPostGameInteractionWatchState();
  startPostGameInteractionWatch(watch, {
    now: 32_000,
    baselineGeneration: 90,
    log: () => {}
  });

  const captureGameFn = async (_cdp, options) => {
    captureCalls += 1;
    broadFlags.push(options.allowBroadScan);
    return captureCalls === 1
      ? { ok: false, reason: "still hidden", outcome: "targeted_only_miss" }
      : { ok: false, reason: "still hidden", outcome: "completed_not_found" };
  };

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(32_100),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: watch,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 32_100,
    log: (line) => logs.push(line),
    readNextGameInteractionStateFn: async () => ({
      generation: 91,
      key: null,
      timestamp: 32_010,
      type: "pointerdown",
      targetTag: "DIV",
      targetId: "start_results",
      targetClass: ""
    })
  });
  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(32_550),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: watch,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 32_550,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: [
        { source: "result_dom", value: true, state: "result" },
        { source: "countdown_dom", value: false, state: "inactive" },
        { source: "gameplay_dom", value: false, state: "inactive" },
        { source: "route_game", value: false, state: "inactive" }
      ]
    }),
    captureGameFn
  });
  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(32_700),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: watch,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 32_700,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: true,
      source: "countdown_dom",
      label: "countdown",
      sources: [
        { source: "result_dom", value: false, state: "inactive" },
        { source: "countdown_dom", value: true, state: "countdown" },
        { source: "gameplay_dom", value: false, state: "inactive" },
        { source: "route_game", value: true, state: "playing" }
      ]
    }),
    captureGameFn
  });

  assert.deepEqual(broadFlags, [false]);
  assert.ok(logs.includes("[browser] broad scan suppressed while AGAIN transition is not ready"));
});

test("interaction detection logs distinguish restart key and again button", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  startNextGameReacquire(nextGameReacquireState, {
    now: 33_000,
    epoch: 1,
    interactionBaselineGeneration: 10,
    log: () => {}
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(33_100),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: createPostGameInteractionWatchState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 33_100,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 11,
      key: "R",
      timestamp: 33_050,
      type: "keydown",
      targetTag: "BODY",
      targetId: "",
      targetClass: ""
    }),
    captureGameFn: async () => ({ ok: false, reason: "still hidden" })
  });

  assert.ok(
    logs.some((line) => line.includes("type=keydown key=R interaction_kind=restart_key target=BODY"))
  );
});

test("BODY keydown does not provisionally arm next-game capture", async () => {
  let captureCalls = 0;
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const watch = createPostGameInteractionWatchState();
  startPostGameInteractionWatch(watch, {
    now: 32_000,
    baselineGeneration: 90,
    log: () => {}
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(32_200),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: watch,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 32_200,
    log: () => {},
    readNextGameInteractionStateFn: async () => ({
      generation: 91,
      key: " ",
      timestamp: 32_150,
      type: "keydown",
      targetTag: "BODY",
      targetId: "",
      targetClass: ""
    }),
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: false, reason: "should not run" };
    }
  });

  assert.equal(captureCalls, 0);
  assert.equal(closureCaptureState.armedReason, "");
  assert.equal(watch.pendingGeneration, 91);
});

test("canvas pointerdown does not provisionally arm next-game capture", async () => {
  let captureCalls = 0;
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const watch = createPostGameInteractionWatchState();
  startPostGameInteractionWatch(watch, {
    now: 33_000,
    baselineGeneration: 100,
    log: () => {}
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(33_200),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: watch,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 33_200,
    log: () => {},
    readNextGameInteractionStateFn: async () => ({
      generation: 101,
      key: null,
      timestamp: 33_150,
      type: "pointerdown",
      targetTag: "CANVAS",
      targetId: "pixi",
      targetClass: ""
    }),
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: false, reason: "should not run" };
    }
  });

  assert.equal(captureCalls, 0);
  assert.equal(closureCaptureState.armedReason, "");
  assert.equal(watch.pendingGeneration, 101);
});

test("the same trusted generation opens only one provisional window", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const watch = createPostGameInteractionWatchState();
  startPostGameInteractionWatch(watch, {
    now: 34_000,
    baselineGeneration: 110,
    log: () => {}
  });

  for (const now of [34_100, 34_200]) {
    await readTetrioState(createReadStateCdp([
      { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
    ]), {
      probePageState: true,
      suppressClosureCapture: false,
      useSeedSimulationFallback: false,
      network: { lastPageProbeAt: 0, seed: null },
      probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
      bootstrapState: readyBootstrapState(now),
      browserControlState: { botEnabled: true },
      closureCaptureState,
      nextGameReacquireState,
      postGameInteractionWatchState: watch,
      endedGameCandidate: createEndedGameCandidateState(),
      waitingForNextGame: false,
      now,
      log: (line) => logs.push(line),
      readNextGameInteractionStateFn: async () => ({
        generation: 111,
        key: null,
        timestamp: 34_050,
        type: "pointerdown",
        targetTag: "DIV",
        targetId: "start_results",
        targetClass: ""
      }),
      captureGameFn: async () => ({ ok: false, reason: "should not run" })
    });
  }

  assert.equal(
    logs.filter((line) => line === "[browser] trusted next-game interaction provisional arm generation=111").length,
    1
  );
});

test("game returning to playing cancels post-game watch and clears pending interaction", () => {
  const logs = [];
  const watch = createPostGameInteractionWatchState();
  startPostGameInteractionWatch(watch, {
    now: 6_000,
    baselineGeneration: 64,
    log: () => {}
  });
  watch.pendingGeneration = 65;
  watch.pendingTimestamp = 6_050;

  const cancelled = cancelPostGameInteractionWatch(watch, {
    reason: "playing_resumed",
    log: (line) => logs.push(line)
  });

  assert.equal(cancelled, true);
  assert.equal(watch.active, false);
  assert.equal(watch.pendingGeneration, 0);
  assert.ok(logs.includes("[browser] post-game interaction watch cancelled reason=playing_resumed"));
});

test("capture success enters captured_waiting_start and ignores later interactions", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  startNextGameReacquire(nextGameReacquireState, {
    now: 28_000,
    epoch: 1,
    interactionBaselineGeneration: 88,
    log: () => {}
  });
  nextGameReacquireState.pendingInteractionGeneration = 90;
  nextGameReacquireState.pendingInteractionTimestamp = 28_050;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(28_100),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: createPostGameInteractionWatchState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 28_100,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 0,
      timestamp: 0,
      type: null,
      targetTag: null,
      targetId: null,
      targetClass: null
    }),
    captureGameFn: async () => ({
      ok: true,
      source: "closure:Ai",
      locator: "Ai"
    })
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" },
    { ok: false, ready: false, reason: "TETR.IO game is not started" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(28_450),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: createPostGameInteractionWatchState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 28_450,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 0,
      timestamp: 0,
      type: null,
      targetTag: null,
      targetId: null,
      targetClass: null
    }),
    captureGameFn: async () => ({
      ok: true,
      source: "closure:Ai",
      locator: "Ai"
    })
  });

  assert.equal(nextGameReacquireState.interactionPhase, "captured_waiting_start");
  assert.equal(closureCaptureState.armedReason, "");
  const armLogCountBeforeFollowup = logs.filter((line) =>
    line.includes("closure capture armed reason=next_game_user_interaction")
  ).length;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game is not started" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(28_250),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: createPostGameInteractionWatchState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 28_250,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 92,
      timestamp: 28_200,
      type: "click",
      targetTag: "BUTTON",
      targetId: "retry",
      targetClass: "cta"
    })
  });

  assert.equal(closureCaptureState.armedReason, "");
  assert.equal(
    logs.filter((line) => line.includes("closure capture armed reason=next_game_user_interaction")).length,
    armLogCountBeforeFollowup
  );
});

test("interaction newer than the baseline still requires a timestamp after reacquire start", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const endedGameCandidate = createEndedGameCandidateState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  startNextGameReacquire(nextGameReacquireState, {
    now: 5_000,
    epoch: 1,
    interactionBaselineGeneration: 5,
    log: () => {}
  });
  let captureCalls = 0;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(5_100),
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate,
    waitingForNextGame: true,
    now: 5_100,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 6,
      timestamp: 5_000,
      type: "click",
      targetTag: "BUTTON",
      targetId: "retry",
      targetClass: "cta"
    }),
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: false, reason: "should not run" };
    }
  });

  assert.equal(captureCalls, 0);
  assert.equal(closureCaptureState.armedReason, "");
  assert.equal(
    logs.some((line) => line.includes("closure capture armed reason=next_game_user_interaction")),
    false
  );
});

test("tetrioStateExpression Runtime.evaluate does not use awaitPromise", async () => {
  const cdp = createReadStateCdp([
    {
      ok: true,
      ready: true,
      playing: true,
      countdown: false,
      pieceCounter: 0,
      current: "t",
      hold: null,
      queue: ["i", "o"]
    }
  ]);

  await readTetrioState(cdp, {
    probePageState: false,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState()
  });

  const tetrioEval = cdp.runtimeCalls.find((call) =>
    String(call.expression).includes("const pieceNames")
  );
  assert.ok(tetrioEval);
  assert.equal(Object.hasOwn(tetrioEval, "awaitPromise"), false);
});

test("safeRuntimeEvaluate returns fallback when Promise was collected", async () => {
  const fallback = { result: { value: { ok: false, ready: false } } };
  const cdp = {
    async send() {
      throw new Error("Promise was collected");
    }
  };

  const result = await safeRuntimeEvaluate(
    cdp,
    { expression: "42", returnByValue: true },
    fallback
  );

  assert.equal(result, fallback);
});

test("Promise was collected is classified as a transient runtime error", () => {
  assert.equal(isTransientRuntimeError(new Error("Promise was collected")), true);
});

test("Promise was collected once does not prevent the next poll from recovering", async () => {
  let stateReads = 0;
  const cdp = {
    async send(method, params = {}) {
      assert.equal(method, "Runtime.evaluate");
      if (String(params.expression).includes("document.readyState")) {
        return {
          result: {
            value: {
              readyState: "complete",
              href: "https://tetr.io/"
            }
          }
        };
      }
      stateReads += 1;
      if (stateReads === 1) {
        throw new Error("Promise was collected");
      }
      return {
        result: {
          value: {
            ok: true,
            ready: true,
            playing: true,
            countdown: false,
            pieceCounter: 0,
            current: "t",
            hold: null,
            queue: ["i", "o"]
          }
        }
      };
    }
  };
  const transientState = { lastRuntimeError: "" };
  const logs = [];

  const first = await readTetrioState(cdp, {
    probePageState: false,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(),
    transientState,
    log: (line) => logs.push(line)
  });
  const second = await readTetrioState(cdp, {
    probePageState: false,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(),
    transientState,
    log: (line) => logs.push(line)
  });

  assert.equal(first.ok, false);
  assert.equal(second.ok, true);
  assert.ok(
    logs.some((line) =>
      line.includes("[browser] transient Runtime.evaluate failure: Promise was collected; retrying")
    )
  );
});

test("VS sim OFF reads state then probes once after cooldown", async () => {
  const cdp = createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" },
    {
      ok: true,
      ready: true,
      playing: true,
      countdown: false,
      pieceCounter: 0,
      current: "t",
      hold: null,
      queue: ["i", "o"]
    }
  ]);
  let captureCalls = 0;

  const state = await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    network: { lastPageProbeAt: 0 },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(),
    closureCaptureState: armedClosureCaptureState(20_000),
    now: 20_000,
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    }
  });

  assert.equal(
    isBootstrapReadyForClosureCapture(readyBootstrapState(20_000), 20_000),
    true
  );
  assert.equal(captureCalls, 1);
  assert.equal(state.ok, true);
});

test("Bot On arming opens the solo bootstrap capture window", async () => {
  const controlState = createBrowserControlState();
  const closureCaptureState = createClosureCaptureState();
  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: true },
    controlState,
    closureCaptureState,
    now: 20_000,
    log: () => {}
  });
  const cdp = createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" },
    {
      ok: true,
      ready: true,
      playing: true,
      countdown: false,
      pieceCounter: 0,
      current: "t",
      hold: null,
      queue: ["i", "o"]
    }
  ]);
  let captureCalls = 0;

  const state = await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    network: { lastPageProbeAt: 0 },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(),
    closureCaptureState,
    now: 20_000,
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    },
    log: () => {}
  });

  assert.equal(captureCalls, 1);
  assert.equal(state.ok, true);
});

test("initial gameplay signal reopens an exhausted Bot On capture window once", async () => {
  const logs = [];
  const closureCaptureState = armedClosureCaptureState(20_000, { reason: "bot_on" });
  closureCaptureState.fullScanAttemptsInWindow = 2;
  closureCaptureState.scanBudgetExhausted = true;
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  let captureCalls = 0;

  const state = await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" },
    {
      ok: true,
      ready: true,
      playing: true,
      countdown: false,
      pieceCounter: 0,
      current: "t",
      hold: null,
      queue: ["i", "o"]
    }
  ]), {
    probePageState: true,
    initialCaptureSignalProbe: true,
    suppressClosureCapture: false,
    network: { lastCaptureAt: 0, lastPageProbeAt: 0 },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(20_000),
    browserControlState,
    closureCaptureState,
    now: 20_000,
    readCheapGameSignalFn: async () => ({
      active: true,
      source: "countdown_dom",
      label: "countdown"
    }),
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai", locator: "Ai" };
    },
    log: (line) => logs.push(line)
  });

  assert.equal(captureCalls, 1);
  assert.equal(state.ok, true);
  assert.equal(closureCaptureState.initialGameplaySignalRearmConsumed, true);
  assert.ok(logs.includes(
    "[browser] initial gameplay signal reopened closure capture label=countdown"
  ));
});

test("initial gameplay signal cannot repeatedly rearm after the follow-up scan is exhausted", async () => {
  const closureCaptureState = armedClosureCaptureState(21_000, { reason: "bot_on" });
  closureCaptureState.fullScanAttemptsInWindow = 2;
  closureCaptureState.scanBudgetExhausted = true;
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  let captureCalls = 0;
  const captureGameFn = async () => {
    captureCalls += 1;
    closureCaptureState.fullScanAttemptsInWindow = 2;
    return {
      ok: false,
      reason: "TETR.IO active game variable was not in paused scopes",
      outcome: "completed_not_found"
    };
  };
  const baseOptions = {
    probePageState: true,
    initialCaptureSignalProbe: true,
    suppressClosureCapture: false,
    network: { lastCaptureAt: 0, lastPageProbeAt: 0 },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(21_000),
    browserControlState,
    closureCaptureState,
    readCheapGameSignalFn: async () => ({
      active: true,
      source: "gameplay_dom",
      label: "playing"
    }),
    captureGameFn,
    log: () => {}
  };

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    ...baseOptions,
    now: 21_000
  });
  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    ...baseOptions,
    now: 21_500
  });

  assert.equal(captureCalls, 1);
  assert.equal(closureCaptureState.initialGameplaySignalRearmConsumed, true);
  assert.equal(closureCaptureState.armedUntil, 0);
});

test("VS sim ON but round inactive still probes after cooldown", async () => {
  const cdp = createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" },
    {
      ok: true,
      ready: true,
      playing: true,
      countdown: false,
      pieceCounter: 1,
      current: "o",
      hold: null,
      queue: ["s", "z"]
    }
  ]);
  let captureCalls = 0;

  const state = await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    network: { lastPageProbeAt: 0 },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(),
    closureCaptureState: armedClosureCaptureState(20_000),
    now: 20_000,
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    }
  });

  assert.equal(
    isBootstrapReadyForClosureCapture(readyBootstrapState(20_000), 20_000),
    true
  );
  assert.equal(captureCalls, 1);
  assert.equal(state.ok, true);
});

test("capture success disarms Bot On arming so heavy capture does not repeat", async () => {
  const controlState = createBrowserControlState();
  const closureCaptureState = createClosureCaptureState();
  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: true },
    controlState,
    closureCaptureState,
    now: 20_000,
    log: () => {}
  });
  let captureCalls = 0;
  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" },
    {
      ok: true,
      ready: true,
      playing: true,
      countdown: false,
      pieceCounter: 0,
      current: "t",
      hold: null,
      queue: ["i", "o"]
    }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    network: { lastPageProbeAt: 0 },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(),
    closureCaptureState,
    now: 20_000,
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    },
    log: () => {}
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(29_000),
    closureCaptureState,
    now: 29_000,
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    },
    log: () => {}
  });

  assert.equal(captureCalls, 1);
});

test("same ended object reactivating to playing is treated as the next game", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const endedGameCandidate = createEndedGameCandidateState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  endedGameCandidate.objectId = "ended-object-1";
  endedGameCandidate.epoch = 1;
  endedGameCandidate.lastPieceCounter = 26;
  endedGameCandidate.lastSignature = "26|t|-|i,o";
  startNextGameReacquire(nextGameReacquireState, {
    now: 40_000,
    epoch: 1,
    locator: "closure:Ai",
    log: (line) => logs.push(line)
  });
  let heavyCaptureCalls = 0;

  const state = await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(40_000),
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate,
    waitingForNextGame: true,
    now: 40_000,
    log: (line) => logs.push(line),
    readEndedGameCandidateStateFn: async () => ({
      status: "valid_playing",
      reactivated: true,
      state: {
        ok: true,
        ready: true,
        playing: true,
        countdown: false,
        field: createBoard(),
        current: "t",
        hold: null,
        queue: ["i", "o"],
        b2b: false,
        combo: 0,
        incoming: 0,
        pieceCounter: 0
      }
    }),
    captureGameFn: async () => {
      heavyCaptureCalls += 1;
      return { ok: false, reason: "should not run" };
    }
  });

  assert.equal(state.ok, true);
  assert.equal(state.playing, true);
  assert.equal(heavyCaptureCalls, 0);
  assert.ok(logs.includes("[browser] ended game object probe scheduled object_id_present=true"));
  assert.ok(logs.includes("[browser] ended game object probe status=valid_playing"));
  assert.ok(logs.includes("[browser] ended game object reactivated epoch=1->2"));
});

test("same ended object remaining ended does not start a heavy scan", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const endedGameCandidate = createEndedGameCandidateState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  endedGameCandidate.objectId = "ended-object-1";
  endedGameCandidate.epoch = 1;
  endedGameCandidate.lastPieceCounter = 26;
  startNextGameReacquire(nextGameReacquireState, {
    now: 50_000,
    epoch: 1,
    locator: "closure:Ai",
    log: () => {}
  });
  let heavyCaptureCalls = 0;

  const state = await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(50_000),
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate,
    waitingForNextGame: true,
    now: 50_000,
    log: (line) => logs.push(line),
    readEndedGameCandidateStateFn: async () => ({ status: "valid_ended" }),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: [{ source: "result_dom", value: true, state: "result" }]
    }),
    captureGameFn: async () => {
      heavyCaptureCalls += 1;
      return { ok: false, reason: "should not run" };
    }
  });

  assert.equal(state.ok, false);
  assert.equal(heavyCaptureCalls, 0);
  assert.ok(logs.includes("[browser] ended game object probe status=valid_ended"));
  assert.equal(
    logs.some((line) => line.startsWith("[browser] full closure scan attempt=")),
    false
  );
});

test("ended object probe interval skip logs its guard reason", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const endedGameCandidate = createEndedGameCandidateState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  endedGameCandidate.objectId = "ended-object-1";
  nextGameReacquireState.active = true;
  nextGameReacquireState.lastEndedObjectCheckAt = 80_000;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(80_100),
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate,
    waitingForNextGame: true,
    verboseReacquireLogs: true,
    now: 80_100,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "inactive",
      sources: []
    }),
    captureGameFn: async () => ({ ok: false, reason: "should not run" })
  });

  assert.ok(logs.includes("[browser] ended game object probe skipped reason=interval_wait"));
});

test("object released falls back to cheap signal false->true and arms once", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const endedGameCandidate = createEndedGameCandidateState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  endedGameCandidate.objectId = "ended-object-1";
  startNextGameReacquire(nextGameReacquireState, {
    now: 60_000,
    epoch: 1,
    locator: "",
    log: () => {}
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 60_000, seed: null },
    probeState: { lastCaptureAt: 60_000, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(60_000),
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate,
    waitingForNextGame: true,
    now: 60_000,
    log: (line) => logs.push(line),
    readEndedGameCandidateStateFn: async () => ({ status: "object_released" }),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: [{ source: "result_dom", value: true, state: "result" }]
    }),
    captureGameFn: async () => ({ ok: false, reason: "hidden" })
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 60_000, seed: null },
    probeState: { lastCaptureAt: 60_000, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(60_400),
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate,
    waitingForNextGame: true,
    now: 60_400,
    log: (line) => logs.push(line),
    readEndedGameCandidateStateFn: async () => ({ status: "object_released" }),
    readCheapGameSignalFn: async () => ({
      active: true,
      source: "countdown_dom",
      label: "countdown",
      sources: [{ source: "countdown_dom", value: true, state: "countdown" }]
    }),
    captureGameFn: async () => ({ ok: false, reason: "hidden" })
  });

  assert.equal(
    logs.filter((line) => line === "[browser] cheap game signal transition inactive->playing source=countdown_dom").length,
    1
  );
  assert.equal(
    logs.filter((line) => line === "[browser] closure capture armed reason=next_game_cheap_signal").length,
    1
  );
  assert.equal(endedGameCandidate.objectId, "");
});

test("reacquire active arms one interaction-based capture window and delays the first full scan", async () => {
  const logs = [];
  let captureCalls = 0;
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const endedGameCandidate = createEndedGameCandidateState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  nextGameReacquireState.active = true;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(90_000),
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate,
    waitingForNextGame: true,
    now: 90_000,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: [{ source: "result_dom", value: true, state: "result" }]
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 1,
      type: "click",
      timestamp: 90_000,
      targetTag: "BUTTON",
      targetId: "retry",
      targetClass: "cta"
    }),
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: false, reason: "should not run yet" };
    }
  });

  assert.equal(captureCalls, 0);
  assert.equal(closureCaptureState.armedReason, "next_game_user_interaction");
  assert.equal(closureCaptureState.nextAttemptAt, 90_300);
  assert.ok(
    logs.includes("[browser] closure capture armed reason=next_game_user_interaction generation=1")
  );
});

test("pending retry interaction is preserved while an older interaction window is already armed", async () => {
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  startNextGameReacquire(nextGameReacquireState, {
    now: 93_000,
    epoch: 1,
    interactionBaselineGeneration: 5,
    log: () => {}
  });
  armClosureCaptureWindow(closureCaptureState, {
    reason: "next_game_user_interaction",
    now: 93_050,
    log: () => {}
  });
  closureCaptureState.nextAttemptAt = 93_350;
  nextGameReacquireState.lastInteractionGenerationHandled = 5;
  const bootstrapState = readyBootstrapState(93_100);
  bootstrapState.lastReady = true;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState,
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 93_100,
    log: () => {},
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 6,
      timestamp: 93_090,
      type: "click",
      targetTag: "BUTTON",
      targetId: "retry",
      targetClass: "cta"
    }),
    captureGameFn: async () => ({ ok: false, reason: "should not run" })
  });

  assert.equal(nextGameReacquireState.lastInteractionGenerationHandled, 5);
  assert.equal(nextGameReacquireState.pendingInteractionGeneration, 6);
  assert.equal(closureCaptureState.nextAttemptAt, 93_350);
});

test("pending retry interaction can reopen a one-shot window after the old window expires", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  startNextGameReacquire(nextGameReacquireState, {
    now: 94_000,
    epoch: 1,
    interactionBaselineGeneration: 5,
    log: () => {}
  });
  nextGameReacquireState.pendingInteractionGeneration = 6;
  nextGameReacquireState.pendingInteractionTimestamp = 94_100;
  nextGameReacquireState.pendingInteractionType = "click";
  nextGameReacquireState.pendingInteractionTargetTag = "BUTTON";
  nextGameReacquireState.pendingInteractionTargetId = "retry";
  nextGameReacquireState.pendingInteractionTargetClass = "cta";
  const bootstrapState = readyBootstrapState(94_500);
  bootstrapState.lastReady = true;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState,
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 94_500,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 6,
      timestamp: 94_100,
      type: "click",
      targetTag: "BUTTON",
      targetId: "retry",
      targetClass: "cta"
    }),
    captureGameFn: async () => ({ ok: false, reason: "should not run" })
  });

  assert.equal(nextGameReacquireState.lastInteractionGenerationHandled, 6);
  assert.equal(nextGameReacquireState.pendingInteractionGeneration, 0);
  assert.equal(closureCaptureState.armedReason, "next_game_user_interaction");
  assert.equal(closureCaptureState.nextAttemptAt, 94_800);
  assert.ok(
    logs.includes("[browser] closure capture armed reason=next_game_user_interaction generation=6")
  );
});

test("same interaction generation does not rearm or reset the interaction window", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const endedGameCandidate = createEndedGameCandidateState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  nextGameReacquireState.active = true;
  nextGameReacquireState.lastInteractionGenerationHandled = 1;
  nextGameReacquireState.lastInteractionGenerationSeen = 1;
  nextGameReacquireState.interactionWindowGeneration = 1;
  armClosureCaptureWindow(closureCaptureState, {
    reason: "next_game_user_interaction",
    now: 91_000,
    log: () => {}
  });
  closureCaptureState.nextAttemptAt = 91_300;
  const initialArmedUntil = closureCaptureState.armedUntil;

  const bootstrapState = readyBootstrapState(91_250);
  bootstrapState.lastReady = true;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState,
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate,
    waitingForNextGame: true,
    now: 91_250,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 1,
      type: "click",
      timestamp: 91_250,
      targetTag: "BUTTON",
      targetId: "retry",
      targetClass: "cta"
    }),
    captureGameFn: async () => ({ ok: false, reason: "still hidden" })
  });

  assert.equal(closureCaptureState.armedUntil, initialArmedUntil);
  assert.equal(closureCaptureState.nextAttemptAt, 91_300);
  assert.equal(
    logs.filter((line) => line.includes("reason=next_game_user_interaction")).length,
    0
  );
});

test("interaction fallback waits 150ms before the second full scan continuation", async () => {
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  startNextGameReacquire(nextGameReacquireState, {
    now: 95_000,
    epoch: 1,
    interactionBaselineGeneration: 5,
    log: () => {}
  });
  armClosureCaptureWindow(closureCaptureState, {
    reason: "next_game_user_interaction",
    now: 95_000,
    log: () => {}
  });
  closureCaptureState.nextAttemptAt = 95_300;
  const bootstrapState = readyBootstrapState(95_300);
  bootstrapState.lastReady = true;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState,
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 95_300,
    log: () => {},
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    captureGameFn: async (_cdp, { closureCaptureState: captureState }) => {
      captureState.fullScanAttemptsInWindow = 1;
      return {
        ok: false,
        reason: "TETR.IO paused scope scan limit reached",
        outcome: "completed_not_found",
        windowBudgetExhausted: false
      };
    }
  });

  assert.equal(closureCaptureState.nextAttemptAt, 95_450);
});

test("completed_not_found uses a bounded continuation before the follow-up full scan", async () => {
  let captureCalls = 0;
  const pauseTimeouts = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  startNextGameReacquire(nextGameReacquireState, {
    now: 97_000,
    epoch: 1,
    interactionBaselineGeneration: 6,
    log: () => {}
  });
  armClosureCaptureWindow(closureCaptureState, {
    reason: "next_game_user_interaction",
    now: 97_000,
    log: () => {}
  });
  closureCaptureState.nextAttemptAt = 97_300;

  const captureGameFn = async (_cdp, options) => {
    captureCalls += 1;
    pauseTimeouts.push(options.pauseTimeoutMs);
    return captureCalls === 1
      ? {
          ok: false,
          reason: "TETR.IO paused scope scan limit reached",
          outcome: "completed_not_found",
          windowBudgetExhausted: false
        }
      : { ok: false, reason: "still hidden" };
  };

  const baseOptions = {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    log: () => {},
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    captureGameFn
  };

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    ...baseOptions,
    bootstrapState: readyBootstrapState(97_300),
    now: 97_300
  });
  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    ...baseOptions,
    bootstrapState: readyBootstrapState(98_000),
    now: 98_000
  });
  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    ...baseOptions,
    bootstrapState: readyBootstrapState(98_100),
    now: 98_100
  });

  assert.equal(captureCalls, 2);
  assert.deepEqual(pauseTimeouts, [900, 900]);
});

test("reacquire inactive ignores interaction generations and keeps heavy scan at zero", async () => {
  let captureCalls = 0;
  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(92_000),
    browserControlState: { botEnabled: true },
    closureCaptureState: createClosureCaptureState(),
    nextGameReacquireState: createNextGameReacquireState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 92_000,
    readNextGameInteractionStateFn: async () => ({
      generation: 4,
      type: "click",
      timestamp: 92_000,
      targetTag: "BUTTON",
      targetId: "retry",
      targetClass: "cta"
    }),
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: false, reason: "should not run" };
    }
  });

  assert.equal(captureCalls, 0);
});

test("steady-state polls do not invoke the interaction tracker installer", async () => {
  const cdp = createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" },
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]);

  await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(96_500),
    browserControlState: { botEnabled: true },
    closureCaptureState: createClosureCaptureState(),
    nextGameReacquireState: createNextGameReacquireState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 96_500
  });
  await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(97_000),
    browserControlState: { botEnabled: true },
    closureCaptureState: createClosureCaptureState(),
    nextGameReacquireState: createNextGameReacquireState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 97_000
  });

  assert.equal(
    cdp.runtimeCalls.some((call) =>
      String(call.expression).includes("__fusionNextGameInteractionTrackerInstalled")
    ),
    false
  );
});

test("interaction tracker registers future documents once and reinstalls for the current document", async () => {
  const calls = [];
  const cdp = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: {
              ok: true,
              installed: true
            }
          }
        };
      }
      return {};
    }
  };
  const installState = createInteractionTrackerInstallState();

  await ensureNextGameInteractionTrackerInstalled(cdp, installState, {
    log: () => {}
  });
  await ensureNextGameInteractionTrackerInstalled(cdp, installState, {
    log: () => {}
  });

  assert.equal(
    calls.filter((call) => call.method === "Page.addScriptToEvaluateOnNewDocument").length,
    1
  );
  assert.equal(
    calls.filter((call) => call.method === "Runtime.evaluate").length,
    2
  );
});

test("lobby polling without interactions keeps heavy scan at zero for 60 seconds", async () => {
  let captureCalls = 0;
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  startNextGameReacquire(nextGameReacquireState, {
    now: 98_000,
    epoch: 1,
    interactionBaselineGeneration: 5,
    log: () => {}
  });

  for (let second = 0; second < 60; second += 1) {
    await readTetrioState(createReadStateCdp([
      { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
    ]), {
      probePageState: true,
      suppressClosureCapture: false,
      useSeedSimulationFallback: false,
      network: { lastPageProbeAt: 0, seed: null },
      probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
      bootstrapState: readyBootstrapState(98_000 + second * 1000),
      browserControlState,
      closureCaptureState,
      nextGameReacquireState,
      endedGameCandidate: createEndedGameCandidateState(),
      waitingForNextGame: true,
      now: 98_000 + second * 1000,
      log: () => {},
      readCheapGameSignalFn: async () => ({
        active: false,
        source: "none",
        label: "inactive",
        sources: []
      }),
      readNextGameInteractionStateFn: async () => ({
        generation: 5,
        timestamp: 97_000,
        type: "click",
        targetTag: "BUTTON",
        targetId: "retry",
        targetClass: "cta"
      }),
      captureGameFn: async () => {
        captureCalls += 1;
        return { ok: false, reason: "should not run" };
      }
    });
  }

  assert.equal(captureCalls, 0);
});

test("Bot OFF cancels next-game reacquire", () => {
  const logs = [];
  const controlState = createBrowserControlState();
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  controlState.botEnabled = true;
  nextGameReacquireState.active = true;

  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: false },
    controlState,
    closureCaptureState,
    nextGameReacquireState,
    now: 70_000,
    log: (line) => logs.push(line)
  });

  assert.equal(controlState.botEnabled, false);
  assert.equal(nextGameReacquireState.active, false);
  assert.ok(logs.includes("[browser] next-game reacquire cancelled reason=bot_off"));
});

test("VS sim ON with active round suppresses closure capture for ten seconds", async () => {
  const cdp = createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]);
  let captureCalls = 0;

  const state = await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: true,
    suppressedReason: "VS WebSocket simulation owns live state",
    network: { lastPageProbeAt: 0 },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(),
    now: 20_000,
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    }
  });

  assert.equal(captureCalls, 0);
  assert.equal(state.reason, "VS WebSocket simulation owns live state");
});

test("suppression keeps cheap state reads active", async () => {
  let reads = 0;
  const cdp = {
    async send(method) {
      assert.equal(method, "Runtime.evaluate");
      reads += 1;
      return {
        result: {
          value: {
            ok: false,
            ready: false,
            reason: "TETR.IO game instance not captured yet"
          }
        }
      };
    }
  };

  await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: true,
    suppressedReason: "VS WebSocket simulation owns live state",
    network: { lastPageProbeAt: 0 },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(),
    now: 20_000,
    captureGameFn: async () => {
      throw new Error("should not capture");
    }
  });

  assert.equal(reads, 2);
});

test("document.readyState=loading keeps closure capture disabled", async () => {
  let captureCalls = 0;
  const cdp = {
    async send(method, params = {}) {
      assert.equal(method, "Runtime.evaluate");
      if (String(params.expression).includes("document.readyState")) {
        return {
          result: {
            value: {
              readyState: "loading",
              href: "https://tetr.io/"
            }
          }
        };
      }
      return {
        result: {
          value: {
            ok: false,
            ready: false,
            reason: "TETR.IO game instance not captured yet"
          }
        }
      };
    }
  };

  await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: createBootstrapState(0),
    now: 1_000,
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    }
  });

  assert.equal(captureCalls, 0);
});

test("document complete before websocket keeps closure capture disabled", async () => {
  let captureCalls = 0;
  const bootstrapState = createBootstrapState(0);
  updateBootstrapDocumentState(
    bootstrapState,
    { readyState: "complete", href: "https://tetr.io/" },
    100
  );
  const cdp = createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]);

  await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0 },
    bootstrapState,
    now: 1_000,
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    }
  });

  assert.equal(captureCalls, 0);
});

test("repeated lobby evaluation never allows closure capture without gameplay expectation", async () => {
  let captureCalls = 0;
  const closureCaptureState = createClosureCaptureState();
  const cdp = createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" },
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" },
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]);

  for (const now of [70_000, 73_000, 76_000]) {
    await readTetrioState(cdp, {
      probePageState: true,
      suppressClosureCapture: false,
      useSeedSimulationFallback: false,
      network: { lastPageProbeAt: 0, seed: null },
      probeState: { lastCaptureAt: 0 },
      bootstrapState: readyBootstrapState(now),
      closureCaptureState,
      now,
      log: () => {},
      captureGameFn: async () => {
        captureCalls += 1;
        return { ok: true, source: "closure:Ai" };
      }
    });
  }

  assert.equal(captureCalls, 0);
});

test("websocket bootstrap waits until 1499ms before enabling capture", async () => {
  let captureCalls = 0;
  const cdp = createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]);

  await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(19_999, { transportReadyAt: 18_501 }),
    now: 19_999,
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    }
  });

  assert.equal(
    isBootstrapReadyForClosureCapture(
      readyBootstrapState(19_999, { transportReadyAt: 18_501 }),
      19_999
    ),
    false
  );
  assert.equal(captureCalls, 0);
});

test("websocket bootstrap enables capture after 1500ms", async () => {
  let captureCalls = 0;
  const cdp = createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" },
    {
      ok: true,
      ready: true,
      playing: true,
      countdown: false,
      pieceCounter: 0,
      current: "t",
      hold: null,
      queue: ["i", "o"]
    }
  ]);

  await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(20_000, { transportReadyAt: 18_500 }),
    closureCaptureState: armedClosureCaptureState(20_000),
    now: 20_000,
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    }
  });

  assert.equal(captureCalls, 1);
});

test("bootstrap falls back to connectedAt after 15 seconds without websocket", async () => {
  let captureCalls = 0;
  const bootstrapState = createBootstrapState(0);
  updateBootstrapDocumentState(
    bootstrapState,
    { readyState: "complete", href: "https://tetr.io/" },
    100
  );
  const cdp = createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" },
    {
      ok: true,
      ready: true,
      playing: true,
      countdown: false,
      pieceCounter: 0,
      current: "t",
      hold: null,
      queue: ["i", "o"]
    }
  ]);

  await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0 },
    bootstrapState,
    closureCaptureState: armedClosureCaptureState(15_000),
    now: 15_000,
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    }
  });

  assert.equal(captureCalls, 1);
});

test("navigation resets bootstrap gating before capture can run again", async () => {
  const bootstrapState = readyBootstrapState();
  resetBootstrapState(bootstrapState, { resetConnectedAt: true, now: 30_000 });
  assert.equal(isBootstrapReadyForClosureCapture(bootstrapState, 31_000), false);
});

test("ended cached game is not selected again when a fresh game is available", () => {
  const endedGame = createGame({
    destroyed: true,
    playing: false,
    current: "t",
    pieceCounter: 8
  });
  const freshGame = createGame({
    current: "o",
    hold: "l",
    queue: ["i", "s"],
    pieceCounter: 0
  });

  const { result, window } = evaluateInWindow(tetrioStateExpression(), {
    __fusionTetrioGame: endedGame,
    __fusionEndedTetrioGame: endedGame,
    game: freshGame
  });

  assert.equal(result.ok, true);
  assert.equal(result.current, "o");
  assert.equal(window.__fusionTetrioGame, freshGame);
  assert.equal(window.__fusionEndedTetrioGame, endedGame);
});

test("same object reused for a new game becomes selectable again", () => {
  const reusedGame = createGame({
    destroyed: false,
    current: "s",
    hold: "z",
    queue: ["i", "o"],
    pieceCounter: 0
  });

  const { result, window } = evaluateInWindow(tetrioStateExpression(), {
    __fusionEndedTetrioGame: reusedGame
  });

  assert.equal(result.ok, true);
  assert.equal(result.current, "s");
  assert.equal(window.__fusionTetrioGame, reusedGame);
  assert.equal(Object.hasOwn(window, "__fusionEndedTetrioGame"), false);
});

test("closure exposure skips the ended cached object", () => {
  const endedGame = createGame({
    destroyed: true,
    playing: false
  });

  const { result, window } = evaluateInWindow(
    pausedFrameExposureExpression(),
    {
      __fusionEndedTetrioGame: endedGame
    },
    {
      Ai: endedGame
    }
  );

  assert.equal(result.ok, false);
  assert.equal(Object.hasOwn(window, "__fusionTetrioGame"), false);
});

test("closure exposure allows a reused object once it is no longer ended", () => {
  const reusedGame = createGame({
    destroyed: false,
    current: "i"
  });

  const { result, window } = evaluateInWindow(
    pausedFrameExposureExpression(),
    {
      __fusionEndedTetrioGame: reusedGame
    },
    {
      Ai: reusedGame
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.source, "closure:Ai");
  assert.equal(window.__fusionTetrioGame, reusedGame);
  assert.equal(Object.hasOwn(window, "__fusionEndedTetrioGame"), false);
});

test("captureTetrioGame source still keeps raf and setTimeout breakpoints", () => {
  const source = readFileSync(
    new URL("./tetrio-cdp-source.mjs", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /for \(const expression of \["window\.requestAnimationFrame", "window\.setTimeout"\]\)/
  );
});

test("passive bridge producer remains installed in connect_only mode", () => {
  const source = readFileSync(
    new URL("./tetrio-cdp-source.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /const connectOnly = args\.connectOnly === "1";/);
  assert.match(source, /dddWsObserverCleanup = await installDddWsObserver\(cdp, \{/);
  assert.doesNotMatch(source, /if \(!connectOnly\)\s*\{[\s\S]{0,400}installDddWsObserver/);
});

test("page session probe lifecycle is wired to target reset and bootstrap ready", () => {
  const source = readFileSync(
    new URL("./tetrio-cdp-source.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /notifyObserverTargetReset\("initial_target_state"\);/);
  assert.match(
    source,
    /notifyObserverTargetReset\(\s*resetConnectedAt \? "page_navigation" : "execution_context_reset"\s*\);/
  );
  assert.match(source, /onBootstrapReady: notifyObserverBootstrapReady/);
  assert.match(source, /options\.onBootstrapReady\?\.\(\);/);
});

test("zenith ribbon seeds do not create Solo generations", () => {
  const source = readFileSync(
    new URL("./tetrio-cdp-source.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /if \(isZenithGameplayOptions\(options\)\) \{\s*return;\s*\}/);
});
