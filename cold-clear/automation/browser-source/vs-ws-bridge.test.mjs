import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_BRIDGE_PATH,
  collectVsIncomingGarbage,
  createVsBridgeState,
  deriveVsRoundBridge,
  ingestVsBridgeSessionSelfIdentity,
  ingestVsBridgeOptionsCandidate,
  ingestVsBridgeRoot,
  markVsBridgeInactive,
  resetVsBridgeZenithAccumulator,
  setVsBridgeConfiguredLocalUsername,
  updateVsBridgeState,
  writeVsBridgeFile
} from "./vs-ws-bridge.mjs";

function makeTempBridgeFile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vs-ws-bridge-"));
  return {
    dir,
    filePath: path.join(dir, "vs-ws-bridge.json")
  };
}

function cleanupTempDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function configureFriendlyVsLocalUsername(state, username) {
  setVsBridgeConfiguredLocalUsername(state, username);
  return state;
}

function packetA(overrides = {}) {
  return {
    players: [
      {
        userid: "local-id",
        gameid: 5449,
        options: {
          gameid: 5449,
          seed: 1744077373,
          bagtype: "7-bag",
          nextcount: 5,
          boardwidth: 10,
          boardheight: 20
        }
      },
      {
        userid: "guest-id",
        gameid: 5450,
        options: {
          gameid: 5450,
          seed: 1744077373,
          bagtype: "7-bag",
          nextcount: 5,
          boardwidth: 10,
          boardheight: 20
        }
      }
    ],
    ...overrides
  };
}

function packetB(overrides = {}) {
  return {
    players: [
      {
        _id: "local-id",
        username: "hebi_"
      },
      {
        _id: "guest-id",
        username: "guest-e00651"
      }
    ],
    ...overrides
  };
}

function packetC(overrides = {}) {
  return {
    user: {
      _id: "local-id",
      username: "hebi_"
    },
    ...overrides
  };
}

function packetRoomOptions(overrides = {}) {
  return {
    options: {
      seed: 187156,
      precountdown: 5000,
      countdown_count: 3,
      countdown_interval: 1000,
      garbagemultiplier: 0
    },
    ...overrides
  };
}

function combinedRoundRoot(overrides = {}) {
  return {
    user: {
      _id: "local-id",
      username: "hebi_"
    },
    players: [
      {
        userid: "local-id",
        _id: "local-id",
        username: "hebi_",
        gameid: 5449,
        options: {
          gameid: 5449,
          seed: 1744077373,
          bagtype: "7-bag",
          nextcount: 5,
          boardwidth: 10,
          boardheight: 20
        }
      },
      {
        userid: "guest-id",
        _id: "guest-id",
        username: "guest-e00651",
        gameid: 5450,
        options: {
          gameid: 5450,
          seed: 1744077373,
          bagtype: "7-bag",
          nextcount: 5,
          boardwidth: 10,
          boardheight: 20
        }
      }
    ],
    options: {
      seed: 187156,
      precountdown: 5000,
      countdown_count: 3,
      countdown_interval: 1000,
      garbagemultiplier: 0
    },
    ...overrides
  };
}

function zenithRoundRoot(overrides = {}) {
  return {
    session: "zenith-session-1",
    user: {
      _id: "local-id",
      username: "Hebi_"
    },
    players: [
      {
        userid: "local-id",
        username: "Hebi_",
        gameid: 1111,
        options: {
          gameid: 1111,
          seed: 5678,
          bagtype: "zenith",
          nextcount: 5,
          boardwidth: 10,
          boardheight: 20
        }
      }
    ],
    ...overrides
  };
}

function zenithFlatOptionsRoot(overrides = {}) {
  return {
    session: "zenith-session-flat",
    player: {
      userid: "local-id",
      username: "hebi_",
      gameid: 7101,
      options: {
        seed: 9911,
        bagtype: "zenith",
        nextcount: 5,
        boardwidth: 10,
        boardheight: 20
      }
    },
    ...overrides
  };
}

test("createVsBridgeState logs its enabled absolute bridge path", () => {
  const logs = [];
  const state = createVsBridgeState(DEFAULT_BRIDGE_PATH, (line) => logs.push(line));

  assert.ok(path.isAbsolute(state.bridgeFilePath));
  assert.match(
    state.bridgeFilePath.replace(/\\/g, "/"),
    /\/cold-clear\/automation\/vs-ws-bridge\.json$/
  );
  assert.ok(
    logs.some((line) => line.startsWith("[vs-bridge] producer enabled path="))
  );
});

test("deriveVsRoundBridge identifies local player and ignores room seed for round seed", () => {
  const bridge = deriveVsRoundBridge(combinedRoundRoot(), 1783780572968, {
    configuredLocalUsername: "hebi_"
  });

  assert.ok(bridge);
  assert.equal(bridge.bridge.local.username, "hebi_");
  assert.equal(bridge.bridge.local.userid, "local-id");
  assert.equal(bridge.bridge.local.gameid, 5449);
  assert.equal(bridge.bridge.roundId, "5449:1744077373");
  assert.equal(bridge.bridge.options.seed, 1744077373);
  assert.equal(bridge.roomSeed, 187156);
  assert.deepEqual(bridge.bridge.opponents, [
    {
      username: "guest-e00651",
      userid: "guest-id",
      gameid: 5450
    }
  ]);
});

