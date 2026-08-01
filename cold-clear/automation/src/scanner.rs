use std::convert::TryInto;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use libtetris::{Piece, RotationState};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::error::Category as JsonErrorCategory;
use serde_json::Value;

use crate::browser_source::BrowserSnapshotWire;

pub const MAX_SNAPSHOT_AGE_MS: u64 = 1_000;

#[derive(Clone, Debug, Deserialize)]
pub struct GameSnapshot {
    #[serde(default = "default_snapshot_source")]
    pub source: String,
    pub token: String,
    #[serde(default)]
    pub round_id: Option<String>,
    pub field: Vec<[bool; 10]>,
    pub queue: Vec<PieceToken>,
    #[serde(default)]
    pub hold: Option<PieceToken>,
    #[serde(default)]
    pub combo: u32,
    #[serde(default)]
    pub b2b: bool,
    #[serde(default)]
    pub incoming: u32,
    #[serde(default)]
    pub piece_counter: Option<u32>,
    #[serde(default)]
    pub lines_cleared: Option<u32>,
    #[serde(default = "default_true")]
    pub playing: bool,
    #[serde(default)]
    pub countdown: bool,
    #[serde(default)]
    pub active: Option<ActivePieceState>,
}

#[derive(Clone, Debug)]
pub struct ZenithPassivePlannerSnapshot {
    pub snapshot: GameSnapshot,
    pub userid: String,
    pub gameid: String,
    pub candidate_id: String,
    pub capture_generation: u64,
    pub timestamp_ms: u64,
    pub current_signature: String,
    pub playing: bool,
    pub started: bool,
    pub countdown_started: bool,
    pub paused: Option<bool>,
    pub destroyed: bool,
    pub gameoverreason: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ZenithPassiveSnapshotEnvelope {
    pub status: String,
    pub capture_status: Option<String>,
    pub semantic_error: Option<String>,
    pub snapshot: Option<ZenithPassivePlannerSnapshot>,
}

impl GameSnapshot {
    pub fn field_array(&self) -> Result<[[bool; 10]; 40]> {
        self.field
            .clone()
            .try_into()
            .map_err(|rows: Vec<[bool; 10]>| {
                anyhow::anyhow!("expected 40 rows, got {}", rows.len())
            })
    }

    pub fn queue_pieces(&self) -> Vec<Piece> {
        self.queue.iter().copied().map(Into::into).collect()
    }

    pub fn hold_piece(&self) -> Option<Piece> {
        self.hold.map(Into::into)
    }

    pub fn board(&self) -> Result<libtetris::Board> {
        Ok(libtetris::Board::new_with_state(
            self.field_array()?,
            enumset::EnumSet::all(),
            self.hold_piece(),
            self.b2b,
            self.combo,
        ))
    }
}

#[derive(Copy, Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RotationToken {
    North,
    East,
    South,
    West,
}

impl From<RotationToken> for RotationState {
    fn from(value: RotationToken) -> Self {
        match value {
            RotationToken::North => RotationState::North,
            RotationToken::East => RotationState::East,
            RotationToken::South => RotationState::South,
            RotationToken::West => RotationState::West,
        }
    }
}

#[derive(Copy, Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct ActivePieceState {
    pub x: i32,
    #[serde(default)]
    pub y: i32,
    pub rotation: RotationToken,
}

pub trait SnapshotScanner {
    fn next_snapshot(&mut self) -> Result<Option<GameSnapshot>>;

    fn arm_piece_transition(&mut self, _: &GameSnapshot) {}

    fn latest_snapshot_age(&self) -> Option<Duration> {
        None
    }
}

pub struct JsonFileScanner {
    path: PathBuf,
    last_token: Option<String>,
    waiting_for_file_logged: bool,
    min_snapshot_age: Duration,
    piece_transition_guard: Option<PieceTransitionGuard>,
    pending_token: Option<String>,
    pending_seen_count: u32,
    latest_snapshot_age: Option<Duration>,
    stale_snapshot_token_logged: Option<String>,
}

#[derive(Clone, Debug)]
struct PieceTransitionGuard {
    queue: Vec<PieceToken>,
    piece_counter: Option<u32>,
}

impl JsonFileScanner {
    pub fn new(path: PathBuf, min_snapshot_age: Duration) -> Self {
        Self {
            path,
            last_token: None,
            waiting_for_file_logged: false,
            min_snapshot_age,
            piece_transition_guard: None,
            pending_token: None,
            pending_seen_count: 0,
            latest_snapshot_age: None,
            stale_snapshot_token_logged: None,
        }
    }

    pub fn with_last_token(
        path: PathBuf,
        min_snapshot_age: Duration,
        last_token: Option<String>,
    ) -> Self {
        let mut scanner = Self::new(path, min_snapshot_age);
        scanner.last_token = last_token;
        scanner
    }
}

impl SnapshotScanner for JsonFileScanner {
    fn arm_piece_transition(&mut self, previous: &GameSnapshot) {
        self.piece_transition_guard = Some(PieceTransitionGuard {
            queue: previous.queue.clone(),
            piece_counter: previous.piece_counter,
        });
    }

    fn latest_snapshot_age(&self) -> Option<Duration> {
        self.latest_snapshot_age
    }

