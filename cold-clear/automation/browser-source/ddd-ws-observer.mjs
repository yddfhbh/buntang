import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_BRIDGE_PATH,
  createVsBridgeAccumulatorState,
  createVsBridgeState,
  ingestVsBridgeSessionSelfIdentity,
  ingestVsBridgeOptionsCandidate,
  ingestVsBridgeRoot,
  isZenithBagtype,
  isVsWsSimEnabled,
  markVsBridgeInactive,
  promoteVsBridgeAccumulator,
  resetVsBridgeZenithAccumulator,
  setVsBridgeConfiguredLocalUsername,
} from "./vs-ws-bridge.mjs";

const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 12;
const MAX_VISITED_OBJECTS = 5000;
const MAX_TRACE_RECORDS = 500;
const MAX_TRACE_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TRACE_RECORD_BYTES = 32 * 1024;
const OPTIONS_SIGNATURE_DEDUPE_WINDOW_MS = 2000;
const DEFAULT_TRACE_FILE_PATH = path.join("automation", "ws-live-candidates.jsonl");
const DEFAULT_VS_BRIDGE_PATH = DEFAULT_BRIDGE_PATH;
const DEFAULT_SESSION_SELF_PROBE_RETRY_MS = 250;
const DEFAULT_SESSION_SELF_PROBE_MAX_ATTEMPTS = 5;
const PREBUFFER_MAX_AGE_MS = 10_000;
const PREBUFFER_MAX_ITEMS = 500;
const MODE_SOLO = "solo";
const MODE_ZENITH = "zenith";
const MODE_FRIENDLY_VS = "friendly_vs";
const SENSITIVE_KEYS = new Set([
  "token",
  "auth",
  "authorization",
  "cookie",
  "session",
  "jwt",
  "password",
  "secret",
  "signature",
  "endpoint",
  "handling"
]);
const ALLOWED_OPTION_KEYS = [
  "seed",
  "bagtype",
  "nextcount",
  "boardwidth",
  "boardheight",
  "boardbuffer",
  "countdown",
  "countdown_count",
  "countdown_interval",
  "precountdown",
  "gameid",
  "gametype",
  "spinbonuses",
  "combotable",
  "b2bcharging",
  "garbagemultiplier",
  "garbagecap",
  "garbageblocking",
  "display_next",
  "display_hold"
];
const IDENTITY_KEYS = new Set([
  "gameid",
  "game_id",
  "id",
  "userid",
  "user_id",
  "username",
  "name",
  "players",
  "player",
  "slot",
  "index"
]);
const BOARD_KEYS = new Set(["board", "field"]);
const PIECE_KEYS = new Set([
  "falling",
  "active",
  "current",
  "piece",
  "hold",
  "held",
  "queue",
  "bag",
  "next",
  "preview",
  "pieces"
]);
const REPLAY_KEYS = new Set([
  "replay",
  "events",
  "frames",
  "frame",
  "ige",
  "data",
  "key",
  "keys",
  "inputs",
  "interaction",
  "lock",
  "spawn"
]);
const GARBAGE_KEYS = new Set([
  "garbage",
  "garbagequeue",
  "incoming",
  "targets",
  "target",
  "attack",
  "damage",
  "gameover",
  "gameoverreason",
  "winner",
  "victims"
]);
const CONTEXT_KEYS = [
  "username",
  "name",
  "userid",
  "user_id",
  "gameid",
  "game_id",
  "session",
  "sessionid",
  "session_id",
  "roomid",
  "room_id",
  "slot",
  "index",
  "local",
  "self",
  "me",
  "opponent",
  "type",
  "role"
];
const TRACE_FIRST_LOG_KINDS = new Set(["identity", "board", "replay", "garbage"]);
const TRACE_SUMMARY_SCALAR_KEYS = [
  "seed",
  "gameid",
  "username",
  "name",
  "userid",
  "piece",
  "current",
  "hold",
  "held",
  "incoming",
  "frame",
  "id",
  "slot",
  "index"
];
const GARBAGE_INTERACTION_EVENT_TYPES = new Set([
  "interaction",
  "interaction_confirm"
]);
const GARBAGE_INTERACTION_DATA_KEYS = [
  "type",
  "gameid",
  "frame",
  "amt",
  "size",
  "x",
  "y",
  "zthalt",
  "iid",
  "ackiid",
  "cid"
];

function safeLog(log, message) {
  try {
    log?.(message);
  } catch {}
}

export async function installDddWsObserver(
  cdp,
  {
    unpack,
    log,
    traceEnabled = process.env.FUSION_DDD_WS_TRACE === "1",
    traceFilePath = DEFAULT_TRACE_FILE_PATH,
    vsSimEnabled = isVsWsSimEnabled(),
    vsBridgeEnabled = true,
    vsBridgePath = DEFAULT_VS_BRIDGE_PATH,
    onVsRoundStatus = null,
    onGameOptions = null,
    onDiagnosticEnvelope = null,
    perfEnabled = process.env.FUSION_BROWSER_PERF === "1",
    resolveSessionSelfIdentity = null,
    sessionSelfProbeRetryMs = DEFAULT_SESSION_SELF_PROBE_RETRY_MS,
    sessionSelfProbeMaxAttempts = DEFAULT_SESSION_SELF_PROBE_MAX_ATTEMPTS,
    now: nowFn = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
  } = {}
) {
  const logger = (message) => safeLog(log, message);

  if (typeof unpack !== "function") {
    safeLog(log, "[ws-observer] msgpackr unavailable; observer inactive");
    return () => {};
  }

  let vsBridge = null;
  if (vsBridgeEnabled) {
    try {
      vsBridge = createVsBridgeState(vsBridgePath, logger);
      safeLog(
        log,
        `[vs-bridge] observer attached mode=${vsSimEnabled ? "simulation" : "passive"}`
      );
    } catch (error) {
      safeLog(
        log,
        `[vs-bridge] initialization failed: ${error?.message ?? String(error)}`
      );
    }
  }

  const observerState = {
    requestUrls: new Map(),
    recentOptionsSignatures: new Map(),
    framesReceived: 0,
    binaryFramesReceived: 0,
    decodeAttempts: 0,
    optionsCaptured: 0,
    optionsCaptureSequence: 0,
    trace: null,
    vsBridge,
    modeController: createModeControllerState(),
    resolveSessionSelfIdentity,
    sessionSelfProbe: createSessionSelfProbeState({
      retryMs: sessionSelfProbeRetryMs,
      maxAttempts: sessionSelfProbeMaxAttempts,
      now: nowFn,
      setTimeoutFn,
      clearTimeoutFn
    }),
    lastVsRoundStatusKey: "",
    perf: perfEnabled
      ? {
          lastLoggedAt: Date.now(),
          wsFrames: 0,
          wsFrameElapsedTotalMs: 0
        }
      : null
  };
  if (traceEnabled) {
    try {
      observerState.trace = createTraceRecorder(traceFilePath, logger);
    } catch (error) {
      safeLog(
        log,
        `[ws-trace] disabled after initialization error: ${
          error?.message ?? String(error)
        }`
      );
    }
  }

  await cdp.send("Network.enable").catch(() => undefined);

  const offCreated = cdp.on("Network.webSocketCreated", (event) => {
    try {
      const requestId = event?.requestId;
      const url = typeof event?.url === "string" ? event.url : "";
      if (!requestId || !url) {
        return;
      }
      observerState.requestUrls.set(requestId, url);
      safeLog(log, `[ws-observer] websocket opened host=${safeUrlHost(url)}`);
      if (isZenithModeActive(observerState)) {
        notifySessionSelfProbeTrigger(observerState, cdp, logger, onVsRoundStatus, {
          reason: "websocket_open"
        });
      }
    } catch {}
  });

  const offClosed = cdp.on("Network.webSocketClosed", (event) => {
    try {
      if (event?.requestId) {
        observerState.requestUrls.delete(event.requestId);
      }
      markVsBridgeInactive(observerState.vsBridge, logger);
      emitVsRoundStatusIfChanged(observerState, onVsRoundStatus);
    } catch {}
  });

  const processWsFrame = (direction, event) => {
    try {
      const frameStartedAt = Date.now();
      observerState.framesReceived += 1;
      const payloadData = event?.response?.payloadData;
      if (typeof payloadData !== "string" || payloadData.length === 0) {
        recordPerfFrame(observerState, frameStartedAt, logger);
        return;
      }

      const opcode = event?.response?.opcode;
      if (opcode === 2) {
        observerState.binaryFramesReceived += 1;
        const payload = Buffer.from(payloadData, "base64");
        if (payload.length === 0 || payload.length > MAX_PAYLOAD_BYTES) {
          return;
        }
        const decodedRoots = collectDecodedRoots(payload, unpack);
        const candidates = collectOptionCandidates(decodedRoots);
        const timestamp = Date.now();
        const urlHost = resolveTraceUrlHost(event?.requestId, observerState);
        observerState.decodeAttempts += decodeAttemptCount(payload);
        for (const chunk of split87Frame(payload)) {
          observerState.decodeAttempts += decodeAttemptCount(chunk);
        }
        const prebufferEntry = {
          requestId: event?.requestId ?? null,
          urlHost,
          capturedAt: timestamp,
          candidates,
          decodedRoots
        };
        recordSelectedModePrebuffer(observerState, prebufferEntry);
        updateFriendlyVsBootstrap(observerState, prebufferEntry, logger);
        emitDiagnosticEnvelope(
          onDiagnosticEnvelope,
          buildDiagnosticWsEnvelopeRecord({
            direction,
            event,
            decodedRoots,
            candidates,
            observerState,
            timestamp
          })
        );
        logCapturedCandidates(
          candidates,
          event?.requestId,
          observerState,
          log,
          onGameOptions,
          cdp,
          logger,
          onVsRoundStatus,
          {
            allowBridgeIngest: isBridgeIngestActive(observerState),
            allowSoloSignals: isSoloModeActive(observerState)
          }
        );
        if (isBridgeIngestActive(observerState)) {
          ingestZenithDecodedRoots(
            observerState,
            decodedRoots,
            {
              timestamp,
              urlHost,
              requestId: event?.requestId ?? null
            },
            logger,
            onVsRoundStatus
          );
        }
        traceDecodedRoots(decodedRoots, event, observerState, log);
        recordPerfFrame(observerState, frameStartedAt, logger);
        return;
      }

      if (opcode === 1) {
        if (payloadData.length > MAX_PAYLOAD_BYTES) {
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(payloadData);
        } catch {
          return;
        }
        if (!parsed || typeof parsed !== "object") {
          return;
        }
        const decodedRoots = collectDecodedRoots(parsed, unpack);
        const candidates = collectOptionCandidates(decodedRoots);
        const timestamp = Date.now();
        const urlHost = resolveTraceUrlHost(event?.requestId, observerState);
        const prebufferEntry = {
          requestId: event?.requestId ?? null,
          urlHost,
          capturedAt: timestamp,
          candidates,
          decodedRoots
        };
        recordSelectedModePrebuffer(observerState, prebufferEntry);
        updateFriendlyVsBootstrap(observerState, prebufferEntry, logger);
        emitDiagnosticEnvelope(
          onDiagnosticEnvelope,
          buildDiagnosticWsEnvelopeRecord({
            direction,
            event,
            decodedRoots,
            candidates,
            observerState,
            timestamp
          })
        );
        logCapturedCandidates(
          candidates,
          event?.requestId,
          observerState,
          log,
          onGameOptions,
          cdp,
          logger,
          onVsRoundStatus,
          {
            allowBridgeIngest: isBridgeIngestActive(observerState),
            allowSoloSignals: isSoloModeActive(observerState)
          }
        );
        if (isBridgeIngestActive(observerState)) {
          ingestZenithDecodedRoots(
            observerState,
            decodedRoots,
            {
              timestamp,
              urlHost,
              requestId: event?.requestId ?? null
            },
            logger,
            onVsRoundStatus
          );
        }
        traceDecodedRoots(decodedRoots, event, observerState, log);
      }
      recordPerfFrame(observerState, frameStartedAt, logger);
    } catch {}
  };

  const offReceived = cdp.on("Network.webSocketFrameReceived", (event) => {
    processWsFrame("inbound", event);
  });
  const offSent = cdp.on("Network.webSocketFrameSent", (event) => {
    processWsFrame("outbound", event);
  });

  const cleanup = () => {
    cancelSessionSelfProbeLoop(observerState, { shutdown: true });
    markVsBridgeInactive(observerState.vsBridge, logger);
    emitVsRoundStatusIfChanged(observerState, onVsRoundStatus);
    offCreated();
    offClosed();
    offReceived();
    offSent();
    observerState.requestUrls.clear();
    finalizeTrace(observerState, logger);
  };
  cleanup.notifyTargetReset = (reason = "target_reset") => {
    notifySessionSelfProbeTargetReset(observerState, logger, reason);
  };
  cleanup.notifyBootstrapReady = () => {
    notifySessionSelfProbeBootstrapReady(
      observerState,
      cdp,
      logger,
      onVsRoundStatus
    );
  };
  cleanup.notifyZenithOptionsObserved = () => {
    notifySessionSelfProbeTrigger(observerState, cdp, logger, onVsRoundStatus, {
      reason: "zenith_options_missing_self"
    });
  };
  cleanup.setModeControl = (control) => {
    setModeControlState(observerState, control, cdp, logger, onVsRoundStatus);
  };
  cleanup.cancelSessionProbe = () => {
    cancelSessionSelfProbeLoop(observerState);
  };
  return cleanup;
}

