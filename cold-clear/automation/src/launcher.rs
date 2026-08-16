use std::fs;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use eframe::egui;
use serde::{Deserialize, Deserializer, Serialize};

use crate::browser_source::{ChromiumHostProcess, ProviderProcess, SharedLogger};
use crate::config::{
    AutomationConfig, BotConfig, BrowserCdpConfig, BufferModeConfig, EvaluationProfileConfig,
    HandlingConfig, InputBackendConfig, KeyBindings, MovementModeConfig, PlayStyleConfig,
    RouteProfileConfig, ScannerSourceConfig, SnapshotProviderConfig, SoftDropModeConfig,
    SpawnRuleConfig,
};
use crate::driver::{
    execute_plan, BrowserCdpInputBackend, DebugLogBackend, ExecutionTimings, InputBackend,
    SharedBrowserCdpInputBackend,
};
use crate::paths::AppPaths;
use crate::runner::{
    execution_start_pose, prepare_snapshot_execution, ExecutionStartPose,
    PreparedSnapshotExecution, PreparedSnapshotExecutionResult,
};
use crate::runtime::run_automation_with_resources_and_live_pps;
use crate::scanner::{
    read_friendly_vs_passive_snapshot_file_with_age, read_snapshot_file,
    read_zenith_passive_snapshot_file_with_age, FriendlyVsPassivePlannerSnapshot, JsonFileScanner,
    ZenithPassivePlannerSnapshot, MAX_SNAPSHOT_AGE_MS,
};
use crate::vs_sim::{read_vs_bridge_observation, vs_bridge_path_for_snapshot};

const FRIENDLY_VS_DRY_RUN_SKIP_LOG_COOLDOWN: Duration = Duration::from_secs(2);
const FRIENDLY_VS_LIVE_MAX_PLACEMENTS: u32 = 20;

const BOT_UI_VISIBLE_LABELS: &[&str] = &[
    "Play Style",
    "PPS",
    "Unlimited",
    "Status",
    "Bot ON",
    "Bot OFF",
];
const ZENITH_LIVE_MAX_PIECE_OPTIONS: &[u32] = &[1, 5, 20];

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum FriendlyVsLiveLimit {
    Twenty,
    Unlimited,
}

impl Default for FriendlyVsLiveLimit {
    fn default() -> Self {
        Self::Twenty
    }
}

impl FriendlyVsLiveLimit {
    fn normalized(self) -> Self {
        match self {
            Self::Twenty | Self::Unlimited => self,
        }
    }

    fn count_suffix(self) -> &'static str {
        match self {
            Self::Twenty => "20",
            Self::Unlimited => "Unlimited",
        }
    }

    fn bounded_value(self) -> Option<u32> {
        match self {
            Self::Twenty => Some(FRIENDLY_VS_LIVE_MAX_PLACEMENTS),
            Self::Unlimited => None,
        }
    }

    fn is_reached(self, executed_placements: u32) -> bool {
        match self.bounded_value() {
            Some(limit) => executed_placements >= limit,
            None => false,
        }
    }
}

impl Serialize for FriendlyVsLiveLimit {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::Twenty => serializer.serialize_u32(FRIENDLY_VS_LIVE_MAX_PLACEMENTS),
            Self::Unlimited => serializer.serialize_str("unlimited"),
        }
    }
}

impl<'de> Deserialize<'de> for FriendlyVsLiveLimit {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        let parsed = match value {
            serde_json::Value::Number(number) => number
                .as_u64()
                .filter(|value| *value == u64::from(FRIENDLY_VS_LIVE_MAX_PLACEMENTS))
                .map(|_| Self::Twenty)
                .unwrap_or_default(),
            serde_json::Value::String(value)
                if value.eq_ignore_ascii_case("unlimited") =>
            {
                Self::Unlimited
            }
            _ => Self::default(),
        };
        Ok(parsed.normalized())
    }
}

const BOT_UI_HIDDEN_LABELS: &[&str] = &[
    "Dry run",
    "Use hold",
    "Speculate",
    "Allow spin routes",
    "Allow post-softdrop horizontal",
    "Release after each action",
    "Settle",
    "Poll",
    "Move Tap",
    "Rotate Tap",
    "Hold Tap",
    "HardDrop Tap",
    "SoftDrop Tap",
    "Move Delay",
    "Rotate Delay",
    "HardDrop Delay",
    "Piece Delay",
    "Min age",
    "Movement",
    "Spawn",
    "Threads",
    "Min Nodes",
    "Max Nodes",
    "Planner",
];
const ZENITH_PASSIVE_SNAPSHOT_RELATIVE_PATH: &str = "automation/quick-play-passive-snapshot.json";
const FRIENDLY_VS_PASSIVE_SNAPSHOT_RELATIVE_PATH: &str =
    "automation/friendly-vs-passive-snapshot.json";
const ZENITH_LIVE_LOCK_TIMEOUT_MS: u64 = 1_500;

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum ZenithLivePieceLimit {
    Bounded(u32),
    Unlimited,
}

impl Default for ZenithLivePieceLimit {
    fn default() -> Self {
        Self::Bounded(default_zenith_live_max_pieces())
    }
}

impl ZenithLivePieceLimit {
    fn normalized(self) -> Self {
        match self {
            Self::Bounded(value) if ZENITH_LIVE_MAX_PIECE_OPTIONS.contains(&value) => {
                Self::Bounded(value)
            }
            Self::Unlimited => Self::Unlimited,
            Self::Bounded(_) => Self::default(),
        }
    }

    fn log_label(self) -> String {
        match self {
            Self::Bounded(value) => value.to_string(),
            Self::Unlimited => "unlimited".to_owned(),
        }
    }

    fn is_reached(self, executed_pieces: u32) -> bool {
        match self {
            Self::Bounded(value) => executed_pieces >= value,
            Self::Unlimited => false,
        }
    }

    fn bounded_value(self) -> Option<u32> {
        match self {
            Self::Bounded(value) => Some(value),
            Self::Unlimited => None,
        }
    }
}

impl Serialize for ZenithLivePieceLimit {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::Bounded(value) => serializer.serialize_u32(*value),
            Self::Unlimited => serializer.serialize_str("unlimited"),
        }
    }
}

impl<'de> Deserialize<'de> for ZenithLivePieceLimit {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        let parsed = match value {
            serde_json::Value::Number(number) => number
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .map(Self::Bounded)
                .unwrap_or_default(),
            serde_json::Value::String(value) if value.eq_ignore_ascii_case("unlimited") => {
                Self::Unlimited
            }
            _ => Self::default(),
        };
        Ok(parsed.normalized())
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
enum ModePreset {
    VsLeft1080p,
    Solo1080p,
    Custom,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RuntimeMode {
    Solo,
    Zenith,
    FriendlyVs,
}

impl RuntimeMode {
    fn label(self) -> &'static str {
        match self {
            RuntimeMode::Solo => "Solo",
            RuntimeMode::Zenith => "Zenith",
            RuntimeMode::FriendlyVs => "Friendly VS",
        }
    }

    fn control_value(self) -> &'static str {
        match self {
            RuntimeMode::Solo => "solo",
            RuntimeMode::Zenith => "zenith",
            RuntimeMode::FriendlyVs => "friendly_vs",
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum BrowserStatus {
    Closed,
    Starting,
    Ready,
    Error,
}

impl BrowserStatus {
    fn label(self) -> &'static str {
        match self {
            BrowserStatus::Closed => "Closed",
            BrowserStatus::Starting => "Starting",
            BrowserStatus::Ready => "Ready",
            BrowserStatus::Error => "Error",
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum BotStatus {
    Off,
    Starting,
    On,
    Error,
}

impl BotStatus {
    fn label(self) -> &'static str {
        match self {
            BotStatus::Off => "Off",
            BotStatus::Starting => "Starting",
            BotStatus::On => "On",
            BotStatus::Error => "Error",
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum SnapshotStatus {
    Closed,
    Starting,
    WaitingForGame,
    Ready,
    Error,
}

impl SnapshotStatus {
    fn label(self) -> &'static str {
        match self {
            SnapshotStatus::Closed => "Closed",
            SnapshotStatus::Starting => "Starting",
            SnapshotStatus::WaitingForGame => "WaitingForGame",
            SnapshotStatus::Ready => "Ready",
            SnapshotStatus::Error => "Error",
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum InputStatus {
    Closed,
    Starting,
    Ready,
    Error,
}

impl InputStatus {
    fn label(self) -> &'static str {
        match self {
            InputStatus::Closed => "Closed",
            InputStatus::Starting => "Starting",
            InputStatus::Ready => "Ready",
            InputStatus::Error => "Error",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
struct LauncherState {
    preset: ModePreset,
    selected_mode: RuntimeMode,
    bot_enabled: bool,
    mode_generation: u64,
    snapshot_provider: SnapshotProviderConfig,
    scanner_config_path: String,
    snapshot_path: String,
    python_command: String,
    browser: BrowserCdpConfig,
    always_on_top: bool,
    friendly_vs_live_input_enabled: bool,
    friendly_vs_live_limit: FriendlyVsLiveLimit,
    zenith_live_input_enabled: bool,
    zenith_live_max_pieces: ZenithLivePieceLimit,
    dry_run: bool,
    play_style: PlayStyleConfig,
    poll_interval_ms: u64,
    pps_unlimited: bool,
    target_pps: f32,
    tap_duration_ms: u64,
    movement_tap_duration_ms: u64,
    rotate_tap_duration_ms: u64,
    hold_tap_duration_ms: u64,
    hard_drop_tap_duration_ms: u64,
    soft_drop_tap_duration_ms: u64,
    movement_interval_ms: u64,
    rotation_interval_ms: u64,
    piece_interval_ms: u64,
    hard_drop_interval_ms: u64,
    min_snapshot_age_ms: u64,
    input_backend: InputBackendConfig,
    bot: BotConfig,
    handling: HandlingConfig,
    keys: KeyBindings,
}

impl Default for LauncherState {
    fn default() -> Self {
        Self {
            preset: ModePreset::VsLeft1080p,
            selected_mode: RuntimeMode::Solo,
            bot_enabled: false,
            mode_generation: 0,
            snapshot_provider: SnapshotProviderConfig::BrowserCdp,
            scanner_config_path: "automation/scan-config.vs-left-1080p.json".to_owned(),
            snapshot_path: "automation/live-snapshot.json".to_owned(),
            python_command: "python".to_owned(),
            browser: BrowserCdpConfig::default(),
            always_on_top: false,
            friendly_vs_live_input_enabled: false,
            friendly_vs_live_limit: FriendlyVsLiveLimit::default(),
            zenith_live_input_enabled: false,
            zenith_live_max_pieces: ZenithLivePieceLimit::default(),
            dry_run: true,
            play_style: PlayStyleConfig::Normal,
            poll_interval_ms: 4,
            pps_unlimited: true,
            target_pps: 3.0,
            tap_duration_ms: 60,
            movement_tap_duration_ms: 10,
            rotate_tap_duration_ms: 10,
            hold_tap_duration_ms: 10,
            hard_drop_tap_duration_ms: 8,
            soft_drop_tap_duration_ms: 10,
            movement_interval_ms: 0,
            rotation_interval_ms: 0,
            piece_interval_ms: 0,
            hard_drop_interval_ms: 0,
            min_snapshot_age_ms: 0,
            input_backend: InputBackendConfig::BrowserCdp,
            bot: BotConfig::default(),
            handling: HandlingConfig::default(),
            keys: KeyBindings::default(),
        }
    }
}

#[derive(Clone, Debug)]
struct SnapshotInfo {
    token: String,
    age_ms: u128,
    playing: bool,
}

fn window_level(always_on_top: bool) -> egui::viewport::WindowLevel {
    if always_on_top {
        egui::viewport::WindowLevel::AlwaysOnTop
    } else {
        egui::viewport::WindowLevel::Normal
    }
}

pub fn launcher_viewport(paths: &AppPaths) -> egui::ViewportBuilder {
    let always_on_top = load_launcher_state(paths)
        .map(|state| state.always_on_top)
        .unwrap_or(false);
    egui::ViewportBuilder::default().with_window_level(window_level(always_on_top))
}

impl LauncherState {
    fn ensure_scanner_config_path(&mut self) {
        if !self.scanner_config_path.is_empty() {
            return;
        }

        self.scanner_config_path = match self.preset {
            ModePreset::VsLeft1080p => "automation/scan-config.vs-left-1080p.json".to_owned(),
            ModePreset::Solo1080p => "automation/scan-config.solo-1080p.json".to_owned(),
            ModePreset::Custom => return,
        };
    }

    fn apply_tetrio_safe_preset(&mut self) {
        self.pps_unlimited = true;
        self.target_pps = 3.0;
        self.tap_duration_ms = 60;
        self.poll_interval_ms = 8;
        self.movement_tap_duration_ms = 10;
        self.rotate_tap_duration_ms = 10;
        self.hold_tap_duration_ms = 10;
        self.hard_drop_tap_duration_ms = 8;
        self.soft_drop_tap_duration_ms = 10;
        self.movement_interval_ms = 0;
        self.rotation_interval_ms = 0;
        self.piece_interval_ms = 0;
        self.hard_drop_interval_ms = 0;
        self.min_snapshot_age_ms = 0;
        self.snapshot_provider = SnapshotProviderConfig::BrowserCdp;
        self.input_backend = InputBackendConfig::BrowserCdp;
        self.browser = BrowserCdpConfig::default();
        self.bot.threads = BotConfig::default().threads;
        self.bot.min_nodes = BotConfig::default().min_nodes;
        self.bot.max_nodes = BotConfig::default().max_nodes;
        self.bot.speculate = false;
        self.bot.movement_mode = MovementModeConfig::ZeroGSafe;
        self.bot.spawn_rule = SpawnRuleConfig::Row19Or20;
        self.handling.soft_drop_mode = SoftDropModeConfig::Infinite;
        self.handling.allow_post_softdrop_actions = true;
        self.handling.allow_post_softdrop_horizontal = false;
        self.handling.release_after_each_action = false;
        self.handling.action_settle_ms = 0;
        self.handling.prevent_accidental_hard_drops = true;
        self.handling.cancel_das_on_direction_change = true;
        self.handling.prefer_soft_drop_over_movement = false;
        self.handling.irs_mode = BufferModeConfig::Off;
        self.handling.ihs_mode = BufferModeConfig::Off;
        self.normalize_pps_state();
    }

    fn apply_preset(&mut self) {
        self.scanner_config_path = match self.preset {
            ModePreset::VsLeft1080p => "automation/scan-config.vs-left-1080p.json",
            ModePreset::Solo1080p => "automation/scan-config.solo-1080p.json",
            ModePreset::Custom => return,
        }
        .to_owned();
        self.snapshot_path = "automation/live-snapshot.json".to_owned();
        self.apply_tetrio_safe_preset();
    }

    fn migrate_legacy_defaults(&mut self) {
        if self.preset != ModePreset::Custom
            && matches!(
                self.bot.movement_mode,
                MovementModeConfig::TwentyG | MovementModeConfig::ZeroGComplete
            )
            && self.tap_duration_ms <= 8
        {
            self.apply_tetrio_safe_preset();
        }
        if self.preset != ModePreset::Custom
            && self.bot.movement_mode == MovementModeConfig::HardDropOnly
        {
            self.bot.movement_mode = MovementModeConfig::ZeroGSafe;
        }
        if self.preset != ModePreset::Custom && self.matches_known_legacy_safe_preset() {
            self.apply_tetrio_safe_preset();
        }
        self.normalize_pps_state();
    }

    fn matches_known_legacy_safe_preset(&self) -> bool {
        self.effective_target_pps() == 0.0
            && (self.matches_first_safe_preset_family()
                || self.matches_second_safe_preset_family()
                || self.matches_third_safe_preset_family())
    }

    fn matches_first_safe_preset_family(&self) -> bool {
        self.poll_interval_ms == 16
            && self.movement_tap_duration_ms == 55
            && self.rotate_tap_duration_ms == 70
            && self.hold_tap_duration_ms == 70
            && self.hard_drop_tap_duration_ms == 80
            && self.soft_drop_tap_duration_ms == 55
            && self.movement_interval_ms == 60
            && self.rotation_interval_ms == 120
            && self.piece_interval_ms == 100
            && self.hard_drop_interval_ms == 100
            && self.min_snapshot_age_ms == 40
            && self.handling.action_settle_ms == 25
    }

    fn matches_second_safe_preset_family(&self) -> bool {
        self.poll_interval_ms == 16
            && self.movement_tap_duration_ms == 40
            && self.rotate_tap_duration_ms == 45
            && self.hold_tap_duration_ms == 55
            && self.hard_drop_tap_duration_ms == 55
            && self.soft_drop_tap_duration_ms == 40
            && self.movement_interval_ms == 18
            && self.rotation_interval_ms == 45
            && self.piece_interval_ms == 20
            && self.hard_drop_interval_ms == 35
            && self.min_snapshot_age_ms == 8
            && self.handling.action_settle_ms == 8
    }

    fn matches_third_safe_preset_family(&self) -> bool {
        self.poll_interval_ms == 4
            && self.movement_tap_duration_ms == 25
            && self.rotate_tap_duration_ms == 28
            && self.hold_tap_duration_ms == 35
            && self.hard_drop_tap_duration_ms == 30
            && self.soft_drop_tap_duration_ms == 25
            && self.movement_interval_ms == 0
            && self.rotation_interval_ms == 8
            && self.piece_interval_ms == 0
            && self.hard_drop_interval_ms == 0
            && self.min_snapshot_age_ms == 0
            && self.handling.action_settle_ms == 0
            && self.handling.release_after_each_action
    }

    fn to_automation_config(&self, paths: &AppPaths) -> AutomationConfig {
        let mut config = AutomationConfig {
            snapshot_provider: SnapshotProviderConfig::BrowserCdp,
            snapshot_path: paths.resolve_workspace_path(&self.snapshot_path),
            dry_run: self.dry_run,
            poll_interval_ms: self.poll_interval_ms,
            target_pps: self.effective_target_pps(),
            play_style: self.play_style,
            evaluation_profile: EvaluationProfileConfig::Normal,
            route_profile: RouteProfileConfig::Normal,
            tap_duration_ms: self.tap_duration_ms,
            movement_tap_duration_ms: self.movement_tap_duration_ms,
            rotate_tap_duration_ms: self.rotate_tap_duration_ms,
            hold_tap_duration_ms: self.hold_tap_duration_ms,
            hard_drop_tap_duration_ms: self.hard_drop_tap_duration_ms,
            soft_drop_tap_duration_ms: self.soft_drop_tap_duration_ms,
            movement_interval_ms: self.movement_interval_ms,
            rotation_interval_ms: self.rotation_interval_ms,
            piece_interval_ms: self.piece_interval_ms,
            hard_drop_interval_ms: self.hard_drop_interval_ms,
            min_snapshot_age_ms: self.min_snapshot_age_ms,
            input_backend: InputBackendConfig::BrowserCdp,
            scanner: ScannerSourceConfig {
                config_path: self.scanner_config_path.clone(),
                python_command: self.python_command.clone(),
            },
            browser: self.browser.clone(),
            bot: self.bot.clone(),
            handling: self.handling.clone(),
            keys: self.keys.clone(),
        };
        if self.play_style == PlayStyleConfig::Speed {
            config.evaluation_profile = EvaluationProfileConfig::Speed;
            config.route_profile = RouteProfileConfig::Speed;
        }
        config
    }

    fn to_bot_automation_config(&self, paths: &AppPaths) -> AutomationConfig {
        let mut config = self.to_automation_config(paths);
        config.browser.connect_only = true;
        config
    }

    fn normalize_pps_state(&mut self) {
        self.friendly_vs_live_limit = self.friendly_vs_live_limit.normalized();
        self.target_pps = normalize_target_pps_value(self.target_pps);
        self.zenith_live_max_pieces = self.zenith_live_max_pieces.normalized();
    }

    fn effective_target_pps(&self) -> f32 {
        if self.pps_unlimited {
            0.0
        } else {
            self.target_pps
        }
    }

    fn effective_zenith_live_max_pieces(&self) -> ZenithLivePieceLimit {
        self.zenith_live_max_pieces.normalized()
    }

    fn effective_friendly_vs_live_limit(&self) -> FriendlyVsLiveLimit {
        self.friendly_vs_live_limit.normalized()
    }
}

fn default_zenith_live_max_pieces() -> u32 {
    1
}

fn normalize_target_pps_value(target_pps: f32) -> f32 {
    if !target_pps.is_finite() || target_pps < 0.25 {
        3.0
    } else {
        target_pps.clamp(0.25, 20.0)
    }
}

fn pacing_interval_for_target_pps(target_pps: f32) -> Option<Duration> {
    if !target_pps.is_finite() || target_pps <= 0.0 {
        return None;
    }
    Some(Duration::from_secs_f64(1.0 / f64::from(target_pps)))
}

enum LauncherEvent {
    BrowserLog(String),
    BrowserExited(Result<(), String>),
    BotLog(String),
    BotExited(Result<(), String>),
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum BotStartMode {
    UserInitiated,
    AutoResume,
}

struct BrowserSession {
    host: ChromiumHostProcess,
    snapshot_provider: ProviderProcess,
    input_backend: SharedBrowserCdpInputBackend,
    provider_started_at: Instant,
    last_used_token: Arc<Mutex<Option<String>>>,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum PassiveProviderOwner {
    ManualDiagnostic,
    ZenithDryRun,
}

impl PassiveProviderOwner {
    fn control_value(self) -> &'static str {
        match self {
            PassiveProviderOwner::ManualDiagnostic => "manual_diagnostic",
            PassiveProviderOwner::ZenithDryRun => "zenith_dry_run",
        }
    }

    fn log_prefix(self) -> &'static str {
        match self {
            PassiveProviderOwner::ManualDiagnostic => "[quick-play]",
            PassiveProviderOwner::ZenithDryRun => "[zenith-dry-run]",
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum PassiveProviderLifecycle {
    Activated,
    OwnerAdded,
    OwnerReleased,
    Deactivated,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
struct PassiveProviderTransition {
    owner: PassiveProviderOwner,
    lifecycle: PassiveProviderLifecycle,
    activation_generation: u64,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct PassiveProviderController {
    manual_diagnostic_requested: bool,
    zenith_dry_run_requested: bool,
    activation_generation: u64,
}

impl PassiveProviderController {
    fn reset(&mut self) {
        *self = Self::default();
    }

    fn has_any(&self) -> bool {
        self.manual_diagnostic_requested || self.zenith_dry_run_requested
    }

    fn is_requested(&self, owner: PassiveProviderOwner) -> bool {
        match owner {
            PassiveProviderOwner::ManualDiagnostic => self.manual_diagnostic_requested,
            PassiveProviderOwner::ZenithDryRun => self.zenith_dry_run_requested,
        }
    }

    fn owners_label(&self) -> &'static str {
        match (
            self.manual_diagnostic_requested,
            self.zenith_dry_run_requested,
        ) {
            (false, false) => "none",
            (true, false) => "manual_diagnostic",
            (false, true) => "zenith_dry_run",
            (true, true) => "manual_diagnostic+zenith_dry_run",
        }
    }

    fn request(&mut self, owner: PassiveProviderOwner) -> Option<PassiveProviderTransition> {
        if self.is_requested(owner) {
            return None;
        }
        let was_any = self.has_any();
        self.set_requested(owner, true);
        let lifecycle = if was_any {
            PassiveProviderLifecycle::OwnerAdded
        } else {
            self.activation_generation = self.activation_generation.saturating_add(1);
            PassiveProviderLifecycle::Activated
        };
        Some(PassiveProviderTransition {
            owner,
            lifecycle,
            activation_generation: self.activation_generation,
        })
    }

    fn release(&mut self, owner: PassiveProviderOwner) -> Option<PassiveProviderTransition> {
        if !self.is_requested(owner) {
            return None;
        }
        self.set_requested(owner, false);
        let lifecycle = if self.has_any() {
            PassiveProviderLifecycle::OwnerReleased
        } else {
            PassiveProviderLifecycle::Deactivated
        };
        Some(PassiveProviderTransition {
            owner,
            lifecycle,
            activation_generation: self.activation_generation,
        })
    }

    fn set_requested(&mut self, owner: PassiveProviderOwner, requested: bool) {
        match owner {
            PassiveProviderOwner::ManualDiagnostic => {
                self.manual_diagnostic_requested = requested;
            }
            PassiveProviderOwner::ZenithDryRun => {
                self.zenith_dry_run_requested = requested;
            }
        }
    }
}

struct BotSession {
    stop: Arc<AtomicBool>,
    live_target_pps: Arc<AtomicU32>,
    automation_thread: Option<JoinHandle<()>>,
}

impl BotSession {
    fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.automation_thread.take() {
            let _ = thread.join();
        }
    }
}

#[derive(Clone, Debug, Default)]
struct FriendlyVsObserver {
    armed: bool,
    awaiting_first_fresh_bridge: bool,
    armed_at_ms: Option<u64>,
    baseline_sequence: Option<u64>,
    baseline_captured_at_ms: Option<u64>,
    baseline_signature: Option<String>,
    last_fresh_sequence: Option<u64>,
    last_fresh_captured_at_ms: Option<u64>,
    last_fresh_signature: Option<String>,
    last_waiting_reason: Option<String>,
    last_bridge_error: Option<String>,
    last_round_id: Option<String>,
    last_identity_signature: Option<String>,
    last_options_signature: Option<String>,
    last_active_signature: Option<String>,
    active_round_id: Option<String>,
    resolved_userid: Option<String>,
    resolved_game_id: Option<String>,
}

impl FriendlyVsObserver {
    fn reset(&mut self) {
        *self = Self::default();
    }

    fn note_armed(
        &mut self,
        armed_at_ms: u64,
        baseline: Option<&crate::vs_sim::VsBridgeObservation>,
    ) -> Option<String> {
        if self.armed {
            return None;
        }
        self.armed = true;
        self.awaiting_first_fresh_bridge = true;
        self.armed_at_ms = Some(armed_at_ms);
        self.baseline_sequence = baseline.map(|value| value.sequence);
        self.baseline_captured_at_ms = baseline.map(|value| value.captured_at_ms);
        self.baseline_signature = baseline.map(Self::observation_signature);
        self.last_fresh_sequence = None;
        self.last_fresh_captured_at_ms = None;
        self.last_fresh_signature = None;
        Some("[friendly-vs] observer armed".to_owned())
    }

    fn note_stopped(&mut self) -> Option<String> {
        if !self.armed {
            self.reset();
            return None;
        }
        self.reset();
        Some("[friendly-vs] observer stopped".to_owned())
    }

    fn note_waiting(&mut self, reason: &str) -> Option<String> {
        self.clear_ready_state();
        if self.last_waiting_reason.as_deref() == Some(reason) {
            return None;
        }
        self.last_waiting_reason = Some(reason.to_owned());
        Some(format!("[friendly-vs] waiting reason={reason}"))
    }

    fn note_bridge_error(&mut self, error: &str) -> Option<String> {
        if self.last_bridge_error.as_deref() == Some(error) {
            return None;
        }
        self.last_bridge_error = Some(error.to_owned());
        Some(format!(
            "[friendly-vs] waiting reason=bridge_unavailable error={error}"
        ))
    }

    fn observe_round(&mut self, round_id: &str) -> Option<String> {
        if self.last_round_id.as_deref() == Some(round_id) {
            return None;
        }
        let ended = self
            .active_round_id
            .take()
            .filter(|previous| previous != round_id)
            .map(|previous| format!("[friendly-vs] round ended round_id={previous}"));
        self.last_round_id = Some(round_id.to_owned());
        self.clear_ready_state();
        self.last_identity_signature = None;
        self.last_options_signature = None;
        self.last_active_signature = None;
        self.last_bridge_error = None;
        ended
    }

    fn observe_fresh_bridge(&mut self, observation: &crate::vs_sim::VsBridgeObservation) {
        self.awaiting_first_fresh_bridge = false;
        self.last_fresh_sequence = Some(observation.sequence);
        self.last_fresh_captured_at_ms = Some(observation.captured_at_ms);
        self.last_fresh_signature = Some(Self::observation_signature(observation));
        self.last_bridge_error = None;
    }

    fn is_fresh_bridge(&self, observation: &crate::vs_sim::VsBridgeObservation) -> bool {
        if !self.awaiting_first_fresh_bridge {
            return true;
        }
        let observation_signature = Self::observation_signature(observation);
        let reference_signature = self
            .last_fresh_signature
            .as_deref()
            .or(self.baseline_signature.as_deref());
        if reference_signature == Some(observation_signature.as_str()) {
            return false;
        }

        let armed_at_ms = self.armed_at_ms.unwrap_or(0);
        let reference_sequence = self.last_fresh_sequence.or(self.baseline_sequence);
        let reference_captured_at_ms = self
            .last_fresh_captured_at_ms
            .or(self.baseline_captured_at_ms)
            .unwrap_or(0);
        let sequence_advanced = reference_sequence
            .map(|value| observation.sequence > value)
            .unwrap_or(false);
        if sequence_advanced {
            return observation.captured_at_ms >= armed_at_ms.max(reference_captured_at_ms);
        }
        observation.captured_at_ms > reference_captured_at_ms
            && observation.captured_at_ms >= armed_at_ms
    }

    fn clear_ready_state(&mut self) {
        self.last_identity_signature = None;
        self.last_options_signature = None;
        self.last_active_signature = None;
        self.active_round_id = None;
        self.resolved_userid = None;
        self.resolved_game_id = None;
    }

    fn observation_signature(observation: &crate::vs_sim::VsBridgeObservation) -> String {
        format!(
            "{}|{}|{}|{}|{}|{}|{}|{}",
            observation.sequence,
            observation.captured_at_ms,
            observation.round_id,
            observation.local_userid.as_deref().unwrap_or(""),
            observation.local_username.as_deref().unwrap_or(""),
            observation.local_game_id,
            observation.seed,
            observation.opponent_count
        )
    }

    fn note_identity_ready(
        &mut self,
        userid: &str,
        gameid: &str,
        round_id: &str,
    ) -> Option<String> {
        let signature = format!("{userid}|{gameid}|{round_id}");
        if self.last_identity_signature.as_deref() == Some(signature.as_str()) {
            return None;
        }
        self.last_identity_signature = Some(signature);
        self.resolved_userid = Some(userid.to_owned());
        self.resolved_game_id = Some(gameid.to_owned());
        self.last_waiting_reason = None;
        Some(format!(
            "[friendly-vs] identity ready userid={userid} gameid={gameid} round_id={round_id}"
        ))
    }

    fn note_options_ready(
        &mut self,
        seed: &str,
        bagtype: &str,
        nextcount: usize,
    ) -> Option<String> {
        let signature = format!("{seed}|{bagtype}|{nextcount}");
        if self.last_options_signature.as_deref() == Some(signature.as_str()) {
            return None;
        }
        self.last_options_signature = Some(signature);
        Some(format!(
            "[friendly-vs] options ready seed={seed} bagtype={bagtype} nextcount={nextcount}"
        ))
    }

    fn note_round_active(
        &mut self,
        round_id: &str,
        opponents: usize,
        incoming_garbage: usize,
    ) -> Option<String> {
        let signature = format!("{round_id}|{opponents}|{incoming_garbage}");
        if self.last_active_signature.as_deref() == Some(signature.as_str()) {
            return None;
        }
        self.last_active_signature = Some(signature);
        self.active_round_id = Some(round_id.to_owned());
        Some(format!(
            "[friendly-vs] round active opponents={opponents} incoming_garbage={incoming_garbage}"
        ))
    }

    fn note_round_ended(&mut self, round_id: &str) -> Option<String> {
        if self.active_round_id.as_deref() != Some(round_id) {
            return None;
        }
        self.clear_ready_state();
        Some(format!("[friendly-vs] round ended round_id={round_id}"))
    }
}

#[derive(Clone, Debug, Default)]
struct FriendlyVsDryRunController {
    last_round_id: Option<String>,
    last_game_id: Option<String>,
    last_capture_generation: Option<u64>,
    last_candidate_id: Option<String>,
    last_attempted_file_signature: Option<String>,
    last_processed_snapshot_token: Option<String>,
    last_piece_counter: Option<u32>,
    last_current_signature: Option<String>,
    active: bool,
    last_skip_key: Option<String>,
    last_skip_logged_at: Option<Instant>,
}

impl FriendlyVsDryRunController {
    fn reset(&mut self) {
        *self = Self::default();
    }

    fn reset_processed_state(&mut self) {
        self.last_round_id = None;
        self.last_game_id = None;
        self.last_capture_generation = None;
        self.last_candidate_id = None;
        self.last_attempted_file_signature = None;
        self.last_processed_snapshot_token = None;
        self.last_piece_counter = None;
        self.last_current_signature = None;
        self.active = false;
    }

    fn clear_skip_reason(&mut self) {
        self.last_skip_key = None;
        self.last_skip_logged_at = None;
    }

    fn record_attempted(
        &mut self,
        snapshot: &FriendlyVsPassivePlannerSnapshot,
        file_signature: &str,
    ) {
        self.last_round_id = Some(snapshot.round_id.clone());
        self.last_game_id = Some(snapshot.gameid.clone());
        self.last_capture_generation = Some(snapshot.capture_generation);
        self.last_candidate_id = Some(snapshot.candidate_id.clone());
        self.last_attempted_file_signature = Some(file_signature.to_owned());
        self.last_piece_counter = snapshot.snapshot.piece_counter;
        self.last_current_signature = Some(snapshot.current_signature.clone());
        self.active = true;
        self.clear_skip_reason();
    }

    fn record_processed(
        &mut self,
        snapshot: &FriendlyVsPassivePlannerSnapshot,
        file_signature: &str,
    ) {
        self.record_attempted(snapshot, file_signature);
        self.last_processed_snapshot_token = Some(snapshot.snapshot.token.clone());
    }

    fn mark_processed_snapshot(&mut self, snapshot: &FriendlyVsPassivePlannerSnapshot) {
        self.last_round_id = Some(snapshot.round_id.clone());
        self.last_game_id = Some(snapshot.gameid.clone());
        self.last_capture_generation = Some(snapshot.capture_generation);
        self.last_candidate_id = Some(snapshot.candidate_id.clone());
        self.last_piece_counter = snapshot.snapshot.piece_counter;
        self.last_current_signature = Some(snapshot.current_signature.clone());
        self.last_processed_snapshot_token = Some(snapshot.snapshot.token.clone());
        self.active = true;
        self.clear_skip_reason();
    }

    fn is_duplicate_attempt(&self, file_signature: &str) -> bool {
        self.last_attempted_file_signature.as_deref() == Some(file_signature)
    }

    fn is_duplicate_processed_piece(&self, snapshot: &FriendlyVsPassivePlannerSnapshot) -> bool {
        self.last_processed_snapshot_token.as_deref() == Some(snapshot.snapshot.token.as_str())
    }

    fn note_skip(&mut self, key: &str, line: String) -> Option<String> {
        let now = Instant::now();
        if self.last_skip_key.as_deref() == Some(key) {
            if let Some(last_logged_at) = self.last_skip_logged_at {
                if now.duration_since(last_logged_at) < FRIENDLY_VS_DRY_RUN_SKIP_LOG_COOLDOWN {
                    return None;
                }
            }
        }
        self.last_skip_key = Some(key.to_owned());
        self.last_skip_logged_at = Some(now);
        Some(line)
    }

}

#[derive(Clone, Debug, Default)]
struct FriendlyVsLiveController {
    session_round_id: Option<String>,
    session_game_id: Option<String>,
    session_capture_generation: Option<u64>,
    session_pps_unlimited: bool,
    session_target_pps: f32,
    executed_placements: u32,
    limit_logged: bool,
    last_execution_started_at: Option<Instant>,
    next_execution_earliest_at: Option<Instant>,
    last_execution_round_id: Option<String>,
    last_execution_game_id: Option<String>,
    deferred_snapshot_token: Option<String>,
    deferred_plan: Option<FriendlyVsDeferredPlan>,
    last_skip_key: Option<String>,
}

#[derive(Clone, Debug)]
struct FriendlyVsDeferredPlan {
    snapshot_token: String,
    round_id: String,
    gameid: String,
    capture_generation: u64,
    candidate_id: String,
    piece_counter: Option<u32>,
    current_signature: String,
    prepared: PreparedSnapshotExecution,
}

impl FriendlyVsLiveController {
    fn reset(&mut self) {
        *self = Self::default();
    }

    fn set_session_pacing(&mut self, pps_unlimited: bool, target_pps: f32) {
        self.session_pps_unlimited = pps_unlimited;
        self.session_target_pps = normalize_target_pps_value(target_pps);
        self.clear_pacing_state();
    }

    fn session_target_pps(&self) -> f32 {
        normalize_target_pps_value(self.session_target_pps)
    }

    fn session_target_pps_interval(&self) -> Option<Duration> {
        if self.session_pps_unlimited {
            None
        } else {
            pacing_interval_for_target_pps(self.session_target_pps())
        }
    }

    fn clear_pacing_state(&mut self) {
        self.last_execution_started_at = None;
        self.next_execution_earliest_at = None;
        self.last_execution_round_id = None;
        self.last_execution_game_id = None;
        self.deferred_snapshot_token = None;
        self.deferred_plan = None;
    }

    fn sync_session(&mut self, round_id: &str, gameid: &str, capture_generation: u64) {
        if self.session_round_id.as_deref() == Some(round_id)
            && self.session_game_id.as_deref() == Some(gameid)
            && self.session_capture_generation == Some(capture_generation)
        {
            return;
        }
        self.session_round_id = Some(round_id.to_owned());
        self.session_game_id = Some(gameid.to_owned());
        self.session_capture_generation = Some(capture_generation);
        self.executed_placements = 0;
        self.limit_logged = false;
        self.last_skip_key = None;
        self.clear_pacing_state();
    }

    fn limit_reached(&self, limit: FriendlyVsLiveLimit) -> bool {
        limit.is_reached(self.executed_placements)
    }

    fn clear_skip_reason(&mut self) {
        self.last_skip_key = None;
    }

    fn note_skip(&mut self, key: &str, line: String) -> Option<String> {
        if self.last_skip_key.as_deref() == Some(key) {
            return None;
        }
        self.last_skip_key = Some(key.to_owned());
        Some(line)
    }

    fn record_execution(&mut self) {
        self.executed_placements = self.executed_placements.saturating_add(1);
        self.clear_skip_reason();
    }

    fn note_execution_started_for_pacing(
        &mut self,
        snapshot: &FriendlyVsPassivePlannerSnapshot,
        now: Instant,
    ) {
        self.last_execution_started_at = Some(now);
        self.last_execution_round_id = Some(snapshot.round_id.clone());
        self.last_execution_game_id = Some(snapshot.gameid.clone());
        self.next_execution_earliest_at = self
            .session_target_pps_interval()
            .map(|interval| now + interval);
        self.deferred_snapshot_token = None;
        self.deferred_plan = None;
    }

    fn pacing_remaining_for_snapshot(
        &mut self,
        snapshot: &FriendlyVsPassivePlannerSnapshot,
        now: Instant,
    ) -> Option<Duration> {
        if self
            .last_execution_round_id
            .as_deref()
            .is_some_and(|round_id| round_id != snapshot.round_id.as_str())
        {
            self.clear_pacing_state();
            return None;
        }
        if self
            .last_execution_game_id
            .as_deref()
            .is_some_and(|game_id| game_id != snapshot.gameid.as_str())
        {
            self.clear_pacing_state();
            return None;
        }
        let earliest = self.next_execution_earliest_at?;
        let remaining = earliest.saturating_duration_since(now);
        if remaining.is_zero() {
            None
        } else {
            Some(remaining)
        }
    }

    fn set_deferred_plan(
        &mut self,
        snapshot: &FriendlyVsPassivePlannerSnapshot,
        prepared: PreparedSnapshotExecution,
    ) {
        self.deferred_snapshot_token = Some(snapshot.snapshot.token.clone());
        self.deferred_plan = Some(FriendlyVsDeferredPlan {
            snapshot_token: snapshot.snapshot.token.clone(),
            round_id: snapshot.round_id.clone(),
            gameid: snapshot.gameid.clone(),
            capture_generation: snapshot.capture_generation,
            candidate_id: snapshot.candidate_id.clone(),
            piece_counter: snapshot.snapshot.piece_counter,
            current_signature: snapshot.current_signature.clone(),
            prepared,
        });
    }

    fn clear_deferred_plan(&mut self) {
        self.deferred_snapshot_token = None;
        self.deferred_plan = None;
    }

    fn is_deferred_snapshot(&self, snapshot: &FriendlyVsPassivePlannerSnapshot) -> bool {
        self.deferred_snapshot_token.as_deref() == Some(snapshot.snapshot.token.as_str())
    }

    fn deferred_plan_for_snapshot(
        &self,
        snapshot: &FriendlyVsPassivePlannerSnapshot,
    ) -> Option<&FriendlyVsDeferredPlan> {
        let deferred = self.deferred_plan.as_ref()?;
        (deferred.snapshot_token == snapshot.snapshot.token
            || (deferred.round_id == snapshot.round_id
                && deferred.gameid == snapshot.gameid
                && deferred.capture_generation == snapshot.capture_generation
                && deferred.candidate_id == snapshot.candidate_id
                && deferred.piece_counter == snapshot.snapshot.piece_counter
                && deferred.current_signature == snapshot.current_signature))
        .then_some(deferred)
    }

    fn note_limit_locked(&mut self, limit: FriendlyVsLiveLimit) -> Option<String> {
        if !self.limit_reached(limit) || self.limit_logged {
            return None;
        }
        self.limit_logged = true;
        Some("[friendly-vs-live] input locked reason=placement_limit".to_owned())
    }

    fn count_label(&self, limit: FriendlyVsLiveLimit) -> String {
        format!("{}/{}", self.executed_placements, limit.count_suffix())
    }
}

#[derive(Clone, Debug, Default)]
struct ZenithDryRunController {
    last_game_id: Option<String>,
    last_capture_generation: Option<u64>,
    last_candidate_id: Option<String>,
    last_attempted_file_signature: Option<String>,
    last_processed_snapshot_token: Option<String>,
    last_piece_counter: Option<u32>,
    last_current_signature: Option<String>,
    last_planned_at: Option<Instant>,
    active: bool,
    last_skip_key: Option<String>,
}

impl ZenithDryRunController {
    fn reset(&mut self) {
        *self = Self::default();
    }

    fn reset_processed_state(&mut self) {
        self.last_game_id = None;
        self.last_capture_generation = None;
        self.last_candidate_id = None;
        self.last_attempted_file_signature = None;
        self.last_processed_snapshot_token = None;
        self.last_piece_counter = None;
        self.last_current_signature = None;
        self.last_planned_at = None;
        self.active = false;
    }

    fn clear_skip_reason(&mut self) {
        self.last_skip_key = None;
    }

    fn record_attempted(&mut self, snapshot: &ZenithPassivePlannerSnapshot, file_signature: &str) {
        self.last_game_id = Some(snapshot.gameid.clone());
        self.last_capture_generation = Some(snapshot.capture_generation);
        self.last_candidate_id = Some(snapshot.candidate_id.clone());
        self.last_attempted_file_signature = Some(file_signature.to_owned());
        self.last_piece_counter = snapshot.snapshot.piece_counter;
        self.last_current_signature = Some(snapshot.current_signature.clone());
        self.active = true;
        self.clear_skip_reason();
    }

    #[cfg_attr(not(test), allow(dead_code))]
    fn record_processed(&mut self, snapshot: &ZenithPassivePlannerSnapshot, file_signature: &str) {
        self.record_attempted(snapshot, file_signature);
        self.last_processed_snapshot_token = Some(snapshot.snapshot.token.clone());
        self.last_planned_at = Some(Instant::now());
    }

    fn mark_processed_snapshot(&mut self, snapshot: &ZenithPassivePlannerSnapshot) {
        self.last_game_id = Some(snapshot.gameid.clone());
        self.last_capture_generation = Some(snapshot.capture_generation);
        self.last_candidate_id = Some(snapshot.candidate_id.clone());
        self.last_piece_counter = snapshot.snapshot.piece_counter;
        self.last_current_signature = Some(snapshot.current_signature.clone());
        self.last_processed_snapshot_token = Some(snapshot.snapshot.token.clone());
        self.last_planned_at = Some(Instant::now());
        self.active = true;
        self.clear_skip_reason();
    }

    fn is_duplicate_attempt(&self, file_signature: &str) -> bool {
        self.last_attempted_file_signature.as_deref() == Some(file_signature)
    }

    fn is_duplicate_processed_piece(&self, snapshot: &ZenithPassivePlannerSnapshot) -> bool {
        self.last_processed_snapshot_token.as_deref() == Some(snapshot.snapshot.token.as_str())
    }

    fn note_skip(&mut self, key: &str, line: String) -> Option<String> {
        if self.last_skip_key.as_deref() == Some(key) {
            return None;
        }
        self.last_skip_key = Some(key.to_owned());
        Some(line)
    }
}

fn zenith_semantic_skip_key(error: &str) -> String {
    if error.contains("missing current piece type") {
        return "semantic_invalid:current.type:missing".to_owned();
    }
    if error.contains("invalid current piece") {
        return "semantic_invalid:current.type:invalid_piece".to_owned();
    }
    if error.contains("invalid hold piece") {
        return "semantic_invalid:hold:invalid_piece".to_owned();
    }
    if error.contains("invalid queue piece") {
        return "semantic_invalid:queue:invalid_piece".to_owned();
    }
    if error.contains("missing current x coordinate") {
        return "semantic_invalid:current.x:missing".to_owned();
    }
    if error.contains("null current x coordinate") {
        return "semantic_invalid:current.x:null".to_owned();
    }
    if error.contains("invalid current x coordinate type") {
        return "semantic_invalid:current.x:invalid_type".to_owned();
    }
    if error.contains("invalid current x coordinate non_integer") {
        return "semantic_invalid:current.x:non_integer".to_owned();
    }
    if error.contains("invalid current x coordinate out_of_range") {
        return "semantic_invalid:current.x:out_of_range".to_owned();
    }
    if error.contains("missing current y coordinate") {
        return "semantic_invalid:current.y:missing".to_owned();
    }
    if error.contains("null current y coordinate") {
        return "semantic_invalid:current.y:null".to_owned();
    }
    if error.contains("invalid current y coordinate type") {
        return "semantic_invalid:current.y:invalid_type".to_owned();
    }
    if error.contains("invalid current y coordinate out_of_range") {
        return "semantic_invalid:current.y:out_of_range".to_owned();
    }
    format!("semantic_invalid:{error}")
}

fn friendly_vs_snapshot_parse_skip_key(error: &str) -> String {
    let normalized = error
        .split_once(" at line ")
        .map(|(prefix, _)| prefix)
        .unwrap_or(error)
        .trim();
    format!("semantic_invalid:{normalized}")
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum ZenithLiveStage {
    Idle,
    Planned,
    Executing,
    AwaitingLock,
    Completed,
    Aborted,
}

impl Default for ZenithLiveStage {
    fn default() -> Self {
        Self::Idle
    }
}

#[derive(Clone, Debug, Default)]
struct ZenithLiveController {
    stage: ZenithLiveStage,
    executed_pieces: u32,
    max_reached_logged: bool,
    session_max_pieces: ZenithLivePieceLimit,
    session_pps_unlimited: bool,
    session_target_pps: f32,
    startup_started_at: Option<Instant>,
    startup_first_plan_logged: bool,
    startup_first_input_logged: bool,
    active_piece_counter: Option<u32>,
    active_snapshot_token: Option<String>,
    active_game_id: Option<String>,
    active_candidate_id: Option<String>,
    active_capture_generation: Option<u64>,
    active_provider_generation: Option<u64>,
    started_at: Option<Instant>,
    last_execution_started_at: Option<Instant>,
    next_execution_earliest_at: Option<Instant>,
    last_execution_game_id: Option<String>,
    deferred_snapshot_token: Option<String>,
    deferred_plan: Option<ZenithDeferredPlan>,
    last_skip_key: Option<String>,
    last_abort_key: Option<String>,
    last_completed_execution: Option<ZenithLiveExecutionIdentity>,
    last_aborted_execution: Option<ZenithLiveExecutionIdentity>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ZenithLiveExecutionIdentity {
    snapshot_token: String,
    game_id: String,
    candidate_id: String,
    capture_generation: u64,
    piece_counter: Option<u32>,
}

#[derive(Clone, Debug)]
struct ZenithDeferredPlan {
    snapshot_token: String,
    gameid: String,
    capture_generation: u64,
    candidate_id: String,
    userid: String,
    piece_counter: Option<u32>,
    current_signature: String,
    prepared: PreparedSnapshotExecution,
}

impl ZenithDeferredPlan {
    fn matches_snapshot(&self, snapshot: &ZenithPassivePlannerSnapshot) -> bool {
        self.snapshot_token == snapshot.snapshot.token
            && self.gameid == snapshot.gameid
            && self.capture_generation == snapshot.capture_generation
            && self.candidate_id == snapshot.candidate_id
            && self.userid == snapshot.userid
            && self.piece_counter == snapshot.snapshot.piece_counter
            && self.current_signature == snapshot.current_signature
    }
}

impl ZenithLiveController {
    fn reset(&mut self) {
        *self = Self::default();
    }

    fn clear_skip_reason(&mut self) {
        self.last_skip_key = None;
    }

    fn clear_abort_reason(&mut self) {
        self.last_abort_key = None;
    }

    fn note_max_reached(&mut self) -> bool {
        if self.max_reached_logged {
            false
        } else {
            self.max_reached_logged = true;
            true
        }
    }

    fn session_max_pieces(&self) -> ZenithLivePieceLimit {
        self.session_max_pieces.normalized()
    }

    fn set_session_pacing(&mut self, pps_unlimited: bool, target_pps: f32) {
        self.session_pps_unlimited = pps_unlimited;
        self.session_target_pps = normalize_target_pps_value(target_pps);
        self.clear_pacing_state();
    }

    fn session_target_pps(&self) -> f32 {
        normalize_target_pps_value(self.session_target_pps)
    }

    fn session_target_pps_interval(&self) -> Option<Duration> {
        if self.session_pps_unlimited {
            None
        } else {
            pacing_interval_for_target_pps(self.session_target_pps())
        }
    }

    fn clear_pacing_state(&mut self) {
        self.last_execution_started_at = None;
        self.next_execution_earliest_at = None;
        self.last_execution_game_id = None;
        self.deferred_snapshot_token = None;
        self.deferred_plan = None;
    }

    fn start_startup_session(&mut self) {
        self.startup_started_at = Some(Instant::now());
        self.startup_first_plan_logged = false;
        self.startup_first_input_logged = false;
    }

    fn note_startup_stage(&mut self, stage: &str) -> Option<String> {
        let elapsed_ms = self.startup_started_at?.elapsed().as_millis();
        let should_log = match stage {
            "first_plan" if !self.startup_first_plan_logged => {
                self.startup_first_plan_logged = true;
                true
            }
            "first_input" if !self.startup_first_input_logged => {
                self.startup_first_input_logged = true;
                true
            }
            _ => false,
        };
        should_log.then(|| format!("[zenith-startup] stage={stage} elapsed_ms={elapsed_ms}"))
    }

    fn note_skip(&mut self, key: &str, line: String) -> Option<String> {
        if self.last_skip_key.as_deref() == Some(key) {
            return None;
        }
        self.last_skip_key = Some(key.to_owned());
        Some(line)
    }

    fn note_abort(&mut self, key: &str, line: String) -> Option<String> {
        if self.last_abort_key.as_deref() == Some(key) {
            return None;
        }
        self.last_abort_key = Some(key.to_owned());
        Some(line)
    }

    fn start_planned(
        &mut self,
        snapshot: &ZenithPassivePlannerSnapshot,
        provider_generation: u64,
        stage: ZenithLiveStage,
    ) {
        self.stage = stage;
        self.deferred_snapshot_token = None;
        self.deferred_plan = None;
        self.active_piece_counter = snapshot.snapshot.piece_counter;
        self.active_snapshot_token = Some(snapshot.snapshot.token.clone());
        self.active_game_id = Some(snapshot.gameid.clone());
        self.active_candidate_id = Some(snapshot.candidate_id.clone());
        self.active_capture_generation = Some(snapshot.capture_generation);
        self.active_provider_generation = Some(provider_generation);
        self.started_at = Some(Instant::now());
        self.clear_skip_reason();
        self.clear_abort_reason();
    }

    fn note_execution_started_for_pacing(
        &mut self,
        snapshot: &ZenithPassivePlannerSnapshot,
        now: Instant,
    ) {
        self.last_execution_started_at = Some(now);
        self.last_execution_game_id = Some(snapshot.gameid.clone());
        self.next_execution_earliest_at = self
            .session_target_pps_interval()
            .map(|interval| now + interval);
        self.deferred_snapshot_token = None;
        self.deferred_plan = None;
    }

    fn pacing_remaining_for_snapshot(
        &mut self,
        snapshot: &ZenithPassivePlannerSnapshot,
        now: Instant,
    ) -> Option<Duration> {
        if self
            .last_execution_game_id
            .as_deref()
            .is_some_and(|game_id| game_id != snapshot.gameid.as_str())
        {
            self.clear_pacing_state();
            return None;
        }
        let earliest = self.next_execution_earliest_at?;
        let remaining = earliest.saturating_duration_since(now);
        if remaining.is_zero() {
            None
        } else {
            Some(remaining)
        }
    }

    fn set_deferred_plan(
        &mut self,
        snapshot: &ZenithPassivePlannerSnapshot,
        prepared: PreparedSnapshotExecution,
    ) {
        self.deferred_snapshot_token = Some(snapshot.snapshot.token.clone());
        self.deferred_plan = Some(ZenithDeferredPlan {
            snapshot_token: snapshot.snapshot.token.clone(),
            gameid: snapshot.gameid.clone(),
            capture_generation: snapshot.capture_generation,
            candidate_id: snapshot.candidate_id.clone(),
            userid: snapshot.userid.clone(),
            piece_counter: snapshot.snapshot.piece_counter,
            current_signature: snapshot.current_signature.clone(),
            prepared,
        });
    }

    fn clear_deferred_snapshot(&mut self) {
        self.deferred_snapshot_token = None;
        self.deferred_plan = None;
    }

    fn is_deferred_snapshot(&self, snapshot: &ZenithPassivePlannerSnapshot) -> bool {
        self.deferred_snapshot_token.as_deref() == Some(snapshot.snapshot.token.as_str())
    }

    fn deferred_plan_for_snapshot(
        &self,
        snapshot: &ZenithPassivePlannerSnapshot,
    ) -> Option<&ZenithDeferredPlan> {
        let deferred = self.deferred_plan.as_ref()?;
        deferred.matches_snapshot(snapshot).then_some(deferred)
    }

    fn active_execution_identity(&self) -> Option<ZenithLiveExecutionIdentity> {
        Some(ZenithLiveExecutionIdentity {
            snapshot_token: self.active_snapshot_token.clone()?,
            game_id: self.active_game_id.clone()?,
            candidate_id: self.active_candidate_id.clone()?,
            capture_generation: self.active_capture_generation?,
            piece_counter: self.active_piece_counter,
        })
    }

    fn execution_matches_snapshot(
        execution: &Option<ZenithLiveExecutionIdentity>,
        snapshot: &ZenithPassivePlannerSnapshot,
    ) -> bool {
        let Some(execution) = execution else {
            return false;
        };
        execution.snapshot_token == snapshot.snapshot.token
            || (execution.game_id == snapshot.gameid
                && execution.candidate_id == snapshot.candidate_id
                && execution.capture_generation == snapshot.capture_generation
                && execution.piece_counter == snapshot.snapshot.piece_counter)
    }

    fn completed_execution_matches_snapshot(
        &self,
        snapshot: &ZenithPassivePlannerSnapshot,
    ) -> bool {
        Self::execution_matches_snapshot(&self.last_completed_execution, snapshot)
    }

    fn aborted_execution_matches_snapshot(&self, snapshot: &ZenithPassivePlannerSnapshot) -> bool {
        Self::execution_matches_snapshot(&self.last_aborted_execution, snapshot)
    }

    fn mark_completed(&mut self) {
        self.stage = ZenithLiveStage::Completed;
        self.executed_pieces = self.executed_pieces.saturating_add(1);
        self.last_completed_execution = self.active_execution_identity();
        self.clear_skip_reason();
        self.clear_abort_reason();
        self.active_piece_counter = None;
        self.active_snapshot_token = None;
        self.active_game_id = None;
        self.active_candidate_id = None;
        self.active_capture_generation = None;
        self.active_provider_generation = None;
        self.started_at = None;
    }

    fn mark_aborted(&mut self) {
        self.stage = ZenithLiveStage::Aborted;
        self.last_aborted_execution = self.active_execution_identity();
        self.active_piece_counter = None;
        self.active_snapshot_token = None;
        self.active_game_id = None;
        self.active_candidate_id = None;
        self.active_capture_generation = None;
        self.active_provider_generation = None;
        self.started_at = None;
        self.clear_skip_reason();
    }

    fn is_waiting_for_lock(&self) -> bool {
        self.stage == ZenithLiveStage::AwaitingLock
    }

    fn is_executing_piece(&self, piece_counter: Option<u32>) -> bool {
        self.active_piece_counter == piece_counter
            && matches!(
                self.stage,
                ZenithLiveStage::Planned
                    | ZenithLiveStage::Executing
                    | ZenithLiveStage::AwaitingLock
            )
    }
}

#[cfg(test)]
#[derive(Clone, Default)]
struct ZenithLiveTestHook {
    dispatch_count: Arc<AtomicU32>,
    release_count: Arc<AtomicU32>,
    started_at: Arc<Mutex<Vec<Instant>>>,
    tapped_actions: Arc<Mutex<Vec<crate::driver::GameAction>>>,
    fail_after_taps: Arc<AtomicU32>,
}

#[cfg(test)]
struct ZenithLiveTestBackend {
    hook: ZenithLiveTestHook,
}

#[cfg(test)]
impl InputBackend for ZenithLiveTestBackend {
    fn tap(&mut self, action: crate::driver::GameAction, _duration: Duration) -> Result<()> {
        if let Ok(mut actions) = self.hook.tapped_actions.lock() {
            actions.push(action);
        }
        let fail_after = self.hook.fail_after_taps.load(Ordering::Relaxed);
        if fail_after > 0 {
            let tapped = self
                .hook
                .tapped_actions
                .lock()
                .map(|actions| actions.len() as u32)
                .unwrap_or(0);
            if tapped >= fail_after {
                anyhow::bail!("test forced tap failure after {fail_after} actions");
            }
        }
        Ok(())
    }

    fn release_all_keys(&mut self) -> Result<()> {
        self.hook.release_count.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

pub struct LauncherApp {
    paths: AppPaths,
    state: LauncherState,
    logs: Vec<String>,
    event_tx: Sender<LauncherEvent>,
    event_rx: Receiver<LauncherEvent>,
    browser_session: Option<BrowserSession>,
    bot_session: Option<BotSession>,
    browser_status: BrowserStatus,
    snapshot_status: SnapshotStatus,
    input_status: InputStatus,
    bot_status: BotStatus,
    latest_snapshot_token: Option<String>,
    latest_snapshot_age_ms: Option<u128>,
    ignore_next_bot_exit: bool,
    bot_desired_enabled: bool,
    bot_waiting_for_next_game: bool,
    bot_restart_pending: bool,
    friendly_vs_capture_enabled: bool,
    friendly_vs_capture_round_id: Option<String>,
    friendly_vs_capture_local_game_id: Option<String>,
    friendly_vs: FriendlyVsObserver,
    friendly_vs_dry_run: FriendlyVsDryRunController,
    friendly_vs_live: FriendlyVsLiveController,
    passive_provider: PassiveProviderController,
    zenith_dry_run: ZenithDryRunController,
    zenith_live: ZenithLiveController,
    #[cfg(test)]
    zenith_live_test_hook: ZenithLiveTestHook,
    #[cfg(test)]
    test_now: Option<Instant>,
    #[cfg(test)]
    friendly_vs_live_before_reread: Option<Box<dyn FnOnce(&mut LauncherApp)>>,
    #[cfg(test)]
    zenith_live_before_reread: Option<Box<dyn FnOnce(&mut LauncherApp)>>,
}

impl LauncherApp {
    pub fn new(paths: AppPaths) -> Self {
        let mut state = load_launcher_state(&paths).unwrap_or_default();
        state.ensure_scanner_config_path();
        state.migrate_legacy_defaults();
        state.bot_enabled = false;
        state.friendly_vs_live_limit = FriendlyVsLiveLimit::Unlimited;
        state.friendly_vs_live_input_enabled = true;
        let (event_tx, event_rx) = mpsc::channel();
        Self {
            paths,
            state,
            logs: vec!["Launcher ready".to_owned()],
            event_tx,
            event_rx,
            browser_session: None,
            bot_session: None,
            browser_status: BrowserStatus::Closed,
            snapshot_status: SnapshotStatus::Closed,
            input_status: InputStatus::Closed,
            bot_status: BotStatus::Off,
            latest_snapshot_token: None,
            latest_snapshot_age_ms: None,
            ignore_next_bot_exit: false,
            bot_desired_enabled: false,
            bot_waiting_for_next_game: false,
            bot_restart_pending: false,
            friendly_vs_capture_enabled: false,
            friendly_vs_capture_round_id: None,
            friendly_vs_capture_local_game_id: None,
            friendly_vs: FriendlyVsObserver::default(),
            friendly_vs_dry_run: FriendlyVsDryRunController::default(),
            friendly_vs_live: FriendlyVsLiveController::default(),
            passive_provider: PassiveProviderController::default(),
            zenith_dry_run: ZenithDryRunController::default(),
            zenith_live: ZenithLiveController::default(),
            #[cfg(test)]
            zenith_live_test_hook: ZenithLiveTestHook::default(),
            #[cfg(test)]
            test_now: None,
            #[cfg(test)]
            friendly_vs_live_before_reread: None,
            #[cfg(test)]
            zenith_live_before_reread: None,
        }
    }

    fn monotonic_now(&self) -> Instant {
        #[cfg(test)]
        if let Some(now) = self.test_now {
            return now;
        }
        Instant::now()
    }

    fn browser_logger(&self) -> SharedLogger {
        let tx = self.event_tx.clone();
        Arc::new(Mutex::new(Box::new(move |line| {
            let _ = tx.send(LauncherEvent::BrowserLog(line));
        })))
    }

    fn push_log(&mut self, line: impl Into<String>) {
        let line = line.into();
        self.append_log_file(&line);
        self.logs.push(line);
        if self.logs.len() > 400 {
            let drain = self.logs.len() - 400;
            self.logs.drain(0..drain);
        }
    }

    fn append_log_file(&self, line: &str) {
        let log_path = self
            .paths
            .launcher_state_path
            .parent()
            .map(|parent| parent.join("launcher-latest.log"))
            .unwrap_or_else(|| {
                self.paths
                    .workspace_root
                    .join("automation")
                    .join("launcher-latest.log")
            });
        if let Some(parent) = log_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(mut file) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            let _ = writeln!(file, "{line}");
        }
    }

    fn save_state(&mut self) {
        self.state.bot_enabled = self.bot_desired_enabled;
        if let Err(err) = save_launcher_state(&self.paths, &self.state) {
            self.push_log(format!("[launcher] failed to save launcher state: {err:#}"));
        } else {
            self.push_log(format!(
                "[launcher] saved settings to {}",
                self.paths
                    .display_workspace_relative(&self.paths.launcher_state_path)
            ));
        }
    }

    fn browser_connection_settings_locked(&self) -> bool {
        self.browser_session.is_some()
    }

    fn local_tetrio_username_locked(&self) -> bool {
        self.bot_desired_enabled
            || self.bot_session.is_some()
            || matches!(self.bot_status, BotStatus::Starting | BotStatus::On)
    }

    fn update_live_target_pps(&mut self) {
        let effective_target_pps = self.state.effective_target_pps();
        if self.state.selected_mode == RuntimeMode::FriendlyVs
            && (self.bot_desired_enabled
                || self.bot_session.is_some()
                || self.bot_status == BotStatus::On)
        {
            self.friendly_vs_live
                .set_session_pacing(self.state.pps_unlimited, self.state.target_pps);
        }
        if self.state.selected_mode == RuntimeMode::Zenith
            && (self.bot_desired_enabled
                || self.bot_session.is_some()
                || self.bot_status == BotStatus::On)
        {
            self.zenith_live
                .set_session_pacing(self.state.pps_unlimited, self.state.target_pps);
        }
        if let Some(bot_session) = self.bot_session.as_ref() {
            bot_session
                .live_target_pps
                .store(effective_target_pps.to_bits(), Ordering::Relaxed);
            self.push_log(format!(
                "[bot] target PPS changed {}",
                format_target_pps_label(effective_target_pps)
            ));
        }
    }

    fn local_tetrio_username_hint(&self) -> Option<String> {
        let trimmed = self.state.browser.local_tetrio_username.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_owned())
        }
    }

    fn sync_passive_provider_username_hint_for_owner(
        &mut self,
        owner: PassiveProviderOwner,
    ) -> bool {
        if !self.passive_provider.is_requested(owner) {
            return true;
        }
        let username_hint = self.local_tetrio_username_hint();
        let Some(session) = self.browser_session.as_mut() else {
            return true;
        };
        match session.snapshot_provider.set_quick_play_passive_provider(
            owner.control_value(),
            true,
            username_hint.as_deref(),
        ) {
            Ok(()) => true,
            Err(err) => {
                self.push_log(format!(
                    "{} passive provider username sync failed owner={} error={err:#}",
                    owner.log_prefix(),
                    owner.control_value()
                ));
                false
            }
        }
    }

    fn sync_requested_passive_provider_username_hint(&mut self) -> bool {
        let mut synced = true;
        for owner in [
            PassiveProviderOwner::ManualDiagnostic,
            PassiveProviderOwner::ZenithDryRun,
        ] {
            synced &= self.sync_passive_provider_username_hint_for_owner(owner);
        }
        synced
    }

    fn sync_browser_local_tetrio_username(&mut self) -> bool {
        let username_hint = self.local_tetrio_username_hint();
        let Some(session) = self.browser_session.as_mut() else {
            return true;
        };
        match session
            .snapshot_provider
            .set_local_tetrio_username(username_hint.as_deref())
        {
            Ok(()) => true,
            Err(err) => {
                self.push_log(format!(
                    "[browser] failed to forward local_tetrio_username to snapshot provider: {err:#}"
                ));
                false
            }
        }
    }

    fn zenith_live_piece_limit(&self) -> ZenithLivePieceLimit {
        if self.state.selected_mode == RuntimeMode::Zenith
            && (self.bot_desired_enabled
                || self.bot_session.is_some()
                || self.bot_status == BotStatus::On)
        {
            self.zenith_live.session_max_pieces()
        } else {
            self.state.effective_zenith_live_max_pieces()
        }
    }

    fn zenith_live_pps_unlimited(&self) -> bool {
        if self.state.selected_mode == RuntimeMode::Zenith
            && (self.bot_desired_enabled
                || self.bot_session.is_some()
                || self.bot_status == BotStatus::On)
        {
            self.zenith_live.session_pps_unlimited
        } else {
            self.state.pps_unlimited
        }
    }

    fn zenith_live_target_pps(&self) -> f32 {
        if self.state.selected_mode == RuntimeMode::Zenith
            && (self.bot_desired_enabled
                || self.bot_session.is_some()
                || self.bot_status == BotStatus::On)
        {
            self.zenith_live.session_target_pps()
        } else {
            normalize_target_pps_value(self.state.target_pps)
        }
    }

    fn zenith_live_pps_interval(&self) -> Option<Duration> {
        if self.zenith_live_pps_unlimited() {
            None
        } else {
            pacing_interval_for_target_pps(self.zenith_live_target_pps())
        }
    }

    fn zenith_live_pps_label(&self) -> String {
        if self.zenith_live_pps_unlimited() {
            "unlimited".to_owned()
        } else {
            format_target_pps_log_label(self.zenith_live_target_pps())
        }
    }

    fn zenith_live_input_allowed(&self) -> bool {
        self.state.selected_mode == RuntimeMode::Zenith && self.state.zenith_live_input_enabled
    }

    fn friendly_vs_live_pps_unlimited(&self) -> bool {
        if self.state.selected_mode == RuntimeMode::FriendlyVs
            && (self.bot_desired_enabled
                || self.bot_session.is_some()
                || self.bot_status == BotStatus::On)
        {
            self.friendly_vs_live.session_pps_unlimited
        } else {
            self.state.pps_unlimited
        }
    }

    fn friendly_vs_live_target_pps(&self) -> f32 {
        if self.state.selected_mode == RuntimeMode::FriendlyVs
            && (self.bot_desired_enabled
                || self.bot_session.is_some()
                || self.bot_status == BotStatus::On)
        {
            self.friendly_vs_live.session_target_pps()
        } else {
            normalize_target_pps_value(self.state.target_pps)
        }
    }

    fn friendly_vs_live_pps_interval(&self) -> Option<Duration> {
        if self.friendly_vs_live_pps_unlimited() {
            None
        } else {
            pacing_interval_for_target_pps(self.friendly_vs_live_target_pps())
        }
    }

    fn friendly_vs_live_pps_label(&self) -> String {
        if self.friendly_vs_live_pps_unlimited() {
            "unlimited".to_owned()
        } else {
            format_target_pps_log_label(self.friendly_vs_live_target_pps())
        }
    }

    fn friendly_vs_live_limit(&self) -> FriendlyVsLiveLimit {
        self.state.effective_friendly_vs_live_limit()
    }

    fn friendly_vs_live_input_allowed(&self) -> bool {
        self.state.selected_mode == RuntimeMode::FriendlyVs
            && self.state.friendly_vs_live_input_enabled
    }

    fn friendly_vs_live_count_label(&self) -> String {
        self.friendly_vs_live.count_label(self.friendly_vs_live_limit())
    }

    #[cfg(test)]
    fn friendly_vs_live_status_label(&self) -> String {
        if self.state.friendly_vs_live_input_enabled {
            format!(
                "Friendly VS: Live ({})",
                self.friendly_vs_live_count_label()
            )
        } else {
            "Friendly VS: Dry Run".to_owned()
        }
    }

    #[cfg(test)]
    fn set_friendly_vs_live_input_enabled(&mut self, enabled: bool) {
        if self.state.friendly_vs_live_input_enabled == enabled {
            return;
        }
        self.state.friendly_vs_live_input_enabled = enabled;
        self.save_state();

        if self.state.selected_mode != RuntimeMode::FriendlyVs {
            return;
        }

        let count = self.friendly_vs_live_count_label();
        if enabled {
            self.push_log(format!("[friendly-vs-live] enabled count={count}"));
            if let Some(line) = self
                .friendly_vs_live
                .note_limit_locked(self.friendly_vs_live_limit())
            {
                self.push_log(line);
            }
        } else {
            self.push_log(format!("[friendly-vs-live] disabled count={count}"));
        }
    }

    fn friendly_vs_live_session_armed_log(&self) -> String {
        format!(
            "[friendly-vs-live] pacing target_pps={} interval_ms={} limit={}",
            self.friendly_vs_live_pps_label(),
            self.friendly_vs_live_pps_interval()
                .map(|interval| interval.as_millis())
                .unwrap_or(0),
            self.friendly_vs_live_limit().count_suffix()
        )
    }

    fn friendly_vs_live_execution_started_log(&self, piece_counter: Option<u32>) -> String {
        match self.friendly_vs_live_limit() {
            FriendlyVsLiveLimit::Twenty => format!(
                "[friendly-vs-live] execution started piece_counter={} executed={} max_pieces=20 pps={}",
                piece_counter_label(piece_counter),
                self.friendly_vs_live.executed_placements,
                self.friendly_vs_live_pps_label()
            ),
            FriendlyVsLiveLimit::Unlimited => format!(
                "[friendly-vs-live] execution started piece_counter={} executed={} limit=unlimited pps={}",
                piece_counter_label(piece_counter),
                self.friendly_vs_live.executed_placements,
                self.friendly_vs_live_pps_label()
            ),
        }
    }

    fn zenith_live_limit_reached(&self) -> bool {
        self.zenith_live_piece_limit()
            .is_reached(self.zenith_live.executed_pieces)
    }

    fn zenith_live_session_armed_log(&self) -> String {
        format!(
            "[zenith-live] session armed limit={} pps={} interval_ms={}",
            self.zenith_live_piece_limit().log_label(),
            self.zenith_live_pps_label(),
            self.zenith_live_pps_interval()
                .map(|interval| interval.as_millis())
                .unwrap_or(0)
        )
    }

    fn zenith_live_execution_started_log(&self, piece_counter: Option<u32>) -> String {
        match self.zenith_live_piece_limit() {
            ZenithLivePieceLimit::Bounded(max_pieces) => format!(
                "[zenith-live] execution started piece_counter={} executed={} max_pieces={} pps={}",
                piece_counter_label(piece_counter),
                self.zenith_live.executed_pieces,
                max_pieces,
                self.zenith_live_pps_label()
            ),
            ZenithLivePieceLimit::Unlimited => format!(
                "[zenith-live] execution started piece_counter={} executed={} limit=unlimited pps={}",
                piece_counter_label(piece_counter),
                self.zenith_live.executed_pieces,
                self.zenith_live_pps_label()
            ),
        }
    }

    fn zenith_live_piece_completed_log(
        &self,
        before_piece_counter: u32,
        after_piece_counter: u32,
    ) -> String {
        match self.zenith_live_piece_limit() {
            ZenithLivePieceLimit::Bounded(max_pieces) => format!(
                "[zenith-live] piece completed piece_counter_before={} piece_counter_after={} executed={} max={}",
                before_piece_counter, after_piece_counter, self.zenith_live.executed_pieces, max_pieces
            ),
            ZenithLivePieceLimit::Unlimited => format!(
                "[zenith-live] piece completed piece_counter_before={} piece_counter_after={} executed={} limit=unlimited",
                before_piece_counter, after_piece_counter, self.zenith_live.executed_pieces
            ),
        }
    }

    fn zenith_execution_timings(config: &AutomationConfig) -> ExecutionTimings {
        ExecutionTimings {
            tap_duration: Duration::from_millis(config.tap_duration_ms),
            movement_tap_duration: Duration::from_millis(config.movement_tap_duration_ms),
            rotate_tap_duration: Duration::from_millis(config.rotate_tap_duration_ms),
            hold_tap_duration: Duration::from_millis(config.hold_tap_duration_ms),
            hard_drop_tap_duration: Duration::from_millis(config.hard_drop_tap_duration_ms),
            soft_drop_tap_duration: Duration::from_millis(config.soft_drop_tap_duration_ms),
            movement_interval: Duration::from_millis(config.movement_interval_ms),
            rotation_interval: Duration::from_millis(config.rotation_interval_ms),
            piece_interval: Duration::from_millis(config.piece_interval_ms),
            hard_drop_interval: Duration::from_millis(config.hard_drop_interval_ms),
        }
    }

    fn create_live_input_backend(&mut self) -> Result<Box<dyn InputBackend>> {
        #[cfg(test)]
        if self.browser_session.is_none() {
            self.zenith_live_test_hook
                .dispatch_count
                .fetch_add(1, Ordering::Relaxed);
            return Ok(Box::new(ZenithLiveTestBackend {
                hook: self.zenith_live_test_hook.clone(),
            }));
        }

        let shared = self
            .browser_session
            .as_ref()
            .map(|session| session.input_backend.clone())
            .context("browser input backend missing for live execution")?;
        Ok(Box::new(BrowserCdpInputBackend::from_shared(shared)))
    }

    fn execute_live_plan_with_existing_executor(
        &mut self,
        config: &AutomationConfig,
        prepared: &PreparedSnapshotExecution,
    ) -> Result<()> {
        let timings = Self::zenith_execution_timings(config);
        let mut backend = self.create_live_input_backend()?;
        execute_plan(
            &mut *backend,
            &prepared.execution_plan,
            &config.handling,
            timings,
            |line| self.push_log(line),
        )
    }

    fn execute_zenith_live_plan(
        &mut self,
        config: &AutomationConfig,
        prepared: &PreparedSnapshotExecution,
    ) -> Result<()> {
        self.execute_live_plan_with_existing_executor(config, prepared)
    }

    fn execute_friendly_vs_live_plan(
        &mut self,
        config: &AutomationConfig,
        prepared: &PreparedSnapshotExecution,
    ) -> Result<()> {
        self.execute_live_plan_with_existing_executor(config, prepared)
    }

    fn dispatch_friendly_vs_live_plan(
        &mut self,
        config: &AutomationConfig,
        prepared: &PreparedSnapshotExecution,
    ) -> Result<()> {
        self.execute_friendly_vs_live_plan(config, prepared)
    }

    fn release_live_input_now(&mut self) -> Result<()> {
        #[cfg(test)]
        if self.browser_session.is_none() {
            self.zenith_live_test_hook
                .release_count
                .fetch_add(1, Ordering::Relaxed);
            return Ok(());
        }

        self.release_shared_input_now()
    }

    fn release_live_input_with_log(&mut self) {
        match self.release_live_input_now() {
            Ok(()) => self.push_log("[input] released all keys"),
            Err(err) => self.push_log(format!("[input] failed to release all keys: {err:#}")),
        }
    }

    fn suppress_friendly_vs_live_input(
        &mut self,
        reason: &str,
        snapshot: &FriendlyVsPassivePlannerSnapshot,
    ) {
        let skip_key = if reason == "placement_limit" {
            format!(
                "{reason}:{}:{}:{}",
                snapshot.round_id, snapshot.gameid, snapshot.capture_generation
            )
        } else {
            format!(
                "{reason}:{}:{}:{}:{}",
                snapshot.round_id,
                snapshot.gameid,
                snapshot.capture_generation,
                piece_counter_label(snapshot.snapshot.piece_counter)
            )
        };
        if let Some(line) = self.friendly_vs_live.note_skip(
            &skip_key,
            format!(
                "[friendly-vs-live] input suppressed reason={reason} round_id={} gameid={} piece_counter={}",
                snapshot.round_id,
                snapshot.gameid,
                piece_counter_label(snapshot.snapshot.piece_counter)
            ),
        ) {
            self.push_log(line);
        }
    }

    fn friendly_vs_live_requires_source_pose_guard(&self) -> bool {
        self.friendly_vs_live_input_allowed()
    }

    fn log_execution_start_pose_confirmed(
        &mut self,
        mode: &str,
        pose: &ExecutionStartPose,
    ) {
        self.push_log(format!(
            "[{mode}] plan source pose confirmed before dispatch piece={} x={} y={} rotation={:?} piece_counter={}",
            pose.piece.label(),
            pose.x,
            pose.y,
            pose.rotation,
            piece_counter_label(pose.piece_counter)
        ));
    }

    fn invalidate_live_plan_for_start_pose(
        &mut self,
        mode: &str,
        planned_pose: &ExecutionStartPose,
        fresh_pose: Option<&ExecutionStartPose>,
    ) {
        let reason = if fresh_pose
            .is_some_and(|pose| pose.piece_counter != planned_pose.piece_counter)
        {
            "piece_advanced"
        } else {
            "pose_mismatch"
        };
        let (fresh_piece, fresh_x, fresh_y, fresh_rotation, fresh_counter) = match fresh_pose {
            Some(pose) => (
                pose.piece.label().to_owned(),
                pose.x.to_string(),
                pose.y.to_string(),
                format!("{:?}", pose.rotation),
                piece_counter_label(pose.piece_counter),
            ),
            None => (
                "?".to_owned(),
                "missing".to_owned(),
                "missing".to_owned(),
                "missing".to_owned(),
                "missing".to_owned(),
            ),
        };
        self.push_log(format!(
            "[{mode}] plan invalidated before dispatch planned=(piece={} x={} y={} rotation={:?} piece_counter={}) actual=(piece={} x={} y={} rotation={} piece_counter={}) reason={} action=discard_and_replan",
            planned_pose.piece.label(),
            planned_pose.x,
            planned_pose.y,
            planned_pose.rotation,
            piece_counter_label(planned_pose.piece_counter),
            fresh_piece,
            fresh_x,
            fresh_y,
            fresh_rotation,
            fresh_counter,
            reason
        ));
    }

    fn friendly_vs_live_reread_matches_plan(
        &mut self,
        path: &std::path::Path,
        planned_snapshot: &FriendlyVsPassivePlannerSnapshot,
        active_round_id: &str,
        active_game_id: &str,
    ) -> Result<Option<FriendlyVsPassivePlannerSnapshot>> {
        let read_result = read_friendly_vs_passive_snapshot_file_with_age(path)?;
        let Some((envelope, age)) = read_result else {
            return Ok(None);
        };
        let Some(snapshot) = envelope.snapshot else {
            return Ok(None);
        };
        if envelope.status != "ready" || envelope.capture_status.as_deref() != Some("running") {
            return Ok(None);
        }
        if age
            .map(|value| value.as_millis() > u128::from(MAX_SNAPSHOT_AGE_MS))
            .unwrap_or(false)
        {
            return Ok(None);
        }
        if snapshot.round_id != active_round_id
            || snapshot.gameid != active_game_id
            || snapshot.capture_generation != planned_snapshot.capture_generation
            || !snapshot.playing
            || !snapshot.started
            || snapshot.countdown_started
            || snapshot.paused == Some(true)
            || snapshot.destroyed
            || snapshot.successful
            || snapshot.gameoverreason.is_some()
        {
            return Ok(Some(snapshot));
        }
        if snapshot.candidate_id != planned_snapshot.candidate_id
            || snapshot.current_signature != planned_snapshot.current_signature
            || snapshot.snapshot.piece_counter != planned_snapshot.snapshot.piece_counter
        {
            return Ok(Some(snapshot));
        }
        Ok(Some(snapshot))
    }

    fn zenith_live_reread_snapshot(
        &mut self,
        path: &std::path::Path,
    ) -> Result<Option<ZenithPassivePlannerSnapshot>> {
        let Some((envelope, age)) = read_zenith_passive_snapshot_file_with_age(path)? else {
            return Ok(None);
        };
        if envelope.status != "ready" || envelope.capture_status.as_deref() != Some("running") {
            return Ok(None);
        }
        if age
            .map(|value| value.as_millis() > u128::from(MAX_SNAPSHOT_AGE_MS))
            .unwrap_or(false)
        {
            return Ok(None);
        }
        Ok(envelope.snapshot)
    }

    fn try_dispatch_friendly_vs_live_plan(
        &mut self,
        config: &AutomationConfig,
        path: &std::path::Path,
        file_signature: &str,
        planned_snapshot: &FriendlyVsPassivePlannerSnapshot,
        prepared: &PreparedSnapshotExecution,
    ) {
        self.friendly_vs_live.sync_session(
            &planned_snapshot.round_id,
            &planned_snapshot.gameid,
            planned_snapshot.capture_generation,
        );
        if !self.friendly_vs_live_input_allowed() {
            return;
        }
        if self
            .friendly_vs_live
            .limit_reached(self.friendly_vs_live_limit())
        {
            self.suppress_friendly_vs_live_input("placement_limit", planned_snapshot);
            return;
        }

        self.push_log(format!(
            "[friendly-vs-live] plan accepted round_id={} gameid={} generation={} piece_counter={} current={} use_hold={}",
            planned_snapshot.round_id,
            planned_snapshot.gameid,
            planned_snapshot.capture_generation,
            piece_counter_label(planned_snapshot.snapshot.piece_counter),
            planned_snapshot
                .snapshot
                .queue
                .first()
                .copied()
                .map(|piece| piece.label())
                .unwrap_or("?"),
            prepared.summary.use_hold
        ));

        #[cfg(test)]
        if let Some(callback) = self.friendly_vs_live_before_reread.take() {
            callback(self);
        }

        if self.state.selected_mode != RuntimeMode::FriendlyVs {
            self.suppress_friendly_vs_live_input("mode_changed", planned_snapshot);
            return;
        }
        if !self.bot_desired_enabled || self.bot_status != BotStatus::On {
            self.suppress_friendly_vs_live_input("bot_off", planned_snapshot);
            return;
        }
        if !self.friendly_vs_live_input_allowed()
            || !self.friendly_vs_runtime_ready()
            || !self.friendly_vs_capture_enabled
        {
            self.suppress_friendly_vs_live_input("stale_snapshot", planned_snapshot);
            return;
        }
        let Some(active_round_id) = self.friendly_vs.active_round_id.as_deref() else {
            self.suppress_friendly_vs_live_input("round_mismatch", planned_snapshot);
            return;
        };
        let Some(active_game_id) = self.friendly_vs.resolved_game_id.as_deref() else {
            self.suppress_friendly_vs_live_input("gameid_mismatch", planned_snapshot);
            return;
        };
        let active_round_id = active_round_id.to_owned();
        let active_game_id = active_game_id.to_owned();
        if active_round_id != planned_snapshot.round_id {
            self.suppress_friendly_vs_live_input("round_mismatch", planned_snapshot);
            return;
        }
        if active_game_id != planned_snapshot.gameid {
            self.suppress_friendly_vs_live_input("gameid_mismatch", planned_snapshot);
            return;
        }
        if self
            .friendly_vs_live
            .limit_reached(self.friendly_vs_live_limit())
        {
            self.suppress_friendly_vs_live_input("placement_limit", planned_snapshot);
            return;
        }

        let fresh_snapshot = match self.friendly_vs_live_reread_matches_plan(
            path,
            planned_snapshot,
            &active_round_id,
            &active_game_id,
        ) {
            Ok(Some(snapshot)) => snapshot,
            Ok(None) => {
                self.suppress_friendly_vs_live_input("stale_snapshot", planned_snapshot);
                return;
            }
            Err(err) => {
                self.push_log(format!(
                    "[friendly-vs-live] input suppressed reason=stale_snapshot error={err:#}"
                ));
                return;
            }
        };

        if fresh_snapshot.round_id != active_round_id {
            self.suppress_friendly_vs_live_input("round_mismatch", &fresh_snapshot);
            return;
        }
        if fresh_snapshot.gameid != active_game_id {
            self.suppress_friendly_vs_live_input("gameid_mismatch", &fresh_snapshot);
            return;
        }
        if fresh_snapshot.capture_generation != planned_snapshot.capture_generation {
            self.suppress_friendly_vs_live_input("generation_mismatch", &fresh_snapshot);
            return;
        }
        if !fresh_snapshot.playing
            || !fresh_snapshot.started
            || fresh_snapshot.countdown_started
            || fresh_snapshot.paused == Some(true)
            || fresh_snapshot.destroyed
            || fresh_snapshot.successful
            || fresh_snapshot.gameoverreason.is_some()
        {
            self.suppress_friendly_vs_live_input("not_playing", &fresh_snapshot);
            return;
        }
        if fresh_snapshot.candidate_id != planned_snapshot.candidate_id {
            self.suppress_friendly_vs_live_input("stale_snapshot", &fresh_snapshot);
            return;
        }

        let Some(planned_pose) = prepared.execution_start_pose.as_ref() else {
            self.friendly_vs_live.clear_deferred_plan();
            self.push_log(
                "[friendly-vs-live] plan invalidated before dispatch reason=source_pose_missing action=discard_and_replan",
            );
            return;
        };
        let fresh_pose = execution_start_pose(&fresh_snapshot.snapshot);
        if fresh_pose.as_ref() != Some(planned_pose) {
            self.friendly_vs_live.clear_deferred_plan();
            self.invalidate_live_plan_for_start_pose(
                "friendly-vs-live",
                planned_pose,
                fresh_pose.as_ref(),
            );
            return;
        }
        self.log_execution_start_pose_confirmed("friendly-vs-live", planned_pose);

        if fresh_snapshot.current_signature != planned_snapshot.current_signature {
            self.friendly_vs_live.clear_deferred_plan();
            self.suppress_friendly_vs_live_input("stale_snapshot", &fresh_snapshot);
            return;
        }

        self.friendly_vs_live.clear_skip_reason();
        self.push_log(format!(
            "[friendly-vs-live] freshness confirmed round_id={} gameid={} generation={} piece_counter={}",
            fresh_snapshot.round_id,
            fresh_snapshot.gameid,
            fresh_snapshot.capture_generation,
            piece_counter_label(fresh_snapshot.snapshot.piece_counter)
        ));
        let execution_started_at = self.monotonic_now();
        self.friendly_vs_live
            .note_execution_started_for_pacing(&fresh_snapshot, execution_started_at);
        #[cfg(test)]
        if let Ok(mut started_at) = self.zenith_live_test_hook.started_at.lock() {
            started_at.push(execution_started_at);
        }
        self.push_log(self.friendly_vs_live_execution_started_log(
            fresh_snapshot.snapshot.piece_counter,
        ));
        self.push_log(format!(
            "[friendly-vs-live] input dispatch actions={:?}",
            prepared.summary.actions
        ));
        match self.dispatch_friendly_vs_live_plan(config, prepared) {
            Ok(()) => {
                self.friendly_vs_dry_run
                    .mark_processed_snapshot(&fresh_snapshot);
                self.friendly_vs_dry_run
                    .record_attempted(&fresh_snapshot, file_signature);
                self.friendly_vs_live.record_execution();
                self.push_log(format!(
                    "[friendly-vs-live] placement executed count={}",
                    self.friendly_vs_live_count_label()
                ));
                if let Some(line) = self
                    .friendly_vs_live
                    .note_limit_locked(self.friendly_vs_live_limit())
                {
                    self.push_log(line);
                }
            }
            Err(err) => {
                self.friendly_vs_dry_run
                    .record_processed(&fresh_snapshot, file_signature);
                self.push_log(format!(
                    "[friendly-vs-live] dispatch error piece_counter={} error={err:#}",
                    piece_counter_label(planned_snapshot.snapshot.piece_counter)
                ));
            }
        }
    }

    fn suppress_zenith_live_input(&mut self, reason: &str, piece_counter: Option<u32>) {
        if reason == "max_pieces_reached" {
            return;
        }
        let skip_key = if reason == "max_pieces_reached" {
            reason.to_owned()
        } else {
            format!("{reason}:{}", piece_counter_label(piece_counter))
        };
        if let Some(line) = self.zenith_live.note_skip(
            &skip_key,
            format!(
                "[zenith-live] input suppressed reason={reason} piece_counter={}",
                piece_counter_label(piece_counter)
            ),
        ) {
            self.push_log(line);
        }
    }

    fn discard_zenith_live_deferred_plan_for_replan(&mut self) {
        self.zenith_live.clear_deferred_snapshot();
        self.zenith_dry_run.reset_processed_state();
    }

    fn defer_zenith_live_input_for_pacing(
        &mut self,
        snapshot: &ZenithPassivePlannerSnapshot,
        prepared: PreparedSnapshotExecution,
        remaining: Duration,
    ) {
        self.zenith_live.set_deferred_plan(snapshot, prepared);
        let skip_key = format!(
            "pps_pacing:{}:{}:{}:{}",
            snapshot.gameid,
            snapshot.capture_generation,
            snapshot.candidate_id,
            piece_counter_label(snapshot.snapshot.piece_counter)
        );
        if let Some(line) = self.zenith_live.note_skip(
            &skip_key,
            format!(
                "[zenith-live] input deferred reason=pps_pacing remaining_ms={} piece_counter={}",
                remaining.as_millis(),
                piece_counter_label(snapshot.snapshot.piece_counter)
            ),
        ) {
            self.push_log(line);
        }
    }

    fn try_dispatch_zenith_live_plan(
        &mut self,
        config: &AutomationConfig,
        path: &std::path::Path,
        file_signature: &str,
        planned_snapshot: &ZenithPassivePlannerSnapshot,
        prepared: &PreparedSnapshotExecution,
    ) {
        #[cfg(test)]
        if let Some(callback) = self.zenith_live_before_reread.take() {
            callback(self);
        }
        let planned_provider_generation = prepared.planned_provider_generation;

        let piece_counter = planned_snapshot.snapshot.piece_counter;
        if !self.zenith_live_input_allowed() {
            self.discard_zenith_live_deferred_plan_for_replan();
            self.suppress_zenith_live_input("live_disabled", piece_counter);
            return;
        }
        if self.state.selected_mode != RuntimeMode::Zenith
            || !self.bot_desired_enabled
            || self.bot_status != BotStatus::On
        {
            self.discard_zenith_live_deferred_plan_for_replan();
            self.suppress_zenith_live_input("bot_off", piece_counter);
            return;
        }
        if self.browser_status != BrowserStatus::Ready
            || self.input_status != InputStatus::Ready
            || !self
                .passive_provider
                .is_requested(PassiveProviderOwner::ZenithDryRun)
        {
            self.discard_zenith_live_deferred_plan_for_replan();
            self.suppress_zenith_live_input("stale_snapshot", piece_counter);
            return;
        }
        if self.passive_provider.activation_generation != planned_provider_generation {
            self.discard_zenith_live_deferred_plan_for_replan();
            self.suppress_zenith_live_input("provider_generation_changed", piece_counter);
            return;
        }
        if self.zenith_live_limit_reached() {
            self.suppress_zenith_live_input("max_pieces_reached", piece_counter);
            return;
        }

        let fresh_snapshot = match self.zenith_live_reread_snapshot(path) {
            Ok(Some(snapshot)) => snapshot,
            Ok(None) => {
                self.discard_zenith_live_deferred_plan_for_replan();
                self.suppress_zenith_live_input("stale_snapshot", piece_counter);
                return;
            }
            Err(err) => {
                self.discard_zenith_live_deferred_plan_for_replan();
                self.push_log(format!(
                    "[zenith-live] input suppressed reason=stale_snapshot error={err:#}"
                ));
                return;
            }
        };

        if fresh_snapshot.gameid != planned_snapshot.gameid {
            self.discard_zenith_live_deferred_plan_for_replan();
            self.suppress_zenith_live_input(
                "gameid_changed",
                fresh_snapshot.snapshot.piece_counter,
            );
            return;
        }
        if fresh_snapshot.capture_generation != planned_snapshot.capture_generation {
            self.discard_zenith_live_deferred_plan_for_replan();
            self.suppress_zenith_live_input(
                "generation_mismatch",
                fresh_snapshot.snapshot.piece_counter,
            );
            return;
        }
        if fresh_snapshot.candidate_id != planned_snapshot.candidate_id
            || fresh_snapshot.userid != planned_snapshot.userid
        {
            self.discard_zenith_live_deferred_plan_for_replan();
            self.suppress_zenith_live_input(
                "identity_mismatch",
                fresh_snapshot.snapshot.piece_counter,
            );
            return;
        }
        if !fresh_snapshot.playing
            || !fresh_snapshot.started
            || fresh_snapshot.countdown_started
            || fresh_snapshot.paused == Some(true)
            || fresh_snapshot.destroyed
            || fresh_snapshot.successful
            || fresh_snapshot.gameoverreason.is_some()
        {
            self.discard_zenith_live_deferred_plan_for_replan();
            self.suppress_zenith_live_input("not_playing", fresh_snapshot.snapshot.piece_counter);
            return;
        }

        let Some(planned_pose) = prepared.execution_start_pose.as_ref() else {
            self.discard_zenith_live_deferred_plan_for_replan();
            self.push_log(
                "[zenith-live] plan invalidated before dispatch reason=source_pose_missing action=discard_and_replan",
            );
            return;
        };
        let fresh_pose = execution_start_pose(&fresh_snapshot.snapshot);
        if fresh_pose.as_ref() != Some(planned_pose) {
            self.discard_zenith_live_deferred_plan_for_replan();
            self.invalidate_live_plan_for_start_pose(
                "zenith-live",
                planned_pose,
                fresh_pose.as_ref(),
            );
            return;
        }
        self.log_execution_start_pose_confirmed("zenith-live", planned_pose);

        if fresh_snapshot.current_signature != planned_snapshot.current_signature {
            self.discard_zenith_live_deferred_plan_for_replan();
            self.suppress_zenith_live_input(
                "stale_snapshot",
                fresh_snapshot.snapshot.piece_counter,
            );
            return;
        }

        self.zenith_dry_run.mark_processed_snapshot(&fresh_snapshot);
        self.zenith_dry_run
            .record_attempted(&fresh_snapshot, file_signature);
        let execution_started_at = self.monotonic_now();
        self.zenith_live.clear_skip_reason();
        self.push_log(format!(
            "[zenith-live] plan accepted piece_counter={} generation={}",
            piece_counter_label(fresh_snapshot.snapshot.piece_counter),
            fresh_snapshot.capture_generation
        ));
        self.zenith_live.start_planned(
            &fresh_snapshot,
            self.passive_provider.activation_generation,
            ZenithLiveStage::Planned,
        );
        self.zenith_live
            .note_execution_started_for_pacing(&fresh_snapshot, execution_started_at);
        #[cfg(test)]
        if let Ok(mut started_at) = self.zenith_live_test_hook.started_at.lock() {
            started_at.push(execution_started_at);
        }
        self.push_log(
            self.zenith_live_execution_started_log(fresh_snapshot.snapshot.piece_counter),
        );
        self.zenith_live.stage = ZenithLiveStage::Executing;
        match self.execute_zenith_live_plan(config, prepared) {
            Ok(()) => {
                self.push_log(format!(
                    "[zenith-live] input dispatched piece_counter={}",
                    piece_counter_label(fresh_snapshot.snapshot.piece_counter)
                ));
                if let Some(line) = self.zenith_live.note_startup_stage("first_input") {
                    self.push_log(line);
                }
                self.zenith_live.start_planned(
                    &fresh_snapshot,
                    self.passive_provider.activation_generation,
                    ZenithLiveStage::AwaitingLock,
                );
                self.push_log(format!(
                    "[zenith-live] awaiting lock piece_counter={}",
                    piece_counter_label(fresh_snapshot.snapshot.piece_counter)
                ));
            }
            Err(err) => {
                self.push_log(format!(
                    "[zenith-live] dispatch error piece_counter={} error={err:#}",
                    piece_counter_label(fresh_snapshot.snapshot.piece_counter)
                ));
                self.cancel_zenith_live_execution("dispatch_failed");
            }
        }
    }

    fn cancel_zenith_live_execution(&mut self, reason: &str) {
        if !matches!(
            self.zenith_live.stage,
            ZenithLiveStage::Planned | ZenithLiveStage::Executing | ZenithLiveStage::AwaitingLock
        ) {
            return;
        }
        let piece_counter = self.zenith_live.active_piece_counter;
        let abort_key = format!("{reason}:{}", piece_counter_label(piece_counter));
        if let Some(line) = self.zenith_live.note_abort(
            &abort_key,
            format!(
                "[zenith-live] execution aborted reason={reason} piece_counter={}",
                piece_counter_label(piece_counter)
            ),
        ) {
            self.push_log(line);
        }
        if let Err(err) = self.release_live_input_now() {
            self.push_log(format!("[input] failed to release all keys: {err:#}"));
        }
        self.zenith_live.mark_aborted();
        if matches!(
            reason,
            "bot_off"
                | "launcher_shutdown"
                | "provider_owner_missing"
                | "provider_child_exited"
                | "capture_stopped"
                | "playing_false"
                | "destroyed"
                | "successful"
                | "gameid_changed"
        ) {
            self.zenith_live.clear_pacing_state();
        }
    }

    fn update_zenith_live_lock_state(&mut self, snapshot: &ZenithPassivePlannerSnapshot) -> bool {
        if !self.zenith_live.is_waiting_for_lock() {
            return false;
        }
        if self.zenith_live.active_provider_generation
            != Some(self.passive_provider.activation_generation)
        {
            self.cancel_zenith_live_execution("provider_generation_changed");
            return true;
        }
        if self.zenith_live.active_game_id.as_deref() != Some(snapshot.gameid.as_str()) {
            self.cancel_zenith_live_execution("gameid_changed");
            return true;
        }
        if self.zenith_live.active_candidate_id.as_deref() != Some(snapshot.candidate_id.as_str()) {
            self.cancel_zenith_live_execution("identity_mismatch");
            return true;
        }
        if self.zenith_live.active_capture_generation != Some(snapshot.capture_generation) {
            self.cancel_zenith_live_execution("generation_mismatch");
            return true;
        }
        let before_piece_counter = self.zenith_live.active_piece_counter;
        if let (Some(before), Some(after)) = (before_piece_counter, snapshot.snapshot.piece_counter)
        {
            if after > before {
                let piece_limit = self.zenith_live_piece_limit();
                self.zenith_live.mark_completed();
                self.push_log(self.zenith_live_piece_completed_log(before, after));
                if piece_limit.is_reached(self.zenith_live.executed_pieces) {
                    if self.zenith_live.note_max_reached() {
                        self.push_log(format!(
                            "[zenith-live] execution suspended reason=max_pieces_reached executed={} max={}",
                            self.zenith_live.executed_pieces,
                            piece_limit
                                .bounded_value()
                                .expect("bounded limit required for max reached log")
                        ));
                    }
                }
                return false;
            }
        }
        let timed_out = self
            .zenith_live
            .started_at
            .map(|started_at| {
                started_at.elapsed() >= Duration::from_millis(ZENITH_LIVE_LOCK_TIMEOUT_MS)
            })
            .unwrap_or(false);
        if timed_out {
            self.cancel_zenith_live_execution("lock_timeout");
            return true;
        }
        true
    }

    fn open_browser(&mut self) {
        if self.browser_session.is_some() {
            return;
        }

        self.save_state();
        self.browser_status = BrowserStatus::Starting;
        self.snapshot_status = SnapshotStatus::Starting;
        self.input_status = InputStatus::Starting;
        self.push_log("[launcher] opening Chromium");

        let mut host = match ChromiumHostProcess::start(
            &self.paths,
            &self.state.browser,
            self.browser_logger(),
        ) {
            Ok(process) => {
                self.push_log("[browser-host] ready");
                process
            }
            Err(err) => {
                self.browser_status = BrowserStatus::Error;
                self.snapshot_status = SnapshotStatus::Error;
                self.input_status = InputStatus::Error;
                self.push_log(format!("[launcher] failed to open Chromium: {err:#}"));
                return;
            }
        };

        let config = self.state.to_bot_automation_config(&self.paths);
        self.push_log("[snapshot] connecting");
        let mut snapshot_provider =
            match ProviderProcess::start_prewarmed(&self.paths, &config, self.browser_logger()) {
                Ok(process) => {
                    self.push_log("[snapshot] ready");
                    process
                }
                Err(err) => {
                    let _ = host.shutdown();
                    self.browser_status = BrowserStatus::Error;
                    self.snapshot_status = SnapshotStatus::Error;
                    self.input_status = InputStatus::Error;
                    self.push_log(format!("[launcher] snapshot helper failed: {err:#}"));
                    return;
                }
            };
        if let Err(err) = snapshot_provider.set_selected_mode(
            self.state.selected_mode.control_value(),
            self.state.mode_generation,
        ) {
            self.push_log(format!(
                "[browser] failed to forward selected mode to snapshot provider: {err:#}"
            ));
        }
        if let Err(err) = snapshot_provider
            .set_local_tetrio_username(self.local_tetrio_username_hint().as_deref())
        {
            self.push_log(format!(
                "[browser] failed to forward local_tetrio_username to snapshot provider: {err:#}"
            ));
        }

        self.push_log("[input] connecting");
        let input_backend = match BrowserCdpInputBackend::shared(&self.paths, &config) {
            Ok(shared) => {
                self.push_log("[input] ready");
                shared
            }
            Err(err) => {
                snapshot_provider.stop();
                let _ = host.shutdown();
                self.browser_status = BrowserStatus::Error;
                self.snapshot_status = SnapshotStatus::Error;
                self.input_status = InputStatus::Error;
                self.push_log(format!("[launcher] input helper failed: {err:#}"));
                return;
            }
        };

        self.browser_session = Some(BrowserSession {
            host,
            snapshot_provider,
            input_backend,
            provider_started_at: Instant::now(),
            last_used_token: Arc::new(Mutex::new(None)),
        });
        self.browser_status = BrowserStatus::Ready;
        self.input_status = InputStatus::Ready;
        self.refresh_snapshot_status();
        self.push_log("[launcher] browser runtime ready");
    }

    fn start_bot(&mut self) {
        self.bot_desired_enabled = true;
        self.bot_restart_pending = false;
        self.start_bot_with_mode(BotStartMode::UserInitiated);
    }

    fn start_bot_with_mode(&mut self, mode: BotStartMode) {
        let browser_ready = self.browser_status == BrowserStatus::Ready;
        let input_ready = self.input_status == InputStatus::Ready;
        let snapshot_running = matches!(
            self.snapshot_status,
            SnapshotStatus::WaitingForGame | SnapshotStatus::Ready
        );
        if self.bot_session.is_some() || !browser_ready || !input_ready || !snapshot_running {
            self.bot_status = if mode == BotStartMode::AutoResume {
                BotStatus::Starting
            } else {
                BotStatus::Error
            };
            if mode == BotStartMode::UserInitiated {
                self.bot_desired_enabled = false;
                self.push_log("[launcher] bot on blocked: browser runtime is not ready");
            }
            return;
        }

        if self.state.selected_mode != RuntimeMode::Solo {
            if mode == BotStartMode::UserInitiated {
                self.save_state();
                self.push_log("[launcher] bot on");
            }
            self.sync_browser_local_tetrio_username();
            if self.state.selected_mode == RuntimeMode::FriendlyVs {
                self.sync_friendly_vs_capture_enabled(false, None, None);
                self.prepare_friendly_vs_observer_arm();
            }
            if self.state.selected_mode == RuntimeMode::Zenith {
                self.sync_requested_passive_provider_username_hint();
            }
            if self.state.selected_mode == RuntimeMode::Zenith
                && !self.set_passive_provider_owner(PassiveProviderOwner::ZenithDryRun, true)
            {
                self.bot_status = BotStatus::Error;
                if mode == BotStartMode::UserInitiated {
                    self.bot_desired_enabled = false;
                }
                return;
            }
            let set_bot_enabled_result = if let Some(session) = self.browser_session.as_mut() {
                session.snapshot_provider.set_bot_enabled(true)
            } else {
                Ok(())
            };
            if let Err(err) = set_bot_enabled_result {
                self.push_log(format!(
                    "[browser] failed to forward bot on state to snapshot provider: {err:#}"
                ));
                if self.state.selected_mode == RuntimeMode::Zenith {
                    let _ =
                        self.set_passive_provider_owner(PassiveProviderOwner::ZenithDryRun, false);
                }
                if self.state.selected_mode == RuntimeMode::FriendlyVs {
                    self.sync_friendly_vs_capture_enabled(false, None, None);
                    if let Some(line) = self.friendly_vs.note_stopped() {
                        self.push_log(line);
                    }
                }
                self.bot_status = BotStatus::Error;
                if mode == BotStartMode::UserInitiated {
                    self.bot_desired_enabled = false;
                }
                return;
            }
            self.bot_status = BotStatus::On;
            self.bot_waiting_for_next_game = false;
            self.bot_restart_pending = false;
            self.zenith_dry_run.reset();
            self.zenith_live.reset();
            self.friendly_vs_live
                .set_session_pacing(self.state.pps_unlimited, self.state.target_pps);
            self.zenith_live.session_max_pieces = self.state.effective_zenith_live_max_pieces();
            self.zenith_live
                .set_session_pacing(self.state.pps_unlimited, self.state.target_pps);
            if self.state.selected_mode == RuntimeMode::Zenith {
                self.zenith_live.start_startup_session();
                self.push_log(self.zenith_live_session_armed_log());
            }
            self.push_log(format!(
                "[mode] bot enabled mode={} generation={}",
                self.state.selected_mode.control_value(),
                self.state.mode_generation
            ));
            if self.state.selected_mode == RuntimeMode::FriendlyVs {
                if self.state.friendly_vs_live_input_enabled {
                    self.push_log(self.friendly_vs_live_session_armed_log());
                } else {
                    self.push_log("[friendly-vs-live] input disabled mode=dry_run".to_owned());
                }
            }
            if self.state.selected_mode == RuntimeMode::Zenith {
                self.push_log("[zenith-dry-run] controller armed");
            }
            return;
        }

        let Some((shared_input_backend, last_used_token_handle, last_used_token_seed)) =
            self.browser_session.as_ref().map(|session| {
                (
                    session.input_backend.clone(),
                    session.last_used_token.clone(),
                    session
                        .last_used_token
                        .lock()
                        .ok()
                        .and_then(|guard| guard.clone()),
                )
            })
        else {
            self.bot_status = BotStatus::Error;
            if mode == BotStartMode::UserInitiated {
                self.bot_desired_enabled = false;
            }
            self.push_log("[launcher] bot on blocked: browser session missing");
            return;
        };

        if mode == BotStartMode::UserInitiated {
            self.save_state();
            self.push_log("[launcher] bot on");
            if let Some(session) = self.browser_session.as_mut() {
                if let Err(err) = session.snapshot_provider.set_bot_enabled(true) {
                    self.push_log(format!(
                        "[browser] failed to forward bot on state to snapshot provider: {err:#}"
                    ));
                }
            }
        }
        self.bot_status = BotStatus::Starting;
        self.push_log("[bot] starting runner with prewarmed snapshot/input");

        let latest_snapshot = self.read_latest_snapshot_info();
        if let Some(snapshot) = latest_snapshot.as_ref() {
            self.push_log(format!(
                "[bot] latest snapshot token={} age_ms={}",
                snapshot.token, snapshot.age_ms
            ));
        } else {
            self.push_log("[bot] latest snapshot not ready yet; waiting for provider update");
        }
        if mode == BotStartMode::AutoResume {
            if let Some(snapshot) = latest_snapshot.as_ref() {
                if let Some(epoch) = extract_snapshot_epoch(&snapshot.token) {
                    self.push_log(format!("[bot] runner resumed for game epoch={epoch}"));
                    self.bot_waiting_for_next_game = false;
                }
            } else if !self.bot_waiting_for_next_game {
                self.push_log("[bot] waiting for next game while remaining enabled");
                self.bot_waiting_for_next_game = true;
            }
        }

        let config = self.state.to_bot_automation_config(&self.paths);
        self.push_log(format!(
            "[bot] style={} target_pps={}",
            config.play_style.log_label(),
            format_target_pps_label(config.target_pps)
        ));
        self.push_log(format!(
            "[bot] evaluation_profile={} route_profile={}",
            config.evaluation_profile.log_label(),
            config.route_profile.log_label()
        ));
        if config.play_style == PlayStyleConfig::Speed {
            self.push_log("[bot] speed priorities=non_spin,short_input,no_softdrop");
        }
        let scanner = JsonFileScanner::with_last_token(
            config.snapshot_path.clone(),
            Duration::from_millis(config.min_snapshot_age_ms),
            last_used_token_seed,
        );

        let input_backend: Box<dyn InputBackend + Send> = if config.dry_run {
            Box::new(DebugLogBackend::new())
        } else {
            Box::new(BrowserCdpInputBackend::from_shared(shared_input_backend))
        };

        let stop = Arc::new(AtomicBool::new(false));
        let live_target_pps = Arc::new(AtomicU32::new(config.target_pps.to_bits()));
        let worker_stop = stop.clone();
        let worker_target_pps = live_target_pps.clone();
        let tx = self.event_tx.clone();
        let last_used_token = last_used_token_handle;
        let automation_thread = thread::spawn(move || {
            let log_tx = tx.clone();
            let result = run_automation_with_resources_and_live_pps(
                config,
                scanner,
                input_backend,
                &worker_stop,
                worker_target_pps,
                move |line| {
                    if let Some(token) = extract_planned_token(&line) {
                        if let Ok(mut guard) = last_used_token.lock() {
                            *guard = Some(token);
                        }
                    }
                    let _ = log_tx.send(LauncherEvent::BotLog(line));
                },
            )
            .map_err(|err| format!("{err:#}"));
            let _ = tx.send(LauncherEvent::BotExited(result));
        });

        self.bot_session = Some(BotSession {
            stop,
            live_target_pps,
            automation_thread: Some(automation_thread),
        });
        self.bot_restart_pending = false;
        self.bot_status = BotStatus::On;
        self.push_log("[bot] planner started");
    }

    fn stop_bot(&mut self) {
        self.stop_bot_with_browser_hint(self.browser_session.is_some());
    }

    fn stop_bot_with_browser_hint(&mut self, browser_remains_open: bool) {
        self.bot_desired_enabled = false;
        self.bot_waiting_for_next_game = false;
        self.bot_restart_pending = false;
        self.cancel_zenith_live_execution("bot_off");
        self.sync_friendly_vs_capture_enabled(false, None, None);
        self.friendly_vs_dry_run.reset();
        self.friendly_vs_live.clear_pacing_state();
        self.zenith_dry_run.reset();
        self.zenith_live.reset();
        let had_runner = self.bot_session.is_some();
        if let Some(mut bot) = self.bot_session.take() {
            self.ignore_next_bot_exit = true;
            bot.stop();
            self.push_log("[bot] runner stopped");
            if browser_remains_open {
                self.push_log("[snapshot] provider remains active");
            }
        }
        if browser_remains_open || had_runner {
            self.release_live_input_with_log();
        }
        if let Some(session) = self.browser_session.as_mut() {
            if let Err(err) = session.snapshot_provider.set_bot_enabled(false) {
                self.push_log(format!(
                    "[browser] failed to forward bot off state to snapshot provider: {err:#}"
                ));
            }
        }
        let _ = self.set_passive_provider_owner(PassiveProviderOwner::ZenithDryRun, false);
        self.bot_status = BotStatus::Off;
    }

    fn select_mode(&mut self, next_mode: RuntimeMode) {
        if self.state.selected_mode == next_mode {
            return;
        }
        if self.bot_desired_enabled
            || self.bot_session.is_some()
            || matches!(self.bot_status, BotStatus::Starting | BotStatus::On)
        {
            self.stop_bot_with_browser_hint(self.browser_session.is_some());
        }
        self.state.selected_mode = next_mode;
        self.state.mode_generation = self.state.mode_generation.saturating_add(1);
        self.sync_friendly_vs_capture_enabled(false, None, None);
        if next_mode != RuntimeMode::Zenith {
            self.clear_passive_provider_owners();
        }
        self.friendly_vs_dry_run.reset();
        self.zenith_dry_run.reset();
        self.zenith_live.reset();
        self.push_log(format!(
            "[mode] selected mode={}",
            self.state.selected_mode.control_value()
        ));
        if let Some(session) = self.browser_session.as_mut() {
            if let Err(err) = session.snapshot_provider.set_selected_mode(
                self.state.selected_mode.control_value(),
                self.state.mode_generation,
            ) {
                self.push_log(format!(
                    "[browser] failed to forward selected mode to snapshot provider: {err:#}"
                ));
            }
        }
        self.save_state();
    }

    fn close_browser(&mut self) {
        if self.bot_session.is_some() {
            self.stop_bot_with_browser_hint(false);
        }
        self.cancel_zenith_live_execution("launcher_shutdown");

        if let Some(mut session) = self.browser_session.take() {
            self.push_log("[launcher] closing Chromium");
            let _ = self.release_input_from_session(&session);
            session.snapshot_provider.stop();
            if let Ok(mut backend) = session.input_backend.lock() {
                let _ = backend.shutdown();
            }
            match session.host.shutdown() {
                Ok(()) => self.push_log("[launcher] browser closed"),
                Err(err) => self.push_log(format!("[launcher] browser shutdown failed: {err:#}")),
            }
        }

        self.browser_status = BrowserStatus::Closed;
        self.snapshot_status = SnapshotStatus::Closed;
        self.input_status = InputStatus::Closed;
        self.friendly_vs_capture_enabled = false;
        self.friendly_vs_capture_round_id = None;
        self.friendly_vs_capture_local_game_id = None;
        self.latest_snapshot_token = None;
        self.latest_snapshot_age_ms = None;
        self.passive_provider.reset();
        self.friendly_vs_dry_run.reset();
        self.friendly_vs_live.reset();
        self.zenith_dry_run.reset();
        self.zenith_live.reset();
    }

    fn release_shared_input_now(&self) -> Result<()> {
        let Some(session) = self.browser_session.as_ref() else {
            return Ok(());
        };
        self.release_input_from_session(session)
    }

    fn release_input_from_session(&self, session: &BrowserSession) -> Result<()> {
        let mut backend = session
            .input_backend
            .lock()
            .map_err(|_| anyhow::anyhow!("shared browser input backend lock poisoned"))?;
        backend.release_all_keys()
    }

    fn read_latest_snapshot_info(&self) -> Option<SnapshotInfo> {
        let snapshot_path = self.paths.resolve_workspace_path(&self.state.snapshot_path);
        let metadata = fs::metadata(&snapshot_path).ok()?;
        let modified_at = metadata.modified().ok()?;
        let age_ms = modified_at.elapsed().ok()?.as_millis();
        let snapshot = read_snapshot_file(&snapshot_path).ok()?;
        if snapshot.token.trim().is_empty() {
            return None;
        }
        Some(SnapshotInfo {
            token: snapshot.token,
            age_ms,
            playing: snapshot.playing,
        })
    }

    fn refresh_snapshot_status(&mut self) {
        let Some(session) = self.browser_session.as_ref() else {
            self.snapshot_status = SnapshotStatus::Closed;
            self.latest_snapshot_token = None;
            self.latest_snapshot_age_ms = None;
            return;
        };

        if let Some(snapshot) = self.read_latest_snapshot_info() {
            self.latest_snapshot_token = Some(snapshot.token.clone());
            self.latest_snapshot_age_ms = Some(snapshot.age_ms);
            if snapshot.playing && snapshot.age_ms <= 500 {
                self.snapshot_status = SnapshotStatus::Ready;
            } else {
                self.snapshot_status = SnapshotStatus::WaitingForGame;
            }
        } else if session.provider_started_at.elapsed() >= Duration::from_millis(200) {
            self.snapshot_status = SnapshotStatus::WaitingForGame;
            self.latest_snapshot_token = None;
            self.latest_snapshot_age_ms = None;
        } else {
            self.snapshot_status = SnapshotStatus::Starting;
        }
    }

    fn poll_browser_runtime(&mut self) {
        let Some(session) = self.browser_session.as_mut() else {
            return;
        };

        let host_running = match session.host.is_running() {
            Ok(true) => {}
            Ok(false) => {
                let _ = self.event_tx.send(LauncherEvent::BrowserExited(Ok(())));
                return;
            }
            Err(err) => {
                let _ = self
                    .event_tx
                    .send(LauncherEvent::BrowserExited(Err(format!("{err:#}"))));
                return;
            }
        };
        let _ = host_running;

        let snapshot_result = session.snapshot_provider.is_running();
        let input_result = match session.input_backend.lock() {
            Ok(mut backend) => backend.is_running(),
            Err(_) => Err(anyhow::anyhow!(
                "shared browser input backend lock poisoned"
            )),
        };
        let _ = session;

        match snapshot_result {
            Ok(true) => {}
            Ok(false) => {
                if self.snapshot_status != SnapshotStatus::Error {
                    self.snapshot_status = SnapshotStatus::Error;
                    self.browser_status = BrowserStatus::Error;
                    self.push_log("[snapshot] provider exited unexpectedly");
                }
            }
            Err(err) => {
                if self.snapshot_status != SnapshotStatus::Error {
                    self.snapshot_status = SnapshotStatus::Error;
                    self.browser_status = BrowserStatus::Error;
                    self.push_log(format!("[snapshot] provider status failed: {err:#}"));
                }
            }
        }

        match input_result {
            Ok(true) => {}
            Ok(false) => {
                if self.input_status != InputStatus::Error {
                    self.input_status = InputStatus::Error;
                    self.browser_status = BrowserStatus::Error;
                    self.push_log("[input] helper exited unexpectedly");
                }
            }
            Err(err) => {
                if self.input_status != InputStatus::Error {
                    self.input_status = InputStatus::Error;
                    self.browser_status = BrowserStatus::Error;
                    self.push_log(format!("[input] helper status failed: {err:#}"));
                }
            }
        }

        if self.snapshot_status != SnapshotStatus::Error {
            self.refresh_snapshot_status();
        }
    }

    fn handle_browser_exited(&mut self, result: Result<(), String>) {
        if self.bot_session.is_some() {
            self.push_log("[launcher] browser closed while bot was on");
            self.stop_bot_with_browser_hint(false);
        }
        if let Some(mut session) = self.browser_session.take() {
            session.snapshot_provider.stop();
            if let Ok(mut backend) = session.input_backend.lock() {
                let _ = backend.shutdown();
            }
        }
        match result {
            Ok(()) => self.push_log("[browser-host] Chromium exited"),
            Err(err) => self.push_log(format!("[launcher] browser exited with error: {err}")),
        }
        self.browser_status = BrowserStatus::Closed;
        self.snapshot_status = SnapshotStatus::Closed;
        self.input_status = InputStatus::Closed;
        self.friendly_vs_capture_enabled = false;
        self.friendly_vs_capture_round_id = None;
        self.friendly_vs_capture_local_game_id = None;
        self.latest_snapshot_token = None;
        self.latest_snapshot_age_ms = None;
        self.bot_desired_enabled = false;
        self.bot_waiting_for_next_game = false;
        self.bot_restart_pending = false;
        self.passive_provider.reset();
        self.friendly_vs_dry_run.reset();
        self.friendly_vs_live.reset();
        self.zenith_dry_run.reset();
        self.push_log("[launcher] browser closed");
    }

    fn log_passive_provider_transition(&mut self, transition: PassiveProviderTransition) {
        match transition.lifecycle {
            PassiveProviderLifecycle::Activated => self.push_log(format!(
                "{} passive provider requested owner={} generation={} owners={}",
                transition.owner.log_prefix(),
                transition.owner.control_value(),
                transition.activation_generation,
                self.passive_provider.owners_label()
            )),
            PassiveProviderLifecycle::OwnerAdded => self.push_log(format!(
                "[quick-play] passive provider owner added owner={} owners={}",
                transition.owner.control_value(),
                self.passive_provider.owners_label()
            )),
            PassiveProviderLifecycle::OwnerReleased => self.push_log(format!(
                "{} passive provider owner released owner={} owners={}",
                transition.owner.log_prefix(),
                transition.owner.control_value(),
                self.passive_provider.owners_label()
            )),
            PassiveProviderLifecycle::Deactivated => self.push_log(format!(
                "{} passive provider stopped owner={} generation={}",
                transition.owner.log_prefix(),
                transition.owner.control_value(),
                transition.activation_generation
            )),
        }
    }

    fn set_passive_provider_owner(&mut self, owner: PassiveProviderOwner, enabled: bool) -> bool {
        let previous = self.passive_provider.clone();
        let transition = if enabled {
            self.passive_provider.request(owner)
        } else {
            self.passive_provider.release(owner)
        };
        let Some(transition) = transition else {
            return true;
        };

        let username_hint = if enabled {
            self.local_tetrio_username_hint()
        } else {
            None
        };
        let control_result = if let Some(session) = self.browser_session.as_mut() {
            session.snapshot_provider.set_quick_play_passive_provider(
                owner.control_value(),
                enabled,
                username_hint.as_deref(),
            )
        } else {
            self.passive_provider = previous;
            self.push_log(format!(
                "{} passive provider unavailable owner={} reason=browser_runtime_not_ready",
                owner.log_prefix(),
                owner.control_value()
            ));
            return false;
        };

        match control_result {
            Ok(()) => {
                self.log_passive_provider_transition(transition);
                true
            }
            Err(err) => {
                self.passive_provider = previous;
                self.push_log(format!(
                    "{} passive provider unavailable owner={} error={err:#}",
                    owner.log_prefix(),
                    owner.control_value()
                ));
                false
            }
        }
    }

    fn clear_passive_provider_owners(&mut self) {
        if self.browser_session.is_none() {
            self.passive_provider.reset();
            return;
        }
        let manual_requested = self
            .passive_provider
            .is_requested(PassiveProviderOwner::ManualDiagnostic);
        let zenith_requested = self
            .passive_provider
            .is_requested(PassiveProviderOwner::ZenithDryRun);
        if manual_requested {
            let _ = self.set_passive_provider_owner(PassiveProviderOwner::ManualDiagnostic, false);
        }
        if zenith_requested {
            let _ = self.set_passive_provider_owner(PassiveProviderOwner::ZenithDryRun, false);
        }
    }

    fn zenith_passive_snapshot_path(&self) -> std::path::PathBuf {
        self.paths
            .resolve_workspace_path(ZENITH_PASSIVE_SNAPSHOT_RELATIVE_PATH)
    }

    fn friendly_vs_passive_snapshot_path(&self) -> std::path::PathBuf {
        self.paths
            .resolve_workspace_path(FRIENDLY_VS_PASSIVE_SNAPSHOT_RELATIVE_PATH)
    }

    fn friendly_vs_bridge_path(&self) -> std::path::PathBuf {
        let snapshot_path = self.paths.resolve_workspace_path(&self.state.snapshot_path);
        vs_bridge_path_for_snapshot(&snapshot_path)
    }

    fn friendly_vs_runtime_ready(&self) -> bool {
        self.state.selected_mode == RuntimeMode::FriendlyVs
            && self.bot_desired_enabled
            && self.bot_status == BotStatus::On
            && self.browser_status == BrowserStatus::Ready
            && self.input_status == InputStatus::Ready
            && matches!(
                self.snapshot_status,
                SnapshotStatus::WaitingForGame | SnapshotStatus::Ready
            )
    }

    fn current_wall_clock_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
            .unwrap_or(0)
    }

    fn zenith_passive_snapshot_file_signature(&self, path: &std::path::Path) -> String {
        match fs::metadata(path) {
            Ok(metadata) => {
                let modified_ms = metadata
                    .modified()
                    .ok()
                    .and_then(|timestamp| timestamp.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis())
                    .unwrap_or(0);
                format!("len={} modified_ms={modified_ms}", metadata.len())
            }
            Err(err) => format!("metadata_error={:?}", err.kind()),
        }
    }

    fn note_snapshot_provider_control_failure(&mut self, control_name: &str, err: &anyhow::Error) {
        if self.snapshot_status == SnapshotStatus::Error
            && self.browser_status == BrowserStatus::Error
        {
            return;
        }
        self.snapshot_status = SnapshotStatus::Error;
        self.browser_status = BrowserStatus::Error;
        self.friendly_vs_capture_enabled = false;
        self.friendly_vs_capture_round_id = None;
        self.friendly_vs_capture_local_game_id = None;
        self.push_log(format!(
            "[browser] failed to forward {control_name} to snapshot provider: {err:#}"
        ));
    }

    fn sync_friendly_vs_capture_enabled(
        &mut self,
        enabled: bool,
        round_id: Option<&str>,
        local_gameid: Option<&str>,
    ) -> bool {
        if self.snapshot_status == SnapshotStatus::Error
            || self.browser_status == BrowserStatus::Error
        {
            return false;
        }
        let next_round_id = if enabled {
            round_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        } else {
            None
        };
        let next_local_game_id = if enabled {
            local_gameid
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        } else {
            None
        };
        if self.friendly_vs_capture_enabled == enabled
            && self.friendly_vs_capture_round_id == next_round_id
            && self.friendly_vs_capture_local_game_id == next_local_game_id
        {
            return true;
        }
        let result = if let Some(session) = self.browser_session.as_mut() {
            session
                .snapshot_provider
                .set_friendly_vs_capture_enabled(
                    enabled,
                    next_round_id.as_deref(),
                    next_local_game_id.as_deref(),
                )
        } else {
            Ok(())
        };
        match result {
            Ok(()) => {
                self.friendly_vs_capture_enabled = enabled;
                self.friendly_vs_capture_round_id = next_round_id;
                self.friendly_vs_capture_local_game_id = next_local_game_id;
                true
            }
            Err(err) => {
                self.note_snapshot_provider_control_failure("friendly_vs_capture_enabled", &err);
                false
            }
        }
    }

    fn prepare_friendly_vs_observer_arm(&mut self) {
        if self.state.selected_mode != RuntimeMode::FriendlyVs || !self.bot_desired_enabled {
            return;
        }
        self.friendly_vs.reset();
        let baseline = read_vs_bridge_observation(&self.friendly_vs_bridge_path())
            .ok()
            .flatten();
        if let Some(line) = self
            .friendly_vs
            .note_armed(self.current_wall_clock_ms(), baseline.as_ref())
        {
            self.push_log(line);
        }
    }

    fn poll_friendly_vs_observer(&mut self) {
        if self.state.selected_mode != RuntimeMode::FriendlyVs || !self.bot_desired_enabled {
            self.sync_friendly_vs_capture_enabled(false, None, None);
            if let Some(line) = self.friendly_vs.note_stopped() {
                self.push_log(line);
            }
            return;
        }
        if self.bot_status != BotStatus::On || !self.friendly_vs_runtime_ready() {
            self.sync_friendly_vs_capture_enabled(false, None, None);
            if let Some(line) = self.friendly_vs.note_stopped() {
                self.push_log(line);
            }
            return;
        }
        let path = self.friendly_vs_bridge_path();
        let observation = match read_vs_bridge_observation(&path) {
            Ok(Some(observation)) => observation,
            Ok(None) => {
                if let Some(line) = self
                    .friendly_vs
                    .note_armed(self.current_wall_clock_ms(), None)
                {
                    self.push_log(line);
                }
                self.sync_friendly_vs_capture_enabled(false, None, None);
                if let Some(line) = self.friendly_vs.note_waiting("bridge_not_fresh") {
                    self.push_log(line);
                }
                return;
            }
            Err(err) => {
                if let Some(line) = self
                    .friendly_vs
                    .note_armed(self.current_wall_clock_ms(), None)
                {
                    self.push_log(line);
                }
                self.sync_friendly_vs_capture_enabled(false, None, None);
                let error = format!("{err:#}");
                if let Some(line) = self.friendly_vs.note_bridge_error(&error) {
                    self.push_log(line);
                }
                return;
            }
        };
        if let Some(line) = self
            .friendly_vs
            .note_armed(self.current_wall_clock_ms(), Some(&observation))
        {
            self.push_log(line);
        }
        if !self.friendly_vs.is_fresh_bridge(&observation) {
            self.sync_friendly_vs_capture_enabled(false, None, None);
            if let Some(line) = self.friendly_vs.note_waiting("bridge_not_fresh") {
                self.push_log(line);
            }
            return;
        }
        self.friendly_vs.observe_fresh_bridge(&observation);
        if let Some(line) = self.friendly_vs.observe_round(&observation.round_id) {
            self.push_log(line);
        }
        let Some(local_userid) = observation
            .local_userid
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        else {
            self.sync_friendly_vs_capture_enabled(false, None, None);
            self.friendly_vs.clear_ready_state();
            return;
        };
        if let Some(line) = self.friendly_vs.note_identity_ready(
            local_userid,
            &observation.local_game_id,
            &observation.round_id,
        ) {
            self.push_log(line);
        }
        let bagtype = observation.bagtype.as_deref().unwrap_or("missing");
        let nextcount = observation.next_count.unwrap_or_default();
        if let Some(line) =
            self.friendly_vs
                .note_options_ready(&observation.seed, bagtype, nextcount)
        {
            self.push_log(line);
        }
        let round_live =
            observation.active && self.current_wall_clock_ms() >= observation.ready_at_ms;
        if round_live {
            if let Some(line) = self.friendly_vs.note_round_active(
                &observation.round_id,
                observation.opponent_count,
                observation.incoming_garbage_count,
            ) {
                self.push_log(line);
            }
            self.sync_friendly_vs_capture_enabled(
                true,
                Some(&observation.round_id),
                Some(&observation.local_game_id),
            );
        } else if let Some(line) = self.friendly_vs.note_round_ended(&observation.round_id) {
            self.push_log(line);
            self.sync_friendly_vs_capture_enabled(false, None, None);
        } else {
            self.sync_friendly_vs_capture_enabled(false, None, None);
        }
    }

    fn defer_friendly_vs_live_input_for_pacing(
        &mut self,
        snapshot: &FriendlyVsPassivePlannerSnapshot,
        prepared: PreparedSnapshotExecution,
        remaining: Duration,
    ) {
        self.friendly_vs_live.set_deferred_plan(snapshot, prepared);
        let skip_key = format!(
            "pps_pacing:{}:{}:{}:{}",
            snapshot.gameid,
            snapshot.capture_generation,
            snapshot.candidate_id,
            piece_counter_label(snapshot.snapshot.piece_counter)
        );
        if let Some(line) = self.friendly_vs_live.note_skip(
            &skip_key,
            format!(
                "[friendly-vs-live] input deferred reason=pps_pacing remaining_ms={} piece_counter={}",
                remaining.as_millis(),
                piece_counter_label(snapshot.snapshot.piece_counter)
            ),
        ) {
            self.push_log(line);
        }
    }

    fn poll_friendly_vs_dry_run(&mut self) {
        if self.state.selected_mode != RuntimeMode::FriendlyVs {
            self.friendly_vs_dry_run.reset();
            return;
        }
        if !self.bot_desired_enabled
            || self.bot_status != BotStatus::On
            || !self.friendly_vs_runtime_ready()
        {
            self.friendly_vs_dry_run.reset();
            return;
        }
        let Some(active_round_id) = self.friendly_vs.active_round_id.as_deref() else {
            self.friendly_vs_dry_run.reset();
            return;
        };
        let Some(active_game_id) = self.friendly_vs.resolved_game_id.as_deref() else {
            self.friendly_vs_dry_run.reset();
            return;
        };

        let path = self.friendly_vs_passive_snapshot_path();
        let file_signature = self.zenith_passive_snapshot_file_signature(&path);
        let read_result = match read_friendly_vs_passive_snapshot_file_with_age(&path) {
            Ok(Some(value)) => value,
            Ok(None) => {
                if let Some(line) = self.friendly_vs_dry_run.note_skip(
                    &format!("snapshot_missing:{file_signature}"),
                    "[friendly-vs-dry-run] snapshot skipped reason=snapshot_missing".to_owned(),
                ) {
                    self.push_log(line);
                }
                return;
            }
            Err(err) => {
                let error = format!("{err:#}");
                if let Some(line) = self.friendly_vs_dry_run.note_skip(
                    &friendly_vs_snapshot_parse_skip_key(&error),
                    format!(
                        "[friendly-vs-dry-run] snapshot skipped reason=semantic_invalid error={error}"
                    ),
                ) {
                    self.push_log(line);
                }
                self.friendly_vs_dry_run.reset_processed_state();
                return;
            }
        };
        let (envelope, age) = read_result;
        let Some(snapshot) = envelope.snapshot.as_ref() else {
            let skip = if envelope.capture_status.as_deref() == Some("stopped") {
                (
                    "capture_stopped".to_owned(),
                    "[friendly-vs-dry-run] snapshot skipped reason=capture_stopped".to_owned(),
                )
            } else if let Some(error) = envelope.semantic_error.as_deref() {
                (
                    format!("semantic_invalid:{error}"),
                    format!(
                        "[friendly-vs-dry-run] snapshot skipped reason=semantic_invalid error={error}"
                    ),
                )
            } else {
                (
                    "semantic_invalid".to_owned(),
                    "[friendly-vs-dry-run] snapshot skipped reason=semantic_invalid".to_owned(),
                )
            };
            if let Some(line) = self.friendly_vs_dry_run.note_skip(&skip.0, skip.1) {
                self.push_log(line);
            }
            self.friendly_vs_dry_run.reset_processed_state();
            return;
        };

        if self.friendly_vs_dry_run.last_round_id.as_deref() != Some(snapshot.round_id.as_str())
            || self.friendly_vs_dry_run.last_game_id.as_deref() != Some(snapshot.gameid.as_str())
            || self.friendly_vs_dry_run.last_capture_generation != Some(snapshot.capture_generation)
            || self.friendly_vs_dry_run.last_candidate_id.as_deref()
                != Some(snapshot.candidate_id.as_str())
        {
            self.friendly_vs_dry_run.reset_processed_state();
        }
        self.friendly_vs_live.sync_session(
            &snapshot.round_id,
            &snapshot.gameid,
            snapshot.capture_generation,
        );

        if envelope.status != "ready" {
            if let Some(line) = self.friendly_vs_dry_run.note_skip(
                "semantic_invalid",
                "[friendly-vs-dry-run] snapshot skipped reason=semantic_invalid".to_owned(),
            ) {
                self.push_log(line);
            }
            return;
        }
        if envelope.capture_status.as_deref() != Some("running") {
            if let Some(line) = self.friendly_vs_dry_run.note_skip(
                "capture_stopped",
                "[friendly-vs-dry-run] snapshot skipped reason=capture_stopped".to_owned(),
            ) {
                self.push_log(line);
            }
            self.friendly_vs_dry_run.reset_processed_state();
            return;
        }
        if age
            .map(|value| value.as_millis() > u128::from(MAX_SNAPSHOT_AGE_MS))
            .unwrap_or(false)
        {
            if let Some(line) = self.friendly_vs_dry_run.note_skip(
                "stale",
                "[friendly-vs-dry-run] snapshot skipped reason=stale".to_owned(),
            ) {
                self.push_log(line);
            }
            return;
        }
        if snapshot.round_id != active_round_id {
            if let Some(line) = self.friendly_vs_dry_run.note_skip(
                &format!("round_id_mismatch:{}:{}", snapshot.round_id, active_round_id),
                format!(
                    "[friendly-vs-dry-run] snapshot skipped reason=round_id_mismatch snapshot_round_id={} current_round_id={}",
                    snapshot.round_id, active_round_id
                ),
            ) {
                self.push_log(line);
            }
            self.friendly_vs_dry_run.reset_processed_state();
            return;
        }
        if snapshot.gameid != active_game_id {
            if let Some(line) = self.friendly_vs_dry_run.note_skip(
                &format!("gameid_mismatch:{}:{}", snapshot.gameid, active_game_id),
                format!(
                    "[friendly-vs-dry-run] snapshot skipped reason=gameid_mismatch snapshot_gameid={} current_gameid={}",
                    snapshot.gameid, active_game_id
                ),
            ) {
                self.push_log(line);
            }
            self.friendly_vs_dry_run.reset_processed_state();
            return;
        }
        if !snapshot.playing || !snapshot.started {
            if let Some(line) = self.friendly_vs_dry_run.note_skip(
                "not_playing",
                "[friendly-vs-dry-run] snapshot skipped reason=not_playing".to_owned(),
            ) {
                self.push_log(line);
            }
            self.friendly_vs_dry_run.reset_processed_state();
            return;
        }
        if snapshot.countdown_started {
            if let Some(line) = self.friendly_vs_dry_run.note_skip(
                "countdown",
                "[friendly-vs-dry-run] snapshot skipped reason=countdown".to_owned(),
            ) {
                self.push_log(line);
            }
            self.friendly_vs_dry_run.reset_processed_state();
            return;
        }
        if snapshot.paused == Some(true) {
            if let Some(line) = self.friendly_vs_dry_run.note_skip(
                "paused",
                "[friendly-vs-dry-run] snapshot skipped reason=paused".to_owned(),
            ) {
                self.push_log(line);
            }
            self.friendly_vs_dry_run.reset_processed_state();
            return;
        }
        if snapshot.destroyed || snapshot.successful || snapshot.gameoverreason.is_some() {
            let end_reason = if snapshot.successful {
                "successful"
            } else {
                "destroyed"
            };
            if let Some(line) = self.friendly_vs_dry_run.note_skip(
                end_reason,
                format!("[friendly-vs-dry-run] snapshot skipped reason={end_reason}"),
            ) {
                self.push_log(line);
            }
            self.friendly_vs_dry_run.reset_processed_state();
            return;
        }
        if self.friendly_vs_live.is_deferred_snapshot(snapshot) {
            if let Some(remaining) = self
                .friendly_vs_live
                .pacing_remaining_for_snapshot(snapshot, self.monotonic_now())
            {
                let skip_key = format!(
                    "pps_pacing:{}:{}:{}:{}",
                    snapshot.gameid,
                    snapshot.capture_generation,
                    snapshot.candidate_id,
                    piece_counter_label(snapshot.snapshot.piece_counter)
                );
                if let Some(line) = self.friendly_vs_live.note_skip(
                    &skip_key,
                    format!(
                        "[friendly-vs-live] input deferred reason=pps_pacing remaining_ms={} piece_counter={}",
                        remaining.as_millis(),
                        piece_counter_label(snapshot.snapshot.piece_counter)
                    ),
                ) {
                    self.push_log(line);
                }
                return;
            }
            if let Some(deferred) = self
                .friendly_vs_live
                .deferred_plan_for_snapshot(snapshot)
                .cloned()
            {
                let config = self.state.to_automation_config(&self.paths);
                self.try_dispatch_friendly_vs_live_plan(
                    &config,
                    &path,
                    &file_signature,
                    snapshot,
                    &deferred.prepared,
                );
                return;
            }
        } else if self
            .friendly_vs_dry_run
            .is_duplicate_processed_piece(snapshot)
        {
            if let Some(line) = self.friendly_vs_dry_run.note_skip(
                "duplicate_piece",
                "[friendly-vs-dry-run] snapshot skipped reason=duplicate_piece".to_owned(),
            ) {
                self.push_log(line);
            }
            return;
        }
        if self
            .friendly_vs_dry_run
            .is_duplicate_attempt(&file_signature)
        {
            if let Some(line) = self.friendly_vs_dry_run.note_skip(
                "duplicate_snapshot",
                "[friendly-vs-dry-run] snapshot skipped reason=duplicate_snapshot".to_owned(),
            ) {
                self.push_log(line);
            }
            return;
        }

        self.friendly_vs_dry_run.clear_skip_reason();
        self.push_log(format!(
            "[friendly-vs-dry-run] snapshot ready round_id={} gameid={} generation={} candidate={} piece_counter={} current={}",
            snapshot.round_id,
            snapshot.gameid,
            snapshot.capture_generation,
            snapshot.candidate_id,
            snapshot.snapshot.piece_counter.unwrap_or_default(),
            snapshot
                .snapshot
                .queue
                .first()
                .copied()
                .map(|piece| piece.label())
                .unwrap_or("?")
        ));
        let config = self.state.to_automation_config(&self.paths);
        match prepare_snapshot_execution(
            &config,
            &snapshot.snapshot,
            self.passive_provider.activation_generation,
        ) {
            Ok(PreparedSnapshotExecutionResult::Ready(prepared)) => {
                let plan = &prepared.summary;
                if let Some(fallback_from) = plan.fallback_from {
                    self.push_log(format!(
                        "[friendly-vs-dry-run] fallback mode={} from={} reason={}",
                        movement_mode_label(plan.movement_mode_used),
                        movement_mode_label(fallback_from),
                        plan.fallback_reason.as_deref().unwrap_or("unknown")
                    ));
                }
                self.push_log(format!(
                    "[friendly-vs-dry-run] plan ready piece={} hold_piece={} use_hold={} target_x={} rotation={:?} action_count={} actions={:?} route={} planner={}",
                    plan.piece.label(),
                    plan.hold_piece.map(|piece| piece.label()).unwrap_or("-"),
                    plan.use_hold,
                    plan.target_x,
                    plan.target_rotation,
                    plan.action_count,
                    plan.actions,
                    plan.route_kind,
                    plan.planner
                ));
                if self.friendly_vs_live_requires_source_pose_guard() {
                    self.friendly_vs_dry_run
                        .record_attempted(snapshot, &file_signature);
                    if let Some(remaining) = self
                        .friendly_vs_live
                        .pacing_remaining_for_snapshot(snapshot, self.monotonic_now())
                    {
                        self.defer_friendly_vs_live_input_for_pacing(
                            snapshot,
                            prepared.clone(),
                            remaining,
                        );
                    } else {
                        self.try_dispatch_friendly_vs_live_plan(
                            &config,
                            &path,
                            &file_signature,
                            snapshot,
                            &prepared,
                        );
                    }
                } else {
                    self.friendly_vs_dry_run
                        .record_processed(snapshot, &file_signature);
                    if let Some(remaining) = self
                        .friendly_vs_live
                        .pacing_remaining_for_snapshot(snapshot, self.monotonic_now())
                    {
                        self.defer_friendly_vs_live_input_for_pacing(
                            snapshot,
                            prepared.clone(),
                            remaining,
                        );
                    } else {
                        self.try_dispatch_friendly_vs_live_plan(
                            &config,
                            &path,
                            &file_signature,
                            snapshot,
                            &prepared,
                        );
                    }
                }
            }
            Ok(PreparedSnapshotExecutionResult::Skipped { reason, retryable }) => {
                self.friendly_vs_dry_run
                    .record_attempted(snapshot, &file_signature);
                self.push_log(format!(
                    "[friendly-vs-dry-run] plan skipped piece={} retryable={} reason={reason}",
                    snapshot
                        .snapshot
                        .queue
                        .first()
                        .copied()
                        .map(|piece| piece.label())
                        .unwrap_or("?"),
                    retryable
                ));
            }
            Err(err) => {
                self.friendly_vs_dry_run
                    .record_attempted(snapshot, &file_signature);
                self.push_log(format!(
                    "[friendly-vs-dry-run] plan skipped piece={} reason={err:#}",
                    snapshot
                        .snapshot
                        .queue
                        .first()
                        .copied()
                        .map(|piece| piece.label())
                        .unwrap_or("?")
                ));
            }
        }
    }

    fn poll_zenith_dry_run(&mut self) {
        if self.state.selected_mode != RuntimeMode::Zenith {
            self.zenith_dry_run.reset();
            self.zenith_live.reset();
            return;
        }
        if !self
            .passive_provider
            .is_requested(PassiveProviderOwner::ZenithDryRun)
        {
            self.cancel_zenith_live_execution("provider_owner_missing");
            self.zenith_dry_run.reset();
            return;
        }
        if !self.bot_desired_enabled || self.bot_status != BotStatus::On {
            self.zenith_dry_run.reset();
            self.zenith_live.reset();
            return;
        }
        let runtime_ready = self.browser_status == BrowserStatus::Ready
            && self.input_status == InputStatus::Ready
            && matches!(
                self.snapshot_status,
                SnapshotStatus::WaitingForGame | SnapshotStatus::Ready
            );
        if !runtime_ready {
            let reason = if self.browser_status != BrowserStatus::Ready {
                "provider_child_exited"
            } else if self.input_status != InputStatus::Ready {
                "input_unavailable"
            } else {
                "capture_stopped"
            };
            self.cancel_zenith_live_execution(reason);
            if matches!(reason, "provider_child_exited" | "capture_stopped") {
                self.zenith_live.clear_pacing_state();
            }
            return;
        }
        let path = self.zenith_passive_snapshot_path();
        let file_signature = self.zenith_passive_snapshot_file_signature(&path);
        let read_result = match read_zenith_passive_snapshot_file_with_age(&path) {
            Ok(Some(value)) => value,
            Ok(None) => {
                let skip_key = format!("snapshot_missing:{file_signature}");
                if let Some(line) = self.zenith_dry_run.note_skip(
                    &skip_key,
                    "[zenith-dry-run] snapshot skipped reason=snapshot_missing".to_owned(),
                ) {
                    self.push_log(line);
                }
                return;
            }
            Err(err) => {
                let error = format!("{err:#}");
                self.cancel_zenith_live_execution("semantic_invalid");
                let skip_key = zenith_semantic_skip_key(&error);
                if let Some(line) = self.zenith_dry_run.note_skip(
                    &skip_key,
                    format!(
                        "[zenith-dry-run] snapshot skipped reason=semantic_invalid error={error}"
                    ),
                ) {
                    self.push_log(line);
                }
                self.zenith_dry_run.reset_processed_state();
                return;
            }
        };
        let (envelope, age) = read_result;
        let Some(snapshot) = envelope.snapshot.as_ref() else {
            if self.zenith_live.is_waiting_for_lock() {
                if envelope.capture_status.as_deref() == Some("stopped") {
                    self.cancel_zenith_live_execution("capture_stopped");
                } else {
                    self.cancel_zenith_live_execution("semantic_invalid");
                }
            }
            let skip = if envelope.capture_status.as_deref() == Some("stopped") {
                (
                    "capture_stopped".to_owned(),
                    "capture_stopped".to_owned(),
                    "[zenith-dry-run] snapshot skipped reason=capture_stopped".to_owned(),
                )
            } else if let Some(error) = envelope.semantic_error.as_deref() {
                let key = zenith_semantic_skip_key(error);
                (
                    key,
                    "semantic_invalid".to_owned(),
                    format!(
                        "[zenith-dry-run] snapshot skipped reason=semantic_invalid error={error}"
                    ),
                )
            } else {
                (
                    "semantic_invalid".to_owned(),
                    "semantic_invalid".to_owned(),
                    "[zenith-dry-run] snapshot skipped reason=semantic_invalid".to_owned(),
                )
            };
            if let Some(line) = self.zenith_dry_run.note_skip(&skip.0, skip.2) {
                self.push_log(line);
            }
            self.zenith_dry_run.reset_processed_state();
            return;
        };

        if self.zenith_dry_run.last_game_id.as_deref() != Some(snapshot.gameid.as_str())
            || self.zenith_dry_run.last_capture_generation != Some(snapshot.capture_generation)
            || self.zenith_dry_run.last_candidate_id.as_deref()
                != Some(snapshot.candidate_id.as_str())
        {
            self.zenith_dry_run.reset_processed_state();
        }

        if envelope.status != "ready" {
            self.cancel_zenith_live_execution("semantic_invalid");
            if let Some(line) = self.zenith_dry_run.note_skip(
                "semantic_invalid",
                "[zenith-dry-run] snapshot skipped reason=semantic_invalid".to_owned(),
            ) {
                self.push_log(line);
            }
            return;
        }
        if envelope.capture_status.as_deref() != Some("running") {
            self.cancel_zenith_live_execution("capture_stopped");
            self.zenith_live.clear_pacing_state();
            if let Some(line) = self.zenith_dry_run.note_skip(
                "capture_stopped",
                "[zenith-dry-run] snapshot skipped reason=capture_stopped".to_owned(),
            ) {
                self.push_log(line);
            }
            self.zenith_dry_run.reset_processed_state();
            return;
        }
        if age
            .map(|value| value.as_millis() > u128::from(MAX_SNAPSHOT_AGE_MS))
            .unwrap_or(false)
        {
            self.cancel_zenith_live_execution("snapshot_stale");
            if let Some(line) = self.zenith_dry_run.note_skip(
                "stale",
                "[zenith-dry-run] snapshot skipped reason=stale".to_owned(),
            ) {
                self.push_log(line);
            }
            return;
        }
        if !snapshot.playing || !snapshot.started {
            self.cancel_zenith_live_execution("playing_false");
            self.zenith_live.clear_pacing_state();
            if let Some(line) = self.zenith_dry_run.note_skip(
                "not_playing",
                "[zenith-dry-run] snapshot skipped reason=not_playing".to_owned(),
            ) {
                self.push_log(line);
            }
            self.zenith_dry_run.reset_processed_state();
            return;
        }
        if snapshot.countdown_started {
            self.cancel_zenith_live_execution("countdown");
            self.zenith_live.clear_pacing_state();
            if let Some(line) = self.zenith_dry_run.note_skip(
                "countdown",
                "[zenith-dry-run] snapshot skipped reason=countdown".to_owned(),
            ) {
                self.push_log(line);
            }
            self.zenith_dry_run.reset_processed_state();
            return;
        }
        if snapshot.paused == Some(true) {
            self.cancel_zenith_live_execution("paused");
            self.zenith_live.clear_pacing_state();
            if let Some(line) = self.zenith_dry_run.note_skip(
                "paused",
                "[zenith-dry-run] snapshot skipped reason=paused".to_owned(),
            ) {
                self.push_log(line);
            }
            self.zenith_dry_run.reset_processed_state();
            return;
        }
        if snapshot.destroyed || snapshot.successful || snapshot.gameoverreason.is_some() {
            let end_reason = if snapshot.successful {
                "successful"
            } else {
                "destroyed"
            };
            self.cancel_zenith_live_execution(end_reason);
            self.zenith_live.clear_pacing_state();
            if let Some(line) = self.zenith_dry_run.note_skip(
                end_reason,
                format!("[zenith-dry-run] snapshot skipped reason={end_reason}"),
            ) {
                self.push_log(line);
            }
            self.zenith_dry_run.reset_processed_state();
            return;
        }
        if self.update_zenith_live_lock_state(snapshot) {
            return;
        }
        let config = self.state.to_automation_config(&self.paths);
        if let Some(deferred_plan) = self.zenith_live.deferred_plan_for_snapshot(snapshot).cloned() {
            if self.zenith_live_limit_reached() {
                self.zenith_live.clear_deferred_snapshot();
                return;
            }
            if let Some(remaining) = self
                .zenith_live
                .pacing_remaining_for_snapshot(snapshot, self.monotonic_now())
            {
                self.defer_zenith_live_input_for_pacing(
                    snapshot,
                    deferred_plan.prepared.clone(),
                    remaining,
                );
                return;
            }
            self.try_dispatch_zenith_live_plan(
                &config,
                &path,
                &file_signature,
                snapshot,
                &deferred_plan.prepared,
            );
            return;
        }
        if self.zenith_live.deferred_plan.is_some() {
            self.discard_zenith_live_deferred_plan_for_replan();
            return;
        }
        if self.zenith_dry_run.is_duplicate_processed_piece(snapshot) {
            if let Some(line) = self.zenith_dry_run.note_skip(
                "duplicate_piece",
                "[zenith-dry-run] snapshot skipped reason=duplicate_piece".to_owned(),
            ) {
                self.push_log(line);
            }
            return;
        } else if self.zenith_dry_run.is_duplicate_attempt(&file_signature) {
            if let Some(line) = self.zenith_dry_run.note_skip(
                "duplicate_snapshot",
                "[zenith-dry-run] snapshot skipped reason=duplicate_snapshot".to_owned(),
            ) {
                self.push_log(line);
            }
            return;
        }

        self.zenith_dry_run.clear_skip_reason();
        self.push_log(format!(
            "[zenith-dry-run] snapshot accepted userid={} gameid={} generation={} candidate={} timestamp_ms={} piece_counter={} current={} hold={} queue_count={} board=10x40",
            snapshot.userid,
            snapshot.gameid,
            snapshot.capture_generation,
            snapshot.candidate_id,
            snapshot.timestamp_ms,
            snapshot.snapshot.piece_counter.unwrap_or_default(),
            snapshot
                .snapshot
                .queue
                .first()
                .copied()
                .map(|piece| piece.label())
                .unwrap_or("?"),
            snapshot
                .snapshot
                .hold
                .map(|piece| piece.label())
                .unwrap_or("-"),
            snapshot.snapshot.queue.len().saturating_sub(1)
        ));
        match prepare_snapshot_execution(
            &config,
            &snapshot.snapshot,
            self.passive_provider.activation_generation,
        ) {
            Ok(PreparedSnapshotExecutionResult::Ready(prepared)) => {
                let plan = &prepared.summary;
                if let Some(fallback_from) = plan.fallback_from {
                    self.push_log(format!(
                        "[zenith-dry-run] fallback mode={} from={} reason={}",
                        movement_mode_label(plan.movement_mode_used),
                        movement_mode_label(fallback_from),
                        plan.fallback_reason.as_deref().unwrap_or("unknown")
                    ));
                }
                self.push_log(format!(
                    "[zenith-dry-run] plan ready token={} piece={} hold_piece={} use_hold={} target_x={} rotation={:?} action_count={} actions={:?} route={} planner={}",
                    plan.token,
                    plan.piece.label(),
                    plan.hold_piece.map(|piece| piece.label()).unwrap_or("-"),
                    plan.use_hold,
                    plan.target_x,
                    plan.target_rotation,
                    plan.action_count,
                    plan.actions,
                    plan.route_kind,
                    plan.planner
                ));
                self.zenith_dry_run
                    .record_attempted(snapshot, &file_signature);
                if let Some(line) = self.zenith_live.note_startup_stage("first_plan") {
                    self.push_log(line);
                }
                let piece_counter = snapshot.snapshot.piece_counter;
                if !self.zenith_live_input_allowed() {
                    self.zenith_dry_run.mark_processed_snapshot(snapshot);
                    self.push_log("[zenith-dry-run] input suppressed reason=dry_run");
                } else if self.zenith_live_limit_reached() {
                    self.zenith_dry_run.mark_processed_snapshot(snapshot);
                    self.suppress_zenith_live_input("max_pieces_reached", piece_counter);
                } else if self
                    .zenith_live
                    .aborted_execution_matches_snapshot(snapshot)
                {
                    self.zenith_dry_run.mark_processed_snapshot(snapshot);
                    self.suppress_zenith_live_input("aborted_piece", piece_counter);
                } else if self
                    .zenith_live
                    .completed_execution_matches_snapshot(snapshot)
                {
                    self.zenith_dry_run.mark_processed_snapshot(snapshot);
                    self.suppress_zenith_live_input("completed_piece", piece_counter);
                } else if self.zenith_live.is_executing_piece(piece_counter) {
                    self.zenith_dry_run.mark_processed_snapshot(snapshot);
                    self.suppress_zenith_live_input("already_executing", piece_counter);
                } else if snapshot.userid.trim().is_empty() {
                    self.zenith_dry_run.mark_processed_snapshot(snapshot);
                    self.suppress_zenith_live_input("identity_mismatch", piece_counter);
                } else if let Some(remaining) = self
                    .zenith_live
                    .pacing_remaining_for_snapshot(snapshot, self.monotonic_now())
                {
                    self.zenith_dry_run.mark_processed_snapshot(snapshot);
                    self.defer_zenith_live_input_for_pacing(
                        snapshot,
                        prepared.clone(),
                        remaining,
                    );
                } else {
                    self.try_dispatch_zenith_live_plan(
                        &config,
                        &path,
                        &file_signature,
                        snapshot,
                        &prepared,
                    );
                }
            }
            Ok(PreparedSnapshotExecutionResult::Skipped { reason, retryable }) => {
                self.zenith_dry_run
                    .record_attempted(snapshot, &file_signature);
                self.push_log(format!(
                    "[zenith-dry-run] plan skipped token={} piece={} retryable={} reason={reason}",
                    snapshot.snapshot.token,
                    snapshot
                        .snapshot
                        .queue
                        .first()
                        .copied()
                        .map(|piece| piece.label())
                        .unwrap_or("?"),
                    retryable
                ));
            }
            Err(err) => {
                self.zenith_dry_run
                    .record_attempted(snapshot, &file_signature);
                self.push_log(format!(
                    "[zenith-dry-run] plan skipped token={} piece={} reason={err:#}",
                    snapshot.snapshot.token,
                    snapshot
                        .snapshot
                        .queue
                        .first()
                        .copied()
                        .map(|piece| piece.label())
                        .unwrap_or("?")
                ));
            }
        }
    }

    fn maybe_resume_bot_runner(&mut self) {
        if self.state.selected_mode != RuntimeMode::Solo {
            return;
        }
        if !self.bot_restart_pending || !self.bot_desired_enabled || self.bot_session.is_some() {
            return;
        }
        let runtime_ready = self.browser_status == BrowserStatus::Ready
            && self.input_status == InputStatus::Ready
            && matches!(
                self.snapshot_status,
                SnapshotStatus::WaitingForGame | SnapshotStatus::Ready
            );
        if !runtime_ready {
            return;
        }
        self.start_bot_with_mode(BotStartMode::AutoResume);
    }

    fn mirror_friendly_vs_browser_log(&mut self, line: &str) {
        if self.state.selected_mode != RuntimeMode::FriendlyVs || !self.bot_desired_enabled {
            return;
        }
        let Some(reason) = line.strip_prefix("[vs-bridge] waiting reason=") else {
            return;
        };
        let reason = reason.split_whitespace().next().unwrap_or("").trim();
        if reason.is_empty() {
            return;
        }
        if let Some(line) = self.friendly_vs.note_waiting(reason) {
            self.push_log(line);
        }
    }

    fn poll_events(&mut self) {
        let mut events = Vec::new();
        while let Ok(event) = self.event_rx.try_recv() {
            events.push(event);
        }

        for event in events {
            match event {
                LauncherEvent::BrowserLog(line) => {
                    self.mirror_friendly_vs_browser_log(&line);
                    self.push_log(line);
                }
                LauncherEvent::BrowserExited(result) => {
                    self.handle_browser_exited(result);
                }
                LauncherEvent::BotLog(line) => {
                    if self.bot_desired_enabled
                        && !self.bot_waiting_for_next_game
                        && line_reports_runner_waiting(&line)
                    {
                        self.bot_waiting_for_next_game = true;
                        self.push_log("[bot] waiting for next game while remaining enabled");
                        self.push_log("[bot] idle runner remains active");
                    } else if let Some(epoch) = extract_resumed_epoch_from_bot_log(&line) {
                        if self.bot_waiting_for_next_game {
                            self.bot_waiting_for_next_game = false;
                            self.push_log(format!("[bot] runner resumed for game epoch={epoch}"));
                        }
                    }
                    self.push_log(line);
                }
                LauncherEvent::BotExited(result) => {
                    if self.ignore_next_bot_exit {
                        self.ignore_next_bot_exit = false;
                        continue;
                    }
                    self.bot_session = None;
                    match result {
                        Ok(()) => {
                            let exit_reason = if !self.bot_desired_enabled {
                                "stop_flag"
                            } else if self.browser_session.is_none() {
                                "browser_closed"
                            } else {
                                "wait_function_returned"
                            };
                            self.push_log(format!("[bot] idle runner exit reason={exit_reason}"));
                            if self.bot_desired_enabled && self.browser_session.is_some() {
                                self.bot_status = BotStatus::Starting;
                                self.bot_restart_pending = true;
                                if !self.bot_waiting_for_next_game {
                                    self.bot_waiting_for_next_game = true;
                                    self.push_log(
                                        "[bot] waiting for next game while remaining enabled",
                                    );
                                }
                            } else {
                                self.bot_status = BotStatus::Off;
                                self.bot_waiting_for_next_game = false;
                                self.bot_restart_pending = false;
                                self.push_log("[bot] automation exited cleanly");
                            }
                        }
                        Err(err) => {
                            self.push_log(format!(
                                "[bot] idle runner exit reason=provider_error error={err}"
                            ));
                            self.bot_status = BotStatus::Error;
                            self.bot_waiting_for_next_game = false;
                            self.bot_restart_pending = false;
                            self.push_log(format!("[bot] automation failed: {err}"));
                        }
                    }
                }
            }
        }
    }
}

impl eframe::App for LauncherApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.poll_browser_runtime();
        self.poll_events();
        self.maybe_resume_bot_runner();
        self.poll_friendly_vs_observer();
        self.poll_friendly_vs_dry_run();
        self.poll_zenith_dry_run();
        ctx.send_viewport_cmd(egui::ViewportCommand::WindowLevel(window_level(
            self.state.always_on_top,
        )));

        let browser_locked = self.browser_connection_settings_locked();
        let bot_locked = self.local_tetrio_username_locked();
        let can_turn_bot_on = self.browser_status == BrowserStatus::Ready
            && self.input_status == InputStatus::Ready
            && matches!(
                self.snapshot_status,
                SnapshotStatus::WaitingForGame | SnapshotStatus::Ready
            )
            && !bot_locked;
        egui::TopBottomPanel::top("top_bar").show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.heading("Cold Clear Launcher");
                ui.separator();
                ui.label(format!("Browser: {}", self.browser_status.label()));
                ui.separator();
                ui.label(format!("Bot: {}", self.bot_status.label()));
            });
        });

        egui::CentralPanel::default().show(ctx, |ui| {
            ui.label("Open Chromium now prewarms the snapshot and input CDP helpers. Bot ON only starts the planner/runner.");
            if browser_locked {
                ui.small("Browser connection settings are locked while Chromium is open.");
            }
            ui.add_enabled_ui(!browser_locked, |ui| {
                ui.horizontal(|ui| {
                    ui.label("Chrome Path");
                    ui.text_edit_singleline(&mut self.state.browser.chrome_path);
                });
                ui.horizontal(|ui| {
                    ui.label("CDP Port");
                    ui.add(egui::DragValue::new(&mut self.state.browser.cdp_port).speed(1));
                    ui.label("URL");
                    ui.text_edit_singleline(&mut self.state.browser.url);
                });
                ui.horizontal(|ui| {
                    ui.label("Target");
                    ui.text_edit_singleline(&mut self.state.browser.target_hint);
                });
            });
            ui.horizontal(|ui| {
                ui.label("Local TETR.IO Username");
                let response = ui.add_enabled(
                    !bot_locked,
                    egui::TextEdit::singleline(&mut self.state.browser.local_tetrio_username)
                        .hint_text("exact username"),
                );
                if response.changed() && self.browser_session.is_some() {
                    self.sync_browser_local_tetrio_username();
                    self.sync_requested_passive_provider_username_hint();
                }
            });
            ui.horizontal(|ui| {
                ui.checkbox(&mut self.state.always_on_top, "Always on top");
            });

            ui.separator();
            ui.heading("Browser");
            ui.horizontal(|ui| {
                ui.label(format!("Chromium: {}", self.browser_status.label()));
                ui.label(format!("Snapshot: {}", self.snapshot_status.label()));
                ui.label(format!("Input: {}", self.input_status.label()));
            });
            if let Some(token) = &self.latest_snapshot_token {
                ui.label(format!(
                    "Latest Snapshot: token={} age_ms={}",
                    token,
                    self.latest_snapshot_age_ms.unwrap_or_default()
                ));
            }
            ui.horizontal(|ui| {
                if ui
                    .add_enabled(!browser_locked, egui::Button::new("Open Chromium"))
                    .clicked()
                {
                    self.open_browser();
                }
                if ui
                    .add_enabled(browser_locked, egui::Button::new("Close Chromium"))
                    .clicked()
                {
                    self.close_browser();
                }
            });

            ui.separator();
            ui.heading("Bot");
            if bot_locked {
                ui.small("플레이 스타일은 다음 Bot ON부터 적용됩니다.");
            }
            ui.horizontal(|ui| {
                ui.label("Mode");
                let current_mode = self.state.selected_mode;
                for mode in [
                    RuntimeMode::Solo,
                    RuntimeMode::Zenith,
                    RuntimeMode::FriendlyVs,
                ] {
                    if ui
                        .selectable_label(current_mode == mode, mode.label())
                        .clicked()
                    {
                        self.select_mode(mode);
                    }
                }
            });
            if self.state.selected_mode == RuntimeMode::FriendlyVs {
                }
            ui.horizontal(|ui| {
                ui.label(BOT_UI_VISIBLE_LABELS[0]);
                ui.add_enabled_ui(!bot_locked, |ui| {
                    egui::ComboBox::from_id_salt("play_style")
                        .selected_text(play_style_label(self.state.play_style))
                        .show_ui(ui, |ui| {
                            ui.selectable_value(
                                &mut self.state.play_style,
                                PlayStyleConfig::Normal,
                                play_style_label(PlayStyleConfig::Normal),
                            );
                            ui.selectable_value(
                                &mut self.state.play_style,
                                PlayStyleConfig::Speed,
                                play_style_label(PlayStyleConfig::Speed),
                            );
                        });
                });
            });
            ui.small(play_style_description(self.state.play_style));

            let previous_target_pps = self.state.target_pps;
            let previous_pps_unlimited = self.state.pps_unlimited;
            ui.horizontal(|ui| {
                ui.label(BOT_UI_VISIBLE_LABELS[1]).on_hover_text(
                    "PPS는 초당 배치할 미노 수의 최대값입니다.\n실제 속도는 계산 및 입력 경로에 따라 더 낮을 수 있습니다.",
                );
                ui.add_enabled_ui(!bot_locked, |ui| {
                    ui.add_enabled_ui(!self.state.pps_unlimited, |ui| {
                        ui.add(
                            egui::DragValue::new(&mut self.state.target_pps)
                                .speed(0.1)
                                .range(0.25..=20.0)
                                .fixed_decimals(2),
                        );
                    });
                    ui.checkbox(&mut self.state.pps_unlimited, BOT_UI_VISIBLE_LABELS[2]);
                });
            });
            self.state.normalize_pps_state();
            if previous_target_pps != self.state.target_pps
                || previous_pps_unlimited != self.state.pps_unlimited
            {
                self.update_live_target_pps();
            }
            ui.horizontal(|ui| {
                ui.label(format!("{}: {}", BOT_UI_VISIBLE_LABELS[3], self.bot_status.label()));
                if ui
                    .add_enabled(can_turn_bot_on, egui::Button::new(BOT_UI_VISIBLE_LABELS[4]))
                    .clicked()
                {
                    self.start_bot();
                }
                if ui
                    .add_enabled(bot_locked, egui::Button::new(BOT_UI_VISIBLE_LABELS[5]))
                    .clicked()
                {
                    self.stop_bot();
                }
            });



            ui.separator();
            ui.heading("Settings");
            if ui.button("Save Settings").clicked() {
                self.save_state();
                if self.browser_session.is_some() && !bot_locked {
                    self.sync_requested_passive_provider_username_hint();
                }
            }

            ui.separator();
            ui.heading("Log");
            egui::ScrollArea::vertical()
                .stick_to_bottom(true)
                .max_height(260.0)
                .show(ui, |ui| {
                    for line in &self.logs {
                        ui.monospace(line);
                    }
                });
        });

        ctx.request_repaint_after(Duration::from_millis(16));
    }
}

impl Drop for LauncherApp {
    fn drop(&mut self) {
        self.stop_bot_with_browser_hint(false);
        self.close_browser();
        let _ = save_launcher_state(&self.paths, &self.state);
    }
}

fn load_launcher_state(paths: &AppPaths) -> Result<LauncherState> {
    let raw = fs::read_to_string(&paths.launcher_state_path).with_context(|| {
        format!(
            "failed to read launcher state from {}",
            paths.launcher_state_path.display()
        )
    })?;
    let raw_json: serde_json::Value =
        serde_json::from_str(&raw).context("failed to parse launcher state JSON")?;
    let mut state: LauncherState =
        serde_json::from_value(raw_json.clone()).context("failed to decode launcher state")?;
    if raw_json.get("pps_unlimited").is_none() {
        state.pps_unlimited = state.target_pps <= 0.0;
    }
    if state.browser.local_tetrio_username.trim().is_empty() {
        if let Some(username) = legacy_local_tetrio_username(&raw_json) {
            state.browser.local_tetrio_username = username;
        }
    }
    state.normalize_pps_state();
    Ok(state)
}

fn save_launcher_state(paths: &AppPaths, state: &LauncherState) -> Result<()> {
    if let Some(parent) = paths.launcher_state_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string_pretty(state)?;
    fs::write(&paths.launcher_state_path, raw)?;
    Ok(())
}

fn legacy_local_tetrio_username(raw_json: &serde_json::Value) -> Option<String> {
    let browser = raw_json.get("browser");
    [
        raw_json.get("local_tetrio_username"),
        raw_json.get("local_player_username"),
        raw_json.get("quick_play_diagnostic_username"),
        browser.and_then(|value| value.get("local_player_username")),
        browser.and_then(|value| value.get("quick_play_diagnostic_username")),
    ]
    .into_iter()
    .flatten()
    .filter_map(|value| value.as_str())
    .map(str::trim)
    .find(|value| !value.is_empty())
    .map(str::to_owned)
}

fn movement_mode_label(mode: MovementModeConfig) -> &'static str {
    match mode {
        MovementModeConfig::ZeroG => "ZeroG",
        MovementModeConfig::ZeroGSafe => "ZeroG Safe",
        MovementModeConfig::ZeroGComplete => "ZeroG Complete (Experimental)",
        MovementModeConfig::TwentyG => "TwentyG",
        MovementModeConfig::HardDropOnly => "Hard Drop Only",
    }
}

fn play_style_label(style: PlayStyleConfig) -> &'static str {
    match style {
        PlayStyleConfig::Normal => "노말",
        PlayStyleConfig::Speed => "속도 지향",
    }
}

fn play_style_description(style: PlayStyleConfig) -> &'static str {
    match style {
        PlayStyleConfig::Normal => "현재 기본 설정으로 플레이합니다.",
        PlayStyleConfig::Speed => "테트리스 중심의 Sprint 40L 빌드를 우선합니다.",
    }
}

fn format_target_pps_label(target_pps: f32) -> String {
    if target_pps.is_finite() && target_pps > 0.0 {
        format!("{target_pps:.2}")
    } else {
        "unlimited".to_owned()
    }
}

fn format_target_pps_log_label(target_pps: f32) -> String {
    if !target_pps.is_finite() || target_pps <= 0.0 {
        return "unlimited".to_owned();
    }
    let mut label = format!("{target_pps:.2}");
    while label.contains('.') && label.ends_with('0') {
        label.pop();
    }
    if label.ends_with('.') {
        label.pop();
    }
    label
}

fn piece_counter_label(piece_counter: Option<u32>) -> String {
    piece_counter
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unknown".to_owned())
}

fn spawn_rule_label(rule: SpawnRuleConfig) -> &'static str {
    match rule {
        SpawnRuleConfig::Row19Or20 => "Row 19 or 20",
        SpawnRuleConfig::Row21AndFall => "Row 21 and fall",
    }
}

fn extract_planned_token(line: &str) -> Option<String> {
    if !line.contains("[automation] source=") || !line.contains(" piece=") {
        return None;
    }
    line.split_whitespace()
        .find_map(|part| part.strip_prefix("token=").map(|value| value.to_owned()))
}

fn extract_snapshot_epoch(token: &str) -> Option<u64> {
    let mut parts = token.split('-');
    let prefix = parts.next()?;
    let epoch = parts.next()?;
    let _piece_counter = parts.next()?;
    if prefix != "browser" || parts.next().is_some() {
        return None;
    }
    epoch.parse().ok()
}

fn line_reports_runner_waiting(line: &str) -> bool {
    line.contains("[automation] idle waiting for next live game after token=")
}

fn extract_resumed_epoch_from_bot_log(line: &str) -> Option<u64> {
    if !line.contains("[automation] live game resumed token=") {
        return None;
    }
    line.split_whitespace()
        .find_map(|part| part.strip_prefix("token="))
        .and_then(extract_snapshot_epoch)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use super::*;
    use crate::driver::{ExecutionPlan, GameAction};
    use crate::runner::DryRunPlanSummary;
    use crate::scanner::{PieceToken, RotationToken};
    use libtetris::{Board, Piece, SpawnRule};
    use serde_json::json;

    fn test_paths(test_name: &str) -> AppPaths {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "automation-launcher-tests-{test_name}-{}-{unique}",
            std::process::id()
        ));
        let automation = root.join("automation");
        let _ = fs::create_dir_all(automation.join("browser-source"));
        let _ = fs::create_dir_all(automation.join("scripts"));
        AppPaths {
            workspace_root: root.clone(),
            launcher_state_path: automation.join("launcher-state.json"),
            scanner_script_path: automation.join("scripts").join("screen_scanner.py"),
            browser_host_script_path: automation
                .join("browser-source")
                .join("tetrio-browser-host.mjs"),
            browser_snapshot_script_path: automation
                .join("browser-source")
                .join("tetrio-cdp-source.mjs"),
            browser_input_script_path: automation
                .join("browser-source")
                .join("browser-cdp-input.mjs"),
        }
    }

    fn cleanup_test_paths(paths: &AppPaths) {
        let _ = fs::remove_dir_all(&paths.workspace_root);
    }

    fn friendly_vs_bridge_path(paths: &AppPaths) -> std::path::PathBuf {
        let snapshot_path = paths.resolve_workspace_path("automation/live-snapshot.json");
        vs_bridge_path_for_snapshot(&snapshot_path)
    }

    fn configure_friendly_vs_runtime_ready(app: &mut LauncherApp) {
        app.state.selected_mode = RuntimeMode::FriendlyVs;
        app.browser_status = BrowserStatus::Ready;
        app.input_status = InputStatus::Ready;
        app.snapshot_status = SnapshotStatus::Ready;
    }

    fn write_friendly_vs_bridge(
        paths: &AppPaths,
        sequence: u64,
        round_id: &str,
        active: bool,
        captured_at: u64,
        ready_at: u64,
        local_userid: &str,
        local_username: &str,
        local_gameid: i64,
        seed: i64,
        nextcount: i64,
        opponent_gameids: &[i64],
        incoming_garbage_count: usize,
    ) {
        let path = friendly_vs_bridge_path(paths);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let opponents = opponent_gameids
            .iter()
            .enumerate()
            .map(|(index, gameid)| {
                json!({
                    "username": format!("guest-{index}"),
                    "userid": format!("guest-id-{index}"),
                    "gameid": gameid
                })
            })
            .collect::<Vec<_>>();
        let incoming_garbage = (0..incoming_garbage_count)
            .map(|index| {
                json!({
                    "ownerGameId": opponent_gameids.first().copied().unwrap_or(9001),
                    "eventType": "garbage",
                    "data": { "amt": index + 1 }
                })
            })
            .collect::<Vec<_>>();
        let raw = json!({
            "version": 1,
            "sequence": sequence,
            "roundId": round_id,
            "active": active,
            "capturedAt": captured_at,
            "readyAt": ready_at,
            "readyOffsetMs": 3000,
            "local": {
                "username": local_username,
                "userid": local_userid,
                "gameid": local_gameid
            },
            "opponents": opponents,
            "options": {
                "seed": seed,
                "bagtype": "7-bag",
                "nextcount": nextcount
            },
            "incomingGarbage": incoming_garbage
        });
        fs::write(path, serde_json::to_vec(&raw).unwrap()).unwrap();
    }

    fn arm_friendly_vs_round(
        app: &mut LauncherApp,
        paths: &AppPaths,
        round_id: &str,
        local_gameid: i64,
    ) {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        app.poll_friendly_vs_observer();
        write_friendly_vs_bridge(
            paths,
            1,
            round_id,
            true,
            now_ms.saturating_add(1_000),
            now_ms.saturating_sub(1),
            "local-id",
            "guest-local",
            local_gameid,
            1_744_077_373,
            5,
            &[local_gameid.saturating_add(1)],
            0,
        );
        app.poll_friendly_vs_observer();
    }

    fn setup_friendly_vs_live_app_with_options(
        test_name: &str,
        live_input_enabled: bool,
        live_limit: FriendlyVsLiveLimit,
    ) -> (AppPaths, LauncherApp, String) {
        let paths = test_paths(test_name);
        let mut app = LauncherApp::new(paths.clone());
        configure_friendly_vs_runtime_ready(&mut app);
        app.state.friendly_vs_live_input_enabled = live_input_enabled;
        app.state.friendly_vs_live_limit = live_limit;
        app.start_bot();
        app.logs.clear();
        let round_id = "7001:1744077373".to_owned();
        arm_friendly_vs_round(&mut app, &paths, &round_id, 7001);
        (paths, app, round_id)
    }

    fn setup_friendly_vs_live_app_with_enabled(
        test_name: &str,
        live_input_enabled: bool,
    ) -> (AppPaths, LauncherApp, String) {
        setup_friendly_vs_live_app_with_options(
            test_name,
            live_input_enabled,
            FriendlyVsLiveLimit::Twenty,
        )
    }

    fn setup_friendly_vs_live_app(test_name: &str) -> (AppPaths, LauncherApp, String) {
        setup_friendly_vs_live_app_with_enabled(test_name, true)
    }

    fn poll_friendly_vs_live_test_piece(
        app: &mut LauncherApp,
        paths: &AppPaths,
        round_id: &str,
        piece_counter: u32,
        sequence_index: usize,
    ) {
        let patterns = [
            ("J", ["O", "T", "L", "S", "Z"]),
            ("T", ["I", "O", "L", "S", "Z"]),
            ("L", ["I", "O", "T", "S", "Z"]),
            ("S", ["I", "O", "T", "L", "Z"]),
            ("Z", ["I", "O", "T", "L", "S"]),
            ("I", ["O", "T", "L", "S", "Z"]),
        ];
        let (current_piece, queue) = patterns[sequence_index % patterns.len()];
        std::thread::sleep(Duration::from_millis(20));
        write_friendly_vs_passive_snapshot(
            paths,
            round_id,
            "7001",
            "cand-local",
            piece_counter,
            json!("friendly-user"),
            current_piece,
            &queue,
        );
        app.poll_friendly_vs_dry_run();
    }

    fn poll_friendly_vs_live_test_sequence(
        app: &mut LauncherApp,
        paths: &AppPaths,
        round_id: &str,
        first_piece_counter: u32,
        piece_count: u32,
    ) {
        for offset in 0..piece_count {
            poll_friendly_vs_live_test_piece(
                app,
                paths,
                round_id,
                first_piece_counter + offset,
                offset as usize,
            );
        }
    }

    fn tapped_actions(app: &LauncherApp) -> Vec<GameAction> {
        app.zenith_live_test_hook
            .tapped_actions
            .lock()
            .map(|actions| actions.clone())
            .unwrap_or_default()
    }

    fn clear_tapped_actions(app: &LauncherApp) {
        if let Ok(mut actions) = app.zenith_live_test_hook.tapped_actions.lock() {
            actions.clear();
        }
    }

    fn configure_zenith_runtime_ready(app: &mut LauncherApp) {
        app.state.selected_mode = RuntimeMode::Zenith;
        app.bot_desired_enabled = true;
        app.bot_status = BotStatus::On;
        app.zenith_live.session_max_pieces = app.state.effective_zenith_live_max_pieces();
        app.zenith_live
            .set_session_pacing(app.state.pps_unlimited, app.state.target_pps);
        app.browser_status = BrowserStatus::Ready;
        app.input_status = InputStatus::Ready;
        app.snapshot_status = SnapshotStatus::Ready;
        let _ = app
            .passive_provider
            .request(PassiveProviderOwner::ZenithDryRun);
    }

    fn zenith_live_started_offsets_ms(app: &LauncherApp, baseline: Instant) -> Vec<u128> {
        app.zenith_live_test_hook
            .started_at
            .lock()
            .unwrap()
            .iter()
            .map(|started_at| started_at.duration_since(baseline).as_millis())
            .collect()
    }

    fn prepare_zenith_test_plan(
        app: &LauncherApp,
        snapshot: &ZenithPassivePlannerSnapshot,
    ) -> PreparedSnapshotExecution {
        match prepare_snapshot_execution(
            &app.state.to_automation_config(&app.paths),
            &snapshot.snapshot,
            app.passive_provider.activation_generation,
        ) {
            Ok(PreparedSnapshotExecutionResult::Ready(prepared)) => prepared,
            result => panic!("expected ready zenith plan for test, got {result:?}"),
        }
    }

    fn friendly_vs_live_started_offsets_ms(app: &LauncherApp, baseline: Instant) -> Vec<u128> {
        app.zenith_live_test_hook
            .started_at
            .lock()
            .unwrap()
            .iter()
            .map(|started_at| started_at.duration_since(baseline).as_millis())
            .collect()
    }

    fn zenith_passive_snapshot_path(paths: &AppPaths) -> std::path::PathBuf {
        paths.resolve_workspace_path(ZENITH_PASSIVE_SNAPSHOT_RELATIVE_PATH)
    }

    fn friendly_vs_passive_snapshot_path(paths: &AppPaths) -> std::path::PathBuf {
        paths.resolve_workspace_path(FRIENDLY_VS_PASSIVE_SNAPSHOT_RELATIVE_PATH)
    }

    fn zenith_spawn_coordinates(piece: Piece) -> (i32, i32) {
        let board = Board::<u16>::new();
        let spawned = SpawnRule::Row19Or20
            .spawn(piece, &board)
            .expect("spawn position for test piece");
        (spawned.x, spawned.y)
    }

    fn write_zenith_passive_snapshot_with_pieces(
        paths: &AppPaths,
        status: &str,
        capture_status: &str,
        piece_counter: u32,
        paused: serde_json::Value,
        current_piece: &str,
        current_x: serde_json::Value,
        current_y: serde_json::Value,
        hold_piece: serde_json::Value,
        queue: &[&str],
    ) {
        write_zenith_passive_snapshot_with_metadata(
            paths,
            status,
            capture_status,
            5,
            "user-zenith",
            "game-zenith",
            "candidate-1",
            piece_counter,
            paused,
            current_piece,
            current_x,
            current_y,
            hold_piece,
            queue,
        );
    }

    fn write_zenith_passive_snapshot_with_metadata(
        paths: &AppPaths,
        status: &str,
        capture_status: &str,
        capture_generation: u64,
        userid: &str,
        gameid: &str,
        candidate_id: &str,
        piece_counter: u32,
        paused: serde_json::Value,
        current_piece: &str,
        current_x: serde_json::Value,
        current_y: serde_json::Value,
        hold_piece: serde_json::Value,
        queue: &[&str],
    ) {
        write_zenith_passive_snapshot_with_metadata_and_flags(
            paths,
            status,
            capture_status,
            capture_generation,
            userid,
            gameid,
            candidate_id,
            piece_counter,
            true,
            paused,
            false,
            false,
            None,
            current_piece,
            current_x,
            current_y,
            hold_piece,
            queue,
        );
    }

    fn write_zenith_passive_snapshot_with_metadata_and_flags(
        paths: &AppPaths,
        status: &str,
        capture_status: &str,
        capture_generation: u64,
        userid: &str,
        gameid: &str,
        candidate_id: &str,
        piece_counter: u32,
        playing: bool,
        paused: serde_json::Value,
        destroyed: bool,
        successful: bool,
        gameoverreason: Option<&str>,
        current_piece: &str,
        current_x: serde_json::Value,
        current_y: serde_json::Value,
        hold_piece: serde_json::Value,
        queue: &[&str],
    ) {
        let path = zenith_passive_snapshot_path(paths);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let board = vec![vec![serde_json::Value::Bool(false); 10]; 40];
        let raw = json!({
            "status": status,
            "capture_status": capture_status,
            "snapshot": {
                "source": "zenith_passive",
                "capture_generation": capture_generation,
                "timestamp": 1722422400123u64,
                "userid": userid,
                "gameid": gameid,
                "candidate_id": candidate_id,
                "playing": playing,
                "started": true,
                "countdown_started": false,
                "paused": paused,
                "destroyed": destroyed,
                "successful": successful,
                "gameoverreason": gameoverreason,
                "board": board,
                "current": {
                    "type": current_piece,
                    "x": current_x,
                    "y": current_y,
                    "rotation": "north"
                },
                "hold": hold_piece,
                "queue": queue,
                "piece_counter": piece_counter
            }
        });
        fs::write(path, serde_json::to_vec(&raw).unwrap()).unwrap();
    }

    fn write_zenith_passive_snapshot(
        paths: &AppPaths,
        status: &str,
        capture_status: &str,
        piece_counter: u32,
        paused: serde_json::Value,
    ) {
        let (x, y) = zenith_spawn_coordinates(Piece::J);
        write_zenith_passive_snapshot_with_pieces(
            paths,
            status,
            capture_status,
            piece_counter,
            paused,
            "J",
            json!(x),
            json!(y),
            json!(null),
            &["O", "T", "L", "S", "Z"],
        );
    }

    fn write_zenith_passive_snapshot_with_active_pose(
        paths: &AppPaths,
        piece_counter: u32,
        x: i32,
        y: i32,
        rotation: &str,
    ) {
        write_zenith_passive_snapshot(paths, "ready", "running", piece_counter, json!(false));
        let path = zenith_passive_snapshot_path(paths);
        let mut raw: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        raw["snapshot"]["current"]["x"] = json!(x);
        raw["snapshot"]["current"]["y"] = json!(y);
        raw["snapshot"]["current"]["rotation"] = json!(rotation);
        fs::write(path, serde_json::to_vec(&raw).unwrap()).unwrap();
    }

    fn write_zenith_passive_snapshot_with_state_flags(
        paths: &AppPaths,
        status: &str,
        capture_status: &str,
        piece_counter: u32,
        playing: bool,
        destroyed: bool,
        successful: bool,
        gameoverreason: Option<&str>,
    ) {
        let (x, y) = zenith_spawn_coordinates(Piece::J);
        write_zenith_passive_snapshot_with_metadata_and_flags(
            paths,
            status,
            capture_status,
            5,
            "user-zenith",
            "game-zenith",
            "candidate-1",
            piece_counter,
            playing,
            json!(false),
            destroyed,
            successful,
            gameoverreason,
            "J",
            json!(x),
            json!(y),
            json!(null),
            &["O", "T", "L", "S", "Z"],
        );
    }

    fn write_friendly_vs_passive_snapshot(
        paths: &AppPaths,
        round_id: &str,
        gameid: &str,
        candidate_id: &str,
        piece_counter: u32,
        userid: serde_json::Value,
        current_piece: &str,
        queue: &[&str],
    ) {
        let raw = friendly_vs_ready_snapshot_value(
            round_id,
            gameid,
            candidate_id,
            7,
            piece_counter,
            userid,
            current_piece,
            None,
            queue,
        );
        write_friendly_vs_passive_snapshot_value(paths, &raw);
    }

    fn write_friendly_vs_passive_snapshot_with_active_pose(
        paths: &AppPaths,
        round_id: &str,
        gameid: &str,
        candidate_id: &str,
        piece_counter: u32,
        userid: serde_json::Value,
        current_piece: &str,
        current_x: i32,
        current_y: i32,
        current_rotation: &str,
        queue: &[&str],
    ) {
        let mut raw = friendly_vs_ready_snapshot_value(
            round_id,
            gameid,
            candidate_id,
            7,
            piece_counter,
            userid,
            current_piece,
            None,
            queue,
        );
        raw["snapshot"]["current"]["x"] = json!(current_x);
        raw["snapshot"]["current"]["y"] = json!(current_y);
        raw["snapshot"]["current"]["rotation"] = json!(current_rotation);
        write_friendly_vs_passive_snapshot_value(paths, &raw);
    }

    fn friendly_vs_ready_snapshot_value(
        round_id: &str,
        gameid: &str,
        candidate_id: &str,
        capture_generation: u64,
        piece_counter: u32,
        userid: serde_json::Value,
        current_piece: &str,
        hold_piece: Option<&str>,
        queue: &[&str],
    ) -> serde_json::Value {
        let (x, y) = zenith_spawn_coordinates(match current_piece {
            "I" => Piece::I,
            "O" => Piece::O,
            "T" => Piece::T,
            "L" => Piece::L,
            "J" => Piece::J,
            "S" => Piece::S,
            "Z" => Piece::Z,
            _ => Piece::J,
        });
        let board = vec![vec![serde_json::Value::Bool(false); 10]; 40];
        json!({
            "status": "ready",
            "capture_status": "running",
            "snapshot": {
                "source": "friendly_vs_passive",
                "round_id": round_id,
                "capture_generation": capture_generation,
                "timestamp": 1722422401123u64,
                "userid": userid,
                "gameid": gameid,
                "candidate_id": candidate_id,
                "playing": true,
                "started": true,
                "countdown_started": false,
                "paused": false,
                "destroyed": false,
                "successful": false,
                "gameoverreason": null,
                "board": board,
                "current": {
                    "type": current_piece,
                    "x": x,
                    "y": y,
                    "rotation": "north"
                },
                "hold": hold_piece,
                "queue": queue,
                "piece_counter": piece_counter
            }
        })
    }

    fn write_friendly_vs_passive_snapshot_value(paths: &AppPaths, raw: &serde_json::Value) {
        let path = friendly_vs_passive_snapshot_path(paths);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, serde_json::to_vec(raw).unwrap()).unwrap();
    }

    fn write_friendly_vs_invalid_snapshot_null_round_id(paths: &AppPaths, padding_lines: usize) {
        let path = friendly_vs_passive_snapshot_path(paths);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut raw = String::from(
            "{\n  \"status\": \"ready\",\n  \"capture_status\": \"running\",\n  \"snapshot\": {\n",
        );
        for index in 0..padding_lines {
            raw.push_str(&format!("    \"padding_{index}\": null,\n"));
        }
        raw.push_str(
            "    \"source\": \"friendly_vs_passive\",\n    \"round_id\": null,\n    \"capture_generation\": 7,\n    \"timestamp\": 1722422401123,\n    \"userid\": null,\n    \"gameid\": \"7001\",\n    \"candidate_id\": \"cand-local\",\n    \"playing\": true,\n    \"started\": true,\n    \"countdown_started\": false,\n    \"paused\": false,\n    \"destroyed\": false,\n    \"successful\": false,\n    \"gameoverreason\": null,\n    \"board\": [\n",
        );
        for row in 0..40 {
            raw.push_str("      [false,false,false,false,false,false,false,false,false,false]");
            if row < 39 {
                raw.push_str(",\n");
            } else {
                raw.push('\n');
            }
        }
        raw.push_str(
            "    ],\n    \"current\": {\n      \"type\": \"J\",\n      \"x\": 4,\n      \"y\": 19,\n      \"rotation\": \"north\"\n    },\n    \"hold\": null,\n    \"queue\": [\"O\", \"T\", \"L\", \"S\", \"Z\"],\n    \"piece_counter\": 4\n  }\n}\n",
        );
        fs::write(path, raw).unwrap();
    }

    fn drive_zenith_live_piece_counters(app: &mut LauncherApp, paths: &AppPaths, counters: &[u32]) {
        for piece_counter in counters {
            std::thread::sleep(Duration::from_millis(20));
            write_zenith_passive_snapshot(paths, "ready", "running", *piece_counter, json!(false));
            app.poll_zenith_dry_run();
        }
    }

    fn drive_zenith_live_piece_counters_for_game(
        app: &mut LauncherApp,
        paths: &AppPaths,
        gameid: &str,
        counters: &[u32],
    ) {
        let (x, y) = zenith_spawn_coordinates(Piece::J);
        for piece_counter in counters {
            std::thread::sleep(Duration::from_millis(20));
            write_zenith_passive_snapshot_with_metadata(
                paths,
                "ready",
                "running",
                5,
                "user-zenith",
                gameid,
                "candidate-1",
                *piece_counter,
                json!(false),
                "J",
                json!(x),
                json!(y),
                json!(null),
                &["O", "T", "L", "S", "Z"],
            );
            app.poll_zenith_dry_run();
        }
    }

    fn write_zenith_invalid_passive_snapshot_missing_current_type(paths: &AppPaths) {
        let path = zenith_passive_snapshot_path(paths);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let board = vec![vec![serde_json::Value::Bool(false); 10]; 40];
        let raw = json!({
            "status": "ready",
            "capture_status": "running",
            "snapshot": {
                "source": "zenith_passive",
                "capture_generation": 5,
                "timestamp": 1722422400123u64,
                "userid": "user-zenith",
                "gameid": "game-zenith",
                "candidate_id": "candidate-1",
                "playing": true,
                "started": true,
                "countdown_started": false,
                "paused": false,
                "destroyed": false,
                "gameoverreason": null,
                "board": board,
                "current": {
                    "x": 4,
                    "y": 19,
                    "rotation": "north"
                },
                "hold": null,
                "queue": ["O", "T", "L", "S", "Z"],
                "piece_counter": 7
            }
        });
        fs::write(path, serde_json::to_vec(&raw).unwrap()).unwrap();
    }

    fn read_test_zenith_passive_snapshot(paths: &AppPaths) -> ZenithPassivePlannerSnapshot {
        let path = zenith_passive_snapshot_path(paths);
        let (envelope, _) = read_zenith_passive_snapshot_file_with_age(&path)
            .unwrap()
            .expect("test Zenith passive snapshot to exist");
        envelope
            .snapshot
            .expect("test Zenith passive snapshot payload")
    }

    #[test]
    fn built_in_preset_uses_safe_defaults() {
        let mut state = LauncherState::default();
        state.preset = ModePreset::Solo1080p;
        state.apply_preset();

        assert_eq!(state.bot.movement_mode, MovementModeConfig::ZeroGSafe);
        assert_eq!(state.bot.spawn_rule, SpawnRuleConfig::Row19Or20);
        assert!(state.pps_unlimited);
        assert_eq!(state.effective_target_pps(), 0.0);
        assert_eq!(state.target_pps, 3.0);
        assert_eq!(state.tap_duration_ms, 60);
        assert_eq!(state.poll_interval_ms, 8);
        assert_eq!(state.movement_tap_duration_ms, 10);
        assert_eq!(state.rotate_tap_duration_ms, 10);
        assert_eq!(state.hold_tap_duration_ms, 10);
        assert_eq!(state.hard_drop_tap_duration_ms, 8);
        assert_eq!(state.soft_drop_tap_duration_ms, 10);
        assert_eq!(state.movement_interval_ms, 0);
        assert_eq!(state.rotation_interval_ms, 0);
        assert_eq!(state.piece_interval_ms, 0);
        assert_eq!(state.hard_drop_interval_ms, 0);
        assert_eq!(state.min_snapshot_age_ms, 0);
        assert_eq!(state.snapshot_provider, SnapshotProviderConfig::BrowserCdp);
        assert_eq!(state.input_backend, InputBackendConfig::BrowserCdp);
        assert!(state.handling.allow_post_softdrop_actions);
        assert!(!state.handling.allow_post_softdrop_horizontal);
        assert!(!state.handling.release_after_each_action);
        assert_eq!(state.handling.action_settle_ms, 0);
        assert_eq!(state.handling.irs_mode, BufferModeConfig::Off);
        assert_eq!(state.handling.ihs_mode, BufferModeConfig::Off);
    }

    #[test]
    fn readme_matches_safe_preset_defaults() {
        let readme = include_str!("../README.md");
        assert!(readme.contains("Open Chromium"));
        assert!(readme.contains("Bot ON"));
        assert!(readme.contains("snapshot and input CDP helpers"));
        assert!(readme.contains("Play Style"));
        assert!(readme.contains("Unlimited"));
        assert!(!readme.contains("choose `2P Left 1080p`, `Solo 1080p`, or `Custom`"));
    }

    #[test]
    fn migrate_legacy_defaults_upgrades_previous_safe_profile() {
        let mut state = LauncherState {
            preset: ModePreset::Solo1080p,
            dry_run: false,
            poll_interval_ms: 4,
            pps_unlimited: true,
            target_pps: 3.0,
            movement_tap_duration_ms: 25,
            rotate_tap_duration_ms: 28,
            hold_tap_duration_ms: 35,
            hard_drop_tap_duration_ms: 30,
            soft_drop_tap_duration_ms: 25,
            movement_interval_ms: 0,
            rotation_interval_ms: 8,
            piece_interval_ms: 0,
            hard_drop_interval_ms: 0,
            min_snapshot_age_ms: 0,
            handling: HandlingConfig {
                release_after_each_action: true,
                action_settle_ms: 0,
                ..HandlingConfig::default()
            },
            ..LauncherState::default()
        };

        state.migrate_legacy_defaults();

        assert_eq!(state.poll_interval_ms, 8);
        assert_eq!(state.movement_tap_duration_ms, 10);
        assert_eq!(state.rotate_tap_duration_ms, 10);
        assert_eq!(state.hold_tap_duration_ms, 10);
        assert_eq!(state.hard_drop_tap_duration_ms, 8);
        assert_eq!(state.movement_interval_ms, 0);
        assert_eq!(state.rotation_interval_ms, 0);
        assert_eq!(state.piece_interval_ms, 0);
        assert_eq!(state.hard_drop_interval_ms, 0);
        assert_eq!(state.min_snapshot_age_ms, 0);
        assert_eq!(state.handling.action_settle_ms, 0);
        assert!(!state.handling.release_after_each_action);
    }

    #[test]
    fn bot_config_forces_connect_only() {
        let paths = AppPaths::discover();
        let state = LauncherState::default();
        let config = state.to_bot_automation_config(&paths);
        assert!(config.browser.connect_only);
    }

    #[test]
    fn launcher_state_missing_play_style_defaults_to_normal() {
        let state: LauncherState = serde_json::from_value(json!({
            "preset": "Solo1080p"
        }))
        .unwrap();
        assert_eq!(state.play_style, PlayStyleConfig::Normal);
    }

    #[test]
    fn default_selected_mode_is_solo() {
        let state = LauncherState::default();
        assert_eq!(state.selected_mode, RuntimeMode::Solo);
        assert!(!state.bot_enabled);
        assert_eq!(state.mode_generation, 0);
    }

    #[test]
    fn friendly_vs_live_input_defaults_to_false() {
        let state = LauncherState::default();
        assert!(!state.friendly_vs_live_input_enabled);
        assert_eq!(state.effective_friendly_vs_live_limit(), FriendlyVsLiveLimit::Twenty);

        let paths = test_paths("friendly-vs-live-default-false");
        let app = LauncherApp::new(paths.clone());
        assert!(app.state.friendly_vs_live_input_enabled);
        assert_eq!(
            app.state.effective_friendly_vs_live_limit(),
            FriendlyVsLiveLimit::Unlimited
        );
        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_limit_missing_field_defaults_to_twenty() {
        let state: LauncherState =
            serde_json::from_value(json!({ "friendly_vs_live_input_enabled": true })).unwrap();
        assert_eq!(
            state.effective_friendly_vs_live_limit(),
            FriendlyVsLiveLimit::Twenty
        );
    }

    #[test]
    fn friendly_vs_live_limit_accepts_unlimited_value() {
        let state: LauncherState =
            serde_json::from_value(json!({ "friendly_vs_live_limit": "unlimited" })).unwrap();
        assert_eq!(
            state.effective_friendly_vs_live_limit(),
            FriendlyVsLiveLimit::Unlimited
        );
    }

    #[test]
    fn friendly_vs_live_limit_serializes_with_twenty_or_unlimited() {
        let mut state = LauncherState::default();
        let serialized = serde_json::to_value(&state).unwrap();
        assert_eq!(
            serialized.get("friendly_vs_live_limit"),
            Some(&serde_json::Value::Number(FRIENDLY_VS_LIVE_MAX_PLACEMENTS.into()))
        );

        state.friendly_vs_live_limit = FriendlyVsLiveLimit::Unlimited;
        let serialized = serde_json::to_value(state).unwrap();
        assert_eq!(
            serialized.get("friendly_vs_live_limit"),
            Some(&serde_json::Value::String("unlimited".to_owned()))
        );
    }

    #[test]
    fn friendly_vs_live_limit_invalid_values_fall_back_to_twenty() {
        for raw in [
            json!({ "friendly_vs_live_limit": 0 }),
            json!({ "friendly_vs_live_limit": 21 }),
            json!({ "friendly_vs_live_limit": null }),
            json!({ "friendly_vs_live_limit": "20" }),
        ] {
            let state: LauncherState = serde_json::from_value(raw).unwrap();
            assert_eq!(
                state.effective_friendly_vs_live_limit(),
                FriendlyVsLiveLimit::Twenty
            );
        }
    }

    #[test]
    fn friendly_vs_live_status_label_uses_unlimited_limit() {
        let paths = test_paths("friendly-vs-live-status-labels");
        let mut app = LauncherApp::new(paths.clone());
        app.state.friendly_vs_live_input_enabled = true;
        app.friendly_vs_live.executed_placements = 7;

        assert_eq!(
            app.friendly_vs_live_status_label(),
            "Friendly VS: Live (7/Unlimited)"
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn snapshot_provider_control_failure_marks_provider_unavailable_once() {
        let paths = test_paths("snapshot-provider-control-failure");
        let mut app = LauncherApp::new(paths.clone());

        app.note_snapshot_provider_control_failure(
            "friendly_vs_capture_enabled",
            &anyhow::anyhow!("broken pipe (os error 232)"),
        );
        app.note_snapshot_provider_control_failure(
            "friendly_vs_capture_enabled",
            &anyhow::anyhow!("broken pipe (os error 232)"),
        );

        assert_eq!(app.snapshot_status, SnapshotStatus::Error);
        assert_eq!(app.browser_status, BrowserStatus::Error);
        assert!(!app.friendly_vs_capture_enabled);
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| {
                    line.contains(
                        "failed to forward friendly_vs_capture_enabled to snapshot provider",
                    )
                })
                .count(),
            1
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_capture_sync_stays_bounded_after_provider_error() {
        let paths = test_paths("friendly-vs-capture-sync-bounded");
        let mut app = LauncherApp::new(paths.clone());
        app.snapshot_status = SnapshotStatus::Error;
        app.browser_status = BrowserStatus::Error;
        let initial_log_count = app.logs.len();

        assert!(!app.sync_friendly_vs_capture_enabled(true, Some("7001:seed-1"), Some("7001")));
        assert_eq!(app.logs.len(), initial_log_count);
        assert!(!app.friendly_vs_capture_enabled);

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_bot_on_arms_passive_observer_without_runner() {
        let paths = test_paths("friendly-vs-observer-only");
        let mut app = LauncherApp::new(paths.clone());
        configure_friendly_vs_runtime_ready(&mut app);

        app.start_bot();

        assert_eq!(app.bot_status, BotStatus::On);
        assert!(app.bot_desired_enabled);
        assert!(app.bot_session.is_none());
        assert!(app
            .logs
            .iter()
            .any(|line| line == "[friendly-vs] observer armed"));
        assert!(!app.friendly_vs_capture_enabled);
        assert!(!app
            .logs
            .iter()
            .any(|line| line.contains("[bot] planner started")));
        assert!(!app
            .logs
            .iter()
            .any(|line| line.contains("[zenith-live] input dispatched")));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_bot_on_arms_before_bootstrap_bridge_write_and_admits_on_first_poll() {
        let paths = test_paths("friendly-vs-pre-arm-before-bootstrap");
        let mut app = LauncherApp::new(paths.clone());
        configure_friendly_vs_runtime_ready(&mut app);
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        write_friendly_vs_bridge(
            &paths,
            2,
            "5449:1744077000",
            false,
            now_ms.saturating_sub(10_000),
            now_ms.saturating_sub(5_000),
            "local-id",
            "fixture-user",
            5449,
            1744077000,
            5,
            &[5450],
            0,
        );

        app.start_bot();

        assert!(app.friendly_vs.armed);
        assert_eq!(app.friendly_vs.baseline_sequence, Some(2));
        assert_eq!(app.friendly_vs_capture_enabled, false);

        write_friendly_vs_bridge(
            &paths,
            3,
            "4942:461010047",
            true,
            now_ms.saturating_add(1_000),
            now_ms.saturating_sub(1),
            "6a77d006f9f0612f4cbde602",
            "guest-2e94ioia_",
            4942,
            461010047,
            5,
            &[4941],
            0,
        );

        app.poll_friendly_vs_observer();

        assert!(app.logs.iter().any(|line| {
            line == "[friendly-vs] identity ready userid=6a77d006f9f0612f4cbde602 gameid=4942 round_id=4942:461010047"
        }));
        assert!(app.logs.iter().any(|line| {
            line == "[friendly-vs] options ready seed=461010047 bagtype=7-bag nextcount=5"
        }));
        assert!(app
            .logs
            .iter()
            .any(|line| { line == "[friendly-vs] round active opponents=1 incoming_garbage=0" }));
        assert!(!app
            .logs
            .iter()
            .any(|line| line.contains("round_id=5449:1744077000")));
        assert!(app.friendly_vs_capture_enabled);
        assert_eq!(
            app.friendly_vs_capture_round_id.as_deref(),
            Some("4942:461010047")
        );
        assert_eq!(
            app.friendly_vs_capture_local_game_id.as_deref(),
            Some("4942")
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_bot_off_keeps_observer_inactive() {
        let paths = test_paths("friendly-vs-bot-off");
        let mut app = LauncherApp::new(paths.clone());
        configure_friendly_vs_runtime_ready(&mut app);

        app.poll_friendly_vs_observer();

        assert!(!app.friendly_vs.armed);
        assert!(!app
            .logs
            .iter()
            .any(|line| line.starts_with("[friendly-vs] observer")));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_waiting_reason_is_mirrored_once() {
        let paths = test_paths("friendly-vs-waiting");
        let mut app = LauncherApp::new(paths.clone());
        configure_friendly_vs_runtime_ready(&mut app);
        app.bot_desired_enabled = true;
        app.bot_status = BotStatus::On;
        app.poll_friendly_vs_observer();

        app.event_tx
            .send(LauncherEvent::BrowserLog(
                "[vs-bridge] waiting reason=self_user_missing".to_owned(),
            ))
            .unwrap();
        app.event_tx
            .send(LauncherEvent::BrowserLog(
                "[vs-bridge] waiting reason=self_user_missing".to_owned(),
            ))
            .unwrap();
        app.poll_events();

        let waiting_logs = app
            .logs
            .iter()
            .filter(|line| line.as_str() == "[friendly-vs] waiting reason=self_user_missing")
            .count();
        assert_eq!(waiting_logs, 1);

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_stale_bridge_is_not_promoted_until_fresh_sequence_advances() {
        let paths = test_paths("friendly-vs-stale-baseline");
        let mut app = LauncherApp::new(paths.clone());
        configure_friendly_vs_runtime_ready(&mut app);
        app.bot_desired_enabled = true;
        app.bot_status = BotStatus::On;
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        write_friendly_vs_bridge(
            &paths,
            10,
            "7001:1744077373",
            true,
            now_ms.saturating_sub(500),
            now_ms.saturating_sub(1),
            "local-id",
            "hebi_",
            7001,
            1744077373,
            5,
            &[8002],
            0,
        );

        app.poll_friendly_vs_observer();
        app.poll_friendly_vs_observer();

        assert!(app
            .logs
            .iter()
            .any(|line| line == "[friendly-vs] observer armed"));
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.as_str() == "[friendly-vs] waiting reason=bridge_not_fresh")
                .count(),
            1
        );
        assert!(!app
            .logs
            .iter()
            .any(|line| line.contains("[friendly-vs] identity ready")));

        write_friendly_vs_bridge(
            &paths,
            11,
            "7001:1744077373",
            true,
            now_ms.saturating_add(1_000),
            now_ms.saturating_add(60_000),
            "local-id",
            "hebi_",
            7001,
            1744077373,
            5,
            &[8002],
            0,
        );

        app.poll_friendly_vs_observer();

        assert!(app.logs.iter().any(|line| {
            line == "[friendly-vs] identity ready userid=local-id gameid=7001 round_id=7001:1744077373"
        }));
        assert!(app.logs.iter().any(|line| {
            line == "[friendly-vs] options ready seed=1744077373 bagtype=7-bag nextcount=5"
        }));
        assert!(!app
            .logs
            .iter()
            .any(|line| line.contains("gameid=8002 round_id=7001:1744077373")));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_admitted_bridge_same_sequence_stays_ready_until_round_active() {
        let paths = test_paths("friendly-vs-same-sequence-ready-at");
        let mut app = LauncherApp::new(paths.clone());
        configure_friendly_vs_runtime_ready(&mut app);
        app.bot_desired_enabled = true;
        app.bot_status = BotStatus::On;
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        write_friendly_vs_bridge(
            &paths,
            10,
            "7001:1744077373",
            true,
            now_ms.saturating_sub(500),
            now_ms.saturating_sub(1),
            "stale-id",
            "stale-user",
            7001,
            1744077373,
            5,
            &[8002],
            0,
        );
        app.poll_friendly_vs_observer();

        write_friendly_vs_bridge(
            &paths,
            11,
            "7001:1744077373",
            true,
            now_ms.saturating_add(1_000),
            now_ms.saturating_add(250),
            "local-id",
            "hebi_",
            7001,
            1744077373,
            5,
            &[8002],
            2,
        );
        app.poll_friendly_vs_observer();
        app.poll_friendly_vs_observer();

        assert_eq!(
            app.logs
                .iter()
                .filter(|line| {
                    line.as_str()
                        == "[friendly-vs] identity ready userid=local-id gameid=7001 round_id=7001:1744077373"
                })
                .count(),
            1
        );
        assert!(!app.friendly_vs_capture_enabled);
        assert!(!app.logs.iter().any(
            |line| line.as_str() == "[friendly-vs] round active opponents=1 incoming_garbage=2"
        ));

        std::thread::sleep(Duration::from_millis(300));
        app.poll_friendly_vs_observer();

        assert!(app.logs.iter().any(
            |line| line.as_str() == "[friendly-vs] round active opponents=1 incoming_garbage=2"
        ));
        assert!(app.friendly_vs_capture_enabled);

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_fresh_unresolved_bridge_does_not_promote_stale_identity() {
        let paths = test_paths("friendly-vs-fresh-unresolved");
        let mut app = LauncherApp::new(paths.clone());
        configure_friendly_vs_runtime_ready(&mut app);
        app.bot_desired_enabled = true;
        app.bot_status = BotStatus::On;
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        write_friendly_vs_bridge(
            &paths,
            10,
            "7001:1744077373",
            true,
            now_ms.saturating_sub(500),
            now_ms.saturating_sub(1),
            "local-id",
            "hebi_",
            7001,
            1744077373,
            5,
            &[8002],
            2,
        );
        app.poll_friendly_vs_observer();

        write_friendly_vs_bridge(
            &paths,
            11,
            "7001:1744077373",
            true,
            now_ms.saturating_add(1_000),
            now_ms.saturating_add(60_000),
            "",
            "hebi_",
            7001,
            1744077373,
            5,
            &[8002],
            2,
        );
        app.poll_friendly_vs_observer();
        app.event_tx
            .send(LauncherEvent::BrowserLog(
                "[vs-bridge] waiting reason=local_player_unresolved".to_owned(),
            ))
            .unwrap();
        app.poll_events();

        assert!(!app
            .logs
            .iter()
            .any(|line| line.contains("[friendly-vs] identity ready")));
        assert!(app
            .logs
            .iter()
            .any(|line| { line == "[friendly-vs] waiting reason=local_player_unresolved" }));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_round_lifecycle_resets_on_new_round() {
        let paths = test_paths("friendly-vs-round-lifecycle");
        let mut app = LauncherApp::new(paths.clone());
        configure_friendly_vs_runtime_ready(&mut app);
        app.bot_desired_enabled = true;
        app.bot_status = BotStatus::On;
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        write_friendly_vs_bridge(
            &paths,
            10,
            "6999:1744077000",
            true,
            now_ms.saturating_sub(500),
            now_ms.saturating_sub(1),
            "stale-id",
            "stale-user",
            6999,
            1744077000,
            5,
            &[7998],
            0,
        );
        app.poll_friendly_vs_observer();

        write_friendly_vs_bridge(
            &paths,
            11,
            "7001:1744077373",
            true,
            now_ms.saturating_add(1_000),
            now_ms.saturating_sub(1),
            "local-id",
            "hebi_",
            7001,
            1744077373,
            5,
            &[8002],
            2,
        );
        app.poll_friendly_vs_observer();

        write_friendly_vs_bridge(
            &paths,
            12,
            "7001:1744077373",
            false,
            now_ms.saturating_add(2_000),
            now_ms.saturating_sub(1),
            "local-id",
            "hebi_",
            7001,
            1744077373,
            5,
            &[8002],
            2,
        );
        app.poll_friendly_vs_observer();

        write_friendly_vs_bridge(
            &paths,
            13,
            "7003:1744077374",
            true,
            now_ms.saturating_add(3_000),
            now_ms.saturating_sub(1),
            "local-id",
            "hebi_",
            7003,
            1744077374,
            5,
            &[8004, 8005],
            1,
        );
        app.poll_friendly_vs_observer();

        assert!(!app.logs.iter().any(|line| {
            line == "[friendly-vs] identity ready userid=stale-id gameid=6999 round_id=6999:1744077000"
        }));
        assert!(app
            .logs
            .iter()
            .any(|line| { line == "[friendly-vs] round active opponents=1 incoming_garbage=2" }));
        assert!(app
            .logs
            .iter()
            .any(|line| line == "[friendly-vs] round ended round_id=7001:1744077373"));
        assert!(app.logs.iter().any(|line| {
            line == "[friendly-vs] identity ready userid=local-id gameid=7003 round_id=7003:1744077374"
        }));
        assert!(app
            .logs
            .iter()
            .any(|line| { line == "[friendly-vs] round active opponents=2 incoming_garbage=1" }));
        assert_eq!(
            app.friendly_vs_capture_round_id.as_deref(),
            Some("7003:1744077374")
        );
        assert_eq!(
            app.friendly_vs_capture_local_game_id.as_deref(),
            Some("7003")
        );
        assert_eq!(app.friendly_vs.resolved_game_id.as_deref(), Some("7003"));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_rearm_requires_fresh_sequence_before_ready() {
        let paths = test_paths("friendly-vs-rearm-freshness");
        let mut app = LauncherApp::new(paths.clone());
        configure_friendly_vs_runtime_ready(&mut app);
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        write_friendly_vs_bridge(
            &paths,
            10,
            "7001:1744077373",
            true,
            now_ms.saturating_sub(500),
            now_ms.saturating_sub(1),
            "local-id",
            "hebi_",
            7001,
            1744077373,
            5,
            &[8002],
            0,
        );

        app.start_bot();
        app.poll_friendly_vs_observer();
        assert!(!app
            .logs
            .iter()
            .any(|line| line.contains("[friendly-vs] identity ready")));

        app.stop_bot_with_browser_hint(false);
        app.poll_friendly_vs_observer();

        app.start_bot();
        app.poll_friendly_vs_observer();
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[friendly-vs] identity ready"))
                .count(),
            0
        );

        write_friendly_vs_bridge(
            &paths,
            11,
            "7001:1744077373",
            true,
            now_ms.saturating_add(1_000),
            now_ms.saturating_add(60_000),
            "local-id",
            "hebi_",
            7001,
            1744077373,
            5,
            &[8002],
            0,
        );
        app.poll_friendly_vs_observer();

        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[friendly-vs] identity ready"))
                .count(),
            1
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_mode_change_stops_observer_and_clears_state() {
        let paths = test_paths("friendly-vs-mode-change");
        let mut app = LauncherApp::new(paths.clone());
        configure_friendly_vs_runtime_ready(&mut app);
        app.bot_desired_enabled = true;
        app.bot_status = BotStatus::On;
        app.poll_friendly_vs_observer();

        app.select_mode(RuntimeMode::Solo);
        app.poll_friendly_vs_observer();

        assert!(app
            .logs
            .iter()
            .any(|line| line == "[friendly-vs] observer stopped"));
        assert!(!app.friendly_vs.armed);
        assert!(!app.friendly_vs_capture_enabled);

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_bot_off_disables_capture_gate_immediately() {
        let paths = test_paths("friendly-vs-bot-off-disables-capture");
        let mut app = LauncherApp::new(paths.clone());
        configure_friendly_vs_runtime_ready(&mut app);
        app.bot_desired_enabled = true;
        app.bot_status = BotStatus::On;
        app.friendly_vs_capture_enabled = true;

        app.stop_bot_with_browser_hint(false);

        assert!(!app.friendly_vs_capture_enabled);

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_dry_run_plans_once_per_piece_without_dispatch() {
        let paths = test_paths("friendly-vs-dry-run-once");
        let mut app = LauncherApp::new(paths.clone());
        configure_friendly_vs_runtime_ready(&mut app);
        app.state.friendly_vs_live_input_enabled = false;
        app.start_bot();
        app.logs.clear();
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        app.poll_friendly_vs_observer();
        write_friendly_vs_bridge(
            &paths,
            1,
            "7001:1744077373",
            true,
            now_ms.saturating_add(1_000),
            now_ms.saturating_sub(1),
            "local-id",
            "guest-local",
            7001,
            1_744_077_373,
            5,
            &[7002],
            0,
        );
        app.poll_friendly_vs_observer();

        write_friendly_vs_passive_snapshot(
            &paths,
            "7001:1744077373",
            "7001",
            "cand-local",
            4,
            json!("friendly-user"),
            "J",
            &["O", "T", "L", "S", "Z"],
        );
        app.poll_friendly_vs_dry_run();
        app.poll_friendly_vs_dry_run();

        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[friendly-vs-dry-run] snapshot ready"))
                .count(),
            1
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[friendly-vs-dry-run] plan ready"))
                .count(),
            1
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| {
                    line == &&"[friendly-vs-dry-run] snapshot skipped reason=duplicate_piece"
                        .to_owned()
                })
                .count(),
            1
        );
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            0
        );
        assert!(app.bot_session.is_none());

        std::thread::sleep(Duration::from_millis(20));
        write_friendly_vs_passive_snapshot(
            &paths,
            "7001:1744077373",
            "7001",
            "cand-local",
            5,
            json!("friendly-user"),
            "T",
            &["I", "O", "L", "S", "Z"],
        );
        app.poll_friendly_vs_dry_run();

        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[friendly-vs-dry-run] plan ready"))
                .count(),
            2
        );
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            0
        );
        assert!(app.bot_session.is_none());

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_off_keeps_dry_run_only() {
        let paths = test_paths("friendly-vs-live-off");
        let mut app = LauncherApp::new(paths.clone());
        configure_friendly_vs_runtime_ready(&mut app);
        app.state.friendly_vs_live_input_enabled = false;
        assert!(!app.state.friendly_vs_live_input_enabled);
        app.start_bot();
        assert!(app
            .logs
            .iter()
            .any(|line| line == "[friendly-vs-live] input disabled mode=dry_run"));
        app.logs.clear();
        arm_friendly_vs_round(&mut app, &paths, "7001:1744077373", 7001);

        write_friendly_vs_passive_snapshot(
            &paths,
            "7001:1744077373",
            "7001",
            "cand-local",
            4,
            json!("friendly-user"),
            "J",
            &["O", "T", "L", "S", "Z"],
        );
        app.poll_friendly_vs_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            0
        );
        assert!(app
            .logs
            .iter()
            .any(|line| line.contains("[friendly-vs-dry-run] plan ready")));
        assert!(!app
            .logs
            .iter()
            .any(|line| line.contains("[friendly-vs-live] input dispatch")));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_dry_run_gameid_mismatch_does_not_stall_retry() {
        let paths = test_paths("friendly-vs-dry-run-retry");
        let mut app = LauncherApp::new(paths.clone());
        configure_friendly_vs_runtime_ready(&mut app);
        app.state.friendly_vs_live_input_enabled = false;
        app.start_bot();
        app.logs.clear();
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        app.poll_friendly_vs_observer();
        write_friendly_vs_bridge(
            &paths,
            1,
            "7001:1744077373",
            true,
            now_ms.saturating_add(1_000),
            now_ms.saturating_sub(1),
            "local-id",
            "guest-local",
            7001,
            1_744_077_373,
            5,
            &[7002],
            0,
        );
        app.poll_friendly_vs_observer();

        write_friendly_vs_passive_snapshot(
            &paths,
            "7001:1744077373",
            "7999",
            "cand-opponent",
            3,
            json!("friendly-user"),
            "J",
            &["O", "T", "L", "S", "Z"],
        );
        app.poll_friendly_vs_dry_run();

        assert!(app
            .logs
            .iter()
            .any(|line| line
                .contains("[friendly-vs-dry-run] snapshot skipped reason=gameid_mismatch")));
        assert!(!app
            .logs
            .iter()
            .any(|line| line.contains("[friendly-vs-dry-run] plan ready")));

        std::thread::sleep(Duration::from_millis(20));
        write_friendly_vs_passive_snapshot(
            &paths,
            "7001:1744077373",
            "7001",
            "cand-local",
            3,
            json!("friendly-user"),
            "J",
            &["O", "T", "L", "S", "Z"],
        );
        app.poll_friendly_vs_dry_run();

        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[friendly-vs-dry-run] plan ready"))
                .count(),
            1
        );
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            0
        );
        assert!(app.bot_session.is_none());

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_dry_run_ready_snapshot_with_null_userid_reaches_planner() {
        let paths = test_paths("friendly-vs-dry-run-null-userid");
        let mut app = LauncherApp::new(paths.clone());
        configure_friendly_vs_runtime_ready(&mut app);
        app.state.friendly_vs_live_input_enabled = false;
        app.start_bot();
        app.logs.clear();
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        app.poll_friendly_vs_observer();
        write_friendly_vs_bridge(
            &paths,
            1,
            "7001:1744077373",
            true,
            now_ms.saturating_add(1_000),
            now_ms.saturating_sub(1),
            "local-id",
            "guest-local",
            7001,
            1_744_077_373,
            5,
            &[7002],
            0,
        );
        app.poll_friendly_vs_observer();

        write_friendly_vs_passive_snapshot(
            &paths,
            "7001:1744077373",
            "7001",
            "cand-local",
            4,
            json!(null),
            "J",
            &["O", "T", "L", "S", "Z"],
        );
        app.poll_friendly_vs_dry_run();
        app.poll_friendly_vs_dry_run();

        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[friendly-vs-dry-run] snapshot ready"))
                .count(),
            1
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[friendly-vs-dry-run] plan ready"))
                .count(),
            1
        );
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            0
        );
        assert!(app.bot_session.is_none());

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_dry_run_parse_error_logging_is_bounded_across_line_drift() {
        let paths = test_paths("friendly-vs-dry-run-parse-dedupe");
        let mut app = LauncherApp::new(paths.clone());
        configure_friendly_vs_runtime_ready(&mut app);
        app.start_bot();
        app.logs.clear();
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        app.poll_friendly_vs_observer();
        write_friendly_vs_bridge(
            &paths,
            1,
            "7001:1744077373",
            true,
            now_ms.saturating_add(1_000),
            now_ms.saturating_sub(1),
            "local-id",
            "guest-local",
            7001,
            1_744_077_373,
            5,
            &[7002],
            0,
        );
        app.poll_friendly_vs_observer();

        write_friendly_vs_invalid_snapshot_null_round_id(&paths, 0);
        for _ in 0..50 {
            app.poll_friendly_vs_dry_run();
        }

        write_friendly_vs_invalid_snapshot_null_round_id(&paths, 6);
        for _ in 0..50 {
            app.poll_friendly_vs_dry_run();
        }

        assert_eq!(
            app.logs
                .iter()
                .filter(|line| {
                    line.contains(
                        "[friendly-vs-dry-run] snapshot skipped reason=semantic_invalid error=failed to parse Friendly VS passive snapshot JSON: invalid type: null, expected a string"
                    )
                })
                .count(),
            1
        );

        app.friendly_vs_dry_run.last_skip_logged_at = Some(
            Instant::now() - FRIENDLY_VS_DRY_RUN_SKIP_LOG_COOLDOWN - Duration::from_millis(10),
        );
        app.poll_friendly_vs_dry_run();

        assert_eq!(
            app.logs
                .iter()
                .filter(|line| {
                    line.contains(
                        "[friendly-vs-dry-run] snapshot skipped reason=semantic_invalid error=failed to parse Friendly VS passive snapshot JSON: invalid type: null, expected a string"
                    )
                })
                .count(),
            2
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_dispatches_twenty_times_then_locks_same_round() {
        let (paths, mut app, round_id) = setup_friendly_vs_live_app("friendly-vs-live-twenty");
        app.logs.clear();
        poll_friendly_vs_live_test_sequence(
            &mut app,
            &paths,
            &round_id,
            4,
            FRIENDLY_VS_LIVE_MAX_PLACEMENTS + 1,
        );

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            FRIENDLY_VS_LIVE_MAX_PLACEMENTS
        );
        assert!(app
            .logs
            .iter()
            .any(|line| line.contains("[friendly-vs-live] plan accepted")));
        assert!(app
            .logs
            .iter()
            .any(|line| line.contains("[friendly-vs-live] freshness confirmed")));
        assert!(app
            .logs
            .iter()
            .any(|line| line.contains("[friendly-vs-live] input dispatch actions=")));
        assert_eq!(
            app.friendly_vs_live.executed_placements,
            FRIENDLY_VS_LIVE_MAX_PLACEMENTS
        );
        assert!(app.logs.iter().any(|line| {
            line == &format!(
                "[friendly-vs-live] placement executed count={}/{}",
                FRIENDLY_VS_LIVE_MAX_PLACEMENTS,
                FRIENDLY_VS_LIVE_MAX_PLACEMENTS
            )
        }));
        assert!(app
            .logs
            .iter()
            .any(|line| { line == "[friendly-vs-live] input locked reason=placement_limit" }));
        assert!(app.logs.iter().any(|line| {
            line.contains("[friendly-vs-live] input suppressed reason=placement_limit")
        }));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_unlimited_dispatches_fifty_times_without_limit_lock() {
        let (paths, mut app, round_id) = setup_friendly_vs_live_app_with_options(
            "friendly-vs-live-unlimited-fifty",
            true,
            FriendlyVsLiveLimit::Unlimited,
        );
        let reread_count = Arc::new(AtomicU32::new(0));
        app.logs.clear();

        for offset in 0..50u32 {
            let reread_count = reread_count.clone();
            app.friendly_vs_live_before_reread = Some(Box::new(move |_| {
                reread_count.fetch_add(1, Ordering::Relaxed);
            }));
            poll_friendly_vs_live_test_piece(
                &mut app,
                &paths,
                &round_id,
                4 + offset,
                offset as usize,
            );
        }

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            50
        );
        assert_eq!(app.friendly_vs_live.executed_placements, 50);
        assert_eq!(reread_count.load(Ordering::Relaxed), 50);
        assert_eq!(app.friendly_vs_live_status_label(), "Friendly VS: Live (50/Unlimited)");
        assert!(app.logs.iter().any(|line| {
            line == "[friendly-vs-live] placement executed count=50/Unlimited"
        }));
        assert!(!app.logs.iter().any(|line| {
            line.contains("[friendly-vs-live] input locked reason=placement_limit")
                || line.contains("[friendly-vs-live] input suppressed reason=placement_limit")
        }));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_toggle_on_waits_for_next_fresh_piece_without_restarting_capture() {
        let (paths, mut app, round_id) =
            setup_friendly_vs_live_app_with_enabled("friendly-vs-live-toggle-on", false);

        write_friendly_vs_passive_snapshot(
            &paths,
            &round_id,
            "7001",
            "cand-local",
            4,
            json!("friendly-user"),
            "J",
            &["O", "T", "L", "S", "Z"],
        );
        app.poll_friendly_vs_dry_run();
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            0
        );

        let active_round_before = app.friendly_vs.active_round_id.clone();
        let active_game_before = app.friendly_vs.resolved_game_id.clone();
        let capture_enabled_before = app.friendly_vs_capture_enabled;
        let log_count_before_toggle = app.logs.len();

        app.set_friendly_vs_live_input_enabled(true);
        app.poll_friendly_vs_dry_run();

        assert_eq!(app.friendly_vs.active_round_id, active_round_before);
        assert_eq!(app.friendly_vs.resolved_game_id, active_game_before);
        assert_eq!(app.friendly_vs_capture_enabled, capture_enabled_before);
        assert!(app
            .logs
            .iter()
            .any(|line| line == &format!("[friendly-vs-live] enabled count=0/20")));
        assert!(!app.logs[log_count_before_toggle..].iter().any(|line| {
            line.contains("[friendly-vs] observer armed")
                || line.contains("[friendly-vs] identity ready")
                || line.contains("[friendly-vs] round active")
        }));
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            0
        );

        poll_friendly_vs_live_test_piece(&mut app, &paths, &round_id, 5, 1);

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert!(app
            .logs
            .iter()
            .any(|line| {
                line
                    == &format!(
                        "[friendly-vs-live] placement executed count=1/{}",
                        FRIENDLY_VS_LIVE_MAX_PLACEMENTS
                    )
            }));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_toggle_off_then_on_same_round_keeps_count_and_dry_run() {
        let (paths, mut app, round_id) =
            setup_friendly_vs_live_app("friendly-vs-live-toggle-off-on");

        write_friendly_vs_passive_snapshot(
            &paths,
            &round_id,
            "7001",
            "cand-local",
            4,
            json!("friendly-user"),
            "J",
            &["O", "T", "L", "S", "Z"],
        );
        app.poll_friendly_vs_dry_run();
        app.set_friendly_vs_live_input_enabled(false);

        std::thread::sleep(Duration::from_millis(20));
        write_friendly_vs_passive_snapshot(
            &paths,
            &round_id,
            "7001",
            "cand-local",
            5,
            json!("friendly-user"),
            "T",
            &["I", "O", "L", "S", "Z"],
        );
        app.poll_friendly_vs_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert!(app
            .logs
            .iter()
            .any(|line| {
                line
                    == &format!(
                        "[friendly-vs-live] disabled count=1/{}",
                        FRIENDLY_VS_LIVE_MAX_PLACEMENTS
                    )
            }));
        assert!(app
            .logs
            .iter()
            .any(|line| line.contains("[friendly-vs-dry-run] plan ready")));
        assert_eq!(app.friendly_vs_live.executed_placements, 1);

        app.set_friendly_vs_live_input_enabled(true);
        assert!(app
            .logs
            .iter()
            .any(|line| {
                line
                    == &format!(
                        "[friendly-vs-live] enabled count=1/{}",
                        FRIENDLY_VS_LIVE_MAX_PLACEMENTS
                    )
            }));

        poll_friendly_vs_live_test_piece(&mut app, &paths, &round_id, 6, 2);

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            2
        );
        assert!(app
            .logs
            .iter()
            .any(|line| {
                line
                    == &format!(
                        "[friendly-vs-live] placement executed count=2/{}",
                        FRIENDLY_VS_LIVE_MAX_PLACEMENTS
                    )
            }));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_unlimited_toggle_off_then_on_same_round_keeps_count_and_dry_run() {
        let (paths, mut app, round_id) = setup_friendly_vs_live_app_with_options(
            "friendly-vs-live-unlimited-toggle-off-on",
            true,
            FriendlyVsLiveLimit::Unlimited,
        );

        write_friendly_vs_passive_snapshot(
            &paths,
            &round_id,
            "7001",
            "cand-local",
            4,
            json!("friendly-user"),
            "J",
            &["O", "T", "L", "S", "Z"],
        );
        app.poll_friendly_vs_dry_run();
        app.set_friendly_vs_live_input_enabled(false);

        std::thread::sleep(Duration::from_millis(20));
        write_friendly_vs_passive_snapshot(
            &paths,
            &round_id,
            "7001",
            "cand-local",
            5,
            json!("friendly-user"),
            "T",
            &["I", "O", "L", "S", "Z"],
        );
        app.poll_friendly_vs_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert!(app
            .logs
            .iter()
            .any(|line| line == "[friendly-vs-live] disabled count=1/Unlimited"));
        assert!(app
            .logs
            .iter()
            .any(|line| line.contains("[friendly-vs-dry-run] plan ready")));
        assert_eq!(app.friendly_vs_live.executed_placements, 1);

        app.set_friendly_vs_live_input_enabled(true);
        assert!(app
            .logs
            .iter()
            .any(|line| line == "[friendly-vs-live] enabled count=1/Unlimited"));

        poll_friendly_vs_live_test_piece(&mut app, &paths, &round_id, 6, 2);

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            2
        );
        assert_eq!(app.friendly_vs_live.executed_placements, 2);
        assert!(app.logs.iter().any(|line| {
            line == "[friendly-vs-live] placement executed count=2/Unlimited"
        }));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_flag_is_ignored_outside_friendly_mode() {
        for (name, mode) in [
            ("friendly-vs-live-ignored-solo", RuntimeMode::Solo),
            ("friendly-vs-live-ignored-zenith", RuntimeMode::Zenith),
        ] {
            let paths = test_paths(name);
            let mut app = LauncherApp::new(paths.clone());
            app.state.selected_mode = mode;
            app.state.friendly_vs_live_input_enabled = true;
            app.state.friendly_vs_live_limit = FriendlyVsLiveLimit::Unlimited;
            app.bot_desired_enabled = true;
            app.bot_status = BotStatus::On;
            app.browser_status = BrowserStatus::Ready;
            app.input_status = InputStatus::Ready;
            app.snapshot_status = SnapshotStatus::Ready;
            app.logs.clear();

            write_friendly_vs_passive_snapshot(
                &paths,
                "7001:1744077373",
                "7001",
                "cand-local",
                4,
                json!("friendly-user"),
                "J",
                &["O", "T", "L", "S", "Z"],
            );
            app.poll_friendly_vs_dry_run();

            assert_eq!(
                app.zenith_live_test_hook
                    .dispatch_count
                    .load(Ordering::Relaxed),
                0
            );
            assert!(!app
                .logs
                .iter()
                .any(|line| line.contains("[friendly-vs-live] input dispatch")));

            cleanup_test_paths(&paths);
        }
    }

    #[test]
    fn friendly_vs_live_stale_current_piece_suppresses_input() {
        let (paths, mut app, round_id) = setup_friendly_vs_live_app("friendly-vs-live-stale-piece");
        let planned = friendly_vs_ready_snapshot_value(
            &round_id,
            "7001",
            "cand-local",
            7,
            4,
            json!("friendly-user"),
            "J",
            None,
            &["O", "T", "L", "S", "Z"],
        );
        write_friendly_vs_passive_snapshot_value(&paths, &planned);
        let mut refreshed = planned.clone();
        refreshed["snapshot"]["current"]["type"] = json!("T");
        refreshed["snapshot"]["queue"] = json!(["I", "O", "L", "S", "Z"]);
        app.friendly_vs_live_before_reread = Some(Box::new(move |app| {
            write_friendly_vs_passive_snapshot_value(&app.paths, &refreshed);
        }));

        app.poll_friendly_vs_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            0
        );
        assert!(app.logs.iter().any(|line| {
            line.contains("[friendly-vs-live] plan invalidated before dispatch")
                && line.contains("reason=pose_mismatch")
        }));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_stale_then_fresher_piece_progresses_normally() {
        let (paths, mut app, round_id) =
            setup_friendly_vs_live_app("friendly-vs-live-stale-then-fresh");
        let planned = friendly_vs_ready_snapshot_value(
            &round_id,
            "7001",
            "cand-local",
            7,
            4,
            json!("friendly-user"),
            "J",
            None,
            &["O", "T", "L", "S", "Z"],
        );
        write_friendly_vs_passive_snapshot_value(&paths, &planned);
        let mut refreshed = planned.clone();
        refreshed["snapshot"]["current"]["type"] = json!("T");
        refreshed["snapshot"]["queue"] = json!(["I", "O", "L", "S", "Z"]);
        app.friendly_vs_live_before_reread = Some(Box::new(move |app| {
            write_friendly_vs_passive_snapshot_value(&app.paths, &refreshed);
        }));

        app.poll_friendly_vs_dry_run();

        assert_eq!(app.friendly_vs_live.executed_placements, 0);
        assert!(app.logs.iter().any(|line| {
            line.contains("[friendly-vs-live] plan invalidated before dispatch")
                && line.contains("reason=pose_mismatch")
        }));

        poll_friendly_vs_live_test_piece(&mut app, &paths, &round_id, 5, 1);

        assert_eq!(app.friendly_vs_live.executed_placements, 1);
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_unlimited_duplicate_same_piece_dispatches_once() {
        let (paths, mut app, round_id) = setup_friendly_vs_live_app_with_options(
            "friendly-vs-live-unlimited-duplicate-piece",
            true,
            FriendlyVsLiveLimit::Unlimited,
        );

        write_friendly_vs_passive_snapshot(
            &paths,
            &round_id,
            "7001",
            "cand-local",
            4,
            json!("friendly-user"),
            "J",
            &["O", "T", "L", "S", "Z"],
        );
        app.poll_friendly_vs_dry_run();
        app.poll_friendly_vs_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert_eq!(app.friendly_vs_live.executed_placements, 1);

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_session_pps_is_fixed_while_bot_is_on() {
        let paths = test_paths("friendly-vs-live-session-pps-fixed");
        let mut app = LauncherApp::new(paths.clone());
        app.state.selected_mode = RuntimeMode::FriendlyVs;
        app.state.pps_unlimited = false;
        app.state.target_pps = 2.0;
        app.state.normalize_pps_state();
        configure_friendly_vs_runtime_ready(&mut app);
        app.state.friendly_vs_live_input_enabled = true;
        app.start_bot();
        arm_friendly_vs_round(&mut app, &paths, "7001:1744077373", 7001);

        assert!(!app.friendly_vs_live_pps_unlimited());
        assert_eq!(app.friendly_vs_live_target_pps(), 2.0);
        assert_eq!(
            app.friendly_vs_live_pps_interval(),
            Some(Duration::from_millis(500))
        );

        app.state.pps_unlimited = true;
        app.state.target_pps = 4.0;
        app.state.normalize_pps_state();

        assert!(!app.friendly_vs_live_pps_unlimited());
        assert_eq!(app.friendly_vs_live_target_pps(), 2.0);
        assert_eq!(
            app.friendly_vs_live_pps_interval(),
            Some(Duration::from_millis(500))
        );

        app.stop_bot_with_browser_hint(false);

        assert!(app.friendly_vs_live_pps_unlimited());
        assert_eq!(app.friendly_vs_live_pps_interval(), None);

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_pps_two_enforces_half_second_start_interval() {
        let (paths, mut app, round_id) =
            setup_friendly_vs_live_app("friendly-vs-live-pps-two");
        app.state.pps_unlimited = false;
        app.state.target_pps = 2.0;
        app.state.normalize_pps_state();
        app.update_live_target_pps();
        app.logs.clear();

        let baseline = Instant::now();
        app.test_now = Some(baseline);
        poll_friendly_vs_live_test_piece(&mut app, &paths, &round_id, 4, 0);

        app.test_now = Some(baseline + Duration::from_millis(200));
        poll_friendly_vs_live_test_piece(&mut app, &paths, &round_id, 5, 1);

        app.test_now = Some(baseline + Duration::from_millis(500));
        app.poll_friendly_vs_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(700));
        poll_friendly_vs_live_test_piece(&mut app, &paths, &round_id, 6, 2);

        app.test_now = Some(baseline + Duration::from_millis(1000));
        app.poll_friendly_vs_dry_run();

        assert_eq!(
            friendly_vs_live_started_offsets_ms(&app, baseline),
            vec![0, 500, 1000]
        );
        assert!(app.logs.iter().any(|line| {
            line.contains("[friendly-vs-live] input deferred reason=pps_pacing remaining_ms=")
        }));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_pps_four_enforces_quarter_second_start_interval() {
        let (paths, mut app, round_id) =
            setup_friendly_vs_live_app("friendly-vs-live-pps-four");
        app.state.pps_unlimited = false;
        app.state.target_pps = 4.0;
        app.state.normalize_pps_state();
        app.update_live_target_pps();

        let baseline = Instant::now();
        app.test_now = Some(baseline);
        poll_friendly_vs_live_test_piece(&mut app, &paths, &round_id, 4, 0);

        app.test_now = Some(baseline + Duration::from_millis(100));
        poll_friendly_vs_live_test_piece(&mut app, &paths, &round_id, 5, 1);

        app.test_now = Some(baseline + Duration::from_millis(250));
        app.poll_friendly_vs_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(300));
        poll_friendly_vs_live_test_piece(&mut app, &paths, &round_id, 6, 2);

        app.test_now = Some(baseline + Duration::from_millis(500));
        app.poll_friendly_vs_dry_run();

        assert_eq!(
            friendly_vs_live_started_offsets_ms(&app, baseline),
            vec![0, 250, 500]
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_pps_wait_does_not_replan_same_snapshot() {
        let (paths, mut app, round_id) =
            setup_friendly_vs_live_app("friendly-vs-live-pps-no-replan");
        app.state.pps_unlimited = false;
        app.state.target_pps = 1.0;
        app.state.normalize_pps_state();
        app.update_live_target_pps();
        app.logs.clear();

        let baseline = Instant::now();
        app.test_now = Some(baseline);
        poll_friendly_vs_live_test_piece(&mut app, &paths, &round_id, 4, 0);

        app.test_now = Some(baseline + Duration::from_millis(200));
        poll_friendly_vs_live_test_piece(&mut app, &paths, &round_id, 5, 1);

        app.test_now = Some(baseline + Duration::from_millis(500));
        app.poll_friendly_vs_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(999));
        app.poll_friendly_vs_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(1000));
        app.poll_friendly_vs_dry_run();

        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[friendly-vs-dry-run] plan ready"))
                .count(),
            2
        );
        assert_eq!(
            friendly_vs_live_started_offsets_ms(&app, baseline),
            vec![0, 1000]
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_pps_wait_stale_snapshot_suppresses_old_dispatch() {
        let (paths, mut app, round_id) =
            setup_friendly_vs_live_app("friendly-vs-live-pps-stale-snapshot");
        app.state.pps_unlimited = false;
        app.state.target_pps = 1.0;
        app.state.normalize_pps_state();
        app.update_live_target_pps();

        let baseline = Instant::now();
        app.test_now = Some(baseline);
        poll_friendly_vs_live_test_piece(&mut app, &paths, &round_id, 4, 0);

        app.test_now = Some(baseline + Duration::from_millis(200));
        write_friendly_vs_passive_snapshot(
            &paths,
            &round_id,
            "7001",
            "cand-local",
            5,
            json!("friendly-user"),
            "T",
            &["I", "O", "L", "S", "Z"],
        );
        app.poll_friendly_vs_dry_run();

        app.friendly_vs_live_before_reread = Some(Box::new(move |app| {
            write_friendly_vs_passive_snapshot(
                &app.paths,
                &round_id,
                "7001",
                "cand-local",
                6,
                json!("friendly-user"),
                "L",
                &["I", "O", "T", "S", "Z"],
            );
        }));
        app.test_now = Some(baseline + Duration::from_millis(1000));
        app.poll_friendly_vs_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert!(app
            .logs
            .iter()
            .any(|line| {
                line.contains("[friendly-vs-live] plan invalidated before dispatch")
                    && line.contains("reason=piece_advanced")
            }));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_pps_bot_off_cancels_deferred_pacing() {
        let (paths, mut app, round_id) =
            setup_friendly_vs_live_app("friendly-vs-live-pps-bot-off-reset");
        app.state.pps_unlimited = false;
        app.state.target_pps = 1.0;
        app.state.normalize_pps_state();
        app.update_live_target_pps();

        let baseline = Instant::now();
        app.test_now = Some(baseline);
        poll_friendly_vs_live_test_piece(&mut app, &paths, &round_id, 4, 0);

        app.test_now = Some(baseline + Duration::from_millis(200));
        poll_friendly_vs_live_test_piece(&mut app, &paths, &round_id, 5, 1);

        app.stop_bot_with_browser_hint(false);
        assert!(app.friendly_vs_live.next_execution_earliest_at.is_none());
        assert!(app.friendly_vs_live.deferred_snapshot_token.is_none());
        assert!(app.friendly_vs_live.deferred_plan.is_none());

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_unlimited_stale_then_fresher_piece_progresses_normally() {
        let (paths, mut app, round_id) = setup_friendly_vs_live_app_with_options(
            "friendly-vs-live-unlimited-stale-then-fresh",
            true,
            FriendlyVsLiveLimit::Unlimited,
        );
        let planned = friendly_vs_ready_snapshot_value(
            &round_id,
            "7001",
            "cand-local",
            7,
            4,
            json!("friendly-user"),
            "J",
            None,
            &["O", "T", "L", "S", "Z"],
        );
        write_friendly_vs_passive_snapshot_value(&paths, &planned);
        let mut refreshed = planned.clone();
        refreshed["snapshot"]["current"]["type"] = json!("T");
        refreshed["snapshot"]["queue"] = json!(["I", "O", "L", "S", "Z"]);
        app.friendly_vs_live_before_reread = Some(Box::new(move |app| {
            write_friendly_vs_passive_snapshot_value(&app.paths, &refreshed);
        }));

        app.poll_friendly_vs_dry_run();

        assert_eq!(app.friendly_vs_live.executed_placements, 0);
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            0
        );

        poll_friendly_vs_live_test_piece(&mut app, &paths, &round_id, 5, 1);

        assert_eq!(app.friendly_vs_live.executed_placements, 1);
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert!(app.logs.iter().any(|line| {
            line == "[friendly-vs-live] placement executed count=1/Unlimited"
        }));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_matching_start_pose_confirms_and_dispatches_once() {
        let (paths, mut app, round_id) =
            setup_friendly_vs_live_app("friendly-vs-live-start-pose-confirmed");
        app.state.bot.use_hold = false;

        write_friendly_vs_passive_snapshot(
            &paths,
            &round_id,
            "7001",
            "cand-local",
            4,
            json!("friendly-user"),
            "J",
            &["O", "T", "L", "S", "Z"],
        );
        app.poll_friendly_vs_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert!(app.logs.iter().any(|line| {
            line.contains("[friendly-vs-live] plan source pose confirmed before dispatch")
                && line.contains("piece_counter=4")
                && line.contains("piece=J")
        }));
        assert!(!app.logs.iter().any(|line| {
            line.contains("[friendly-vs-live] plan invalidated before dispatch")
        }));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_active_pose_changes_invalidate_old_plan_without_dispatch() {
        for (name, mutate) in [
            ("friendly-vs-live-active-pose-x", "x"),
            ("friendly-vs-live-active-pose-y", "y"),
            ("friendly-vs-live-active-pose-rotation", "rotation"),
        ] {
            let (paths, mut app, round_id) = setup_friendly_vs_live_app(name);
            app.state.bot.use_hold = false;
            write_friendly_vs_passive_snapshot(
                &paths,
                &round_id,
                "7001",
                "cand-local",
                4,
                json!("friendly-user"),
                "J",
                &["O", "T", "L", "S", "Z"],
            );
            app.friendly_vs_live_before_reread = Some(Box::new(move |app| match mutate {
                "x" => write_friendly_vs_passive_snapshot_with_active_pose(
                    &app.paths,
                    &round_id,
                    "7001",
                    "cand-local",
                    4,
                    json!("friendly-user"),
                    "J",
                    3,
                    19,
                    "north",
                    &["O", "T", "L", "S", "Z"],
                ),
                "y" => write_friendly_vs_passive_snapshot_with_active_pose(
                    &app.paths,
                    &round_id,
                    "7001",
                    "cand-local",
                    4,
                    json!("friendly-user"),
                    "J",
                    4,
                    18,
                    "north",
                    &["O", "T", "L", "S", "Z"],
                ),
                "rotation" => write_friendly_vs_passive_snapshot_with_active_pose(
                    &app.paths,
                    &round_id,
                    "7001",
                    "cand-local",
                    4,
                    json!("friendly-user"),
                    "J",
                    4,
                    19,
                    "west",
                    &["O", "T", "L", "S", "Z"],
                ),
                _ => unreachable!(),
            }));

            app.poll_friendly_vs_dry_run();

            assert_eq!(app.friendly_vs_live.executed_placements, 0);
            assert_eq!(
                app.zenith_live_test_hook
                    .dispatch_count
                    .load(Ordering::Relaxed),
                0
            );
            assert!(app.logs.iter().any(|line| {
                line.contains("[friendly-vs-live] plan invalidated before dispatch")
                    && line.contains("reason=pose_mismatch")
                    && line.contains("piece_counter=4")
            }));
            assert!(app.friendly_vs_dry_run.last_processed_snapshot_token.is_none());

            cleanup_test_paths(&paths);
        }
    }

    #[test]
    fn friendly_vs_live_active_pose_invalidated_piece_replans_same_piece_without_resetting_pps() {
        let (paths, mut app, round_id) = setup_friendly_vs_live_app_with_options(
            "friendly-vs-live-active-pose-replan",
            true,
            FriendlyVsLiveLimit::Unlimited,
        );
        app.state.bot.use_hold = false;
        app.state.pps_unlimited = false;
        app.state.target_pps = 1.0;
        app.state.normalize_pps_state();
        app.update_live_target_pps();

        let baseline = Instant::now();
        app.test_now = Some(baseline);
        poll_friendly_vs_live_test_piece(&mut app, &paths, &round_id, 4, 0);

        app.test_now = Some(baseline + Duration::from_millis(200));
        write_friendly_vs_passive_snapshot(
            &paths,
            &round_id,
            "7001",
            "cand-local",
            5,
            json!("friendly-user"),
            "J",
            &["O", "T", "L", "S", "Z"],
        );
        app.poll_friendly_vs_dry_run();

        let invalidated_round_id = round_id.clone();
        app.friendly_vs_live_before_reread = Some(Box::new(move |app| {
            write_friendly_vs_passive_snapshot_with_active_pose(
                &app.paths,
                &invalidated_round_id,
                "7001",
                "cand-local",
                5,
                json!("friendly-user"),
                "J",
                3,
                19,
                "north",
                &["O", "T", "L", "S", "Z"],
            );
        }));
        app.test_now = Some(baseline + Duration::from_millis(1000));
        app.poll_friendly_vs_dry_run();

        assert_eq!(app.friendly_vs_live.executed_placements, 1);
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert!(app.logs.iter().any(|line| {
            line.contains("[friendly-vs-live] plan invalidated before dispatch")
                && line.contains("reason=pose_mismatch")
                && line.contains("piece_counter=5")
        }));

        let dispatches_after_invalidation = app
            .zenith_live_test_hook
            .dispatch_count
            .load(Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(20));
        write_friendly_vs_passive_snapshot_with_active_pose(
            &paths,
            &round_id,
            "7001",
            "cand-local",
            5,
            json!("friendly-user"),
            "J",
            3,
            19,
            "north",
            &["O", "T", "L", "S", "Z"],
        );
        app.test_now = Some(baseline + Duration::from_millis(1000));
        app.poll_friendly_vs_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            dispatches_after_invalidation + 1
        );
        assert_eq!(app.friendly_vs_live.executed_placements, 2);
        assert!(app.logs.iter().any(|line| {
            line.contains("[friendly-vs-live] plan source pose confirmed before dispatch")
                && line.contains("piece_counter=5")
        }));
        assert_eq!(friendly_vs_live_started_offsets_ms(&app, baseline), vec![0, 1000]);

        app.poll_friendly_vs_dry_run();
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            dispatches_after_invalidation + 1
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[friendly-vs-dry-run] plan ready"))
                .count(),
            3
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_piece_counter_change_suppresses_input() {
        let (paths, mut app, round_id) =
            setup_friendly_vs_live_app("friendly-vs-live-stale-piece-counter");
        let planned = friendly_vs_ready_snapshot_value(
            &round_id,
            "7001",
            "cand-local",
            7,
            4,
            json!("friendly-user"),
            "J",
            None,
            &["O", "T", "L", "S", "Z"],
        );
        write_friendly_vs_passive_snapshot_value(&paths, &planned);
        let mut refreshed = planned.clone();
        refreshed["snapshot"]["piece_counter"] = json!(5);
        app.friendly_vs_live_before_reread = Some(Box::new(move |app| {
            write_friendly_vs_passive_snapshot_value(&app.paths, &refreshed);
        }));

        app.poll_friendly_vs_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            0
        );
        assert!(app.logs.iter().any(|line| {
            line.contains("[friendly-vs-live] plan invalidated before dispatch")
                && line.contains("reason=piece_advanced")
        }));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_board_fingerprint_change_suppresses_input() {
        let (paths, mut app, round_id) = setup_friendly_vs_live_app("friendly-vs-live-stale-board");
        let planned = friendly_vs_ready_snapshot_value(
            &round_id,
            "7001",
            "cand-local",
            7,
            4,
            json!("friendly-user"),
            "J",
            None,
            &["O", "T", "L", "S", "Z"],
        );
        write_friendly_vs_passive_snapshot_value(&paths, &planned);
        let mut refreshed = planned.clone();
        refreshed["snapshot"]["board"][39][0] = json!(true);
        app.friendly_vs_live_before_reread = Some(Box::new(move |app| {
            write_friendly_vs_passive_snapshot_value(&app.paths, &refreshed);
        }));

        app.poll_friendly_vs_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            0
        );
        assert!(app.logs.iter().any(|line| {
            line.contains("[friendly-vs-live] input suppressed reason=stale_snapshot")
        }));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_round_gameid_and_generation_mismatches_suppress_input() {
        for (name, mutate, expected_reason) in [
            ("friendly-vs-live-round-mismatch", "round", "round_mismatch"),
            (
                "friendly-vs-live-gameid-mismatch",
                "gameid",
                "gameid_mismatch",
            ),
            (
                "friendly-vs-live-generation-mismatch",
                "generation",
                "generation_mismatch",
            ),
        ] {
            let (paths, mut app, round_id) = setup_friendly_vs_live_app(name);
            let planned = friendly_vs_ready_snapshot_value(
                &round_id,
                "7001",
                "cand-local",
                7,
                4,
                json!("friendly-user"),
                "J",
                None,
                &["O", "T", "L", "S", "Z"],
            );
            write_friendly_vs_passive_snapshot_value(&paths, &planned);
            let mut refreshed = planned.clone();
            match mutate {
                "round" => refreshed["snapshot"]["round_id"] = json!("7999:1744077999"),
                "gameid" => {
                    refreshed["snapshot"]["gameid"] = json!("7999");
                    refreshed["snapshot"]["candidate_id"] = json!("cand-opponent");
                }
                "generation" => refreshed["snapshot"]["capture_generation"] = json!(8),
                _ => unreachable!(),
            }
            app.friendly_vs_live_before_reread = Some(Box::new(move |app| {
                write_friendly_vs_passive_snapshot_value(&app.paths, &refreshed);
            }));

            app.poll_friendly_vs_dry_run();

            assert_eq!(
                app.zenith_live_test_hook
                    .dispatch_count
                    .load(Ordering::Relaxed),
                0
            );
            assert!(app.logs.iter().any(|line| {
                line.contains(&format!(
                    "[friendly-vs-live] input suppressed reason={expected_reason}"
                ))
            }));

            cleanup_test_paths(&paths);
        }
    }

    #[test]
    fn friendly_vs_live_unlimited_round_gameid_and_generation_mismatches_suppress_input() {
        for (name, mutate, expected_reason) in [
            (
                "friendly-vs-live-unlimited-round-mismatch",
                "round",
                "round_mismatch",
            ),
            (
                "friendly-vs-live-unlimited-gameid-mismatch",
                "gameid",
                "gameid_mismatch",
            ),
            (
                "friendly-vs-live-unlimited-generation-mismatch",
                "generation",
                "generation_mismatch",
            ),
        ] {
            let (paths, mut app, round_id) = setup_friendly_vs_live_app_with_options(
                name,
                true,
                FriendlyVsLiveLimit::Unlimited,
            );
            let planned = friendly_vs_ready_snapshot_value(
                &round_id,
                "7001",
                "cand-local",
                7,
                4,
                json!("friendly-user"),
                "J",
                None,
                &["O", "T", "L", "S", "Z"],
            );
            write_friendly_vs_passive_snapshot_value(&paths, &planned);
            let mut refreshed = planned.clone();
            match mutate {
                "round" => refreshed["snapshot"]["round_id"] = json!("7999:1744077999"),
                "gameid" => {
                    refreshed["snapshot"]["gameid"] = json!("7999");
                    refreshed["snapshot"]["candidate_id"] = json!("cand-opponent");
                }
                "generation" => refreshed["snapshot"]["capture_generation"] = json!(8),
                _ => unreachable!(),
            }
            app.friendly_vs_live_before_reread = Some(Box::new(move |app| {
                write_friendly_vs_passive_snapshot_value(&app.paths, &refreshed);
            }));

            app.poll_friendly_vs_dry_run();

            assert_eq!(
                app.zenith_live_test_hook
                    .dispatch_count
                    .load(Ordering::Relaxed),
                0
            );
            assert!(app.logs.iter().any(|line| {
                line.contains(&format!(
                    "[friendly-vs-live] input suppressed reason={expected_reason}"
                ))
            }));

            cleanup_test_paths(&paths);
        }
    }

    #[test]
    fn friendly_vs_live_bot_off_mode_change_and_round_inactive_suppress_input() {
        for (name, trigger, expected_reason) in [
            ("friendly-vs-live-bot-off", "bot_off", "bot_off"),
            (
                "friendly-vs-live-mode-change",
                "mode_changed",
                "mode_changed",
            ),
            (
                "friendly-vs-live-round-inactive",
                "round_inactive",
                "round_mismatch",
            ),
        ] {
            let (paths, mut app, round_id) = setup_friendly_vs_live_app(name);
            write_friendly_vs_passive_snapshot(
                &paths,
                &round_id,
                "7001",
                "cand-local",
                4,
                json!("friendly-user"),
                "J",
                &["O", "T", "L", "S", "Z"],
            );
            app.friendly_vs_live_before_reread = Some(Box::new(move |app| match trigger {
                "bot_off" => app.stop_bot_with_browser_hint(false),
                "mode_changed" => app.state.selected_mode = RuntimeMode::Solo,
                "round_inactive" => app.friendly_vs.active_round_id = None,
                _ => unreachable!(),
            }));

            app.poll_friendly_vs_dry_run();

            assert_eq!(
                app.zenith_live_test_hook
                    .dispatch_count
                    .load(Ordering::Relaxed),
                0
            );
            assert!(app.logs.iter().any(|line| {
                line.contains(&format!(
                    "[friendly-vs-live] input suppressed reason={expected_reason}"
                ))
            }));

            cleanup_test_paths(&paths);
        }
    }

    #[test]
    fn friendly_vs_live_bot_off_then_on_same_round_does_not_bypass_cap() {
        let (paths, mut app, round_id) =
            setup_friendly_vs_live_app("friendly-vs-live-cap-persists");
        poll_friendly_vs_live_test_sequence(
            &mut app,
            &paths,
            &round_id,
            4,
            FRIENDLY_VS_LIVE_MAX_PLACEMENTS,
        );
        app.stop_bot_with_browser_hint(false);

        app.start_bot();
        app.logs.clear();
        arm_friendly_vs_round(&mut app, &paths, &round_id, 7001);
        poll_friendly_vs_live_test_piece(
            &mut app,
            &paths,
            &round_id,
            4 + FRIENDLY_VS_LIVE_MAX_PLACEMENTS,
            FRIENDLY_VS_LIVE_MAX_PLACEMENTS as usize,
        );

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            FRIENDLY_VS_LIVE_MAX_PLACEMENTS
        );
        assert!(app.logs.iter().any(|line| {
            line.contains("[friendly-vs-live] input suppressed reason=placement_limit")
        }));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_rereads_fresh_snapshot_for_each_placement() {
        let (paths, mut app, round_id) = setup_friendly_vs_live_app("friendly-vs-live-reread-each");
        let reread_count = Arc::new(AtomicU32::new(0));

        for offset in 0..FRIENDLY_VS_LIVE_MAX_PLACEMENTS {
            let reread_count = reread_count.clone();
            app.friendly_vs_live_before_reread = Some(Box::new(move |_| {
                reread_count.fetch_add(1, Ordering::Relaxed);
            }));
            poll_friendly_vs_live_test_piece(
                &mut app,
                &paths,
                &round_id,
                4 + offset,
                offset as usize,
            );
        }

        assert_eq!(
            reread_count.load(Ordering::Relaxed),
            FRIENDLY_VS_LIVE_MAX_PLACEMENTS
        );
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            FRIENDLY_VS_LIVE_MAX_PLACEMENTS
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_hold_plan_uses_existing_executor_sequence() {
        let (paths, mut app, round_id) =
            setup_friendly_vs_live_app("friendly-vs-live-hold-sequence");
        write_friendly_vs_passive_snapshot(
            &paths,
            &round_id,
            "7001",
            "cand-local",
            4,
            json!("friendly-user"),
            "J",
            &["O", "T", "L", "S", "Z"],
        );
        let path = friendly_vs_passive_snapshot_path(&paths);
        let planned_snapshot = read_friendly_vs_passive_snapshot_file_with_age(&path)
            .unwrap()
            .unwrap()
            .0
            .snapshot
            .unwrap();
        clear_tapped_actions(&app);
        let config = app.state.to_automation_config(&app.paths);
        let prepared = PreparedSnapshotExecution {
            summary: DryRunPlanSummary {
                token: "friendly-hold".to_owned(),
                piece: PieceToken::J,
                hold_piece: None,
                use_hold: true,
                target_x: 3,
                target_rotation: RotationToken::North,
                movement_mode_used: MovementModeConfig::ZeroGSafe,
                fallback_from: None,
                fallback_reason: None,
                action_count: 3,
                actions: vec![GameAction::Hold, GameAction::Left, GameAction::HardDrop],
                route_kind: "test".to_owned(),
                planner: "test".to_owned(),
            },
            execution_plan: ExecutionPlan {
                hold: true,
                movement_actions: vec![GameAction::Left],
                hard_drop: true,
            },
            execution_start_pose: execution_start_pose(&planned_snapshot.snapshot),
            planned_provider_generation: app.passive_provider.activation_generation,
        };

        app.try_dispatch_friendly_vs_live_plan(
            &config,
            &path,
            "friendly-hold-signature",
            &planned_snapshot,
            &prepared,
        );

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert_eq!(
            tapped_actions(&app),
            vec![GameAction::Hold, GameAction::Left, GameAction::HardDrop]
        );
        assert!(app.logs.iter().any(|line| {
            line.contains("[friendly-vs-live] plan source pose confirmed before dispatch")
                && line.contains("piece_counter=4")
        }));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_rotation_route_uses_existing_executor_sequence() {
        let (paths, mut app, round_id) =
            setup_friendly_vs_live_app("friendly-vs-live-rotation-sequence");
        write_friendly_vs_passive_snapshot(
            &paths,
            &round_id,
            "7001",
            "cand-local",
            4,
            json!("friendly-user"),
            "T",
            &["I", "O", "L", "S", "Z"],
        );
        let path = friendly_vs_passive_snapshot_path(&paths);
        let planned_snapshot = read_friendly_vs_passive_snapshot_file_with_age(&path)
            .unwrap()
            .unwrap()
            .0
            .snapshot
            .unwrap();
        clear_tapped_actions(&app);
        let config = app.state.to_automation_config(&app.paths);
        let prepared = PreparedSnapshotExecution {
            summary: DryRunPlanSummary {
                token: "friendly-rotation".to_owned(),
                piece: PieceToken::T,
                hold_piece: None,
                use_hold: false,
                target_x: 7,
                target_rotation: RotationToken::East,
                movement_mode_used: MovementModeConfig::ZeroGSafe,
                fallback_from: None,
                fallback_reason: None,
                action_count: 4,
                actions: vec![
                    GameAction::RotateCw,
                    GameAction::Right,
                    GameAction::Right,
                    GameAction::HardDrop,
                ],
                route_kind: "test".to_owned(),
                planner: "test".to_owned(),
            },
            execution_plan: ExecutionPlan {
                hold: false,
                movement_actions: vec![
                    GameAction::RotateCw,
                    GameAction::Right,
                    GameAction::Right,
                ],
                hard_drop: true,
            },
            execution_start_pose: execution_start_pose(&planned_snapshot.snapshot),
            planned_provider_generation: app.passive_provider.activation_generation,
        };

        app.try_dispatch_friendly_vs_live_plan(
            &config,
            &path,
            "friendly-rotation-signature",
            &planned_snapshot,
            &prepared,
        );

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert_eq!(
            tapped_actions(&app),
            vec![
                GameAction::RotateCw,
                GameAction::Right,
                GameAction::Right,
                GameAction::HardDrop,
            ]
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_rotation_route_pose_mismatch_dispatches_zero_actions() {
        let (paths, mut app, round_id) =
            setup_friendly_vs_live_app("friendly-vs-live-rotation-pose-mismatch");
        write_friendly_vs_passive_snapshot(
            &paths,
            &round_id,
            "7001",
            "cand-local",
            4,
            json!("friendly-user"),
            "T",
            &["I", "O", "L", "S", "Z"],
        );
        let path = friendly_vs_passive_snapshot_path(&paths);
        let planned_snapshot = read_friendly_vs_passive_snapshot_file_with_age(&path)
            .unwrap()
            .unwrap()
            .0
            .snapshot
            .unwrap();
        let prepared = PreparedSnapshotExecution {
            summary: DryRunPlanSummary {
                token: "friendly-rotation-stale".to_owned(),
                piece: PieceToken::T,
                hold_piece: None,
                use_hold: false,
                target_x: 7,
                target_rotation: RotationToken::East,
                movement_mode_used: MovementModeConfig::ZeroGSafe,
                fallback_from: None,
                fallback_reason: None,
                action_count: 2,
                actions: vec![GameAction::RotateCw, GameAction::HardDrop],
                route_kind: "test".to_owned(),
                planner: "test".to_owned(),
            },
            execution_plan: ExecutionPlan {
                hold: false,
                movement_actions: vec![GameAction::RotateCw],
                hard_drop: true,
            },
            execution_start_pose: execution_start_pose(&planned_snapshot.snapshot),
            planned_provider_generation: app.passive_provider.activation_generation,
        };
        let stale_round_id = round_id.clone();
        app.friendly_vs_live_before_reread = Some(Box::new(move |app| {
            write_friendly_vs_passive_snapshot_with_active_pose(
                &app.paths,
                &stale_round_id,
                "7001",
                "cand-local",
                4,
                json!("friendly-user"),
                "T",
                4,
                19,
                "east",
                &["I", "O", "L", "S", "Z"],
            );
        }));
        clear_tapped_actions(&app);
        let config = app.state.to_automation_config(&app.paths);

        app.try_dispatch_friendly_vs_live_plan(
            &config,
            &path,
            "friendly-rotation-stale-signature",
            &planned_snapshot,
            &prepared,
        );

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            0
        );
        assert!(tapped_actions(&app).is_empty());
        assert!(app.logs.iter().any(|line| {
            line.contains("[friendly-vs-live] plan invalidated before dispatch")
                && line.contains("reason=pose_mismatch")
                && line.contains("rotation=North")
                && line.contains("rotation=East")
        }));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_soft_drop_spin_route_uses_existing_executor_sequence() {
        let paths = test_paths("friendly-vs-live-soft-drop-spin-sequence");
        let mut app = LauncherApp::new(paths.clone());
        configure_friendly_vs_runtime_ready(&mut app);
        clear_tapped_actions(&app);
        let config = app.state.to_automation_config(&app.paths);
        let prepared = PreparedSnapshotExecution {
            summary: DryRunPlanSummary {
                token: "friendly-softdrop-spin".to_owned(),
                piece: PieceToken::T,
                hold_piece: None,
                use_hold: false,
                target_x: 2,
                target_rotation: RotationToken::East,
                movement_mode_used: MovementModeConfig::ZeroGSafe,
                fallback_from: None,
                fallback_reason: None,
                action_count: 5,
                actions: vec![
                    GameAction::Left,
                    GameAction::RotateCw,
                    GameAction::SoftDrop,
                    GameAction::RotateCw,
                    GameAction::HardDrop,
                ],
                route_kind: "SoftDropSpinRoute".to_owned(),
                planner: "test".to_owned(),
            },
            execution_plan: ExecutionPlan {
                hold: false,
                movement_actions: vec![
                    GameAction::Left,
                    GameAction::RotateCw,
                    GameAction::SoftDrop,
                    GameAction::RotateCw,
                ],
                hard_drop: true,
            },
            execution_start_pose: None,
            planned_provider_generation: app.passive_provider.activation_generation,
        };

        app.dispatch_friendly_vs_live_plan(&config, &prepared).unwrap();
        assert_eq!(
            tapped_actions(&app),
            vec![
                GameAction::Left,
                GameAction::RotateCw,
                GameAction::SoftDrop,
                GameAction::RotateCw,
                GameAction::HardDrop,
            ]
        );
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert!(!app
            .logs
            .iter()
            .any(|line| line.contains("[friendly-vs-spin-step]")));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn friendly_vs_live_dispatch_failure_does_not_retry_same_piece() {
        let (paths, mut app, round_id) =
            setup_friendly_vs_live_app("friendly-vs-live-dispatch-failure");
        app.zenith_live_test_hook
            .fail_after_taps
            .store(1, Ordering::Relaxed);
        clear_tapped_actions(&app);

        write_friendly_vs_passive_snapshot(
            &paths,
            &round_id,
            "7001",
            "cand-local",
            4,
            json!("friendly-user"),
            "J",
            &["O", "T", "L", "S", "Z"],
        );
        app.poll_friendly_vs_dry_run();
        app.poll_friendly_vs_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert!(app
            .logs
            .iter()
            .any(|line| { line.contains("[friendly-vs-live] dispatch error piece_counter=4") }));
        assert_eq!(tapped_actions(&app).len(), 1);

        cleanup_test_paths(&paths);
    }

    #[test]
    fn local_tetrio_username_is_persisted_in_launcher_state() {
        let mut state = LauncherState::default();
        state.browser.local_tetrio_username = "ExactLocal".to_owned();
        let serialized = serde_json::to_value(state).unwrap();
        assert_eq!(serialized.get("quick_play_diagnostic_username"), None);
        assert_eq!(
            serialized
                .pointer("/browser/local_tetrio_username")
                .and_then(|value| value.as_str()),
            Some("ExactLocal")
        );
    }

    #[test]
    fn local_tetrio_username_hint_is_fail_closed_when_blank() {
        let paths = test_paths("launcher-state-empty-local-username");
        let mut app = LauncherApp::new(paths.clone());
        app.state.browser.local_tetrio_username = "   ".to_owned();
        assert_eq!(app.local_tetrio_username_hint(), None);
        cleanup_test_paths(&paths);
    }

    #[test]
    fn load_launcher_state_migrates_legacy_quick_play_username() {
        let paths = test_paths("launcher-state-legacy-local-username");
        fs::write(
            &paths.launcher_state_path,
            serde_json::to_vec(&json!({
                "quick_play_diagnostic_username": "ExactLocal"
            }))
            .unwrap(),
        )
        .unwrap();

        let state = load_launcher_state(&paths).unwrap();

        assert_eq!(state.browser.local_tetrio_username, "ExactLocal");

        cleanup_test_paths(&paths);
    }

    #[test]
    fn browser_connection_settings_lock_only_depends_on_browser_session() {
        let paths = test_paths("browser-connection-lock");
        let mut app = LauncherApp::new(paths.clone());
        assert!(!app.browser_connection_settings_locked());

        app.browser_status = BrowserStatus::Ready;
        assert!(!app.browser_connection_settings_locked());

        configure_zenith_runtime_ready(&mut app);
        assert!(!app.browser_connection_settings_locked());

        cleanup_test_paths(&paths);
    }

    #[test]
    fn local_tetrio_username_editability_tracks_bot_state_independently() {
        let paths = test_paths("local-username-lock");
        let mut app = LauncherApp::new(paths.clone());

        app.browser_status = BrowserStatus::Closed;
        app.bot_status = BotStatus::Off;
        app.bot_desired_enabled = false;
        assert!(!app.local_tetrio_username_locked());

        app.browser_status = BrowserStatus::Ready;
        assert!(!app.local_tetrio_username_locked());
        assert!(!app.browser_connection_settings_locked());

        app.bot_desired_enabled = true;
        app.bot_status = BotStatus::On;
        assert!(app.local_tetrio_username_locked());
        assert!(!app.browser_connection_settings_locked());

        app.stop_bot_with_browser_hint(false);
        assert_eq!(app.bot_status, BotStatus::Off);
        assert!(!app.local_tetrio_username_locked());

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_max_pieces_defaults_to_one() {
        assert_eq!(
            LauncherState::default().effective_zenith_live_max_pieces(),
            ZenithLivePieceLimit::Bounded(1)
        );
    }

    #[test]
    fn zenith_live_max_pieces_accepts_supported_values() {
        for value in ZENITH_LIVE_MAX_PIECE_OPTIONS {
            let state: LauncherState =
                serde_json::from_value(json!({ "zenith_live_max_pieces": value })).unwrap();
            assert_eq!(
                state.effective_zenith_live_max_pieces(),
                ZenithLivePieceLimit::Bounded(*value)
            );
        }
    }

    #[test]
    fn zenith_live_max_pieces_accepts_unlimited_value() {
        let state: LauncherState =
            serde_json::from_value(json!({ "zenith_live_max_pieces": "unlimited" })).unwrap();
        assert_eq!(
            state.effective_zenith_live_max_pieces(),
            ZenithLivePieceLimit::Unlimited
        );
    }

    #[test]
    fn zenith_live_max_pieces_serializes_unlimited_explicitly() {
        let mut state = LauncherState::default();
        state.zenith_live_max_pieces = ZenithLivePieceLimit::Unlimited;
        state.zenith_live_input_enabled = true;
        let serialized = serde_json::to_value(state).unwrap();
        assert_eq!(
            serialized.get("zenith_live_max_pieces"),
            Some(&serde_json::Value::String("unlimited".to_owned()))
        );
    }

    #[test]
    fn zenith_live_max_pieces_serializes_bounded_values_as_numbers() {
        let mut state = LauncherState::default();
        state.zenith_live_max_pieces = ZenithLivePieceLimit::Bounded(20);
        let serialized = serde_json::to_value(state).unwrap();
        assert_eq!(
            serialized.get("zenith_live_max_pieces"),
            Some(&serde_json::Value::Number(20u32.into()))
        );
    }

    #[test]
    fn zenith_live_max_pieces_invalid_values_fall_back_to_one() {
        for raw in [
            json!({ "zenith_live_max_pieces": 0 }),
            json!({ "zenith_live_max_pieces": -1 }),
            json!({ "zenith_live_max_pieces": 3 }),
            json!({ "zenith_live_max_pieces": 100 }),
            json!({ "zenith_live_max_pieces": "5" }),
            json!({ "zenith_live_max_pieces": null }),
        ] {
            let state: LauncherState = serde_json::from_value(raw).unwrap();
            assert_eq!(
                state.effective_zenith_live_max_pieces(),
                ZenithLivePieceLimit::Bounded(1)
            );
        }
    }

    #[test]
    fn normal_style_preserves_base_profiles() {
        let paths = AppPaths::discover();
        let mut state = LauncherState::default();
        state.play_style = PlayStyleConfig::Normal;
        let config = state.to_automation_config(&paths);
        assert_eq!(config.play_style, PlayStyleConfig::Normal);
        assert_eq!(config.evaluation_profile, EvaluationProfileConfig::Normal);
        assert_eq!(config.route_profile, RouteProfileConfig::Normal);
        assert_eq!(config.bot.movement_mode, state.bot.movement_mode);
        assert_eq!(config.bot.min_nodes, state.bot.min_nodes);
    }

    #[test]
    fn speed_style_only_applies_transient_profiles() {
        let paths = AppPaths::discover();
        let mut state = LauncherState::default();
        state.bot.movement_mode = MovementModeConfig::TwentyG;
        state.bot.min_nodes = 1234;
        state.play_style = PlayStyleConfig::Speed;

        let config = state.to_automation_config(&paths);

        assert_eq!(config.play_style, PlayStyleConfig::Speed);
        assert_eq!(config.evaluation_profile, EvaluationProfileConfig::Speed);
        assert_eq!(config.route_profile, RouteProfileConfig::Speed);
        assert_eq!(config.bot.movement_mode, MovementModeConfig::TwentyG);
        assert_eq!(config.bot.min_nodes, 1234);
        assert_eq!(state.bot.movement_mode, MovementModeConfig::TwentyG);
        assert_eq!(state.bot.min_nodes, 1234);
    }

    #[test]
    fn pps_unlimited_migration_is_inferred_from_zero_target_pps() {
        let raw = json!({
            "preset": "Solo1080p",
            "target_pps": 0.0
        });
        let mut state: LauncherState = serde_json::from_value(raw).unwrap();
        state.pps_unlimited = state.target_pps <= 0.0;
        state.normalize_pps_state();
        assert!(state.pps_unlimited);
        assert_eq!(state.target_pps, 3.0);
        assert_eq!(state.effective_target_pps(), 0.0);
    }

    #[test]
    fn bot_ui_hides_legacy_controls() {
        assert!(BOT_UI_VISIBLE_LABELS.contains(&"Play Style"));
        assert!(BOT_UI_VISIBLE_LABELS.contains(&"PPS"));
        assert!(BOT_UI_VISIBLE_LABELS.contains(&"Bot ON"));
        assert!(BOT_UI_VISIBLE_LABELS.contains(&"Bot OFF"));
        assert!(!BOT_UI_VISIBLE_LABELS.contains(&"Mode"));
        assert!(!BOT_UI_VISIBLE_LABELS.contains(&"Dry run"));
        assert!(BOT_UI_HIDDEN_LABELS.contains(&"Dry run"));
        assert!(BOT_UI_HIDDEN_LABELS.contains(&"Movement"));
        assert!(BOT_UI_HIDDEN_LABELS.contains(&"Threads"));
    }

    #[test]
    fn missing_scanner_path_is_backfilled_without_resetting_hidden_settings() {
        let mut state = LauncherState {
            preset: ModePreset::Solo1080p,
            scanner_config_path: String::new(),
            movement_tap_duration_ms: 37,
            rotate_tap_duration_ms: 29,
            hold_tap_duration_ms: 17,
            hard_drop_tap_duration_ms: 11,
            soft_drop_tap_duration_ms: 19,
            bot: BotConfig {
                min_nodes: 1234,
                ..BotConfig::default()
            },
            handling: HandlingConfig {
                action_settle_ms: 9,
                ..HandlingConfig::default()
            },
            ..LauncherState::default()
        };

        state.ensure_scanner_config_path();

        assert_eq!(
            state.scanner_config_path,
            "automation/scan-config.solo-1080p.json"
        );
        assert_eq!(state.movement_tap_duration_ms, 37);
        assert_eq!(state.rotate_tap_duration_ms, 29);
        assert_eq!(state.hold_tap_duration_ms, 17);
        assert_eq!(state.hard_drop_tap_duration_ms, 11);
        assert_eq!(state.soft_drop_tap_duration_ms, 19);
        assert_eq!(state.bot.min_nodes, 1234);
        assert_eq!(state.handling.action_settle_ms, 9);
    }

    #[test]
    fn extract_planned_token_reads_runner_move_log() {
        assert_eq!(
            extract_planned_token(
                "[automation] source=browser_cdp token=browser-10 piece=T hold=- mode=ZeroG Safe"
            )
            .as_deref(),
            Some("browser-10")
        );
        assert_eq!(extract_planned_token("[automation] waiting"), None);
    }

    #[test]
    fn extract_snapshot_epoch_reads_browser_tokens() {
        assert_eq!(extract_snapshot_epoch("browser-2-0"), Some(2));
        assert_eq!(extract_snapshot_epoch("browser-17-42"), Some(17));
        assert_eq!(extract_snapshot_epoch("scanner-2-0"), None);
    }

    #[test]
    fn passive_provider_controller_coalesces_owners_and_restart_cycles() {
        let mut controller = PassiveProviderController::default();

        assert!(!controller.has_any());
        assert_eq!(controller.release(PassiveProviderOwner::ZenithDryRun), None);

        let activated = controller
            .request(PassiveProviderOwner::ZenithDryRun)
            .expect("zenith owner should activate provider");
        assert_eq!(activated.lifecycle, PassiveProviderLifecycle::Activated);
        assert_eq!(activated.activation_generation, 1);
        assert_eq!(controller.owners_label(), "zenith_dry_run");
        assert_eq!(controller.request(PassiveProviderOwner::ZenithDryRun), None);

        let manual_added = controller
            .request(PassiveProviderOwner::ManualDiagnostic)
            .expect("manual owner should join active provider");
        assert_eq!(manual_added.lifecycle, PassiveProviderLifecycle::OwnerAdded);
        assert_eq!(manual_added.activation_generation, 1);
        assert_eq!(
            controller.owners_label(),
            "manual_diagnostic+zenith_dry_run"
        );

        let manual_released = controller
            .release(PassiveProviderOwner::ManualDiagnostic)
            .expect("manual owner should release while zenith remains");
        assert_eq!(
            manual_released.lifecycle,
            PassiveProviderLifecycle::OwnerReleased
        );
        assert_eq!(controller.owners_label(), "zenith_dry_run");

        let manual_readded = controller
            .request(PassiveProviderOwner::ManualDiagnostic)
            .expect("manual owner should rejoin");
        assert_eq!(
            manual_readded.lifecycle,
            PassiveProviderLifecycle::OwnerAdded
        );
        assert_eq!(
            controller.owners_label(),
            "manual_diagnostic+zenith_dry_run"
        );

        let zenith_released = controller
            .release(PassiveProviderOwner::ZenithDryRun)
            .expect("zenith owner should release while manual remains");
        assert_eq!(
            zenith_released.lifecycle,
            PassiveProviderLifecycle::OwnerReleased
        );
        assert_eq!(controller.owners_label(), "manual_diagnostic");
        assert_eq!(controller.release(PassiveProviderOwner::ZenithDryRun), None);

        let deactivated = controller
            .release(PassiveProviderOwner::ManualDiagnostic)
            .expect("final owner should stop provider");
        assert_eq!(deactivated.lifecycle, PassiveProviderLifecycle::Deactivated);
        assert!(!controller.has_any());

        let reactivated = controller
            .request(PassiveProviderOwner::ManualDiagnostic)
            .expect("new activation should advance generation");
        assert_eq!(reactivated.lifecycle, PassiveProviderLifecycle::Activated);
        assert_eq!(reactivated.activation_generation, 2);
        assert_eq!(controller.owners_label(), "manual_diagnostic");
    }

    #[test]
    fn mode_change_increments_generation_and_stops_active_bot_state() {
        let paths = test_paths("mode-change");
        let mut app = LauncherApp::new(paths.clone());
        app.state.mode_generation = 4;
        app.bot_desired_enabled = true;
        app.bot_status = BotStatus::On;
        app.zenith_live.executed_pieces = 3;
        app.zenith_live.session_max_pieces = ZenithLivePieceLimit::Bounded(5);

        app.select_mode(RuntimeMode::Zenith);

        assert_eq!(app.state.selected_mode, RuntimeMode::Zenith);
        assert_eq!(app.state.mode_generation, 5);
        assert!(!app.bot_desired_enabled);
        assert_eq!(app.bot_status, BotStatus::Off);
        assert_eq!(app.zenith_live.executed_pieces, 0);
        assert_eq!(
            app.zenith_live.session_max_pieces(),
            ZenithLivePieceLimit::Bounded(1)
        );
        assert!(app
            .logs
            .iter()
            .any(|line| line == "[mode] selected mode=zenith"));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn runner_wait_and_resume_logs_keep_bot_enabled_state() {
        let paths = AppPaths::discover();
        let mut app = LauncherApp::new(paths);
        app.bot_desired_enabled = true;
        app.bot_status = BotStatus::On;

        app.event_tx
            .send(LauncherEvent::BotLog(
                "[automation] idle waiting for next live game after token=browser-1-116".to_owned(),
            ))
            .unwrap();
        app.poll_events();

        assert!(app.bot_desired_enabled);
        assert!(app.bot_waiting_for_next_game);
        assert!(app
            .logs
            .iter()
            .any(|line| line == "[bot] waiting for next game while remaining enabled"));

        app.event_tx
            .send(LauncherEvent::BotLog(
                "[automation] live game resumed token=browser-2-0 queue=I,O,T".to_owned(),
            ))
            .unwrap();
        app.poll_events();

        assert!(!app.bot_waiting_for_next_game);
        assert!(app
            .logs
            .iter()
            .any(|line| line == "[bot] runner resumed for game epoch=2"));
    }

    #[test]
    fn zenith_live_disabled_keeps_dry_run_only() {
        let paths = test_paths("zenith-live-disabled");
        let mut app = LauncherApp::new(paths.clone());
        configure_zenith_runtime_ready(&mut app);
        app.logs.clear();
        write_zenith_passive_snapshot(&paths, "ready", "running", 6, json!(false));

        app.poll_zenith_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            0
        );
        assert!(app
            .logs
            .iter()
            .any(|line| line.contains("[zenith-dry-run] plan ready")));
        assert!(app
            .logs
            .iter()
            .any(|line| line == "[zenith-dry-run] input suppressed reason=dry_run"));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_valid_snapshot_dispatches_once_and_waits_for_lock() {
        let paths = test_paths("zenith-live-dispatch-once");
        let mut app = LauncherApp::new(paths.clone());
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();
        write_zenith_passive_snapshot(&paths, "ready", "running", 6, json!(false));

        app.poll_zenith_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert!(!tapped_actions(&app).is_empty());
        assert_eq!(app.zenith_live.stage, ZenithLiveStage::AwaitingLock);
        assert!(app
            .logs
            .iter()
            .any(|line| line.contains("[zenith-live] plan accepted piece_counter=6 generation=5")));
        assert!(app.logs.iter().any(|line| line
            .contains("[zenith-live] execution started piece_counter=6 executed=0 max_pieces=1")));
        assert!(app
            .logs
            .iter()
            .any(|line| line.contains("[zenith-live] input dispatched piece_counter=6")));
        assert!(app.logs.iter().any(|line| {
            line.contains("[zenith-live] plan source pose confirmed before dispatch")
                && line.contains("piece=J")
                && line.contains("piece_counter=6")
        }));
        assert!(app
            .logs
            .iter()
            .any(|line| line.contains("[zenith-live] awaiting lock piece_counter=6")));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_provider_generation_change_discards_prepared_plan_without_dispatch() {
        let paths = test_paths("zenith-live-provider-generation-change");
        let mut app = LauncherApp::new(paths.clone());
        app.state.pps_unlimited = false;
        app.state.target_pps = 3.0;
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Unlimited;
        app.state.normalize_pps_state();
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();
        let baseline = Instant::now();
        app.test_now = Some(baseline);
        write_zenith_passive_snapshot(&paths, "ready", "running", 6, json!(false));
        app.poll_zenith_dry_run();
        app.test_now = Some(baseline + Duration::from_millis(200));
        write_zenith_passive_snapshot(&paths, "ready", "running", 7, json!(false));
        app.poll_zenith_dry_run();
        assert!(app.zenith_live.deferred_plan.is_some());

        let planned_provider_generation = app.passive_provider.activation_generation;
        app.zenith_live_before_reread = Some(Box::new(move |app| {
            app.passive_provider.activation_generation = planned_provider_generation + 1;
        }));
        app.test_now = Some(baseline + Duration::from_millis(334));
        app.poll_zenith_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert!(!tapped_actions(&app).is_empty());
        assert!(app.zenith_live.deferred_snapshot_token.is_none());
        assert!(app.zenith_live.deferred_plan.is_none());
        assert!(app.zenith_dry_run.last_processed_snapshot_token.is_none());
        assert!(app.logs.iter().any(|line| {
            line.contains("[zenith-live] input suppressed reason=provider_generation_changed")
                && line.contains("piece_counter=7")
        }));
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[zenith-dry-run] plan ready"))
                .count(),
            2
        );

        app.zenith_live_before_reread = None;
        app.test_now = Some(baseline + Duration::from_millis(334));
        app.poll_zenith_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            2
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[zenith-dry-run] plan ready"))
                .count(),
            3
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_three_pps_anchor_dispatches_saved_plan_after_wait() {
        let paths = test_paths("zenith-live-three-pps-anchor");
        let mut app = LauncherApp::new(paths.clone());
        app.state.pps_unlimited = false;
        app.state.target_pps = 3.0;
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Unlimited;
        app.state.normalize_pps_state();
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();

        let baseline = Instant::now();
        app.test_now = Some(baseline);
        write_zenith_passive_snapshot(&paths, "ready", "running", 6, json!(false));
        app.poll_zenith_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(200));
        write_zenith_passive_snapshot(&paths, "ready", "running", 7, json!(false));
        app.poll_zenith_dry_run();

        assert!(app.zenith_live.deferred_plan.is_some());
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[zenith-dry-run] plan ready"))
                .count(),
            2
        );

        app.test_now = Some(baseline + Duration::from_millis(334));
        app.poll_zenith_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .started_at
                .lock()
                .unwrap()
                .iter()
                .map(|started_at| started_at.duration_since(baseline).as_millis())
                .collect::<Vec<_>>(),
            vec![0, 334]
        );
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            2
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[zenith-dry-run] plan ready"))
                .count(),
            2
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("input deferred reason=pps_pacing"))
                .count(),
            1
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_pose_changes_invalidate_old_plan_without_dispatch() {
        let (spawn_x, spawn_y) = zenith_spawn_coordinates(Piece::J);
        for (name, x, y, rotation) in [
            ("zenith-live-pose-x", spawn_x - 1, spawn_y, "north"),
            ("zenith-live-pose-y", spawn_x, spawn_y - 1, "north"),
            ("zenith-live-pose-rotation", spawn_x, spawn_y, "east"),
        ] {
            let paths = test_paths(name);
            let mut app = LauncherApp::new(paths.clone());
            app.state.pps_unlimited = false;
            app.state.target_pps = 3.0;
            app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Unlimited;
            app.state.normalize_pps_state();
            configure_zenith_runtime_ready(&mut app);
            app.state.zenith_live_input_enabled = true;
            app.logs.clear();
            let baseline = Instant::now();
            app.test_now = Some(baseline);
            write_zenith_passive_snapshot(&paths, "ready", "running", 6, json!(false));
            app.poll_zenith_dry_run();
            assert_eq!(
                app.zenith_live_test_hook
                    .dispatch_count
                    .load(Ordering::Relaxed),
                1
            );

            app.test_now = Some(baseline + Duration::from_millis(200));
            write_zenith_passive_snapshot(&paths, "ready", "running", 7, json!(false));
            app.poll_zenith_dry_run();

            assert_eq!(
                app.zenith_live_test_hook
                    .dispatch_count
                    .load(Ordering::Relaxed),
                1
            );
            assert!(app.zenith_live.deferred_plan.is_some());

            app.test_now = Some(baseline + Duration::from_millis(334));
            write_zenith_passive_snapshot_with_active_pose(&app.paths, 7, x, y, rotation);
            app.poll_zenith_dry_run();

            assert_eq!(
                app.zenith_live_test_hook
                    .dispatch_count
                    .load(Ordering::Relaxed),
                1
            );
            assert!(app.zenith_live.deferred_plan.is_none());
            assert!(app.zenith_dry_run.last_processed_snapshot_token.is_none());

            assert!(app.logs.iter().any(|line| {
                line.contains("[zenith-live] plan invalidated before dispatch")
                    && line.contains("reason=pose_mismatch")
                    && line.contains("piece_counter=7")
            }));

            cleanup_test_paths(&paths);
        }
    }

    #[test]
    fn zenith_live_fractional_y_within_same_logical_row_keeps_plan_valid() {
        let paths = test_paths("zenith-live-pose-fractional-y");
        let mut app = LauncherApp::new(paths.clone());
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();
        let (spawn_x, _spawn_y) = zenith_spawn_coordinates(Piece::J);
        write_zenith_passive_snapshot_with_pieces(
            &paths,
            "ready",
            "running",
            6,
            json!(false),
            "J",
            json!(spawn_x),
            json!(18.0),
            json!(null),
            &["O", "T", "L", "S", "Z"],
        );
        app.zenith_live_before_reread = Some(Box::new(move |app| {
            write_zenith_passive_snapshot_with_pieces(
                &app.paths,
                "ready",
                "running",
                6,
                json!(false),
                "J",
                json!(spawn_x),
                json!(18.4125),
                json!(null),
                &["O", "T", "L", "S", "Z"],
            );
        }));

        app.poll_zenith_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert!(app.logs.iter().any(|line| {
            line.contains("[zenith-live] plan source pose confirmed before dispatch")
                && line.contains("y=18")
        }));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_pose_mismatch_replans_same_piece_from_fresh_snapshot() {
        let paths = test_paths("zenith-live-pose-replan");
        let mut app = LauncherApp::new(paths.clone());
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();
        let (spawn_x, spawn_y) = zenith_spawn_coordinates(Piece::J);
        write_zenith_passive_snapshot(&paths, "ready", "running", 6, json!(false));
        app.zenith_live_before_reread = Some(Box::new(move |app| {
            write_zenith_passive_snapshot_with_active_pose(
                &app.paths,
                6,
                spawn_x - 1,
                spawn_y,
                "north",
            );
        }));

        app.poll_zenith_dry_run();
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            0
        );

        std::thread::sleep(Duration::from_millis(20));
        write_zenith_passive_snapshot_with_active_pose(
            &paths,
            6,
            spawn_x - 1,
            spawn_y,
            "north",
        );
        app.poll_zenith_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert_eq!(app.zenith_live.stage, ZenithLiveStage::AwaitingLock);
        assert!(app.logs.iter().any(|line| {
            line.contains("[zenith-live] plan source pose confirmed before dispatch")
                && line.contains("piece_counter=6")
        }));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_piece_advance_invalidates_old_plan_without_dispatch() {
        let paths = test_paths("zenith-live-pose-piece-advanced");
        let mut app = LauncherApp::new(paths.clone());
        app.state.pps_unlimited = false;
        app.state.target_pps = 3.0;
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Unlimited;
        app.state.normalize_pps_state();
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();
        let baseline = Instant::now();
        app.test_now = Some(baseline);
        write_zenith_passive_snapshot(&paths, "ready", "running", 6, json!(false));
        app.poll_zenith_dry_run();
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );

        app.test_now = Some(baseline + Duration::from_millis(200));
        write_zenith_passive_snapshot(&paths, "ready", "running", 7, json!(false));
        app.poll_zenith_dry_run();
        assert!(app.zenith_live.deferred_plan.is_some());

        app.test_now = Some(baseline + Duration::from_millis(250));
        write_zenith_passive_snapshot(&paths, "ready", "running", 8, json!(false));
        app.poll_zenith_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert!(app.zenith_live.deferred_plan.is_none());
        assert!(app.zenith_dry_run.last_processed_snapshot_token.is_none());

        app.test_now = Some(baseline + Duration::from_millis(250));
        write_zenith_passive_snapshot(&paths, "ready", "running", 8, json!(false));
        app.poll_zenith_dry_run();

        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[zenith-dry-run] plan ready"))
                .count(),
            3
        );
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_deferred_plan_identity_change_clears_and_replans_next_poll() {
        let paths = test_paths("zenith-live-deferred-identity-change");
        let mut app = LauncherApp::new(paths.clone());
        app.state.pps_unlimited = false;
        app.state.target_pps = 3.0;
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Unlimited;
        app.state.normalize_pps_state();
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();
        let (spawn_x, spawn_y) = zenith_spawn_coordinates(Piece::J);

        let baseline = Instant::now();
        app.test_now = Some(baseline);
        write_zenith_passive_snapshot(&paths, "ready", "running", 6, json!(false));
        app.poll_zenith_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(200));
        write_zenith_passive_snapshot(&paths, "ready", "running", 7, json!(false));
        app.poll_zenith_dry_run();
        assert!(app.zenith_live.deferred_plan.is_some());

        app.test_now = Some(baseline + Duration::from_millis(250));
        write_zenith_passive_snapshot_with_metadata_and_flags(
            &paths,
            "ready",
            "running",
            6,
            "user-other",
            "game-other",
            "candidate-other",
            7,
            true,
            json!(false),
            false,
            false,
            None,
            "J",
            json!(spawn_x),
            json!(spawn_y),
            json!(null),
            &["O", "T", "L", "S", "Z"],
        );
        app.poll_zenith_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert!(app.zenith_live.deferred_plan.is_none());
        assert!(app.zenith_dry_run.last_processed_snapshot_token.is_none());

        app.test_now = Some(baseline + Duration::from_millis(250));
        write_zenith_passive_snapshot_with_metadata_and_flags(
            &paths,
            "ready",
            "running",
            6,
            "user-other",
            "game-other",
            "candidate-other",
            7,
            true,
            json!(false),
            false,
            false,
            None,
            "J",
            json!(spawn_x),
            json!(spawn_y),
            json!(null),
            &["O", "T", "L", "S", "Z"],
        );
        app.poll_zenith_dry_run();

        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[zenith-dry-run] plan ready"))
                .count(),
            3
        );
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            2
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_same_piece_counter_and_current_y_change_do_not_replay() {
        let paths = test_paths("zenith-live-no-replay-same-piece");
        let mut app = LauncherApp::new(paths.clone());
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();
        let (x, _y) = zenith_spawn_coordinates(Piece::J);
        write_zenith_passive_snapshot_with_pieces(
            &paths,
            "ready",
            "running",
            12,
            json!(false),
            "J",
            json!(x),
            json!(18.0),
            json!(null),
            &["O", "T", "L", "S", "Z"],
        );

        app.poll_zenith_dry_run();

        std::thread::sleep(Duration::from_millis(20));
        write_zenith_passive_snapshot_with_pieces(
            &paths,
            "ready",
            "running",
            12,
            json!(false),
            "J",
            json!(x),
            json!(18.4125),
            json!(null),
            &["O", "T", "L", "S", "Z"],
        );
        app.poll_zenith_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_lock_completion_suspends_after_max_piece() {
        let paths = test_paths("zenith-live-max-piece");
        let mut app = LauncherApp::new(paths.clone());
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();
        write_zenith_passive_snapshot(&paths, "ready", "running", 20, json!(false));

        app.poll_zenith_dry_run();

        std::thread::sleep(Duration::from_millis(20));
        write_zenith_passive_snapshot(&paths, "ready", "running", 21, json!(false));
        app.poll_zenith_dry_run();

        assert_eq!(app.zenith_live.executed_pieces, 1);
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert!(app.logs.iter().any(|line| {
            line.contains(
                "[zenith-live] piece completed piece_counter_before=20 piece_counter_after=21 executed=1 max=1"
            )
        }));
        assert!(app.logs.iter().any(|line| {
            line == "[zenith-live] execution suspended reason=max_pieces_reached executed=1 max=1"
        }));

        std::thread::sleep(Duration::from_millis(20));
        write_zenith_passive_snapshot(&paths, "ready", "running", 22, json!(false));
        app.poll_zenith_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("input suppressed reason=max_pieces_reached"))
                .count(),
            0
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_completed_execution_identity_tracks_executed_piece_not_ack_piece() {
        let paths = test_paths("zenith-live-completed-identity");
        let mut controller = ZenithLiveController::default();

        write_zenith_passive_snapshot_with_metadata(
            &paths,
            "ready",
            "running",
            5,
            "user-zenith",
            "game-a",
            "candidate-1",
            0,
            json!(false),
            "J",
            json!(4),
            json!(19),
            json!(null),
            &["O", "T", "L", "S", "Z"],
        );
        let executed_snapshot = read_test_zenith_passive_snapshot(&paths);
        controller.start_planned(&executed_snapshot, 9, ZenithLiveStage::AwaitingLock);
        controller.mark_completed();

        let completed = controller
            .last_completed_execution
            .as_ref()
            .expect("completed execution identity");
        assert_eq!(completed.piece_counter, Some(0));
        assert_eq!(completed.game_id, "game-a");
        assert_eq!(completed.capture_generation, 5);
        assert_eq!(completed.snapshot_token, "zenith-game-a-5-0-candidate-1");

        write_zenith_passive_snapshot_with_metadata(
            &paths,
            "ready",
            "running",
            5,
            "user-zenith",
            "game-a",
            "candidate-1",
            1,
            json!(false),
            "J",
            json!(4),
            json!(19),
            json!(null),
            &["O", "T", "L", "S", "Z"],
        );
        let next_piece_snapshot = read_test_zenith_passive_snapshot(&paths);
        assert!(!controller.completed_execution_matches_snapshot(&next_piece_snapshot));

        write_zenith_passive_snapshot_with_metadata(
            &paths,
            "ready",
            "running",
            6,
            "user-zenith",
            "game-a",
            "candidate-1",
            0,
            json!(false),
            "J",
            json!(4),
            json!(19),
            json!(null),
            &["O", "T", "L", "S", "Z"],
        );
        let next_generation_snapshot = read_test_zenith_passive_snapshot(&paths);
        assert!(!controller.completed_execution_matches_snapshot(&next_generation_snapshot));

        write_zenith_passive_snapshot_with_metadata(
            &paths,
            "ready",
            "running",
            5,
            "user-zenith",
            "game-b",
            "candidate-1",
            0,
            json!(false),
            "J",
            json!(4),
            json!(19),
            json!(null),
            &["O", "T", "L", "S", "Z"],
        );
        let next_game_snapshot = read_test_zenith_passive_snapshot(&paths);
        assert!(!controller.completed_execution_matches_snapshot(&next_game_snapshot));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_completion_allows_next_piece_after_lock_acknowledgement() {
        let paths = test_paths("zenith-live-next-piece-after-complete");
        let mut app = LauncherApp::new(paths.clone());
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Bounded(5);
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();

        write_zenith_passive_snapshot(&paths, "ready", "running", 0, json!(false));
        app.poll_zenith_dry_run();

        std::thread::sleep(Duration::from_millis(20));
        write_zenith_passive_snapshot(&paths, "ready", "running", 1, json!(false));
        app.poll_zenith_dry_run();

        assert_eq!(app.zenith_live.executed_pieces, 1);
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            2
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[zenith-live] execution started"))
                .count(),
            2
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("input suppressed reason=completed_piece"))
                .count(),
            0
        );
        assert!(app.logs.iter().any(|line| {
            line.contains(
                "[zenith-live] piece completed piece_counter_before=0 piece_counter_after=1 executed=1 max=5",
            )
        }));
        assert!(app.logs.iter().any(|line| {
            line.contains("[zenith-live] execution started piece_counter=1 executed=1 max_pieces=5")
        }));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_session_max_is_fixed_while_bot_is_on() {
        let paths = test_paths("zenith-live-session-max-fixed");
        let mut app = LauncherApp::new(paths.clone());
        app.state.selected_mode = RuntimeMode::Zenith;
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Bounded(1);
        configure_zenith_runtime_ready(&mut app);

        assert_eq!(
            app.zenith_live_piece_limit(),
            ZenithLivePieceLimit::Bounded(1)
        );

        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Bounded(20);

        assert_eq!(
            app.zenith_live_piece_limit(),
            ZenithLivePieceLimit::Bounded(1)
        );

        app.stop_bot_with_browser_hint(false);

        assert_eq!(
            app.zenith_live_piece_limit(),
            ZenithLivePieceLimit::Bounded(20)
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_unlimited_session_limit_is_fixed_while_bot_is_on() {
        let paths = test_paths("zenith-live-session-unlimited-fixed");
        let mut app = LauncherApp::new(paths.clone());
        app.state.selected_mode = RuntimeMode::Zenith;
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Unlimited;
        configure_zenith_runtime_ready(&mut app);

        assert_eq!(
            app.zenith_live_piece_limit(),
            ZenithLivePieceLimit::Unlimited
        );

        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Bounded(1);

        assert_eq!(
            app.zenith_live_piece_limit(),
            ZenithLivePieceLimit::Unlimited
        );

        app.stop_bot_with_browser_hint(false);

        assert_eq!(
            app.zenith_live_piece_limit(),
            ZenithLivePieceLimit::Bounded(1)
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_session_pps_is_fixed_while_bot_is_on() {
        let paths = test_paths("zenith-live-session-pps-fixed");
        let mut app = LauncherApp::new(paths.clone());
        app.state.selected_mode = RuntimeMode::Zenith;
        app.state.pps_unlimited = false;
        app.state.target_pps = 1.0;
        app.state.normalize_pps_state();
        configure_zenith_runtime_ready(&mut app);

        assert!(!app.zenith_live_pps_unlimited());
        assert_eq!(app.zenith_live_target_pps(), 1.0);
        assert_eq!(
            app.zenith_live_pps_interval(),
            Some(Duration::from_millis(1000))
        );

        app.state.pps_unlimited = true;
        app.state.target_pps = 2.0;
        app.state.normalize_pps_state();

        assert!(!app.zenith_live_pps_unlimited());
        assert_eq!(app.zenith_live_target_pps(), 1.0);
        assert_eq!(
            app.zenith_live_pps_interval(),
            Some(Duration::from_millis(1000))
        );

        app.stop_bot_with_browser_hint(false);

        assert!(app.zenith_live_pps_unlimited());
        assert_eq!(app.zenith_live_pps_interval(), None);

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_pps_one_defers_until_interval_elapses() {
        let paths = test_paths("zenith-live-pps-one");
        let mut app = LauncherApp::new(paths.clone());
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Unlimited;
        app.state.pps_unlimited = false;
        app.state.target_pps = 1.0;
        app.state.normalize_pps_state();
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();

        let baseline = Instant::now();
        app.test_now = Some(baseline);
        write_zenith_passive_snapshot(&paths, "ready", "running", 0, json!(false));
        app.poll_zenith_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(200));
        write_zenith_passive_snapshot(&paths, "ready", "running", 1, json!(false));
        app.poll_zenith_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(999));
        app.poll_zenith_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(1000));
        app.poll_zenith_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            2
        );
        assert_eq!(
            zenith_live_started_offsets_ms(&app, baseline),
            vec![0, 1000]
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("input deferred reason=pps_pacing"))
                .count(),
            1
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_pps_two_enforces_half_second_start_interval() {
        let paths = test_paths("zenith-live-pps-two");
        let mut app = LauncherApp::new(paths.clone());
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Unlimited;
        app.state.pps_unlimited = false;
        app.state.target_pps = 2.0;
        app.state.normalize_pps_state();
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;

        let baseline = Instant::now();
        app.test_now = Some(baseline);
        write_zenith_passive_snapshot(&paths, "ready", "running", 0, json!(false));
        app.poll_zenith_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(200));
        write_zenith_passive_snapshot(&paths, "ready", "running", 1, json!(false));
        app.poll_zenith_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(500));
        app.poll_zenith_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(700));
        write_zenith_passive_snapshot(&paths, "ready", "running", 2, json!(false));
        app.poll_zenith_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(1000));
        app.poll_zenith_dry_run();

        assert_eq!(
            zenith_live_started_offsets_ms(&app, baseline),
            vec![0, 500, 1000]
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_pps_quarter_enforces_four_second_start_interval() {
        let paths = test_paths("zenith-live-pps-quarter");
        let mut app = LauncherApp::new(paths.clone());
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Unlimited;
        app.state.pps_unlimited = false;
        app.state.target_pps = 0.25;
        app.state.normalize_pps_state();
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;

        let baseline = Instant::now();
        app.test_now = Some(baseline);
        write_zenith_passive_snapshot(&paths, "ready", "running", 0, json!(false));
        app.poll_zenith_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(250));
        write_zenith_passive_snapshot(&paths, "ready", "running", 1, json!(false));
        app.poll_zenith_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(3999));
        app.poll_zenith_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(4000));
        app.poll_zenith_dry_run();

        assert_eq!(
            zenith_live_started_offsets_ms(&app, baseline),
            vec![0, 4000]
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_pps_unlimited_keeps_immediate_post_lock_execution() {
        let paths = test_paths("zenith-live-pps-unlimited");
        let mut app = LauncherApp::new(paths.clone());
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Unlimited;
        app.state.pps_unlimited = true;
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();

        let baseline = Instant::now();
        app.test_now = Some(baseline);
        write_zenith_passive_snapshot(&paths, "ready", "running", 0, json!(false));
        app.poll_zenith_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(100));
        write_zenith_passive_snapshot(&paths, "ready", "running", 1, json!(false));
        app.poll_zenith_dry_run();

        assert_eq!(zenith_live_started_offsets_ms(&app, baseline), vec![0, 100]);
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("input deferred reason=pps_pacing"))
                .count(),
            0
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_pps_wait_uses_latest_snapshot_when_piece_counter_advances() {
        let paths = test_paths("zenith-live-pps-latest-snapshot");
        let mut app = LauncherApp::new(paths.clone());
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Unlimited;
        app.state.pps_unlimited = false;
        app.state.target_pps = 1.0;
        app.state.normalize_pps_state();
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();

        let baseline = Instant::now();
        app.test_now = Some(baseline);
        write_zenith_passive_snapshot(&paths, "ready", "running", 0, json!(false));
        app.poll_zenith_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(200));
        write_zenith_passive_snapshot(&paths, "ready", "running", 1, json!(false));
        app.poll_zenith_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(500));
        write_zenith_passive_snapshot(&paths, "ready", "running", 2, json!(false));
        app.poll_zenith_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(1000));
        app.poll_zenith_dry_run();

        assert_eq!(
            zenith_live_started_offsets_ms(&app, baseline),
            vec![0, 1000]
        );
        assert_eq!(app.zenith_live.active_piece_counter, Some(2));
        assert!(app
            .logs
            .iter()
            .any(|line| { line.contains("[zenith-live] execution started piece_counter=2") }));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_pps_does_not_add_wait_after_long_piece_cycle() {
        let paths = test_paths("zenith-live-pps-long-cycle");
        let mut app = LauncherApp::new(paths.clone());
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Unlimited;
        app.state.pps_unlimited = false;
        app.state.target_pps = 1.0;
        app.state.normalize_pps_state();
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;

        let baseline = Instant::now();
        app.test_now = Some(baseline);
        write_zenith_passive_snapshot(&paths, "ready", "running", 0, json!(false));
        app.poll_zenith_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(1500));
        write_zenith_passive_snapshot(&paths, "ready", "running", 1, json!(false));
        app.poll_zenith_dry_run();

        assert_eq!(
            zenith_live_started_offsets_ms(&app, baseline),
            vec![0, 1500]
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_pps_bot_off_cancels_deferred_pacing() {
        let paths = test_paths("zenith-live-pps-bot-off-reset");
        let mut app = LauncherApp::new(paths.clone());
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Unlimited;
        app.state.pps_unlimited = false;
        app.state.target_pps = 1.0;
        app.state.normalize_pps_state();
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;

        let baseline = Instant::now();
        app.test_now = Some(baseline);
        write_zenith_passive_snapshot(&paths, "ready", "running", 0, json!(false));
        app.poll_zenith_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(200));
        write_zenith_passive_snapshot(&paths, "ready", "running", 1, json!(false));
        app.poll_zenith_dry_run();

        app.stop_bot_with_browser_hint(false);
        assert!(app.zenith_live.next_execution_earliest_at.is_none());
        assert!(app.zenith_live.deferred_snapshot_token.is_none());

        app.test_now = Some(baseline + Duration::from_millis(1000));
        app.poll_zenith_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_pps_mode_change_cancels_deferred_pacing() {
        let paths = test_paths("zenith-live-pps-mode-change-reset");
        let mut app = LauncherApp::new(paths.clone());
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Unlimited;
        app.state.pps_unlimited = false;
        app.state.target_pps = 1.0;
        app.state.normalize_pps_state();
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;

        let baseline = Instant::now();
        app.test_now = Some(baseline);
        write_zenith_passive_snapshot(&paths, "ready", "running", 0, json!(false));
        app.poll_zenith_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(200));
        write_zenith_passive_snapshot(&paths, "ready", "running", 1, json!(false));
        app.poll_zenith_dry_run();

        app.select_mode(RuntimeMode::Solo);
        assert!(app.zenith_live.next_execution_earliest_at.is_none());
        assert!(app.zenith_live.deferred_snapshot_token.is_none());

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_pps_game_end_cancels_deferred_pacing() {
        let paths = test_paths("zenith-live-pps-game-end-reset");
        let mut app = LauncherApp::new(paths.clone());
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Unlimited;
        app.state.pps_unlimited = false;
        app.state.target_pps = 1.0;
        app.state.normalize_pps_state();
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;

        let baseline = Instant::now();
        app.test_now = Some(baseline);
        write_zenith_passive_snapshot(&paths, "ready", "running", 0, json!(false));
        app.poll_zenith_dry_run();

        app.test_now = Some(baseline + Duration::from_millis(200));
        write_zenith_passive_snapshot(&paths, "ready", "running", 1, json!(false));
        app.poll_zenith_dry_run();

        write_zenith_passive_snapshot_with_state_flags(
            &paths, "ready", "running", 1, true, false, true, None,
        );
        app.poll_zenith_dry_run();

        assert!(app.zenith_live.next_execution_earliest_at.is_none());
        assert!(app.zenith_live.deferred_snapshot_token.is_none());
        assert!(app
            .logs
            .iter()
            .any(|line| line == "[zenith-dry-run] snapshot skipped reason=successful"));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_executes_exactly_five_pieces() {
        let paths = test_paths("zenith-live-five-pieces");
        let mut app = LauncherApp::new(paths.clone());
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Bounded(5);
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();

        drive_zenith_live_piece_counters(
            &mut app,
            &paths,
            &[20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30],
        );

        assert_eq!(app.zenith_live.executed_pieces, 5);
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            5
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[zenith-live] execution started"))
                .count(),
            5
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[zenith-live] piece completed"))
                .count(),
            5
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("execution suspended reason=max_pieces_reached"))
                .count(),
            1
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("input suppressed reason=max_pieces_reached"))
                .count(),
            0
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("input suppressed reason=completed_piece"))
                .count(),
            0
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_executes_exactly_twenty_pieces() {
        let paths = test_paths("zenith-live-twenty-pieces");
        let mut app = LauncherApp::new(paths.clone());
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Bounded(20);
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();

        let counters: Vec<u32> = (40..=80).collect();
        drive_zenith_live_piece_counters(&mut app, &paths, &counters);

        assert_eq!(app.zenith_live.executed_pieces, 20);
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            20
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("execution suspended reason=max_pieces_reached"))
                .count(),
            1
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("input suppressed reason=max_pieces_reached"))
                .count(),
            0
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("execution aborted"))
                .count(),
            0
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("input suppressed reason=completed_piece"))
                .count(),
            0
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_unlimited_dispatches_one_hundred_sequential_pieces_without_max_gate() {
        let paths = test_paths("zenith-live-unlimited-hundred");
        let mut app = LauncherApp::new(paths.clone());
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Unlimited;
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();

        let counters: Vec<u32> = (0..100).collect();
        drive_zenith_live_piece_counters(&mut app, &paths, &counters);

        let dispatch_count = app
            .zenith_live_test_hook
            .dispatch_count
            .load(Ordering::Relaxed);
        assert_eq!(dispatch_count, 100);
        assert_eq!(app.zenith_live.executed_pieces, 99);
        assert_eq!(app.zenith_live.stage, ZenithLiveStage::AwaitingLock);
        assert_eq!(app.zenith_live.active_piece_counter, Some(99));
        assert!(!app.zenith_live.max_reached_logged);
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("execution suspended reason=max_pieces_reached"))
                .count(),
            0
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("input suppressed reason=max_pieces_reached"))
                .count(),
            0
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("input suppressed reason=completed_piece"))
                .count(),
            0
        );
        assert!(dispatch_count > app.zenith_live.executed_pieces);
        assert!(app.logs.iter().any(|line| {
            line.contains("[zenith-live] execution started") && line.contains("limit=unlimited")
        }));
        assert!(app.logs.iter().any(|line| {
            line.contains("[zenith-live] piece completed") && line.contains("limit=unlimited")
        }));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_game_change_keeps_session_execution_count() {
        let paths = test_paths("zenith-live-count-persists-across-games");
        let mut app = LauncherApp::new(paths.clone());
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Bounded(5);
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();

        drive_zenith_live_piece_counters_for_game(&mut app, &paths, "game-a", &[20, 21, 22, 23]);
        assert_eq!(app.zenith_live.executed_pieces, 3);

        drive_zenith_live_piece_counters_for_game(&mut app, &paths, "game-b", &[6, 7, 8, 9]);

        assert_eq!(app.zenith_live.executed_pieces, 5);
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            6
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("execution suspended reason=max_pieces_reached"))
                .count(),
            1
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("input suppressed reason=max_pieces_reached"))
                .count(),
            0
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_max_reached_log_resets_for_new_bot_on_session() {
        let paths = test_paths("zenith-live-max-log-reset");
        let mut app = LauncherApp::new(paths.clone());
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();

        write_zenith_passive_snapshot(&paths, "ready", "running", 10, json!(false));
        app.poll_zenith_dry_run();

        std::thread::sleep(Duration::from_millis(20));
        write_zenith_passive_snapshot(&paths, "ready", "running", 11, json!(false));
        app.poll_zenith_dry_run();

        app.stop_bot_with_browser_hint(false);
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;

        std::thread::sleep(Duration::from_millis(20));
        write_zenith_passive_snapshot(&paths, "ready", "running", 20, json!(false));
        app.poll_zenith_dry_run();

        std::thread::sleep(Duration::from_millis(20));
        write_zenith_passive_snapshot(&paths, "ready", "running", 21, json!(false));
        app.poll_zenith_dry_run();

        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("execution suspended reason=max_pieces_reached"))
                .count(),
            2
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("input suppressed reason=max_pieces_reached"))
                .count(),
            0
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_bot_off_then_on_resets_executed_counter() {
        let paths = test_paths("zenith-live-bot-reset");
        let mut app = LauncherApp::new(paths.clone());
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();
        write_zenith_passive_snapshot(&paths, "ready", "running", 30, json!(false));
        app.poll_zenith_dry_run();

        std::thread::sleep(Duration::from_millis(20));
        write_zenith_passive_snapshot(&paths, "ready", "running", 31, json!(false));
        app.poll_zenith_dry_run();
        assert_eq!(app.zenith_live.executed_pieces, 1);

        app.stop_bot_with_browser_hint(false);
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();

        std::thread::sleep(Duration::from_millis(20));
        write_zenith_passive_snapshot(&paths, "ready", "running", 32, json!(false));
        app.poll_zenith_dry_run();

        assert_eq!(app.zenith_live.executed_pieces, 0);
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            2
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_lock_timeout_aborts_without_retrying_same_piece() {
        let paths = test_paths("zenith-live-lock-timeout");
        let mut app = LauncherApp::new(paths.clone());
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();
        write_zenith_passive_snapshot(&paths, "ready", "running", 40, json!(false));

        app.poll_zenith_dry_run();
        app.zenith_live.started_at =
            Some(Instant::now() - Duration::from_millis(ZENITH_LIVE_LOCK_TIMEOUT_MS + 50));

        std::thread::sleep(Duration::from_millis(20));
        write_zenith_passive_snapshot(&paths, "ready", "running", 40, json!(false));
        app.poll_zenith_dry_run();
        app.poll_zenith_dry_run();

        assert_eq!(app.zenith_live.stage, ZenithLiveStage::Aborted);
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert!(app.logs.iter().any(|line| {
            line.contains("[zenith-live] execution aborted reason=lock_timeout piece_counter=40")
        }));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_aborted_piece_does_not_block_next_piece() {
        let paths = test_paths("zenith-live-abort-next-piece");
        let mut app = LauncherApp::new(paths.clone());
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Bounded(5);
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();

        write_zenith_passive_snapshot(&paths, "ready", "running", 0, json!(false));
        app.poll_zenith_dry_run();
        app.zenith_live.started_at =
            Some(Instant::now() - Duration::from_millis(ZENITH_LIVE_LOCK_TIMEOUT_MS + 50));

        std::thread::sleep(Duration::from_millis(20));
        write_zenith_passive_snapshot(&paths, "ready", "running", 0, json!(false));
        app.poll_zenith_dry_run();
        app.poll_zenith_dry_run();

        assert_eq!(app.zenith_live.stage, ZenithLiveStage::Aborted);
        let aborted = app
            .zenith_live
            .last_aborted_execution
            .as_ref()
            .expect("aborted execution identity");
        assert_eq!(aborted.piece_counter, Some(0));
        let aborted_snapshot = read_test_zenith_passive_snapshot(&paths);
        assert!(app
            .zenith_live
            .aborted_execution_matches_snapshot(&aborted_snapshot));

        std::thread::sleep(Duration::from_millis(20));
        write_zenith_passive_snapshot(&paths, "ready", "running", 1, json!(false));
        app.poll_zenith_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            2
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[zenith-live] execution started piece_counter=1"))
                .count(),
            1
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_generation_mismatch_aborts_awaiting_lock() {
        let paths = test_paths("zenith-live-generation-mismatch");
        let mut app = LauncherApp::new(paths.clone());
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();
        write_zenith_passive_snapshot(&paths, "ready", "running", 50, json!(false));

        app.poll_zenith_dry_run();

        std::thread::sleep(Duration::from_millis(20));
        let (x, y) = zenith_spawn_coordinates(Piece::J);
        write_zenith_passive_snapshot_with_metadata(
            &paths,
            "ready",
            "running",
            6,
            "user-zenith",
            "game-zenith",
            "candidate-1",
            50,
            json!(false),
            "J",
            json!(x),
            json!(y),
            json!(null),
            &["O", "T", "L", "S", "Z"],
        );
        app.poll_zenith_dry_run();

        assert_eq!(app.zenith_live.stage, ZenithLiveStage::Aborted);
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert!(app.logs.iter().any(|line| {
            line.contains(
                "[zenith-live] execution aborted reason=generation_mismatch piece_counter=50",
            )
        }));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_bot_off_while_awaiting_lock_releases_input_and_stops_dispatch() {
        let paths = test_paths("zenith-live-bot-off-awaiting-lock");
        let mut app = LauncherApp::new(paths.clone());
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Unlimited;
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();

        write_zenith_passive_snapshot(&paths, "ready", "running", 0, json!(false));
        app.poll_zenith_dry_run();

        assert_eq!(app.zenith_live.stage, ZenithLiveStage::AwaitingLock);
        let release_count_before_stop = app
            .zenith_live_test_hook
            .release_count
            .load(Ordering::Relaxed);

        app.stop_bot_with_browser_hint(false);

        assert_eq!(app.bot_status, BotStatus::Off);
        assert_eq!(
            app.zenith_live_test_hook
                .release_count
                .load(Ordering::Relaxed)
                .saturating_sub(release_count_before_stop),
            1
        );

        std::thread::sleep(Duration::from_millis(20));
        write_zenith_passive_snapshot(&paths, "ready", "running", 1, json!(false));
        app.poll_zenith_dry_run();

        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_successful_snapshot_aborts_active_execution_without_replanning() {
        let paths = test_paths("zenith-live-successful-stops");
        let mut app = LauncherApp::new(paths.clone());
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Unlimited;
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();

        write_zenith_passive_snapshot(&paths, "ready", "running", 0, json!(false));
        app.poll_zenith_dry_run();

        std::thread::sleep(Duration::from_millis(20));
        write_zenith_passive_snapshot_with_state_flags(
            &paths, "ready", "running", 1, true, false, true, None,
        );
        app.poll_zenith_dry_run();

        assert_eq!(app.zenith_live.stage, ZenithLiveStage::Aborted);
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[zenith-live] execution started"))
                .count(),
            1
        );
        assert!(app.logs.iter().any(|line| {
            line.contains("[zenith-live] execution aborted reason=successful piece_counter=0")
        }));
        assert!(app
            .logs
            .iter()
            .any(|line| line == "[zenith-dry-run] snapshot skipped reason=successful"));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_not_playing_snapshot_aborts_active_execution_without_replanning() {
        let paths = test_paths("zenith-live-playing-false-stops");
        let mut app = LauncherApp::new(paths.clone());
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Unlimited;
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();

        write_zenith_passive_snapshot(&paths, "ready", "running", 0, json!(false));
        app.poll_zenith_dry_run();

        std::thread::sleep(Duration::from_millis(20));
        write_zenith_passive_snapshot_with_state_flags(
            &paths, "ready", "running", 1, false, false, false, None,
        );
        app.poll_zenith_dry_run();

        assert_eq!(app.zenith_live.stage, ZenithLiveStage::Aborted);
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert!(app.logs.iter().any(|line| {
            line.contains("[zenith-live] execution aborted reason=playing_false piece_counter=0")
        }));
        assert!(app
            .logs
            .iter()
            .any(|line| line == "[zenith-dry-run] snapshot skipped reason=not_playing"));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_live_destroyed_snapshot_aborts_active_execution_without_replanning() {
        let paths = test_paths("zenith-live-destroyed-stops");
        let mut app = LauncherApp::new(paths.clone());
        app.state.zenith_live_max_pieces = ZenithLivePieceLimit::Unlimited;
        configure_zenith_runtime_ready(&mut app);
        app.state.zenith_live_input_enabled = true;
        app.logs.clear();

        write_zenith_passive_snapshot(&paths, "ready", "running", 0, json!(false));
        app.poll_zenith_dry_run();

        std::thread::sleep(Duration::from_millis(20));
        write_zenith_passive_snapshot_with_state_flags(
            &paths, "ready", "running", 1, true, true, false, None,
        );
        app.poll_zenith_dry_run();

        assert_eq!(app.zenith_live.stage, ZenithLiveStage::Aborted);
        assert_eq!(
            app.zenith_live_test_hook
                .dispatch_count
                .load(Ordering::Relaxed),
            1
        );
        assert!(app.logs.iter().any(|line| {
            line.contains("[zenith-live] execution aborted reason=destroyed piece_counter=0")
        }));
        assert!(app
            .logs
            .iter()
            .any(|line| line == "[zenith-dry-run] snapshot skipped reason=destroyed"));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_dry_run_paused_null_remains_compatible() {
        let paths = test_paths("zenith-dry-run-paused-null");
        let mut app = LauncherApp::new(paths.clone());
        configure_zenith_runtime_ready(&mut app);
        app.logs.clear();
        write_zenith_passive_snapshot(&paths, "ready", "running", 6, json!(null));

        app.poll_zenith_dry_run();

        assert!(app
            .logs
            .iter()
            .any(|line| line.contains("[zenith-dry-run] snapshot accepted")));
        assert!(app
            .logs
            .iter()
            .any(|line| line.contains("[zenith-dry-run] plan ready")));
        assert!(app.bot_session.is_none());

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_dry_run_paused_true_blocks_planning() {
        let paths = test_paths("zenith-dry-run-paused-true");
        let mut app = LauncherApp::new(paths.clone());
        configure_zenith_runtime_ready(&mut app);
        app.logs.clear();
        write_zenith_passive_snapshot(&paths, "ready", "running", 6, json!(true));

        app.poll_zenith_dry_run();

        assert!(app
            .logs
            .iter()
            .any(|line| line == "[zenith-dry-run] snapshot skipped reason=paused"));
        assert!(app.bot_session.is_none());
        assert!(!app
            .logs
            .iter()
            .any(|line| line.contains("[zenith-dry-run] plan ready")));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_dry_run_capture_stopped_still_rejects_last_snapshot() {
        let paths = test_paths("zenith-dry-run-stopped");
        let mut app = LauncherApp::new(paths.clone());
        configure_zenith_runtime_ready(&mut app);
        app.logs.clear();
        write_zenith_passive_snapshot(&paths, "ready", "stopped", 6, json!(false));

        app.poll_zenith_dry_run();

        assert!(app
            .logs
            .iter()
            .any(|line| line == "[zenith-dry-run] snapshot skipped reason=capture_stopped"));
        assert!(!app
            .logs
            .iter()
            .any(|line| line.contains("[zenith-dry-run] snapshot accepted")));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_dry_run_only_logs_duplicate_skip_once_for_same_piece() {
        let paths = test_paths("zenith-dry-run-duplicate");
        let mut app = LauncherApp::new(paths.clone());
        configure_zenith_runtime_ready(&mut app);
        app.logs.clear();
        write_zenith_passive_snapshot(&paths, "ready", "running", 7, json!(false));

        app.poll_zenith_dry_run();
        app.poll_zenith_dry_run();
        app.poll_zenith_dry_run();

        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[zenith-dry-run] snapshot accepted"))
                .count(),
            1
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| {
                    line == &&"[zenith-dry-run] snapshot skipped reason=duplicate_piece".to_owned()
                })
                .count(),
            1
        );
        assert!(app
            .logs
            .iter()
            .any(|line| line.contains("[zenith-dry-run] input suppressed reason=dry_run")));
        assert!(app
            .logs
            .iter()
            .any(|line| line.contains("[zenith-dry-run] plan ready")));
        assert!(app.bot_session.is_none());

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_dry_run_attempted_snapshot_is_retryable_on_fresher_same_piece() {
        let paths = test_paths("zenith-dry-run-attempted-contract");
        write_zenith_passive_snapshot(&paths, "ready", "running", 3, json!(false));
        let snapshot = read_test_zenith_passive_snapshot(&paths);
        let mut controller = ZenithDryRunController::default();

        controller.record_attempted(&snapshot, "sig-a");

        assert!(controller.is_duplicate_attempt("sig-a"));
        assert!(!controller.is_duplicate_attempt("sig-b"));
        assert!(!controller.is_duplicate_processed_piece(&snapshot));

        controller.record_processed(&snapshot, "sig-b");

        assert!(controller.is_duplicate_processed_piece(&snapshot));
        assert!(controller.is_duplicate_attempt("sig-b"));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_dry_run_schema_error_logs_once_for_identical_snapshot() {
        let paths = test_paths("zenith-dry-run-schema-once");
        let mut app = LauncherApp::new(paths.clone());
        configure_zenith_runtime_ready(&mut app);
        app.logs.clear();
        write_zenith_invalid_passive_snapshot_missing_current_type(&paths);

        app.poll_zenith_dry_run();
        app.poll_zenith_dry_run();

        assert_eq!(
            app.logs
                .iter()
                .filter(|line| {
                    line.contains(
                        "[zenith-dry-run] snapshot skipped reason=semantic_invalid error=missing current piece type"
                    )
                })
                .count(),
            1
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_dry_run_lowercase_snapshot_reaches_planner_once() {
        let paths = test_paths("zenith-dry-run-lowercase");
        let mut app = LauncherApp::new(paths.clone());
        configure_zenith_runtime_ready(&mut app);
        app.logs.clear();
        let (x, _y) = zenith_spawn_coordinates(Piece::J);
        write_zenith_passive_snapshot_with_pieces(
            &paths,
            "ready",
            "running",
            12,
            json!(false),
            "j",
            json!(x),
            json!(17.96),
            json!("l"),
            &["t", "S", "z"],
        );

        app.poll_zenith_dry_run();
        app.poll_zenith_dry_run();

        std::thread::sleep(Duration::from_millis(20));
        write_zenith_passive_snapshot_with_pieces(
            &paths,
            "ready",
            "running",
            12,
            json!(false),
            "j",
            json!(x),
            json!(18.395631),
            json!("l"),
            &["t", "S", "z"],
        );
        app.poll_zenith_dry_run();

        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[zenith-dry-run] snapshot accepted"))
                .count(),
            1
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[zenith-dry-run] plan ready"))
                .count(),
            1
        );
        assert!(app
            .logs
            .iter()
            .any(|line| line.contains("[zenith-dry-run] input suppressed reason=dry_run")));
        assert!(app.bot_session.is_none());

        std::thread::sleep(Duration::from_millis(20));
        write_zenith_passive_snapshot_with_pieces(
            &paths,
            "ready",
            "running",
            13,
            json!(false),
            "j",
            json!(x),
            json!(18.001516),
            json!("l"),
            &["t", "S", "z"],
        );
        app.poll_zenith_dry_run();

        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[zenith-dry-run] snapshot accepted"))
                .count(),
            2
        );
        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[zenith-dry-run] plan ready"))
                .count(),
            2
        );

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_dry_run_successful_parse_clears_prior_error_dedupe() {
        let paths = test_paths("zenith-dry-run-error-reset");
        let mut app = LauncherApp::new(paths.clone());
        configure_zenith_runtime_ready(&mut app);
        app.logs.clear();
        write_zenith_invalid_passive_snapshot_missing_current_type(&paths);
        app.poll_zenith_dry_run();

        std::thread::sleep(Duration::from_millis(20));
        write_zenith_passive_snapshot(&paths, "ready", "running", 9, json!(false));
        app.poll_zenith_dry_run();

        std::thread::sleep(Duration::from_millis(20));
        write_zenith_invalid_passive_snapshot_missing_current_type(&paths);
        app.poll_zenith_dry_run();

        assert_eq!(
            app.logs
                .iter()
                .filter(|line| {
                    line.contains(
                        "[zenith-dry-run] snapshot skipped reason=semantic_invalid error=missing current piece type"
                    )
                })
                .count(),
            2
        );
        assert!(app
            .logs
            .iter()
            .any(|line| line.contains("[zenith-dry-run] snapshot accepted")));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_dry_run_snapshot_missing_logs_once_and_success_resets_dedupe() {
        let paths = test_paths("zenith-dry-run-snapshot-missing");
        let mut app = LauncherApp::new(paths.clone());
        configure_zenith_runtime_ready(&mut app);
        app.logs.clear();

        app.poll_zenith_dry_run();
        app.poll_zenith_dry_run();

        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line
                    == &&"[zenith-dry-run] snapshot skipped reason=snapshot_missing".to_owned())
                .count(),
            1
        );
        assert!(app.bot_session.is_none());

        std::thread::sleep(Duration::from_millis(20));
        write_zenith_passive_snapshot(&paths, "ready", "running", 11, json!(false));
        app.poll_zenith_dry_run();

        assert!(app
            .logs
            .iter()
            .any(|line| line.contains("[zenith-dry-run] snapshot accepted")));
        assert!(app
            .logs
            .iter()
            .any(|line| line.contains("[zenith-dry-run] input suppressed reason=dry_run")));

        fs::remove_file(zenith_passive_snapshot_path(&paths)).unwrap();
        app.poll_zenith_dry_run();

        std::thread::sleep(Duration::from_millis(20));
        write_zenith_passive_snapshot(&paths, "ready", "running", 11, json!(false));
        app.poll_zenith_dry_run();

        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line.contains("[zenith-dry-run] snapshot accepted"))
                .count(),
            1
        );

        app.poll_zenith_dry_run();

        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line
                    == &&"[zenith-dry-run] snapshot skipped reason=snapshot_missing".to_owned())
                .count(),
            2
        );
        assert!(app.bot_session.is_none());

        cleanup_test_paths(&paths);
    }

    #[test]
    fn zenith_dry_run_skips_stale_snapshot_without_planning() {
        let paths = test_paths("zenith-dry-run-stale");
        let mut app = LauncherApp::new(paths.clone());
        configure_zenith_runtime_ready(&mut app);
        app.logs.clear();
        write_zenith_passive_snapshot(&paths, "ready", "running", 8, json!(false));
        std::thread::sleep(Duration::from_millis(MAX_SNAPSHOT_AGE_MS + 100));

        app.poll_zenith_dry_run();
        app.poll_zenith_dry_run();

        assert_eq!(
            app.logs
                .iter()
                .filter(|line| line == &&"[zenith-dry-run] snapshot skipped reason=stale".to_owned())
                .count(),
            1
        );
        assert!(!app
            .logs
            .iter()
            .any(|line| line.contains("[zenith-dry-run] snapshot accepted")));
        assert!(!app
            .logs
            .iter()
            .any(|line| line.contains("[zenith-dry-run] plan ready")));

        cleanup_test_paths(&paths);
    }

    #[test]
    fn solo_mode_ignores_zenith_passive_snapshot_file() {
        let paths = test_paths("zenith-dry-run-solo-noop");
        let mut app = LauncherApp::new(paths.clone());
        app.browser_status = BrowserStatus::Ready;
        app.input_status = InputStatus::Ready;
        app.snapshot_status = SnapshotStatus::Ready;
        app.bot_desired_enabled = true;
        app.bot_status = BotStatus::On;
        app.logs.clear();
        write_zenith_passive_snapshot(&paths, "ready", "running", 10, json!(false));

        app.poll_zenith_dry_run();

        assert!(app.logs.is_empty());
        assert!(app.bot_session.is_none());

        cleanup_test_paths(&paths);
    }
}
