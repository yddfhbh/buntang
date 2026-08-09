import { fileURLToPath } from "node:url";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_BRIDGE_PATH = fileURLToPath(
  new URL("../vs-ws-bridge.json", import.meta.url)
);

const MAX_DEPTH = 12;
const MAX_VISITED_OBJECTS = 5000;
const BRIDGE_OPTION_KEYS = [
  "bagtype",
  "nextcount",
  "boardwidth",
  "boardheight",
  "precountdown",
  "countdown_count",
  "countdown_interval",
  "garbagemultiplier"
];
const ROOM_OPTION_KEYS = ["seed", ...BRIDGE_OPTION_KEYS];
const REQUIRED_LOCAL_OPTION_KEYS = [
  "seed",
  "bagtype",
  "nextcount",
  "boardwidth",
  "boardheight"
];
const ZENITH_PLAYER_STALE_MS = 30_000;
const ZENITH_SESSION_KEYS = [
  "session",
  "sessionid",
  "session_id",
  "roomid",
  "room_id"
];
const GARBAGE_DATA_KEYS = [
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
const ROOT_USER_PENDING_REQUEST_ID = "__root_user_pending__";

export function isVsWsSimEnabled(env = process.env) {
  return env?.FUSION_VS_WS_SIM === "1";
}

export function isZenithBagtype(value) {
  return normalizeBagtype(value) === "zenith";
}

export function createVsBridgeState(
  bridgeFilePath = DEFAULT_BRIDGE_PATH,
  log = null
) {
  const state = {
    bridgeFilePath: path.resolve(bridgeFilePath),
    sequence: 0,
    current: null,
    currentSignature: "",
    garbageKeys: new Set(),
    lastDisabledRoundId: "",
    lastWaitingReason: "",
    lastLocalPlayerSignature: "",
    lastSelfIdentitySignature: "",
    lastIgnoredSelfCandidateSignature: "",
    lastZenithWaitingSignature: "",
    sessionSelfIdentity: createEmptySessionSelfIdentity(),
    participantIdentities: new Map(),
    requestIdentityState: new Map(),
    pendingRequestSelfCandidates: new Map(),
    roomUsers: new Map(),
    roundPlayers: new Map(),
    zenithPlayersByGameId: new Map(),
    zenithPlayersByUserId: new Map(),
    configuredLocalUsername: null,
    roomOptions: {},
    zenithSession: null,
    roundObservedAt: 0,
    roundObservationKey: "",
    identityCandidateKeys: new Set(),
    log,
    ingest(root, context = {}) {
      return ingestVsBridgeRoot(state, root, context, state.log);
    }
  };

  log?.(`[vs-bridge] producer enabled path=${buildLogPath(state.bridgeFilePath)}`);
  return state;
}

export function setVsBridgeConfiguredLocalUsername(state, username) {
  if (!state) {
    return false;
  }
  const nextUsername = sanitizeConfiguredLocalUsername(username);
  if ((state.configuredLocalUsername ?? null) === nextUsername) {
    return false;
  }
  state.configuredLocalUsername = nextUsername;
  return true;
}

export function ingestVsBridgeOptionsCandidate(
  state,
  candidate,
  log = state?.log ?? null
) {
  if (!state || !candidate || typeof candidate !== "object") {
    return false;
  }
  const options = asPlainObject(candidate.options);
  const context = asPlainObject(candidate.context);
  const pathLabel = sanitizeScalar(candidate.path) ?? "unknown";
  const requestId = sanitizeScalar(candidate.requestId ?? candidate.request_id);
  let changed = false;

  if (context) {
    logIdentityCandidate(state, {
      path: pathLabel,
      source: context,
      requestId,
      marker: describeIdentityMarker(context, "candidate_context")
    }, log);
  }

  if (context && isConfirmedObserverSelfContext(context)) {
    changed =
      ingestVsBridgeSessionSelfIdentity(
        state,
        {
          userid: sanitizeScalar(context.userid ?? context.user_id),
          username: sanitizeScalar(context.username ?? context.name),
          gameid: sanitizeScalar(context.gameid ?? context.game_id),
          session:
            findZenithSessionValue(context) ??
            findZenithSessionValue(options),
          requestId,
          source: `candidate:${pathLabel}`
        },
        log
      ) || changed;
  }

  if (options && isZenithBagtype(options.bagtype)) {
    const requestState = ensureRequestIdentityState(state, requestId);
    noteZenithRequestCandidate(requestState, context, options);
    changed =
      accumulateZenithPlayerCandidate(state, {
        options,
        context,
        path: pathLabel,
        requestId,
        capturedAt: normalizeTimestamp(candidate.capturedAt ?? Date.now())
      }) || changed;
  }
  if (changed) {
    tryBuildBridge(
      state,
      normalizeTimestamp(candidate.capturedAt ?? Date.now()),
      log
    );
  }
  return changed;
}

export function updateVsBridgeState(
  state,
  decodedRoots,
  log = state?.log ?? null,
  capturedAt = Date.now()
) {
  if (!state || !Array.isArray(decodedRoots)) {
    return null;
  }

  for (const root of decodedRoots) {
    ingestVsBridgeRoot(state, root, { timestamp: capturedAt }, log);
  }

  return state.current;
}

export function ingestVsBridgeRoot(
  state,
  root,
  context = {},
  log = state?.log ?? null
) {
  if (!state || !root || typeof root !== "object") {
    return state?.current ?? null;
  }

  const capturedAt = normalizeTimestamp(context.timestamp);
  updateSelfUserCache(state, root, context, log);
  updateRoomUsersCache(state, root);
  updateRoundPlayersCache(state, root);
  updateRoomOptionsCache(state, root);
  updateZenithSessionCache(state, root, context);
  updateRoundObservation(state, capturedAt);

  const built = tryBuildBridge(state, capturedAt, log);
  if (built) {
    maybeLogResolvedLocalPlayer(state, built, log);
  }

  if (!state.current?.active) {
    return state.current;
  }

  if (bridgeSessionShouldEnd(root, state.current.local.gameid)) {
    markVsBridgeInactive(state, log);
    return state.current;
  }

  const garbageEvents = collectVsIncomingGarbage(root, state.current);
  if (garbageEvents.length === 0) {
    return state.current;
  }

  let changed = false;
  for (const event of garbageEvents) {
    if (state.garbageKeys.has(event.dedupeKey)) {
      continue;
    }
    state.garbageKeys.add(event.dedupeKey);
    state.current.incomingGarbage.push({
      ownerGameId: event.ownerGameId,
      eventType: event.eventType,
      eventFrame: event.eventFrame,
      eventId: event.eventId,
      data: event.data
    });
    changed = true;
    log?.(
      `[vs-bridge] incoming garbage observed amt=${event.data.amt ?? 0} hole=${event.data.x ?? 0}`
    );
    log?.("[vs-bridge] garbage application disabled in validation phase");
  }

  if (!changed) {
    return state.current;
  }

  state.sequence += 1;
  state.current.sequence = state.sequence;
  state.current.capturedAt = capturedAt;
  safeWriteBridgeFile(state, log);
  return state.current;
}

export function markVsBridgeInactive(state, log = state?.log ?? null) {
  if (!state?.current?.active) {
    resetVsBridgeZenithAccumulator(state);
    return;
  }

  state.sequence += 1;
  state.lastDisabledRoundId = state.current.roundId;
  state.current = {
    ...state.current,
    sequence: state.sequence,
    active: false,
    capturedAt: Date.now()
  };
  safeWriteBridgeFile(state, log);
  resetVsBridgeZenithAccumulator(state);
}

export function resetVsBridgeZenithAccumulator(state) {
  if (!state) {
    return false;
  }
  state.zenithPlayersByGameId?.clear?.();
  state.zenithPlayersByUserId?.clear?.();
  state.participantIdentities?.clear?.();
  state.requestIdentityState?.clear?.();
  state.pendingRequestSelfCandidates?.clear?.();
  state.zenithSession = null;
  state.lastZenithWaitingSignature = "";
  state.sessionSelfIdentity = createEmptySessionSelfIdentity();
  state.lastSelfIdentitySignature = "";
  state.lastIgnoredSelfCandidateSignature = "";
  return true;
}

export function ingestVsBridgeSessionSelfIdentity(
  state,
  identity,
  log = state?.log ?? null
) {
  const changed = pinSessionSelfIdentity(
    state,
    {
      userid: sanitizeScalar(identity?.userid ?? identity?._id ?? identity?.user_id),
      username: sanitizeScalar(identity?.username ?? identity?.name),
      gameid: sanitizeScalar(identity?.gameid ?? identity?.game_id),
      session: sanitizeScalar(
        identity?.session ??
          identity?.sessionid ??
          identity?.session_id ??
          identity?.roomid ??
          identity?.room_id
      ),
      requestId: sanitizeScalar(identity?.requestId ?? identity?.request_id) ?? null,
      source: sanitizeScalar(identity?.source) ?? "session_identity"
    },
    log
  );
  if (changed) {
    tryBuildBridge(state, Date.now(), log);
  }
  return changed;
}

export function deriveVsRoundBridge(root, capturedAt = Date.now(), options = {}) {
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return null;
  }

  const state = {
    sessionSelfIdentity: createEmptySessionSelfIdentity(),
    participantIdentities: new Map(),
    requestIdentityState: new Map(),
    pendingRequestSelfCandidates: new Map(),
    roomUsers: new Map(),
    roundPlayers: new Map(),
    zenithPlayersByGameId: new Map(),
    zenithPlayersByUserId: new Map(),
    configuredLocalUsername: sanitizeConfiguredLocalUsername(
      options?.configuredLocalUsername ??
        options?.localTetrioUsername ??
        options?.local_tetrio_username
    ),
    roomOptions: {},
    zenithSession: null,
    roundObservedAt: 0,
    roundObservationKey: "",
    current: null,
    currentSignature: "",
    garbageKeys: new Set(),
    lastDisabledRoundId: "",
    lastWaitingReason: "",
    lastLocalPlayerSignature: "",
    lastSelfIdentitySignature: "",
    lastIgnoredSelfCandidateSignature: "",
    lastZenithWaitingSignature: "",
    sequence: 0,
    bridgeFilePath: DEFAULT_BRIDGE_PATH,
    identityCandidateKeys: new Set(),
    log: null
  };

  updateSelfUserCache(state, root, {}, null);
  updateRoomUsersCache(state, root);
  updateRoundPlayersCache(state, root);
  updateRoomOptionsCache(state, root);
  updateZenithSessionCache(state, root);
  updateRoundObservation(state, capturedAt);

  return buildBridgeFromState(state, capturedAt);
}