function emitVsRoundStatusIfChanged(observerState, onVsRoundStatus) {
  if (typeof onVsRoundStatus !== "function") {
    return;
  }

  const current = observerState?.vsBridge?.current ?? null;
  const active = Boolean(current?.active);
  const roundId = active ? String(current?.roundId ?? "") : "";
  const localGameId = active ? String(current?.local?.gameid ?? "") : "";
  const seed = active ? String(current?.options?.seed ?? "") : "";
  const nextKey = `${active ? 1 : 0}|${roundId}|${localGameId}|${seed}`;
  if (nextKey === observerState.lastVsRoundStatusKey) {
    return;
  }
  observerState.lastVsRoundStatusKey = nextKey;
  try {
    onVsRoundStatus({
      active,
      roundId,
      localGameId,
      seed
    });
  } catch {}
}

function normalizeModeValue(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === MODE_ZENITH) {
    return MODE_ZENITH;
  }
  if (normalized === MODE_FRIENDLY_VS) {
    return MODE_FRIENDLY_VS;
  }
  return MODE_SOLO;
}

function normalizeModeControlScalar(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function createModeControllerState() {
  return {
    selectedMode: MODE_SOLO,
    botEnabled: false,
    modeGeneration: 0,
    localTetrioUsername: null,
    zenithPrebuffer: [],
    friendlyVsPrebuffer: [],
    friendlyVsBootstrap: null,
    lastPassiveMode: "",
    lastLoggedActivationKey: ""
  };
}

function isZenithModeActive(observerState) {
  return Boolean(observerState?.modeController?.botEnabled) &&
    normalizeModeValue(observerState?.modeController?.selectedMode) === MODE_ZENITH;
}

function isFriendlyVsModeActive(observerState) {
  return Boolean(observerState?.modeController?.botEnabled) &&
    normalizeModeValue(observerState?.modeController?.selectedMode) ===
      MODE_FRIENDLY_VS;
}

function isBridgeIngestActive(observerState) {
  return isZenithModeActive(observerState) || isFriendlyVsModeActive(observerState);
}

function isSoloModeActive(observerState) {
  return Boolean(observerState?.modeController?.botEnabled) &&
    normalizeModeValue(observerState?.modeController?.selectedMode) === MODE_SOLO;
}

function selectedPrebufferForMode(observerState, mode = null) {
  const selectedMode = normalizeModeValue(
    mode ?? observerState?.modeController?.selectedMode
  );
  if (selectedMode === MODE_ZENITH) {
    return observerState?.modeController?.zenithPrebuffer ?? [];
  }
  if (selectedMode === MODE_FRIENDLY_VS) {
    return observerState?.modeController?.friendlyVsPrebuffer ?? [];
  }
  return null;
}

function clearAllModePrebuffers(observerState) {
  observerState?.modeController?.zenithPrebuffer?.splice?.(0);
  observerState?.modeController?.friendlyVsPrebuffer?.splice?.(0);
}

function pruneModePrebuffer(buffer, now = Date.now()) {
  if (!Array.isArray(buffer)) {
    return 0;
  }
  while (buffer.length > 0) {
    const first = buffer[0];
    const firstAt = Math.max(0, Number(first?.capturedAt ?? 0));
    if (now - firstAt <= PREBUFFER_MAX_AGE_MS) {
      break;
    }
    buffer.shift();
  }
  while (buffer.length > PREBUFFER_MAX_ITEMS) {
    buffer.shift();
  }
  return buffer.length;
}

function recordSelectedModePrebuffer(observerState, entry) {
  const buffer = selectedPrebufferForMode(observerState);
  if (!buffer) {
    return 0;
  }
  buffer.push({
    requestId: entry?.requestId ?? null,
    urlHost: entry?.urlHost ?? "",
    capturedAt: Math.max(0, Number(entry?.capturedAt ?? Date.now())),
    candidates: Array.isArray(entry?.candidates) ? entry.candidates : [],
    decodedRoots: Array.isArray(entry?.decodedRoots) ? entry.decodedRoots : []
  });
  return pruneModePrebuffer(buffer, Date.now());
}

function clearFriendlyVsBootstrap(observerState) {
  if (observerState?.modeController) {
    observerState.modeController.friendlyVsBootstrap = null;
  }
}

function ensureFriendlyVsBootstrap(observerState) {
  const modeController = observerState?.modeController;
  if (!modeController) {
    return null;
  }
  if (!modeController.friendlyVsBootstrap) {
    modeController.friendlyVsBootstrap = {
      roundKey: "",
      lastLoggedRoundId: "",
      accumulator: createVsBridgeAccumulatorState({
        configuredLocalUsername: modeController.localTetrioUsername
      })
    };
  }
  setVsBridgeConfiguredLocalUsername(
    modeController.friendlyVsBootstrap.accumulator,
    modeController.localTetrioUsername
  );
  return modeController.friendlyVsBootstrap;
}

function stringifyBootstrapScalar(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function collectFriendlyRoundIdentityTuples(decodedRoots, candidates) {
  const tuples = [];
  const seen = new Set();
  const pushTuple = (identity, gameid, seed) => {
    const normalizedGameid = stringifyBootstrapScalar(gameid);
    const normalizedSeed = stringifyBootstrapScalar(seed);
    if (!normalizedGameid || !normalizedSeed) {
      return;
    }
    const normalizedIdentity =
      stringifyBootstrapScalar(identity) ?? `gameid:${normalizedGameid}`;
    const key = `${normalizedIdentity}|${normalizedGameid}|${normalizedSeed}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    tuples.push({
      identity: normalizedIdentity,
      gameid: normalizedGameid,
      seed: normalizedSeed
    });
  };

  for (const root of decodedRoots ?? []) {
    const players = Array.isArray(root?.players) ? root.players : [];
    for (const player of players) {
      pushTuple(
        player?.userid ?? player?._id ?? player?.username ?? player?.name,
        player?.gameid ?? player?.options?.gameid,
        player?.options?.seed
      );
    }
  }

  for (const candidate of candidates ?? []) {
    pushTuple(
      candidate?.context?.userid ??
        candidate?.context?.user_id ??
        candidate?.context?._id ??
        candidate?.context?.username ??
        candidate?.context?.name,
      candidate?.options?.gameid,
      candidate?.options?.seed
    );
  }

  return tuples;
}

function deriveFriendlyVsRoundKey(decodedRoots, candidates) {
  const tuples = collectFriendlyRoundIdentityTuples(decodedRoots, candidates);
  const bySeed = new Map();
  for (const tuple of tuples) {
    const group = bySeed.get(tuple.seed) ?? [];
    group.push(tuple);
    bySeed.set(tuple.seed, group);
  }
  let bestGroup = null;
  for (const group of bySeed.values()) {
    const distinctGameIds = new Set(group.map((entry) => entry.gameid));
    if (distinctGameIds.size < 2) {
      continue;
    }
    if (!bestGroup || group.length > bestGroup.length) {
      bestGroup = group;
    }
  }
  if (!bestGroup) {
    return "";
  }
  return bestGroup
    .map((entry) => `${entry.identity}:${entry.gameid}:${entry.seed}`)
    .sort()
    .join("|");
}

function updateFriendlyVsBootstrap(observerState, entry, log) {
  if (
    normalizeModeValue(observerState?.modeController?.selectedMode) !==
    MODE_FRIENDLY_VS
  ) {
    return null;
  }
  let bootstrap = ensureFriendlyVsBootstrap(observerState);
  if (!bootstrap) {
    return null;
  }
  const roundKey = deriveFriendlyVsRoundKey(
    entry?.decodedRoots ?? [],
    entry?.candidates ?? []
  );
  if (roundKey && bootstrap.roundKey && roundKey !== bootstrap.roundKey) {
    clearFriendlyVsBootstrap(observerState);
    bootstrap = ensureFriendlyVsBootstrap(observerState);
  }
  if (roundKey) {
    bootstrap.roundKey = roundKey;
  }

  const requestId = entry?.requestId ?? null;
  const capturedAt = Math.max(0, Number(entry?.capturedAt ?? Date.now()));
  const urlHost = String(entry?.urlHost ?? "");
  for (const candidate of entry?.candidates ?? []) {
    try {
      ingestVsBridgeOptionsCandidate(
        bootstrap.accumulator,
        {
          ...candidate,
          requestId,
          capturedAt
        },
        null
      );
    } catch {}
  }
  for (const decodedRoot of entry?.decodedRoots ?? []) {
    try {
      ingestVsBridgeRoot(
        bootstrap.accumulator,
        decodedRoot,
        { requestId, capturedAt, urlHost, timestamp: capturedAt },
        null
      );
    } catch {}
  }

  if (!bootstrap.roundKey) {
    bootstrap.roundKey =
      String(bootstrap.accumulator?.current?.roundId ?? "") ||
      String(bootstrap.accumulator?.roundObservationKey ?? "");
  }
  const roundId = String(bootstrap.accumulator?.current?.roundId ?? "");
  if (roundId && bootstrap.lastLoggedRoundId !== roundId) {
    bootstrap.lastLoggedRoundId = roundId;
    safeLog(log, `[friendly_vs] bootstrap retained roundId=${roundId}`);
  }
  return bootstrap;
}

function clearVsRuntimeState(observerState, log, onVsRoundStatus) {
  cancelSessionSelfProbeLoop(observerState);
  observerState.sessionSelfProbe.shutdown = false;
  if (observerState?.vsBridge?.current?.active) {
    markVsBridgeInactive(observerState.vsBridge, log);
  } else {
    resetVsBridgeZenithAccumulator(observerState.vsBridge);
  }
  emitVsRoundStatusIfChanged(observerState, onVsRoundStatus);
}

function ingestZenithDecodedRoots(
  observerState,
  decodedRoots,
  context,
  logger,
  onVsRoundStatus
) {
  let changed = false;
  for (const decodedRoot of decodedRoots) {
    try {
      const previousSignature = observerState?.vsBridge?.currentSignature ?? "";
      ingestVsBridgeRoot(observerState.vsBridge, decodedRoot, context, logger);
      changed =
        changed ||
        previousSignature !== String(observerState?.vsBridge?.currentSignature ?? "");
    } catch {}
  }
  if (changed) {
    emitVsRoundStatusIfChanged(observerState, onVsRoundStatus);
  }
}

function replayModePrebuffer(observerState, logger, onVsRoundStatus) {
  const buffer = [...(selectedPrebufferForMode(observerState) ?? [])];
  let candidateCount = 0;
  for (const entry of buffer) {
    const requestId = entry?.requestId ?? null;
    const capturedAt = Math.max(0, Number(entry?.capturedAt ?? Date.now()));
    const urlHost = String(entry?.urlHost ?? "");
    for (const candidate of entry?.candidates ?? []) {
      candidateCount += 1;
      try {
        ingestVsBridgeOptionsCandidate(
          observerState.vsBridge,
          {
            ...candidate,
            requestId,
            capturedAt
          },
          logger
        );
      } catch {}
    }
    ingestZenithDecodedRoots(
      observerState,
      entry?.decodedRoots ?? [],
      { requestId, capturedAt, urlHost, timestamp: capturedAt },
      logger,
      onVsRoundStatus
    );
  }
  safeLog(
    logger,
    `[${normalizeModeValue(observerState?.modeController?.selectedMode)}] prebuffer replayed candidates=${candidateCount}`
  );
}

function replayFriendlyVsBootstrap(observerState, logger, onVsRoundStatus) {
  const bootstrap = observerState?.modeController?.friendlyVsBootstrap;
  if (!bootstrap?.accumulator) {
    return null;
  }
  const current = promoteVsBridgeAccumulator(
    observerState?.vsBridge,
    bootstrap.accumulator,
    Date.now(),
    logger
  );
  if (!current) {
    return null;
  }
  emitVsRoundStatusIfChanged(observerState, onVsRoundStatus);
  const playerCount =
    1 + (Array.isArray(current?.opponents) ? current.opponents.length : 0);
  safeLog(
    logger,
    `[friendly_vs] bootstrap replayed roundId=${current.roundId} players=${playerCount}`
  );
  return current;
}

function setModeControlState(observerState, control, cdp, log, onVsRoundStatus) {
  const modeController = observerState?.modeController;
  if (!modeController) {
    return false;
  }
  const nextMode = normalizeModeValue(control?.selectedMode);
  const nextBotEnabled = control?.botEnabled === true;
  const nextGeneration = Math.max(0, Number(control?.modeGeneration ?? 0));
  const nextLocalTetrioUsername =
    normalizeModeControlScalar(
      control?.localTetrioUsername ?? control?.local_tetrio_username
    );
  const previousMode = normalizeModeValue(modeController.selectedMode);
  const previousBotEnabled = modeController.botEnabled === true;
  const previousGeneration = Math.max(0, Number(modeController.modeGeneration ?? 0));
  const previousLocalTetrioUsername =
    normalizeModeControlScalar(modeController.localTetrioUsername);
  const modeChanged = previousMode !== nextMode;
  const activationChanged =
    previousBotEnabled !== nextBotEnabled || previousGeneration !== nextGeneration;
  const localUsernameChanged =
    previousLocalTetrioUsername !== nextLocalTetrioUsername;
  modeController.localTetrioUsername = nextLocalTetrioUsername;
  setVsBridgeConfiguredLocalUsername(
    observerState?.vsBridge,
    nextLocalTetrioUsername
  );
  if (modeController.friendlyVsBootstrap?.accumulator) {
    setVsBridgeConfiguredLocalUsername(
      modeController.friendlyVsBootstrap.accumulator,
      nextLocalTetrioUsername
    );
  }
  if (modeController.lastPassiveMode !== nextMode) {
    modeController.lastPassiveMode = nextMode;
    safeLog(log, `[mode] passive websocket listener active mode=${nextMode}`);
  }
  if (!modeChanged && !activationChanged && !localUsernameChanged) {
    return false;
  }
  modeController.selectedMode = nextMode;
  modeController.botEnabled = nextBotEnabled;
  modeController.modeGeneration = nextGeneration;
  if (!modeChanged && !activationChanged && localUsernameChanged) {
    return true;
  }
  if (modeChanged || previousGeneration !== nextGeneration) {
    clearFriendlyVsBootstrap(observerState);
  }
  if (modeChanged) {
    modeController.lastLoggedActivationKey = "";
    clearVsRuntimeState(observerState, log, onVsRoundStatus);
    clearAllModePrebuffers(observerState);
  }
  if (!nextBotEnabled) {
    modeController.lastLoggedActivationKey = "";
    clearVsRuntimeState(observerState, log, onVsRoundStatus);
    safeLog(
      log,
      `[mode] activation cancelled mode=${nextMode} generation=${nextGeneration}`
    );
    return true;
  }
  if (nextMode === MODE_SOLO) {
    modeController.lastLoggedActivationKey = "";
    clearVsRuntimeState(observerState, log, onVsRoundStatus);
    return true;
  }
  const activationKey = `${nextMode}:${nextGeneration}`;
  if (modeController.lastLoggedActivationKey !== activationKey) {
    modeController.lastLoggedActivationKey = activationKey;
    safeLog(log, `[${nextMode}] activation started`);
  }
  clearVsRuntimeState(observerState, log, onVsRoundStatus);
  if (nextMode === MODE_ZENITH) {
    resetSessionSelfProbeActivation(observerState, log, "bot_on");
  }
  replayModePrebuffer(observerState, log, onVsRoundStatus);
  if (nextMode === MODE_FRIENDLY_VS) {
    replayFriendlyVsBootstrap(observerState, log, onVsRoundStatus);
  }
  if (nextMode === MODE_ZENITH) {
    notifySessionSelfProbeTrigger(observerState, cdp, log, onVsRoundStatus, {
      reason: "zenith_bot_on"
    });
  }
  return true;
}

function createSessionSelfProbeState({
  retryMs = DEFAULT_SESSION_SELF_PROBE_RETRY_MS,
  maxAttempts = DEFAULT_SESSION_SELF_PROBE_MAX_ATTEMPTS,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  return {
    retryMs: clampProbeRetryMs(retryMs),
    maxAttempts: clampProbeMaxAttempts(maxAttempts),
    now,
    setTimeoutFn,
    clearTimeoutFn,
    needed: true,
    bootstrapReady: false,
    attemptCount: 0,
    targetGeneration: 1,
    running: false,
    timer: null,
    scheduledDelayMs: 0,
    started: false,
    shutdown: false
  };
}

function clampProbeRetryMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_SESSION_SELF_PROBE_RETRY_MS;
  }
  return Math.max(200, Math.min(500, Math.round(numeric)));
}

function clampProbeMaxAttempts(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_SESSION_SELF_PROBE_MAX_ATTEMPTS;
  }
  return Math.max(1, Math.min(5, Math.round(numeric)));
}

function hasPinnedSessionSelf(observerState) {
  const identity = observerState?.vsBridge?.sessionSelfIdentity ?? null;
  return Boolean(identity?.userid || identity?.username);
}

function cancelSessionSelfProbeLoop(observerState, { shutdown = false } = {}) {
  const probe = observerState?.sessionSelfProbe;
  if (!probe) {
    return;
  }
  probe.shutdown = shutdown;
  if (probe.timer) {
    try {
      probe.clearTimeoutFn?.(probe.timer);
    } catch {}
    probe.timer = null;
  }
  probe.running = false;
  probe.scheduledDelayMs = 0;
}

function notifySessionSelfProbeTargetReset(
  observerState,
  log,
  reason = "target_reset"
) {
  if (!observerState?.sessionSelfProbe) {
    return;
  }
  const probe = observerState.sessionSelfProbe;
  if (probe.timer) {
    try {
      probe.clearTimeoutFn?.(probe.timer);
    } catch {}
    probe.timer = null;
  }
  probe.shutdown = false;
  probe.running = false;
  probe.scheduledDelayMs = 0;
  probe.attemptCount = 0;
  probe.bootstrapReady = false;
  probe.needed = true;
  probe.started = false;
  probe.targetGeneration += 1;
  resetVsBridgeZenithAccumulator(observerState.vsBridge);
  clearAllModePrebuffers(observerState);
  safeLog(
    log,
    `[vs-bridge] page session probe reset reason=${reason} target_generation=${probe.targetGeneration}`
  );
}

function resetSessionSelfProbeActivation(observerState, log, reason = "bot_on") {
  const probe = observerState?.sessionSelfProbe;
  if (!probe) {
    return;
  }
  if (probe.timer) {
    try {
      probe.clearTimeoutFn?.(probe.timer);
    } catch {}
    probe.timer = null;
  }
  probe.shutdown = false;
  probe.running = false;
  probe.scheduledDelayMs = 0;
  probe.attemptCount = 0;
  probe.needed = true;
  probe.started = false;
  probe.targetGeneration += 1;
  resetVsBridgeZenithAccumulator(observerState.vsBridge);
  safeLog(
    log,
    `[vs-bridge] page session probe reset reason=${reason} target_generation=${probe.targetGeneration}`
  );
}

function notifySessionSelfProbeBootstrapReady(
  observerState,
  cdp,
  log,
  onVsRoundStatus = null
) {
  const probe = observerState?.sessionSelfProbe;
  if (!probe) {
    return false;
  }
  probe.bootstrapReady = true;
  return notifySessionSelfProbeTrigger(
    observerState,
    cdp,
    log,
    onVsRoundStatus,
    { reason: "bootstrap_ready" }
  );
}

function notifySessionSelfProbeTrigger(
  observerState,
  cdp,
  log,
  onVsRoundStatus = null,
  {
    reason = "session_probe",
    delayMs = 0
  } = {}
) {
  if (!observerState?.vsBridge || !observerState?.sessionSelfProbe) {
    return false;
  }
  const probe = observerState.sessionSelfProbe;
  if (
    probe.shutdown ||
    !probe.needed ||
    hasPinnedSessionSelf(observerState) ||
    !isZenithModeActive(observerState)
  ) {
    if (hasPinnedSessionSelf(observerState)) {
      probe.needed = false;
    }
    return false;
  }
  if (!probe.bootstrapReady && reason !== "bootstrap_ready") {
    return false;
  }
  if (probe.running) {
    return false;
  }
  if (probe.attemptCount >= probe.maxAttempts) {
    probe.needed = false;
    return false;
  }
  const normalizedDelayMs = Math.max(0, Number(delayMs) || 0);
  const nextAttempt = probe.attemptCount + 1;
  if (probe.timer) {
    if (normalizedDelayMs > 0 || probe.scheduledDelayMs === 0) {
      return false;
    }
    try {
      probe.clearTimeoutFn?.(probe.timer);
    } catch {}
    probe.timer = null;
    probe.scheduledDelayMs = 0;
  }
  safeLog(
    log,
    `[vs-bridge] page session probe scheduled reason=${reason} target_generation=${probe.targetGeneration} attempt=${nextAttempt}`
  );
  if (normalizedDelayMs > 0) {
    probe.scheduledDelayMs = normalizedDelayMs;
    const generation = probe.targetGeneration;
    probe.timer = probe.setTimeoutFn(() => {
      probe.timer = null;
      probe.scheduledDelayMs = 0;
      void startSessionSelfProbeRun(
        observerState,
        cdp,
        log,
        onVsRoundStatus,
        reason,
        generation
      );
    }, normalizedDelayMs);
    return true;
  }
  void startSessionSelfProbeRun(
    observerState,
    cdp,
    log,
    onVsRoundStatus,
    reason,
    probe.targetGeneration
  );
  return true;
}

async function startSessionSelfProbeRun(
  observerState,
  cdp,
  log,
  onVsRoundStatus,
  reason,
  targetGeneration
) {
  const probe = observerState?.sessionSelfProbe;
  if (!probe || probe.shutdown || probe.running) {
    return false;
  }
  if (
    targetGeneration !== probe.targetGeneration ||
    !probe.needed ||
    hasPinnedSessionSelf(observerState) ||
    probe.attemptCount >= probe.maxAttempts
  ) {
    return false;
  }
  probe.running = true;
  probe.started = true;
  probe.attemptCount += 1;
  const attempt = probe.attemptCount;
  safeLog(
    log,
    `[vs-bridge] page session probe started reason=${reason} attempt=${attempt}`
  );
  let result = null;
  try {
    result = normalizeSessionSelfProbeResult(
      await resolveSessionSelfIdentity(observerState, cdp)
    );
  } catch (error) {
    result = {
      status: "error",
      error: error?.message ?? String(error),
      userid: null,
      username: null,
      sourcePath: null,
      keys: []
    };
  }
  probe.running = false;
  if (probe.shutdown || targetGeneration !== probe.targetGeneration) {
    return false;
  }
  logSessionSelfProbeResult(log, result, probe.targetGeneration);
  if (result.status === "resolved") {
    const changed = ingestVsBridgeSessionSelfIdentity(observerState.vsBridge, {
      userid: result.userid,
      username: result.username,
      source: result.sourcePath ?? "page_session_probe"
    });
    if (hasPinnedSessionSelf(observerState)) {
      probe.needed = false;
      if (changed) {
        emitVsRoundStatusIfChanged(observerState, onVsRoundStatus);
      }
      return changed;
    }
  }
  if (probe.attemptCount >= probe.maxAttempts) {
    probe.needed = false;
    return false;
  }
  return notifySessionSelfProbeTrigger(
    observerState,
    cdp,
    log,
    onVsRoundStatus,
    {
      reason: `retry_after_${result.status}`,
      delayMs: probe.retryMs
    }
  );
}

function normalizeSessionSelfProbeResult(result) {
  if (!result) {
    return {
      status: "not_found",
      userid: null,
      username: null,
      sourcePath: null,
      keys: []
    };
  }
  if (typeof result !== "object") {
    return {
      status: "not_found",
      userid: null,
      username: null,
      sourcePath: null,
      keys: []
    };
  }
  const status =
    result.status === "resolved" ||
    result.status === "not_ready" ||
    result.status === "not_found" ||
    result.status === "error"
      ? result.status
      : result.userid !== undefined ||
          result.username !== undefined ||
          result._id !== undefined ||
          result.user_id !== undefined ||
          result.name !== undefined
        ? "resolved"
        : "not_found";
  return {
    status,
    userid: sanitizeTraceScalar(result.userid ?? result._id ?? result.user_id) ?? null,
    username: sanitizeTraceScalar(result.username ?? result.name) ?? null,
    sourcePath:
      sanitizeTraceScalar(
        result.sourcePath ?? result.source_path ?? result.source
      ) ?? null,
    keys: sanitizeTraceKeyList(result.keys),
    error: sanitizeTraceScalar(result.error) ?? null
  };
}

function sanitizeTraceKeyList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => sanitizeTraceScalar(entry))
    .filter((entry) => typeof entry === "string")
    .slice(0, 12);
}

function logSessionSelfProbeResult(log, result, targetGeneration) {
  const keysLabel =
    Array.isArray(result?.keys) && result.keys.length > 0
      ? result.keys.join(",")
      : "-";
  const errorSuffix =
    result?.status === "error" && result?.error
      ? ` error=${result.error}`
      : "";
  safeLog(
    log,
    `[vs-bridge] page session probe result status=${result?.status ?? "not_found"} userid=${
      result?.userid ?? "null"
    } username=${result?.username ?? "null"} source_path=${
      result?.sourcePath ?? "null"
    } keys=${keysLabel} target_generation=${targetGeneration}${errorSuffix}`
  );
}

async function resolveSessionSelfIdentity(observerState, cdp) {
  if (typeof observerState?.resolveSessionSelfIdentity === "function") {
    return await observerState.resolveSessionSelfIdentity(cdp);
  }
  return await probePageSessionSelfIdentity(cdp);
}

async function probePageSessionSelfIdentity(cdp) {
  if (!cdp?.send) {
    return { status: "error", error: "cdp_unavailable" };
  }
  const response = await cdp.send("Runtime.evaluate", {
    expression: pageSessionIdentityExpression(),
    returnByValue: true,
    awaitPromise: false
  });
  const value = response?.result?.value;
  if (!value || typeof value !== "object") {
    return { status: "not_found" };
  }
  const status =
    sanitizeTraceScalar(value.status) ?? "resolved";
  const userid = sanitizeTraceScalar(value.userid ?? value._id ?? value.user_id);
  const username = sanitizeTraceScalar(value.username ?? value.name);
  const sourcePath =
    sanitizeTraceScalar(value.sourcePath ?? value.source) ?? null;
  if (
    status === "resolved" &&
    userid === undefined &&
    username === undefined
  ) {
    return { status: "not_found", sourcePath };
  }
  return {
    status,
    userid,
    username,
    sourcePath,
    keys: sanitizeTraceKeyList(value.keys)
  };
}

function pageSessionIdentityExpression() {
  return `(() => {
    const MAX_NODES = 400;
    const MAX_DEPTH = 4;
    if (
      !window ||
      !window.document ||
      (window.document.readyState &&
        window.document.readyState !== "complete" &&
        window.document.readyState !== "interactive")
    ) {
      return { status: "not_ready" };
    }
    const seen = new WeakSet();
    const participantHints = /players?|leaderboard|entrants?|bracket|naturalorder|opponents?|copies/i;
    const selfHints = /self|me|user|account|session|profile|auth|state|store/i;
    const queue = [{ value: window, path: "window", depth: 0 }];
    let visited = 0;
    let best = null;
    const scalar = (value) =>
      value === null ||
      value === undefined ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
        ? value
        : undefined;
    const scoreCandidate = (path, value) => {
      let score = 0;
      if (selfHints.test(path)) score += 4;
      if (participantHints.test(path)) score -= 10;
      if (scalar(value?.userid ?? value?._id ?? value?.user_id) !== undefined) score += 3;
      if (scalar(value?.username ?? value?.name) !== undefined) score += 2;
      if (path.includes(".__NUXT__") || path.includes(".$nuxt") || path.includes(".store")) {
        score += 2;
      }
      if (/session|account|auth|profile/.test(path)) {
        score += 3;
      }
      if (scalar(value?.gameid ?? value?.game_id) !== undefined) score -= 4;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if (value.options || value.players || value.player || value.naturalorder !== undefined) {
          score -= 8;
        }
      }
      return score;
    };
    while (queue.length > 0 && visited < MAX_NODES) {
      const current = queue.shift();
      const value = current?.value;
      if (!value || typeof value !== "object") continue;
      if (seen.has(value)) continue;
      seen.add(value);
      visited += 1;
      const userid = scalar(value.userid ?? value._id ?? value.user_id);
      const username = scalar(value.username ?? value.name);
      if (userid !== undefined || username !== undefined) {
        const score = scoreCandidate(current.path, value);
        if (score > 0 && (!best || score > best.score)) {
          best = {
            userid,
            username,
            sourcePath: current.path,
            keys: Object.keys(value).slice(0, 12),
            score
          };
        }
      }
      if (current.depth >= MAX_DEPTH) continue;
      const entries = Array.isArray(value)
        ? value.map((entry, index) => [String(index), entry])
        : Object.entries(value);
      for (const [key, entry] of entries) {
        if (typeof entry !== "object" || entry === null) continue;
        if (participantHints.test(key) && current.path === "window") continue;
        queue.push({
          value: entry,
          path: current.path + "." + key,
          depth: current.depth + 1
        });
      }
    }
    if (best) {
      return {
        status: "resolved",
        userid: best.userid ?? null,
        username: best.username ?? null,
        sourcePath: best.sourcePath,
        keys: best.keys
      };
    }
    return {
      status: "not_found"
    };
  })()`;
}

function recordPerfFrame(observerState, frameStartedAt, log) {
  const perf = observerState?.perf;
  if (!perf) {
    return;
  }
  perf.wsFrames += 1;
  perf.wsFrameElapsedTotalMs += Math.max(0, Date.now() - frameStartedAt);
  if (Date.now() - perf.lastLoggedAt < 2000) {
    return;
  }
  safeLog(log, `[browser-perf] ws_frame elapsed_ms=${perf.wsFrameElapsedTotalMs}`);
  perf.lastLoggedAt = Date.now();
  perf.wsFrames = 0;
  perf.wsFrameElapsedTotalMs = 0;
}

export function split87Frame(buf) {
  const chunks = [];

  if (!Buffer.isBuffer(buf) || buf.length < 4) {
    return chunks;
  }

  if (buf[0] !== 0x87) {
    return chunks;
  }

  let pos = 4;

  while (pos + 4 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    pos += 4;

    if (
      length <= 0 ||
      length > 2 * 1024 * 1024 ||
      pos + length > buf.length
    ) {
      break;
    }

    chunks.push(buf.subarray(pos, pos + length));
    pos += length;
  }

  return chunks;
}

export function tryUnpackAtOffsets(buffer, unpack) {
  const values = [];

  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length === 0 ||
    typeof unpack !== "function"
  ) {
    return values;
  }

  const maximumOffset = Math.min(24, buffer.length - 1);

  for (let offset = 0; offset <= maximumOffset; offset += 1) {
    try {
      values.push(unpack(buffer.subarray(offset)));
    } catch {}
  }

  return values;
}

export function decodeGameOptionsCandidates(payload, unpack) {
  const candidates = [];
  collectDecodedCandidates(candidates, collectDecodedRoots(payload, unpack));
  return candidates.map((candidate) => candidate.options);
}

export function decodeGameOptionsCandidateRecords(payload, unpack) {
  const candidates = [];
  collectDecodedCandidates(candidates, collectDecodedRoots(payload, unpack));
  return candidates;
}

export function buildDiagnosticWsEnvelopeRecord({
  direction = "inbound",
  event = null,
  decodedRoots = [],
  candidates = [],
  observerState = null,
  timestamp = Date.now()
} = {}) {
  const websocketRequestId =
    sanitizeTraceScalar(event?.requestId) ??
    sanitizeTraceScalar(event?.request_id) ??
    null;
  const messageRequestId =
    resolveEnvelopeScalar(decodedRoots, [
      "request_id",
      "requestId",
      "reqid",
      "req_id",
      "id"
    ]) ?? null;
  const rootKeys = collectRootKeyList(decodedRoots);
  const payloadKeys = collectPayloadKeyList(decodedRoots);
  const players = collectDiagnosticWsPlayers(decodedRoots);
  const sanitizedCandidates = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => sanitizeDiagnosticOptionsCandidate(candidate))
    .filter(Boolean);
  const useridSet = new Set();
  const gameidSet = new Set();
  for (const player of players) {
    if (player.userid !== null && player.userid !== undefined) {
      useridSet.add(String(player.userid));
    }
    if (player.gameid !== null && player.gameid !== undefined) {
      gameidSet.add(String(player.gameid));
    }
  }
  for (const candidate of sanitizedCandidates) {
    if (candidate.userid !== null && candidate.userid !== undefined) {
      useridSet.add(String(candidate.userid));
    }
    if (candidate.gameid !== null && candidate.gameid !== undefined) {
      gameidSet.add(String(candidate.gameid));
    }
  }
  return {
    timestamp: Math.max(0, Number(timestamp ?? Date.now())),
    direction: direction === "outbound" ? "outbound" : "inbound",
    request_id: messageRequestId ?? websocketRequestId,
    websocket_request_id: websocketRequestId,
    message_request_id: messageRequestId,
    websocket_session: websocketRequestId,
    mode_generation: Math.max(
      0,
      Number(observerState?.modeController?.modeGeneration ?? 0)
    ),
    url_host: resolveTraceUrlHost(websocketRequestId, observerState),
    opcode: event?.response?.opcode ?? null,
    event: resolveEnvelopeScalar(decodedRoots, ["event"]),
    type: resolveEnvelopeScalar(decodedRoots, ["type"]),
    command: resolveEnvelopeScalar(decodedRoots, ["command", "cmd", "action"]),
    root_keys: rootKeys,
    payload_keys: payloadKeys,
    candidate_paths: sanitizedCandidates
      .map((candidate) => sanitizeTraceScalar(candidate?.path))
      .filter((entry) => typeof entry === "string")
      .slice(0, 24),
    distinct_userid_count: useridSet.size,
    distinct_gameid_count: gameidSet.size,
    players,
    candidates: sanitizedCandidates
  };
}

export function findGameOptions(root) {
  const seen = new WeakSet();
  const counters = {
    visitedObjects: 0
  };
  return visitForGameOptions(root, 0, seen, counters);
}

export function sanitizeGameOptions(options) {
  if (!options || typeof options !== "object") {
    return null;
  }

  const sanitized = {};
  for (const key of ALLOWED_OPTION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(options, key)) {
      continue;
    }
    try {
      sanitized[key] = options[key];
    } catch {}
  }

  if (
    !Object.prototype.hasOwnProperty.call(sanitized, "seed") ||
    !Object.prototype.hasOwnProperty.call(sanitized, "bagtype")
  ) {
    return null;
  }

  return sanitized;
}

function collectDecodedCandidates(target, values) {
  for (const value of values) {
    collectOptionCandidatesFromValue(
      target,
      value,
      "root",
      [],
      new WeakSet(),
      { visitedObjects: 0 },
      0
    );
  }
}

function visitForGameOptions(value, depth, seen, counters) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (depth > MAX_DEPTH || counters.visitedObjects >= MAX_VISITED_OBJECTS) {
    return null;
  }
  if (seen.has(value)) {
    return null;
  }

  seen.add(value);
  counters.visitedObjects += 1;

  const directMatch = extractGameOptionsCandidate(value);
  if (directMatch) {
    return directMatch;
  }

  if (depth === MAX_DEPTH) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = visitForGameOptions(entry, depth + 1, seen, counters);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  for (const key of Object.keys(value)) {
    if (isSensitiveKey(key)) {
      continue;
    }
    let nestedValue;
    try {
      nestedValue = value[key];
    } catch {
      continue;
    }
    const nested = visitForGameOptions(
      nestedValue,
      depth + 1,
      seen,
      counters
    );
    if (nested) {
      return nested;
    }
  }

  return null;
}

function extractGameOptionsCandidate(value) {
  if (hasSeedAndBagtype(value)) {
    return value;
  }

  if (
    Object.prototype.hasOwnProperty.call(value, "options") &&
    hasSeedAndBagtype(value.options)
  ) {
    return mergeAllowedOptionShape(value, value.options);
  }

  if (
    Object.prototype.hasOwnProperty.call(value, "setoptions") &&
    hasSeedAndBagtype(value.setoptions)
  ) {
    return mergeAllowedOptionShape(value, value.setoptions);
  }

  return null;
}

function hasSeedAndBagtype(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      Object.prototype.hasOwnProperty.call(value, "seed") &&
      Object.prototype.hasOwnProperty.call(value, "bagtype")
  );
}

function mergeAllowedOptionShape(parent, child) {
  const merged = {};
  for (const source of [parent, child]) {
    for (const key of ALLOWED_OPTION_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) {
        continue;
      }
      try {
        merged[key] = source[key];
      } catch {}
    }
  }
  return merged;
}

function isSensitiveKey(key) {
  return SENSITIVE_KEYS.has(String(key).toLowerCase());
}

export function shouldEmitSoloSignalForGameOptions(options) {
  return !isZenithBagtype(options?.bagtype);
}

function logCapturedCandidates(
  candidates,
  requestId,
  observerState,
  log,
  onGameOptions = null,
  cdp = null,
  logger = log,
  onVsRoundStatus = null,
  {
    allowBridgeIngest = true,
    allowSoloSignals = true
  } = {}
) {
  for (const candidate of candidates) {
    const options = candidate?.options ?? null;
    if (!options) {
      continue;
    }
    const signature = buildOptionsSignature(options);
    const now = Date.now();
    const summary = summarizeOptionsForSignalLog(options);
    if (!signature) {
      safeLog(
        log,
        "[browser] solo signal ignored reason=missing_signature signature=missing"
      );
      continue;
    }
    pruneRecentOptionSignatures(observerState, now);
    const lastSeenAt = observerState.recentOptionsSignatures.get(signature) ?? 0;
    if (lastSeenAt > 0 && now - lastSeenAt < OPTIONS_SIGNATURE_DEDUPE_WINDOW_MS) {
      safeLog(
        log,
        `[browser] solo signal ignored reason=duplicate_signature_window signature=${signature}`
      );
      continue;
    }
    observerState.recentOptionsSignatures.set(signature, now);
    observerState.optionsCaptured += 1;
    observerState.optionsCaptureSequence += 1;
    if (allowBridgeIngest) {
      try {
        ingestVsBridgeOptionsCandidate(observerState.vsBridge, {
          ...candidate,
          requestId,
          capturedAt: now
        });
      } catch {}
    }
    if (
      allowBridgeIngest &&
      isZenithBagtype(options?.bagtype) &&
      !hasPinnedSessionSelf(observerState)
    ) {
      notifySessionSelfProbeTrigger(observerState, cdp, logger, onVsRoundStatus, {
        reason: "zenith_options_missing_self"
      });
    }

    const emitSoloSignal =
      allowSoloSignals && shouldEmitSoloSignalForGameOptions(options);
    if (emitSoloSignal) {
      safeLog(
        log,
        `[browser] solo signal candidate type=ddd_game_options path=ws_observer seed=${summary.seed} bagtype=${summary.bagtype} nextcount=${summary.nextcount} signature=${summary.signature}`
      );
    }
    try {
      if (emitSoloSignal) {
        onGameOptions?.({
          signature,
          options,
          sequence: observerState.optionsCaptureSequence,
          capturedAt: now
        });
      }
    } catch {}

    if (emitSoloSignal) {
      safeLog(log, `[browser] solo signal queued key=ddd:${signature} source=ddd_game_options`);
    }
    safeLog(log, "[ws-observer] game options captured");
    if (requestId && observerState.requestUrls.has(requestId)) {
      safeLog(
        log,
        `[ws-observer] url_host=${safeUrlHost(
          observerState.requestUrls.get(requestId)
        )}`
      );
    }
    safeLog(log, `[ws-observer] seed=${String(options.seed)}`);
    safeLog(log, `[ws-observer] bagtype=${String(options.bagtype)}`);
    if (Object.prototype.hasOwnProperty.call(options, "nextcount")) {
      safeLog(log, `[ws-observer] nextcount=${String(options.nextcount)}`);
    }
    if (
      Object.prototype.hasOwnProperty.call(options, "boardwidth") &&
      Object.prototype.hasOwnProperty.call(options, "boardheight")
    ) {
      safeLog(
        log,
        `[ws-observer] board=${String(options.boardwidth)}x${String(
          options.boardheight
        )}`
      );
    }
    if (Object.prototype.hasOwnProperty.call(options, "gameid")) {
      safeLog(log, `[ws-observer] gameid=${String(options.gameid)}`);
    }
  }
}

function summarizeOptionsForSignalLog(options) {
  return {
    seed: options?.seed === undefined || options?.seed === null ? "missing" : String(options.seed),
    bagtype:
      options?.bagtype === undefined || options?.bagtype === null
        ? "missing"
        : String(options.bagtype),
    nextcount:
      options?.nextcount === undefined || options?.nextcount === null
        ? "missing"
        : String(options.nextcount),
    signature: buildOptionsSignature(options) || "missing"
  };
}

function pruneRecentOptionSignatures(observerState, now) {
  for (const [signature, seenAt] of observerState.recentOptionsSignatures ?? []) {
    if (now - seenAt >= OPTIONS_SIGNATURE_DEDUPE_WINDOW_MS) {
      observerState.recentOptionsSignatures.delete(signature);
    }
  }
}

function buildOptionsSignature(options) {
  if (!options) {
    return "";
  }
  return [
    options.seed,
    options.bagtype,
    options.gameid,
    options.boardwidth,
    options.boardheight,
    options.nextcount
  ].join("|");
}

function safeUrlHost(url) {
  try {
    return new URL(url).host || "unknown";
  } catch {
    return "unknown";
  }
}

function decodeAttemptCount(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return 0;
  }
  return Math.min(24, buffer.length - 1) + 1;
}

function collectDecodedRoots(payload, unpack) {
  if (Buffer.isBuffer(payload)) {
    const roots = [];
    for (const chunk of split87Frame(payload)) {
      roots.push(...tryUnpackAtOffsets(chunk, unpack));
    }
    roots.push(...tryUnpackAtOffsets(payload, unpack));
    return roots;
  }

  if (payload && typeof payload === "object") {
    return [payload];
  }

  return [];
}

function collectOptionCandidates(decodedRoots) {
  const candidates = [];
  const seen = new Set();
  collectDecodedCandidates(candidates, decodedRoots);
  return candidates.filter((candidate) => {
    const key = `${buildOptionsSignature(candidate?.options ?? null)}|${JSON.stringify(candidate?.context ?? {})}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function collectOptionCandidatesFromValue(
  target,
  value,
  pathLabel,
  ancestors,
  seen,
  counters,
  depth
) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (depth > MAX_DEPTH || counters.visitedObjects >= MAX_VISITED_OBJECTS) {
    return;
  }
  if (seen.has(value)) {
    return;
  }

  seen.add(value);
  counters.visitedObjects += 1;

  const lineage = [{ value, path: pathLabel }, ...ancestors];
  const directMatch = resolveOptionCandidateEntry(value);
  const sanitized = sanitizeGameOptions(directMatch?.candidate ?? null);
  if (sanitized) {
    target.push({
      options: sanitized,
      context: extractTraceContext(lineage),
      path: pathLabel,
      ancestorPaths: ancestors.map((entry) => entry?.path).filter(Boolean)
    });
  }

  if (depth === MAX_DEPTH) {
    return;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectOptionCandidatesFromValue(
        target,
        value[index],
        `${pathLabel}[${index}]`,
        lineage.slice(0, 4),
        seen,
        counters,
        depth + 1
      );
    }
    return;
  }

  for (const key of Object.keys(value)) {
    if (isSensitiveKey(key)) {
      continue;
    }
    if (directMatch?.skipNestedKey === key) {
      continue;
    }
    let nestedValue;
    try {
      nestedValue = value[key];
    } catch {
      continue;
    }
    collectOptionCandidatesFromValue(
      target,
      nestedValue,
      `${pathLabel}.${key}`,
      lineage.slice(0, 4),
      seen,
      counters,
      depth + 1
    );
  }
}

function emitDiagnosticEnvelope(onDiagnosticEnvelope, record) {
  if (typeof onDiagnosticEnvelope !== "function" || !record) {
    return;
  }
  try {
    onDiagnosticEnvelope(record);
  } catch {}
}

function sanitizeDiagnosticOptionsCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const options = sanitizeGameOptions(candidate.options);
  if (!options) {
    return null;
  }
  const context =
    candidate.context && typeof candidate.context === "object"
      ? candidate.context
      : {};
  return {
    path: sanitizeTraceScalar(candidate.path) ?? "root",
    ancestorPaths: Array.isArray(candidate.ancestorPaths)
      ? candidate.ancestorPaths
          .map((entry) => sanitizeTraceScalar(entry))
          .filter((entry) => typeof entry === "string")
          .slice(0, 6)
      : [],
    userid:
      sanitizeTraceScalar(context.userid ?? context.user_id ?? context._id) ?? null,
    username: sanitizeTraceScalar(context.username ?? context.name) ?? null,
    gameid: sanitizeTraceScalar(options.gameid ?? context.gameid ?? context.game_id) ?? null,
    seed: sanitizeTraceScalar(options.seed) ?? null,
    bagtype: sanitizeTraceScalar(options.bagtype) ?? null,
    nextcount: sanitizeTraceScalar(options.nextcount) ?? null,
    boardwidth: sanitizeTraceScalar(options.boardwidth) ?? null,
    boardheight: sanitizeTraceScalar(options.boardheight) ?? null,
    naturalorder:
      sanitizeTraceScalar(context.naturalorder ?? context.slot ?? context.index) ?? null,
    sessionFieldPresent: hasSessionFieldInContext(context)
  };
}

