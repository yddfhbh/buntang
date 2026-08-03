import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_PORT,
  DEFAULT_URL,
  isCdpOpen,
  launchChromium,
  shutdownChromium,
  waitForCdpReady
} from "./chromium-launch.mjs";

const DEFAULT_NEXT_COUNT = 6;
const DEFAULT_STATUS_MS = 2500;
const DEFAULT_CAPTURE_COOLDOWN_MS = 2000;
const DEFAULT_CAPTURE_ARMING_WINDOW_MS = 8000;
const DEFAULT_CAPTURE_SKIP_LOG_INTERVAL_MS = 60000;
const DEFAULT_CAPTURE_RETRY_SCHEDULE_MS = [750, 1000, 1500, 1500];
const DEFAULT_FULL_SCAN_PAUSE_BUDGET_MS = 350;
const DEFAULT_FULL_SCAN_CUMULATIVE_BUDGET_MS = 700;
const DEFAULT_FULL_SCAN_CONTINUATION_BACKOFF_MS = 100;
const DEFAULT_FIRST_FULL_SCAN_CONTINUATION_BACKOFF_MS = 150;
const DEFAULT_BOOTSTRAP_BLOCKED_LOG_INTERVAL_MS = 5000;
const DEFAULT_GAME_START_SIGNAL_OVERLAP_MS = 10000;
const DEFAULT_NEXT_GAME_FAST_LOCATOR_INTERVAL_MS = 350;
const DEFAULT_NEXT_GAME_FAST_LOCATOR_MISS_LOG_INTERVAL_MS = 5000;
const DEFAULT_NEXT_GAME_INTERACTION_POLL_MS = 75;
const DEFAULT_NEXT_GAME_INTERACTION_BURST_DEDUPE_MS = 150;
const DEFAULT_INITIAL_GAMEPLAY_SIGNAL_INTERVAL_MS = 350;
const DEFAULT_NEXT_GAME_INTERACTION_CAPTURE_DELAY_MS = 300;
const DEFAULT_TARGETED_PAUSED_PROBE_DELAY_MS = 450;
const DEFAULT_TARGETED_PAUSED_PROBE_BACKOFF_MS = 800;
const DEFAULT_FOLLOWUP_FAST_CAPTURE_TIMEOUT_MS = 100;
const DEFAULT_AGAIN_PROVISIONAL_HARD_FALLBACK_MS = 1200;
const DEFAULT_ZENITH_BOOTSTRAP_RETRY_MS = 250;
const DEFAULT_ZENITH_BOOTSTRAP_MAX_ATTEMPTS = 5;
const MAX_GAME_START_SIGNALS = 16;
const MAX_FULL_SCAN_ATTEMPTS_PER_WINDOW = 2;
const MAX_PAUSED_SCOPE_SCAN_CANDIDATES_PER_ATTEMPT = 400;
const MAX_SCOPE_PROPERTIES_PER_SCOPE = 80;
const DEFAULT_SUPPRESSED_REASON = "VS WebSocket simulation owns live state";
const PERF_LOG_INTERVAL_MS = 2000;
const DEFAULT_BOOTSTRAP_TRANSPORT_SETTLE_MS = 1500;
const DEFAULT_BOOTSTRAP_FALLBACK_MS = 15000;
const DEFAULT_QUICK_PLAY_DIAGNOSTIC_DURATION_MS = 20_000;
const DEFAULT_QUICK_PLAY_DIAGNOSTIC_PACKET_LIMIT = 250;
const DEFAULT_QUICK_PLAY_SESSION_SURVEY_INTERVAL_MS = 1000;
const DEFAULT_QUICK_PLAY_CLOSURE_SURVEY_INTERVAL_MS = 500;
const DEFAULT_QUICK_PLAY_CLOSURE_SCAN_MAX_ATTEMPTS = 5;
const DEFAULT_QUICK_PLAY_CLOSURE_SCAN_MAX_NONPRODUCTIVE_ATTEMPTS = 10;
const DEFAULT_QUICK_PLAY_CLOSURE_SCAN_MAX_RAW_CANDIDATES = 200;
const DEFAULT_QUICK_PLAY_CLOSURE_SCAN_PAUSE_TIMEOUT_MS = 700;
const DEFAULT_QUICK_PLAY_CLOSURE_SCAN_PAUSE_BUDGET_MS = 250;
const DEFAULT_QUICK_PLAY_CLOSURE_RETRY_BACKOFF_MS = [80, 160, 280, 450, 700, 1000];
const DEFAULT_QUICK_PLAY_CLOSURE_RETRY_JITTER_MS = 30;
const DEFAULT_QUICK_PLAY_REPORT_PATH = path.join(
  "automation",
  "quick-play-runtime-report.json"
);
const DEFAULT_QUICK_PLAY_WS_RAW_PATH = path.join(
  "automation",
  "quick-play-ws-raw.jsonl"
);
const DEFAULT_QUICK_PLAY_CLOSURE_PATH = path.join(
  "automation",
  "quick-play-closure-candidates.jsonl"
);
const DEFAULT_QUICK_PLAY_CALLFRAME_PATH = path.join(
  "automation",
  "quick-play-callframes.jsonl"
);
const DEFAULT_QUICK_PLAY_PASSIVE_SNAPSHOT_PATH = path.join(
  "automation",
  "quick-play-passive-snapshot.json"
);
const DEFAULT_SOLO_CLOSURE_FINGERPRINT_PATH = path.join(
  "automation",
  "solo-closure-fingerprint.json"
);
const QUICK_PLAY_OWNER_MANUAL_DIAGNOSTIC = "manual_diagnostic";
const QUICK_PLAY_OWNER_ZENITH_DRY_RUN = "zenith_dry_run";
export const RUNTIME_MODE_SOLO = "solo";
export const RUNTIME_MODE_ZENITH = "zenith";
export const RUNTIME_MODE_FRIENDLY_VS = "friendly_vs";
const NEXT_GAME_INTERACTION_PHASE_INACTIVE = "inactive";
const NEXT_GAME_INTERACTION_PHASE_POST_GAME_WATCH = "post_game_watch";
const NEXT_GAME_INTERACTION_PHASE_REACQUIRING = "reacquiring";
const NEXT_GAME_INTERACTION_PHASE_WAITING_TRANSITION_READY = "waiting_transition_ready";
const NEXT_GAME_INTERACTION_PHASE_CAPTURE_ARMED = "capture_armed";
const NEXT_GAME_INTERACTION_PHASE_CAPTURED_WAITING_START = "captured_waiting_start";

export function determineChromiumOwnership({ connectOnly, alreadyOpen }) {
  return !connectOnly && !alreadyOpen;
}

export function createSnapshotTracking() {
  return {
    stableSignature: "",
    stableCount: 0,
    lastWrittenSignature: "",
    lastLoggedToken: "",
    pendingPieceKey: "",
    pendingPieceDetectedAt: 0,
    lastPerfLoggedPieceKey: ""
  };
}

export function resetSnapshotTracking(tracking) {
  tracking.stableSignature = "";
  tracking.stableCount = 0;
  tracking.lastWrittenSignature = "";
  tracking.lastLoggedToken = "";
  tracking.pendingPieceKey = "";
  tracking.pendingPieceDetectedAt = 0;
  tracking.lastPerfLoggedPieceKey = "";
  return tracking;
}

export function buildSnapshotSignature(gameEpoch, state) {
  const queueText = state.queue.join(",");
  return `${gameEpoch}|${state.pieceCounter}|${state.current}|${state.hold ?? "-"}|${queueText}|${state.activeX ?? "-"}|${state.activeY ?? "-"}|${state.activeRotation ?? "-"}`;
}

export function buildSnapshotToken(gameEpoch, pieceCounter) {
  return `browser-${gameEpoch}-${pieceCounter}`;
}

export function resolvePollMs(args) {
  return numberArg(args.pollMs, 8);
}

export function resolveUseSeedSimulationFallback(
  requestedValue,
  env = process.env
) {
  return requestedValue && env?.FUSION_VS_WS_SIM !== "1";
}

export function isVsWsSimEnvEnabled(env = process.env) {
  return env?.FUSION_VS_WS_SIM === "1";
}

export function isZenithGameplayOptions(options) {
  const bagtype = String(options?.bagtype ?? "")
    .trim()
    .toLowerCase();
  return bagtype === "zenith";
}

export function normalizeRuntimeMode(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === RUNTIME_MODE_ZENITH) {
    return RUNTIME_MODE_ZENITH;
  }
  if (normalized === RUNTIME_MODE_FRIENDLY_VS) {
    return RUNTIME_MODE_FRIENDLY_VS;
  }
  return RUNTIME_MODE_SOLO;
}

export function isSoloModeSelected(controlState) {
  return normalizeRuntimeMode(controlState?.selectedMode) === RUNTIME_MODE_SOLO;
}

export function isZenithModeSelected(controlState) {
  return normalizeRuntimeMode(controlState?.selectedMode) === RUNTIME_MODE_ZENITH;
}

export function isFriendlyVsModeSelected(controlState) {
  return (
    normalizeRuntimeMode(controlState?.selectedMode) ===
    RUNTIME_MODE_FRIENDLY_VS
  );
}

export function isSoloModeActive(controlState) {
  return Boolean(controlState?.botEnabled) && isSoloModeSelected(controlState);
}

export function isZenithModeActive(controlState) {
  return Boolean(controlState?.botEnabled) && isZenithModeSelected(controlState);
}

export function shouldAttemptClosureCapture({
  probePageState,
  suppressClosureCapture,
  bootstrapReady = true,
  stateOk,
  gameplayExpected = false,
  nextAttemptAt = null,
  lastCaptureAt = 0,
  lastPageProbeAt = 0,
  now = Date.now(),
  cooldownMs = DEFAULT_CAPTURE_COOLDOWN_MS
}) {
  const retryReady =
    Number.isFinite(nextAttemptAt) && nextAttemptAt !== null
      ? now >= nextAttemptAt
      : now - lastCaptureAt >= cooldownMs &&
        now - lastPageProbeAt >= cooldownMs;
  return Boolean(
    probePageState &&
      gameplayExpected &&
      !suppressClosureCapture &&
      bootstrapReady &&
      !stateOk &&
      retryReady
  );
}

export function createClosureCaptureState() {
  return {
    armedUntil: 0,
    armedReason: "",
    lastSkippedLogAt: 0,
    nextAttemptAt: 0,
    retryCount: 0,
    lastSuccessfulLocator: "",
    pendingCaptureArm: null,
    firstAttemptLoggedForReason: "",
    captureAttemptsInWindow: 0,
    fullScanAttemptsInWindow: 0,
    cumulativePausedScanBudgetUsedMs: 0,
    pausedScopeScanCursor: null,
    windowSequence: 0,
    scanBudgetExhausted: false,
    fastLocatorAttempted: false,
    lastSuccessfulPausedLocation: null,
    pendingFollowupFullScan: false,
    pendingFollowupFastCapture: false,
    windowArmedAt: 0,
    windowFirstInteractionAt: 0,
    windowTargetedProbeAt: 0,
    soloClosureFingerprintPath: DEFAULT_SOLO_CLOSURE_FINGERPRINT_PATH,
    provisionalNonHeavyAttemptConsumed: false,
    initialGameplayProbeAt: 0,
    initialGameplaySignalActive: false,
    initialGameplaySignalLabel: "",
    initialGameplaySignalRearmConsumed: false,
    captureTiming: createClosureCaptureTimingState()
  };
}

function resetInitialGameplayCaptureProbeState(closureCaptureState) {
  if (!closureCaptureState) {
    return false;
  }
  closureCaptureState.initialGameplayProbeAt = 0;
  closureCaptureState.initialGameplaySignalActive = false;
  closureCaptureState.initialGameplaySignalLabel = "";
  closureCaptureState.initialGameplaySignalRearmConsumed = false;
  return true;
}

function createClosureCaptureTimingState() {
  return {
    armedAt: 0,
    retryWaitActive: false,
    retryWaitStartAt: 0,
    firstFastProbeStartAt: 0,
    firstFastProbeEndAt: 0,
    firstFullScanStartAt: 0,
    firstFullScanEndAt: 0,
    secondFullScanStartAt: 0,
    secondFullScanEndAt: 0,
    captureSuccessAt: 0
  };
}

function resetClosureCaptureTiming(closureCaptureState, armedAt = 0) {
  if (!closureCaptureState) {
    return false;
  }
  closureCaptureState.captureTiming = {
    ...createClosureCaptureTimingState(),
    armedAt: Math.max(0, Number(armedAt ?? 0))
  };
  return true;
}

function logClosureTimingStage(
  closureCaptureState,
  stage,
  {
    phase = "end",
    startAt = 0,
    endAt = Date.now(),
    log = console.log,
    details = null
  } = {}
) {
  if (typeof log !== "function" || !closureCaptureState) {
    return;
  }
  const timing = closureCaptureState.captureTiming ?? createClosureCaptureTimingState();
  const armedAt = Math.max(
    0,
    Number(timing.armedAt ?? closureCaptureState.windowArmedAt ?? 0)
  );
  const normalizedStart = Math.max(0, Number(startAt ?? 0));
  const normalizedEnd = Math.max(0, Number(endAt ?? Date.now()));
  const elapsedFromArm = Math.max(0, normalizedEnd - armedAt);
  const duration = normalizedStart > 0
    ? Math.max(0, normalizedEnd - normalizedStart)
    : null;
  const detailText = details && typeof details === "object"
    ? Object.entries(details)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" ")
    : "";
  log(
    `[browser] closure timing stage=${stage} phase=${phase} elapsed_from_arm_ms=${elapsedFromArm}` +
      (duration === null ? "" : ` duration_ms=${duration}`) +
      (detailText ? ` ${detailText}` : "")
  );
}

function markClosureRetryWaitStart(
  closureCaptureState,
  now,
  delayMs,
  log = console.log
) {
  const timing = closureCaptureState?.captureTiming;
  if (!timing || timing.retryWaitActive) {
    return false;
  }
  const startAt = Math.max(0, Number(now ?? Date.now()));
  timing.retryWaitActive = true;
  timing.retryWaitStartAt = startAt;
  logClosureTimingStage(closureCaptureState, "retry_wait", {
    phase: "start",
    startAt,
    endAt: startAt,
    log,
    details: { delay_ms: Math.max(0, Number(delayMs ?? 0)) }
  });
  return true;
}

function markClosureRetryWaitEnd(closureCaptureState, now, log = console.log) {
  const timing = closureCaptureState?.captureTiming;
  if (!timing?.retryWaitActive) {
    return false;
  }
  const endAt = Math.max(0, Number(now ?? Date.now()));
  const startAt = timing.retryWaitStartAt;
  timing.retryWaitActive = false;
  logClosureTimingStage(closureCaptureState, "retry_wait", {
    phase: "end",
    startAt,
    endAt,
    log
  });
  return true;
}

function hasActiveClosureCaptureWindowState(closureCaptureState) {
  if (!closureCaptureState) {
    return false;
  }
  return Boolean(
    Number(closureCaptureState.armedUntil ?? 0) > 0 ||
      Number(closureCaptureState.captureAttemptsInWindow ?? 0) > 0 ||
      Number(closureCaptureState.fullScanAttemptsInWindow ?? 0) > 0 ||
      Number(closureCaptureState.cumulativePausedScanBudgetUsedMs ?? 0) > 0 ||
      closureCaptureState.pausedScopeScanCursor ||
      closureCaptureState.scanBudgetExhausted === true ||
      closureCaptureState.fastLocatorAttempted === true ||
      Number(closureCaptureState.nextAttemptAt ?? 0) > 0 ||
      Number(closureCaptureState.retryCount ?? 0) > 0 ||
      String(closureCaptureState.armedReason ?? "").trim() ||
      String(closureCaptureState.firstAttemptLoggedForReason ?? "").trim()
  );
}

function formatClosureWindowResetReason(reason = "") {
  if (reason === "next_game_carried_interaction") {
    return "carried interaction";
  }
  if (reason === "next_game_user_interaction") {
    return "next-game interaction";
  }
  return String(reason || "gameplay_signal");
}

export function initializeFreshClosureCaptureWindow(
  closureCaptureState,
  {
    reason = "gameplay_signal",
    log = console.log
  } = {}
) {
  if (!closureCaptureState) {
    return false;
  }
  const previousCaptureAttempts = Math.max(
    0,
    Number(closureCaptureState.captureAttemptsInWindow ?? 0)
  );
  const previousFullScanAttempts = Math.max(
    0,
    Number(closureCaptureState.fullScanAttemptsInWindow ?? 0)
  );
  const previousPausedUsedMs = Math.max(
    0,
    Number(closureCaptureState.cumulativePausedScanBudgetUsedMs ?? 0)
  );
  const hadActiveState = hasActiveClosureCaptureWindowState(closureCaptureState);
  if (hadActiveState && typeof log === "function") {
    log(
      `[browser] resetting closure window for ${formatClosureWindowResetReason(reason)} previous_capture_attempts=${previousCaptureAttempts} previous_full_scan_attempts=${previousFullScanAttempts} previous_paused_used_ms=${previousPausedUsedMs}`
    );
  }
  closureCaptureState.armedUntil = 0;
  closureCaptureState.armedReason = "";
  closureCaptureState.lastSkippedLogAt = 0;
  closureCaptureState.nextAttemptAt = 0;
  closureCaptureState.retryCount = 0;
  closureCaptureState.pendingCaptureArm = null;
  closureCaptureState.firstAttemptLoggedForReason = "";
  closureCaptureState.captureAttemptsInWindow = 0;
  closureCaptureState.pendingFollowupFullScan = false;
  closureCaptureState.pendingFollowupFastCapture = false;
  closureCaptureState.windowArmedAt = 0;
  closureCaptureState.windowFirstInteractionAt = 0;
  closureCaptureState.windowTargetedProbeAt = 0;
  closureCaptureState.provisionalNonHeavyAttemptConsumed = false;
  resetClosureCaptureTiming(closureCaptureState);
  resetClosureCaptureScanWindowState(closureCaptureState, {
    nextAttemptAt: 0,
    cursor: createPausedScopeScanCursor()
  });
  return true;
}

export function createNextGameReacquireState() {
  return {
    active: false,
    interactionPhase: NEXT_GAME_INTERACTION_PHASE_INACTIVE,
    startedAt: 0,
    lastFastAttemptAt: 0,
    lastFastMissLoggedAt: 0,
    lastEndedObjectCheckAt: 0,
    lastEndedObjectProbeStatus: "",
    lastEndedObjectProbeLogAt: 0,
    lastCheapSignalState: false,
    lastCheapSignalLogAt: 0,
    lastCheapSignalLabel: "",
    lastCheapSampledAt: 0,
    lastCheapAggregateState: "",
    interactionBaselineGeneration: 0,
    lastInteractionGenerationSeen: 0,
    lastInteractionGenerationHandled: 0,
    interactionWindowGeneration: 0,
    interactionWindowArmedAt: 0,
    pendingInteractionGeneration: 0,
    pendingInteractionTimestamp: 0,
    pendingInteractionSource: "",
    pendingArmReason: "",
    pendingInteractionType: "",
    pendingInteractionKey: "",
    pendingInteractionTargetTag: "",
    pendingInteractionTargetId: "",
    pendingInteractionTargetClass: "",
    pendingInteractionKind: "",
    provisionalInteractionGeneration: 0,
    provisionalInteractionTimestamp: 0,
    provisionalInteractionKey: "",
    provisionalInteractionTrusted: false,
    provisionalInteractionKind: "",
    provisionalTransitionReady: false,
    provisionalTransitionReadyLoggedAt: 0
  };
}

export function createPostGameInteractionWatchState() {
  return {
    active: false,
    firstNotPlayingAt: 0,
    interactionBaselineGeneration: 0,
    lastInteractionGenerationSeen: 0,
    lastPollAt: 0,
    pendingGeneration: 0,
    pendingTimestamp: 0,
    pendingType: "",
    pendingKey: "",
    pendingTargetTag: "",
    pendingTargetId: "",
    pendingTargetClass: "",
    provisionalArmedGeneration: 0
  };
}

function setNextGameInteractionPhase(
  nextGameReacquireState,
  phase = NEXT_GAME_INTERACTION_PHASE_INACTIVE
) {
  if (!nextGameReacquireState) {
    return phase;
  }
  nextGameReacquireState.interactionPhase = String(phase || NEXT_GAME_INTERACTION_PHASE_INACTIVE);
  return nextGameReacquireState.interactionPhase;
}

function clearPostGameInteractionPending(postGameInteractionWatchState) {
  if (!postGameInteractionWatchState) {
    return false;
  }
  postGameInteractionWatchState.pendingGeneration = 0;
  postGameInteractionWatchState.pendingTimestamp = 0;
  postGameInteractionWatchState.pendingType = "";
  postGameInteractionWatchState.pendingKey = "";
  postGameInteractionWatchState.pendingTargetTag = "";
  postGameInteractionWatchState.pendingTargetId = "";
  postGameInteractionWatchState.pendingTargetClass = "";
  return true;
}

export function resetPostGameInteractionWatch(
  postGameInteractionWatchState,
  {
    clearPending = true
  } = {}
) {
  if (!postGameInteractionWatchState) {
    return null;
  }
  postGameInteractionWatchState.active = false;
  postGameInteractionWatchState.firstNotPlayingAt = 0;
  postGameInteractionWatchState.interactionBaselineGeneration = 0;
  postGameInteractionWatchState.lastInteractionGenerationSeen = 0;
  postGameInteractionWatchState.lastPollAt = 0;
  if (clearPending) {
    clearPostGameInteractionPending(postGameInteractionWatchState);
  }
  return postGameInteractionWatchState;
}

export function startPostGameInteractionWatch(
  postGameInteractionWatchState,
  {
    now = Date.now(),
    baselineGeneration = 0,
    log = console.log
  } = {}
) {
  if (!postGameInteractionWatchState) {
    return false;
  }
  postGameInteractionWatchState.active = true;
  postGameInteractionWatchState.firstNotPlayingAt = now;
  postGameInteractionWatchState.interactionBaselineGeneration = Math.max(
    0,
    Number(baselineGeneration ?? 0)
  );
  postGameInteractionWatchState.lastInteractionGenerationSeen =
    postGameInteractionWatchState.interactionBaselineGeneration;
  postGameInteractionWatchState.lastPollAt = 0;
  clearPostGameInteractionPending(postGameInteractionWatchState);
  if (typeof log === "function") {
    log(
      `[browser] post-game interaction watch started baseline=${postGameInteractionWatchState.interactionBaselineGeneration} first_not_playing_at=${now}`
    );
  }
  return true;
}

export function cancelPostGameInteractionWatch(
  postGameInteractionWatchState,
  {
    reason = "cancelled",
    log = console.log
  } = {}
) {
  if (!postGameInteractionWatchState?.active && !postGameInteractionWatchState?.pendingGeneration) {
    return false;
  }
  resetPostGameInteractionWatch(postGameInteractionWatchState);
  if (typeof log === "function") {
    log(`[browser] post-game interaction watch cancelled reason=${reason}`);
  }
  return true;
}

export function resetNextGameReacquireInteractionState(
  nextGameReacquireState,
  {
    baselineGeneration = 0
  } = {}
) {
  if (!nextGameReacquireState) {
    return null;
  }
  const normalizedBaseline = Math.max(0, Number(baselineGeneration ?? 0));
  nextGameReacquireState.interactionBaselineGeneration = normalizedBaseline;
  nextGameReacquireState.lastInteractionGenerationSeen = normalizedBaseline;
  nextGameReacquireState.lastInteractionGenerationHandled = normalizedBaseline;
  nextGameReacquireState.interactionWindowGeneration = 0;
  nextGameReacquireState.interactionWindowArmedAt = 0;
  nextGameReacquireState.pendingInteractionGeneration = 0;
  nextGameReacquireState.pendingInteractionTimestamp = 0;
  nextGameReacquireState.pendingInteractionSource = "";
  nextGameReacquireState.pendingArmReason = "";
  nextGameReacquireState.pendingInteractionType = "";
  nextGameReacquireState.pendingInteractionKey = "";
  nextGameReacquireState.pendingInteractionTargetTag = "";
  nextGameReacquireState.pendingInteractionTargetId = "";
  nextGameReacquireState.pendingInteractionTargetClass = "";
  nextGameReacquireState.pendingInteractionKind = "";
  nextGameReacquireState.provisionalInteractionGeneration = 0;
  nextGameReacquireState.provisionalInteractionTimestamp = 0;
  nextGameReacquireState.provisionalInteractionKey = "";
  nextGameReacquireState.provisionalInteractionTrusted = false;
  nextGameReacquireState.provisionalInteractionKind = "";
  nextGameReacquireState.provisionalTransitionReady = false;
  nextGameReacquireState.provisionalTransitionReadyLoggedAt = 0;
  return nextGameReacquireState;
}

export function setNextGameInteractionBaseline(
  nextGameReacquireState,
  interactionState = null
) {
  const generation = Math.max(
    0,
    Number(interactionState?.generation ?? interactionState ?? 0)
  );
  resetNextGameReacquireInteractionState(nextGameReacquireState, {
    baselineGeneration: generation
  });
  return generation;
}

export function createEndedGameCandidateState() {
  return {
    objectId: "",
    locator: "",
    epoch: 0,
    endedAt: 0,
    lastPlaying: false,
    lastPieceCounter: -1,
    lastSignature: "",
    releaseReason: ""
  };
}

export function startNextGameReacquire(
  nextGameReacquireState,
  {
    now = Date.now(),
    locator = "",
    epoch = null,
    interactionBaselineGeneration = 0,
    log = console.log
  } = {}
) {
  if (!nextGameReacquireState) {
    return false;
  }
  nextGameReacquireState.active = true;
  setNextGameInteractionPhase(
    nextGameReacquireState,
    NEXT_GAME_INTERACTION_PHASE_REACQUIRING
  );
  nextGameReacquireState.startedAt = now;
  nextGameReacquireState.lastFastAttemptAt = 0;
  nextGameReacquireState.lastFastMissLoggedAt = 0;
  nextGameReacquireState.lastEndedObjectCheckAt = 0;
  nextGameReacquireState.lastEndedObjectProbeStatus = "";
  nextGameReacquireState.lastEndedObjectProbeLogAt = 0;
  nextGameReacquireState.lastCheapSignalState = false;
  nextGameReacquireState.lastCheapSignalLogAt = 0;
  nextGameReacquireState.lastCheapSignalLabel = "";
  nextGameReacquireState.lastCheapSampledAt = 0;
  nextGameReacquireState.lastCheapAggregateState = "";
  resetNextGameReacquireInteractionState(nextGameReacquireState, {
    baselineGeneration: interactionBaselineGeneration
  });
  if (typeof log === "function") {
    const epochLabel = Number.isFinite(epoch) ? ` epoch=${epoch}` : "";
    const locatorLabel = locator ? ` locator=${locator}` : "";
    log(`[browser] next-game reacquire started${epochLabel}${locatorLabel}`);
  }
  return true;
}

export function cancelNextGameReacquire(
  nextGameReacquireState,
  {
    reason = "cancelled",
    log = console.log
  } = {}
) {
  if (!nextGameReacquireState?.active) {
    return false;
  }
  nextGameReacquireState.active = false;
  setNextGameInteractionPhase(
    nextGameReacquireState,
    NEXT_GAME_INTERACTION_PHASE_INACTIVE
  );
  nextGameReacquireState.startedAt = 0;
  nextGameReacquireState.lastFastAttemptAt = 0;
  nextGameReacquireState.lastEndedObjectCheckAt = 0;
  nextGameReacquireState.lastEndedObjectProbeStatus = "";
  nextGameReacquireState.lastEndedObjectProbeLogAt = 0;
  nextGameReacquireState.lastCheapSignalState = false;
  nextGameReacquireState.lastCheapSignalLogAt = 0;
  nextGameReacquireState.lastCheapSignalLabel = "";
  nextGameReacquireState.lastCheapSampledAt = 0;
  nextGameReacquireState.lastCheapAggregateState = "";
  resetNextGameReacquireInteractionState(nextGameReacquireState);
  if (typeof log === "function") {
    log(`[browser] next-game reacquire cancelled reason=${reason}`);
  }
  return true;
}

export function completeNextGameReacquire(
  nextGameReacquireState,
  {
    epoch = null,
    log = console.log
  } = {}
) {
  if (!nextGameReacquireState) {
    return false;
  }
  const wasActive = nextGameReacquireState.active;
  nextGameReacquireState.active = false;
  setNextGameInteractionPhase(
    nextGameReacquireState,
    NEXT_GAME_INTERACTION_PHASE_INACTIVE
  );
  nextGameReacquireState.startedAt = 0;
  nextGameReacquireState.lastFastAttemptAt = 0;
  nextGameReacquireState.lastEndedObjectCheckAt = 0;
  nextGameReacquireState.lastEndedObjectProbeStatus = "";
  nextGameReacquireState.lastEndedObjectProbeLogAt = 0;
  nextGameReacquireState.lastCheapSignalState = false;
  nextGameReacquireState.lastCheapSignalLogAt = 0;
  nextGameReacquireState.lastCheapSignalLabel = "";
  nextGameReacquireState.lastCheapSampledAt = 0;
  nextGameReacquireState.lastCheapAggregateState = "";
  resetNextGameReacquireInteractionState(nextGameReacquireState);
  if (wasActive && typeof log === "function" && Number.isFinite(epoch)) {
    log(`[browser] next-game reacquire completed epoch=${epoch}`);
  }
  return wasActive;
}

export function clearEndedGameCandidate(endedGameCandidate, reason = "") {
  if (!endedGameCandidate) {
    return "";
  }
  const previousObjectId = String(endedGameCandidate.objectId ?? "");
  endedGameCandidate.objectId = "";
  endedGameCandidate.locator = "";
  endedGameCandidate.epoch = 0;
  endedGameCandidate.endedAt = 0;
  endedGameCandidate.lastPlaying = false;
  endedGameCandidate.lastPieceCounter = -1;
  endedGameCandidate.lastSignature = "";
  endedGameCandidate.releaseReason = reason ? String(reason) : "";
  return previousObjectId;
}

export async function releaseEndedGameCandidateHandle(
  cdp,
  endedGameCandidate,
  {
    reason = "released",
    log = console.log
  } = {}
) {
  const objectId = clearEndedGameCandidate(endedGameCandidate, reason);
  if (!objectId || !cdp?.send) {
    return false;
  }
  await cdp.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
  await cdp.send("Runtime.releaseObjectGroup", {
    objectGroup: "fusion-ended-game"
  }).catch(() => undefined);
  if (typeof log === "function") {
    log(`[browser] ended game object released reason=${reason}`);
  }
  return true;
}

function createPausedScopeScanCursor() {
  return {
    frameIndex: 0,
    scopeIndex: 0,
    propertyIndex: 0,
    completedScopeKeys: [],
    seenCandidateKeys: []
  };
}

function clearPausedScopeScanCursor(closureCaptureState) {
  if (!closureCaptureState) {
    return false;
  }
  closureCaptureState.pausedScopeScanCursor = null;
  return true;
}

function resetClosureCaptureScanWindowState(
  closureCaptureState,
  { nextAttemptAt = 0, cursor = null } = {}
) {
  if (!closureCaptureState) {
    return false;
  }
  closureCaptureState.fullScanAttemptsInWindow = 0;
  closureCaptureState.cumulativePausedScanBudgetUsedMs = 0;
  closureCaptureState.pausedScopeScanCursor = cursor;
  closureCaptureState.scanBudgetExhausted = false;
  closureCaptureState.fastLocatorAttempted = false;
  closureCaptureState.nextAttemptAt = nextAttemptAt;
  return true;
}

export function resetPausedScopeScanProgress(closureCaptureState) {
  if (!closureCaptureState) {
    return false;
  }
  closureCaptureState.cumulativePausedScanBudgetUsedMs = 0;
  clearPausedScopeScanCursor(closureCaptureState);
  closureCaptureState.scanBudgetExhausted = false;
  return true;
}

export function createGameStartSignalState() {
  return {
    generation: 0,
    latestKey: "",
    latestSource: "",
    latestSeenAt: 0,
    latestDetails: null,
    consumedKey: "",
    signals: []
  };
}

export function resetGameStartSignalState(gameStartSignalState) {
  if (!gameStartSignalState) {
    return false;
  }
  gameStartSignalState.generation = 0;
  gameStartSignalState.latestKey = "";
  gameStartSignalState.latestSource = "";
  gameStartSignalState.latestSeenAt = 0;
  gameStartSignalState.latestDetails = null;
  gameStartSignalState.consumedKey = "";
  gameStartSignalState.signals = [];
  return true;
}

function buildGameStartSignalKey(generation, source, baseKey) {
  return `${Math.max(0, Number(generation ?? 0))}:${String(source || "unknown")}:${String(baseKey || "")}`;
}

function refreshLatestGameStartSignalState(gameStartSignalState) {
  if (!gameStartSignalState) {
    return false;
  }
  const signals = Array.isArray(gameStartSignalState.signals)
    ? gameStartSignalState.signals
    : [];
  const latest = signals.at(-1) ?? null;
  gameStartSignalState.latestKey = latest?.key ?? "";
  gameStartSignalState.latestSource = latest?.source ?? "";
  gameStartSignalState.latestSeenAt = latest?.seenAt ?? 0;
  gameStartSignalState.latestDetails = latest?.details ?? null;
  return true;
}

export function advanceGameStartSignalGeneration(
  gameStartSignalState,
  { preserveSince = 0 } = {}
) {
  if (!gameStartSignalState) {
    return false;
  }
  const nextGeneration = Math.max(
    0,
    Number(gameStartSignalState.generation ?? 0)
  ) + 1;
  const nextSignals = [];
  for (const signal of Array.isArray(gameStartSignalState.signals)
    ? gameStartSignalState.signals
    : []) {
    if (Number(signal?.seenAt ?? 0) < preserveSince) {
      continue;
    }
    nextSignals.push({
      ...signal,
      generation: nextGeneration,
      key: buildGameStartSignalKey(
        nextGeneration,
        signal?.source ?? "unknown",
        signal?.baseKey ?? signal?.key ?? ""
      )
    });
  }
  gameStartSignalState.generation = nextGeneration;
  gameStartSignalState.consumedKey = "";
  gameStartSignalState.signals = nextSignals;
  refreshLatestGameStartSignalState(gameStartSignalState);
  return true;
}

export function noteGameStartSignal(
  gameStartSignalState,
  {
    key,
    source = "unknown",
    now = Date.now(),
    details = null
  } = {}
) {
  if (!gameStartSignalState || !key) {
    return false;
  }
  const normalizedBaseKey = String(key);
  const generation = Math.max(0, Number(gameStartSignalState.generation ?? 0));
  const normalizedKey = buildGameStartSignalKey(
    generation,
    source,
    normalizedBaseKey
  );
  if ((gameStartSignalState.signals ?? []).some((signal) => signal.key === normalizedKey)) {
    return false;
  }
  const nextSignal = {
    key: normalizedKey,
    baseKey: normalizedBaseKey,
    source: String(source || "unknown"),
    generation,
    seenAt: now,
    details: details ?? null
  };
  const signals = Array.isArray(gameStartSignalState.signals)
    ? gameStartSignalState.signals
    : [];
  signals.push(nextSignal);
  while (signals.length > MAX_GAME_START_SIGNALS) {
    signals.shift();
  }
  gameStartSignalState.signals = signals;
  refreshLatestGameStartSignalState(gameStartSignalState);
  return true;
}

function logSoloSignalCandidate(
  log,
  {
    source = "unknown",
    key = "",
    details = null
  } = {}
) {
  if (typeof log !== "function") {
    return;
  }
  log(
    `[browser] solo signal candidate type=${source} path=${source} seed=${String(
      details?.seed ?? "missing"
    )} bagtype=${String(details?.bagtype ?? "missing")} nextcount=${String(
      details?.nextCount ?? "missing"
    )} signature=${key || "missing"}`
  );
}

function noteSoloGameStartSignal(
  gameStartSignalState,
  {
    key,
    source = "unknown",
    now = Date.now(),
    details = null,
    log = console.log
  } = {}
) {
  logSoloSignalCandidate(log, { source, key, details });
  const queued = noteGameStartSignal(gameStartSignalState, {
    key,
    source,
    now,
    details
  });
  if (!queued) {
    if (typeof log === "function") {
      log(
        `[browser] solo signal ignored reason=duplicate_key signature=${String(key || "missing")}`
      );
    }
    return false;
  }
  if (typeof log === "function") {
    log(`[browser] solo signal queued key=${key} source=${source}`);
  }
  return true;
}

export function hasUnconsumedGameStartSignal(
  gameStartSignalState,
  { since = 0 } = {}
) {
  if (!Array.isArray(gameStartSignalState?.signals)) {
    return false;
  }
  return gameStartSignalState.signals.some((signal) => signal.seenAt >= since);
}

export function consumeGameStartSignal(
  gameStartSignalState,
  { since = 0 } = {}
) {
  if (!Array.isArray(gameStartSignalState?.signals)) {
    return null;
  }
  const index = gameStartSignalState.signals.findIndex((signal) => signal.seenAt >= since);
  if (index < 0) {
    return null;
  }
  const [signal] = gameStartSignalState.signals.splice(index, 1);
  gameStartSignalState.consumedKey = signal.key;
  return {
    key: signal.key,
    source: signal.source,
    seenAt: signal.seenAt,
    details: signal.details
  };
}

export function applyGameStartSignalToNetwork(
  network,
  signal,
  now = Date.now()
) {
  if (!network || !signal?.details || signal.details.seed === undefined || signal.details.seed === null) {
    return false;
  }
  network.seed = String(signal.details.seed);
  const nextCount = Number.parseInt(
    signal.details.nextCount ?? `${DEFAULT_NEXT_COUNT}`,
    10
  );
  network.nextCount = Number.isFinite(nextCount) && nextCount > 0
    ? nextCount
    : DEFAULT_NEXT_COUNT;
  const readyAt = Number(signal.details.readyAt);
  const countdownMs = Number(signal.details.countdownMs);
  if (Number.isFinite(readyAt) && readyAt > 0) {
    network.readyAt = readyAt;
  } else if (Number.isFinite(countdownMs) && countdownMs >= 0) {
    network.readyAt = now + countdownMs;
  } else {
    network.readyAt = 0;
  }
  return true;
}

export function isClosureCaptureArmed(
  closureCaptureState,
  now = Date.now()
) {
  return Boolean(closureCaptureState && closureCaptureState.armedUntil > now);
}

export function armClosureCaptureWindow(
  closureCaptureState,
  {
    reason = "gameplay_signal",
    now = Date.now(),
    windowMs = DEFAULT_CAPTURE_ARMING_WINDOW_MS,
    log = console.log,
    restartWindow = false
  } = {}
) {
  if (!closureCaptureState) {
    return false;
  }
  const nextUntil = now + Math.max(0, windowMs);
  const wasArmed = isClosureCaptureArmed(closureCaptureState, now);
  const reasonChanged = closureCaptureState.armedReason !== reason;
  closureCaptureState.armedUntil = restartWindow
    ? nextUntil
    : Math.max(closureCaptureState.armedUntil, nextUntil);
  closureCaptureState.armedReason = reason;
  closureCaptureState.lastSkippedLogAt = 0;
  closureCaptureState.firstAttemptLoggedForReason = "";
  if (!wasArmed || reasonChanged || restartWindow) {
    closureCaptureState.retryCount = 0;
    closureCaptureState.captureAttemptsInWindow = 0;
    closureCaptureState.windowArmedAt = now;
    resetClosureCaptureTiming(closureCaptureState, now);
    resetClosureCaptureScanWindowState(closureCaptureState, {
      nextAttemptAt: now,
      cursor: createPausedScopeScanCursor()
    });
    closureCaptureState.windowSequence += 1;
  }
  if (!wasArmed || reasonChanged || restartWindow) {
    log(`[browser] closure capture armed reason=${reason}`);
    logClosureCaptureWindowInitialized(closureCaptureState, reason, log);
  }
  return true;
}

export function disarmClosureCaptureWindow(
  closureCaptureState,
  {
    reason = "gameplay_inactive",
    log = console.log,
    clearPending = false
  } = {}
) {
  if (!closureCaptureState) {
    return false;
  }
  if (reason === "bot_off") {
    resetInitialGameplayCaptureProbeState(closureCaptureState);
  }
  const hadPending = Boolean(closureCaptureState.pendingCaptureArm);
  if (clearPending) {
    clearPendingClosureCaptureArm(closureCaptureState);
  }
  if (closureCaptureState.armedUntil === 0) {
    return hadPending;
  }
  closureCaptureState.armedUntil = 0;
  closureCaptureState.armedReason = "";
  closureCaptureState.lastSkippedLogAt = 0;
  closureCaptureState.nextAttemptAt = 0;
  closureCaptureState.retryCount = 0;
  closureCaptureState.firstAttemptLoggedForReason = "";
  closureCaptureState.captureAttemptsInWindow = 0;
  closureCaptureState.pendingFollowupFullScan = false;
  closureCaptureState.pendingFollowupFastCapture = false;
  closureCaptureState.windowArmedAt = 0;
  closureCaptureState.windowFirstInteractionAt = 0;
  closureCaptureState.windowTargetedProbeAt = 0;
  closureCaptureState.provisionalNonHeavyAttemptConsumed = false;
  resetClosureCaptureScanWindowState(closureCaptureState);
  log(`[browser] closure capture disarmed reason=${reason}`);
  return true;
}

export function clearPendingClosureCaptureArm(closureCaptureState) {
  if (!closureCaptureState?.pendingCaptureArm) {
    return false;
  }
  closureCaptureState.pendingCaptureArm = null;
  return true;
}

export function hasPendingClosureCaptureArm(closureCaptureState) {
  return Boolean(closureCaptureState?.pendingCaptureArm);
}

export function requestClosureCaptureArm(
  closureCaptureState,
  {
    reason = "gameplay_signal",
    now = Date.now(),
    bootstrapReady = true,
    windowMs = DEFAULT_CAPTURE_ARMING_WINDOW_MS,
    log = console.log
  } = {}
) {
  if (!closureCaptureState) {
    return false;
  }
  if (bootstrapReady) {
    clearPendingClosureCaptureArm(closureCaptureState);
    return armClosureCaptureWindow(closureCaptureState, {
      reason,
      now,
      windowMs,
      log
    });
  }
  if (!closureCaptureState.pendingCaptureArm) {
    closureCaptureState.pendingCaptureArm = {
      reason,
      requestedAt: now
    };
    log(`[browser] closure capture pending reason=${reason} bootstrap_not_ready`);
    return true;
  }
  return false;
}

export function activatePendingClosureCaptureArm(
  closureCaptureState,
  {
    now = Date.now(),
    windowMs = DEFAULT_CAPTURE_ARMING_WINDOW_MS,
    log = console.log
  } = {}
) {
  const pending = closureCaptureState?.pendingCaptureArm;
  if (!pending) {
    return false;
  }
  clearPendingClosureCaptureArm(closureCaptureState);
  log(`[browser] bootstrap ready; activating pending arm reason=${pending.reason}`);
  return armClosureCaptureWindow(closureCaptureState, {
    reason: `${pending.reason}_after_bootstrap`,
    now,
    windowMs,
    log,
    restartWindow: true
  });
}

export function reactivateClosureCaptureArmAfterBootstrap(
  closureCaptureState,
  {
    now = Date.now(),
    windowMs = DEFAULT_CAPTURE_ARMING_WINDOW_MS,
    log = console.log
  } = {}
) {
  if (!closureCaptureState || closureCaptureState.armedUntil === 0) {
    return false;
  }
  const baseReason = String(closureCaptureState.armedReason || "gameplay_signal");
  const nextReason = baseReason.endsWith("_after_bootstrap")
    ? baseReason
    : `${baseReason}_after_bootstrap`;
  return armClosureCaptureWindow(closureCaptureState, {
    reason: nextReason,
    now,
    windowMs,
    log,
    restartWindow: true
  });
}

export function deriveGameplayPhase(state) {
  if (state?.playing === true) {
    return "playing";
  }
  if (state?.countdown === true) {
    return "countdown";
  }
  return "inactive";
}

export function isGameplayExpectedForClosureCapture({
  state,
  activeRoundId = "",
  closureCaptureState = null,
  carriedInteractionExpected = false,
  now = Date.now()
}) {
  return Boolean(
    activeRoundId ||
      carriedInteractionExpected ||
      state?.countdown === true ||
      state?.playing === true ||
      isClosureCaptureArmed(closureCaptureState, now)
  );
}

function hasUnhandledCarriedPostGameInteraction(nextGameReacquireState) {
  if (!nextGameReacquireState?.active) {
    return false;
  }
  const pendingGeneration = Math.max(
    0,
    Number(nextGameReacquireState.pendingInteractionGeneration ?? 0)
  );
  const handledGeneration = Math.max(
    0,
    Number(nextGameReacquireState.lastInteractionGenerationHandled ?? 0)
  );
  return (
    nextGameReacquireState.interactionPhase ===
      NEXT_GAME_INTERACTION_PHASE_REACQUIRING &&
    String(nextGameReacquireState.pendingInteractionSource ?? "") === "post_game" &&
    pendingGeneration > handledGeneration
  );
}

function isProvisionalClosureCaptureReason(reason = "") {
  return String(reason ?? "").startsWith("next_game_provisional_interaction");
}

function isCarriedClosureCaptureReason(reason = "") {
  return String(reason ?? "").startsWith("next_game_carried_interaction");
}

export function shouldLogClosureCaptureSkipped({
  gameplayExpected,
  lastSkippedLogAt = 0,
  now = Date.now(),
  intervalMs = DEFAULT_CAPTURE_SKIP_LOG_INTERVAL_MS
}) {
  return !gameplayExpected && now - lastSkippedLogAt >= intervalMs;
}

export function createBrowserControlState() {
  return {
    botEnabled: false,
    selectedMode: RUNTIME_MODE_SOLO,
    modeGeneration: 0
  };
}

export function createQuickPlayDiagnosticState() {
  return {
    active: false,
    ownerRequests: {
      [QUICK_PLAY_OWNER_MANUAL_DIAGNOSTIC]: false,
      [QUICK_PLAY_OWNER_ZENITH_DRY_RUN]: false
    },
    startedAt: 0,
    stopAt: 0,
    manualOwnerStopAt: 0,
    finishedAt: 0,
    maxDurationMs: DEFAULT_QUICK_PLAY_DIAGNOSTIC_DURATION_MS,
    maxWsPackets: DEFAULT_QUICK_PLAY_DIAGNOSTIC_PACKET_LIMIT,
    nextSessionSurveyAt: 0,
    nextClosureSurveyAt: 0,
    sessionSurveyIntervalMs: DEFAULT_QUICK_PLAY_SESSION_SURVEY_INTERVAL_MS,
    closureSurveyIntervalMs: DEFAULT_QUICK_PLAY_CLOSURE_SURVEY_INTERVAL_MS,
    wsEnvelopes: [],
    wsPlayers: new Map(),
    sessionCandidates: new Map(),
    closureCandidates: new Map(),
    screenUsername: null,
    diagnosticUsernameHint: null,
    sessionStorageKeys: {
      local: [],
      session: []
    },
    storageIdentityRecords: [],
    indexedDbCatalog: [],
    sessionRuntimePathsChecked: [],
    screenIdentityEvidence: [],
    legacyPathProbe: {
      __NUXT__: false,
      state: false,
      session: false,
      user: false
    },
    rawWsPath: DEFAULT_QUICK_PLAY_WS_RAW_PATH,
    closurePath: DEFAULT_QUICK_PLAY_CLOSURE_PATH,
    callframePath: DEFAULT_QUICK_PLAY_CALLFRAME_PATH,
    passiveSnapshotPath: DEFAULT_QUICK_PLAY_PASSIVE_SNAPSHOT_PATH,
    soloClosureFingerprintPath: DEFAULT_SOLO_CLOSURE_FINGERPRINT_PATH,
    reportPath: DEFAULT_QUICK_PLAY_REPORT_PATH,
    roundObserved: false,
    roundCompleted: false,
    stopReason: "",
    localResolution: null,
    captureGeneration: 0,
    currentTargetUrl: "",
    nextPassiveSnapshotAt: 0,
    passiveSnapshotIntervalMs: 150,
    passiveSnapshotFinalReason: "",
    lastUsablePassiveSnapshot: null,
    lastPassiveSnapshotError: null,
    lastPassiveSnapshotLogSignature: "",
    lastPassiveSnapshotLogAt: 0,
    lastPassiveRootProbeSignature: "",
    lastPassiveSnapshotFailureLogReason: "",
    boundLocalClosureCandidate: {
      generation: 0,
      targetId: "",
      candidateId: "",
      rootObjectId: "",
      retainedRootKind: "binding",
      retainedRootPath: [],
      rootPath: [],
      functionName: "",
      callFrameIndex: -1,
      scopeIndex: -1,
      scopeType: "",
      bindingName: "",
      boardPath: [],
      currentPath: [],
      holdPath: [],
      queuePath: [],
      capturedAt: 0,
      userid: null,
      gameid: null,
      wsPlayerId: "",
      identityBound: false
    },
    pendingIdentity: {
      generation: 0,
      userid: null,
      gameid: null,
      wsPlayerId: "",
      resolvedAt: 0
    },
    logFn: null,
    closureRetryJitterMsFn: null,
    sessionScanState: {
      pendingReason: "diagnostic_start"
    },
    closureScanState: {
      pendingReason: "",
      attempts: 0,
      productiveAttempts: 0,
      nonproductiveAttempts: 0,
      timingMissCount: 0,
      retryScheduled: 0,
      retryExhausted: false,
      lastNoTickCallframes: 0,
      noTickAttempts: [],
      running: false,
      maxAttempts: DEFAULT_QUICK_PLAY_CLOSURE_SCAN_MAX_ATTEMPTS,
      maxNonproductiveAttempts:
        DEFAULT_QUICK_PLAY_CLOSURE_SCAN_MAX_NONPRODUCTIVE_ATTEMPTS,
      zenithRetryScheduled: false
    },
    diagnostics: {
      session_scan: {
        scheduled: 0,
        attempts: 0,
        completed: 0,
        errors: [],
        legacy_path_result: {
          __NUXT__: false,
          state: false,
          session: false,
          user: false
        },
        runtime_paths_checked: [],
        storage_identity_records: [],
        indexed_db_catalog: [],
        storage_keys: {
          local: [],
          session: []
        },
        screen_identity_evidence: []
      },
      closure_scan: {
        scheduled: 0,
        attempts: 0,
        productive_attempts: 0,
        nonproductive_attempts: 0,
        timing_miss_count: 0,
        timing_miss_reasons: {},
        retry_scheduled: 0,
        retry_exhausted: false,
        last_no_tick_callframes: 0,
        no_tick_attempts: [],
        completed: 0,
        skipped: 0,
        skip_reasons: {},
        pause_requested: 0,
        pause_acquired: 0,
        callframes_seen: 0,
        tick_frames_seen: 0,
        selected_tick_frames: 0,
        matching_frames_seen: 0,
        matching_scopes_seen: 0,
        candidate_closure_scopes_seen: 0,
        selected_primary_scopes: 0,
        selected_secondary_scopes: 0,
        targeted_inspections: 0,
        generic_targets_seen: 0,
        target_handoff_mismatches: 0,
        inventory_rows_written: 0,
        errors: [],
        raw_candidate_count: 0,
        accepted_candidate_count: 0,
        rejection_counts: {},
        targeted_binding_inspection: null,
        targeted_binding_inspections: []
      },
      passive_snapshot: {
        candidate_bound_current: false,
        identity_bound_current: false,
        candidate_id: null,
        bind_attempts: 0,
        bind_succeeded: 0,
        bind_deferred: 0,
        bind_deferred_reasons: {},
        candidate_retained: false,
        candidate_retain_attempts: 0,
        candidate_retain_succeeded: 0,
        candidate_retain_failed: 0,
        candidate_retain_failure_reasons: {},
        last_candidate_retain_failure: "",
        identity_available: false,
        polling_started: false,
        reads_attempted: 0,
        transport_reads_succeeded: 0,
        transport_reads_failed: 0,
        reads_succeeded: 0,
        reads_failed: 0,
        semantic_reads_succeeded: 0,
        semantic_reads_failed: 0,
        semantic_failure_reasons: {},
        ever_candidate_bound: false,
        ever_identity_bound: false,
        last_success_at: 0,
        last_failure_reason: "",
        board_normalized: false,
        current_normalized: false,
        hold_normalized: false,
        queue_normalized: false,
        field_diagnostics: null,
        candidate_bound: false,
        identity_bound: false
      }
    }
  };
}

function normalizeQuickPlayPassiveOwner(owner) {
  const normalized = String(owner ?? "").trim().toLowerCase();
  if (normalized === QUICK_PLAY_OWNER_MANUAL_DIAGNOSTIC) {
    return QUICK_PLAY_OWNER_MANUAL_DIAGNOSTIC;
  }
  if (normalized === QUICK_PLAY_OWNER_ZENITH_DRY_RUN) {
    return QUICK_PLAY_OWNER_ZENITH_DRY_RUN;
  }
  return "";
}

function quickPlayPassiveOwnerRequested(quickPlayDiagnosticState, owner) {
  const normalized = normalizeQuickPlayPassiveOwner(owner);
  if (!normalized) {
    return false;
  }
  return quickPlayDiagnosticState?.ownerRequests?.[normalized] === true;
}

function hasAnyQuickPlayPassiveOwner(quickPlayDiagnosticState) {
  return (
    quickPlayPassiveOwnerRequested(
      quickPlayDiagnosticState,
      QUICK_PLAY_OWNER_MANUAL_DIAGNOSTIC
    ) ||
    quickPlayPassiveOwnerRequested(
      quickPlayDiagnosticState,
      QUICK_PLAY_OWNER_ZENITH_DRY_RUN
    )
  );
}

function quickPlayPassiveArtifactsEnabled(quickPlayDiagnosticState) {
  if (
    !quickPlayDiagnosticState ||
    !hasAnyQuickPlayPassiveOwner(quickPlayDiagnosticState)
  ) {
    return true;
  }
  return quickPlayPassiveOwnerRequested(
    quickPlayDiagnosticState,
    QUICK_PLAY_OWNER_MANUAL_DIAGNOSTIC
  );
}

function quickPlayPassiveAllowsBotEnabled(quickPlayDiagnosticState) {
  return quickPlayPassiveOwnerRequested(
    quickPlayDiagnosticState,
    QUICK_PLAY_OWNER_ZENITH_DRY_RUN
  );
}

function quickPlayPassiveUsesOwnerLifecycle(quickPlayDiagnosticState) {
  return quickPlayPassiveOwnerRequested(
    quickPlayDiagnosticState,
    QUICK_PLAY_OWNER_ZENITH_DRY_RUN
  );
}

function quickPlayPassivePacketLimit(quickPlayDiagnosticState) {
  if (quickPlayPassiveUsesOwnerLifecycle(quickPlayDiagnosticState)) {
    return null;
  }
  return Math.max(
    1,
    Number(
      quickPlayDiagnosticState?.maxWsPackets ??
        DEFAULT_QUICK_PLAY_DIAGNOSTIC_PACKET_LIMIT
    )
  );
}

function syncQuickPlayPassiveStopDeadline(
  quickPlayDiagnosticState,
  now = Date.now()
) {
  if (!quickPlayDiagnosticState) {
    return false;
  }
  if (
    quickPlayPassiveOwnerRequested(
      quickPlayDiagnosticState,
      QUICK_PLAY_OWNER_ZENITH_DRY_RUN
    )
  ) {
    quickPlayDiagnosticState.stopAt = Number.MAX_SAFE_INTEGER;
    return true;
  }
  if (
    !hasAnyQuickPlayPassiveOwner(quickPlayDiagnosticState) ||
    quickPlayPassiveOwnerRequested(
      quickPlayDiagnosticState,
      QUICK_PLAY_OWNER_MANUAL_DIAGNOSTIC
    )
  ) {
    if (Number(quickPlayDiagnosticState.manualOwnerStopAt ?? 0) <= 0) {
      const startedAt = Math.max(
        0,
        Number(quickPlayDiagnosticState.startedAt ?? now ?? Date.now())
      );
      quickPlayDiagnosticState.manualOwnerStopAt =
        startedAt +
        Math.max(
          1,
          Number(
            quickPlayDiagnosticState.maxDurationMs ??
              DEFAULT_QUICK_PLAY_DIAGNOSTIC_DURATION_MS
          )
        );
    }
    quickPlayDiagnosticState.stopAt = Math.max(
      1,
      Number(quickPlayDiagnosticState.manualOwnerStopAt ?? 0)
    );
    return true;
  }
  quickPlayDiagnosticState.stopAt = Math.max(
    now,
    Number(quickPlayDiagnosticState.manualOwnerStopAt ?? 0)
  );
  return true;
}

function clampQuickPlayClosureScanAttemptCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_QUICK_PLAY_CLOSURE_SCAN_MAX_ATTEMPTS;
  }
  return Math.max(1, Math.min(5, Math.round(numeric)));
}

function touchQuickPlayDiagnosticFile(filePath) {
  const normalizedPath = String(filePath ?? "").trim();
  if (!normalizedPath) {
    return false;
  }
  mkdirSync(path.dirname(normalizedPath), { recursive: true });
  writeFileSync(normalizedPath, "");
  return true;
}

function appendQuickPlayDiagnosticError(target, error) {
  if (!target || !Array.isArray(target.errors)) {
    return false;
  }
  const message = String(error?.message ?? error ?? "").trim();
  if (!message) {
    return false;
  }
  target.errors.push(message);
  if (target.errors.length > 12) {
    target.errors.splice(0, target.errors.length - 12);
  }
  return true;
}

function scheduleQuickPlaySessionSurvey(
  quickPlayDiagnosticState,
  {
    now = Date.now(),
    delayMs = 0,
    reason = "diagnostic_start"
  } = {}
) {
  if (!quickPlayDiagnosticState?.active) {
    return false;
  }
  quickPlayDiagnosticState.nextSessionSurveyAt =
    Math.max(0, Number(now ?? Date.now())) + Math.max(0, Number(delayMs) || 0);
  quickPlayDiagnosticState.sessionScanState.pendingReason = String(
    reason ?? "diagnostic_start"
  );
  quickPlayDiagnosticState.diagnostics.session_scan.scheduled += 1;
  return true;
}

function scheduleQuickPlayClosureSurvey(
  quickPlayDiagnosticState,
  {
    now = Date.now(),
    delayMs = 0,
    reason = "diagnostic_start",
    generation = quickPlayDiagnosticState?.captureGeneration ?? 0,
    log = quickPlayDiagnosticState?.logFn ?? console.log
  } = {}
) {
  const artifactsEnabled = quickPlayPassiveArtifactsEnabled(quickPlayDiagnosticState);
  if (!quickPlayDiagnosticState?.active) {
    return false;
  }
  const closureScanState = quickPlayDiagnosticState.closureScanState;
  if (
    !closureScanState ||
    closureScanState.running === true ||
    quickPlayDiagnosticState?.boundLocalClosureCandidate?.rootObjectId ||
    closureScanState.productiveAttempts >=
      clampQuickPlayClosureScanAttemptCount(closureScanState.maxAttempts)
  ) {
    return false;
  }
  if (
    !quickPlayDiagnosticState.roundObserved &&
    reason !== "first_zenith_options" &&
    reason !== "gameplay_signal"
  ) {
    return false;
  }
  const nextAt = Math.max(0, Number(now ?? Date.now())) + Math.max(0, Number(delayMs) || 0);
  const nextAttempt = Math.max(1, Number(closureScanState.attempts ?? 0) + 1);
  if (quickPlayDiagnosticState.nextClosureSurveyAt > 0) {
    const currentReason = String(quickPlayDiagnosticState.closureScanState.pendingReason ?? "retry");
    const normalizedReason = String(reason ?? "retry");
    const shouldCoalesce =
      normalizedReason === "first_zenith_options" ||
      currentReason === normalizedReason ||
      nextAt < quickPlayDiagnosticState.nextClosureSurveyAt;
    if (!shouldCoalesce) {
      return false;
    }
    if (
      currentReason === normalizedReason &&
      quickPlayDiagnosticState.nextClosureSurveyAt <= nextAt
    ) {
      return false;
    }
    quickPlayDiagnosticState.nextClosureSurveyAt = Math.min(
      quickPlayDiagnosticState.nextClosureSurveyAt,
      nextAt
    );
    quickPlayDiagnosticState.closureScanState.pendingReason = normalizedReason;
    log?.(
      `[quick-play] closure scan coalesced generation=${Math.max(
        0,
        Number(generation ?? 0)
      )} reason=${normalizedReason} attempt=${nextAttempt}`
    );
    return true;
  }
  quickPlayDiagnosticState.nextClosureSurveyAt = nextAt;
  quickPlayDiagnosticState.closureScanState.pendingReason = String(
    reason ?? "retry"
  );
  closureScanState.retryScheduled += 1;
  quickPlayDiagnosticState.diagnostics.closure_scan.retry_scheduled += 1;
  quickPlayDiagnosticState.diagnostics.closure_scan.scheduled += 1;
  log?.(
    `[quick-play] closure scan scheduled generation=${Math.max(
      0,
      Number(generation ?? 0)
    )} reason=${String(reason ?? "retry")} attempt=${
      nextAttempt
    }`
  );
  return true;
}

function isQuickPlayTimingMissResult(resultType = "") {
  return [
    "matching_frame_missing",
    "pause_timeout",
    "paused_event_not_received",
    "callframes_empty"
  ].includes(String(resultType ?? "").trim());
}

function summarizeQuickPlayNoTickCallFrames(callFrames = [], attempt = 0) {
  const normalized = Array.isArray(callFrames) ? callFrames : [];
  const names = normalized
    .map((callFrame) => String(callFrame?.functionName ?? "").trim())
    .filter(Boolean);
  const topFunctions = [...new Set(names)].slice(0, 3);
  return {
    attempt: Math.max(0, Number(attempt ?? 0)),
    callframes_seen: normalized.length,
    top_functions: topFunctions,
    render_like_count: names.filter((name) => /render/i.test(name)).length,
    update_like_count: names.filter((name) => /update/i.test(name)).length,
    tick_like_count: names.filter((name) => /tick/i.test(name)).length,
    frames: normalized.slice(0, 20).map((callFrame, index) => ({
      call_frame_index: index,
      function_name: String(callFrame?.functionName ?? "").trim() || null,
      script_basename: basenameFromUrlLike(callFrame?.url ?? callFrame?.scriptId ?? ""),
      scope_count: Array.isArray(callFrame?.scopeChain) ? callFrame.scopeChain.length : 0
    }))
  };
}

function nextQuickPlayTimingMissDelayMs(quickPlayDiagnosticState) {
  const closureScanState = quickPlayDiagnosticState?.closureScanState ?? {};
  const missCount = Math.max(0, Number(closureScanState.timingMissCount ?? 0));
  const base =
    DEFAULT_QUICK_PLAY_CLOSURE_RETRY_BACKOFF_MS[
      Math.min(
        DEFAULT_QUICK_PLAY_CLOSURE_RETRY_BACKOFF_MS.length - 1,
        missCount
      )
    ];
  const jitterFn = quickPlayDiagnosticState?.closureRetryJitterMsFn;
  const jitter = Number.isFinite(Number(jitterFn?.(missCount, base)))
    ? Number(jitterFn(missCount, base))
    : 0;
  return Math.max(0, Math.round(base + jitter));
}

function shouldAllowQuickPlayGameplaySignalScan(quickPlayDiagnosticState, envelope) {
  if (!quickPlayDiagnosticState?.active || envelope?.direction !== "inbound") {
    return false;
  }
  if (quickPlayDiagnosticState?.boundLocalClosureCandidate?.rootObjectId) {
    return false;
  }
  const closureScanState = quickPlayDiagnosticState?.closureScanState;
  if (!closureScanState || closureScanState.running === true) {
    return false;
  }
  const identity = quickPlayDiagnosticState?.pendingIdentity?.userid &&
    quickPlayDiagnosticState?.pendingIdentity?.gameid !== null
      ? quickPlayDiagnosticState.pendingIdentity
      : resolveQuickPlayWsSelfEvidence(quickPlayDiagnosticState);
  if (!identity) {
    return false;
  }
  const localMatch = (envelope?.players ?? []).some(
    (player) =>
      valuesEqual(player?.userid, identity.userid) ||
      valuesEqual(player?.gameid, identity.gameid)
  );
  if (!localMatch) {
    return false;
  }
  const keys = [
    ...(Array.isArray(envelope?.root_keys) ? envelope.root_keys : []),
    ...(Array.isArray(envelope?.payload_keys) ? envelope.payload_keys : [])
  ]
    .map((entry) => String(entry ?? "").toLowerCase());
  return keys.some((entry) =>
    /(player|options|state|playing|countdown|piece|place|placement|alive)/.test(entry)
  );
}

function maybeScheduleQuickPlayClosureRetryFromZenithOptions(
  quickPlayDiagnosticState,
  now = Date.now()
) {
  if (!quickPlayDiagnosticState?.active) {
    return false;
  }
  const closureScanState = quickPlayDiagnosticState.closureScanState;
  if (
    !closureScanState ||
    closureScanState.zenithRetryScheduled ||
    closureScanState.productiveAttempts >=
      clampQuickPlayClosureScanAttemptCount(closureScanState.maxAttempts)
  ) {
    return false;
  }
  closureScanState.zenithRetryScheduled = true;
  return scheduleQuickPlayClosureSurvey(quickPlayDiagnosticState, {
    now,
    delayMs: 150,
    reason: "first_zenith_options"
  });
}

export function startQuickPlayDiagnosticCapture(
  quickPlayDiagnosticState,
  browserControlState,
  {
    now = Date.now(),
    log = console.log,
    usernameHint = null
  } = {}
) {
  return requestQuickPlayPassiveProviderOwner(
    quickPlayDiagnosticState,
    browserControlState,
    {
      owner: QUICK_PLAY_OWNER_MANUAL_DIAGNOSTIC,
      enabled: true,
      now,
      log,
      usernameHint
    }
  );
}

function activateQuickPlayPassiveCapture(
  quickPlayDiagnosticState,
  browserControlState,
  {
    now = Date.now(),
    log = console.log,
    usernameHint = null
  } = {}
) {
  if (!quickPlayDiagnosticState) {
    return { started: false, reason: "state_missing" };
  }
  if (!isZenithModeSelected(browserControlState)) {
    return { started: false, reason: "mode_not_zenith" };
  }
  if (browserControlState?.botEnabled && !quickPlayPassiveAllowsBotEnabled(quickPlayDiagnosticState)) {
    return { started: false, reason: "bot_enabled" };
  }
  quickPlayDiagnosticState.active = true;
  quickPlayDiagnosticState.startedAt = Math.max(0, Number(now ?? Date.now()));
  quickPlayDiagnosticState.manualOwnerStopAt = quickPlayPassiveOwnerRequested(
    quickPlayDiagnosticState,
    QUICK_PLAY_OWNER_MANUAL_DIAGNOSTIC
  )
    ? quickPlayDiagnosticState.startedAt +
      Math.max(
        1,
        Number(
          quickPlayDiagnosticState.maxDurationMs ??
            DEFAULT_QUICK_PLAY_DIAGNOSTIC_DURATION_MS
        )
      )
    : 0;
  syncQuickPlayPassiveStopDeadline(quickPlayDiagnosticState, quickPlayDiagnosticState.startedAt);
  quickPlayDiagnosticState.finishedAt = 0;
  quickPlayDiagnosticState.nextSessionSurveyAt = 0;
  quickPlayDiagnosticState.nextClosureSurveyAt = 0;
  quickPlayDiagnosticState.wsEnvelopes = [];
  quickPlayDiagnosticState.wsPlayers = new Map();
  quickPlayDiagnosticState.sessionCandidates = new Map();
  quickPlayDiagnosticState.closureCandidates = new Map();
  quickPlayDiagnosticState.screenUsername = null;
  quickPlayDiagnosticState.diagnosticUsernameHint =
    normalizedScalar(usernameHint) ?? null;
  quickPlayDiagnosticState.sessionStorageKeys = {
    local: [],
    session: []
  };
  quickPlayDiagnosticState.storageIdentityRecords = [];
  quickPlayDiagnosticState.indexedDbCatalog = [];
  quickPlayDiagnosticState.sessionRuntimePathsChecked = [];
  quickPlayDiagnosticState.screenIdentityEvidence = [];
  quickPlayDiagnosticState.legacyPathProbe = {
    __NUXT__: false,
    state: false,
    session: false,
    user: false
  };
  quickPlayDiagnosticState.roundObserved = false;
  quickPlayDiagnosticState.roundCompleted = false;
  quickPlayDiagnosticState.stopReason = "";
  quickPlayDiagnosticState.localResolution = null;
  quickPlayDiagnosticState.captureGeneration = Math.max(
    0,
    Number(browserControlState?.modeGeneration ?? 0)
  );
  quickPlayDiagnosticState.currentTargetUrl = "";
  quickPlayDiagnosticState.nextPassiveSnapshotAt = 0;
  quickPlayDiagnosticState.passiveSnapshotFinalReason = "";
  quickPlayDiagnosticState.lastUsablePassiveSnapshot = null;
  quickPlayDiagnosticState.lastPassiveSnapshotError = null;
  quickPlayDiagnosticState.lastPassiveSnapshotLogSignature = "";
  quickPlayDiagnosticState.lastPassiveSnapshotLogAt = 0;
  quickPlayDiagnosticState.lastPassiveRootProbeSignature = "";
  quickPlayDiagnosticState.lastPassiveSnapshotFailureLogReason = "";
  clearQuickPlayBoundLocalClosureCandidate(quickPlayDiagnosticState);
  clearQuickPlayPendingIdentity(quickPlayDiagnosticState);
  quickPlayDiagnosticState.logFn = log;
  quickPlayDiagnosticState.sessionScanState = {
    pendingReason: "diagnostic_start"
  };
  quickPlayDiagnosticState.closureScanState = {
    pendingReason: "",
    attempts: 0,
    productiveAttempts: 0,
    nonproductiveAttempts: 0,
    timingMissCount: 0,
    retryScheduled: 0,
    retryExhausted: false,
    lastNoTickCallframes: 0,
    noTickAttempts: [],
    running: false,
    maxAttempts: DEFAULT_QUICK_PLAY_CLOSURE_SCAN_MAX_ATTEMPTS,
    maxNonproductiveAttempts:
      DEFAULT_QUICK_PLAY_CLOSURE_SCAN_MAX_NONPRODUCTIVE_ATTEMPTS,
    zenithRetryScheduled: false
  };
  quickPlayDiagnosticState.diagnostics = createQuickPlayDiagnosticState().diagnostics;
  if (quickPlayPassiveArtifactsEnabled(quickPlayDiagnosticState)) {
    clearQuickPlayDiagnosticFiles(quickPlayDiagnosticState);
    touchQuickPlayDiagnosticFile(quickPlayDiagnosticState.closurePath);
    touchQuickPlayDiagnosticFile(quickPlayDiagnosticState.callframePath);
  }
  markQuickPlayPassiveSnapshotUnavailable(
    quickPlayDiagnosticState,
    "diagnostic_start"
  );
  scheduleQuickPlaySessionSurvey(quickPlayDiagnosticState, {
    now: quickPlayDiagnosticState.startedAt,
    reason: "diagnostic_start"
  });
  log?.(
    `[quick-play] diagnostic capture started duration_ms=${
      quickPlayPassiveUsesOwnerLifecycle(quickPlayDiagnosticState)
        ? "owner_lifecycle"
        : Math.max(
            0,
            Number.isFinite(Number(quickPlayDiagnosticState.stopAt))
              ? quickPlayDiagnosticState.stopAt - quickPlayDiagnosticState.startedAt
              : 0
          )
    } packet_limit=${
      quickPlayPassivePacketLimit(quickPlayDiagnosticState) === null
        ? "unlimited"
        : quickPlayPassivePacketLimit(quickPlayDiagnosticState)
    }`
  );
  return { started: true };
}

function requestQuickPlayPassiveProviderOwner(
  quickPlayDiagnosticState,
  browserControlState,
  {
    owner,
    enabled = true,
    now = Date.now(),
    log = console.log,
    usernameHint = null
  } = {}
) {
  if (!quickPlayDiagnosticState) {
    return { started: false, reason: "state_missing" };
  }
  const normalizedOwner = normalizeQuickPlayPassiveOwner(owner);
  if (!normalizedOwner) {
    return { started: false, reason: "owner_invalid" };
  }
  const previousRequested = quickPlayPassiveOwnerRequested(
    quickPlayDiagnosticState,
    normalizedOwner
  );
  const previousHadOwners = hasAnyQuickPlayPassiveOwner(quickPlayDiagnosticState);
  const previousDiagnosticUsernameHint =
    quickPlayDiagnosticState.diagnosticUsernameHint ?? null;
  const normalizedUsernameHint = normalizedScalar(usernameHint) ?? null;
  const usernameHintChanged =
    Boolean(enabled) &&
    quickPlayDiagnosticState.diagnosticUsernameHint !== normalizedUsernameHint;
  if (
    quickPlayDiagnosticState.ownerRequests &&
    quickPlayDiagnosticState.ownerRequests[normalizedOwner] === Boolean(enabled) &&
    !usernameHintChanged
  ) {
    return { started: false, changed: false, active: quickPlayDiagnosticState.active === true };
  }
  quickPlayDiagnosticState.ownerRequests[normalizedOwner] = Boolean(enabled);
  if (enabled) {
    quickPlayDiagnosticState.diagnosticUsernameHint = normalizedUsernameHint;
  }
  if (normalizedOwner === QUICK_PLAY_OWNER_MANUAL_DIAGNOSTIC && enabled) {
    if (Number(quickPlayDiagnosticState.manualOwnerStopAt ?? 0) <= 0) {
      quickPlayDiagnosticState.manualOwnerStopAt =
        Math.max(0, Number(now ?? Date.now())) +
        Math.max(
          1,
          Number(
            quickPlayDiagnosticState.maxDurationMs ??
              DEFAULT_QUICK_PLAY_DIAGNOSTIC_DURATION_MS
          )
        );
    }
  }
  const nextHasOwners = hasAnyQuickPlayPassiveOwner(quickPlayDiagnosticState);
  if (!nextHasOwners) {
    if (!quickPlayDiagnosticState.active) {
      return { stopped: false, changed: previousRequested, active: false };
    }
    const stopped = stopQuickPlayDiagnosticCapture(quickPlayDiagnosticState, {
      now,
      reason: "disabled",
      log
    });
    return { stopped, changed: true, active: false };
  }
  if (!quickPlayDiagnosticState.active) {
    const result = activateQuickPlayPassiveCapture(
      quickPlayDiagnosticState,
      browserControlState,
      {
        now,
        log,
        usernameHint
      }
    );
    if (!result.started) {
      quickPlayDiagnosticState.ownerRequests[normalizedOwner] = previousRequested;
      quickPlayDiagnosticState.diagnosticUsernameHint = previousDiagnosticUsernameHint;
      return result;
    }
    return { ...result, changed: true };
  }
  syncQuickPlayPassiveStopDeadline(quickPlayDiagnosticState, now);
  if (quickPlayPassiveArtifactsEnabled(quickPlayDiagnosticState)) {
    touchQuickPlayDiagnosticFile(quickPlayDiagnosticState.closurePath);
    touchQuickPlayDiagnosticFile(quickPlayDiagnosticState.callframePath);
  }
  return {
    started: false,
    changed:
      usernameHintChanged ||
      !previousHadOwners ||
      previousRequested !== Boolean(enabled),
    active: true
  };
}

export function stopQuickPlayDiagnosticCapture(
  quickPlayDiagnosticState,
  {
    now = Date.now(),
    reason = "completed",
    log = console.log
  } = {}
) {
  const artifactsEnabled = quickPlayPassiveArtifactsEnabled(quickPlayDiagnosticState);
  if (!quickPlayDiagnosticState?.active) {
    if (quickPlayDiagnosticState?.ownerRequests) {
      quickPlayDiagnosticState.ownerRequests[QUICK_PLAY_OWNER_MANUAL_DIAGNOSTIC] = false;
      quickPlayDiagnosticState.ownerRequests[QUICK_PLAY_OWNER_ZENITH_DRY_RUN] = false;
    }
    return false;
  }
  quickPlayDiagnosticState.active = false;
  quickPlayDiagnosticState.ownerRequests[QUICK_PLAY_OWNER_MANUAL_DIAGNOSTIC] = false;
  quickPlayDiagnosticState.ownerRequests[QUICK_PLAY_OWNER_ZENITH_DRY_RUN] = false;
  quickPlayDiagnosticState.finishedAt = Math.max(0, Number(now ?? Date.now()));
  quickPlayDiagnosticState.stopReason = String(reason ?? "completed");
  quickPlayDiagnosticState.logFn = null;
  finalizeQuickPlayPassiveSnapshotState(
    quickPlayDiagnosticState,
    quickPlayDiagnosticState.stopReason
  );
  finalizeQuickPlayPassiveSnapshotDiagnostics(quickPlayDiagnosticState);
  if (artifactsEnabled) {
    const report = buildQuickPlayRuntimeReport(quickPlayDiagnosticState);
    writeSnapshot(quickPlayDiagnosticState.reportPath, report);
    log?.(
      `[quick-play] diagnostic capture stopped reason=${quickPlayDiagnosticState.stopReason} report=${quickPlayDiagnosticState.reportPath.replace(/\\/g, "/")}`
    );
  } else {
    log?.(
      `[quick-play] passive provider stopped reason=${quickPlayDiagnosticState.stopReason}`
    );
  }
  return true;
}

function clearQuickPlayDiagnosticFiles(quickPlayDiagnosticState) {
  for (const filePath of [
    quickPlayDiagnosticState?.reportPath,
    quickPlayDiagnosticState?.rawWsPath,
    quickPlayDiagnosticState?.closurePath,
    quickPlayDiagnosticState?.callframePath
  ]) {
    if (!filePath) {
      continue;
    }
    rmSync(filePath, { force: true });
  }
}

function appendJsonLine(filePath, payload) {
  const normalizedPath = String(filePath ?? "").trim();
  if (!normalizedPath) {
    return false;
  }
  mkdirSync(path.dirname(normalizedPath), { recursive: true });
  appendFileSync(normalizedPath, `${JSON.stringify(payload)}\n`);
  return true;
}

function writeJsonFile(filePath, payload) {
  const normalizedPath = String(filePath ?? "").trim();
  if (!normalizedPath) {
    return false;
  }
  mkdirSync(path.dirname(normalizedPath), { recursive: true });
  writeFileSync(normalizedPath, JSON.stringify(payload, null, 2));
  return true;
}

function readJsonFileIfPresent(filePath) {
  const normalizedPath = String(filePath ?? "").trim();
  if (!normalizedPath || !existsSync(normalizedPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(normalizedPath, "utf8"));
  } catch {
    return null;
  }
}

function normalizedScalar(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return null;
}

function normalizeIdentityText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function basenameFromUrlLike(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  try {
    const url = new URL(text);
    const pathname = String(url.pathname ?? "");
    return pathname.split("/").filter(Boolean).pop() ?? pathname;
  } catch {
    const normalized = text.replace(/\\/g, "/");
    return normalized.split("/").filter(Boolean).pop() ?? normalized;
  }
}

export function recordQuickPlayDiagnosticEnvelope(
  quickPlayDiagnosticState,
  envelope
) {
  if (!quickPlayDiagnosticState?.active || !envelope || typeof envelope !== "object") {
    return false;
  }
  const packetLimit = quickPlayPassivePacketLimit(quickPlayDiagnosticState);
  if (
    packetLimit !== null &&
    quickPlayDiagnosticState.wsEnvelopes.length >= packetLimit
  ) {
    quickPlayDiagnosticState.roundCompleted = true;
    quickPlayDiagnosticState.stopReason = "packet_limit_reached";
    return false;
  }
  const record = JSON.parse(JSON.stringify(envelope));
  quickPlayDiagnosticState.wsEnvelopes.push(record);
  if (quickPlayPassiveArtifactsEnabled(quickPlayDiagnosticState)) {
    appendJsonLine(quickPlayDiagnosticState.rawWsPath, record);
  }
  for (const player of record.players ?? []) {
    const key = [
      player?.userid ?? "",
      player?.gameid ?? "",
      player?.username ?? "",
      player?.source_path ?? ""
    ].join("|");
    quickPlayDiagnosticState.wsPlayers.set(key, {
      ...player,
      firstSeen: quickPlayDiagnosticState.wsPlayers.get(key)?.firstSeen ?? record.timestamp,
      lastSeen: record.timestamp
    });
  }
  if ((record.candidates ?? []).some((candidate) => candidate?.bagtype === "zenith")) {
    quickPlayDiagnosticState.roundObserved = true;
    maybeScheduleQuickPlayClosureRetryFromZenithOptions(
      quickPlayDiagnosticState,
      record.timestamp
    );
  }
  if (shouldAllowQuickPlayGameplaySignalScan(quickPlayDiagnosticState, record)) {
    scheduleQuickPlayClosureSurvey(quickPlayDiagnosticState, {
      now: Math.max(0, Number(record.timestamp ?? Date.now())),
      delayMs: 0,
      reason: "gameplay_signal"
    });
  }
  return true;
}

export function mergeQuickPlaySessionSurvey(
  quickPlayDiagnosticState,
  survey,
  now = Date.now()
) {
  if (!quickPlayDiagnosticState || !survey || typeof survey !== "object") {
    return false;
  }
  quickPlayDiagnosticState.screenUsername =
    normalizedScalar(survey.screenUsername) ?? quickPlayDiagnosticState.screenUsername;
  quickPlayDiagnosticState.sessionStorageKeys = {
    local: Array.isArray(survey.storageKeys?.local)
      ? survey.storageKeys.local.slice(0, 32)
      : quickPlayDiagnosticState.sessionStorageKeys.local,
    session: Array.isArray(survey.storageKeys?.session)
      ? survey.storageKeys.session.slice(0, 32)
      : quickPlayDiagnosticState.sessionStorageKeys.session
  };
  quickPlayDiagnosticState.storageIdentityRecords = Array.isArray(
    survey.storageIdentityRecords
  )
    ? survey.storageIdentityRecords.slice(0, 16).map((entry) => ({
        path: normalizedScalar(entry?.path) ?? "",
        parsed: entry?.parsed === true,
        safe_fields: {
          userid: normalizedScalar(entry?.safeFields?.userid) ?? null,
          username: normalizedScalar(entry?.safeFields?.username) ?? null
        },
        sensitive_fields_redacted: entry?.sensitiveFieldsRedacted !== false
      }))
    : quickPlayDiagnosticState.storageIdentityRecords;
  quickPlayDiagnosticState.indexedDbCatalog = Array.isArray(survey.indexedDbCatalog)
    ? survey.indexedDbCatalog.slice(0, 8).map((entry) => ({
        database: normalizedScalar(entry?.database) ?? null,
        object_stores: Array.isArray(entry?.objectStores)
          ? entry.objectStores
              .map((objectStore) => normalizedScalar(objectStore))
              .filter((objectStore) => typeof objectStore === "string")
              .slice(0, 16)
          : []
      }))
    : quickPlayDiagnosticState.indexedDbCatalog;
  quickPlayDiagnosticState.sessionRuntimePathsChecked = Array.isArray(
    survey.runtimePathsChecked
  )
    ? survey.runtimePathsChecked.slice(0, 32).map((entry) => ({
        path: normalizedScalar(entry?.path) ?? "",
        exists: entry?.exists === true,
        keys: Array.isArray(entry?.keys) ? entry.keys.slice(0, 16) : [],
        userid_present: entry?.useridPresent === true,
        username_present: entry?.usernamePresent === true,
        screen_username_matches:
          typeof entry?.screenUsernameMatches === "boolean"
            ? entry.screenUsernameMatches
            : null,
        candidate_kind: normalizedScalar(entry?.candidateKind) ?? null
      }))
    : quickPlayDiagnosticState.sessionRuntimePathsChecked;
  quickPlayDiagnosticState.screenIdentityEvidence = Array.isArray(
    survey.screenIdentityEvidence
  )
    ? survey.screenIdentityEvidence.slice(0, 12).map((entry) => ({
        selector: normalizedScalar(entry?.selector) ?? null,
        text: normalizedScalar(entry?.text) ?? null,
        dataset: Array.isArray(entry?.dataset) ? entry.dataset.slice(0, 8) : []
      }))
    : quickPlayDiagnosticState.screenIdentityEvidence;
  if (survey.legacyPath && typeof survey.legacyPath === "object") {
    quickPlayDiagnosticState.legacyPathProbe = {
      __NUXT__: Boolean(survey.legacyPath.__NUXT__),
      state: Boolean(survey.legacyPath.state),
      session: Boolean(survey.legacyPath.session),
      user: Boolean(survey.legacyPath.user)
    };
    quickPlayDiagnosticState.diagnostics.session_scan.legacy_path_result =
      quickPlayDiagnosticState.legacyPathProbe;
  }
  quickPlayDiagnosticState.diagnostics.session_scan.runtime_paths_checked =
    quickPlayDiagnosticState.sessionRuntimePathsChecked;
  quickPlayDiagnosticState.diagnostics.session_scan.storage_identity_records =
    quickPlayDiagnosticState.storageIdentityRecords;
  quickPlayDiagnosticState.diagnostics.session_scan.indexed_db_catalog =
    quickPlayDiagnosticState.indexedDbCatalog;
  quickPlayDiagnosticState.diagnostics.session_scan.storage_keys =
    quickPlayDiagnosticState.sessionStorageKeys;
  quickPlayDiagnosticState.diagnostics.session_scan.screen_identity_evidence =
    quickPlayDiagnosticState.screenIdentityEvidence;
  for (const candidate of survey.candidates ?? []) {
    const pathLabel = String(candidate?.path ?? "").trim();
    if (!pathLabel) {
      continue;
    }
    const previous = quickPlayDiagnosticState.sessionCandidates.get(pathLabel);
    quickPlayDiagnosticState.sessionCandidates.set(pathLabel, {
      path: pathLabel,
      keys: Array.isArray(candidate?.keys) ? candidate.keys.slice(0, 16) : [],
      userid: normalizedScalar(candidate?.userid),
      username: normalizedScalar(candidate?.username),
      userid_present: Boolean(candidate?.useridPresent),
      username_present: Boolean(candidate?.usernamePresent),
      screen_username_matches:
        typeof candidate?.screenUsernameMatches === "boolean"
          ? candidate.screenUsernameMatches
          : null,
      candidate_kind: normalizedScalar(candidate?.candidateKind) ?? "unknown",
      evidence: Array.isArray(candidate?.evidence)
        ? candidate.evidence
            .map((entry) => normalizedScalar(entry))
            .filter((entry) => typeof entry === "string")
            .slice(0, 8)
        : [],
      firstSeen: previous?.firstSeen ?? now,
      lastSeen: now
    });
  }
  return true;
}

export function recordQuickPlayClosureCandidates(
  quickPlayDiagnosticState,
  scan,
  now = Date.now()
) {
  if (!quickPlayDiagnosticState || !scan || typeof scan !== "object") {
    return false;
  }
  const closureDiagnostics = quickPlayDiagnosticState.diagnostics.closure_scan;
  const rawCandidates = Array.isArray(scan.rawCandidates)
    ? scan.rawCandidates
    : Array.isArray(scan.candidates)
      ? scan.candidates
      : [];
  let changed = false;
  let anyPlaying = false;
  let endedTransition = false;
  const artifactsEnabled = quickPlayPassiveArtifactsEnabled(quickPlayDiagnosticState);
  closureDiagnostics.raw_candidate_count += rawCandidates.length;
  for (const rawCandidate of rawCandidates) {
    const rejectedReasons = Array.isArray(rawCandidate?.rejectedReason)
      ? rawCandidate.rejectedReason
      : Array.isArray(rawCandidate?.rejected_reason)
        ? rawCandidate.rejected_reason
        : [];
    for (const reason of rejectedReasons) {
      const key = String(reason ?? "").trim();
      if (!key) {
        continue;
      }
      closureDiagnostics.rejection_counts[key] =
        Math.max(0, Number(closureDiagnostics.rejection_counts[key] ?? 0)) + 1;
    }
    if (artifactsEnabled) {
      appendJsonLine(quickPlayDiagnosticState.closurePath, {
        timestamp: now,
        attempt: Math.max(0, Number(scan.attempt ?? 0)),
        result_type: normalizedScalar(scan.resultType) ?? "completed",
        function_name:
          normalizedScalar(rawCandidate?.functionName ?? rawCandidate?.function_name) ?? null,
        call_frame_index: Number.isFinite(Number(rawCandidate?.callFrameIndex ?? rawCandidate?.call_frame_index))
          ? Math.max(0, Number(rawCandidate?.callFrameIndex ?? rawCandidate?.call_frame_index))
          : null,
        scope_index: Number.isFinite(Number(rawCandidate?.scopeIndex ?? rawCandidate?.scope_index))
          ? Math.max(0, Number(rawCandidate?.scopeIndex ?? rawCandidate?.scope_index))
          : null,
        scope_type:
          normalizedScalar(rawCandidate?.scopeType ?? rawCandidate?.scope_type) ?? null,
        candidate_id: normalizedScalar(rawCandidate?.candidateId ?? rawCandidate?.candidate_id),
        locator: normalizedScalar(rawCandidate?.locator) ?? null,
        binding_name:
          normalizedScalar(rawCandidate?.bindingName ?? rawCandidate?.binding_name) ?? null,
        retained_root_kind:
          normalizedScalar(rawCandidate?.retainedRootKind ?? rawCandidate?.retained_root_kind) ??
          null,
        retained_root_path: Array.isArray(rawCandidate?.retainedRootPath)
          ? rawCandidate.retainedRootPath.slice(0, 8)
          : Array.isArray(rawCandidate?.retained_root_path)
            ? rawCandidate.retained_root_path.slice(0, 8)
            : [],
        full_path:
          normalizedScalar(rawCandidate?.fullPath ?? rawCandidate?.full_path) ?? null,
        matched_shape:
          normalizedScalar(rawCandidate?.matchedShape ?? rawCandidate?.matched_shape) ?? null,
        discovered_paths:
          rawCandidate?.discoveredPaths && typeof rawCandidate.discoveredPaths === "object"
            ? {
                board: Array.isArray(rawCandidate.discoveredPaths.board)
                  ? rawCandidate.discoveredPaths.board.slice(0, 8)
                  : [],
                current: Array.isArray(rawCandidate.discoveredPaths.current)
                  ? rawCandidate.discoveredPaths.current.slice(0, 8)
                  : [],
                hold: Array.isArray(rawCandidate.discoveredPaths.hold)
                  ? rawCandidate.discoveredPaths.hold.slice(0, 8)
                  : [],
                queue: Array.isArray(rawCandidate.discoveredPaths.queue)
                  ? rawCandidate.discoveredPaths.queue.slice(0, 8)
                  : []
              }
            : rawCandidate?.discovered_paths && typeof rawCandidate.discovered_paths === "object"
              ? rawCandidate.discovered_paths
              : null,
        object_keys: Array.isArray(rawCandidate?.objectKeys)
          ? rawCandidate.objectKeys.slice(0, 20)
          : Array.isArray(rawCandidate?.object_keys)
            ? rawCandidate.object_keys.slice(0, 20)
            : [],
        typeof: normalizedScalar(rawCandidate?.typeof) ?? null,
        has_board_like: rawCandidate?.hasBoardLike === true,
        has_current_like: rawCandidate?.hasCurrentLike === true,
        has_queue_like: rawCandidate?.hasQueueLike === true,
        has_hold_like: rawCandidate?.hasHoldLike === true,
        has_gameid: rawCandidate?.hasGameId === true,
        has_seed: rawCandidate?.hasSeed === true,
        has_userid: rawCandidate?.hasUserId === true,
        rejected_reason: rejectedReasons
          .map((entry) => normalizedScalar(entry))
          .filter((entry) => typeof entry === "string")
          .slice(0, 8)
      });
    }
  }
  for (const candidate of scan.acceptedCandidates ?? scan.candidates ?? []) {
    const candidateId = String(candidate?.candidateId ?? "").trim();
    if (!candidateId) {
      continue;
    }
    closureDiagnostics.accepted_candidate_count += 1;
    const previous = quickPlayDiagnosticState.closureCandidates.get(candidateId);
    const next = {
      candidate_id: candidateId,
      locator: normalizedScalar(candidate?.locator) ?? candidateId,
      function_name: normalizedScalar(candidate?.functionName),
      call_frame_index: Number.isFinite(Number(candidate?.callFrameIndex))
        ? Math.max(0, Number(candidate.callFrameIndex))
        : null,
      scope_index: Number.isFinite(Number(candidate?.scopeIndex))
        ? Math.max(0, Number(candidate.scopeIndex))
        : null,
      scope_type: normalizedScalar(candidate?.scopeType),
      binding_name: normalizedScalar(candidate?.bindingName),
      retained_root_kind:
        normalizedScalar(candidate?.retainedRootKind ?? candidate?.retained_root_kind) ??
        "binding",
      retained_root_path: Array.isArray(candidate?.retainedRootPath)
        ? candidate.retainedRootPath.slice(0, 8)
        : Array.isArray(candidate?.retained_root_path)
          ? candidate.retained_root_path.slice(0, 8)
          : [],
      matched_shape: normalizedScalar(candidate?.matchedShape),
      discovered_paths:
        candidate?.discoveredPaths && typeof candidate.discoveredPaths === "object"
          ? {
              board: Array.isArray(candidate.discoveredPaths.board)
                ? candidate.discoveredPaths.board.slice(0, 8)
                : [],
              current: Array.isArray(candidate.discoveredPaths.current)
                ? candidate.discoveredPaths.current.slice(0, 8)
                : [],
              hold: Array.isArray(candidate.discoveredPaths.hold)
                ? candidate.discoveredPaths.hold.slice(0, 8)
                : [],
              queue: Array.isArray(candidate.discoveredPaths.queue)
                ? candidate.discoveredPaths.queue.slice(0, 8)
                : []
            }
          : candidate?.discovered_paths && typeof candidate.discovered_paths === "object"
            ? candidate.discovered_paths
            : null,
      object_keys: Array.isArray(candidate?.objectKeys)
        ? candidate.objectKeys.slice(0, 20)
        : [],
      gameid: normalizedScalar(candidate?.gameid),
      seed: normalizedScalar(candidate?.seed),
      userid: normalizedScalar(candidate?.userid),
      pieceCounter: Number.isFinite(Number(candidate?.pieceCounter))
        ? Math.max(0, Math.floor(Number(candidate.pieceCounter)))
        : null,
      current: normalizedScalar(candidate?.current),
      hold: normalizedScalar(candidate?.hold),
      queue: Array.isArray(candidate?.queue)
        ? candidate.queue.slice(0, 10).map((entry) => normalizedScalar(entry))
        : [],
      board_width: Number.isFinite(Number(candidate?.boardWidth))
        ? Math.max(0, Math.floor(Number(candidate.boardWidth)))
        : null,
      board_height: Number.isFinite(Number(candidate?.boardHeight))
        ? Math.max(0, Math.floor(Number(candidate.boardHeight)))
        : null,
      board_hash: normalizedScalar(candidate?.boardHash),
      row_occupancy: Array.isArray(candidate?.rowOccupancy)
        ? candidate.rowOccupancy.slice(0, 20)
        : [],
      playing: candidate?.playing === true,
      ended: candidate?.ended === true,
      firstSeen: previous?.firstSeen ?? now,
      lastSeen: now
    };
    if (next.playing) {
      anyPlaying = true;
      quickPlayDiagnosticState.roundObserved = true;
    }
    if (previous?.playing === true && next.playing === false && next.ended === true) {
      endedTransition = true;
    }
    quickPlayDiagnosticState.closureCandidates.set(candidateId, next);
    changed = true;
  }
  if (quickPlayDiagnosticState.roundObserved && endedTransition && !anyPlaying) {
    quickPlayDiagnosticState.roundCompleted = true;
    quickPlayDiagnosticState.stopReason = "round_completed";
  }
  if (!changed && rawCandidates.length === 0) {
    return false;
  }
  return changed;
}

function valuesEqual(left, right) {
  return left !== null && left !== undefined && right !== null && right !== undefined && String(left) === String(right);
}

function buildMatchEvidence(wsPlayer, closureCandidate) {
  const matchedBy = [];
  if (valuesEqual(wsPlayer?.userid, closureCandidate?.userid)) {
    matchedBy.push("userid");
  }
  if (valuesEqual(wsPlayer?.gameid, closureCandidate?.gameid)) {
    matchedBy.push("gameid");
  }
  if (valuesEqual(wsPlayer?.seed, closureCandidate?.seed)) {
    matchedBy.push("seed");
  }
  const overlaps =
    Number(closureCandidate?.firstSeen ?? 0) <= Number(wsPlayer?.lastSeen ?? 0) &&
    Number(wsPlayer?.firstSeen ?? 0) <= Number(closureCandidate?.lastSeen ?? 0);
  if (overlaps) {
    matchedBy.push("timing_overlap");
  }
  return matchedBy;
}

function hasResolvedQuickPlayIdentity(evidence = null) {
  const userid = normalizeIdentityText(evidence?.userid);
  const gameid = normalizedScalar(evidence?.gameid);
  return Boolean(userid) && gameid !== null;
}

function envelopeHasExplicitSelfMarker(envelope = null) {
  const fields = [
    ...(envelope?.root_keys ?? []),
    ...(envelope?.payload_keys ?? []),
    ...(envelope?.candidate_paths ?? [])
  ]
    .map((entry) => String(entry ?? "").toLowerCase());
  return fields.some((entry) =>
    /(self|local|me|client|you|currentuser|current_user)/.test(entry)
  );
}

function resolveQuickPlayWsSelfEvidence(quickPlayDiagnosticState) {
  const evidence = [];
  const rejectedStrategies = [];
  const envelopes = quickPlayDiagnosticState?.wsEnvelopes ?? [];
  const sessionCandidates = [...(quickPlayDiagnosticState?.sessionCandidates?.values?.() ?? [])];
  const wsPlayers = [...(quickPlayDiagnosticState?.wsPlayers?.values?.() ?? [])];

  for (const envelope of envelopes) {
    if (!envelopeHasExplicitSelfMarker(envelope)) {
      continue;
    }
    const player = (envelope.players ?? []).find(
      (entry) => entry?.userid || entry?.username
    );
    if (!player) {
      continue;
    }
    evidence.push({
      kind: "explicit_ws_marker",
      direction: envelope.direction,
      websocket_request_id:
        normalizedScalar(envelope.websocket_request_id) ??
        normalizedScalar(envelope.request_id) ??
        null,
      packet_shape: {
        event: normalizedScalar(envelope.event) ?? null,
        type: normalizedScalar(envelope.type) ?? null,
        command: normalizedScalar(envelope.command) ?? null,
        root_keys: Array.isArray(envelope.root_keys)
          ? envelope.root_keys.slice(0, 12)
          : [],
        payload_keys: Array.isArray(envelope.payload_keys)
          ? envelope.payload_keys.slice(0, 12)
          : []
      },
      userid: normalizedScalar(player.userid) ?? null,
      username: normalizedScalar(player.username) ?? null,
      gameid: normalizedScalar(player.gameid) ?? null
    });
  }

  if (evidence.length === 0) {
    rejectedStrategies.push("no_explicit_ws_self_marker");
  }

  if (evidence.length === 0) {
    const correlatedPairs = [];
    const outboundByMessageRequestId = new Map();
    for (const envelope of envelopes) {
      const messageRequestId =
        normalizedScalar(envelope.message_request_id) ??
        normalizedScalar(envelope.request_id) ??
        null;
      if (!messageRequestId) {
        continue;
      }
      if (envelope.direction === "outbound") {
        outboundByMessageRequestId.set(messageRequestId, envelope);
        continue;
      }
      const outbound = outboundByMessageRequestId.get(messageRequestId);
      if (!outbound) {
        continue;
      }
      const outboundPlayer = (outbound.players ?? []).find(
        (player) => player?.userid || player?.username
      );
      const inboundPlayer = (envelope.players ?? []).find(
        (player) => player?.userid || player?.gameid
      );
      if (!outboundPlayer || !inboundPlayer) {
        continue;
      }
      correlatedPairs.push({
        kind: "request_correlation",
        message_request_id: messageRequestId,
        outbound_shape: {
          event: normalizedScalar(outbound.event) ?? null,
          type: normalizedScalar(outbound.type) ?? null,
          command: normalizedScalar(outbound.command) ?? null
        },
        inbound_shape: {
          event: normalizedScalar(envelope.event) ?? null,
          type: normalizedScalar(envelope.type) ?? null,
          command: normalizedScalar(envelope.command) ?? null
        },
        userid: normalizedScalar(outboundPlayer.userid ?? inboundPlayer.userid) ?? null,
        username:
          normalizedScalar(outboundPlayer.username ?? inboundPlayer.username) ?? null,
        gameid: normalizedScalar(inboundPlayer.gameid) ?? null
      });
    }
    evidence.push(...correlatedPairs);
    if (correlatedPairs.length === 0) {
      rejectedStrategies.push("no_outbound_inbound_request_correlation");
    }
  }

  if (evidence.length === 0) {
    const runtimeCandidate = sessionCandidates.find(
      (candidate) =>
        candidate?.candidate_kind === "storage_identity" &&
        candidate?.userid_present === true &&
        (candidate?.userid || candidate?.username)
    );
    if (runtimeCandidate) {
      const wsPlayer = wsPlayers.find((player) =>
        valuesEqual(player.userid, runtimeCandidate.userid)
      );
      if (wsPlayer) {
        evidence.push({
          kind: "storage_identity_candidate",
          path: runtimeCandidate.path,
          userid: normalizedScalar(runtimeCandidate.userid) ?? null,
          username: normalizedScalar(runtimeCandidate.username) ?? null,
          gameid: normalizedScalar(wsPlayer.gameid) ?? null
        });
      }
    } else {
      rejectedStrategies.push("no_verified_storage_identity_candidate");
    }
  }

  if (evidence.length === 0) {
    const usernameHint = normalizeIdentityText(
      quickPlayDiagnosticState?.diagnosticUsernameHint
    );
    if (!usernameHint) {
      rejectedStrategies.push("no_diagnostic_username_hint");
    } else {
      const matchedProfiles = wsPlayers.filter(
        (player) => normalizeIdentityText(player.username) === usernameHint
      );
      const uniqueUserIds = [...new Set(
        matchedProfiles
          .map((player) => normalizedScalar(player.userid))
          .filter(Boolean)
      )];
      if (uniqueUserIds.length !== 1) {
        rejectedStrategies.push("diagnostic_username_not_unique_to_userid");
      } else {
        const matchedUserId = uniqueUserIds[0];
        const matchedGames = wsPlayers.filter(
          (player) =>
            valuesEqual(player.userid, matchedUserId) &&
            normalizedScalar(player.gameid) !== null
        );
        const uniqueGameIds = [...new Set(
          matchedGames
            .map((player) => normalizedScalar(player.gameid))
            .filter((value) => value !== null)
        )];
        if (uniqueGameIds.length !== 1) {
          rejectedStrategies.push("diagnostic_userid_not_unique_to_gameid");
        } else {
          evidence.push({
            kind: "diagnostic_username_hint",
            username: matchedProfiles[0]?.username ?? null,
            userid: matchedUserId,
            gameid: uniqueGameIds[0]
          });
        }
      }
    }
  }

  if (evidence.length === 0) {
    return {
      status: "unresolved",
      userid: null,
      gameid: null,
      evidence: [],
      rejected_strategies: rejectedStrategies
    };
  }

  const winner = evidence.find((entry) => hasResolvedQuickPlayIdentity(entry)) ?? null;
  if (!winner) {
    rejectedStrategies.push("resolved_identity_invariant_failed");
    return {
      status: "unresolved",
      userid: null,
      gameid: null,
      evidence,
      rejected_strategies: [...new Set(rejectedStrategies)]
    };
  }
  return {
    status: "resolved",
    userid: normalizedScalar(winner.userid) ?? null,
    gameid: normalizedScalar(winner.gameid) ?? null,
    evidence,
    rejected_strategies: [...new Set(rejectedStrategies)]
  };
}

export function buildQuickPlayRuntimeReport(quickPlayDiagnosticState) {
  const sessionCandidates = [...(quickPlayDiagnosticState?.sessionCandidates?.values?.() ?? [])];
  const wsPlayers = [...(quickPlayDiagnosticState?.wsPlayers?.values?.() ?? [])];
  const closureCandidates = [...(quickPlayDiagnosticState?.closureCandidates?.values?.() ?? [])];
  const matches = [];
  const unresolvedWsPlayers = [];
  for (const wsPlayer of wsPlayers) {
    let bestMatch = null;
    let bestEvidence = [];
    for (const closureCandidate of closureCandidates) {
      const evidence = buildMatchEvidence(wsPlayer, closureCandidate).filter(
        (entry) => entry !== "timing_overlap"
      );
      if (evidence.length === 0) {
        continue;
      }
      if (bestMatch === null || evidence.length > bestEvidence.length) {
        bestMatch = closureCandidate;
        bestEvidence = buildMatchEvidence(wsPlayer, closureCandidate);
      }
    }
    if (!bestMatch) {
      unresolvedWsPlayers.push(wsPlayer);
      continue;
    }
    const stableIdentifiers = bestEvidence.filter((entry) =>
      ["userid", "gameid", "seed"].includes(entry)
    );
    matches.push({
      ws_player_id: [
        wsPlayer.userid ?? "",
        wsPlayer.gameid ?? "",
        wsPlayer.username ?? ""
      ].join("|"),
      closure_candidate_id: bestMatch.candidate_id,
      matched_by: bestEvidence,
      confidence:
        stableIdentifiers.length >= 2
          ? "high"
          : bestEvidence.includes("timing_overlap")
            ? "medium"
            : "low"
    });
  }
  const wsSelfEvidence = resolveQuickPlayWsSelfEvidence(quickPlayDiagnosticState);
  const localResolution = resolveQuickPlayLocalPlayer(
    quickPlayDiagnosticState,
    sessionCandidates,
    wsPlayers,
    closureCandidates,
    wsSelfEvidence
  );
  return {
    started_at: quickPlayDiagnosticState?.startedAt ?? 0,
    finished_at:
      quickPlayDiagnosticState?.finishedAt ??
      quickPlayDiagnosticState?.stopAt ??
      quickPlayDiagnosticState?.startedAt ??
      0,
    stop_reason: quickPlayDiagnosticState?.stopReason ?? "",
    legacy_path_probe: quickPlayDiagnosticState?.legacyPathProbe ?? {},
    screen_username: quickPlayDiagnosticState?.screenUsername ?? null,
    session_candidates: sessionCandidates,
    ws_players: wsPlayers,
    closure_candidates: closureCandidates,
    matches,
    local_resolution: localResolution,
    diagnostics: {
      session_scan: {
        scheduled: Math.max(
          0,
          Number(quickPlayDiagnosticState?.diagnostics?.session_scan?.scheduled ?? 0)
        ),
        attempts: Math.max(
          0,
          Number(quickPlayDiagnosticState?.diagnostics?.session_scan?.attempts ?? 0)
        ),
        completed: Math.max(
          0,
          Number(quickPlayDiagnosticState?.diagnostics?.session_scan?.completed ?? 0)
        ),
        errors: Array.isArray(
          quickPlayDiagnosticState?.diagnostics?.session_scan?.errors
        )
          ? quickPlayDiagnosticState.diagnostics.session_scan.errors.slice(0, 12)
          : [],
        legacy_path_result:
          quickPlayDiagnosticState?.diagnostics?.session_scan?.legacy_path_result ??
          {},
        runtime_paths_checked:
          quickPlayDiagnosticState?.diagnostics?.session_scan?.runtime_paths_checked ??
          [],
        storage_identity_records:
          quickPlayDiagnosticState?.diagnostics?.session_scan
            ?.storage_identity_records ?? [],
        indexed_db_catalog:
          quickPlayDiagnosticState?.diagnostics?.session_scan
            ?.indexed_db_catalog ?? [],
        storage_keys:
          quickPlayDiagnosticState?.diagnostics?.session_scan?.storage_keys ?? {
            local: [],
            session: []
          },
        screen_identity_evidence:
          quickPlayDiagnosticState?.diagnostics?.session_scan?.screen_identity_evidence ??
          []
      },
      closure_scan: {
        scheduled: Math.max(
          0,
          Number(quickPlayDiagnosticState?.diagnostics?.closure_scan?.scheduled ?? 0)
        ),
        attempts: Math.max(
          0,
          Number(quickPlayDiagnosticState?.diagnostics?.closure_scan?.attempts ?? 0)
        ),
        productive_attempts: Math.max(
          0,
          Number(
            quickPlayDiagnosticState?.diagnostics?.closure_scan?.productive_attempts ?? 0
          )
        ),
        nonproductive_attempts: Math.max(
          0,
          Number(
            quickPlayDiagnosticState?.diagnostics?.closure_scan?.nonproductive_attempts ?? 0
          )
        ),
        timing_miss_count: Math.max(
          0,
          Number(
            quickPlayDiagnosticState?.diagnostics?.closure_scan?.timing_miss_count ?? 0
          )
        ),
        timing_miss_reasons:
          quickPlayDiagnosticState?.diagnostics?.closure_scan?.timing_miss_reasons ?? {},
        retry_scheduled: Math.max(
          0,
          Number(quickPlayDiagnosticState?.diagnostics?.closure_scan?.retry_scheduled ?? 0)
        ),
        retry_exhausted:
          quickPlayDiagnosticState?.diagnostics?.closure_scan?.retry_exhausted === true,
        last_no_tick_callframes: Math.max(
          0,
          Number(
            quickPlayDiagnosticState?.diagnostics?.closure_scan?.last_no_tick_callframes ?? 0
          )
        ),
        no_tick_attempts: Array.isArray(
          quickPlayDiagnosticState?.diagnostics?.closure_scan?.no_tick_attempts
        )
          ? quickPlayDiagnosticState.diagnostics.closure_scan.no_tick_attempts.slice(0, 12)
          : [],
        completed: Math.max(
          0,
          Number(quickPlayDiagnosticState?.diagnostics?.closure_scan?.completed ?? 0)
        ),
        skipped: Math.max(
          0,
          Number(quickPlayDiagnosticState?.diagnostics?.closure_scan?.skipped ?? 0)
        ),
        skip_reasons:
          quickPlayDiagnosticState?.diagnostics?.closure_scan?.skip_reasons ?? {},
        pause_requested: Math.max(
          0,
          Number(quickPlayDiagnosticState?.diagnostics?.closure_scan?.pause_requested ?? 0)
        ),
        pause_acquired: Math.max(
          0,
          Number(quickPlayDiagnosticState?.diagnostics?.closure_scan?.pause_acquired ?? 0)
        ),
        callframes_seen: Math.max(
          0,
          Number(quickPlayDiagnosticState?.diagnostics?.closure_scan?.callframes_seen ?? 0)
        ),
        tick_frames_seen: Math.max(
          0,
          Number(quickPlayDiagnosticState?.diagnostics?.closure_scan?.tick_frames_seen ?? 0)
        ),
        selected_tick_frames: Math.max(
          0,
          Number(quickPlayDiagnosticState?.diagnostics?.closure_scan?.selected_tick_frames ?? 0)
        ),
        matching_frames_seen: Math.max(
          0,
          Number(
            quickPlayDiagnosticState?.diagnostics?.closure_scan?.matching_frames_seen ?? 0
          )
        ),
        matching_scopes_seen: Math.max(
          0,
          Number(
            quickPlayDiagnosticState?.diagnostics?.closure_scan?.matching_scopes_seen ?? 0
          )
        ),
        candidate_closure_scopes_seen: Math.max(
          0,
          Number(
            quickPlayDiagnosticState?.diagnostics?.closure_scan
              ?.candidate_closure_scopes_seen ?? 0
          )
        ),
        selected_primary_scopes: Math.max(
          0,
          Number(
            quickPlayDiagnosticState?.diagnostics?.closure_scan
              ?.selected_primary_scopes ?? 0
          )
        ),
        selected_secondary_scopes: Math.max(
          0,
          Number(
            quickPlayDiagnosticState?.diagnostics?.closure_scan
              ?.selected_secondary_scopes ?? 0
          )
        ),
        targeted_inspections: Math.max(
          0,
          Number(
            quickPlayDiagnosticState?.diagnostics?.closure_scan?.targeted_inspections ?? 0
          )
        ),
        generic_targets_seen: Math.max(
          0,
          Number(
            quickPlayDiagnosticState?.diagnostics?.closure_scan?.generic_targets_seen ?? 0
          )
        ),
        target_handoff_mismatches: Math.max(
          0,
          Number(
            quickPlayDiagnosticState?.diagnostics?.closure_scan
              ?.target_handoff_mismatches ?? 0
          )
        ),
        inventory_rows_written: Math.max(
          0,
          Number(
            quickPlayDiagnosticState?.diagnostics?.closure_scan?.inventory_rows_written ?? 0
          )
        ),
        errors: Array.isArray(
          quickPlayDiagnosticState?.diagnostics?.closure_scan?.errors
        )
          ? quickPlayDiagnosticState.diagnostics.closure_scan.errors.slice(0, 12)
          : [],
        raw_candidate_count: Math.max(
          0,
          Number(
            quickPlayDiagnosticState?.diagnostics?.closure_scan?.raw_candidate_count ??
              0
          )
        ),
        accepted_candidate_count: Math.max(
          0,
          Number(
            quickPlayDiagnosticState?.diagnostics?.closure_scan
              ?.accepted_candidate_count ?? 0
          )
        ),
        targeted_binding_inspection:
          quickPlayDiagnosticState?.diagnostics?.closure_scan
            ?.targeted_binding_inspection ?? null,
        targeted_binding_inspections: Array.isArray(
          quickPlayDiagnosticState?.diagnostics?.closure_scan?.targeted_binding_inspections
        )
          ? quickPlayDiagnosticState.diagnostics.closure_scan.targeted_binding_inspections
          : [],
        rejection_counts:
          quickPlayDiagnosticState?.diagnostics?.closure_scan?.rejection_counts ??
          {}
      },
      passive_snapshot: {
        candidate_bound_current:
          quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.candidate_bound_current ===
          true,
        identity_bound_current:
          quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.identity_bound_current ===
          true,
        candidate_id:
          quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.candidate_id ?? null,
        bind_attempts: Math.max(
          0,
          Number(quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.bind_attempts ?? 0)
        ),
        bind_succeeded: Math.max(
          0,
          Number(quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.bind_succeeded ?? 0)
        ),
        bind_deferred: Math.max(
          0,
          Number(quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.bind_deferred ?? 0)
        ),
        bind_deferred_reasons:
          quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.bind_deferred_reasons ?? {},
        candidate_retained:
          quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.candidate_retained === true,
        candidate_retain_attempts: Math.max(
          0,
          Number(
            quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.candidate_retain_attempts ?? 0
          )
        ),
        candidate_retain_succeeded: Math.max(
          0,
          Number(
            quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.candidate_retain_succeeded ??
              0
          )
        ),
        candidate_retain_failed: Math.max(
          0,
          Number(
            quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.candidate_retain_failed ?? 0
          )
        ),
        candidate_retain_failure_reasons:
          quickPlayDiagnosticState?.diagnostics?.passive_snapshot
            ?.candidate_retain_failure_reasons ?? {},
        last_candidate_retain_failure:
          quickPlayDiagnosticState?.diagnostics?.passive_snapshot
            ?.last_candidate_retain_failure ?? "",
        identity_available:
          quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.identity_available === true,
        polling_started:
          quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.polling_started === true,
        reads_attempted: Math.max(
          0,
          Number(quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.reads_attempted ?? 0)
        ),
        transport_reads_succeeded: Math.max(
          0,
          Number(
            quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.transport_reads_succeeded ?? 0
          )
        ),
        transport_reads_failed: Math.max(
          0,
          Number(
            quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.transport_reads_failed ?? 0
          )
        ),
        reads_succeeded: Math.max(
          0,
          Number(quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.reads_succeeded ?? 0)
        ),
        reads_failed: Math.max(
          0,
          Number(quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.reads_failed ?? 0)
        ),
        semantic_reads_succeeded: Math.max(
          0,
          Number(
            quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.semantic_reads_succeeded ?? 0
          )
        ),
        semantic_reads_failed: Math.max(
          0,
          Number(
            quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.semantic_reads_failed ?? 0
          )
        ),
        semantic_failure_reasons:
          quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.semantic_failure_reasons ??
          {},
        ever_candidate_bound:
          quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.ever_candidate_bound === true,
        ever_identity_bound:
          quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.ever_identity_bound === true,
        last_success_at: Math.max(
          0,
          Number(quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.last_success_at ?? 0)
        ),
        last_failure_reason:
          quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.last_failure_reason ?? "",
        board_normalized:
          quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.board_normalized === true,
        current_normalized:
          quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.current_normalized === true,
        hold_normalized:
          quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.hold_normalized === true,
        queue_normalized:
          quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.queue_normalized === true,
        field_diagnostics:
          quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.field_diagnostics ?? null,
        candidate_bound:
          quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.candidate_bound_current ===
          true,
        identity_bound:
          quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.identity_bound_current ===
          true
      }
    },
    ws_self_evidence: wsSelfEvidence,
    unresolved: {
      ws_players: unresolvedWsPlayers.map((player) => ({
        userid: player.userid ?? null,
        username: player.username ?? null,
        gameid: player.gameid ?? null
      })),
      closure_candidates: closureCandidates
        .filter((candidate) => !matches.some((match) => match.closure_candidate_id === candidate.candidate_id))
        .map((candidate) => candidate.candidate_id)
    }
  };
}

function resolveQuickPlayLocalPlayer(
  quickPlayDiagnosticState,
  sessionCandidates,
  wsPlayers,
  closureCandidates,
  wsSelfEvidence
) {
  if (wsSelfEvidence?.status !== "resolved") {
    return null;
  }
  const wsPlayer = wsPlayers.find((player) =>
    valuesEqual(player.userid, wsSelfEvidence.userid) ||
    valuesEqual(player.gameid, wsSelfEvidence.gameid)
  );
  if (!wsPlayer) {
    return null;
  }
  const boundCandidate = quickPlayDiagnosticState?.boundLocalClosureCandidate ?? null;
  if (
    boundCandidate?.identityBound === true &&
    boundCandidate?.candidateId &&
    valuesEqual(boundCandidate.userid, wsPlayer.userid) &&
    valuesEqual(boundCandidate.gameid, wsPlayer.gameid) &&
    Math.max(0, Number(boundCandidate.generation ?? -1)) ===
      Math.max(0, Number(quickPlayDiagnosticState?.captureGeneration ?? 0))
  ) {
    return {
      status: "resolved",
      userid: normalizedScalar(wsPlayer.userid) ?? null,
      gameid: normalizedScalar(wsPlayer.gameid) ?? null,
      session_candidate_path: null,
      ws_player_id: [
        wsPlayer.userid ?? "",
        wsPlayer.gameid ?? "",
        wsPlayer.username ?? ""
      ].join("|"),
      closure_candidate_id: boundCandidate.candidateId,
      matched_by: ["explicit_ws_marker", "unique_local_tick_closure"],
      confidence: "high"
    };
  }
  const sessionCandidate = sessionCandidates.find(
    (candidate) =>
      candidate?.candidate_kind === "storage_identity" &&
      valuesEqual(candidate.userid, wsPlayer.userid)
  );
  const closureMatch = closureCandidates.find((candidate) =>
    valuesEqual(candidate.gameid, wsPlayer.gameid) ||
    valuesEqual(candidate.seed, wsPlayer.seed) ||
    valuesEqual(candidate.userid, wsPlayer.userid)
  );
  const matchedBy = [];
  if (
    sessionCandidate &&
    sessionCandidate.candidate_kind === "storage_identity" &&
    valuesEqual(sessionCandidate.userid, wsPlayer.userid)
  ) {
    matchedBy.push("storage_identity_userid");
  }
  if (closureMatch) {
    matchedBy.push(...buildMatchEvidence(wsPlayer, closureMatch));
  }
  if (matchedBy.length === 0) {
    matchedBy.push(...(wsSelfEvidence.evidence ?? []).map((entry) => entry?.kind).filter(Boolean));
  }
  if (matchedBy.length === 0) {
    return null;
  }
  if (!closureMatch) {
    return {
      status: "identity_resolved_closure_unresolved",
      userid: normalizedScalar(wsPlayer.userid) ?? null,
      gameid: normalizedScalar(wsPlayer.gameid) ?? null,
      session_candidate_path: sessionCandidate?.path ?? null,
      ws_player_id: [
        wsPlayer.userid ?? "",
        wsPlayer.gameid ?? "",
        wsPlayer.username ?? ""
      ].join("|"),
      closure_candidate_id: null,
      matched_by: [...new Set(matchedBy)],
      confidence: sessionCandidate ? "medium" : "low"
    };
  }
  return {
    status: "resolved",
    userid: normalizedScalar(wsPlayer.userid) ?? null,
    gameid: normalizedScalar(wsPlayer.gameid) ?? null,
    session_candidate_path: sessionCandidate?.path ?? null,
    ws_player_id: [
      wsPlayer.userid ?? "",
      wsPlayer.gameid ?? "",
      wsPlayer.username ?? ""
    ].join("|"),
    closure_candidate_id: closureMatch?.candidate_id ?? null,
    matched_by: [...new Set(matchedBy)],
    confidence:
      matchedBy.includes("storage_identity_userid") && closureMatch
        ? "high"
        : matchedBy.includes("storage_identity_userid")
          ? "medium"
          : "low"
  };
}

export function quickPlaySessionCandidateSurveyExpression() {
  return `(() => (async () => {
    const scalar = (value) =>
      value === null ||
      value === undefined ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
        ? value
        : undefined;
    const normalize = (value) => String(value ?? "").trim().toLowerCase();
    const gatherStorageKeys = (storage) => {
      try {
        const keys = [];
        const length = Math.min(32, Number(storage?.length ?? 0));
        for (let index = 0; index < length; index += 1) {
          const key = scalar(storage.key(index));
          if (typeof key === "string" && key) {
            keys.push(key);
          }
        }
        return keys.sort();
      } catch {
        return [];
      }
    };
    const collectIndexedDbCatalog = async () => {
      if (!window.indexedDB || typeof window.indexedDB.databases !== "function") {
        return [];
      }
      let databases = [];
      try {
        databases = await window.indexedDB.databases();
      } catch {
        databases = [];
      }
      const catalog = [];
      for (const databaseEntry of Array.isArray(databases) ? databases.slice(0, 8) : []) {
        const databaseName = scalar(databaseEntry?.name);
        if (typeof databaseName !== "string" || !databaseName) {
          continue;
        }
        let objectStores = [];
        try {
          objectStores = await new Promise((resolve) => {
            const request = window.indexedDB.open(databaseName);
            request.onerror = () => resolve([]);
            request.onupgradeneeded = () => {
              try {
                request.transaction?.abort?.();
              } catch {}
              resolve([]);
            };
            request.onsuccess = () => {
              try {
                const names = Array.from(request.result?.objectStoreNames ?? [])
                  .map((name) => scalar(name))
                  .filter((name) => typeof name === "string" && name)
                  .slice(0, 16);
                request.result?.close?.();
                resolve(names);
              } catch {
                resolve([]);
              }
            };
          });
        } catch {
          objectStores = [];
        }
        catalog.push({
          database: databaseName,
          objectStores
        });
      }
      return catalog;
    };
    const collectSafeIdentityFields = (value) => {
      if (!value || typeof value !== "object") {
        return {
          userid: null,
          username: null
        };
      }
      return {
        userid:
          scalar(value.userid ?? value.user_id ?? value._id) ?? null,
        username: scalar(value.username ?? value.name) ?? null
      };
    };
    const selectors = [
      'a[href*="/u/"]',
      'a[href*="/users/"]',
      '[data-user]',
      '[data-username]',
      '.user',
      '.username'
    ];
    const screenIdentityEvidence = [];
    for (const selector of selectors) {
      const element = document.querySelector?.(selector);
      if (!element) {
        continue;
      }
      const text =
        scalar(element?.getAttribute?.("data-username")) ??
        scalar(element?.getAttribute?.("data-user")) ??
        scalar(element?.textContent) ??
        null;
      const normalizedText = normalize(text);
      const datasetKeys =
        element?.dataset && typeof element.dataset === "object"
          ? Object.keys(element.dataset).slice(0, 8)
          : [];
      screenIdentityEvidence.push({
        selector,
        text: scalar(text) ?? null,
        dataset: datasetKeys,
        candidateKind: "unknown_dom"
      });
    }
    const localStorageKeys = gatherStorageKeys(window.localStorage);
    const sessionStorageKeys = gatherStorageKeys(window.sessionStorage);
    const indexedDbCatalog = await collectIndexedDbCatalog();
    const storageIdentityRecords = [];
    const parseStorageRecord = (storage, storageLabel, key) => {
      const path = storageLabel + "." + key;
      let rawValue = null;
      try {
        rawValue = storage?.getItem?.(key) ?? null;
      } catch {
        rawValue = null;
      }
      if (typeof rawValue !== "string" || rawValue.trim() === "") {
        storageIdentityRecords.push({
          path,
          parsed: false,
          safeFields: {
            userid: null,
            username: null
          },
          sensitiveFieldsRedacted: true
        });
        return null;
      }
      let parsedValue = null;
      try {
        parsedValue = JSON.parse(rawValue);
      } catch {
        storageIdentityRecords.push({
          path,
          parsed: false,
          safeFields: {
            userid: null,
            username: null
          },
          sensitiveFieldsRedacted: true
        });
        return null;
      }
      const safeFields = collectSafeIdentityFields(parsedValue);
      storageIdentityRecords.push({
        path,
        parsed: true,
        safeFields,
        sensitiveFieldsRedacted: true
      });
      if (
        key !== "userConfig" ||
        (!safeFields.userid && !safeFields.username)
      ) {
        return null;
      }
      return {
        path,
        keys: Object.keys(parsedValue).slice(0, 16),
        userid: safeFields.userid,
        username: safeFields.username,
        useridPresent: Boolean(safeFields.userid),
        usernamePresent: Boolean(safeFields.username),
        screenUsernameMatches: null,
        candidateKind: "storage_identity",
        evidence: ["local_storage_user_config"]
      };
    };
    const legacyPath = {
      __NUXT__: Boolean(window.__NUXT__),
      state: Boolean(window.__NUXT__?.state),
      session: Boolean(window.__NUXT__?.state?.session),
      user: Boolean(window.__NUXT__?.state?.session?.user)
    };
    const runtimeRoots = [
      { path: "window.__NUXT__", value: window.__NUXT__ },
      { path: "window.__NUXT__.state", value: window.__NUXT__?.state },
      { path: "window.__NUXT__.state.session", value: window.__NUXT__?.state?.session },
      { path: "window.__NUXT__.state.session.user", value: window.__NUXT__?.state?.session?.user },
      { path: "window.__NUXT__.state.room", value: window.__NUXT__?.state?.room },
      { path: "window.$nuxt", value: window.$nuxt },
      { path: "window.$nuxt.$store", value: window.$nuxt?.$store },
      { path: "window.$nuxt.$store.state", value: window.$nuxt?.$store?.state },
      { path: "window.app", value: window.app },
      { path: "window.app.$store", value: window.app?.$store },
      { path: "window.app.store", value: window.app?.store },
      { path: "window.app.room", value: window.app?.room },
      { path: "window.app.pinia", value: window.app?.pinia },
      { path: "window.store", value: window.store },
      { path: "window.store.room", value: window.store?.room },
      { path: "window.__pinia", value: window.__pinia },
      { path: "window.tetrio", value: window.tetrio },
      { path: "window.socket", value: window.socket },
      { path: "window.client", value: window.client },
      { path: "window.wsclient", value: window.wsclient },
      { path: "window.__APOLLO_CLIENT__", value: window.__APOLLO_CLIENT__ }
    ];
    const nestedKeys = [
      "state",
      "$state",
      "session",
      "user",
      "profile",
      "account",
      "auth",
      "room",
      "players",
      "leaderboard",
      "roster",
      "currentUser",
      "current_user",
      "me",
      "self"
    ];
    const participantHints = /players?|leaderboard|entrants?|bracket|roster|copies|naturalorder|opponents?|gameid|slot|index/i;
    const sessionHints = /session|account|auth|profile|user|self|me|store|state/i;
    const candidates = [];
    const runtimePathsChecked = [];
    const seenCandidatePaths = new Set();
    const inspectValue = (value, path, inheritedKind = "") => {
      if (!value || typeof value !== "object") {
        runtimePathsChecked.push({
          path,
          exists: false,
          keys: [],
          useridPresent: false,
          usernamePresent: false,
          screenUsernameMatches: null,
          candidateKind: inheritedKind || null
        });
        return;
      }
      const keys = Object.keys(value).slice(0, 16);
      const userid = scalar(value.userid ?? value._id ?? value.user_id);
      const username = scalar(value.username ?? value.name);
      let candidateKind = inheritedKind || "runtime_object";
      const evidence = [];
      if (participantHints.test(path)) {
        candidateKind = "participant_candidate";
        evidence.push("path_contains_participant_hint");
      }
      if (
        Object.prototype.hasOwnProperty.call(value, "players") ||
        Object.prototype.hasOwnProperty.call(value, "options") ||
        scalar(value.gameid ?? value.game_id) !== undefined ||
        scalar(value.naturalorder ?? value.slot ?? value.index) !== undefined
      ) {
        candidateKind = "participant_candidate";
        evidence.push("contains_roster_or_game_fields");
      } else if (
        path.endsWith(".user") ||
        path.endsWith(".profile") ||
        path.endsWith(".account") ||
        path.endsWith(".auth") ||
        path.endsWith(".me") ||
        path.endsWith(".self")
      ) {
        candidateKind = "session_user";
        evidence.push("leaf_session_identity_path");
      } else if (sessionHints.test(path)) {
        candidateKind = "session_candidate";
        evidence.push("path_contains_session_hint");
      }
      const normalizedUsername = normalize(username);
      runtimePathsChecked.push({
        path,
        exists: true,
        keys,
        useridPresent: userid !== undefined,
        usernamePresent: username !== undefined,
        screenUsernameMatches: null,
        candidateKind
      });
      if ((userid !== undefined || username !== undefined) && !seenCandidatePaths.has(path)) {
        seenCandidatePaths.add(path);
        candidates.push({
          path,
          keys,
          userid: userid ?? null,
          username: username ?? null,
          useridPresent: userid !== undefined,
          usernamePresent: username !== undefined,
          screenUsernameMatches: null,
          candidateKind,
          evidence
        });
      }
    };
    for (const root of runtimeRoots) {
      inspectValue(root.value, root.path, sessionHints.test(root.path) ? "session_candidate" : "");
      if (!root.value || typeof root.value !== "object") {
        continue;
      }
      for (const key of nestedKeys) {
        let nextValue;
        try {
          nextValue = root.value[key];
        } catch {
          continue;
        }
        inspectValue(
          nextValue,
          root.path + "." + key,
          /user|profile|account|auth|me|self/i.test(key) ? "session_user" : ""
        );
        if (Array.isArray(nextValue)) {
          for (let index = 0; index < Math.min(3, nextValue.length); index += 1) {
            inspectValue(
              nextValue[index],
              root.path + "." + key + "[" + index + "]",
              /players|leaderboard|roster/i.test(key) ? "participant_candidate" : ""
            );
          }
        }
      }
    }
    for (const key of localStorageKeys) {
      const candidate = parseStorageRecord(window.localStorage, "localStorage", key);
      if (candidate && !seenCandidatePaths.has(candidate.path)) {
        seenCandidatePaths.add(candidate.path);
        candidates.push(candidate);
      }
    }
    for (const key of sessionStorageKeys) {
      parseStorageRecord(window.sessionStorage, "sessionStorage", key);
    }
    return {
      status: "ready",
      screenUsername: null,
      legacyPath,
      storageKeys: {
        local: localStorageKeys,
        session: sessionStorageKeys
      },
      indexedDbCatalog,
      storageIdentityRecords,
      screenIdentityEvidence,
      runtimePathsChecked,
      candidates
    };
  })())()`;
}

export function quickPlayClosureCandidateScanExpression() {
  return `(() => {
    const normalizePiece = (piece) => {
      if (typeof piece === "string") {
        const token = piece.trim().toLowerCase();
        return ["i", "o", "t", "s", "z", "j", "l"].includes(token) ? token : null;
      }
      if (piece && typeof piece === "object") {
        return normalizePiece(piece.type ?? piece.name ?? piece.kind ?? piece.id);
      }
      return null;
    };
    const scalar = (value) =>
      value === null ||
      value === undefined ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
        ? value
        : undefined;
    const numberFrom = (...values) => {
      for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number)) return number;
      }
      return null;
    };
    const rowCells = (row) =>
      Array.isArray(row)
        ? row
        : Array.isArray(row?.cells)
          ? row.cells
          : Array.isArray(row?.row)
            ? row.row
            : null;
    const filled = (cell) => {
      if (cell === null || cell === undefined || cell === false || cell === 0 || cell === "") return false;
      if (typeof cell === "string") {
        const text = cell.trim().toLowerCase();
        return text !== "" && text !== "." && text !== "0" && text !== "empty";
      }
      if (typeof cell === "object") {
        if ("empty" in cell) return !cell.empty;
        if ("type" in cell) return filled(cell.type);
        if ("mino" in cell) return filled(cell.mino);
      }
      return true;
    };
    const queueFrom = (...values) => {
      for (const value of values) {
        if (!Array.isArray(value)) continue;
        const queue = value.map(normalizePiece).filter(Boolean);
        if (queue.length > 0) return queue.slice(0, 10);
      }
      return [];
    };
    const looksLikeGame = (value) =>
      value &&
      typeof value === "object" &&
      typeof value.ejectState === "function" &&
      typeof value.ejectBoardState === "function";
    const summarizeBoard = (board) => {
      const rows = [];
      let hash = 2166136261 >>> 0;
      for (let rowIndex = 0; rowIndex < Math.min(40, board.length); rowIndex += 1) {
        const sourceRow = board[board.length - 1 - rowIndex];
        const cells = rowCells(sourceRow);
        let filledCount = 0;
        for (let x = 0; x < 10; x += 1) {
          const active = filled(cells ? cells[x] : null) ? 1 : 0;
          filledCount += active;
          hash ^= active + x + rowIndex * 17;
          hash = Math.imul(hash, 16777619) >>> 0;
        }
        rows.push(filledCount);
      }
      return {
        boardHash: hash.toString(16).padStart(8, "0"),
        rowOccupancy: rows
      };
    };
    const candidateRoots = [
      { path: "window.__fusionTetrioGame", value: window.__fusionTetrioGame },
      { path: "window.__fusionEndedTetrioGame", value: window.__fusionEndedTetrioGame },
      { path: "window.tetrioGame", value: window.tetrioGame },
      { path: "window.TETRIO_GAME", value: window.TETRIO_GAME },
      { path: "window.game", value: window.game },
      { path: "window.app", value: window.app },
      { path: "window.tetrio", value: window.tetrio }
    ];
    const seenObjects = new WeakSet();
    const seenPaths = new Set();
    const results = [];
    const visit = (value, path, depth = 0) => {
      if (!value || typeof value !== "object" || seenPaths.has(path) || depth > 2) return;
      seenPaths.add(path);
      if (seenObjects.has(value)) return;
      seenObjects.add(value);
      if (looksLikeGame(value)) {
        try {
          const exported = value.ejectState();
          const boardState = value.ejectBoardState();
          const state = exported && typeof exported === "object" && exported.game ? exported.game : exported;
          const board = Array.isArray(state?.board) ? state.board : Array.isArray(boardState?.b) ? boardState.b : null;
          if (!state || !Array.isArray(board) || board.length === 0) return;
          const activeState = state.falling ?? state.active ?? state.current ?? state.piece;
          const current = normalizePiece(activeState);
          const hold = normalizePiece(state.hold ?? state.held);
          const queue = queueFrom(state.bag, state.queue, state.next, state.preview, state.previews, state.pieces);
          const boardSummary = summarizeBoard(board);
          const playing =
            typeof value.isPlaying === "function" ? Boolean(value.isPlaying()) :
            typeof state.playing === "boolean" ? state.playing :
            typeof state.paused === "boolean" ? !state.paused :
            true;
          const started =
            typeof value.isStarted === "function" ? Boolean(value.isStarted()) :
            Boolean(state.started ?? true);
          const ended = Boolean(state.destroyed || state.dead || state.gameover || (started && !playing));
          results.push({
            candidateId: path,
            locator: path,
            objectKeys: Object.getOwnPropertyNames(value).slice(0, 20),
            gameid: scalar(state.gameid ?? state.game_id ?? state.options?.gameid ?? state.room?.gameid),
            seed: scalar(state.seed ?? state.options?.seed ?? state.room?.seed),
            userid: scalar(state.userid ?? state.user_id ?? state.user?._id ?? state.user?.userid),
            pieceCounter: Math.max(0, Math.floor(numberFrom(
              state?.stats?.piecesplaced,
              state?.stats?.piecesPlaced,
              state?.stats?.pieces,
              state.piecesplaced,
              state.piecesPlaced,
              state.pieceCounter,
              state.piececount,
              0
            ) ?? 0)),
            current,
            hold,
            queue,
            boardWidth: rowCells(board[0])?.length ?? 10,
            boardHeight: board.length,
            boardHash: boardSummary.boardHash,
            rowOccupancy: boardSummary.rowOccupancy,
            playing,
            ended
          });
        } catch {}
      }
      if (depth >= 2) return;
      const names = Object.getOwnPropertyNames(value).slice(0, 40);
      for (const name of names) {
        let nextValue;
        try {
          nextValue = value[name];
        } catch {
          continue;
        }
        if (nextValue && typeof nextValue === "object") {
          visit(nextValue, path + "." + name, depth + 1);
        }
      }
    };
    for (const root of candidateRoots) {
      visit(root.value, root.path, 0);
    }
    for (const name of Object.getOwnPropertyNames(window).slice(0, 160)) {
      let value;
      try {
        value = window[name];
      } catch {
        continue;
      }
      if (value && typeof value === "object") {
        visit(value, "window." + name, 0);
      }
    }
    return {
      status: "ready",
      candidates: results.slice(0, 24)
    };
  })()`;
}

async function surveyQuickPlaySessionCandidates(cdp, transientState, log = console.log) {
  const raw = await safeRuntimeEvaluate(
    cdp,
    {
      expression: quickPlaySessionCandidateSurveyExpression(),
      returnByValue: true,
      awaitPromise: true
    },
    { result: { value: { status: "not_ready", candidates: [] } } },
    { transientState, log }
  );
  return raw?.result?.value ?? { status: "not_ready", candidates: [] };
}

function buildLocatorPropertyChain(locator, suffix = []) {
  const chain = String(locator ?? "")
    .split(/[.[\]]+/)
    .map((part) => String(part ?? "").trim())
    .filter(Boolean);
  return [...chain, ...suffix];
}

async function readScopeBindingNames(cdp, scopeObjectId) {
  if (!scopeObjectId) {
    return [];
  }
  const properties = await cdp.send("Runtime.getProperties", {
    objectId: scopeObjectId,
    ownProperties: true,
    accessorPropertiesOnly: false,
    generatePreview: false
  }).catch(() => null);
  return (properties?.result ?? [])
    .filter((descriptor) => !descriptor?.get && !descriptor?.set)
    .map((descriptor) => String(descriptor?.name ?? "").trim())
    .filter(Boolean)
    .slice(0, MAX_SCOPE_PROPERTIES_PER_SCOPE);
}

async function buildQuickPlayPausedFrameInventory(cdp, pausedEvent) {
  if (!pausedEvent || !("callFrames" in pausedEvent)) {
    return {
      resultType: "callframes_missing",
      callFrames: [],
      frameInventory: []
    };
  }
  const callFrames = Array.isArray(pausedEvent?.callFrames) ? pausedEvent.callFrames : [];
  const frameInventory = [];
  for (let callFrameIndex = 0; callFrameIndex < callFrames.length; callFrameIndex += 1) {
    const callFrame = callFrames[callFrameIndex];
    const scopeChain = Array.isArray(callFrame?.scopeChain) ? callFrame.scopeChain : [];
    const scopes = [];
    for (let scopeIndex = 0; scopeIndex < scopeChain.length; scopeIndex += 1) {
      const scope = scopeChain[scopeIndex];
      const bindingNames = await readScopeBindingNames(cdp, scope?.object?.objectId);
      scopes.push({
        scope_index: scopeIndex,
        scope_type: normalizedScalar(scope?.type) ?? null,
        binding_count: bindingNames.length,
        binding_names: bindingNames.slice(0, 40)
      });
    }
    frameInventory.push({
      attempt: 0,
      call_frame_index: callFrameIndex,
      function_name: normalizedScalar(callFrame?.functionName) ?? null,
      script_id:
        normalizedScalar(callFrame?.location?.scriptId) ??
        normalizedScalar(callFrame?.functionLocation?.scriptId) ??
        null,
      script_url_basename: basenameFromUrlLike(
        callFrame?.url ?? callFrame?.documentURL ?? ""
      ),
      line_number: Number.isFinite(Number(callFrame?.location?.lineNumber))
        ? Number(callFrame.location.lineNumber)
        : null,
      column_number: Number.isFinite(Number(callFrame?.location?.columnNumber))
        ? Number(callFrame.location.columnNumber)
        : null,
      scope_types: scopes.map((scope) => scope.scope_type),
      scopes
    });
  }
  return {
    resultType: callFrames.length === 0 ? "callframes_empty" : "ready",
    callFrames,
    frameInventory
  };
}

function writeQuickPlayCallFrameInventory(
  cdp,
  quickPlayDiagnosticState,
  frameInventory,
  attempt
) {
  let rowsWritten = 0;
  try {
    if (!quickPlayPassiveArtifactsEnabled(quickPlayDiagnosticState)) {
      return {
        ok: true,
        rowsWritten: 0
      };
    }
    for (const row of Array.isArray(frameInventory) ? frameInventory : []) {
      appendJsonLine(quickPlayDiagnosticState?.callframePath, {
        ...row,
        attempt
      });
      rowsWritten += 1;
    }
    return {
      ok: true,
      rowsWritten
    };
  } catch (error) {
    return {
      ok: false,
      rowsWritten,
      error: String(error?.message ?? error ?? "inventory_write_failed")
    };
  }
}

function clearQuickPlayBoundLocalClosureCandidate(quickPlayDiagnosticState) {
  if (!quickPlayDiagnosticState) {
    return "";
  }
  const objectId = String(
    quickPlayDiagnosticState.boundLocalClosureCandidate?.rootObjectId ?? ""
  );
  quickPlayDiagnosticState.boundLocalClosureCandidate = {
    generation: 0,
    targetId: "",
    candidateId: "",
    rootObjectId: "",
    retainedRootKind: "binding",
    retainedRootPath: [],
    rootPath: [],
    functionName: "",
    callFrameIndex: -1,
    scopeIndex: -1,
    scopeType: "",
    bindingName: "",
    boardPath: [],
    currentPath: [],
    holdPath: [],
    queuePath: [],
    capturedAt: 0,
    userid: null,
    gameid: null,
    wsPlayerId: "",
    identityBound: false
  };
  return objectId;
}

function clearQuickPlayPendingIdentity(quickPlayDiagnosticState) {
  if (!quickPlayDiagnosticState) {
    return false;
  }
  quickPlayDiagnosticState.pendingIdentity = {
    generation: 0,
    userid: null,
    gameid: null,
    wsPlayerId: "",
    resolvedAt: 0
  };
  return true;
}

function noteQuickPlayPassiveBindReason(diagnostics, reason) {
  if (!diagnostics) {
    return false;
  }
  const key = String(reason ?? "").trim() || "unknown";
  diagnostics.bind_deferred_reasons[key] =
    Math.max(0, Number(diagnostics.bind_deferred_reasons[key] ?? 0)) + 1;
  return true;
}

function syncQuickPlayPassiveSnapshotCurrentState(quickPlayDiagnosticState) {
  const diagnostics = quickPlayDiagnosticState?.diagnostics?.passive_snapshot;
  if (!diagnostics) {
    return false;
  }
  diagnostics.candidate_bound_current = isQuickPlayPassiveRuntimeCandidateReady(
    quickPlayDiagnosticState?.boundLocalClosureCandidate
  );
  diagnostics.identity_bound_current =
    quickPlayDiagnosticState?.boundLocalClosureCandidate?.identityBound === true;
  diagnostics.candidate_bound = diagnostics.candidate_bound_current;
  diagnostics.identity_bound = diagnostics.identity_bound_current;
  diagnostics.candidate_retained = Boolean(
    quickPlayDiagnosticState?.boundLocalClosureCandidate?.rootObjectId
  );
  diagnostics.identity_available =
    normalizedScalar(quickPlayDiagnosticState?.pendingIdentity?.userid) !== null &&
    normalizedScalar(quickPlayDiagnosticState?.pendingIdentity?.gameid) !== null;
  diagnostics.candidate_id =
    normalizedScalar(quickPlayDiagnosticState?.boundLocalClosureCandidate?.candidateId) ?? null;
  return true;
}

function finalizeQuickPlayPassiveSnapshotDiagnostics(quickPlayDiagnosticState) {
  const diagnostics = quickPlayDiagnosticState?.diagnostics?.passive_snapshot;
  const closureDiagnostics = quickPlayDiagnosticState?.diagnostics?.closure_scan;
  if (!diagnostics || !closureDiagnostics) {
    return false;
  }
  if (
    Math.max(0, Number(closureDiagnostics.accepted_candidate_count ?? 0)) >= 1 &&
    diagnostics.identity_available === true &&
    Math.max(0, Number(diagnostics.candidate_retain_succeeded ?? 0)) >= 1 &&
    Math.max(0, Number(diagnostics.bind_succeeded ?? 0)) === 0 &&
    Math.max(0, Number(diagnostics.reads_attempted ?? 0)) === 0
  ) {
    diagnostics.last_failure_reason = "accepted_candidate_invariant_failed";
  } else if (
    Math.max(0, Number(closureDiagnostics.accepted_candidate_count ?? 0)) >= 1 &&
    Math.max(0, Number(diagnostics.candidate_retain_failed ?? 0)) >= 1 &&
    !String(diagnostics.last_failure_reason ?? "").trim()
  ) {
    diagnostics.last_failure_reason = "candidate_retain_failed";
  }
  return true;
}

function finalizeQuickPlayPassiveSnapshotState(
  quickPlayDiagnosticState,
  reason = "inactive"
) {
  if (!quickPlayDiagnosticState) {
    return false;
  }
  quickPlayDiagnosticState.passiveSnapshotFinalReason = String(reason ?? "inactive");
  if (quickPlayDiagnosticState.lastUsablePassiveSnapshot) {
    return writeQuickPlayPassiveSnapshotState(quickPlayDiagnosticState, {
      status: "ready",
      capture_status: "stopped",
      stopped_reason: quickPlayDiagnosticState.passiveSnapshotFinalReason,
      snapshot: quickPlayDiagnosticState.lastUsablePassiveSnapshot,
      last_read_error: quickPlayDiagnosticState.lastPassiveSnapshotError ?? null
    });
  }
  const lastError = quickPlayDiagnosticState.lastPassiveSnapshotError ?? null;
  const payload = {
    status: "unavailable",
    reason:
      Math.max(
        0,
        Number(
          quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.semantic_reads_failed ??
            0
        )
      ) > 0 ||
      Math.max(
        0,
        Number(
          quickPlayDiagnosticState?.diagnostics?.passive_snapshot?.transport_reads_failed ??
            0
        )
      ) > 0
        ? normalizedScalar(lastError?.reason) ??
          quickPlayDiagnosticState.passiveSnapshotFinalReason
        :
      quickPlayDiagnosticState.passiveSnapshotFinalReason,
  };
  if (lastError?.field_diagnostics) {
    payload.field_diagnostics = lastError.field_diagnostics;
  }
  return writeQuickPlayPassiveSnapshotState(quickPlayDiagnosticState, payload);
}

function writeQuickPlayPassiveSnapshotState(
  quickPlayDiagnosticState,
  payload = { status: "unavailable", reason: "inactive" }
) {
  const filePath = String(quickPlayDiagnosticState?.passiveSnapshotPath ?? "").trim();
  if (!filePath) {
    return false;
  }
  writeSnapshot(filePath, payload);
  return true;
}

function markQuickPlayPassiveSnapshotUnavailable(
  quickPlayDiagnosticState,
  reason = "inactive"
) {
  const diagnostics = quickPlayDiagnosticState?.diagnostics?.passive_snapshot;
  if (!diagnostics) {
    return false;
  }
  syncQuickPlayPassiveSnapshotCurrentState(quickPlayDiagnosticState);
  diagnostics.last_failure_reason = String(reason ?? "inactive");
  diagnostics.board_normalized = false;
  diagnostics.current_normalized = false;
  diagnostics.hold_normalized = false;
  diagnostics.queue_normalized = false;
  if (!quickPlayDiagnosticState.lastUsablePassiveSnapshot) {
    quickPlayDiagnosticState.lastPassiveSnapshotError = {
      reason: String(reason ?? "inactive"),
      field_diagnostics: diagnostics.field_diagnostics ?? null
    };
  }
  if (quickPlayDiagnosticState.lastUsablePassiveSnapshot) {
    return writeQuickPlayPassiveSnapshotState(quickPlayDiagnosticState, {
      status: "ready",
      capture_status: quickPlayDiagnosticState.active ? "running" : "stopped",
      stopped_reason: quickPlayDiagnosticState.active ? null : quickPlayDiagnosticState.stopReason || null,
      snapshot: quickPlayDiagnosticState.lastUsablePassiveSnapshot,
      last_read_error: quickPlayDiagnosticState.lastPassiveSnapshotError ?? {
        reason: String(reason ?? "inactive"),
        field_diagnostics: diagnostics.field_diagnostics ?? null
      }
    });
  }
  const payload = {
    status: "unavailable",
    reason: String(reason ?? "inactive")
  };
  if (diagnostics.field_diagnostics) {
    payload.field_diagnostics = diagnostics.field_diagnostics;
  }
  return writeQuickPlayPassiveSnapshotState(quickPlayDiagnosticState, payload);
}

export async function releaseQuickPlayPassiveState(
  cdp,
  quickPlayDiagnosticState,
  {
    reason = "released",
    writeSnapshotStatus = true,
    preserveDiagnostics = true,
    log = console.log
  } = {}
) {
  const objectId = clearQuickPlayBoundLocalClosureCandidate(quickPlayDiagnosticState);
  clearQuickPlayPendingIdentity(quickPlayDiagnosticState);
  quickPlayDiagnosticState.nextPassiveSnapshotAt = 0;
  if (!preserveDiagnostics && quickPlayDiagnosticState?.diagnostics?.passive_snapshot) {
    quickPlayDiagnosticState.diagnostics.passive_snapshot = {
      ...createQuickPlayDiagnosticState().diagnostics.passive_snapshot
    };
  }
  syncQuickPlayPassiveSnapshotCurrentState(quickPlayDiagnosticState);
  if (writeSnapshotStatus) {
    markQuickPlayPassiveSnapshotUnavailable(quickPlayDiagnosticState, reason);
  }
  if (!objectId || !cdp?.send) {
    return false;
  }
  await cdp.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
  await cdp.send("Runtime.releaseObjectGroup", {
    objectGroup: "fusion-quick-play-passive"
  }).catch(() => undefined);
  if (typeof log === "function") {
    log(`[quick-play] passive snapshot unavailable reason=${reason}`);
  }
  return true;
}

function buildQuickPlayBoardPathFromCandidate(candidate = null) {
  const matchedShape = String(candidate?.matchedShape ?? "").trim();
  if (!matchedShape) {
    return [];
  }
  return matchedShape.split(".").map((part) => String(part ?? "").trim()).filter(Boolean);
}

function normalizeQuickPlayPathParts(value, limit = 8) {
  return Array.isArray(value)
    ? value
        .map((part) => String(part ?? "").trim())
        .filter(Boolean)
        .slice(0, limit)
    : [];
}

function inferQuickPlayRetainedRootKind(pathParts = []) {
  const normalized = normalizeQuickPlayPathParts(pathParts);
  const terminal = String(normalized[normalized.length - 1] ?? "").trim().toLowerCase();
  if (terminal === "state") {
    return "state";
  }
  if (terminal === "game") {
    return "game";
  }
  return "binding";
}

function rebaseQuickPlayAccessorPath(pathParts = [], rootPath = []) {
  const normalizedPath = normalizeQuickPlayPathParts(pathParts);
  const normalizedRoot = normalizeQuickPlayPathParts(rootPath);
  if (normalizedRoot.length === 0) {
    return normalizedPath;
  }
  if (normalizedPath.length < normalizedRoot.length) {
    return [];
  }
  for (let index = 0; index < normalizedRoot.length; index += 1) {
    if (normalizedPath[index] !== normalizedRoot[index]) {
      return [];
    }
  }
  return normalizedPath.slice(normalizedRoot.length);
}

function buildQuickPlayRuntimeCandidatePaths(candidate = null) {
  const matchedBoardPath = buildQuickPlayBoardPathFromCandidate(candidate);
  const retainedRootPath = normalizeQuickPlayPathParts(
    candidate?.retainedRootPath ?? candidate?.retained_root_path ?? candidate?.rootPath
  );
  const fallbackRootPath =
    retainedRootPath.length > 0
      ? retainedRootPath
      : normalizeQuickPlayPathParts(
          matchedBoardPath.length > 0 ? matchedBoardPath.slice(0, -1) : []
        );
  const discoveredPaths =
    candidate?.discoveredPaths && typeof candidate.discoveredPaths === "object"
      ? candidate.discoveredPaths
      : candidate?.discovered_paths && typeof candidate.discovered_paths === "object"
        ? candidate.discovered_paths
        : {};
  let boardPath = normalizeQuickPlayPathParts(
    candidate?.boardPathRelative ??
      candidate?.board_path_relative ??
      discoveredPaths?.board
  );
  let currentPath = normalizeQuickPlayPathParts(
    candidate?.currentPathRelative ??
      candidate?.current_path_relative ??
      discoveredPaths?.current
  );
  let holdPath = normalizeQuickPlayPathParts(
    candidate?.holdPathRelative ??
      candidate?.hold_path_relative ??
      discoveredPaths?.hold
  );
  let queuePath = normalizeQuickPlayPathParts(
    candidate?.queuePathRelative ??
      candidate?.queue_path_relative ??
      discoveredPaths?.queue
  );
  if (boardPath.length === 0) {
    boardPath = rebaseQuickPlayAccessorPath(
      normalizeQuickPlayPathParts(candidate?.boardPath ?? matchedBoardPath),
      fallbackRootPath
    );
  }
  if (currentPath.length === 0) {
    currentPath = rebaseQuickPlayAccessorPath(
      normalizeQuickPlayPathParts(candidate?.currentPath),
      fallbackRootPath
    );
  }
  if (currentPath.length === 0 && normalizedScalar(candidate?.current) !== null) {
    currentPath = ["current"];
  }
  if (holdPath.length === 0) {
    holdPath = rebaseQuickPlayAccessorPath(
      normalizeQuickPlayPathParts(candidate?.holdPath),
      fallbackRootPath
    );
  }
  if (holdPath.length === 0 && Object.prototype.hasOwnProperty.call(candidate ?? {}, "hold")) {
    holdPath = ["hold"];
  }
  if (queuePath.length === 0) {
    queuePath = rebaseQuickPlayAccessorPath(
      normalizeQuickPlayPathParts(candidate?.queuePath),
      fallbackRootPath
    );
  }
  if (queuePath.length === 0 && Array.isArray(candidate?.queue)) {
    queuePath = ["queue"];
  }
  return {
    retainedRootKind: String(
      candidate?.retainedRootKind ??
        candidate?.retained_root_kind ??
        inferQuickPlayRetainedRootKind(
          candidate?.retainedRootPath ??
            candidate?.retained_root_path ??
            candidate?.rootPath ??
            fallbackRootPath
        )
    ),
    retainedRootPath: fallbackRootPath,
    rootPath: fallbackRootPath,
    boardPath: boardPath.slice(0, 8),
    currentPath: currentPath.slice(0, 8),
    holdPath: holdPath.slice(0, 8),
    queuePath: queuePath.slice(0, 8),
    pathInvariantOk:
      boardPath.length > 0 &&
      currentPath.length > 0 &&
      holdPath.length > 0 &&
      queuePath.length > 0
  };
}

function buildQuickPlayPassiveRuntimeCandidate(
  candidate = null,
  {
    generation = 0,
    targetId = "",
    capturedAt = Date.now(),
    rootObjectId = ""
  } = {}
) {
  const paths = buildQuickPlayRuntimeCandidatePaths(candidate);
  const preferredRootObjectId =
    String(rootObjectId ?? "").trim() || String(candidate?.rootObjectId ?? "").trim();
  return {
    generation: Math.max(0, Number(generation ?? 0)),
    targetId: String(targetId ?? ""),
    candidateId: String(candidate?.candidateId ?? ""),
    rootObjectId: preferredRootObjectId,
    retainedRootKind: String(paths.retainedRootKind ?? "binding"),
    retainedRootPath: paths.retainedRootPath.slice(0, 8),
    rootPath: paths.rootPath.slice(0, 8),
    functionName: String(candidate?.functionName ?? ""),
    callFrameIndex: Number.isFinite(Number(candidate?.callFrameIndex))
      ? Math.max(0, Number(candidate.callFrameIndex))
      : -1,
    scopeIndex: Number.isFinite(Number(candidate?.scopeIndex))
      ? Math.max(0, Number(candidate.scopeIndex))
      : -1,
    scopeType: String(candidate?.scopeType ?? ""),
    bindingName: String(candidate?.bindingName ?? ""),
    boardPath: paths.boardPath.slice(0, 8),
    currentPath: paths.currentPath.slice(0, 8),
    holdPath: paths.holdPath.slice(0, 8),
    queuePath: paths.queuePath.slice(0, 8),
    pathInvariantOk: paths.pathInvariantOk === true,
    capturedAt: Math.max(0, Number(capturedAt ?? Date.now())),
    userid: normalizedScalar(candidate?.userid) ?? null,
    gameid: normalizedScalar(candidate?.gameid) ?? null,
    wsPlayerId: "",
    identityBound: false
  };
}

function isQuickPlayPassiveRuntimeCandidateReady(candidate = null) {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }
  const paths = {
    boardPath: Array.isArray(candidate.boardPath) ? candidate.boardPath : [],
    currentPath: Array.isArray(candidate.currentPath) ? candidate.currentPath : [],
    holdPath: Array.isArray(candidate.holdPath) ? candidate.holdPath : [],
    queuePath: Array.isArray(candidate.queuePath) ? candidate.queuePath : []
  };
  return (
    String(candidate.rootObjectId ?? "").trim() !== "" &&
    String(candidate.candidateId ?? "").trim() !== "" &&
    Number.isFinite(Number(candidate.generation)) &&
    String(candidate.targetId ?? "").trim() !== "" &&
    String(candidate.functionName ?? "") === "_tick" &&
    String(candidate.scopeType ?? "") === "closure" &&
    candidate.pathInvariantOk !== false &&
    paths.boardPath.length > 0 &&
    paths.currentPath.length > 0 &&
    paths.holdPath.length > 0 &&
    paths.queuePath.length > 0
  );
}

export async function retainQuickPlayPassiveCandidateHandle(
  cdp,
  quickPlayDiagnosticState,
  candidate,
  {
    generation = 0,
    targetId = "",
    capturedAt = Date.now(),
    log = console.log
  } = {}
) {
  const diagnostics = quickPlayDiagnosticState?.diagnostics?.passive_snapshot ?? null;
  const runtimeCandidate = buildQuickPlayPassiveRuntimeCandidate(candidate, {
    generation,
    targetId,
    capturedAt
  });
  const rootObjectId = String(runtimeCandidate.rootObjectId ?? "").trim();
  const failure = (reason) => {
    if (diagnostics) {
      diagnostics.candidate_retain_failed += 1;
      diagnostics.last_candidate_retain_failure = String(reason ?? "unknown");
      diagnostics.last_failure_reason = "candidate_retain_failed";
      incrementQuickPlayDiagnosticBucket(
        diagnostics.candidate_retain_failure_reasons,
        diagnostics.last_candidate_retain_failure
      );
    }
    syncQuickPlayPassiveSnapshotCurrentState(quickPlayDiagnosticState);
    if (typeof log === "function") {
      log(
        `[quick-play] passive candidate retain failed candidate=${runtimeCandidate.candidateId || "unknown"} reason=${String(
          reason ?? "unknown"
        )}`
      );
    }
    return {
      ok: false,
      reason: String(reason ?? "unknown"),
      candidateId: runtimeCandidate.candidateId,
      generation: runtimeCandidate.generation,
      targetId: runtimeCandidate.targetId
    };
  };
  if (diagnostics) {
    diagnostics.candidate_retain_attempts += 1;
  }
  if (typeof log === "function") {
    log(
      `[quick-play] passive candidate retain started candidate=${runtimeCandidate.candidateId || "unknown"} generation=${runtimeCandidate.generation} runtime_handle_present=${rootObjectId ? "true" : "false"} root_path=${runtimeCandidate.rootPath.join(".")}`
    );
  }
  if (!cdp?.send || !quickPlayDiagnosticState) {
    return failure("root_object_not_found");
  }
  if (!rootObjectId) {
    return failure("missing_runtime_object_handle");
  }
  if (runtimeCandidate.generation !== Math.max(0, Number(quickPlayDiagnosticState.captureGeneration ?? 0))) {
    return failure("generation_mismatch");
  }
  if (
    runtimeCandidate.targetId &&
    String(quickPlayDiagnosticState.currentTargetUrl ?? "").trim() !== "" &&
    runtimeCandidate.targetId !== String(quickPlayDiagnosticState.currentTargetUrl ?? "").trim()
  ) {
    return failure("target_mismatch");
  }
  if (!runtimeCandidate.candidateId) {
    return failure("candidate_ambiguous");
  }
  if (runtimeCandidate.pathInvariantOk !== true) {
    return failure("root_path_invariant_failed");
  }
  const existingCandidate = quickPlayDiagnosticState.boundLocalClosureCandidate ?? null;
  if (
    existingCandidate?.candidateId === runtimeCandidate.candidateId &&
    Math.max(0, Number(existingCandidate?.generation ?? 0)) === runtimeCandidate.generation &&
    String(existingCandidate?.targetId ?? "") === runtimeCandidate.targetId &&
    String(existingCandidate?.rootObjectId ?? "").trim() !== ""
  ) {
    syncQuickPlayPassiveSnapshotCurrentState(quickPlayDiagnosticState);
    return {
      ok: true,
      candidateId: runtimeCandidate.candidateId,
      generation: runtimeCandidate.generation,
      targetId: runtimeCandidate.targetId
    };
  }
  const previousObjectId = String(
    quickPlayDiagnosticState.boundLocalClosureCandidate?.rootObjectId ?? ""
  ).trim();
  if (previousObjectId && previousObjectId !== rootObjectId) {
    await cdp.send("Runtime.releaseObject", {
      objectId: previousObjectId
    }).catch(() => undefined);
  }
  const retainedRootProbe = await cdp.send("Runtime.callFunctionOn", {
    objectId: rootObjectId,
    functionDeclaration: `function(rootPath) {
      const normalizePath = (value) =>
        Array.isArray(value)
          ? value.map((part) => String(part ?? "").trim()).filter(Boolean).slice(0, 8)
          : [];
      const constructorName = (value) => {
        try {
          return value?.constructor?.name ?? null;
        } catch {
          return null;
        }
      };
      const listKeys = (value) => {
        if (!value || typeof value !== "object") {
          return [];
        }
        try {
          return Object.keys(value).slice(0, 50);
        } catch {
          return [];
        }
      };
      const hasOwn = (value, key) => {
        try {
          return !!value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);
        } catch {
          return false;
        }
      };
      const isTypedArray = (value) =>
        typeof ArrayBuffer === "function" &&
        typeof ArrayBuffer.isView === "function" &&
        ArrayBuffer.isView(value);
      const describeRoot = (value) => {
        const ownKeys = listKeys(value);
        return {
          raw_type:
            value === null
              ? "null"
              : Array.isArray(value)
                ? "array"
                : typeof value,
          constructor: constructorName(value),
          own_keys: ownKeys,
          has_board: ownKeys.includes("board") || hasOwn(value, "board"),
          has_falling: ownKeys.includes("falling") || hasOwn(value, "falling"),
          has_hold: ownKeys.includes("hold") || hasOwn(value, "hold"),
          has_bag: ownKeys.includes("bag") || hasOwn(value, "bag"),
          has_game: ownKeys.includes("game") || hasOwn(value, "game"),
          has_state: ownKeys.includes("state") || hasOwn(value, "state")
        };
      };
      const classifyStage = (value, diagnostic) => {
        if (!value || typeof value !== "object") {
          return "unavailable";
        }
        if (diagnostic?.has_board) {
          return "state";
        }
        if (diagnostic?.has_state) {
          return "game";
        }
        if (diagnostic?.has_game) {
          return "binding";
        }
        if (
          Array.isArray(value?.board) ||
          Array.isArray(value?.field) ||
          Array.isArray(value?.cells) ||
          Array.isArray(value?.matrix) ||
          Array.isArray(value?.grid) ||
          Array.isArray(value?.data) ||
          isTypedArray(value?.data)
        ) {
          return "board";
        }
        return "unknown";
      };
      const parts = normalizePath(rootPath);
      let current = this;
      const resolvedSegments = [];
      let failedSegment = null;
      let accessorException = false;
      for (const part of parts) {
        if (
          current === null ||
          current === undefined ||
          (typeof current !== "object" && typeof current !== "function")
        ) {
          failedSegment = part;
          break;
        }
        let next;
        try {
          next = current[part];
        } catch {
          failedSegment = part;
          accessorException = true;
          break;
        }
        if (next === undefined) {
          failedSegment = part;
          break;
        }
        current = next;
        resolvedSegments.push(part);
      }
      const pathResolved = failedSegment === null;
      const diagnostic =
        pathResolved && current && typeof current === "object" ? describeRoot(current) : null;
      return {
        requested_path: parts,
        resolved_segments: resolvedSegments,
        failed_segment: failedSegment,
        path_resolved: pathResolved,
        accessor_exception: accessorException,
        value_type:
          pathResolved
            ? current === null
              ? "null"
              : Array.isArray(current)
                ? "array"
                : typeof current
            : "undefined",
        retained_object_stage: classifyStage(current, diagnostic),
        root_diagnostics: diagnostic
      };
    }`,
    arguments: [{ value: runtimeCandidate.rootPath }],
    returnByValue: true,
    silent: true
  }).catch((error) => ({ error }));
  if (retainedRootProbe?.error) {
    return failure("root_path_invariant_failed");
  }
  const rootProbeValue = retainedRootProbe?.result?.value ?? null;
  const expectedRootKind = String(runtimeCandidate.retainedRootKind ?? "binding").trim() || "binding";
  const actualRootStage = String(rootProbeValue?.retained_object_stage ?? "").trim() || "unavailable";
  const rootProbeResolved =
    rootProbeValue?.path_resolved === true && String(rootProbeValue?.value_type ?? "") === "object";
  const rootDiagnostic = rootProbeValue?.root_diagnostics ?? null;
  const rootStageMismatch =
    rootProbeResolved &&
    actualRootStage !== "unknown" &&
    actualRootStage !== "unavailable" &&
    actualRootStage !== expectedRootKind;
  const rootKeysEmpty =
    rootProbeResolved &&
    expectedRootKind !== "binding" &&
    Array.isArray(rootDiagnostic?.own_keys) &&
    rootDiagnostic.own_keys.length === 0 &&
    !rootDiagnostic?.has_board &&
    !rootDiagnostic?.has_state &&
    !rootDiagnostic?.has_game;
  if (!rootProbeResolved || rootProbeValue?.accessor_exception === true || rootStageMismatch || rootKeysEmpty) {
    return failure("root_path_invariant_failed");
  }
  const retained = await cdp.send("Runtime.callFunctionOn", {
    objectId: rootObjectId,
    functionDeclaration: `function(rootPath) {
      const parts = Array.isArray(rootPath)
        ? rootPath.map((part) => String(part ?? "").trim()).filter(Boolean).slice(0, 8)
        : [];
      let current = this;
      for (const part of parts) {
        if (
          current === null ||
          current === undefined ||
          (typeof current !== "object" && typeof current !== "function")
        ) {
          return undefined;
        }
        current = current[part];
        if (current === undefined) {
          return undefined;
        }
      }
      return current;
    }`,
    arguments: [{ value: runtimeCandidate.rootPath }],
    returnByValue: false,
    silent: true,
    objectGroup: "fusion-quick-play-passive"
  }).catch((error) => ({ error }));
  if (retained?.error) {
    const message = String(retained.error?.message ?? retained.error ?? "");
    if (/objectid|object id/i.test(message) && /invalid|missing|null|undefined|released/i.test(message)) {
      return failure("handle_released_before_retain");
    }
    return failure("handle_clone_failed");
  }
  const retainedObjectId = String(retained?.result?.objectId ?? "").trim();
  if (!retainedObjectId) {
    return failure("handle_clone_failed");
  }
  quickPlayDiagnosticState.boundLocalClosureCandidate = {
    ...runtimeCandidate,
    rootObjectId: retainedObjectId
  };
  syncQuickPlayPassiveSnapshotCurrentState(quickPlayDiagnosticState);
  if (diagnostics) {
    diagnostics.candidate_retain_succeeded += 1;
    diagnostics.last_candidate_retain_failure = "";
    diagnostics.last_failure_reason = "";
    diagnostics.ever_candidate_bound = true;
  }
  if (typeof log === "function") {
    log(
      `[quick-play] passive candidate retained candidate=${runtimeCandidate.candidateId} generation=${runtimeCandidate.generation} function=${runtimeCandidate.functionName} scope=${runtimeCandidate.scopeIndex}`
    );
  }
  return {
    ok: true,
    candidateId: runtimeCandidate.candidateId,
    generation: runtimeCandidate.generation,
    targetId: runtimeCandidate.targetId
  };
}

export function updateQuickPlayPendingIdentity(
  quickPlayDiagnosticState,
  wsSelfEvidence,
  now = Date.now()
) {
  if (!quickPlayDiagnosticState) {
    return { changed: false, reason: "state_missing" };
  }
  const previous = quickPlayDiagnosticState.pendingIdentity ?? null;
  if (wsSelfEvidence?.status !== "resolved") {
    return { changed: false, reason: "identity_unresolved" };
  }
  const userid = normalizedScalar(wsSelfEvidence.userid);
  const gameid = normalizedScalar(wsSelfEvidence.gameid);
  if (!userid || gameid === null) {
    return { changed: false, reason: "identity_incomplete" };
  }
  const wsPlayer = [...(quickPlayDiagnosticState?.wsPlayers?.values?.() ?? [])].find(
    (player) => valuesEqual(player.userid, userid) || valuesEqual(player.gameid, gameid)
  );
  const wsPlayerId = [
    userid ?? "",
    gameid ?? "",
    wsPlayer?.username ?? ""
  ].join("|");
  const next = {
    generation: Math.max(0, Number(quickPlayDiagnosticState.captureGeneration ?? 0)),
    userid,
    gameid,
    wsPlayerId,
    resolvedAt: Math.max(0, Number(now ?? Date.now()))
  };
  const changed =
    !previous ||
    !valuesEqual(previous.userid, next.userid) ||
    !valuesEqual(previous.gameid, next.gameid) ||
    String(previous.wsPlayerId ?? "") !== next.wsPlayerId ||
    Math.max(0, Number(previous.generation ?? -1)) !== next.generation;
  quickPlayDiagnosticState.pendingIdentity = next;
  syncQuickPlayPassiveSnapshotCurrentState(quickPlayDiagnosticState);
  quickPlayDiagnosticState.diagnostics.passive_snapshot.identity_available = true;
  return {
    changed,
    reason: changed ? (previous?.userid ? "identity_updated" : "identity_resolved") : "identity_unchanged"
  };
}

function getQuickPlayAcceptedCandidateRecord(quickPlayDiagnosticState, candidateId) {
  if (!candidateId) {
    return null;
  }
  const candidate = quickPlayDiagnosticState?.closureCandidates?.get?.(candidateId) ?? null;
  return candidate?.playing === true ? candidate : null;
}

export async function reconcileQuickPlayPassiveBinding(
  quickPlayDiagnosticState,
  {
    reason = "unknown",
    browserControlState = null,
    now = Date.now(),
    log = console.log
  } = {}
) {
  const diagnostics = quickPlayDiagnosticState?.diagnostics?.passive_snapshot;
  if (!diagnostics) {
    return { result: "rejected", deferredReason: "state_missing", shouldStartPolling: false };
  }
  diagnostics.bind_attempts += 1;
  const candidate = quickPlayDiagnosticState?.boundLocalClosureCandidate ?? null;
  const identity = quickPlayDiagnosticState?.pendingIdentity ?? null;
  const candidateReady = isQuickPlayPassiveRuntimeCandidateReady(candidate);
  const identityReady =
    normalizedScalar(identity?.userid) !== null &&
    normalizedScalar(identity?.gameid) !== null;
  let result = "deferred";
  let deferredReason = "";
  let generationMatch = null;
  let targetMatch = null;
  let shouldStartPolling = false;

  if (!quickPlayDiagnosticState?.active) {
    result = "rejected";
    deferredReason = "capture_inactive";
  } else if (!isZenithModeSelected(browserControlState)) {
    result = "rejected";
    deferredReason = "mode_not_zenith";
  } else if (
    browserControlState?.botEnabled &&
    !quickPlayPassiveAllowsBotEnabled(quickPlayDiagnosticState)
  ) {
    result = "rejected";
    deferredReason = "bot_enabled";
  }
  if (!deferredReason && !candidateReady) {
    deferredReason = "candidate_not_ready";
  }
  if (!deferredReason && !identityReady) {
    deferredReason = "identity_not_ready";
  }
  if (!deferredReason) {
    generationMatch =
      Math.max(0, Number(candidate?.generation ?? -1)) ===
        Math.max(0, Number(identity?.generation ?? -2)) &&
      Math.max(0, Number(candidate?.generation ?? -1)) ===
        Math.max(0, Number(quickPlayDiagnosticState?.captureGeneration ?? -3));
    targetMatch =
      String(candidate?.targetId ?? "").trim() !== "" &&
      String(candidate?.targetId ?? "").trim() ===
        String(quickPlayDiagnosticState?.currentTargetUrl ?? "").trim();
    const acceptedCandidate = getQuickPlayAcceptedCandidateRecord(
      quickPlayDiagnosticState,
      candidate?.candidateId
    );
    if (!generationMatch) {
      result = "rejected";
      deferredReason = "generation_mismatch";
    } else if (!targetMatch || !/tetr\.io/i.test(String(candidate?.targetId ?? ""))) {
      result = "rejected";
      deferredReason = "target_mismatch";
    } else if (!acceptedCandidate) {
      result = "rejected";
      deferredReason = "candidate_stale";
    } else if (String(candidate?.functionName ?? "") !== "_tick") {
      result = "rejected";
      deferredReason = "candidate_function_invalid";
    } else if (String(candidate?.scopeType ?? "") !== "closure") {
      result = "rejected";
      deferredReason = "candidate_scope_invalid";
    } else if (!Array.isArray(candidate?.boardPath) || candidate.boardPath.length === 0) {
      result = "rejected";
      deferredReason = "board_path_invalid";
    } else if (quickPlayDiagnosticState?.diagnostics?.closure_scan?.target_handoff_mismatches > 0) {
      result = "rejected";
      deferredReason = "target_handoff_mismatch";
    } else if (
      normalizedScalar(acceptedCandidate.current) === null ||
      !Array.isArray(acceptedCandidate.queue) ||
      acceptedCandidate.queue.filter(Boolean).length === 0 ||
      !Object.prototype.hasOwnProperty.call(acceptedCandidate, "hold")
    ) {
      result = "rejected";
      deferredReason = "candidate_shape_unverified";
    } else if (
      candidate.identityBound === true &&
      valuesEqual(candidate.userid, identity.userid) &&
      valuesEqual(candidate.gameid, identity.gameid)
    ) {
      result = "bound";
    } else {
      candidate.userid = normalizedScalar(identity.userid);
      candidate.gameid = normalizedScalar(identity.gameid);
      candidate.wsPlayerId = String(identity.wsPlayerId ?? "");
      candidate.identityBound = true;
      diagnostics.bind_succeeded += 1;
      diagnostics.ever_identity_bound = true;
      diagnostics.ever_candidate_bound = true;
      shouldStartPolling = true;
      result = "bound";
    }
  }

  if (result === "deferred") {
    diagnostics.bind_deferred += 1;
    noteQuickPlayPassiveBindReason(diagnostics, deferredReason);
    diagnostics.last_failure_reason = String(deferredReason ?? "unknown");
  } else if (result === "rejected" && deferredReason) {
    noteQuickPlayPassiveBindReason(diagnostics, deferredReason);
    diagnostics.last_failure_reason = String(deferredReason ?? "unknown");
  } else if (result === "bound") {
    diagnostics.last_failure_reason = "";
  }
  syncQuickPlayPassiveSnapshotCurrentState(quickPlayDiagnosticState);
  if (candidate?.identityBound === true) {
    diagnostics.ever_candidate_bound = true;
    diagnostics.ever_identity_bound = true;
  }
  if (typeof log === "function") {
    log(
      `[quick-play] passive bind reconcile reason=${String(reason ?? "unknown")} candidate_ready=${candidateReady ? "true" : "false"} identity_ready=${identityReady ? "true" : "false"} generation_match=${generationMatch === null ? "not_applicable" : generationMatch ? "true" : "false"} target_match=${targetMatch === null ? "not_applicable" : targetMatch ? "true" : "false"} result=${result}` +
        (deferredReason ? ` deferred_reason=${deferredReason}` : "")
    );
    if (result === "bound" && shouldStartPolling) {
      log(
        `[quick-play] local closure bound candidate=${String(candidate?.candidateId ?? "")} userid=${String(candidate?.userid ?? "")} gameid=${String(candidate?.gameid ?? "")} generation=${Math.max(0, Number(candidate?.generation ?? 0))}`
      );
    }
  }
  return { result, deferredReason, shouldStartPolling };
}

async function readQuickPlayPassiveSnapshot(
  cdp,
  quickPlayDiagnosticState,
  {
    now = Date.now(),
    log = console.log
  } = {}
) {
  const bound = quickPlayDiagnosticState?.boundLocalClosureCandidate;
  const diagnostics = quickPlayDiagnosticState?.diagnostics?.passive_snapshot;
  if (!bound?.rootObjectId || !diagnostics) {
    if (diagnostics) {
      diagnostics.transport_reads_failed += 1;
      diagnostics.reads_failed += 1;
      diagnostics.last_failure_reason = "candidate_handle_invalid";
    }
    syncQuickPlayPassiveSnapshotCurrentState(quickPlayDiagnosticState);
    return { status: "unavailable", reason: "candidate_handle_invalid" };
  }
  diagnostics.reads_attempted += 1;
  const result = await cdp.send("Runtime.callFunctionOn", {
    objectId: bound.rootObjectId,
    functionDeclaration: `function(retainedRootKind, boardPath, currentPath, holdPath, queuePath) {
      const pieceNames = ["I", "O", "T", "S", "Z", "J", "L"];
      const normalizePieceType = (value) => {
        if (value === null || value === undefined || value === false) return null;
        if (typeof value === "number") return pieceNames[value] ?? null;
        if (typeof value === "string") {
          const token = value.trim();
          if (!token) {
            return null;
          }
          switch (token.toLowerCase()) {
            case "i":
              return "I";
            case "o":
              return "O";
            case "t":
              return "T";
            case "s":
              return "S";
            case "z":
              return "Z";
            case "j":
              return "J";
            case "l":
              return "L";
            default:
              return null;
          }
        }
        if (typeof value === "object") {
          return normalizePieceType(
            value.type ?? value.name ?? value.kind ?? value.id ?? value.piece ?? value.mino
          );
        }
        return null;
      };
      const constructorName = (value) => {
        try {
          return value?.constructor?.name ?? null;
        } catch {
          return null;
        }
      };
      const listKeys = (value) => {
        if (!value || typeof value !== "object") {
          return [];
        }
        try {
          return Object.keys(value).slice(0, 50);
        } catch {
          return [];
        }
      };
      const hasOwn = (value, key) => {
        try {
          return !!value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);
        } catch {
          return false;
        }
      };
      const readRawPauseState = (value) => {
        if (!value || typeof value !== "object") {
          return undefined;
        }
        if (hasOwn(value, "pause")) {
          return value.pause;
        }
        if (hasOwn(value, "paused")) {
          return value.paused;
        }
        return undefined;
      };
      const normalizePausedState = (value) =>
        value !== null && value !== undefined && value !== false;
      const rowCells = (row) =>
        Array.isArray(row) ? row :
        Array.isArray(row?.cells) ? row.cells :
        Array.isArray(row?.data) ? row.data :
        Array.isArray(row?.row) ? row.row :
        null;
      const scalar = (value) =>
        value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
          ? value
          : undefined;
      const isTypedArray = (value) =>
        typeof ArrayBuffer === "function" &&
        typeof ArrayBuffer.isView === "function" &&
        ArrayBuffer.isView(value);
      const numberFrom = (...values) => {
        for (const value of values) {
          const next = Number(value);
          if (Number.isFinite(next)) return next;
        }
        return null;
      };
      const readPath = (root, parts) => {
        let current = root;
        const requestedPath = Array.isArray(parts)
          ? parts.map((part) => String(part ?? "").trim()).filter(Boolean).slice(0, 8)
          : [];
        const resolvedSegments = [];
        let failedSegment = null;
        let accessorException = false;
        for (const part of requestedPath) {
          if (
            current === null ||
            current === undefined ||
            (typeof current !== "object" && typeof current !== "function")
          ) {
            failedSegment = part;
            return {
              ok: false,
              value: undefined,
              requestedPath,
              resolvedSegments,
              failedSegment,
              accessorException
            };
          }
          try {
            current = current[part];
          } catch {
            failedSegment = part;
            accessorException = true;
            return {
              ok: false,
              value: undefined,
              requestedPath,
              resolvedSegments,
              failedSegment,
              accessorException
            };
          }
          if (current === undefined) {
            failedSegment = part;
            return {
              ok: false,
              value: undefined,
              requestedPath,
              resolvedSegments,
              failedSegment,
              accessorException
            };
          }
          resolvedSegments.push(part);
        }
        return {
          ok: true,
          value: current,
          requestedPath,
          resolvedSegments,
          failedSegment: null,
          accessorException
        };
      };
      const buildBaseFieldDiagnostic = (requestedPath, lookup) => {
        const rawValue = lookup?.value;
        return {
          requested_path: Array.isArray(requestedPath) ? requestedPath.slice(0, 8) : [],
          resolved_segments: Array.isArray(lookup?.resolvedSegments)
            ? lookup.resolvedSegments.slice(0, 8)
            : [],
          failed_segment: lookup?.failedSegment ?? null,
          path_resolved: lookup?.ok === true && lookup?.failedSegment === null,
          accessor_exception: lookup?.accessorException === true,
          raw_type:
            lookup?.ok !== true
              ? "undefined"
              : rawValue === null
              ? "null"
              : Array.isArray(rawValue)
                ? "array"
                : typeof rawValue,
          raw_constructor: constructorName(rawValue),
          raw_keys: listKeys(rawValue),
          raw_length:
            Array.isArray(rawValue) || isTypedArray(rawValue)
              ? Math.max(0, Number(rawValue?.length ?? 0))
              : null
        };
      };
      const normalizeCurrent = (value) => {
        if (value === null) {
          return { ok: true, value: null };
        }
        const type = normalizePieceType(value);
        if (!type) {
          return { ok: false, reason: "invalid_current_shape" };
        }
        return {
          ok: true,
          value: {
            type,
            x: Number.isFinite(Number(value?.x)) ? Number(value.x) : null,
            y: Number.isFinite(Number(value?.y)) ? Number(value.y) : null,
            rotation: Number.isFinite(Number(value?.rotation)) ? Number(value.rotation) : null
          }
        };
      };
      const normalizeHold = (value) => {
        if (value === null) {
          return { ok: true, value: null };
        }
        const type = normalizePieceType(value);
        if (!type) {
          return { ok: false, reason: "invalid_hold_shape" };
        }
        return { ok: true, value: type };
      };
      const normalizeQueue = (value) => {
        if (!Array.isArray(value)) {
          return { ok: false, reason: "invalid_queue_shape", value: [] };
        }
        const queue = [];
        for (const entry of value.slice(0, 20)) {
          const normalized = normalizePieceType(entry);
          if (!normalized) {
            return { ok: false, reason: "invalid_queue_piece", value: [] };
          }
          queue.push(normalized);
        }
        return { ok: true, value: queue };
      };
      const normalizeCell = (cell) => {
        if (cell === null || cell === undefined || cell === false || cell === 0 || cell === "") {
          return 0;
        }
        const normalized = normalizePieceType(cell?.type ?? cell?.mino ?? cell);
        return normalized ?? 1;
      };
      const describeRoot = (value) => {
        const ownKeys = listKeys(value);
        return {
          retained_root_kind:
            typeof retainedRootKind === "string" && retainedRootKind.trim()
              ? retainedRootKind.trim()
              : "binding",
          raw_type:
            value === null
              ? "null"
              : Array.isArray(value)
                ? "array"
                : typeof value,
          constructor: constructorName(value),
          own_keys: ownKeys,
          has_board: ownKeys.includes("board") || hasOwn(value, "board"),
          has_falling: ownKeys.includes("falling") || hasOwn(value, "falling"),
          has_hold: ownKeys.includes("hold") || hasOwn(value, "hold"),
          has_bag: ownKeys.includes("bag") || hasOwn(value, "bag"),
          has_game: ownKeys.includes("game") || hasOwn(value, "game"),
          has_state: ownKeys.includes("state") || hasOwn(value, "state")
        };
      };
      const classifyRootStage = (value, diagnostic) => {
        if (!value || typeof value !== "object") {
          return "unavailable";
        }
        if (diagnostic?.has_board) {
          return "state";
        }
        if (diagnostic?.has_state) {
          return "game";
        }
        if (diagnostic?.has_game) {
          return "binding";
        }
        if (
          Array.isArray(value?.board) ||
          Array.isArray(value?.field) ||
          Array.isArray(value?.cells) ||
          Array.isArray(value?.matrix) ||
          Array.isArray(value?.grid) ||
          Array.isArray(value?.data) ||
          isTypedArray(value?.data)
        ) {
          return "board";
        }
        return "unknown";
      };
      const normalizeBoard = (value, diagnostic) => {
        const withFailure = (reason) => ({
          ok: false,
          reason,
          board: null,
          boardWidth: 0,
          boardHeight: 0,
          diagnostic: {
            ...diagnostic,
            first_item_type:
              Array.isArray(value) && value.length > 0
                ? Array.isArray(value[0])
                  ? "array"
                  : typeof value[0]
                : null,
            first_item_length:
              Array.isArray(value) && value.length > 0 && Array.isArray(rowCells(value[0]))
                ? rowCells(value[0]).length
                : null,
            normalization_status: "failed",
            failure_reason: reason
          }
        });
        const normalizeMatrix = (matrix) => {
          if (!Array.isArray(matrix) || matrix.length === 0) {
            return withFailure("empty_board_shape");
          }
          const sampleRow = rowCells(matrix[0]);
          const width = Math.min(20, Array.isArray(sampleRow) ? sampleRow.length : 0);
          const height = Math.min(40, matrix.length);
          if (width <= 0 || height <= 0) {
            return withFailure("empty_board_shape");
          }
          return {
            ok: true,
            reason: null,
            board: Array.from({ length: height }, (_, rowIndex) => {
              const sourceRow = matrix[matrix.length - 1 - rowIndex];
              const cells = rowCells(sourceRow);
              return Array.from({ length: width }, (_, colIndex) =>
                normalizeCell(cells ? cells[colIndex] : null)
              );
            }),
            boardWidth: width,
            boardHeight: height,
            diagnostic: {
              ...diagnostic,
              first_item_type:
                matrix.length > 0
                  ? Array.isArray(matrix[0])
                    ? "array"
                    : typeof matrix[0]
                  : null,
              first_item_length:
                matrix.length > 0 && Array.isArray(rowCells(matrix[0]))
                  ? rowCells(matrix[0]).length
                  : null,
              normalization_status: "normalized",
              failure_reason: null
            }
          };
        };
        if (Array.isArray(value)) {
          return normalizeMatrix(value);
        }
        if (value && typeof value === "object") {
          for (const key of ["board", "field", "cells", "matrix", "grid"]) {
            if (Object.prototype.hasOwnProperty.call(value, key) && Array.isArray(value[key])) {
              return normalizeMatrix(value[key]);
            }
          }
          for (const key of ["data", "cells", "grid"]) {
            const rawFlat = value[key];
            const width = numberFrom(value.width, value.cols, value.columns, value.w);
            const height = numberFrom(value.height, value.rows, value.h);
            const flat = Array.isArray(rawFlat)
              ? rawFlat
              : isTypedArray(rawFlat)
                ? Array.from(rawFlat)
                : null;
            if (!flat) {
              continue;
            }
            if (!Number.isFinite(width) || !Number.isFinite(height)) {
              return withFailure("unsupported_board_shape");
            }
            const cappedWidth = Math.min(20, Math.max(0, Math.floor(width)));
            const cappedHeight = Math.min(40, Math.max(0, Math.floor(height)));
            if (cappedWidth <= 0 || cappedHeight <= 0) {
              return withFailure("empty_board_shape");
            }
            if (flat.length < cappedWidth * cappedHeight) {
              return withFailure("unsupported_board_shape");
            }
            return {
              ok: true,
              reason: null,
              board: Array.from({ length: cappedHeight }, (_, rowIndex) => {
                const sourceRowIndex = cappedHeight - 1 - rowIndex;
                return Array.from({ length: cappedWidth }, (_, colIndex) =>
                  normalizeCell(flat[sourceRowIndex * cappedWidth + colIndex])
                );
              }),
              boardWidth: cappedWidth,
              boardHeight: cappedHeight,
              diagnostic: {
                ...diagnostic,
                first_item_type: flat.length > 0 ? typeof flat[0] : null,
                first_item_length: null,
                normalization_status: "normalized",
                failure_reason: null
              }
            };
          }
        }
        return withFailure("unsupported_board_shape");
      };
      try {
        if (!this || typeof this !== "object") {
          return { status: "candidate_handle_invalid" };
        }
        const boardLookup = Array.isArray(boardPath) ? readPath(this, boardPath) : { ok: false, value: null };
        const currentLookup = Array.isArray(currentPath) ? readPath(this, currentPath) : { ok: false, value: null };
        const holdLookup = Array.isArray(holdPath) ? readPath(this, holdPath) : { ok: false, value: null };
        const queueLookup = Array.isArray(queuePath) ? readPath(this, queuePath) : { ok: false, value: null };
        const rootDiagnostic = describeRoot(this);
        const boardDiagnosticBase = buildBaseFieldDiagnostic(boardPath, boardLookup);
        const currentDiagnosticBase = buildBaseFieldDiagnostic(currentPath, currentLookup);
        const holdDiagnosticBase = buildBaseFieldDiagnostic(holdPath, holdLookup);
        const queueDiagnosticBase = buildBaseFieldDiagnostic(queuePath, queueLookup);
        const boardResult =
          boardLookup.ok === true
            ? normalizeBoard(boardLookup.value, boardDiagnosticBase)
            : {
                ok: false,
                reason: "accessor_path_unresolved",
                board: null,
                boardWidth: 0,
                boardHeight: 0,
                diagnostic: {
                  ...boardDiagnosticBase,
                  first_item_type: null,
                  first_item_length: null,
                  normalization_status: "failed",
                  failure_reason: "accessor_path_unresolved"
                }
              };
        const currentResult =
          currentLookup.ok === true
            ? normalizeCurrent(currentLookup.value)
            : { ok: false, reason: "accessor_path_unresolved" };
        const holdResult =
          holdLookup.ok === true
            ? normalizeHold(holdLookup.value)
            : { ok: false, reason: "accessor_path_unresolved" };
        const queueResult =
          queueLookup.ok === true
            ? normalizeQueue(queueLookup.value)
            : { ok: false, reason: "accessor_path_unresolved", value: [] };
        const contextLookups = [
          readPath(this, Array.isArray(currentPath) ? currentPath.slice(0, -1) : []),
          readPath(this, Array.isArray(boardPath) ? boardPath.slice(0, -1) : []),
          readPath(this, Array.isArray(queuePath) ? queuePath.slice(0, -1) : []),
          readPath(this, Array.isArray(holdPath) ? holdPath.slice(0, -1) : [])
        ];
        const stateContext =
          contextLookups.find((entry) => entry?.ok && entry.value && typeof entry.value === "object")?.value ?? this;
        const rawPauseState = readRawPauseState(stateContext);
        const paused = normalizePausedState(rawPauseState);
        const playing =
          typeof this.isPlaying === "function" ? Boolean(this.isPlaying()) :
          typeof stateContext?.playing === "boolean" ? stateContext.playing :
          rawPauseState !== undefined ? !paused :
          null;
        const started =
          typeof this.isStarted === "function" ? Boolean(this.isStarted()) :
          typeof stateContext?.started === "boolean" ? stateContext.started :
          null;
        const destroyed = Boolean(stateContext?.destroyed || stateContext?.dead || stateContext?.gameover);
        const countdownStarted = Boolean(started && playing === false && destroyed === false);
        const currentDiagnostic = {
          ...currentDiagnosticBase,
          piece_keys: listKeys(currentLookup.value),
          normalization_status: currentResult.ok ? "normalized" : "failed",
          failure_reason: currentResult.ok ? null : currentResult.reason
        };
        const holdDiagnostic = {
          ...holdDiagnosticBase,
          piece_keys: listKeys(holdLookup.value),
          normalization_status: holdResult.ok ? "normalized" : "failed",
          failure_reason: holdResult.ok ? null : holdResult.reason
        };
        const queueDiagnostic = {
          ...queueDiagnosticBase,
          piece_keys:
            Array.isArray(queueLookup.value) && queueLookup.value.length > 0 && queueLookup.value[0]
              ? listKeys(queueLookup.value[0])
              : [],
          normalization_status: queueResult.ok ? "normalized" : "failed",
          failure_reason: queueResult.ok ? null : queueResult.reason
        };
        const fieldDiagnostics = {
          root: {
            ...rootDiagnostic,
            retained_object_stage: classifyRootStage(this, rootDiagnostic)
          },
          board: boardResult.diagnostic,
          current: currentDiagnostic,
          hold: holdDiagnostic,
          queue: queueDiagnostic
        };
        const semanticFailureReason =
          boardResult.ok !== true ? boardResult.reason :
          currentResult.ok !== true ? currentResult.reason :
          holdResult.ok !== true ? holdResult.reason :
          queueResult.ok !== true ? queueResult.reason :
          boardResult.boardWidth <= 0 || boardResult.boardHeight <= 0 ? "empty_board_shape" :
          null;
        return {
          status: semanticFailureReason ? "semantic_failed" : "ready",
          reason: semanticFailureReason,
          board: boardResult.board,
          current: currentResult.ok ? currentResult.value : null,
          hold: holdResult.ok ? holdResult.value : null,
          queue: queueResult.ok ? queueResult.value : [],
          playing,
          started,
          countdown_started: countdownStarted,
          paused,
          destroyed,
          successful: scalar(stateContext?.successful) ?? null,
          gameoverreason: scalar(stateContext?.gameoverreason ?? stateContext?.gameOverReason) ?? null,
          piece_counter: Math.max(0, Math.floor(numberFrom(
            stateContext?.stats?.piecesplaced,
            stateContext?.stats?.piecesPlaced,
            stateContext?.stats?.pieces,
            stateContext?.piecesplaced,
            stateContext?.piecesPlaced,
            stateContext?.pieceCounter,
            stateContext?.piececount,
            0
          ) ?? 0)),
          board_width: boardResult.boardWidth,
          board_height: boardResult.boardHeight,
          current_path: Array.isArray(currentPath) ? currentPath.slice(0, 8) : [],
          hold_path: Array.isArray(holdPath) ? holdPath.slice(0, 8) : [],
          queue_path: Array.isArray(queuePath) ? queuePath.slice(0, 8) : [],
          board_normalized: boardResult.ok === true,
          current_normalized: currentResult.ok === true,
          hold_normalized: holdResult.ok === true,
          queue_normalized: queueResult.ok === true,
          field_diagnostics: fieldDiagnostics
        };
      } catch {
        return { status: "candidate_handle_invalid" };
      }
    }`,
    arguments: [
      { value: bound.retainedRootKind },
      { value: bound.boardPath },
      { value: bound.currentPath },
      { value: bound.holdPath },
      { value: bound.queuePath }
    ],
    returnByValue: true,
    silent: true
  }).catch((error) => ({ error }));
  if (result?.error) {
    diagnostics.transport_reads_failed += 1;
    diagnostics.reads_failed += 1;
    return { status: "unavailable", reason: "candidate_handle_invalid" };
  }
  diagnostics.transport_reads_succeeded += 1;
  const value = result?.result?.value ?? { status: "candidate_handle_invalid" };
  if (value.status === "candidate_handle_invalid") {
    diagnostics.semantic_reads_failed += 1;
    diagnostics.reads_failed += 1;
    diagnostics.last_failure_reason = "candidate_handle_invalid";
    incrementQuickPlayDiagnosticBucket(
      diagnostics.semantic_failure_reasons,
      diagnostics.last_failure_reason
    );
    return { status: "unavailable", reason: "candidate_handle_invalid" };
  }
  diagnostics.field_diagnostics = value.field_diagnostics ?? null;
  diagnostics.board_normalized = value.board_normalized === true;
  diagnostics.current_normalized = value.current_normalized === true;
  diagnostics.hold_normalized = value.hold_normalized === true;
  diagnostics.queue_normalized = value.queue_normalized === true;
  if (
    typeof log === "function" &&
    value.field_diagnostics?.root &&
    value.field_diagnostics?.board
  ) {
    const rootProbeSignature = JSON.stringify({
      retained_root_kind: value.field_diagnostics.root.retained_root_kind ?? "binding",
      root_type: value.field_diagnostics.root.raw_type ?? "unknown",
      root_constructor: value.field_diagnostics.root.constructor ?? null,
      root_keys: Array.isArray(value.field_diagnostics.root.own_keys)
        ? value.field_diagnostics.root.own_keys
        : [],
      requested_board_path: Array.isArray(value.field_diagnostics.board.requested_path)
        ? value.field_diagnostics.board.requested_path
        : [],
      board_path_resolved: value.field_diagnostics.board.path_resolved === true
    });
    if (quickPlayDiagnosticState.lastPassiveRootProbeSignature !== rootProbeSignature) {
      quickPlayDiagnosticState.lastPassiveRootProbeSignature = rootProbeSignature;
      log(
        `[quick-play] passive root probe retained_root_kind=${String(
          value.field_diagnostics.root.retained_root_kind ?? "binding"
        )} root_type=${String(value.field_diagnostics.root.raw_type ?? "unknown")} root_constructor=${String(
          value.field_diagnostics.root.constructor ?? "unknown"
        )} root_keys=${Array.isArray(value.field_diagnostics.root.own_keys) && value.field_diagnostics.root.own_keys.length > 0
          ? value.field_diagnostics.root.own_keys.join(",")
          : "(none)"} requested_board_path=${Array.isArray(value.field_diagnostics.board.requested_path) && value.field_diagnostics.board.requested_path.length > 0
          ? value.field_diagnostics.board.requested_path.join(".")
          : "(root)"} board_path_resolved=${value.field_diagnostics.board.path_resolved === true ? "true" : "false"}`
      );
    }
  }
  if (value.status !== "ready") {
    diagnostics.semantic_reads_failed += 1;
    diagnostics.reads_failed += 1;
    diagnostics.last_failure_reason = String(value.reason ?? "semantic_read_failed");
    incrementQuickPlayDiagnosticBucket(
      diagnostics.semantic_failure_reasons,
      diagnostics.last_failure_reason
    );
    quickPlayDiagnosticState.lastPassiveSnapshotError = {
      reason: diagnostics.last_failure_reason,
      field_diagnostics: value.field_diagnostics ?? null
    };
    syncQuickPlayPassiveSnapshotCurrentState(quickPlayDiagnosticState);
    return {
      status: "unavailable",
      reason: diagnostics.last_failure_reason,
      field_diagnostics: value.field_diagnostics ?? null
    };
  }
  diagnostics.semantic_reads_succeeded += 1;
  diagnostics.reads_succeeded += 1;
  diagnostics.last_success_at = Math.max(0, Number(now ?? Date.now()));
  diagnostics.last_failure_reason = "";
  quickPlayDiagnosticState.lastPassiveSnapshotError = null;
  quickPlayDiagnosticState.lastPassiveSnapshotFailureLogReason = "";
  syncQuickPlayPassiveSnapshotCurrentState(quickPlayDiagnosticState);
  const payload = {
    version: 1,
    source: "quick_play_closure",
    capture_generation: Math.max(0, Number(bound.generation ?? 0)),
    timestamp: Math.max(0, Number(now ?? Date.now())),
    userid: normalizedScalar(bound.userid),
    gameid: normalizedScalar(bound.gameid),
    candidate_id: normalizedScalar(bound.candidateId),
    playing: value.playing ?? null,
    started: value.started ?? null,
    countdown_started: value.countdown_started ?? null,
    paused: typeof value.paused === "boolean" ? value.paused : false,
    destroyed: value.destroyed ?? null,
    successful: value.successful ?? null,
    gameoverreason: normalizedScalar(value.gameoverreason),
    board: Array.isArray(value.board) ? value.board : null,
    current:
      value.current && typeof value.current === "object"
        ? {
            type: normalizedScalar(value.current.type),
            x: Number.isFinite(Number(value.current.x)) ? Number(value.current.x) : null,
            y: Number.isFinite(Number(value.current.y)) ? Number(value.current.y) : null,
            rotation:
              Number.isFinite(Number(value.current.rotation))
                ? Number(value.current.rotation)
                : null
          }
        : normalizedScalar(value.current)
          ? {
              type: normalizedScalar(value.current),
              x: null,
              y: null,
              rotation: null
            }
        : null,
    hold: value.hold === null ? null : normalizedScalar(value.hold),
    queue: Array.isArray(value.queue) ? value.queue.slice(0, 20).map((entry) => normalizedScalar(entry)).filter(Boolean) : [],
    piece_counter: Math.max(0, Number(value.piece_counter ?? 0)),
    board_width: Math.max(0, Number(value.board_width ?? 0)),
    board_height: Math.max(0, Number(value.board_height ?? 0))
  };
  quickPlayDiagnosticState.lastUsablePassiveSnapshot = payload;
  writeQuickPlayPassiveSnapshotState(quickPlayDiagnosticState, {
    status: "ready",
    capture_status: quickPlayDiagnosticState.active ? "running" : "stopped",
    snapshot: payload,
    last_read_error: null
  });
  if (typeof log === "function") {
    const signature = JSON.stringify({
      board_width: payload.board_width,
      board_height: payload.board_height,
      current: payload.current?.type ?? null,
      hold: payload.hold ?? null,
      queue: payload.queue
    });
    if (
      quickPlayDiagnosticState.lastPassiveSnapshotLogSignature !== signature ||
      Math.max(0, Number(now ?? Date.now())) -
        Math.max(0, Number(quickPlayDiagnosticState.lastPassiveSnapshotLogAt ?? 0)) >=
        3000
    ) {
      quickPlayDiagnosticState.lastPassiveSnapshotLogSignature = signature;
      quickPlayDiagnosticState.lastPassiveSnapshotLogAt = Math.max(0, Number(now ?? Date.now()));
      log(
        `[quick-play] passive snapshot ready board=${payload.board_width}x${payload.board_height} current=${payload.current?.type ?? ""} hold=${payload.hold ?? ""} queue=${payload.queue.join(",")}`
      );
    }
  }
  return { status: "ready", snapshot: payload };
}

export async function pollQuickPlayPassiveSnapshotNow(
  cdp,
  quickPlayDiagnosticState,
  {
    now = Date.now(),
    log = console.log
  } = {}
) {
  const diagnostics = quickPlayDiagnosticState?.diagnostics?.passive_snapshot;
  const boundCandidate = quickPlayDiagnosticState?.boundLocalClosureCandidate;
  if (!diagnostics || !boundCandidate?.rootObjectId || boundCandidate.identityBound !== true) {
    return { status: "skipped", reason: "binding_incomplete" };
  }
  if (diagnostics.polling_started !== true) {
    diagnostics.polling_started = true;
    log?.(
      `[quick-play] passive snapshot polling started candidate=${String(boundCandidate.candidateId ?? "")} interval_ms=${Math.max(100, Number(quickPlayDiagnosticState?.passiveSnapshotIntervalMs ?? 150))}`
    );
  }
  const snapshot = await readQuickPlayPassiveSnapshot(cdp, quickPlayDiagnosticState, {
    now,
    log
  });
  quickPlayDiagnosticState.nextPassiveSnapshotAt =
    now + Math.max(100, Number(quickPlayDiagnosticState.passiveSnapshotIntervalMs ?? 150));
  if (snapshot.status !== "ready") {
    markQuickPlayPassiveSnapshotUnavailable(
      quickPlayDiagnosticState,
      snapshot.reason ?? "candidate_handle_invalid"
    );
    if (
      typeof log === "function" &&
      quickPlayDiagnosticState.lastPassiveSnapshotFailureLogReason !==
        String(snapshot.reason ?? "candidate_handle_invalid")
    ) {
      quickPlayDiagnosticState.lastPassiveSnapshotFailureLogReason = String(
        snapshot.reason ?? "candidate_handle_invalid"
      );
      log(
        `[quick-play] passive snapshot unusable reason=${String(
          snapshot.reason ?? "candidate_handle_invalid"
        )} board_shape=${String(
          snapshot.field_diagnostics?.board?.raw_constructor ??
            snapshot.field_diagnostics?.board?.raw_type ??
            "unknown"
        )} current_shape=${String(
          snapshot.field_diagnostics?.current?.raw_constructor ??
            snapshot.field_diagnostics?.current?.raw_type ??
            "unknown"
        )} queue_shape=${String(
          snapshot.field_diagnostics?.queue?.raw_constructor ??
            snapshot.field_diagnostics?.queue?.raw_type ??
            "unknown"
        )}`
      );
    }
    if ((snapshot.reason ?? "") === "candidate_handle_invalid") {
      await releaseQuickPlayPassiveState(cdp, quickPlayDiagnosticState, {
        reason: "candidate_handle_invalid",
        writeSnapshotStatus: true,
        preserveDiagnostics: true,
        log
      });
    }
  }
  return snapshot;
}

async function captureSoloClosureFingerprintForPausedCandidate(
  cdp,
  {
    pausedEvent,
    frameIndex,
    scopeIndex,
    locator,
    objectId,
    filePath = DEFAULT_SOLO_CLOSURE_FINGERPRINT_PATH,
    targetGeneration = 0
  } = {}
) {
  if (!pausedEvent || !Number.isFinite(frameIndex) || !Number.isFinite(scopeIndex) || !objectId) {
    return false;
  }
  const callFrame = pausedEvent.callFrames?.[frameIndex];
  const scope = callFrame?.scopeChain?.[scopeIndex];
  const result = await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      const listKeys = (value) => {
        if (!value || typeof value !== "object") return [];
        try {
          return Object.keys(value).slice(0, 20);
        } catch {
          return [];
        }
      };
      try {
        const rootObjectKeys = listKeys(this);
        const eject = typeof this.ejectState === "function" ? this.ejectState() : null;
        const state =
          eject && typeof eject === "object" && eject.game ? eject.game : eject;
        const boardState = typeof this.ejectBoardState === "function" ? this.ejectBoardState() : null;
        return {
          rootObjectKeys,
          ejectKeys: listKeys(eject),
          stateKeys: listKeys(state),
          boardStateKeys: listKeys(boardState)
        };
      } catch {
        return {
          rootObjectKeys: [],
          ejectKeys: [],
          stateKeys: [],
          boardStateKeys: []
        };
      }
    }`,
    returnByValue: true,
    silent: true
  }).catch(() => null);
  const fingerprint = result?.result?.value ?? {};
  return writeJsonFile(filePath, {
    timestamp: Date.now(),
    target_generation: Math.max(0, Number(targetGeneration ?? 0)),
    script_url_basename: basenameFromUrlLike(callFrame?.url ?? callFrame?.documentURL ?? ""),
    script_id:
      normalizedScalar(callFrame?.location?.scriptId) ??
      normalizedScalar(callFrame?.functionLocation?.scriptId) ??
      null,
    frame_function_name: normalizedScalar(callFrame?.functionName) ?? null,
    call_frame_index: Math.max(0, Number(frameIndex)),
    scope_index: Math.max(0, Number(scopeIndex)),
    scope_type: normalizedScalar(scope?.type) ?? null,
    local_binding_name: buildLocatorPropertyChain(locator)[0] ?? null,
    successful_locator: normalizedScalar(locator) ?? null,
    property_chain: buildLocatorPropertyChain(locator, ["ejectState", "game", "board"]),
    root_object_keys: Array.isArray(fingerprint.rootObjectKeys) ? fingerprint.rootObjectKeys : [],
    eject_keys: Array.isArray(fingerprint.ejectKeys) ? fingerprint.ejectKeys : [],
    state_keys: Array.isArray(fingerprint.stateKeys) ? fingerprint.stateKeys : [],
    board_state_keys: Array.isArray(fingerprint.boardStateKeys) ? fingerprint.boardStateKeys : []
  });
}

function normalizeScriptFamilyKey(value) {
  return basenameFromUrlLike(value)
    .toLowerCase()
    .replace(/\.(m?js|cjs)$/i, "")
    .replace(/[0-9a-f]{6,}/g, "{hash}")
    .replace(/\d{3,}/g, "{n}")
    .replace(/[-_.]+/g, "-")
    .trim();
}

function scoreQuickPlayCallFrame(
  callFrame,
  {
    soloFingerprint = null,
    bindingNames = [],
    scopeTypes = [],
    frameIndex = -1
  } = {}
) {
  let score = getFramePriority(callFrame, {
    targetUrl: "",
    mainFrameId: "",
    preferredLocators: soloFingerprint?.successful_locator
      ? [soloFingerprint.successful_locator]
      : []
  });
  if (!soloFingerprint) {
    return score;
  }
  const scriptBasename = basenameFromUrlLike(callFrame?.url ?? callFrame?.documentURL ?? "");
  if (
    soloFingerprint.script_url_basename &&
    scriptBasename === String(soloFingerprint.script_url_basename)
  ) {
    score += 20000;
  }
  if (
    soloFingerprint.script_url_basename &&
    normalizeScriptFamilyKey(scriptBasename) ===
      normalizeScriptFamilyKey(soloFingerprint.script_url_basename)
  ) {
    score += 12000;
  }
  if (
    soloFingerprint.frame_function_name &&
    normalizeIdentityText(callFrame?.functionName) ===
      normalizeIdentityText(soloFingerprint.frame_function_name)
  ) {
    score += 40000;
  }
  if (
    soloFingerprint.scope_type &&
    scopeTypes.some(
      (scopeType) =>
        normalizeIdentityText(scopeType) === normalizeIdentityText(soloFingerprint.scope_type)
    )
  ) {
    score += 9000;
  }
  const closureScopes = scopeTypes.filter(
    (scopeType) => normalizeIdentityText(scopeType) === "closure"
  ).length;
  score += Math.min(6, closureScopes) * 2500;
  score += Math.min(
    5000,
    (Array.isArray(bindingNames) ? bindingNames.length : 0) * 50
  );
  for (const segment of soloFingerprint.property_chain ?? []) {
    if (
      bindingNames.some(
        (bindingName) =>
          normalizeIdentityText(bindingName) === normalizeIdentityText(segment)
      )
    ) {
      score += 1500;
    }
  }
  if (
    bindingNames.some((bindingName) =>
      /(eject|state|board|current|queue|hold|piece|game|engine|replay)/i.test(
        bindingName
      )
    )
  ) {
    score += 750;
  }
  return score;
}

function scoreQuickPlayScope(scopeEntry, soloFingerprint = null) {
  if (!scopeEntry) {
    return 0;
  }
  let score = 0;
  const bindingNames = Array.isArray(scopeEntry.bindingNames) ? scopeEntry.bindingNames : [];
  if (normalizeIdentityText(scopeEntry.scopeType) === "closure") {
    score += 20000;
  }
  if (
    soloFingerprint?.scope_type &&
    normalizeIdentityText(scopeEntry.scopeType) ===
      normalizeIdentityText(soloFingerprint.scope_type)
  ) {
    score += 12000;
  }
  if (
    Number.isFinite(Number(soloFingerprint?.scope_index)) &&
    scopeEntry.scopeIndex === Math.max(0, Number(soloFingerprint.scope_index))
  ) {
    score += 6000;
  }
  if (scopeEntry.scopeIndex === 4) {
    score += 16000;
  } else if (scopeEntry.scopeIndex === 3) {
    score += 8000;
  }
  for (const segment of soloFingerprint?.property_chain ?? []) {
    if (
      bindingNames.some(
        (bindingName) =>
          normalizeIdentityText(bindingName) === normalizeIdentityText(segment)
      )
    ) {
      score += 1200;
    }
  }
  if (
    bindingNames.some((bindingName) =>
      /(eject|state|board|current|queue|hold|piece|game|engine|replay)/i.test(
        bindingName
      )
    )
  ) {
    score += 400;
  }
  score += Math.min(120, Number(bindingNames.length ?? 0)) * 10;
  return score;
}

function buildQuickPlayInspectionResult(
  inspectionTarget,
  {
    attempt = 1,
    inventoryBindingCount = 0,
    propertiesBindingCount = 0,
    inspectedObjectBindings = [],
    skippedPrimitiveBindings = [],
    skippedFunctionBindings = [],
    result = ""
  } = {}
) {
  return {
    attempt: Math.max(1, Number(attempt ?? 1)),
    selected_function_name: inspectionTarget?.functionName ?? null,
    selected_call_frame_index: Number.isFinite(Number(inspectionTarget?.callFrameIndex))
      ? Math.max(0, Number(inspectionTarget.callFrameIndex))
      : null,
    selected_scope_index: Number.isFinite(Number(inspectionTarget?.scopeIndex))
      ? Math.max(0, Number(inspectionTarget.scopeIndex))
      : null,
    selected_scope_type: inspectionTarget?.scopeType ?? null,
    inventory_binding_count: Math.max(0, Number(inventoryBindingCount ?? 0)),
    properties_binding_count: Math.max(0, Number(propertiesBindingCount ?? 0)),
    inspected_object_bindings: Array.isArray(inspectedObjectBindings)
      ? inspectedObjectBindings.slice(0, 80)
      : [],
    skipped_primitive_bindings: Array.isArray(skippedPrimitiveBindings)
      ? skippedPrimitiveBindings.slice(0, 80)
      : [],
    skipped_function_bindings: Array.isArray(skippedFunctionBindings)
      ? skippedFunctionBindings.slice(0, 80)
      : [],
    result: String(result ?? "")
  };
}

function shouldInspectQuickPlayBindingDescriptor(descriptor) {
  const value = descriptor?.value ?? null;
  if (!value || value.objectId == null) {
    return false;
  }
  if (value.type !== "object") {
    return false;
  }
  const subtype = normalizeIdentityText(value.subtype);
  const className = normalizeIdentityText(value.className);
  if (subtype === "null" || subtype === "node") {
    return false;
  }
  if (
    /(console|window|global|document|location|navigator|history|storage|event|events|promise)/i.test(
      className
    )
  ) {
    return false;
  }
  return true;
}

function incrementQuickPlayDiagnosticCounter(record, key, amount = 1) {
  if (!record || typeof record !== "object") {
    return false;
  }
  const delta = Number(amount);
  if (!Number.isFinite(delta) || delta === 0) {
    return false;
  }
  record[key] = Math.max(0, Number(record[key] ?? 0) + delta);
  return true;
}

function incrementQuickPlayDiagnosticBucket(record, key) {
  if (!record || typeof record !== "object") {
    return false;
  }
  const bucketKey = String(key ?? "").trim();
  if (!bucketKey) {
    return false;
  }
  record[bucketKey] = Math.max(0, Number(record[bucketKey] ?? 0) + 1);
  return true;
}

async function inspectQuickPlayClosureDiagnosticCandidate(
  cdp,
  objectId,
  candidateId,
  locator,
  {
    attempt = 1,
    functionName = null,
    callFrameIndex = 0,
    scopeIndex = 0,
    scopeType = null
  } = {}
) {
  const result = await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      const MAX_KEYS = 50;
      const MAX_DEPTH = 4;
      const MAX_CHILD_OBJECTS = 200;
      const INTERESTING_KEYS = new Set([
        "ejectstate",
        "eject",
        "state",
        "game",
        "board",
        "boardstate",
        "field",
        "current",
        "hold",
        "queue",
        "next",
        "replay",
        "engine",
        "seed",
        "gameid",
        "userid",
        "piececounter",
        "phase"
      ]);
      const normalizePiece = (piece) => {
        if (typeof piece === "string") {
          const token = piece.trim().toLowerCase();
          return ["i", "o", "t", "s", "z", "j", "l"].includes(token) ? token : null;
        }
        if (typeof piece === "number") {
          return ["i", "o", "t", "s", "z", "j", "l"][piece] ?? null;
        }
        if (piece && typeof piece === "object") {
          return normalizePiece(piece.type ?? piece.name ?? piece.kind ?? piece.id);
        }
        return null;
      };
      const scalar = (value) =>
        value === null ||
        value === undefined ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
          ? value
          : undefined;
      const numberFrom = (...values) => {
        for (const value of values) {
          const number = Number(value);
          if (Number.isFinite(number)) return number;
        }
        return null;
      };
      const rowCells = (row) =>
        Array.isArray(row)
          ? row
          : Array.isArray(row?.cells)
            ? row.cells
            : Array.isArray(row?.row)
              ? row.row
              : null;
      const filled = (cell) => {
        if (cell === null || cell === undefined || cell === false || cell === 0 || cell === "") return false;
        if (typeof cell === "string") {
          const text = cell.trim().toLowerCase();
          return text !== "" && text !== "." && text !== "0" && text !== "empty";
        }
        if (typeof cell === "object") {
          if ("empty" in cell) return !cell.empty;
          if ("type" in cell) return filled(cell.type);
          if ("mino" in cell) return filled(cell.mino);
        }
        return true;
      };
      const queueFrom = (...values) => {
        for (const value of values) {
          if (!Array.isArray(value)) continue;
          const queue = value.map(normalizePiece).filter(Boolean);
          if (queue.length > 0) return queue.slice(0, 10);
        }
        return [];
      };
      const normalizeKey = (value) => String(value ?? "").trim().toLowerCase();
      const listKeys = (value) => {
        if (!value || typeof value !== "object") return [];
        try {
          return Object.keys(value).slice(0, MAX_KEYS);
        } catch {
          return [];
        }
      };
      const objectBrand = (value) => {
        try {
          return Object.prototype.toString.call(value);
        } catch {
          return "[object Unknown]";
        }
      };
      const isDomLike = (value) =>
        !!value &&
        typeof value === "object" &&
        typeof value.nodeType === "number" &&
        typeof value.nodeName === "string";
      const isSkippableObject = (value) => {
        if (!value || typeof value !== "object") {
          return true;
        }
        if (isDomLike(value)) {
          return true;
        }
        const brand = objectBrand(value);
        if (brand === "[object Object]" || brand === "[object Array]") {
          return false;
        }
        if (
          /\[object (Window|HTML.+Element|Document|Location|Navigator|Console|Performance|Event)\]/.test(
            brand
          )
        ) {
          return true;
        }
        const keys = listKeys(value).map(normalizeKey);
        if (
          keys.length > 0 &&
          keys.every((key) => /^(console|logger|event|events|analytics|listeners?)$/.test(key))
        ) {
          return true;
        }
        return false;
      };
      const boardFrom = (value) => {
        if (!value || typeof value !== "object") return null;
        if (Array.isArray(value.board)) return value.board;
        if (Array.isArray(value.field)) return value.field;
        if (Array.isArray(value.matrix)) return value.matrix;
        if (Array.isArray(value.b)) return value.b;
        return null;
      };
      const summarizeBoard = (board) => {
        const rows = [];
        let hash = 2166136261 >>> 0;
        for (let rowIndex = 0; rowIndex < Math.min(40, board.length); rowIndex += 1) {
          const sourceRow = board[board.length - 1 - rowIndex];
          const cells = rowCells(sourceRow);
          let filledCount = 0;
          for (let x = 0; x < 10; x += 1) {
            const active = filled(cells ? cells[x] : null) ? 1 : 0;
            filledCount += active;
            hash ^= active + x + rowIndex * 17;
            hash = Math.imul(hash, 16777619) >>> 0;
          }
          rows.push(filledCount);
        }
        return {
          boardHash: hash.toString(16).padStart(8, "0"),
          rowOccupancy: rows
        };
      };
      const fullPathFrom = (parts) => ["frame[${callFrameIndex}]", "scope[${scopeIndex}]", ${JSON.stringify(locator)}, ...parts]
        .filter(Boolean)
        .join(".");
      const readPath = (root, parts) => {
        let current = root;
        for (const part of parts) {
          if (!current || typeof current !== "object") {
            return { ok: false, value: null };
          }
          try {
            current = current[part];
          } catch {
            return { ok: false, value: null };
          }
        }
        return { ok: true, value: current };
      };
      const hasStateShape = (value) => {
        if (!value || typeof value !== "object") return false;
        const directBoard = boardFrom(value);
        const directQueue = queueFrom(
          value.queue,
          value.next,
          value.preview,
          value.previews,
          value.bag,
          value.pieces
        );
        const directCurrent = normalizePiece(
          value.current ?? value.falling ?? value.active ?? value.piece
        );
        const directHold = normalizePiece(value.hold ?? value.held);
        return Boolean(
          directBoard ||
            directQueue.length > 0 ||
            directCurrent ||
            directHold ||
            scalar(value.gameid ?? value.game_id ?? value.seed ?? value.userid ?? value.user_id) !== undefined
        );
      };
      const statePathFrom = (value) => {
        if (!value || typeof value !== "object") return [];
        if (hasStateShape(value)) {
          return [];
        }
        for (const key of ["game", "state", "replay", "engine", "session"]) {
          if (hasStateShape(value?.[key])) {
            return [key];
          }
        }
        return [];
      };
      const resolveAccessorPath = (root, basePath, keys, predicate, { allowNull = false } = {}) => {
        for (const key of keys) {
          const path = [...basePath, key];
          const candidate = readPath(root, path);
          if (!candidate.ok) {
            continue;
          }
          if (allowNull && candidate.value === null) {
            return { path, value: null };
          }
          if (predicate(candidate.value)) {
            return { path, value: candidate.value };
          }
        }
        return { path: [], value: undefined };
      };
      const summarizeNode = (value, pathParts, matchedShape = "binding") => {
        const objectKeys = listKeys(value);
        const statePath = statePathFrom(value);
        let state = extractStateLike(readPath(value, statePath).value ?? value);
        let board = boardFrom(state);
        const boardAccessor = resolveAccessorPath(
          value,
          statePath,
          ["board", "field", "matrix", "b"],
          (candidate) => Array.isArray(candidate)
        );
        const directState = value?.ejectState;
        if (directState && typeof directState === "object") {
          const directGame = directState.game && typeof directState.game === "object"
            ? directState.game
            : directState;
          state = extractStateLike(directGame) ?? state;
          board = boardFrom(directGame) ?? board;
        }
        const ejectStateFn = value?.ejectState;
        if ((!board || board.length === 0) && typeof ejectStateFn === "function") {
          try {
            const exported = ejectStateFn.call(value);
            const exportedState =
              exported && typeof exported === "object" && exported.game
                ? exported.game
                : exported;
            state = extractStateLike(exportedState) ?? state;
            board = boardFrom(exportedState) ?? board;
          } catch {}
        }
        const currentAccessor = resolveAccessorPath(
          value,
          statePath,
          ["falling", "active", "current", "piece"],
          (candidate) => normalizePiece(candidate) !== null
        );
        const holdAccessor = resolveAccessorPath(
          value,
          statePath,
          ["hold", "held"],
          (candidate) => normalizePiece(candidate) !== null,
          { allowNull: true }
        );
        const queueAccessor = resolveAccessorPath(
          value,
          statePath,
          ["queue", "next", "preview", "previews", "bag", "pieces"],
          (candidate) => Array.isArray(candidate)
        );
        const activeState = currentAccessor.value;
        const current = normalizePiece(activeState);
        const hold = normalizePiece(holdAccessor.value);
        const queue = queueFrom(queueAccessor.value);
        const gameid = scalar(
          state?.gameid ?? state?.game_id ?? state?.options?.gameid ?? state?.room?.gameid
        );
        const seed = scalar(
          state?.seed ?? state?.options?.seed ?? state?.room?.seed
        );
        const userid = scalar(
          state?.userid ?? state?.user_id ?? state?.user?._id ?? state?.user?.userid
        );
        const pieceCounter = Math.max(0, Math.floor(numberFrom(
          state?.stats?.piecesplaced,
          state?.stats?.piecesPlaced,
          state?.stats?.pieces,
          state?.piecesplaced,
          state?.piecesPlaced,
          state?.pieceCounter,
          state?.piececount,
          0
        ) ?? 0));
        const hasBoardLike = Array.isArray(board) && board.length > 0;
        const hasCurrentLike = current !== null;
        const hasQueueLike =
          queue.length > 0 ||
          Array.isArray(state?.queue) ||
          Array.isArray(state?.next) ||
          Array.isArray(state?.preview) ||
          Array.isArray(state?.previews);
        const hasHoldLike =
          hold !== null ||
          state?.hold !== undefined ||
          state?.held !== undefined;
        const hasGameId = gameid !== undefined && gameid !== null;
        const hasSeed = seed !== undefined && seed !== null;
        const hasUserId = userid !== undefined && userid !== null;
        const rejectedReason = [];
        if (!hasBoardLike) rejectedReason.push("board_missing");
        if (!hasCurrentLike) rejectedReason.push("current_missing");
        if (!hasQueueLike) rejectedReason.push("queue_missing");
        if (
          !hasBoardLike &&
          !hasCurrentLike &&
          !hasQueueLike &&
          !hasHoldLike &&
          !hasGameId &&
          !hasSeed &&
          !hasUserId
        ) {
          rejectedReason.push("no_game_shape");
        }
        if (state?.destroyed || state?.dead || state?.gameover) {
          rejectedReason.push("ended_state");
        }
        const record = {
          candidateId: ${JSON.stringify(candidateId)},
          locator: ${JSON.stringify(locator)},
          bindingName: ${JSON.stringify(locator)},
          retainedRootKind:
            pathParts.length === 0
              ? "binding"
              : normalizeKey(pathParts[pathParts.length - 1] ?? "") === "state"
                ? "state"
                : normalizeKey(pathParts[pathParts.length - 1] ?? "") === "game"
                  ? "game"
                  : "binding",
          retainedRootPath: pathParts.slice(0, 8),
          fullPath: fullPathFrom(pathParts),
          matchedShape: matchedShape || "binding",
          objectKeys,
          typeof: typeof value,
          hasBoardLike,
          hasCurrentLike,
          hasQueueLike,
          hasHoldLike,
          hasGameId,
          hasSeed,
          hasUserId,
          rejectedReason,
          current,
          hold,
          queue,
          gameid,
          seed,
          userid,
          pieceCounter,
          discoveredPaths: {
            board: boardAccessor.path.slice(0, 8),
            current: currentAccessor.path.slice(0, 8),
            hold: holdAccessor.path.slice(0, 8),
            queue: queueAccessor.path.slice(0, 8)
          }
        };
        if (hasBoardLike) {
          const boardSummary = summarizeBoard(board);
          record.boardWidth = rowCells(board[0])?.length ?? 10;
          record.boardHeight = board.length;
          record.boardHash = boardSummary.boardHash;
          record.rowOccupancy = boardSummary.rowOccupancy;
          if (
            objectKeys.map(normalizeKey).includes("board") &&
            String(record.fullPath).endsWith(".board") === false
          ) {
            record.fullPath = fullPathFrom([...pathParts, "board"]);
            if (record.matchedShape === "binding") {
              record.matchedShape = "board";
            } else if (String(record.matchedShape).endsWith(".board") === false) {
              record.matchedShape = String(record.matchedShape) + ".board";
            }
          }
        }
        record.playing =
          typeof value?.isPlaying === "function"
            ? Boolean(value.isPlaying())
            : typeof state?.playing === "boolean"
              ? state.playing
              : typeof state?.paused === "boolean"
                ? !state.paused
                : true;
        record.ended = Boolean(
          state?.destroyed ||
            state?.dead ||
            state?.gameover ||
            (typeof record.playing === "boolean" && !record.playing)
        );
        record.accepted = record.rejectedReason.length === 0;
        return record;
      };
      const extractStateLike = (value) => {
        if (!value || typeof value !== "object") return null;
        const directBoard = boardFrom(value);
        const directQueue = queueFrom(
          value.queue,
          value.next,
          value.preview,
          value.previews,
          value.bag,
          value.pieces
        );
        const directCurrent = normalizePiece(
          value.current ?? value.falling ?? value.active ?? value.piece
        );
        const directHold = normalizePiece(value.hold ?? value.held);
        if (
          directBoard ||
          directQueue.length > 0 ||
          directCurrent ||
          directHold ||
          scalar(value.gameid ?? value.game_id ?? value.seed ?? value.userid ?? value.user_id) !== undefined
        ) {
          return value;
        }
        for (const key of ["game", "state", "replay", "engine", "session"]) {
          const nested = value[key];
          if (!nested || typeof nested !== "object") {
            continue;
          }
          const nestedBoard = boardFrom(nested);
          const nestedQueue = queueFrom(
            nested.queue,
            nested.next,
            nested.preview,
            nested.previews,
            nested.bag,
            nested.pieces
          );
          const nestedCurrent = normalizePiece(
            nested.current ?? nested.falling ?? nested.active ?? nested.piece
          );
          const nestedHold = normalizePiece(nested.hold ?? nested.held);
          if (
            nestedBoard ||
            nestedQueue.length > 0 ||
            nestedCurrent ||
            nestedHold ||
            scalar(nested.gameid ?? nested.game_id ?? nested.seed ?? nested.userid ?? nested.user_id) !== undefined
          ) {
            return nested;
          }
        }
        return value;
      };
      const walkPreferredPath = (root, pathParts, matchedShape) => {
        let current = root;
        const traversed = [];
        for (const part of pathParts) {
          traversed.push(part);
          if (!current || typeof current !== "object") {
            return {
              fullPath: fullPathFrom(traversed),
              matchedShape,
              objectKeys: [],
              rejectedReason: ["path_missing"]
            };
          }
          try {
            current = current[part];
          } catch {
            return {
              fullPath: fullPathFrom(traversed),
              matchedShape,
              objectKeys: [],
              rejectedReason: ["getter_failed"]
            };
          }
          if (current === null || current === undefined) {
            return {
              fullPath: fullPathFrom(traversed),
              matchedShape,
              objectKeys: [],
              rejectedReason: ["path_missing"]
            };
          }
        }
        if (!current || typeof current !== "object") {
          return {
            fullPath: fullPathFrom(pathParts),
            matchedShape,
            objectKeys: [],
            rejectedReason: ["not_object"]
          };
        }
        return summarizeNode(current, pathParts, matchedShape);
      };
      try {
        if (!this || typeof this !== "object" || isSkippableObject(this)) {
          return {
            candidateId: ${JSON.stringify(candidateId)},
            locator: ${JSON.stringify(locator)},
            bindingName: ${JSON.stringify(locator)},
            fullPath: fullPathFrom([]),
            matchedShape: "binding",
            objectKeys: [],
            typeof: typeof this,
            hasBoardLike: false,
            hasCurrentLike: false,
            hasQueueLike: false,
            hasHoldLike: false,
            hasGameId: false,
            hasSeed: false,
            hasUserId: false,
            rejectedReason: ["skipped_object"],
            accepted: false
          };
        }
        const preferredPaths = [
          { parts: ["ejectState", "game", "board"], matchedShape: "ejectState.game.board" },
          { parts: ["ejectState", "game"], matchedShape: "ejectState.game" },
          { parts: ["ejectState"], matchedShape: "ejectState" },
          { parts: ["ejectState", "game", "current"], matchedShape: "ejectState.game.current" },
          { parts: ["ejectState", "game", "hold"], matchedShape: "ejectState.game.hold" },
          { parts: ["ejectState", "game", "queue"], matchedShape: "ejectState.game.queue" },
          { parts: ["eject", "game", "board"], matchedShape: "eject.game.board" },
          { parts: ["game", "board"], matchedShape: "game.board" },
          { parts: ["state", "board"], matchedShape: "state.board" },
          { parts: ["board"], matchedShape: "board" }
        ];
        let bestRecord = summarizeNode(this, [], "binding");
        const scoreRecord = (record) =>
          (record?.hasBoardLike ? 16 : 0) +
          (record?.hasCurrentLike ? 8 : 0) +
          (record?.hasQueueLike ? 8 : 0) +
          (record?.hasHoldLike ? 4 : 0) +
          (record?.hasGameId ? 4 : 0) +
          (record?.hasSeed ? 4 : 0) +
          (record?.hasUserId ? 4 : 0) -
          Math.max(0, Array.isArray(record?.rejectedReason) ? record.rejectedReason.length : 0);
        const visitedObjects = new Set();
        const queue = [{ value: this, pathParts: [] }];
        let childObjectsVisited = 0;
        const candidateRecords = [];
        while (queue.length > 0 && childObjectsVisited < MAX_CHILD_OBJECTS) {
          const entry = queue.shift();
          const value = entry?.value;
          const pathParts = entry?.pathParts ?? [];
          if (!value || typeof value !== "object") {
            continue;
          }
          if (visitedObjects.has(value) || isSkippableObject(value)) {
            continue;
          }
          visitedObjects.add(value);
          childObjectsVisited += 1;
          const keys = listKeys(value);
          const normalizedKeys = keys.map(normalizeKey);
          if (
            normalizedKeys.some((key) => INTERESTING_KEYS.has(key)) ||
            pathParts.length === 0
          ) {
            const rootShape = pathParts.length === 0
              ? "binding"
              : normalizeKey(pathParts[pathParts.length - 1] ?? "binding");
            candidateRecords.push(summarizeNode(value, pathParts, rootShape));
            for (const preferred of preferredPaths) {
              const preferredRecord = walkPreferredPath(
                value,
                preferred.parts,
                preferred.matchedShape
              );
              if (
                preferredRecord?.hasBoardLike ||
                preferredRecord?.hasCurrentLike ||
                preferredRecord?.hasQueueLike ||
                preferredRecord?.hasHoldLike ||
                preferredRecord?.hasGameId ||
                preferredRecord?.hasSeed ||
                preferredRecord?.hasUserId
              ) {
                candidateRecords.push(preferredRecord);
              }
            }
          }
          if (pathParts.length >= MAX_DEPTH) {
            continue;
          }
          for (const key of keys) {
            if (queue.length >= MAX_CHILD_OBJECTS) {
              break;
            }
            let nextValue;
            try {
              nextValue = value[key];
            } catch {
              continue;
            }
            if (!nextValue || typeof nextValue !== "object" || isSkippableObject(nextValue)) {
              continue;
            }
            queue.push({
              value: nextValue,
              pathParts: [...pathParts, key]
            });
          }
        }
        for (const record of candidateRecords) {
          const evidenceScore = scoreRecord(record);
          const bestScore = scoreRecord(bestRecord);
          const recordDepth = String(record?.fullPath ?? "").split(".").length;
          const bestDepth = String(bestRecord?.fullPath ?? "").split(".").length;
          if (
            evidenceScore > bestScore ||
            (evidenceScore === bestScore &&
              recordDepth > bestDepth &&
              record?.matchedShape !== "binding")
          ) {
            bestRecord = record;
          }
        }
        return bestRecord;
      } catch {
        return {
          candidateId: ${JSON.stringify(candidateId)},
          locator: ${JSON.stringify(locator)},
          bindingName: ${JSON.stringify(locator)},
          fullPath: fullPathFrom([]),
          matchedShape: "binding",
          objectKeys: [],
          typeof: "object",
          hasBoardLike: false,
          hasCurrentLike: false,
          hasQueueLike: false,
          hasHoldLike: false,
          hasGameId: false,
          hasSeed: false,
          hasUserId: false,
          rejectedReason: ["inspection_failed"],
          accepted: false
        };
      }
    }`,
    returnByValue: true,
    silent: true
  }).catch((error) => ({
    result: {
      value: {
        candidateId,
        locator,
        bindingName: locator,
        fullPath: `frame[${callFrameIndex}].scope[${scopeIndex}].${locator}`,
        matchedShape: "binding",
        objectKeys: [],
        typeof: "object",
        hasBoardLike: false,
        hasCurrentLike: false,
        hasQueueLike: false,
        hasHoldLike: false,
        hasGameId: false,
        hasSeed: false,
        hasUserId: false,
        rejectedReason: [
          `inspect_failed:${String(error?.message ?? error ?? "unknown")}`
        ]
      }
    }
  }));
  return result?.result?.value ?? null;
}

export async function collectQuickPlayClosureDiagnosticFromPausedScopes(
  cdp,
  pausedEvent,
  {
    quickPlayDiagnosticState = null,
    attempt = 1,
    targetUrl = "",
    mainFrameId = "",
    maxRawCandidates = DEFAULT_QUICK_PLAY_CLOSURE_SCAN_MAX_RAW_CANDIDATES,
    perScanBudgetMs = DEFAULT_QUICK_PLAY_CLOSURE_SCAN_PAUSE_BUDGET_MS,
    log = quickPlayDiagnosticState?.logFn ?? console.log
  } = {}
) {
  const inventory = await buildQuickPlayPausedFrameInventory(cdp, pausedEvent);
  const callFrames = inventory.callFrames ?? [];
  const baseResult = {
    rawCandidates: [],
    acceptedCandidates: [],
    framesScanned: 0,
    scopesScanned: 0,
    durationMs: 0,
    callframesSeen: callFrames.length,
    tickFramesSeen: 0,
    selectedTickFrames: 0,
    matchingFramesSeen: 0,
    matchingScopesSeen: 0,
    candidateClosureScopesSeen: 0,
    selectedPrimaryScopes: 0,
    selectedSecondaryScopes: 0,
    targetedInspections: 0,
    genericTargetsSeen: 0,
    targetHandoffMismatches: 0,
    inventoryRowsWritten: 0,
    productive: false
  };
  if (inventory.resultType === "callframes_missing") {
    return { ...baseResult, resultType: "callframes_missing" };
  }
  const writeResult = writeQuickPlayCallFrameInventory(
    cdp,
    quickPlayDiagnosticState,
    inventory.frameInventory,
    attempt
  );
  baseResult.inventoryRowsWritten = Math.max(0, Number(writeResult?.rowsWritten ?? 0));
  if (writeResult?.ok !== true) {
    return {
      ...baseResult,
      resultType: "inventory_write_failed",
      error: String(writeResult?.error ?? "inventory_write_failed")
    };
  }
  if (inventory.resultType === "callframes_empty") {
    return {
      ...baseResult,
      resultType: "callframes_empty",
      noTickAttempt: summarizeQuickPlayNoTickCallFrames(callFrames, attempt)
    };
  }
  const soloFingerprint = readJsonFileIfPresent(
    quickPlayDiagnosticState?.soloClosureFingerprintPath ??
      DEFAULT_SOLO_CLOSURE_FINGERPRINT_PATH
  );
  const frameInventory = inventory.frameInventory.map((row, frameIndex) => ({
    frameIndex,
    callFrame: callFrames[frameIndex],
    bindingNames: [
      ...new Set(
        (row?.scopes ?? []).flatMap((scope) =>
          Array.isArray(scope?.binding_names) ? scope.binding_names.slice(0, 20) : []
        )
      )
    ],
    scopeTypes: Array.isArray(row?.scope_types) ? row.scope_types : [],
    scopes: (row?.scopes ?? []).map((scope) => ({
      scopeIndex: Math.max(0, Number(scope?.scope_index ?? 0)),
      scopeType: normalizedScalar(scope?.scope_type) ?? "",
      bindingNames: Array.isArray(scope?.binding_names) ? scope.binding_names.slice(0, 80) : []
    }))
  }));
  const tickFrames = frameInventory.filter(
    (entry) =>
      normalizeIdentityText(entry.callFrame?.functionName) === "_tick" &&
      entry.scopes.some(
        (scopeEntry) => normalizeIdentityText(scopeEntry.scopeType) === "closure"
      )
  );
  baseResult.tickFramesSeen = tickFrames.length;
  const selectedFrames = tickFrames
    .map((entry) => ({
      ...entry,
      frameScore: scoreQuickPlayCallFrame(entry.callFrame, {
        soloFingerprint,
        bindingNames: entry.bindingNames,
        scopeTypes: entry.scopeTypes,
        frameIndex: entry.frameIndex
      })
    }))
    .sort((left, right) => right.frameScore - left.frameScore || left.frameIndex - right.frameIndex)
    .slice(0, 1);
  baseResult.matchingFramesSeen = selectedFrames.length;
  baseResult.selectedTickFrames = selectedFrames.length;
  if (selectedFrames.length === 0) {
    return {
      ...baseResult,
      resultType: "matching_frame_missing",
      noTickAttempt: summarizeQuickPlayNoTickCallFrames(callFrames, attempt)
    };
  }
  const frameEntry = selectedFrames[0];
  const callFrame = callFrames[frameEntry.frameIndex];
  const closureScopes = frameEntry.scopes
    .filter((scopeEntry) => normalizeIdentityText(scopeEntry.scopeType) === "closure")
    .sort((left, right) => {
      const leftPriority = left.scopeIndex === 4 ? 2 : left.scopeIndex === 3 ? 1 : 0;
      const rightPriority = right.scopeIndex === 4 ? 2 : right.scopeIndex === 3 ? 1 : 0;
      if (rightPriority !== leftPriority) {
        return rightPriority - leftPriority;
      }
      const scoreDelta = scoreQuickPlayScope(right, soloFingerprint) - scoreQuickPlayScope(left, soloFingerprint);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return left.scopeIndex - right.scopeIndex;
    });
  baseResult.candidateClosureScopesSeen = closureScopes.length;
  const scopeOrder = [];
  const primaryScope = closureScopes.find((scopeEntry) => scopeEntry.scopeIndex === 4) ?? null;
  const secondaryScope = closureScopes.find((scopeEntry) => scopeEntry.scopeIndex === 3) ?? null;
  if (primaryScope) {
    scopeOrder.push(primaryScope.scopeIndex);
    baseResult.selectedPrimaryScopes = 1;
  }
  if (secondaryScope && secondaryScope.scopeIndex !== primaryScope?.scopeIndex) {
    scopeOrder.push(secondaryScope.scopeIndex);
    baseResult.selectedSecondaryScopes = 1;
  }
  baseResult.matchingScopesSeen = scopeOrder.length;
  if (scopeOrder.length === 0) {
    return { ...baseResult, resultType: "matching_scope_missing" };
  }
  const startedAt = Date.now();
  const seenCandidateKeys = new Set();
  const rawCandidates = [];
  const acceptedCandidates = [];
  let lastInspection = null;
  const buildTarget = (scopeIndex) => {
    const scope = callFrame?.scopeChain?.[scopeIndex] ?? null;
    const scopeInventory = frameEntry.scopes.find((entry) => entry.scopeIndex === scopeIndex) ?? null;
    if (!scope?.object?.objectId) {
      return null;
    }
    return {
      attempt,
      callFrameId: normalizedScalar(callFrame?.callFrameId) ?? null,
      callFrameIndex: frameEntry.frameIndex,
      functionName: normalizedScalar(callFrame?.functionName) ?? null,
      scriptId: normalizedScalar(callFrame?.location?.scriptId) ?? null,
      lineNumber: Number.isFinite(Number(callFrame?.location?.lineNumber))
        ? Math.max(0, Number(callFrame.location.lineNumber))
        : null,
      columnNumber: Number.isFinite(Number(callFrame?.location?.columnNumber))
        ? Math.max(0, Number(callFrame.location.columnNumber))
        : null,
      scopeIndex,
      scopeType: normalizedScalar(scope?.type) ?? null,
      scopeObjectId: normalizedScalar(scope.object?.objectId) ?? null,
      inventoryBindingCount: Array.isArray(scopeInventory?.bindingNames)
        ? scopeInventory.bindingNames.length
        : 0,
      bindingNames: Array.isArray(scopeInventory?.bindingNames)
        ? scopeInventory.bindingNames.slice(0, 80)
        : []
    };
  };
  const primaryTarget = buildTarget(scopeOrder[0]);
  if (primaryTarget && typeof log === "function") {
    log(
      `[quick-play] closure target selected attempt=${attempt} function=${primaryTarget.functionName ?? ""} frame=${primaryTarget.callFrameIndex} scope=${primaryTarget.scopeIndex} scope_type=${primaryTarget.scopeType ?? ""} bindings=${primaryTarget.bindingNames.join(",")}`
    );
  }
  const makeInspection = (target, propertiesBindingCount, skippedPrimitiveBindings, skippedFunctionBindings, result) =>
    buildQuickPlayInspectionResult(target, {
      attempt,
      inventoryBindingCount: target?.inventoryBindingCount ?? 0,
      propertiesBindingCount,
      inspectedObjectBindings: [],
      skippedPrimitiveBindings,
      skippedFunctionBindings,
      result
    });
  for (const scopeIndex of scopeOrder) {
    if (Date.now() - startedAt >= perScanBudgetMs) {
      break;
    }
    const inspectionTarget = buildTarget(scopeIndex);
    if (!inspectionTarget) {
      continue;
    }
    if (
      normalizeIdentityText(inspectionTarget.functionName) !== "_tick" ||
      normalizeIdentityText(inspectionTarget.scopeType) !== "closure"
    ) {
      return {
        ...baseResult,
        resultType: "target_handoff_mismatch",
        durationMs: Math.max(0, Date.now() - startedAt),
        targetedInspections: 1,
        targetHandoffMismatches: 1,
        productive: true,
        targetedBindingInspection: buildQuickPlayInspectionResult(inspectionTarget, {
          attempt,
          inventoryBindingCount: inspectionTarget.inventoryBindingCount,
          result: "target_handoff_mismatch"
        })
      };
    }
    baseResult.framesScanned = 1;
    baseResult.scopesScanned += 1;
    if (typeof log === "function") {
      log(
        `[quick-play] closure inspection started attempt=${attempt} function=${inspectionTarget.functionName ?? ""} frame=${inspectionTarget.callFrameIndex} scope=${inspectionTarget.scopeIndex} scope_object_id_present=${inspectionTarget.scopeObjectId ? "true" : "false"}`
      );
    }
    const properties = await cdp.send("Runtime.getProperties", {
      objectId: inspectionTarget.scopeObjectId,
      ownProperties: true,
      accessorPropertiesOnly: false,
      generatePreview: false
    }).catch(() => null);
    const rawDescriptors = (properties?.result ?? []).slice(0, MAX_SCOPE_PROPERTIES_PER_SCOPE);
    lastInspection = makeInspection(
      inspectionTarget,
      rawDescriptors.length,
      rawDescriptors
        .filter((descriptor) => !descriptor?.get && !descriptor?.set)
        .filter((descriptor) => {
          const type = String(descriptor?.value?.type ?? "").trim();
          return type && type !== "object" && type !== "function";
        })
        .map((descriptor) => String(descriptor?.name ?? "").trim())
        .filter(Boolean),
      rawDescriptors
        .filter((descriptor) => !descriptor?.get && !descriptor?.set)
        .filter((descriptor) => String(descriptor?.value?.type ?? "").trim() === "function")
        .map((descriptor) => String(descriptor?.name ?? "").trim())
        .filter(Boolean),
      "inspection_started"
    );
    if (inspectionTarget.inventoryBindingCount > 0 && rawDescriptors.length === 0) {
      return {
        ...baseResult,
        resultType: "target_handoff_mismatch",
        durationMs: Math.max(0, Date.now() - startedAt),
        targetedInspections: 1,
        targetHandoffMismatches: 1,
        productive: true,
        targetedBindingInspection: {
          ...lastInspection,
          result: "target_handoff_mismatch"
        }
      };
    }
    const descriptors = rawDescriptors
      .map((descriptor, index) => ({ descriptor, index }))
      .sort((left, right) => {
        const scoreDelta =
          scorePausedScopeDescriptor(right.descriptor, []) -
          scorePausedScopeDescriptor(left.descriptor, []);
        return scoreDelta !== 0 ? scoreDelta : left.index - right.index;
      })
      .map(({ descriptor }) => descriptor);
    for (let propertyIndex = 0; propertyIndex < descriptors.length; propertyIndex += 1) {
      if (
        rawCandidates.length >= maxRawCandidates ||
        Date.now() - startedAt >= perScanBudgetMs
      ) {
        break;
      }
      const descriptor = descriptors[propertyIndex];
      if (descriptor?.get || descriptor?.set) {
        continue;
      }
      if (!shouldInspectQuickPlayBindingDescriptor(descriptor)) {
        continue;
      }
      const valueObjectId = descriptor?.value?.objectId;
      const locator = String(descriptor?.name ?? "").trim();
      if (!valueObjectId || !locator) {
        continue;
      }
      const candidateKey = [
        inspectionTarget.callFrameIndex,
        inspectionTarget.scopeIndex,
        inspectionTarget.scopeObjectId,
        propertyIndex,
        locator,
        valueObjectId
      ].join(":");
      if (seenCandidateKeys.has(candidateKey)) {
        continue;
      }
      seenCandidateKeys.add(candidateKey);
      lastInspection.inspected_object_bindings.push(locator);
      const candidateId = `paused:${inspectionTarget.callFrameIndex}:${inspectionTarget.scopeIndex}:${propertyIndex}:${locator}`;
      const inspected = await inspectQuickPlayClosureDiagnosticCandidate(
        cdp,
        valueObjectId,
        candidateId,
        locator,
        inspectionTarget
      );
      if (!inspected || typeof inspected !== "object") {
        continue;
      }
      if (
        (Number.isFinite(Number(inspected.callFrameIndex)) &&
          Number(inspected.callFrameIndex) !== inspectionTarget.callFrameIndex) ||
        (Number.isFinite(Number(inspected.scopeIndex)) &&
          Number(inspected.scopeIndex) !== inspectionTarget.scopeIndex)
      ) {
        return {
          ...baseResult,
          resultType: "target_handoff_mismatch",
          durationMs: Math.max(0, Date.now() - startedAt),
          targetedInspections: 1,
          targetHandoffMismatches: 1,
          productive: true,
          targetedBindingInspection: {
            ...lastInspection,
            result: "target_handoff_mismatch"
          }
        };
      }
      inspected.attempt = attempt;
      inspected.rootObjectId = valueObjectId;
      inspected.functionName = inspectionTarget.functionName;
      inspected.callFrameIndex = inspectionTarget.callFrameIndex;
      inspected.scopeIndex = inspectionTarget.scopeIndex;
      inspected.scopeType = inspectionTarget.scopeType;
      rawCandidates.push(inspected);
      if (typeof log === "function") {
        log(
          `[quick-play] closure candidate emitted function=${inspected.functionName ?? ""} frame=${inspected.callFrameIndex} scope=${inspected.scopeIndex} binding=${inspected.bindingName ?? ""} full_path=${inspected.fullPath ?? ""}`
        );
      }
      if (inspected.accepted === true) {
        acceptedCandidates.push(inspected);
      }
    }
    if (acceptedCandidates.length > 0) {
      break;
    }
  }
  return {
    resultType:
      Date.now() - startedAt >= perScanBudgetMs
        ? "paused_budget_reached"
        : rawCandidates.length >= maxRawCandidates
          ? "raw_candidate_limit_reached"
          : acceptedCandidates.length > 0
            ? "accepted_candidates_found"
            : "completed_not_found",
    rawCandidates,
    acceptedCandidates,
    framesScanned: baseResult.framesScanned,
    scopesScanned: baseResult.scopesScanned,
    durationMs: Math.max(0, Date.now() - startedAt),
    callframesSeen: callFrames.length,
    tickFramesSeen: baseResult.tickFramesSeen,
    selectedTickFrames: baseResult.selectedTickFrames,
    matchingFramesSeen: baseResult.matchingFramesSeen,
    matchingScopesSeen: baseResult.matchingScopesSeen,
    candidateClosureScopesSeen: baseResult.candidateClosureScopesSeen,
    selectedPrimaryScopes: baseResult.selectedPrimaryScopes,
    selectedSecondaryScopes: baseResult.selectedSecondaryScopes,
    targetedInspections: lastInspection ? 1 : 0,
    genericTargetsSeen: 0,
    targetHandoffMismatches: 0,
    inventoryRowsWritten: baseResult.inventoryRowsWritten,
    productive: true,
    targetedBindingInspection: lastInspection
      ? {
          ...lastInspection,
          result:
            acceptedCandidates.length > 0 ? "accepted_candidates_found" : "completed_not_found"
        }
      : null
  };
}

function createQuickPlayClosureSkipResult(resultType, extra = {}) {
  return {
    status: "ready",
    resultType,
    exception: false,
    rawCandidates: [],
    acceptedCandidates: [],
    productive: false,
    pauseRequested: Math.max(0, Number(extra.pauseRequested ?? 0)),
    pauseAcquired: Math.max(0, Number(extra.pauseAcquired ?? 0)),
    callframesSeen: Math.max(0, Number(extra.callframesSeen ?? 0)),
    matchingFramesSeen: Math.max(0, Number(extra.matchingFramesSeen ?? 0)),
    matchingScopesSeen: Math.max(0, Number(extra.matchingScopesSeen ?? 0)),
    inventoryRowsWritten: Math.max(0, Number(extra.inventoryRowsWritten ?? 0)),
    framesScanned: Math.max(0, Number(extra.framesScanned ?? 0)),
    scopesScanned: Math.max(0, Number(extra.scopesScanned ?? 0)),
    durationMs: Math.max(0, Number(extra.durationMs ?? 0)),
    error: extra.error ? String(extra.error) : undefined
  };
}

export async function scanQuickPlayClosureCandidates(
  cdp,
  transientState,
  log = console.log,
  quickPlayDiagnosticState = null,
  attempt = 1
) {
  const expectedGeneration = Math.max(
    0,
    Number(quickPlayDiagnosticState?.captureGeneration ?? 0)
  );
  let debuggerEnabled = false;
  let paused = false;
  try {
    if (
      !cdp ||
      typeof cdp.send !== "function" ||
      typeof cdp.waitForEvent !== "function"
    ) {
      return createQuickPlayClosureSkipResult("target_not_available");
    }
    if (!quickPlayDiagnosticState?.active) {
      return createQuickPlayClosureSkipResult("capture_inactive");
    }
    if (
      Math.max(0, Number(quickPlayDiagnosticState.captureGeneration ?? 0)) !==
      expectedGeneration
    ) {
      return createQuickPlayClosureSkipResult("stale_generation");
    }
    try {
      await cdp.send("Debugger.enable");
      debuggerEnabled = true;
    } catch (error) {
      return createQuickPlayClosureSkipResult("debugger_not_enabled", {
        error: error?.message ?? error ?? "debugger_not_enabled"
      });
    }
    log?.(`[quick-play] closure pause requested attempt=${attempt}`);
    try {
      await cdp.send("Debugger.pause");
    } catch (error) {
      return createQuickPlayClosureSkipResult("pause_request_failed", {
        pauseRequested: 1,
        error: error?.message ?? error ?? "pause_request_failed"
      });
    }
    let pausedEvent = null;
    try {
      pausedEvent = await cdp.waitForEvent(
        "Debugger.paused",
        () => true,
        DEFAULT_QUICK_PLAY_CLOSURE_SCAN_PAUSE_TIMEOUT_MS
      );
    } catch (error) {
      return createQuickPlayClosureSkipResult("pause_timeout", {
        pauseRequested: 1,
        error: error?.message ?? error ?? "pause_timeout"
      });
    }
    if (!pausedEvent) {
      return createQuickPlayClosureSkipResult("paused_event_not_received", {
        pauseRequested: 1
      });
    }
    paused = true;
    log?.(
      `[quick-play] closure pause acquired attempt=${attempt} callframes=${Math.max(
        0,
        Number(pausedEvent?.callFrames?.length ?? 0)
      )}`
    );
    if (!quickPlayDiagnosticState?.active) {
      return createQuickPlayClosureSkipResult("capture_inactive", {
        pauseRequested: 1,
        pauseAcquired: 1
      });
    }
    if (
      Math.max(0, Number(quickPlayDiagnosticState.captureGeneration ?? 0)) !==
      expectedGeneration
    ) {
      return createQuickPlayClosureSkipResult("stale_generation", {
        pauseRequested: 1,
        pauseAcquired: 1
      });
    }
    const scanned = await collectQuickPlayClosureDiagnosticFromPausedScopes(
      cdp,
      pausedEvent,
      {
        quickPlayDiagnosticState,
        attempt,
        log
      }
    );
    let retainResult = null;
    if (Array.isArray(scanned?.acceptedCandidates) && scanned.acceptedCandidates.length === 1) {
      retainResult = await retainQuickPlayPassiveCandidateHandle(
        cdp,
        quickPlayDiagnosticState,
        scanned.acceptedCandidates[0],
        {
          generation: quickPlayDiagnosticState.captureGeneration,
          targetId: quickPlayDiagnosticState.currentTargetUrl,
          capturedAt: Date.now(),
          log
        }
      );
    }
    return {
      status: "ready",
      exception: false,
      pauseRequested: 1,
      pauseAcquired: 1,
      retainResult,
      ...scanned
    };
  } catch (error) {
    return {
      status: "error",
      resultType: "exception",
      exception: true,
      error: String(error?.message ?? error ?? "unknown"),
      rawCandidates: [],
      acceptedCandidates: []
    };
  } finally {
    if (paused) {
      await cdp.send("Debugger.resume").catch(() => undefined);
    }
    await cdp.send("Runtime.releaseObjectGroup", {
      objectGroup: "fusion-quick-play-diagnostic"
    }).catch(() => undefined);
    if (debuggerEnabled) {
      await cdp.send("Debugger.disable").catch(() => undefined);
    }
  }
}

function recordQuickPlayClosureScanDiagnostics(quickPlayDiagnosticState, scan) {
  const closureDiagnostics = quickPlayDiagnosticState?.diagnostics?.closure_scan;
  const closureScanState = quickPlayDiagnosticState?.closureScanState;
  if (!closureDiagnostics || !scan || typeof scan !== "object") {
    return false;
  }
  incrementQuickPlayDiagnosticCounter(
    closureDiagnostics,
    "pause_requested",
    Math.max(0, Number(scan.pauseRequested ?? 0))
  );
  incrementQuickPlayDiagnosticCounter(
    closureDiagnostics,
    "pause_acquired",
    Math.max(0, Number(scan.pauseAcquired ?? 0))
  );
  incrementQuickPlayDiagnosticCounter(
    closureDiagnostics,
    "callframes_seen",
    Math.max(0, Number(scan.callframesSeen ?? 0))
  );
  incrementQuickPlayDiagnosticCounter(
    closureDiagnostics,
    "tick_frames_seen",
    Math.max(0, Number(scan.tickFramesSeen ?? 0))
  );
  incrementQuickPlayDiagnosticCounter(
    closureDiagnostics,
    "selected_tick_frames",
    Math.max(0, Number(scan.selectedTickFrames ?? 0))
  );
  incrementQuickPlayDiagnosticCounter(
    closureDiagnostics,
    "matching_frames_seen",
    Math.max(0, Number(scan.matchingFramesSeen ?? 0))
  );
  incrementQuickPlayDiagnosticCounter(
    closureDiagnostics,
    "matching_scopes_seen",
    Math.max(0, Number(scan.matchingScopesSeen ?? 0))
  );
  incrementQuickPlayDiagnosticCounter(
    closureDiagnostics,
    "candidate_closure_scopes_seen",
    Math.max(0, Number(scan.candidateClosureScopesSeen ?? 0))
  );
  incrementQuickPlayDiagnosticCounter(
    closureDiagnostics,
    "selected_primary_scopes",
    Math.max(0, Number(scan.selectedPrimaryScopes ?? 0))
  );
  incrementQuickPlayDiagnosticCounter(
    closureDiagnostics,
    "selected_secondary_scopes",
    Math.max(0, Number(scan.selectedSecondaryScopes ?? 0))
  );
  incrementQuickPlayDiagnosticCounter(
    closureDiagnostics,
    "targeted_inspections",
    Math.max(0, Number(scan.targetedInspections ?? 0))
  );
  incrementQuickPlayDiagnosticCounter(
    closureDiagnostics,
    "generic_targets_seen",
    Math.max(0, Number(scan.genericTargetsSeen ?? 0))
  );
  incrementQuickPlayDiagnosticCounter(
    closureDiagnostics,
    "target_handoff_mismatches",
    Math.max(0, Number(scan.targetHandoffMismatches ?? 0))
  );
  incrementQuickPlayDiagnosticCounter(
    closureDiagnostics,
    "inventory_rows_written",
    Math.max(0, Number(scan.inventoryRowsWritten ?? 0))
  );
  if (Object.hasOwn(scan, "targetedBindingInspection")) {
    closureDiagnostics.targeted_binding_inspection =
      scan.targetedBindingInspection ?? null;
    if (scan.targetedBindingInspection) {
      closureDiagnostics.targeted_binding_inspections.push(
        scan.targetedBindingInspection
      );
      if (closureDiagnostics.targeted_binding_inspections.length > 12) {
        closureDiagnostics.targeted_binding_inspections.splice(
          0,
          closureDiagnostics.targeted_binding_inspections.length - 12
        );
      }
    }
  }
  if (scan.productive === true) {
    incrementQuickPlayDiagnosticCounter(closureDiagnostics, "productive_attempts", 1);
  } else {
    incrementQuickPlayDiagnosticCounter(closureDiagnostics, "nonproductive_attempts", 1);
    incrementQuickPlayDiagnosticCounter(closureDiagnostics, "skipped", 1);
    incrementQuickPlayDiagnosticBucket(
      closureDiagnostics.skip_reasons,
      scan.resultType ?? "unknown"
    );
  }
  if (isQuickPlayTimingMissResult(scan.resultType)) {
    incrementQuickPlayDiagnosticCounter(closureDiagnostics, "timing_miss_count", 1);
    incrementQuickPlayDiagnosticBucket(
      closureDiagnostics.timing_miss_reasons,
      scan.resultType ?? "unknown"
    );
    if (closureScanState) {
      closureScanState.timingMissCount += 1;
      closureDiagnostics.last_no_tick_callframes = Math.max(
        0,
        Number(scan?.callframesSeen ?? 0)
      );
      closureScanState.lastNoTickCallframes = closureDiagnostics.last_no_tick_callframes;
      if (scan?.noTickAttempt) {
        closureScanState.noTickAttempts.push(scan.noTickAttempt);
        if (closureScanState.noTickAttempts.length > 12) {
          closureScanState.noTickAttempts.splice(
            0,
            closureScanState.noTickAttempts.length - 12
          );
        }
        closureDiagnostics.no_tick_attempts = closureScanState.noTickAttempts.slice(-12);
      }
    }
  }
  return true;
}

function shouldRetryQuickPlayClosureScan(quickPlayDiagnosticState, scan) {
  const closureScanState = quickPlayDiagnosticState?.closureScanState;
  if (!closureScanState || !quickPlayDiagnosticState?.active) {
    return false;
  }
  if (scan?.resultType === "capture_inactive" || scan?.resultType === "stale_generation") {
    return false;
  }
  if (quickPlayDiagnosticState?.boundLocalClosureCandidate?.rootObjectId) {
    return false;
  }
  if (scan?.productive === true) {
    return (
      Math.max(0, Number(scan?.acceptedCandidates?.length ?? 0)) === 0 &&
      closureScanState.productiveAttempts <
        clampQuickPlayClosureScanAttemptCount(closureScanState.maxAttempts)
    );
  }
  if (!isQuickPlayTimingMissResult(scan?.resultType)) {
    return (
      closureScanState.nonproductiveAttempts <
      Math.max(1, Number(closureScanState.maxNonproductiveAttempts ?? 1))
    );
  }
  return closureScanState.nonproductiveAttempts <
    Math.max(1, Number(closureScanState.maxNonproductiveAttempts ?? 1));
}

function resolveQuickPlayTimingMissExhaustedReason(quickPlayDiagnosticState) {
  const reasons =
    quickPlayDiagnosticState?.diagnostics?.closure_scan?.timing_miss_reasons ?? {};
  if (Math.max(0, Number(reasons.pause_timeout ?? 0)) > 0) {
    return "pause_timeout_exhausted";
  }
  if (Math.max(0, Number(reasons.matching_frame_missing ?? 0)) > 0) {
    return "tick_frame_not_observed";
  }
  return "closure_retry_exhausted";
}

export async function maybeRunQuickPlayDiagnosticCapture({
  cdp,
  quickPlayDiagnosticState,
  browserControlState,
  transientState,
  targetUrl = "",
  now = Date.now(),
  surveySessionFn = surveyQuickPlaySessionCandidates,
  scanClosureFn = scanQuickPlayClosureCandidates,
  log = console.log
} = {}) {
  if (!quickPlayDiagnosticState?.active) {
    return { ran: false, reason: "inactive" };
  }
  quickPlayDiagnosticState.currentTargetUrl = String(targetUrl ?? "");
  if (
    !isZenithModeSelected(browserControlState) ||
    (browserControlState?.botEnabled &&
      !quickPlayPassiveAllowsBotEnabled(quickPlayDiagnosticState))
  ) {
    stopQuickPlayDiagnosticCapture(quickPlayDiagnosticState, {
      now,
      reason:
        !isZenithModeSelected(browserControlState) ? "mode_changed" : "bot_enabled",
      log
    });
    await releaseQuickPlayPassiveState(cdp, quickPlayDiagnosticState, {
      reason:
        !isZenithModeSelected(browserControlState) ? "mode_changed" : "bot_enabled",
      writeSnapshotStatus: false,
      preserveDiagnostics: true,
      log
    });
    return { ran: true, stopped: true, reason: quickPlayDiagnosticState.stopReason };
  }
  if (now >= Number(quickPlayDiagnosticState.stopAt ?? 0)) {
    stopQuickPlayDiagnosticCapture(quickPlayDiagnosticState, {
      now,
      reason:
        quickPlayDiagnosticState.stopReason ||
        "duration_elapsed",
      log
    });
    await releaseQuickPlayPassiveState(cdp, quickPlayDiagnosticState, {
      reason: quickPlayDiagnosticState.stopReason || "duration_elapsed",
      writeSnapshotStatus: false,
      preserveDiagnostics: true,
      log
    });
    return { ran: true, stopped: true, reason: quickPlayDiagnosticState.stopReason };
  }
  if (
    Number(quickPlayDiagnosticState.nextSessionSurveyAt ?? 0) > 0 &&
    now >= Number(quickPlayDiagnosticState.nextSessionSurveyAt ?? 0)
  ) {
    quickPlayDiagnosticState.nextSessionSurveyAt = 0;
    quickPlayDiagnosticState.diagnostics.session_scan.attempts += 1;
    try {
      const survey = await surveySessionFn(cdp, transientState, log);
      mergeQuickPlaySessionSurvey(quickPlayDiagnosticState, survey, now);
      quickPlayDiagnosticState.diagnostics.session_scan.completed += 1;
    } catch (error) {
      appendQuickPlayDiagnosticError(
        quickPlayDiagnosticState.diagnostics.session_scan,
        error
      );
    }
    const wsSelfEvidence = resolveQuickPlayWsSelfEvidence(quickPlayDiagnosticState);
    const identityUpdate = updateQuickPlayPendingIdentity(
      quickPlayDiagnosticState,
      wsSelfEvidence,
      now
    );
    if (identityUpdate.changed) {
      const reconcile = await reconcileQuickPlayPassiveBinding(quickPlayDiagnosticState, {
        reason: identityUpdate.reason,
        browserControlState,
        now,
        log
      });
      if (reconcile.shouldStartPolling) {
        await pollQuickPlayPassiveSnapshotNow(cdp, quickPlayDiagnosticState, {
          now,
          log
        });
      }
    }
    scheduleQuickPlaySessionSurvey(quickPlayDiagnosticState, {
      now,
      delayMs: Math.max(
        100,
        Number(
          quickPlayDiagnosticState.sessionSurveyIntervalMs ??
            DEFAULT_QUICK_PLAY_SESSION_SURVEY_INTERVAL_MS
        )
      ),
      reason: "interval"
    });
  }
  if (
    Number(quickPlayDiagnosticState.nextClosureSurveyAt ?? 0) > 0 &&
    now >= Number(quickPlayDiagnosticState.nextClosureSurveyAt ?? 0)
  ) {
    const closureScanState = quickPlayDiagnosticState.closureScanState;
    quickPlayDiagnosticState.nextClosureSurveyAt = 0;
    if (
      closureScanState.productiveAttempts <
        clampQuickPlayClosureScanAttemptCount(closureScanState.maxAttempts) ||
      closureScanState.nonproductiveAttempts <
        Math.max(1, Number(closureScanState.maxNonproductiveAttempts ?? 1))
    ) {
      closureScanState.running = true;
      closureScanState.attempts += 1;
      quickPlayDiagnosticState.diagnostics.closure_scan.attempts += 1;
      const attempt = closureScanState.attempts;
      const reason = String(
        quickPlayDiagnosticState.closureScanState.pendingReason ?? "retry"
      );
      log?.(
        `[quick-play] closure scan started attempt=${attempt} target_generation=${Math.max(
          0,
          Number(quickPlayDiagnosticState.captureGeneration ?? 0)
        )}`
      );
      try {
        const scan = await scanClosureFn(
          cdp,
          transientState,
          log,
          quickPlayDiagnosticState,
          attempt
        );
        quickPlayDiagnosticState.diagnostics.closure_scan.completed += 1;
        recordQuickPlayClosureScanDiagnostics(quickPlayDiagnosticState, scan);
        if (scan?.productive === true) {
          closureScanState.productiveAttempts += 1;
        } else {
          closureScanState.nonproductiveAttempts += 1;
          log?.(
            `[quick-play] closure scan skipped attempt=${attempt} reason=${String(
              scan?.resultType ?? "unknown"
            )}`
          );
        }
        if (scan?.callframesSeen > 0 || scan?.matchingFramesSeen > 0 || scan?.matchingScopesSeen > 0) {
          log?.(
            `[quick-play] closure frame inventory attempt=${attempt} callframes=${Math.max(
              0,
              Number(scan?.callframesSeen ?? 0)
            )} matching_frames=${Math.max(
              0,
              Number(scan?.matchingFramesSeen ?? 0)
            )} matching_scopes=${Math.max(
              0,
              Number(scan?.matchingScopesSeen ?? 0)
            )}`
          );
        }
        if (Math.max(0, Number(scan?.inventoryRowsWritten ?? 0)) > 0) {
          log?.(
            `[quick-play] closure inventory written attempt=${attempt} frames=${Math.max(
              0,
              Number(scan?.inventoryRowsWritten ?? 0)
            )} path=${String(quickPlayDiagnosticState.callframePath ?? "").replace(/\\/g, "/")}`
          );
        }
        log?.(
          `[quick-play] closure scan evaluated result_type=${String(
            scan?.resultType ?? scan?.status ?? "unknown"
          )} exception=${scan?.exception === true ? "true" : "false"} raw_candidates=${Math.max(
            0,
            Number(scan?.rawCandidates?.length ?? 0)
          )}`
        );
        if (scan?.error) {
          appendQuickPlayDiagnosticError(
            quickPlayDiagnosticState.diagnostics.closure_scan,
            scan?.error ?? scan?.resultType ?? "closure_scan_error"
          );
        }
        if (scan?.status === "error") {
          log?.(
            `[quick-play] closure scan failed error=${String(
              scan?.error ?? scan?.resultType ?? "unknown"
            )} exception_details=${String(
              scan?.exception === true ? "runtime_exception" : "none"
            )}`
          );
        } else {
          recordQuickPlayClosureCandidates(quickPlayDiagnosticState, {
            ...scan,
            attempt
          }, now);
          const acceptedCandidates = Array.isArray(scan?.acceptedCandidates)
            ? scan.acceptedCandidates
            : [];
          if (acceptedCandidates.length === 1) {
            const retainResult = scan?.retainResult && typeof scan.retainResult === "object"
              ? scan.retainResult
              : await retainQuickPlayPassiveCandidateHandle(
                  cdp,
                  quickPlayDiagnosticState,
                  acceptedCandidates[0],
                  {
                    generation: quickPlayDiagnosticState.captureGeneration,
                    targetId: quickPlayDiagnosticState.currentTargetUrl,
                    capturedAt: now,
                    log
                  }
                );
            if (retainResult?.ok === true) {
              const reconcile = await reconcileQuickPlayPassiveBinding(quickPlayDiagnosticState, {
                reason: "accepted_candidate",
                browserControlState,
                now,
                log
              });
              if (reconcile.shouldStartPolling) {
                await pollQuickPlayPassiveSnapshotNow(cdp, quickPlayDiagnosticState, {
                  now,
                  log
                });
              }
            }
          } else if (acceptedCandidates.length > 1) {
            await releaseQuickPlayPassiveState(cdp, quickPlayDiagnosticState, {
              reason: "ambiguous_accepted_candidates",
              writeSnapshotStatus: true,
              preserveDiagnostics: true,
              log
            });
          }
          const rejectedCandidates = Math.max(
            0,
            Number(scan?.rawCandidates?.length ?? 0)
          ) - Math.max(0, Number(scan?.acceptedCandidates?.length ?? 0));
          log?.(
            `[quick-play] closure scan completed raw_candidates=${Math.max(
              0,
              Number(scan?.rawCandidates?.length ?? 0)
            )} accepted_candidates=${Math.max(
              0,
              Number(scan?.acceptedCandidates?.length ?? 0)
            )} rejected_candidates=${Math.max(0, rejectedCandidates)}`
          );
          closureScanState.running = false;
          if (shouldRetryQuickPlayClosureScan(quickPlayDiagnosticState, scan)) {
            const delayMs = isQuickPlayTimingMissResult(scan?.resultType)
              ? nextQuickPlayTimingMissDelayMs(quickPlayDiagnosticState)
              : Math.max(
                  500,
                  Number(
                    quickPlayDiagnosticState.closureSurveyIntervalMs ??
                      DEFAULT_QUICK_PLAY_CLOSURE_SURVEY_INTERVAL_MS
                  )
                );
            if (isQuickPlayTimingMissResult(scan?.resultType)) {
              log?.(
                `[quick-play] closure timing miss attempt=${attempt} reason=${String(
                  scan?.resultType ?? "unknown"
                )} callframes=${Math.max(
                  0,
                  Number(scan?.callframesSeen ?? 0)
                )} top_functions=${Array.isArray(scan?.noTickAttempt?.top_functions)
                  ? scan.noTickAttempt.top_functions.join(",")
                  : ""} retry_in_ms=${delayMs}`
              );
            }
            const scheduled = scheduleQuickPlayClosureSurvey(quickPlayDiagnosticState, {
              now,
              delayMs,
              reason: isQuickPlayTimingMissResult(scan?.resultType)
                ? "timing_miss"
                : "retry",
              generation: quickPlayDiagnosticState.captureGeneration,
              log
            });
            if (scheduled && isQuickPlayTimingMissResult(scan?.resultType)) {
              log?.(
                `[quick-play] closure retry scheduled attempt=${attempt} trigger=timing_miss delay_ms=${delayMs}`
              );
            }
          } else if (
            isQuickPlayTimingMissResult(scan?.resultType) &&
            !quickPlayDiagnosticState?.boundLocalClosureCandidate?.rootObjectId
          ) {
            closureScanState.retryExhausted = true;
            quickPlayDiagnosticState.diagnostics.closure_scan.retry_exhausted = true;
            if (!quickPlayDiagnosticState.stopReason) {
              quickPlayDiagnosticState.stopReason =
                resolveQuickPlayTimingMissExhaustedReason(quickPlayDiagnosticState);
            }
          }
        }
      } catch (error) {
        quickPlayDiagnosticState.diagnostics.closure_scan.completed += 1;
        appendQuickPlayDiagnosticError(
          quickPlayDiagnosticState.diagnostics.closure_scan,
          error
        );
        log?.(
          `[quick-play] closure scan failed error=${String(
            error?.message ?? error ?? "unknown"
          )} exception_details=runtime_exception`
        );
      } finally {
        closureScanState.running = false;
      }
    }
  }
  const boundCandidate = quickPlayDiagnosticState.boundLocalClosureCandidate;
  const wsSelfEvidence = resolveQuickPlayWsSelfEvidence(quickPlayDiagnosticState);
  const identityUpdate = updateQuickPlayPendingIdentity(
    quickPlayDiagnosticState,
    wsSelfEvidence,
    now
  );
  if (identityUpdate.changed) {
    const reconcile = await reconcileQuickPlayPassiveBinding(quickPlayDiagnosticState, {
      reason: identityUpdate.reason,
      browserControlState,
      now,
      log
    });
    if (reconcile.shouldStartPolling) {
      await pollQuickPlayPassiveSnapshotNow(cdp, quickPlayDiagnosticState, {
        now,
        log
      });
    }
  }
  if (
    boundCandidate?.rootObjectId &&
    boundCandidate?.identityBound === true &&
    now >= Number(quickPlayDiagnosticState.nextPassiveSnapshotAt ?? 0)
  ) {
    await pollQuickPlayPassiveSnapshotNow(cdp, quickPlayDiagnosticState, {
      now,
      log
    });
  }
  if (quickPlayDiagnosticState.roundCompleted) {
    stopQuickPlayDiagnosticCapture(quickPlayDiagnosticState, {
      now,
      reason: quickPlayDiagnosticState.stopReason || "round_completed",
      log
    });
    await releaseQuickPlayPassiveState(cdp, quickPlayDiagnosticState, {
      reason: quickPlayDiagnosticState.stopReason || "round_completed",
      writeSnapshotStatus: false,
      preserveDiagnostics: true,
      log
    });
    return { ran: true, stopped: true, reason: quickPlayDiagnosticState.stopReason };
  }
  return { ran: true, stopped: false };
}

export function resetClosureCaptureLocatorHint(closureCaptureState) {
  if (!closureCaptureState) {
    return false;
  }
  closureCaptureState.lastSuccessfulLocator = "";
  closureCaptureState.lastSuccessfulPausedLocation = null;
  resetInitialGameplayCaptureProbeState(closureCaptureState);
  return true;
}

function shouldAttemptNextGameFastLocator(
  nextGameReacquireState,
  now = Date.now(),
  intervalMs = DEFAULT_NEXT_GAME_FAST_LOCATOR_INTERVAL_MS
) {
  if (!nextGameReacquireState?.active) {
    return false;
  }
  return now - Number(nextGameReacquireState.lastFastAttemptAt ?? 0) >= intervalMs;
}

function shouldLogNextGameFastLocatorMiss(
  nextGameReacquireState,
  now = Date.now(),
  intervalMs = DEFAULT_NEXT_GAME_FAST_LOCATOR_MISS_LOG_INTERVAL_MS
) {
  if (!nextGameReacquireState) {
    return false;
  }
  return now - Number(nextGameReacquireState.lastFastMissLoggedAt ?? 0) >= intervalMs;
}

function shouldLogReacquireStatus(
  previousStatus,
  nextStatus,
  lastLoggedAt,
  now = Date.now(),
  intervalMs = DEFAULT_NEXT_GAME_FAST_LOCATOR_MISS_LOG_INTERVAL_MS
) {
  return previousStatus !== nextStatus || now - Number(lastLoggedAt ?? 0) >= intervalMs;
}

export function nextGameInteractionTrackerExpression() {
  return `(() => {
    try {
      if (window.__fusionNextGameInteractionTrackerInstalled) {
        return { ok: true, installed: true, deduped: true };
      }
      const state = window.__fusionNextGameInteraction = window.__fusionNextGameInteraction || {
        generation: 0,
        type: null,
        key: null,
        interactionKind: null,
        timestamp: 0,
        targetTag: null,
        targetId: null,
        targetClass: null
      };
      const capture = (event) => {
        try {
          const type = String(event?.type || "");
          if (!type) return;
          if (type === "keydown") {
            if (event?.repeat === true) {
              return;
            }
            const key = String(event?.key || "");
            if (!["Enter", " ", "Spacebar", "Space", "r", "R"].includes(key)) {
              return;
            }
          }
          const now = Date.now();
          if (
            now - Number(state.timestamp || 0) <= ${DEFAULT_NEXT_GAME_INTERACTION_BURST_DEDUPE_MS} &&
            (
              (type === "click" && state.type === "pointerup") ||
              (type === "click" && state.type === "pointerdown") ||
              (type === "pointerup" && state.type === "click") ||
              (type === "pointerup" && state.type === "pointerdown") ||
              (type === "pointerdown" && state.type === "pointerup") ||
              (type === "pointerdown" && state.type === "click") ||
              type === state.type
            )
          ) {
            state.timestamp = now;
            return;
          }
          const target = event?.target && typeof event.target === "object" ? event.target : null;
          const targetTag = String(target?.tagName || "");
          const targetId = String(target?.id || "");
          let interactionKind = "other";
          if ((type === "pointerdown" || type === "click") && targetTag === "DIV" && targetId === "start_results") {
            interactionKind = "again_button";
          } else if (type === "keydown" && (String(event?.key || "") === "r" || String(event?.key || "") === "R")) {
            interactionKind = "restart_key";
          }
          state.generation = Math.max(0, Number(state.generation || 0)) + 1;
          state.type = type;
          state.key = type === "keydown" ? String(event?.key || "") : null;
          state.interactionKind = interactionKind;
          state.timestamp = now;
          state.targetTag = targetTag;
          state.targetId = targetId;
          state.targetClass =
            typeof target?.className === "string" ? target.className : "";
        } catch {}
      };
      document.addEventListener("pointerdown", capture, true);
      document.addEventListener("click", capture, true);
      document.addEventListener("pointerup", capture, true);
      document.addEventListener("keydown", capture, true);
      window.__fusionNextGameInteractionTrackerInstalled = true;
      return { ok: true, installed: true, deduped: false };
    } catch (error) {
      return { ok: false, reason: String(error?.message || error || "install_failed") };
    }
  })()`;
}

export function createInteractionTrackerInstallState() {
  return {
    futureDocumentsRegistered: false,
    currentDocumentInstalls: 0
  };
}

export async function registerNextGameInteractionTrackerForFutureDocuments(
  cdp
) {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: nextGameInteractionTrackerExpression()
  }).catch(() => undefined);
  return true;
}

export async function installNextGameInteractionTracker(
  cdp,
  {
    transientState = null,
    log = console.log
  } = {}
) {
  const raw = await safeRuntimeEvaluate(cdp, {
    expression: nextGameInteractionTrackerExpression(),
    returnByValue: true
  }, {
    result: {
      value: { ok: false, reason: "install_failed" }
    }
  }, {
    transientState,
    log
  });
  return raw?.result?.value ?? { ok: false, reason: "install_failed" };
}

export async function ensureNextGameInteractionTrackerInstalled(
  cdp,
  interactionTrackerInstallState,
  {
    transientState = null,
    log = console.log
  } = {}
) {
  if (!interactionTrackerInstallState?.futureDocumentsRegistered) {
    await registerNextGameInteractionTrackerForFutureDocuments(cdp);
    if (interactionTrackerInstallState) {
      interactionTrackerInstallState.futureDocumentsRegistered = true;
    }
  }
  if (interactionTrackerInstallState) {
    interactionTrackerInstallState.currentDocumentInstalls = Math.max(
      0,
      Number(interactionTrackerInstallState.currentDocumentInstalls ?? 0)
    ) + 1;
  }
  return installNextGameInteractionTracker(cdp, {
    transientState,
    log
  });
}

function nextGameInteractionStateExpression() {
  return `(() => {
    const state = window.__fusionNextGameInteraction || null;
    return {
      generation: Math.max(0, Number(state?.generation || 0)),
      type: state?.type || null,
      key: state?.key || null,
      interactionKind: state?.interactionKind || null,
      timestamp: Math.max(0, Number(state?.timestamp || 0)),
      targetTag: state?.targetTag || null,
      targetId: state?.targetId || null,
      targetClass: state?.targetClass || null
    };
  })()`;
}

export async function readNextGameInteractionState(
  cdp,
  {
    transientState = null,
    log = console.log
  } = {}
) {
  const raw = await safeRuntimeEvaluate(cdp, {
    expression: nextGameInteractionStateExpression(),
    returnByValue: true
  }, {
    result: {
      value: {
        generation: 0,
        type: null,
        key: null,
        interactionKind: null,
        timestamp: 0,
        targetTag: null,
        targetId: null,
        targetClass: null
      }
    }
  }, {
    transientState,
    log
  });
  return raw?.result?.value ?? {
    generation: 0,
    type: null,
    key: null,
    interactionKind: null,
    timestamp: 0,
    targetTag: null,
    targetId: null,
    targetClass: null
  };
}

export async function primeNextGameInteractionBaseline(
  cdp,
  nextGameReacquireState,
  {
    transientState = null,
    log = console.log,
    readNextGameInteractionStateFn = readNextGameInteractionState
  } = {}
) {
  const interaction = await readNextGameInteractionStateFn(cdp, {
    transientState,
    log
  }).catch(() => ({
    generation: 0
  }));
  const baselineGeneration = setNextGameInteractionBaseline(
    nextGameReacquireState,
    interaction
  );
  if (typeof log === "function") {
    log(`[browser] next-game interaction baseline generation=${baselineGeneration}`);
  }
  return baselineGeneration;
}

export async function primePostGameInteractionWatchBaseline(
  cdp,
  postGameInteractionWatchState,
  {
    now = Date.now(),
    transientState = null,
    log = console.log,
    readNextGameInteractionStateFn = readNextGameInteractionState,
    nextGameReacquireState = null
  } = {}
) {
  const interaction = await readNextGameInteractionStateFn(cdp, {
    transientState,
    log
  }).catch(() => ({
    generation: 0
  }));
  const baselineGeneration = Math.max(
    0,
    Number(interaction?.generation ?? 0)
  );
  startPostGameInteractionWatch(postGameInteractionWatchState, {
    now,
    baselineGeneration,
    log
  });
  setNextGameInteractionPhase(
    nextGameReacquireState,
    NEXT_GAME_INTERACTION_PHASE_POST_GAME_WATCH
  );
  return baselineGeneration;
}

function rememberPendingNextGameInteraction(
  nextGameReacquireState,
  interaction = null
) {
  if (!nextGameReacquireState) {
    return false;
  }
  const generation = Math.max(0, Number(interaction?.generation ?? 0));
  if (
    generation <= 0 ||
    generation <= Math.max(0, Number(nextGameReacquireState.pendingInteractionGeneration ?? 0))
  ) {
    return false;
  }
  nextGameReacquireState.pendingInteractionGeneration = generation;
  nextGameReacquireState.pendingInteractionTimestamp = Math.max(
    0,
    Number(interaction?.timestamp ?? 0)
  );
  nextGameReacquireState.pendingInteractionSource = "rearm";
  nextGameReacquireState.pendingArmReason = "";
  nextGameReacquireState.pendingInteractionType = String(interaction?.type ?? "");
  nextGameReacquireState.pendingInteractionKey = String(interaction?.key ?? "");
  nextGameReacquireState.pendingInteractionKind = deriveInteractionKind(interaction);
  nextGameReacquireState.pendingInteractionTargetTag = String(
    interaction?.targetTag ?? ""
  );
  nextGameReacquireState.pendingInteractionTargetId = String(
    interaction?.targetId ?? ""
  );
  nextGameReacquireState.pendingInteractionTargetClass = String(
    interaction?.targetClass ?? ""
  );
  return true;
}

function clearPendingNextGameInteraction(nextGameReacquireState) {
  if (!nextGameReacquireState) {
    return false;
  }
  nextGameReacquireState.pendingInteractionGeneration = 0;
  nextGameReacquireState.pendingInteractionTimestamp = 0;
  nextGameReacquireState.pendingInteractionSource = "";
  nextGameReacquireState.pendingArmReason = "";
  nextGameReacquireState.pendingInteractionType = "";
  nextGameReacquireState.pendingInteractionKey = "";
  nextGameReacquireState.pendingInteractionKind = "";
  nextGameReacquireState.pendingInteractionTargetTag = "";
  nextGameReacquireState.pendingInteractionTargetId = "";
  nextGameReacquireState.pendingInteractionTargetClass = "";
  return true;
}

function rememberPendingPostGameInteraction(
  postGameInteractionWatchState,
  interaction = null
) {
  if (!postGameInteractionWatchState?.active) {
    return false;
  }
  const generation = Math.max(0, Number(interaction?.generation ?? 0));
  const timestamp = Math.max(0, Number(interaction?.timestamp ?? 0));
  if (
    generation <= Math.max(0, Number(postGameInteractionWatchState.interactionBaselineGeneration ?? 0)) ||
    generation <= Math.max(0, Number(postGameInteractionWatchState.pendingGeneration ?? 0)) ||
    timestamp <= Math.max(0, Number(postGameInteractionWatchState.firstNotPlayingAt ?? 0))
  ) {
    return false;
  }
  postGameInteractionWatchState.pendingGeneration = generation;
  postGameInteractionWatchState.pendingTimestamp = timestamp;
  postGameInteractionWatchState.pendingType = String(interaction?.type ?? "");
  postGameInteractionWatchState.pendingKey = String(interaction?.key ?? "");
  postGameInteractionWatchState.pendingTargetTag = String(interaction?.targetTag ?? "");
  postGameInteractionWatchState.pendingTargetId = String(interaction?.targetId ?? "");
  postGameInteractionWatchState.pendingTargetClass = String(interaction?.targetClass ?? "");
  return true;
}

function isTrustedNextGameInteraction(interaction = null) {
  const kind = deriveInteractionKind(interaction);
  return kind === "again_button" || kind === "restart_key";
}

function deriveInteractionKind(interaction = null) {
  const type = String(interaction?.type ?? "");
  const key = String(interaction?.key ?? "");
  const targetTag = String(interaction?.targetTag ?? "").toUpperCase();
  const targetId = String(interaction?.targetId ?? "");
  if ((type === "pointerdown" || type === "click") && targetTag === "DIV" && targetId === "start_results") {
    return "again_button";
  }
  if (type === "keydown" && (key === "r" || key === "R")) {
    return "restart_key";
  }
  return "other";
}

function recordProvisionalInteraction(
  nextGameReacquireState,
  interaction = null
) {
  if (!nextGameReacquireState) {
    return false;
  }
  const generation = Math.max(0, Number(interaction?.generation ?? 0));
  if (generation <= 0) {
    return false;
  }
  nextGameReacquireState.provisionalInteractionGeneration = generation;
  nextGameReacquireState.provisionalInteractionTimestamp = Math.max(
    0,
    Number(interaction?.timestamp ?? 0)
  );
  nextGameReacquireState.provisionalInteractionKey = String(interaction?.key ?? "");
  nextGameReacquireState.provisionalInteractionTrusted = true;
  nextGameReacquireState.provisionalInteractionKind = deriveInteractionKind(interaction);
  nextGameReacquireState.provisionalTransitionReady = false;
  nextGameReacquireState.provisionalTransitionReadyLoggedAt = 0;
  return true;
}

function isAgainButtonProvisionalInteraction(nextGameReacquireState) {
  return (
    nextGameReacquireState?.provisionalInteractionTrusted === true &&
    String(nextGameReacquireState?.provisionalInteractionKind ?? "") === "again_button"
  );
}

function isTransitionReadyForAgainProvisional(cheapSignal = null) {
  const sources = Array.isArray(cheapSignal?.sources) ? cheapSignal.sources : [];
  const byName = new Map(
    sources.map((entry) => [String(entry?.source ?? ""), Boolean(entry?.value)])
  );
  const resultHidden = byName.get("result_dom") === false;
  const countdownVisible = byName.get("countdown_dom") === true;
  const gameplayVisible = byName.get("gameplay_dom") === true;
  const routeGame = byName.get("route_game") === true;
  if (countdownVisible || gameplayVisible) {
    return true;
  }
  return resultHidden && routeGame;
}

export function carryPendingPostGameInteractionIntoReacquire(
  postGameInteractionWatchState,
  nextGameReacquireState,
  {
    log = console.log
  } = {}
) {
  if (
    !postGameInteractionWatchState ||
    !nextGameReacquireState ||
    Math.max(0, Number(postGameInteractionWatchState.pendingGeneration ?? 0)) <= 0
  ) {
    return false;
  }
  nextGameReacquireState.lastInteractionGenerationSeen = Math.max(
    Math.max(0, Number(nextGameReacquireState.lastInteractionGenerationSeen ?? 0)),
    Math.max(0, Number(postGameInteractionWatchState.pendingGeneration ?? 0))
  );
  nextGameReacquireState.pendingInteractionGeneration = Math.max(
    0,
    Number(postGameInteractionWatchState.pendingGeneration ?? 0)
  );
  nextGameReacquireState.pendingInteractionTimestamp = Math.max(
    0,
    Number(postGameInteractionWatchState.pendingTimestamp ?? 0)
  );
  nextGameReacquireState.pendingInteractionSource = "post_game";
  nextGameReacquireState.pendingArmReason = "";
  nextGameReacquireState.pendingInteractionType = String(
    postGameInteractionWatchState.pendingType ?? ""
  );
  nextGameReacquireState.pendingInteractionKey = String(
    postGameInteractionWatchState.pendingKey ?? ""
  );
  nextGameReacquireState.pendingInteractionKind = deriveInteractionKind({
    type: postGameInteractionWatchState.pendingType,
    key: postGameInteractionWatchState.pendingKey,
    targetTag: postGameInteractionWatchState.pendingTargetTag,
    targetId: postGameInteractionWatchState.pendingTargetId
  });
  nextGameReacquireState.pendingInteractionTargetTag = String(
    postGameInteractionWatchState.pendingTargetTag ?? ""
  );
  nextGameReacquireState.pendingInteractionTargetId = String(
    postGameInteractionWatchState.pendingTargetId ?? ""
  );
  nextGameReacquireState.pendingInteractionTargetClass = String(
    postGameInteractionWatchState.pendingTargetClass ?? ""
  );
  if (typeof log === "function") {
    log(
      `[browser] pending post-game interaction carried into reacquire generation=${nextGameReacquireState.pendingInteractionGeneration}`
    );
  }
  return true;
}

function armNextGameInteractionWindow(
  closureCaptureState,
  nextGameReacquireState,
  {
    generation = 0,
    now = Date.now(),
    bootstrapReady = true,
    armReason = "next_game_user_interaction",
    log = console.log
  } = {}
) {
  if (
    nextGameReacquireState?.interactionPhase !== NEXT_GAME_INTERACTION_PHASE_REACQUIRING
  ) {
    return false;
  }
  if (
    nextGameReacquireState?.interactionWindowGeneration === generation &&
    isClosureCaptureArmed(closureCaptureState, now) &&
    (
      closureCaptureState?.armedReason === "next_game_user_interaction" ||
      closureCaptureState?.armedReason === "next_game_carried_interaction"
    )
  ) {
    return false;
  }
  initializeFreshClosureCaptureWindow(closureCaptureState, {
    reason: armReason,
    log
  });
  const armed = requestClosureCaptureArm(closureCaptureState, {
    reason: armReason,
    now,
    bootstrapReady,
    log: () => {}
  });
  if (!armed) {
    return false;
  }
  const initialDelayMs =
    isProvisionalClosureCaptureReason(armReason)
      ? DEFAULT_TARGETED_PAUSED_PROBE_DELAY_MS
      : armReason === "bot_on"
        ? 600
        : DEFAULT_NEXT_GAME_INTERACTION_CAPTURE_DELAY_MS;
  closureCaptureState.nextAttemptAt = now + initialDelayMs;
  closureCaptureState.windowArmedAt = now;
  if (nextGameReacquireState) {
    nextGameReacquireState.interactionWindowGeneration = generation;
    nextGameReacquireState.interactionWindowArmedAt = now;
    setNextGameInteractionPhase(
      nextGameReacquireState,
      NEXT_GAME_INTERACTION_PHASE_CAPTURE_ARMED
    );
  }
  if (typeof log === "function") {
    log(
      `[browser] closure capture armed reason=${armReason} generation=${generation}`
    );
    logClosureCaptureWindowInitialized(closureCaptureState, armReason, log);
  }
  return true;
}

function consumeNextGameInteractionWindow(
  closureCaptureState,
  nextGameReacquireState,
  {
    reason = "completed",
    log = console.log
  } = {}
) {
  if (!nextGameReacquireState) {
    return false;
  }
  const generation = Math.max(
    0,
    Number(nextGameReacquireState.interactionWindowGeneration ?? 0)
  );
  const armedReason = String(closureCaptureState?.armedReason ?? "");
  const isCarriedWindow = isCarriedClosureCaptureReason(armedReason);
  if (generation > 0) {
    nextGameReacquireState.lastInteractionGenerationHandled = Math.max(
      Math.max(0, Number(nextGameReacquireState.lastInteractionGenerationHandled ?? 0)),
      generation
    );
  }
  if (
    generation > 0 &&
    Math.max(0, Number(nextGameReacquireState.pendingInteractionGeneration ?? 0)) === generation
  ) {
    clearPendingNextGameInteraction(nextGameReacquireState);
  }
  nextGameReacquireState.pendingArmReason = "";
  nextGameReacquireState.interactionWindowGeneration = 0;
  nextGameReacquireState.interactionWindowArmedAt = 0;
  if (
    nextGameReacquireState.interactionPhase ===
    NEXT_GAME_INTERACTION_PHASE_CAPTURE_ARMED
  ) {
    setNextGameInteractionPhase(
      nextGameReacquireState,
      NEXT_GAME_INTERACTION_PHASE_REACQUIRING
    );
  }
  if (typeof log === "function" && generation > 0 && reason === "scan_budget_exhausted") {
    if (isCarriedWindow) {
      log(`[browser] carried interaction capture exhausted generation=${generation}`);
    }
    log("[browser] waiting for fresh next-game interaction after capture exhaustion");
  }
  return generation > 0;
}

function armPendingNextGameInteractionWindow(
  closureCaptureState,
  nextGameReacquireState,
  {
    now = Date.now(),
    bootstrapReady = true,
    log = console.log,
    logPrefix = "",
    armReason = ""
  } = {}
) {
  if (
    !nextGameReacquireState ||
    nextGameReacquireState.interactionPhase !== NEXT_GAME_INTERACTION_PHASE_REACQUIRING
  ) {
    return false;
  }
  const pendingGeneration = Math.max(
    0,
    Number(nextGameReacquireState.pendingInteractionGeneration ?? 0)
  );
  const pendingSource = String(nextGameReacquireState.pendingInteractionSource ?? "");
  if (
    pendingGeneration <=
      Math.max(0, Number(nextGameReacquireState.lastInteractionGenerationHandled ?? 0)) ||
    Math.max(0, Number(nextGameReacquireState.pendingInteractionTimestamp ?? 0)) <=
      Math.max(0, Number(nextGameReacquireState.startedAt ?? 0))
  ) {
    return { armed: false, reason: "already_handled_or_stale" };
  }
  if (!bootstrapReady) {
    nextGameReacquireState.pendingArmReason =
      armReason || (
        pendingSource === "post_game"
          ? "next_game_carried_interaction"
          : "next_game_user_interaction"
      );
    if (typeof log === "function") {
      log(
        `[browser] carried interaction arm deferred generation=${pendingGeneration} reason=bootstrap_not_ready`
      );
    }
    return { armed: false, reason: "bootstrap_not_ready" };
  }
  const armed = armNextGameInteractionWindow(
    closureCaptureState,
    nextGameReacquireState,
    {
      generation: pendingGeneration,
      now,
      bootstrapReady,
      armReason:
        armReason || (
          pendingSource === "post_game"
            ? "next_game_carried_interaction"
            : "next_game_user_interaction"
        ),
      log
    }
  );
  if (!armed) {
    if (typeof log === "function") {
      log(
        `[browser] carried interaction arm blocked generation=${pendingGeneration} reason=arm_request_rejected`
      );
    }
    return { armed: false, reason: "arm_request_rejected" };
  }
  nextGameReacquireState.lastInteractionGenerationHandled = pendingGeneration;
  nextGameReacquireState.pendingArmReason = "";
  clearPendingNextGameInteraction(nextGameReacquireState);
  if (typeof log === "function") {
    const nextLogPrefix = logPrefix || (
      pendingSource === "post_game"
        ? "carried interaction armed"
        : "closure capture armed reason=next_game_user_interaction"
    );
    log(`[browser] ${nextLogPrefix} generation=${pendingGeneration}`);
  }
  return { armed: true, reason: "armed" };
}

export function expireClosureCaptureWindow(
  closureCaptureState,
  now = Date.now(),
  { log = null } = {}
) {
  if (!closureCaptureState || closureCaptureState.armedUntil === 0) {
    return false;
  }
  if (closureCaptureState.armedUntil > now) {
    return false;
  }
  const previousReason = closureCaptureState.armedReason || "gameplay_signal";
  closureCaptureState.armedUntil = 0;
  closureCaptureState.armedReason = "";
  closureCaptureState.lastSkippedLogAt = 0;
  closureCaptureState.nextAttemptAt = 0;
  closureCaptureState.retryCount = 0;
  closureCaptureState.firstAttemptLoggedForReason = "";
  closureCaptureState.captureAttemptsInWindow = 0;
  resetClosureCaptureScanWindowState(closureCaptureState);
  if (typeof log === "function") {
    log(
      `[browser] closure capture disarmed reason=window_expired previous_reason=${previousReason}`
    );
  }
  return true;
}

function isClosureCaptureWindowExhausted(closureCaptureState) {
  if (!closureCaptureState) {
    return false;
  }
  return Boolean(
    closureCaptureState.scanBudgetExhausted === true ||
      Math.max(0, Number(closureCaptureState.fullScanAttemptsInWindow ?? 0)) >=
        MAX_FULL_SCAN_ATTEMPTS_PER_WINDOW
  );
}

export function scheduleNextClosureCaptureAttempt(
  closureCaptureState,
  now = Date.now(),
  retryScheduleMs = DEFAULT_CAPTURE_RETRY_SCHEDULE_MS,
  log = null
) {
  if (!closureCaptureState) {
    return 0;
  }
  const index = Math.min(
    closureCaptureState.retryCount,
    Math.max(0, retryScheduleMs.length - 1)
  );
  const delayMs = Math.max(0, retryScheduleMs[index] ?? DEFAULT_CAPTURE_COOLDOWN_MS);
  closureCaptureState.retryCount += 1;
  closureCaptureState.nextAttemptAt = now + delayMs;
  markClosureRetryWaitStart(closureCaptureState, now, delayMs, log ?? (() => {}));
  return delayMs;
}

export function scheduleClosureCaptureContinuation(
  closureCaptureState,
  now = Date.now(),
  delayMs = DEFAULT_FULL_SCAN_CONTINUATION_BACKOFF_MS,
  log = null
) {
  if (!closureCaptureState) {
    return 0;
  }
  const nextDelayMs = Math.max(0, delayMs);
  closureCaptureState.nextAttemptAt = now + nextDelayMs;
  markClosureRetryWaitStart(closureCaptureState, now, nextDelayMs, log ?? (() => {}));
  return nextDelayMs;
}

function saveClosureCaptureContinuationCursor(
  closureCaptureState,
  resumeCursor,
  log = console.log
) {
  if (!closureCaptureState || !resumeCursor) {
    return false;
  }
  closureCaptureState.pausedScopeScanCursor = {
    frameIndex: Math.max(0, Number(resumeCursor.frameIndex ?? 0)),
    scopeIndex: Math.max(0, Number(resumeCursor.scopeIndex ?? 0)),
    propertyIndex: Math.max(
      0,
      Number(resumeCursor.propertyIndex ?? resumeCursor.candidateIndex ?? 0)
    ),
    completedScopeKeys: Array.from(closureCaptureState.pausedScopeScanCursor?.completedScopeKeys ?? []),
    seenCandidateKeys: Array.from(closureCaptureState.pausedScopeScanCursor?.seenCandidateKeys ?? [])
  };
  if (typeof log === "function") {
    log(
      `[browser] full closure scan continuation saved cursor=${formatClosureCaptureCursorLabel(
        closureCaptureState.pausedScopeScanCursor
      )}`
    );
  }
  return true;
}

function formatScanCursor(cursor = null) {
  return {
    frameIndex: Math.max(0, Number(cursor?.frameIndex ?? 0)),
    scopeIndex: Math.max(0, Number(cursor?.scopeIndex ?? 0)),
    candidateIndex: Math.max(
      0,
      Number(cursor?.candidateIndex ?? cursor?.propertyIndex ?? 0)
    )
  };
}

function formatClosureCaptureCursorLabel(cursor = null) {
  if (!cursor) {
    return "none";
  }
  const formatted = formatScanCursor(cursor);
  return `${formatted.frameIndex}:${formatted.scopeIndex}:${formatted.candidateIndex}`;
}

function normalizeFrameUrl(value = "") {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  try {
    return new URL(text).href.toLowerCase();
  } catch {
    return text.toLowerCase();
  }
}

function getFramePriority(
  callFrame,
  {
    targetUrl = "",
    mainFrameId = "",
    preferredLocators = []
  } = {}
) {
  let score = 0;
  const auxData = callFrame?.auxData ?? callFrame?.executionContext?.auxData ?? null;
  const executionContext = callFrame?.executionContext ?? null;
  const frameId = String(callFrame?.frameId ?? "");
  const normalizedTargetUrl = normalizeFrameUrl(targetUrl);
  const targetOrigin = normalizedTargetUrl
    ? normalizedTargetUrl.match(/^(https?:\/\/[^/]+)/)?.[1] ?? ""
    : "";
  const urls = [
    callFrame?.documentURL,
    callFrame?.url,
    callFrame?.executionContext?.origin,
    executionContext?.origin
  ].map(normalizeFrameUrl).filter(Boolean);
  const functionLabel = String(
    callFrame?.functionName ?? callFrame?.functionLocation?.name ?? ""
  ).toLowerCase();
  if (auxData?.isDefault === true || executionContext?.isDefault === true) {
    score += 10000;
  }
  if (mainFrameId && frameId === String(mainFrameId)) {
    score += 9000;
  }
  if (targetOrigin && urls.some((url) => url === normalizedTargetUrl || url.startsWith(`${targetOrigin}/`))) {
    score += 4000;
  }
  if (urls.some((url) => /(^|[.:/])tetr\.io(?:[/:]|$)/.test(url))) {
    score += 2500;
  }
  if (/(game|tetr|play|battle|requestanimationframe|settimeout|update|tick|render)/.test(functionLabel)) {
    score += 100;
  }
  score += Math.min(12, Array.isArray(callFrame?.scopeChain) ? callFrame.scopeChain.length : 0) * 150;
  return score;
}

function formatPausedFrameDiagnostic(callFrame, index, options = {}) {
  const functionLabel = String(callFrame?.functionName ?? "").trim() || "anonymous";
  const url = String(callFrame?.url ?? callFrame?.documentURL ?? "").trim() || "-";
  const scopeCount = Array.isArray(callFrame?.scopeChain)
    ? callFrame.scopeChain.length
    : 0;
  return `${index}(score=${getFramePriority(callFrame, options)} function=${functionLabel} url=${url} scopes=${scopeCount})`;
}

function getPausedScopeScanFrameOrder(
  callFrames = [],
  options = {}
) {
  return callFrames
    .map((callFrame, index) => ({
      index,
      score: getFramePriority(callFrame, options)
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ index }) => index);
}

function nextPausedScopeScanFrameIndex(callFrames = [], frameIndex = 0, options = {}) {
  const order = getPausedScopeScanFrameOrder(callFrames, options);
  const currentOrderIndex = order.indexOf(frameIndex);
  if (currentOrderIndex < 0) {
    return null;
  }
  return order[currentOrderIndex + 1] ?? null;
}

function computePausedScopeScanResumeCursor(
  callFrames = [],
  {
    frameIndex = 0,
    scopeIndex = 0,
    propertyIndex = 0,
    descriptorsLength = 0,
    advancePastCurrentProperty = false,
    frameOrderOptions = {}
  } = {}
) {
  const currentFrame = callFrames[frameIndex];
  const currentScopeChain = currentFrame?.scopeChain ?? [];
  const currentPropertyIndex =
    Math.max(0, Number(propertyIndex ?? 0)) + (advancePastCurrentProperty ? 1 : 0);
  if (currentPropertyIndex < Math.max(0, Number(descriptorsLength ?? 0))) {
    return {
      frameIndex,
      scopeIndex,
      propertyIndex: currentPropertyIndex
    };
  }
  if (scopeIndex + 1 < currentScopeChain.length) {
    return {
      frameIndex,
      scopeIndex: scopeIndex + 1,
      propertyIndex: 0
    };
  }
  const nextFrameIndex = nextPausedScopeScanFrameIndex(
    callFrames,
    frameIndex,
    frameOrderOptions
  );
  if (nextFrameIndex === null || nextFrameIndex === undefined) {
    return null;
  }
  return {
    frameIndex: nextFrameIndex,
    scopeIndex: 0,
    propertyIndex: 0
  };
}

async function probeTargetedPausedLocation(
  cdp,
  pausedEvent,
  closureCaptureState,
  {
    log = console.log,
    requireActiveGame = false
  } = {}
) {
  const hint = closureCaptureState?.lastSuccessfulPausedLocation ?? null;
  if (!hint) {
    return { ok: false, reason: "missing_hint" };
  }
  const callFrames = pausedEvent?.callFrames ?? [];
  const callFrame = callFrames[hint.frameIndex];
  const scope = callFrame?.scopeChain?.[hint.scopeIndex];
  const scopeObjectId = scope?.object?.objectId;
  if (!scopeObjectId) {
    if (typeof log === "function") {
      log("[browser] targeted paused locator miss reason=scope_missing");
    }
    return { ok: false, reason: "scope_missing" };
  }
  const properties = await cdp.send("Runtime.getProperties", {
    objectId: scopeObjectId,
    ownProperties: true,
    accessorPropertiesOnly: false,
    generatePreview: false
  }).catch(() => null);
  const descriptors = (properties?.result ?? [])
    .slice(0, MAX_SCOPE_PROPERTIES_PER_SCOPE)
    .map((descriptor, index) => ({ descriptor, index }))
    .sort((left, right) => {
      const scoreDelta =
        scorePausedScopeDescriptor(right.descriptor) -
        scorePausedScopeDescriptor(left.descriptor);
      return scoreDelta !== 0 ? scoreDelta : left.index - right.index;
    })
    .map(({ descriptor }) => descriptor);
  const expectedLocator = String(hint.locator ?? "");
  const candidates = [];
  if (Number.isFinite(hint.candidateIndex) && descriptors[hint.candidateIndex]) {
    candidates.push({
      descriptor: descriptors[hint.candidateIndex],
      candidateIndex: hint.candidateIndex
    });
  }
  for (let index = 0; index < descriptors.length; index += 1) {
    if (index === hint.candidateIndex) {
      continue;
    }
    const descriptor = descriptors[index];
    if (String(descriptor?.name ?? "") === expectedLocator) {
      candidates.push({ descriptor, candidateIndex: index });
      break;
    }
  }
  for (const candidate of candidates) {
    const valueObjectId = candidate.descriptor?.value?.objectId;
    const locator = String(candidate.descriptor?.name ?? "").trim();
    if (!valueObjectId || !locator || locator !== expectedLocator) {
      continue;
    }
    const exposed = await exposeTetrioCandidateObjectWithOptions(
      cdp,
      valueObjectId,
      locator,
      { requireActiveGame }
    );
    if (exposed.ok) {
      await captureSoloClosureFingerprintForPausedCandidate(cdp, {
        pausedEvent,
        frameIndex: hint.frameIndex,
        scopeIndex: hint.scopeIndex,
        locator,
        objectId: valueObjectId,
        filePath:
          closureCaptureState?.soloClosureFingerprintPath ??
          DEFAULT_SOLO_CLOSURE_FINGERPRINT_PATH,
        targetGeneration: Math.max(
          0,
          Number(closureCaptureState?.windowSequence ?? 0)
        )
      }).catch(() => false);
      if (typeof log === "function") {
        log(
          `[browser] targeted paused locator hit frame=${hint.frameIndex} scope=${hint.scopeIndex} candidate=${candidate.candidateIndex}`
        );
      }
      return {
        ...exposed,
        outcome: "targeted_hint_found",
        progress: {
          frameIndex: hint.frameIndex,
          scopeIndex: hint.scopeIndex,
          candidateIndex: candidate.candidateIndex,
          inspectedObjects: 1,
          pausedMs: 0
        }
      };
    }
  }
  if (typeof log === "function") {
    log(
      `[browser] targeted paused locator miss frame=${hint.frameIndex} scope=${hint.scopeIndex} candidate=${hint.candidateIndex}`
    );
  }
  return { ok: false, reason: "targeted_hint_miss" };
}

function logClosureCaptureWindowInitialized(
  closureCaptureState,
  reason,
  log = console.log
) {
  if (typeof log !== "function" || !closureCaptureState) {
    return;
  }
  const pausedUsedMs = Math.max(
    0,
    Number(closureCaptureState.cumulativePausedScanBudgetUsedMs ?? 0)
  );
  const remainingPausedMs = Math.max(
    0,
    DEFAULT_FULL_SCAN_CUMULATIVE_BUDGET_MS - pausedUsedMs
  );
  log(
    `[browser] closure window initialized reason=${reason} capture_attempts=${Math.max(
      0,
      Number(closureCaptureState.captureAttemptsInWindow ?? 0)
    )} full_scan_attempts=${Math.max(
      0,
      Number(closureCaptureState.fullScanAttemptsInWindow ?? 0)
    )} paused_used_ms=${pausedUsedMs} cursor=${formatClosureCaptureCursorLabel(
      closureCaptureState.pausedScopeScanCursor
    )} exhausted=${closureCaptureState.scanBudgetExhausted ? "true" : "false"} remaining_paused_ms=${remainingPausedMs}`
  );
}

function logPausedScopeScanProgress(log, progress) {
  if (typeof log !== "function" || !progress) {
    return;
  }
  log(
    `[browser] full closure scan progress attempt=${progress.attempt}/${MAX_FULL_SCAN_ATTEMPTS_PER_WINDOW} frame=${progress.frameIndex} scope=${progress.scopeIndex} candidate=${progress.candidateIndex} inspected_objects=${progress.inspectedObjects} paused_ms=${progress.pausedMs} frames_scanned=${progress.framesScanned ?? 0} scopes_scanned=${progress.scopesScanned ?? 0}`
  );
}

function logPausedScopeScanContinuation(log, cursor) {
  if (typeof log !== "function" || !cursor) {
    return;
  }
  const formatted = formatScanCursor(cursor);
  log(
    `[browser] full closure scan continuation from frame=${formatted.frameIndex} scope=${formatted.scopeIndex} candidate=${formatted.candidateIndex}`
  );
}

function scorePausedScopeDescriptor(descriptor, preferredLocators = []) {
  const locator = String(descriptor?.name ?? "").trim().toLowerCase();
  if (!locator) {
    return Number.NEGATIVE_INFINITY;
  }
  const preferred = new Set(
    Array.isArray(preferredLocators)
      ? preferredLocators.map((value) => String(value ?? "").trim().toLowerCase()).filter(Boolean)
      : []
  );
  let score = 0;
  if (preferred.has(locator)) score += 10000;
  if (locator === "ai") score += 5000;
  if (locator === "game") score += 200;
  if (locator.includes("game")) score += 120;
  if (locator.includes("field")) score += 50;
  if (locator.includes("queue")) score += 50;
  if (locator.includes("hold")) score += 50;
  if (locator.includes("board")) score += 35;
  if (locator.includes("current")) score += 35;
  if (locator.includes("piece")) score += 20;
  if (locator.length >= 4) score += 5;
  return score;
}

export function applyBrowserControlMessage({
  message,
  controlState,
  closureCaptureState,
  nextGameReacquireState = null,
  quickPlayDiagnosticState = null,
  onModeChanged = null,
  onBotEnabled = null,
  onBotDisabled = null,
  onQuickPlayDiagnosticStart = null,
  onQuickPlayDiagnosticStop = null,
  now = Date.now(),
  log = console.log,
  windowMs = DEFAULT_CAPTURE_ARMING_WINDOW_MS,
  bootstrapReady = true
}) {
  if (!controlState) {
    return false;
  }
  if (!message || typeof message !== "object") {
    return false;
  }
  if (message.type === "quick_play_passive_provider") {
    const result = requestQuickPlayPassiveProviderOwner(
      quickPlayDiagnosticState,
      controlState,
      {
        owner: normalizedScalar(message.owner),
        enabled: message.enabled !== false,
        now,
        log,
        usernameHint: normalizedScalar(message.username_hint)
      }
    );
    if (result.started) {
      if (
        normalizedScalar(message.owner) === QUICK_PLAY_OWNER_ZENITH_DRY_RUN
      ) {
        log?.(
          `[zenith-dry-run] passive provider active mode=${normalizeRuntimeMode(
            controlState.selectedMode
          )} packet_limit=${
            quickPlayPassivePacketLimit(quickPlayDiagnosticState) === null
              ? "unlimited"
              : quickPlayPassivePacketLimit(quickPlayDiagnosticState)
          } duration=${
            quickPlayPassiveUsesOwnerLifecycle(quickPlayDiagnosticState)
              ? "owner_lifecycle"
              : Math.max(
                  0,
                  Number(quickPlayDiagnosticState.stopAt) -
                    Number(quickPlayDiagnosticState.startedAt)
                )
          }`
        );
      }
      onQuickPlayDiagnosticStart?.(result);
    } else if (result.stopped) {
      onQuickPlayDiagnosticStop?.();
    } else if (result.reason) {
      log?.(
        `[quick-play] passive provider rejected owner=${String(
          normalizedScalar(message.owner) ?? ""
        )} reason=${String(result.reason)}` +
          (result.reason === "mode_not_zenith"
            ? ` actual_mode=${normalizeRuntimeMode(controlState.selectedMode)}`
            : "")
      );
    }
    return result.changed === true || result.started === true || result.stopped === true;
  }
  if (message.type === "quick_play_diagnostic") {
    return applyBrowserControlMessage({
      message: {
        type: "quick_play_passive_provider",
        owner: QUICK_PLAY_OWNER_MANUAL_DIAGNOSTIC,
        enabled: message.enabled !== false,
        username_hint: normalizedScalar(message.username_hint)
      },
      controlState,
      closureCaptureState,
      nextGameReacquireState,
      quickPlayDiagnosticState,
      onModeChanged,
      onBotEnabled,
      onBotDisabled,
      onQuickPlayDiagnosticStart,
      onQuickPlayDiagnosticStop,
      now,
      log,
      windowMs,
      bootstrapReady
    });
  }
  if (message.type === "selected_mode") {
    const nextMode = normalizeRuntimeMode(message.mode);
    const nextGeneration = Math.max(0, Number(message.generation ?? 0));
    if (
      controlState.selectedMode === nextMode &&
      Math.max(0, Number(controlState.modeGeneration ?? 0)) === nextGeneration
    ) {
      return false;
    }
    controlState.selectedMode = nextMode;
    controlState.modeGeneration = nextGeneration;
    cancelNextGameReacquire(nextGameReacquireState, {
      reason: "mode_changed",
      log
    });
    disarmClosureCaptureWindow(closureCaptureState, {
      reason: "mode_changed",
      log,
      clearPending: true
    });
    log?.(`[mode] selected mode=${nextMode}`);
    onModeChanged?.({
      selectedMode: nextMode,
      modeGeneration: nextGeneration,
      botEnabled: Boolean(controlState.botEnabled)
    });
    return true;
  }
  if (message.type !== "bot_enabled" || typeof message.enabled !== "boolean") {
    return false;
  }
  if (controlState.botEnabled === message.enabled) {
    return false;
  }
  controlState.botEnabled = message.enabled;
  if (message.enabled) {
    if (quickPlayDiagnosticState?.active && !quickPlayPassiveAllowsBotEnabled(quickPlayDiagnosticState)) {
      stopQuickPlayDiagnosticCapture(quickPlayDiagnosticState, {
        now,
        reason: "bot_enabled",
        log
      });
      onQuickPlayDiagnosticStop?.();
    }
    log?.(
      `[mode] bot enabled mode=${normalizeRuntimeMode(
        controlState.selectedMode
      )} generation=${Math.max(0, Number(controlState.modeGeneration ?? 0))}`
    );
    if (isSoloModeSelected(controlState)) {
      requestClosureCaptureArm(closureCaptureState, {
        reason: "bot_on",
        now,
        bootstrapReady,
        windowMs,
        log
      });
    }
    onBotEnabled?.({
      selectedMode: normalizeRuntimeMode(controlState.selectedMode),
      modeGeneration: Math.max(0, Number(controlState.modeGeneration ?? 0))
    });
  } else {
    cancelNextGameReacquire(nextGameReacquireState, {
      reason: "bot_off",
      log
    });
    disarmClosureCaptureWindow(closureCaptureState, {
      reason: "bot_off",
      log,
      clearPending: true
    });
    log?.(
      `[mode] bot disabled mode=${normalizeRuntimeMode(controlState.selectedMode)}`
    );
    onBotDisabled?.({
      selectedMode: normalizeRuntimeMode(controlState.selectedMode),
      modeGeneration: Math.max(0, Number(controlState.modeGeneration ?? 0))
    });
  }
  return true;
}

export function createBootstrapState(now = Date.now()) {
  return {
    connectedAt: now,
    documentCompleteAt: 0,
    transportReadyAt: 0,
    waitingLogged: false,
    readyLogged: false,
    lastDocumentReadyState: "loading",
    lastReadHref: "",
    lastBlockedReason: "",
    lastBlockedLogAt: 0,
    lastReady: false
  };
}

export function createZenithBootstrapCheckState() {
  return {
    generation: 0,
    scheduled: false,
    nextCheckAt: 0,
    attemptCount: 0,
    retryMs: DEFAULT_ZENITH_BOOTSTRAP_RETRY_MS,
    maxAttempts: DEFAULT_ZENITH_BOOTSTRAP_MAX_ATTEMPTS,
    running: false,
    lastReadyGeneration: 0
  };
}

export function resetZenithBootstrapCheckState(zenithBootstrapCheckState) {
  if (!zenithBootstrapCheckState) {
    return false;
  }
  zenithBootstrapCheckState.generation = 0;
  zenithBootstrapCheckState.scheduled = false;
  zenithBootstrapCheckState.nextCheckAt = 0;
  zenithBootstrapCheckState.attemptCount = 0;
  zenithBootstrapCheckState.retryMs = DEFAULT_ZENITH_BOOTSTRAP_RETRY_MS;
  zenithBootstrapCheckState.maxAttempts = DEFAULT_ZENITH_BOOTSTRAP_MAX_ATTEMPTS;
  zenithBootstrapCheckState.running = false;
  zenithBootstrapCheckState.lastReadyGeneration = 0;
  return true;
}

function clampZenithBootstrapRetryMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_ZENITH_BOOTSTRAP_RETRY_MS;
  }
  return Math.max(200, Math.min(500, Math.round(numeric)));
}

function clampZenithBootstrapMaxAttempts(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_ZENITH_BOOTSTRAP_MAX_ATTEMPTS;
  }
  return Math.max(1, Math.min(5, Math.round(numeric)));
}

export function ensureZenithBootstrapCheckScheduled(
  zenithBootstrapCheckState,
  browserControlState,
  {
    now = Date.now(),
    delayMs = 0,
    retryMs = DEFAULT_ZENITH_BOOTSTRAP_RETRY_MS,
    maxAttempts = DEFAULT_ZENITH_BOOTSTRAP_MAX_ATTEMPTS,
    log = console.log
  } = {}
) {
  if (
    !zenithBootstrapCheckState ||
    !isZenithModeActive(browserControlState)
  ) {
    return false;
  }
  const generation = Math.max(
    0,
    Number(browserControlState.modeGeneration ?? 0)
  );
  zenithBootstrapCheckState.retryMs = clampZenithBootstrapRetryMs(retryMs);
  zenithBootstrapCheckState.maxAttempts = clampZenithBootstrapMaxAttempts(maxAttempts);
  if (zenithBootstrapCheckState.lastReadyGeneration === generation) {
    return false;
  }
  if (zenithBootstrapCheckState.generation !== generation) {
    zenithBootstrapCheckState.generation = generation;
    zenithBootstrapCheckState.scheduled = false;
    zenithBootstrapCheckState.nextCheckAt = 0;
    zenithBootstrapCheckState.attemptCount = 0;
    zenithBootstrapCheckState.running = false;
  }
  if (
    zenithBootstrapCheckState.scheduled ||
    zenithBootstrapCheckState.running ||
    zenithBootstrapCheckState.attemptCount >=
      zenithBootstrapCheckState.maxAttempts
  ) {
    return false;
  }
  zenithBootstrapCheckState.scheduled = true;
  zenithBootstrapCheckState.nextCheckAt =
    now + Math.max(0, Number(delayMs) || 0);
  log?.(
    `[zenith] bootstrap check scheduled generation=${generation} attempt=${
      zenithBootstrapCheckState.attemptCount + 1
    }`
  );
  return true;
}

export async function maybeRunZenithBootstrapCheck({
  cdp,
  zenithBootstrapCheckState,
  browserControlState,
  bootstrapState,
  transientState = null,
  now = Date.now(),
  nowFn = () => Date.now(),
  readBootstrapPageStateFn = readBootstrapPageState,
  getBootstrapReadinessStatusFn = getBootstrapReadinessStatus,
  onBootstrapReady = null,
  log = console.log
} = {}) {
  if (
    !zenithBootstrapCheckState ||
    !isZenithModeActive(browserControlState)
  ) {
    return { ran: false, reason: "inactive" };
  }
  const generation = Math.max(
    0,
    Number(browserControlState.modeGeneration ?? 0)
  );
  if (
    zenithBootstrapCheckState.generation !== generation ||
    !zenithBootstrapCheckState.scheduled ||
    zenithBootstrapCheckState.running ||
    now < zenithBootstrapCheckState.nextCheckAt
  ) {
    return { ran: false, reason: "not_due" };
  }

  zenithBootstrapCheckState.scheduled = false;
  zenithBootstrapCheckState.running = true;
  zenithBootstrapCheckState.attemptCount += 1;
  let pageState = null;
  try {
    pageState = await readBootstrapPageStateFn(
      cdp,
      bootstrapState,
      now,
      transientState,
      log
    );
  } finally {
    zenithBootstrapCheckState.running = false;
  }

  if (
    !isZenithModeActive(browserControlState) ||
    generation !== Math.max(0, Number(browserControlState.modeGeneration ?? 0))
  ) {
    return { ran: true, ready: false, reason: "stale_generation", pageState };
  }

  const evaluatedAt = nowFn();
  const bootstrapStatus = getBootstrapReadinessStatusFn(
    bootstrapState,
    evaluatedAt
  );
  if (bootstrapStatus.ready) {
    if (zenithBootstrapCheckState.lastReadyGeneration !== generation) {
      zenithBootstrapCheckState.lastReadyGeneration = generation;
      log?.(`[zenith] bootstrap ready generation=${generation}`);
      onBootstrapReady?.();
    }
    return { ran: true, ready: true, reason: bootstrapStatus.reason, pageState };
  }

  if (
    zenithBootstrapCheckState.attemptCount >=
    zenithBootstrapCheckState.maxAttempts
  ) {
    return {
      ran: true,
      ready: false,
      exhausted: true,
      reason: bootstrapStatus.reason,
      pageState
    };
  }

  ensureZenithBootstrapCheckScheduled(zenithBootstrapCheckState, browserControlState, {
    now: evaluatedAt,
    delayMs: zenithBootstrapCheckState.retryMs,
    retryMs: zenithBootstrapCheckState.retryMs,
    maxAttempts: zenithBootstrapCheckState.maxAttempts,
    log
  });
  return {
    ran: true,
    ready: false,
    exhausted: false,
    reason: bootstrapStatus.reason,
    pageState
  };
}

export function resetBootstrapState(
  bootstrapState,
  { resetConnectedAt = false, now = Date.now() } = {}
) {
  if (resetConnectedAt) {
    bootstrapState.connectedAt = now;
  }
  bootstrapState.documentCompleteAt = 0;
  bootstrapState.transportReadyAt = 0;
  bootstrapState.waitingLogged = false;
  bootstrapState.readyLogged = false;
  bootstrapState.lastDocumentReadyState = "loading";
  bootstrapState.lastReadHref = "";
  bootstrapState.lastBlockedReason = "";
  bootstrapState.lastBlockedLogAt = 0;
  bootstrapState.lastReady = false;
  return bootstrapState;
}

export function markBootstrapTransportReady(
  bootstrapState,
  now = Date.now()
) {
  if (!bootstrapState || bootstrapState.transportReadyAt > 0) {
    return bootstrapState;
  }
  bootstrapState.transportReadyAt = now;
  return bootstrapState;
}

export function updateBootstrapDocumentState(
  bootstrapState,
  pageState,
  now = Date.now()
) {
  if (bootstrapState) {
    bootstrapState.lastDocumentReadyState = String(
      pageState?.readyState ?? "loading"
    );
    bootstrapState.lastReadHref = String(pageState?.href ?? "");
  }
  if (
    bootstrapState &&
    pageState?.readyState &&
    pageState.readyState !== "loading" &&
    bootstrapState.documentCompleteAt === 0
  ) {
    bootstrapState.documentCompleteAt = now;
  }
  return bootstrapState;
}

export function getBootstrapReadinessStatus(
  bootstrapState,
  now = Date.now(),
  {
    transportSettleMs = DEFAULT_BOOTSTRAP_TRANSPORT_SETTLE_MS,
    fallbackMs = DEFAULT_BOOTSTRAP_FALLBACK_MS
  } = {}
) {
  if (!bootstrapState?.documentCompleteAt) {
    return {
      ready: false,
      reason: `document_ready_state_${bootstrapState?.lastDocumentReadyState ?? "loading"}`
    };
  }
  if (bootstrapState.transportReadyAt > 0) {
    const elapsedMs = now - bootstrapState.transportReadyAt;
    if (elapsedMs >= transportSettleMs) {
      return { ready: true, reason: "transport_settled" };
    }
    return {
      ready: false,
      reason: `transport_settling_${Math.max(0, transportSettleMs - elapsedMs)}ms_remaining`
    };
  }
  const elapsedSinceConnectMs = now - bootstrapState.connectedAt;
  if (elapsedSinceConnectMs >= fallbackMs) {
    return { ready: true, reason: "fallback_elapsed" };
  }
  return {
    ready: false,
    reason: `fallback_waiting_${Math.max(0, fallbackMs - elapsedSinceConnectMs)}ms_remaining`
  };
}

export function isBootstrapReadyForClosureCapture(
  bootstrapState,
  now = Date.now(),
  options = {}
) {
  return getBootstrapReadinessStatus(bootstrapState, now, options).ready;
}

export function shouldLogBootstrapBlocked(
  bootstrapState,
  reason,
  now = Date.now(),
  intervalMs = DEFAULT_BOOTSTRAP_BLOCKED_LOG_INTERVAL_MS
) {
  if (!bootstrapState) {
    return false;
  }
  return (
    bootstrapState.lastBlockedReason !== reason ||
    now - bootstrapState.lastBlockedLogAt >= intervalMs
  );
}

export function markBootstrapBlockedLogged(
  bootstrapState,
  reason,
  now = Date.now()
) {
  if (!bootstrapState) {
    return false;
  }
  bootstrapState.lastBlockedReason = reason;
  bootstrapState.lastBlockedLogAt = now;
  return true;
}

export function isTransientRuntimeError(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  return (
    message.includes("promise was collected") ||
    message.includes("cannot find default execution context") ||
    message.includes("execution context was destroyed") ||
    message.includes("cannot find context with specified id") ||
    message.includes("inspected target navigated or closed") ||
    message.includes("no frame with given id")
  );
}

function maybeLogTransientRuntimeError(error, transientState, log = console.log) {
  const message = String(error?.message ?? error ?? "");
  if (!transientState || transientState.lastRuntimeError === message) {
    return;
  }
  transientState.lastRuntimeError = message;
  log(`[browser] transient Runtime.evaluate failure: ${message}; retrying`);
}

export function shouldLogStateReason({
  reason,
  lastReason,
  lastReasonAt,
  now = Date.now(),
  statusMs = DEFAULT_STATUS_MS,
  suppressRepeatedReason = false
}) {
  if (reason !== lastReason) {
    return true;
  }
  if (suppressRepeatedReason) {
    return false;
  }
  return now - lastReasonAt >= statusMs;
}

function maybeLogBrowserPerf({
  browserPerfEnabled,
  lastPerfLoggedAt,
  maxEventLoopDelayMs
}) {
  if (!browserPerfEnabled || Date.now() - lastPerfLoggedAt < PERF_LOG_INTERVAL_MS) {
    return null;
  }
  console.log(`[browser-perf] max_event_loop_delay_ms=${maxEventLoopDelayMs}`);
  return {
    lastPerfLoggedAt: Date.now(),
    maxEventLoopDelayMs: 0
  };
}

export function isTetrioGameEndedState(state) {
  return Boolean(state?.ok && state.ready === false && state.reason === "TETR.IO game ended");
}

export function shouldHandleEndedGame(state, endedHandled) {
  return isTetrioGameEndedState(state) && !endedHandled;
}

export function isActiveTetrioGameState(state) {
  return Boolean(state?.ok && state.ready && state.playing && !state.countdown);
}

export function shouldAdvanceGameEpoch(state, waitingForNextGame) {
  return waitingForNextGame && isActiveTetrioGameState(state);
}

export function clearSnapshotFile(snapshotPath) {
  rmSync(snapshotPath, { force: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshotPath = args.snapshotPath ?? "automation/live-snapshot.json";
  const url = args.url ?? DEFAULT_URL;
  const port = numberArg(args.port, DEFAULT_PORT);
  const targetHint = args.target ?? "TETR.IO";
  const pollMs = resolvePollMs(args);
  const connectOnly = args.connectOnly === "1";
  const probePageState = args.probePageState !== "0";
  const useRibbonWebsocket = args.useRibbonWebsocket !== "0";
  const useSeedSimulationFallback = resolveUseSeedSimulationFallback(
    args.useSeedSimulationFallback !== "0"
  );
  const vsWsSimEnabled = isVsWsSimEnvEnabled();
  const browserPerfEnabled = process.env.FUSION_BROWSER_PERF === "1";
  const closureCandidateTraceEnabled =
    process.env.FUSION_CLOSURE_CANDIDATE_TRACE === "1";
  const chromePath = process.env.CHROME_PATH || "";
  const msgpack = await loadOptionalMsgpack();

  let browserProcess = null;
  let ownsChromium = false;
  const alreadyOpen = await isCdpOpen(port);
  if (determineChromiumOwnership({ connectOnly, alreadyOpen })) {
    browserProcess = launchChromium({ port, url, chromePath });
    ownsChromium = true;
  }

  await waitForCdpReady(port);
  const target = await findOrCreateTarget({ port, url, targetHint });
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable").catch(() => undefined);
  await cdp.send("Runtime.enable").catch(() => undefined);

  process.stdout.write(
    `${JSON.stringify({ type: "ready", ok: true, target: target.title || target.url, port })}\n`
  );
  console.log(`[browser] connected to ${target.title || target.url} on port ${port}`);

  let dddWsObserverCleanup = null;
  let vsRoundActive = false;
  let vsRoundId = "";
  const browserControlState = createBrowserControlState();
  const quickPlayDiagnosticState = createQuickPlayDiagnosticState();
  const closureCaptureState = createClosureCaptureState();
  const gameStartSignalState = createGameStartSignalState();
  const nextGameReacquireState = createNextGameReacquireState();
  const postGameInteractionWatchState = createPostGameInteractionWatchState();
  const endedGameCandidate = createEndedGameCandidateState();
  let lastPerfLoggedAt = Date.now();
  let loopStartedAt = Date.now();
  let maxEventLoopDelayMs = 0;
  const notifyObserverTargetReset = (reason = "browser_target_reset") => {
    try {
      dddWsObserverCleanup?.notifyTargetReset?.(reason);
    } catch {}
  };
  const notifyObserverBootstrapReady = () => {
    try {
      dddWsObserverCleanup?.notifyBootstrapReady?.();
    } catch {}
  };
  const notifyObserverModeControl = () => {
    try {
      dddWsObserverCleanup?.setModeControl?.({
        selectedMode: normalizeRuntimeMode(browserControlState.selectedMode),
        botEnabled: Boolean(browserControlState.botEnabled),
        modeGeneration: Math.max(0, Number(browserControlState.modeGeneration ?? 0))
      });
    } catch {}
  };
  const clearModeRuntimeState = (reason = "mode_change") => {
    cancelNextGameReacquire(nextGameReacquireState, {
      reason,
      log: (message) => console.log(message)
    });
    cancelPostGameInteractionWatch(postGameInteractionWatchState, {
      reason,
      log: (message) => console.log(message)
    });
    disarmClosureCaptureWindow(closureCaptureState, {
      reason,
      log: (message) => console.log(message),
      clearPending: true
    });
    resetGameStartSignalState(gameStartSignalState);
    resetSnapshotTracking(snapshotTracking);
    probeState.lastCaptureAt = 0;
    waitingForNextGame = false;
    waitingForNextGameSignalCutoffAt = 0;
    endedHandled = false;
    lastReason = "";
    lastReasonAt = 0;
    clearSnapshotFile(snapshotPath);
    console.log(
      `[mode] runtime state cleared mode=${normalizeRuntimeMode(browserControlState.selectedMode)}`
    );
  };
  try {
    const { installDddWsObserver } =
      await import("./ddd-ws-observer.mjs");

    dddWsObserverCleanup = await installDddWsObserver(cdp, {
      unpack: msgpack?.unpack ?? null,
      log: message => console.log(message),
      onVsRoundStatus: (status) => {
        const nextActive = Boolean(status?.active);
        const nextRoundId = nextActive ? String(status?.roundId ?? "") : "";
        const changed =
          nextActive !== vsRoundActive || nextRoundId !== vsRoundId;
        vsRoundActive = nextActive;
        vsRoundId = nextRoundId;
        if (!changed || !vsWsSimEnabled) {
          return;
        }
        if (vsRoundActive) {
          disarmClosureCaptureWindow(closureCaptureState, {
            reason: "vs_round_active"
          });
          console.log(
            `[browser] VS round active; closure capture probe suspended roundId=${vsRoundId}`
          );
        } else {
          disarmClosureCaptureWindow(closureCaptureState, {
            reason: "vs_round_inactive"
          });
          console.log("[browser] VS round inactive; closure capture probe restored");
        }
      },
      onGameOptions: ({ signature, options, capturedAt }) => {
        if (!isSoloModeActive(browserControlState)) {
          return;
        }
        if (isZenithGameplayOptions(options)) {
          return;
        }
        const now = Number.isFinite(capturedAt) ? capturedAt : Date.now();
        const countdownMs = estimateCountdownWait(options);
        noteSoloGameStartSignal(gameStartSignalState, {
          key: `ddd:${signature}`,
          source: "ddd_game_options",
          now,
          log: (message) => console.log(message),
          details: {
            seed: options?.seed ?? null,
            bagtype: options?.bagtype ?? null,
            gameid: options?.gameid ?? null,
            nextCount: options?.nextcount ?? DEFAULT_NEXT_COUNT,
            countdownMs,
            readyAt: now + countdownMs
          }
        });
      },
      perfEnabled: browserPerfEnabled
      ,
      onDiagnosticEnvelope: (record) => {
        if (!quickPlayDiagnosticState.active) {
          return;
        }
        recordQuickPlayDiagnosticEnvelope(quickPlayDiagnosticState, record);
      }
    });

    console.log("[ws-observer] installed");
    notifyObserverModeControl();
  } catch (error) {
    console.log(
      `[ws-observer] installation failed: ${
        error?.message ?? String(error)
      }`
    );
  }
  await cdp.send("Page.bringToFront");
  await installBackgroundInputKeepalive(cdp);
  await safeRuntimeEvaluate(cdp, {
    expression: "window.focus(); document.body && document.body.focus && document.body.focus(); true"
  }).catch(() => undefined);

  const network = createTetrioNetworkState();
  const bootstrapState = createBootstrapState();
  const zenithBootstrapCheckState = createZenithBootstrapCheckState();
  const transientState = { lastRuntimeError: "" };
  const interactionTrackerInstallState = createInteractionTrackerInstallState();
  const installInteractionTrackerForCurrentDocument = () =>
    ensureNextGameInteractionTrackerInstalled(cdp, interactionTrackerInstallState, {
      transientState,
      log: (message) => console.log(message)
    }).catch(() => undefined);
  await installInteractionTrackerForCurrentDocument();
  notifyObserverTargetReset("initial_target_state");
  console.log("[browser] browser target state reset");
  if (useRibbonWebsocket) {
    await installRibbonMonitor(cdp, network, msgpack, bootstrapState, {
      onGameplaySignal: ({ key, source, details }) => {
        if (!isSoloModeActive(browserControlState)) {
          return;
        }
        noteSoloGameStartSignal(gameStartSignalState, {
          key,
          source,
          now: Date.now(),
          details,
          log: (message) => console.log(message)
        });
      }
    });
  }
  const resetBrowserTargetState = ({ resetConnectedAt = false } = {}) => {
    resetBootstrapState(bootstrapState, { resetConnectedAt });
    resetZenithBootstrapCheckState(zenithBootstrapCheckState);
    resetTetrioNetworkState(network);
    resetClosureCaptureLocatorHint(closureCaptureState);
    resetPausedScopeScanProgress(closureCaptureState);
    clearPendingClosureCaptureArm(closureCaptureState);
    resetGameStartSignalState(gameStartSignalState);
    void releaseEndedGameCandidateHandle(cdp, endedGameCandidate, {
      reason: resetConnectedAt ? "navigation" : "execution_context_reset",
      log: (message) => console.log(message)
    }).catch(() => undefined);
    void releaseQuickPlayPassiveState(cdp, quickPlayDiagnosticState, {
      reason: resetConnectedAt ? "page_navigation" : "execution_context_reset",
      writeSnapshotStatus: quickPlayDiagnosticState?.active === true,
      preserveDiagnostics: true,
      log: (message) => console.log(message)
    }).catch(() => undefined);
    cancelNextGameReacquire(nextGameReacquireState, {
      reason: "browser_reset",
      log: (message) => console.log(message)
    });
    cancelPostGameInteractionWatch(postGameInteractionWatchState, {
      reason: "browser_reset",
      log: (message) => console.log(message)
    });
    notifyObserverTargetReset(
      resetConnectedAt ? "page_navigation" : "execution_context_reset"
    );
    console.log("[browser] browser target state reset");
  };
  cdp.on("Page.frameNavigated", (event) => {
    if (event?.frame?.parentId) {
      return;
    }
    resetBrowserTargetState({ resetConnectedAt: true });
    disarmClosureCaptureWindow(closureCaptureState, {
      reason: "page_navigated"
    });
    void installInteractionTrackerForCurrentDocument();
  });
  cdp.on("Runtime.executionContextsCleared", () => {
    resetBrowserTargetState();
    disarmClosureCaptureWindow(closureCaptureState, {
      reason: "execution_context_cleared"
    });
    void installInteractionTrackerForCurrentDocument();
  });
  cdp.on("Runtime.executionContextCreated", (event) => {
    const auxData = event?.context?.auxData ?? null;
    if (auxData && auxData.isDefault === false) {
      return;
    }
    void installInteractionTrackerForCurrentDocument();
  });
  const control = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false
  });
  control.on("line", (line) => {
    if (!line?.trim()) {
      return;
    }
    let message = null;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    applyBrowserControlMessage({
      message,
      controlState: browserControlState,
      closureCaptureState,
      nextGameReacquireState,
      quickPlayDiagnosticState,
      onModeChanged: () => {
        notifyObserverModeControl();
        resetZenithBootstrapCheckState(zenithBootstrapCheckState);
        void releaseQuickPlayPassiveState(cdp, quickPlayDiagnosticState, {
          reason: "mode_changed",
          writeSnapshotStatus: false,
          preserveDiagnostics: true,
          log: (entry) => console.log(entry)
        }).catch(() => undefined);
        if (quickPlayDiagnosticState.active) {
          stopQuickPlayDiagnosticCapture(quickPlayDiagnosticState, {
            now: Date.now(),
            reason: "mode_changed",
            log: (entry) => console.log(entry)
          });
        }
        clearModeRuntimeState("mode_change");
      },
      onBotEnabled: () => {
        notifyObserverModeControl();
        if (isZenithModeActive(browserControlState)) {
          ensureZenithBootstrapCheckScheduled(
            zenithBootstrapCheckState,
            browserControlState,
            {
              now: Date.now(),
              log: (entry) => console.log(entry)
            }
          );
        } else {
          resetZenithBootstrapCheckState(zenithBootstrapCheckState);
        }
      },
      onBotDisabled: () => {
        notifyObserverModeControl();
        resetZenithBootstrapCheckState(zenithBootstrapCheckState);
        clearModeRuntimeState("bot_off");
      },
      onQuickPlayDiagnosticStart: () => {
        notifyObserverModeControl();
      },
      onQuickPlayDiagnosticStop: () => {
        notifyObserverModeControl();
      },
      bootstrapReady: isBootstrapReadyForClosureCapture(bootstrapState),
      log: (entry) => console.log(entry)
    });
    if (message?.type === "bot_enabled" && message.enabled === false) {
      void releaseQuickPlayPassiveState(cdp, quickPlayDiagnosticState, {
        reason: "bot_off",
        writeSnapshotStatus: quickPlayDiagnosticState?.active === true,
        preserveDiagnostics: true,
        log: (entry) => console.log(entry)
      }).catch(() => undefined);
      cancelPostGameInteractionWatch(postGameInteractionWatchState, {
        reason: "bot_off",
        log: (entry) => console.log(entry)
      });
      void releaseEndedGameCandidateHandle(cdp, endedGameCandidate, {
        reason: "bot_off",
        log: (entry) => console.log(entry)
      }).catch(() => undefined);
    }
  });

  let gameEpoch = 1;
  let waitingForNextGame = false;
  let waitingForNextGameSignalCutoffAt = 0;
  let endedHandled = false;
  let lastReason = "";
  let lastReasonAt = 0;
  const snapshotTracking = createSnapshotTracking();
  const probeState = {
    lastCaptureAt: 0
  };

  const stop = async () => {
    if (typeof dddWsObserverCleanup === "function") {
      try {
        dddWsObserverCleanup();
      } catch {}
      dddWsObserverCleanup = null;
    }
    if (quickPlayDiagnosticState.active) {
      stopQuickPlayDiagnosticCapture(quickPlayDiagnosticState, {
        now: Date.now(),
        reason: "shutdown",
        log: (message) => console.log(message)
      });
      await releaseQuickPlayPassiveState(cdp, quickPlayDiagnosticState, {
        reason: "shutdown",
        writeSnapshotStatus: false,
        preserveDiagnostics: true,
        log: (message) => console.log(message)
      }).catch(() => undefined);
    }
    resetBrowserTargetState();
    clearPendingClosureCaptureArm(closureCaptureState);
    await releaseEndedGameCandidateHandle(cdp, endedGameCandidate, {
      reason: "chromium_shutdown",
      log: (message) => console.log(message)
    }).catch(() => undefined);
    await cdp.close().catch(() => undefined);
    if (ownsChromium && browserProcess) {
      await shutdownChromium(browserProcess);
    }
  };
  process.on("SIGINT", () => stop().finally(() => process.exit(0)));
  process.on("SIGTERM", () => stop().finally(() => process.exit(0)));

  while (true) {
    try {
      const loopNow = Date.now();
      maxEventLoopDelayMs = Math.max(
        maxEventLoopDelayMs,
        Math.max(0, loopNow - (loopStartedAt + pollMs))
      );
      loopStartedAt = loopNow;
      if (isZenithModeActive(browserControlState)) {
        ensureZenithBootstrapCheckScheduled(
          zenithBootstrapCheckState,
          browserControlState,
          {
            now: loopNow,
            log: (entry) => console.log(entry)
          }
        );
        await maybeRunZenithBootstrapCheck({
          cdp,
          zenithBootstrapCheckState,
          browserControlState,
          bootstrapState,
          transientState,
          now: loopNow,
          onBootstrapReady: notifyObserverBootstrapReady,
          log: (entry) => console.log(entry)
        });
      } else {
        resetZenithBootstrapCheckState(zenithBootstrapCheckState);
      }
      if (quickPlayDiagnosticState.active) {
        await maybeRunQuickPlayDiagnosticCapture({
          cdp,
          quickPlayDiagnosticState,
          browserControlState,
          transientState,
          targetUrl: target.url ?? "",
          now: loopNow,
          log: (entry) => console.log(entry)
        });
      }
      if (!isSoloModeActive(browserControlState)) {
        const perfUpdate = maybeLogBrowserPerf({
          browserPerfEnabled,
          lastPerfLoggedAt,
          maxEventLoopDelayMs
        });
        if (perfUpdate) {
          lastPerfLoggedAt = perfUpdate.lastPerfLoggedAt;
          maxEventLoopDelayMs = perfUpdate.maxEventLoopDelayMs;
        }
        await sleep(pollMs);
        continue;
      }
      const previousGameplayPhase = String(probeState.lastGameplayPhase ?? "inactive");
      const state = await readTetrioState(cdp, {
        probePageState,
        useSeedSimulationFallback,
        network,
        probeState,
        bootstrapState,
        transientState,
        browserControlState,
        suppressClosureCapture: vsWsSimEnabled && vsRoundActive,
        activeRoundId: vsRoundActive ? vsRoundId : "",
        closureCaptureState,
        nextGameReacquireState,
        postGameInteractionWatchState,
        endedGameCandidate,
        waitingForNextGame,
        suppressedReason: DEFAULT_SUPPRESSED_REASON,
        perfEnabled: browserPerfEnabled,
        initialCaptureSignalProbe: true,
        targetUrl: target.url ?? "",
        candidateTraceEnabled: closureCandidateTraceEnabled,
        onBootstrapReady: notifyObserverBootstrapReady
      });

      if (
        isSoloModeActive(browserControlState) &&
        !waitingForNextGame &&
        !postGameInteractionWatchState.active &&
        previousGameplayPhase === "playing" &&
        state?.playing !== true
      ) {
        await primePostGameInteractionWatchBaseline(cdp, postGameInteractionWatchState, {
          now: Date.now(),
          transientState,
          log: (message) => console.log(message),
          nextGameReacquireState
        });
      }

      if (
        postGameInteractionWatchState.active &&
        !waitingForNextGame &&
        state?.playing === true
      ) {
        setNextGameInteractionPhase(
          nextGameReacquireState,
          NEXT_GAME_INTERACTION_PHASE_INACTIVE
        );
        cancelPostGameInteractionWatch(postGameInteractionWatchState, {
          reason: "playing_resumed",
          log: (message) => console.log(message)
        });
      }

      if (shouldHandleEndedGame(state, endedHandled)) {
        endedHandled = true;
        waitingForNextGame = true;
        const preserveProvisionalWindow =
          isClosureCaptureArmed(closureCaptureState, Date.now()) &&
          isAgainButtonProvisionalInteraction(nextGameReacquireState) &&
          Math.max(0, Number(nextGameReacquireState.interactionWindowGeneration ?? 0)) > 0;
        const preservedWindowGeneration = Math.max(
          0,
          Number(nextGameReacquireState.interactionWindowGeneration ?? 0)
        );
        const preservedWindowArmedAt = Math.max(
          0,
          Number(nextGameReacquireState.interactionWindowArmedAt ?? 0)
        );
        const preservedProvisionalInteraction = {
          generation: Math.max(0, Number(nextGameReacquireState.provisionalInteractionGeneration ?? 0)),
          timestamp: Math.max(0, Number(nextGameReacquireState.provisionalInteractionTimestamp ?? 0)),
          key: String(nextGameReacquireState.provisionalInteractionKey ?? ""),
          trusted: nextGameReacquireState.provisionalInteractionTrusted === true,
          kind: String(nextGameReacquireState.provisionalInteractionKind ?? ""),
          transitionReady: nextGameReacquireState.provisionalTransitionReady === true,
          transitionReadyLoggedAt: Math.max(0, Number(nextGameReacquireState.provisionalTransitionReadyLoggedAt ?? 0))
        };

        await markCurrentGameAsEnded(cdp);

        resetSnapshotTracking(snapshotTracking);
        probeState.lastCaptureAt = 0;
        resetTetrioNetworkState(network);
        if (!preserveProvisionalWindow) {
          disarmClosureCaptureWindow(closureCaptureState, {
            reason: "game_ended"
          });
        }
        clearSnapshotFile(snapshotPath);
        waitingForNextGameSignalCutoffAt =
          Math.max(0, Date.now() - DEFAULT_GAME_START_SIGNAL_OVERLAP_MS);
        advanceGameStartSignalGeneration(gameStartSignalState, {
          preserveSince: waitingForNextGameSignalCutoffAt
        });

        console.log(`[browser] game session ended epoch=${gameEpoch}`);
        console.log("[browser] cleared ended game cache; waiting for next game");
        await retainEndedGameCandidateHandle(cdp, endedGameCandidate, {
          locator: closureCaptureState.lastSuccessfulLocator,
          epoch: gameEpoch,
          endedAt: Date.now(),
          lastPlaying: false,
          lastPieceCounter: Number(state.pieceCounter ?? -1),
          lastSignature: snapshotTracking.lastWrittenSignature,
          transientState,
          log: (message) => console.log(message)
        });
        if (isSoloModeActive(browserControlState)) {
          startNextGameReacquire(nextGameReacquireState, {
            now: Date.now(),
            epoch: gameEpoch,
            locator: endedGameCandidate.locator
              ? `closure:${endedGameCandidate.locator}`
              : "",
            interactionBaselineGeneration: Math.max(
              0,
              Number(postGameInteractionWatchState.interactionBaselineGeneration ?? 0)
            ),
            log: (message) => console.log(message)
          });
          const carriedPending = carryPendingPostGameInteractionIntoReacquire(
            postGameInteractionWatchState,
            nextGameReacquireState,
            {
              log: (message) => console.log(message)
            }
          );
          if (!carriedPending && !postGameInteractionWatchState.active) {
            await primeNextGameInteractionBaseline(cdp, nextGameReacquireState, {
              transientState,
              log: (message) => console.log(message)
            });
          } else {
            nextGameReacquireState.lastInteractionGenerationSeen = Math.max(
              Math.max(0, Number(nextGameReacquireState.lastInteractionGenerationSeen ?? 0)),
              Math.max(0, Number(postGameInteractionWatchState.lastInteractionGenerationSeen ?? 0))
            );
          }
          if (preserveProvisionalWindow) {
            nextGameReacquireState.interactionWindowGeneration = preservedWindowGeneration;
            nextGameReacquireState.interactionWindowArmedAt = preservedWindowArmedAt;
            nextGameReacquireState.provisionalInteractionGeneration = preservedProvisionalInteraction.generation;
            nextGameReacquireState.provisionalInteractionTimestamp = preservedProvisionalInteraction.timestamp;
            nextGameReacquireState.provisionalInteractionKey = preservedProvisionalInteraction.key;
            nextGameReacquireState.provisionalInteractionTrusted = preservedProvisionalInteraction.trusted;
            nextGameReacquireState.provisionalInteractionKind = preservedProvisionalInteraction.kind;
            nextGameReacquireState.provisionalTransitionReady = preservedProvisionalInteraction.transitionReady;
            nextGameReacquireState.provisionalTransitionReadyLoggedAt = preservedProvisionalInteraction.transitionReadyLoggedAt;
            setNextGameInteractionPhase(
              nextGameReacquireState,
              preservedProvisionalInteraction.transitionReady
                ? NEXT_GAME_INTERACTION_PHASE_REACQUIRING
                : NEXT_GAME_INTERACTION_PHASE_WAITING_TRANSITION_READY
            );
            console.log(
              `[browser] provisional capture promoted after end confirmation generation=${preservedWindowGeneration}`
            );
            console.log(
              `[browser] provisional window preserved across game end confirmation generation=${preservedWindowGeneration}`
            );
          }
          if (carriedPending && isBootstrapReadyForClosureCapture(bootstrapState)) {
            console.log(
              `[browser] carried interaction requesting capture generation=${Math.max(
                0,
                Number(nextGameReacquireState.pendingInteractionGeneration ?? 0)
              )}`
            );
            armPendingNextGameInteractionWindow(
              closureCaptureState,
              nextGameReacquireState,
              {
                now: Date.now(),
                bootstrapReady: true,
                log: (message) => console.log(message),
                logPrefix: "carried interaction armed"
              }
            );
          } else if (carriedPending) {
            nextGameReacquireState.pendingArmReason = "next_game_carried_interaction";
            console.log(
              `[browser] carried interaction arm deferred generation=${Math.max(
                0,
                Number(nextGameReacquireState.pendingInteractionGeneration ?? 0)
              )} reason=bootstrap_not_ready`
            );
          }
        }
        resetPostGameInteractionWatch(postGameInteractionWatchState);
      }

      if (
        isSoloModeActive(browserControlState) &&
        waitingForNextGame &&
        hasUnconsumedGameStartSignal(gameStartSignalState, {
          since: waitingForNextGameSignalCutoffAt
        })
      ) {
        const signal = consumeGameStartSignal(gameStartSignalState, {
          since: waitingForNextGameSignalCutoffAt
        });
        if (signal) {
          console.log(
            `[browser] solo signal consumed key=${signal.key} source=${signal.source}`
          );
          console.log(`[browser] game-start signal source=${signal.source}`);
          applyGameStartSignalToNetwork(network, signal);
          requestClosureCaptureArm(closureCaptureState, {
            reason: "game_start_signal",
            now: Date.now(),
            bootstrapReady: isBootstrapReadyForClosureCapture(bootstrapState),
            log: (message) => console.log(message)
          });
          console.log(
            `[browser] game-start transition armed epoch_candidate=${gameEpoch + 1}`
          );
        }
      }

      if (isTetrioGameEndedState(state)) {
        const perfUpdate = maybeLogBrowserPerf({
          browserPerfEnabled,
          lastPerfLoggedAt,
          maxEventLoopDelayMs
        });
        if (perfUpdate) {
          lastPerfLoggedAt = perfUpdate.lastPerfLoggedAt;
          maxEventLoopDelayMs = perfUpdate.maxEventLoopDelayMs;
        }
        await sleep(pollMs);
        continue;
      }

      if (!state.ok || !state.ready || !state.playing || state.countdown) {
        const reason =
          state.reason ??
          (!state.playing
            ? "page is not playing"
            : state.countdown
              ? "countdown active"
              : "state not ready");
        const now = Date.now();
        if (shouldLogStateReason({
          reason,
          lastReason,
          lastReasonAt,
          now,
          suppressRepeatedReason: state.reason === DEFAULT_SUPPRESSED_REASON
        })) {
          console.log(`[browser] ${reason}`);
          lastReason = reason;
          lastReasonAt = now;
        }
        const perfUpdate = maybeLogBrowserPerf({
          browserPerfEnabled,
          lastPerfLoggedAt,
          maxEventLoopDelayMs
        });
        if (perfUpdate) {
          lastPerfLoggedAt = perfUpdate.lastPerfLoggedAt;
          maxEventLoopDelayMs = perfUpdate.maxEventLoopDelayMs;
        }
        await sleep(pollMs);
        continue;
      }

      if (shouldAdvanceGameEpoch(state, waitingForNextGame)) {
        gameEpoch += 1;
        waitingForNextGame = false;
        waitingForNextGameSignalCutoffAt = 0;
        endedHandled = false;
        setNextGameInteractionPhase(
          nextGameReacquireState,
          NEXT_GAME_INTERACTION_PHASE_INACTIVE
        );
        resetPostGameInteractionWatch(postGameInteractionWatchState);
        resetSnapshotTracking(snapshotTracking);
        console.log(`[browser] new game detected epoch=${gameEpoch}`);
        completeNextGameReacquire(nextGameReacquireState, {
          epoch: gameEpoch,
          log: (message) => console.log(message)
        });
      }

      lastReason = "";
      lastReasonAt = 0;

      const pieceKey = `${gameEpoch}:${state.pieceCounter}`;
      if (pieceKey !== snapshotTracking.pendingPieceKey) {
        snapshotTracking.pendingPieceKey = pieceKey;
        snapshotTracking.pendingPieceDetectedAt = Date.now();
      }

      const signature = buildSnapshotSignature(gameEpoch, state);
      if (signature === snapshotTracking.stableSignature) {
        snapshotTracking.stableCount += 1;
      } else {
        snapshotTracking.stableSignature = signature;
        snapshotTracking.stableCount = 1;
      }

      if (snapshotTracking.stableCount < 2) {
        await sleep(pollMs);
        continue;
      }

      const snapshot = {
        ok: true,
        source: "browser_cdp",
        field: state.field,
        current: state.current.toUpperCase(),
        hold: state.hold ? state.hold.toUpperCase() : null,
        queue: state.queue.map((piece) => piece.toUpperCase()),
        b2b: Boolean(state.b2b),
        combo: state.combo,
        incoming: state.incoming,
        pieceCounter: state.pieceCounter,
        token: buildSnapshotToken(gameEpoch, state.pieceCounter),
        playing: state.playing,
        countdown: state.countdown,
        activeX: Number.isFinite(state.activeX) ? state.activeX : undefined,
        activeY: Number.isFinite(state.activeY) ? state.activeY : undefined,
        activeRotation: state.activeRotation ?? undefined
      };

      if (signature !== snapshotTracking.lastWrittenSignature) {
        writeSnapshot(snapshotPath, snapshot);
        snapshotTracking.lastWrittenSignature = signature;
        if (
          pieceKey === snapshotTracking.pendingPieceKey &&
          pieceKey !== snapshotTracking.lastPerfLoggedPieceKey
        ) {
          snapshotTracking.lastPerfLoggedPieceKey = pieceKey;
          if (browserPerfEnabled) {
            console.log(
              `[browser-perf] piece_change_to_snapshot_ms=${Math.max(0, Date.now() - snapshotTracking.pendingPieceDetectedAt)}`
            );
          }
        }
        if (snapshot.token !== snapshotTracking.lastLoggedToken) {
          snapshotTracking.lastLoggedToken = snapshot.token;
          console.log(
            `[browser] page state ready pieceCounter=${state.pieceCounter} current=${snapshot.current} hold=${snapshot.hold ?? "-"} queue=${snapshot.queue.join(",")}`
          );
        }
      }

      const perfUpdate = maybeLogBrowserPerf({
        browserPerfEnabled,
        lastPerfLoggedAt,
        maxEventLoopDelayMs
      });
      if (perfUpdate) {
        lastPerfLoggedAt = perfUpdate.lastPerfLoggedAt;
        maxEventLoopDelayMs = perfUpdate.maxEventLoopDelayMs;
      }

      await sleep(pollMs);
    } catch (error) {
      if (isTransientRuntimeError(error)) {
        maybeLogTransientRuntimeError(error, transientState);
        await sleep(Math.max(50, pollMs));
        continue;
      }
      throw error;
    }
  }
}

async function markCurrentGameAsEnded(cdp) {
  await safeRuntimeEvaluate(cdp, {
    expression: `(() => {
      if (window.__fusionTetrioGame) {
        window.__fusionEndedTetrioGame = window.__fusionTetrioGame;
      }

      delete window.__fusionTetrioGame;
      delete window.__fusionTetrioBridge;

      return true;
    })()`,
    returnByValue: true
  }).catch(() => undefined);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "1";
      continue;
    }
    parsed[key] = next;
    i++;
  }
  return parsed;
}

function numberArg(value, fallback) {
  const parsed = Number.parseInt(value ?? `${fallback}`, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function loadOptionalMsgpack() {
  try {
    return await import("msgpackr");
  } catch {
    console.log("[browser] msgpackr not installed; ribbon seed parsing will be best-effort only");
    return null;
  }
}

async function findOrCreateTarget({ port, url, targetHint }) {
  const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  const pages = list.filter((item) => item.type === "page");
  const hinted = pages.find(
    (item) =>
      item.url?.toLowerCase().includes(targetHint.toLowerCase()) ||
      item.title?.toLowerCase().includes(targetHint.toLowerCase())
  );
  const matchingUrl = pages.find((item) => item.url === url);
  const matchingHost = pages.find((item) => {
    try {
      return new URL(item.url).host === new URL(url).host;
    } catch {
      return false;
    }
  });
  const existing = hinted ?? matchingUrl ?? matchingHost ?? pages[0];
  if (existing?.webSocketDebuggerUrl) return existing;
  return await fetchJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT"
  });
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
  return await response.json();
}

class CdpClient {
  static connect(webSocketDebuggerUrl) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(webSocketDebuggerUrl);
      const client = new CdpClient(socket);
      socket.addEventListener("open", () => resolve(client), { once: true });
      socket.addEventListener("error", (event) => reject(event.error ?? event), { once: true });
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        if (message.method) this.emit(message.method, message.params ?? {});
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }

  on(method, handler) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(handler);
    this.listeners.set(method, listeners);
    return () => this.off(method, handler);
  }

  off(method, handler) {
    const listeners = this.listeners.get(method);
    if (!listeners) return;
    listeners.delete(handler);
    if (listeners.size === 0) this.listeners.delete(method);
  }

  emit(method, params) {
    const listeners = this.listeners.get(method);
    if (!listeners) return;
    for (const handler of [...listeners]) handler(params);
  }

  waitForEvent(method, predicate = () => true, timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, Math.max(1, timeoutMs));
      const handler = (params) => {
        if (!predicate(params)) return;
        cleanup();
        resolve(params);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.off(method, handler);
      };
      this.on(method, handler);
    });
  }

  send(method, params = {}) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP socket is not open"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
    return Promise.resolve();
  }
}

function createTetrioNetworkState() {
  return {
    seed: null,
    nextCount: DEFAULT_NEXT_COUNT,
    readyAt: 0,
    ribbonSeen: false,
    lastPageProbeAt: 0
  };
}

export function resetTetrioNetworkState(network) {
  if (!network) {
    return false;
  }
  network.seed = null;
  network.nextCount = DEFAULT_NEXT_COUNT;
  network.readyAt = 0;
  network.ribbonSeen = false;
  network.lastPageProbeAt = 0;
  return true;
}

async function installBackgroundInputKeepalive(cdp) {
  const source = `(() => {
    if (window.__fusionBackgroundInputKeepalive) return window.__fusionBackgroundInputKeepalive;
    const defineGetter = (target, key, value) => {
      try {
        Object.defineProperty(target, key, {
          configurable: true,
          get: () => value
        });
      } catch {}
    };

    defineGetter(Document.prototype, "hidden", false);
    defineGetter(Document.prototype, "visibilityState", "visible");
    defineGetter(document, "hidden", false);
    defineGetter(document, "visibilityState", "visible");

    try {
      document.hasFocus = () => true;
    } catch {}

    window.addEventListener(
      "blur",
      (event) => {
        event.stopImmediatePropagation();
      },
      true
    );
    document.addEventListener(
      "visibilitychange",
      (event) => {
        event.stopImmediatePropagation();
      },
      true
    );

    window.__fusionBackgroundInputKeepalive = {
      at: Date.now()
    };
    return window.__fusionBackgroundInputKeepalive;
  })()`;

  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source }).catch(() => undefined);
  await cdp.send("Runtime.evaluate", {
    expression: source,
    returnByValue: true
  }).catch(() => undefined);
}

async function installRibbonMonitor(
  cdp,
  network,
  msgpack,
  bootstrapState,
  { onGameplaySignal = null } = {}
) {
  await cdp.send("Network.enable").catch(() => undefined);
  cdp.on("Network.webSocketCreated", (event) => {
    if (/spool\.tetr\.io\/ribbon/i.test(event?.url ?? "")) {
      network.ribbonSeen = true;
      markBootstrapTransportReady(bootstrapState);
      console.log("[browser] ribbon websocket opened");
    }
  });
  if (!msgpack?.unpack) return;
  const handleFrame = (event) => {
    const payload = event?.response?.payloadData;
    if (!payload) return;
    const buffer = event?.response?.opcode === 2 ? Buffer.from(payload, "base64") : Buffer.from(payload, "utf8");
    inspectRibbonPayload(buffer, network, msgpack.unpack, onGameplaySignal);
  };
  cdp.on("Network.webSocketFrameReceived", handleFrame);
  cdp.on("Network.webSocketFrameSent", handleFrame);
}

function inspectRibbonPayload(
  payload,
  network,
  unpack,
  onGameplaySignal = null
) {
  const candidates = [];
  for (let offset = 0; offset <= Math.min(24, payload.length - 1); offset++) {
    try {
      candidates.push(unpack(payload.subarray(offset)));
    } catch {}
  }
  for (const decoded of candidates) {
    const options = findOptionsObject(decoded);
    if (options?.seed !== undefined && options?.bagtype !== undefined) {
      if (isZenithGameplayOptions(options)) {
        return;
      }
      const countdownMs = estimateCountdownWait(options);
      network.seed = String(options.seed);
      network.nextCount = Math.max(
        1,
        Number.parseInt(options.nextcount ?? `${DEFAULT_NEXT_COUNT}`, 10) || DEFAULT_NEXT_COUNT
      );
      network.readyAt = Date.now() + countdownMs;
      console.log(`[browser] ribbon seed captured seed=${network.seed}`);
      onGameplaySignal?.({
        key: `ribbon:${String(options.seed)}:${String(options.gameid ?? "")}`,
        source: "ribbon_seed",
        details: {
          seed: String(options.seed),
          gameid: options.gameid ?? null,
          nextCount: network.nextCount,
          countdownMs,
          readyAt: network.readyAt
        }
      });
      return;
    }
  }
}

function findOptionsObject(root) {
  let found = null;
  walkObject(root, (value) => {
    if (found || !value || typeof value !== "object") return;
    if (Object.hasOwn(value, "seed") && Object.hasOwn(value, "bagtype")) {
      found = value;
    } else if (
      value.options &&
      typeof value.options === "object" &&
      Object.hasOwn(value.options, "seed") &&
      Object.hasOwn(value.options, "bagtype")
    ) {
      found = value.options;
    }
  });
  return found;
}

function walkObject(value, visit) {
  if (!value || typeof value !== "object") return;
  visit(value);
  if (Array.isArray(value)) {
    value.forEach((item) => walkObject(item, visit));
    return;
  }
  for (const child of Object.values(value)) walkObject(child, visit);
}

function estimateCountdownWait(options) {
  if (options?.countdown === false) return 0;
  const count = finiteNumber(options?.countdown_count);
  const interval = finiteNumber(options?.countdown_interval);
  const pre = finiteNumber(options?.precountdown);
  if (count !== null && interval !== null) {
    return normalizeDuration(pre ?? 0) + count * normalizeDuration(interval) + 250;
  }
  return 4500;
}

function normalizeDuration(value) {
  return value > 0 && value < 60 ? value * 1000 : value;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function readBootstrapPageState(
  cdp,
  bootstrapState,
  now,
  transientState,
  log = console.log
) {
  const raw = await safeRuntimeEvaluate(cdp, {
    expression: `(() => ({
      readyState: document.readyState,
      href: location.href
    }))()`,
    returnByValue: true
  }, {
    result: {
      value: {
        readyState: "loading",
        href: ""
      }
    }
  }, {
    transientState,
    log
  });
  const pageState = raw?.result?.value ?? { readyState: "loading", href: "" };
  updateBootstrapDocumentState(bootstrapState, pageState, now);
  return pageState;
}

async function retainEndedGameCandidateHandle(
  cdp,
  endedGameCandidate,
  {
    locator = "",
    epoch = 0,
    endedAt = Date.now(),
    lastPlaying = false,
    lastPieceCounter = -1,
    lastSignature = "",
    transientState = null,
    log = console.log
  } = {}
) {
  if (!endedGameCandidate) {
    return false;
  }
  const raw = await safeRuntimeEvaluate(cdp, {
    expression: "window.__fusionEndedTetrioGame || window.__fusionTetrioGame || null",
    objectGroup: "fusion-ended-game",
    silent: true
  }, null, {
    transientState,
    log
  });
  const objectId = String(raw?.result?.objectId ?? "");
  if (!objectId) {
    if (typeof log === "function") {
      log("[browser] ended game object retained epoch=0 object_id_present=false locator=");
    }
    return false;
  }
  endedGameCandidate.objectId = objectId;
  endedGameCandidate.locator = String(locator ?? "");
  endedGameCandidate.epoch = Math.max(0, Number(epoch ?? 0));
  endedGameCandidate.endedAt = endedAt;
  endedGameCandidate.lastPlaying = Boolean(lastPlaying);
  endedGameCandidate.lastPieceCounter = Number.isFinite(lastPieceCounter)
    ? Math.max(0, Math.floor(lastPieceCounter))
    : -1;
  endedGameCandidate.lastSignature = String(lastSignature ?? "");
  if (typeof log === "function") {
    log(
      `[browser] ended game object retained epoch=${endedGameCandidate.epoch} object_id_present=true locator=${
        endedGameCandidate.locator ? `closure:${endedGameCandidate.locator}` : ""
      }`
    );
  }
  return true;
}

function endedGameCandidateProbeExpression() {
  return `function(lastEndedPieceCounter, lastSignature) {
    try {
      const normalizePiece = (piece) => {
        if (typeof piece === "string") {
          const token = piece.trim().toLowerCase();
          return ["i", "o", "t", "s", "z", "j", "l"].includes(token) ? token : null;
        }
        if (piece && typeof piece === "object") {
          return normalizePiece(piece.type ?? piece.name ?? piece.kind ?? piece.id);
        }
        return null;
      };
      const numberFrom = (...values) => {
        for (const value of values) {
          const next = Number(value);
          if (Number.isFinite(next)) return next;
        }
        return null;
      };
      const rowCells = (row) => Array.isArray(row) ? row : Array.isArray(row?.cells) ? row.cells : null;
      const filled = (cell) => cell !== null && cell !== undefined && cell !== 0 && cell !== false;
      const queueFrom = (...sources) => {
        for (const source of sources) {
          if (!Array.isArray(source)) continue;
          const queue = source.map((piece) => normalizePiece(piece)).filter(Boolean);
          if (queue.length > 0) return queue;
        }
        return [];
      };
      if (
        !this ||
        typeof this !== "object" ||
        typeof this.ejectState !== "function" ||
        typeof this.ejectBoardState !== "function"
      ) {
        return { status: "invalid_shape" };
      }
      const exported = this.ejectState();
      const boardState = this.ejectBoardState();
      const state = exported && typeof exported === "object" && exported.game ? exported.game : exported;
      if (!state || typeof state !== "object") {
        return { status: "invalid_shape" };
      }
      const activeState = state.falling ?? state.active ?? state.current ?? state.piece;
      const current = normalizePiece(activeState);
      const hold = normalizePiece(state.hold ?? state.held);
      const queue = queueFrom(state.bag, state.queue, state.next, state.preview, state.previews, state.pieces);
      const board = Array.isArray(state.board) ? state.board : Array.isArray(boardState?.b) ? boardState.b : null;
      const playing =
        typeof this.isPlaying === "function" ? Boolean(this.isPlaying()) :
        typeof state.playing === "boolean" ? state.playing :
        typeof state.paused === "boolean" ? !state.paused :
        true;
      const started =
        typeof this.isStarted === "function" ? Boolean(this.isStarted()) :
        Boolean(state.started ?? true);
      const destroyed = Boolean(state.destroyed || state.dead || state.gameover);
      const countdown = started && !destroyed && !playing;
      const ready = started && !destroyed;
      const pieceCounter = Math.max(0, Math.floor(numberFrom(
        state?.stats?.piecesplaced,
        state?.stats?.piecesPlaced,
        state?.stats?.pieces,
        state.piecesplaced,
        state.piecesPlaced,
        state.pieceCounter,
        state.piececount,
        0
      ) ?? 0));
      if (!ready || (!playing && !countdown)) {
        return {
          status: "valid_ended",
          playing,
          countdown,
          pieceCounter
        };
      }
      if (!current || queue.length === 0 || !Array.isArray(board) || board.length === 0) {
        return { status: "invalid_shape" };
      }
      const field = Array.from({ length: 40 }, (_, rowIndex) => {
        const sourceRow = board[board.length - 1 - rowIndex];
        const cells = rowCells(sourceRow);
        return Array.from({ length: 10 }, (_, x) => filled(cells ? cells[x] : null));
      });
      const signature =
        String(pieceCounter) + "|" + String(current) + "|" + String(hold ?? "-") + "|" + queue.join(",");
      return {
        status: playing ? "valid_playing" : "valid_countdown",
        reactivated:
          pieceCounter <= 3 ||
          (Number.isFinite(lastEndedPieceCounter) && lastEndedPieceCounter >= 0 && pieceCounter < lastEndedPieceCounter) ||
          signature !== String(lastSignature || ""),
        state: {
          ok: true,
          ready,
          reason: null,
          field,
          current,
          hold,
          queue,
          b2b: Math.max(0, numberFrom(state?.stats?.b2b, state.b2b, 0) ?? 0) > 0,
          combo: Math.max(0, numberFrom(state?.stats?.combo, state.combo, 0) ?? 0),
          incoming: Math.max(0, numberFrom(state?.stats?.impendingdamage, state.incoming, 0) ?? 0),
          pieceCounter,
          playing,
          countdown
        }
      };
    } catch {
      return { status: "transient_error" };
    }
  }`;
}

async function readEndedGameCandidateState(
  cdp,
  endedGameCandidate,
  {
    log = console.log
  } = {}
) {
  const objectId = String(endedGameCandidate?.objectId ?? "");
  if (!objectId) {
    return { status: "object_released" };
  }
  try {
    const result = await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: endedGameCandidateProbeExpression(),
      arguments: [
        { value: endedGameCandidate?.lastPieceCounter ?? -1 },
        { value: endedGameCandidate?.lastSignature ?? "" }
      ],
      returnByValue: true,
      silent: true
    });
    return result?.result?.value ?? { status: "transient_error" };
  } catch (error) {
    const message = String(error?.message ?? error ?? "");
    if (/Cannot find context with specified id|Execution context was destroyed/i.test(message)) {
      return { status: "execution_context_destroyed" };
    }
    if (/objectId|object id/i.test(message) && /invalid|missing|null|undefined/i.test(message)) {
      return { status: "invalid_object_id" };
    }
    if (/Could not find object with given id|Cannot find object with id|Invalid remote object id/i.test(message)) {
      return { status: "object_released" };
    }
    return { status: "transient_error", reason: message };
  }
}

export function cheapGameSignalExpression() {
  return `(() => {
      const isVisible = (node, depth = 2) => {
        if (!node || typeof node !== "object" || node.isConnected !== true) return false;
        let current = node;
        let remaining = depth;
        while (current && remaining >= 0) {
          const style = window.getComputedStyle ? window.getComputedStyle(current) : null;
          if (!style) return false;
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse" ||
            Number(style.opacity) <= 0
          ) {
            return false;
          }
          current = current.parentElement;
          remaining -= 1;
        }
        const rect = typeof node.getBoundingClientRect === "function" ? node.getBoundingClientRect() : null;
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      };
      const firstVisible = (selector) =>
        Array.from(document.querySelectorAll(selector)).find((node) => isVisible(node)) || null;
      const textIncludes = (tokens) => {
        const text = String(document.body?.innerText ?? "").toLowerCase();
        return tokens.some((token) => text.includes(token));
      };
      const routeText = (String(location.pathname || "") + String(location.hash || "")).toLowerCase();
      const countdownNode = firstVisible("[class*='countdown'],[class*='ready'],[class*='start']");
      const resultNode = firstVisible("[class*='result'],[class*='summary'],[class*='finish']");
      const retryNode = firstVisible(
        "[class*='retry'],[data-action*='retry'],button[id*='retry'],button[class*='restart']"
      );
      const canvasNode = firstVisible("canvas");
      const gameplayNode = firstVisible("[class*='board'],[class*='matrix'],[class*='playfield'],[class*='hud'],[data-screen='game']");
      const countdownByText = textIncludes(["go!", "ready"]);
      const resultByText = textIncludes(["result", "finished"]);
      const routeGame = /play|solo|40l/.test(routeText) && !/result|summary|finish/.test(routeText);
      const routeResult = /result|summary|finish/.test(routeText);
      const resultVisible = Boolean(resultNode) || Boolean(retryNode) || resultByText || routeResult;
      const countdownVisible = Boolean(countdownNode) || countdownByText;
      const gameplayVisible = Boolean(gameplayNode) && routeGame;
      const canvasVisible = Boolean(canvasNode);
      const sources = [
        { source: "route_game", value: routeGame, state: routeGame ? "playing" : "inactive" },
        { source: "countdown_dom", value: countdownVisible, state: countdownVisible ? "countdown" : "inactive" },
        { source: "result_dom", value: resultVisible, state: resultVisible ? "result" : "inactive" },
        { source: "gameplay_dom", value: gameplayVisible, state: gameplayVisible ? "playing" : "inactive" },
        { source: "canvas_visible", value: canvasVisible, state: canvasVisible ? "visible" : "inactive" }
      ];
      let active = false;
      let source = "none";
      let label = "inactive";
      if (resultVisible && countdownVisible) {
        label = "ambiguous";
      } else if (resultVisible) {
        label = "result";
      } else if (countdownVisible) {
        active = true;
        source = "countdown_dom";
        label = "countdown";
      } else if (gameplayVisible) {
        active = true;
        source = "gameplay_dom";
        label = "playing";
      }
      return { active, source, label, sources };
    })()`;
}

async function readCheapGameSignal(
  cdp,
  {
    transientState = null,
    log = console.log
  } = {}
) {
  const raw = await safeRuntimeEvaluate(cdp, {
    expression: cheapGameSignalExpression(),
    returnByValue: true
  }, {
    result: {
      value: { active: false, source: "none", label: "inactive", sources: [] }
    }
  }, {
    transientState,
    log
  });
  return raw?.result?.value ?? { active: false, source: "none", label: "inactive", sources: [] };
}

function nextGameFastLocatorExpression(locatorName = "closure:Ai") {
  return `(() => {
    const normalizePiece = (piece) => {
      if (typeof piece === "string") {
        const token = piece.trim().toLowerCase();
        return ["i", "o", "t", "s", "z", "j", "l"].includes(token) ? token : null;
      }
      if (piece && typeof piece === "object") {
        return normalizePiece(piece.type ?? piece.name ?? piece.kind ?? piece.id);
      }
      return null;
    };
    const numberFrom = (...values) => {
      for (const value of values) {
        const next = Number(value);
        if (Number.isFinite(next)) return next;
      }
      return null;
    };
    const rowCells = (row) => Array.isArray(row) ? row : Array.isArray(row?.cells) ? row.cells : null;
    const filled = (cell) => cell !== null && cell !== undefined && cell !== 0 && cell !== false;
    const queueFrom = (...sources) => {
      for (const source of sources) {
        if (!Array.isArray(source)) continue;
        const queue = source.map((piece) => normalizePiece(piece)).filter(Boolean);
        if (queue.length > 0) return queue;
      }
      return [];
    };
    const readCandidate = (game) => {
      if (!game || typeof game !== "object" || typeof game.ejectState !== "function" || typeof game.ejectBoardState !== "function") {
        return null;
      }
      const exported = game.ejectState();
      const boardState = game.ejectBoardState();
      const state = exported && typeof exported === "object" && exported.game ? exported.game : exported;
      if (!state || typeof state !== "object") return null;
      const activeState = state.falling ?? state.active ?? state.current ?? state.piece;
      const current = normalizePiece(activeState);
      const queue = queueFrom(state.bag, state.queue, state.next, state.preview, state.previews, state.pieces);
      const board = Array.isArray(state.board) ? state.board : Array.isArray(boardState?.b) ? boardState.b : null;
      const playing =
        typeof game.isPlaying === "function" ? Boolean(game.isPlaying()) :
        typeof state.playing === "boolean" ? state.playing :
        typeof state.paused === "boolean" ? !state.paused :
        true;
      const started =
        typeof game.isStarted === "function" ? Boolean(game.isStarted()) :
        Boolean(state.started ?? true);
      const destroyed = Boolean(state.destroyed || state.dead || state.gameover);
      const countdown = started && !destroyed && !playing;
      const ready = started && !destroyed;
      if (!ready || (!playing && !countdown) || !current || queue.length === 0 || !Array.isArray(board) || board.length === 0) {
        return null;
      }
      const stats = state.stats ?? {};
      const field = Array.from({ length: 40 }, (_, rowIndex) => {
        const sourceRow = board[board.length - 1 - rowIndex];
        const cells = rowCells(sourceRow);
        return Array.from({ length: 10 }, (_, x) => filled(cells ? cells[x] : null));
      });
      return {
        ok: true,
        ready,
        reason: null,
        field,
        current,
        hold: normalizePiece(state.hold ?? state.held),
        queue,
        b2b: Math.max(0, numberFrom(stats.b2b, state.b2b, 0) ?? 0) > 0,
        combo: Math.max(0, numberFrom(stats.combo, state.combo, 0) ?? 0),
        incoming: Math.max(0, numberFrom(stats.impendingdamage, state.incoming, 0) ?? 0),
        pieceCounter: Math.max(0, Math.floor(numberFrom(
          stats.piecesplaced,
          stats.piecesPlaced,
          stats.pieces,
          state.piecesplaced,
          state.piecesPlaced,
          state.pieceCounter,
          state.piececount,
          0
        ) ?? 0)),
        playing,
        countdown
      };
    };
    for (const candidate of [window.__fusionEndedTetrioGame, window.__fusionTetrioGame]) {
      const state = readCandidate(candidate);
      if (!state) continue;
      window.__fusionTetrioGame = candidate;
      if (candidate === window.__fusionEndedTetrioGame) {
        delete window.__fusionEndedTetrioGame;
      }
      return {
        ok: true,
        locator: ${JSON.stringify(locatorName)},
        source: ${JSON.stringify(locatorName)},
        state
      };
    }
    return { ok: false };
  })()`;
}

async function probeNextGameViaFastLocator(
  cdp,
  {
    locator = "",
    transientState = null,
    log = console.log
  } = {}
) {
  const raw = await safeRuntimeEvaluate(cdp, {
    expression: nextGameFastLocatorExpression(`closure:${locator}`),
    returnByValue: true
  }, {
    result: {
      value: { ok: false }
    }
  }, {
    transientState,
    log
  });
  return raw?.result?.value ?? { ok: false };
}

async function readNextGameCheapSignal(
  cdp,
  {
    transientState = null,
    log = console.log
  } = {}
) {
  const raw = await safeRuntimeEvaluate(cdp, {
    expression: `(() => {
      try {
        const candidate = window.__fusionEndedTetrioGame || window.__fusionTetrioGame || null;
        if (!candidate || typeof candidate.ejectState !== "function") {
          return { active: false };
        }
        const exported = candidate.ejectState();
        const state = exported && typeof exported === "object" && exported.game ? exported.game : exported;
        const playing =
          typeof candidate.isPlaying === "function" ? Boolean(candidate.isPlaying()) :
          typeof state?.playing === "boolean" ? state.playing :
          typeof state?.paused === "boolean" ? !state.paused :
          false;
        const started =
          typeof candidate.isStarted === "function" ? Boolean(candidate.isStarted()) :
          Boolean(state?.started ?? false);
        const destroyed = Boolean(state?.destroyed || state?.dead || state?.gameover);
        return { active: Boolean(started && !destroyed && playing) };
      } catch {
        return { active: false };
      }
    })()`,
    returnByValue: true
  }, {
    result: {
      value: { active: false }
    }
  }, {
    transientState,
    log
  });
  return raw?.result?.value ?? { active: false };
}

export async function readTetrioState(cdp, options) {
  const now = options.now ?? Date.now();
  const log = options.log ?? console.log;
  const bootstrapState = options.bootstrapState ?? createBootstrapState(now);
  const browserControlState =
    options.browserControlState ?? createBrowserControlState();
  const closureCaptureState =
    options.closureCaptureState ?? createClosureCaptureState();
  const nextGameReacquireState =
    options.nextGameReacquireState ?? createNextGameReacquireState();
  const postGameInteractionWatchState =
    options.postGameInteractionWatchState ?? createPostGameInteractionWatchState();
  const endedGameCandidate =
    options.endedGameCandidate ?? createEndedGameCandidateState();
  const waitingForNextGame = Boolean(options.waitingForNextGame);
  const verboseReacquireLogs = options.verboseReacquireLogs === true;
  const soloBotEnabled = isSoloModeActive(browserControlState);
  if (
    nextGameReacquireState.active &&
    nextGameReacquireState.interactionPhase === NEXT_GAME_INTERACTION_PHASE_INACTIVE
  ) {
    setNextGameInteractionPhase(
      nextGameReacquireState,
      NEXT_GAME_INTERACTION_PHASE_REACQUIRING
    );
  } else if (
    !nextGameReacquireState.active &&
    postGameInteractionWatchState.active &&
    nextGameReacquireState.interactionPhase === NEXT_GAME_INTERACTION_PHASE_INACTIVE
  ) {
    setNextGameInteractionPhase(
      nextGameReacquireState,
      NEXT_GAME_INTERACTION_PHASE_POST_GAME_WATCH
    );
  }
  expireClosureCaptureWindow(closureCaptureState, now, { log });
  if (
    nextGameReacquireState.active &&
    waitingForNextGame &&
    nextGameReacquireState.interactionPhase ===
      NEXT_GAME_INTERACTION_PHASE_CAPTURE_ARMED &&
    !isClosureCaptureArmed(closureCaptureState, now)
  ) {
    setNextGameInteractionPhase(
      nextGameReacquireState,
      NEXT_GAME_INTERACTION_PHASE_REACQUIRING
    );
  }
  const pageState = await readBootstrapPageState(
    cdp,
    bootstrapState,
    now,
    options.transientState,
    log
  );
  const bootstrapStatus = getBootstrapReadinessStatus(bootstrapState, now);
  const bootstrapReady = bootstrapStatus.ready;
  const bootstrapReason = bootstrapStatus.reason;
  const bootstrapJustBecameReady = bootstrapReady && !bootstrapState.lastReady;
  if (
    options.probePageState &&
    !options.suppressClosureCapture &&
    !bootstrapReady &&
    !bootstrapState.waitingLogged
  ) {
    log("[browser] waiting for TETR.IO bootstrap before closure capture");
    bootstrapState.waitingLogged = true;
  }
  if (
    options.probePageState &&
    !options.suppressClosureCapture &&
    !bootstrapReady &&
    (soloBotEnabled ||
      hasPendingClosureCaptureArm(closureCaptureState) ||
      isClosureCaptureArmed(closureCaptureState, now)) &&
    shouldLogBootstrapBlocked(bootstrapState, bootstrapReason, now)
  ) {
    log("[browser] closure capture blocked reason=bootstrap_not_ready");
    log(`[browser] bootstrap readiness check failed reason=${bootstrapReason}`);
    markBootstrapBlockedLogged(bootstrapState, bootstrapReason, now);
  }
  if (
    options.probePageState &&
    !options.suppressClosureCapture &&
    bootstrapJustBecameReady &&
    !bootstrapState.readyLogged
  ) {
    try {
      options.onBootstrapReady?.();
    } catch {}
    log("[browser] TETR.IO bootstrap ready; closure capture enabled");
    bootstrapState.readyLogged = true;
  }
  if (
    nextGameReacquireState.active &&
    waitingForNextGame &&
    bootstrapReady &&
    nextGameReacquireState.interactionPhase ===
      NEXT_GAME_INTERACTION_PHASE_REACQUIRING &&
    Math.max(0, Number(nextGameReacquireState.pendingInteractionGeneration ?? 0)) >
      Math.max(0, Number(nextGameReacquireState.lastInteractionGenerationHandled ?? 0)) &&
    Math.max(0, Number(nextGameReacquireState.pendingInteractionTimestamp ?? 0)) >
      Math.max(0, Number(nextGameReacquireState.startedAt ?? 0))
  ) {
    const forceCarriedInteractionArm =
      String(nextGameReacquireState.pendingInteractionSource ?? "") === "post_game";
    const preserveExistingProvisionalWindow =
      forceCarriedInteractionArm &&
      isAgainButtonProvisionalInteraction(nextGameReacquireState) &&
      isClosureCaptureArmed(closureCaptureState, now) &&
      Math.max(0, Number(nextGameReacquireState.interactionWindowGeneration ?? 0)) ===
        Math.max(0, Number(nextGameReacquireState.pendingInteractionGeneration ?? 0));
    if (!forceCarriedInteractionArm && isClosureCaptureArmed(closureCaptureState, now)) {
      // Keep the currently armed one-shot window alive for non-carried interactions.
    } else if (preserveExistingProvisionalWindow) {
      if (typeof log === "function") {
        log(
          `[browser] provisional window preserved across game end confirmation generation=${Math.max(
            0,
            Number(nextGameReacquireState.pendingInteractionGeneration ?? 0)
          )}`
        );
      }
    } else {
    if (
      String(nextGameReacquireState.pendingInteractionSource ?? "") === "post_game"
    ) {
      log(
        `[browser] carried interaction requesting capture generation=${Math.max(
          0,
          Number(nextGameReacquireState.pendingInteractionGeneration ?? 0)
        )}`
      );
    }
    armPendingNextGameInteractionWindow(
      closureCaptureState,
      nextGameReacquireState,
      {
        now,
        bootstrapReady,
        log
      }
    );
    }
  }

  const read = async () => {
    const raw = await safeRuntimeEvaluate(cdp, {
      expression: tetrioStateExpression(),
      returnByValue: true
    }, {
      result: {
        value: {
          ok: false,
          ready: false,
          reason: "browser execution context not ready yet"
        }
      }
    }, {
      transientState: options.transientState,
      log
    });
    return raw.result?.value ?? { ok: false, ready: false, reason: "page probe returned empty" };
  };

  let state = await read();
  if (
    options.initialCaptureSignalProbe === true &&
    options.probePageState &&
    !options.suppressClosureCapture &&
    bootstrapReady &&
    soloBotEnabled &&
    !state.ok &&
    !nextGameReacquireState.active &&
    !postGameInteractionWatchState.active &&
    (!isClosureCaptureArmed(closureCaptureState, now) ||
      isClosureCaptureWindowExhausted(closureCaptureState)) &&
    now - Number(closureCaptureState.initialGameplayProbeAt ?? 0) >=
      DEFAULT_INITIAL_GAMEPLAY_SIGNAL_INTERVAL_MS
  ) {
    closureCaptureState.initialGameplayProbeAt = now;
    const signalFn = options.readCheapGameSignalFn ?? readCheapGameSignal;
    const cheapSignal = await signalFn(cdp, {
      transientState: options.transientState,
      log
    }).catch(() => ({ active: false, label: "inactive" }));
    const signalActive = cheapSignal?.active === true;
    const previousSignalActive = closureCaptureState.initialGameplaySignalActive === true;
    closureCaptureState.initialGameplaySignalActive = signalActive;
    closureCaptureState.initialGameplaySignalLabel = String(
      cheapSignal?.label ?? "inactive"
    );
    if (
      signalActive &&
      !previousSignalActive &&
      !closureCaptureState.initialGameplaySignalRearmConsumed
    ) {
      initializeFreshClosureCaptureWindow(closureCaptureState, {
        reason: "bot_on_gameplay_signal",
        log
      });
      requestClosureCaptureArm(closureCaptureState, {
        reason: "bot_on_gameplay_signal",
        now,
        bootstrapReady,
        log
      });
      closureCaptureState.nextAttemptAt = now;
      closureCaptureState.initialGameplaySignalRearmConsumed = true;
      log(
        `[browser] initial gameplay signal reopened closure capture label=${closureCaptureState.initialGameplaySignalLabel}`
      );
    }
  }
  let skipCaptureThisPoll = false;
  const shouldPollInteraction =
    options.probePageState &&
    !options.suppressClosureCapture &&
    bootstrapReady &&
    soloBotEnabled &&
    nextGameReacquireState.interactionPhase !==
      NEXT_GAME_INTERACTION_PHASE_CAPTURED_WAITING_START &&
    (
      (nextGameReacquireState.active && waitingForNextGame && !state.ok) ||
      (postGameInteractionWatchState.active && !nextGameReacquireState.active)
    );
  if (
    options.probePageState &&
    !options.suppressClosureCapture &&
    bootstrapReady &&
    soloBotEnabled &&
    (
      (nextGameReacquireState.active && waitingForNextGame) ||
      (postGameInteractionWatchState.active &&
        isAgainButtonProvisionalInteraction(nextGameReacquireState))
    ) &&
    !state.ok
  ) {
    let fallbackEligible = !endedGameCandidate.objectId;
    if (endedGameCandidate.objectId) {
      if (
        now - Number(nextGameReacquireState.lastEndedObjectCheckAt ?? 0) >=
        DEFAULT_NEXT_GAME_FAST_LOCATOR_INTERVAL_MS
      ) {
        log("[browser] ended game object probe scheduled object_id_present=true");
        nextGameReacquireState.lastEndedObjectCheckAt = now;
        const endedProbeFn =
          options.readEndedGameCandidateStateFn ?? readEndedGameCandidateState;
        const endedProbe = await endedProbeFn(cdp, endedGameCandidate, {
          log
        }).catch((error) => ({
          status: "transient_error",
          reason: error?.message ?? String(error)
        }));
        if (
          shouldLogReacquireStatus(
            nextGameReacquireState.lastEndedObjectProbeStatus,
            String(endedProbe.status ?? "unknown"),
            nextGameReacquireState.lastEndedObjectProbeLogAt,
            now
          )
        ) {
          log(
            `[browser] ended game object probe status=${String(
              endedProbe.status ?? "unknown"
            )}`
          );
          nextGameReacquireState.lastEndedObjectProbeLogAt = now;
          nextGameReacquireState.lastEndedObjectProbeStatus = String(
            endedProbe.status ?? "unknown"
          );
        }
        if (
          (endedProbe.status === "valid_countdown" ||
            endedProbe.status === "valid_playing") &&
          endedProbe.reactivated &&
          endedProbe.state?.ok
        ) {
          log(
            `[browser] ended game object reactivated epoch=${Math.max(
              0,
              Number(endedGameCandidate.epoch ?? 0)
            )}->${Math.max(0, Number(endedGameCandidate.epoch ?? 0)) + 1}`
          );
          state = endedProbe.state;
        } else if (
          endedProbe.status === "object_released" ||
          endedProbe.status === "execution_context_destroyed" ||
          endedProbe.status === "invalid_object_id"
        ) {
          fallbackEligible = true;
          clearEndedGameCandidate(endedGameCandidate, endedProbe.status);
        }
      } else if (
        verboseReacquireLogs &&
        shouldLogReacquireStatus(
          nextGameReacquireState.lastEndedObjectProbeStatus,
          "interval_wait",
          nextGameReacquireState.lastEndedObjectProbeLogAt,
          now
        )
      ) {
        log("[browser] ended game object probe skipped reason=interval_wait");
        nextGameReacquireState.lastEndedObjectProbeLogAt = now;
        nextGameReacquireState.lastEndedObjectProbeStatus = "interval_wait";
      }
    } else if (
      shouldLogReacquireStatus(
        nextGameReacquireState.lastEndedObjectProbeStatus,
        "no_object_id",
        nextGameReacquireState.lastEndedObjectProbeLogAt,
        now
      )
    ) {
      log("[browser] ended game object probe skipped reason=no_object_id");
      nextGameReacquireState.lastEndedObjectProbeLogAt = now;
      nextGameReacquireState.lastEndedObjectProbeStatus = "no_object_id";
    }
    if (!state.ok) {
      if (
        now - Number(nextGameReacquireState.lastCheapSampledAt ?? 0) >=
        DEFAULT_NEXT_GAME_FAST_LOCATOR_INTERVAL_MS
      ) {
        nextGameReacquireState.lastCheapSampledAt = now;
      const cheapSignalFn =
          options.readCheapGameSignalFn ?? readCheapGameSignal;
        const cheapSignal = await cheapSignalFn(cdp, {
          transientState: options.transientState,
          log
        }).catch(() => ({ active: false, source: "none", label: "inactive", sources: [] }));
        if (
          now - Number(nextGameReacquireState.lastCheapSignalLogAt ?? 0) >= 5000 ||
          nextGameReacquireState.lastCheapSignalLabel !== String(cheapSignal?.label ?? "inactive")
        ) {
          for (const entry of Array.isArray(cheapSignal?.sources) ? cheapSignal.sources : []) {
            log(
              `[browser] cheap game signal source=${entry.source} value=${entry.value ? "true" : "false"} state=${entry.state}`
            );
          }
          nextGameReacquireState.lastCheapSignalLogAt = now;
          nextGameReacquireState.lastCheapSignalLabel = String(
            cheapSignal?.label ?? "inactive"
          );
        }
        const currentAggregate = String(cheapSignal?.label ?? "inactive");
        const previousAggregate = String(
          nextGameReacquireState.lastCheapAggregateState || ""
        );
        const cheapSignalActive = Boolean(cheapSignal?.active);
        const againTransitionReady =
          isAgainButtonProvisionalInteraction(nextGameReacquireState) &&
          isTransitionReadyForAgainProvisional(cheapSignal);
        const hardFallbackReady =
          isAgainButtonProvisionalInteraction(nextGameReacquireState) &&
          Math.max(0, Number(closureCaptureState.windowFirstInteractionAt ?? 0)) > 0 &&
          now - Math.max(0, Number(closureCaptureState.windowFirstInteractionAt ?? 0)) >=
            DEFAULT_AGAIN_PROVISIONAL_HARD_FALLBACK_MS;
        if (
          isAgainButtonProvisionalInteraction(nextGameReacquireState) &&
          (againTransitionReady || hardFallbackReady)
        ) {
          nextGameReacquireState.provisionalTransitionReady = true;
          if (
            nextGameReacquireState.interactionPhase ===
            NEXT_GAME_INTERACTION_PHASE_WAITING_TRANSITION_READY
          ) {
            setNextGameInteractionPhase(
              nextGameReacquireState,
              NEXT_GAME_INTERACTION_PHASE_REACQUIRING
            );
          }
          if (
            now - Number(nextGameReacquireState.provisionalTransitionReadyLoggedAt ?? 0) >= 1
          ) {
            log(
              againTransitionReady
                ? "[browser] AGAIN provisional transition ready; enabling targeted/broad fallback"
                : "[browser] AGAIN provisional hard fallback ready; enabling broad fallback"
            );
            nextGameReacquireState.provisionalTransitionReadyLoggedAt = now;
          }
          if (Number(closureCaptureState.nextAttemptAt ?? 0) > now) {
            closureCaptureState.nextAttemptAt = now;
          }
        }
        const qualifiesForArm =
          (previousAggregate === "result" || previousAggregate === "inactive") &&
          (currentAggregate === "countdown" || currentAggregate === "playing");
        if (qualifiesForArm) {
          log(
            `[browser] cheap game signal transition inactive->playing source=${String(
              cheapSignal?.source ?? "unknown"
            )}`
          );
          if (fallbackEligible) {
            requestClosureCaptureArm(closureCaptureState, {
              reason: "next_game_cheap_signal",
              now,
              bootstrapReady,
              log
            });
          }
        }
        nextGameReacquireState.lastCheapSignalState = cheapSignalActive;
        nextGameReacquireState.lastCheapAggregateState = currentAggregate;
      }
    }
  }
  if (
    shouldPollInteraction &&
    now - Number(nextGameReacquireState.lastFastAttemptAt ?? 0) >=
      DEFAULT_NEXT_GAME_INTERACTION_POLL_MS &&
    now - Number(postGameInteractionWatchState.lastPollAt ?? 0) >=
      DEFAULT_NEXT_GAME_INTERACTION_POLL_MS
  ) {
    nextGameReacquireState.lastFastAttemptAt = now;
    postGameInteractionWatchState.lastPollAt = now;
    const interactionStateFn =
      options.readNextGameInteractionStateFn ?? readNextGameInteractionState;
    const interaction = await interactionStateFn(cdp, {
      transientState: options.transientState,
      log
    }).catch(() => ({
      generation: 0,
      type: null,
      timestamp: 0,
      targetTag: null,
      targetId: null,
      targetClass: null
    }));
    const generation = Math.max(0, Number(interaction?.generation ?? 0));
    const timestamp = Math.max(0, Number(interaction?.timestamp ?? 0));
    if (generation > nextGameReacquireState.lastInteractionGenerationSeen) {
      nextGameReacquireState.lastInteractionGenerationSeen = generation;
      const keyLabel = interaction?.key ? ` key=${String(interaction.key)}` : "";
      const interactionKind = deriveInteractionKind(interaction);
      const kindLabel = interactionKind !== "other" ? ` interaction_kind=${interactionKind}` : "";
      log(
        `[browser] next-game interaction detected generation=${generation} type=${String(
          interaction?.type ?? "unknown"
        )}${keyLabel}${kindLabel} target=${String(interaction?.targetTag ?? "")}${
          interaction?.targetId ? `#${interaction.targetId}` : ""
        }`
      );
    }
    if (generation > postGameInteractionWatchState.lastInteractionGenerationSeen) {
      postGameInteractionWatchState.lastInteractionGenerationSeen = generation;
    }
    if (
      postGameInteractionWatchState.active &&
      rememberPendingPostGameInteraction(postGameInteractionWatchState, interaction)
    ) {
      log(
        `[browser] post-game interaction captured before end confirmation generation=${generation} type=${String(
          interaction?.type ?? "unknown"
        )}`
      );
      if (
        soloBotEnabled &&
        isTrustedNextGameInteraction(interaction) &&
        generation > Math.max(0, Number(postGameInteractionWatchState.provisionalArmedGeneration ?? 0))
      ) {
        postGameInteractionWatchState.provisionalArmedGeneration = generation;
        recordProvisionalInteraction(nextGameReacquireState, interaction);
        closureCaptureState.windowFirstInteractionAt = timestamp;
        nextGameReacquireState.interactionWindowGeneration = generation;
        nextGameReacquireState.interactionWindowArmedAt = now;
        setNextGameInteractionPhase(
          nextGameReacquireState,
          deriveInteractionKind(interaction) === "again_button"
            ? NEXT_GAME_INTERACTION_PHASE_WAITING_TRANSITION_READY
            : NEXT_GAME_INTERACTION_PHASE_CAPTURE_ARMED
        );
        log(`[browser] trusted next-game interaction provisional arm generation=${generation}`);
        log(`[perf] next_game_interaction_to_arm_ms=${Math.max(0, now - timestamp)}`);
        requestClosureCaptureArm(closureCaptureState, {
          reason: "next_game_provisional_interaction",
          now,
          bootstrapReady,
          log
        });
        closureCaptureState.nextAttemptAt = now + DEFAULT_TARGETED_PAUSED_PROBE_DELAY_MS;
        skipCaptureThisPoll = true;
      }
    }
    const interactionIsFresh =
      nextGameReacquireState.interactionPhase ===
        NEXT_GAME_INTERACTION_PHASE_REACQUIRING &&
      generation >
        Math.max(
          0,
          Number(nextGameReacquireState.interactionBaselineGeneration ?? 0)
        ) &&
      timestamp > Math.max(0, Number(nextGameReacquireState.startedAt ?? 0));
    if (
      interactionIsFresh &&
      generation > nextGameReacquireState.lastInteractionGenerationHandled
    ) {
      const interactionWindowAlreadyArmed =
        isClosureCaptureArmed(closureCaptureState, now) &&
        closureCaptureState.armedReason === "next_game_user_interaction";
      if (!interactionWindowAlreadyArmed) {
        const armed = armNextGameInteractionWindow(
          closureCaptureState,
          nextGameReacquireState,
          {
            generation,
            now,
            bootstrapReady,
            log
          }
        );
        if (armed) {
          nextGameReacquireState.lastInteractionGenerationHandled = generation;
          clearPendingNextGameInteraction(nextGameReacquireState);
        }
      } else {
        rememberPendingNextGameInteraction(nextGameReacquireState, interaction);
      }
    }
  }
  if (
    options.probePageState &&
    !options.suppressClosureCapture &&
    bootstrapJustBecameReady &&
    soloBotEnabled &&
    !state.ok &&
    closureCaptureState.armedReason !== "next_game_user_interaction" &&
    !isProvisionalClosureCaptureReason(closureCaptureState.armedReason) &&
    !isCarriedClosureCaptureReason(closureCaptureState.armedReason)
  ) {
    if (hasPendingClosureCaptureArm(closureCaptureState)) {
      activatePendingClosureCaptureArm(closureCaptureState, {
        now,
        log
      });
    } else if (isClosureCaptureArmed(closureCaptureState, now)) {
      reactivateClosureCaptureArmAfterBootstrap(closureCaptureState, {
        now,
        log
      });
    }
  }
  const carriedInteractionExpected =
    soloBotEnabled &&
    waitingForNextGame &&
    nextGameReacquireState.active &&
    hasUnhandledCarriedPostGameInteraction(nextGameReacquireState);
  const gameplayExpected = isGameplayExpectedForClosureCapture({
    state,
    activeRoundId: options.activeRoundId ?? "",
    closureCaptureState,
    carriedInteractionExpected,
    now
  });
  if (
    options.probePageState &&
    !options.suppressClosureCapture &&
    bootstrapReady &&
    !state.ok &&
    shouldLogClosureCaptureSkipped({
      gameplayExpected,
      lastSkippedLogAt: closureCaptureState.lastSkippedLogAt,
      now
    })
  ) {
    log(
      `[browser] closure capture skipped; gameplay not expected phase=${String(
        nextGameReacquireState.interactionPhase ?? NEXT_GAME_INTERACTION_PHASE_INACTIVE
      )} carried_pending=${carriedInteractionExpected ? "true" : "false"} pending_source=${String(
        nextGameReacquireState.pendingInteractionSource ?? ""
      )}`
    );
    closureCaptureState.lastSkippedLogAt = now;
  }
  const shouldCapture = shouldAttemptClosureCapture({
    probePageState: options.probePageState,
    suppressClosureCapture: options.suppressClosureCapture,
    bootstrapReady,
    stateOk:
      isProvisionalClosureCaptureReason(closureCaptureState.armedReason)
        ? false
        : state.ok,
    gameplayExpected,
    nextAttemptAt: closureCaptureState.nextAttemptAt,
    lastCaptureAt: options.probeState?.lastCaptureAt ?? 0,
    lastPageProbeAt: options.network?.lastPageProbeAt ?? 0,
    now
  });
  const shouldCaptureWithWindow =
    shouldCapture &&
    isClosureCaptureArmed(closureCaptureState, now) &&
    !skipCaptureThisPoll &&
    !isClosureCaptureWindowExhausted(closureCaptureState);
  if (shouldCaptureWithWindow) {
    const pausedUsedMs = Math.max(
      0,
      Number(closureCaptureState.cumulativePausedScanBudgetUsedMs ?? 0)
    );
    log(
      `[browser] closure scan gate capture_attempts=${Math.max(
        0,
        Number(closureCaptureState.captureAttemptsInWindow ?? 0)
      )} full_scan_attempts=${Math.max(
        0,
        Number(closureCaptureState.fullScanAttemptsInWindow ?? 0)
      )} paused_used_ms=${pausedUsedMs} remaining_paused_ms=${Math.max(
        0,
        DEFAULT_FULL_SCAN_CUMULATIVE_BUDGET_MS - pausedUsedMs
      )} cursor=${formatClosureCaptureCursorLabel(
        closureCaptureState.pausedScopeScanCursor
      )} exhausted=${closureCaptureState.scanBudgetExhausted ? "true" : "false"} gameplay_expected=${gameplayExpected ? "true" : "false"}`
    );
  }

  if (shouldCaptureWithWindow) {
    if (closureCaptureState.firstAttemptLoggedForReason !== closureCaptureState.armedReason) {
      log(`[browser] closure capture first attempt reason=${closureCaptureState.armedReason}`);
      closureCaptureState.firstAttemptLoggedForReason = closureCaptureState.armedReason;
    }
    const captureStartedAt = Date.now();
    options.probeState.lastCaptureAt = now;
    if (options.network) {
      options.network.lastPageProbeAt = now;
    }
    const captureFn = options.captureGameFn ?? captureTetrioGame;
    const isProvisionalCapture = isProvisionalClosureCaptureReason(
      closureCaptureState.armedReason
    );
    const isAgainButtonProvisionalCapture =
      isProvisionalCapture && isAgainButtonProvisionalInteraction(nextGameReacquireState);
    const allowBroadScan =
      !isAgainButtonProvisionalCapture ||
      nextGameReacquireState.provisionalTransitionReady === true;
    if (
      !closureCaptureState.windowTargetedProbeAt &&
      (closureCaptureState.lastSuccessfulPausedLocation || isProvisionalCapture)
    ) {
      closureCaptureState.windowTargetedProbeAt = now;
      if (closureCaptureState.windowArmedAt > 0) {
        log(
          `[perf] next_game_arm_to_targeted_probe_ms=${Math.max(
            0,
            now - Number(closureCaptureState.windowArmedAt ?? 0)
          )}`
        );
      }
    }
    const capture = await captureFn(cdp, {
      closureCaptureState,
      log,
      requireActiveGame: isProvisionalCapture,
      pauseTimeoutMs:
        (isAgainButtonProvisionalCapture && !allowBroadScan)
          ? DEFAULT_FOLLOWUP_FAST_CAPTURE_TIMEOUT_MS
          : 900,
      allowBroadScan,
      targetUrl: options.targetUrl ?? "",
      mainFrameId: options.mainFrameId ?? "",
      candidateTraceEnabled: options.candidateTraceEnabled === true
    }).catch((error) => ({
      ok: false,
      reason: error?.message ?? String(error)
    }));
    closureCaptureState.pendingFollowupFastCapture = false;
    closureCaptureState.pendingFollowupFullScan = false;
    if (options.perfEnabled) {
      console.log(
        `[browser-perf] closure_capture elapsed_ms=${Math.max(0, Date.now() - captureStartedAt)}`
      );
    }
    if (capture.ok) {
      if (closureCaptureState.captureTiming) {
        const successAt = Date.now();
        closureCaptureState.captureTiming.captureSuccessAt = successAt;
        logClosureTimingStage(closureCaptureState, "capture_success", {
          phase: "end",
          startAt: successAt,
          endAt: successAt,
          log,
          details: { source: capture.source }
        });
      }
      if (capture.locator) {
        closureCaptureState.lastSuccessfulLocator = String(capture.locator);
      }
      if (capture.progress) {
        closureCaptureState.lastSuccessfulPausedLocation = {
          frameIndex: Math.max(0, Number(capture.progress.frameIndex ?? 0)),
          scopeIndex: Math.max(0, Number(capture.progress.scopeIndex ?? 0)),
          candidateIndex: Math.max(0, Number(capture.progress.candidateIndex ?? 0)),
          locator: String(capture.locator ?? ""),
          propertyKey: String(capture.locator ?? "")
        };
      }
      if (closureCaptureState.windowArmedAt > 0) {
        log(
          `[perf] next_game_arm_to_capture_ms=${Math.max(
            0,
            now - Number(closureCaptureState.windowArmedAt ?? 0)
          )}`
        );
      }
      if (closureCaptureState.windowFirstInteractionAt > 0) {
        log(
          `[perf] next_game_interaction_to_capture_ms=${Math.max(
            0,
            now - Number(closureCaptureState.windowFirstInteractionAt ?? 0)
          )}`
        );
      }
      await releaseEndedGameCandidateHandle(cdp, endedGameCandidate, {
        reason: "new_capture_success",
        log
      }).catch(() => undefined);
      consumeNextGameInteractionWindow(closureCaptureState, nextGameReacquireState, {
        reason: "capture_success",
        log: () => {}
      });
      disarmClosureCaptureWindow(closureCaptureState, {
        reason: "capture_success",
        log
      });
      console.log(`[browser] page probe exposed game object via ${capture.source}`);
      state = await read();
      if (
        nextGameReacquireState.active &&
        waitingForNextGame &&
        state?.reason === "TETR.IO game is not started"
      ) {
        clearPendingNextGameInteraction(nextGameReacquireState);
        nextGameReacquireState.lastInteractionGenerationHandled = Math.max(
          Math.max(0, Number(nextGameReacquireState.lastInteractionGenerationHandled ?? 0)),
          Math.max(0, Number(nextGameReacquireState.interactionWindowGeneration ?? 0))
        );
        setNextGameInteractionPhase(
          nextGameReacquireState,
          NEXT_GAME_INTERACTION_PHASE_CAPTURED_WAITING_START
        );
      } else if (
        nextGameReacquireState.active &&
        waitingForNextGame &&
        !state?.ok
      ) {
        setNextGameInteractionPhase(
          nextGameReacquireState,
          NEXT_GAME_INTERACTION_PHASE_REACQUIRING
        );
      }
    } else if (state.reason) {
      const fullScanOutcome = String(capture.outcome ?? "");
      const hasResumeCursor = Boolean(capture.resumeCursor);
      const continuationEligible =
        fullScanOutcome === "continuation_required" &&
        hasResumeCursor &&
        !capture.windowBudgetExhausted &&
        closureCaptureState.fullScanAttemptsInWindow < MAX_FULL_SCAN_ATTEMPTS_PER_WINDOW &&
        isClosureCaptureArmed(closureCaptureState, now);
      if (continuationEligible) {
        saveClosureCaptureContinuationCursor(
          closureCaptureState,
          capture.resumeCursor,
          log
        );
        const continuationDelayMs = DEFAULT_FULL_SCAN_CONTINUATION_BACKOFF_MS;
        scheduleClosureCaptureContinuation(
          closureCaptureState,
          now,
          continuationDelayMs,
          log
        );
        log(
          `[browser] full closure scan continuation resume cursor=${formatClosureCaptureCursorLabel(
            capture.resumeCursor
          )}`
        );
        if (capture.continuationReason === "paused_scope_limit_reached") {
          log("[browser] full closure scan paused scope limit reached; scheduling continuation");
        } else {
          log("[browser] full closure scan paused budget reached; scheduling continuation");
        }
      } else if (
        capture.outcome === "targeted_only_miss" &&
        isAgainButtonProvisionalCapture &&
        nextGameReacquireState.provisionalTransitionReady !== true
      ) {
        closureCaptureState.provisionalNonHeavyAttemptConsumed = true;
        setNextGameInteractionPhase(
          nextGameReacquireState,
          NEXT_GAME_INTERACTION_PHASE_WAITING_TRANSITION_READY
        );
        closureCaptureState.nextAttemptAt = now + DEFAULT_CAPTURE_ARMING_WINDOW_MS;
        log(
          `[browser] AGAIN provisional targeted miss; waiting for transition readiness generation=${Math.max(
            0,
            Number(nextGameReacquireState.interactionWindowGeneration ?? 0)
          )}`
        );
        log("[browser] broad scan suppressed while AGAIN transition is not ready");
      } else if (
        fullScanOutcome === "completed_not_found" &&
        !capture.windowBudgetExhausted &&
        closureCaptureState.fullScanAttemptsInWindow < MAX_FULL_SCAN_ATTEMPTS_PER_WINDOW &&
        isClosureCaptureArmed(closureCaptureState, now)
      ) {
        closureCaptureState.pendingFollowupFullScan = true;
        scheduleClosureCaptureContinuation(
          closureCaptureState,
          now,
          DEFAULT_FIRST_FULL_SCAN_CONTINUATION_BACKOFF_MS,
          log
        );
      } else if (
        capture.reason === "TETR.IO full closure scan cumulative budget exhausted" ||
        capture.windowBudgetExhausted === true ||
        closureCaptureState.scanBudgetExhausted === true ||
        ((fullScanOutcome === "continuation_required" ||
          fullScanOutcome === "completed_not_found") &&
          closureCaptureState.fullScanAttemptsInWindow >= MAX_FULL_SCAN_ATTEMPTS_PER_WINDOW)
      ) {
        consumeNextGameInteractionWindow(closureCaptureState, nextGameReacquireState, {
          reason: "scan_budget_exhausted",
          log
        });
        disarmClosureCaptureWindow(closureCaptureState, {
          reason: "scan_budget_exhausted",
          log
        });
      } else {
        scheduleNextClosureCaptureAttempt(closureCaptureState, now, undefined, log);
      }
      state = {
        ...state,
        reason: `${state.reason}; page probe: ${capture.reason}`
      };
    }
  }

  bootstrapState.lastReady = bootstrapReady;
  options.probeState.lastGameplayPhase = deriveGameplayPhase(state);

  if (options.suppressClosureCapture && !state.ok) {
    return {
      ...state,
      reason: options.suppressedReason ?? DEFAULT_SUPPRESSED_REASON
    };
  }

  if (state.ok) {
    return state;
  }
  if (!options.useSeedSimulationFallback || !options.network.seed) {
    return state;
  }
  return buildSeedFallbackState(options.network);
}

export async function captureTetrioGame(
  cdp,
  {
    closureCaptureState = null,
    log = console.log,
    requireActiveGame = false,
    pauseTimeoutMs = 900,
    allowBroadScan = true,
    targetUrl = "",
    mainFrameId = "",
    candidateTraceEnabled = false
  } = {}
) {
  const breakpointIds = [];
  let paused = false;

  try {
    const probeStartedAt = Date.now();
    markClosureRetryWaitEnd(closureCaptureState, probeStartedAt, log);
    if (closureCaptureState?.captureTiming) {
      const timing = closureCaptureState.captureTiming;
      if (timing.firstFastProbeStartAt === 0) {
        timing.firstFastProbeStartAt = probeStartedAt;
        logClosureTimingStage(closureCaptureState, "first_fast_probe", {
          phase: "start",
          startAt: probeStartedAt,
          endAt: probeStartedAt,
          log
        });
      }
    }
    if (closureCaptureState) {
      closureCaptureState.captureAttemptsInWindow += 1;
    }
    await cdp.send("Debugger.enable");
    for (const expression of ["window.requestAnimationFrame", "window.setTimeout"]) {
      const evaluated = await safeRuntimeEvaluate(cdp, {
        expression,
        objectGroup: "fusion-tetrio-probe",
        silent: true
      }, null).catch(() => null);
      const objectId = evaluated?.result?.objectId;
      if (!objectId) continue;
      const breakpoint = await cdp.send("Debugger.setBreakpointOnFunctionCall", {
        objectId
      }).catch(() => null);
      if (breakpoint?.breakpointId) {
        breakpointIds.push(breakpoint.breakpointId);
      }
    }

    if (breakpointIds.length === 0) {
      return { ok: false, reason: "TETR.IO probe could not attach function breakpoints" };
    }

    let event;
    try {
      event = await cdp.waitForEvent(
        "Debugger.paused",
        () => true,
        pauseTimeoutMs
      );
    } catch {
      event = null;
    }
    if (!event) {
      if (
        closureCaptureState?.captureTiming &&
        closureCaptureState.captureTiming.firstFastProbeEndAt === 0
      ) {
        const probeEndedAt = Date.now();
        closureCaptureState.captureTiming.firstFastProbeEndAt = probeEndedAt;
        logClosureTimingStage(closureCaptureState, "first_fast_probe", {
          phase: "end",
          startAt: closureCaptureState.captureTiming.firstFastProbeStartAt,
          endAt: probeEndedAt,
          log
        });
      }
      return {
        ok: false,
        reason: "TETR.IO game closure not visible yet",
        outcome: "preflight_not_visible"
      };
    }

    paused = true;
    if (
      closureCaptureState?.captureTiming &&
      closureCaptureState.captureTiming.firstFastProbeEndAt === 0
    ) {
      const probeEndedAt = Date.now();
      closureCaptureState.captureTiming.firstFastProbeEndAt = probeEndedAt;
      logClosureTimingStage(closureCaptureState, "first_fast_probe", {
        phase: "end",
        startAt: closureCaptureState.captureTiming.firstFastProbeStartAt,
        endAt: probeEndedAt,
        log
      });
    }
    const exposed = await exposeTetrioGameFromPausedCallFrames(cdp, event, {
      closureCaptureState,
      log,
      requireActiveGame,
      allowBroadScan,
      targetUrl,
      mainFrameId,
      candidateTraceEnabled
    });
    await cdp.send("Debugger.resume").catch(() => undefined);
    paused = false;
    if (exposed.ok) {
      return {
        ...exposed,
        outcome: exposed.outcome ?? "full_scan_found"
      };
    }

    return exposed.reason
      ? exposed
      : {
          ok: false,
          reason: "TETR.IO game closure not visible yet",
          outcome: "preflight_not_visible"
        };
  } finally {
    if (paused) {
      await cdp.send("Debugger.resume").catch(() => undefined);
    }
    for (const breakpointId of breakpointIds) {
      await cdp.send("Debugger.removeBreakpoint", { breakpointId }).catch(() => undefined);
    }
    await cdp.send("Runtime.releaseObjectGroup", {
      objectGroup: "fusion-tetrio-probe"
    }).catch(() => undefined);
    await cdp.send("Debugger.disable").catch(() => undefined);
  }
}

export async function safeRuntimeEvaluate(
  cdp,
  params,
  fallbackResult = null,
  { transientState = null, log = console.log } = {}
) {
  try {
    return await cdp.send("Runtime.evaluate", params);
  } catch (error) {
    if (isTransientRuntimeError(error)) {
      maybeLogTransientRuntimeError(error, transientState, log);
      return fallbackResult;
    }
    throw error;
  }
}

export async function exposeTetrioGameFromPausedCallFrames(
  cdp,
  pausedEvent,
  {
    closureCaptureState = null,
    log = console.log,
    requireActiveGame = false,
    allowBroadScan = true,
    targetUrl = "",
    mainFrameId = "",
    candidateTraceEnabled = false
  } = {}
) {
  const locatorHint = String(closureCaptureState?.lastSuccessfulLocator ?? "").trim();
  const resumeCursorLabel = formatClosureCaptureCursorLabel(
    closureCaptureState?.pausedScopeScanCursor
  );
  if (locatorHint) {
    if (closureCaptureState) {
      closureCaptureState.fastLocatorAttempted = true;
    }
    const hinted = await exposeTetrioGameViaLocatorHint(cdp, pausedEvent, locatorHint);
    if (hinted.ok) {
      log(`[browser] fast closure locator succeeded locator=${locatorHint}`);
      return hinted;
    }
    if (hinted.reason === "cached_locator_property_lookup_failed") {
      closureCaptureState.lastSuccessfulLocator = "";
      log("[browser] fast closure locator property lookup failed; invalidating locator cache");
    } else {
      log("[browser] fast closure locator miss; retaining locator cache and falling back to scan");
    }
  }
  if (closureCaptureState?.lastSuccessfulPausedLocation) {
    const hinted = await probeTargetedPausedLocation(cdp, pausedEvent, closureCaptureState, {
      log,
      requireActiveGame
    });
    if (hinted.ok) {
      return hinted;
    }
  }
  if (!allowBroadScan) {
    return {
      ok: false,
      reason: "AGAIN provisional targeted miss before transition readiness",
      outcome: "targeted_only_miss"
    };
  }
  const nextFullScanAttempt = (closureCaptureState?.fullScanAttemptsInWindow ?? 0) + 1;
  if (closureCaptureState?.fullScanAttemptsInWindow >= MAX_FULL_SCAN_ATTEMPTS_PER_WINDOW) {
    if (closureCaptureState) {
      closureCaptureState.scanBudgetExhausted = true;
    }
    return {
      ok: false,
      reason: "TETR.IO full closure scan cumulative budget exhausted",
      outcome: "continuation_required",
      continuationReason: "paused_budget_reached",
      windowBudgetExhausted: true
    };
  }
  log(
    resumeCursorLabel !== "none"
      ? `[browser] full closure scan attempt=${nextFullScanAttempt}/${MAX_FULL_SCAN_ATTEMPTS_PER_WINDOW} resume_from=${resumeCursorLabel}`
      : `[browser] full closure scan attempt=${nextFullScanAttempt}/${MAX_FULL_SCAN_ATTEMPTS_PER_WINDOW}`
  );
  if (closureCaptureState) {
    closureCaptureState.fullScanAttemptsInWindow = nextFullScanAttempt;
  }
  const scanStartedAt = Date.now();
  const scanStage = nextFullScanAttempt === 1 ? "first_full_scan" : "second_full_scan";
  if (closureCaptureState) {
    const timing = closureCaptureState.captureTiming ?? createClosureCaptureTimingState();
    timing[`${scanStage}StartAt`] = scanStartedAt;
    logClosureTimingStage(closureCaptureState, scanStage, {
      phase: "start",
      startAt: scanStartedAt,
      endAt: scanStartedAt,
      log,
      details: { attempt: nextFullScanAttempt }
    });
  }
  const scanned = await exposeTetrioGameViaPausedScopeScan(cdp, pausedEvent, {
    closureCaptureState,
    requireActiveGame,
    targetUrl,
    mainFrameId,
    preferredLocators: [locatorHint, "Ai"],
    candidateTraceEnabled,
    log
  });
  if (closureCaptureState) {
    const timing = closureCaptureState.captureTiming ?? createClosureCaptureTimingState();
    const scanEndedAt = Date.now();
    timing[`${scanStage}EndAt`] = scanEndedAt;
    logClosureTimingStage(closureCaptureState, scanStage, {
      phase: "end",
      startAt: timing[`${scanStage}StartAt`],
      endAt: scanEndedAt,
      log,
      details: {
        attempt: nextFullScanAttempt,
        frames_scanned: scanned.progress?.framesScanned,
        scopes_scanned: scanned.progress?.scopesScanned,
        inspected_objects: scanned.progress?.inspectedObjects,
        paused_ms: scanned.progress?.pausedMs
      }
    });
  }
  logPausedScopeScanProgress(log, scanned.progress ?? null);
  if (!scanned.ok && scanned.outcome === "continuation_required") {
    if (scanned.resumeCursor) {
      logPausedScopeScanContinuation(log, scanned.resumeCursor);
    } else {
      log("[browser] invalid full closure scan continuation without cursor; treating as completed_not_found");
      scanned.outcome = "completed_not_found";
      scanned.continuationReason = "invalid_resume_cursor";
    }
  }
  if (!scanned.ok && scanned.outcome === "continuation_required") {
    log(
      `[browser] full closure scan aborted budget_ms=${Math.max(0, Date.now() - scanStartedAt)}`
    );
  }
  return scanned;
}

export async function exposeTetrioGameViaLocatorHint(cdp, pausedEvent, locatorName) {
  let failureReason = "";
  for (const callFrame of pausedEvent.callFrames ?? []) {
    const result = await cdp.send("Debugger.evaluateOnCallFrame", {
      callFrameId: callFrame.callFrameId,
      expression: pausedFrameExposureExpression(locatorName),
      returnByValue: true,
      silent: true
    }).catch(() => null);
    const value = result?.result?.value;
    if (value?.ok) {
      return value;
    }
    if (value?.reason) {
      failureReason = String(value.reason);
    }
  }
  return {
    ok: false,
    reason: failureReason || `TETR.IO locator ${locatorName} was not visible in paused scopes`
  };
}

export async function exposeTetrioGameViaPausedScopeScan(
  cdp,
  pausedEvent,
  {
    closureCaptureState = null,
    perScanBudgetMs = DEFAULT_FULL_SCAN_PAUSE_BUDGET_MS,
    cumulativeBudgetMs = DEFAULT_FULL_SCAN_CUMULATIVE_BUDGET_MS,
    requireActiveGame = false,
    targetUrl = "",
    mainFrameId = "",
    preferredLocators = [],
    candidateTraceEnabled = false,
    log = console.log
  } = {}
) {
  const callFrames = pausedEvent?.callFrames ?? [];
  const frameOrderOptions = {
    targetUrl,
    mainFrameId,
    preferredLocators
  };
  const frameOrder = getPausedScopeScanFrameOrder(callFrames, frameOrderOptions);
  if (typeof log === "function") {
    log(
      `[browser] full closure scan frame_order=${frameOrder
        .map((frameIndex) =>
          formatPausedFrameDiagnostic(callFrames[frameIndex], frameIndex, frameOrderOptions)
        )
        .join(",")}`
    );
  }
  const persistedCursor =
    closureCaptureState?.pausedScopeScanCursor ?? {
      ...createPausedScopeScanCursor(),
      frameIndex: frameOrder[0] ?? 0
    };
  const completedScopeKeys = new Set(persistedCursor.completedScopeKeys ?? []);
  const seenCandidateKeys = new Set(persistedCursor.seenCandidateKeys ?? []);
  const budgetUsedMs = Math.max(
    0,
    Number(closureCaptureState?.cumulativePausedScanBudgetUsedMs ?? 0)
  );
  const remainingWindowBudgetMs = Math.max(0, cumulativeBudgetMs - budgetUsedMs);
  if (remainingWindowBudgetMs <= 0) {
    if (closureCaptureState) {
      closureCaptureState.scanBudgetExhausted = true;
    }
    return {
      ok: false,
      reason: "TETR.IO full closure scan cumulative budget exhausted",
      outcome: "continuation_required",
      continuationReason: "paused_budget_reached",
      windowBudgetExhausted: true,
      progress: {
        attempt: Math.max(1, Number(closureCaptureState?.fullScanAttemptsInWindow ?? 1)),
        ...formatScanCursor(persistedCursor),
        inspectedObjects: seenCandidateKeys.size,
        pausedMs: 0,
        framesScanned: 0,
        scopesScanned: 0
      },
      resumeCursor: formatScanCursor(persistedCursor)
    };
  }

  const scanStartedAt = Date.now();
  const scanBudgetMs = Math.max(
    1,
    Math.min(Math.max(1, perScanBudgetMs), remainingWindowBudgetMs)
  );
  let candidatesVisited = 0;
  let framesScanned = 0;
  let scopesScanned = 0;

  const updateBudgetUsed = () => {
    if (closureCaptureState) {
      closureCaptureState.cumulativePausedScanBudgetUsedMs = Math.min(
        cumulativeBudgetMs,
        budgetUsedMs + Math.max(0, Date.now() - scanStartedAt)
      );
    }
  };

  const persistPartial = ({
    frameIndex,
    scopeIndex,
    propertyIndex,
    descriptorsLength = 0,
    continuationReason = "paused_budget_reached",
    advancePastCurrentProperty = false
  }) => {
    updateBudgetUsed();
    const windowBudgetExhausted =
      (closureCaptureState?.cumulativePausedScanBudgetUsedMs ?? 0) >= cumulativeBudgetMs;
    const resumeCursor = computePausedScopeScanResumeCursor(callFrames, {
      frameIndex,
      scopeIndex,
      propertyIndex,
      descriptorsLength,
      advancePastCurrentProperty,
      frameOrderOptions
    });
    if (!resumeCursor && !windowBudgetExhausted) {
      if (closureCaptureState) {
        clearPausedScopeScanCursor(closureCaptureState);
        closureCaptureState.scanBudgetExhausted = false;
      }
      return {
        ok: false,
        reason: "TETR.IO active game variable was not in paused scopes",
        outcome: "completed_not_found",
        progress: {
          attempt: Math.max(1, Number(closureCaptureState?.fullScanAttemptsInWindow ?? 1)),
          frameIndex,
          scopeIndex,
          candidateIndex: propertyIndex,
          inspectedObjects: seenCandidateKeys.size,
          pausedMs: Math.max(0, Date.now() - scanStartedAt),
          framesScanned,
          scopesScanned
        }
      };
    }
    if (closureCaptureState) {
      closureCaptureState.pausedScopeScanCursor = resumeCursor ? {
        frameIndex: resumeCursor.frameIndex,
        scopeIndex: resumeCursor.scopeIndex,
        propertyIndex: resumeCursor.propertyIndex,
        completedScopeKeys: Array.from(completedScopeKeys),
        seenCandidateKeys: Array.from(seenCandidateKeys)
      } : null;
      closureCaptureState.scanBudgetExhausted = windowBudgetExhausted;
    }
    return {
      ok: false,
      reason: windowBudgetExhausted
        ? "TETR.IO full closure scan cumulative budget exhausted"
        : continuationReason === "paused_scope_limit_reached"
          ? "TETR.IO paused scope scan limit reached"
          : "TETR.IO paused scope scan pause budget reached",
      outcome: "continuation_required",
      continuationReason,
      windowBudgetExhausted,
      progress: {
        attempt: Math.max(1, Number(closureCaptureState?.fullScanAttemptsInWindow ?? 1)),
        frameIndex,
        scopeIndex,
        candidateIndex: propertyIndex,
        inspectedObjects: seenCandidateKeys.size,
        pausedMs: Math.max(0, Date.now() - scanStartedAt),
        framesScanned,
        scopesScanned
      },
      resumeCursor: resumeCursor ? formatScanCursor(resumeCursor) : null
    };
  };

  const isScanBudgetExhausted = () => Date.now() - scanStartedAt >= scanBudgetMs;

  const startFrameOrderIndex = Math.max(
    0,
    frameOrder.indexOf(persistedCursor.frameIndex ?? frameOrder[0] ?? 0)
  );
  for (let frameOrderIndex = startFrameOrderIndex; frameOrderIndex < frameOrder.length; frameOrderIndex += 1) {
    const frameIndex = frameOrder[frameOrderIndex];
    const callFrame = callFrames[frameIndex];
    const scopeChain = callFrame?.scopeChain ?? [];
    framesScanned += 1;
    const initialScopeIndex =
      frameIndex === (persistedCursor.frameIndex ?? 0)
        ? persistedCursor.scopeIndex ?? 0
        : 0;
    for (let scopeIndex = initialScopeIndex; scopeIndex < scopeChain.length; scopeIndex += 1) {
      const scope = scopeChain[scopeIndex];
      const scopeObjectId = scope?.object?.objectId;
      const scopeKey = `${frameIndex}:${scopeIndex}:${scopeObjectId ?? ""}`;
      if (!scopeObjectId || completedScopeKeys.has(scopeKey)) {
        continue;
      }
      scopesScanned += 1;
      const initialPropertyIndex =
        frameIndex === (persistedCursor.frameIndex ?? 0) &&
        scopeIndex === (persistedCursor.scopeIndex ?? 0)
          ? persistedCursor.propertyIndex ?? 0
          : 0;
      if (isScanBudgetExhausted()) {
        return persistPartial({
          frameIndex,
          scopeIndex,
          propertyIndex: initialPropertyIndex,
          descriptorsLength: Number.MAX_SAFE_INTEGER,
          continuationReason: "paused_budget_reached"
        });
      }
      const properties = await cdp.send("Runtime.getProperties", {
        objectId: scopeObjectId,
        ownProperties: true,
        accessorPropertiesOnly: false,
        generatePreview: false
      }).catch(() => null);
      const descriptors = (properties?.result ?? [])
        .slice(0, MAX_SCOPE_PROPERTIES_PER_SCOPE)
        .map((descriptor, index) => ({ descriptor, index }))
        .sort((left, right) => {
          const scoreDelta =
            scorePausedScopeDescriptor(right.descriptor, preferredLocators) -
            scorePausedScopeDescriptor(left.descriptor, preferredLocators);
          return scoreDelta !== 0 ? scoreDelta : left.index - right.index;
        })
        .map(({ descriptor }) => descriptor);
      for (
        let propertyIndex = initialPropertyIndex;
        propertyIndex < descriptors.length;
        propertyIndex += 1
      ) {
        if (isScanBudgetExhausted()) {
          return persistPartial({
            frameIndex,
            scopeIndex,
            propertyIndex,
            descriptorsLength: descriptors.length,
            continuationReason: "paused_budget_reached"
          });
        }
        const descriptor = descriptors[propertyIndex];
        if (descriptor?.get || descriptor?.set) {
          continue;
        }
        const valueObjectId = descriptor?.value?.objectId;
        const locator = String(descriptor?.name ?? "").trim();
        if (!valueObjectId || !locator) {
          continue;
        }
        const candidateKey =
          `${frameIndex}:${scopeIndex}:${scopeObjectId}:${locator}:${valueObjectId}`;
        if (seenCandidateKeys.has(candidateKey)) {
          continue;
        }
        candidatesVisited += 1;
        if (candidatesVisited > MAX_PAUSED_SCOPE_SCAN_CANDIDATES_PER_ATTEMPT) {
          return persistPartial({
            frameIndex,
            scopeIndex,
            propertyIndex,
            descriptorsLength: descriptors.length,
            continuationReason: "paused_scope_limit_reached",
            advancePastCurrentProperty: true
          });
        }
        seenCandidateKeys.add(candidateKey);
        if (candidateTraceEnabled && typeof log === "function") {
          log(
            `[browser] closure candidate trace ${JSON.stringify({
              frame: frameIndex,
              scope: scopeIndex,
              candidate: propertyIndex,
              locator
            })}`
          );
        }
        const exposed = await exposeTetrioCandidateObjectWithOptions(
          cdp,
          valueObjectId,
          locator,
          { requireActiveGame }
        );
        if (exposed.ok) {
          await captureSoloClosureFingerprintForPausedCandidate(cdp, {
            pausedEvent,
            frameIndex,
            scopeIndex,
            locator,
            objectId: valueObjectId,
            filePath:
              closureCaptureState?.soloClosureFingerprintPath ??
              DEFAULT_SOLO_CLOSURE_FINGERPRINT_PATH,
            targetGeneration: Math.max(
              0,
              Number(closureCaptureState?.windowSequence ?? 0)
            )
          }).catch(() => false);
          updateBudgetUsed();
          clearPausedScopeScanCursor(closureCaptureState);
          if (closureCaptureState) {
            closureCaptureState.scanBudgetExhausted = false;
          }
          return {
            ...exposed,
            outcome: "full_scan_found",
            progress: {
              attempt: Math.max(1, Number(closureCaptureState?.fullScanAttemptsInWindow ?? 1)),
              frameIndex,
              scopeIndex,
              candidateIndex: propertyIndex,
              inspectedObjects: seenCandidateKeys.size,
              pausedMs: Math.max(0, Date.now() - scanStartedAt),
              framesScanned,
              scopesScanned
            }
          };
        }
      }
      completedScopeKeys.add(scopeKey);
    }
  }

  updateBudgetUsed();
  clearPausedScopeScanCursor(closureCaptureState);
  if (closureCaptureState) {
    closureCaptureState.scanBudgetExhausted = false;
  }
  return {
    ok: false,
    reason: "TETR.IO active game variable was not in paused scopes",
    outcome: "completed_not_found",
    progress: {
      attempt: Math.max(1, Number(closureCaptureState?.fullScanAttemptsInWindow ?? 1)),
      frameIndex: callFrames.length === 0 ? 0 : Math.max(0, callFrames.length - 1),
      scopeIndex: 0,
      candidateIndex: 0,
      inspectedObjects: seenCandidateKeys.size,
      pausedMs: Math.max(0, Date.now() - scanStartedAt),
      framesScanned,
      scopesScanned
    }
  };
}

export async function exposeTetrioCandidateObject(cdp, objectId, locatorName) {
  const result = await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      try {
        if (
          !this ||
          typeof this !== "object" ||
          typeof this.ejectState !== "function" ||
          typeof this.ejectBoardState !== "function"
        ) {
          return { ok: false };
        }
        const exported = this.ejectState();
        const state =
          exported && typeof exported === "object" && exported.game
            ? exported.game
            : exported;
        const requireActiveGame = ${JSON.stringify(false)};
        if (state?.destroyed || state?.dead || state?.gameover) {
          return { ok: false };
        }
        window.__fusionTetrioGame = this;
        window.__fusionTetrioBridge = {
          ok: true,
          source: ${JSON.stringify("closure:" + locatorName)},
          locator: ${JSON.stringify(locatorName)},
          at: Date.now(),
          href: location.href
        };
        return window.__fusionTetrioBridge;
      } catch {
        return { ok: false };
      }
    }`,
    returnByValue: true,
    silent: true
  }).catch(() => null);
  return result?.result?.value ?? { ok: false };
}

async function exposeTetrioCandidateObjectWithOptions(
  cdp,
  objectId,
  locatorName,
  {
    requireActiveGame = false
  } = {}
) {
  const result = await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      try {
        if (
          !this ||
          typeof this !== "object" ||
          typeof this.ejectState !== "function" ||
          typeof this.ejectBoardState !== "function"
        ) {
          return { ok: false };
        }
        const exported = this.ejectState();
        const state =
          exported && typeof exported === "object" && exported.game
            ? exported.game
            : exported;
        if (state?.destroyed || state?.dead || state?.gameover) {
          return { ok: false };
        }
        if (${requireActiveGame ? "true" : "false"} && state?.playing !== true && state?.countdown !== true) {
          return { ok: false };
        }
        window.__fusionTetrioGame = this;
        window.__fusionTetrioBridge = {
          ok: true,
          source: ${JSON.stringify("closure:" + locatorName)},
          locator: ${JSON.stringify(locatorName)},
          at: Date.now(),
          href: location.href
        };
        return window.__fusionTetrioBridge;
      } catch {
        return { ok: false };
      }
    }`,
    returnByValue: true,
    silent: true
  }).catch(() => null);
  return result?.result?.value ?? { ok: false };
}

export function pausedFrameExposureExpression(locatorName = "Ai") {
  return `(() => {
    try {
      const locator = ${JSON.stringify(locatorName)};
      const candidate = locator ? (() => {
        try {
          return eval(locator);
        } catch {
          return undefined;
        }
      })() : undefined;
      if (
        candidate &&
        typeof candidate.ejectState === "function" &&
        typeof candidate.ejectBoardState === "function"
      ) {
        if (candidate === window.__fusionEndedTetrioGame) {
          try {
            const exported = candidate.ejectState();
            const state =
              exported && typeof exported === "object" && exported.game
                ? exported.game
                : exported;
            if (state?.destroyed || state?.dead || state?.gameover) {
              return { ok: false, reason: "cached_locator_property_lookup_failed" };
            }
          } catch {
            return { ok: false, reason: "cached_locator_property_lookup_failed" };
          }

          delete window.__fusionEndedTetrioGame;
        }

        window.__fusionTetrioGame = candidate;
        window.__fusionTetrioBridge = {
          ok: true,
          source: locator ? "closure:" + locator : "closure",
          locator: locator || null,
          at: Date.now(),
          href: location.href
        };
        return window.__fusionTetrioBridge;
      }
      if (candidate !== undefined) {
        return { ok: false, reason: "cached_locator_property_lookup_failed" };
      }
    } catch {}
    return { ok: false, reason: "cached_locator_not_visible" };
  })()`;
}

function buildSeedFallbackState(network) {
  const now = Date.now();
  const ready = network.readyAt > 0 && now >= network.readyAt;
  const generated = getCurrentAndNext(network.seed, 0, network.nextCount);
  return {
    ok: Boolean(generated.current),
    ready,
    reason: ready ? null : "TETR.IO seed captured; waiting for countdown timing",
    field: Array.from({ length: 40 }, () => Array.from({ length: 10 }, () => false)),
    current: generated.current,
    hold: null,
    queue: generated.queue,
    b2b: false,
    combo: 0,
    incoming: 0,
    pieceCounter: 0,
    playing: ready,
    countdown: !ready
  };
}

function createPrng(seed) {
  let value = Number.parseInt(seed, 10) % 2147483647;
  if (value <= 0) value += 2147483646;
  return {
    next() {
      value = (16807 * value) % 2147483647;
      return value;
    },
    nextFloat() {
      return (this.next() - 1) / 2147483646;
    }
  };
}

function generate7BagQueue(seed, count) {
  const rng = createPrng(seed);
  const pieces = ["z", "l", "o", "s", "i", "j", "t"];
  const bag = [];
  const queue = [];
  while (queue.length < count) {
    const nextBag = [...pieces];
    for (let index = nextBag.length - 1; index > 0; index--) {
      const swapIndex = Math.floor(rng.nextFloat() * (index + 1));
      [nextBag[index], nextBag[swapIndex]] = [nextBag[swapIndex], nextBag[index]];
    }
    bag.push(...nextBag);
    while (bag.length > 0 && queue.length < count) {
      queue.push(bag.shift());
    }
  }
  return queue;
}

function getCurrentAndNext(seed, pieceIndex, nextCount = DEFAULT_NEXT_COUNT) {
  const queue = generate7BagQueue(seed, pieceIndex + nextCount + 1);
  return {
    current: queue[pieceIndex] ?? null,
    queue: queue.slice(pieceIndex + 1, pieceIndex + 1 + nextCount)
  };
}

export function tetrioStateExpression() {
  return `(() => {
    const pieceNames = ["i", "o", "t", "s", "z", "j", "l"];
    const normalizePiece = (value) => {
      if (value === null || value === undefined || value === false) return null;
      if (typeof value === "number") return pieceNames[value] ?? null;
      if (typeof value === "string") {
        const text = value.trim().toLowerCase();
        if (!text) return null;
        for (const token of text.split(/[^a-z0-9]+/)) {
          if (pieceNames.includes(token)) return token;
        }
        return pieceNames.includes(text) ? text : null;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          const piece = normalizePiece(item);
          if (piece) return piece;
        }
        return null;
      }
      if (typeof value === "object") {
        for (const key of ["type", "symbol", "id", "piece", "name", "mino", "value"]) {
          const piece = normalizePiece(value[key]);
          if (piece) return piece;
        }
      }
      return null;
    };
    const filled = (cell) => {
      if (cell === null || cell === undefined || cell === false || cell === 0 || cell === "") return false;
      if (typeof cell === "string") {
        const text = cell.trim().toLowerCase();
        return text !== "" && text !== "." && text !== "0" && text !== "empty";
      }
      if (typeof cell === "object") {
        if ("empty" in cell) return !cell.empty;
        if ("type" in cell) return filled(cell.type);
        if ("mino" in cell) return filled(cell.mino);
      }
      return true;
    };
    const rowCells = (row) =>
      Array.isArray(row)
        ? row
        : Array.isArray(row?.cells)
          ? row.cells
          : Array.isArray(row?.row)
            ? row.row
            : null;
    const queueFrom = (...values) => {
      for (const value of values) {
        if (!Array.isArray(value)) continue;
        const queue = value.map(normalizePiece).filter(Boolean);
        if (queue.length > 0) return queue.slice(0, 12);
      }
      return [];
    };
    const numberFrom = (...values) => {
      for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number)) return number;
      }
      return null;
    };
    const integerFrom = (...values) => {
      const number = numberFrom(...values);
      return number === null ? null : Math.floor(number);
    };
    const rotationFrom = (...values) => {
      for (const value of values) {
        if (value === null || value === undefined) continue;
        if (typeof value === "number" && Number.isFinite(value)) {
          const normalized = ((Math.floor(value) % 4) + 4) % 4;
          return ["north", "east", "south", "west"][normalized] ?? null;
        }
        if (typeof value === "string") {
          const text = value.trim().toLowerCase();
          if (!text) continue;
          if (["north", "n", "spawn", "0"].includes(text)) return "north";
          if (["east", "e", "right", "r", "1"].includes(text)) return "east";
          if (["south", "s", "2"].includes(text)) return "south";
          if (["west", "w", "left", "l", "3"].includes(text)) return "west";
        }
      }
      return null;
    };
    const looksLikeGame = (value) =>
      value &&
      typeof value === "object" &&
      typeof value.ejectState === "function" &&
      typeof value.ejectBoardState === "function";
    const candidateEnded = (candidate) => {
      if (!looksLikeGame(candidate)) return false;

      try {
        const exported = candidate.ejectState();
        const state =
          exported && typeof exported === "object" && exported.game
            ? exported.game
            : exported;

        return Boolean(
          state?.destroyed ||
          state?.dead ||
          state?.gameover
        );
      } catch {
        return false;
      }
    };
    const usableGame = (candidate) => {
      if (!looksLikeGame(candidate)) return false;

      if (candidate === window.__fusionEndedTetrioGame) {
        if (candidateEnded(candidate)) {
          return false;
        }

        delete window.__fusionEndedTetrioGame;
      }

      return true;
    };
    const scanObject = (root, limit = 200) => {
      if (!root || typeof root !== "object") return null;
      let names = [];
      try { names = Object.getOwnPropertyNames(root).slice(0, limit); } catch {}
      for (const name of names) {
        try {
          const value = root[name];
          if (usableGame(value)) return value;
        } catch {}
      }
      return null;
    };
    const findGame = () => {
      const direct = [window.__fusionTetrioGame, window.tetrioGame, window.TETRIO_GAME, window.game, window.app, window.tetrio];
      for (const candidate of direct) {
        if (usableGame(candidate)) return candidate;
        const nested = scanObject(candidate);
        if (nested) return nested;
      }
      const names = Object.getOwnPropertyNames(window).slice(0, 1500);
      for (const name of names) {
        try {
          const value = window[name];
          if (usableGame(value)) return value;
        } catch {}
      }
      return null;
    };

    const game = findGame();
    if (!game) {
      return { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" };
    }
    window.__fusionTetrioGame = game;
    const exported = typeof game.ejectState === "function" ? game.ejectState() : null;
    const boardState = typeof game.ejectBoardState === "function" ? game.ejectBoardState() : null;
    const state = exported && typeof exported === "object" && exported.game ? exported.game : exported;
    if (!state || typeof state !== "object") {
      return { ok: false, ready: false, reason: "TETR.IO game state is not available" };
    }

    const board =
      Array.isArray(state.board) ? state.board :
      Array.isArray(boardState?.b) ? boardState.b :
      null;
    if (!Array.isArray(board) || board.length === 0) {
      return { ok: false, ready: false, reason: "TETR.IO board is not available" };
    }

    const activeState = state.falling ?? state.active ?? state.current ?? state.piece;
    const current = normalizePiece(activeState);
    const hold = normalizePiece(state.hold ?? state.held);
    const queue = queueFrom(state.bag, state.queue, state.next, state.preview, state.previews, state.pieces);
    const stats = state.stats ?? {};
    const pieceCounter = Math.max(0, Math.floor(numberFrom(
      stats.piecesplaced,
      stats.piecesPlaced,
      stats.pieces,
      state.piecesplaced,
      state.piecesPlaced,
      state.pieceCounter,
      state.piececount
    ) ?? -1));
    const linesClearedRaw = numberFrom(
      stats.lines,
      stats.linesCleared,
      stats.lines_cleared,
      state?.stats?.lines,
      state?.stats?.linesCleared,
      state?.stats?.lines_cleared
    );
    const linesCleared =
      linesClearedRaw === null ? null : Math.max(0, Math.floor(linesClearedRaw));
    if (!current || pieceCounter < 0) {
      return { ok: false, ready: false, reason: "TETR.IO current piece or piece counter is not available" };
    }

    const activeX = integerFrom(
      activeState?.x,
      activeState?.col,
      activeState?.column,
      activeState?.cx
    );
    const activeY = integerFrom(
      activeState?.y,
      activeState?.row,
      activeState?.cy
    );
    const activeRotation = rotationFrom(
      activeState?.rotation,
      activeState?.rot,
      activeState?.orientation,
      activeState?.dir,
      activeState?.state
    );

    const playing =
      typeof game.isPlaying === "function" ? Boolean(game.isPlaying()) :
      typeof state.playing === "boolean" ? state.playing :
      typeof state.paused === "boolean" ? !state.paused :
      true;
    const started =
      typeof game.isStarted === "function" ? Boolean(game.isStarted()) :
      Boolean(state.started ?? true);
    const destroyed = Boolean(state.destroyed || state.dead || state.gameover);
    const countdown = started && !destroyed && !playing;
    const ready = started && !destroyed;
    const field = Array.from({ length: 40 }, (_, rowIndex) => {
      const sourceRow = board[board.length - 1 - rowIndex];
      const cells = rowCells(sourceRow);
      return Array.from({ length: 10 }, (_, x) => filled(cells ? cells[x] : null));
    });
    return {
      ok: true,
      ready,
      reason: ready ? null : !started ? "TETR.IO game is not started" : "TETR.IO game ended",
      field,
      current,
      hold,
      queue,
      b2b: Math.max(0, numberFrom(stats.b2b, state.b2b, 0) ?? 0) > 0,
      combo: Math.max(0, numberFrom(stats.combo, state.combo, 0) ?? 0),
      incoming: Math.max(0, numberFrom(stats.impendingdamage, state.incoming, 0) ?? 0),
      pieceCounter,
      linesCleared: linesCleared ?? undefined,
      playing,
      countdown,
      activeX,
      activeY,
      activeRotation
    };
  })()`;
}

function writeSnapshot(snapshotPath, payload) {
  const directory = path.dirname(snapshotPath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${snapshotPath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(payload, null, 2));
  rmSync(snapshotPath, { force: true });
  renameSync(temporaryPath, snapshotPath);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    console.error("[browser] fatal:", error?.message ?? error);
    process.exit(1);
  });
}