export function collectVsIncomingGarbage(root, currentBridge) {
  if (!root || typeof root !== "object" || !currentBridge) {
    return [];
  }

  const matches = [];
  const seen = new WeakSet();
  const counters = { visitedObjects: 0 };
  walkBridgeObject(
    root,
    "root",
    [{ value: root }],
    seen,
    counters,
    (value, pathLabel, lineage) => {
      const match = buildIncomingGarbageEvent(
        value,
        pathLabel,
        lineage,
        currentBridge
      );
      if (match) {
        matches.push(match);
      }
    },
    0
  );
  return matches;
}

export function writeVsBridgeFile(bridgeFilePath, payload) {
  const directory = path.dirname(bridgeFilePath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${bridgeFilePath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(payload, null, 2));
  rmSync(bridgeFilePath, { force: true });
  renameSync(temporaryPath, bridgeFilePath);
}

function tryBuildBridge(state, capturedAt, log) {
  const built = buildBridgeFromState(state, capturedAt);
  if (!built) {
    return null;
  }

  clearWaitingReason(state);
  const signature = JSON.stringify(built);
  if (built.bridge.roundId === state.lastDisabledRoundId) {
    return built.bridge;
  }
  if (
    state.current?.roundId === built.bridge.roundId &&
    state.currentSignature === signature
  ) {
    return built.bridge;
  }

  const previousIncomingGarbage =
    state.current?.roundId === built.bridge.roundId
      ? state.current.incomingGarbage
      : [];

  state.sequence += 1;
  state.current = {
    ...built.bridge,
    roomSeed: built.roomSeed ?? null,
    version: 1,
    sequence: state.sequence,
    active: true,
    capturedAt,
    incomingGarbage: previousIncomingGarbage
  };
  state.currentSignature = signature;

  if (previousIncomingGarbage.length === 0) {
    state.garbageKeys.clear();
  }

  if (safeWriteBridgeFile(state, log)) {
    if (state.current.mode === "zenith") {
      log?.(
        `[vs-bridge] zenith bridge written sequence=${state.current.sequence} round_id=${state.current.round_id ?? state.current.roundId ?? ""} phase=${state.current.phase ?? "active"}`
      );
    } else {
      log?.(
        `[vs-bridge] readyAt offset_ms=${built.bridge.readyOffsetMs ?? 0} source=${built.bridge.readyOffsetSource ?? "precountdown_fallback"}`
      );
      log?.(`[vs-bridge] written roundId=${state.current.roundId}`);
    }
  }
  return state.current;
}

function buildBridgeFromState(state, capturedAt) {
  const selfIdentity = state.sessionSelfIdentity ?? createEmptySessionSelfIdentity();
  const zenithPlayers = getZenithPlayers(state, capturedAt);
  const zenithMode = shouldBuildZenithBridge(state, zenithPlayers);
  const configuredLocalUsername = sanitizeConfiguredLocalUsername(
    state?.configuredLocalUsername
  );
  if (zenithMode) {
    return buildZenithBridgeFromState(state, zenithPlayers, selfIdentity);
  }

  const roundPlayers = [...state.roundPlayers.values()]
    .map((player) => withBackfilledRoundUsername(state, player))
    .filter((player) => player?.userid);
  if (roundPlayers.length === 0) {
    setWaitingReason(state, "round_players_missing");
    return null;
  }

  let localPlayer = null;
  if (configuredLocalUsername !== null) {
    const configuredResolution = resolveConfiguredFriendlyVsLocalPlayer(
      roundPlayers,
      configuredLocalUsername
    );
    if (configuredResolution.status === "not_found") {
      setWaitingReason(state, "configured_username_not_found");
      return null;
    }
    if (configuredResolution.status === "ambiguous") {
      setWaitingReason(state, "configured_username_ambiguous");
      return null;
    }
    localPlayer = configuredResolution.player;
    if (
      hasFriendlyVsIdentityConflict(
        selfIdentity,
        localPlayer,
        configuredLocalUsername
      )
    ) {
      setWaitingReason(state, "identity_conflict");
      return null;
    }
  } else {
    if (!selfIdentity.userid && !selfIdentity.username) {
      setWaitingReason(state, "self_user_missing");
      return null;
    }
    localPlayer = resolveLocalPlayer(selfIdentity, roundPlayers);
    if (!localPlayer) {
      setWaitingReason(state, "local_player_unresolved");
      return null;
    }
  }

  if (roundPlayers.length < 2) {
    setWaitingReason(state, "round_players_missing");
    return null;
  }

  const opponents = roundPlayers.filter(
    (player) => player.userid !== localPlayer.userid
  );
  if (opponents.length !== 1) {
    setWaitingReason(state, "round_players_missing");
    return null;
  }

  const localOptions = asPlainObject(localPlayer.options);
  if (!hasScalarKeys(localOptions, REQUIRED_LOCAL_OPTION_KEYS)) {
    setWaitingReason(state, "round_options_incomplete");
    return null;
  }

  const playerSeeds = roundPlayers
    .map((player) => sanitizeScalar(player?.options?.seed))
    .filter((seed) => seed !== undefined);
  if (playerSeeds.length !== roundPlayers.length) {
    setWaitingReason(state, "round_options_incomplete");
    return null;
  }

  const roundSeed = playerSeeds[0];
  if (!playerSeeds.every((seed) => seed === roundSeed)) {
    setWaitingReason(state, "round_seed_mismatch");
    return null;
  }

  const options = pickBridgeOptions(state.roomOptions, localOptions, roundSeed);
  const localGameId = sanitizeScalar(
    localPlayer.gameid ?? localOptions.gameid
  );
  if (localGameId === undefined) {
    setWaitingReason(state, "round_options_incomplete");
    return null;
  }

  const readyTiming = resolveReadyTiming(options);
  const readyOffsetMs = readyTiming.offsetMs;
  const readyAt = (state.roundObservedAt || capturedAt) + readyOffsetMs;

  return {
    roomSeed: sanitizeScalar(state.roomOptions.seed),
    bridge: {
      roundId: `${localGameId}:${roundSeed}`,
      readyAt,
      readyOffsetMs,
      readyOffsetSource: readyTiming.source,
      local: summarizeBridgePlayer(
        localPlayer,
        configuredLocalUsername === null ? selfIdentity : null
      ),
      opponents: opponents.map((player) => summarizeBridgePlayer(player, null)),
      options
    }
  };
}

function buildZenithBridgeFromState(state, zenithPlayers, selfIdentity) {
  if (!selfIdentity.userid && !selfIdentity.username) {
    setWaitingReason(state, "self_user_missing");
    logZenithWaitingState(state, "self_user_missing");
    return null;
  }

  if (zenithPlayers.length === 0) {
    setWaitingReason(state, "zenith_players_missing");
    logZenithWaitingState(state, "zenith_players_missing");
    return null;
  }

  const localPlayer = resolveLocalPlayer(selfIdentity, zenithPlayers);
  if (!localPlayer) {
    setWaitingReason(state, "local_zenith_player_missing");
    logZenithWaitingState(state, "local_zenith_player_missing");
    return null;
  }

  const localOptions = asPlainObject(localPlayer.options);
  const seed = sanitizeScalar(localOptions.seed);
  const localGameId = sanitizeScalar(localPlayer.gameid ?? localOptions.gameid);
  const session = resolveZenithSessionId(state, localPlayer);
  if (
    seed === undefined ||
    localGameId === undefined ||
    session === undefined ||
    !isZenithBagtype(localOptions?.bagtype)
  ) {
    setWaitingReason(state, "local_zenith_options_incomplete");
    logZenithWaitingState(state, "local_zenith_options_incomplete");
    return null;
  }

  const local = summarizeBridgePlayer(localPlayer, selfIdentity);
  const username =
    sanitizeScalar(local.username) ??
    sanitizeScalar(selfIdentity?.username) ??
    null;
  const userid = sanitizeScalar(local.userid) ?? null;
  const options = {
    bagtype: "zenith",
    nextcount: sanitizeScalar(localOptions.nextcount),
    boardwidth: sanitizeScalar(localOptions.boardwidth),
    boardheight: sanitizeScalar(localOptions.boardheight)
  };
  if (!hasScalarKeys(options, ["bagtype", "nextcount", "boardwidth", "boardheight"])) {
    setWaitingReason(state, "local_zenith_options_incomplete");
    logZenithWaitingState(state, "local_zenith_options_incomplete");
    return null;
  }

  const roundId = `zenith:${session}:${localGameId}:${seed}`;
  return {
    roomSeed: null,
    bridge: {
      mode: "zenith",
      roundId,
      round_id: roundId,
      phase: "active",
      bagtype: "zenith",
      local: {
        userid,
        username,
        gameid: localGameId,
        seed
      },
      opponents: [],
      options
    }
  };
}

function updateSelfUserCache(state, root, context = {}, log = state?.log ?? null) {
  const requestId = sanitizeScalar(context.requestId ?? context.request_id) ?? null;
  const requestState = ensureRequestIdentityState(state, requestId);
  const envelope = summarizeIdentityEnvelope(root);
  mergeRequestIdentityState(requestState, envelope);
  for (const candidate of collectRootIdentityCandidates(root)) {
    const identity = extractIdentityFromSource(candidate.source);
    logIdentityCandidate(state, {
      path: candidate.path,
      source: candidate.source,
      requestId,
      marker: candidate.marker
    }, log);
    if (candidate.path === "root.user") {
      const rootUserRequestId = requestId ?? ROOT_USER_PENDING_REQUEST_ID;
      observeParticipantIdentity(
        state,
        {
          ...identity,
          requestId,
          sourcePath: candidate.path
        },
        log
      );
      clearPendingRootUserCandidate(state, rootUserRequestId);
      if (!isConfirmedObserverSelfContext(candidate.source)) {
        continue;
      }
    }
    if (!candidate.trusted) {
      continue;
    }
    pinSessionSelfIdentity(
      state,
      {
        ...identity,
        requestId,
        session:
          findZenithSessionValue(root) ??
          findZenithSessionValue(context) ??
          sanitizeScalar(state.zenithSession),
        source: candidate.path
      },
      log
    );
  }
}

function updateRoomUsersCache(state, root) {
  const players = Array.isArray(root.players) ? root.players : null;
  if (!players) {
    return;
  }

  for (const player of players) {
    const source = asPlainObject(player);
    if (!source) {
      continue;
    }
    const userid = sanitizeScalar(source._id ?? source.userid ?? source.user_id);
    const username = sanitizeScalar(source.username ?? source.name);
    if (userid === undefined) {
      continue;
    }

    const entry = state.roomUsers.get(userid) ?? { userid, username: null };
    if (username !== undefined) {
      entry.username = username;
    }
    state.roomUsers.set(userid, entry);
  }
}

function updateRoundPlayersCache(state, root) {
  const players = Array.isArray(root.players) ? root.players : null;
  if (!players) {
    return;
  }

  for (const player of players) {
    const source = asPlainObject(player);
    if (!source) {
      continue;
    }
    const options = asPlainObject(source.options);
    const userid = sanitizeScalar(source.userid ?? source._id ?? source.user_id);
    const gameid = sanitizeScalar(source.gameid ?? source?.options?.gameid);
    const username =
      sanitizeScalar(source.username ?? source.name ?? source?.options?.username) ??
      state.roomUsers.get(userid)?.username ??
      null;
    if (userid === undefined) {
      if (
        isZenithBagtype(options?.bagtype) &&
        (gameid !== undefined || username !== null)
      ) {
        upsertZenithPlayerEntry(state, {
          userid: undefined,
          username,
          gameid,
          seed: sanitizeScalar(options?.seed),
          bagtype: sanitizeScalar(options?.bagtype),
          nextcount: sanitizeScalar(options?.nextcount),
          boardwidth: sanitizeScalar(options?.boardwidth),
          boardheight: sanitizeScalar(options?.boardheight),
          lastSeenAt: Date.now(),
          requestId: null,
          sourcePath: "root.players",
          options: {
            ...pickScalarFields(
              options,
              ROOM_OPTION_KEYS.concat(["gameid", ...ZENITH_SESSION_KEYS])
            )
          }
        });
      }
      continue;
    }

    const hasRoundData =
      gameid !== undefined ||
      (options && Object.keys(options).length > 0);
    if (!hasRoundData) {
      continue;
    }

    const entry = state.roundPlayers.get(userid) ?? {
      userid,
      username: null,
      gameid: undefined,
      options: {}
    };

    if (username !== null) {
      entry.username = username;
    }
    if (gameid !== undefined) {
      entry.gameid = gameid;
    }
    if (options) {
      entry.options = {
        ...entry.options,
        ...pickScalarFields(
          options,
          ROOM_OPTION_KEYS.concat([
            "gameid",
            "username",
            ...ZENITH_SESSION_KEYS
          ])
        )
      };
    }
    state.roundPlayers.set(userid, entry);
    if (isZenithBagtype(entry.options?.bagtype)) {
      upsertZenithPlayerEntry(state, {
        userid,
        username,
        gameid: sanitizeScalar(entry.gameid ?? entry.options?.gameid),
        seed: sanitizeScalar(entry.options?.seed),
        bagtype: sanitizeScalar(entry.options?.bagtype),
        nextcount: sanitizeScalar(entry.options?.nextcount),
        boardwidth: sanitizeScalar(entry.options?.boardwidth),
        boardheight: sanitizeScalar(entry.options?.boardheight),
        lastSeenAt: Date.now(),
        requestId: null,
        sourcePath: "root.players",
        options: {
          ...pickScalarFields(
            entry.options,
            ROOM_OPTION_KEYS.concat(["gameid", ...ZENITH_SESSION_KEYS])
          )
        }
      });
    }
  }

  for (const [userid, entry] of state.roundPlayers.entries()) {
    if (!entry.username && state.roomUsers.has(userid)) {
      entry.username = state.roomUsers.get(userid)?.username ?? entry.username;
      state.roundPlayers.set(userid, entry);
    }
  }
}

function updateRoomOptionsCache(state, root) {
  const options = asPlainObject(root.options);
  if (!options) {
    return;
  }

  state.roomOptions = {
    ...state.roomOptions,
    ...pickScalarFields(options, ROOM_OPTION_KEYS.concat(ZENITH_SESSION_KEYS))
  };
}

function updateZenithSessionCache(state, root, context = {}) {
  const rootSession = findZenithSessionValue(root);
  if (rootSession !== undefined) {
    setZenithSessionValue(state, rootSession);
    return;
  }
  const contextSession = findZenithSessionValue(context);
  if (contextSession !== undefined) {
    setZenithSessionValue(state, contextSession);
  }
}

function updateRoundObservation(state, capturedAt) {
  const observationKey = [...state.roundPlayers.values()]
    .map((player) => {
      const seed = sanitizeScalar(player?.options?.seed) ?? "";
      const gameid = sanitizeScalar(player?.gameid ?? player?.options?.gameid) ?? "";
      return `${player?.userid ?? ""}:${gameid}:${seed}`;
    })
    .filter((entry) => entry !== "::")
    .sort()
    .join("|");

  if (!observationKey) {
    return;
  }
  if (state.roundObservationKey !== observationKey) {
    state.roundObservationKey = observationKey;
    state.roundObservedAt = capturedAt;
  }
}

function resolveLocalPlayer(selfIdentity, roundPlayers) {
  const sessionSelfIdentity = selfIdentity ?? {};
  if (
    sessionSelfIdentity.userid !== null &&
    sessionSelfIdentity.userid !== undefined
  ) {
    const matches = roundPlayers.filter(
      (player) => player.userid === sessionSelfIdentity.userid
    );
    if (matches.length === 1) {
      return matches[0];
    }
    return null;
  }

  const fallbackUsername = normalizeIdentityName(sessionSelfIdentity.username);
  if (fallbackUsername === null) {
    return null;
  }
  const matches = roundPlayers.filter(
    (player) =>
      (player.userid === null || player.userid === undefined) &&
      normalizeIdentityName(player.username) === fallbackUsername
  );
  if (matches.length === 1) {
    return matches[0];
  }

  return null;
}

function resolveConfiguredFriendlyVsLocalPlayer(
  roundPlayers,
  configuredLocalUsername
) {
  const normalizedConfiguredUsername =
    normalizeIdentityName(configuredLocalUsername);
  if (normalizedConfiguredUsername === null) {
    return { status: "not_found", player: null };
  }
  const matches = roundPlayers.filter(
    (player) =>
      normalizeIdentityName(player?.username) === normalizedConfiguredUsername
  );
  if (matches.length === 0) {
    return { status: "not_found", player: null };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", player: null };
  }
  return { status: "resolved", player: matches[0] };
}

function hasFriendlyVsIdentityConflict(
  selfIdentity,
  localPlayer,
  configuredLocalUsername
) {
  const pinnedUserid = sanitizeScalar(selfIdentity?.userid);
  const localUserid = sanitizeScalar(localPlayer?.userid);
  if (
    pinnedUserid !== undefined &&
    pinnedUserid !== null &&
    localUserid !== undefined &&
    String(pinnedUserid) !== String(localUserid)
  ) {
    return true;
  }
  const pinnedUsername = normalizeIdentityName(selfIdentity?.username);
  const configuredUsername = normalizeIdentityName(configuredLocalUsername);
  if (
    pinnedUsername !== null &&
    configuredUsername !== null &&
    pinnedUsername !== configuredUsername
  ) {
    return true;
  }
  return false;
}

function summarizeBridgePlayer(player, selfIdentity = null) {
  const summary = {
    username:
      sanitizeScalar(player?.username) ??
      sanitizeScalar(selfIdentity?.username) ??
      null,
    userid: sanitizeScalar(player?.userid) ?? null,
    gameid: sanitizeScalar(player?.gameid ?? player?.options?.gameid) ?? null
  };
  return summary;
}

function withBackfilledRoundUsername(state, player) {
  if (!player) {
    return player;
  }
  if (player.username) {
    return player;
  }
  return {
    ...player,
    username:
      state.roomUsers.get(player.userid)?.username ??
      findParticipantUsernameByUserid(state, player.userid) ??
      null
  };
}

function findParticipantUsernameByUserid(state, userid) {
  const normalizedUserid = sanitizeScalar(userid);
  if (normalizedUserid === undefined) {
    return null;
  }
  for (const participant of state?.participantIdentities?.values?.() ?? []) {
    if (
      sanitizeScalar(participant?.userid) === normalizedUserid &&
      sanitizeScalar(participant?.username) !== undefined
    ) {
      return sanitizeScalar(participant.username);
    }
  }
  return null;
}

function pickBridgeOptions(roomOptions, localOptions, roundSeed) {
  const options = { seed: roundSeed };
  for (const key of BRIDGE_OPTION_KEYS) {
    const localValue = sanitizeScalar(localOptions?.[key]);
    const roomValue = sanitizeScalar(roomOptions?.[key]);
    if (localValue !== undefined) {
      options[key] = localValue;
    } else if (roomValue !== undefined) {
      options[key] = roomValue;
    }
  }
  return options;
}

function resolveReadyTiming(options) {
  const countdownCount = normalizeCount(options?.countdown_count);
  const countdownIntervalMs = normalizeDuration(options?.countdown_interval);
  if (countdownCount > 0 && countdownIntervalMs > 0) {
    return {
      offsetMs: countdownCount * countdownIntervalMs,
      source: "countdown"
    };
  }

  return {
    offsetMs: normalizeDuration(options?.precountdown ?? 0),
    source: "precountdown_fallback"
  };
}

function maybeLogResolvedLocalPlayer(state, local, log) {
  const localPlayer = local?.local ?? null;
  const signature = [
    local?.mode ?? "vs",
    localPlayer?.username ?? "",
    localPlayer?.userid ?? "",
    localPlayer?.gameid ?? "",
    localPlayer?.seed ?? "",
    state.sessionSelfIdentity?.source ?? ""
  ].join("|");
  if (!signature || signature === state.lastLocalPlayerSignature) {
    return;
  }
  state.lastLocalPlayerSignature = signature;
  if (local?.mode === "zenith") {
    log?.(
      `[vs-bridge] zenith local resolved userid=${localPlayer?.userid ?? "null"} username=${localPlayer?.username ?? "null"} gameid=${localPlayer?.gameid ?? "null"} seed=${localPlayer?.seed ?? "null"} self_source=${state.sessionSelfIdentity?.source ?? "unknown"}`
    );
    return;
  }
  log?.(
    `[vs-bridge] local player username=${localPlayer?.username ?? "null"} userid=${localPlayer?.userid ?? "null"} gameid=${localPlayer?.gameid ?? "null"}`
  );
}

function logZenithWaitingState(state, reason) {
  const selfUserid = sanitizeScalar(state.sessionSelfIdentity?.userid) ?? "null";
  const signature = [
    reason,
    selfUserid,
    state.zenithPlayersByGameId?.size ?? 0,
    state.zenithPlayersByUserId?.size ?? 0
  ].join("|");
  if (signature === state.lastZenithWaitingSignature) {
    return;
  }
  state.lastZenithWaitingSignature = signature;
  state.log?.(
    `[vs-bridge] zenith waiting reason=${reason} self_userid=${selfUserid} players_by_gameid=${state.zenithPlayersByGameId?.size ?? 0} players_by_userid=${state.zenithPlayersByUserId?.size ?? 0}`
  );
}

function setWaitingReason(state, reason) {
  if (state.lastWaitingReason === reason) {
    return;
  }
  state.lastWaitingReason = reason;
  state.log?.(`[vs-bridge] waiting reason=${reason}`);
}

function clearWaitingReason(state) {
  state.lastWaitingReason = "";
}

function safeWriteBridgeFile(state, log) {
  try {
    writeVsBridgeFile(state.bridgeFilePath, state.current);
    return true;
  } catch (error) {
    log?.(`[vs-bridge] write failed: ${error?.message ?? String(error)}`);
    return false;
  }
}

function displayPath(filePath) {
  return String(filePath).replace(/\\/g, "/");
}

function buildLogPath(filePath) {
  const relative = path.relative(process.cwd(), filePath);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return displayPath(relative);
  }
  return displayPath(filePath);
}

function normalizeTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return Date.now();
  }
  return Math.floor(number);
}

function hasScalarKeys(value, keys) {
  return keys.every((key) => sanitizeScalar(value?.[key]) !== undefined);
}

function asPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

function isConfirmedObserverSelfContext(context) {
  if (!context || typeof context !== "object") {
    return false;
  }
  return [context.local, context.self, context.me].some((value) => value === true);
}

function collectRootIdentityCandidates(root) {
  const candidates = [];
  pushRootIdentityCandidate(
    candidates,
    "root.user",
    root?.user,
    "participant_user",
    true
  );
  pushRootIdentityCandidate(candidates, "root.account", root?.account, "account_packet", true);
  pushRootIdentityCandidate(candidates, "root.context", root?.context, "context_packet", true);
  pushRootIdentityCandidate(candidates, "root.self", root?.self, "self_path", true);
  pushRootIdentityCandidate(candidates, "root.me", root?.me, "me_path", true);
  pushRootIdentityCandidate(candidates, "root.session", root?.session, "session_packet", true);
  if (
    sanitizeScalar(root?._id ?? root?.userid ?? root?.user_id) !== undefined ||
    sanitizeScalar(root?.username ?? root?.name) !== undefined
  ) {
    candidates.push({
      path: "root",
      source: root,
      marker: "top_level_untrusted",
      trusted: false
    });
  }
  return candidates;
}