function hasSessionFieldInContext(context) {
  if (!context || typeof context !== "object") {
    return false;
  }
  return [
    "session",
    "sessionid",
    "session_id"
  ].some((key) => Object.prototype.hasOwnProperty.call(context, key));
}

function collectRootKeyList(decodedRoots) {
  const keys = new Set();
  for (const root of decodedRoots) {
    if (!root || typeof root !== "object" || Array.isArray(root)) {
      continue;
    }
    for (const key of Object.keys(root)) {
      if (!isSensitiveKey(key)) {
        keys.add(key);
      }
    }
  }
  return [...keys].sort().slice(0, 48);
}

function collectPayloadKeyList(decodedRoots) {
  const keys = new Set();
  for (const root of decodedRoots) {
    if (!root || typeof root !== "object" || Array.isArray(root)) {
      continue;
    }
    for (const containerKey of ["payload", "data", "body", "args", "message"]) {
      if (!Object.prototype.hasOwnProperty.call(root, containerKey) || isSensitiveKey(containerKey)) {
        continue;
      }
      const container = root[containerKey];
      if (!container || typeof container !== "object" || Array.isArray(container)) {
        continue;
      }
      for (const key of Object.keys(container)) {
        if (!isSensitiveKey(key)) {
          keys.add(key);
        }
      }
    }
  }
  return [...keys].sort().slice(0, 48);
}