    fn next_snapshot(&mut self) -> Result<Option<GameSnapshot>> {
        let raw = match fs::read_to_string(&self.path) {
            Ok(raw) => {
                self.waiting_for_file_logged = false;
                raw
            }
            Err(err) if is_retryable_snapshot_io_error(&err) => {
                if !self.waiting_for_file_logged {
                    println!(
                        "[automation] waiting for scanner output at {}",
                        self.path.display()
                    );
                    self.waiting_for_file_logged = true;
                }
                return Ok(None);
            }
            Err(err) => {
                return Err(err).with_context(|| {
                    format!("failed to read snapshot JSON from {}", self.path.display())
                });
            }
        };
        if raw.trim().is_empty() {
            return Ok(None);
        }
        let snapshot_age = read_snapshot_age(&self.path)?;
        let snapshot = match parse_snapshot_json(&raw) {
            Ok(snapshot) => snapshot,
            Err(err) if is_retryable_snapshot_parse_error(&raw, &err) => {
                return Ok(None);
            }
            Err(err) => return Err(err).context("failed to parse snapshot JSON"),
        };
        self.latest_snapshot_age = snapshot_age;
        if snapshot_age.map(snapshot_age_is_stale).unwrap_or(false) {
            log_stale_snapshot_once(
                &mut self.stale_snapshot_token_logged,
                &snapshot.token,
                snapshot_age.expect("stale snapshot age should exist"),
            );
            self.pending_token = None;
            self.pending_seen_count = 0;
            return Ok(None);
        }
        if self.last_token.as_deref() == Some(snapshot.token.as_str()) {
            return Ok(None);
        }
        let is_same_pending = self.pending_token.as_deref() == Some(snapshot.token.as_str());
        if is_same_pending {
            self.pending_seen_count += 1;
        } else {
            self.pending_token = Some(snapshot.token.clone());
            self.pending_seen_count = 1;
        }

        let age_ready = snapshot_age
            .map(|age| age >= self.min_snapshot_age)
            .unwrap_or(true);
        let required_stable_reads = if snapshot.source == "browser_cdp" {
            1
        } else {
            2
        };
        let stable_enough = self.pending_seen_count >= required_stable_reads;

        if !age_ready || !stable_enough {
            return Ok(None);
        }

        if let Some(guard) = &self.piece_transition_guard {
            if !queue_transitioned(&guard.queue, guard.piece_counter, &snapshot) {
                return Ok(None);
            }
        }

        self.last_token = Some(snapshot.token.clone());
        self.stale_snapshot_token_logged = None;
        self.piece_transition_guard = None;
        self.pending_token = None;
        self.pending_seen_count = 0;
        Ok(Some(snapshot))
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum SnapshotWire {
    Browser(BrowserSnapshotWire),
    Compatible(CompatibleSnapshotWire),
    Game(GameSnapshot),
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
struct ZenithPassiveEnvelopeWire {
    status: String,
    capture_status: Option<String>,
    snapshot: Option<ZenithPassiveSnapshotWire>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
struct ZenithPassiveSnapshotWire {
    source: String,
    capture_generation: u64,
    timestamp: u64,
    userid: String,
    gameid: Value,
    candidate_id: String,
    playing: bool,
    started: bool,
    countdown_started: bool,
    paused: Option<bool>,
    destroyed: bool,
    gameoverreason: Option<String>,
    board: Vec<Vec<Value>>,
    current: ZenithPassiveCurrentWire,
    hold: Option<String>,
    queue: Vec<String>,
    piece_counter: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(default)]
struct ZenithPassiveCurrentWire {
    #[serde(rename = "type")]
    piece: Option<String>,
    #[serde(default, deserialize_with = "deserialize_zenith_coordinate_wire")]
    x: ZenithCoordinateWire,
    #[serde(default, deserialize_with = "deserialize_zenith_coordinate_wire")]
    y: ZenithCoordinateWire,
    rotation: Option<ZenithPassiveRotationWire>,
}

#[derive(Clone, Debug, Default)]
enum ZenithCoordinateWire {
    #[default]
    Missing,
    Null,
    Value(Value),
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum ZenithPassiveRotationWire {
    Number(i32),
    Text(String),
}

fn parse_snapshot_json(raw: &str) -> Result<GameSnapshot> {
    match serde_json::from_str::<SnapshotWire>(raw)? {
        SnapshotWire::Browser(wire) => wire
            .into_game_snapshot()?
            .context("browser snapshot was not ready"),
        SnapshotWire::Compatible(wire) => wire
            .into_game_snapshot()?
            .context("compatible snapshot was not ready"),
        SnapshotWire::Game(snapshot) => Ok(snapshot),
    }
}

pub fn read_zenith_passive_snapshot_file_with_age(
    path: &Path,
) -> Result<Option<(ZenithPassiveSnapshotEnvelope, Option<Duration>)>> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if is_retryable_snapshot_io_error(&err) => return Ok(None),
        Err(err) => {
            return Err(err).with_context(|| {
                format!(
                    "failed to read Zenith passive snapshot JSON from {}",
                    path.display()
                )
            })
        }
    };
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let snapshot_age = read_snapshot_age(path)?;
    let envelope_wire: ZenithPassiveEnvelopeWire =
        serde_json::from_str(&raw).context("failed to parse Zenith passive snapshot JSON")?;
    let snapshot = match envelope_wire.snapshot {
        Some(snapshot_wire) => match snapshot_wire.into_planner_snapshot() {
            Ok(snapshot) => Some(snapshot),
            Err(err) => {
                return Ok(Some((
                    ZenithPassiveSnapshotEnvelope {
                        status: envelope_wire.status,
                        capture_status: envelope_wire.capture_status,
                        semantic_error: Some(err.to_string()),
                        snapshot: None,
                    },
                    snapshot_age,
                )))
            }
        },
        None => None,
    };
    Ok(Some((
        ZenithPassiveSnapshotEnvelope {
            status: envelope_wire.status,
            capture_status: envelope_wire.capture_status,
            semantic_error: None,
            snapshot,
        },
        snapshot_age,
    )))
}

pub fn read_snapshot_file(path: &Path) -> Result<GameSnapshot> {
    read_snapshot_file_with_age(path).map(|(snapshot, _)| snapshot)
}

pub fn read_snapshot_file_with_age(path: &Path) -> Result<(GameSnapshot, Option<Duration>)> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read snapshot JSON from {}", path.display()))?;
    if raw.trim().is_empty() {
        anyhow::bail!("snapshot JSON file was empty");
    }
    let snapshot_age = read_snapshot_age(path)?;
    let snapshot = parse_snapshot_json(&raw).context("failed to parse snapshot JSON")?;
    Ok((snapshot, snapshot_age))
}

fn is_retryable_snapshot_parse_error(raw: &str, err: &anyhow::Error) -> bool {
    if raw.trim().is_empty() {
        return true;
    }
    err.downcast_ref::<serde_json::Error>()
        .map(|json_err| matches!(json_err.classify(), JsonErrorCategory::Eof))
        .unwrap_or(false)
}

fn is_retryable_snapshot_io_error(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        ErrorKind::NotFound | ErrorKind::PermissionDenied | ErrorKind::WouldBlock
    )
}

fn read_snapshot_age(path: &Path) -> Result<Option<Duration>> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if is_retryable_snapshot_io_error(&err) => {
            return Ok(None);
        }
        Err(err) => {
            return Err(err).with_context(|| {
                format!("failed to read snapshot metadata from {}", path.display())
            })
        }
    };
    Ok(metadata
        .modified()
        .ok()
        .and_then(|timestamp| timestamp.elapsed().ok()))
}