function pushRootIdentityCandidate(target, pathLabel, value, marker, trusted) {
  const source = asPlainObject(value);
  if (!source) {
    return;
  }
  const userid = sanitizeScalar(source._id ?? source.userid ?? source.user_id);
  const username = sanitizeScalar(source.username ?? source.name);
  if (userid === undefined && username === undefined) {
    return;
  }
  target.push({
    path: pathLabel,
    source,
    marker,
    trusted
  });
}

function logIdentityCandidate(
  state,
  { path: pathLabel, source, requestId = null, marker = "" } = {},
  log = state?.log ?? null
) {
  if (!state || typeof log !== "function") {
    return false;
  }
  const userid = sanitizeScalar(source?._id ?? source?.userid ?? source?.user_id);
  const username = sanitizeScalar(source?.username ?? source?.name);
  if (userid === undefined && username === undefined) {
    return false;
  }
  const signature = [
    pathLabel ?? "",
    userid ?? "",
    username ?? "",
    requestId ?? "",
    marker ?? ""
  ].join("|");
  if (state.identityCandidateKeys?.has(signature)) {
    return false;
  }
  state.identityCandidateKeys?.add(signature);
  const keys = Object.keys(source ?? {}).sort().join(",");
  log(
    `[vs-bridge] identity candidate path=${pathLabel ?? "unknown"} keys=${keys || "-"} userid=${userid ?? "null"} username=${username ?? "null"} marker=${marker || "-"} request_id=${requestId ?? "null"}`
  );
  return true;
}