function resolveEnvelopeScalar(decodedRoots, keys) {
  for (const root of decodedRoots) {
    if (!root || typeof root !== "object" || Array.isArray(root)) {
      continue;
    }
    for (const key of keys) {
      const scalar = sanitizeTraceScalar(root[key]);
      if (scalar !== undefined) {
        return scalar;
      }
    }
    for (const containerKey of ["payload", "data", "body", "args", "message"]) {
      const container = root[containerKey];
      if (!container || typeof container !== "object" || Array.isArray(container)) {
        continue;
      }
      for (const key of keys) {
        const scalar = sanitizeTraceScalar(container[key]);
        if (scalar !== undefined) {
          return scalar;
        }
      }
    }
  }
  return null;
}

function collectDiagnosticWsPlayers(decodedRoots) {
  const records = [];
  const seen = new Set();
  const pushRecord = (record) => {
    if (!record) {
      return;
    }
    const signature = [
      record.source_path ?? "",
      record.userid ?? "",
      record.username ?? "",
      record.gameid ?? "",
      record.seed ?? ""
    ].join("|");
    if (seen.has(signature)) {
      return;
    }
    seen.add(signature);
    records.push(record);
  };
  for (const root of decodedRoots) {
    collectDiagnosticWsPlayersFromValue(root, "root", pushRecord, 0, new WeakSet());
  }
  return records.slice(0, 64);
}