test("deriveVsRoundBridge computes readyAt from room countdown options", () => {
  const capturedAt = 1783780572968;
  const result = deriveVsRoundBridge(combinedRoundRoot(), capturedAt, {
    configuredLocalUsername: "hebi_"
  });

  assert.ok(result);
  assert.equal(result.bridge.readyAt, capturedAt + 3000);
  assert.equal(result.bridge.readyOffsetMs, 3000);
  assert.equal(result.bridge.readyOffsetSource, "countdown");
});

test("zenith resolves local player by root userid before observer identity and writes passive bridge", () => {
  const result = deriveVsRoundBridge(
    zenithRoundRoot({
      user: {
        _id: "guest-id",
        username: "guest-user"
      },
      context: {
        _id: "local-id",
        username: "VISIBLE_ROOT"
      },
      players: [
        {
          userid: "local-id",
          username: "VISIBLE_ROOT",
          gameid: 4321,
          options: {
            gameid: 4321,
            seed: 9876,
            bagtype: "zenith",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        },
        {
          userid: "observer-id",
          username: "observer-user",
          gameid: 4322,
          options: {
            gameid: 4322,
            seed: 9876,
            bagtype: "zenith",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        }
      ]
    }),
    1000
  );

  assert.ok(result);
  assert.equal(result.bridge.mode, "zenith");
  assert.equal(result.bridge.round_id, "zenith:zenith-session-1:4321:9876");
  assert.equal(result.bridge.local.userid, "local-id");
  assert.equal(result.bridge.local.username, "VISIBLE_ROOT");
  assert.equal(result.bridge.local.gameid, 4321);
  assert.equal(result.bridge.local.seed, 9876);
  assert.deepEqual(result.bridge.opponents, []);
  assert.deepEqual(result.bridge.options, {
    bagtype: "zenith",
    nextcount: 5,
    boardwidth: 10,
    boardheight: 20
  });
});

test("zenith resolves local player from observer userid before username fallback", () => {
  const { dir, filePath } = makeTempBridgeFile();

  try {
    const state = createVsBridgeState(filePath, () => {});
    ingestVsBridgeOptionsCandidate(state, {
      options: {
        seed: 5678,
        bagtype: "zenith",
        nextcount: 5,
        boardwidth: 10,
        boardheight: 20
      },
      context: {
        local: true,
        userid: "player-b",
        username: "HEBI_"
      }
    });
    ingestVsBridgeRoot(
      state,
      zenithRoundRoot({
        user: null,
        players: [
          {
            userid: "player-a",
            username: "hebi_",
            gameid: 7001,
            options: {
              gameid: 7001,
              seed: 5678,
              bagtype: "zenith",
              nextcount: 5,
              boardwidth: 10,
              boardheight: 20
            }
          },
          {
            userid: "player-b",
            username: "hebi_",
            gameid: 7002,
            options: {
              gameid: 7002,
              seed: 5678,
              bagtype: "zenith",
              nextcount: 5,
              boardwidth: 10,
              boardheight: 20
            }
          }
        ]
      }),
      { timestamp: 1000 }
    );

    const bridge = readJson(filePath);
    assert.equal(bridge.local.userid, "player-b");
    assert.equal(bridge.local.gameid, 7002);
    assert.equal(bridge.round_id, "zenith:zenith-session-1:7002:5678");
  } finally {
    cleanupTempDir(dir);
  }
});

test("zenith falls back to normalized username only when userid is unavailable", () => {
  const result = deriveVsRoundBridge(
    zenithRoundRoot({
      context: {
        username: "HEBI_"
      },
      players: [
        {
          username: "hebi_",
          gameid: 9001,
          options: {
            gameid: 9001,
            seed: 5678,
            bagtype: "zenith",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        },
        {
          username: "guest",
          gameid: 9002,
          options: {
            gameid: 9002,
            seed: 5678,
            bagtype: "zenith",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        },
      ]
    }),
    1000
  );

  assert.ok(result);
  assert.equal(result.bridge.local.userid, null);
  assert.equal(result.bridge.local.gameid, 9001);
});

test("many-player zenith bridge does not require an opponent entry", () => {
  const result = deriveVsRoundBridge(
    zenithRoundRoot({
      context: {
        userid: "local-id",
        username: "hebi_"
      },
      players: [
        {
          userid: "local-id",
          username: "hebi_",
          gameid: 1111,
          options: {
            gameid: 1111,
            seed: 5678,
            bagtype: "zenith",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        },
        {
          userid: "other-1",
          username: "other-1",
          gameid: 1112,
          options: {
            gameid: 1112,
            seed: 5678,
            bagtype: "zenith",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        },
        {
          userid: "other-2",
          username: "other-2",
          gameid: 1113,
          options: {
            gameid: 1113,
            seed: 5678,
            bagtype: "zenith",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        }
      ]
    }),
    1000
  );

  assert.ok(result);
  assert.equal(result.bridge.local.userid, "local-id");
  assert.deepEqual(result.bridge.opponents, []);
});

test("duplicate flattened options update one zenith player entry", () => {
  const state = createVsBridgeState(DEFAULT_BRIDGE_PATH, () => {});
  const candidate = {
    path: "root.player.options",
    context: {
      userid: "local-id",
      username: "hebi_",
      gameid: 7101
    },
    options: {
      seed: 9911,
      bagtype: "zenith",
      nextcount: 5,
      boardwidth: 10,
      boardheight: 20
    }
  };

  ingestVsBridgeOptionsCandidate(state, candidate);
  ingestVsBridgeOptionsCandidate(state, {
    ...candidate,
    options: {
      ...candidate.options,
      nextcount: 6
    }
  });

  assert.equal(state.zenithPlayersByGameId.size, 1);
  assert.equal(state.zenithPlayersByUserId.size, 1);
  assert.equal(
    state.zenithPlayersByGameId.get("7101")?.nextcount,
    6
  );
});

test("identity before options creates bridge", () => {
  const { dir, filePath } = makeTempBridgeFile();

  try {
    const state = createVsBridgeState(filePath, () => {});
    ingestVsBridgeSessionSelfIdentity(state, {
      userid: "local-id",
      username: "hebi_",
      source: "trusted_session_packet"
    });
    ingestVsBridgeOptionsCandidate(state, {
      path: "root.player.options",
      context: {
        userid: "local-id",
        username: "hebi_",
        gameid: 7101,
        session: "zenith-session-flat"
      },
      options: {
        seed: 9911,
        bagtype: "zenith",
        nextcount: 5,
        boardwidth: 10,
        boardheight: 20
      }
    });
    ingestVsBridgeRoot(state, zenithFlatOptionsRoot(), { timestamp: 1001 });

    const bridge = readJson(filePath);
    assert.equal(bridge.round_id, "zenith:zenith-session-flat:7101:9911");
    assert.equal(bridge.local.userid, "local-id");
  } finally {
    cleanupTempDir(dir);
  }
});

test("options before identity creates bridge", () => {
  const { dir, filePath } = makeTempBridgeFile();

  try {
    const state = createVsBridgeState(filePath, () => {});
    ingestVsBridgeOptionsCandidate(state, {
      path: "root.player.options",
      context: {
        userid: "local-id",
        username: "hebi_",
        gameid: 7101,
        session: "zenith-session-flat"
      },
      options: {
        seed: 9911,
        bagtype: "zenith",
        nextcount: 5,
        boardwidth: 10,
        boardheight: 20
      }
    });
    ingestVsBridgeRoot(state, zenithFlatOptionsRoot({ user: null }), { timestamp: 1000 });
    assert.equal(state.lastWaitingReason, "self_user_missing");
    ingestVsBridgeSessionSelfIdentity(state, {
      userid: "local-id",
      username: "hebi_",
      source: "trusted_session_packet"
    });

    const bridge = readJson(filePath);
    assert.equal(bridge.round_id, "zenith:zenith-session-flat:7101:9911");
    assert.equal(bridge.local.userid, "local-id");
  } finally {
    cleanupTempDir(dir);
  }
});

test("zenith bridge does not require original players array", () => {
  const { dir, filePath } = makeTempBridgeFile();

  try {
    const state = createVsBridgeState(filePath, () => {});
    ingestVsBridgeOptionsCandidate(state, {
      path: "root.player.options",
      context: {
        userid: "local-id",
        username: "hebi_",
        gameid: 7101,
        session: "zenith-session-flat"
      },
      options: {
        seed: 9911,
        bagtype: "zenith",
        nextcount: 5,
        boardwidth: 10,
        boardheight: 20
      }
    });
    ingestVsBridgeSessionSelfIdentity(state, {
      userid: "local-id",
      username: "hebi_",
      session: "zenith-session-flat",
      source: "trusted_session_packet"
    });

    const bridge = readJson(filePath);
    assert.equal(bridge.round_id, "zenith:zenith-session-flat:7101:9911");
    assert.deepEqual(bridge.opponents, []);
  } finally {
    cleanupTempDir(dir);
  }
});

test("arbitrary standalone user object is not accepted as self", () => {
  const state = createVsBridgeState(DEFAULT_BRIDGE_PATH, () => {});
  ingestVsBridgeOptionsCandidate(state, {
    path: "root.player.options",
    context: {
      userid: "other-id",
      username: "other",
      gameid: 7102,
      session: "zenith-session-flat"
    },
    options: {
      seed: 9912,
      bagtype: "zenith",
      nextcount: 5,
      boardwidth: 10,
      boardheight: 20
    }
  });
  ingestVsBridgeRoot(state, {
    _id: "standalone-user",
    username: "standalone"
  }, { timestamp: 1000 });

  assert.equal(state.lastWaitingReason, "self_user_missing");
});

test("missing self reports self_user_missing", () => {
  const state = createVsBridgeState(DEFAULT_BRIDGE_PATH, () => {});
  ingestVsBridgeOptionsCandidate(state, {
    path: "root.player.options",
    context: {
      userid: "guest-id",
      username: "guest",
      gameid: 7201,
      session: "zenith-session-flat"
    },
    options: {
      seed: 9921,
      bagtype: "zenith",
      nextcount: 5,
      boardwidth: 10,
      boardheight: 20
    }
  });
  ingestVsBridgeRoot(state, { session: "zenith-session-flat" }, { timestamp: 1000 });

  assert.equal(state.lastWaitingReason, "self_user_missing");
});

test("accumulated players without a local match report local_zenith_player_missing", () => {
  const state = createVsBridgeState(DEFAULT_BRIDGE_PATH, () => {});
  ingestVsBridgeOptionsCandidate(state, {
    path: "root.player.options",
    context: {
      userid: "guest-id",
      username: "guest",
      gameid: 7202,
      session: "zenith-session-flat"
    },
    options: {
      seed: 9922,
      bagtype: "zenith",
      nextcount: 5,
      boardwidth: 10,
      boardheight: 20
    }
  });
  ingestVsBridgeSessionSelfIdentity(state, {
    userid: "local-id",
    username: "hebi_",
    session: "zenith-session-flat",
    source: "trusted_session_packet"
  });

  assert.equal(state.lastWaitingReason, "local_zenith_player_missing");
});

test("target reset clears Zenith accumulator", () => {
  const state = createVsBridgeState(DEFAULT_BRIDGE_PATH, () => {});
  ingestVsBridgeSessionSelfIdentity(state, {
    userid: "local-id",
    username: "hebi_",
    source: "trusted_session_packet"
  });
  ingestVsBridgeOptionsCandidate(state, {
    path: "root.player.options",
    context: {
      userid: "local-id",
      username: "hebi_",
      gameid: 7301,
      session: "zenith-session-flat"
    },
    options: {
      seed: 9931,
      bagtype: "zenith",
      nextcount: 5,
      boardwidth: 10,
      boardheight: 20
    }
  });

  assert.equal(state.zenithPlayersByGameId.size, 1);
  assert.equal(resetVsBridgeZenithAccumulator(state), true);
  assert.equal(state.zenithPlayersByGameId.size, 0);
  assert.equal(state.zenithPlayersByUserId.size, 0);
  assert.equal(state.zenithSession, null);
  assert.equal(state.sessionSelfIdentity.userid, null);
});

test("roster root.user is treated as participant, not self", () => {
  const state = createVsBridgeState(DEFAULT_BRIDGE_PATH, () => {});

  ingestVsBridgeOptionsCandidate(state, {
    path: "root.player.options",
    requestId: "req-zenith",
    context: {
      userid: "guest-id",
      username: "guest",
      gameid: 8001
    },
    options: {
      seed: 5511,
      bagtype: "zenith",
      nextcount: 5,
      boardwidth: 10,
      boardheight: 20
    }
  });
  ingestVsBridgeRoot(state, {
    user: {
      _id: "guest-id",
      username: "guest"
    }
  }, { requestId: "req-zenith", timestamp: 1000 });

  assert.equal(state.sessionSelfIdentity.userid, null);
  assert.equal(state.participantIdentities.size, 1);
  assert.equal(state.lastWaitingReason, "self_user_missing");
});

test("username-only root.user is never promoted to self even when round players exist", () => {
  const state = createVsBridgeState(DEFAULT_BRIDGE_PATH, () => {});

  ingestVsBridgeRoot(
    state,
    {
      user: {
        username: "[sys]"
      },
      players: [
        {
          userid: "local-id",
          username: "hebi_",
          gameid: 6328,
          options: {
            gameid: 6328,
            seed: 1744077373,
            bagtype: "7-bag",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        },
        {
          userid: "guest-id",
          username: "guest",
          gameid: 6329,
          options: {
            gameid: 6329,
            seed: 1744077373,
            bagtype: "7-bag",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        }
      ]
    },
    { timestamp: 1000 }
  );

  assert.equal(state.sessionSelfIdentity.userid, null);
  assert.equal(state.sessionSelfIdentity.username, null);
});

test("username-only root.user with arbitrary name is never promoted to self", () => {
  const state = createVsBridgeState(DEFAULT_BRIDGE_PATH, () => {});

  ingestVsBridgeRoot(
    state,
    {
      user: {
        username: "totally-random-name"
      },
      players: [
        {
          userid: "local-id",
          username: "hebi_",
          gameid: 6428,
          options: {
            gameid: 6428,
            seed: 1744077374,
            bagtype: "7-bag",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        },
        {
          userid: "guest-id",
          username: "guest",
          gameid: 6429,
          options: {
            gameid: 6429,
            seed: 1744077374,
            bagtype: "7-bag",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        }
      ]
    },
    { timestamp: 1000 }
  );

  assert.equal(state.sessionSelfIdentity.userid, null);
  assert.equal(state.sessionSelfIdentity.username, null);
});

test("configured local username resolves the matching round participant", () => {
  const state = createVsBridgeState(DEFAULT_BRIDGE_PATH, () => {});
  configureFriendlyVsLocalUsername(state, "GUEST-2E94IOLA_");

  ingestVsBridgeRoot(
    state,
    {
      players: [
        {
          userid: "A",
          username: "hebi_",
          gameid: 10,
          options: {
            gameid: 10,
            seed: 1744077375,
            bagtype: "7-bag",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        },
        {
          userid: "B",
          username: "GUEST-2E94IOLA_",
          gameid: 11,
          options: {
            gameid: 11,
            seed: 1744077375,
            bagtype: "7-bag",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        }
      ]
    },
    { timestamp: 1000 }
  );

  assert.equal(state.sessionSelfIdentity.userid, null);
  assert.equal(state.current.local.userid, "B");
  assert.equal(state.current.local.gameid, 11);
});

test("explicit local root.user marker remains authoritative", () => {
  const state = createVsBridgeState(DEFAULT_BRIDGE_PATH, () => {});

  ingestVsBridgeRoot(
    state,
    {
      user: {
        username: "explicit-local",
        local: true
      },
      players: [
        {
          userid: "other-id",
          username: "other",
          gameid: 6628,
          options: {
            gameid: 6628,
            seed: 1744077376,
            bagtype: "7-bag",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        },
        {
          userid: "guest-id",
          username: "guest",
          gameid: 6629,
          options: {
            gameid: 6629,
            seed: 1744077376,
            bagtype: "7-bag",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        }
      ]
    },
    { timestamp: 1000 }
  );

  assert.equal(state.sessionSelfIdentity.username, "explicit-local");
  assert.equal(state.sessionSelfIdentity.source, "root.user");
});

test("participant root.user cannot promote a different roster user to self", () => {
  const state = createVsBridgeState(DEFAULT_BRIDGE_PATH, () => {});
  configureFriendlyVsLocalUsername(state, "GUEST-2E94IOLA_");

  ingestVsBridgeRoot(
    state,
    {
      user: {
        _id: "A",
        username: "hebi_"
      },
      players: [
        {
          userid: "A",
          username: "hebi_",
          gameid: 10,
          options: {
            gameid: 10,
            seed: 1744077377,
            bagtype: "7-bag",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        },
        {
          userid: "B",
          username: "GUEST-2E94IOLA_",
          gameid: 11,
          options: {
            gameid: 11,
            seed: 1744077377,
            bagtype: "7-bag",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        }
      ]
    },
    { timestamp: 1000 }
  );

  assert.equal(state.sessionSelfIdentity.userid, null);
  assert.equal(state.current.local.userid, "B");
});

test("configured local username waits when no round participant matches", () => {
  const state = createVsBridgeState(DEFAULT_BRIDGE_PATH, () => {});
  configureFriendlyVsLocalUsername(state, "GUEST-2E94IOLA_");

  ingestVsBridgeRoot(
    state,
    {
      players: [
        {
          userid: "A",
          username: "hebi_",
          gameid: 10,
          options: {
            gameid: 10,
            seed: 1744077378,
            bagtype: "7-bag",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        },
        {
          userid: "B",
          username: "guest-other",
          gameid: 11,
          options: {
            gameid: 11,
            seed: 1744077378,
            bagtype: "7-bag",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        }
      ]
    },
    { timestamp: 1000 }
  );

  assert.equal(state.current, null);
  assert.equal(state.lastWaitingReason, "configured_username_not_found");
});

test("configured local username waits when multiple round participants match", () => {
  const state = createVsBridgeState(DEFAULT_BRIDGE_PATH, () => {});
  configureFriendlyVsLocalUsername(state, "GUEST-2E94IOLA_");

  ingestVsBridgeRoot(
    state,
    {
      players: [
        {
          userid: "A",
          username: "GUEST-2E94IOLA_",
          gameid: 10,
          options: {
            gameid: 10,
            seed: 1744077379,
            bagtype: "7-bag",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        },
        {
          userid: "B",
          username: "guest-2e94iola_",
          gameid: 11,
          options: {
            gameid: 11,
            seed: 1744077379,
            bagtype: "7-bag",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        }
      ]
    },
    { timestamp: 1000 }
  );

  assert.equal(state.current, null);
  assert.equal(state.lastWaitingReason, "configured_username_ambiguous");
});

test("blank configured username still blocks generic root.user roster-match fallback", () => {
  const state = createVsBridgeState(DEFAULT_BRIDGE_PATH, () => {});

  ingestVsBridgeRoot(
    state,
    {
      user: {
        _id: "local-id",
        username: "hebi_"
      },
      players: [
        {
          userid: "local-id",
          username: "hebi_",
          gameid: 6528,
          options: {
            gameid: 6528,
            seed: 1744077380,
            bagtype: "7-bag",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        },
        {
          userid: "guest-id",
          username: "guest",
          gameid: 6529,
          options: {
            gameid: 6529,
            seed: 1744077380,
            bagtype: "7-bag",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        }
      ]
    },
    { timestamp: 1000 }
  );

  assert.equal(state.sessionSelfIdentity.userid, null);
  assert.equal(state.current, null);
  assert.equal(state.lastWaitingReason, "self_user_missing");
});

test("configured local username conflict blocks explicit self marker", () => {
  const state = createVsBridgeState(DEFAULT_BRIDGE_PATH, () => {});
  configureFriendlyVsLocalUsername(state, "GUEST-2E94IOLA_");

  ingestVsBridgeRoot(
    state,
    {
      user: {
        username: "hebi_",
        local: true
      },
      players: [
        {
          userid: "A",
          username: "hebi_",
          gameid: 10,
          options: {
            gameid: 10,
            seed: 1744077381,
            bagtype: "7-bag",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        },
        {
          userid: "B",
          username: "GUEST-2E94IOLA_",
          gameid: 11,
          options: {
            gameid: 11,
            seed: 1744077381,
            bagtype: "7-bag",
            nextcount: 5,
            boardwidth: 10,
            boardheight: 20
          }
        }
      ]
    },
    { timestamp: 1000 }
  );

  assert.equal(state.current, null);
  assert.equal(state.lastWaitingReason, "identity_conflict");
});

test("multiple root.user candidates in one request never overwrite session self", () => {
  const state = createVsBridgeState(DEFAULT_BRIDGE_PATH, () => {});
  ingestVsBridgeSessionSelfIdentity(state, {
    userid: "local-id",
    username: "hebi_",
    source: "trusted_session_packet"
  });

  ingestVsBridgeRoot(state, {
    user: {
      _id: "guest-a",
      username: "guest-a"
    }
  }, { requestId: "req-zenith", timestamp: 1000 });
  ingestVsBridgeRoot(state, {
    user: {
      _id: "guest-b",
      username: "guest-b"
    }
  }, { requestId: "req-zenith", timestamp: 1001 });

  assert.equal(state.sessionSelfIdentity.userid, "local-id");
  assert.equal(state.participantIdentities.size, 2);
});

test("participant root.user before trusted self leaves self unresolved", () => {
  const state = createVsBridgeState(DEFAULT_BRIDGE_PATH, () => {});
  ingestVsBridgeRoot(state, {
    user: {
      _id: "guest-id",
      username: "guest"
    }
  }, { requestId: "req-zenith", timestamp: 1000 });

  assert.equal(state.sessionSelfIdentity.userid, null);
});

test("trusted session packet pins self identity", () => {
  const state = createVsBridgeState(DEFAULT_BRIDGE_PATH, () => {});

  ingestVsBridgeRoot(state, {
    context: {
      userid: "local-id",
      username: "hebi_"
    }
  }, { timestamp: 1000 });

  assert.equal(state.sessionSelfIdentity.userid, "local-id");
  assert.equal(state.sessionSelfIdentity.source, "root.context");
});

test("pinned self ignores later participant identities", () => {
  const state = createVsBridgeState(DEFAULT_BRIDGE_PATH, () => {});
  ingestVsBridgeSessionSelfIdentity(state, {
    userid: "local-id",
    username: "hebi_",
    source: "trusted_session_packet"
  });

  ingestVsBridgeOptionsCandidate(state, {
    path: "root.player.options",
    requestId: "req-zenith",
    context: {
      userid: "guest-id",
      username: "guest",
      gameid: 8002
    },
    options: {
      seed: 5512,
      bagtype: "zenith",
      nextcount: 5,
      boardwidth: 10,
      boardheight: 20
    }
  });
  ingestVsBridgeRoot(state, {
    user: {
      _id: "guest-id",
      username: "guest"
    }
  }, { requestId: "req-zenith", timestamp: 1000 });

  assert.equal(state.sessionSelfIdentity.userid, "local-id");
});

test("userid match takes precedence over username", () => {
  const { dir, filePath } = makeTempBridgeFile();

  try {
    const state = createVsBridgeState(filePath, () => {});
    ingestVsBridgeSessionSelfIdentity(state, {
      userid: "player-b",
      username: "hebi_",
      source: "trusted_session_packet"
    });
    ingestVsBridgeOptionsCandidate(state, {
      path: "root.player.options",
      context: {
        userid: "player-a",
        username: "hebi_",
        gameid: 8101,
        session: "zenith-session-flat"
      },
      options: {
        seed: 9913,
        bagtype: "zenith",
        nextcount: 5,
        boardwidth: 10,
        boardheight: 20
      }
    });
    ingestVsBridgeOptionsCandidate(state, {
      path: "root.player.options",
      context: {
        userid: "player-b",
        username: "hebi_",
        gameid: 8102,
        session: "zenith-session-flat"
      },
      options: {
        seed: 9913,
        bagtype: "zenith",
        nextcount: 5,
        boardwidth: 10,
        boardheight: 20
      }
    });

    const bridge = readJson(filePath);
    assert.equal(bridge.local.userid, "player-b");
    assert.equal(bridge.local.gameid, 8102);
  } finally {
    cleanupTempDir(dir);
  }
});

test("unrelated participant with the same username is not selected", () => {
  const state = createVsBridgeState(DEFAULT_BRIDGE_PATH, () => {});
  ingestVsBridgeSessionSelfIdentity(state, {
    userid: "local-id",
    username: "hebi_",
    source: "trusted_session_packet"
  });
  ingestVsBridgeOptionsCandidate(state, {
    path: "root.player.options",
    context: {
      userid: "other-id",
      username: "hebi_",
      gameid: 8201,
      session: "zenith-session-flat"
    },
    options: {
      seed: 9914,
      bagtype: "zenith",
      nextcount: 5,
      boardwidth: 10,
      boardheight: 20
    }
  });

  assert.equal(state.lastWaitingReason, "local_zenith_player_missing");
});

test("deriveVsRoundBridge falls back to precountdown when countdown metadata is invalid", () => {
  const capturedAt = 1783780572968;
  const result = deriveVsRoundBridge(
    combinedRoundRoot({
      options: {
        seed: 187156,
        precountdown: 5000,
        countdown_count: 0,
        countdown_interval: "bad"
      }
    }),
    capturedAt,
    {
      configuredLocalUsername: "hebi_"
    }
  );

  assert.ok(result);
  assert.equal(result.bridge.readyAt, capturedAt + 5000);
  assert.equal(result.bridge.readyOffsetMs, 5000);
  assert.equal(result.bridge.readyOffsetSource, "precountdown_fallback");
});

test("writeVsBridgeFile writes atomically without leaving a temp file", () => {
  const { dir, filePath } = makeTempBridgeFile();

  try {
    writeVsBridgeFile(filePath, {
      version: 1,
      sequence: 1,
      roundId: "5449:1744077373",
      active: true
    });

    assert.equal(existsSync(filePath), true);
    assert.equal(existsSync(`${filePath}.tmp`), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test("collectVsIncomingGarbage keeps only interaction events with ownerGameId", () => {
  const currentBridge = {
    roundId: "5449:1744077373",
    local: { gameid: 5449 }
  };
  const root = {
    gameid: 5450,
    replay: {
      events: [
        {
          type: "interaction",
          frame: 179,
          id: 2,
          data: {
            type: "garbage",
            gameid: 5449,
            frame: 214,
            amt: 2,
            size: 2,
            x: 2,
            y: { ignored: true },
            iid: 11,
            cid: "cid-1"
          }
        },
        {
          type: "interaction_confirm",
          frame: 180,
          id: 3,
          data: {
            type: "garbage",
            gameid: 5449,
            frame: 214,
            amt: 2,
            size: 2,
            x: 2,
            iid: 11,
            cid: "cid-1"
          }
        }
      ]
    },
    copies: [
      {
        replay: {
          events: [
            {
              type: "interaction",
              frame: 181,
              data: {
                type: "garbage",
                gameid: 5449,
                frame: 215,
                amt: 3,
                size: 3,
                x: 6,
                iid: 12,
                cid: "cid-2"
              }
            }
          ]
        }
      }
    ]
  };

  const events = collectVsIncomingGarbage(root, currentBridge);

  assert.equal(events.length, 1);
  assert.deepEqual(events[0].data, {
    type: "garbage",
    gameid: 5449,
    frame: 214,
    amt: 2,
    size: 2,
    x: 2,
    iid: 11,
    cid: "cid-1"
  });
});

test("split identity packets build the same bridge in A->B->C order", () => {
  const { dir, filePath } = makeTempBridgeFile();
  const logs = [];

  try {
    const state = createVsBridgeState(filePath, (line) => logs.push(line));
    configureFriendlyVsLocalUsername(state, "hebi_");
    ingestVsBridgeRoot(state, packetA(), { timestamp: 1000 });
    ingestVsBridgeRoot(state, packetB(), { timestamp: 1100 });
    ingestVsBridgeRoot(state, packetC(), { timestamp: 1200 });

    const bridge = readJson(filePath);
    assert.equal(bridge.local.username, "hebi_");
    assert.equal(bridge.local.userid, "local-id");
    assert.equal(bridge.local.gameid, 5449);
    assert.equal(bridge.opponents[0].gameid, 5450);
    assert.equal(bridge.options.seed, 1744077373);
    assert.equal(bridge.roomSeed, null);
    assert.equal(bridge.readyAt, 1000);
    assert.ok(
      logs.includes(
        "[vs-bridge] local player username=hebi_ userid=local-id gameid=5449"
      )
    );
    assert.ok(logs.includes("[vs-bridge] written roundId=5449:1744077373"));
  } finally {
    cleanupTempDir(dir);
  }
});

test("split identity packets build the same bridge in C->B->A order", () => {
  const { dir, filePath } = makeTempBridgeFile();

  try {
    const state = createVsBridgeState(filePath, () => {});
    configureFriendlyVsLocalUsername(state, "hebi_");
    ingestVsBridgeRoot(state, packetC(), { timestamp: 1200 });
    ingestVsBridgeRoot(state, packetB(), { timestamp: 1100 });
    ingestVsBridgeRoot(state, packetA(), { timestamp: 1000 });

    const bridge = readJson(filePath);
    assert.equal(bridge.local.username, "hebi_");
    assert.equal(bridge.local.userid, "local-id");
    assert.equal(bridge.local.gameid, 5449);
    assert.equal(bridge.opponents[0].gameid, 5450);
    assert.equal(bridge.options.seed, 1744077373);
    assert.equal(bridge.readyAt, 1000);
  } finally {
    cleanupTempDir(dir);
  }
});

test("room options arriving later update readyAt without changing the round seed", () => {
  const { dir, filePath } = makeTempBridgeFile();

  try {
    const state = createVsBridgeState(filePath, () => {});
    configureFriendlyVsLocalUsername(state, "hebi_");
    ingestVsBridgeRoot(state, packetA(), { timestamp: 1000 });
    ingestVsBridgeRoot(state, packetB(), { timestamp: 1100 });
    ingestVsBridgeRoot(state, packetC(), { timestamp: 1200 });
    ingestVsBridgeRoot(state, packetRoomOptions(), { timestamp: 2000 });

    const bridge = readJson(filePath);
    assert.equal(bridge.options.seed, 1744077373);
    assert.equal(bridge.roomSeed, 187156);
    assert.equal(bridge.readyAt, 1000 + 3000);
  } finally {
    cleanupTempDir(dir);
  }
});

test("readyAt log prefers countdown and does not add precountdown on top", () => {
  const { dir, filePath } = makeTempBridgeFile();
  const logs = [];

  try {
    const state = createVsBridgeState(filePath, (line) => logs.push(line));
    configureFriendlyVsLocalUsername(state, "hebi_");
    ingestVsBridgeRoot(state, combinedRoundRoot(), { timestamp: 1000 }, (line) =>
      logs.push(line)
    );

    assert.ok(
      logs.includes("[vs-bridge] readyAt offset_ms=3000 source=countdown")
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test("readyAt log falls back to precountdown when countdown metadata is missing", () => {
  const { dir, filePath } = makeTempBridgeFile();
  const logs = [];

  try {
    const state = createVsBridgeState(filePath, (line) => logs.push(line));
    configureFriendlyVsLocalUsername(state, "hebi_");
    ingestVsBridgeRoot(
      state,
      combinedRoundRoot({
        options: {
          seed: 187156,
          precountdown: 5000
        }
      }),
      { timestamp: 1000 },
      (line) => logs.push(line)
    );

    assert.ok(
      logs.includes(
        "[vs-bridge] readyAt offset_ms=5000 source=precountdown_fallback"
      )
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test("shared player seed mismatch logs once and blocks bridge creation", () => {
  const { dir, filePath } = makeTempBridgeFile();
  const logs = [];

  try {
    const state = createVsBridgeState(filePath, (line) => logs.push(line));
    configureFriendlyVsLocalUsername(state, "hebi_");
    ingestVsBridgeRoot(
      state,
      packetA({
        players: [
          {
            userid: "local-id",
            gameid: 5449,
            options: {
              gameid: 5449,
              seed: 1744077373,
              bagtype: "7-bag",
              nextcount: 5,
              boardwidth: 10,
              boardheight: 20
            }
          },
          {
            userid: "guest-id",
            gameid: 5450,
            options: {
              gameid: 5450,
              seed: 1744077374,
              bagtype: "7-bag",
              nextcount: 5,
              boardwidth: 10,
              boardheight: 20
            }
          }
        ]
      }),
      { timestamp: 1000 }
    );
    ingestVsBridgeRoot(state, packetC(), { timestamp: 1001 });
    ingestVsBridgeRoot(state, packetB(), { timestamp: 1002 });
    ingestVsBridgeRoot(state, packetB(), { timestamp: 1003 });

    assert.equal(existsSync(filePath), false);
    assert.equal(
      logs.filter((line) => line === "[vs-bridge] waiting reason=round_seed_mismatch").length,
      1
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test("same round packets do not rewrite the bridge unnecessarily", () => {
  const { dir, filePath } = makeTempBridgeFile();

  try {
    const state = createVsBridgeState(filePath, () => {});
    configureFriendlyVsLocalUsername(state, "hebi_");
    ingestVsBridgeRoot(state, packetA(), { timestamp: 1000 });
    ingestVsBridgeRoot(state, packetB(), { timestamp: 1100 });
    ingestVsBridgeRoot(state, packetC(), { timestamp: 1200 });
    const firstBridge = readJson(filePath);
    ingestVsBridgeRoot(state, packetA(), { timestamp: 4000 });
    ingestVsBridgeRoot(state, packetB(), { timestamp: 4100 });
    ingestVsBridgeRoot(state, packetC(), { timestamp: 4200 });
    const secondBridge = readJson(filePath);

    assert.equal(firstBridge.sequence, 1);
    assert.equal(secondBridge.sequence, 1);
    assert.deepEqual(secondBridge, firstBridge);
  } finally {
    cleanupTempDir(dir);
  }
});

test("updateVsBridgeState stores round start and deduped interaction garbage", () => {
  const { dir, filePath } = makeTempBridgeFile();
  const logs = [];

  try {
    const state = createVsBridgeState(filePath, (line) => logs.push(line));
    configureFriendlyVsLocalUsername(state, "hebi_");
    updateVsBridgeState(
      state,
      [packetA(), packetB(), packetC()],
      (line) => logs.push(line),
      1000
    );
    updateVsBridgeState(
      state,
      [
        {
          gameid: 5450,
          replay: {
            events: [
              {
                type: "interaction",
                frame: 179,
                id: 2,
                data: {
                  type: "garbage",
                  gameid: 5449,
                  frame: 214,
                  amt: 2,
                  size: 2,
                  x: 2,
                  iid: 11,
                  cid: "cid-1"
                }
              },
              {
                type: "interaction",
                frame: 179,
                id: 2,
                data: {
                  type: "garbage",
                  gameid: 5449,
                  frame: 214,
                  amt: 2,
                  size: 2,
                  x: 2,
                  iid: 11,
                  cid: "cid-1"
                }
              },
              {
                type: "interaction_confirm",
                frame: 180,
                id: 3,
                data: {
                  type: "garbage",
                  gameid: 5449,
                  frame: 214,
                  amt: 2,
                  size: 2,
                  x: 2,
                  iid: 11,
                  cid: "cid-1"
                }
              }
            ]
          }
        }
      ],
      (line) => logs.push(line),
      2000
    );

    const bridge = readJson(filePath);
    assert.equal(bridge.roundId, "5449:1744077373");
    assert.equal(bridge.sequence, 2);
    assert.equal(bridge.options.seed, 1744077373);
    assert.equal(bridge.incomingGarbage.length, 1);
    assert.equal(bridge.incomingGarbage[0].eventType, "interaction");
    assert.ok(
      logs.includes("[vs-bridge] garbage application disabled in validation phase")
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test("markVsBridgeInactive writes an inactive bridge snapshot", () => {
  const { dir, filePath } = makeTempBridgeFile();

  try {
    const state = createVsBridgeState(filePath, () => {});
    configureFriendlyVsLocalUsername(state, "hebi_");
    updateVsBridgeState(state, [packetA(), packetB(), packetC()], () => {}, 1000);
    markVsBridgeInactive(state, () => {});

    const bridge = readJson(filePath);
    assert.equal(bridge.active, false);
    assert.equal(bridge.roundId, "5449:1744077373");
  } finally {
    cleanupTempDir(dir);
  }
});