function describeIdentityMarker(source, fallback = "") {
  const markers = [];
  if (source?.local === true) {
    markers.push("local");
  }
  if (source?.self === true) {
    markers.push("self");
  }
  if (source?.me === true) {
    markers.push("me");
  }
  return markers.length > 0 ? markers.join(",") : fallback;
}

function pinSessionSelfIdentity(state, identity, log = state?.log ?? null) {
  if (!state) {
    return false;
  }
  const userid = sanitizeScalar(identity?.userid);
  const username = sanitizeScalar(identity?.username);
  if (userid === undefined && username === undefined) {
    return false;
  }
  const current = state.sessionSelfIdentity ?? createEmptySessionSelfIdentity();
  if (
    current.userid &&
    userid &&
    current.userid !== userid
  ) {
    maybeLogIgnoredSelfCandidate(state, identity, "pinned_self_preserved", log);
    return false;
  }
  if (
    !current.userid &&
    current.username &&
    username &&
    current.username !== username
  ) {
    maybeLogIgnoredSelfCandidate(state, identity, "pinned_self_preserved", log);
    return false;
  }
  const next = {
    userid: userid ?? current.userid ?? null,
    username: username ?? current.username ?? null,
    gameid: sanitizeScalar(identity?.gameid) ?? current.gameid ?? null,
    requestId:
      sanitizeScalar(identity?.requestId ?? identity?.request_id) ??
      current.requestId ??
      null,
    session:
      sanitizeScalar(identity?.session) ??
      current.session ??
      sanitizeScalar(state.zenithSession) ??
      null,
    source: sanitizeScalar(identity?.source) ?? current.source ?? "unknown"
  };
  const signature = [
    next.source ?? "",
    next.userid ?? "",
    next.username ?? "",
    next.session ?? ""
  ].join("|");
  state.sessionSelfIdentity = next;
  if (signature === state.lastSelfIdentitySignature) {
    return true;
  }
  state.lastSelfIdentitySignature = signature;
  log?.(
    `[vs-bridge] self identity pinned source=${next.source ?? "unknown"} userid=${next.userid ?? "null"} username=${next.username ?? "null"} session=${next.session ?? "null"}`
  );
  return true;
}