function collectDiagnosticWsPlayersFromValue(
  value,
  pathLabel,
  pushRecord,
  depth,
  seen
) {
  if (!value || typeof value !== "object" || depth > 4) {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectDiagnosticWsPlayersFromValue(
        value[index],
        `${pathLabel}[${index}]`,
        pushRecord,
        depth + 1,
        seen
      );
    }
    return;
  }
  if (looksLikePlayerRecord(value)) {
    pushRecord(buildDiagnosticWsPlayerRecord(value, pathLabel));
  }
  for (const [key, nextValue] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      continue;
    }
    if (
      key === "players" ||
      key === "player" ||
      key === "leaderboard" ||
      key === "entrants"
    ) {
      collectDiagnosticWsPlayersFromValue(
        nextValue,
        `${pathLabel}.${key}`,
        pushRecord,
        depth + 1,
        seen
      );
    }
  }
}

function looksLikePlayerRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const userid = sanitizeTraceScalar(value.userid ?? value._id ?? value.user_id);
  const username = sanitizeTraceScalar(value.username ?? value.name);
  const gameid = sanitizeTraceScalar(value.gameid ?? value.game_id);
  return userid !== undefined || username !== undefined || gameid !== undefined;
}

function buildDiagnosticWsPlayerRecord(value, pathLabel) {
  const options = sanitizeGameOptions(value.options ?? value.setoptions ?? null);
  return {
    source_path: pathLabel,
    userid: sanitizeTraceScalar(value.userid ?? value._id ?? value.user_id) ?? null,
    username: sanitizeTraceScalar(value.username ?? value.name) ?? null,
    gameid: sanitizeTraceScalar(value.gameid ?? value.game_id) ?? null,
    seed: sanitizeTraceScalar(options?.seed ?? value.seed) ?? null,
    bagtype: sanitizeTraceScalar(options?.bagtype) ?? null,
    nextcount: sanitizeTraceScalar(options?.nextcount) ?? null,
    naturalorder:
      sanitizeTraceScalar(value.naturalorder ?? value.slot ?? value.index) ?? null
  };
}