fn snapshot_age_is_stale(age: Duration) -> bool {
    age.as_millis() > u128::from(MAX_SNAPSHOT_AGE_MS)
}

fn log_stale_snapshot_once(
    stale_snapshot_token_logged: &mut Option<String>,
    token: &str,
    age: Duration,
) {
    if stale_snapshot_token_logged.as_deref() == Some(token) {
        return;
    }
    println!(
        "[bot] ignoring stale snapshot token={} age_ms={}",
        token,
        age.as_millis()
    );
    println!("[bot] waiting for fresh snapshot");
    *stale_snapshot_token_logged = Some(token.to_owned());
}

fn queue_transitioned(
    previous_queue: &[PieceToken],
    previous_piece_counter: Option<u32>,
    candidate: &GameSnapshot,
) -> bool {
    if previous_queue != candidate.queue {
        return true;
    }
    if let (Some(previous), Some(current)) = (previous_piece_counter, candidate.piece_counter) {
        return current != previous;
    }
    false
}

fn default_snapshot_source() -> String {
    "file".to_owned()
}

fn default_zenith_passive_source() -> String {
    "zenith_passive".to_owned()
}

fn default_true() -> bool {
    true
}

#[derive(Copy, Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "UPPERCASE")]
pub enum PieceToken {
    I,
    O,
    T,
    L,
    J,
    S,
    Z,
}