function createEmptySessionSelfIdentity() {
  return {
    userid: null,
    username: null,
    gameid: null,
    requestId: null,
    session: null,
    source: null
  };
}

function extractIdentityFromSource(source) {
  return {
    userid: sanitizeScalar(source?._id ?? source?.userid ?? source?.user_id),
    username: sanitizeScalar(source?.username ?? source?.name),
    gameid: sanitizeScalar(source?.gameid ?? source?.game_id)
  };
}

function ensureRequestIdentityState(state, requestId) {
  if (!state || !requestId) {
    return null;
  }
  if (!state.requestIdentityState.has(requestId)) {
    state.requestIdentityState.set(requestId, {
      requestId,
      zenithSeen: false,
      roundLikeSeen: false,
      rootUserIds: new Set(),
      playerUserIds: new Set(),
      playerGameIds: new Set()
    });
  }
  return state.requestIdentityState.get(requestId);
}

function mergeRequestIdentityState(requestState, envelope) {
  if (!requestState || !envelope) {
    return;
  }
  requestState.zenithSeen = requestState.zenithSeen || envelope.zenithSeen;
  requestState.roundLikeSeen = requestState.roundLikeSeen || envelope.roundLikeSeen;
  for (const userid of envelope.playerUserIds ?? []) {
    requestState.playerUserIds.add(userid);
  }
  for (const gameid of envelope.playerGameIds ?? []) {
    requestState.playerGameIds.add(gameid);
  }
}

function noteZenithRequestCandidate(requestState, context, options) {
  if (!requestState) {
    return;
  }
  requestState.zenithSeen = true;
  const userid = sanitizeScalar(context?.userid ?? context?.user_id);
  const gameid = sanitizeScalar(context?.gameid ?? context?.game_id ?? options?.gameid);
  if (userid !== undefined) {
    requestState.playerUserIds.add(String(userid));
  }
  if (gameid !== undefined) {
    requestState.playerGameIds.add(String(gameid));
  }
}

function summarizeIdentityEnvelope(root) {
  const playerUserIds = new Set();
  const playerGameIds = new Set();
  let zenithSeen = false;
  let roundLikeSeen = false;
  const pushPlayer = (value) => {
    const source = asPlainObject(value);
    if (!source) {
      return;
    }
    const userid = sanitizeScalar(source.userid ?? source._id ?? source.user_id);
    const gameid = sanitizeScalar(source.gameid ?? source?.options?.gameid);
    const hasPlayerShape =
      userid !== undefined ||
      gameid !== undefined ||
      asPlainObject(source.options) !== null ||
      sanitizeScalar(source.naturalorder) !== undefined;
    if (!hasPlayerShape) {
      return;
    }
    roundLikeSeen = true;
    if (userid !== undefined) {
      playerUserIds.add(String(userid));
    }
    if (gameid !== undefined) {
      playerGameIds.add(String(gameid));
    }
    if (
      isZenithBagtype(source?.options?.bagtype) ||
      isZenithBagtype(source?.bagtype)
    ) {
      zenithSeen = true;
    }
  };

  if (isZenithBagtype(root?.options?.bagtype) || isZenithBagtype(root?.bagtype)) {
    zenithSeen = true;
  }
  if (Array.isArray(root?.players)) {
    if (root.players.length > 0) {
      roundLikeSeen = true;
    }
    for (const player of root.players) {
      pushPlayer(player);
    }
  }
  pushPlayer(root?.player);
  pushPlayer(root);

  return {
    zenithSeen,
    roundLikeSeen,
    playerUserIds,
    playerGameIds
  };
}

function hasAuthoritativeRoundPlayerUserid(state, userid) {
  const identityKey = sanitizeScalar(userid);
  if (identityKey === undefined || !state?.roundPlayers) {
    return false;
  }
  return state.roundPlayers.has(String(identityKey));
}

function hasAuthoritativeRoundObservation(state) {
  return (state?.roundPlayers?.size ?? 0) > 0;
}

function canUseRootUserAsSessionSelf(state, identity, envelope, requestState) {
  if (!identity || !envelope) {
    return false;
  }
  if (envelope.zenithSeen || requestState?.zenithSeen) {
    return false;
  }
  if (
    !envelope.roundLikeSeen &&
    !requestState?.roundLikeSeen &&
    !hasAuthoritativeRoundObservation(state)
  ) {
    return false;
  }
  if (identity.userid === undefined || identity.userid === null) {
    return false;
  }
  const identityKey = String(identity.userid);
  return (
    envelope.playerUserIds.has(identityKey) ||
    requestState?.playerUserIds?.has(identityKey) === true ||
    hasAuthoritativeRoundPlayerUserid(state, identityKey)
  );
}

function canPromoteRootUserAsSessionSelf(
  state,
  identity,
  source,
  envelope,
  requestState
) {
  if (isConfirmedObserverSelfContext(source)) {
    return true;
  }
  return canUseRootUserAsSessionSelf(state, identity, envelope, requestState);
}

function shouldTreatRootUserAsParticipantOnly(envelope, requestState) {
  if (envelope?.zenithSeen) {
    return true;
  }
  return shouldTreatRequestAsParticipantOnly(requestState);
}

function shouldTreatRequestAsParticipantOnly(requestState) {
  if (!requestState) {
    return false;
  }
  return requestState.zenithSeen || requestState.rootUserIds.size > 1;
}