function resolveOptionCandidateEntry(value) {
  if (hasSeedAndBagtype(value)) {
    return {
      candidate: value,
      skipNestedKey: null
    };
  }
  if (
    Object.prototype.hasOwnProperty.call(value, "options") &&
    hasSeedAndBagtype(value.options)
  ) {
    return {
      candidate: mergeAllowedOptionShape(value, value.options),
      skipNestedKey: "options"
    };
  }
  if (
    Object.prototype.hasOwnProperty.call(value, "setoptions") &&
    hasSeedAndBagtype(value.setoptions)
  ) {
    return {
      candidate: mergeAllowedOptionShape(value, value.setoptions),
      skipNestedKey: "setoptions"
    };
  }
  return null;
}

function createTraceRecorder(traceFilePath, log) {
  const filePath = path.resolve(traceFilePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  rmSync(filePath, { force: true });
  safeLog(log, `[ws-trace] recording ${traceFilePath.replace(/\\/g, "/")}`);
  return {
    filePath,
    displayPath: traceFilePath.replace(/\\/g, "/"),
    records: 0,
    fileBytes: 0,
    stopped: false,
    stopLogged: false,
    signatureCounts: new Map(),
    firstKindsLogged: new Set(),
    kindCounts: {
      options: 0,
      identity: 0,
      board: 0,
      piece: 0,
      replay: 0,
      garbage: 0,
      garbage_interaction: 0,
      round_start: 0,
      mixed: 0
    }
  };
}

function traceDecodedRoots(decodedRoots, event, observerState, log) {
  const trace = observerState.trace;
  if (!trace || trace.stopped) {
    return;
  }

  for (const root of decodedRoots) {
    try {
      const candidates = collectTraceCandidates(root);
      for (const candidate of candidates) {
        maybeRecordTraceCandidate(candidate, event, observerState, log);
      }
    } catch {}
  }
}

function collectTraceCandidates(root) {
  const candidates = [];
  const seen = new WeakSet();
  const counters = {
    visitedObjects: 0
  };

  walkTraceCandidates(root, "root", [], seen, counters, candidates, 0);
  return candidates;
}

function walkTraceCandidates(
  value,
  pathLabel,
  ancestors,
  seen,
  counters,
  candidates,
  depth
) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (depth > MAX_DEPTH || counters.visitedObjects >= MAX_VISITED_OBJECTS) {
    return;
  }
  if (seen.has(value)) {
    return;
  }

  seen.add(value);
  counters.visitedObjects += 1;

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      walkTraceCandidates(
        value[index],
        `${pathLabel}[${index}]`,
        ancestors,
        seen,
        counters,
        candidates,
        depth + 1
      );
    }
    return;
  }

  const lineage = [{ value, path: pathLabel }, ...ancestors];
  candidates.push(...buildTraceEntriesForObject(value, pathLabel, lineage));

  const nextAncestors = lineage.slice(0, 4);
  for (const key of Object.keys(value)) {
    if (isSensitiveKey(key)) {
      continue;
    }
    let nextValue;
    try {
      nextValue = value[key];
    } catch {
      continue;
    }
    walkTraceCandidates(
      nextValue,
      `${pathLabel}.${key}`,
      nextAncestors,
      seen,
      counters,
      candidates,
      depth + 1
    );
  }
}