impl From<PieceToken> for Piece {
    fn from(value: PieceToken) -> Self {
        match value {
            PieceToken::I => Piece::I,
            PieceToken::O => Piece::O,
            PieceToken::T => Piece::T,
            PieceToken::L => Piece::L,
            PieceToken::J => Piece::J,
            PieceToken::S => Piece::S,
            PieceToken::Z => Piece::Z,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
struct CompatibleSnapshotWire {
    #[serde(default)]
    ok: Option<bool>,
    #[serde(default)]
    ready: Option<bool>,
    #[serde(default = "default_snapshot_source")]
    source: String,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    round_id: Option<String>,
    #[serde(default, alias = "roundId")]
    round_id_alias: Option<String>,
    #[serde(default)]
    board: Option<Vec<Vec<Value>>>,
    #[serde(default)]
    field: Option<Vec<Vec<Value>>>,
    #[serde(default)]
    current: Option<PieceToken>,
    #[serde(default)]
    queue: Vec<PieceToken>,
    #[serde(default)]
    hold: Option<PieceToken>,
    #[serde(default)]
    combo: u32,
    #[serde(default)]
    b2b: bool,
    #[serde(default)]
    incoming: u32,
    #[serde(default)]
    piece_counter: Option<u32>,
    #[serde(default, alias = "pieceCounter")]
    piece_counter_alias: Option<u32>,
    #[serde(default)]
    lines_cleared: Option<u32>,
    #[serde(default, alias = "linesCleared", alias = "lines")]
    lines_cleared_alias: Option<u32>,
    #[serde(default = "default_true")]
    playing: bool,
    #[serde(default)]
    countdown: bool,
    #[serde(default)]
    active: Option<ActivePieceState>,
}

impl CompatibleSnapshotWire {
    fn into_game_snapshot(self) -> Result<Option<GameSnapshot>> {
        if matches!(self.ok, Some(false)) || matches!(self.ready, Some(false)) || !self.playing {
            return Ok(None);
        }

        let field = normalize_compatible_field(self.field.as_deref(), self.board.as_deref())?;

        let mut queue = Vec::with_capacity(self.queue.len() + usize::from(self.current.is_some()));
        if let Some(current) = self.current {
            queue.push(current);
        }
        queue.extend(self.queue);
        if queue.is_empty() {
            anyhow::bail!("compatible snapshot queue was empty");
        }

        Ok(Some(GameSnapshot {
            source: self.source,
            token: self.token.unwrap_or_else(|| {
                default_compatible_token(queue[0], self.piece_counter.or(self.piece_counter_alias))
            }),
            round_id: self.round_id.or(self.round_id_alias),
            field,
            queue,
            hold: self.hold,
            combo: self.combo,
            b2b: self.b2b,
            incoming: self.incoming,
            piece_counter: self.piece_counter.or(self.piece_counter_alias),
            lines_cleared: self.lines_cleared.or(self.lines_cleared_alias),
            playing: self.playing,
            countdown: self.countdown,
            active: self.active,
        }))
    }
}

impl Default for ZenithPassiveEnvelopeWire {
    fn default() -> Self {
        Self {
            status: String::new(),
            capture_status: None,
            snapshot: None,
        }
    }
}

impl Default for ZenithPassiveSnapshotWire {
    fn default() -> Self {
        Self {
            source: default_zenith_passive_source(),
            capture_generation: 0,
            timestamp: 0,
            userid: String::new(),
            gameid: Value::Null,
            candidate_id: String::new(),
            playing: false,
            started: false,
            countdown_started: false,
            paused: None,
            destroyed: false,
            gameoverreason: None,
            board: Vec::new(),
            current: ZenithPassiveCurrentWire::default(),
            hold: None,
            queue: Vec::new(),
            piece_counter: None,
        }
    }
}

impl ZenithPassiveSnapshotWire {
    fn into_planner_snapshot(self) -> Result<ZenithPassivePlannerSnapshot> {
        let userid = self.userid.trim().to_owned();
        if userid.is_empty() {
            anyhow::bail!("missing userid");
        }
        let gameid = normalized_zenith_gameid(&self.gameid).context("missing gameid")?;
        let candidate_id = self.candidate_id.trim().to_owned();
        if candidate_id.is_empty() {
            anyhow::bail!("missing candidate_id");
        }
        let current_piece = parse_zenith_required_piece_token(
            self.current.piece.as_deref(),
            "current piece type",
            "current piece",
        )?;
        let current_x = parse_zenith_integral_coordinate(&self.current.x, "current x coordinate")?;
        let current_y = parse_zenith_vertical_coordinate(&self.current.y, "current y coordinate")?;
        let hold = parse_zenith_optional_piece_token(self.hold.as_deref(), "hold piece")?;
        let queue = parse_zenith_piece_queue(&self.queue)?;
        let current_rotation = self
            .current
            .rotation
            .as_ref()
            .and_then(zenith_rotation_token_from_wire)
            .context("missing or invalid current rotation")?;
        let field = zenith_board_to_field(&self.board)?;
        let board_hash = zenith_board_hash(&field);
        let current_signature = zenith_current_signature(current_piece, hold, &queue, board_hash);
        let token = zenith_passive_token(
            &gameid,
            self.capture_generation,
            &candidate_id,
            self.piece_counter,
            &current_signature,
        );
        let mut planner_queue = Vec::with_capacity(queue.len() + 1);
        planner_queue.push(current_piece);
        planner_queue.extend(queue.iter().copied());
        Ok(ZenithPassivePlannerSnapshot {
            snapshot: GameSnapshot {
                source: if self.source.trim().is_empty() {
                    default_zenith_passive_source()
                } else {
                    self.source
                },
                token,
                round_id: Some(gameid.clone()),
                field,
                queue: planner_queue,
                hold,
                combo: 0,
                b2b: false,
                incoming: 0,
                piece_counter: self.piece_counter,
                lines_cleared: None,
                playing: self.playing,
                countdown: self.countdown_started,
                active: Some(ActivePieceState {
                    x: current_x,
                    y: current_y,
                    rotation: current_rotation,
                }),
            },
            userid,
            gameid,
            candidate_id,
            capture_generation: self.capture_generation,
            timestamp_ms: self.timestamp,
            current_signature,
            playing: self.playing,
            started: self.started,
            countdown_started: self.countdown_started,
            paused: self.paused,
            destroyed: self.destroyed,
            gameoverreason: self.gameoverreason.and_then(|reason| {
                let trimmed = reason.trim().to_owned();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed)
                }
            }),
        })
    }
}

fn parse_zenith_piece_token(value: &str) -> Option<PieceToken> {
    match value.trim() {
        "I" | "i" => Some(PieceToken::I),
        "O" | "o" => Some(PieceToken::O),
        "T" | "t" => Some(PieceToken::T),
        "L" | "l" => Some(PieceToken::L),
        "J" | "j" => Some(PieceToken::J),
        "S" | "s" => Some(PieceToken::S),
        "Z" | "z" => Some(PieceToken::Z),
        _ => None,
    }
}

fn parse_zenith_required_piece_token(
    value: Option<&str>,
    missing_message: &str,
    invalid_field: &str,
) -> Result<PieceToken> {
    let Some(value) = value else {
        anyhow::bail!("missing {missing_message}");
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        anyhow::bail!("missing {missing_message}");
    }
    parse_zenith_piece_token(trimmed)
        .ok_or_else(|| anyhow::anyhow!("invalid {invalid_field} {:?}", trimmed))
}

fn parse_zenith_optional_piece_token(
    value: Option<&str>,
    invalid_field: &str,
) -> Result<Option<PieceToken>> {
    match value {
        None => Ok(None),
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                anyhow::bail!("invalid {invalid_field} {:?}", trimmed);
            }
            parse_zenith_piece_token(trimmed)
                .map(Some)
                .ok_or_else(|| anyhow::anyhow!("invalid {invalid_field} {:?}", trimmed))
        }
    }
}

fn parse_zenith_piece_queue(values: &[String]) -> Result<Vec<PieceToken>> {
    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                anyhow::bail!("invalid queue piece at index {index}: {:?}", trimmed);
            }
            parse_zenith_piece_token(trimmed).ok_or_else(|| {
                anyhow::anyhow!("invalid queue piece at index {index}: {:?}", trimmed)
            })
        })
        .collect()
}

fn deserialize_zenith_coordinate_wire<'de, D>(
    deserializer: D,
) -> std::result::Result<ZenithCoordinateWire, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(match value {
        Some(Value::Null) => ZenithCoordinateWire::Null,
        Some(value) => ZenithCoordinateWire::Value(value),
        None => ZenithCoordinateWire::Null,
    })
}

fn parse_zenith_coordinate_number(value: &ZenithCoordinateWire, field: &str) -> Result<f64> {
    match value {
        ZenithCoordinateWire::Missing => anyhow::bail!("missing {field}"),
        ZenithCoordinateWire::Null => anyhow::bail!("null {field}"),
        ZenithCoordinateWire::Value(Value::Number(number)) => number
            .as_f64()
            .filter(|value| value.is_finite())
            .ok_or_else(|| anyhow::anyhow!("invalid {field} out_of_range {:?}", number)),
        ZenithCoordinateWire::Value(Value::String(_)) => {
            anyhow::bail!("invalid {field} type string")
        }
        ZenithCoordinateWire::Value(Value::Bool(_)) => {
            anyhow::bail!("invalid {field} type boolean")
        }
        ZenithCoordinateWire::Value(Value::Array(_)) => anyhow::bail!("invalid {field} type array"),
        ZenithCoordinateWire::Value(Value::Object(_)) => {
            anyhow::bail!("invalid {field} type object")
        }
        ZenithCoordinateWire::Value(Value::Null) => anyhow::bail!("null {field}"),
    }
}