function stagePendingRootUserCandidate(state, requestId, identity) {
  if (!state || !requestId || !identity) {
    return false;
  }
  if (sanitizeScalar(identity.userid) === undefined) {
    return false;
  }
  const existing = state.pendingRequestSelfCandidates.get(requestId);
  if (
    existing &&
    sanitizeScalar(existing.userid) !== undefined &&
    sanitizeScalar(identity.userid) !== undefined &&
    sanitizeScalar(existing.userid) !== sanitizeScalar(identity.userid)
  ) {
    state.pendingRequestSelfCandidates.delete(requestId);
    return false;
  }
  state.pendingRequestSelfCandidates.set(requestId, identity);
  return true;
}

function clearPendingRootUserCandidate(state, requestId) {
  if (!state || !requestId) {
    return false;
  }
  return state.pendingRequestSelfCandidates.delete(requestId);
}

function maybePromotePendingRootUserCandidate(state, requestId, log) {
  if (!state || !requestId) {
    return false;
  }
  const pending = state.pendingRequestSelfCandidates.get(requestId);
  const requestState = state.requestIdentityState.get(requestId);
  if (!pending || !requestState) {
    return false;
  }
  if (shouldTreatRequestAsParticipantOnly(requestState)) {
    state.pendingRequestSelfCandidates.delete(requestId);
    return false;
  }
  if (!requestState.roundLikeSeen) {
    return false;
  }
  if (sanitizeScalar(pending.userid) === undefined) {
    state.pendingRequestSelfCandidates.delete(requestId);
    return false;
  }
  if (
    pending.userid !== undefined &&
    pending.userid !== null &&
    requestState.playerUserIds.size > 0 &&
    !requestState.playerUserIds.has(String(pending.userid))
  ) {
    return false;
  }
  const changed = pinSessionSelfIdentity(state, pending, log);
  state.pendingRequestSelfCandidates.delete(requestId);
  return changed;
}

function observeParticipantIdentity(state, identity, log = state?.log ?? null) {
  const userid = sanitizeScalar(identity?.userid);
  const username = sanitizeScalar(identity?.username);
  if (userid === undefined && username === undefined) {
    return false;
  }
  const requestId = sanitizeScalar(identity?.requestId ?? identity?.request_id) ?? "null";
  const sourcePath = sanitizeScalar(identity?.sourcePath) ?? "unknown";
  const key = [requestId, sourcePath, userid ?? "", username ?? ""].join("|");
  if (state.participantIdentities.has(key)) {
    return false;
  }
  state.participantIdentities.set(key, {
    userid: userid ?? null,
    username: username ?? null,
    requestId,
    sourcePath
  });
  log?.(
    `[vs-bridge] participant identity observed userid=${userid ?? "null"} username=${username ?? "null"} request_id=${requestId} source_path=${sourcePath}`
  );
  return true;
}

function hasPinnedSessionSelfIdentity(state) {
  return Boolean(state?.sessionSelfIdentity?.userid || state?.sessionSelfIdentity?.username);
}

function maybeLogIgnoredSelfCandidate(
  state,
  identity,
  reason,
  log = state?.log ?? null
) {
  const userid = sanitizeScalar(identity?.userid) ?? "null";
  const currentSelfUserid = sanitizeScalar(state?.sessionSelfIdentity?.userid) ?? "null";
  const signature = [reason, userid, currentSelfUserid].join("|");
  if (signature === state?.lastIgnoredSelfCandidateSignature) {
    return false;
  }
  state.lastIgnoredSelfCandidateSignature = signature;
  log?.(
    `[vs-bridge] self candidate ignored reason=${reason} userid=${userid} current_self_userid=${currentSelfUserid}`
  );
  return true;
}

function normalizeBagtype(value) {
  const scalar = sanitizeScalar(value);
  if (scalar === undefined || scalar === null) {
    return "";
  }
  return String(scalar).trim().toLowerCase();
}

function normalizeIdentityName(value) {
  const scalar = sanitizeScalar(value);
  if (scalar === undefined || scalar === null) {
    return null;
  }
  const normalized = String(scalar).trim().toLowerCase();
  return normalized ? normalized : null;
}

function sanitizeConfiguredLocalUsername(value) {
  const scalar = sanitizeScalar(value);
  if (scalar === undefined || scalar === null) {
    return null;
  }
  const trimmed = String(scalar).trim();
  return trimmed ? trimmed : null;
}

function findZenithSessionValue(value) {
  const source = asPlainObject(value);
  if (!source) {
    return undefined;
  }
  for (const key of ZENITH_SESSION_KEYS) {
    const scalar = sanitizeScalar(source[key]);
    if (scalar !== undefined) {
      return scalar;
    }
  }
  const optionSource = asPlainObject(source.options);
  if (!optionSource) {
    return undefined;
  }
  for (const key of ZENITH_SESSION_KEYS) {
    const scalar = sanitizeScalar(optionSource[key]);
    if (scalar !== undefined) {
      return scalar;
    }
  }
  return undefined;
}

function setZenithSessionValue(state, value) {
  const nextValue = sanitizeScalar(value);
  if (nextValue === undefined) {
    return false;
  }
  if (state.zenithSession === null || state.zenithSession === undefined) {
    state.zenithSession = nextValue;
    return true;
  }
  if (state.zenithSession === nextValue) {
    return false;
  }
  state.zenithPlayersByGameId?.clear?.();
  state.zenithPlayersByUserId?.clear?.();
  state.zenithSession = nextValue;
  state.lastZenithWaitingSignature = "";
  return true;
}

function resolveZenithSessionId(state, localPlayer) {
  const playerSession =
    findZenithSessionValue(localPlayer) ??
    findZenithSessionValue(localPlayer?.options);
  if (playerSession !== undefined) {
    return playerSession;
  }
  const roomSession =
    findZenithSessionValue(state?.roomOptions) ??
    sanitizeScalar(state?.zenithSession);
  if (roomSession !== undefined) {
    return roomSession;
  }
  return undefined;
}

function accumulateZenithPlayerCandidate(state, candidate) {
  if (!state || !candidate) {
    return false;
  }
  const options = asPlainObject(candidate.options);
  if (!options || !isZenithBagtype(options.bagtype)) {
    return false;
  }
  const context = asPlainObject(candidate.context);
  const entry = {
    userid: sanitizeScalar(context?.userid ?? context?.user_id),
    username: sanitizeScalar(context?.username ?? context?.name),
    gameid: sanitizeScalar(context?.gameid ?? context?.game_id ?? options?.gameid),
    seed: sanitizeScalar(options.seed),
    bagtype: sanitizeScalar(options.bagtype),
    nextcount: sanitizeScalar(options.nextcount),
    boardwidth: sanitizeScalar(options.boardwidth),
    boardheight: sanitizeScalar(options.boardheight),
    lastSeenAt: normalizeTimestamp(candidate.capturedAt ?? Date.now()),
    requestId: sanitizeScalar(candidate.requestId ?? candidate.request_id) ?? null,
    sourcePath: sanitizeScalar(candidate.path) ?? "unknown",
    options: {
      seed: sanitizeScalar(options.seed),
      bagtype: sanitizeScalar(options.bagtype),
      nextcount: sanitizeScalar(options.nextcount),
      boardwidth: sanitizeScalar(options.boardwidth),
      boardheight: sanitizeScalar(options.boardheight),
      gameid: sanitizeScalar(options.gameid),
      ...pickScalarFields(options, ZENITH_SESSION_KEYS)
    }
  };
  if (entry.gameid === undefined && entry.userid === undefined) {
    return false;
  }
  setZenithSessionValue(
    state,
    findZenithSessionValue(context) ?? findZenithSessionValue(options)
  );
  return upsertZenithPlayerEntry(state, entry);
}