function buildTraceEntriesForObject(value, pathLabel, lineage) {
  const entries = [];
  const safeKeys = Object.keys(value).filter((key) => !isSensitiveKey(key));
  const keySet = new Set(safeKeys.map((key) => key.toLowerCase()));
  const roundStartRecord =
    pathLabel === "root" ? buildRoundStartTraceRecord(value) : null;
  if (roundStartRecord) {
    entries.push(roundStartRecord);
  }
  const garbageInteractionRecord = buildGarbageInteractionRecord(
    value,
    lineage
  );
  if (garbageInteractionRecord) {
    entries.push(garbageInteractionRecord);
  }

  if (hasSeedAndBagtype(value)) {
    entries.push(buildOptionTraceRecord(value, pathLabel, lineage));
  }

  if (
    Object.prototype.hasOwnProperty.call(value, "options") &&
    hasSeedAndBagtype(value.options)
  ) {
    entries.push(
      buildOptionTraceRecord(
        mergeAllowedOptionShape(value, value.options),
        `${pathLabel}.options`,
        [{ value: value.options, path: `${pathLabel}.options` }, ...lineage]
      )
    );
  }

  if (
    Object.prototype.hasOwnProperty.call(value, "setoptions") &&
    hasSeedAndBagtype(value.setoptions)
  ) {
    entries.push(
      buildOptionTraceRecord(
        mergeAllowedOptionShape(value, value.setoptions),
        `${pathLabel}.setoptions`,
        [{ value: value.setoptions, path: `${pathLabel}.setoptions` }, ...lineage]
      )
    );
  }

  const kind = classifyTraceKind(keySet);
  if (kind) {
    entries.push(buildTraceRecord(kind, value, pathLabel, safeKeys, lineage));
  }

  return entries;
}

function buildOptionTraceRecord(options, pathLabel, lineage) {
  const sanitized = sanitizeGameOptions(options);
  if (!sanitized) {
    return null;
  }

  return {
    kind: "options",
    path: pathLabel,
    keys: Object.keys(sanitized).sort(),
    context: extractTraceContext(lineage),
    summary: summarizeTraceObject(sanitized),
    ...sanitized
  };
}

function buildTraceRecord(kind, value, pathLabel, safeKeys, lineage) {
  return {
    kind,
    path: pathLabel,
    keys: safeKeys.sort(),
    context: extractTraceContext(lineage),
    summary: summarizeTraceObject(value)
  };
}

function buildGarbageInteractionRecord(value, lineage) {
  const eventType = sanitizeTraceScalar(value.type);
  if (!GARBAGE_INTERACTION_EVENT_TYPES.has(eventType)) {
    return null;
  }

  const data = value.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  if (sanitizeTraceScalar(data.type) !== "garbage") {
    return null;
  }

  const record = {
    kind: "garbage_interaction",
    eventType,
    data: pickScalarFields(data, GARBAGE_INTERACTION_DATA_KEYS)
  };
  const eventFrame = sanitizeTraceScalar(value.frame);
  if (eventFrame !== undefined) {
    record.eventFrame = eventFrame;
  }
  const eventId = sanitizeTraceScalar(value.id);
  if (eventId !== undefined) {
    record.eventId = eventId;
  }
  const ownerGameId = findOwnerGameId(lineage);
  if (ownerGameId !== undefined) {
    record.ownerGameId = ownerGameId;
  }
  return record;
}

function buildRoundStartTraceRecord(value) {
  const players = Array.isArray(value.players) ? value.players : null;
  if (!players) {
    return null;
  }

  const summarizedPlayers = players
    .map((player) => summarizeRoundStartPlayer(player))
    .filter((player) => player && Object.keys(player).length > 0);
  if (summarizedPlayers.length === 0) {
    return null;
  }

  const record = {
    kind: "round_start",
    players: summarizedPlayers
  };
  const roomSeed = sanitizeTraceScalar(value?.options?.seed);
  if (roomSeed !== undefined) {
    record.roomSeed = roomSeed;
  }
  return record;
}

function summarizeRoundStartPlayer(player) {
  if (!player || typeof player !== "object" || Array.isArray(player)) {
    return null;
  }

  const summary = {};
  for (const key of ["username", "userid", "gameid", "seed"]) {
    const scalar = sanitizeTraceScalar(player[key]);
    if (scalar !== undefined) {
      summary[key] = scalar;
    }
  }
  return summary;
}

function classifyTraceKind(keySet) {
  const matchedKinds = [];
  if (matchesAnyKeySet(keySet, IDENTITY_KEYS)) {
    matchedKinds.push("identity");
  }
  if (matchesAnyKeySet(keySet, BOARD_KEYS)) {
    matchedKinds.push("board");
  }
  if (matchesAnyKeySet(keySet, PIECE_KEYS)) {
    matchedKinds.push("piece");
  }
  if (matchesAnyKeySet(keySet, REPLAY_KEYS)) {
    matchedKinds.push("replay");
  }
  if (matchesAnyKeySet(keySet, GARBAGE_KEYS)) {
    matchedKinds.push("garbage");
  }

  if (matchedKinds.length === 0) {
    return null;
  }
  if (matchedKinds.length === 1) {
    return matchedKinds[0];
  }
  return "mixed";
}