fn parse_zenith_integral_coordinate(value: &ZenithCoordinateWire, field: &str) -> Result<i32> {
    let coordinate = parse_zenith_coordinate_number(value, field)?;
    if coordinate.fract() != 0.0 {
        anyhow::bail!("invalid {field} non_integer {coordinate}");
    }
    if coordinate < i32::MIN as f64 || coordinate > i32::MAX as f64 {
        anyhow::bail!("invalid {field} out_of_range {coordinate}");
    }
    Ok(coordinate as i32)
}

fn parse_zenith_vertical_coordinate(value: &ZenithCoordinateWire, field: &str) -> Result<i32> {
    let coordinate = parse_zenith_coordinate_number(value, field)?;
    let logical = coordinate.floor();
    if logical < i32::MIN as f64 || logical > i32::MAX as f64 {
        anyhow::bail!("invalid {field} out_of_range {coordinate}");
    }
    Ok(logical as i32)
}

fn normalized_zenith_gameid(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_owned())
            }
        }
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

fn zenith_rotation_token_from_wire(value: &ZenithPassiveRotationWire) -> Option<RotationToken> {
    match value {
        ZenithPassiveRotationWire::Number(number) => match *number {
            0 => Some(RotationToken::North),
            1 => Some(RotationToken::East),
            2 => Some(RotationToken::South),
            3 => Some(RotationToken::West),
            _ => None,
        },
        ZenithPassiveRotationWire::Text(text) => match text.trim().to_ascii_lowercase().as_str() {
            "north" => Some(RotationToken::North),
            "east" => Some(RotationToken::East),
            "south" => Some(RotationToken::South),
            "west" => Some(RotationToken::West),
            _ => None,
        },
    }
}

fn zenith_board_to_field(board: &[Vec<Value>]) -> Result<Vec<[bool; 10]>> {
    if board.len() != 40 {
        anyhow::bail!("expected 40 board rows, got {}", board.len());
    }
    board
        .iter()
        .enumerate()
        .map(|(row_index, row)| {
            if row.len() != 10 {
                anyhow::bail!(
                    "expected board row {row_index} to have 10 columns, got {}",
                    row.len()
                );
            }
            let mut next = [false; 10];
            for (column_index, cell) in row.iter().enumerate() {
                next[column_index] = zenith_board_cell_is_filled(cell);
            }
            Ok(next)
        })
        .collect()
}

fn zenith_board_cell_is_filled(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_i64().map(|value| value != 0).unwrap_or(true),
        Value::String(text) => !text.trim().is_empty() && text.trim() != "0",
        Value::Array(values) => !values.is_empty(),
        Value::Object(values) => !values.is_empty(),
    }
}

fn zenith_board_hash(field: &[[bool; 10]]) -> u64 {
    let mut hash = 1469598103934665603u64;
    for row in field {
        for cell in row {
            hash ^= u64::from(*cell as u8);
            hash = hash.wrapping_mul(1099511628211);
        }
    }
    hash
}

fn zenith_queue_signature(queue: &[PieceToken]) -> String {
    queue
        .iter()
        .map(|piece| format!("{piece:?}"))
        .collect::<Vec<_>>()
        .join("")
}

fn zenith_current_signature(
    current: PieceToken,
    hold: Option<PieceToken>,
    queue: &[PieceToken],
    board_hash: u64,
) -> String {
    format!(
        "{current:?}|{}|{}|{board_hash:016x}",
        hold.map(|piece| format!("{piece:?}"))
            .unwrap_or_else(|| "-".to_owned()),
        zenith_queue_signature(queue)
    )
}

fn zenith_passive_token(
    gameid: &str,
    capture_generation: u64,
    candidate_id: &str,
    piece_counter: Option<u32>,
    current_signature: &str,
) -> String {
    match piece_counter {
        Some(piece_counter) => {
            format!("zenith-{gameid}-{capture_generation}-{piece_counter}-{candidate_id}")
        }
        None => format!("zenith-{gameid}-{capture_generation}-{candidate_id}-{current_signature}"),
    }
}

fn normalize_compatible_field(
    raw_field: Option<&[Vec<Value>]>,
    raw_board: Option<&[Vec<Value>]>,
) -> Result<Vec<[bool; 10]>> {
    if let Some(field) = raw_field {
        return normalize_bottom_up_rows(field);
    }
    if let Some(board) = raw_board {
        return normalize_top_down_board(board);
    }
    anyhow::bail!("compatible snapshot did not contain board or field");
}

fn normalize_bottom_up_rows(rows: &[Vec<Value>]) -> Result<Vec<[bool; 10]>> {
    match rows.len() {
        20 | 40 => {}
        height => anyhow::bail!("unsupported bottom-up field height: {height}"),
    }

    let mut normalized = Vec::with_capacity(40);
    for row in rows.iter().take(40) {
        normalized.push(normalize_row(row)?);
    }
    while normalized.len() < 40 {
        normalized.push([false; 10]);
    }
    Ok(normalized)
}

fn normalize_top_down_board(rows: &[Vec<Value>]) -> Result<Vec<[bool; 10]>> {
    match rows.len() {
        20 | 40 => {}
        height => anyhow::bail!("unsupported top-down board height: {height}"),
    }

    let visible_rows = if rows.len() == 40 { &rows[20..] } else { rows };

    let mut normalized = Vec::with_capacity(40);
    for row in visible_rows.iter().rev() {
        normalized.push(normalize_row(row)?);
    }
    while normalized.len() < 40 {
        normalized.push([false; 10]);
    }
    Ok(normalized)
}

fn normalize_row(row: &[Value]) -> Result<[bool; 10]> {
    if row.len() != 10 {
        anyhow::bail!("snapshot row width was {}, expected 10", row.len());
    }
    let mut normalized = [false; 10];
    for (index, cell) in row.iter().enumerate() {
        normalized[index] = snapshot_cell_filled(cell);
    }
    Ok(normalized)
}