function upsertZenithPlayerEntry(state, entry) {
  const gameidKey =
    entry.gameid === undefined || entry.gameid === null
      ? null
      : String(entry.gameid);
  const useridKey =
    entry.userid === undefined || entry.userid === null
      ? null
      : String(entry.userid);
  const existing =
    (gameidKey && state.zenithPlayersByGameId.get(gameidKey)) ??
    (useridKey && state.zenithPlayersByUserId.get(useridKey)) ??
    null;
  const merged = mergeZenithPlayerEntry(existing, entry);
  if (existing) {
    const previousGameid =
      existing.gameid === undefined || existing.gameid === null
        ? null
        : String(existing.gameid);
    const previousUserid =
      existing.userid === undefined || existing.userid === null
        ? null
        : String(existing.userid);
    if (previousGameid && previousGameid !== gameidKey) {
      state.zenithPlayersByGameId.delete(previousGameid);
    }
    if (previousUserid && previousUserid !== useridKey) {
      state.zenithPlayersByUserId.delete(previousUserid);
    }
  }
  if (gameidKey) {
    state.zenithPlayersByGameId.set(gameidKey, merged);
  }
  if (useridKey) {
    state.zenithPlayersByUserId.set(useridKey, merged);
  }
  return true;
}

function mergeZenithPlayerEntry(previous, incoming) {
  const merged = {
    userid: previous?.userid ?? null,
    username: previous?.username ?? null,
    gameid: previous?.gameid,
    seed: previous?.seed,
    bagtype: previous?.bagtype,
    nextcount: previous?.nextcount,
    boardwidth: previous?.boardwidth,
    boardheight: previous?.boardheight,
    lastSeenAt: Math.max(
      0,
      Number(previous?.lastSeenAt ?? 0),
      Number(incoming?.lastSeenAt ?? 0)
    ),
    requestId: previous?.requestId ?? null,
    sourcePath: previous?.sourcePath ?? "unknown",
    options: {
      ...(previous?.options ?? {})
    }
  };
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (value === undefined || value === null) {
      continue;
    }
    if (key === "options") {
      merged.options = {
        ...merged.options,
        ...Object.fromEntries(
          Object.entries(value).filter(([, nested]) => nested !== undefined && nested !== null)
        )
      };
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function getZenithPlayers(state, now = Date.now()) {
  const players = [];
  const seen = new Set();
  pruneStaleZenithPlayers(state, now);
  for (const entry of state.zenithPlayersByGameId?.values?.() ?? []) {
    if (!entry || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    players.push(entry);
  }
  for (const entry of state.zenithPlayersByUserId?.values?.() ?? []) {
    if (!entry || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    players.push(entry);
  }
  return players;
}

function pruneStaleZenithPlayers(state, now = Date.now()) {
  const cutoff = Math.max(0, Number(now ?? Date.now()) - ZENITH_PLAYER_STALE_MS);
  for (const [gameid, entry] of state.zenithPlayersByGameId?.entries?.() ?? []) {
    if (Number(entry?.lastSeenAt ?? 0) < cutoff) {
      state.zenithPlayersByGameId.delete(gameid);
    }
  }
  for (const [userid, entry] of state.zenithPlayersByUserId?.entries?.() ?? []) {
    if (Number(entry?.lastSeenAt ?? 0) < cutoff) {
      state.zenithPlayersByUserId.delete(userid);
    }
  }
}

function shouldBuildZenithBridge(state, zenithPlayers) {
  if ((zenithPlayers?.length ?? 0) > 0) {
    return true;
  }
  if (isZenithBagtype(state.roomOptions?.bagtype)) {
    return true;
  }
  if (state.zenithSession) {
    return true;
  }
  return [...(state.roundPlayers?.values?.() ?? [])].some((player) =>
    isZenithBagtype(player?.options?.bagtype)
  );
}

function walkBridgeObject(
  value,
  pathLabel,
  lineage,
  seen,
  counters,
  visit,
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

  visit(value, pathLabel, lineage);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      walkBridgeObject(
        value[index],
        `${pathLabel}[${index}]`,
        lineage,
        seen,
        counters,
        visit,
        depth + 1
      );
    }
    return;
  }

  const nextLineage = [{ value }, ...lineage].slice(0, 4);
  for (const key of Object.keys(value)) {
    walkBridgeObject(
      value[key],
      `${pathLabel}.${key}`,
      nextLineage,
      seen,
      counters,
      visit,
      depth + 1
    );
  }
}

function buildIncomingGarbageEvent(value, pathLabel, lineage, currentBridge) {
  const eventType = sanitizeScalar(value?.type);
  if (eventType !== "interaction") {
    return null;
  }

  const data = value?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  if (sanitizeScalar(data.type) !== "garbage") {
    return null;
  }

  const ownerGameId = findOwnerGameId(lineage);
  if (ownerGameId === undefined || ownerGameId === currentBridge.local.gameid) {
    return null;
  }

  const targetGameId = sanitizeScalar(data.gameid);
  if (targetGameId !== currentBridge.local.gameid) {
    return null;
  }
  if (/\.copies(\[\d+\])?\./.test(pathLabel)) {
    return null;
  }

  const garbageData = pickScalarFields(data, GARBAGE_DATA_KEYS);
  const dedupeKey = [
    currentBridge.roundId,
    ownerGameId,
    garbageData.gameid ?? "",
    garbageData.iid ?? "",
    garbageData.cid ?? "",
    garbageData.frame ?? ""
  ].join("|");

  return {
    ownerGameId,
    eventType,
    eventFrame: sanitizeScalar(value.frame),
    eventId: sanitizeScalar(value.id),
    data: garbageData,
    dedupeKey
  };
}

function bridgeSessionShouldEnd(root, localGameId) {
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return false;
  }

  if (Array.isArray(root.players)) {
    for (const player of root.players) {
      if (!player || typeof player !== "object") {
        continue;
      }
      if (sanitizeScalar(player.gameid) !== localGameId) {
        continue;
      }
      if (player.alive === false) {
        return true;
      }
      if (sanitizeScalar(player.gameoverreason) !== undefined) {
        return true;
      }
    }
  }

  if (sanitizeScalar(root.gameid) === localGameId) {
    if (root.alive === false) {
      return true;
    }
    if (sanitizeScalar(root.gameoverreason) !== undefined) {
      return true;
    }
  }

  return false;
}

function findOwnerGameId(lineage) {
  for (const entry of lineage) {
    const source = entry?.value;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      continue;
    }
    const gameid = sanitizeScalar(source.gameid ?? source.game_id);
    if (gameid !== undefined) {
      return gameid;
    }
  }
  return undefined;
}

function pickScalarFields(source, keys) {
  const picked = {};
  for (const key of keys) {
    const scalar = sanitizeScalar(source?.[key]);
    if (scalar !== undefined) {
      picked[key] = scalar;
    }
  }
  return picked;
}

function normalizeDuration(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  if (number > 0 && number < 60) {
    return number * 1000;
  }
  return number;
}

function normalizeCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return 0;
  }
  return Math.floor(number);
}

function sanitizeScalar(value) {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return undefined;
}