function matchesAnyKeySet(source, expected) {
  for (const key of expected) {
    if (source.has(key)) {
      return true;
    }
  }
  return false;
}

function extractTraceContext(lineage) {
  const context = {};
  for (const entry of lineage.slice(0, 4)) {
    const source = entry?.value;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      continue;
    }
    for (const key of CONTEXT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(context, key)) {
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(source, key)) {
        continue;
      }
      const scalar = sanitizeTraceScalar(source[key]);
      if (scalar !== undefined) {
        context[key] = scalar;
      }
    }
  }
  return context;
}

function summarizeTraceObject(value) {
  const summary = {};

  if (!value || typeof value !== "object") {
    return summary;
  }

  for (const key of TRACE_SUMMARY_SCALAR_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || isSensitiveKey(key)) {
      continue;
    }
    const scalar = sanitizeTraceScalar(value[key]);
    if (scalar !== undefined) {
      summary[key] = scalar;
    }
  }

  const playerArray = findDirectArray(value, ["players"]);
  if (playerArray) {
    summary.playerCount = playerArray.length;
  }

  const boardInfo = findBoardSummary(value);
  if (boardInfo) {
    Object.assign(summary, boardInfo);
  }

  const queueInfo = findQueueSummary(value);
  if (queueInfo) {
    Object.assign(summary, queueInfo);
  }

  const replayInfo = findReplaySummary(value);
  if (replayInfo) {
    Object.assign(summary, replayInfo);
  }

  return summary;
}

function findBoardSummary(value) {
  const board = findFirstOwnObject(value, ["board", "field"]);
  if (!Array.isArray(board) || board.length < 20 || board.length > 40) {
    return null;
  }

  const row = board.find((entry) => Array.isArray(entry));
  if (!row || row.length < 8 || row.length > 12) {
    return null;
  }

  let filledCells = 0;
  for (const currentRow of board) {
    if (!Array.isArray(currentRow)) {
      continue;
    }
    for (const cell of currentRow) {
      if (cell) {
        filledCells += 1;
      }
    }
  }

  return {
    boardRows: board.length,
    boardWidth: row.length,
    filledCells
  };
}

function findQueueSummary(value) {
  const queue = findDirectArray(value, ["queue", "bag", "next", "preview", "pieces"]);
  if (!queue) {
    return null;
  }

  const sample = queue
    .slice(0, 12)
    .map((entry) => sanitizeTraceScalar(entry))
    .filter((entry) => entry !== undefined);

  return {
    queueLength: queue.length,
    queueSample: sample
  };
}

function findReplaySummary(value) {
  const eventContainer = findEventContainer(value);
  if (!eventContainer) {
    return null;
  }

  const { label, events } = eventContainer;
  const summary = {
    [label === "frames" ? "frameCount" : "eventCount"]: events.length,
    eventSamples: events.slice(0, 3).map(summarizeReplayEvent)
  };

  return summary;
}

function findEventContainer(value) {
  const directEvents = findDirectArray(value, ["events", "frames"]);
  if (directEvents) {
    return {
      label: Object.prototype.hasOwnProperty.call(value, "frames") ? "frames" : "events",
      events: directEvents
    };
  }

  for (const key of ["replay", "data"]) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || isSensitiveKey(key)) {
      continue;
    }
    const nested = value[key];
    if (!nested || typeof nested !== "object") {
      continue;
    }
    const nestedEvents = findDirectArray(nested, ["events", "frames"]);
    if (nestedEvents) {
      return {
        label: Object.prototype.hasOwnProperty.call(nested, "frames") ? "frames" : "events",
        events: nestedEvents
      };
    }
  }

  return null;
}

function summarizeReplayEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return {};
  }

  const sample = {
    keys: Object.keys(event).filter((key) => !isSensitiveKey(key)).sort()
  };

  const frame = sanitizeTraceScalar(event.frame);
  if (frame !== undefined) {
    sample.frame = frame;
  }
  const type = sanitizeTraceScalar(event.type);
  if (type !== undefined) {
    sample.type = type;
  }
  const id = sanitizeTraceScalar(event.id);
  if (id !== undefined) {
    sample.id = id;
  }
  if (event.data && typeof event.data === "object" && !Array.isArray(event.data)) {
    sample.dataKeys = Object.keys(event.data)
      .filter((key) => !isSensitiveKey(key))
      .sort();
  }

  return sample;
}

function maybeRecordTraceCandidate(candidate, event, observerState, log) {
  if (!candidate) {
    return;
  }

  const trace = observerState.trace;
  if (!trace || trace.stopped) {
    return;
  }

  const record = {
    timestamp: Date.now(),
    urlHost: resolveTraceUrlHost(event?.requestId, observerState),
    requestId: event?.requestId ?? null,
    opcode: event?.response?.opcode ?? null,
    ...candidate
  };
  if (Object.keys(record.context ?? {}).length === 0) {
    delete record.context;
  }
  if (Object.keys(record.summary ?? {}).length === 0) {
    delete record.summary;
  }

  const signature = buildTraceSignature(record);
  const duplicateLimit = traceDuplicateLimit(record);
  const seenCount = trace.signatureCounts.get(signature) ?? 0;
  if (seenCount >= duplicateLimit) {
    return;
  }

  const serialized = JSON.stringify(record);
  const serializedBytes = Buffer.byteLength(serialized);
  if (serializedBytes > MAX_TRACE_RECORD_BYTES) {
    return;
  }

  if (
    trace.records >= MAX_TRACE_RECORDS ||
    trace.fileBytes + serializedBytes + 1 > MAX_TRACE_FILE_BYTES
  ) {
    stopTraceRecording(trace, log);
    return;
  }

  try {
    appendFileSync(trace.filePath, `${serialized}\n`);
  } catch {
    stopTraceRecording(trace, log);
    return;
  }

  trace.signatureCounts.set(signature, seenCount + 1);
  trace.records += 1;
  trace.fileBytes += serializedBytes + 1;
  trace.kindCounts[record.kind] = (trace.kindCounts[record.kind] ?? 0) + 1;

  if (
    TRACE_FIRST_LOG_KINDS.has(record.kind) &&
    !trace.firstKindsLogged.has(record.kind)
  ) {
    trace.firstKindsLogged.add(record.kind);
    safeLog(log, `[ws-trace] first ${record.kind} candidate`);
  }
}

function buildTraceSignature(record) {
  if (record.kind === "garbage_interaction") {
    const data = record.data ?? {};
    return [
      record.eventType ?? "",
      record.ownerGameId ?? "",
      data.gameid ?? "",
      data.iid ?? "",
      data.ackiid ?? "",
      data.cid ?? "",
      data.frame ?? "",
      data.amt ?? "",
      data.size ?? "",
      data.x ?? ""
    ].join("|");
  }

  if (record.kind === "round_start") {
    const players = Array.isArray(record.players)
      ? record.players
          .map((player) =>
            [
              player?.username ?? "",
              player?.userid ?? "",
              player?.gameid ?? "",
              player?.seed ?? ""
            ].join(":")
          )
          .join("|")
      : "";
    return ["round_start", record.roomSeed ?? "", players].join("|");
  }

  const keys = Array.isArray(record.keys) ? [...record.keys].sort().join(",") : "";
  const summary = record.summary ?? {};
  const context = record.context ?? {};
  const firstEventType =
    Array.isArray(summary.eventSamples) && summary.eventSamples[0]
      ? summary.eventSamples[0].type ?? ""
      : "";

  return [
    record.urlHost ?? "",
    record.kind ?? "",
    record.path ?? "",
    keys,
    record.gameid ?? summary.gameid ?? context.gameid ?? "",
    context.username ?? summary.username ?? context.name ?? summary.name ?? "",
    record.seed ?? summary.seed ?? "",
    summary.boardRows ?? "",
    summary.queueLength ?? "",
    firstEventType,
    summary.current ?? summary.piece ?? "",
    summary.hold ?? summary.held ?? "",
    summary.frame ?? "",
    summary.incoming ?? "",
    summary.filledCells ?? ""
  ].join("|");
}

function traceDuplicateLimit(record) {
  if (record.kind === "garbage_interaction" || record.kind === "round_start") {
    return 1;
  }
  return 3;
}

function resolveTraceUrlHost(requestId, observerState) {
  if (!requestId || !observerState.requestUrls.has(requestId)) {
    return "unknown";
  }
  return safeUrlHost(observerState.requestUrls.get(requestId));
}

function sanitizeTraceScalar(value) {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return undefined;
}

function pickScalarFields(value, keys) {
  const record = {};
  for (const key of keys) {
    if (isSensitiveKey(key) || !Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }
    const scalar = sanitizeTraceScalar(value[key]);
    if (scalar !== undefined) {
      record[key] = scalar;
    }
  }
  return record;
}

function findOwnerGameId(lineage) {
  for (const entry of lineage) {
    const source = entry?.value;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      continue;
    }
    for (const key of ["gameid", "game_id"]) {
      const scalar = sanitizeTraceScalar(source[key]);
      if (scalar !== undefined) {
        return scalar;
      }
    }
  }
  return undefined;
}

function findDirectArray(value, keys) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || isSensitiveKey(key)) {
      continue;
    }
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return null;
}

function findFirstOwnObject(value, keys) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || isSensitiveKey(key)) {
      continue;
    }
    return value[key];
  }
  return null;
}

function stopTraceRecording(trace, log) {
  if (trace.stopLogged) {
    trace.stopped = true;
    return;
  }
  trace.stopped = true;
  trace.stopLogged = true;
  safeLog(log, "[ws-trace] limit reached; recording stopped");
}

function finalizeTrace(observerState, log) {
  const trace = observerState.trace;
  if (!trace) {
    return;
  }
  safeLog(
    log,
    `[ws-trace] records=${trace.records} options=${trace.kindCounts.options ?? 0} identity=${trace.kindCounts.identity ?? 0} board=${trace.kindCounts.board ?? 0} replay=${trace.kindCounts.replay ?? 0} garbage=${trace.kindCounts.garbage ?? 0}`
  );
}