fn snapshot_cell_filled(cell: &Value) -> bool {
    match cell {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_i64().map(|value| value != 0).unwrap_or(true),
        Value::String(text) => {
            let trimmed = text.trim();
            !trimmed.is_empty()
                && trimmed != "."
                && trimmed != "0"
                && !trimmed.eq_ignore_ascii_case("empty")
                && !trimmed.eq_ignore_ascii_case("false")
                && !trimmed.eq_ignore_ascii_case("null")
        }
        Value::Object(map) => {
            if let Some(empty) = map.get("empty").and_then(Value::as_bool) {
                return !empty;
            }
            if let Some(value) = map.get("type") {
                return snapshot_cell_filled(value);
            }
            if let Some(value) = map.get("mino") {
                return snapshot_cell_filled(value);
            }
            true
        }
        Value::Array(values) => values.iter().any(snapshot_cell_filled),
    }
}

fn default_compatible_token(current: PieceToken, piece_counter: Option<u32>) -> String {
    match piece_counter {
        Some(piece_counter) => format!("compatible-{piece_counter}-{current:?}"),
        None => format!("compatible-{current:?}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::env;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn sample_snapshot(token: &str, piece_counter: u32) -> GameSnapshot {
        GameSnapshot {
            source: "browser_cdp".to_owned(),
            token: token.to_owned(),
            round_id: None,
            field: vec![[false; 10]; 40],
            queue: vec![PieceToken::T, PieceToken::I, PieceToken::O],
            hold: None,
            combo: 0,
            b2b: false,
            incoming: 0,
            piece_counter: Some(piece_counter),
            lines_cleared: None,
            playing: true,
            countdown: false,
            active: None,
        }
    }

    fn temp_snapshot_path(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!("automation-{name}-{unique}.json"))
    }

    fn write_snapshot(path: &Path, snapshot: &GameSnapshot) {
        let raw = serde_json::json!({
            "source": snapshot.source,
            "token": snapshot.token,
            "round_id": snapshot.round_id,
            "field": snapshot.field,
            "queue": snapshot.queue,
            "hold": snapshot.hold,
            "combo": snapshot.combo,
            "b2b": snapshot.b2b,
            "incoming": snapshot.incoming,
            "piece_counter": snapshot.piece_counter,
            "lines_cleared": snapshot.lines_cleared,
            "playing": snapshot.playing,
            "countdown": snapshot.countdown,
            "active": snapshot.active,
        });
        fs::write(path, serde_json::to_vec(&raw).unwrap()).unwrap();
    }

    fn write_json(path: &Path, value: &serde_json::Value) {
        fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    }

    fn zenith_empty_board() -> Vec<Vec<serde_json::Value>> {
        vec![vec![serde_json::Value::Bool(false); 10]; 40]
    }

    #[test]
    fn queue_transition_requires_queue_change() {
        let same_snapshot = sample_snapshot("browser-4", 4);
        assert!(!queue_transitioned(
            &[PieceToken::T, PieceToken::I, PieceToken::O],
            Some(4),
            &same_snapshot
        ));
        let changed_queue = GameSnapshot {
            token: "browser-5".to_owned(),
            queue: vec![PieceToken::I, PieceToken::O, PieceToken::L],
            piece_counter: Some(5),
            ..same_snapshot.clone()
        };
        assert!(queue_transitioned(
            &[PieceToken::T, PieceToken::I, PieceToken::O],
            Some(4),
            &changed_queue
        ));
    }

    #[test]
    fn queue_transition_allows_new_game_even_if_queue_repeats() {
        let candidate = sample_snapshot("browser-0", 0);
        assert!(queue_transitioned(
            &[PieceToken::T, PieceToken::I, PieceToken::O],
            Some(12),
            &candidate
        ));
    }

    #[test]
    fn parses_browser_snapshot_wire() {
        let raw = r#"{
          "ok": true,
          "source": "browser_cdp",
          "field": [[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false]],
          "current": "T",
          "hold": "I",
          "queue": ["J","L","O","S","Z"],
          "b2b": false,
          "combo": 0,
          "piece_counter": 123,
          "token": "browser-123"
        }"#;
        let snapshot = parse_snapshot_json(raw).unwrap();
        assert_eq!(snapshot.source, "browser_cdp");
        assert_eq!(snapshot.queue[0], PieceToken::T);
        assert_eq!(snapshot.piece_counter, Some(123));
        assert_eq!(snapshot.lines_cleared, None);
    }

    #[test]
    fn parses_compatible_top_down_board_and_prepends_current_to_queue() {
        let raw = r#"{
          "source": "browser_cdp",
          "ready": true,
          "playing": true,
          "token": "session-1:8",
          "board": [[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,true,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,true,false,false]],
          "current": "L",
          "hold": "I",
          "queue": ["T","S","Z","O","J"],
          "pieceCounter": 8
        }"#;

        let snapshot = parse_snapshot_json(raw).unwrap();
        assert_eq!(snapshot.queue[0], PieceToken::L);
        assert_eq!(snapshot.queue[1], PieceToken::T);
        assert!(snapshot.field[0][7]);
        assert!(snapshot.field[1][2]);
        assert_eq!(snapshot.piece_counter, Some(8));
    }

    #[test]
    fn parses_compatible_bottom_up_20_row_field() {
        let raw = r#"{
          "ready": true,
          "playing": true,
          "field": [[false,false,false,true,false,false,false,false,false,false],[false,false,false,false,true,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false]],
          "queue": ["T","I","O"]
        }"#;

        let snapshot = parse_snapshot_json(raw).unwrap();
        assert_eq!(
            snapshot.queue,
            vec![PieceToken::T, PieceToken::I, PieceToken::O]
        );
        assert!(snapshot.field[0][3]);
        assert!(snapshot.field[1][4]);
        assert_eq!(snapshot.field.len(), 40);
    }

    #[test]
    fn reads_zenith_passive_snapshot_into_planner_contract() {
        let path = temp_snapshot_path("zenith-passive-ready");
        let mut board = zenith_empty_board();
        board[0][0] = json!(true);
        board[39][9] = json!(1);
        write_json(
            &path,
            &json!({
                "status": "ready",
                "capture_status": "running",
                "snapshot": {
                    "source": "zenith_passive",
                    "capture_generation": 3,
                    "timestamp": 1722422400123u64,
                    "userid": "user-77",
                    "gameid": "game-42",
                    "candidate_id": "candidate-1",
                    "playing": true,
                    "started": true,
                    "countdown_started": false,
                    "paused": false,
                    "destroyed": false,
                    "gameoverreason": null,
                    "board": board,
                    "current": {
                        "type": "l",
                        "x": 4,
                        "y": 19,
                        "rotation": "east"
                    },
                    "hold": "j",
                    "queue": ["t", "S", "z"],
                    "piece_counter": 42
                }
            }),
        );

        let (envelope, snapshot_age) = read_zenith_passive_snapshot_file_with_age(&path)
            .unwrap()
            .expect("parsed Zenith passive snapshot");
        let snapshot = envelope.snapshot.expect("planner snapshot");

        assert_eq!(envelope.status, "ready");
        assert_eq!(envelope.capture_status.as_deref(), Some("running"));
        assert!(snapshot_age.is_some());
        assert_eq!(snapshot.userid, "user-77");
        assert_eq!(snapshot.gameid, "game-42");
        assert_eq!(snapshot.capture_generation, 3);
        assert_eq!(snapshot.timestamp_ms, 1722422400123u64);
        assert_eq!(snapshot.snapshot.source, "zenith_passive");
        assert_eq!(snapshot.snapshot.token, "zenith-game-42-3-42-candidate-1");
        assert_eq!(snapshot.snapshot.round_id.as_deref(), Some("game-42"));
        assert_eq!(
            snapshot.snapshot.queue,
            vec![PieceToken::L, PieceToken::T, PieceToken::S, PieceToken::Z]
        );
        assert_eq!(snapshot.snapshot.hold, Some(PieceToken::J));
        assert_eq!(snapshot.snapshot.piece_counter, Some(42));
        assert!(snapshot.snapshot.field[0][0]);
        assert!(snapshot.snapshot.field[39][9]);
        assert_eq!(
            snapshot.snapshot.active,
            Some(ActivePieceState {
                x: 4,
                y: 19,
                rotation: RotationToken::East,
            })
        );
        assert_eq!(snapshot.paused, Some(false));
        assert!(!snapshot.current_signature.is_empty());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn reads_zenith_passive_snapshot_allows_null_paused_without_serde_failure() {
        let path = temp_snapshot_path("zenith-passive-paused-null");
        write_json(
            &path,
            &json!({
                "status": "ready",
                "capture_status": "running",
                "snapshot": {
                    "source": "zenith_passive",
                    "capture_generation": 3,
                    "timestamp": 1722422400123u64,
                    "userid": "user-77",
                    "gameid": "game-42",
                    "candidate_id": "candidate-1",
                    "playing": true,
                    "started": true,
                    "countdown_started": false,
                    "paused": null,
                    "destroyed": false,
                    "gameoverreason": null,
                    "board": zenith_empty_board(),
                    "current": {
                        "type": "L",
                        "x": 4,
                        "y": 19,
                        "rotation": 1
                    },
                    "hold": null,
                    "queue": ["T", "S", "Z"],
                    "piece_counter": 42
                }
            }),
        );

        let (envelope, _) = read_zenith_passive_snapshot_file_with_age(&path)
            .unwrap()
            .expect("parsed Zenith passive snapshot");
        let snapshot = envelope.snapshot.expect("planner snapshot");

        assert_eq!(envelope.status, "ready");
        assert_eq!(snapshot.paused, None);
        assert_eq!(snapshot.snapshot.hold, None);
        assert_eq!(snapshot.snapshot.queue[0], PieceToken::L);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn reads_zenith_passive_snapshot_accepts_fractional_current_y() {
        let path = temp_snapshot_path("zenith-passive-fractional-y");
        write_json(
            &path,
            &json!({
                "status": "ready",
                "capture_status": "running",
                "snapshot": {
                    "source": "zenith_passive",
                    "capture_generation": 3,
                    "timestamp": 1722422400123u64,
                    "userid": "user-77",
                    "gameid": "game-42",
                    "candidate_id": "candidate-1",
                    "playing": true,
                    "started": true,
                    "countdown_started": false,
                    "paused": false,
                    "destroyed": false,
                    "gameoverreason": null,
                    "board": zenith_empty_board(),
                    "current": {
                        "type": "T",
                        "x": 4.0,
                        "y": 18.001516,
                        "rotation": 0
                    },
                    "hold": "I",
                    "queue": ["O", "S", "Z"],
                    "piece_counter": 42
                }
            }),
        );

        let (envelope, _) = read_zenith_passive_snapshot_file_with_age(&path)
            .unwrap()
            .expect("parsed Zenith passive snapshot");
        let snapshot = envelope.snapshot.expect("planner snapshot");

        assert_eq!(
            snapshot.snapshot.active,
            Some(ActivePieceState {
                x: 4,
                y: 18,
                rotation: RotationToken::North,
            })
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn reads_zenith_passive_snapshot_accepts_representative_fractional_y_values() {
        for (raw_y, expected_y) in [(17.96, 17), (18.001516, 18), (37.1, 37), (38.1, 38)] {
            let path = temp_snapshot_path(&format!(
                "zenith-passive-y-{}",
                format!("{raw_y}").replace('.', "_")
            ));
            write_json(
                &path,
                &json!({
                    "status": "ready",
                    "capture_status": "running",
                    "snapshot": {
                        "source": "zenith_passive",
                        "capture_generation": 3,
                        "timestamp": 1722422400123u64,
                        "userid": "user-77",
                        "gameid": "game-42",
                        "candidate_id": "candidate-1",
                        "playing": true,
                        "started": true,
                        "countdown_started": false,
                        "paused": false,
                        "destroyed": false,
                        "gameoverreason": null,
                        "board": zenith_empty_board(),
                        "current": {
                            "type": "T",
                            "x": 4,
                            "y": raw_y,
                            "rotation": 0
                        },
                        "hold": "I",
                        "queue": ["O", "S", "Z"],
                        "piece_counter": 42
                    }
                }),
            );

            let (envelope, _) = read_zenith_passive_snapshot_file_with_age(&path)
                .unwrap()
                .expect("parsed Zenith passive snapshot");
            let snapshot = envelope.snapshot.expect("planner snapshot");

            assert_eq!(
                snapshot.snapshot.active,
                Some(ActivePieceState {
                    x: 4,
                    y: expected_y,
                    rotation: RotationToken::North,
                })
            );

            let _ = fs::remove_file(path);
        }
    }

    #[test]
    fn reads_zenith_passive_snapshot_rejects_string_current_y() {
        let path = temp_snapshot_path("zenith-passive-string-y");
        write_json(
            &path,
            &json!({
                "status": "ready",
                "capture_status": "running",
                "snapshot": {
                    "userid": "user-77",
                    "gameid": "game-42",
                    "candidate_id": "candidate-1",
                    "playing": true,
                    "started": true,
                    "countdown_started": false,
                    "paused": false,
                    "destroyed": false,
                    "board": zenith_empty_board(),
                    "current": {
                        "type": "L",
                        "x": 4,
                        "y": "18.001516",
                        "rotation": 0
                    },
                    "queue": ["T", "S", "Z"]
                }
            }),
        );

        let (envelope, _) = read_zenith_passive_snapshot_file_with_age(&path)
            .unwrap()
            .expect("parsed Zenith passive envelope");

        assert_eq!(
            envelope.semantic_error.as_deref(),
            Some("invalid current y coordinate type string")
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn reads_zenith_passive_snapshot_rejects_null_current_y() {
        let path = temp_snapshot_path("zenith-passive-null-y");
        write_json(
            &path,
            &json!({
                "status": "ready",
                "capture_status": "running",
                "snapshot": {
                    "userid": "user-77",
                    "gameid": "game-42",
                    "candidate_id": "candidate-1",
                    "playing": true,
                    "started": true,
                    "countdown_started": false,
                    "paused": false,
                    "destroyed": false,
                    "board": zenith_empty_board(),
                    "current": {
                        "type": "L",
                        "x": 4,
                        "y": null,
                        "rotation": 0
                    },
                    "queue": ["T", "S", "Z"]
                }
            }),
        );

        let (envelope, _) = read_zenith_passive_snapshot_file_with_age(&path)
            .unwrap()
            .expect("parsed Zenith passive envelope");

        assert_eq!(
            envelope.semantic_error.as_deref(),
            Some("null current y coordinate")
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn reads_zenith_passive_snapshot_rejects_unknown_piece_with_field_context() {
        let path = temp_snapshot_path("zenith-passive-invalid");
        write_json(
            &path,
            &json!({
                "status": "ready",
                "capture_status": "running",
                "snapshot": {
                    "userid": "user-77",
                    "gameid": "game-42",
                    "candidate_id": "candidate-1",
                    "playing": true,
                    "started": true,
                    "countdown_started": false,
                    "paused": false,
                    "destroyed": false,
                    "board": zenith_empty_board(),
                    "current": {
                        "type": "L",
                        "x": 4,
                        "y": 19,
                        "rotation": 0
                    },
                    "queue": ["T", "garbage", "Z"]
                }
            }),
        );

        let (envelope, _) = read_zenith_passive_snapshot_file_with_age(&path)
            .unwrap()
            .expect("parsed Zenith passive envelope");

        assert_eq!(envelope.status, "ready");
        assert!(envelope.snapshot.is_none());
        assert_eq!(
            envelope.semantic_error.as_deref(),
            Some("invalid queue piece at index 1: \"garbage\"")
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn retryable_snapshot_io_errors_include_permission_denied() {
        assert!(is_retryable_snapshot_io_error(&std::io::Error::from(
            ErrorKind::NotFound
        )));
        assert!(is_retryable_snapshot_io_error(&std::io::Error::from(
            ErrorKind::PermissionDenied
        )));
        assert!(is_retryable_snapshot_io_error(&std::io::Error::from(
            ErrorKind::WouldBlock
        )));
        assert!(!is_retryable_snapshot_io_error(&std::io::Error::from(
            ErrorKind::InvalidData
        )));
    }

    #[test]
    fn snapshot_age_threshold_allows_500ms_but_blocks_1001ms() {
        assert!(!snapshot_age_is_stale(Duration::from_millis(500)));
        assert!(!snapshot_age_is_stale(Duration::from_millis(1000)));
        assert!(snapshot_age_is_stale(Duration::from_millis(1001)));
    }

    #[test]
    fn stale_snapshot_is_blocked_until_a_fresh_token_arrives() {
        let path = temp_snapshot_path("stale-snapshot");
        let mut scanner = JsonFileScanner::new(path.clone(), Duration::ZERO);

        write_snapshot(&path, &sample_snapshot("browser-1-1008", 1008));
        std::thread::sleep(Duration::from_millis(MAX_SNAPSHOT_AGE_MS + 50));
        assert!(scanner.next_snapshot().unwrap().is_none());
        assert!(scanner
            .latest_snapshot_age()
            .map(snapshot_age_is_stale)
            .unwrap_or(false));

        write_snapshot(&path, &sample_snapshot("browser-2-0", 0));
        let snapshot = scanner.next_snapshot().unwrap().expect("fresh snapshot");
        assert_eq!(snapshot.token, "browser-2-0");
        assert!(scanner
            .latest_snapshot_age()
            .map(|age| age.as_millis() <= u128::from(MAX_SNAPSHOT_AGE_MS))
            .unwrap_or(false));

        let _ = fs::remove_file(path);
    }
}
